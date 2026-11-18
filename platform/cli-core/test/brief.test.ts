import { describe, expect, test } from "bun:test";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { recordEvent } from "../../../apps/cli/src/events.ts";

function prSynced(db: ReturnType<typeof openDb>, ts: string, payload: Record<string, unknown>) {
  recordEvent(db, { ts, source: "github", type: "pr_synced", payload });
}

describe("CLI: ob brief (138 Part A)", () => {
  test("brief <id> — item title/status + a recent event", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const id = await createItem(db, {
      type: "linear_ref",
      title: "Voice transcript pipeline",
      status: "in_progress",
      linkUrl: "https://linear.app/cue/issue/CUE-9893/voice-transcript",
    });
    // a recent Linear state transition for the ticket
    recordEvent(db, {
      ts: "2026-07-12T09:00:00Z",
      source: "linear",
      type: "state_change",
      payload: { entity: "CUE-9893", from: "Todo", to: "In Progress" },
    });

    const human = await runCli(dbPath, ["brief", id]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Voice transcript pipeline");
    expect(human.out).toContain("in_progress");
    expect(human.out).toContain("In Progress"); // the recent state_change

    // resolvable by the Linear ref too
    const byRef = await runCli(dbPath, ["brief", "CUE-9893"]);
    expect(byRef.code).toBe(0);
    expect(byRef.out).toContain("Voice transcript pipeline");
  });

  test("brief <id> --json is stable + parseable", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const id = await createItem(db, {
      type: "linear_ref",
      title: "Voice transcript pipeline",
      status: "in_progress",
      linkUrl: "https://linear.app/cue/issue/CUE-9893/voice-transcript",
    });
    recordEvent(db, { ts: "2026-07-12T09:00:00Z", source: "linear", type: "state_change", payload: { entity: "CUE-9893", from: "Todo", to: "In Progress" } });

    const res = await runCli(dbPath, ["brief", id, "--json"]);
    expect(res.code).toBe(0);
    const b = JSON.parse(res.out);
    expect(b.form).toBe("item");
    expect(b.item).toMatchObject({ id, title: "Voice transcript pipeline", status: "in_progress" });
    expect(b.linear.linear_id).toBe("CUE-9893");
    expect(b.ticket).toBe("CUE-9893");
    expect(b.events.map((e: { type: string }) => e.type)).toContain("state_change");
  });

  test("brief --in-flight — open PRs by state + open items", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    await createItem(db, { type: "task", title: "open thing", status: "in_progress" });
    prSynced(db, "2026-07-11T00:00:00Z", { pr: "o/app#42", title: "ready one", is_draft: false });
    prSynced(db, "2026-07-12T00:00:00Z", { pr: "o/tools#7", title: "draft one", is_draft: true });

    const human = await runCli(dbPath, ["brief", "--in-flight"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("[waiting-review] o/app#42");
    expect(human.out).toContain("[authoring] o/tools#7");
    expect(human.out).toContain("open thing [in_progress]");

    const b = JSON.parse((await runCli(dbPath, ["brief", "--in-flight", "--json"])).out);
    expect(b.form).toBe("in-flight");
    expect(b.prs["waiting-review"][0].pr).toBe("o/app#42");
    expect(b.prs.authoring[0].pr).toBe("o/tools#7");
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ title: "open thing", status: "in_progress" });
  });

  test("brief with no arg is a usage error; unknown ref is exit 1", async () => {
    const dbPath = freshDbPath();
    expect((await runCli(dbPath, ["brief"])).code).toBe(2);
    expect((await runCli(dbPath, ["brief", "NOPE-1"])).code).toBe(1);
  });
});
