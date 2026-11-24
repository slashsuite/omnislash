import type { Database } from "bun:sqlite";
import { bareNumberCollision, bareNumberCollisionMessage, refsFor, resolveItemId } from "./refs.ts";
import { emitId, type Mode } from "./output.ts";
import { AppError } from "./errors.ts";
import type { RemoteWriter } from "./remote.ts";
import { getItem, type ItemRow } from "./items.ts";
import type { Store } from "./db/store.ts";

export interface Flags {
  json?: boolean;
  quiet?: boolean;
  table?: boolean;
  key?: string;
  db?: string;
  /** ob 183: force the local read replica. No ssh dispatch and no network: offline work and debugging. */
  local?: boolean;
  "no-daemon"?: boolean;
  help?: boolean;
  type?: string;
  kind?: string;
  project?: string;
  priority?: string;
  body?: string;
  tag?: string[];
  link?: string;
  url?: string;
  title?: string;
  reason?: string;
  summary?: string;
  missed?: string;
  refs?: string;
  owner?: string;
  rank?: string;
  /** OB-2083: `ob order`. */
  top?: boolean;
  before?: string;
  after?: string;
  clear?: boolean;
  open?: boolean;
  status?: string;
  since?: string;
  /** OB-2278: `ob usage day`. */
  until?: string;
  compare?: boolean;
  days?: string;
  query?: string;
  max?: string;
  "updated-after"?: string;
  /** OS-170: `ob machine audit`. */
  "stale-days"?: string;
  by?: string;
  /** `ob inbox --read <id>`: the first message id to mark read. */
  read?: string;
  /** OS-55: `ob role brief --peek`: show the note without consuming it. */
  peek?: boolean;
  limit?: string;
  remote?: string;
  /** OB-2116: `project add|edit --icon <emoji>`; '' clears on edit. */
  icon?: string;
  /** OB-2116: `project add|edit --display-name <text>`; '' clears on edit. */
  "display-name"?: string;
  /** OB-2103: `project edit --stage alpha|beta|rc|stable|legacy|none`. */
  stage?: string;
  /** OB-2255: the `--team` filter on `list`, `spinoff list` and `spinoff gateable`. */
  team?: string;
  /** OB-2255: `t3 team add <name> --projects a,b`. */
  projects?: string;
  /** OB-2255: `t3 sentinel|muse <team> --remove` drops the role's row and unpins its thread. */
  remove?: boolean;
  /** OB-2257: `t3 team handoff <team> --role <r> --show` prints the role's latest handoff. */
  show?: boolean;
  points?: string;
  backfill?: boolean;
  digest?: boolean;
  /** ob 1655: `alerts --digest --notify` pushes the digest to Home Assistant (the 08:00 server job). */
  notify?: boolean;
  markdown?: boolean;
  sprint?: boolean;
  quarter?: boolean;
  standup?: boolean;
  ttl?: string;
  session?: string;
  thread?: string;
  timeout?: string;
  within?: string;
  wait?: boolean;
  /** OB-1809: `ob deploy run --ssh`, the named last resort when the API is down. */
  ssh?: boolean;
  source?: string;
  "target-date"?: string;
  "source-ref"?: string;
  context?: string;
  choice?: string;
  rationale?: string;
  alternatives?: string;
  "decided-at"?: string;
  "learn-kind"?: string;
  progress?: string;
  why?: string;
  role?: string;
  email?: string;
  workspace?: string;
  env?: string;
  "secret-ref"?: string;
  scope?: string;
  "scope-ref"?: string;
  channel?: string;
  handle?: string;
  class?: string;
  pr?: string;
  notes?: string;
  position?: string;
  "dry-run"?: boolean;
  queue?: boolean;
  once?: boolean;
  dep?: string;
  repo?: string;
  github?: string;
  linear?: string;
  "linear-name"?: string;
  slack?: string;
  "slack-handle"?: string;
  "whatsapp-jid"?: string;
  relationship?: string;
  "comms-style"?: string;
  "comms-notes"?: string;
  about?: string;
  item?: string;
  ticket?: string;
  /** OB-2007: `ob wiki log`; OB-2097: `ob overnight decide`. */
  what?: string;
  /** OB-2097: `ob overnight`. */
  doubt?: string;
  undo?: string;
  night?: string;
  add?: string;
  check?: boolean;
  cause?: string;
  fix?: string;
  "new-area"?: boolean;
  worktree?: string;
  branch?: string;
  id?: string;
  holder?: string;
  "no-lease"?: boolean;
  "spawn-failed"?: boolean;
  /** 1205: `ob spinoff handoff --no-note`, stamp only; the caller IS the architect the note would go to. */
  "no-note"?: boolean;
  /** OS-145: `ob models set <route> <models> --effort <lvl> --profile <p>` (spinoff reads --effort too). */
  effort?: string;
  profile?: string;
  /** OB-2107: `ob spinoff <ref> --opus-high '<his ask>'`, the owner's quoted ask to run Opus above its default effort. */
  "opus-high"?: string;
  /** OB-1991: the model trial's flags (`ob spinoff <ref> --no-trial`, `ob spinoff trial ...`). */
  "no-trial"?: boolean;
  /** OB-2075: `ob spinoff stamp --raised`, the launch ran an urgent item on complex, so the row records complex. */
  raised?: boolean;
  a?: string;
  b?: string;
  "a-price"?: string;
  "b-price"?: string;
  x?: string;
  y?: string;
  forfeit?: string;
  void?: boolean;
  diffs?: string;
  rating?: string;
  label?: string;
  /** OB-1825: `ob spinoff check` inputs, and the `--no-check '<why>'` override on a dispatch. */
  architect?: string;
  checker?: string;
  /** OB-2131: one entry per checker question; `--questions-resolved` is kept only to be refused by name. */
  resolutions?: string;
  "questions-resolved"?: boolean;
  "no-check"?: string;
  /** OB-2230: `ob spinoff <ref> --no-flake-slot '<why>'`, a flake row that launches without taking `flake:slot`. */
  "no-flake-slot"?: string;
  all?: boolean;
  "all-launchers"?: boolean;
  window?: string;
  refresh?: boolean;
  launcher?: string;
  "in-flight"?: boolean;
  agent?: boolean;
  interactive?: boolean;
  brief?: string;
  note?: string;
  force?: boolean;
  client?: string;
  "client-id"?: string;
  "client-secret"?: string;
  scopes?: string;
  to?: string;
  yes?: boolean;
  /** OB-1909: `whatsapp send --resend` sends despite an unknown-outcome identical send in the last 24 h. */
  resend?: boolean;
  /** ob 1757: `gmail draft --subject/--cc/--body-file/--reply-to`; `gmail send-draft --confirm`. */
  subject?: string;
  cc?: string;
  "body-file"?: string;
  /** OB-2187: `ob t3 broadcast … --message-file <path>`. */
  "message-file"?: string;
  /** OB-2004: `ob doc show <id> --version <n>`. */
  version?: string;
  "reply-to"?: string;
  confirm?: boolean;
  /** OB-1910: `gmail send-draft --confirm --hash <hex>`: the hash of the draft the human read. */
  hash?: string;
  /** ob 1680: `gmail draft --attach <file>` (repeatable); `gmail attachment --name <filename>`. */
  attach?: string[];
  /** OB-1750: `gmail draft-edit --no-attach` drops the draft's files. */
  "no-attach"?: boolean;
  name?: string;
  /** ob 1756: `cloudflare dns add --proxied`. */
  proxied?: boolean;
  /** ob 1643: `cloudflare tunnels --floor <version>` — an advisory's exact cutoff (e.g. 2026.10.2). */
  floor?: string;
  date?: string;
  tier?: string;
  /** OB-2173: `review readers set <leg> --model <id>`. */
  model?: string;
  answers?: string;
  shareable?: string;
  adguard?: boolean;
  router?: boolean;
  /** ob 209: assert there is no human here, so a source that needs one is skipped, not failed. */
  unattended?: boolean;
  issue?: boolean;
  map?: string;
  exec?: string;
  when?: string;
  overdue?: boolean;
  from?: string;
  triage?: boolean;
  /** ob 1683: `whatsapp send --file <path>` (repeatable). */
  file?: string[];
  "no-github"?: boolean;
  /** OS-56: `ob send` stores the message and delivers nothing. */
  "no-deliver"?: boolean;
  book?: string;
  "external-id"?: string;
  // ob 165 — person identity number + attached documents. `reveal` is the explicit opt-in that prints
  // an identity number in full; without it every output path masks it.
  "id-number"?: string;
  reveal?: boolean;
  /** OB-2249: `ob profile set|list`. */
  category?: string;
  alias?: string[];
  secret?: string;
  confirmed?: string;
  path?: string;
  "issued-on"?: string;
  bind?: string;
  // ob 220: TLS for `ob web` (both listeners) and the certificate `ob cert` maintains.
  "tls-cert"?: string;
  "tls-key"?: string;
  // OB-2160: `ob web --prebuilt`, serve without building.
  prebuilt?: boolean;
  // OB-2199 step 1: `ob web --app <name>` serves apps/<name>; `--port` sets its port; `--no-sidecar-port` opens no :5051 listener.
  app?: string;
  port?: string;
  "no-sidecar-port"?: boolean;
  staging?: boolean;
  // ob 323: `ob pg-export`, the SQLite -> Postgres data move.
  "to-file"?: string;
  truncate?: boolean;
  "verify-only"?: boolean;
  "allow-missing-target-tables"?: boolean;
  "allow-missing-target-columns"?: boolean;
  out?: string;
  // ob 200: `ob db snapshot`'s rotated local history.
  dir?: string;
  list?: boolean;
  "keep-hourly"?: string;
  "keep-daily"?: string;
  "max-bytes"?: string;
  // ob 468: `ob vision compare`.
  as?: string;
  design?: string;
  "no-enforce"?: boolean;
  on?: string[];
  off?: string[];
  // ob 582: `ob deploy record` fields.
  target?: string;
  host?: string;
  unit?: string;
  sha?: string;
  result?: string;
  at?: string;
  /** 1102: `ob t3` — T3 base URL and MCP access level. */
  "base-url"?: string;
  access?: string;
  /** 1124: `ob t3 tree --subagents` — include T3's delegated child threads. */
  subagents?: boolean;
}

