import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SPINOFF_EDGES } from "../src/spinoff.ts";

// OS-211 (OS-112): model/Spinoff.tla is the spinoff row lifecycle TLC checks, and its `Edges` set must be
// SPINOFF_EDGES exactly. An edge added to or dropped from the machine fails here until the model says the same,
// and CI's `tla` job re-runs TLC on the model (model/tlc.sh), so the lifecycle and its checked rules move together.

const MODEL = readFileSync(join(import.meta.dirname, "..", "model", "Spinoff.tla"), "utf8");

/** The `<<from, event, to>>` triples inside `Edges == { ... }`. */
function modelEdges(text: string): string[] {
  const block = /^Edges == \{\n([\s\S]*?)\n\}/m.exec(text);
  if (!block) throw new Error("model/Spinoff.tla has no `Edges == {` block");
  return [...block[1]!.matchAll(/<<"([^"]+)", "([^"]+)", "([^"]+)">>/g)].map((m) => `${m[1]} --${m[2]}--> ${m[3]}`).sort();
}

function quotedSet(text: string, name: string): string[] {
  const m = new RegExp(`^${name} == \\{([^}]*)\\}`, "m").exec(text);
  if (!m) throw new Error(`model/Spinoff.tla has no ${name}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
}

describe("the TLA+ model matches the machine (OS-211)", () => {
  test("Edges is SPINOFF_EDGES, edge for edge", () => {
    const machine = Object.entries(SPINOFF_EDGES)
      .flatMap(([from, edges]) => Object.entries(edges).map(([event, to]) => `${from} --${event}--> ${to}`))
      .sort();
    expect(modelEdges(MODEL)).toEqual(machine);
  });

  test("States and Events are the machine's", () => {
    expect(quotedSet(MODEL, "States")).toEqual(Object.keys(SPINOFF_EDGES).sort());
    const events = [...new Set(Object.values(SPINOFF_EDGES).flatMap((e) => Object.keys(e)))].sort();
    expect(quotedSet(MODEL, "Events")).toEqual(events);
  });
});
