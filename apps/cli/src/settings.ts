import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { getConfig } from "./config.ts";
import { nowIso } from "./db.ts";
import { orm } from "./db/orm.ts";
import { asStore, type Store } from "./db/store.ts";
import { config, skillCursor } from "./db/schema.ts";
import { OPENCODE_HEADLESS_MODEL } from "./headless-run.ts";

export const DEFAULTS: Record<string, string> = {
  github_login: "",
  // 1121: branch_age_days stays -- alert rule 3 (stale branch) and the dashboard's PR age chip read it.
  branch_age_days: "3",
  alert_pr_unreviewed_hours: "24",
  alert_aging_days: "5",
  alert_blocked_days: "3",
  // Per-job health (ob 218). Three consecutive failures, because one is a transient (a DNS blip, a
  // token refresh racing a rotation) and three in a row is a pattern that will not clear itself. All
  // four silent outages ran into the hundreds.
  alert_job_failures: "3",
  // A job is late once it has gone this many of its OWN scheduled intervals without a success, but
  // never sooner than the floor below. The multiple is what lets one setting cover a 300s poll and a
  // monthly backup; the floor is what stops the 300s poll alerting because a laptop was shut for lunch.
  alert_job_stale_multiple: "3",
  alert_job_stale_floor_hours: "24",
  // How many runs in a row may start and never finish before that is a broken job rather than a closed
  // laptop (221). One interruption is normal life; three in a row is a job being killed every time, and
  // this fires long before the stale floor above would notice that it has stopped succeeding.
  alert_job_interruptions: "3",
  // Job names (comma-separated) that raise no health alerts: a job that ships installed-and-disabled on
  // purpose, e.g. whatsapp-sync and whatsapp-bridge, which stay off until the ob 202 bridge window.
  // Empty by default -- silencing a job is a deliberate act, and `ob alerts snooze` is the softer one.
  alert_job_ignore: "",
  // off-machine DB backup target (must be a PRIVATE repo — the backup command refuses public)
  backup_repo: "",
  // Public URL GitHub posts webhook events to (`ob ci hooks`): the API origin plus /api/ob/github/webhook.
  github_webhook_url: "",
  // wayfinder frontier source (221): the GitHub repo whose `wayfinder:task`/`wayfinder:epic` issues are
  // the takeable-ticket frontier surfaced in `ob status`. Maps stay markdown; only the
  // ticket/frontier source is GitHub issues. A config row (not schema) — `owner/name`.
  wayfinder_repo: "",
  // spun-off agents run unattended, so skip permission prompts by default; Opus 5 at medium reasoning
  // effort (#141), matching the live swept value; the model/effort sweep was scoped to builders and
  // spinoffs. The default is what a fresh `ob init` gets,
  // so it drifting from the live value is invisible until the machine that matters is a new one.
  spinoff_agent_cmd: "claude --dangerously-skip-permissions --model claude-opus-5 --effort medium",
  // architect launch command (#84): deliberately EXCLUDED from the builder
  // model/effort sweep (#141): it launches an ARCHITECT, the strategic layer, so it stays on the CLI's own
  // default model and effort. The asymmetry with spinoff_agent_cmd is a decision, not an oversight.
  // `/ob-architect` is the slash command the launched session runs on start.
  architect_cmd: 'claude --dangerously-skip-permissions "/ob-architect"',
  // Which harness a launched agent session runs under: `claude` (Claude Code) or `opencode` (OpenCode).
  // The engine decides every engine-shaped thing about a launch — the command builders
  // (spinoffTabCommand / withSessionID), the headless argv (`-p` vs `run`) and the token reader (Claude's `~/.claude/projects`
  // jsonl vs opencode's own SQLite `session` table). Stamped on the row at launch (spinoff.engine) so
  // reconcile reads the right transcript source even if this setting flips later. `claude` stays the
  // default: existing rows and machines change nothing until they opt in.
  spinoff_engine: "claude",
  // opencode's builder command, the counterpart of spinoff_agent_cmd under spinoff_engine=opencode.
  // V2 TUI `--prompt` only fills the composer; `--auto` is auto-approve, not auto-run.
  // `.opencode/spinoff-tui.sh` creates a session, POST /model pins it to
  // opencode-go/deepseek-v4.1-flash (refusing to continue if the stamp did not take),
  // POST /prompt `{text}` to start the turn, then execs the full TUI with `--session`.
  // Resume is `--session` with no brief. The pin is a session API call, not a `--model` flag.
  // Headless still spawns `opencode run --auto` (the wrapper is not a headless verb).
  // Server headless jobs (suggest, standup, …) pin via opencode_headless_model instead.
  opencode_spinoff_agent_cmd: ".opencode/spinoff-tui.sh",
  // Model pin for server headless `opencode run` jobs (whatsapp describe/suggest/family-update/
  // summarize-day/converse). Not the builder command — do not put `--model` on
  // opencode_spinoff_agent_cmd. describe (images) uses the vision-exp id, not this row.
  opencode_headless_model: OPENCODE_HEADLESS_MODEL,
  // opencode's architect command, the counterpart of architect_cmd. V2 TUI has no `--agent`
  // (that flag is `run`/`mini` only; passing it prints help). Mini is the wrong UI.
  // `.opencode/architect-tui.sh` creates a session, POST /agent architect, POST /model
  // pins it to opencode-go/deepseek-v4.1-flash (refusing to continue if the stamp did
  // not take), then execs the full TUI with `--session`. A `--prompt` kickoff stays on
  // the build agent.
  opencode_architect_cmd: ".opencode/architect-tui.sh",
  // Home Assistant config sync (tar-over-ssh; the VM has no rsync)
  ha_host: "",
  ha_user: "root",
  // The HA notify service the alert digest goes to (`mobile_app_<device>`). Empty: no push is sent.
  ha_notify_service: "",
  // HA long-lived token (121, forward-looking) — file fallback path for the `ha` secret.
  ha_token_path: "~/.ha_token",
  // GitHub token file fallback path for the `github` secret (gh CLI / GITHUB_TOKEN still take priority).
  github_key_path: "~/.github_key",
  // Google connectors (126/127): one combined OAuth token (Gmail + Calendar) at a *_path setting,
  // mirroring ha_token_path / github_key_path. The file holds the OAuth token JSON; never in the DB.
  google_token_path: "~/.google_token",
  // which Calendar(s) to poll (comma-separated calendarId list; "primary" = the account's own calendar)
  google_calendar_ids: "primary",
  // WhatsApp (personal) read-only ingest (099/100): the Go bridge's SQLite messages.db. ob opens this
  // file READ-ONLY and never writes it (sending is a separate, later ticket).
  whatsapp_db_path: "~/dev/whatsapp-mcp/whatsapp-bridge/store/messages.db",
  // WhatsApp contact names (156): the bridge's OWN address book (`whatsmeow_contacts` in whatsapp.db,
  // sibling of messages.db). ob opens it READ-ONLY to resolve a chat's display name (full/push/business/
  // first name) so the feed shows people, not phone numbers. Empty = derive the `whatsapp.db` sibling of
  // whatsapp_db_path; absent DB degrades gracefully to chat_name/jid.
  whatsapp_contacts_db_path: "",
  // WhatsApp OUTBOUND send (101): the Go bridge's loopback REST API + its bearer token file. ob only
  // ever POSTs localhost here; the bridge is the one that talks to WhatsApp. Send is gated by an
  // explicit human confirmation in sendWhatsapp() — there is no send path without it.
  // WhatsApp pairing QR (274): the file the bridge writes the CURRENT QR payload to whenever whatsmeow
  // emits one, so re-linking is a page on the dashboard instead of a terminal on the box tailing a log
  // whose QR line is truncated. ob only ever READS it. Empty = derive the `qr.json` sibling of
  // whatsapp_db_path (the bridge's own store dir).
  whatsapp_qr_path: "",
  whatsapp_bridge_url: "http://127.0.0.1:8080",
  whatsapp_bridge_token_path: "~/dev/whatsapp-mcp/whatsapp-bridge/store/.bridge-token",
  // WhatsApp media proxy + voice-note transcription (158/162). The proxy streams a message's image/audio
  // via the bridge's POST /api/download (token stays server-side) and caches the decrypted bytes here,
  // keyed by (chat_jid, id). Empty cache dir = derive `<XDG_DATA_HOME|~/.local/share>/omnislash/wa-media`.
  whatsapp_media_cache_dir: "",
  // WhatsApp profile-picture (avatar) proxy (163). The proxy streams a chat/group profile picture via the
  // bridge's GET /api/avatar?jid= (token stays server-side) and caches the bytes here, keyed by jid, with
  // a long TTL (avatars change rarely). Empty = derive `<XDG_DATA_HOME|~/.local/share>/omnislash/wa-avatars`.
  whatsapp_avatar_cache_dir: "",
  // On-demand voice-note STT (158/201): local whisper (needs ffmpeg to decode ogg/opus). Two flavours
  // behind the SttEngine seam, chosen by `whisper_engine` or auto-detected from `whisper_bin_path`'s
  // basename (`whisper-cli`/`main` → whisper.cpp; `whisper` → openai-whisper). Default = whisper.cpp
  // (light, no Python; the installed flavour). `whisper_model` is engine-specific — for whisper.cpp it's a
  // PATH to a ggml-*.bin, for openai-whisper a model NAME; left empty here so each engine self-defaults
  // (whisper.cpp → the OmniSlash model dir's ggml-base.bin; openai-whisper → "base"). All detected on PATH;
  // if a binary/model is absent the feed degrades gracefully to a "transcription unavailable" hint (no fail).
  whisper_bin_path: "whisper-cli",
  whisper_model: "",
  ffmpeg_bin_path: "ffmpeg",
  // whisper flavour: "whisper.cpp" | "openai-whisper" (empty → auto-detect from whisper_bin_path basename).
  whisper_engine: "",
  // On-demand WhatsApp image VISION-DESCRIBE (198b/378). The DEFAULT engine is mlx-vlm (decision #31 —
  // fully local: nothing leaves the machine; Qwen2.5-VL covers casual photos AND UI screenshots).
  // `vision_engine` selects it or explicitly opts BACK into the old claude runner (`claude` — the one
  // engine that sends image bytes to Anthropic, never the default). `vision_model` is the HF repo the
  // FIRST run downloads (GBs — hence the generous `vision_timeout`); `vision_bin_path` is the console
  // script `pip install -U mlx-vlm` installs (`mlx_lm.generate` is the mlx-LM CLI and has NO --image
  // flag). Detected on PATH (or an absolute path); if absent the image degrades gracefully to a
  // "[image]" placeholder (no fail).
  vision_engine: "",
  vision_model: "mlx-community/Qwen2.5-VL-7B-Instruct-4bit",
  vision_bin_path: "mlx_vlm.generate",
  vision_timeout: "300000",
  // Spinoff launcher seam (154; warp removed: #79, the interactive app retired: ob 1109, the headless
  // launcher retired: ob 1589): `t3` opens a T3 thread bound to the row's worktree. It is the only value
  // `config set` accepts; a legacy value recorded on an existing row still reads as itself.
  spinoff_launcher: "t3",
  // Per-repo launcher override (#83): a JSON object mapping a repo's basename (its last path segment,
  // same key as repo_checkouts) to a launcher value (t3). A repo present here uses its mapped
  // launcher instead of the global spinoff_launcher; a repo absent from the map, or mapped to an unknown
  // value, falls back to spinoff_launcher.
  spinoff_launcher_by_repo: "{}",
  // Spinoff complexity tier → model (1480): a JSON object naming the model a `t3` build runs on for any of
  // the tiers `ob spinoff --tier complex|medium|simple` takes, on the T3 project's own provider instance
  // (1549: or `<provider>:<model>` to name another instance, e.g. `opencode:opencode-go/deepseek-v4.1-flash`).
  // Empty = the defaults (DEFAULT_TIER_MODELS in t3/dispatch.ts: complex Opus, medium Sonnet, simple
  // Haiku); a tier left out keeps its default. Malformed JSON, an unknown tier, or a model T3's catalog does not list
  // is a NAMED refusal at launch, never a fallback.
  spinoff_tier_models: "",
  // Spinoff --repo slug resolution (#61): a JSON object mapping a slug (or its last path segment) to an
  // absolute local checkout, e.g. {"owner/app": "/Users/j/dev/app"}. Consulted when
  // --repo is not itself an existing git-repo directory, before the ~/dev/<name> fallback.
  repo_checkouts: "{}",
  // WhatsApp Go bridge binary (161) — `ob whatsapp bridge start|stop|status` manages its lifecycle and
  // the `whatsapp-bridge` daemon slot (KeepAlive + RunAtLoad) keeps it up. Spawned detached with cwd =
  // its own dir (it needs `store/` beside it) + env WHATSAPP_BRIDGE_PORT parsed from whatsapp_bridge_url.
  whatsapp_bridge_bin: "~/dev/whatsapp-mcp/whatsapp-bridge/whatsapp-bridge",
  // Global self-bio (#28): a short first-person description of the owner ("who I am / what I do / how I
  // talk") woven into EVERY suggested reply as a TRUSTED, additive block near the top of the prompt, so
  // drafts sound like him without re-declaring it per chat. A config row (not schema); empty by default
  // (omitted from the prompt when blank → the exact prior 104/142 shape). Set via `ob whatsapp bio`.
  self_bio: "",
  // Where `ob web` listens (192): the dashboard on :5050 and its realtime sidecar on :5051 both bind
  // this address. Loopback by default, so a laptop serves nobody but itself; the always-on server sets
  // its LAN address or, if a wildcard is genuinely needed, "0.0.0.0" deliberately.
  // `--bind` and OMNISLASH_WEB_BIND both outrank this row.
  web_bind: "127.0.0.1",
  // TLS for the dashboard (220). EMPTY BY DEFAULT ON PURPOSE: a laptop install has no certificate, and
  // the absence of one is plain HTTP rather than an error. Set, they are a promise of TLS: a path that
  // does not exist (yet) stops `ob web` rather than downgrading it (1383). Both must be set together, and both
  // are outranked by --tls-cert/--tls-key and by OMNISLASH_WEB_TLS_CERT/OMNISLASH_WEB_TLS_KEY (the form the
  // server's systemd unit uses). The key is secret material: mode 0600, never in git, never in a backup.
  web_tls_cert: "",
  web_tls_key: "",
  // The name the certificate is issued for, and the only name it is valid for. Empty means this machine
  // does not do TLS at all, which is what makes `ob cert renew` a no-op on a laptop instead of a daily
  // failing job. It resolves to the LAN address through a Pi-hole Local DNS record, never a public A record.
  tls_domain: "",
  // The Let's Encrypt account contact. Required once tls_domain is set (the CA will not issue without one).
  tls_email: "",
  // Where the installed material and lego's own storage live. Owned by the service user, mode 0700.
  tls_dir: "/etc/omnislash/tls",
  // Renew when fewer than this many days remain. Let's Encrypt issues for 90; 30 leaves a month of
  // daily retries before anything expires, so a broken renewal is an alert long before it is an outage.
  tls_renew_days: "30",
  // The ACME client `ob cert renew` drives. A seam, so a newer upstream binary can replace Debian's
  // packaged one by setting this row rather than by changing code.
  lego_bin: "lego",
};

