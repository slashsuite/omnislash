// OB-2041: `ob ports`, the LAN dev-port range an iPad can reach, and which of its ports are free, leased or in use.
//
// Three facts meet here and none of them is the whole answer:
//   - the lease table says who has CLAIMED `port:<n>` (shared across machines and sessions, over the ob API);
//   - `ss` says what is actually LISTENING on this machine, and on which address;
//   - the ufw rules say whether the range is open to the LAN at all.
// Everything below the seams is pure, so the states are tested from fixtures with no live network.
// This module never runs sudo and never changes the firewall: when the rule is missing it prints the line.
import { readFileSync } from "node:fs";
import { UsageError } from "./errors.ts";
import { print, warn } from "./output.ts";
import type { Mode } from "./output.ts";
import { acquireLease, leaseHolderId, leaseStatus, type LeaseStatusRow } from "../../../platform/cli-coord/src/lease.ts";
import { refKey } from "../../../platform/cli-coord/src/clean-repo.ts";
import type { Ctx } from "./ctx.ts";

/** The dev range (decision 1 of OB-2041). Holds Vite's default 5173. */
export const DEV_PORT_FIRST = 5100;
export const DEV_PORT_LAST = 5199;
/** The only source the range is ever opened to: this machine's LAN, the /24 around its own LAN address. */
export function lanCidrOf(lanIp: string | null): string | null {
  const m = lanIp?.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : null;
}
export function ufwAllowLine(cidr: string): string {
  return `sudo ufw allow from ${cidr} to any port ${DEV_PORT_FIRST}:${DEV_PORT_LAST} proto tcp comment 'ob dev ports'`;
}
/** A dev server outlives the 20 minute lease default; 8 hours covers a working day without a heartbeat. */
export const PORT_LEASE_TTL_S = 8 * 60 * 60;

export interface Listener {
  /** The bound address as `ss` prints it, brackets removed (`127.0.0.1`, `::`, `*`). */
  address: string;
  port: number;
  /** Absent when `ss` could not see the owner (another user's process). */
  pid?: number;
  process?: string;
}

/** True for an address only this machine can reach. `*`, `0.0.0.0`, `::` and a LAN address are reachable. */
export function isLoopbackAddress(address: string): boolean {
  const a = address.replace(/%.*$/, "");
  return a === "::1" || a === "localhost" || /^127\./.test(a);
}

/**
 * Parse `ss -ltnpH`. One line per listening socket:
 *   LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))
 *   LISTEN 0 511 [::1]:5174 [::]:* users:(("bun",pid=77,fd=9),("bun",pid=78,fd=9))
 *   LISTEN 0 4096 *:8123 *:*
 * A line that does not parse is skipped, never guessed at.
 */
