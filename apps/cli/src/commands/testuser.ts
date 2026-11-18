import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Ctx } from "../ctx.ts";
import { UsageError, AppError } from "../errors.ts";
import { type Store } from "../db/store.ts";
import { print } from "../output.ts";
import { nowIso } from "../db.ts";
import { orm } from "../db/orm.ts";
import { testUser } from "../db/schema.ts";
import { hasSecret, masterKeyForWrite, setSecret } from "../secrets.ts";

// -----------------------------------------------------------------------------
// Test-account registry (137). Each test-user's secret lives in the encrypted
// `secret` store (135) under the namespaced key `test-user:<label>` — NOT in a
// per-user macOS Keychain item. `test_user.secret_ref` holds that store key.
// The store's single master key still lives in the Keychain (the shared key for
// everything, via `defaultMasterKey`), replacing the per-test-user items.
// The secret VALUE is written on `add` (read from stdin) and NEVER printed by
// add/list/show — this module only ever writes or existence-checks a secret,
// it never decrypts a stored value back out.
// -----------------------------------------------------------------------------

export interface TestUserRow {
  id: number;
  label: string;
  email: string | null;
  role: string | null;
  workspace: string | null;
  env: string | null;
  secret_ref: string | null;
  notes: string | null;
  secret_set_at: string | null;
  last_used: string | null;
}

export interface AddTestUserInput {
  label: string;
  role?: string | null;
  email?: string | null;
  workspace?: string | null;
  env?: string | null;
  secretRef?: string | null;
  notes?: string | null;
}

const STALE_DAYS = 90;
const DAY_MS = 86_400_000;

/** The default secret-store key for a test user, when --secret-ref is omitted. */
export function defaultSecretRef(label: string): string {
  return `test-user:${label}`;
}

/**
 * Existence check for a test-user's secret in the encrypted store — does NOT
 * need the master key, so `check`/`list`/`show` never touch the Keychain.
 */
export async function testUserSecretPresent(
  store: Store,
  db: Database | Store,
  label: string,
): Promise<boolean> {
  const row = "kind" in db ? await getTestUserFor(db, label) : getTestUser(db, label);
  if (!row) return false;
  return hasSecret(store, row.secret_ref ?? defaultSecretRef(label));
}

/**
 * Returns a human note when the stored secret looks stale (older than 90 days)
 * or when its age is unknown (secret_set_at absent). Returns null when fresh.
 */
export function secretStaleness(secretSetAt: string | null, nowMs = Date.now()): string | null {
  if (!secretSetAt) {
    return "secret age unknown (secret_set_at not recorded — run `ob test-user check`)";
  }
  const ageDays = Math.floor((nowMs - new Date(secretSetAt).getTime()) / DAY_MS);
  if (ageDays > STALE_DAYS) {
    return `secret may be stale (set ${ageDays}d ago, > ${STALE_DAYS}d) — consider rotating`;
  }
  return null;
}

export async function addTestUserFor(store: Store, input: AddTestUserInput): Promise<TestUserRow> {
  const secretRef = input.secretRef ?? defaultSecretRef(input.label);
  try {
    await store.q.insert(store.t.testUser).values({
      label: input.label,
      email: input.email ?? null,
      role: input.role ?? null,
      workspace: input.workspace ?? null,
      env: input.env ?? null,
      secret_ref: secretRef,
      notes: input.notes ?? null,
    });
  } catch (err) {
    if (String(err).includes("UNIQUE") || String(err).includes("unique")) {
      throw new AppError(`test-user '${input.label}' already exists`);
    }
    throw err;
  }
  return (await getTestUserFor(store, input.label))!;
}

