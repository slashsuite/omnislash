import type { Database } from "bun:sqlite";
import { asc, desc, eq } from "drizzle-orm";
import type { Ctx } from "../ctx.ts";
import { UsageError, AppError } from "../errors.ts";
import { print } from "../output.ts";
import { nowIso } from "../db.ts";
import { orm } from "../db/orm.ts";
import { asStore, type Store } from "../db/store.ts";
import { person } from "../db/schema.ts";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface PersonRow {
  id: number;
  real_name: string;
  role: string | null;
  github_login: string | null;
  linear_user_id: string | null;
  linear_name: string | null;
  slack_user_id: string | null;
  slack_handle: string | null;
  whatsapp_jid: string | null;
  email: string | null;
  notes: string | null;
  relationship: string | null;
  comms_style: string | null;
  comms_notes: string | null;
  id_number: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonFields {
  role?: string | null;
  github_login?: string | null;
  linear_user_id?: string | null;
  linear_name?: string | null;
  slack_user_id?: string | null;
  slack_handle?: string | null;
  whatsapp_jid?: string | null;
  email?: string | null;
  notes?: string | null;
  relationship?: string | null;
  comms_style?: string | null;
  comms_notes?: string | null;
  id_number?: string | null;
}

// The handles the schema guarantees unique (partial-unique index, one per person).
const KEY_COLUMNS = ["github_login", "linear_user_id", "slack_user_id"] as const;

// Key-handle name → its Drizzle column (the conflict-check targets).
const KEY_COLUMN_MAP = {
  github_login: person.github_login,
  linear_user_id: person.linear_user_id,
  slack_user_id: person.slack_user_id,
} as const;

// CLI flag → column. role/email/notes reuse existing global flags.
const FLAG_MAP: ReadonlyArray<readonly [string, keyof PersonFields]> = [
  ["role", "role"],
  ["github", "github_login"],
  ["linear", "linear_user_id"],
  ["linear-name", "linear_name"],
  ["slack", "slack_user_id"],
  ["slack-handle", "slack_handle"],
  ["whatsapp-jid", "whatsapp_jid"],
  ["email", "email"],
  ["notes", "notes"],
  ["relationship", "relationship"],
  ["comms-style", "comms_style"],
  ["comms-notes", "comms_notes"],
  ["id-number", "id_number"],
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Display label for a person: "Real Name (role)" or just the name. Pure. */
export function personDisplay(p: PersonRow): string {
  return p.role ? `${p.real_name} (${p.role})` : p.real_name;
}

/**
 * Mask an identity number down to its last four digits (`...1083`). Pure.
 *
 * Enough to confirm you are looking at the right person's record, not enough to reuse. This is the
 * DEFAULT rendering everywhere — text and JSON, `show` and `whois` — because the realistic leak for
 * this value is an agent transcript or a screenshot, not the DB file (which is never in git). The
 * full number is printed only when the caller asks for it with `--reveal`.
 */
export function maskIdNumber(value: string | null): string | null {
  if (value == null) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) return null;
  return `...${digits.slice(-4)}`;
}

/**
 * A person as it is safe to print: `id_number` replaced by its masked form unless `reveal`. Pure.
 * Every output path funnels through this, so a new command cannot leak the number by forgetting to.
 */
export function redactPerson(p: PersonRow, reveal = false): PersonRow {
  if (reveal) return p;
  return { ...p, id_number: maskIdNumber(p.id_number) };
}

/** Normalize a handle for comparison: trim, drop a leading @, lowercase. Pure. */
export function normHandle(s: string): string {
  return s.trim().replace(/^@/, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export function getPerson(db: Database, id: number): PersonRow | null {
  return (orm(db).select().from(person).where(eq(person.id, id)).get() as PersonRow | undefined) ?? null;
}

export function listPersons(db: Database): PersonRow[] {
  // `id` breaks the tie so two people sharing a real_name keep a stable order (and the same one the
  // store-aware `listPersonsFor` produces on either engine).
  return orm(db).select().from(person).orderBy(asc(person.real_name), asc(person.id)).all() as PersonRow[];
}

/**
 * Resolve any handle — GitHub login, Linear id/name, Slack id/handle, or email —
 * to the person that owns it, case-insensitively (@-prefix tolerated). Returns
 * null when unmapped. This is enrichment only: callers must fall back to the raw
 * handle, never gate behaviour on a hit (the registry is hand-maintained and may lag).
 */
export function resolvePerson(db: Database, handle: string): PersonRow | null {
  return matchPersonByHandle(listPersons(db), handle);
}

/**
 * The store-aware form of `listPersons()` (337). `real_name` is NOT NULL on both engines, so ASC over it
 * cannot meet the NULLS-FIRST (Postgres) vs NULLS-LAST (SQLite) split; `id` breaks ties so two people who
 * share a name do not swap places between engines.
 */
export async function listPersonsFor(db: Database | Store): Promise<PersonRow[]> {
  const s = asStore(db);
  return (await s.q.select().from(s.t.person).orderBy(asc(s.t.person.real_name), asc(s.t.person.id))) as PersonRow[];
}

/**
 * The store-aware form of `resolvePerson()` (337) -- `ob status` resolves every journal entry's `about`
 * handle through it. Both forms share the pure `matchPersonByHandle`, so an engine can only change where
 * the rows came from, never which person a handle resolves to.
 */
export async function resolvePersonFor(db: Database | Store, handle: string): Promise<PersonRow | null> {
  return matchPersonByHandle(await listPersonsFor(db), handle);
}

/** The match rule itself: first person carrying `handle` on any of its identity columns. Pure. */
function matchPersonByHandle(people: PersonRow[], handle: string): PersonRow | null {
  const h = normHandle(handle);
  if (!h) return null;
  for (const p of people) {
    const candidates = [
      p.github_login,
      p.linear_user_id,
      p.linear_name,
      p.slack_user_id,
      p.slack_handle,
      p.whatsapp_jid,
      p.email,
    ];
    if (candidates.some((c) => c != null && normHandle(c) === h)) return p;
  }
  return null;
}

/** One person by id, from the store (337). */
export async function getPersonFor(db: Database | Store, id: number): Promise<PersonRow | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select()
    .from(s.t.person)
    .where(eq(s.t.person.id, id))
    .limit(1)) as PersonRow[];
  return rows[0] ?? null;
}

/**
 * Register a person, from the store (337).
 *
 * The uniqueness of github_login / linear_user_id / slack_user_id is enforced by three PARTIAL unique
 * indexes in the hand-written SQLite DDL (`WHERE <col> IS NOT NULL`), and the drizzle model cannot say
 * `WHERE`, so only `idx_person_linear` carries its predicate on the Postgres side today -- see the note
 * in the module header. This pre-check is what actually produces the friendly message either way, and it
 * is unchanged: it was never resting on the index.
 */
export async function addPersonFor(
  store: Store,
  realName: string,
  fields: PersonFields,
): Promise<PersonRow> {
  const people = await listPersonsFor(store);
  for (const col of KEY_COLUMNS) {
    const v = fields[col];
    if (!v) continue;
    const owner = people.find((p) => p[col] === v);
    if (owner) {
      throw new AppError(
        `${col} '${v}' already maps to ${personDisplay(owner)} (#${owner.id}); use \`ob person set\` to move it`,
      );
    }
  }
  const now = nowIso();
  const inserted = (await store.q
    .insert(store.t.person)
    .values({
      real_name: realName,
      role: fields.role ?? null,
      github_login: fields.github_login ?? null,
      linear_user_id: fields.linear_user_id ?? null,
      linear_name: fields.linear_name ?? null,
      slack_user_id: fields.slack_user_id ?? null,
      slack_handle: fields.slack_handle ?? null,
      whatsapp_jid: fields.whatsapp_jid ?? null,
      email: fields.email ?? null,
      notes: fields.notes ?? null,
      relationship: fields.relationship ?? null,
      comms_style: fields.comms_style ?? null,
      comms_notes: fields.comms_notes ?? null,
      id_number: fields.id_number ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning({ id: store.t.person.id })) as Array<{ id: number }>;
  return (await getPersonFor(store, inserted[0]!.id))!;
}

async function ownerOfKeyFor(
  db: Database | Store,
  column: (typeof KEY_COLUMNS)[number],
  value: string,
  exceptId?: number,
): Promise<PersonRow | null> {
  const people = await listPersonsFor(db);
  return people.find((p) => p[column] === value && p.id !== exceptId) ?? null;
}

async function assertNoKeyConflictFor(db: Database | Store, fields: PersonFields, exceptId?: number): Promise<void> {
  for (const col of KEY_COLUMNS) {
    const v = fields[col];
    if (!v) continue;
    const owner = await ownerOfKeyFor(db, col, v, exceptId);
    if (owner) {
      throw new AppError(
        `${col} '${v}' already maps to ${personDisplay(owner)} (#${owner.id}); use \`ob person set\` to move it`,
      );
    }
  }
}

/** Store-aware form of `setPerson` (456). `""` clears a field to NULL. */
export async function setPersonFor(db: Database | Store, id: number, fields: PersonFields): Promise<PersonRow> {
  const s = asStore(db);
  const existing = await getPersonFor(s, id);
  if (!existing) throw new AppError(`no person with id ${id}`);
  await assertNoKeyConflictFor(s, fields, id);
  const set: Partial<typeof s.t.person.$inferInsert> = {};
  for (const [, col] of FLAG_MAP) {
    if (col in fields && fields[col] !== undefined) {
      const v = fields[col];
      set[col] = v === "" ? null : (v ?? null);
    }
  }
  if (Object.keys(set).length === 0) return existing;
  set.updated_at = nowIso();
  await s.q.update(s.t.person).set(set).where(eq(s.t.person.id, id));
  return (await getPersonFor(s, id))!;
}

/** Store-aware form of `rmPerson` (456). */
export async function rmPersonFor(db: Database | Store, id: number): Promise<boolean> {
  const s = asStore(db);
  if (!(await getPersonFor(s, id))) return false;
  await s.q.delete(s.t.person).where(eq(s.t.person.id, id));
  return true;
}

/** A short identifying handle for candidate listings: first of gh/slack/email/linear/whatsapp, or "-". Pure. */
export function primaryHandle(p: PersonRow): string {
  return (
    p.github_login ??
    p.slack_handle ??
    p.email ??
    p.linear_name ??
    p.slack_user_id ??
    p.whatsapp_jid ??
    "-"
  );
}

/**
 * People whose `real_name` matches `name`, case-insensitively. An exact full-name match
 * (case-insensitive) wins outright; otherwise every substring match is returned. The caller
 * decides what to do with 0 / 1 / many. Name-only — never touches handles.
 */
/** People whose `real_name` matches `name`, case-insensitively. Pure over an already-loaded list. */
export function matchPersonsByNameIn(people: PersonRow[], name: string): PersonRow[] {
  const q = name.trim().toLowerCase();
  if (!q) return [];
  const exact = people.filter((p) => p.real_name.trim().toLowerCase() === q);
  if (exact.length > 0) return exact;
  return people.filter((p) => p.real_name.toLowerCase().includes(q));
}

export function matchPersonsByName(db: Database, name: string): PersonRow[] {
  return matchPersonsByNameIn(listPersons(db), name);
}

export async function matchPersonsByNameFor(db: Database | Store, name: string): Promise<PersonRow[]> {
  return matchPersonsByNameIn(await listPersonsFor(db), name);
}

/**
 * Resolve a `<person>` CLI argument to a single person, in order:
 *   1. numeric id, 2. exact handle (via `resolvePerson`), 3. name on `real_name` (new — #37).
 * Returns null when nothing matches (caller raises the not-found error). Throws `UsageError`
 * listing the candidates when a NAME is ambiguous, so the user re-runs with an id or handle.
 * This is the name-aware sibling of the handle-only `resolvePerson` — kept separate so enrichment
 * callers (ingest/status/report) never gain fuzzy name matching against external handles.
 */
export function resolvePersonArg(db: Database, key: string): PersonRow | null {
  if (/^\d+$/.test(key)) return getPerson(db, Number(key));

  const byHandle = resolvePerson(db, key);
  if (byHandle) return byHandle;

  const byName = matchPersonsByName(db, key);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    const lines = byName.map((p) => `  ${p.id} · ${p.real_name} · ${primaryHandle(p)}`).join("\n");
    throw new UsageError(
      `'${key}' matches ${byName.length} people; re-run with an id or handle:\n${lines}`,
    );
  }
  return null;
}

/** Store-aware form of `resolvePersonArg` (456). Same 1. id 2. handle 3. name order. */
export async function resolvePersonArgFor(db: Database | Store, key: string): Promise<PersonRow | null> {
  if (/^\d+$/.test(key)) return getPersonFor(db, Number(key));
  const byHandle = await resolvePersonFor(db, key);
  if (byHandle) return byHandle;
  const byName = await matchPersonsByNameFor(db, key);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    const lines = byName.map((p) => `  ${p.id} · ${p.real_name} · ${primaryHandle(p)}`).join("\n");
    throw new UsageError(
      `'${key}' matches ${byName.length} people; re-run with an id or handle:\n${lines}`,
    );
  }
  return null;
}

/** The person owning a key-handle value (excluding `exceptId`), or null. */
function ownerOfKey(db: Database, column: keyof typeof KEY_COLUMN_MAP, value: string, exceptId?: number): PersonRow | null {
  const rows = orm(db).select().from(person).where(eq(KEY_COLUMN_MAP[column], value)).all() as PersonRow[];
  for (const r of rows) if (r.id !== exceptId) return r;
  return null;
}

/** Reject a key handle already owned by someone else, with a friendly message. */
function assertNoKeyConflict(db: Database, fields: PersonFields, exceptId?: number): void {
  for (const col of KEY_COLUMNS) {
    const v = fields[col];
    if (v) {
      const owner = ownerOfKey(db, col, v, exceptId);
      if (owner) {
        throw new AppError(
          `${col} '${v}' already maps to ${personDisplay(owner)} (#${owner.id}); use \`ob person set\` to move it`,
        );
      }
    }
  }
}

export function addPerson(db: Database, realName: string, fields: PersonFields): PersonRow {
  assertNoKeyConflict(db, fields);
  const now = nowIso();
  const { id } = orm(db)
    .insert(person)
    .values({
      real_name: realName,
      role: fields.role ?? null,
      github_login: fields.github_login ?? null,
      linear_user_id: fields.linear_user_id ?? null,
      linear_name: fields.linear_name ?? null,
      slack_user_id: fields.slack_user_id ?? null,
      slack_handle: fields.slack_handle ?? null,
      whatsapp_jid: fields.whatsapp_jid ?? null,
      email: fields.email ?? null,
      notes: fields.notes ?? null,
      relationship: fields.relationship ?? null,
      comms_style: fields.comms_style ?? null,
      comms_notes: fields.comms_notes ?? null,
      id_number: fields.id_number ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning({ id: person.id })
    .get();
  return getPerson(db, id)!;
}

/** Update the provided fields; `""` clears a field to NULL, omitted leaves it unchanged. */
export function setPerson(db: Database, id: number, fields: PersonFields): PersonRow {
  const existing = getPerson(db, id);
  if (!existing) throw new AppError(`no person with id ${id}`);
  assertNoKeyConflict(db, fields, id);

  const set: Partial<typeof person.$inferInsert> = {};
  for (const [, col] of FLAG_MAP) {
    if (col in fields && fields[col] !== undefined) {
      const v = fields[col];
      set[col] = v === "" ? null : (v ?? null);
    }
  }
  if (Object.keys(set).length === 0) return existing;
  set.updated_at = nowIso();
  orm(db).update(person).set(set).where(eq(person.id, id)).run();
  return getPerson(db, id)!;
}

export function rmPerson(db: Database, id: number): boolean {
  const exists = orm(db).select({ id: person.id }).from(person).where(eq(person.id, id)).get();
  if (!exists) return false;
  orm(db).delete(person).where(eq(person.id, id)).run();
  return true;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Build person fields from flags. `allowClear` includes empty strings (to NULL a field on `set`). */
export function personFieldsFromFlags(flags: Record<string, unknown>, allowClear: boolean): PersonFields {
  const f: Record<string, string> = {};
  for (const [flagKey, col] of FLAG_MAP) {
    const v = flags[flagKey];
    if (typeof v !== "string") continue;
    if (v.length === 0 && !allowClear) continue;
    f[col] = v;
  }
  return f as PersonFields;
}

function fieldsFromFlags(ctx: Ctx, allowClear: boolean): PersonFields {
  return personFieldsFromFlags(ctx.flags as Record<string, unknown>, allowClear);
}

export function renderPersonShow(p: PersonRow, reveal: boolean): string {
  const idNumber = reveal ? (p.id_number ?? "") : (maskIdNumber(p.id_number) ?? "");
  return [
    `id:             ${p.id}`,
    `real_name:      ${p.real_name}`,
    `id_number:      ${idNumber}${p.id_number && !reveal ? "  (masked; --reveal for the full number)" : ""}`,
    `role:           ${p.role ?? ""}`,
    `github_login:   ${p.github_login ?? ""}`,
    `linear_user_id: ${p.linear_user_id ?? ""}`,
    `linear_name:    ${p.linear_name ?? ""}`,
    `slack_user_id:  ${p.slack_user_id ?? ""}`,
    `slack_handle:   ${p.slack_handle ?? ""}`,
    `whatsapp_jid:   ${p.whatsapp_jid ?? ""}`,
    `email:          ${p.email ?? ""}`,
    `notes:          ${p.notes ?? ""}`,
    `relationship:   ${p.relationship ?? ""}`,
    `comms_style:    ${p.comms_style ?? ""}`,
    `comms_notes:    ${p.comms_notes ?? ""}`,
  ].join("\n");
}

export function renderPersonList(rows: PersonRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.id}\t${r.real_name}\t${r.role ?? ""}\tgh:${r.github_login ?? "-"}\tlinear:${r.linear_name ?? r.linear_user_id ?? "-"}\tslack:${r.slack_handle ?? "-"}`,
    )
    .join("\n");
}

export async function cmdPerson(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  const store = ctx.store;

  if (sub === "add") {
    const realName = ctx.args[1];
    if (!realName) throw new UsageError('person add requires a "<real name>"');
    const row = await addPersonFor(store, realName, fieldsFromFlags(ctx, false));
    if (ctx.mode === "json") print(JSON.stringify({ id: row.id, real_name: row.real_name }));
    else if (ctx.mode === "quiet") print(String(row.id));
    else print(`${row.id}\t${personDisplay(row)}`);
    return;
  }

  if (sub === "set") {
    const id = Number(ctx.args[1]);
    if (!Number.isInteger(id)) throw new UsageError("person set requires a numeric <id>");
    const row = await setPersonFor(store, id, fieldsFromFlags(ctx, true));
    if (ctx.mode === "json") print(JSON.stringify({ id: row.id, real_name: row.real_name }));
    else print(`${row.id}\t${personDisplay(row)}`);
    return;
  }

  if (sub === "list") {
    const rows = (await listPersonsFor(store)).map((r) => redactPerson(r));
    if (ctx.mode === "json") {
      print(JSON.stringify(rows, null, 2));
    } else if (ctx.mode === "quiet") {
      print(rows.map((r) => r.real_name).join("\n"));
    } else {
      print(renderPersonList(rows));
    }
    return;
  }

  if (sub === "show") {
    const key = ctx.args[1];
    if (!key) throw new UsageError("person show requires an <id>, <handle>, or <name>");
    const p = await resolvePersonArgFor(store, key);
    if (!p) throw new AppError(`no person matches '${key}'`);
    const reveal = ctx.flags.reveal === true;
    if (ctx.mode === "json") print(JSON.stringify(redactPerson(p, reveal), null, 2));
    else print(renderPersonShow(p, reveal));
    return;
  }

  if (sub === "rm") {
    const id = Number(ctx.args[1]);
    if (!Number.isInteger(id)) throw new UsageError("person rm requires a numeric <id>");
    if (!(await rmPersonFor(store, id))) throw new AppError(`no person with id ${id}`);
    if (ctx.mode !== "quiet") print(`removed person ${id}`);
    return;
  }

  throw new UsageError(`unknown person subcommand '${sub ?? ""}' (add|set|list|show|rm)`);
}

/** Terse resolver: any handle → the person (real_name + role). Exit 1 when unmapped. */
export async function cmdWhois(ctx: Ctx): Promise<void> {
  const handle = ctx.args[0];
  if (!handle) throw new UsageError("whois requires a <handle>");
  const p = await resolvePersonFor(ctx.store, handle);
  if (!p) {
    if (ctx.mode === "json") print("null");
    throw new AppError(`no person matches '${handle}'`);
  }
  if (ctx.mode === "json") print(JSON.stringify(redactPerson(p), null, 2));
  else if (ctx.mode === "quiet") print(p.real_name);
  else print(personDisplay(p));
}