// 337: the SYNCHRONOUS, sqlite-only read behind `setting()`.
//
// config.ts's getConfig went async with the port, and `setting()` cannot follow it: it has ~90 call
// sites through whatsapp, net, cert, credentials, spinoff and the connectors, none of them ported, all
// of which would have to become async in the same change. So the unported callers keep a synchronous
// read of the same table, and it is honest about being sqlite-only rather than pretending to be
// engine-agnostic. It is only reachable from a raw handle, and in postgres mode an unported command
// never gets one (db.ts's guard refuses to open the file), so this cannot quietly answer from the wrong
// engine. A ported caller uses settingFor() below.
function sqliteSetting(db: Database, key: string): string | null {
  const row = orm(db).select({ value: config.value }).from(config).where(eq(config.key, key)).get();
  return row ? row.value : null;
}

/**
 * The opencode architect command: the stored value, else the default. The key is new in OB-2256, so no
 * pre-433 default was ever stored under it and there is nothing to upgrade.
 */
export function effectiveOpencodeArchitectCmd(stored: string | null): string {
  return stored ?? DEFAULTS.opencode_architect_cmd!;
}

/** Pre-815 default: V2 `--prompt` filled the composer and never submitted. */
export const LEGACY_OPENCODE_SPINOFF_AGENT_CMDS = ["opencode --auto"] as const;
export const LEGACY_OPENCODE_SPINOFF_AGENT_CMD = LEGACY_OPENCODE_SPINOFF_AGENT_CMDS[0];