export function addTestUser(db: Database, input: AddTestUserInput): TestUserRow {
  const secretRef = input.secretRef ?? defaultSecretRef(input.label);
  try {
    orm(db)
      .insert(testUser)
      .values({
        label: input.label,
        email: input.email ?? null,
        role: input.role ?? null,
        workspace: input.workspace ?? null,
        env: input.env ?? null,
        secret_ref: secretRef,
        notes: input.notes ?? null,
      })
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new AppError(`test-user '${input.label}' already exists`);
    }
    throw err;
  }
  return getTestUser(db, input.label)!;
}

/**
 * Encrypt+store a test-user's secret VALUE in the `secret` store under its
 * store key (`secret_ref`, default `test-user:<label>`) and stamp `secret_set_at`
 * to now (rotation resets the age). The value is never logged/printed here.
 */
export async function setTestUserSecret(
  store: Store,
  db: Database | Store,
  label: string,
  value: string,
  key: Buffer,
): Promise<void> {
  const row = "kind" in db ? await getTestUserFor(db, label) : getTestUser(db, label);
  if (!row) throw new AppError(`no test-user with label '${label}'`);
  await setSecret(store, row.secret_ref ?? defaultSecretRef(label), value, key);
  if ("kind" in db) {
    await db.q.update(db.t.testUser).set({ secret_set_at: nowIso() }).where(eq(db.t.testUser.label, label));
  } else {
    orm(db).update(testUser).set({ secret_set_at: nowIso() }).where(eq(testUser.label, label)).run();
  }
}

export function getTestUser(db: Database, label: string): TestUserRow | null {
  return (
    (orm(db).select().from(testUser).where(eq(testUser.label, label)).get() as
      | TestUserRow
      | undefined) ?? null
  );
}

export async function getTestUserFor(store: Store, label: string): Promise<TestUserRow | null> {
  const rows = (await store.q
    .select()
    .from(store.t.testUser)
    .where(eq(store.t.testUser.label, label))
    .limit(1)) as TestUserRow[];
  return rows[0] ?? null;
}

export function listTestUsers(
  db: Database,
  filter: { role?: string | null; env?: string | null } = {},
): TestUserRow[] {
  const conds = [];
  if (filter.role) conds.push(eq(testUser.role, filter.role));
  if (filter.env) conds.push(eq(testUser.env, filter.env));
  return orm(db)
    .select()
    .from(testUser)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(testUser.label))
    .all() as TestUserRow[];
}

export async function listTestUsersFor(
  store: Store,
  filter: { role?: string | null; env?: string | null } = {},
): Promise<TestUserRow[]> {
  const conds = [];
  if (filter.role) conds.push(eq(store.t.testUser.role, filter.role));
  if (filter.env) conds.push(eq(store.t.testUser.env, filter.env));
  return (await store.q
    .select()
    .from(store.t.testUser)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(store.t.testUser.label))) as TestUserRow[];
}

/** Records that the secret exists now, only when its set-time was previously unknown. */
export function recordSecretSeen(db: Database, label: string): void {
  orm(db)
    .update(testUser)
    .set({ secret_set_at: nowIso() })
    .where(and(eq(testUser.label, label), isNull(testUser.secret_set_at)))
    .run();
}

export async function recordSecretSeenFor(store: Store, label: string): Promise<void> {
  await store.q
    .update(store.t.testUser)
    .set({ secret_set_at: nowIso() })
    .where(and(eq(store.t.testUser.label, label), isNull(store.t.testUser.secret_set_at)));
}