export interface Ctx {
  db: Database;
  /**
   * The store a PORTED handler reads and writes through (337), and the thing that decides which engine
   * this invocation actually talks to.
   *
   * Optional, because apps/cli is ported a piece at a time: a handler that has not been ported still uses
   * `db` and is unaffected. In sqlite mode this wraps that same `db` handle, so a ported handler and an
   * unported one see one connection and identical behaviour. In postgres mode `db` never gets opened at
   * all -- openDb refuses (see unportedCommandMessage) -- so a handler reaching this far under postgres
   * is by definition one of the ported ones, and this is its only route to the data.
   *
   * Prefer `ctx.store ?? ctx.db` when calling into a ported module, so the same call site works in both
   * states while the port is in progress.
   */
  store: Store;
  dbPath: string;
  mode: Mode;
  flags: Flags;
  args: string[];
  /**
   * A non-zero exit code a handler wants WITHOUT the error path's stderr shape: a normal, expected
   * outcome that is still a failure for the caller (`ob lease acquire` denied, #97). `run` returns it.
   * Per-invocation, so it can never leak between calls the way `process.exitCode` does.
   */
  exit?: number;
  /**
   * ob 189, the split class: the server this handler's DB half runs on. Set ONLY in `split` mode, so an
   * ABSENT `remote` means "there is no server" and the handler writes to `db` exactly as it always has.
   * That is what keeps inert mode byte-for-byte identical and what makes the handler correct when it is
   * the server running it.
   */
  remote?: RemoteWriter;
  /** ob 636: ssh seam for `ob deploy run`. Tests inject; production omits. */
  deploySsh?: (argv: readonly string[]) => { code: number };
  /** ob 1756: the fetch `ob cloudflare` uses. Tests inject; production omits (global fetch). */
  cloudflareFetch?: typeof fetch;
  /** ob 1655: the fetch `ob creds check` makes its provider call with. Tests inject; production omits (global fetch). */
  credsFetch?: typeof fetch;
  /** ob 1655: the fetch the `alerts --notify` Home Assistant push uses. Tests inject; production omits (global fetch). */
  notifyFetch?: typeof fetch;
}

