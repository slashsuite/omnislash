import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  COMPARE_RULES,
  dropCrossSlotWalkDiffs,
  dropGreyOnGreyNavDiffs,
  parseCompareOutput,
  parseCompareRequest,
  runVisionCompare,
  type CompareDiff,
} from "../../../apps/cli/src/vision/compare.ts";
import { type ProcLike, type SpawnProc } from "../../cli-whatsapp/src/whatsapp/describe.ts";

const FIX = join(import.meta.dir, "../../../apps/cli/test/fixtures", "vision");
const LEFT = join(FIX, "left.png");
const RIGHT = join(FIX, "right.png");

const enc = new TextEncoder();

function fakeProc(stdoutText: string, stderrText = "", exitCode: number | null = 0, signalCode: string | null = null): ProcLike {
  const stream = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (text) c.enqueue(enc.encode(text));
        c.close();
      },
    });
  return {
    stdout: stream(stdoutText),
    stderr: stream(stderrText),
    exited: Promise.resolve(exitCode),
    exitCode,
    signalCode,
    stdin: { write: () => {}, end: () => {} },
  };
}

function recordSpawn(...procs: ProcLike[]): SpawnProc {
  const calls: ProcLike[] = [...procs];
  let i = 0;
  return (cmd, opts) => {
    void cmd;
    void opts;
    return calls[i++] ?? fakeProc("NONE");
  };
}

const INBOX_LIGHTER: CompareDiff = { where: "Inbox title", what: "lighter grey than the build" };
const SEARCH_DARKER: CompareDiff = { where: "search field", what: "darker tone" };
const INBOX_BRAND: CompareDiff = { where: "Inbox title", what: "grey versus brand" };
const LIST_PAD: CompareDiff = { where: "list row", what: "taller padding than the mockup" };
const PHONE_SUCCESS: CompareDiff = { where: "trailing phone icon", what: "grey versus success" };

describe("COMPARE_RULES walk (480)", () => {
  test("chrome walk is the first sentences after LEFT/RIGHT", () => {
    const marker = "LEFT is the first image. RIGHT is the second image.";
    const i = COMPARE_RULES.indexOf(marker);
    expect(i).toBeGreaterThanOrEqual(0);
    const after = COMPARE_RULES.slice(i + marker.length).trimStart();
    expect(after.startsWith("Walk these chrome items in order.")).toBe(true);
    expect(after).toMatch(/1\. ICON_TONE/);
    expect(after).toMatch(/3\. ROW_PAD/);
    expect(COMPARE_RULES).toMatch(
      /A page title or search field that is only lighter or darker grey \(same hue family\) is NOT a diff/,
    );
    expect(COMPARE_RULES).toMatch(/Output exactly five lines, nothing else/);
    expect(COMPARE_RULES).toMatch(/Each line MUST start with the key/);
    expect(COMPARE_RULES).toMatch(/ICON_TONE SAME/);
    expect(COMPARE_RULES).toMatch(/ICON_TONE DIFF success versus red/);
    expect(COMPARE_RULES).toMatch(/No such icon: N\/A/);
    expect(COMPARE_RULES).toMatch(/Never put DIFF before the key/);
    expect(COMPARE_RULES).toMatch(/Never repeat the walk instructions as the answer/);
    expect(COMPARE_RULES).toMatch(/WASH N\/A/);
    expect(COMPARE_RULES).toMatch(/WELL N\/A/);
    expect(COMPARE_RULES).toMatch(/LABEL_BASELINE/);
    expect(COMPARE_RULES).toMatch(/ROW_PAD/);
    expect(COMPARE_RULES).toMatch(/WASH/);
    expect(COMPARE_RULES).toMatch(/WELL/);
    expect(COMPARE_RULES).not.toMatch(/WHERE <region or chrome>/);
    expect(COMPARE_RULES).not.toMatch(/Skip an item only if it is the same/);
    expect(COMPARE_RULES).not.toMatch(/Each line is SAME, DIFF <change>, or N\/A/);
  });
});

