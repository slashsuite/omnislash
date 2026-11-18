// OB-2167: a project whose tests lease a Postgres test database must preload test/pg/warm.ts (OB-2021).
//
// Without it the first pg test of the run builds the cluster (initdb, the postmaster boot, the schema chain)
// inside its own budget. Measured at load ~70: cli-sources' first calendar test hit its 15 s timeout during
// that build, bun's runner SIGTERMed every child it had spawned ("killed 1 dangling process"), the postmaster
// among them ("received smart shutdown request"), and every later pg test in the run met a cluster that was
// shutting down: 2 of 210 looped runs failed that way, each taking ten minutes. cli-sources and cli-whatsapp
// had pg tests and no warm preload.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const LEASES_PG = /from "[./]*(?:apps\/cli\/test\/|test\/|\.\/)?pg\/(?:store|real-schema|harness|cluster)\.ts"/;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

describe("the pg warm preload (OB-2167)", () => {
  test("every moon project with a pg-leasing test file preloads test/pg/warm.ts", () => {
    const workspace = Bun.YAML.parse(readFileSync(join(REPO, ".moon/workspace.yml"), "utf8")) as { projects: Record<string, string> };
    const missing: string[] = [];
    let leasing = 0;
    for (const [name, root] of Object.entries(workspace.projects)) {
      const dir = join(REPO, root);
      const files = testFiles(dir).filter((f) => LEASES_PG.test(readFileSync(f, "utf8")));
      if (files.length === 0) continue;
      leasing++;
      const bunfig = join(dir, "bunfig.toml");
      const preload = existsSync(bunfig) ? (Bun.TOML.parse(readFileSync(bunfig, "utf8")) as { test?: { preload?: string[] } }).test?.preload : undefined;
      if (!preload?.some((p) => p.endsWith("test/pg/warm.ts"))) missing.push(`${name} (${files.length} pg test files)`);
    }
    expect(missing).toEqual([]);
    expect(leasing).toBeGreaterThan(0);
  });
});