export function effectiveOpencodeSpinoffAgentCmd(stored: string | null): string {
  if (stored === null || (LEGACY_OPENCODE_SPINOFF_AGENT_CMDS as readonly string[]).includes(stored)) {
    return DEFAULTS.opencode_spinoff_agent_cmd!;
  }
  return stored;
}

export function setting(db: Database, key: string): string {
  const raw = sqliteSetting(db, key);
  if (key === "opencode_architect_cmd") return effectiveOpencodeArchitectCmd(raw);
  if (key === "opencode_spinoff_agent_cmd") return effectiveOpencodeSpinoffAgentCmd(raw);
  return raw ?? DEFAULTS[key] ?? "";
}

export function settingNum(db: Database, key: string): number {
  return Number(setting(db, key));
}

/** The store-aware form of `setting()`, for ported callers. Same precedence: row, then DEFAULTS, then "". */
export async function settingFor(db: Database | Store, key: string): Promise<string> {
  const raw = await getConfig(asStore(db), key);
  if (key === "opencode_architect_cmd") return effectiveOpencodeArchitectCmd(raw);
  if (key === "opencode_spinoff_agent_cmd") return effectiveOpencodeSpinoffAgentCmd(raw);
  return (raw ?? DEFAULTS[key] ?? "") as string;
}

