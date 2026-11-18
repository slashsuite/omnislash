// --- ob 322 (Postgres migration, phase 2): the query half of the fts5 -> tsvector rewrite ---
//
// SQLite stays authoritative until phase 6 (ob 326), so NOTHING here is on the live path yet. The live
// `ob search` / `ob gmail search` / `ob whatsapp search` still run fts5 `MATCH` out of
// commands/query.ts, ingest/gmail.ts and ingest/whatsapp.ts, untouched. This module is the Postgres
// equivalent, built beside them so phases 4 and 6 have something to point at.
//
// WHAT REPLACED WHAT
//   item_fts(title, body)      -> item.search_vec
//   pr_comment_fts(body)       -> pr_comment.search_vec
//   email_fts(subject, body)   -> email_message.search_vec
//   slack_fts(text)            -> slack_message.search_vec
//   whatsapp_fts(content)      -> whatsapp_message.search_vec  (336: also transcript + media_desc)
// All five are generated columns with a GIN index (see the ob 322 block in schema.ts). There is no
// shadow table and no sync code on this side, so `syncFts`-style drift is not a failure this can have.
//
// THE HONEST PART: fts5 and tsvector do NOT match the same things, and this file is where the gap is
// managed. Both are token-based (fts5 is not really substring matching -- an unadorned fts5 term matches
// whole tokens too), so the overlap is large, but four differences are real:
//
//   1. STEMMING. tsvector matches MORE: `migration` finds "migrations"/"migrating" with no `*`. fts5
//      needs `migrat*`. Strictly better recall; kept.
//   2. STOPWORDS. tsvector matches LESS: `the`, `is`, `of` index to nothing, so a query made only of
//      stopwords is an empty tsquery that matches every row's nothing. fts5 has no stopword list.
//   3. THE PARSER. tsvector's default parser keeps an email address, a URL or a file path together as
//      ONE lexeme (`alex@acmecorp.example.com`, `apps/cli/src/db/pg/schema.ts`), where fts5's unicode61
//      tokenizer splits them on punctuation. So `acmecorp` and `schema.ts` find nothing by word match.
//   4. SIGNED NUMBERS. `ob-322` parses as `ob` plus the INTEGER `-322`, so a bare `322` does not match
//      it. Ticket refs are exactly this shape, which makes it the difference most likely to be noticed.
//
// (Accents were a fifth, and are handled in the schema rather than here: the `ob_search` configuration
// puts `unaccent` in front of the stemmer, matching unicode61's diacritic stripping, so `cafe` finds
// `café` on both sides.)
//
// 3 and 4 are recall losses against a corpus of tickets, addresses and error strings, which is exactly
// what this tracker holds -- so they get pg_trgm, via `substringConditions`. The rule is deliberately
// narrow: the trigram clause is a FALLBACK, used only when the tsquery matched NOTHING. That makes it
// purely additive (it can never displace or reorder a word-match hit, and it never widens a query that
// already worked), it rescues 2 as well as 3 and 4, and one wrong guess about term-vs-substring cannot
// flood a good result set. Callers get both halves and decide; `runSearch` below is that decision.

import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { emailMessage, item, prComment, slackMessage, whatsappMessage } from "./schema.ts";

/** The text search configuration created by migration 0001 (english + unaccent). */
export const SEARCH_CONFIG = "ob_search";

type Node =
	| { kind: "term"; value: string; prefix: boolean }
	| { kind: "phrase"; terms: string[] }
	| { kind: "and"; left: Node; right: Node }
	| { kind: "or"; left: Node; right: Node }
	| { kind: "not"; left: Node; right: Node };

type Token =
	| { kind: "word"; value: string; prefix: boolean }
	| { kind: "phrase"; value: string }
	| { kind: "op"; value: "AND" | "OR" | "NOT" }
	| { kind: "paren"; value: "(" | ")" };

/**
 * Split an fts5-shaped query into tokens. Accepts what `ob search` accepts today: bare terms (implicit
 * AND), `AND` / `OR` / `NOT` in caps, `"quoted phrases"`, `trailing*` prefixes and `( grouping )`.
 * Anything it does not recognise is treated as a term rather than rejected -- an unparseable query
 * should return no rows, never an error, which is a small improvement on the fts5 path (it throws
 * `invalid search query` on a stray operator).
 */
