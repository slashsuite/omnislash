// ---------------------------------------------------------------------------
// Shared network-config sanitiser (ticket 151).
//
// Redaction primitives + a deterministic block-YAML emitter used to turn a raw
// captured network config (AdGuard now; the router in 152) into a git-safe,
// diffable artifact. The hard rule: nothing secret in git. These
// helpers are the single place that enforces that for network/ — 152's router
// capture imports the SAME primitives so both feeds redact identically.
// ---------------------------------------------------------------------------

/** The placeholder every redacted value collapses to. Stable so diffs stay quiet. */
export const REDACTED = "[redacted]";

/**
 * Key names whose VALUE is always a secret, wherever they appear in the tree.
 * Matched case-insensitively as a whole word / snake segment (password, api_key,
 * session_secret, private_key, auth_token, client_secret, cookie, salt, …).
 */
export const SECRET_KEY_RE =
  /(^|[_-])(password|passwd|pass|secret|token|apikey|api_key|privatekey|private_key|priv_key|sessionkey|session_key|session|cookie|salt|hash|credential|credentials|passphrase|client_secret|auth)($|[_-])/i;

/** Replace every IPv4/IPv6 literal in a string with a placeholder (keeps surrounding shape). */
export function redactIps(s: string): string {
  const ipv4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
  const ipv6 = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?:%[0-9a-zA-Z]+)?\b/g;
  return s.replace(ipv4, "[redacted-ip]").replace(ipv6, "[redacted-ip6]");
}

/** Replace every MAC address in a string with a placeholder. */
export function redactMacs(s: string): string {
  return s.replace(/\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g, "[redacted-mac]");
}

/** Strip `user:pass@` userinfo from any URL embedded in the string (keeps the host). */
export function stripUrlCredentials(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted-creds]@");
}

/**
 * IPs + MACs + URL creds, for a "keep the shape, mask the topology/PII" string.
 * MACs are masked BEFORE IPs — a MAC (hex groups joined by colons) otherwise
 * matches the loose IPv6 pattern and would be mis-tagged as an IP.
 */
export function redactTopology(s: string): string {
  return redactIps(redactMacs(stripUrlCredentials(s)));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-clone `value`, replacing the value under any secret-looking key with
 * {@link REDACTED} — recursively, at any depth, inside arrays too. This is the
 * generic, config-agnostic secret scrub; callers layer on domain-specific PII
 * redaction (client MACs/IPs, rewrite answers, …) afterwards.
 */
export function deepRedactSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepRedactSecretKeys);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = v === null || v === undefined || v === "" ? v : REDACTED;
      } else {
        out[k] = deepRedactSecretKeys(v);
      }
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Deterministic block-style YAML emitter.
//
// Bun.YAML.stringify emits flow style ({a: 1,b: [x]}) — useless for diffs — so
// we emit clean block YAML ourselves. Round-tripped in tests
// (YAML.parse(toYaml(x)) deep-equals x) to guarantee fidelity.
// ---------------------------------------------------------------------------

function needsQuote(s: string): boolean {
  if (s === "") return true;
  if (/^\s|\s$/.test(s)) return true;
  if (/[:#[\]{}&*!|>'"%@`,]/.test(s)) return true;
  if (/^[-?]/.test(s)) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (s.trim() !== "" && !Number.isNaN(Number(s))) return true;
  return false;
}

function scalarInline(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[]"; // only reached for an empty array
  if (isPlainObject(v)) return "{}"; // only reached for an empty map
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : JSON.stringify(String(v));
  const s = String(v);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

function scalarKey(k: string): string {
  return needsQuote(k) ? JSON.stringify(k) : k;
}

function emitMap(obj: Record<string, unknown>, indent: number): string[] {
  const pad = "  ".repeat(indent);
  const keys = Object.keys(obj);
  if (keys.length === 0) return [`${pad}{}`];
  const lines: string[] = [];
  for (const k of keys) {
    const child = obj[k];
    const key = `${pad}${scalarKey(k)}:`;
    if (isPlainObject(child) && Object.keys(child).length > 0) {
      lines.push(key);
      lines.push(...emitMap(child, indent + 1));
    } else if (Array.isArray(child) && child.length > 0) {
      lines.push(key);
      lines.push(...emitArray(child, indent)); // items sit at the key's indent (valid YAML)
    } else {
      lines.push(`${key} ${scalarInline(child)}`);
    }
  }
  return lines;
}

function emitArray(arr: unknown[], indent: number): string[] {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const item of arr) {
    if (isPlainObject(item) && Object.keys(item).length > 0) {
      const block = emitMap(item, indent + 1);
      const [first = "", ...rest] = block;
      lines.push(`${pad}- ${first.slice((indent + 1) * 2)}`);
      lines.push(...rest);
    } else if (Array.isArray(item) && item.length > 0) {
      const block = emitArray(item, indent + 1);
      const [first = "", ...rest] = block;
      lines.push(`${pad}- ${first.slice((indent + 1) * 2)}`);
      lines.push(...rest);
    } else {
      lines.push(`${pad}- ${scalarInline(item)}`);
    }
  }
  return lines;
}

/** Serialise a JSON-like value to deterministic block-style YAML (trailing newline). */
export function toYaml(value: unknown): string {
  let lines: string[];
  if (isPlainObject(value)) lines = emitMap(value, 0);
  else if (Array.isArray(value)) lines = value.length === 0 ? ["[]"] : emitArray(value, 0);
  else lines = [scalarInline(value)];
  return lines.join("\n") + "\n";
}
