import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import {
  registerAgent,
  heartbeatAgent,
  doneAgent,
  listAgents,
  getAgent,
  isAgentExpired,
  isAgentStatus,
  LEGACY_AGENT_STATUSES,
  parseAgentStatus,
  tabTitleEscape,
  effectiveLauncher,
  DEFAULT_AGENT_STATUS,
  InvalidAgentStatusError,
  setAgentRun,
} from "../src/agent.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import { enqueueSpinoff } from "../src/commands/spinoff.ts";

describe("agent registry logic", () => {
  test("register writes the status it is given (NULL included) and a bare re-register preserves it", async () => {
    const db = freshDb();
    const a = (await registerAgent(db, { id: "x", ticket: "CUE-9861", branch: "feat/x", status: "planning", ttlS: 900 }));
    expect(a.status).toBe("planning");
    expect(a.ticket).toBe("CUE-9861");
    const started = a.started_at;

    // bare re-register (heartbeat) keeps ticket/branch/status, bumps heartbeat, keeps started_at
    const b = (await registerAgent(db, { id: "x", ttlS: 900 }));
    expect(b.ticket).toBe("CUE-9861");
    expect(b.branch).toBe("feat/x");
    expect(b.status).toBe("planning"); // an omitted status is not a word
    expect(b.started_at).toBe(started);

    // status change via re-register
    const c = (await registerAgent(db, { id: "x", status: "readying", ttlS: 900 }));
    expect(c.status).toBe("readying");
    expect(c.ticket).toBe("CUE-9861"); // still preserved

    // 1189: the STORE has no default word — a launcher creating a row for a tree/lease claims none, and
    // `ob agent register` (local and over the API) is where a new row gets the agent's own default.
    const bare = (await registerAgent(db, { id: "bare", ttlS: 900 }));
    expect(bare.status).toBeNull();
  });

  test("needs-human status + reason note; note preserved on bare re-register (058)", async () => {
    const db = freshDb();
    const a = (await registerAgent(db, { id: "x", branch: "feat/x", status: "needs-human", note: "spec ambiguous on empty state", ttlS: 900 }));
    expect(a.status).toBe("needs-human");
    expect(a.note).toBe("spec ambiguous on empty state");

    // a bare heartbeat must not wipe the note
    const b = (await registerAgent(db, { id: "x", ttlS: 900 }));
    expect(b.note).toBe("spec ambiguous on empty state");
    expect(b.status).toBe("needs-human");
  });

  // OB-1923: the store is a second gate, for internal callers that never pass the CLI or API edge.
  test("the store refuses an unknown word and every legacy word by name, and still writes a current one", async () => {
    const db = freshDb();
    for (const word of ["coding", "idle", ...LEGACY_AGENT_STATUSES]) {
      let thrown: unknown = null;
      try {
        await registerAgent(db, { id: "x", status: word, ttlS: 900 });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InvalidAgentStatusError);
      expect(thrown).toBeInstanceOf(UsageError); // the API maps it to 400, the CLI to exit 2
      expect((thrown as Error).message).toContain(`'${word}'`);
    }
    expect(await getAgent(db, "x")).toBeNull(); // a refused insert leaves no row
    expect((await registerAgent(db, { id: "x", status: "working", ttlS: 900 })).status).toBe("working");
    // a refused UPDATE leaves the stored word alone
    await expect(registerAgent(db, { id: "x", status: "manual-review", ttlS: 900 })).rejects.toBeInstanceOf(InvalidAgentStatusError);
    expect((await getAgent(db, "x"))!.status).toBe("working");
  });

  // OB-1923: the run-state mirror's write. Update-only, and liveness follows the run.
  test("setAgentRun updates an existing row only, and moves the heartbeat only for an active run", async () => {
    const db = freshDb();
    expect(await setAgentRun(db, "gone", "running")).toBe(false);
    expect(await getAgent(db, "gone")).toBeNull();

    await registerAgent(db, { id: "b", status: "working", ttlS: 900 });
    const s = asStore(db);
    const old = "2020-01-01T00:00:00.000Z";
    await s.q.update(s.t.agent).set({ heartbeat_at: old }).where(eq(s.t.agent.id, "b"));

    expect(await setAgentRun(db, "b", "running")).toBe(true);
    const live = (await getAgent(db, "b"))!;
    expect(live.run).toBe("running");
    expect(live.status).toBe("working"); // the agent's own word is never touched
    expect(live.heartbeat_at).not.toBe(old);

    await s.q.update(s.t.agent).set({ heartbeat_at: old }).where(eq(s.t.agent.id, "b"));
    for (const finished of ["completed", "interrupted", "cancelled", "rolled_back"]) {
      expect(await setAgentRun(db, "b", finished)).toBe(true);
      const row = (await getAgent(db, "b"))!;
      expect(row.run).toBe(finished);
      expect(row.heartbeat_at).toBe(old);
    }
  });

  test("heartbeat + done", async () => {
    const db = freshDb();
    (await registerAgent(db, { id: "x", ttlS: 900 }));
    expect((await heartbeatAgent(db, "x"))).toBe(true);
    expect((await heartbeatAgent(db, "nope"))).toBe(false);
    expect((await doneAgent(db, "x"))).toBe(true);
    expect((await getAgent(db, "x"))).toBeNull();
  });

  test("listAgents filters expired unless includeExpired", async () => {
    const db = freshDb();
    // ttl 1s, heartbeat far in the past → expired
    (await registerAgent(db, { id: "stale", ttlS: 1 }));
    db.query("UPDATE agent SET heartbeat_at = '2000-01-01T00:00:00Z', started_at = '2000-01-01T00:00:00Z' WHERE id = 'stale'").run();
    (await registerAgent(db, { id: "live", ttlS: 900 }));

    expect((await listAgents(db)).map((a) => a.id)).toEqual(["live"]);
    expect((await listAgents(db, { includeExpired: true })).map((a) => a.id).sort()).toEqual(["live", "stale"]);
  });

  test("isAgentExpired + isAgentStatus", () => {
    const now = Date.parse("2026-07-17T12:00:00Z");
    const fresh = { heartbeat_at: "2026-07-17T11:59:00Z", started_at: "x", ttl_s: 900 } as never;
    const old = { heartbeat_at: "2026-07-17T11:00:00Z", started_at: "x", ttl_s: 900 } as never;
    expect(isAgentExpired(fresh, now)).toBe(false);
    expect(isAgentExpired(old, now)).toBe(true);
    // 1189: the five ob workflow words, and only them, are writable statuses.
    expect(isAgentStatus("planning")).toBe(true);
    expect(isAgentStatus("needs-human")).toBe(true);
    expect(isAgentStatus("blocked")).toBe(true);
    // The retired words are NOT writable any more; they still READ off old rows (LEGACY_AGENT_STATUSES).
    for (const retired of LEGACY_AGENT_STATUSES) expect([retired, isAgentStatus(retired)]).toEqual([retired, false]);
    // T3's enum left the column entirely: it is `run` now, and the mirror writes it there.
    expect(isAgentStatus("waiting")).toBe(false);
    expect(isAgentStatus("running")).toBe(false);
    expect(isAgentStatus("completed")).toBe(false);
    expect(isAgentStatus("coding")).toBe(false);
    expect(parseAgentStatus("needs-human")).toBe("needs-human");
    expect(parseAgentStatus("waiting")).toBeNull();
    expect(parseAgentStatus("coding")).toBeNull();
  });

  test("tabTitleEscape builds an OSC title `<status> · <ticket>` (062)", () => {
    const e = tabTitleEscape("manual-review", "CUE-9893");
    expect(e.charCodeAt(0)).toBe(0x1b); // ESC
    expect(e.charCodeAt(e.length - 1)).toBe(0x07); // BEL
    expect(e).toContain("]0;manual-review · CUE-9893");
    // control chars in the inputs are stripped
    expect(tabTitleEscape("work\x07ing", "CUE\n1")).toContain("]0;working · CUE1");
    // nothing to show → empty (no stray escape written)
    expect(tabTitleEscape(null, null)).toBe("");
  });
});

