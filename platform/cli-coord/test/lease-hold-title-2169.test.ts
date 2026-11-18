import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  __setT3Seam,
  isTeamRoleTitle,
  syncLeaseTitle,
  titleWithLeaseMarker,
  titleWithNeedsYou,
  type T3Seam,
} from "../../../apps/cli/src/t3/dispatch.ts";
import { leaseLabel } from "../../../apps/cli/src/t3/lease-icon.ts";
import { runUnderLease, type LeaseRunIo } from "../src/lease-run.ts";
import { T3_THREAD_ENV } from "../src/lease-wait-title.ts";
import { NEEDS_YOU_MARKER } from "../src/spinoff-state-reason.ts";

// OB-2169: a thread whose `ob lease run` holds the lease wears `🔒<label>` from the grant until the release, beside
// any other lease's marker (one per resource), and gets its own title back however the run ends.

const TITLE = "OB-2169 · A thread holding a lease says so in its title";
const WAITING = `⏳🌐 · ${TITLE}`;
const HELD = `🔒🌐 · ${TITLE}`;

type Event = string;

/** A fake T3 that keeps one thread's title and records every rename, into a shared event log. */
function fakeT3(events: Event[], opts: { failRename?: boolean } = {}) {
  const state = { title: TITLE, renames: [] as string[], reads: 0 };
  const seam = {
    read: async () => {
      state.reads += 1;
      return { thread: { title: state.title } };
    },
    rename: async (_id: string, t: string) => {
      if (opts.failRename) throw new Error("T3 unreachable");
      state.renames.push(t);
      state.title = t;
      events.push(`rename:${t}`);
    },
  } as unknown as T3Seam;
  return { seam, state };
}

/** A lease io that denies `denials` times, then grants (Infinity: never grants); logs the release. */
function io(denials: number, events: Event[]): LeaseRunIo & { attempts: number } {
  const me = {
    attempts: 0,
    acquire: async () => {
      me.attempts += 1;
      return me.attempts > denials ? { ok: true, holder: "me" } : { ok: false, holder: "someone-else" };
    },
    release: async () => {
      events.push("release");
      return true;
    },
  };
  return me;
}

let restoreSeam: (() => void) | null = null;
const savedThread = process.env[T3_THREAD_ENV];
const savedHeld = process.env.OB_LEASE_RUN_HELD;
const savedEscape = process.env.OB_LEASE_RUN_ESCAPE;
const temps: string[] = [];

beforeEach(() => {
  process.env[T3_THREAD_ENV] = "th-1";
  delete process.env.OB_LEASE_RUN_HELD;
  // The signal tests need the child in this process's hands, not a user service.
  process.env.OB_LEASE_RUN_ESCAPE = "0";
});

afterEach(() => {
  restoreSeam?.();
  restoreSeam = null;
  for (const [k, v] of [
    [T3_THREAD_ENV, savedThread],
    ["OB_LEASE_RUN_HELD", savedHeld],
    ["OB_LEASE_RUN_ESCAPE", savedEscape],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const p of temps.splice(0)) rmSync(p, { force: true });
});

function install(t3: ReturnType<typeof fakeT3>) {
  restoreSeam = __setT3Seam(t3.seam);
}

/** A command that appends one line to a file per run and exits 3. */
function command(): { command: string[]; runs: () => number } {
  const file = join(tmpdir(), `ob-2169-${randomUUID()}`);
  temps.push(file);
  return {
    command: ["sh", "-c", `echo ran >> '${file}'; exit 3`],
    runs: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0),
  };
}

/** A command that says it started, then runs until `stop()`, then exits `code`: no sleep it has to outlast. */
function stoppable(code: number): { command: string[]; started: () => boolean; stop: () => void } {
  const base = join(tmpdir(), `ob-2169-${randomUUID()}`);
  temps.push(`${base}.started`, `${base}.stop`);
  return {
    command: ["sh", "-c", `touch '${base}.started'; while [ ! -e '${base}.stop' ]; do sleep 0.05; done; exit ${code}`],
    started: () => existsSync(`${base}.started`),
    stop: () => writeFileSync(`${base}.stop`, ""),
  };
}

function run(lease: LeaseRunIo, cmd: string[], lines: string[] = [], resource = "cpu:browser") {
  return runUnderLease({
    resource,
    holder: "me",
    command: cmd,
    io: lease,
    heartbeatMs: 60_000,
    log: (l) => lines.push(l),
    pollMs: 5,
  });
}

async function until(pred: () => boolean) {
  for (let i = 0; i < 2_000 && !pred(); i++) await Bun.sleep(5);
}

