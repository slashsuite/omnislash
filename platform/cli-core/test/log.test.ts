import { describe, expect, test } from "bun:test";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { logEntry, listJournal, orderJournal, isJournalType } from "../../../apps/cli/src/commands/log.ts";

describe("journal helpers", () => {
  test("isJournalType", () => {
    expect(isJournalType("kudos")).toBe(true);
    expect(isJournalType("blocker")).toBe(false);
  });

  test("logEntry → listJournal roundtrip with about", async () => {
    const db = freshDb();
    await logEntry(db, { type: "kudos", text: "great review", about: "sam-gh", ts: "2026-07-16T09:00:00Z" });
    await logEntry(db, { type: "comment", text: "flaky CI", ts: "2026-07-16T10:00:00Z" });
    const all = await listJournal(db);
    expect(all).toHaveLength(2);
    const kudos = all.find((e) => e.type === "kudos")!;
    expect(kudos.text).toBe("great review");
    expect(kudos.about).toBe("sam-gh");
    expect(all.find((e) => e.type === "comment")!.about).toBeNull();
  });

  test("listJournal filters by type and since window", async () => {
    const db = freshDb();
    await logEntry(db, { type: "kudos", text: "a", ts: "2026-07-15T09:00:00Z" });
    await logEntry(db, { type: "suggestion", text: "b", ts: "2026-07-16T09:00:00Z" });
    expect(await listJournal(db, { type: "kudos" })).toHaveLength(1);
    expect(await listJournal(db, { since: "2026-07-16T00:00:00Z" })).toHaveLength(1);
  });

  test("orderJournal puts kudos first, then suggestion, then comment", async () => {
    const db = freshDb();
    await logEntry(db, { type: "comment", text: "c", ts: "2026-07-16T09:00:00Z" });
    await logEntry(db, { type: "kudos", text: "k", ts: "2026-07-16T09:01:00Z" });
    await logEntry(db, { type: "suggestion", text: "s", ts: "2026-07-16T09:02:00Z" });
    expect(orderJournal(await listJournal(db)).map((e) => e.type)).toEqual(["kudos", "suggestion", "comment"]);
  });
});

describe("CLI: ob log", () => {
  test("capture + list --json", async () => {
    const dbPath = freshDbPath();
    const add = await runCli(dbPath, ["log", "kudos", "great work by the team", "--about", "@sam"]);
    expect(add.code).toBe(0);
    const list = await runCli(dbPath, ["log", "list", "--json"]);
    const entries = JSON.parse(list.out);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "kudos", text: "great work by the team", about: "@sam" });
  });

  test("invalid type is a usage error", async () => {
    const dbPath = freshDbPath();
    const bad = await runCli(dbPath, ["log", "praise", "nope"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("must be one of");
  });

  test("empty list is clean (exit 0)", async () => {
    const dbPath = freshDbPath();
    const list = await runCli(dbPath, ["log", "list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("no journal entries");
  });

  test("--item associates a real tracked item", async () => {
    const dbPath = freshDbPath();
    const add = await runCli(dbPath, ["add", "fix flaky test", "--project", "omnislash", "--json"]);
    const { id, ref } = JSON.parse(add.out) as { id: string; ref: string };
    // The ref (1949) is accepted and stored as the legacy id.
    const log = await runCli(dbPath, ["log", "comment", "still flaky on CI", "--item", ref]);
    expect(log.code).toBe(0);
    const list = await runCli(dbPath, ["log", "list", "--json"]);
    expect(JSON.parse(list.out)[0].itemId).toBe(id);
  });
});
