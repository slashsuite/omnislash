import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { Database } from "bun:sqlite";

// Token usage of a spun-off agent, recovered from its Claude Code session transcript(s) (#55). Claude
// Code writes each session to ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, where <encoded-cwd>
// is the worktree's absolute cwd with every "/" and "." replaced by "-" (the leading slash therefore
// becomes a leading dash). Every assistant event carries `message.usage`; summing across all of them
// gives the per-spinoff totals. Kept pure + base-dir-injected so tests point it at a fixture dir.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
}

/** Encode an absolute worktree cwd the way Claude Code names its project dir: "/" and "." both become "-". Pure. */
export function encodeCwd(worktree: string): string {
  return worktree.replace(/[/.]/g, "-");
}

/** The base dir Claude Code writes session transcripts under. */
export function defaultClaudeProjectsDir(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

/** The project dir for a worktree, under a given claude-projects base dir. Pure. */
export function claudeProjectDir(baseDir: string, worktree: string): string {
  return join(baseDir, encodeCwd(worktree));
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Sum the token usage across every session transcript in a worktree's Claude Code project dir. The
 * project dir is derived from `baseDir` + the encoded worktree cwd (baseDir injected so tests point at
 * a fixture). Reads all *.jsonl files there, sums `message.usage` over assistant events, and returns
 * the four component totals plus their sum. Missing dir / malformed lines are handled gracefully (bad
 * lines skipped; zeros when nothing is found). Pure w.r.t. its inputs (only reads the given dir).
 */
export function sumSessionTokens(baseDir: string, worktree: string): TokenUsage {
  const dir = claudeProjectDir(baseDir, worktree);
  const usage = zeroUsage();
  if (!existsSync(dir)) return usage;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return usage;
  }

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: { type?: string; message?: { usage?: RawUsage } };
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue; // malformed line — skip
      }
      const u = event.message?.usage;
      if (!u || event.type !== "assistant") continue;
      usage.inputTokens += num(u.input_tokens);
      usage.outputTokens += num(u.output_tokens);
      usage.cacheCreationTokens += num(u.cache_creation_input_tokens);
      usage.cacheReadTokens += num(u.cache_read_input_tokens);
    }
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  return usage;
}

// --- per-SESSION totals (#142) ----------------------------------------------
// `sumSessionTokens` above sums EVERY transcript in a project dir, which is right for a spinoff (a fresh
// worktree with one session in it) and wrong for an architect, whose cwd is the repo root: there the dir
// accumulates every session ever run there, so the "session" total is really an all-time repo total.
// These two read ONE session instead. Deliberately separate rather than a flag on the function above, so
// the reconcile path's meaning does not change.

/**
 * Sum one session's transcript (`<sessionId>.jsonl`) in a worktree's project dir. Zeros when that file is
 * absent or unreadable, and malformed lines are skipped, exactly like `sumSessionTokens`. Pure w.r.t. its
 * inputs (reads only that one file).
 */
export function sessionTokens(baseDir: string, worktree: string, sessionId: string): TokenUsage {
  const usage = zeroUsage();
  const path = join(claudeProjectDir(baseDir, worktree), `${sessionId}.jsonl`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return usage;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: string; message?: { usage?: RawUsage } };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // malformed line, skip
    }
    const u = event.message?.usage;
    if (!u || event.type !== "assistant") continue;
    usage.inputTokens += num(u.input_tokens);
    usage.outputTokens += num(u.output_tokens);
    usage.cacheCreationTokens += num(u.cache_creation_input_tokens);
    usage.cacheReadTokens += num(u.cache_read_input_tokens);
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  return usage;
}

/**
 * The id of the most recently WRITTEN session transcript in a worktree's project dir, or null when there
 * is none. Most-recently-written rather than newest-created because a session that is still running is the
 * one being appended to, and "which session is this architect in" is what the caller is really asking.
 */
export function latestSessionID(baseDir: string, worktree: string): string | null {
  const dir = claudeProjectDir(baseDir, worktree);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best: { id: string; mtimeMs: number } | null = null;
  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(dir, file)).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) best = { id: file.replace(/\.jsonl$/, ""), mtimeMs };
  }
  return best?.id ?? null;
}

/** OB-1993: the env override for the Claude projects dir the transcript reader sums (a test seam, like the opencode one). */
export const CLAUDE_PROJECTS_DIR_ENV = "OMNISLASH_CLAUDE_PROJECTS_DIR";