describe("leaseLabel (OB-2169)", () => {
  test("an exact icon alone, a class icon and the value, else the value after the class", () => {
    expect(leaseLabel("cpu:browser")).toBe("🌐");
    expect(leaseLabel("port:5101")).toBe("🔌5101");
    expect(leaseLabel("probe:ob-2169-a")).toBe("ob-2169-a");
    expect(leaseLabel("worktree:/home/owner/dev/acme.ob-2169")).toBe("acme.ob-2169");
    expect(leaseLabel("worktree:/home/owner/dev/acme.ob-2169/")).toBe("acme.ob-2169");
    expect(leaseLabel("cpu:other")).toBe("other");
    expect(leaseLabel("probe:a b")).not.toMatch(/\s/u);
  });
});

describe("titleWithLeaseMarker (OB-2169)", () => {
  const set = (t: string, r: string, s: "waiting" | "holding" | null) => titleWithLeaseMarker(t, r, s);
  const T = TITLE;

  test("🔒 goes in front, a ⏳ is swapped for it in place, and null strips it", () => {
    expect(set(T, "cpu:browser", "holding")).toBe(`🔒🌐 · ${T}`);
    expect(set(`⏳🌐 · ${T}`, "cpu:browser", "holding")).toBe(`🔒🌐 · ${T}`);
    expect(set(`🔒🌐 · ${T}`, "cpu:browser", null)).toBe(T);
    expect(set(`⏳🌐 · ${T}`, "cpu:browser", null)).toBe(T);
  });

  test("a needs-you 🙋 stays behind the marker run, both ways round", () => {
    const needsYou = `${NEEDS_YOU_MARKER} ${T}`;
    expect(set(needsYou, "cpu:browser", "holding")).toBe(`🔒🌐 · ${needsYou}`);
    expect(set(`🔒🌐 · ${needsYou}`, "cpu:browser", null)).toBe(needsYou);
    expect(set(`⏳🔌5101 🔒🌐 · ${needsYou}`, "port:5101", null)).toBe(`🔒🌐 · ${needsYou}`);
    expect(titleWithNeedsYou(`⏳🔌5101 🔒🌐 · ${T}`, "needs-human")).toBe(`⏳🔌5101 🔒🌐 · ${needsYou}`);
    expect(titleWithNeedsYou(`⏳🔌5101 🔒🌐 · ${needsYou}`, "working")).toBe(`⏳🔌5101 🔒🌐 · ${T}`);
  });

  for (const order of [
    ["cpu:browser", "port:5101"],
    ["port:5101", "cpu:browser"],
  ]) {
    test(`several leases keep their own markers (clearing ${order.join(" then ")})`, () => {
      let t = set(T, "cpu:browser", "holding");
      expect(t).toBe(`🔒🌐 · ${T}`);
      t = set(t, "port:5101", "waiting");
      expect(t).toBe(`⏳🔌5101 🔒🌐 · ${T}`);
      t = set(t, "port:5101", "holding");
      expect(t).toBe(`🔒🔌5101 🔒🌐 · ${T}`);
      t = set(t, order[0], null);
      expect(t).toBe(order[0] === "cpu:browser" ? `🔒🔌5101 · ${T}` : `🔒🌐 · ${T}`);
      t = set(t, order[1], null);
      expect(t).toBe(T);
    });
  }

  test("an architect title under several markers is still an architect title", () => {
    expect(isTeamRoleTitle("🔒🌐 ⏳🔌5101 · 🖼️ PixelSlash · architect")).toBe(true);
    expect(isTeamRoleTitle(`🔒🌐 · ${NEEDS_YOU_MARKER} 🖼️ PixelSlash · architect`)).toBe(true);
    expect(isTeamRoleTitle("🔒🌐 · OB-12 · architect")).toBe(false);
  });
});