/** The store-aware form of `settingNum()`. */
export async function settingNumFor(db: Database | Store, key: string): Promise<number> {
  return Number(await settingFor(db, key));
}

// --- sync cursors (in skill_cursor under the "omnislash" skill) ---

export function getCursor(db: Database, key: string): string | null {
  const row = orm(db)
    .select({ value: skillCursor.value })
    .from(skillCursor)
    .where(and(eq(skillCursor.skill, "omnislash"), eq(skillCursor.key, key)))
    .get();
  return row?.value ?? null;
}

/**
 * The store-aware form of `getCursor()`, for ported callers (337). `ob log list` reads the standup
 * cursor to decide its default `--since`; every other cursor caller is a connector on the unported
 * synchronous path above, which is why that one stays.
 */
export async function getCursorFor(db: Database | Store, key: string): Promise<string | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ value: s.t.skillCursor.value })
    .from(s.t.skillCursor)
    .where(and(eq(s.t.skillCursor.skill, "omnislash"), eq(s.t.skillCursor.key, key)))
    .limit(1)) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

export function setCursor(db: Database, key: string, value: string): void {
  orm(db)
    .insert(skillCursor)
    .values({ skill: "omnislash", key, value, updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: [skillCursor.skill, skillCursor.key],
      set: { value, updatedAt: nowIso() },
    })
    .run();
}

