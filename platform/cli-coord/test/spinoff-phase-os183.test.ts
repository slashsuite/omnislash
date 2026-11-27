// OS-183: `spinoff.phase`, the role phase inside a row's status. The hooks set it (a status move through
// moveSpinoff, the needs-human verdict, `ob spinoff phase`), the phase machine refuses a phase the status does
// not hold and logs the refusal as OS-169's `machine_would_refuse`, and `ob spinoff list --json` and the
// spinoffs API carry it. Fresh SQLite file per test; no network.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { TransitionRefused } from "../../../apps/cli/src/errors.ts";
import { ApiFault } from "../../../apps/cli/src/api/fault.ts";
import * as h from "../../../apps/cli/src/api/handlers.ts";
import { MACHINE_SHADOW_SOURCE, MACHINE_WOULD_REFUSE } from "../../../apps/cli/src/machine-shadow.ts";
import { machineAudit } from "../../../apps/cli/src/machine-audit.ts";
import {
  SpinoffPhaseRefused,
  enqueueSpinoff,
  getSpinoffRow,
  markSpinoffReady,
  markSpinoffSentBack,
  moveSpinoff,
  recordSpinoffVerdict,
  setSpinoffPhase,
} from "../src/commands/spinoff.ts";

const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

function dbAt(): { d: Database; path: string } {
  const path = freshDbPath();
  paths.push(path);
  return { d: openDb(path, { create: true }), path };
}

/** A clean-repo row (its verdict lives on the row) stamped at `status`. */
async function rowAt(d: Database, status: string): Promise<number> {
  const { row } = await enqueueSpinoff(d, { ticketRef: "HC-7", repo: "/r/hackcove", branch: "keep-zoom", mode: "interactive", brief: "b", launcher: "t3" });
  d.query("UPDATE spinoff SET status = ?, agent_id = ?, worktree = ? WHERE id = ?").run(status, "hc-7", "/wt/hc-7", row.id);
  return row.id;
}

const phaseOf = async (d: Database, id: number) => (await getSpinoffRow(d, id))?.phase ?? null;

function refusals(d: Database): Array<Record<string, unknown>> {
  return (d.query("SELECT payload FROM event WHERE source = ? AND type = ?").all(MACHINE_SHADOW_SOURCE, MACHINE_WOULD_REFUSE) as Array<{ payload: string }>).map(
    (r) => JSON.parse(r.payload) as Record<string, unknown>,
  );
}

