// OB-2004 -- reference documents on Postgres: a reference is outside the queue, and an edit keeps the
// previous text as a version that a history read returns. Follows pg-items-337 (the ob 325 harness: a local
// cluster on a unix socket, no network, no live database).
import { describe, expect, test } from "bun:test";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { appendNote, createItem, editItem, queryItems, referenceVersions } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { setTodayRank } from "../../../apps/cli/src/workflow.ts";
import { openItemsFor } from "../../../apps/cli/src/commands/status.ts";
import { docCreate, docList, docRead, docSet } from "../../../apps/cli/src/commands/doc.ts";
import { getItem } from "../../../apps/cli/src/items.ts";

describe("reference documents on Postgres (OB-2004)", () => {
  test(
    "absent from queryItems({open}) and openItemsFor; an edit then a history read returns the previous body",
    async () => {
      const lease = await leaseRealPgDb();
      const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
      try {
        await registerProject(store, { name: "personal", kind: "home" });
        const doc = await docCreate(store, { title: "Bumble profile", project: "personal", body: "original text\n" });
        const task = await createItem(store, { type: "task", title: "a real task" });
        await setTodayRank(store, doc.id, 1);
        await setTodayRank(store, task, 2);

        const open = await queryItems(store, { open: true });
        expect(open.map((r) => r.id)).toContain(task);
        expect(open.map((r) => r.id)).not.toContain(doc.id);
        const all = await queryItems(store, { type: "reference" });
        expect(all.map((r) => r.id)).toEqual([doc.id]);

        const inStatus = await openItemsFor(store);
        expect(inStatus.map((r) => r.id)).toContain(task);
        expect(inStatus.map((r) => r.id)).not.toContain(doc.id);

        // edit, then read the history back
        await docSet(store, (await getItem(store, doc.id))!, { body: "second text" });
        const versions = await referenceVersions(store, doc.id);
        expect(versions).toHaveLength(1);
        expect(versions[0]!.body).toBe("original text\n");
        expect(versions[0]!.title).toBe("Bumble profile");

        await editItem(store, doc.id, { title: "Bumble v2" });
        await appendNote(store, doc.id, "note");
        const read = await docRead(store, (await getItem(store, doc.id))!);
        expect(read.versions.map((v) => v.n)).toEqual([1, 2, 3]);
        expect(read.versions[0]!.body).toBe("original text\n");
        expect((await docList(store, "personal")).map((r) => r.id)).toEqual([doc.id]);
      } finally {
        await store.close?.();
      }
    },
    spawnBudget(3),
  );

  test(
    "two edits at once keep two distinct versions, and two notes at once keep both notes",
    async () => {
      const lease = await leaseRealPgDb();
      const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
      try {
        await registerProject(store, { name: "personal", kind: "home" });
        const doc = await docCreate(store, { title: "Race", project: "personal", body: "P0" });
        const row = (await getItem(store, doc.id))!;
        await Promise.all([docSet(store, row, { body: "P1" }), docSet(store, row, { body: "P2" })]);
        const bodies = (await referenceVersions(store, doc.id)).map((v) => v.body);
        expect(bodies).toHaveLength(2);
        expect(bodies).toContain("P0");
        expect(bodies.includes("P1") || bodies.includes("P2")).toBe(true);

        await Promise.all([appendNote(store, doc.id, "note A"), appendNote(store, doc.id, "note B")]);
        const body = (await getItem(store, doc.id))!.body ?? "";
        expect(body).toContain("note A");
        expect(body).toContain("note B");
      } finally {
        await store.close?.();
      }
    },
    spawnBudget(3),
  );
});
