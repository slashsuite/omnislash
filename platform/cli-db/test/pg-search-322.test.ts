import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
	emailSearch,
	itemSearch,
	prCommentSearch,
	runSearch,
	slackSearch,
	substringMatch,
	substringTerms,
	toTsQuery,
	tsQueryMatch,
	whatsappSearch,
} from "../../../apps/cli/src/db/pg/search.ts";
import { item } from "../../../apps/cli/src/db/pg/schema.ts";

// 322: the fts5 -> tsvector rewrite, guarded WITHOUT a database, exactly as 321 is. The behavioural
// half of this phase (does tsvector find what fts5 found?) cannot be answered by a unit test at all --
// it needs both engines over one corpus, which no unit test holds. What IS assertable here, and what breaks silently if it is wrong:
//
//   * the query translator, because a wrong tsquery is a search that quietly returns the wrong rows;
//   * that no user input can escape into tsquery OPERATORS, since the query is user text;
//   * that the trigram fallback's haystack expression stays character-identical to the one indexed in
//     schema.ts -- if it drifts, the ILIKE stops using the gin_trgm_ops index and silently becomes a
//     sequential scan of every message in the tracker;
//   * that the fallback is a FALLBACK, not an OR, since that is the whole reason it is safe to have.

const dialect = new PgDialect();

function render(fragment: SQL | null): { sql: string; params: unknown[] } {
	if (!fragment) throw new Error("expected a SQL fragment, got null");
	const query = dialect.sqlToQuery(fragment);
	return { sql: query.sql, params: query.params };
}

describe("tsquery translation (322)", () => {
	test("bare terms are ANDed, as fts5 does implicitly", () => {
		expect(toTsQuery("postgres migration")).toBe("('postgres' & 'migration')");
	});

	test("a single term is a single lexeme", () => {
		expect(toTsQuery("drizzle")).toBe("'drizzle'");
	});

	test("AND / OR / NOT carry over", () => {
		expect(toTsQuery("a AND b")).toBe("('a' & 'b')");
		expect(toTsQuery("a OR b")).toBe("('a' | 'b')");
		expect(toTsQuery("a NOT b")).toBe("('a' & !'b')");
	});

	test("OR binds looser than AND, so a OR b c parses as a OR (b AND c)", () => {
		expect(toTsQuery("a OR b c")).toBe("('a' | ('b' & 'c'))");
	});

	test("parentheses group", () => {
		expect(toTsQuery("(a OR b) c")).toBe("(('a' | 'b') & 'c')");
	});

	test("a quoted phrase becomes an adjacency query", () => {
		expect(toTsQuery('"database is locked"')).toBe("'database' <-> 'is' <-> 'locked'");
	});

	test("a trailing star becomes a tsquery prefix", () => {
		expect(toTsQuery("migrat*")).toBe("'migrat':*");
	});

	test("an unterminated quote is still a phrase, not an error", () => {
		expect(toTsQuery('"database is locked')).toBe("'database' <-> 'is' <-> 'locked'");
	});

	test("an empty or whitespace-only query yields no tsquery at all", () => {
		expect(toTsQuery("")).toBe("");
		expect(toTsQuery("   ")).toBe("");
	});

	test("a query of nothing but operators yields no tsquery rather than a syntax error", () => {
		// fts5 raises `invalid search query` here and cmdSearch turns that into an AppError. On this side
		// it degrades to "matches nothing", which is the safer failure for a search box.
		expect(toTsQuery("AND")).toBe("");
		expect(toTsQuery("()")).toBe("");
	});
});

describe("no user input escapes into tsquery operators (322)", () => {
	test("tsquery metacharacters are inert inside a quoted lexeme", () => {
		for (const hostile of ["a & b", "a | b", "!a", "a:*", "a <-> b", "a'b", "a\\b"]) {
			const tsquery = toTsQuery(hostile);
			// every lexeme is single-quoted; the only unquoted characters may be operators WE emitted.
			const outside = tsquery.replace(/'(?:[^']|'')*'/g, "");
			// what is left once OUR operators are removed must be nothing: any residue is user text that
			// reached the tsquery unquoted.
			expect({ hostile, residue: outside.replace(/[\s()&|!:*<>-]/g, "") }).toEqual({ hostile, residue: "" });
		}
	});

	test("a single quote is doubled, so it cannot close its own lexeme", () => {
		expect(toTsQuery("o'brien")).toBe("'o''brien'");
	});

	test("a backslash is doubled", () => {
		expect(toTsQuery("a\\b")).toBe("'a\\\\b'");
	});
});

