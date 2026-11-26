import type { SuggestContext } from "./suggest.ts";

// ── The reply panel's web-egress guard (#121) ───────────────────────────────────────────────────────
// The conversational panel is the ONE WhatsApp path with web access (WebSearch + WebFetch), because
// "where should we eat Thursday" is unanswerable from local state alone. A search query is EGRESS, and the
// permanent repo rule is that nothing reaches an external service without explicit human confirmation.
//
// So the panel may search WHAT THE OWNER ASKED ABOUT - a place name, a suburb, a cuisine, a business - and
// must never put LOCAL PRIVATE DETAIL in a query: contact names, phone numbers/jids, quoted message text,
// ob work titles, his bio. The thread decides WHAT to look up; it never travels.
//
// That is enforced in three layers, not hoped for:
//   1. a prompt rule (converse.ts) stating the line explicitly;
//   2. THIS guard, compiled to a PreToolUse hook the panel's `claude -p` runs before every WebSearch /
//      WebFetch - a query carrying guarded detail is DENIED, so it never leaves the machine (the model is
//      told why and can retry with the public part only);
//   3. post-hoc observation: the queries actually used are read back off the stream and re-checked here,
//      so if the hook ever fails to fire the panel still SHOWS the leak instead of hiding it.
//
// Everything here is pure and local: guard terms come from the already-assembled SuggestContext, and the
// terms themselves are never sent anywhere - they only ever cause a refusal.

/** Words this long or shorter are too generic to guard on (they'd block ordinary public queries). */
const MIN_TERM_LENGTH = 3;

/** How many words of local text make a guarded phrase - long enough that quoting trips, topics don't. */
export const GUARD_PHRASE_WORDS = 4;

/** Cap on guarded phrases so a long thread can't grow the hook program unboundedly. */
export const MAX_GUARD_PHRASES = 600;

/** A digit run this long (separators allowed) reads as a phone number / jid and is refused outright. */
export const MIN_DIGIT_RUN = 7;

/** Every refusal carries this marker, so the panel and the model can both recognise a guard denial. */
export const GUARD_DENY_MARKER = "BLOCKED-BY-OB-EGRESS-GUARD";

/**
 * Role/label words that ride along with a resolved contact ("Mia Example (partner)", "unknown contact")
 * and would otherwise be guarded as if they were names - blocking innocent public queries.
 */
const LABEL_WORDS = new Set([
  "unknown",
  "contact",
  "group",
  "chat",
  "partner",
  "girlfriend",
  "boyfriend",
  "wife",
  "husband",
  "friend",
  "family",
  "colleague",
  "the",
  "and",
]);

/** The guarded local material for ONE chat: name tokens, quoted phrases, and the digit-run rule. */
export interface SearchGuard {
  /** Single words that may not appear in a query - contact name tokens and jid/phone digit strings. */
  words: string[];
  /** Word spans lifted from local text (thread, bio, work, draft): quoting any of them is a refusal. */
  phrases: string[];
}

export const emptySearchGuard: SearchGuard = { words: [], phrases: [] };

