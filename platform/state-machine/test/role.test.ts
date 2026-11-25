import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decide } from "../src/decide.ts";
import { exportStates, exportTransitions, renderAll } from "../src/export.ts";
import { moveEvent, taskMachine } from "../src/item.ts";
import { ROLE_TRANSITIONS, type RoleStateMeta, roleMachine, type Stored } from "../src/role.ts";
import { SPINOFF_EDGES, spinoffMachine } from "../src/spinoff.ts";

// OS-174: the role machine and what the export makes of it.

const ROOT = join(import.meta.dirname, "../../..");
const stored = (id: string): Stored => (roleMachine.states[id]!.meta as RoleStateMeta).stored;

describe("the generated files", () => {
  test("the committed docs/role-state-machine.json and .mmd are what role.ts gives", () => {
    for (const [path, text] of Object.entries(renderAll())) {
      expect(readFileSync(join(ROOT, path), "utf8"), `${path}: run bunx moon run state-machine:export`).toBe(text);
    }
  });

  test("the JSON keeps the v1 shape: 20 states, 39 transitions, every endpoint a state", () => {
    const json = JSON.parse(renderAll()["docs/role-state-machine.json"]!);
    expect(json.version).toBe(1);
    expect(json.states).toHaveLength(20);
    expect(json.transitions).toHaveLength(39);
    const ids = new Set(json.states.map((s: { id: string }) => s.id));
    for (const t of json.transitions) {
      expect(Object.keys(t)).toEqual(["from", "to", "label", "event", "actor", "source"]);
      expect(ids.has(t.from) && ids.has(t.to), `${t.from} -> ${t.to}`).toBe(true);
      expect(json.roles).toContain(t.actor);
    }
    for (const s of json.states) expect(Object.keys(s)).toEqual(["id", "label", "role", "human_required", "terminal"]);
  });

  test("the export reads every move off the machine, in role.ts order", () => {
    expect(exportTransitions().map((t) => `${t.from}>${t.to}`)).toEqual(ROLE_TRANSITIONS.map((t) => `${t.from}>${t.to}`));
    expect(exportStates().filter((s) => s.terminal).map((s) => s.id)).toEqual(["closed", "failed"]);
  });
});

describe("the role machine", () => {
  test("every move is a move of the machine, through decide", () => {
    for (const t of ROLE_TRANSITIONS) expect(decide(roleMachine, t.from, t.event)).toEqual({ ok: true, to: t.to });
    expect(decide(roleMachine, "exploring", "launch claims the row").ok).toBe(false);
  });

  test("a source is a skill line, or a symbol that exists", () => {
    for (const { source, from, to } of ROLE_TRANSITIONS) {
      const at = `${from} -> ${to}: ${source}`;
      if (source.startsWith("skills/")) {
        expect(source, at).toMatch(/^skills\/[a-z-]+\/SKILL\.md:\d+$/);
        continue;
      }
      const [path, symbol] = source.split("#");
      expect(symbol, at).toBeTruthy();
      expect(existsSync(join(ROOT, path!)), at).toBe(true);
      if (path === "platform/state-machine/src/spinoff.ts") {
        expect(Object.values(SPINOFF_EDGES).some((edges) => symbol! in edges), at).toBe(true);
      } else if (path === "platform/state-machine/src/item.ts") {
        expect(Object.keys(taskMachine.states).map(moveEvent), at).toContain(symbol);
      } else {
        expect(readFileSync(join(ROOT, path!), "utf8"), at).toMatch(new RegExp(`function ${symbol}\\(`));
      }
    }
  });

  test("a row event's source moves the row between the statuses its two states ride on", () => {
    for (const t of ROLE_TRANSITIONS) {
      const [path, event] = t.source.split("#");
      const a = stored(t.from);
      const b = stored(t.to);
      if (path !== "platform/state-machine/src/spinoff.ts" || a?.table !== "spinoff" || b?.table !== "spinoff") continue;
      expect(decide(spinoffMachine, a.status, event!), `${t.from} -> ${t.to}`).toEqual({ ok: true, to: b.status });
    }
  });
});
