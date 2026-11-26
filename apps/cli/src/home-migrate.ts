// OS-215: a machine moved from omnibus keeps its T3 credential and Google OAuth state in ~/.omnibus, while
// OmniSlash reads ~/.omnislash. Decided by Jacobus, 2026-11-25: migrate once. The first `ob` run on such a
// machine copies those files into a new ~/.omnislash and leaves ~/.omnibus as it was; from then on only
// ~/.omnislash is read. A ~/.omnislash that exists in any form (a directory, or the hand-made symlink to
// ~/.omnibus on the desktop that predates this) is never touched.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OMNISLASH_HOME_DIR = ".omnislash";
export const OMNIBUS_HOME_DIR = ".omnibus";

/** What is carried over: the T3 MCP credential and the hosted Google OAuth state. */
export const MIGRATED_FILES = ["t3-mcp-credential.json", "google-oauth-state.json"] as const;

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the omnibus-era state into a new ~/.omnislash when ~/.omnislash is absent and ~/.omnibus is a
 * directory. Returns the files copied, or null when nothing was migrated (already migrated, another `ob`
 * migrated it first, or nothing to migrate from). The new directory is mode 700 and each copy mode 600.
 *
 * The copy is built in a sibling temp directory and renamed onto ~/.omnislash, so ~/.omnislash only ever
 * appears complete: a failed copy leaves no ~/.omnislash and the next run tries again, and an `ob` started
 * alongside (the drain job) either sees nothing yet or sees every file.
 */
export function migrateOmnibusHome(home: string = homedir()): string[] | null {
  const target = join(home, OMNISLASH_HOME_DIR);
  if (present(target)) return null;
  const source = join(home, OMNIBUS_HOME_DIR);
  if (!existsSync(source) || !statSync(source).isDirectory()) return null;
  const staging = `${target}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(staging, { mode: 0o700 });
    const copied: string[] = [];
    for (const name of MIGRATED_FILES) {
      const from = join(source, name);
      if (!existsSync(from)) continue;
      const to = join(staging, name);
      copyFileSync(from, to);
      chmodSync(to, 0o600);
      copied.push(name);
    }
    try {
      renameSync(staging, target);
    } catch (err) {
      // Another `ob` renamed its copy into place first: that one is the migration.
      if (present(target)) return null;
      throw err;
    }
    return copied;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The entry point's call: migrate, say so on stderr, and never stop `ob` over it. */
export function migrateOmnibusHomeOnStartup(home: string = homedir()): void {
  try {
    const copied = migrateOmnibusHome(home);
    if (copied) {
      const what = copied.length > 0 ? copied.join(", ") : "nothing to copy";
      process.stderr.write(`ob: first run here: created ~/${OMNISLASH_HOME_DIR} from ~/${OMNIBUS_HOME_DIR} (${what}); ~/${OMNIBUS_HOME_DIR} is left as it was\n`);
    }
  } catch (err) {
    process.stderr.write(`ob: could not migrate ~/${OMNIBUS_HOME_DIR} into ~/${OMNISLASH_HOME_DIR}: ${(err as Error).message}\n`);
  }
}
