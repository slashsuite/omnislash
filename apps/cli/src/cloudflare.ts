import { AppError, UsageError } from "./errors.ts";
import type { Flags } from "./ctx.ts";
import { print, type Mode } from "./output.ts";

// -----------------------------------------------------------------------------
// `ob cloudflare` (1756): zones and DNS records through the Cloudflare API, with the token from the
// encrypted store (`cloudflare-api-token`, never an argument and never printed).
//
// TWO WRITES, ONE GATE. `dns add` and `dns rm` change a live zone, so each prints the exact change and
// sends it only with --yes. Without --yes it is a dry run: it exits 0 and sends no write. The reads that
// make the change exact (the zone id, the record being removed) still go out, because a change shown
// against a record that does not exist is worse than no preview.
//
// WHAT THIS DOES NOT TOUCH: the DNS-01 path `ob cert` hands to lego, which writes and deletes its own
// `_acme-challenge` TXT. There is also no bulk edit and no zone creation here.
//
// `tunnels` (1643) is the connector-version read OB-1641's incident asked for: two tunnels sat on
// 2026.8.2 and 2026.10.1 until Cloudflare's advisory email found them, because nothing here looked at
// what cloudflared each host actually runs. It reads the fleet's tunnels and their connectors, marks a
// tunnel STALE when a connector drifts, and exits 1 — a verdict the `tunnel-check` daemon job and its
// alert rules stand on. It is a read: no tunnel, DNS or cloudflared is changed here.
//
// The fetch and the secret read are injected: the local command reads the secret from the store, the API
// client reads it over POST /secrets/read, and the tests hand in a fake fetch so nothing reaches the net.
// -----------------------------------------------------------------------------

const CF_API = "https://api.cloudflare.com/client/v4";
const CF_TOKEN_SECRET = "cloudflare-api-token";
const CF_ACCOUNT_SECRET = "cloudflare-account-id";

/** Record types this command writes. Others (MX, SRV, CAA) need fields it does not take, so they are refused by name. */
const WRITABLE_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "NS"]);
const PROXIABLE_TYPES = new Set(["A", "AAAA", "CNAME"]);
const ID_RE = /^[0-9a-f]{32}$/;
const PAGE = 100;

export interface CloudflareDeps {
  fetch: typeof fetch;
  /** The secret's value, or null when the store has no such name. */
  secret: (name: string) => Promise<string | null>;
}

interface CfZone {
  id: string;
  name: string;
  status: string;
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl: number;
}

interface CfTunnel {
  id: string;
  name: string;
  status: string;
}

/**
 * One RUNNING cloudflared client on a tunnel, as `/cfd_tunnel/<id>/connections` reports it (1643):
 * `version` is the host's cloudflared, `conns[].client_version` the version each edge connection
 * speaks. Both are read because the LIST endpoint's own `conns` field comes back empty — the versions
 * only ever arrive from this per-tunnel call.
 */
interface CfTunnelClient {
  version?: string;
  conns?: Array<{ client_version?: string }>;
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
  result_info?: { page: number; total_pages: number };
}

class Cf {
  private token: string | null = null;
  constructor(private readonly deps: CloudflareDeps) {}

  private async auth(): Promise<string> {
    if (this.token === null) {
      const t = await this.deps.secret(CF_TOKEN_SECRET);
      if (!t) throw new AppError(`no secret \`${CF_TOKEN_SECRET}\` in the store (ob secret set ${CF_TOKEN_SECRET})`);
      this.token = t;
    }
    return this.token;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<CfEnvelope<T>> {
    const token = await this.auth();
    let res: Response;
    try {
      res = await this.deps.fetch(`${CF_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? null : JSON.stringify(body),
      });
    } catch (e) {
      // The message of a failed fetch never carries the header, but say nothing beyond the cause anyway.
      throw new AppError(`cloudflare: ${method} ${path} failed: ${(e as Error).message}`);
    }
    let env: CfEnvelope<T> | null = null;
    try {
      env = (await res.json()) as CfEnvelope<T>;
    } catch {
      /* not JSON: reported below with the status alone */
    }
    if (!res.ok || !env || env.success === false) {
      const why = (env?.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown"}`).join("; ");
      throw new AppError(`cloudflare: ${method} ${path} -> ${res.status}${why ? ` (${why})` : ""}`);
    }
    return env;
  }

  /** Every page of a list endpoint. */
  async list<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const env = await this.call<T[]>("GET", `${path}${sep}per_page=${PAGE}&page=${page}`);
      out.push(...env.result);
      if (page >= (env.result_info?.total_pages ?? 1)) return out;
    }
  }
}