/** The default reader used at reconcile: the real ~/.claude/projects for a worktree (or the env override). */
export function readSpinoffTokens(worktree: string, home?: string): TokenUsage {
  // An explicit `home` wins; the env override only replaces the default (OB-1993: Bun's homedir() ignores a runtime HOME).
  const override = home === undefined ? process.env[CLAUDE_PROJECTS_DIR_ENV] : undefined;
  return sumSessionTokens(override ? override : defaultClaudeProjectsDir(home ?? homedir()), worktree);
}

// --- the opencode engine seat (0023) ---------------------------------------
// opencode keeps no `~/.claude/projects` transcripts: a launch composed for the `opencode` engine leaves
// its token accounting in opencode's own SQLite database (`session` table), keyed by the absolute session
// `directory` instead of an encoded project-dir, with the four buckets as SUM-able columns rather than
// per-message usage blocks. So the opencode reader mirrors `readSpinoffTokens`' contract — same
// `TokenUsage`, same "wrong engine on the wrong dir reads zeros rather than throws" grace — but reads a
// single SUM over that table instead of walking jsonl lines. Kept beside the claude reader, never
// folded into it, so `readSpinoffTokens`' semantics cannot change by indirection.

/** The env override (and the default) for the opencode DB path the opencode reader queries. */
export const OPENCODE_DB_PATH_ENV = "OMNISLASH_OPENCODE_DB_PATH";

/** Test seam: `off` skips the API, a path is a JSON fixture. Unset shells `opencode api`. */
export const OPENCODE_API_SESSIONS_ENV = "OMNISLASH_OPENCODE_API_SESSIONS";

/**
 * The opencode SQLite database path: the `OMNISLASH_OPENCODE_DB_PATH` override when set, else opencode's
 * standard data-dir seat (`$XDG_DATA_HOME/opencode/opencode.db`, with the flat
 * `~/.local/share/opencode/opencode.db` fallback). Pure given its inputs.
 */
export function defaultOpencodeDbPath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OPENCODE_DB_PATH_ENV];
  if (override && override.length > 0) return override;
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "opencode", "opencode.db");
  return join(home, ".local", "share", "opencode", "opencode.db");
}

/**
 * Sum every opencode session in `worktree`'s `session` table into the same `TokenUsage` shape the claude
 * reader produces, so reconcile and the land/stamp columns never change by engine. opencode's buckets map
 * one-for-one onto the shared shape: `tokens_input` -> input, `tokens_output` -> output,
 * `tokens_cache_write` -> cacheCreation (both are "tokens written into the prompt cache"),
 * `tokens_cache_read` -> cacheRead. The directory is matched both as given and via realpath, because a
 * macOS `/tmp` vs `/private/tmp` spelling must not read as two worktrees. Missing db / missing rows /
 * a sqlite error all return zeros rather than throw — the same grace the claude reader has for a missing
 * dir, since a wrong engine on the wrong machine must land a row, not fail the drain.
 */
export function readOpencodeSpinoffTokens(worktree: string, dbPath: string = defaultOpencodeDbPath()): TokenUsage {
  return readOpencodeSpinoffUsage(worktree, dbPath).usage;
}

/** OB-1991: the tables opencode keeps sessions in. opencode 2.x writes `session_v2`; the legacy `session` stopped
 *  growing. A session sits in one or the other, never both, so the two are summed. */
const OPENCODE_SESSION_TABLES = ["session", "session_v2"] as const;

/**
 * A worktree's opencode tokens AND opencode's own reported `cost` (USD as opencode reports it), summed over
 * `session` and `session_v2` (OB-1991). A table that is missing, or lacks a `cost` column, contributes nothing
 * rather than failing the read. `cost` is null when no table carried one for this directory.
 */