describe("the tsquery clause (322)", () => {
	test("matches the generated column with the ob_search configuration", () => {
		const { sql, params } = render(tsQueryMatch(item.search_vec, "postgres migration"));
		expect(sql).toBe(`"item"."search_vec" @@ to_tsquery($1, $2)`);
		expect(params).toEqual(["ob_search", "('postgres' & 'migration')"]);
	});

	test("an unmatchable query produces no clause at all, never an empty to_tsquery", () => {
		// to_tsquery('ob_search', '') is a SYNTAX ERROR, so the null here is load-bearing.
		expect(tsQueryMatch(item.search_vec, "")).toBeNull();
	});
});

describe("the pg_trgm fallback (322)", () => {
	test("the haystack is character-identical to the expression indexed in schema.ts", async () => {
		// The gin_trgm_ops index in migration 0001 is on
		//   (coalesce("title", '') || ' ' || coalesce("body", ''))
		// and Postgres only uses an expression index when the query expression MATCHES it. A drift here
		// costs nothing at typecheck time and turns every fallback search into a sequential scan.
		const { sql } = render(substringMatch([item.title, item.body], "acmecorp"));
		expect(sql).toContain(`coalesce("item"."title", '') || ' ' || coalesce("item"."body", '')`);
		expect(sql).toContain("ILIKE");
	});

	test("every positive term must appear as a substring", () => {
		const { sql, params } = render(substringMatch([item.title, item.body], "acmecorp 322"));
		expect(sql.split(" AND ").length).toBe(2);
		expect(params).toEqual(["%acmecorp%", "%322%"]);
	});

	test("a phrase stays one substring, keeping its spaces", () => {
		expect(substringTerms('"database is locked"')).toEqual(["database is locked"]);
	});

	test("a prefix star is stripped -- a substring match already covers a prefix", () => {
		expect(substringTerms("migrat*")).toEqual(["migrat"]);
	});

	test("a negated term is NOT required as a substring", () => {
		expect(substringTerms("postgres NOT sqlite")).toEqual(["postgres"]);
	});

	test("no terms means no clause", () => {
		expect(substringMatch([item.title], "")).toBeNull();
	});
});

describe("the fallback is a fallback, not an OR (322)", () => {
	test("a word match that returns rows never runs the substring query", async () => {
		const ran: string[] = [];
		const hits = await runSearch<{ id: string }>(itemSearch("postgres"), async (where) => {
			ran.push(render(where).sql);
			return [{ id: "itm-1" }];
		});
		expect(hits).toEqual([{ id: "itm-1" }]);
		expect(ran.length).toBe(1);
		expect(ran[0]).toContain("@@");
	});

	test("a word match that returns nothing falls through to the substring query", async () => {
		const ran: string[] = [];
		const hits = await runSearch<{ id: string }>(itemSearch("acmecorp"), async (where) => {
			ran.push(render(where).sql);
			return ran.length === 1 ? [] : [{ id: "itm-2" }];
		});
		expect(hits).toEqual([{ id: "itm-2" }]);
		expect(ran.length).toBe(2);
		expect(ran[1]).toContain("ILIKE");
	});

	test("a query with neither half runs nothing and returns nothing", async () => {
		let calls = 0;
		const hits = await runSearch<{ id: string }>(itemSearch(""), async () => {
			calls++;
			return [];
		});
		expect({ hits, calls }).toEqual({ hits: [], calls: 0 });
	});
});

describe("every fts5 corpus has a replacement (322)", () => {
	const corpora = {
		"item_fts -> item.search_vec": itemSearch("drizzle"),
		"pr_comment_fts -> pr_comment.search_vec": prCommentSearch("drizzle"),
		"email_fts -> email_message.search_vec": emailSearch("drizzle"),
		"slack_fts -> slack_message.search_vec": slackSearch("drizzle"),
		"whatsapp_fts -> whatsapp_message.search_vec": whatsappSearch("drizzle"),
	};

	for (const [name, conditions] of Object.entries(corpora)) {
		test(`${name} has both a word clause and a substring clause`, () => {
			expect(render(conditions.primary).sql).toContain(`"search_vec" @@ to_tsquery(`);
			expect(render(conditions.fallback).sql).toContain("ILIKE");
		});
	}

	test("each corpus searches the columns its fts5 table indexed", () => {
		const columnsOf = (fragment: SQL | null) =>
			[...render(fragment).sql.matchAll(/"[a-z_]+"\."([a-z_]+)"/g)].map((m) => m[1]!);
		expect(columnsOf(itemSearch("x").fallback)).toEqual(["title", "body"]);
		expect(columnsOf(prCommentSearch("x").fallback)).toEqual(["body"]);
		expect(columnsOf(emailSearch("x").fallback)).toEqual(["subject", "body"]);
		expect(columnsOf(slackSearch("x").fallback)).toEqual(["text"]);
		// 336: whatsapp is the one corpus that indexes MORE than its fts5 table did.
		expect(columnsOf(whatsappSearch("x").fallback)).toEqual(["content", "transcript", "media_desc"]);
	});
});
