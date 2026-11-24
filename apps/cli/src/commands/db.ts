import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import type { Ctx } from "../ctx.ts";
import { UsageError, AppError } from "../errors.ts";
import { print } from "../output.ts";
import { ARTIFACT_SUFFIX, capture, describeCapture, restoreHint } from "../db/capture.ts";
import { settingFor } from "../settings.ts";
import type { Store } from "../db/store.ts";
import { masterKeyFilePath } from "../secrets.ts";
import { storedGithubToken } from "../net.ts";
import { WEB_TLS_KEY_ENV, installedTlsPathsFor, tlsPathsFor } from "../web-tls.ts";

const RETAIN_MONTHS = 12;
const MASTER_KEY_FILE_NAME = "master.key";
/** ob 220: the dashboard's TLS private key, by its installed name and by shape. */
const TLS_KEY_FILE_NAME = "privkey.pem";

// ---------------------------------------------------------------------------
// Pure, unit-testable logic
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local-date stamp YYYY-MM-DD. */
export function localDateStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local-month stamp YYYY-MM. */
export function monthStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/**
 * Dated snapshot filename for a backup taken on `d` (local date). Pure.
 *
 * 337: `.dump`, not `.sqlite`. The suffix is the format, and a restore begins with a human finding this
 * file in a release a year later and deciding what to do with it.
 */
export function snapshotFileName(d: Date): string {
  return `omnislash-${localDateStamp(d)}${ARTIFACT_SUFFIX}`;
}

/** Per-month release tag db-backup-YYYY-MM (local month). Pure. */
export function releaseTag(d: Date): string {
  return `db-backup-${monthStamp(d)}`;
}