describe("OS-183 spinoff.phase", () => {
  test("a row reads phase null until a hook sets one", async () => {
    const { d } = dbAt();
    const id = await rowAt(d, "launched");
    expect(await phaseOf(d, id)).toBeNull();
  });

  test("the hooks drive one row through all five phases", async () => {
    const { d } = dbAt();
    const id = await rowAt(d, "launched");
    const seen: (string | null)[] = [];
    // skeptical review start (`ob review run` runs `ob spinoff phase <ref> reviewing`, review-run.ts)
    await setSpinoffPhase(d, id, "reviewing");
    seen.push(await phaseOf(d, id));
    // PR opened (pr-wait, run after `gh pr create`, runs `ob spinoff phase <id> pr_ci`: pr-wait-phase-os285.test.ts)
    await setSpinoffPhase(d, id, "pr_ci");
    seen.push(await phaseOf(d, id));
    // ob spinoff handoff
    await markSpinoffReady(d, (await getSpinoffRow(d, id))!);
    seen.push(await phaseOf(d, id));
    // ob spinoff sendback
    await markSpinoffSentBack(d, (await getSpinoffRow(d, id))!, { note: "fix it" });
    seen.push(await phaseOf(d, id));
    // ob-spinoff's order: the builder records needs-human while building, then hands off
    await recordSpinoffVerdict(d, (await getSpinoffRow(d, id))!, { verdict: "needs-human", reason: "is the label right?" });
    expect(await phaseOf(d, id)).toBe("updating_pr");
    await markSpinoffReady(d, (await getSpinoffRow(d, id))!);
    seen.push(await phaseOf(d, id));
    expect(seen).toEqual(["reviewing", "pr_ci", "gating", "updating_pr", "owner_merge_call"]);
    // landing clears it
    await moveSpinoff(d, id, "land");
    expect(await phaseOf(d, id)).toBeNull();
    expect(refusals(d)).toEqual([]);
  });

  test("on a handed-off row, a needs-human verdict waits on the owner and a later landable goes back to gating", async () => {
    const { d } = dbAt();
    const id = await rowAt(d, "launched");
    await markSpinoffReady(d, (await getSpinoffRow(d, id))!);
    expect(await phaseOf(d, id)).toBe("gating");
    await recordSpinoffVerdict(d, (await getSpinoffRow(d, id))!, { verdict: "needs-human" });
    expect(await phaseOf(d, id)).toBe("owner_merge_call");
    await recordSpinoffVerdict(d, (await getSpinoffRow(d, id))!, { verdict: "landable" });
    expect(await phaseOf(d, id)).toBe("gating");
    expect(refusals(d)).toEqual([]);
  });

  test("a phase the status does not hold (an older writer's leftover) reads as the bare status, and a set repairs it", async () => {
    const { d } = dbAt();
    const id = await rowAt(d, "ready-for-gate");
    d.query("UPDATE spinoff SET phase = 'pr_ci' WHERE id = ?").run(id);
    expect((await setSpinoffPhase(d, id, "gating")).from).toBeNull();
    expect(await phaseOf(d, id)).toBe("gating");
  });

  test("a stamp keeps the phase; a needs-human verdict on a building row leaves it alone", async () => {
    const { d } = dbAt();
    const id = await rowAt(d, "launched");
    await setSpinoffPhase(d, id, "pr_ci");
    await moveSpinoff(d, id, "stamp");
    expect(await phaseOf(d, id)).toBe("pr_ci");
    await recordSpinoffVerdict(d, (await getSpinoffRow(d, id))!, { verdict: "needs-human" });
    expect(await phaseOf(d, id)).toBe("pr_ci");
    expect(refusals(d)).toEqual([]);
  });

  test("the machine refuses a phase the row's status does not hold, the row keeps its phase, and the refusal is logged", async () => {
    const { d } = dbAt();
    const id = await rowAt(d, "launched");
    await setSpinoffPhase(d, id, "pr_ci");
    const err = (await setSpinoffPhase(d, id, "gating", { actor: "arch" }).catch((e: unknown) => e)) as SpinoffPhaseRefused;
    expect(err).toBeInstanceOf(SpinoffPhaseRefused);
    expect(err).toBeInstanceOf(TransitionRefused);
    expect(err.message).toBe(`spinoff #${id} is building: it cannot be in phase 'gating' (its phases are reviewing, pr_ci, updating_pr)`);
    expect({ machine: err.machine, from: err.from, event: err.event, why: err.why }).toEqual({ machine: "spinoff-phase", from: "launched/pr_ci", event: "gate", why: "machine" });
    expect(await phaseOf(d, id)).toBe("pr_ci");
    expect(refusals(d)).toEqual([
      { machine: "spinoff-phase", id: String(id), rowId: id, from: "launched/pr_ci", event: "gate", to: "launched/gating", why: "machine", today: "refused", message: err.message },
    ]);
    // `ob machine audit` groups it with the rest
    const audit = await machineAudit(asStore(d));
    expect(audit.wouldRefuse.groups).toEqual([{ machine: "spinoff-phase", from: "launched/pr_ci", event: "gate", today: "refused", count: 1, example: `#${id}` }]);
  });

  test("a status with no phases refuses every phase", async () => {
    const { d } = dbAt();
    const id = await rowAt(d, "merged");
    await expect(setSpinoffPhase(d, id, "reviewing")).rejects.toThrow(`spinoff #${id} is landed: it cannot be in phase 'reviewing' (that status holds no phase)`);
    expect(await phaseOf(d, id)).toBeNull();
  });

  test("ob spinoff phase sets it, refuses a bad word and a disallowed phase, and list --json carries it", async () => {
    const { d, path } = dbAt();
    await rowAt(d, "launched");
    d.close();
    const ok = await runCli(path, ["spinoff", "phase", "HC-7", "reviewing", "--json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ ticket: "HC-7", status: "building", phase: "reviewing", from: null });
    const human = await runCli(path, ["spinoff", "phase", "HC-7", "pr-ci"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("building: phase reviewing → pr_ci");
    const bad = await runCli(path, ["spinoff", "phase", "HC-7", "shipping"]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("unknown phase 'shipping'");
    const refused = await runCli(path, ["spinoff", "phase", "HC-7", "owner_merge_call"]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("it cannot be in phase 'owner_merge_call'");
    const list = await runCli(path, ["spinoff", "list", "--json"]);
    expect(list.code).toBe(0);
    expect((JSON.parse(list.out) as Array<{ phase: string | null }>)[0]!.phase).toBe("pr_ci");
    const show = await runCli(path, ["spinoff", "show", "HC-7"]);
    expect(show.out).toContain("  phase:     pr_ci");
  });

  test("the API sets it (400 on a bad word, 409 on a refusal) and the spinoffs list carries it", async () => {
    const { d } = dbAt();
    const id = await rowAt(d, "launched");
    const store = asStore(d);
    const res = await h.spinoffPhase(store, { id, phase: "updating_pr" });
    expect([res.row.phase, res.from]).toEqual(["updating_pr", null]);
    expect((await h.spinoffs(store, {})).spinoffs.find((r) => r.id === id)?.phase).toBe("updating_pr");
    const bad = (await h.spinoffPhase(store, { id, phase: "nope" }).catch((e: unknown) => e)) as ApiFault;
    expect(bad).toBeInstanceOf(ApiFault);
    expect(bad.status).toBe(400);
    const refused = (await h.spinoffPhase(store, { id, phase: "gating" }).catch((e: unknown) => e)) as ApiFault;
    expect(refused.status).toBe(409);
    const missing = (await h.spinoffPhase(store, { id: 999, phase: "gating" }).catch((e: unknown) => e)) as ApiFault;
    expect(missing.status).toBe(404);
  });
});