export function readOpencodeSpinoffUsage(worktree: string, dbPath: string = defaultOpencodeDbPath()): { usage: TokenUsage; cost: number | null } {
  const usage = zeroUsage();
  let cost: number | null = null;
  const dirs = [...new Set([worktree, readWorktreeRealpath(worktree)])];
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return { usage, cost };
  }
  try {
    const placeholders = dirs.map(() => "?").join(", ");
    for (const table of OPENCODE_SESSION_TABLES) {
      let r: Record<string, unknown> | undefined;
      try {
        r = (db
          .query(
            `SELECT COALESCE(SUM(tokens_input), 0)       AS input_tokens,
                    COALESCE(SUM(tokens_output), 0)      AS output_tokens,
                    COALESCE(SUM(tokens_cache_write), 0) AS cache_write_tokens,
                    COALESCE(SUM(tokens_cache_read), 0)  AS cache_read_tokens,
                    COUNT(*)                             AS sessions
               FROM ${table} WHERE directory IN (${placeholders})`,
          )
          .all(...dirs) as Array<Record<string, unknown>>)[0];
      } catch {
        continue; // this machine's opencode has no such table
      }
      if (!r) continue;
      usage.inputTokens += num(r.input_tokens);
      usage.outputTokens += num(r.output_tokens);
      usage.cacheCreationTokens += num(r.cache_write_tokens);
      usage.cacheReadTokens += num(r.cache_read_tokens);
      if (num(r.sessions) === 0) continue;
      try {
        const c = (db.query(`SELECT SUM(cost) AS cost FROM ${table} WHERE directory IN (${placeholders})`).all(...dirs) as Array<Record<string, unknown>>)[0];
        if (c && c.cost !== null && c.cost !== undefined && Number.isFinite(Number(c.cost))) cost = (cost ?? 0) + Number(c.cost);
      } catch {
        // an older table with no cost column: tokens only
      }
    }
  } finally {
    db.close();
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  return { usage, cost };
}

/**
 * Which reader a row's tokens come from (OB-1991): the provider its stamped model names, `claudeAgent…` (the
 * Claude transcripts) or `opencode…` (opencode's tables). Only a model that names no provider falls back to the
 * `engine` stamp, because T3 rows on a `claudeAgent:` model are stamped engine `opencode`. Pure.
 */
export function tokenSourceFor(row: { engine?: string | null; model?: string | null }): "claude" | "opencode" {
  const provider = /^([A-Za-z][\w-]*):/.exec((row.model ?? "").trim())?.[1]?.toLowerCase() ?? "";
  if (provider.startsWith("claudeagent") || provider === "claude") return "claude";
  if (provider.startsWith("opencode")) return "opencode";
  return row.engine === "opencode" ? "opencode" : "claude";
}

/**
 * The unique ROOT opencode session in `directory`, or null when there is not exactly one (384).
 *
 * opencode mints `ses_…` ids when a session starts and `--session` only CONTINUES an existing one,
 * so a launch cannot name the id in advance. After the TUI exists the id is in opencode.db: a root
 * (`parent_id IS NULL`) that is not archived, keyed by the session `directory`. 0 matches or >1
 * matches both return null — guessing would resume a subagent or someone else's conversation, which
 * is why `--continue` is forbidden. `notBeforeMs` (a launch's `launchedAtMs`) and `excludeIds` narrow
 * a shared repo that holds many roots down to the one this launch created. Missing db / sqlite error
 * / a directory that cannot be read all return null, same grace as the token reader.
 */