describe("parseCompareOutput walk lines (480)", () => {
  test("DIFF lines become mapped diffs; SAME ignored", () => {
    expect(
      parseCompareOutput(
        "ICON_TONE DIFF grey versus success\nTAB_BASELINE SAME\nROW_PAD DIFF taller than mockup\nWASH SAME\nDIALER_WELL SAME",
      ),
    ).toEqual([
        { where: "chrome icon", what: "grey versus success" },
      { where: "list-row padding", what: "taller than mockup" },
    ]);
  });

  test("all SAME is empty", () => {
    expect(
      parseCompareOutput(
        "ICON_TONE SAME\nTAB_BASELINE SAME\nROW_PAD SAME\nWASH SAME\nDIALER_WELL SAME",
      ),
    ).toEqual([]);
  });

  test("N/A lines produce no diffs", () => {
    expect(
      parseCompareOutput(
        "ICON_TONE SAME\nTAB_BASELINE SAME\nROW_PAD SAME\nWASH N/A\nDIALER_WELL N/A",
      ),
    ).toEqual([]);
  });

  test("mix of N/A and one DIFF yields one diff", () => {
    expect(
      parseCompareOutput(
        "ICON_TONE DIFF grey versus success\nTAB_BASELINE N/A\nROW_PAD SAME\nWASH N/A\nDIALER_WELL N/A",
      ),
    ).toEqual([{ where: "chrome icon", what: "grey versus success" }]);
  });

  test("NONE is empty", () => {
    expect(parseCompareOutput("NONE")).toEqual([]);
  });

  test("WHERE/WHAT still parses", () => {
    expect(parseCompareOutput("WHERE listing header\nWHAT title+search became Chats/Calls tabs")).toEqual([
      { where: "listing header", what: "title+search became Chats/Calls tabs" },
    ]);
  });

  test("DIFF-first blob keeps ICON_TONE and WASH; drops TAB SAME", () => {
    expect(
      parseCompareOutput(
        "DIFF ICON_TONE DIFF grey versus success DIFF TAB_BASELINE SAME DIFF WASH DIFF covers Call",
      ),
    ).toEqual([
        { where: "chrome icon", what: "grey versus success" },
      { where: "selected wash", what: "covers Call" },
    ]);
  });

  test("live DIFF-first mash records ICON_TONE and TAB_BASELINE; WASH/DIALER if DIFF", () => {
    const diffs = parseCompareOutput(
      "DIFF ROW_PAD DIFF <1px padding> DIFF WASH DIFF covers Call DIFF TAB_BASELINE DIFF count above the label DIFF ICON_TONE DIFF <grey versus success>",
    );
    expect(diffs).toEqual(
      expect.arrayContaining([
        { where: "chrome icon", what: "<grey versus success>" },
         { where: "label versus count", what: "count above the label" },
        { where: "selected wash", what: "covers Call" },
        { where: "list-row padding", what: "<1px padding>" },
      ]),
    );
    expect(diffs.find((d) => d.where === "bounded list well")).toBeUndefined();
  });
});

describe("dropGreyOnGreyNavDiffs (480)", () => {
  test("drops Inbox title / lighter grey than the build", () => {
    expect(dropGreyOnGreyNavDiffs([INBOX_LIGHTER])).toEqual([]);
  });

  test("drops search field / darker tone", () => {
    expect(dropGreyOnGreyNavDiffs([SEARCH_DARKER])).toEqual([]);
  });

  test("keeps Inbox title / grey versus brand", () => {
    expect(dropGreyOnGreyNavDiffs([INBOX_BRAND])).toEqual([INBOX_BRAND]);
  });

  test("keeps list row / taller padding than the mockup", () => {
    expect(dropGreyOnGreyNavDiffs([LIST_PAD])).toEqual([LIST_PAD]);
  });

  test("keeps trailing phone icon / grey versus success", () => {
    expect(dropGreyOnGreyNavDiffs([PHONE_SUCCESS])).toEqual([PHONE_SUCCESS]);
  });
});

describe("dropCrossSlotWalkDiffs (480)", () => {
  test("drops tab baseline that is actually a colour claim", () => {
    expect(
      dropCrossSlotWalkDiffs([{ where: "label versus count", what: "grey versus success" }]),
    ).toEqual([]);
  });

  test("keeps tab baseline that is alignment", () => {
    const hit: CompareDiff = { where: "label versus count", what: "count above the label" };
    expect(dropCrossSlotWalkDiffs([hit])).toEqual([hit]);
  });

  test("drops icon tone that is actually a baseline claim", () => {
    expect(
      dropCrossSlotWalkDiffs([{ where: "chrome icon", what: "count above the baseline" }]),
    ).toEqual([]);
  });

  test("keeps icon tone success versus red", () => {
    const hit: CompareDiff = { where: "chrome icon", what: "success versus red" };
    expect(dropCrossSlotWalkDiffs([hit])).toEqual([hit]);
  });
});

describe("dropGreyOnGreyNavDiffs extras (480)", () => {
  test("keeps Inbox title appeared/disappeared", () => {
    const gone: CompareDiff = { where: "Inbox title", what: "disappeared" };
    const shown: CompareDiff = { where: "Inbox title", what: "appeared" };
    expect(dropGreyOnGreyNavDiffs([gone, shown])).toEqual([gone, shown]);
  });
});

describe("runVisionCompare grey-on-grey drop (480)", () => {
  const engine = (spawn: SpawnProc) => ({ bin: process.execPath, spawn });

  test("Inbox title lighter grey is dropped so --as design ok", async () => {
    const spawn = recordSpawn(
      fakeProc("WHERE Inbox title\nWHAT lighter grey than the build"),
      fakeProc("Inbox\nSearch"),
      fakeProc("Inbox\nSearch"),
    );
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], as: "design" });
    const res = await runVisionCompare(plan, engine(spawn));
    expect(res.exit).toBe(0);
    expect(res.json.ok).toBe(true);
    expect(res.json.pairs[0]!.diffs).toEqual([]);
  });

  test("list-row padding survives the drop", async () => {
    const spawn = recordSpawn(
      fakeProc("WHERE list row\nWHAT taller padding than the mockup"),
      fakeProc("Inbox\nSearch"),
      fakeProc("Inbox\nSearch"),
    );
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], as: "design" });
    const res = await runVisionCompare(plan, engine(spawn));
    expect(res.exit).toBe(1);
    expect(res.json.pairs[0]!.diffs).toEqual([LIST_PAD]);
  });
});
