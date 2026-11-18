// ob 337 pass 2 — config.ts, project.ts and tracker-link.ts, run against BOTH engines and compared.
//
// Companion to pg-items-337.test.ts, and for the same reason: every failure mode this phase risks is
// SILENT. A config row that comes back undefined instead of null, a project list that orders NULLs to
// the other end, a link row read through a join that resolves on one engine and not the other -- none of
// those throw, so "it did not throw on Postgres" proves nothing. Only running the same sequence on both
// engines and diffing the RESULTS does.
//
// The sequence is what the newly servable commands actually do: `ob config`, `ob focus`, `ob project`,
// and the link half of `ob show` / `ob close` (`ob issue link` / `ob issue unlink`).
//
// It uses the ob 325 harness, so the Postgres side is a real local cluster over a unix socket: no
// network, no live database, nothing to configure.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { allConfig, deleteConfig, getConfig, getFocusProject, setConfig } from "../../../apps/cli/src/config.ts";
import { getProject, listProjects, registerProject } from "../../../apps/cli/src/project.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import {
  clearRef,
  getIssueLink,
  getLinearOnlyRef,
  itemForIssue,
  linkIssue,
  linkedItems,
  trackerRepo,
} from "../../../apps/cli/src/tracker-link.ts";
import { settingFor, settingNumFor } from "../../../apps/cli/src/settings.ts";

const PG_BUDGET = spawnBudget(3);

async function exercise(store: Store): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // --- `ob config` ---------------------------------------------------------------------------------
  out.missingConfig = await getConfig(store, "never_set");
  await setConfig(store, "focus_project", "acme");
  await setConfig(store, "wayfinder_repo", "owner/acme");
  // The upsert path: the same key written twice must UPDATE, not raise a unique violation and not
  // duplicate. `excluded.value` is the shared spelling, so this is the assertion that it is shared.
  await setConfig(store, "focus_project", "side-app");
  await setConfig(store, "focus_project", "acme");
  out.focus = await getFocusProject(store);
  out.focusType = typeof (await getFocusProject(store));
  await setConfig(store, "zzz_last", "z");
  await setConfig(store, "aaa_first", "a");
  out.allKeys = (await allConfig(store)).map((r) => r.key);
  await deleteConfig(store, "zzz_last");
  out.afterDelete = (await allConfig(store)).map((r) => r.key);
  out.deletedIsNull = await getConfig(store, "zzz_last");

  // --- settings precedence (row, then DEFAULTS, then "") -------------------------------------------
  out.settingFromRow = await settingFor(store, "wayfinder_repo");
  out.settingFromDefault = await settingFor(store, "branch_age_days");
  out.settingNum = await settingNumFor(store, "branch_age_days");
  out.settingNumType = typeof (await settingNumFor(store, "branch_age_days"));
  out.settingAbsent = await settingFor(store, "never_set");

  // --- `ob project` --------------------------------------------------------------------------------
  out.missingProject = await getProject(store, "nope");
  const acme = await registerProject(store, { name: "acme", kind: "side" });
  const sideApp = await registerProject(store, { name: "Side App", kind: "side", remote: null });
  const chores = await registerProject(store, { name: "chores", kind: "home" });
  out.projectIds = [acme.id, sideApp.id, chores.id];
  // Idempotent: registering the same name again returns the existing row rather than inserting a second.
  const again = await registerProject(store, { name: "acme", kind: "home" });
  out.reregisteredId = again.id;
  out.reregisteredKind = again.kind;
  // Ordered by kind then name, and `git_remote` is nullable, which is the column most likely to sort to
  // the opposite end on Postgres.
  out.projectOrder = (await listProjects(store)).map((p) => `${p.kind}:${p.id}:${p.git_remote ?? "-"}`);
  out.byName = (await getProject(store, "Side App"))?.id ?? null;
  out.byId = (await getProject(store, "side-app"))?.id ?? null;

  // --- the link half of `ob show` / `ob close` -----------------------------------------------------
  const linked = await createItem(store, { type: "task", title: "an issue-paired task" });
  const bare = await createItem(store, { type: "task", title: "no reference at all" });
  out.noLinkYet = await getIssueLink(store, linked);
  const link = await linkIssue(store, linked, { repo: "owner/acme", number: 77 });
  out.linkedNumber = link.number;
  out.readBack = (await getIssueLink(store, linked))?.number ?? null;
  out.readBackUrl = (await getIssueLink(store, linked))?.url ?? null;
  // A GitHub URL is not a Linear reference, and the two share one row: the discriminator has to survive
  // the round trip on both engines.
  out.linearOnly = await getLinearOnlyRef(store, linked);
  out.bareHasNoLink = await getIssueLink(store, bare);
  out.trackerRepo = await trackerRepo(store);
  out.linkedList = (await linkedItems(store)).map((l) => `${l.item_id}:${l.ref.number}:${l.status}`);
  out.foundByIssue =
    (await itemForIssue(store, { repo: "owner/acme", number: 77 }))?.item_id ?? null;
  out.notFoundByIssue = await itemForIssue(store, { repo: "owner/acme", number: 999 });
  // Re-linking is idempotent (the row is rewritten, not duplicated).
  await linkIssue(store, linked, { repo: "owner/acme", number: 78 });
  out.afterRelink = (await linkedItems(store)).map((l) => `${l.item_id}:${l.ref.number}`);
  const cleared = await clearRef(store, linked);
  out.clearedKind = cleared?.kind ?? null;
  out.clearedIssue = cleared && cleared.kind === "issue" ? cleared.issue : null;
  out.afterClear = await getIssueLink(store, linked);
  out.clearAgain = await clearRef(store, linked);
  out.linkedListAfterClear = (await linkedItems(store)).map((l) => l.item_id);

  return out;
}

