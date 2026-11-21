import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMAND_HELP,
  ENV_VARS,
  HANDLERS,
  HELP,
  renderCommandHelp,
  renderEnvHelp,
  renderRootHelp,
  renderSubcommandHelp,
  resolveHelp,
} from "../src/cli.ts";
import { freshDbPath, runCli } from "./helpers.ts";

const TICKET_REF_RE = /\b(?:OB|OS)-\d+\b|\(\d{3,4}(?:,\s*[^)]+)?\)/g;
const DOUBLE_OB_PIPE_RE = /^\s*ob\s+.*\|\s*ob\b/m;
const MAX_LINE_WIDTH = 110;
const MAX_ROOT_LINES = 120;
const MAX_COMMAND_LINES = 80;
const MAX_SPINOFF_LINES = 100;
const MAX_SUMMARY_CHARS = 72;

// Internal runtime/test-only env vars intentionally omitted from user-facing `ob help env`.
const INTERNAL_ENV_VARS = new Set([
  "OMNISLASH_ALLOW_REAL_KEYCHAIN",
  "OMNISLASH_DB_SYNCHRONOUS",
  "OB_LEASE_RUN_HELD",
  "OB_LEASE_RUN_JOB_PIDFILE",
]);

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function discoverCliEnvVars(): string[] {
  const roots = [
    join(REPO_ROOT, "apps/cli/src"),
    join(REPO_ROOT, "platform/cli-coord/src"),
    join(REPO_ROOT, "platform/cli-core/src"),
    join(REPO_ROOT, "platform/cli-db/src"),
    join(REPO_ROOT, "platform/cli-sources/src"),
    join(REPO_ROOT, "platform/cli-whatsapp/src"),
  ];
  const found = new Set<string>();
  const envAssignOrRead =
    /(?:process\.env\.|\benv\.)((?:OMNISLASH|OB)_[A-Z0-9_]+)\b|(?:_ENV\s*=\s*|timeoutFromEnv\()"((?:OMNISLASH|OB)_[A-Z0-9_]+)"/g;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of collectTsFiles(root)) {
      if (file.endsWith("/help.ts")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(envAssignOrRead)) {
        const name = m[1] ?? m[2];
        if (name && !INTERNAL_ENV_VARS.has(name)) found.add(name);
      }
    }
  }
  return [...found].sort();
}

function assertWithinCaps(label: string, text: string, maxLines: number): void {
  const lines = text.split("\n");
  expect(lines.length, `${label} has ${lines.length} lines (cap ${maxLines})`).toBeLessThanOrEqual(maxLines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    expect(
      line.length,
      `${label} line ${i + 1} is ${line.length} chars (cap ${MAX_LINE_WIDTH}): ${line}`,
    ).toBeLessThanOrEqual(MAX_LINE_WIDTH);
  }
  const ticketHits = text.match(TICKET_REF_RE) ?? [];
  expect(
    ticketHits,
    `${label} contains historical ticket refs: ${ticketHits.join(", ")}`,
  ).toEqual([]);
  expect(text, `${label} has a double-prefixed piped example`).not.toMatch(DOUBLE_OB_PIPE_RE);
}

describe("help registry anti-bloat and completeness", () => {
  test("renderRootHelp stays within line and width caps and lists every HANDLERS command", () => {
    const root = renderRootHelp();
    expect(HELP).toBe(root);
    assertWithinCaps("root help", root, MAX_ROOT_LINES);

    const handlerNames = Object.keys(HANDLERS).sort();
    const helpNames = Object.keys(COMMAND_HELP).sort();
    expect(helpNames).toEqual(handlerNames);

    for (const cmd of handlerNames) {
      const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(
        root,
        `root help is missing command '${cmd}'`,
      ).toMatch(new RegExp(`^  ${escaped}\\s+\\S`, "m"));
    }
  });

  test("every command and subcommand help page stays within line, width, and summary caps with zero ticket refs", () => {
    for (const [cmd, meta] of Object.entries(COMMAND_HELP)) {
      expect(
        meta.summary.length,
        `${cmd} summary exceeds ${MAX_SUMMARY_CHARS} chars: ${meta.summary}`,
      ).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);

      const cmdCap = cmd === "spinoff" ? MAX_SPINOFF_LINES : MAX_COMMAND_LINES;
      assertWithinCaps(`command '${cmd}'`, renderCommandHelp(cmd), cmdCap);

      if (meta.subcommands) {
        for (const sub of Object.keys(meta.subcommands)) {
          assertWithinCaps(`subcommand '${cmd} ${sub}'`, renderSubcommandHelp(cmd, sub), MAX_COMMAND_LINES);
        }
      }
    }
  });

  test("env help stays concise, within width cap, free of ticket refs, and covers every CLI env var", () => {
    const env = renderEnvHelp();
    assertWithinCaps("env help", env, MAX_COMMAND_LINES);
    const documented = new Set(ENV_VARS.map((v) => v.name));
    const missing = discoverCliEnvVars().filter((name) => !documented.has(name));
    expect(missing, `CLI env vars missing from ENV_VARS: ${missing.join(", ")}`).toEqual([]);
    for (const v of ENV_VARS) {
      expect(env).toContain(v.name);
    }
  });
});