export function parseSs(text: string): Listener[] {
  const out: Listener[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    // With -H the columns are: State Recv-Q Send-Q Local Peer [Process]. Tolerate a header-less or headed dump.
    const at = cols.findIndex((c) => c === "LISTEN");
    if (at < 0) continue;
    const local = cols[at + 3];
    if (!local) continue;
    const cut = local.lastIndexOf(":");
    if (cut < 0) continue;
    const port = Number(local.slice(cut + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    let address = local.slice(0, cut);
    if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
    const users = line.match(/users:\(\("([^"]*)",pid=(\d+)/);
    out.push({
      address,
      port,
      ...(users ? { process: users[1]!, pid: Number(users[2]) } : {}),
    });
  }
  return out;
}

/**
 * The IPv4 `src` of `ip -4 route get 1.1.1.1`: the address of the default-route interface. Only an address
 * on a LAN interface counts: behind a VPN the default route leaves by a tunnel (`tun0`, `wg0`), and its
 * `10.8.0.2` is not a URL the iPad can open, so that reads as unknown rather than printing a wrong URL.
 */
export function parseRouteSrc(text: string): string | null {
  if (/\bdev\s+(tun|tap|wg|tailscale|utun|ppp)\S*/.test(text)) return null;
  const m = text.match(/\bsrc\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  return m ? m[1]! : null;
}

export type FirewallState = "present" | "missing" | "unknown";

/**
 * Read `/etc/ufw/user.rules` text. The range counts as open ONLY when one tcp ACCEPT rule covers the whole
 * 5100 to 5199 range from exactly `cidr` (the LAN, e.g. 10.0.0.0/24), inbound, to any local address (`0.0.0.0/0`) from any source
 * port. A rule for one host, a narrower subnet, another source, a single destination address, a source-port
 * restriction or part of the range reads `missing`: that is the safe answer, because a wrong `present` would
 * tell the owner a phone on the LAN should work when it cannot. A deny or reject to any address (`0.0.0.0/0`) that
 * touches the range and comes first also reads `missing`; a deny aimed at one local address is not read.
 * ufw writes one rule as `### tuple ### allow tcp 5100:5199 0.0.0.0/0 any 10.0.0.0/24 in`.
 * Fields: action proto dport dst-ip sport src-ip direction.
 */
export function parseUfwRules(text: string, cidr: string): FirewallState {
  // Any address in the LAN's /16 counts as the LAN.
  const lanPrefix = `${cidr.split(".").slice(0, 2).join(".")}.`;
  for (const line of text.split("\n")) {
    const m = line.match(/^###\s*tuple\s*###\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?/);
    if (!m) continue;
    const [, action, proto, dport, dst, sport, src, direction] = m;
    if (direction !== undefined && direction !== "in") continue;
    if (proto !== "tcp" && proto !== "any") continue;
    if (dst !== "0.0.0.0/0" || sport !== "any") continue;
    // ufw evaluates rules in order, so a deny or reject written before the allow decides: it blocks the LAN
    // when its ports touch the range and its source is everyone or any address in the LAN's /16.
    if (action !== "allow") {
      if ((action === "deny" || action === "reject") && overlapsRange(dport!) && (src === "0.0.0.0/0" || src!.startsWith(lanPrefix))) return "missing";
      continue;
    }
    if (proto === "tcp" && coversRange(dport!) && src === cidr) return "present";
  }
  return "missing";
}

/** Whether a ufw port field (`5150`, `5120:5130`) touches 5100 to 5199 at all. */
function overlapsRange(dport: string): boolean {
  const [loText, hiText = loText] = dport.split(":");
  const lo = Number(loText);
  const hi = Number(hiText);
  return Number.isInteger(lo) && Number.isInteger(hi) && lo <= DEV_PORT_LAST && hi >= DEV_PORT_FIRST;
}

function coversRange(dport: string): boolean {
  const parts = dport.split(":");
  if (parts.length === 1) return false;
  const lo = Number(parts[0]);
  const hi = Number(parts[1]);
  return Number.isInteger(lo) && Number.isInteger(hi) && lo <= DEV_PORT_FIRST && hi >= DEV_PORT_LAST;
}

/** `unknown`: nothing says it is taken, but a source that could have said so could not be read. */
export type PortState = "free" | "leased" | "listening" | "leased+listening" | "unknown";

export interface PortRow {
  port: number;
  state: PortState;
  holder?: string;
  listeners: Listener[];
  /** Listening, and every listener is bound to loopback. */
  loopbackOnly: boolean;
  /** Listening with no live lease; false when the lease table could not be read. */
  unleased: boolean;
  /** The LAN URL, set when a listener on the wildcard or LAN address is up and the LAN address is known. */
  url?: string;
}

export interface MergeInput {
  /** null when the lease API could not be read. */
  leases: LeaseStatusRow[] | null;
  /** null when `ss` could not run. */
  listeners: Listener[] | null;
  lanIp: string | null;
}

/** The URL the iPad opens, or null when this machine's LAN address is unknown (never a placeholder). */
export function lanUrl(lanIp: string | null, port: number): string | null {
  return lanIp ? `http://${lanIp}:${port}` : null;
}

/** True when a listener on `address` answers on the LAN address: a wildcard bind, or the LAN address itself. */
function isLanReachable(address: string, lanIp: string | null): boolean {
  const a = address.replace(/%.*$/, "");
  return a === "*" || a === "0.0.0.0" || a === "::" || (lanIp !== null && a === lanIp);
}

/** Merge lease state and listening state into one row per port of the range. Pure. */
export function mergePorts(input: MergeInput): PortRow[] {
  const live = new Map<number, string>();
  for (const l of input.leases ?? []) {
    const m = l.resource.match(/^port:(\d+)$/);
    if (!m || l.expired || !l.holder) continue;
    live.set(Number(m[1]), l.holder);
  }
  const rows: PortRow[] = [];
  for (let port = DEV_PORT_FIRST; port <= DEV_PORT_LAST; port++) {
    const holder = live.get(port);
    const listeners = (input.listeners ?? []).filter((l) => l.port === port);
    const listening = listeners.length > 0;
    const state: PortState = holder && listening ? "leased+listening" : holder ? "leased" : listening ? "listening" : input.leases === null || input.listeners === null ? "unknown" : "free";
    const loopbackOnly = listening && listeners.every((l) => isLoopbackAddress(l.address));
    const url = listeners.some((l) => isLanReachable(l.address, input.lanIp)) ? lanUrl(input.lanIp, port) : null;
    rows.push({
      port,
      state,
      ...(holder ? { holder } : {}),
      listeners,
      loopbackOnly,
      unleased: listening && input.leases !== null && !holder,
      ...(url ? { url } : {}),
    });
  }
  return rows;
}

/** Ports the claim may try: neither leased nor listening as far as the sources that could be read say. */
export function freeCandidates(rows: PortRow[]): number[] {
  return rows.filter((r) => r.state === "free" || r.state === "unknown").map((r) => r.port);
}

/** `5100-5104, 5106` style compaction of a port list. */
export function compactRanges(ports: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < ports.length) {
    let j = i;
    while (j + 1 < ports.length && ports[j + 1] === ports[j]! + 1) j++;
    out.push(j > i ? `${ports[i]}-${ports[j]}` : `${ports[i]}`);
    i = j + 1;
  }
  return out.join(", ");
}

function describeRow(r: PortRow, lanIp: string | null): string {
  const bits: string[] = [String(r.port), r.state];
  if (r.holder) bits.push(`holder ${r.holder}`);
  for (const l of r.listeners) {
    bits.push(`${l.process ?? "unknown process"}${l.pid ? ` pid ${l.pid}` : ""} on ${l.address}`);
  }
  if (r.url) bits.push(r.url);
  if (r.loopbackOnly) {
    const would = lanUrl(lanIp, r.port);
    bits.push(`loopback only: the iPad cannot reach it, start it with --host${would ? ` (it would be ${would})` : ""}`);
  }
  if (r.unleased) bits.push(`unleased: claim it with 'ob lease acquire port:${r.port} --holder <id>'`);
  return bits.join("\t");
}

export interface PortsReport {
  lan_ip: string | null;
  /** cidr is null when this machine's LAN address could not be found. */
  range: { first: number; last: number; cidr: string | null };
  firewall: FirewallState;
  firewall_fix: string | null;
  /** "unavailable" when the lease API could not be read; "unknown" for ss. */
  leases: "ok" | "unavailable";
  listening: "ok" | "unknown";
  ports: PortRow[];
}

export function formatReport(report: PortsReport, all: boolean): string {
  const lines: string[] = [];
  lines.push(`range ${report.range.first}-${report.range.last} (${report.range.cidr ?? "lan unknown"}) · lan ${report.lan_ip ?? "unknown"}`);
  lines.push(`firewall: ${report.firewall}`);
  if (report.firewall !== "present") {
    lines.push(
      report.firewall === "missing"
        ? `  there is no LAN-only allow rule for the range yet. Run this once yourself (ob never runs sudo):`
        : `  ufw rules could not be read (no permission or no ufw). If the range is not open, run:`,
    );
    lines.push(report.firewall_fix ? `  ${report.firewall_fix}` : "  (no LAN address, so no rule can be named: connect to the LAN and run ob ports again)");
  }
  if (report.leases === "unavailable") lines.push("leases: unavailable (the lease API could not be read), showing listening state only");
  if (report.listening === "unknown") lines.push("listening: unknown (ss could not run), showing lease state only");
  for (const r of report.ports) {
    if ((r.state === "free" || r.state === "unknown") && !all) continue;
    lines.push(describeRow(r, report.lan_ip));
  }
  if (!all) {
    const freeNow = report.ports.filter((r) => r.state === "free").map((r) => r.port);
    const unknownNow = report.ports.filter((r) => r.state === "unknown").length;
    if (unknownNow) lines.push(`free: unknown for ${unknownNow} ports (a source above could not be read)`);
    else lines.push(freeNow.length ? `free (${freeNow.length}): ${compactRanges(freeNow)}` : "free: none");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The seams. Each source degrades on its own.
// ---------------------------------------------------------------------------

export interface PortsIo {
  /** All lease rows; throws when the lease API cannot be read. */
  leases(): Promise<LeaseStatusRow[]>;
  /** Take `resource` for `holder`; ok false means it is held by another live holder. */
  acquire(resource: string, holder: string, ttlS: number): Promise<{ ok: boolean; holder: string }>;
  /** `ss -ltnpH` text, or null when it cannot run. */
  ss(): string | null;
  /** `ip -4 route get 1.1.1.1` text, or null. */
  route(): string | null;
  /** /etc/ufw/user.rules text, or null when unreadable. */
  ufw(): string | null;
  /** Fallback holder when none is given. */
  defaultHolder(): string;
}

function spawnText(argv: string[]): string | null {
  try {
    const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
    if (p.exitCode !== 0) return null;
    return new TextDecoder().decode(p.stdout);
  } catch {
    return null;
  }
}

/** The real machine reads. The lease halves are added by the caller (local store or API client). */
export const machineIo: Pick<PortsIo, "ss" | "route" | "ufw"> = {
  ss: () => spawnText(["ss", "-ltnpH"]),
  route: () => spawnText(["ip", "-4", "route", "get", "1.1.1.1"]),
  ufw: () => {
    try {
      return readFileSync("/etc/ufw/user.rules", "utf8");
    } catch {
      return null;
    }
  },
};

export async function gather(io: PortsIo): Promise<PortsReport> {
  let leases: LeaseStatusRow[] | null = null;
  try {
    leases = await io.leases();
  } catch {
    leases = null;
  }
  const ssText = io.ss();
  const listeners = ssText === null ? null : parseSs(ssText);
  const routeText = io.route();
  const lanIp = routeText === null ? null : parseRouteSrc(routeText);
  const ufwText = io.ufw();
  const cidr = lanCidrOf(lanIp);
  const firewall: FirewallState = ufwText === null || cidr === null ? "unknown" : parseUfwRules(ufwText, cidr);
  return {
    lan_ip: lanIp,
    range: { first: DEV_PORT_FIRST, last: DEV_PORT_LAST, cidr },
    firewall,
    firewall_fix: firewall === "present" || cidr === null ? null : ufwAllowLine(cidr),
    leases: leases === null ? "unavailable" : "ok",
    listening: listeners === null ? "unknown" : "ok",
    ports: mergePorts({ leases, listeners, lanIp }),
  };
}

export interface ClaimResult {
  port: number;
  holder: string;
  /** null when this machine's LAN address could not be found. */
  url: string | null;
}

/**
 * Pick the lowest port neither leased nor listening and claim it. The lease acquire IS the claim: a refusal
 * (someone took it between the read and the acquire) moves on to the next candidate. A port that is leased
 * but not yet listening is never a candidate, because `mergePorts` marks it leased.
 */
export async function claimNext(
  io: PortsIo,
  opts: { holder: string; ttlS: number },
): Promise<ClaimResult> {
  let leases: LeaseStatusRow[];
  try {
    leases = await io.leases();
  } catch (err) {
    throw new Error(`ob ports next needs the lease API to claim a port, and it could not be read: ${(err as Error).message}`);
  }
  const ssText = io.ss();
  const listeners = ssText === null ? null : parseSs(ssText);
  if (listeners === null) warn("note: ss could not run, so listening ports are not checked; the lease alone decides");
  const routeText = io.route();
  const lanIp = routeText === null ? null : parseRouteSrc(routeText);
  if (lanIp === null) warn("note: this machine's LAN address could not be found, so no URL is printed");
  const rows = mergePorts({ leases, listeners, lanIp });
  for (const port of freeCandidates(rows)) {
    const got = await io.acquire(`port:${port}`, opts.holder, opts.ttlS);
    if (got.ok) return { port, holder: got.holder, url: lanUrl(lanIp, port) };
  }
  throw new Error(`no free port in ${DEV_PORT_FIRST}-${DEV_PORT_LAST}: every port is leased or in use (see 'ob ports')`);
}

// ---------------------------------------------------------------------------
// The command, shared by the local handler and the API-mode handler.
// ---------------------------------------------------------------------------

export interface PortsCommand {
  args: string[];
  flags: Record<string, unknown>;
  mode: Mode;
}

/** Runs `ob ports [next]` against `io`. */
export async function runPorts(cmd: PortsCommand, io: PortsIo): Promise<void> {
  const sub = cmd.args[0];
  if (sub !== undefined && sub !== "next") {
    throw new UsageError(`unknown ports subcommand '${sub}' (next)`);
  }
  if (sub === "next") {
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const ticket = str(cmd.flags.ticket);
    // The holder is what the lease table and the listing show. A builder's id is its ticket ref as `refKey`
    // writes it, so `--ticket OB-2041` with no --holder holds the port as `ob-2041` and `#42` as `issue-42`.
    const holder = str(cmd.flags.holder) ?? (ticket ? refKey(ticket) : io.defaultHolder());
    let ttlS = PORT_LEASE_TTL_S;
    if (cmd.flags.ttl !== undefined) {
      ttlS = Number(cmd.flags.ttl);
      if (!Number.isInteger(ttlS) || ttlS <= 0) throw new UsageError("ports next --ttl must be a whole number of seconds above zero");
    }
    const claim = await claimNext(io, { holder, ttlS });
    if (cmd.mode === "json") {
      print(JSON.stringify({ port: claim.port, holder: claim.holder, ttl_s: ttlS, url: claim.url, ...(ticket ? { ticket } : {}) }, null, 2));
    } else if (cmd.mode === "quiet") {
      print(String(claim.port));
    } else {
      print(String(claim.port));
      if (claim.url) print(claim.url);
      warn(
        `port:${claim.port} is leased to ${claim.holder} for ${Math.round(ttlS / 3600 * 10) / 10}h. Bind 0.0.0.0 (--host), not loopback. Release: ob lease release port:${claim.port} --holder ${claim.holder}`,
      );
    }
    return;
  }
  const report = await gather(io);
  if (cmd.mode === "json") print(JSON.stringify(report, null, 2));
  else print(formatReport(report, cmd.flags.all === true));
}

/** The local handler: leases come from this process's own store (the server, or a direct database). */
export async function cmdPorts(ctx: Ctx): Promise<void> {
  const store = ctx.store;
  const io: PortsIo = {
    ...machineIo,
    leases: () => leaseStatus(store),
    acquire: async (resource, holder, ttlS) => {
      const r = await acquireLease(store, resource, holder, ttlS);
      return { ok: r.ok, holder: r.holder };
    },
    defaultHolder: leaseHolderId,
  };
  await runPorts({ args: ctx.args, flags: ctx.flags as unknown as Record<string, unknown>, mode: ctx.mode }, io);
}