/**
 * The item id an argument names (1949): a ref (`PS-12`, any case) or an alias resolves to its id; a bare
 * number, or anything unknown, passes through unchanged so the caller's own not-found message still fires.
 */
export async function itemArg<T extends string | undefined>(ctx: Ctx, raw: T): Promise<T> {
  if (raw === undefined) return raw;
  await refuseAmbiguousBareNumber(ctx, raw);
  return ((await resolveItemId(ctx.store ?? ctx.db, raw)) ?? raw) as T;
}

/** emitId for an item: looks its ref up so the echo reads `PS-12`, not the legacy number. */
export async function emitItem(ctx: Ctx, id: string): Promise<void> {
  emitId(ctx, id, (await refsFor(ctx.store ?? ctx.db, [id])).get(id));
}

/**
 * OB-1751: refuse a bare number that is the internal id of one item AND the `OB-<n>` key of another, naming
 * both, instead of silently taking the internal id. Only for what a human TYPED: an id the CLI already
 * resolved is passed with `trusted` (see `requireItem`).
 */
async function refuseAmbiguousBareNumber(ctx: Ctx, raw: string): Promise<void> {
  const collision = await bareNumberCollision(ctx.store ?? ctx.db, raw);
  if (collision) throw new AppError(bareNumberCollisionMessage(collision));
}

/** `trusted`: `id` is an internal id this command already resolved (via `itemArg` or a prior `requireItem`), not typed input. */
export async function requireItem(ctx: Ctx, id: string, opts: { trusted?: boolean } = {}): Promise<ItemRow> {
  if (!opts.trusted) await refuseAmbiguousBareNumber(ctx, id);
  const item = await getItem(ctx.store ?? ctx.db, id);
  if (!item) throw new AppError(`no item with id '${id}'`);
  return item;
}
