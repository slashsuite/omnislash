// Every tracked .ts/.tsx file is typechecked under the one strict base (OS-209): each project tsconfig
// extends tsconfig.base.json, and together their programs hold every TypeScript file git tracks.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// tsconfigs that are not projects of this repo: the one the new-project template carries into the project made
// from it (it already holds the strict flags), and the lint fixture's single-file program.
const NOT_PROJECTS = new Set(["skills/ob-new-project/template/tsconfig.json", "apps/cli/test/fixtures/tsconfig.lint.json"]);

function git(args: string[]): string[] {
  const out = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
  return out.stdout.toString().split("\n").filter((line) => line !== "");
}

const projectConfigs = git(["ls-files", "--cached", "--others", "--exclude-standard", "*tsconfig.json", "*tsconfig.*.json"]).filter(
  (path) => path !== "tsconfig.base.json" && !NOT_PROJECTS.has(path),
);

/** tsconfig files may hold comments; drop full-line `//` comments before parsing. */
function readConfig(path: string): { extends?: string } {
  const text = readFileSync(join(ROOT, path), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(text) as { extends?: string };
}

describe("TypeScript coverage", () => {
  test("every project tsconfig extends tsconfig.base.json", () => {
    expect(projectConfigs.length).toBeGreaterThan(0);
    const wrong = projectConfigs.filter((path) => {
      const base = readConfig(path).extends;
      return base === undefined || resolve(ROOT, dirname(path), base) !== join(ROOT, "tsconfig.base.json");
    });
    expect(wrong).toEqual([]);
  });

  test("every tracked .ts and .tsx file is in a project's program", async () => {
    const tsc = join(ROOT, "node_modules", ".bin", "tsc");
    const programs = await Promise.all(
      projectConfigs.map(async (config) => {
        const proc = Bun.spawn([tsc, "-p", join(ROOT, config), "--listFilesOnly"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (code !== 0) throw new Error(`tsc -p ${config} --listFilesOnly: ${out}${err}`);
        return out.split("\n").filter((file) => file !== "");
      }),
    );
    const covered = new Set(programs.flat().map((file) => relative(ROOT, file)));
    const missing = git(["ls-files", "*.ts", "*.tsx"]).filter((path) => !covered.has(path));
    expect(missing).toEqual([]);
  }, 60_000);
});
