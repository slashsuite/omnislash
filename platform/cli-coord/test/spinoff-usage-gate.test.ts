// OS-108: past the critical-only line (98% of the weekly Claude usage, until the window resets) a dispatch or
// send-back of a ticket that is not critical is refused, leaving no row; `--over-usage '<why>'` overrides it for
// a human run and goes on the Decisions trail. In-process against fresh SQLite databases, a fake T3, a faked
// shell and a usage-cache fixture (`OB_USAGE_T3_CACHE`): no network, no live store, no live cache.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRepoDir, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { liveRead } from "../../../apps/cli/test/role-run-fixture.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { run } from "../../../apps/cli/src/cli.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { createItem, editItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { PRIORITY_CRITICAL, PRIORITY_MEDIUM, PRIORITY_URGENT } from "../../../apps/cli/src/priority.ts";
import { enqueue as apiEnqueue, spinoffSendBack as apiSendBack } from "../../../apps/cli/src/api/handlers.ts";
import { __setT3Seam, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { resetUsageUnknownWarning } from "../../../apps/cli/src/usage-gate.ts";
import { __setSh, enqueueSpinoff, listSpinoffs } from "../src/commands/spinoff.ts";

const cleanup: Array<() => void> = [];
let savedCache: string | undefined;
let savedThread: string | undefined;
beforeEach(() => {
  savedCache = process.env.OB_USAGE_T3_CACHE;
  savedThread = process.env.T3CODE_THREAD_ID;
  delete process.env.T3CODE_THREAD_ID; // a builder runs this suite from a T3 thread; each test says which it is
  resetUsageUnknownWarning();
});
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
  if (savedCache === undefined) delete process.env.OB_USAGE_T3_CACHE;
  else process.env.OB_USAGE_T3_CACHE = savedCache;
  if (savedThread === undefined) delete process.env.T3CODE_THREAD_ID;
  else process.env.T3CODE_THREAD_ID = savedThread;
});