async function accountFilter(deps: CloudflareDeps): Promise<string> {
  const id = await deps.secret(CF_ACCOUNT_SECRET);
  return id ? `?account.id=${encodeURIComponent(id)}` : "";
}

async function zonesOf(cf: Cf, deps: CloudflareDeps): Promise<CfZone[]> {
  return cf.list<CfZone>(`/zones${await accountFilter(deps)}`);
}

/** A zone by name or by id, resolved against the account's zones so a typo is named, not guessed at. */
async function resolveZone(cf: Cf, deps: CloudflareDeps, ref: string): Promise<CfZone> {
  const zones = await zonesOf(cf, deps);
  const want = ref.toLowerCase();
  const hit = zones.find((z) => z.name === want || z.id === want);
  if (!hit) throw new UsageError(`unknown zone '${ref}' (known: ${zones.map((z) => z.name).join(", ") || "none"})`);
  return hit;
}

/** `www` and `@` mean the zone's own names; a name already inside the zone is taken as written. */
export function qualify(name: string, zone: string): string {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n === "@") return zone;
  return n === zone || n.endsWith(`.${zone}`) ? n : `${n}.${zone}`;
}

function describeRecord(r: Pick<CfRecord, "type" | "name" | "content" | "proxied" | "ttl">): string {
  const ttl = r.ttl === 1 ? "auto" : `${r.ttl}s`;
  return `${r.type} ${r.name} -> ${r.content} (proxied: ${r.proxied ? "yes" : "no"}, ttl: ${ttl})`;
}

function renderZones(zones: CfZone[], mode: Mode): string {
  if (mode === "json") return JSON.stringify(zones, null, 2);
  if (mode === "quiet") return zones.map((z) => z.name).join("\n");
  if (zones.length === 0) return "(no zones)";
  return zones.map((z) => `${z.name}\t${z.id}\t${z.status}`).join("\n");
}

function renderRecords(records: CfRecord[], mode: Mode): string {
  if (mode === "json") return JSON.stringify(records, null, 2);
  if (mode === "quiet") return records.map((r) => r.id).join("\n");
  if (records.length === 0) return "(no records)";
  return records
    .map((r) => `${r.id}\t${r.type}\t${r.name}\t${r.content}\t${r.proxied ? "proxied" : "dns-only"}\t${r.ttl === 1 ? "auto" : r.ttl}`)
    .join("\n");
}

/** What a write would do, or did. In json it is one object so a script can read the outcome. */
function reportWrite(mode: Mode, action: "add" | "rm", zone: CfZone, line: string, sent: boolean, record?: CfRecord): void {
  if (mode === "json") {
    print(JSON.stringify({ action, zone: zone.name, change: line, sent, ...(record ? { record } : {}) }, null, 2));
    return;
  }
  if (mode === "quiet") {
    if (record) print(record.id);
    return;
  }
  const [verb, done] = action === "add" ? ["add", "added"] : ["remove", "removed"];
  if (sent) print(`${done} ${line}  [zone ${zone.name}]`);
  else print(`dry run: would ${verb} ${line}  [zone ${zone.name}]\nnothing sent. Re-run with --yes to make this change.`);
}

function parseTtl(raw: string | undefined, proxied: boolean): number {
  if (raw === undefined) return 1;
  const ttl = Number(raw);
  if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) {
    throw new UsageError(`--ttl must be 1 (auto) or 60..86400 seconds, got '${raw}'`);
  }
  if (proxied && ttl !== 1) throw new UsageError("--ttl cannot be set on a proxied record (Cloudflare fixes it at auto)");
  return ttl;
}