/** Parse a db-backup-YYYY-MM tag; null if it doesn't match. Pure. */
export function parseBackupTag(tag: string): { year: number; month: number } | null {
  const m = tag.match(/^db-backup-(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/**
 * Which db-backup-* tags are old enough to prune. Age is measured in whole
 * months from `now`'s month; a tag exactly `keepMonths` months old is pruned,
 * so retention keeps the most recent `keepMonths` months (current included).
 * Tags that aren't db-backup-YYYY-MM are ignored. Pure.
 */
export function prunableTags(tags: string[], now: Date, keepMonths = RETAIN_MONTHS): string[] {
  const nowIdx = monthIndex(now.getFullYear(), now.getMonth() + 1);
  return tags.filter((t) => {
    const p = parseBackupTag(t);
    if (!p) return false;
    return nowIdx - monthIndex(p.year, p.month) >= keepMonths;
  });
}

/** gh release create — new per-month prerelease with the snapshot attached. Pure. */
export function createCmd(repo: string, tag: string, snapshot: string, title: string, notes: string): string[] {
  return ["gh", "release", "create", tag, snapshot, "--repo", repo, "--prerelease", "--title", title, "--notes", notes];
}

/** gh release upload — attach (clobbering) the snapshot to an existing release. Pure. */
export function uploadCmd(repo: string, tag: string, snapshot: string): string[] {
  return ["gh", "release", "upload", tag, snapshot, "--repo", repo, "--clobber"];
}

/**
 * The backup ships the DB, whose `secret` rows are ciphertext only. NO PRIVATE KEY may ride along in
 * the same artifact.
 *
 *  - the secret-store master key (182): DB plus key in one release makes the encryption decorative.
 *  - the dashboard's TLS private key (220): it is the identity of the name the tokens page is served
 *    under, and a copy of it in a GitHub release (private or not) is a copy that outlives the box.
 *
 * Cheap and total: every staged asset is checked, by configured path AND by shape, so a future change
 * to what gets staged trips this (and its test) rather than shipping key material. Pure.
 */
export function assertNoKeyMaterialInBackup(
  assets: string[],
  keyFiles: { masterKey: string | null; tlsKeys?: string[] },
): void {
  const tlsKeys = keyFiles.tlsKeys ?? [];
  const sameFile = (asset: string, path: string | null | undefined): boolean =>
    path != null && path !== "" && resolve(asset) === resolve(path);
  for (const asset of assets) {
    const name = basename(asset);
    if (sameFile(asset, keyFiles.masterKey) || name === MASTER_KEY_FILE_NAME) {
      throw new AppError(
        `refusing to back up ${asset}: that is the secret-store master key, and shipping it with the DB would make the encryption decorative. Keep the key out of the backup artifact`,
      );
    }
    // `.key` by extension as well as the installed name: lego's own copy of the same key is
    // <domain>.key, and a private key is refused by shape rather than by the one path we happen to know.
    if (tlsKeys.some((k) => sameFile(asset, k)) || name === TLS_KEY_FILE_NAME || name.endsWith(".key")) {
      throw new AppError(
        `refusing to back up ${asset}: that is a TLS private key, and a copy of it in a release outlives the machine it was issued for. Keep the key out of the backup artifact`,
      );
    }
  }
}

/**
 * Both TLS key paths the backup must never carry (OB-1933): the served key and the installed one, from
 * the one resolver. A half-configured served pair throws there; a backup must not fail on a TLS typo,
 * so it falls back to the installed key plus whichever served key half was set.
 */
export async function backupTlsKeyPaths(store: Store): Promise<string[]> {
  try {
    const { served, installed } = await tlsPathsFor(store);
    return [served?.keyPath, installed?.keyPath].filter((k): k is string => !!k);
  } catch {
    const installed = await installedTlsPathsFor(store);
    const halfKey = (process.env[WEB_TLS_KEY_ENV] ?? "").trim() || (await settingFor(store, "web_tls_key")).trim();
    return [halfKey, installed?.keyPath].filter((k): k is string => !!k);
  }
}

/** gh release delete — drop an aged-out release and its tag. Pure. */
export function deleteCmd(repo: string, tag: string): string[] {
  return ["gh", "release", "delete", tag, "--repo", repo, "--yes", "--cleanup-tag"];
}

// ---------------------------------------------------------------------------
// 200: the local point-in-time history (`ob db snapshot`)
//
// ob 181 promised an hourly `zfs snapshot` of the ob dataset. The host serves its guests from
// LVM-thin, not ZFS, so there was never a dataset to snapshot. This is the replacement for the common
// failure -- a bad write, a bad migration, a fat-fingered `ob rm` -- and it is deliberately a
// CONSISTENT LOGICAL copy (337: `pg_dump --format=custom`, the form pg_restore can pull one table out
// of) rather than a block image. It lives on the same volume as the database and therefore protects
// against nothing that loses the volume; that is the host-side weekly `vzdump` backup job,
// which lands on the archive pool's separate disk, and the basebackup + WAL archive on the database host is what
// makes point-in-time recovery possible between snapshots.
// ---------------------------------------------------------------------------

/** What `snapshotName` writes, and the only prefix rotation ever prunes or counts. */
export const SNAPSHOT_PREFIX = "omnislash-snap-";
/**
 * What a host still running pre-rename code writes (OS-161). These are listed and fetchable but never
 * rotated: a shim while such a host exists, so nothing here deletes the history it wrote.
 */
export const LEGACY_SNAPSHOT_PREFIX = "omnibus-snap-";
const SNAPSHOT_SUFFIX = ARTIFACT_SUFFIX;
/** The most recent N snapshots are kept whatever their age: the hourly window. */
export const SNAPSHOT_KEEP_HOURLY = 24;
/** Beyond that window, the newest surviving snapshot from each of the next N distinct days. */
export const SNAPSHOT_KEEP_DAILY = 7;
/** A ceiling on what the whole directory may occupy, so rotation cannot fill the data volume. */
export const SNAPSHOT_MAX_BYTES = 2 * 1024 ** 3;
/** Free space that must remain on the volume AFTER writing the new snapshot. */
export const SNAPSHOT_RESERVE_BYTES = 512 * 1024 ** 2;

/** Snapshot filename for a copy taken at `d` (local time). Pure. */
export function snapshotName(d: Date): string {
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `${SNAPSHOT_PREFIX}${date}-${time}${SNAPSHOT_SUFFIX}`;
}

const SNAPSHOT_NAME_RE = new RegExp(
  `^(${SNAPSHOT_PREFIX}|${LEGACY_SNAPSHOT_PREFIX})(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})\\${SNAPSHOT_SUFFIX}$`,
);

/**
 * When a snapshot filename says it was taken, and under which prefix; null if the name is not one of
 * ours. Both `SNAPSHOT_PREFIX` and `LEGACY_SNAPSHOT_PREFIX` names parse, so a legacy snapshot can be
 * listed and fetched; rotation then drops every `prefix` that is not `SNAPSHOT_PREFIX`. A file a human
 * dropped in the directory parses as null and is never deleted. Pure.
 */
export function parseSnapshot(name: string): { taken: Date; prefix: string } | null {
  const m = SNAPSHOT_NAME_RE.exec(name);
  if (!m) return null;
  const prefix = m[1]!;
  const [y, mo, d, h, mi, s] = m.slice(2).map(Number) as [number, number, number, number, number, number];
  const taken = new Date(y, mo - 1, d, h, mi, s);
  if (taken.getFullYear() !== y || taken.getMonth() !== mo - 1 || taken.getDate() !== d) return null;
  if (taken.getHours() !== h || taken.getMinutes() !== mi || taken.getSeconds() !== s) return null;
  return { taken, prefix };
}

/**
 * When a snapshot filename says it was taken; null if the name is not one of ours. Accepts both the
 * current and the legacy (`omnibus-snap-`) prefix: this is the predicate for reading and fetching.
 * Rotation does not use it alone, see `planSnapshotRotation`. Pure.
 */
export function parseSnapshotName(name: string): Date | null {
  return parseSnapshot(name)?.taken ?? null;
}

export interface SnapshotEntry {
  name: string;
  bytes: number;
  taken: Date;
  /** The snapshot about to be written. Never pruned, and its bytes are a cost rather than a saving. */
  pending?: boolean;
}

export interface RotationPolicy {
  keepHourly?: number;
  keepDaily?: number;
  maxBytes?: number;
  /** Bytes free on the volume right now. Omit to skip the free-space pass entirely. */
  freeBytes?: number;
  reserveBytes?: number;
}

export interface RotationPlan {
  /** Newest first. */
  keep: SnapshotEntry[];
  /** Oldest first, which is the order to delete in. */
  prune: SnapshotEntry[];
  /** Bytes still missing after pruning everything prunable. Non-zero means the write cannot be made. */
  shortfallBytes: number;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function totalBytes(entries: SnapshotEntry[]): number {
  return entries.reduce((sum, e) => sum + e.bytes, 0);
}

/**
 * Which snapshots survive and which are pruned, in three passes:
 *
 *  1. AGE. The newest `keepHourly` are kept outright, then the newest survivor of each of the next
 *     `keepDaily` distinct days. Anything older is pruned.
 *  2. BUDGET. If what survives exceeds `maxBytes`, the oldest are dropped until it fits.
 *  3. FREE SPACE. If writing the pending snapshot would leave less than `reserveBytes` free, the
 *     oldest survivors are dropped until it would not.
 *
 * Only `SNAPSHOT_PREFIX` names (and the pending entry) take part. A legacy `omnibus-snap-` entry is
 * dropped before the first pass: it is never pruned, never kept, and never counted toward `maxBytes`.
 *
 * The newest entry is never pruned by 2 or 3, so the plan always keeps at least one snapshot and never
 * prunes the one about to be written. `shortfallBytes` is what is still missing when even that is not
 * enough, which is the caller's cue to fail loudly rather than write into a full volume. Pure.
 */
export function planSnapshotRotation(entries: SnapshotEntry[], policy: RotationPolicy = {}): RotationPlan {
  const keepHourly = Math.max(1, policy.keepHourly ?? SNAPSHOT_KEEP_HOURLY);
  const keepDaily = Math.max(0, policy.keepDaily ?? SNAPSHOT_KEEP_DAILY);
  const maxBytes = policy.maxBytes ?? SNAPSHOT_MAX_BYTES;

  const ordered = entries.filter((e) => e.pending || parseSnapshot(e.name)?.prefix === SNAPSHOT_PREFIX).sort(
    (a, b) => b.taken.getTime() - a.taken.getTime() || b.name.localeCompare(a.name),
  );
  const keep = ordered.slice(0, keepHourly);
  const days = new Set<string>();
  for (const entry of ordered.slice(keepHourly)) {
    const key = dayKey(entry.taken);
    if (days.has(key)) continue;
    if (days.size >= keepDaily) break;
    days.add(key);
    keep.push(entry);
  }
  keep.sort((a, b) => b.taken.getTime() - a.taken.getTime() || b.name.localeCompare(a.name));

  const kept = new Set(keep.map((e) => e.name));
  const prune = ordered.filter((e) => !kept.has(e.name));

  while (keep.length > 1 && totalBytes(keep) > maxBytes && !keep[keep.length - 1]!.pending) {
    prune.push(keep.pop()!);
  }

  let shortfallBytes = 0;
  if (policy.freeBytes !== undefined) {
    const reserve = policy.reserveBytes ?? SNAPSHOT_RESERVE_BYTES;
    const needed = totalBytes(keep.filter((e) => e.pending));
    let free = policy.freeBytes + totalBytes(prune.filter((e) => !e.pending));
    while (keep.length > 1 && free - needed < reserve && !keep[keep.length - 1]!.pending) {
      const dropped = keep.pop()!;
      prune.push(dropped);
      free += dropped.bytes;
    }
    shortfallBytes = Math.max(0, reserve - (free - needed));
  }

  prune.sort((a, b) => a.taken.getTime() - b.taken.getTime() || a.name.localeCompare(b.name));
  return { keep, prune, shortfallBytes };
}

/** Render a byte count for a human. Pure. */
export function fmtBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/** Render an argv as a copy-pasteable shell command (single-quoting where needed). Pure. */
export function fmtCmd(cmd: string[]): string {
  return cmd.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

// ---------------------------------------------------------------------------
// Process side-effects
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string[], env?: GhEnv): RunResult {
  try {
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
    const dec = new TextDecoder();
    return {
      ok: proc.exitCode === 0,
      code: proc.exitCode,
      stdout: dec.decode(proc.stdout).trim(),
      stderr: dec.decode(proc.stderr).trim(),
    };
  } catch (err) {
    return { ok: false, code: null, stdout: "", stderr: (err as Error).message };
  }
}

export type GhEnv = Record<string, string | undefined>;

function envHasGithubToken(env: GhEnv): boolean {
  return Boolean(env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim());
}

/**
 * Fail if gh is missing or unauthenticated; return the env every later gh call must run with.
 * GH_TOKEN / GITHUB_TOKEN count (ob 550): `gh auth status` ignores them and looks at
 * ~/.config/gh/hosts.yml, which the server must not have. Subsequent `gh repo view` /
 * `gh release` pick the env token up themselves.
 * ob 1575: when neither is set and gh has no login, the `github` token from the ob secret
 * store is handed to gh as GH_TOKEN in the returned env, for this run's gh calls only. It is
 * never printed, logged or written anywhere. Inject env/which/run/secret in tests; never hit
 * a live host.
 */
export async function ensureGh(opts?: {
  env?: GhEnv;
  which?: (bin: string) => string | null;
  run?: (cmd: string[]) => RunResult;
  secret?: () => Promise<string | null>;
}): Promise<GhEnv | undefined> {
  const env = opts?.env ?? process.env;
  const which = opts?.which ?? ((bin) => Bun.which(bin) ?? null);
  const runCmd = opts?.run ?? ((cmd: string[]) => run(cmd));
  if (!which("gh")) {
    throw new AppError("gh CLI not found on PATH — install the GitHub CLI");
  }
  if (envHasGithubToken(env)) return undefined;
  const r = runCmd(["gh", "auth", "status"]);
  if (r.code === null) {
    throw new AppError("gh CLI not found on PATH — install the GitHub CLI");
  }
  if (r.ok) return undefined;
  const token = (await opts?.secret?.())?.trim();
  if (token) return { ...env, GH_TOKEN: token };
  throw new AppError(
    `gh is not authenticated: ${r.stderr || "no gh login"} — store a token with \`ob secret set github\`, set GH_TOKEN or GITHUB_TOKEN, or run \`gh auth login\``,
  );
}

function repoIsPrivate(repo: string, env?: GhEnv): boolean {
  const r = run(["gh", "repo", "view", repo, "--json", "isPrivate", "-q", ".isPrivate"], env);
  if (!r.ok) throw new AppError(`gh repo view ${repo} failed: ${r.stderr || "check the repo name and gh auth"}`);
  return r.stdout.trim() === "true";
}

function listBackupReleaseTags(repo: string, env?: GhEnv): string[] {
  const r = run(["gh", "release", "list", "--repo", repo, "--limit", "1000", "--json", "tagName", "-q", ".[].tagName"], env);
  if (!r.ok) throw new AppError(`gh release list failed: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((t) => t.startsWith("db-backup-"));
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Top-level `ob backup`. */
export async function cmdBackup(ctx: Ctx): Promise<void> {
  await backup(ctx);
}

/** `ob db backup` (alias for `ob backup`) and `ob db snapshot` (200). */
export async function cmdDb(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === "backup") {
    await backup(ctx);
    return;
  }
  if (sub === "snapshot") {
    snapshot(ctx);
    return;
  }
  throw new UsageError(`unknown db subcommand '${sub ?? ""}' (backup, snapshot)`);
}

/**
 * Where snapshots live. It used to be derived from the database FILE's directory, which Postgres does
 * not have: the database is on the database host and this command runs wherever `ob` does. So the default is the
 * same data directory the rest of ob's local state uses, and `--dir` / OMNISLASH_SNAPSHOT_DIR still win.
 */
export function snapshotDirFor(flag?: unknown): string {
  const explicit = typeof flag === "string" ? flag : undefined;
  return resolve(
    explicit ?? process.env.OMNISLASH_SNAPSHOT_DIR ?? join(homedir(), ".local", "share", "omnislash", "snapshots"),
  );
}

function numberFlag(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number`);
  return n;
}

/** Existing snapshots in `dir`, ours only, with their sizes. */
function readSnapshots(dir: string): SnapshotEntry[] {
  if (!existsSync(dir)) return [];
  const entries: SnapshotEntry[] = [];
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    if (!file.isFile()) continue;
    const taken = parseSnapshotName(file.name);
    if (!taken) continue;
    entries.push({ name: file.name, bytes: statSync(join(dir, file.name)).size, taken });
  }
  return entries;
}

/** Bytes free on the volume holding `path`, or its nearest existing ancestor. */
function freeBytes(path: string): number {
  let probe = path;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return 0;
    probe = parent;
  }
  const fs = statfsSync(probe);
  return Number(fs.bsize) * Number(fs.bavail);
}

/**
 * How large the next dump is likely to be, with no database file to measure (337).
 *
 * The SQLite form measured the file plus its -wal. A logical dump has no such handle on its own size in
 * advance, so the estimate is the LARGEST recent snapshot: dumps of the same database grow slowly and
 * monotonically, so the newest ones bound the next one closely, and over-estimating is the safe
 * direction (it prunes one extra file, where under-estimating fills the volume). With no history at all
 * the estimate is 0 and the space check is carried by the reserve alone, which is the honest answer:
 * nothing is known yet.
 */
export function estimateNextSnapshotBytes(existing: SnapshotEntry[]): number {
  const recent = [...existing].sort((a, b) => b.taken.getTime() - a.taken.getTime()).slice(0, 3);
  return recent.reduce((max, e) => Math.max(max, e.bytes), 0);
}

function snapshot(ctx: Ctx): void {
  const dir = snapshotDirFor(ctx.flags.dir);
  const existing = readSnapshots(dir);

  if (ctx.flags.list === true) {
    const ordered = [...existing].sort((a, b) => b.taken.getTime() - a.taken.getTime());
    if (ctx.mode === "json") {
      print(
        JSON.stringify(
          {
            dir,
            bytes: existing.reduce((sum, e) => sum + e.bytes, 0),
            snapshots: ordered.map((e) => ({ name: e.name, bytes: e.bytes, taken: e.taken.toISOString() })),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (ordered.length === 0) {
      print(`no snapshots in ${dir}`);
      return;
    }
    for (const e of ordered) print(`${e.name}  ${fmtBytes(e.bytes)}  ${e.taken.toISOString()}`);
    print(`${ordered.length} snapshot(s), ${fmtBytes(existing.reduce((sum, e) => sum + e.bytes, 0))} in ${dir}`);
    return;
  }

  const now = new Date();
  const name = snapshotName(now);
  const estimate = estimateNextSnapshotBytes(existing);
  const policy: RotationPolicy = {
    keepHourly: numberFlag(ctx.flags["keep-hourly"], "keep-hourly", SNAPSHOT_KEEP_HOURLY),
    keepDaily: numberFlag(ctx.flags["keep-daily"], "keep-daily", SNAPSHOT_KEEP_DAILY),
    maxBytes: numberFlag(ctx.flags["max-bytes"], "max-bytes", SNAPSHOT_MAX_BYTES),
    freeBytes: freeBytes(dir),
  };
  const pending: SnapshotEntry = { name, bytes: estimate, taken: now, pending: true };
  // A second run inside the same second writes the same name. Dropping the existing entry keeps it out
  // of the plan twice over: the rename replaces the file, so counting it as both kept and pending would
  // charge the volume for a copy that is about to be overwritten.
  const plan = planSnapshotRotation([...existing.filter((e) => e.name !== name), pending], policy);

  if (ctx.flags["dry-run"] === true) {
    const payload = {
      dryRun: true,
      dir,
      snapshot: name,
      bytes: estimate,
      freeBytes: policy.freeBytes,
      wouldKeep: plan.keep.map((e) => e.name),
      wouldPrune: plan.prune.map((e) => e.name),
      shortfallBytes: plan.shortfallBytes,
    };
    if (ctx.mode === "json") {
      print(JSON.stringify(payload, null, 2));
      return;
    }
    print(`[dry-run] ${describeCapture(join(dir, name))} (about ${fmtBytes(estimate)})`);
    print(`[dry-run] ${fmtBytes(policy.freeBytes ?? 0)} free on the volume`);
    print(`[dry-run] would keep ${plan.keep.length}, prune ${plan.prune.length}`);
    for (const e of plan.prune) print(`  prune ${e.name} (${fmtBytes(e.bytes)})`);
    if (plan.shortfallBytes > 0) print(`[dry-run] SHORT by ${fmtBytes(plan.shortfallBytes)}: this would refuse`);
    return;
  }

  // Prune BEFORE writing: the space the new snapshot needs is the space the old ones are holding, and
  // a rotation that only runs after a successful write cannot help a volume that is already full.
  mkdirSync(dir, { recursive: true });
  const pruned: string[] = [];
  for (const entry of plan.prune) {
    rmSync(join(dir, entry.name), { force: true });
    pruned.push(entry.name);
  }

  if (plan.shortfallBytes > 0) {
    throw new AppError(
      `refusing to snapshot: ${dir} needs about ${fmtBytes(estimate)} plus ${fmtBytes(SNAPSHOT_RESERVE_BYTES)} kept free, ` +
        `and is short by ${fmtBytes(plan.shortfallBytes)} after pruning ${pruned.length} snapshot(s). ` +
        `Free space on the volume, or lower --max-bytes/--keep-hourly`,
    );
  }

  // Written under a scratch name and renamed, so an interrupted run leaves nothing that parses as a
  // snapshot: a half-copied file that rotation counts as history is worse than no file at all.
  const scratch = join(dir, `.${name}.partial`);
  rmSync(scratch, { force: true });
  try {
    capture({ dest: scratch });
    renameSync(scratch, join(dir, name));
  } catch (err) {
    rmSync(scratch, { force: true });
    throw new AppError(`snapshot failed: ${(err as Error).message}`);
  }
  const bytes = statSync(join(dir, name)).size;

  if (ctx.mode === "json") {
    print(
      JSON.stringify(
        { dir, snapshot: name, bytes, kept: plan.keep.map((e) => e.name), pruned, freeBytes: freeBytes(dir) },
        null,
        2,
      ),
    );
    return;
  }
  print(`snapshot ${name} (${fmtBytes(bytes)}) → ${dir}`);
  print(`kept ${plan.keep.length}, pruned ${pruned.length}, ${fmtBytes(freeBytes(dir))} free`);
  print(restoreHint(join(dir, name)));
}

async function backup(ctx: Ctx): Promise<void> {
  const dryRun = ctx.flags["dry-run"] === true;
  const repo = await settingFor(ctx.store ?? ctx.db, "backup_repo");
  if (!repo) throw new AppError("no backup_repo configured — set it with `ob config set backup_repo <owner/repo>`");

  const ghEnv = await ensureGh({ secret: () => storedGithubToken(ctx.store) });

  const now = new Date();
  const fileName = snapshotFileName(now);
  const tag = releaseTag(now);
  const title = `OmniSlash DB backup ${monthStamp(now)}`;
  const notes = `Automated monthly OmniSlash backup: DB snapshot (${fileName}). Private prerelease assets; pruned after ${RETAIN_MONTHS} months.`;

  const tmpDir = mkdtempSync(join(tmpdir(), "omnislash-backup-"));
  const snapshot = join(tmpDir, fileName);
  const store = ctx.store;
  assertNoKeyMaterialInBackup([snapshot], {
    masterKey: masterKeyFilePath(),
    tlsKeys: await backupTlsKeyPaths(store),
  });
  try {
    // 337: a --dry-run no longer TAKES the copy. Under Postgres it would run a full pg_dump against the
    // live database every time somebody asked what the backup would do. A dry run is a question, so it
    // stays one, and the byte count it used to print becomes the command it would run instead.
    if (!dryRun) capture({ dest: snapshot });
    const bytes = dryRun ? 0 : statSync(snapshot).size;

    // PRIVACY GUARD — the DB is private; never upload to a public repo.
    if (!repoIsPrivate(repo, ghEnv)) {
      throw new AppError(`refusing to upload: ${repo} is not private (gh repo view --json isPrivate != true)`);
    }

    const existingTags = listBackupReleaseTags(repo, ghEnv);
    const releaseExists = existingTags.includes(tag);
    const toPrune = prunableTags(existingTags, now);
    const dbUpload = releaseExists ? uploadCmd(repo, tag, snapshot) : createCmd(repo, tag, snapshot, title, notes);

    if (dryRun) {
      if (ctx.mode === "json") {
        print(
          JSON.stringify(
            {
              dryRun: true,
              repo,
              tag,
              snapshot,
              capture: describeCapture(snapshot),
              private: true,
              releaseExists,
              wouldRun: [dbUpload, ...toPrune.map((t) => deleteCmd(repo, t))].map(fmtCmd),
              wouldPrune: toPrune,
            },
            null,
            2,
          ),
        );
        return;
      }
      print(`[dry-run] ${describeCapture(snapshot)}`);
      print(`[dry-run] ${repo} is private — safe to upload`);
      print(`[dry-run] would ${releaseExists ? "upload to existing" : "create"} release ${tag}:`);
      print(`  ${fmtCmd(dbUpload)}`);
      if (toPrune.length > 0) {
        print(`[dry-run] would prune ${toPrune.length} release(s) older than ${RETAIN_MONTHS} months:`);
        for (const t of toPrune) print(`  ${fmtCmd(deleteCmd(repo, t))}`);
      } else {
        print(`[dry-run] nothing to prune`);
      }
      return;
    }

    const up = run(dbUpload, ghEnv);
    if (!up.ok) throw new AppError(`gh release ${releaseExists ? "upload" : "create"} failed: ${up.stderr}`);

    const pruned: string[] = [];
    for (const t of toPrune) {
      if (run(deleteCmd(repo, t), ghEnv).ok) pruned.push(t);
    }

    if (ctx.mode === "json") {
      print(
        JSON.stringify(
          { repo, tag, snapshot: fileName, bytes, action: releaseExists ? "upload" : "create", pruned },
          null,
          2,
        ),
      );
    } else {
      print(`backed up ${fileName} (${bytes} bytes) → ${repo} release ${tag}`);
      print(`  ${restoreHint(fileName)}`);
      if (pruned.length > 0) {
        print(`pruned ${pruned.length} release(s) older than ${RETAIN_MONTHS} months: ${pruned.join(", ")}`);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