describe("CLI: ob agent / ob agents", () => {
  test("register → agents → done round-trip", async () => {
    const dbPath = freshDbPath();
    const reg = await runCli(dbPath, ["agent", "register", "--ticket", "CUE-9861", "--id", "worker-1", "--status", "planning"]);
    expect(reg.code).toBe(0);

    const list = await runCli(dbPath, ["agents", "--json"]);
    const rows = JSON.parse(list.out);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "worker-1", ticket: "CUE-9861", status: "planning" });

    const done = await runCli(dbPath, ["agent", "done", "worker-1"]);
    expect(done.code).toBe(0);
    const after = await runCli(dbPath, ["agents", "--json"]);
    expect(JSON.parse(after.out)).toHaveLength(0);
  });

  // 1189: the human line joins the two vocabularies; --json keeps them APART, and a headless builder's run
  // is null rather than something invented to fill the column.
  test("ob agents prints `status · run`, and --json carries the two fields separately", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    await registerAgent(db, { id: "b-1189", ticket: "1189", branch: "1189", status: "working", run: "running", launcher: "t3", ttlS: 900 });
    await registerAgent(db, { id: "h-1189", ticket: "1189", branch: "1189-h", status: "working", launcher: "headless", ttlS: 900 });
    db.close();

    const human = (await runCli(dbPath, ["agents"])).out;
    expect(human).toContain("working · running"); // the t3 row: ob's word, then T3's
    expect(human).toMatch(/h-1189\tworking\t/); // the headless row: its word alone, no run

    const rows = JSON.parse((await runCli(dbPath, ["agents", "--json"])).out) as Array<{ id: string; status: string; run: string | null }>;
    expect(rows.find((r) => r.id === "b-1189")).toMatchObject({ status: "working", run: "running" });
    expect(rows.find((r) => r.id === "h-1189")).toMatchObject({ status: "working", run: null });
  });

  // 1189: the default word is the AGENT's, applied where it registers itself — not in the store, so a
  // launcher creating the row for a tree/lease claims no workflow word (see the spinoff test for that half).
  test("`ob agent register` with no --status gives a NEW row the agent's default word", async () => {
    const dbPath = freshDbPath();
    const reg = await runCli(dbPath, ["agent", "register", "--id", "d-1189", "--no-lease"]);
    expect(reg.code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["agents", "--json"])).out)[0]).toMatchObject({
      id: "d-1189",
      status: DEFAULT_AGENT_STATUS,
      run: null,
    });
  });

  test("register refuses T3's words: they are `run`, not ob's `status` (1189)", async () => {
    const dbPath = freshDbPath();
    const reg = await runCli(dbPath, ["agent", "register", "--id", "w-wait", "--status", "waiting", "--no-lease"]);
    expect(reg.code).toBe(2);
    expect(reg.err).toContain("must be one of");
  });

  // 1189: the retired words are unwritable but old rows still READ — shown as they are, never rewritten.
  test("a retired status reads off an old row and is never written again (1189)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    // OB-1923: the store refuses the word too, so the old row is seeded straight into the table
    await registerAgent(db, { id: "w2", branch: "cue-9893", note: "transcript pagination unverified", ttlS: 900 });
    const s = asStore(db);
    await s.q.update(s.t.agent).set({ status: "manual-review" }).where(eq(s.t.agent.id, "w2"));
    db.close();

    // READ: the row shows exactly what it holds
    const rows = JSON.parse((await runCli(dbPath, ["agents", "--json"])).out);
    expect(rows[0]).toMatchObject({ id: "w2", status: "manual-review", note: "transcript pagination unverified" });

    // WRITE: the same word through the CLI is refused, and the stored row is left alone
    const bad = await runCli(dbPath, ["agent", "register", "--id", "w2", "--status", "manual-review", "--no-lease"]);
    expect(bad.code).toBe(2);
    expect(JSON.parse((await runCli(dbPath, ["agents", "--json"])).out)[0].status).toBe("manual-review");
  });

  test("register rejects an unknown --status", async () => {
    const r = await runCli(freshDbPath(), ["agent", "register", "--id", "w3", "--status", "coding"]);
    expect(r.code).toBe(2);
  });

  test("invalid --status is a usage error", async () => {
    const dbPath = freshDbPath();
    const bad = await runCli(dbPath, ["agent", "register", "--status", "coding"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("must be one of");
  });

  // #151: the app's spawn-failure report (#146) carries --spawn-failed, which is what tells the queue
  // apart from a run that failed: only a launch that produced NO session invalidates the spinoff row.
  // 1189: the report no longer also demands `--status failed` — `failed` is a launcher word that left the
  // agent vocabulary, and the spinoff row is where a launch's failure is recorded.
  test("register --spawn-failed re-queues the launched spinoff row it names", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    (await enqueueSpinoff(db, { ticketRef: "S-1", repo: "/r/x", branch: "s-1", mode: "agent", brief: "b" }));
    db.query("UPDATE spinoff SET status='launched', agent_id='s-1', launch_attempts=1 WHERE branch='s-1'").run();
    db.close();

    const reg = await runCli(dbPath, [
      "agent", "register", "--id", "s-1", "--branch", "s-1", "--spawn-failed",
      "--note", "spawn produced no session: forkpty failed", "--no-lease", "--json",
    ]);

    expect(reg.code).toBe(0);
    expect(JSON.parse(reg.out).spinoff).toMatchObject({ ticket: "S-1", status: "queued", retrying: true });
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out);
    expect(rows[0]).toMatchObject({ ticket_ref: "S-1", status: "queued", error: "spawn produced no session: forkpty failed" });
  });

  test("a plain register never touches the queue, however its run went", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    (await enqueueSpinoff(db, { ticketRef: "S-2", repo: "/r/x", branch: "s-2", mode: "agent", brief: "b" }));
    db.query("UPDATE spinoff SET status='launched', agent_id='s-2', launch_attempts=1 WHERE branch='s-2'").run();
    db.close();

    // the agent ran and its gate went red: the queue must not act on that
    const reg = await runCli(dbPath, ["agent", "register", "--id", "s-2", "--status", "blocked", "--note", "gate red", "--no-lease"]);

    expect(reg.code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out)[0]).toMatchObject({ status: "building" });
  });

  test("--spawn-failed with a retired --status is still a usage error", async () => {
    const r = await runCli(freshDbPath(), ["agent", "register", "--id", "s-3", "--spawn-failed", "--status", "failed", "--no-lease"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("must be one of");
  });

  test("empty agents list is clean", async () => {
    const dbPath = freshDbPath();
    const list = await runCli(dbPath, ["agents"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("no active agents");
  });
});

// #125: "where does this agent live?" is the question you ask when something dies, so `ob agents`, the
// cross-launcher view, answers it on every row.
describe("agent launcher (#125)", () => {
  test("effectiveLauncher: the agent's own value wins, then its spinoff's, then null", () => {
    expect(effectiveLauncher({ launcher: "headless" }, "warp")).toBe("headless");
    expect(effectiveLauncher({ launcher: null }, "warp")).toBe("warp");
    expect(effectiveLauncher({ launcher: null }, undefined)).toBeNull();
  });

  test("register --launcher round-trips, and a re-register without it keeps the recorded value", async () => {
    const dbPath = freshDbPath();
    const reg = await runCli(dbPath, ["agent", "register", "--id", "w1", "--launcher", "t3"]);
    expect(reg.code).toBe(0);
    let rows = JSON.parse((await runCli(dbPath, ["agents", "--json"])).out);
    expect(rows[0]).toMatchObject({ id: "w1", launcher: "t3" });
    // the heartbeat form must not blank it out
    expect((await runCli(dbPath, ["agent", "register", "--id", "w1", "--status", "readying"])).code).toBe(0);
    rows = JSON.parse((await runCli(dbPath, ["agents", "--json"])).out);
    expect(rows[0]).toMatchObject({ id: "w1", status: "readying", launcher: "t3" });
  });

  test("register rejects an unknown --launcher", async () => {
    const r = await runCli(freshDbPath(), ["agent", "register", "--id", "w2", "--launcher", "iterm"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--launcher must be one of");
  });

  test("ob agents shows the launcher, falling back to the launching spinoff's when the row has none", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const { row } = (await enqueueSpinoff(db, {
      ticketRef: "#125",
      repo: "/dev/acme",
      branch: "125-x",
      mode: "agent",
      brief: "do it",
    }));
    db.query("UPDATE spinoff SET status = 'launched', agent_id = '125-x', launcher = 'warp' WHERE id = ?").run(row.id);
    (await registerAgent(db, { id: "125-x", ticket: "#125", branch: "125-x", ttlS: 900 })); // legacy: no launcher of its own
    db.close();

    const rows = JSON.parse((await runCli(dbPath, ["agents", "--json"])).out);
    expect(rows[0]).toMatchObject({ id: "125-x", launcher: "warp" });
    const human = await runCli(dbPath, ["agents"]);
    expect(human.out).toContain("warp");
  });

  // #79 removed warp as a launcher, but the live registry holds rows stamped with it. #125's rule is that
  // a row is never dropped or broken for the launcher it carries, so those rows still read, render and
  // round-trip as `warp`; only ROUTING to it stopped. Nothing backfills or rewrites them: tidying a
  // vocabulary is not a reason to rewrite where an agent actually lived.
  test("a legacy warp row still reads and renders as warp, and is never rewritten (#79)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    (await registerAgent(db, { id: "legacy-warp", ticket: "CUE-1", branch: "cue-1", launcher: "warp", ttlS: 900 }));
    db.close();

    const rows = JSON.parse((await runCli(dbPath, ["agents", "--json"])).out);
    expect(rows[0]).toMatchObject({ id: "legacy-warp", launcher: "warp" });
    const human = await runCli(dbPath, ["agents"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("legacy-warp");
    expect(human.out).toContain("warp"); // labelled honestly, not blanked to '-' and not an error
    const all = await runCli(dbPath, ["agents", "--all"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("warp");

    // a heartbeat that does not name a launcher leaves the recorded value exactly as it was
    expect((await runCli(dbPath, ["agent", "register", "--id", "legacy-warp", "--status", "working", "--no-lease"])).code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["agents", "--json"])).out)[0].launcher).toBe("warp");
  });

  test("ob agents renders '-' when nothing knows where an agent lives", async () => {
    const dbPath = freshDbPath();
    expect((await runCli(dbPath, ["agent", "register", "--id", "loose", "--no-lease"])).code).toBe(0);
    const human = await runCli(dbPath, ["agents"]);
    expect(human.out).toContain("loose\tworking\t-\t");
    const rows = JSON.parse((await runCli(dbPath, ["agents", "--json"])).out);
    expect(rows[0].launcher).toBeNull();
  });
});