// --- tunnels: the connector-version staleness check (1643) -------------------
//
// The verdict's granularity was decided against the live fleet (2026-10-26: an ob-api at 2026.10.4
// beside two tunnels at 2026.10.3 that are FINE — each host ships what its channel ships, so
// patch-lag is the fleet's normal state, not drift):
//
//   - a connector an entire release-month (cloudflared's calver major.minor) behind the newest month
//     seen across the fleet is DRIFT — that is the "2026.8.2 in October" shape OB-1641 found;
//   - an advisory's cutoff is patch-exact (eMudhra wanted >= 2026.10.2), so `--floor <version>` marks
//     a same-month connector below it as stale too;
//   - anything else is fresh, and a failed read is NEVER a stale verdict: the API error propagates as
//     its own failure, so the watching job records "the read failed", not "a tunnel drifted".

/**
 * Per-tunnel remediation hints (1643). The output path otherwise stays machine-agnostic; this table
 * is the one deliberately machine-specific thing in it, keyed by tunnel name (the only identity the
 * API gives) and kept to a single hint line per host. The full procedure lives in
 * the server runbook — `ob cloudflare tunnels` names it, it does not restate it.
 */
const TUNNEL_HINTS: Record<string, string> = {
  // The API host's tunnel daemon: installed from a MANUAL GitHub .deb (there is no apt repo for it), and the
  // unit pins --no-autoupdate, so every upgrade is this swap by hand — from the pve host, because the
  // ob user has no sudo for dpkg inside the container.
  "ob-api":
    "API host: curl the cloudflared .deb from the GitHub release into /tmp, on the pve host run pct exec <ctid> -- dpkg -i <deb>, then pct exec <ctid> -- systemctl restart cloudflared-ob-api",
  // The HA box's tunnel is the Cloudflared add-on, which bundles its own cloudflared: bumping the
  // add-on is the whole fix, there is no second cloudflared to swap there.
  homeassistant: "HA box: ha apps update 9074a9fa_cloudflared (the add-on bundles its own cloudflared)",
};

const GENERIC_TUNNEL_HINT = "upgrade that host's cloudflared (see the server runbook)";

function tunnelHint(name: string): string {
  return TUNNEL_HINTS[name] ?? GENERIC_TUNNEL_HINT;
}

/** A cloudflared calver version (`2026.10.4`), as ordered parts. null when it is not one: an
 * unparseable version is still PRINTED (the human sees what the host reported) but is never ordered
 * against the fleet, because a string that is not a version cannot be older than one. */
