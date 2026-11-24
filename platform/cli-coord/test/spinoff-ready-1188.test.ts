// 1188, the second half — the wake produced a FALSE ready announce for landed work.
//
// 18 minutes after 1163 landed, its woken builder re-implemented the ticket (its run-2 items: "Now let me
// make the schema changes", "Now add the warning helpers after settleT3ThreadForTicket", …) and then ran
// `ob spinoff ready 1163`, so a **readying note for merged work arrived in the architect's thread**, naming a
// worktree deleted 12 minutes earlier. That note's honesty was 1133 working as designed; the ANNOUNCE was
// the hazard, because an architect acting on it would have gated and re-landed a landed ticket. Only luck
// (the edits failed because the directory was gone) kept it from producing commits.
//
// These two guards stop the harm independently of the wake, and they are pinned here because they are the
// difference between a runaway being a no-op and being a hazard. Both are reached from the local command
// and the API client, which share `pickSpinoffForReady` / `assertWorktreeGateable`.
import { liveRead, openRunsOnSeats } from "../../../apps/cli/test/role-run-fixture.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli, omnislashTeamFor } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import { T3Error, type T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import {
  __setReadyNoteRetryMs,
  __setT3Seam,
  type T3Seam,
} from "../../../apps/cli/src/t3/dispatch.ts";
import { registerAgent } from "../src/agent.ts";
import { alreadyLandedRefusal, enqueueSpinoff, type EnqueueInput } from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";

const README = readFileSync(join(import.meta.dir, "..", "..", "..", "apps/cli/README.md"), "utf8");

const restores: Array<() => void> = [];
// OB-2172: a refused note is retried once after a wait; these tests do not wait for it.
let restoreRetry: () => void = () => {};
beforeAll(() => {
  restoreRetry = __setReadyNoteRetryMs(0);
});
afterAll(() => restoreRetry());
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1188",
  repo: "/r/omnislash",
  branch: "1188",
  mode: "interactive",
  brief: "the wake announced landed work",
  ...over,
});

/** A T3 that records every message ob would deliver, so "sends no note" is an assertion. */
function fakeT3(): { seam: T3Seam; sends: T3SendInput[] } {
  const fake = { sends: [] as T3SendInput[], seam: {} as T3Seam };
  const unimplemented = (name: string) => async () => {
    throw new Error(`${name} is not used by the ready path`);
  };
  fake.seam = {
    projects: unimplemented("projects") as T3Seam["projects"],
    interrupt: async () => {},
    capabilities: unimplemented("capabilities") as T3Seam["capabilities"],
    list: unimplemented("list") as T3Seam["list"],
    read: liveRead,
    launch: unimplemented("launch") as T3Seam["launch"],
    pin: unimplemented("pin") as T3Seam["pin"],
    unpin: unimplemented("unpin") as T3Seam["unpin"],
    rename: unimplemented("rename") as T3Seam["rename"],
    settle: unimplemented("settle") as T3Seam["settle"],
    wait: unimplemented("wait") as T3Seam["wait"],
    queue: unimplemented("queue") as T3Seam["queue"],
    disableAutoSettle: unimplemented("disableAutoSettle") as T3Seam["disableAutoSettle"],
    queueCancel: unimplemented("queueCancel") as T3Seam["queueCancel"],
    send: async (input) => {
      fake.sends.push(input);
      throw new T3Error("refused", "t3_thread_send: unavailable", "retry");
    },
  };
  return fake;
}

/** Git stubs: a clean checkout, a State: line, and a sha for the ticket's land on main. */
function fakeGit(landSha = "1a9ca3fc"): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("--porcelain")) return { ok: true, err: "", out: "" };
      if (line.includes("--fixed-strings")) return { ok: true, err: "", out: `${landSha}\n` };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: "1\n" };
      return { ok: true, err: "", out: "State: ready\n" };
    }),
  );
}

/**
 * The 1163 shape: an ob item whose spinoff row already LANDED (`merged`), with an architect thread pinned so
 * the readying note WOULD be delivered if the guard let it through.
 */
