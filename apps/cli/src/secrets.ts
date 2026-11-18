import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { AppError } from "./errors.ts";
import { nowIso } from "./db.ts";
import type { Store } from "./db/store.ts";

// -----------------------------------------------------------------------------
// Encrypted secret store (ticket 135). AES-256-GCM via node:crypto. Ciphertext,
// the per-secret random IV, and the GCM auth tag live in the `secret` DB table;
// the 32-byte master key lives in the macOS Keychain, or (ticket 182, so `ob` can
// run on Linux) in a 0600 file named by $OMNISLASH_MASTER_KEY_FILE, both behind the
// injectable MasterKey seam so tests never touch the real Keychain and never handle
// a real token. A secret value is NEVER logged/printed here; the only decrypt→stdout
// path is `ob secret get`.
// -----------------------------------------------------------------------------

export const MASTER_KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const KEYCHAIN_SERVICE = "omnislash-master-key";
const KEYCHAIN_ACCOUNT = "omnislash";

/** Provider of the 32-byte master key. Real impl → Keychain; tests inject an in-memory key. */
export interface MasterKey {
  get(): Buffer;
}

export interface Encrypted {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

// --- crypto primitives -------------------------------------------------------

export function encrypt(plain: string, key: Buffer): Encrypted {
  if (key.length !== MASTER_KEY_BYTES) throw new AppError("master key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Decrypt; throws (GCM authentication) on a wrong key or tampered ciphertext/iv/tag. */
export function decrypt(enc: Encrypted, key: Buffer): string {
  if (key.length !== MASTER_KEY_BYTES) throw new AppError("master key must be 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.authTag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

// --- master key providers ----------------------------------------------------

export const REAL_KEYCHAIN_OPT_IN = "OMNISLASH_ALLOW_REAL_KEYCHAIN";

/**
 * Whether the `security` shell-out is allowed to run right now. Under a test runner it is NOT,
 * unless the run explicitly opts in (152): the master key unlocks the store holding live tokens,
 * so a test reaching it would contend for — and, on a first-use miss, WRITE to — the developer's
 * login keychain. Convention alone did not make that impossible; this does.
 */
export function realKeychainBlocked(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "test" && env[REAL_KEYCHAIN_OPT_IN] !== "1";
}

/**
 * The `security` shell-out seam (OB-1911): runs `security <args>` and returns its exit code and
 * decoded output. The default adapter runs the real binary; tests inject a fake so no credential
 * storage is touched.
 */
export type SecurityRunner = (args: string[]) => { exitCode: number; stdout: string; stderr: string };

const realSecurity: SecurityRunner = (args) => {
  const p = Bun.spawnSync(["security", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
};

interface KeychainOpts {
  /** Mint and store a fresh key when the item is missing. Only a write into an EMPTY store passes true. */
  mintIfMissing?: boolean;
  /** Defaults to process.platform, read at `.get()` time. */
  platform?: string;
  /** Test seam replacing the real `security` binary; when given, the test-run refusal is skipped. */
  security?: SecurityRunner;
}

/**
 * Real master-key provider: reads the 32-byte key from the macOS Keychain via `security`. The
 * shell-out only happens inside `.get()`, so merely defaulting to this provider is inert until a
 * store hit needs the key, and under a test runner the REAL binary is refused outright
 * (`realKeychainBlocked`); an injected `security` seam touches no credential storage and skips it.
 *
 * A missing item is a named error (OB-1911), never a silent mint: a fresh key would not decrypt the
 * stored ciphertexts, and sitting in the Keychain it would hide why. A key is minted only when the
 * caller passes `mintIfMissing`, which `masterKeyForWrite` does for a write into an empty store.
 */
export function keychainMasterKey(opts: KeychainOpts = {}): MasterKey {
  return {
    get(): Buffer {
      if (!opts.security && realKeychainBlocked()) {
        throw new AppError(
          `refusing to read the real macOS Keychain from a test run — inject a master key with inMemoryMasterKey() instead (set ${REAL_KEYCHAIN_OPT_IN}=1 only for a deliberate real-wiring check)`,
        );
      }
      if ((opts.platform ?? process.platform) !== "darwin") {
        throw new AppError(
          "the secret store needs the macOS Keychain for its master key, unavailable on this platform",
        );
      }
      const security = opts.security ?? realSecurity;
      const found = security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
      if (found.exitCode === 0) {
        const key = Buffer.from(found.stdout.trim(), "base64");
        if (key.length !== MASTER_KEY_BYTES) {
          throw new AppError(
            `the OmniSlash master key in the Keychain is malformed (expected ${MASTER_KEY_BYTES} bytes) — delete the '${KEYCHAIN_SERVICE}' item and re-run`,
          );
        }
        return key;
      }
      if (!opts.mintIfMissing) {
        throw new AppError(
          `the OmniSlash master key is missing from the Keychain, and the stored secrets cannot be decrypted without it. Restore it from a backup with \`security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w <base64 key>\`, using the copy held in $${MASTER_KEY_FILE_ENV} on the server if there is no other. Refusing to generate a new key: it would not decrypt the stored secrets`,
        );
      }
      // First write into an empty store: mint a fresh key and store it.
      const key = randomBytes(MASTER_KEY_BYTES);
      const added = security([
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
        key.toString("base64"),
      ]);
      if (added.exitCode !== 0) {
        const msg = added.stderr.trim();
        throw new AppError(
          `could not create the OmniSlash master key in the Keychain: ${msg || "security add-generic-password failed"}`,
        );
      }
      return key;
    },
  };
}

export const MASTER_KEY_FILE_ENV = "OMNISLASH_MASTER_KEY_FILE";

const KEYCHAIN_EXPORT_CMD = `security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`;

/** The master key file this process would use, or null when the env var is unset/empty. Pure. */
export function masterKeyFilePath(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env[MASTER_KEY_FILE_ENV] ?? "").trim();
  return raw === "" ? null : raw;
}

/**
 * File-backed master-key provider (ticket 182): the file holds base64 of exactly 32 bytes, mode 0600.
 * Unlike the Keychain provider it NEVER mints a key on a miss, because a freshly generated key would not
 * decrypt the existing ciphertext, and that failure would surface much later as unreadable secrets
 * rather than here. A missing file is a hard error telling the operator to place the key. No error
 * path ever includes the key material, not even truncated.
 */
export function fileMasterKey(path: string): MasterKey {
  return {
    get(): Buffer {
      if (!existsSync(path)) {
        throw new AppError(
          `no master key file at ${path}: place the existing 32-byte key there (base64, chmod 600); on the Mac it comes from \`${KEYCHAIN_EXPORT_CMD}\`. Refusing to generate a new key: it would not decrypt the stored secrets`,
        );
      }
      if (process.platform !== "win32") {
        const mode = statSync(path).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          throw new AppError(
            `the master key file at ${path} has mode 0${mode.toString(8).padStart(3, "0")}, and group/other access is not allowed; fix it with \`chmod 600 ${path}\``,
          );
        }
      }
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        throw new AppError(`could not read the master key file at ${path}: ${(err as Error).message}`);
      }
      const b64 = text.trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        throw new AppError(
          `the master key file at ${path} is not valid base64; it must hold base64 of exactly ${MASTER_KEY_BYTES} bytes`,
        );
      }
      const key = Buffer.from(b64, "base64");
      if (key.length !== MASTER_KEY_BYTES) {
        throw new AppError(
          `the master key file at ${path} decodes to ${key.length} bytes, expected ${MASTER_KEY_BYTES}`,
        );
      }
      return key;
    },
  };
}

/**
 * The provider this machine should use, resolved lazily so merely constructing it stays inert:
 * $OMNISLASH_MASTER_KEY_FILE wins everywhere (deliberately including darwin, so the file path is
 * exercisable on the Mac), else the Keychain on darwin, else a clear error naming the env var.
 */
export function defaultMasterKey(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  opts: { mintIfMissing?: boolean; security?: SecurityRunner } = {},
): MasterKey {
  return {
    get(): Buffer {
      const path = masterKeyFilePath(env);
      if (path) return fileMasterKey(path).get(); // never mints, whatever mintIfMissing says
      if (platform === "darwin") {
        return keychainMasterKey({ mintIfMissing: opts.mintIfMissing, platform, security: opts.security }).get();
      }
      throw new AppError(
        `no master key available on ${platform}: set ${MASTER_KEY_FILE_ENV} to a file holding base64 of the 32-byte master key (mode 0600). Produce it on the Mac with \`${KEYCHAIN_EXPORT_CMD}\``,
      );
    },
  };
}

/** In-memory provider for tests (default: a fixed 32-byte key). Never reaches the Keychain. */
export function inMemoryMasterKey(key?: Buffer): MasterKey {
  const k = key ?? Buffer.alloc(MASTER_KEY_BYTES, 7);
  if (k.length !== MASTER_KEY_BYTES) throw new AppError("in-memory master key must be 32 bytes");
  return { get: () => k };
}

// --- store operations --------------------------------------------------------
//
// The secret store is a TABLE, so it moved to Postgres with everything else (337). What did NOT move is
// any of the cryptography: encrypt/decrypt above are untouched, the master key still comes from the
// macOS Keychain (or the 0600 file named by $OMNISLASH_MASTER_KEY_FILE on the server) through the same
// MasterKey seam, and no value is logged or printed on any path here. Only where the ciphertext rows
// live changed.
//
// `secretRowValues` and `decodeSecret` are pure and kept separate from the queries so the row shape is
// stated once.
//
// `name` is the primary key, and `listSecrets` is this table's only ordering, so the ORDER BY ... DESC
// NULLS-FIRST difference has nothing here to bite: there is no nullable ordered column in this module.

/** The row an insert/upsert writes for one secret. */
function secretRowValues(name: string, value: string, key: Buffer, now: string) {
  const enc = encrypt(value, key);
  return {
    name,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    auth_tag: enc.authTag,
    created_at: now,
    updated_at: now,
  };
}

/** Turn a stored row back into plaintext. */
function decodeSecret(
  row: { ciphertext: string; iv: string; auth_tag: string } | undefined,
  key: Buffer,
): string | null {
  if (!row) return null;
  return decrypt({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag }, key);
}

export async function setSecret(
  store: Store,
  name: string,
  value: string,
  key: Buffer,
): Promise<void> {
  const now = nowIso();
  const values = secretRowValues(name, value, key, now);
  await store.q
    .insert(store.t.secret)
    .values(values)
    .onConflictDoUpdate({
      target: store.t.secret.name,
      set: {
        ciphertext: values.ciphertext,
        iv: values.iv,
        auth_tag: values.auth_tag,
        updated_at: now,
      },
    });
}

/** Decrypt the named secret, or null when it isn't stored. */
export async function getSecret(store: Store, name: string, key: Buffer): Promise<string | null> {
  const rows = (await store.q
    .select({
      ciphertext: store.t.secret.ciphertext,
      iv: store.t.secret.iv,
      auth_tag: store.t.secret.auth_tag,
    })
    .from(store.t.secret)
    .where(eq(store.t.secret.name, name))
    .limit(1)) as Array<{ ciphertext: string; iv: string; auth_tag: string }>;
  return decodeSecret(rows[0], key);
}

/** Existence check that does NOT need the master key (so callers can avoid the Keychain when empty). */
export async function hasSecret(store: Store, name: string): Promise<boolean> {
  const rows = (await store.q
    .select({ name: store.t.secret.name })
    .from(store.t.secret)
    .where(eq(store.t.secret.name, name))
    .limit(1)) as Array<{ name: string }>;
  return rows.length > 0;
}

/** Names + updated_at only — NEVER any ciphertext or value. */
export async function listSecrets(store: Store): Promise<Array<{ name: string; updated_at: string }>> {
  return (await store.q
    .select({ name: store.t.secret.name, updated_at: store.t.secret.updated_at })
    .from(store.t.secret)
    .orderBy(asc(store.t.secret.name))) as Array<{ name: string; updated_at: string }>;
}

/**
 * Forget the last live-check verdict for a credential (OB-1934). A person who replaces or removes a
 * credential has invalidated whatever `ob creds check` last said about it: a failed verdict would keep
 * alert rule 11 firing after the fix, and an old ok would keep showing for a credential that is gone.
 * With no row the credential reads unchecked. A name with no row is a no-op.
 *
 * Lives here, beside the secret writes it follows, so `commands/secret.ts` and the google command
 * (which already import this module) gain no new import edge; `recordCredentialCheck` stays in
 * `credentials.ts`, which imports this module.
 *
 * Called by each write that is a person's act (`ob secret set|rm`, the API twins, the tokens page paste,
 * `ob google auth`), never from `setSecret`/`removeSecret` themselves: the google token refresh also
 * calls `setSecret` on every sync, and clearing there would wipe a failed check on each one.
 */
export async function clearCredentialCheck(store: Store, name: string): Promise<void> {
  await store.q.delete(store.t.credentialCheck).where(eq(store.t.credentialCheck.name, name));
}

/** Remove a secret; returns whether a row existed. */
export async function removeSecret(store: Store, name: string): Promise<boolean> {
  const existed = await hasSecret(store, name);
  await store.q.delete(store.t.secret).where(eq(store.t.secret.name, name));
  return existed;
}

/**
 * Whether a write may mint a fresh Keychain key (OB-1911): only when the store holds no secrets,
 * so a new key can never orphan existing ciphertexts.
 */
export async function mintOnWrite(store: Store): Promise<boolean> {
  return (await listSecrets(store)).length === 0;
}

/** The key a write site falls back to: the default provider, allowed to mint only into an empty store. */
export async function masterKeyForWrite(
  store: Store,
  opts: { env?: Record<string, string | undefined>; platform?: string; security?: SecurityRunner } = {},
): Promise<MasterKey> {
  return defaultMasterKey(opts.env ?? process.env, opts.platform ?? process.platform, {
    mintIfMissing: await mintOnWrite(store),
    security: opts.security,
  });
}

// --- known secrets (the ob-managed tokens the readers + `ob secret import` cover) ---

export interface KnownSecret {
  /** Config key holding the legacy plaintext file path (the transition fallback / import source). */
  pathSetting: string;
  /** Human label for clean error messages. */
  label: string;
}

export const KNOWN_SECRETS: Record<string, KnownSecret> = {
  google: { pathSetting: "google_token_path", label: "Google token" },
  github: { pathSetting: "github_key_path", label: "GitHub token" },
  ha: { pathSetting: "ha_token_path", label: "Home Assistant token" },
};

export const KNOWN_SECRET_NAMES = Object.keys(KNOWN_SECRETS);
