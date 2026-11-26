import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateOmnibusHome } from "../src/home-migrate.ts";
import { base64UrlEncode, credentialPath, readCredential, type T3Credential } from "../src/t3/client.ts";

// OS-215: a machine moved from omnibus has its T3 credential and Google OAuth state in ~/.omnibus. The first
// `ob` run copies them into ~/.omnislash once and leaves ~/.omnibus untouched; afterwards only ~/.omnislash
// is read. These tests stand up a home of their own; the real one is never touched.

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "os215-home-"));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
});

const token = `${base64UrlEncode(JSON.stringify({ kind: "session", sid: "omnibus-era", exp: 4_100_000_000_000 }))}.sig`;
const credential: T3Credential = {
  version: 1,
  baseUrl: "http://127.0.0.1:3773",
  accessToken: token,
  tokenType: "Bearer",
  access: "full-access",
  scopes: ["orchestration:read", "orchestration:operate"],
  issuedAt: "2026-11-13T16:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
};

/** A home as omnibus left it: ~/.omnibus with the credential, the OAuth state and something else. */
function omnibusHome(): string {
  const h = home();
  const ob = join(h, ".omnibus");
  mkdirSync(ob, { mode: 0o700 });
  writeFileSync(join(ob, "t3-mcp-credential.json"), JSON.stringify(credential), { mode: 0o600 });
  writeFileSync(join(ob, "google-oauth-state.json"), '{"states":{}}', { mode: 0o600 });
  writeFileSync(join(ob, "unrelated.json"), "{}", { mode: 0o600 });
  return h;
}

describe("migrate ~/.omnibus into ~/.omnislash once (OS-215)", () => {
  test("with only ~/.omnibus, the first run copies the credential and OAuth state, mode 600 in a 700 dir", () => {
    const h = omnibusHome();
    expect(migrateOmnibusHome(h)).toEqual(["t3-mcp-credential.json", "google-oauth-state.json"]);
    const target = join(h, ".omnislash");
    expect(statSync(target).mode & 0o777).toBe(0o700);
    for (const f of ["t3-mcp-credential.json", "google-oauth-state.json"]) {
      expect(statSync(join(target, f)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(target, f), "utf8")).toBe(readFileSync(join(h, ".omnibus", f), "utf8"));
    }
    expect(existsSync(join(target, "unrelated.json"))).toBe(false);
    // ~/.omnibus is left as it was.
    expect(existsSync(join(h, ".omnibus", "t3-mcp-credential.json"))).toBe(true);
    expect(existsSync(join(h, ".omnibus", "unrelated.json"))).toBe(true);
  });

  test("it runs once: a later change in ~/.omnibus is never read again", () => {
    const h = omnibusHome();
    migrateOmnibusHome(h);
    writeFileSync(join(h, ".omnibus", "t3-mcp-credential.json"), "changed later");
    expect(migrateOmnibusHome(h)).toBeNull();
    expect(readFileSync(join(h, ".omnislash", "t3-mcp-credential.json"), "utf8")).toBe(JSON.stringify(credential));
  });

  test("an existing ~/.omnislash, even the hand-made symlink to ~/.omnibus, is left alone", () => {
    const h = omnibusHome();
    symlinkSync(join(h, ".omnibus"), join(h, ".omnislash"));
    expect(migrateOmnibusHome(h)).toBeNull();
    expect(lstatSync(join(h, ".omnislash")).isSymbolicLink()).toBe(true);
  });

  test("a fresh machine with neither directory gets nothing created", () => {
    const h = home();
    expect(migrateOmnibusHome(h)).toBeNull();
    expect(existsSync(join(h, ".omnislash"))).toBe(false);
  });

  test("a failed copy leaves no ~/.omnislash, so the next run migrates", () => {
    const h = omnibusHome();
    // A directory where the OAuth state should be: copyFileSync fails on it for every user, root included.
    const state = join(h, ".omnibus", "google-oauth-state.json");
    rmSync(state);
    mkdirSync(state);
    expect(() => migrateOmnibusHome(h)).toThrow();
    rmSync(state, { recursive: true });
    writeFileSync(state, '{"states":{}}', { mode: 0o600 });
    expect(existsSync(join(h, ".omnislash"))).toBe(false);
    expect(readdirSync(h).filter((f) => f.startsWith(".omnislash"))).toEqual([]);
    expect(migrateOmnibusHome(h)).toEqual(["t3-mcp-credential.json", "google-oauth-state.json"]);
  });

  test("after the migration the credential `ob close` connects with is the omnibus one", () => {
    const h = omnibusHome();
    migrateOmnibusHome(h);
    // T3Client.connected() in `ob close` reads credentialPath(): ~/.omnislash/t3-mcp-credential.json.
    expect(credentialPath({} as NodeJS.ProcessEnv)).toEndWith(join(".omnislash", "t3-mcp-credential.json"));
    const env = { OB_T3_CREDENTIAL_FILE: join(h, ".omnislash", "t3-mcp-credential.json") } as NodeJS.ProcessEnv;
    expect(readCredential(env)?.accessToken).toBe(token);
  });
});