async function seed(dbPath: string, worktree: string, status: "merged" | "launched" | "ready-for-gate"): Promise<void> {
  const db = openDb(dbPath, { create: true });
  const { row } = await enqueueSpinoff(db, input({ worktree }));
  db.query(
    "UPDATE spinoff SET status = ?, agent_id = ?, worktree = ?, launcher = 't3', t3_thread_id = ?, item_id = '1188' WHERE id = ?",
  ).run(status, "1188", worktree, "builder-thread-1", row.id);
  // A builder hold, as the 418 class leaves behind: a repeat `ready` is the gesture that clears it.
  db.query("INSERT INTO lease (resource, holder, acquired_at, ttl_s, heartbeat_at) VALUES (?,?,?,?,?)").run(
    "ticket:1188",
    "1188",
    new Date().toISOString(),
    900,
    new Date().toISOString(),
  );
  await registerAgent(db, { id: "1188", ticket: "1188", branch: "1188", worktree, status: "readying", ttlS: 900 });
  omnislashTeamFor(db, "1188");
  await registerAgent(db, {
    id: "sentinel-omnislash",
    worktree: "/r/omnislash",
    status: "planning",
    launcher: "t3",
    sessionId: "sentinel-thread-1",
    ttlS: 900,
  });
  await openRunsOnSeats(db);
  db.close();
}

function rowStatus(dbPath: string): string {
  const db = openDb(dbPath);
  const row = db.query("SELECT status FROM spinoff WHERE ticket_ref = '1188'").get() as { status: string };
  db.close();
  return row.status;
}

/** The holder of a lease resource, or null — read through the store so a released row reads as free. */
function leaseHolder(dbPath: string, resource: string): string | null {
  const db = openDb(dbPath);
  const row = db.query("SELECT holder FROM lease WHERE resource = ?").get(resource) as { holder: string } | null;
  db.close();
  return row?.holder ?? null;
}

describe("ob spinoff ready refuses a row that already LANDED (1188)", () => {
  test("a merged row is refused by name, with the sha it landed as, and no note is sent", async () => {
    const dbPath = freshDbPath();
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-1188-"));
    restores.push(() => rmSync(wt, { recursive: true, force: true }));
    await seed(dbPath, wt, "merged");
    fakeGit("66bceda5");
    const fake = fakeT3();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1188"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("nothing to gate; 1188 landed as 66bceda5");
    expect(fake.sends).toHaveLength(0); // the announce is what the guard exists to stop
    expect(rowStatus(dbPath)).toBe("merged"); // and the row is not re-stamped
  });

  test("the refusal still names the land when the row's checkout is gone", async () => {
    const dbPath = freshDbPath();
    // The exact 1163 shape: /home/owner/dev/omnislash.1163 no longer existed.
    await seed(dbPath, join(tmpdir(), "ob-wt-1188-deleted"), "merged");
    fakeGit("66bceda5");
    const fake = fakeT3();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1188"]);
    expect(res.code).toBe(1);
    // The sha comes off main, not the checkout, so a deleted worktree still gets the land named — and the
    // LANDED refusal, not the missing-worktree one, is what a landed row earns.
    expect(res.err).toContain("nothing to gate; 1188 landed as 66bceda5");
    expect(res.err).not.toContain("does not exist");
    expect(fake.sends).toHaveLength(0);
  });

  test("an unreadable land sha is reported as unreported, never guessed at", async () => {
    const dbPath = freshDbPath();
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-1188-nosha-"));
    restores.push(() => rmSync(wt, { recursive: true, force: true }));
    await seed(dbPath, wt, "merged");
    restores.push(__setSh(() => ({ ok: true, err: "", out: "" }))); // every git read comes back empty
    const fake = fakeT3();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1188"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("nothing to gate; 1188 has already landed");
    expect(res.err).toContain("sha is unreported");
    expect(fake.sends).toHaveLength(0);
  });
});

