import { describe, expect, test } from "vitest";
import { applyMove } from "../src/apply.ts";
import { spinoffMachine } from "../src/spinoff.ts";

// OS-173: applyMove over an in-memory row, so each refusal reason is driven without a database.
function row(initial: string | null, opts: { moveUnder?: string; extraRefuses?: boolean } = {}) {
  let status = initial;
  const writes: Array<[string, string]> = [];
  return {
    writes,
    status: () => status,
    spec: (event: string, from?: readonly string[]) => ({
      event,
      from,
      read: async () => status,
      write: async (f: string, t: string) => {
        writes.push([f, t]);
        if (opts.moveUnder) status = opts.moveUnder; // another writer moved it between our read and write
        if (opts.extraRefuses || status !== f) return null;
        status = t;
        return { status: t };
      },
    }),
  };
}

describe("applyMove (OS-173)", () => {
  test("a row moved under the write to a state the event still leads the same way from is written there", async () => {
    // land on a launched row, handed off meanwhile: land is an edge from ready-for-gate to merged too.
    const r = row("launched", { moveUnder: "ready-for-gate" });
    expect(await applyMove(spinoffMachine, r.spec("land"))).toEqual({ ok: true, row: { status: "merged" }, from: "ready-for-gate", to: "merged" });
    expect(r.writes).toEqual([["launched", "merged"], ["ready-for-gate", "merged"]]);
  });

  test("a row moved under the write outside the caller's from-set is a race", async () => {
    const r = row("launching", { moveUnder: "launched" });
    expect(await applyMove(spinoffMachine, r.spec("retry", ["launching"]))).toEqual({ ok: false, why: "race", from: "launched", event: "retry" });
  });

  test("a row that moved under the write is a race, naming where it is now", async () => {
    const r = row("launched", { moveUnder: "merged" });
    expect(await applyMove(spinoffMachine, r.spec("handoff"))).toEqual({ ok: false, why: "race", from: "merged", event: "handoff" });
    expect(r.status()).toBe("merged");
  });

  test("a write its own extra condition refused, with the row unmoved, is a guard", async () => {
    const r = row("pending", { extraRefuses: true });
    expect(await applyMove(spinoffMachine, r.spec("claim"))).toEqual({ ok: false, why: "guard", from: "pending", event: "claim" });
  });
});