function flag(ctx: Ctx, key: string): string | undefined {
  const v = (ctx.flags as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export async function cmdTestUser(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];

  if (sub === "add") {
    const label = ctx.args[1];
    if (!label) throw new UsageError("test-user add requires a <label>");
    // The secret VALUE comes from stdin (never argv — no shell history), like `ob secret set`.
    const value = (await Bun.stdin.text()).trim();
    if (!value) {
      throw new UsageError(
        "test-user add: no secret value on stdin (pipe it in, e.g. `pbpaste | ob test-user add <label>`)",
      );
    }
    // Resolve the key before the row exists, so a refused key leaves no orphan row (OB-1911).
    const key = (await masterKeyForWrite(ctx.store)).get();
    const row = await addTestUserFor(ctx.store, {
      label,
      role: flag(ctx, "role"),
      email: flag(ctx, "email"),
      workspace: flag(ctx, "workspace"),
      env: flag(ctx, "env"),
      secretRef: flag(ctx, "secret-ref"),
      notes: flag(ctx, "notes"),
    });
    await setTestUserSecret(ctx.store, ctx.store, label, value, key);
    if (ctx.mode === "json") {
      print(JSON.stringify({ id: row.id, label: row.label, secret_ref: row.secret_ref }));
    } else if (ctx.mode === "quiet") {
      print(String(row.id));
    } else {
      print(`${row.id}\t${row.label}\t(secret stored: ${row.secret_ref})`);
    }
    return;
  }

  if (sub === "list") {
    const rows = await listTestUsersFor(ctx.store, { role: flag(ctx, "role"), env: flag(ctx, "env") });
    const present = new Map<string, boolean>();
    for (const r of rows) present.set(r.label, await testUserSecretPresent(ctx.store, ctx.store, r.label));
    if (ctx.mode === "json") {
      print(
        JSON.stringify(
          rows.map((r) => ({ ...r, secret_present: present.get(r.label) ?? false })),
          null,
          2,
        ),
      );
      return;
    }
    if (ctx.mode === "quiet") {
      print(rows.map((r) => r.label).join("\n"));
      return;
    }
    print(
      rows
        .map((r) => {
          const secret = present.get(r.label) ? "yes" : "no";
          return `${r.label}\t${r.role ?? ""}\t${r.email ?? ""}\t${r.workspace ?? ""}\t${r.env ?? ""}\tsecret:${secret}`;
        })
        .join("\n"),
    );
    return;
  }

  if (sub === "show") {
    const label = ctx.args[1];
    if (!label) throw new UsageError("test-user show requires a <label>");
    const row = await getTestUserFor(ctx.store, label);
    if (!row) throw new AppError(`no test-user with label '${label}'`);
    const present = await testUserSecretPresent(ctx.store, ctx.store, label);
    const staleness = secretStaleness(row.secret_set_at);
    if (ctx.mode === "json") {
      print(JSON.stringify({ ...row, secret_present: present, staleness }, null, 2));
      return;
    }
    const lines = [
      `id:            ${row.id}`,
      `label:         ${row.label}`,
      `role:          ${row.role ?? ""}`,
      `email:         ${row.email ?? ""}`,
      `workspace:     ${row.workspace ?? ""}`,
      `env:           ${row.env ?? ""}`,
      `secret_ref:    ${row.secret_ref ?? ""}`,
      `secret_present: ${present ? "yes" : "no"}`,
      `secret_set_at: ${row.secret_set_at ?? "(unknown)"}`,
      `last_used:     ${row.last_used ?? ""}`,
      `notes:         ${row.notes ?? ""}`,
    ];
    if (staleness) lines.push(`⚠ ${staleness}`);
    print(lines.join("\n"));
    return;
  }

  if (sub === "check") {
    const label = ctx.args[1];
    if (!label) throw new UsageError("test-user check requires a <label>");
    const row = await getTestUserFor(ctx.store, label);
    if (!row) throw new AppError(`no test-user with label '${label}'`);
    const ref = row.secret_ref ?? defaultSecretRef(row.label);
    const present = await testUserSecretPresent(ctx.store, ctx.store, label);
    if (present && row.secret_set_at === null) {
      await recordSecretSeenFor(ctx.store, row.label);
    }
    if (ctx.mode === "json") {
      print(JSON.stringify({ label: row.label, secret_ref: ref, secret_present: present }));
      return;
    }
    print(`${row.label}: store secret '${ref}' ${present ? "present" : "absent"}`);
    return;
  }

  throw new UsageError(`unknown test-user subcommand '${sub ?? ""}' (add|list|show|check)`);
}