function parseVersion(v: string): number[] | null {
  const parts = v.split(".");
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return nums.length > 0 ? nums : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `--floor <version>`: an advisory's exact cutoff, patch-exact where the fleet rule is
 * month-granular (the eMudhra advisory required >= 2026.10.2, which is same-month stale). */
function parseFloorFlag(raw: string | boolean | undefined): string | null {
  if (raw === undefined || raw === false) return null;
  const v = String(raw);
  if (parseVersion(v) === null) throw new UsageError(`--floor must be a cloudflared version like 2026.10.2, got '${v}'`);
  return v;
}

/** The distinct versions a tunnel's connectors run, oldest first. Both fields the connections
 * endpoint reports are read — the client's own `version` and each edge connection's
 * `client_version` — because a connector with zero live connections still has a version. */
function versionsOfTunnel(clients: CfTunnelClient[]): string[] {
  const seen = new Set<string>();
  for (const c of clients) {
    if (c.version) seen.add(c.version);
    for (const conn of c.conns ?? []) if (conn.client_version) seen.add(conn.client_version);
  }
  return [...seen].sort((a, b) => {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (pa === null || pb === null) return pa === pb ? a.localeCompare(b) : pa === null ? 1 : -1;
    return compareVersions(pa, pb);
  });
}

/** The newest parseable version seen anywhere in the fleet, or null when no connector reported one. */
function fleetNewest(versionsPerTunnel: string[][]): string | null {
  let best: string | null = null;
  let bestParts: number[] | null = null;
  for (const vs of versionsPerTunnel) {
    for (const v of vs) {
      const p = parseVersion(v);
      if (p === null) continue;
      if (bestParts === null || compareVersions(p, bestParts) > 0) {
        best = v;
        bestParts = p;
      }
    }
  }
  return best;
}

interface TunnelRow {
  id: string;
  name: string;
  status: string;
  connectors: number;
  /** Distinct versions across the tunnel's connectors, oldest first. */
  versions: string[];
  stale: boolean;
  /** Why it is stale, one clause per offending version; null when fresh. */
  stale_reason: string | null;
  /** The per-host remediation hint; null when fresh. */
  hint: string | null;
}

/**
 * The staleness verdict, pure: fetched tunnels in, rows (and the drift to name) out. No fetch, no
 * print, no throw — so the rule itself can be tested without a fake network anywhere near it.
 */
function markTunnels(
  fleet: Array<{ id: string; name: string; status: string; clients: CfTunnelClient[] }>,
  floor: string | null,
): TunnelRow[] {
  const newest = fleetNewest(fleet.map((t) => versionsOfTunnel(t.clients)));
  const newestMonth = newest !== null ? parseVersion(newest)!.slice(0, 2) : null;
  const floorParts = floor !== null ? parseVersion(floor)! : null;
  return fleet.map((t) => {
    const versions = versionsOfTunnel(t.clients);
    const clauses: string[] = [];
    for (const v of versions) {
      const p = parseVersion(v);
      if (p === null) continue;
      if (newestMonth !== null && compareVersions(p.slice(0, 2), newestMonth) < 0) {
        clauses.push(`${v} is a release-month behind the fleet (newest ${newest})`);
      }
      if (floorParts !== null && compareVersions(p, floorParts) < 0) clauses.push(`${v} is below the --floor ${floor}`);
    }
    const stale = clauses.length > 0;
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      connectors: t.clients.length,
      versions,
      stale,
      stale_reason: stale ? clauses.join(", ") : null,
      hint: stale ? tunnelHint(t.name) : null,
    };
  });
}

function renderTunnels(rows: TunnelRow[], mode: Mode): string {
  if (mode === "json") return JSON.stringify(rows, null, 2);
  if (mode === "quiet") return rows.map((r) => r.name).join("\n");
  if (rows.length === 0) return "(no tunnels)";
  const lines: string[] = [];
  for (const r of rows) {
    const count = r.connectors === 1 ? "1 connector" : `${r.connectors} connectors`;
    lines.push(`${r.name}\t${r.status}\t${count}\t${r.versions.join(", ") || "-"}${r.stale ? `\tSTALE (${r.stale_reason})` : ""}`);
    if (r.hint) lines.push(`  fix: ${r.hint}`);
  }
  return lines.join("\n");
}

/**
 * The one-line drift verdict a scheduled job records and a human reads: every stale tunnel, its
 * observed versions, what they are measured against, and the per-host fix. This is what the job's
 * `last_error` carries, so it is what a JOB FAILING alert ends up saying.
 */
function tunnelDriftMessage(stale: TunnelRow[]): string {
  return stale.map((r) => `${r.name} at ${r.versions.join(", ")}: ${r.stale_reason}. fix: ${r.hint}`).join("; ");
}

