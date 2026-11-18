import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { __setT3Seam, isTeamRoleTitle, titleWithLeaseMarker, titleWithNeedsYou, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { runUnderLease, type LeaseRunIo } from "../src/lease-run.ts";
import { LeaseWaitSignalled, waitUntilAcquired } from "../src/lease.ts";
import { leaseWaitTitle, T3_THREAD_ENV } from "../src/lease-wait-title.ts";
import { NEEDS_YOU_MARKER } from "../src/spinoff-state-reason.ts";

// OB-2153: a thread waiting on a lease wears a `⏳<label>` marker in front of its title while it waits, and gets
// its own title back however the wait ends. Since OB-2169 the marker is short (`⏳🌐` for cpu:browser) and one per
// resource; lease-hold-title-2169.test.ts covers the labels, several markers and the hold.

const TITLE = "OB-2153 · A thread waiting for a lease says so in its title";
const MARKED = `⏳🌐 · ${TITLE}`;

/** A fake T3 that keeps one thread's title and records every rename. */
function fakeT3(start = TITLE, opts: { failRename?: boolean } = {}) {
  const state = { title: start, renames: [] as Array<[string, string]>, reads: 0 };
  const seam = {
    read: async () => {
      state.reads += 1;
      return { thread: { title: state.title } };
    },
    rename: async (id: string, t: string) => {
      if (opts.failRename) throw new Error("T3 unreachable");
      state.renames.push([id, t]);
      state.title = t;
    },
  } as unknown as T3Seam;
  return { seam, state };
}

/** A lease io that denies `denials` times, then grants (Infinity: never grants). */
function io(denials: number): LeaseRunIo & { attempts: number } {
  const me = {
    attempts: 0,
    acquire: async () => {
      me.attempts += 1;
      return me.attempts > denials ? { ok: true, holder: "me" } : { ok: false, holder: "someone-else" };
    },
    release: async () => true,
  };
  return me;
}

let restoreSeam: (() => void) | null = null;
const savedThread = process.env[T3_THREAD_ENV];
const savedHeld = process.env.OB_LEASE_RUN_HELD;
const temps: string[] = [];

beforeEach(() => {
  process.env[T3_THREAD_ENV] = "th-1";
  delete process.env.OB_LEASE_RUN_HELD;
});

afterEach(() => {
  restoreSeam?.();
  restoreSeam = null;
  if (savedThread === undefined) delete process.env[T3_THREAD_ENV];
  else process.env[T3_THREAD_ENV] = savedThread;
  if (savedHeld === undefined) delete process.env.OB_LEASE_RUN_HELD;
  else process.env.OB_LEASE_RUN_HELD = savedHeld;
  for (const p of temps.splice(0)) rmSync(p, { force: true });
});

function install(t3: ReturnType<typeof fakeT3>) {
  restoreSeam = __setT3Seam(t3.seam);
}

/** A command that appends one line to a file per run and exits 3, so runs and exit codes can be counted. */
function countingCommand(): { command: string[]; runs: () => number } {
  const file = join(tmpdir(), `ob-2153-${randomUUID()}`);
  temps.push(file);
  return {
    command: ["sh", "-c", `echo ran >> '${file}'; exit 3`],
    runs: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0),
  };
}

function run(lease: LeaseRunIo, command: string[], lines: string[]) {
  return runUnderLease({
    resource: "cpu:browser",
    holder: "me",
    command,
    io: lease,
    heartbeatMs: 60_000,
    log: (l) => lines.push(l),
    pollMs: 5,
  });
}

describe("the lease-wait marker (OB-2153, short form since OB-2169)", () => {
  const wait = (t: string) => titleWithLeaseMarker(t, "cpu:browser", "waiting");
  const clear = (t: string) => titleWithLeaseMarker(t, "cpu:browser", null);

  test("puts the marker in front, is idempotent, and null strips it", () => {
    expect(wait(TITLE)).toBe(MARKED);
    expect(wait(MARKED)).toBe(MARKED);
    expect(clear(MARKED)).toBe(TITLE);
    expect(clear(TITLE)).toBe(TITLE);
  });

  test("keeps a needs-you marker after it, both ways round", () => {
    const needsYou = `${NEEDS_YOU_MARKER} ${TITLE}`;
    expect(wait(needsYou)).toBe(`⏳🌐 · ${needsYou}`);
    expect(clear(`⏳🌐 · ${needsYou}`)).toBe(needsYou);
    // The needs-you marker moves behind the lease marker and never disturbs it.
    expect(titleWithNeedsYou(MARKED, "needs-human")).toBe(`⏳🌐 · ${needsYou}`);
    expect(titleWithNeedsYou(`⏳🌐 · ${needsYou}`, "working")).toBe(MARKED);
  });

  test("an architect title under the marker is still an architect title", () => {
    expect(isTeamRoleTitle("⏳🌐 · 🖼️ PixelSlash · architect")).toBe(true);
    expect(isTeamRoleTitle(`⏳🌐 · ${NEEDS_YOU_MARKER} 🖼️ PixelSlash · architect`)).toBe(true);
    expect(isTeamRoleTitle("⏳🌐 · OB-12 · architect")).toBe(false);
  });
});

