// OB-1929: tracker edges. `project rm` and the drift report read "closed" per item type, `ob add --link` and
// the API create refuse an issue another item already holds, `project rm` clears a stale focus. Fixture
// stores, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { attachLinear, createItem, getItem } from "../../../apps/cli/src/items.ts";
import { getConfig, setConfig } from "../../../apps/cli/src/config.ts";
import { getProject, registerProject, removeProject } from "../../../apps/cli/src/project.ts";
import { ApiFault } from "../../../apps/cli/src/api/fault.ts";
import * as h from "../../../apps/cli/src/api/handlers.ts";
import {
  __setSh,
  computeDrift,
  issueUrl,
  linkedItems,
  type Sh,
} from "../../../apps/cli/src/tracker-link.ts";
import type { GithubIssue } from "../../../apps/cli/src/wayfinder.ts";

const REPO = "owner/acme";

describe("project rm (OB-1929)", () => {
  test("closed items of every kind do not block the removal", async () => {
    const db = freshDb();
    await registerProject(db, { name: "alpha", kind: "side" });
    await createItem(db, { type: "roadmap", title: "R", projectId: "alpha", status: "archived" });
    await createItem(db, { type: "decision", title: "D", projectId: "alpha", status: "accepted" });
    await createItem(db, { type: "decision", title: "D2", projectId: "alpha", status: "superseded" });
    const res = await removeProject(db, "alpha");
    expect(res.removed).toBe(true);
    expect(await getProject(db, "alpha")).toBeNull();
  });

  test("an in-progress task still blocks it", async () => {
    const db = freshDb();
    await registerProject(db, { name: "alpha", kind: "side" });
    await createItem(db, { type: "task", title: "T", projectId: "alpha", status: "in_progress" });
    const r1 = await removeProject(db, "alpha");
    expect(r1).toMatchObject({ removed: false, reason: "open_items", open: 1 });
  });

  test("removing the focused project unsets focus; removing another leaves it", async () => {
    const db = freshDb();
    await registerProject(db, { name: "alpha", kind: "side" });
    await registerProject(db, { name: "beta", kind: "side" });
    await setConfig(db, "focus_project", "alpha");
    await removeProject(db, "beta");
    expect(await getConfig(db, "focus_project")).toBe("alpha");
    await removeProject(db, "alpha");
    expect(await getConfig(db, "focus_project")).toBeNull();
  });
});

describe("issue drift reads closed per type (OB-1929)", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
  });

  /** A `git` stub that reads as a repo with an empty history, so no test forks real git. */
  const emptyGit: Sh = (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("rev-parse --show-toplevel")) return { ok: true, err: "", out: "/repo\n" };
    if (joined.includes("config --get remote.origin.url")) return { ok: true, err: "", out: `git@github.com:${REPO}.git\n` };
    if (joined.includes("rev-list --count")) return { ok: true, err: "", out: "0" };
    return { ok: true, err: "", out: "" };
  };

  const closedIssue = (n: number): GithubIssue => ({
    number: n,
    title: `issue ${n}`,
    state: "CLOSED",
    assignees: [],
    labels: ["wayfinder:task"],
    body: null,
    url: issueUrl(REPO, n),
  });

  test("a closed issue on an accepted decision is not drift; on an in_progress task it is", async () => {
    const store = asStore(freshDb());
    restores.push(__setSh(emptyGit));
    const dec = await createItem(store, { type: "decision", title: "D", status: "accepted" });
    const task = await createItem(store, { type: "task", title: "T", status: "in_progress" });
    await attachLinear(store, dec, issueUrl(REPO, 1));
    await attachLinear(store, task, issueUrl(REPO, 3));
    const rows = await computeDrift({
      checkout: "/repo",
      trackerRepo: REPO,
      issues: [closedIssue(1), closedIssue(3)],
      store,
      links: await linkedItems(store),
    });
    expect(rows.map((r) => [r.kind, r.issue])).toEqual([["issue-closed-but-item-open", 3]]);
  });
});

describe("one issue, one item on add (OB-1929)", () => {
  const url = issueUrl(REPO, 77);

  test("`ob add --link` of an issue another item holds is refused and creates nothing", async () => {
    const dbPath = freshDbPath();
    const first = await runCli(dbPath, ["add", "first", "--repo", "acme", "--kind", "side", "--link", url, "--json"]);
    expect(first.code).toBe(0);
    const firstId = (JSON.parse(first.out) as { id: string }).id;

    const second = await runCli(dbPath, ["add", "second", "--repo", "acme", "--kind", "side", "--link", url, "--json"]);
    expect(second.code).not.toBe(0);
    expect(second.err).toContain(`issue #77 is already linked to ob ${firstId} ('first')`);
    expect(second.err).toContain(`ob issue unlink ${firstId}`);

    const list = JSON.parse((await runCli(dbPath, ["list", "--json"])).out) as Array<{ title: string }>;
    expect(list.map((i) => i.title)).toEqual(["first"]);
  });

  test("the API create answers 409 with the same message, and a fresh URL links", async () => {
    const store = asStore(freshDb());
    await registerProject(store, { name: "acme", kind: "side" });
    const input = (title: string, link_url: string) => ({
      type: "task",
      title,
      project: "acme",
      link_url,
      priorityValue: null,
    });
    const first = await h.create(store, input("first", url) as never);
    let fault: unknown;
    try {
      await h.create(store, input("second", url) as never);
    } catch (e) {
      fault = e;
    }
    expect(fault).toBeInstanceOf(ApiFault);
    expect((fault as ApiFault).status).toBe(409);
    expect((fault as ApiFault).message).toContain(`issue #77 is already linked to ob ${first.id} ('first')`);

    const fresh = await h.create(store, input("third", issueUrl(REPO, 79)) as never);
    expect((await getItem(store, fresh.id))?.title).toBe("third");
  });
});