export async function runCloudflare(
  args: string[],
  flags: Flags,
  mode: Mode,
  deps: CloudflareDeps,
): Promise<void> {
  const cf = new Cf(deps);
  const sub = args[0];

  if (sub === "zones") {
    print(renderZones(await zonesOf(cf, deps), mode));
    return;
  }

  if (sub === "tunnels") {
    // The tunnel list is ACCOUNT-scoped: the account id sits in the path (unlike "zones", where it is
    // an optional filter), so without the stored id there is no endpoint to read and the command says
    // so rather than guessing at a user-level fallback the ticket does not build on.
    const acct = await deps.secret(CF_ACCOUNT_SECRET);
    if (!acct) {
      throw new AppError(`no secret \`${CF_ACCOUNT_SECRET}\` in the store (ob secret set ${CF_ACCOUNT_SECRET}) — the tunnel endpoints are account-scoped`);
    }
    const floor = parseFloorFlag(flags.floor); // a typo is a usage error before any request goes out
    const fleet: Array<{ id: string; name: string; status: string; clients: CfTunnelClient[] }> = [];
    for (const t of await cf.list<CfTunnel>(`/accounts/${encodeURIComponent(acct)}/cfd_tunnel?is_deleted=false`)) {
      // The versions live HERE, not in the list entry: that endpoint's own `conns` field comes back
      // empty, so a per-tunnel connections call is made for every tunnel — including the fresh ones,
      // because the fleet's newest version is the bar every other connector is measured against.
      const conns = await cf.call<CfTunnelClient[]>("GET", `/accounts/${encodeURIComponent(acct)}/cfd_tunnel/${t.id}/connections`);
      fleet.push({ id: t.id, name: t.name, status: t.status, clients: conns.result ?? [] });
    }
    const rows = markTunnels(fleet, floor);
    // The table prints BEFORE the drift is thrown, so stdout always carries the whole fleet — a human
    // and the job's journal both see what was seen, not only what was wrong with it.
    print(renderTunnels(rows, mode));
    const stale = rows.filter((r) => r.stale);
    if (stale.length > 0) throw new AppError(`stale cloudflared: ${tunnelDriftMessage(stale)}`);
    return;
  }

  if (sub !== "dns") {
    throw new UsageError(`unknown cloudflare subcommand '${sub ?? ""}' (zones|tunnels|dns list|dns add|dns rm)`);
  }
  const verb = args[1];

  if (verb === "list") {
    const ref = args[2];
    if (!ref) throw new UsageError("cloudflare dns list requires a <zone>");
    const zone = await resolveZone(cf, deps, ref);
    print(renderRecords(await cf.list<CfRecord>(`/zones/${zone.id}/dns_records`), mode));
    return;
  }

  if (verb === "add") {
    const [ref, rawType, rawName, content] = args.slice(2);
    if (!ref || !rawType || !rawName || content === undefined) {
      throw new UsageError("usage: cloudflare dns add <zone> <type> <name> <content> [--proxied] [--ttl <s>] [--yes]");
    }
    const type = rawType.toUpperCase();
    if (!WRITABLE_TYPES.has(type)) {
      throw new UsageError(`record type '${type}' is not supported here (${[...WRITABLE_TYPES].join("|")})`);
    }
    const proxied = flags.proxied === true;
    if (proxied && !PROXIABLE_TYPES.has(type)) throw new UsageError(`--proxied only applies to ${[...PROXIABLE_TYPES].join("|")} records`);
    const ttl = parseTtl(flags.ttl, proxied);
    const zone = await resolveZone(cf, deps, ref);
    const body = { type, name: qualify(rawName, zone.name), content, ttl, proxied };
    const line = describeRecord(body);
    if (flags.yes !== true) return reportWrite(mode, "add", zone, line, false);
    const env = await cf.call<CfRecord>("POST", `/zones/${zone.id}/dns_records`, body);
    return reportWrite(mode, "add", zone, line, true, env.result);
  }

  if (verb === "rm") {
    const [ref, target] = args.slice(2);
    if (!ref || !target) throw new UsageError("usage: cloudflare dns rm <zone> <record-id|name> [--yes]");
    const zone = await resolveZone(cf, deps, ref);
    const records = await cf.list<CfRecord>(`/zones/${zone.id}/dns_records`);
    const wantName = qualify(target, zone.name);
    const hits = ID_RE.test(target) ? records.filter((r) => r.id === target) : records.filter((r) => r.name === wantName);
    if (hits.length === 0) throw new AppError(`no record '${target}' in zone ${zone.name}`);
    if (hits.length > 1) {
      throw new UsageError(
        `'${target}' matches ${hits.length} records in ${zone.name}; remove one by id:\n${renderRecords(hits, "human")}`,
      );
    }
    const record = hits[0]!;
    const line = `${describeRecord(record)} [id ${record.id}]`;
    if (flags.yes !== true) return reportWrite(mode, "rm", zone, line, false, record);
    await cf.call("DELETE", `/zones/${zone.id}/dns_records/${record.id}`);
    return reportWrite(mode, "rm", zone, line, true, record);
  }

  throw new UsageError(`unknown cloudflare dns subcommand '${verb ?? ""}' (list|add|rm)`);
}
