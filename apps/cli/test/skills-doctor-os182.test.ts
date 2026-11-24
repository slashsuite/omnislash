// OS-182: `ob skills doctor [--fix]` against a temp HOME with two fake checkouts, ~/dev/omnibus and
// ~/dev/omnislash, each a real git repo whose commit dates decide which copy of a skill is newer.
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratedDbPath, runCli, spawnBudget } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function git(repo: string, args: string[], date?: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** Write `skills/<name>/SKILL.md` in `repo` and commit it on `date`. */
function skill(repo: string, name: string, body: string, date: string): void {
  mkdirSync(join(repo, "skills", name), { recursive: true });
  writeFileSync(join(repo, "skills", name, "SKILL.md"), body);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", name], date);
}

/**
 * HOME with ~/.claude/skills linking every skill at the omnibus checkout:
 *   same      identical in both
 *   newer     differs, omnislash committed later  -> --fix repoints it
 *   older     differs, omnibus committed later    -> listed only
 *   busonly   only in omnibus                      -> left alone
 * plus a link outside both checkouts and a plain directory, which are not listed.
 */
function fakeHome(): { home: string; bus: string; slash: string; links: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ob-os182-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const bus = join(home, "dev", "omnibus");
  const slash = join(home, "dev", "omnislash");
  for (const repo of [bus, slash]) {
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q"]);
  }
  skill(bus, "same", "one\n", "2026-11-01T00:00:00Z");
  skill(slash, "same", "one\n", "2026-11-01T00:00:00Z");
  skill(bus, "newer", "old\n", "2026-11-02T00:00:00Z");
  skill(slash, "newer", "new\n", "2026-11-10T00:00:00Z");
  skill(slash, "older", "stale\n", "2026-11-03T00:00:00Z");
  skill(bus, "older", "fresh\n", "2026-11-12T00:00:00Z");
  skill(bus, "busonly", "x\n", "2026-11-04T00:00:00Z");
  const links = join(home, ".claude", "skills");
  mkdirSync(links, { recursive: true });
  for (const name of ["same", "newer", "older", "busonly"]) symlinkSync(join(bus, "skills", name), join(links, name));
  const elsewhere = join(home, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(links, "foreign"));
  mkdirSync(join(links, "plain"));
  return { home, bus, slash, links };
}

async function doctor(home: string, args: string[] = []) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await runCli(migratedDbPath(), ["skills", "doctor", ...args]);
  } finally {
    process.env.HOME = prev;
  }
}

test("doctor lists every link into a checkout with its state and changes nothing", async () => {
  const { home, bus, links } = fakeHome();
  const res = await doctor(home);
  expect(res.err).toBe("");
  expect(res.code).toBe(0);
  expect(res.out.trim().split("\n")).toEqual([
    `busonly ${join(bus, "skills", "busonly")} omnibus-only`,
    `newer ${join(bus, "skills", "newer")} differs (omnislash newer)`,
    `older ${join(bus, "skills", "older")} differs (omnibus newer)`,
    `same ${join(bus, "skills", "same")} same`,
  ]);
  for (const name of ["same", "newer", "older", "busonly"]) expect(readlinkSync(join(links, name))).toBe(join(bus, "skills", name));
}, spawnBudget(20));

test("--fix repoints only the link omnislash is newer on", async () => {
  const { home, bus, slash, links } = fakeHome();
  const res = await doctor(home, ["--fix"]);
  expect(res.code).toBe(0);
  expect(res.out).toContain(`newer ${join(bus, "skills", "newer")} differs (omnislash newer; repointed to ${join(slash, "skills", "newer")})`);
  expect(res.out).toContain(`older ${join(bus, "skills", "older")} differs (omnibus newer; left as is)`);
  expect(readlinkSync(join(links, "newer"))).toBe(join(slash, "skills", "newer"));
  expect(readlinkSync(join(links, "older"))).toBe(join(bus, "skills", "older"));
  expect(readlinkSync(join(links, "busonly"))).toBe(join(bus, "skills", "busonly"));
  expect(readlinkSync(join(links, "same"))).toBe(join(bus, "skills", "same"));
  expect(readlinkSync(join(links, "foreign"))).toBe(join(home, "elsewhere"));
  expect(lstatSync(join(links, "plain")).isDirectory()).toBe(true);
  expect(existsSync(join(bus, "skills", "newer", "SKILL.md"))).toBe(true);

  // A second run reads the repointed link as the omnislash copy.
  const again = await doctor(home);
  expect(again.out).toContain(`newer ${join(slash, "skills", "newer")} same`);
}, spawnBudget(20));

test("a bare --fix is expanded only when skills is the command", async () => {
  const { expandSkillsFixFlag } = await import("../src/commands/skills.ts");
  const { FLAGS } = await import("../src/cli.ts");
  const x = (argv: string[]) => expandSkillsFixFlag(argv, FLAGS);
  expect(x(["--db", "/x.db", "skills", "doctor", "--fix"])).toEqual(["--db", "/x.db", "skills", "doctor", "--fix="]);
  expect(x(["skills", "--json", "doctor", "--fix"])).toEqual(["skills", "--json", "doctor", "--fix="]);
  expect(x(["wiki", "log", "skills", "doctor", "--fix", "x"])).toEqual(["wiki", "log", "skills", "doctor", "--fix", "x"]);
  expect(x(["lease", "run", "k", "--", "ob", "skills", "doctor", "--fix"])).toEqual(["lease", "run", "k", "--", "ob", "skills", "doctor", "--fix"]);
});

test("--fix with a value is refused and changes nothing", async () => {
  const { home, bus, links } = fakeHome();
  const res = await doctor(home, ["--fix=false"]);
  expect(res.code).toBe(2);
  expect((await doctor(home, ["--fix", "false"])).code).toBe(2);
  expect(readlinkSync(join(links, "newer"))).toBe(join(bus, "skills", "newer"));
}, spawnBudget(20));

test("a dangling link into omnibus whose skill omnislash still has is differs, and --fix repoints it", async () => {
  const { home, bus, links } = fakeHome();
  symlinkSync(join(bus, "skills", "gone"), join(links, "gone"));
  mkdirSync(join(home, "dev", "omnislash", "skills", "gone"), { recursive: true });
  writeFileSync(join(home, "dev", "omnislash", "skills", "gone", "SKILL.md"), "here\n");
  git(join(home, "dev", "omnislash"), ["add", "-A"]);
  git(join(home, "dev", "omnislash"), ["commit", "-q", "-m", "gone"], "2026-11-20T00:00:00Z");
  const res = await doctor(home);
  expect(res.out).toContain(`gone ${join(bus, "skills", "gone")} differs (omnislash newer)`);
  await doctor(home, ["--fix"]);
  expect(readlinkSync(join(links, "gone"))).toBe(join(home, "dev", "omnislash", "skills", "gone"));
}, spawnBudget(20));