/**
 * Advance a sync cursor (337). Every sync job advances one, so this is what stops an ingest run from
 * re-reading its whole window every time.
 *
 * Named `...For` beside the synchronous `setCursor` rather than replacing it, deliberately and
 * temporarily: `setCursor`/`getCursor` still have call sites in commands/standup.ts and
 * commands/scopechange.ts, which are being ported on other branches in parallel. Collapsing the name
 * here would break those mid-flight. They collapse when the last synchronous caller goes.
 */
export async function setCursorFor(db: Database | Store, key: string, value: string): Promise<void> {
  const s = asStore(db);
  const now = nowIso();
  await s.q
    .insert(s.t.skillCursor)
    .values({ skill: "omnislash", key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: [s.t.skillCursor.skill, s.t.skillCursor.key],
      set: { value, updatedAt: now },
    });
}

/** Which "since" an incremental sync should use, given the stored cursor. PURE. */
export function decideSince(
  cursor: string | null,
  flagSince: string | undefined,
  backfill: boolean,
): string {
  if (flagSince) return normalizeSince(flagSince);
  if (!backfill && cursor) return cursor;
  // backfill / first run: ~2 quarters (183 days) ago
  return new Date(Date.now() - 183 * 24 * 3600 * 1000).toISOString();
}

/** Resolve the effective "since" for an incremental sync: explicit flag > cursor > backfill window. */
export async function resolveSince(
  store: Store,
  cursorKey: string,
  flagSince: string | undefined,
  backfill: boolean,
): Promise<string> {
  return decideSince(backfill ? null : await getCursorFor(store, cursorKey), flagSince, backfill);
}

/** Normalize a `--since` value (ISO, YYYY-MM-DD, or "-Nd") to an absolute ISO-8601 instant. */
export function normalizeSince(s: string): string {
  // accept ISO, YYYY-MM-DD, or "-Nd"
  const rel = s.match(/^-(\d+)d$/);
  if (rel) return new Date(Date.now() - Number(rel[1]) * 24 * 3600 * 1000).toISOString();
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return s;
}
