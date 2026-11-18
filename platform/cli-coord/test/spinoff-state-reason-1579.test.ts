import { describe, expect, test } from "bun:test";
import {
  STATE_REASON_MAX,
  agentNoteText,
  cutAtWord,
  decoratedReasonLine,
  parseStateReason,
  reasonLine,
  stateDisplayLines,
} from "../src/spinoff-state-reason.ts";
import { stateParagraph } from "../src/commands/spinoff.ts";
import { assessGateable, renderGateableList } from "../src/spinoff-gateable.ts";

// acme-shop 1417, as quoted on the ticket: the gate result and tallies first, the reason last. Pinned.
const ACME_SHOP_1417 =
  "State: needs-human — gate green on Bun (check, typecheck, test 63 pass, build; fee schedule snapshot). " +
  "skeptical-review: 11 cut, 0 open (sonnet: 4 + deepseek: 4 + luna: 3). " +
  "The founder should judge the fee levels (12% + R8 buyer fee) and the R650k ask.";

describe("parseStateReason (1579)", () => {
  test("new shape: the reason is the whole short line", () => {
    const state = "State: needs-human — judge the fee levels (12% + R8 buyer fee) and the R650k ask";
    expect(parseStateReason(state)).toEqual({
      token: "needs-human",
      reason: "judge the fee levels (12% + R8 buyer fee) and the R650k ask",
    });
    expect(reasonLine(state)).toBe("needs you: judge the fee levels (12% + R8 buyer fee) and the R650k ask");
  });

  test("blocked and partial use their own labels", () => {
    expect(reasonLine("State: blocked — an API key for the sandbox, from the owner")).toBe(
      "blocked on: an API key for the sandbox, from the owner",
    );
    expect(reasonLine("State: partial — the migration is not written")).toBe("missing: the migration is not written");
  });

  test("old shape (1417 fixture): skips the gate result and the tallies, finds the reason", () => {
    expect(reasonLine(ACME_SHOP_1417)).toBe(
      "needs you: The founder should judge the fee levels (12% + R8 buyer fee) and the R650k ask",
    );
  });

  test("a new-style reason that opens with a verb the gate also uses is still a reason", () => {
    for (const verb of ["check the fee copy", "review the empty state", "test the flow on a phone", "build is fine, judge the layout"]) {
      expect(parseStateReason(`State: needs-human — ${verb}`)?.reason).toBe(verb);
    }
  });

  test("an old line with only a gate result has no reason: the State text prints as today", () => {
    const state = "State: needs-human — gate green (typecheck 9 projects, test 7). skeptical-review: 2 cut, 0 open.";
    expect(parseStateReason(state)?.reason).toBeNull();
    expect(reasonLine(state)).toBeNull();
    expect(stateDisplayLines(state)).toEqual([`  ${state}`]);
  });

  test("a reason over the limit is cut at a word boundary with an ellipsis, never mid-word", () => {
    const long = `State: needs-human — ${"judge the wording of the empty state and the colour of the badge ".repeat(4).trim()}`;
    const reason = parseStateReason(long)?.reason ?? "";
    expect(reason.length).toBeLessThanOrEqual(STATE_REASON_MAX);
    expect(reason.endsWith("…")).toBe(true);
    const words = new Set(long.split(/\s+/));
    const lastWord = reason.slice(0, -1).split(" ").pop()!;
    expect(words.has(lastWord)).toBe(true);
  });

  test("ready and landable carry the verdict word but no reason label", () => {
    for (const word of ["landable", "ready"]) {
      const state = `State: ${word} — gate green (typecheck, test 7)`;
      expect(parseStateReason(state)?.token).toBe(word);
      expect(reasonLine(state)).toBeNull();
      expect(stateDisplayLines(state)).toEqual([`  ${state}`]);
    }
  });

  test("not a State line, or no State", () => {
    expect(parseStateReason("feat: something")).toBeNull();
    expect(parseStateReason(null)).toBeNull();
  });
});

describe("cutAtWord", () => {
  test("text that fits is unchanged", () => {
    expect(cutAtWord("short reason")).toBe("short reason");
  });
  test("cuts at the last space inside the window", () => {
    const out = cutAtWord("alpha beta gamma delta", 14);
    expect(out).toBe("alpha beta…");
    expect(out.length).toBeLessThanOrEqual(14);
  });
});

describe("display (1579)", () => {
  const state = "State: needs-human — judge the fee levels and the R650k ask";

  test("the reason gets its own marked line; the verdict word stays on State:", () => {
    expect(stateDisplayLines(state)).toEqual([
      "  State: needs-human",
      "  🙋 needs you: judge the fee levels and the R650k ask",
    ]);
  });

  test("markdown surfaces bold the label", () => {
    expect(decoratedReasonLine(state, true)).toBe("🙋 **needs you:** judge the fee levels and the R650k ask");
    expect(decoratedReasonLine("State: blocked — a key from the owner")).toBe("⛔ blocked on: a key from the owner");
    expect(decoratedReasonLine("State: partial — the docs")).toBe("🧩 missing: the docs");
  });

  test("gateable prints the reason, not the paragraph, and --json keeps the full state", () => {
    const row = assessGateable(
      { id: 7, ticket_ref: "1417", branch: "1417", worktree: "/wt", repo: "acme-shop" },
      { missing: false, state: ACME_SHOP_1417, paths: ["apps/cli/src/x.ts"] },
    );
    const text = renderGateableList([row], "human");
    expect(text).toContain("🙋 needs you: The founder should judge the fee levels");
    expect(text).not.toContain("gate green on Bun");
    const json = JSON.parse(renderGateableList([row], "json"))[0];
    expect(json.state).toBe(ACME_SHOP_1417);
  });

  test("an agent row's needs-human note prints as the reason; other statuses are untouched", () => {
    expect(agentNoteText("needs-human", "judge the fee levels")).toBe("🙋 needs you: judge the fee levels");
    expect(agentNoteText("working", "building the parser")).toBe("building the parser");
    expect(agentNoteText("needs-human", "x ".repeat(80).trim()).endsWith("…")).toBe(true);
  });
});

describe("stateParagraph (1579)", () => {
  test("joins the wrapped State line and stops at a blank line", () => {
    const body = "State: needs-human — gate green on Bun (check,\ntypecheck). The founder judges\nthe fees.\n\nCo-Authored-By: x";
    expect(stateParagraph(body)).toBe("State: needs-human — gate green on Bun (check, typecheck). The founder judges the fees.");
  });
  test("stops at the next labelled line", () => {
    const body = "State: needs-human — judge the fees\nGate: green on Bun\nLook at: apps/x.ts";
    expect(stateParagraph(body)).toBe("State: needs-human — judge the fees");
  });
});
