import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INFER_PROJECT_ERROR, rewriteAddProjectArgv } from "../../../apps/cli/src/commands/capture.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { run } from "../../../apps/cli/src/cli.ts";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";

function gitCheckout(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-243-git-"));
  execSync("git init -q", { cwd: dir });
  execSync(`git remote add origin ${remote}`, { cwd: dir });
  return dir;
}

describe("rewriteAddProjectArgv (243): the rewrite happens BEFORE dispatch", () => {
  test("a cwd inside a checkout resolves to the right project and kind", () => {
    const side = gitCheckout("https://github.com/owner/acme.git");
    const other = gitCheckout("git@github.com:acmecorp/cue-app.git");
    try {
      const fromSide = rewriteAddProjectArgv({
        argv: ["add", "x"],
        command: "add",
        flags: {},
        cwd: side,
      });
      expect(fromSide.error).toBeNull();
      expect(fromSide.argv).toEqual(["add", "x", "--project", "acme", "--kind", "side"]);

      const fromOther = rewriteAddProjectArgv({
        argv: ["add", "x"],
        command: "add",
        flags: {},
        cwd: other,
      });
      expect(fromOther.error).toBe(INFER_PROJECT_ERROR);
      expect(fromOther.argv).toEqual(["add", "x"]);
    } finally {
      rmSync(side, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("an explicit --project (or --repo) passes through untouched", () => {
    const dir = gitCheckout("https://github.com/owner/acme.git");
    try {
      const project = rewriteAddProjectArgv({
        argv: ["add", "x", "--project", "already"],
        command: "add",
        flags: { project: "already" },
        cwd: dir,
      });
      expect(project).toEqual({ argv: ["add", "x", "--project", "already"], error: null });

      const repo = rewriteAddProjectArgv({
        argv: ["add", "x", "--repo", "already"],
        command: "add",
        flags: { repo: "already" },
        cwd: dir,
      });
      expect(repo).toEqual({ argv: ["add", "x", "--repo", "already"], error: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit --kind is kept; only --project is filled in", () => {
    const dir = gitCheckout("https://github.com/owner/acme.git");
    try {
      const res = rewriteAddProjectArgv({
        argv: ["add", "x", "--kind", "home"],
        command: "add",
        flags: { kind: "home" },
        cwd: dir,
      });
      expect(res.error).toBeNull();
      expect(res.argv).toEqual(["add", "x", "--kind", "home", "--project", "acme"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cwd outside any checkout still gives the existing clear error rather than a wrong guess", () => {
    const bare = mkdtempSync(join(tmpdir(), "ob-243-bare-"));
    try {
      const res = rewriteAddProjectArgv({
        argv: ["add", "x"],
        command: "add",
        flags: {},
        cwd: bare,
      });
      expect(res.error).toBe(INFER_PROJECT_ERROR);
      expect(res.argv).toEqual(["add", "x"]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("a type that does not need a project is left alone, even outside a checkout", () => {
    const bare = mkdtempSync(join(tmpdir(), "ob-243-bare-"));
    try {
      const res = rewriteAddProjectArgv({
        argv: ["add", "x", "--type", "decision"],
        command: "add",
        flags: { type: "decision" },
        cwd: bare,
      });
      expect(res).toEqual({ argv: ["add", "x", "--type", "decision"], error: null });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("only add is rewritten: other commands pass through untouched", () => {
    const dir = gitCheckout("https://github.com/owner/acme.git");
    try {
      for (const [command, args] of [
        ["edit", ["1"]],
        ["spinoff", ["T-1"]],
        ["list", []],
      ] as Array<[string, string[]]>) {
        const argv = [command, ...args];
        expect(rewriteAddProjectArgv({ argv, command, flags: {}, cwd: dir })).toEqual({
          argv,
          error: null,
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ob add over the wire (243): nothing machine-local is dispatched", () => {
  function recordingExec() {
    const calls: string[][] = [];
    return {
      calls,
      stream(_host: string, argv: string[]) {
        calls.push(argv);
        return { code: 0, connectionFailed: false };
      },
      capture(_host: string, argv: string[]) {
        calls.push(argv);
        return { code: 0, connectionFailed: false, stdout: "", stderr: "" };
      },
      fetch(_host: string, argv: string[]) {
        calls.push(argv);
        return { code: 0, connectionFailed: false, stderr: "", bytes: new Uint8Array() };
      },
    };
  }

  async function runDispatched(dbPath: string, argv: string[]) {
    const exec = recordingExec();
    const prevDb = process.env.OMNISLASH_DB;
    const origErr = process.stderr.write.bind(process.stderr);
    let err = "";
    (process.stderr.write as unknown) = (chunk: string) => {
      err += chunk;
      return true;
    };
    process.env.OMNISLASH_DB = dbPath;
    try {
      return { code: await run(argv, { exec }), err, calls: exec.calls };
    } finally {
      (process.stderr.write as unknown) = origErr;
      if (prevDb === undefined) delete process.env.OMNISLASH_DB;
      else process.env.OMNISLASH_DB = prevDb;
    }
  }

  async function clientDb(): Promise<string> {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    await setConfig(db, "remote_host", "ob@10.0.0.20");
    db.close();
    return dbPath;
  }

  test("a cwd inside a checkout dispatches --project and --kind, never the local path", async () => {
    const checkout = gitCheckout("https://github.com/owner/acme.git");
    const dbPath = await clientDb();
    const prev = process.cwd();
    process.chdir(checkout);
    try {
      const r = await runDispatched(dbPath, ["add", "x"]);
      expect(r.code).toBe(0);
      expect(r.calls[0]).toEqual(["add", "x", "--project", "acme", "--kind", "side"]);
      expect(r.calls.flat().join(" ")).not.toContain(checkout);
    } finally {
      process.chdir(prev);
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("an explicit --project is dispatched unchanged", async () => {
    const checkout = gitCheckout("https://github.com/owner/acme.git");
    const dbPath = await clientDb();
    const prev = process.cwd();
    process.chdir(checkout);
    try {
      const r = await runDispatched(dbPath, ["add", "x", "--project", "already", "--kind", "side"]);
      expect(r.code).toBe(0);
      expect(r.calls[0]).toEqual(["add", "x", "--project", "already", "--kind", "side"]);
    } finally {
      process.chdir(prev);
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("a cwd outside every checkout is refused HERE: nothing is dispatched", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ob-243-out-"));
    const dbPath = await clientDb();
    const prev = process.cwd();
    process.chdir(outside);
    try {
      const r = await runDispatched(dbPath, ["add", "x"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(INFER_PROJECT_ERROR);
      expect(r.calls).toEqual([]);
    } finally {
      process.chdir(prev);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
