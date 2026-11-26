// Every dependency two workspace packages share resolves to one version (OS-209): each of them names it
// `catalog:` (or `catalog:<name>`), and the version lives once, in the root package.json's catalogs. A `catalog:`
// naming no entry is refused by `bun install` itself.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

type Manifest = {
  name?: string;
  workspaces?: { packages: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const read = (path: string): Manifest => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Manifest;
const root = read("package.json");

function manifests(): string[] {
  const paths = ["package.json"];
  for (const pattern of root.workspaces?.packages ?? []) {
    for (const path of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: ROOT })) paths.push(path);
  }
  return paths;
}

function deps(manifest: Manifest): [string, string][] {
  return [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].flatMap((section) => Object.entries(section ?? {}));
}

test("a dependency used by two or more workspace packages comes from the root catalog", () => {
  const users = new Map<string, string[]>();
  for (const path of manifests()) {
    for (const [name, spec] of deps(read(path))) {
      if (spec.startsWith("workspace:")) continue;
      users.set(name, [...(users.get(name) ?? []), `${path} ${spec}`]);
    }
  }
  const offCatalog = [...users].filter(([, uses]) => uses.length > 1).flatMap(([name, uses]) => uses.filter((use) => !use.split(" ")[1]?.startsWith("catalog:")).map((use) => `${name}: ${use}`));
  expect(offCatalog).toEqual([]);
});
