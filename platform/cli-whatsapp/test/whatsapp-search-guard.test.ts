import { describe, expect, test } from "bun:test";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import {
  buildSearchGuard,
  checkSearchQuery,
  guardRules,
  searchGuardHookProgram,
  runGuardHook,
  searchGuardSettings,
  selfTestGuardHook,
  GUARD_DENY_MARKER,
  MIN_DIGIT_RUN,
  type SearchGuard,
} from "../src/whatsapp/search-guard.ts";
import { assembleSuggestContext } from "../src/whatsapp/suggest.ts";
import { addPerson } from "../../../apps/cli/src/commands/person.ts";
import { createItem } from "../../../apps/cli/src/items.ts";

// The panel's web-egress guard (#121). NOTHING here touches the network: these tests build the guard from a
// seeded local chat, assert what may and may not leave, and then run the GENERATED PreToolUse hook program
// as its own process to prove it makes the same call the in-process check does.

const CHAT = "27000000004@s.whatsapp.net";

function insertMsg(
  db: ReturnType<typeof freshDb>,
  m: { id: string; content: string; is_from_me?: 0 | 1; ts: string; sender_jid?: string | null; person_id?: number | null },
): void {
  db.query(
    `INSERT INTO whatsapp_message(id, chat_jid, sender_jid, content, ts, is_from_me, person_id, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.id, CHAT, m.sender_jid ?? null, m.content, m.ts, m.is_from_me ?? 0, m.person_id ?? null, m.ts);
}

/** The live-use shape: a resolved partner, a dinner thread, and an unrelated open work item. */
async function guardForSeededChat(): Promise<SearchGuard> {
  const db = freshDb();
  const p = addPerson(db, "Mia Example", { role: "partner", whatsapp_jid: CHAT, relationship: "girlfriend" });
  await createItem(db, { type: "task", title: "Fix the kitchen sink", status: "in_progress" });
  insertMsg(db, { id: "1", content: "are we still on for Thursday evening?", ts: "2026-07-20T09:00:00.000Z", sender_jid: CHAT, person_id: p.id });
  insertMsg(db, { id: "2", content: "yes! where do you want to eat", ts: "2026-07-20T09:02:00.000Z", is_from_me: 1 });
  insertMsg(db, { id: "3", content: "somewhere Asian, close to Elmsworth please", ts: "2026-07-20T09:05:00.000Z", sender_jid: CHAT, person_id: p.id });
  const guard = buildSearchGuard(await assembleSuggestContext(sqliteStoreFor(db), CHAT), {
    draft: "Booked us a table for seven",
  });
  db.close();
  return guard;
}

describe("buildSearchGuard - everything the model can see about the chat is guarded", () => {
  test("guards the contact's name, the number, quoted message text, work and the draft", async () => {
    const guard = await guardForSeededChat();

    expect(guard.words).toContain("mia");
    expect(guard.words).toContain("example");
    expect(guard.words).toContain("27000000004");
    expect(guard.phrases).toContain("are we still on");
    expect(guard.phrases).toContain("somewhere asian close to");
    expect(guard.phrases).toContain("fix the kitchen sink");
    expect(guard.phrases).toContain("booked us a table");
  });

  test("does not guard the role label, so ordinary public words stay searchable", async () => {
    const guard = await guardForSeededChat();
    expect(guard.words).not.toContain("partner");
    expect(guard.words).not.toContain("girlfriend");
  });
});

describe("checkSearchQuery - the public thing goes out, the private detail never does", async () => {
  const guard = await guardForSeededChat();

  test("allows exactly what the panel exists for: asking about a place", () => {
    for (const query of [
      "Asian restaurants Elmsworth Cape Town",
      "Futchi Asian food Cape Town reviews",
      "best places to eat in Elmsworth",
      "https://www.tripadvisor.com/Restaurants-Elmsworth",
      "Table Mountain cableway opening hours",
    ]) {
      expect(checkSearchQuery(query, guard)).toEqual({ ok: true });
    }
  });

  test("refuses a contact name, however it is cased or punctuated", () => {
    for (const query of ["Mia favourite restaurant", "what does MIA. like to eat", "mia's birthday gift ideas"]) {
      const verdict = checkSearchQuery(query, guard);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(GUARD_DENY_MARKER);
    }
  });

  test("refuses a phone number / jid, including the spaced-out way people write one", () => {
    expect(checkSearchQuery("who owns 27000000004", guard).ok).toBe(false);
    expect(checkSearchQuery("27 00 000 0004 whatsapp", guard).ok).toBe(false);
    expect(checkSearchQuery("+27 00 000 0004", guard).ok).toBe(false);
    // A short number is a normal part of a public query and stays allowed.
    expect(checkSearchQuery("restaurants open until 22 00", guard).ok).toBe(true);
    expect(`${MIN_DIGIT_RUN}`).toBe("7");
  });

  test("a review-page URL's long numeric id is NOT a phone number - reading the page stays possible", () => {
    // The exact shape a live search returns; blocking this would kill the "read the actual reviews" case.
    const url = "https://www.tripadvisor.co.za/Restaurant_Review-g312665-d7856056-Reviews-Simply_Asia_Paddocks.html";
    expect(checkSearchQuery(url, guard).ok).toBe(true);
    expect(checkSearchQuery(JSON.stringify({ url, prompt: "what do the reviews say" }), guard).ok).toBe(true);
    // A real number still cannot hide inside a URL - the guarded jid is matched wherever it appears.
    expect(checkSearchQuery("https://example.com/?q=27000000004", guard).ok).toBe(false);
    // Nor can a number sitting next to a URL slip through on the URL's exemption.
    expect(checkSearchQuery(`${url} and call 0000000012`, guard).ok).toBe(false);
  });

  test("refuses a query that quotes the chat, his work or his draft", () => {
    expect(checkSearchQuery("are we still on for Thursday evening etiquette", guard).ok).toBe(false);
    expect(checkSearchQuery("somewhere Asian close to Elmsworth", guard).ok).toBe(false);
    expect(checkSearchQuery("how to fix the kitchen sink", guard).ok).toBe(false);
    expect(checkSearchQuery("booked us a table for seven meaning", guard).ok).toBe(false);
  });

  test("covers a whole serialised tool input, so a URL or a fetch instruction is checked too", () => {
    const input = JSON.stringify({ url: "https://example.com/?q=mia", prompt: "what does it say" });
    expect(checkSearchQuery(input, guard).ok).toBe(false);
    const clean = JSON.stringify({ url: "https://eatout.co.za/elmsworth", prompt: "summarise the reviews" });
    expect(checkSearchQuery(clean, guard).ok).toBe(true);
  });

  test("an empty guard blocks nothing but the number rule", () => {
    const none: SearchGuard = { words: [], phrases: [] };
    expect(checkSearchQuery("Asian restaurants Elmsworth", none).ok).toBe(true);
    expect(checkSearchQuery("call 0000000012", none).ok).toBe(false);
  });
});

describe("searchGuardSettings - the hook is wired in front of the web tools only", () => {
  test("matches WebSearch|WebFetch and runs the generated program with the given runtime", () => {
    const settings = searchGuardSettings("/tmp/ob-wa-panel-x/search-guard.js", "/usr/local/bin/bun") as {
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    const entry = settings.hooks.PreToolUse[0]!;

    expect(entry.matcher).toBe("WebSearch|WebFetch");
    expect(entry.hooks[0]!.type).toBe("command");
    expect(entry.hooks[0]!.command).toBe('"/usr/local/bin/bun" "/tmp/ob-wa-panel-x/search-guard.js"');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });
});

describe("searchGuardHookProgram - the deny happens BEFORE the query leaves, and agrees with the check", () => {
  /** Run the generated hook exactly as `claude -p` runs it: the payload on stdin, a decision on stdout. */
  async function runHook(program: string, toolName: string, toolInput: unknown): Promise<{ decision: string; reason: string }> {
    const dir = await mkdtemp(join(tmpdir(), "ob-guard-hook-test-"));
    try {
      const path = join(dir, "search-guard.js");
      await Bun.write(path, program);
      const proc = Bun.spawn([process.execPath, path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      await proc.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }));
      await proc.stdin.end();
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      const parsed = JSON.parse(out) as {
        hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      return {
        decision: parsed.hookSpecificOutput.permissionDecision,
        reason: parsed.hookSpecificOutput.permissionDecisionReason ?? "",
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("denies a leaking query with the guard's own reason, allows a public one", async () => {
    const guard = await guardForSeededChat();
    const program = searchGuardHookProgram(guardRules(guard));

    const denied = await runHook(program, "WebSearch", { query: "Mia favourite restaurant Elmsworth" });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain(GUARD_DENY_MARKER);
    expect(denied.reason).toContain("mia");

    const allowed = await runHook(program, "WebSearch", { query: "Asian restaurants Elmsworth Cape Town" });
    expect(allowed.decision).toBe("allow");
    expect(allowed.reason).toBe("");
  }, spawnBudget(2));

  test("guards a WebFetch url + prompt too, not just a search query", async () => {
    const guard = await guardForSeededChat();
    const program = searchGuardHookProgram(guardRules(guard));

    const denied = await runHook(program, "WebFetch", { url: "https://example.com/search?q=27000000004", prompt: "who is this" });
    expect(denied.decision).toBe("deny");

    const allowed = await runHook(program, "WebFetch", { url: "https://eatout.co.za/elmsworth", prompt: "summarise the reviews" });
    expect(allowed.decision).toBe("allow");
  }, spawnBudget(2));

  /**
   * Every case in ONE process: a driver imports the generated program and replays each payload through its
   * exported decision path, the same code the stdin/stdout wiring calls. Spawning per case cost 11 process
   * startups against a 5s per-test budget and timed out under parallel load (#148).
   */
  async function batchDecisions(program: string, cases: unknown[]): Promise<{ decision: string; reason: string }[]> {
    const dir = await mkdtemp(join(tmpdir(), "ob-guard-batch-"));
    try {
      const programPath = join(dir, "search-guard.js");
      const driverPath = join(dir, "driver.js");
      await Bun.write(programPath, program);
      await Bun.write(
        driverPath,
        [
          `import { guardDecision, guardedInput } from ${JSON.stringify(programPath)};`,
          `const cases = JSON.parse(await new Response(Bun.stdin.stream()).text());`,
          `const out = cases.map((tool_input) => {`,
          `  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input });`,
          `  const decision = guardDecision(guardedInput(payload));`,
          `  return { decision: decision.permissionDecision, reason: decision.permissionDecisionReason ?? "" };`,
          `});`,
          `console.log(JSON.stringify(out));`,
          "",
        ].join("\n"),
      );
      const proc = Bun.spawn([process.execPath, driverPath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      await proc.stdin.write(JSON.stringify(cases));
      await proc.stdin.end();
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      if (proc.exitCode !== 0) throw new Error((await new Response(proc.stderr).text()).trim() || `driver exited ${proc.exitCode}`);
      return JSON.parse(out) as { decision: string; reason: string }[];
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("agrees with checkSearchQuery on every case - the two matchers cannot drift apart", async () => {
    const guard = await guardForSeededChat();
    const program = searchGuardHookProgram(guardRules(guard));
    const cases: unknown[] = [
      { query: "Asian restaurants Elmsworth Cape Town" },
      { query: "Futchi Asian food Cape Town reviews" },
      { query: "Mia Example restaurant" },
      { query: "somewhere Asian, close to Elmsworth" },
      { query: "how to fix the kitchen sink" },
      { query: "+27 00 000 0004" },
      { query: "restaurants open until 22 00" },
      { url: "https://eatout.co.za/elmsworth", prompt: "summarise the reviews" },
      { url: "https://example.com/?q=mia", prompt: "what does it say" },
      { url: "https://www.tripadvisor.co.za/Restaurant_Review-g312665-d7856056-Reviews-Sake.html", prompt: "reviews" },
      { url: "https://example.com/?q=27000000004", prompt: "who is this" },
    ];

    const decisions = await batchDecisions(program, cases);
    expect(decisions).toHaveLength(cases.length);
    cases.forEach((toolInput, i) => {
      const inProcess = checkSearchQuery(JSON.stringify(toolInput), guard);
      expect(decisions[i]!.decision).toBe(inProcess.ok ? "allow" : "deny");
      if (!inProcess.ok) expect(decisions[i]!.reason).toBe(inProcess.reason);
    });

    // One real end-to-end spawn, so the batch above is known to describe the program the hook actually runs
    // on stdin/stdout - a decision path that stopped being wired in would fail here.
    const wired = cases.findIndex((c) => !checkSearchQuery(JSON.stringify(c), guard).ok);
    expect(wired).toBeGreaterThanOrEqual(0);
    expect(await runHook(program, "WebSearch", cases[wired])).toEqual(decisions[wired]!);
  }, spawnBudget(2)); // the batch driver, plus the one end-to-end run that proves the batch describes it
});

describe("selfTestGuardHook - the pre-flight that decides whether web tools may be granted at all", () => {
  async function withProgram<T>(program: string, fn: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "ob-guard-selftest-"));
    try {
      const path = join(dir, "search-guard.js");
      await Bun.write(path, program);
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("passes for the real generated program", async () => {
    const program = searchGuardHookProgram(guardRules(await guardForSeededChat()));
    const result = await withProgram(program, (path) => selfTestGuardHook(path));
    expect(result.ok).toBe(true);
  }, spawnBudget(2)); // both canaries have to pass, so both are run

  test("fails when the runtime cannot run it, so the caller withholds the web tools", async () => {
    const program = searchGuardHookProgram(guardRules(await guardForSeededChat()));
    const result = await withProgram(program, (path) => selfTestGuardHook(path, "/nonexistent/bun"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  }, spawnBudget(1)); // the first canary already fails, so the self-test stops there

  test("is not vacuous: a program that rubber-stamps everything FAILS the canary", async () => {
    const rubberStamp = [
      'await new Response(Bun.stdin.stream()).text();',
      'console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));',
      "",
    ].join("\n");
    const result = await withProgram(rubberStamp, (path) => selfTestGuardHook(path));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("did not deny its canary");
  }, spawnBudget(1));

  test("a program that crashes fails the pre-flight rather than being trusted", async () => {
    const result = await withProgram('throw new Error("boom");\n', (path) => selfTestGuardHook(path));
    expect(result.ok).toBe(false);
  }, spawnBudget(1));
});

describe("searchGuardHookProgram - attestation", () => {
  test("records each decision it made, so a run can be proven to have been guarded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ob-guard-log-"));
    try {
      const logPath = join(dir, "guard-decisions.log");
      const path = join(dir, "search-guard.js");
      await Bun.write(path, searchGuardHookProgram(guardRules(await guardForSeededChat()), logPath));
      await Bun.write(logPath, "");

      const deny = await runGuardHook(path, { query: "Mia Example favourite restaurant" });
      const allow = await runGuardHook(path, { query: "Asian restaurants Elmsworth Cape Town" });
      expect(deny.decision).toBe("deny");
      expect(allow.decision).toBe("allow");

      const lines = (await Bun.file(logPath).text()).trim().split("\n").map((l) => JSON.parse(l) as { decision: string; input: string });
      expect(lines).toHaveLength(2);
      expect(lines[0]!.decision).toBe("deny");
      expect(lines[1]!.decision).toBe("allow");
      expect(lines[1]!.input).toContain("Asian restaurants Elmsworth Cape Town");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, spawnBudget(2)); // one run per decision, because the log has to show both
});
