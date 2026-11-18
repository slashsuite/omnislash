import { describe, expect, test } from "bun:test";
import { freshDb, freshDbPath, runCli, fakeRepoDir } from "../../../apps/cli/test/helpers.ts";
import { recordEvent } from "../../../apps/cli/src/events.ts";
import { inFlightPrs } from "../../../apps/cli/src/commands/status.ts";
import { openDb, nowIso } from "../../../apps/cli/src/db.ts";

function prSynced(db: ReturnType<typeof freshDb>, ts: string, payload: Record<string, unknown>) {
  recordEvent(db, { ts, source: "github", type: "pr_synced", payload });
}
function comment(db: ReturnType<typeof freshDb>, pr: string, afterReady: number, bot: number, tag: string) {
  db.query(
    `INSERT INTO pr_comment(id, pr, repo, author, kind, state, body, after_ready, bot, created_at)
     VALUES(?, ?, 'o/r', 'rev', 'review', 'COMMENTED', 'x', ?, ?, '2026-07-16T00:00:00Z')`,
  ).run(`${pr}-${tag}`, pr, afterReady, bot);
}

describe("inFlightPrs derivation", () => {
  test("classifies authoring / waiting-review / addressing-comments; excludes merged", () => {
    const db = freshDb();
    prSynced(db, "2026-07-10T00:00:00Z", { pr: "o/r#1", title: "draft one", is_draft: true });
    prSynced(db, "2026-07-11T00:00:00Z", { pr: "o/r#2", title: "waiting", is_draft: false });
    prSynced(db, "2026-07-12T00:00:00Z", { pr: "o/r#3", title: "addressing", is_draft: false });
    comment(db, "o/r#3", 1, 0, "human"); // after-ready human → addressing
    comment(db, "o/r#2", 1, 1, "bot"); // bot must not flip #2
    comment(db, "o/r#2", 0, 0, "pre"); // pre-ready must not flip #2
    prSynced(db, "2026-07-13T00:00:00Z", { pr: "o/r#4", title: "merged", is_draft: false, merged_at: "2026-07-14T00:00:00Z" });

    const byPr = Object.fromEntries(inFlightPrs(db).map((p) => [p.pr, p.state]));
    expect(byPr["o/r#1"]).toBe("authoring");
    expect(byPr["o/r#2"]).toBe("waiting-review");
    expect(byPr["o/r#3"]).toBe("addressing-comments");
    expect(byPr["o/r#4"]).toBeUndefined();
  });

  test("latest pr_synced per PR wins (open then merged → excluded)", () => {
    const db = freshDb();
    prSynced(db, "2026-07-10T00:00:00Z", { pr: "o/r#9", title: "x", is_draft: false });
    prSynced(db, "2026-07-10T00:00:00Z", { pr: "o/r#9", title: "x", is_draft: false, merged_at: "2026-07-15T00:00:00Z" });
    expect(inFlightPrs(db).find((p) => p.pr === "o/r#9")).toBeUndefined();
  });
});