function tokenize(query: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < query.length) {
		const ch = query[i]!;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === "(" || ch === ")") {
			tokens.push({ kind: "paren", value: ch });
			i++;
			continue;
		}
		if (ch === '"') {
			const end = query.indexOf('"', i + 1);
			const value = end === -1 ? query.slice(i + 1) : query.slice(i + 1, end);
			tokens.push({ kind: "phrase", value });
			i = end === -1 ? query.length : end + 1;
			continue;
		}
		let j = i;
		while (j < query.length && !/[\s()"]/.test(query[j]!)) j++;
		const raw = query.slice(i, j);
		i = j;
		if (raw === "AND" || raw === "OR" || raw === "NOT") {
			tokens.push({ kind: "op", value: raw });
			continue;
		}
		const prefix = raw.endsWith("*");
		const value = prefix ? raw.slice(0, -1) : raw;
		if (value.length > 0) tokens.push({ kind: "word", value, prefix });
	}
	return tokens;
}

/** Recursive-descent parse of the token stream. OR binds loosest, then AND/NOT, then primaries. */
function parse(tokens: Token[]): Node | null {
	let pos = 0;

	function primary(): Node | null {
		const token = tokens[pos];
		if (!token) return null;
		if (token.kind === "paren" && token.value === "(") {
			pos++;
			const inner = orExpr();
			if (tokens[pos]?.kind === "paren" && (tokens[pos] as { value: string }).value === ")") pos++;
			return inner;
		}
		if (token.kind === "paren") return null;
		if (token.kind === "op") return null;
		pos++;
		if (token.kind === "phrase") {
			const terms = token.value.split(/\s+/).filter((t) => t.length > 0);
			return terms.length === 0 ? null : { kind: "phrase", terms };
		}
		return { kind: "term", value: token.value, prefix: token.prefix };
	}

	function andExpr(): Node | null {
		let left = primary();
		for (;;) {
			const token = tokens[pos];
			if (!token) break;
			if (token.kind === "paren" && token.value === ")") break;
			if (token.kind === "op" && token.value === "OR") break;
			let kind: "and" | "not" = "and";
			if (token.kind === "op") {
				kind = token.value === "NOT" ? "not" : "and";
				pos++;
			}
			const right = primary();
			if (!right) break;
			left = left ? { kind, left, right } : right;
		}
		return left;
	}

	function orExpr(): Node | null {
		let left = andExpr();
		for (;;) {
			const token = tokens[pos];
			if (!token || token.kind !== "op" || token.value !== "OR") break;
			pos++;
			const right = andExpr();
			if (!right) break;
			left = left ? { kind: "or", left, right } : right;
		}
		return left;
	}

	return orExpr();
}

/**
 * A single tsquery lexeme, always single-quoted so no user input can be a tsquery operator. `to_tsquery`
 * still normalises a quoted lexeme through the configuration (stemming, unaccent, stopword removal), so
 * quoting costs nothing in matching and buys a query that cannot be a syntax error.
 */