describe("config, project and the tracker link agree across the two engines (337)", () => {
  test(
    "the newly servable commands' data paths produce identical results on Postgres and on SQLite",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337b-"));
      const previousCreate = process.env.OMNISLASH_DB_CREATE;
      process.env.OMNISLASH_DB_CREATE = "1";
      let pg: Store | undefined;
      let sqlite: Store | undefined;
      try {
        pg = await openStore({
          kind: "postgres",
          connection: lease.options as unknown as Record<string, unknown>,
        });
        sqlite = await openStore({ kind: "sqlite", path: join(dir, "omnislash.sqlite"), create: true });

        expect(pg.kind).toBe("postgres");
        expect(sqlite.kind).toBe("sqlite");

        const fromPg = await exercise(pg);
        const fromSqlite = await exercise(sqlite);

        for (const key of Object.keys(fromSqlite)) {
          expect({ [key]: fromPg[key] }).toEqual({ [key]: fromSqlite[key] });
        }

        // Absolute anchors, so a bug that broke BOTH engines identically still fails here.
        expect(fromSqlite.missingConfig).toBeNull();
        expect(fromSqlite.focus).toBe("acme");
        expect(fromSqlite.focusType).toBe("string");
        expect(fromSqlite.allKeys).toEqual([
          "aaa_first",
          "focus_project",
          "wayfinder_repo",
          "zzz_last",
        ]);
        expect(fromSqlite.afterDelete).toEqual(["aaa_first", "focus_project", "wayfinder_repo"]);
        expect(fromSqlite.deletedIsNull).toBeNull();
        expect(fromSqlite.settingFromRow).toBe("owner/acme");
        expect(fromSqlite.settingFromDefault).toBe("3");
        expect(fromSqlite.settingNum).toBe(3);
        expect(fromSqlite.settingNumType).toBe("number");
        expect(fromSqlite.settingAbsent).toBe("");
        expect(fromSqlite.missingProject).toBeNull();
        expect(fromSqlite.projectIds).toEqual(["acme", "side-app", "chores"]);
        expect(fromSqlite.reregisteredId).toBe("acme");
        expect(fromSqlite.reregisteredKind).toBe("side");
        expect(fromSqlite.projectOrder).toEqual([
          "home:chores:-",
          "side:side-app:-",
          "side:acme:-",
        ]);
        expect(fromSqlite.byName).toBe("side-app");
        expect(fromSqlite.byId).toBe("side-app");
        expect(fromSqlite.noLinkYet).toBeNull();
        expect(fromSqlite.linkedNumber).toBe(77);
        expect(fromSqlite.readBack).toBe(77);
        expect(fromSqlite.readBackUrl).toBe("https://github.com/owner/acme/issues/77");
        expect(fromSqlite.linearOnly).toBeNull();
        expect(fromSqlite.bareHasNoLink).toBeNull();
        expect(fromSqlite.trackerRepo).toBe("owner/acme");
        expect(fromSqlite.linkedList).toEqual(["1:77:open"]);
        expect(fromSqlite.foundByIssue).toBe("1");
        expect(fromSqlite.notFoundByIssue).toBeNull();
        expect(fromSqlite.afterRelink).toEqual(["1:78"]);
        expect(fromSqlite.clearedKind).toBe("issue");
        expect(fromSqlite.clearedIssue).toBe(78);
        expect(fromSqlite.afterClear).toBeNull();
        expect(fromSqlite.clearAgain).toBeNull();
        expect(fromSqlite.linkedListAfterClear).toEqual([]);
      } finally {
        await pg?.close();
        await sqlite?.close();
        await lease.release();
        rmSync(dir, { recursive: true, force: true });
        if (previousCreate === undefined) delete process.env.OMNISLASH_DB_CREATE;
        else process.env.OMNISLASH_DB_CREATE = previousCreate;
      }
    },
    PG_BUDGET,
  );
});