describe("lease run retitles its thread while it waits (OB-2153)", () => {
  // The wait-then-grant sequence (now `⏳`, `🔒`, then the original) is lease-hold-title-2169.test.ts's (OB-2169).
  test("with no T3CODE_THREAD_ID a wait makes no T3 call", async () => {
    delete process.env[T3_THREAD_ENV];
    const t3 = fakeT3();
    install(t3);
    const cmd = countingCommand();
    expect(await run(io(2), cmd.command, [])).toBe(3);
    expect(t3.state.reads).toBe(0);
  });

  test("a rename that throws says so once and the run still ends with the command's code", async () => {
    install(fakeT3(TITLE, { failRename: true }));
    const cmd = countingCommand();
    const lines: string[] = [];
    expect(await run(io(3), cmd.command, lines)).toBe(3);
    expect(cmd.runs()).toBe(1);
    expect(lines.filter((l) => l.startsWith("could not retitle the thread")).length).toBe(1);
  });

  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`${sig} while waiting renames back before the run exits ${code}`, async () => {
      const t3 = fakeT3();
      install(t3);
      const cmd = countingCommand();
      const pending = run(io(Number.POSITIVE_INFINITY), cmd.command, []);
      for (let i = 0; i < 400 && t3.state.renames.length === 0; i++) await Bun.sleep(5);
      expect(t3.state.title).toBe(MARKED);
      process.emit(sig, sig);
      expect(await pending).toBe(code);
      expect(t3.state.title).toBe(TITLE);
      expect(t3.state.renames).toEqual([
        ["th-1", MARKED],
        ["th-1", TITLE],
      ]);
      expect(cmd.runs()).toBe(0);
    });
  }

  test("a nested run under an enclosing hold of the resource makes no T3 call", async () => {
    process.env.OB_LEASE_RUN_HELD = "cpu:browser";
    const t3 = fakeT3();
    install(t3);
    const cmd = countingCommand();
    expect(await run(io(Number.POSITIVE_INFINITY), cmd.command, [])).toBe(3);
    expect(t3.state.reads).toBe(0);
  });
});

describe("lease acquire --wait retitles its thread while it waits (OB-2153)", () => {
  test("marked on the first denial and restored on the grant", async () => {
    const t3 = fakeT3();
    install(t3);
    const lease = io(2);
    const lines: string[] = [];
    const result = await waitUntilAcquired(() => lease.acquire(), {
      resource: "cpu:browser",
      sleep: () => {},
      log: (l) => lines.push(l),
      title: leaseWaitTitle("cpu:browser", (l) => lines.push(l)),
    });
    expect(result.ok).toBe(true);
    expect(t3.state.renames).toEqual([
      ["th-1", MARKED],
      ["th-1", TITLE],
    ]);
  });

  test("a grant on the first attempt leaves the title alone", async () => {
    const t3 = fakeT3();
    install(t3);
    const lease = io(0);
    await waitUntilAcquired(() => lease.acquire(), { sleep: () => {}, title: leaseWaitTitle("cpu:browser", () => {}) });
    expect(t3.state.reads).toBe(0);
  });

  test("SIGINT while queued stops the wait before another attempt, restores the title, and exits 130", async () => {
    const t3 = fakeT3();
    install(t3);
    const lease = io(Number.POSITIVE_INFINITY);
    const pending = waitUntilAcquired(() => lease.acquire(), { pollMs: 5_000, title: leaseWaitTitle("cpu:browser", () => {}) });
    for (let i = 0; i < 400 && t3.state.renames.length === 0; i++) await Bun.sleep(5);
    expect(t3.state.title).toBe(MARKED);
    const before = lease.attempts;
    process.emit("SIGINT", "SIGINT");
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LeaseWaitSignalled);
    expect((err as LeaseWaitSignalled).exitCode).toBe(130);
    expect(lease.attempts).toBe(before);
    expect(t3.state.title).toBe(TITLE);
  });

  test("with no thread a wait catches no signal and makes no T3 call", async () => {
    delete process.env[T3_THREAD_ENV];
    const t3 = fakeT3();
    install(t3);
    const lease = io(2);
    const before = process.listenerCount("SIGINT");
    let during = -1;
    await waitUntilAcquired(() => lease.acquire(), {
      sleep: () => {
        during = process.listenerCount("SIGINT");
      },
      title: leaseWaitTitle("cpu:browser", () => {}),
    });
    expect(during).toBe(before);
    expect(t3.state.reads).toBe(0);
  });

  test("an error that ends the wait still restores the title", async () => {
    const t3 = fakeT3();
    install(t3);
    let n = 0;
    const attempt = async () => {
      n += 1;
      if (n > 1) throw new Error("boom");
      return { ok: false, holder: "someone-else" };
    };
    await expect(waitUntilAcquired(attempt, { sleep: () => {}, title: leaseWaitTitle("cpu:browser", () => {}) })).rejects.toThrow("boom");
    expect(t3.state.title).toBe(TITLE);
    expect(t3.state.renames.length).toBe(2);
  });
});