function lexeme(term: string, prefix: boolean): string {
	const escaped = term.replace(/\\/g, "\\\\").replace(/'/g, "''");
	return `'${escaped}'${prefix ? ":*" : ""}`;
}

function render(node: Node): string {
	switch (node.kind) {
		case "term":
			return lexeme(node.value, node.prefix);
		case "phrase":
			return node.terms.map((t) => lexeme(t, false)).join(" <-> ");
		case "and":
			return `(${render(node.left)} & ${render(node.right)})`;
		case "or":
			return `(${render(node.left)} | ${render(node.right)})`;
		case "not":
			return `(${render(node.left)} & !${render(node.right)})`;
	}
}

/**
 * Translate an `ob search` query into a tsquery string. Returns "" when there is nothing to match on,
 * which callers must treat as "no word-match clause" rather than passing to `to_tsquery` -- an empty
 * string is a tsquery syntax error, and a search should never raise one.
 */
export function toTsQuery(query: string): string {
	const node = parse(tokenize(query));
	return node ? render(node) : "";
}

/**
 * The positive terms of a query, for the trigram fallback: bare terms and phrase words, with anything
 * under a NOT dropped. Prefix stars are stripped -- a substring match is already a prefix match.
 */
export function substringTerms(query: string): string[] {
	const terms: string[] = [];
	const walk = (node: Node): void => {
		switch (node.kind) {
			case "term":
				terms.push(node.value);
				return;
			case "phrase":
				terms.push(node.terms.join(" "));
				return;
			case "not":
				walk(node.left);
				return;
			case "and":
			case "or":
				walk(node.left);
				walk(node.right);
		}
	};
	const node = parse(tokenize(query));
	if (node) walk(node);
	return terms;
}

/** `<column> @@ to_tsquery('ob_search', <query>)`, or null when the query has no matchable terms. */
export function tsQueryMatch(column: PgColumn, query: string): SQL | null {
	const tsquery = toTsQuery(query);
	if (tsquery.length === 0) return null;
	return sql`${column} @@ to_tsquery(${SEARCH_CONFIG}, ${tsquery})`;
}

/**
 * The pg_trgm fallback: every positive term must appear as a SUBSTRING of the concatenated haystack.
 * `ILIKE '%term%'` is answered from the `gin_trgm_ops` index on that same expression, so this is an
 * index scan and not a table scan -- but only if the expression here stays character-identical to the
 * one indexed in schema.ts. Returns null when there is nothing to match on.
 */
export function substringMatch(columns: PgColumn[], query: string): SQL | null {
	const terms = substringTerms(query);
	if (terms.length === 0 || columns.length === 0) return null;
	const haystack = sql.join(
		columns.map((c) => sql`coalesce(${c}, '')`),
		sql` || ' ' || `,
	);
	const clauses = terms.map((term) => sql`(${haystack}) ILIKE ${`%${term}%`}`);
	return sql.join(clauses, sql` AND `);
}

/**
 * Both halves of one corpus's search: the word match that answers almost everything, and the substring
 * match to fall back to when it answers nothing. Either may be null (a query of nothing but stopwords
 * has no word half; an empty query has neither).
 */
export interface SearchConditions {
	primary: SQL | null;
	fallback: SQL | null;
}

export function itemSearch(query: string): SearchConditions {
	return {
		primary: tsQueryMatch(item.search_vec, query),
		fallback: substringMatch([item.title, item.body], query),
	};
}

export function prCommentSearch(query: string): SearchConditions {
	return {
		primary: tsQueryMatch(prComment.search_vec, query),
		fallback: substringMatch([prComment.body], query),
	};
}

export function emailSearch(query: string): SearchConditions {
	return {
		primary: tsQueryMatch(emailMessage.search_vec, query),
		fallback: substringMatch([emailMessage.subject, emailMessage.body], query),
	};
}

export function slackSearch(query: string): SearchConditions {
	return {
		primary: tsQueryMatch(slackMessage.search_vec, query),
		fallback: substringMatch([slackMessage.text], query),
	};
}

export function whatsappSearch(query: string): SearchConditions {
	return {
		primary: tsQueryMatch(whatsappMessage.search_vec, query),
		fallback: substringMatch(
			[whatsappMessage.content, whatsappMessage.transcript, whatsappMessage.media_desc],
			query,
		),
	};
}

/**
 * Run a corpus's search: word match first, substring only if that returned nothing. Two round trips in
 * the miss case and one in the common case, which is the right trade for a personal tracker -- an ORed
 * single query would make every search pay for the fallback and would let a loose substring hit outrank
 * a real word hit.
 *
 * `run` is supplied by the caller so this stays driver-agnostic: there is no Postgres client in the repo
 * until the cutover (ob 326), and the consumers being ported in ob 324 each have their own query shape
 * (columns, ordering, limit). They pass a closure that applies the condition to their own select.
 */
export async function runSearch<T>(
	conditions: SearchConditions,
	run: (where: SQL) => Promise<T[]>,
): Promise<T[]> {
	if (conditions.primary) {
		const hits = await run(conditions.primary);
		if (hits.length > 0) return hits;
	}
	if (conditions.fallback) return run(conditions.fallback);
	return [];
}