describe("syncLeaseTitle re-reads after it renames (OB-2169)", () => {
  test("two interleaved syncs on one thread both end up in the title", async () => {
    // A reads, B reads, B renames, A renames (A's rename carries the title it read, so it drops B's marker).
    // The first two reads, and the first two renames, each wait for their pair; after that, calls go straight through.
    const state = { title: TITLE };
    const barrier = <T,>(n: number) => {
      const waiting: Array<{ value: T; go: () => void }> = [];
      return (value: T, onFull: (all: T[]) => void) =>
        new Promise<void>((go) => {
          waiting.push({ value, go });
          if (waiting.length === n) {
            onFull(waiting.map((w) => w.value));
            for (const w of waiting) w.go();
          }
        });
    };
    const readPair = barrier<null>(2);
    const renamePair = barrier<string>(2);
    let reads = 0;
    let renames = 0;
    const seam = {
      read: async () => {
        const first = ++reads <= 2;
        const seen = state.title;
        if (first) await readPair(null, () => {});
        return { thread: { title: first ? seen : state.title } };
      },
      rename: async (_id: string, t: string) => {
        if (++renames > 2) {
          state.title = t;
          return;
        }
        await renamePair(t, (all) => {
          // B (the port marker) lands first, then A.
          for (const x of [...all.filter((x) => x.includes("🔌")), ...all.filter((x) => !x.includes("🔌"))]) state.title = x;
        });
      },
    } as unknown as T3Seam;
    const [a, b] = await Promise.all([
      syncLeaseTitle("th-1", "cpu:browser", "holding", seam),
      syncLeaseTitle("th-1", "port:x", "holding", seam),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    // Without the re-read, A's rename would have left `🔒🌐 · <title>`.
    expect(renames).toBe(3);
    expect(state.title).toBe(`🔒🔌x 🔒🌐 · ${TITLE}`);
  });

  test("a seam that keeps losing stops after 3 renames and reports it", async () => {
    let renames = 0;
    const seam = {
      read: async () => ({ thread: { title: TITLE } }),
      rename: async () => {
        renames += 1;
      },
    } as unknown as T3Seam;
    const r = await syncLeaseTitle("th-1", "cpu:browser", "holding", seam);
    expect(renames).toBe(3);
    expect(r.error).toContain("gave up");
  });
});

describe("lease run marks its thread 🔒 while it holds the lease (OB-2169)", () => {
  test("granted at once: one rename to 🔒, one back after the release, the command's exit code", async () => {
    const events: Event[] = [];
    const t3 = fakeT3(events);
    install(t3);
    const cmd = command();
    expect(await run(io(0, events), cmd.command)).toBe(3);
    expect(cmd.runs()).toBe(1);
    expect(t3.state.renames).toEqual([HELD, TITLE]);
    expect(events.indexOf("release")).toBeLessThan(events.indexOf(`rename:${TITLE}`));
    expect(t3.state.title).toBe(TITLE);
  });

  test("denied twice then granted: ⏳, then 🔒, then the original, never both markers", async () => {
    const events: Event[] = [];
    const t3 = fakeT3(events);
    install(t3);
    const cmd = command();
    expect(await run(io(2, events), cmd.command)).toBe(3);
    expect(t3.state.renames).toEqual([WAITING, HELD, TITLE]);
    for (const t of t3.state.renames) expect(t.includes("⏳") && t.includes("🔒")).toBe(false);
    expect(events.indexOf("release")).toBeLessThan(events.indexOf(`rename:${TITLE}`));
  });

  test("SIGINT during the command restores the title before the run exits 130", async () => {
    const events: Event[] = [];
    const t3 = fakeT3(events);
    install(t3);
    const cmd = stoppable(0);
    const pending = run(io(0, events), cmd.command);
    await until(() => t3.state.title === HELD && cmd.started());
    expect(t3.state.title).toBe(HELD);
    process.emit("SIGINT", "SIGINT");
    // On a terminal ob leaves Ctrl-C to the process group, so the command is stopped here, not by the signal.
    cmd.stop();
    expect(await pending).toBe(130);
    expect(t3.state.title).toBe(TITLE);
    expect(t3.state.renames).toEqual([HELD, TITLE]);
  });

  test("a nested run of a different resource marks its own beside the outer one and clears only its own", async () => {
    const events: Event[] = [];
    const t3 = fakeT3(events);
    install(t3);
    const outer = stoppable(0);
    const pending = run(io(0, events), outer.command);
    await until(() => t3.state.title === HELD && outer.started());
    // As the outer run's command would: OB_LEASE_RUN_HELD names the outer resource.
    process.env.OB_LEASE_RUN_HELD = "cpu:browser";
    const inner = stoppable(4);
    const innerRun = run(io(0, events), inner.command, [], "port:x");
    await until(() => t3.state.title.startsWith("🔒🔌x ") && inner.started());
    expect(t3.state.title).toBe(`🔒🔌x 🔒🌐 · ${TITLE}`);
    inner.stop();
    expect(await innerRun).toBe(4);
    delete process.env.OB_LEASE_RUN_HELD;
    expect(t3.state.title).toBe(HELD);
    outer.stop();
    expect(await pending).toBe(0);
    expect(t3.state.title).toBe(TITLE);
  });


  test("a slow hold mark on a command that ends at once still leaves the original title", async () => {
    // Each rename takes 3 s: the hold mark and the restore together outlast one 5 s bound.
    const events: Event[] = [];
    const t3 = fakeT3(events);
    const slow = t3.seam.rename.bind(t3.seam);
    (t3.seam as { rename: T3Seam["rename"] }).rename = async (id, t) => {
      await Bun.sleep(3_000);
      await slow(id, t);
    };
    install(t3);
    expect(await run(io(0, events), command().command)).toBe(3);
    expect(t3.state.title).toBe(TITLE);
  }, 20_000);
});