function opencodeRootIds(
  directory: string,
  opts: { notBeforeMs?: number; excludeIds?: string[]; dbPath?: string } = {},
): string[] | null {
  const dbPath = opts.dbPath ?? defaultOpencodeDbPath();
  const dirs = [...new Set([directory, readWorktreeRealpath(directory)])];
  const exclude = opts.excludeIds ?? [];
  const since = opts.notBeforeMs;
  const hasSince = since != null && Number.isFinite(since);
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const dirPh = dirs.map(() => "?").join(", ");
      const exclPh = exclude.length > 0 ? ` AND id NOT IN (${exclude.map(() => "?").join(", ")})` : "";
      const sincePh = hasSince ? " AND time_created >= ?" : "";
      const params: Array<string | number> = [...dirs, ...exclude];
      if (hasSince) params.push(since);
      const rows = db
        .query(
          `SELECT id FROM session
            WHERE parent_id IS NULL
              AND time_archived IS NULL
              AND directory IN (${dirPh})${exclPh}${sincePh}`,
        )
        .all(...params) as Array<{ id: string }>;
      return rows.map((r) => r.id).filter((id) => typeof id === "string" && id.length > 0);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function rootOpencodeSessionId(
  directory: string,
  opts: { notBeforeMs?: number; excludeIds?: string[]; dbPath?: string } = {},
): string | null {
  const ids = opencodeRootIds(directory, opts);
  if (!ids || ids.length !== 1) return null;
  return ids[0] ?? null;
}

/** One session the OpenCode HTTP API knows about. architect-tui.sh writes here; sqlite may not. */
export interface OpencodeApiSession {
  id: string;
  directory: string;
  agent: string | null;
  timeCreated: number | null;
  parentId: string | null;
}

/**
 * Parse `opencode api get /api/session` stdout. `{data: [...]}` or a bare array.
 * Unparseable is null (unreadable), not an empty list — empty means the server
 * answered and there are no sessions.
 */
export function parseOpencodeApiSessionList(raw: string): OpencodeApiSession[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const data = parsed && typeof parsed === "object" && "data" in parsed ? (parsed as { data: unknown }).data : parsed;
  if (!Array.isArray(data)) return null;
  const out: OpencodeApiSession[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const location = rec.location;
    const directory =
      location && typeof location === "object" && typeof (location as { directory?: unknown }).directory === "string"
        ? (location as { directory: string }).directory
        : typeof rec.directory === "string"
          ? rec.directory
          : "";
    const time = rec.time;
    const created =
      time && typeof time === "object" && typeof (time as { created?: unknown }).created === "number"
        ? (time as { created: number }).created
        : typeof rec.time_created === "number"
          ? rec.time_created
          : null;
    const parent = rec.parentID ?? rec.parent_id;
    out.push({
      id,
      directory,
      agent: typeof rec.agent === "string" && rec.agent.length > 0 ? rec.agent : null,
      timeCreated: created != null && Number.isFinite(created) ? created : null,
      parentId: typeof parent === "string" && parent.length > 0 ? parent : null,
    });
  }
  return out;
}

/**
 * Sessions the running OpenCode service has for `directory`. `off` is an empty
 * answer (tests). A path is a fixture file. Unset shells `opencode api`. A
 * shell or parse failure is null — unreadable, not "no sessions".
 */
export function listOpencodeApiSessions(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): OpencodeApiSession[] | null {
  const override = env[OPENCODE_API_SESSIONS_ENV];
  if (override === "off") return [];
  if (override && override.length > 0) {
    try {
      return parseOpencodeApiSessionList(readFileSync(override, "utf8"));
    } catch {
      return null;
    }
  }
  try {
    const q = new URLSearchParams({ directory, parentID: "null", limit: "50", order: "desc" });
    const r = Bun.spawnSync(["opencode", "api", "get", `/api/session?${q}`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return null;
    return parseOpencodeApiSessionList(new TextDecoder().decode(r.stdout));
  } catch {
    return null;
  }
}

/**
 * The OpenCode agent names an architect session carries. `planner` is the agent file's name before OB-2256: a
 * session OpenCode recorded then keeps it, and OpenCode's store is not ours to rewrite.
 */
const ARCHITECT_SESSION_AGENTS: ReadonlySet<string> = new Set(["architect", "planner"]);

/**
 * The unique session a tab may resume (ob 932). Sqlite roots, plus the OpenCode
 * API when it can be read: architect-tui.sh creates the session there and it is
 * not always a row in opencode.db. `--kind architect` keeps only `agent=architect`
 * API rows so a build session in the same directory is not a candidate.
 * 0 or >1 is null. Never a guess, never `--continue`. An unreadable API leaves
 * the sqlite answer alone.
 */
export function capturedOpencodeSessionId(
  directory: string,
  opts: {
    notBeforeMs?: number;
    kind?: "architect" | "agent";
    excludeIds?: string[];
    dbPath?: string;
    apiSessions?: OpencodeApiSession[] | null;
  } = {},
): string | null {
  const sqlite = opencodeRootIds(directory, opts) ?? [];
  const api = opts.apiSessions === undefined ? listOpencodeApiSessions(directory) : opts.apiSessions;
  const dirs = new Set([directory, readWorktreeRealpath(directory)]);
  const since = opts.notBeforeMs;
  const hasSince = since != null && Number.isFinite(since);
  const kind = opts.kind ?? "agent";
  const apiIds = (api ?? [])
    .filter((s) => s.parentId == null && dirs.has(s.directory))
    .filter((s) => (kind === "architect") === ARCHITECT_SESSION_AGENTS.has(s.agent ?? ""))
    .filter((s) => !hasSince || (s.timeCreated != null && s.timeCreated >= since))
    .map((s) => s.id);
  const ids = [...new Set([...sqlite, ...apiIds])];
  return ids.length === 1 ? ids[0]! : null;
}

/**
 * One opencode session's weight for the architect checkpoint (ob 518/545), or null when there is
 * nothing to read.
 *
 * `readOpencodeSpinoffTokens` SUMs every session in the directory, which is right for a spinoff
 * (one tab, one worktree) and wrong for an architect: the checkout holds other tabs, and summing them
 * would count them. `rootOpencodeSessionId` refuses when there is not exactly one root, which is
 * right for resume and wrong for a weight: the architect still has a latest session. This picks the
 * latest non-archived root (`parent_id IS NULL`, `time_archived IS NULL`) for the worktree
 * (directory + realpath), or the named id when given. The spent figure is the latest **completed**
 * assistant message's `data.tokens.total` — the number OpenCode's footer shows — not
 * `session.tokens_*` (those are lifetime, cache reads dominate, and were the 518 bug). Missing db /
 * sqlite error / no matching session / no completed assistant / unparseable `data` return null —
 * UNREADABLE, never a confident 0. `turns` stays 0 (do not invent a count).
 */
export function readOpencodeSessionWeight(
  worktree: string,
  opts: { sessionID?: string | null; dbPath?: string } = {},
): {
  session_id: string;
  total_tokens: number;
  context_tokens: number;
  turns: number;
  last_at: string | null;
} | null {
  const dbPath = opts.dbPath ?? defaultOpencodeDbPath();
  const dirs = [...new Set([worktree, readWorktreeRealpath(worktree)])];
  const sessionID = opts.sessionID;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const dirPh = dirs.map(() => "?").join(", ");
      const row = (
        sessionID
          ? db
              .query(
                `SELECT id FROM session
                  WHERE id = ? AND directory IN (${dirPh})`,
              )
              .get(sessionID, ...dirs)
          : db
              .query(
                `SELECT id FROM session
                  WHERE parent_id IS NULL
                    AND time_archived IS NULL
                    AND directory IN (${dirPh})
                  ORDER BY COALESCE(time_updated, time_created, 0) DESC
                  LIMIT 1`,
              )
              .get(...dirs)
      ) as { id: string } | null | undefined;
      if (!row || typeof row.id !== "string" || row.id.length === 0) return null;
      const msg = db
        .query(
          `SELECT data FROM message
            WHERE session_id = ?
              AND json_extract(data, '$.role') = 'assistant'
              AND json_extract(data, '$.time.completed') IS NOT NULL
            ORDER BY time_created DESC, id DESC
            LIMIT 1`,
        )
        .get(row.id) as { data: unknown } | null | undefined;
      const weight = weightFromAssistantData(msg?.data);
      if (!weight) return null;
      return {
        session_id: row.id,
        total_tokens: weight.total,
        context_tokens: weight.context,
        turns: 0,
        last_at: weight.last_at,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Last-turn weight from one OpenCode assistant `message.data` blob (545). `total` is `tokens.total`
 * (the footer number). `context` is input + cache.read + cache.write. Null when the blob is missing,
 * not JSON, not a completed assistant, or `tokens.total` is not a finite number — never a confident 0.
 */
function weightFromAssistantData(raw: unknown): { total: number; context: number; last_at: string | null } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (rec.role !== "assistant") return null;
  const time = rec.time;
  const completed =
    time && typeof time === "object" ? (time as Record<string, unknown>).completed : undefined;
  if (typeof completed !== "number" || !Number.isFinite(completed)) return null;
  const tokens = rec.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const t = tokens as Record<string, unknown>;
  if (typeof t.total !== "number" || !Number.isFinite(t.total)) return null;
  const cache = t.cache && typeof t.cache === "object" ? (t.cache as Record<string, unknown>) : null;
  return {
    total: t.total,
    context: num(t.input) + num(cache?.read) + num(cache?.write),
    last_at: completed > 0 ? new Date(completed).toISOString() : null,
  };
}

/** The worktree path canonicalised, or the path as given when it cannot be resolved. Pure. */
function readWorktreeRealpath(worktree: string): string {
  try {
    return realpathSync(worktree);
  } catch {
    return worktree;
  }
}

/** Compact human formatting of a token total, e.g. 106500 -> "106.5k", 1_200_000 -> "1.2M". Pure. */
export function formatTokens(n: number | null | undefined): string {
  if (!n || n <= 0) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * OB-1993: a row's tokens, read on THIS machine with the reader its model names (OB-1991). The one expression the
 * client halves share: reconcile, `ob close` over the API, and `ob spinoff tokens backfill`. Only the machine that
 * ran the builder has its transcripts, so the reading always happens on the client and the server only records.
 */
export function readRowTokens(row: { engine?: string | null; model?: string | null; worktree: string }): TokenUsage {
  return tokensForRow(row)(row.worktree);
}

/** Reads the token usage of a spinoff's worktree. Injectable for tests. */
export type TokenReader = (worktree: string) => TokenUsage;

/** OB-1991: the token reader for a ROW: the provider its stamped model names, the engine only when it names none. */
export function tokensForRow(row: { engine?: string | null; model?: string | null }): TokenReader {
  return tokenSourceFor(row) === "opencode" ? readOpencodeSpinoffTokens : readSpinoffTokens;
}