describe("CLI: ob status", () => {
  test("--json carries all five sections", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["agent", "register", "--id", "w1", "--ticket", "CUE-1", "--status", "working"]);
    const blk = await runCli(dbPath, ["add", "blocked thing", "--project", "acme", "-q"]);
    await runCli(dbPath, ["block", blk.out.trim(), "--reason", "waiting on infra", "--owner", "ops"]);
    const foc = await runCli(dbPath, ["add", "focus thing", "--project", "acme", "-q"]);
    await runCli(dbPath, ["today", foc.out.trim(), "--rank", "1"]);
    await runCli(dbPath, ["log", "kudos", "nice one", "--about", "someone"]);

    const res = await runCli(dbPath, ["status", "--json"]);
    expect(res.code).toBe(0);
    const s = JSON.parse(res.out);
    expect(s.agents).toHaveLength(1);
    expect(s.blocked[0]).toMatchObject({ block_reason: "waiting on infra", block_owner: "ops" });
    expect(s.focus).toHaveLength(1);
    expect(s.journal[0]).toMatchObject({ type: "kudos", text: "nice one" });
    expect(s.in_flight_prs).toHaveProperty("waiting-review");
    expect(s.live_deploy).toBeNull();
  });

  test("empty status is clean (exit 0)", async () => {
    const dbPath = freshDbPath();
    const res = await runCli(dbPath, ["status"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Status — what's happening now");
  });

  // 1189: `manual-review` is a RETIRED word — unwritable, but old rows hold it and `ob status` still reads
  // it into the "needs review" section, alongside the LIVE word that replaced it (`needs-human`). The
  // retired row is seeded the way an old binary would have left it.
  test("the 'needs review' section reads a retired `manual-review` row AND a live `needs-human` one (058/1189)", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["agent", "register", "--id", "worker", "--ticket", "CUE-1", "--status", "working"]);
    await runCli(dbPath, ["agent", "register", "--id", "parked", "--branch", "parked", "--status", "needs-human", "--note", "which wording?"]);
    const db = openDb(dbPath);
    const now = nowIso();
    db.query(
      "INSERT INTO agent(id, ticket, branch, status, note, started_at, heartbeat_at, ttl_s) VALUES('cue-9893', NULL, 'cue-9893', 'manual-review', 'unsure on pagination', ?, ?, 900)",
    ).run(now, now);
    db.close();

    const s = JSON.parse((await runCli(dbPath, ["status", "--json"])).out);
    expect(s.needs_review.map((a: { id: string }) => a.id).sort()).toEqual(["cue-9893", "parked"]);
    expect(s.agents).toHaveLength(3); // agents keeps the full set for the JSON contract

    const human = (await runCli(dbPath, ["status"])).out;
    expect(human).toContain("Needs review");
    expect(human).toContain("unsure on pagination");
    expect(human).toContain("which wording?");
    // neither parked agent is lumped into the working-agents list
    const agentsSection = human.slice(human.indexOf("\nAgents"));
    expect(agentsSection).not.toContain("cue-9893");
    expect(agentsSection).not.toContain("parked");
  });

  test("Recently completed spinoffs surface in status (#36) — text section + --json", async () => {
    const dbPath = freshDbPath();
    // OB-2130: `queue`, the enqueue-only form: a launching dispatch with no T3 project is now refused before the row exists
    await runCli(dbPath, ["spinoff", "queue", "36", "--repo", fakeRepoDir(), "--branch", "36-done", "--brief", "x", "--no-check", "a test fixture", "-q"]);
    const db = openDb(dbPath);
    db.query("UPDATE spinoff SET status = 'merged' WHERE ticket_ref = '36'").run();
    db.close();

    const s = JSON.parse((await runCli(dbPath, ["status", "--json"])).out);
    expect(s.completed_spinoffs).toHaveLength(1);
    expect(s.completed_spinoffs[0]).toMatchObject({ ticket: "36", branch: "36-done" });

    const human = (await runCli(dbPath, ["status"])).out;
    expect(human).toContain("Recently completed spinoffs");
    expect(human).toContain("36-done");
  });

  test("live deploy is quiet when ok or unrecorded, and surfaces when not ok (636)", async () => {
    const dbPath = freshDbPath();
    const empty = JSON.parse((await runCli(dbPath, ["status", "--json"])).out);
    expect(empty.live_deploy).toBeNull();
    expect((await runCli(dbPath, ["status"])).out).not.toContain("Live deploy");

    await runCli(dbPath, [
      "deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service",
      "--sha", "320207e9a1b2c3d4e5f60718293a4b5c6d7e8f901", "--result", "ok", "--at", "2026-09-03T12:00:00.000Z",
    ]);
    const ok = JSON.parse((await runCli(dbPath, ["status", "--json"])).out);
    expect(ok.live_deploy).toBeNull();
    expect((await runCli(dbPath, ["status"])).out).not.toContain("Live deploy");

    await runCli(dbPath, [
      "deploy", "record", "--target", "web-dev", "--host", "ob-host", "--unit", "omnislash-web-dev.service",
      "--sha", "0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb", "--result", "refused",
    ]);
    expect(JSON.parse((await runCli(dbPath, ["status", "--json"])).out).live_deploy).toBeNull();

    await runCli(dbPath, [
      "deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service",
      "--sha", "0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb", "--result", "rolled-back", "--at", "2026-09-03T13:00:00.000Z",
    ]);
    const s = JSON.parse((await runCli(dbPath, ["status", "--json"])).out);
    expect(s.live_deploy).toMatchObject({
      target: "live",
      host: "api-host",
      unit: "omnislash-web.service",
      sha: "0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb",
      result: "rolled-back",
    });
    const human = (await runCli(dbPath, ["status"])).out;
    expect(human).toContain("Live deploy");
    expect(human).toContain("rolled-back");
    expect(human).toContain("0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb");
  });
});
