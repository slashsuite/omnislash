import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "../../..");
const SKIP = new Set(["node_modules", ".git", "dist", ".out", "coverage"]);

function walk(dir: string, pred: (name: string) => boolean, acc: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pred, acc);
    else if (pred(ent.name)) acc.push(p);
  }
  return acc;
}

function posixRel(abs: string): string {
  return relative(REPO, abs).split("\\").join("/");
}

function isCliTestTree(rel: string): boolean {
  return rel.startsWith("apps/cli/") || /^platform\/cli-[^/]+\//.test(rel);
}

describe("CLI test-file ownership (ob 573)", () => {
  test("every CLI *.test.ts lives in a moon project that has a test task", () => {
    // moon runs only the projects .moon/workspace.yml lists, so a moon.yml outside it owns nothing.
    const workspace = Bun.YAML.parse(readFileSync(join(REPO, ".moon/workspace.yml"), "utf8")) as {
      projects: Record<string, string>;
    };
    const projects: { name: string; root: string }[] = [];
    for (const [name, root] of Object.entries(workspace.projects)) {
      const file = join(REPO, root, "moon.yml");
      if (!existsSync(file)) continue;
      const raw = Bun.YAML.parse(readFileSync(file, "utf8")) as { tasks?: Record<string, unknown> } | null;
      if (raw?.tasks && "test" in raw.tasks) projects.push({ name, root });
    }
    projects.sort((a, b) => b.root.length - a.root.length);

    const orphans: string[] = [];
    for (const abs of walk(REPO, (n) => n.endsWith(".test.ts"))) {
      const rel = posixRel(abs);
      if (!isCliTestTree(rel)) continue;
      const owner = projects.find((p) => rel === p.root || rel.startsWith(`${p.root}/`));
      if (!owner) orphans.push(rel);
    }

    expect(
      orphans,
      orphans.length
        ? `These CLI test files sit in no moon project (listed in .moon/workspace.yml) with a test task: ${orphans.join(", ")}. Put them in a shard (platform/cli-*) or on cli.`
        : "",
    ).toEqual([]);
  });
});
