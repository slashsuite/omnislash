import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decide } from "../src/decide.ts";
import { exportStates, exportTransitions, renderAll } from "../src/export.ts";
import { moveEvent, taskMachine } from "../src/item.ts";
import { MIRRORED_STATES, ROLE_TRANSITIONS, ROLES, ROW_STATE, type RoleStateMeta, roleMachine, STATE_IDS, type Stored } from "../src/role.ts";
import { PHASE_EVENT, PHASES_BY_STATUS, SPINOFF_PHASES, isSpinoffPhase, phaseStateOf, spinoffPhaseMachine } from "../src/spinoff-phase.ts";
import { SPINOFF_EDGES, type SpinoffState, spinoffMachine } from "../src/spinoff.ts";

// OS-174: the role machine and what the export makes of it.

const ROOT = join(import.meta.dirname, "../../..");
const stored = (id: string): Stored => (roleMachine.states[id]!.meta as RoleStateMeta).stored;

// OS-236: one reviewer role with two steps (checking, reviewing); the generated-docs test pins each state's role.
test("there is no checker role", () => {
  expect(ROLES).not.toContain("checker");
});

describe("the generated files", () => {
  test("the committed docs/role-state-machine.json and .mmd are what role.ts gives", () => {
    for (const [path, text] of Object.entries(renderAll())) {
      expect(readFileSync(join(ROOT, path), "utf8"), `${path}: run bunx moon run state-machine:export`).toBe(text);
    }
  });

  test("the JSON keeps the v1 shape: 21 states, 42 transitions, every endpoint a state", () => {
    const json = JSON.parse(renderAll()["docs/role-state-machine.json"]!);
    expect(json.version).toBe(1);
    expect(json.states).toHaveLength(21);
    expect(json.transitions).toHaveLength(42);
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
});

// OS-230: the role states that mirror a row status or a phase are built from spinoff.ts and spinoff-phase.ts. These
// fail when the role machine and the row or phase machine say different things about the same state.
describe("the states that mirror the row and phase machines", () => {
  const STATUSES = Object.keys(SPINOFF_EDGES) as SpinoffState[];
  const node = (id: string) => roleMachine.states[id]!;

  test("every row status has its role state, riding on that status, final exactly when the row cannot move on", () => {
    for (const status of STATUSES) {
      const id = ROW_STATE[status];
      expect(STATE_IDS, status).toContain(id);
      if (id === "closed") continue; // a merged row's ticket is closed: the item's state, not the row's
      expect(stored(id), status).toEqual({ table: "spinoff", status });
      expect(node(id).type === "final", status).toBe(Object.keys(SPINOFF_EDGES[status]).length === 0);
    }
  });

  test("every phase is a role state riding on the one status that holds it", () => {
    for (const phase of SPINOFF_PHASES) {
      const holders = STATUSES.filter((s) => (PHASES_BY_STATUS[s] ?? []).includes(phase));
      expect(holders, phase).toHaveLength(1);
      expect(stored(phase), phase).toEqual({ table: "spinoff", status: holders[0] });
    }
  });

  test("each mirrored state is drawn once, with the meta it was built with", () => {
    for (const [id, def] of Object.entries(MIRRORED_STATES)) {
      expect(STATE_IDS.filter((s) => s === id), id).toHaveLength(1);
      const { id: _, terminal: __, ...meta } = def;
      expect(node(id).meta, id).toEqual(meta);
    }
    expect(new Set(STATE_IDS).size).toBe(STATE_IDS.length);
  });

  test("a move between two row-backed states is a row event that makes it, or a phase the phase machine allows", () => {
    for (const t of ROLE_TRANSITIONS) {
      const a = stored(t.from);
      const b = stored(t.to);
      if (a?.table !== "spinoff" || b?.table !== "spinoff") continue;
      const at = `${t.from} -> ${t.to}`;
      if (a.status !== b.status) {
        const [path, event] = t.source.split("#");
        expect(path, `${at}: a status change is sourced from the row event that makes it`).toBe("platform/state-machine/src/spinoff.ts");
        expect(decide(spinoffMachine, a.status, event!), at).toEqual({ ok: true, to: b.status });
      } else if (isSpinoffPhase(t.to)) {
        const from = phaseStateOf(a.status, isSpinoffPhase(t.from) ? t.from : null);
        expect(decide(spinoffPhaseMachine, from, PHASE_EVENT[t.to]), at).toEqual({ ok: true, to: phaseStateOf(a.status, t.to) });
      }
    }
  });
});