/** One compiled check. `digits` is the number rule; `term` is a word/phrase that must not appear. */
export interface GuardRule {
  kind: "digits" | "term";
  value: string;
  /** What the model (and the panel) is told when this rule refuses a query. */
  reason: string;
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** Lowercase, drop punctuation, collapse whitespace - so "Mia's!" and "mia" compare equal. */
export function normalizeForGuard(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The digit-run pattern: MIN_DIGIT_RUN digits, tolerating the spaces/dashes/brackets people type. */
function digitRunPattern(): RegExp {
  return new RegExp(`\\d(?:[\\s\\-().+]*\\d){${MIN_DIGIT_RUN - 1}}`);
}

/**
 * URLs are exempt from the DIGIT rule (only): a review page id like
 * `Restaurant_Review-g312665-d7856056` is a long digit run with nothing private in it, and blocking it
 * would kill the "read the actual reviews page" case the panel exists for. A real number still cannot hide
 * in a URL - the guarded jid/phone strings are matched as terms across the whole input, URLs included.
 */
function urlPattern(): RegExp {
  return /https?:\/\/[^\s"'<>]+/g;
}

/** What the digit rule looks at: the input with its URLs removed. */
function digitTarget(input: string): string {
  return input.replace(urlPattern(), " ");
}

/** Name tokens worth guarding from a display label, with the role/label noise dropped. */
function nameTokens(label: string | null | undefined): string[] {
  if (!label) return [];
  const stripped = label.replace(/\([^)]*\)/g, " ").replace(/<[^>]*>/g, " ");
  return normalizeForGuard(stripped)
    .split(" ")
    .filter((w) => w.length >= MIN_TERM_LENGTH && !LABEL_WORDS.has(w) && !/^\d+$/.test(w));
}

/** The digit strings in a jid worth guarding outright (the whole number and its national part). */
function jidDigits(jid: string | null | undefined): string[] {
  const local = (jid ?? "").split("@")[0] ?? "";
  const digits = local.replace(/\D+/g, "");
  if (digits.length < 6) return [];
  return digits.length > 9 ? [digits, digits.slice(-9)] : [digits];
}

/** Every GUARD_PHRASE_WORDS-word span of `text`. Shorter text yields nothing - it carries no quote. */
function phrasesOf(text: string | null | undefined): string[] {
  const words = normalizeForGuard(text ?? "").split(" ").filter(Boolean);
  if (words.length < GUARD_PHRASE_WORDS) return [];
  const out: string[] = [];
  for (let i = 0; i + GUARD_PHRASE_WORDS <= words.length; i++) {
    out.push(words.slice(i, i + GUARD_PHRASE_WORDS).join(" "));
  }
  return out;
}

/**
 * Build the guard for one chat from the SAME read-only context the prompt is built from (so anything the
 * model can see is guarded, by construction). Newest material is added first, so the MAX_GUARD_PHRASES cap
 * drops the oldest thread history rather than the message currently being discussed.
 */
export function buildSearchGuard(ctx: SuggestContext, opts?: { draft?: string | undefined }): SearchGuard {
  const words = new Set<string>();
  for (const token of [
    ...nameTokens(ctx.sender),
    ...nameTokens(ctx.lastSenderName),
    ...nameTokens(ctx.chatName),
    ...ctx.thread.flatMap((line) => (line.fromMe ? [] : nameTokens(line.who))),
  ]) {
    words.add(token);
  }
  for (const digits of [...jidDigits(ctx.chatJid), ...jidDigits(ctx.recipient)]) words.add(digits);

  const phrases = new Set<string>();
  const sources: (string | null | undefined)[] = [
    opts?.draft,
    ctx.lastInboundMessage,
    ...[...ctx.thread].reverse().map((line) => line.content),
    ...ctx.work.map((w) => w.title),
    ctx.selfBio,
    ctx.profile?.comms_notes,
    ctx.profile?.comms_style,
    ...(ctx.profile?.outboundSamples ?? []).slice().reverse(),
  ];
  for (const source of sources) {
    for (const phrase of phrasesOf(source)) {
      if (phrases.size >= MAX_GUARD_PHRASES) break;
      phrases.add(phrase);
    }
  }

  return { words: [...words], phrases: [...phrases] };
}

/**
 * Compile a guard into the ordered rules both the in-process check and the PreToolUse hook run. The
 * reasons are written FOR THE MODEL: each one says what tripped and what to do instead, so a refusal turns
 * into a cleaner public query rather than a dead end.
 */
export function guardRules(guard: SearchGuard): GuardRule[] {
  const rules: GuardRule[] = [
    {
      kind: "digits",
      value: String(MIN_DIGIT_RUN),
      reason: `${GUARD_DENY_MARKER}: the query contains a phone number / jid from local data. Never send numbers out - search the public place or topic by name instead.`,
    },
  ];
  for (const word of guard.words) {
    rules.push({
      kind: "term",
      value: word,
      reason: `${GUARD_DENY_MARKER}: the query contains "${word}", a name from the owner's local contacts or this chat. Search only the public thing being asked about, with the name removed.`,
    });
  }
  for (const phrase of guard.phrases) {
    rules.push({
      kind: "term",
      value: phrase,
      reason: `${GUARD_DENY_MARKER}: the query quotes local text ("${phrase}") from the chat, his work or his bio. Use that only to decide WHAT to look up - search the public place or topic in your own words.`,
    });
  }
  return rules;
}

/**
 * Run the compiled rules over the exact string that would leave the machine (a query, or a whole
 * serialised tool input, so a URL and a fetch instruction are covered too). MIRRORED by the hook program
 * below - the parity test keeps the two honest.
 */
export function applyGuardRules(input: string, rules: GuardRule[]): GuardVerdict {
  const raw = input ?? "";
  const padded = ` ${normalizeForGuard(raw)} `;
  for (const rule of rules) {
    const hit = rule.kind === "digits" ? digitRunPattern().test(digitTarget(raw)) : padded.includes(` ${rule.value} `);
    if (hit) return { ok: false, reason: rule.reason };
  }
  return { ok: true };
}

/** Would this query/tool-input leave local private detail? The in-process form of the hook's decision. */
export function checkSearchQuery(input: string, guard: SearchGuard): GuardVerdict {
  return applyGuardRules(input, guardRules(guard));
}

/**
 * The PreToolUse hook program, with this chat's rules baked in. Run as `<bun> <file>` by `claude -p`
 * before every WebSearch/WebFetch: it reads the hook payload on stdin and either allows the call or DENIES
 * it, which stops the query before any network call happens. The matcher mirrors applyGuardRules; the
 * POLICY (which rules, which reasons) is computed here, in tested code, and only inlined as data.
 *
 * When `logPath` is given the program ATTESTS each decision by appending it there, so the caller can prove
 * afterwards that the guard actually ran for every query the model made. A failed append never changes the
 * decision: attestation is evidence, not enforcement.
 *
 * The decision path is EXPORTED (`guardedInput` / `guardDecision` / `attest`) and the stdin/stdout wiring
 * sits behind `import.meta.main`, so `<bun> <file>` behaves exactly as before while the parity test can
 * import the generated file and check every case against applyGuardRules in ONE process instead of
 * spawning one per case (#148). The exports are the same code the hook runs, not a copy of it.
 */
export function searchGuardHookProgram(rules: GuardRule[], logPath?: string): string {
  return [
    `import { appendFileSync } from "node:fs";`,
    `const LOG = ${JSON.stringify(logPath ?? "")};`,
    `const RULES = ${JSON.stringify(rules)};`,
    `const DIGITS = /${digitRunPattern().source}/;`,
    `const URLS = ${urlPattern().toString()};`,
    `export function guardedInput(raw) {`,
    `  try { return JSON.stringify(JSON.parse(raw).tool_input ?? {}); } catch { return raw; }`,
    `}`,
    `export function guardDecision(input) {`,
    `  const padded = " " + input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";`,
    `  const digitTarget = input.replace(URLS, " ");`,
    `  let deny = null;`,
    `  for (const r of RULES) {`,
    `    const hit = r.kind === "digits" ? DIGITS.test(digitTarget) : padded.includes(" " + r.value + " ");`,
    `    if (hit) { deny = r.reason; break; }`,
    `  }`,
    `  return deny`,
    `    ? { permissionDecision: "deny", permissionDecisionReason: deny }`,
    `    : { permissionDecision: "allow" };`,
    `}`,
    `export function attest(input, decision) {`,
    `  if (!LOG) return;`,
    `  try {`,
    `    appendFileSync(LOG, JSON.stringify({ decision: decision.permissionDecision, input: input.slice(0, 400) }) + "\\n");`,
    `  } catch {}`,
    `}`,
    `if (import.meta.main) {`,
    `  const input = guardedInput(await new Response(Bun.stdin.stream()).text());`,
    `  const decision = guardDecision(input);`,
    `  attest(input, decision);`,
    `  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } }));`,
    `}`,
    "",
  ].join("\n");
}

/**
 * Run a generated hook program exactly as `claude -p` runs it (payload on stdin, decision on stdout) and
 * read back its verdict. Used for the pre-flight self-test; never throws.
 */
export async function runGuardHook(
  hookPath: string,
  toolInput: unknown,
  runtime: string = process.execPath,
): Promise<{ decision: string; reason: string } | { decision: null; reason: string }> {
  try {
    const proc = Bun.spawn([runtime, hookPath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await proc.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: toolInput }));
    await proc.stdin.end();
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (proc.exitCode !== 0) {
      const err = (await new Response(proc.stderr).text()).trim();
      return { decision: null, reason: `the guard program exited ${proc.exitCode}${err ? `: ${err.slice(0, 200)}` : ""}` };
    }
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown };
    };
    const decision = parsed.hookSpecificOutput?.permissionDecision;
    if (typeof decision !== "string") return { decision: null, reason: "the guard program returned no decision" };
    const reason = parsed.hookSpecificOutput?.permissionDecisionReason;
    return { decision, reason: typeof reason === "string" ? reason : "" };
  } catch (e) {
    return { decision: null, reason: `the guard program could not be run: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A random letters-only token for the self-test, so it can never collide with a real guarded term. */
function selfTestToken(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  return Array.from({ length: 24 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
}

/**
 * PROVE the guard works before any web tool is granted (the fail-CLOSED pre-flight). Runs the generated
 * program twice: a canary carrying a long digit run MUST be denied, and a random clean token MUST be
 * allowed. This exercises the real file with the real runtime, so an unwritable file, a missing/incorrect
 * runtime, a crashing program or a malformed decision all surface HERE, where the caller can simply decline
 * to grant WebSearch/WebFetch, instead of surfacing as an unguarded query after the fact.
 */
export async function selfTestGuardHook(
  hookPath: string,
  runtime: string = process.execPath,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = selfTestToken();
  const mustDeny = await runGuardHook(hookPath, { query: `${token} 5550001234567` }, runtime);
  if (mustDeny.decision !== "deny") {
    return {
      ok: false,
      reason: mustDeny.decision === null ? mustDeny.reason : "the guard program did not deny its canary query",
    };
  }
  const mustAllow = await runGuardHook(hookPath, { query: token }, runtime);
  if (mustAllow.decision !== "allow") {
    return {
      ok: false,
      reason: mustAllow.decision === null ? mustAllow.reason : "the guard program refused its own clean canary",
    };
  }
  return { ok: true };
}

/** The `--settings` payload that wires the hook program in front of the two web tools, and nothing else. */
export function searchGuardSettings(hookPath: string, runtime: string = process.execPath): unknown {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "WebSearch|WebFetch",
          hooks: [{ type: "command", command: `"${runtime}" "${hookPath}"` }],
        },
      ],
    },
  };
}