/** Point the gate at a cache saying `usedPercent`, checked a minute ago, resetting a day from now. */
function usage(usedPercent: number): void {
  const dir = mkdtempSync(join(tmpdir(), "ob-os108-cache-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "claudeAgent.json");
  const now = Date.now();
  writeFileSync(
    file,
    JSON.stringify({
      usageLimits: {
        checkedAt: new Date(now - 60_000).toISOString(),
        windows: [{ id: "seven_day", usedPercent, resetsAt: new Date(now + 86_400_000).toISOString(), windowDurationMins: 10080 }],
      },
    }),
  );
  process.env.OB_USAGE_T3_CACHE = file;
}

async function ticket(dbPath: string, priority: number): Promise<string> {
  const db = openDb(dbPath, { create: true });
  try {
    const id = await createItem(db, { type: "task", title: "A ticket", body: "## Drilled\n- read\n\n## Done when\n- a test" });
    await editItem(db, id, { priority });
    return id;
  } finally {
    db.close();
  }
}

async function dispatch(dbPath: string, args: string[]) {
  cleanup.push(__setSh(() => ({ ok: true, err: "", out: "" })));
  const repo = fakeRepoDir();
  const t3 = installFakeT3([repo]);
  cleanup.push(t3.restore);
  const wt = mkdtempSync(join(tmpdir(), "ob-os108-wt-"));
  cleanup.push(() => rmSync(wt, { recursive: true, force: true }));
  const [first, ...rest] = args;
  const lead = first === "queue" ? ["spinoff", "queue", rest.shift()!] : ["spinoff", first!];
  return runCli(dbPath, [...lead, "--repo", repo, "--branch", `build-${Date.now()}`, "--worktree", wt, "--brief", "b", "--no-check", "test", ...rest]);
}

const rows = async (dbPath: string) => JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as unknown[];

async function trail(dbPath: string, id: string) {
  const db = openDb(dbPath);
  try {
    return (await decisionsForItem(asStore(db), id)).filter((d) => d.to === "over-usage");
  } finally {
    db.close();
  }
}

describe("the dispatch gate past the critical-only line (OS-108)", () => {
  test.each([["spinoff <ref>", []], ["spinoff queue <ref>", ["queue"]]] as const)("%s refuses a non-critical ticket at 99%%, names the usage and the reset, and leaves no row", async (_label, lead) => {
    usage(99);
    const dbPath = freshDbPath();
    const id = await ticket(dbPath, PRIORITY_URGENT);
    const r = await dispatch(dbPath, lead.length ? ["queue", id] : [id]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Weekly Claude usage is 99% (resets ");
    expect(r.err).toContain("critical only.");
    expect(r.err).toContain("Nothing was queued");
    expect(await rows(dbPath)).toEqual([]);
  });

  test("a critical ticket passes the gate at 99%", async () => {
    usage(99);
    const dbPath = freshDbPath();
    const id = await ticket(dbPath, PRIORITY_CRITICAL);
    const r = await dispatch(dbPath, ["queue", id]);
    expect(r.code).toBe(0);
    expect(await rows(dbPath)).toHaveLength(1);
  });

  test("at 97% a medium ticket is dispatched as usual", async () => {
    usage(97);
    const dbPath = freshDbPath();
    const id = await ticket(dbPath, PRIORITY_MEDIUM);
    expect((await dispatch(dbPath, ["queue", id])).code).toBe(0);
    expect(await rows(dbPath)).toHaveLength(1);
  });

  test("a missing cache says 'usage unknown' and does not block", async () => {
    process.env.OB_USAGE_T3_CACHE = join(tmpdir(), "ob-os108-no-such-cache.json");
    const dbPath = freshDbPath();
    const id = await ticket(dbPath, PRIORITY_MEDIUM);
    const r = await dispatch(dbPath, ["queue", id]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("usage unknown");
  });

  test("--over-usage '<why>' outside a T3 thread passes and lands on the Decisions trail", async () => {
    usage(99);
    const dbPath = freshDbPath();
    const id = await ticket(dbPath, PRIORITY_MEDIUM);
    const r = await dispatch(dbPath, ["queue", id, "--over-usage", "release day, worth it"]);
    expect(r.code).toBe(0);
    expect(await rows(dbPath)).toHaveLength(1);
    const over = await trail(dbPath, id);
    expect(over).toHaveLength(1);
    expect(over[0]!.note).toBe("release day, worth it");
  });

  test("--over-usage from a T3 thread is refused, and leaves no row", async () => {
    usage(99);
    process.env.T3CODE_THREAD_ID = "thread-1";
    const dbPath = freshDbPath();
    const id = await ticket(dbPath, PRIORITY_MEDIUM);
    const r = await dispatch(dbPath, ["queue", id, "--over-usage", "an agent wants it"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("refused from a T3 thread");
    expect(await rows(dbPath)).toEqual([]);
  });

  test("an empty --over-usage reason is refused", async () => {
    usage(99);
    const dbPath = freshDbPath();
    const id = await ticket(dbPath, PRIORITY_MEDIUM);
    const r = await dispatch(dbPath, ["queue", id, "--over-usage", "  "]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--over-usage needs a reason");
    expect(await rows(dbPath)).toEqual([]);
  });

  test("over the API the server records over_usage on the trail and does not check", async () => {
    usage(99);
    const dbPath = freshDbPath();
    const id = await ticket(dbPath, PRIORITY_MEDIUM);
    const db = openDb(dbPath);
    try {
      const res = await apiEnqueue(asStore(db), { ticket_ref: id, repo: fakeRepoDir(), branch: "b-api", mode: "interactive", brief: "b", no_check: "test", over_usage: "his call" });
      expect(res.row.id).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    expect((await trail(dbPath, id))[0]!.note).toBe("his call");
  });
});

/** A T3 seam that only takes the send-back's note. */
function sendSeam(): { sends: unknown[] } {
  const sends: unknown[] = [];
  const no = () => async () => {
    throw new Error("not used here");
  };
  const seam = {
    interrupt: async () => {},
    projects: no(),
    capabilities: no(),
    list: no(),
    read: liveRead,
    launch: no(),
    rename: no(),
    settle: async () => {},
    send: async (input: unknown) => {
      sends.push(input);
    },
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
    queue: async () => ({ items: [], complete: true }),
    pin: async () => {},
    unpin: async () => {},
    disableAutoSettle: async () => {},
    queueCancel: async () => {},
  } as unknown as T3Seam;
  cleanup.push(__setT3Seam(seam));
  return { sends };
}

/** A handed-off row for a ticket at `priority`, with a builder thread to send back to. */
async function handedOff(priority: number): Promise<{ dbPath: string; id: string }> {
  const dbPath = freshDbPath();
  const id = await ticket(dbPath, priority);
  const db = openDb(dbPath);
  try {
    const wt = mkdtempSync(join(tmpdir(), "ob-os108-sb-"));
    cleanup.push(() => rmSync(wt, { recursive: true, force: true }));
    mkdirSync(wt, { recursive: true });
    const { row } = await enqueueSpinoff(db, { ticketRef: id, repo: "/r/omnislash", branch: `b-${id}`, worktree: wt, mode: "interactive", brief: "b" });
    db.query("UPDATE spinoff SET status = 'ready-for-gate', worktree = ?, launcher = 't3', t3_thread_id = 'builder-1', base_sha = 'base123' WHERE id = ?").run(wt, row.id);
  } finally {
    db.close();
  }
  cleanup.push(__setSh(() => ({ ok: true, err: "", out: "" })));
  return { dbPath, id };
}

describe("send-back past the critical-only line (OS-108)", () => {
  test("a send-back of a non-critical live row is refused at 99%, and the row stays handed-off", async () => {
    usage(99);
    const { dbPath } = await handedOff(PRIORITY_MEDIUM);
    const t3 = sendSeam();
    const r = await runCli(dbPath, ["spinoff", "sendback", (await firstRef(dbPath)), "--note", "fix it"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not sent back: Weekly Claude usage is 99%");
    expect(t3.sends).toEqual([]);
    expect(await statusOf(dbPath)).toBe("ready-for-gate");
  });

  test("a critical row is sent back at 99%; --over-usage sends back a medium one and records it", async () => {
    usage(99);
    const critical = await handedOff(PRIORITY_CRITICAL);
    sendSeam();
    expect((await runCli(critical.dbPath, ["spinoff", "sendback", critical.id, "--note", "fix it"])).code).toBe(0);

    const medium = await handedOff(PRIORITY_MEDIUM);
    const r = await runCli(medium.dbPath, ["spinoff", "sendback", medium.id, "--note", "fix it", "--over-usage", "one line fix"]);
    expect(r.code).toBe(0);
    expect((await trail(medium.dbPath, medium.id))[0]!.note).toBe("one line fix");
  });

  test("over the API the server records a send-back's over_usage", async () => {
    const { dbPath, id } = await handedOff(PRIORITY_MEDIUM);
    const db = openDb(dbPath);
    try {
      const row = (await listSpinoffs(db))[0]!;
      await apiSendBack(asStore(db), { id: row.id, note: "fix it", over_usage: "his call" });
    } finally {
      db.close();
    }
    expect((await trail(dbPath, id))[0]!.note).toBe("his call");
  });

  test("an API send-back undone by a failed note says on the trail that the override went unused", async () => {
    const { dbPath, id } = await handedOff(PRIORITY_MEDIUM);
    const db = openDb(dbPath);
    try {
      const row = (await listSpinoffs(db))[0]!;
      await apiSendBack(asStore(db), { id: row.id, note: "fix it", over_usage: "his call" });
      await apiSendBack(asStore(db), { id: row.id, note: "", restore: true, over_usage: "his call" });
      const moves = (await decisionsForItem(asStore(db), id)).filter((d) => d.from === "over-usage" || d.to === "over-usage");
      expect(moves.map((d) => `${d.from} -> ${d.to}`).sort()).toEqual(["over-usage -> usage", "usage -> over-usage"]);
    } finally {
      db.close();
    }
  });
});

describe("the legacy ssh remote_host client (OS-108)", () => {
  function recordingExec() {
    const calls: string[][] = [];
    const ok = { code: 0, connectionFailed: false };
    return {
      calls,
      stream: (_h: string, argv: string[]) => (calls.push(argv), ok),
      capture: (_h: string, argv: string[]) => (calls.push(argv), { ...ok, stdout: "", stderr: "" }),
      fetch: (_h: string, argv: string[]) => (calls.push(argv), { ...ok, stderr: "", bytes: new Uint8Array() }),
    };
  }

  async function dispatched(dbPath: string, argv: string[]) {
    const exec = recordingExec();
    const prevDb = process.env.OMNISLASH_DB;
    const origErr = process.stderr.write.bind(process.stderr);
    let err = "";
    (process.stderr.write as unknown) = (chunk: string) => ((err += chunk), true);
    process.env.OMNISLASH_DB = dbPath;
    try {
      return { code: await run(argv, { exec }), err, calls: exec.calls };
    } finally {
      (process.stderr.write as unknown) = origErr;
      if (prevDb === undefined) delete process.env.OMNISLASH_DB;
      else process.env.OMNISLASH_DB = prevDb;
    }
  }

  async function client(priority: number): Promise<{ dbPath: string; id: string }> {
    const dbPath = freshDbPath();
    const id = await ticket(dbPath, priority);
    const db = openDb(dbPath);
    await setConfig(db, "remote_host", "ob@10.0.0.20");
    db.close();
    return { dbPath, id };
  }

  test("`spinoff queue` and `spinoff sendback` of a medium ticket are refused here at 99%, before the ssh hop", async () => {
    usage(99);
    const { dbPath, id } = await client(PRIORITY_MEDIUM);
    for (const argv of [["spinoff", "queue", id], ["spinoff", "sendback", id, "--note", "fix it"]]) {
      const r = await dispatched(dbPath, argv);
      expect(r.code).toBe(1);
      expect(r.err).toContain("Weekly Claude usage is 99%");
      expect(r.calls).toEqual([]);
    }
  });

  test("a critical ticket crosses the wire at 99%, and --over-usage from a T3 thread does not", async () => {
    usage(99);
    const { dbPath, id } = await client(PRIORITY_CRITICAL);
    const ok = await dispatched(dbPath, ["spinoff", "queue", id, "--repo", "omnislash"]);
    expect(ok.code).toBe(0);
    expect(ok.calls).toHaveLength(1);

    process.env.T3CODE_THREAD_ID = "thread-1";
    const r = await dispatched(dbPath, ["spinoff", "queue", id, "--over-usage", "mine"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused from a T3 thread");
    expect(r.calls).toEqual([]);
  });
});

async function firstRef(dbPath: string): Promise<string> {
  const db = openDb(dbPath);
  try {
    return (await listSpinoffs(db))[0]!.ticket_ref;
  } finally {
    db.close();
  }
}

async function statusOf(dbPath: string): Promise<string> {
  const db = openDb(dbPath);
  try {
    return (await listSpinoffs(db))[0]!.status;
  } finally {
    db.close();
  }
}