describe("ob spinoff ready refuses a row whose worktree is gone (1188)", () => {
  // The other ordering of the same incident: the row was still `launched` while the ticket had landed,
  // and the deleted checkout passed the dirty check because that check returned early on a missing path.
  test("a launched row whose checkout was removed is refused, named, and sends no note", async () => {
    const dbPath = freshDbPath();
    const gone = join(tmpdir(), "ob-wt-1188-removed");
    await seed(dbPath, gone, "launched");
    fakeGit();
    const fake = fakeT3();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1188"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain(`worktree ${gone} does not exist`);
    expect(res.err).toContain("nothing to gate from it");
    expect(fake.sends).toHaveLength(0);
    expect(rowStatus(dbPath)).toBe("launched");
  });

  test("a worktree that exists and is clean still stamps, and then tells the architect", async () => {
    const dbPath = freshDbPath();
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-1188-clean-"));
    restores.push(() => rmSync(wt, { recursive: true, force: true }));
    await seed(dbPath, wt, "launched");
    fakeGit();
    const fake = fakeT3();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1188"]);
    expect(res.out).toContain("1188 handed off");
    expect(res.out).toContain(`worktree:  ${wt}`);
    expect(rowStatus(dbPath)).toBe("ready-for-gate");
    // The note is composed and sent (the fake refuses it, which is a warning, not a rollback: 1133's rule),
    // and the refusal is retried once with the same request id (OB-2172).
    expect(fake.sends).toHaveLength(2);
    expect(fake.sends[1]!.clientRequestId).toBe(fake.sends[0]!.clientRequestId);
    expect(fake.sends[0]!.threadId).toBe("sentinel-thread-1");
  });

  // THE HALF THE GUARD MUST NOT BREAK (found by review, 2026-10-18): a REPEAT of `ready` exists for its 426
  // cleanup — clearing a builder hold a `/ob-spinoff-done` left behind (the 418 class) — and that half is safe
  // with the checkout gone. What 1188 closes is the ANNOUNCE, so the cleanup runs and the note is skipped.
  test("a REPEAT on an already-stamped row whose checkout is gone clears the builder's hold and announces nothing", async () => {
    const dbPath = freshDbPath();
    const gone = join(tmpdir(), "ob-wt-1188-repeat-gone");
    await seed(dbPath, gone, "ready-for-gate");
    expect(leaseHolder(dbPath, "ticket:1188")).toBe("1188"); // the stuck hold a human re-runs `ready` to clear
    fakeGit();
    const fake = fakeT3();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1188"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("1188 already handed off");
    expect(res.out).toContain(`the worktree ${gone} does not exist, so there is nothing to announce`);
    expect(leaseHolder(dbPath, "ticket:1188")).toBeNull(); // 426 kept
    expect(fake.sends).toHaveLength(0); // and no note names a checkout an architect could not gate
  });
});

describe("alreadyLandedRefusal (1188)", () => {
  // The wording is user-visible in both close paths' peers (the ready command), so it is pinned here once.
  test("names the land and its sha, and says unreported rather than guessing", () => {
    expect(alreadyLandedRefusal("1163", "66bceda5")).toBe("nothing to gate; 1163 landed as 66bceda5");
    expect(alreadyLandedRefusal("1163", null)).toBe(
      "nothing to gate; 1163 has already landed (its merge commit sha is unreported)",
    );
  });
});

describe("docs (1188)", () => {
  test("HELP and README name both refusals, the repeat exception, and that neither stamps nor sends", () => {
    const help = renderSubcommandHelp("spinoff", "handoff");
    expect(help).toContain("missing checkouts");
    expect(help).toContain("already-landed");
    expect(help).toContain("Repeat handoff");
    expect(help).toContain("releases builder leases");
    expect(README).toContain("it refuses when that worktree does not exist, or the row has already LANDED");
    expect(README).toContain("a **repeat** on a row that is *already* `handed-off` whose checkout is gone still releases");
    expect(README).toContain("nothing to gate; <ticket> landed as <sha>");
    expect(README).toContain("no stamp, no note");
  });
});