describe("help isolation and routing", () => {
  test("command and subcommand help are isolated, focused, and match across --help / -h / help forms", async () => {
    const db = freshDbPath();

    const rootFlag = await runCli(db, ["--help"]);
    const rootShort = await runCli(db, ["-h"]);
    const rootCmd = await runCli(db, ["help"]);
    expect(rootFlag.code).toBe(0);
    expect(rootShort.code).toBe(0);
    expect(rootCmd.code).toBe(0);
    expect(rootShort.out).toBe(rootFlag.out);
    expect(rootCmd.out).toBe(rootFlag.out);

    const editFlag = await runCli(db, ["edit", "--help"]);
    const editShort = await runCli(db, ["edit", "-h"]);
    const editCmd = await runCli(db, ["help", "edit"]);
    expect(editFlag.code).toBe(0);
    expect(editFlag.err).toBe("");
    expect(editShort.out).toBe(editFlag.out);
    expect(editCmd.out).toBe(editFlag.out);
    expect(editFlag.out).toContain("ob edit");
    expect(editFlag.out).not.toContain("spinoff");
    expect(editFlag.out).not.toContain("whatsapp");

    const spinoffFlag = await runCli(db, ["spinoff", "--help"]);
    const handoffFlag = await runCli(db, ["spinoff", "handoff", "--help"]);
    const handoffCmd = await runCli(db, ["help", "spinoff", "handoff"]);
    expect(spinoffFlag.code).toBe(0);
    expect(handoffFlag.code).toBe(0);
    expect(handoffCmd.code).toBe(0);
    expect(handoffCmd.out).toBe(handoffFlag.out);
    expect(handoffFlag.out).toContain("ob spinoff handoff");
    expect(handoffFlag.out.split("\n").length).toBeLessThan(spinoffFlag.out.split("\n").length);
  });

  test("ob help env, unknown targets, positional commands, and bare ob exit codes", async () => {
    const db = freshDbPath();

    const env = await runCli(db, ["help", "env"]);
    expect(env.code).toBe(0);
    expect(env.err).toBe("");
    expect(env.out).toContain("OMNISLASH_API");

    const badCmd = await runCli(db, ["help", "nope"]);
    expect(badCmd.code).toBe(2);
    expect(badCmd.out).toBe("");
    expect(badCmd.err).toContain("unknown command 'nope'");

    const badSub = await runCli(db, ["project", "nope", "--help"]);
    expect(badSub.code).toBe(2);
    expect(badSub.out).toBe("");
    expect(badSub.err).toContain("unknown subcommand 'nope' for 'ob project'");

    const showPos = await runCli(db, ["show", "OS-1", "--help"]);
    expect(showPos.code).toBe(0);
    expect(showPos.err).toBe("");
    expect(showPos.out).toBe(`${renderCommandHelp("show")}\n`);

    const bare = await runCli(db, []);
    expect(bare.code).toBe(2);
    expect(bare.out).toBe(`${renderRootHelp()}\n`);
    expect(bare.err).toBe("");
  });

  test("resolveHelp handles pure unit routing deterministically", () => {
    expect(resolveHelp([])).toEqual({ text: renderRootHelp() });
    expect(resolveHelp(["env"])).toEqual({ text: renderEnvHelp() });
    expect(resolveHelp(["edit"])).toEqual({ text: renderCommandHelp("edit") });
    expect(resolveHelp(["project", "add"])).toEqual({ text: renderSubcommandHelp("project", "add") });
    expect(resolveHelp(["t3", "team"])).toEqual({ text: renderSubcommandHelp("t3", "team") });
    expect(resolveHelp(["spinoff", "ready"])).toEqual({ text: renderSubcommandHelp("spinoff", "handoff") });
    expect(resolveHelp(["spinoff", "OS-1"])).toEqual({ text: renderCommandHelp("spinoff") });
    expect(resolveHelp(["show", "OS-1"])).toEqual({ text: renderCommandHelp("show") });
    expect(resolveHelp(["nope"])).toEqual({
      error: "unknown command 'nope'. Run 'ob --help' to list commands.",
    });
    expect(resolveHelp(["project", "nope"])).toEqual({
      error: "unknown subcommand 'nope' for 'ob project'. Run 'ob project --help' to list subcommands.",
    });
  });
});
