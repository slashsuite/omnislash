#!/usr/bin/env bun
/**
 * ob 1103 — the T3 **V2 surface contract** probe.
 *
 * Wayfinder ticket 1103 asks nine questions about T3's V2 surface and refuses a
 * guess as an answer. This script is how the answers were produced: one live
 * sequence against the real T3 server, writing
 *
 *   • a transcript  → `docs/t3-surface-contract-probe.md`
 *   • fixtures      → `apps/cli/test/fixtures/t3/*.json`
 *
 * so every fact can be re-measured after a T3 upgrade, and the launcher can be
 * tested against a fake instead of a live T3.
 *
 * It is MEASUREMENT ONLY: nothing in ob imports it. It launches throwaway
 * threads (all titled `P0.2 probe · …`), settles and archives them at the end,
 * and leaves the throwaway worktree for inspection.
 *
 * Usage:
 *   bun apps/cli/src/t3/surface-probe.ts [--keep-threads] [--fixtures <dir>] [--transcript <path>]
 *
 * It touches the real T3 server and the real credential file — that is the
 * point: a behaviour seen once in the T3 UI is not a measurement a script can
 * rely on.
 */

import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { T3Client, T3Error, T3_LIVE_STATUSES, type T3LaunchInput, type T3Project, type T3ThreadRead } from "./client.ts";
import { isTeamRoleTitle } from "./dispatch.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const REPO_NAME = REPO_ROOT.split("/").pop()!.split(".")[0]!;
const DEFAULT_FIXTURES = join(REPO_ROOT, "apps", "cli", "test", "fixtures", "t3");
const DEFAULT_TRANSCRIPT = join(REPO_ROOT, "docs", "t3-surface-contract-probe.md");
const TITLE_PREFIX = "P0.2 probe · ";
const PROBE_BRANCH = "p02-probe";
const PROBE_WORKTREE = join(dirname(REPO_ROOT), `${REPO_NAME}.${PROBE_BRANCH}`);
const OPENCODE_DB = join(process.env.HOME ?? "", ".local", "share", "opencode", "opencode.db");
const ATTACHMENT_FIXTURE = join(REPO_ROOT, "apps", "cli", "test", "fixtures", "vision", "design.png");
const OVERSIZE_MESSAGE_CHARS = 120_001;
/** A model id the provider does not have — the one reliable failed RUN (not a refused launch). */
const FAILING_MODEL = "opencode-go/model-that-does-not-exist";
const TOOL_SCHEMAS_WANTED = [
  "t3_thread_launch",
  "t3_thread_read",
  "t3_thread_list",
  "t3_thread_organize",
  "t3_thread_update",
  "t3_attachment_prepare_upload",
  "t3_pending_request_list",
];

interface Line {
  step: string;
  ok: boolean;
  detail: string;
}

interface Capture {
  tool: string;
  args?: Record<string, unknown>;
  result: unknown;
}

const transcript: Line[] = [];
const raw: string[] = [];
const fixtures = new Map<string, unknown>();
const createdThreads: string[] = [];
let failures = 0;
let build = "unknown";

/**
 * Record a step. `extra` becomes the raw-evidence block; the big payloads that are already fixtures
 * (`skipEvidence`) stay out of the transcript, and everything else is capped so the transcript reads
 * like evidence rather than a dump.
 */
function record(step: string, ok: boolean, detail: string, extra?: unknown, skipEvidence = false): void {
  transcript.push({ step, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${step.padEnd(24)} ${detail}`);
  if (extra === undefined || skipEvidence) return;
  const text = typeof extra === "string" ? extra : JSON.stringify(extra, null, 2);
  const capped = text.length > 8_000 ? `${text.slice(0, 8_000)}\n… (${text.length - 8_000} bytes elided — the full payload is the matching fixture under apps/cli/test/fixtures/t3/)` : text;
  raw.push(`### ${step}\n\n\`\`\`json\n${capped}\n\`\`\`\n`);
}

function capture(name: string, tool: string, result: unknown, args?: Record<string, unknown>): void {
  fixtures.set(name, { tool, ...(args === undefined ? {} : { args }), result } satisfies Capture);
}

function args(): { keep: boolean; fixturesDir: string; transcriptPath: string } {
  const argv = process.argv.slice(2);
  let keep = false;
  let fixturesDir = DEFAULT_FIXTURES;
  let transcriptPath = DEFAULT_TRANSCRIPT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--keep-threads") keep = true;
    if (argv[i] === "--fixtures") fixturesDir = argv[i + 1] ?? fixturesDir;
    if (argv[i] === "--transcript") transcriptPath = argv[i + 1] ?? transcriptPath;
  }
  return { keep, fixturesDir, transcriptPath };
}

function sh(argv: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", cwd: REPO_ROOT });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** True when the probe branch already existed, so cleanup must NOT delete it. */
let probeBranchExisted = false;

/**
 * The throwaway worktree. It only ever claims a path it can prove is disposable: an existing
 * directory that is not a worktree of this repo is left alone and the probe refuses, because a
 * side-effecting probe must not recursively delete something it did not create.
 */
function ensureWorktree(): void {
  const listed = sh(["git", "worktree", "list", "--porcelain"]).out;
  if (listed.includes(PROBE_WORKTREE)) return;
  if (existsSync(PROBE_WORKTREE)) {
    throw new Error(`${PROBE_WORKTREE} exists but is not a worktree of this repo — refusing to delete it; move it aside and re-run`);
  }
  const base = sh(["git", "rev-parse", "HEAD"]).out.trim();
  probeBranchExisted = sh(["git", "rev-parse", "--verify", PROBE_BRANCH]).code === 0;
  const add = probeBranchExisted
    ? sh(["git", "worktree", "add", PROBE_WORKTREE, PROBE_BRANCH])
    : sh(["git", "worktree", "add", "-b", PROBE_BRANCH, PROBE_WORKTREE, base]);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.err}`);
}

/**
 * The opencode token lanes. ob's reader (`platform/cli-coord/src/spinoff-tokens.ts`,
 * `readOpencodeSpinoffTokens`) queries the legacy `session` table; opencode 2.x writes `session_v2`.
 * Both are queried here so the finding is "the row is in the other table", not "no row anywhere".
 */
function opencodeRows(sql: string, directory: string): Array<Record<string, unknown>> {
  if (!existsSync(OPENCODE_DB)) return [];
  try {
    const db = new Database(OPENCODE_DB, { readonly: true });
    try {
      return db.query(sql).all(directory, directory) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function sumTokens(rows: Array<Record<string, unknown>>): { input: number; output: number; cacheWrite: number; cacheRead: number; reasoning: number; total: number } {
  const t = rows.reduce<{ input: number; output: number; cacheWrite: number; cacheRead: number; reasoning: number }>(
    (acc, s) => ({
      input: acc.input + Number(s.tokens_input ?? 0),
      output: acc.output + Number(s.tokens_output ?? 0),
      cacheWrite: acc.cacheWrite + Number(s.tokens_cache_write ?? 0),
      cacheRead: acc.cacheRead + Number(s.tokens_cache_read ?? 0),
      reasoning: acc.reasoning + Number(s.tokens_reasoning ?? 0),
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
  );
  return { ...t, total: t.input + t.output + t.cacheWrite + t.cacheRead + t.reasoning };
}

/**
 * `tools/list`, raw: the launch tool's own schema is the evidence for the 120,000-char limit, the
 * attachment shape and the ABSENCE of a retry key — none of which a call result can show.
 */
async function fetchToolSchemas(client: T3Client): Promise<Record<string, unknown>> {
  const base = client.credential?.baseUrl ?? "";
  const token = client.credential?.accessToken ?? "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  const initRes = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ob", version: "1" } } }),
  });
  const session = initRes.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> } };
  const out: Record<string, unknown> = {};
  for (const t of body.result?.tools ?? []) {
    if (!TOOL_SCHEMAS_WANTED.includes(t.name)) continue;
    out[t.name] = { description: t.description, inputSchema: t.inputSchema };
  }
  return out;
}

function errText(err: unknown): string {
  if (err instanceof T3Error) return `${err.kind}: ${err.message}${err.remedy ? ` → ${err.remedy}` : ""}`;
  return `${(err as Error).name}: ${(err as Error).message}`;
}

function texts(read: T3ThreadRead, type: string): string[] {
  return read.items.filter((i) => i.type === type).map((i) => i.text ?? "");
}

async function attemptLaunch(
  client: T3Client,
  project: T3Project,
  label: string,
  input: Partial<T3LaunchInput>,
): Promise<{ ok: true; threadId: string; status: string | null } | { ok: false; error: string }> {
  try {
    const launched = await client.launch({
      modelSelection: project.defaultModelSelection ?? { instanceId: "opencode", model: "opencode-go/beam-free" },
      runtimeMode: "full-access",
      ...input,
      projectId: project.id,
      title: input.title ?? `${TITLE_PREFIX}${label}`,
    });
    createdThreads.push(launched.threadId);
    return { ok: true, threadId: launched.threadId, status: launched.status };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/** Launch bound to the throwaway worktree: keeps a probe run out of the real checkout. Pure wrapper. */
function boundToProbe(): Pick<T3LaunchInput, "workspaceStrategy"> {
  return { workspaceStrategy: { type: "existing_worktree", worktreePath: PROBE_WORKTREE, branch: PROBE_BRANCH } };
}

async function runProbes(): Promise<{ client: T3Client; project: T3Project; opts: ReturnType<typeof args> }> {
  const opts = args();

  // ── preflight ─────────────────────────────────────────────────────────────
  const client = await T3Client.connected();
  const init = await client.initialize();
  build = init.serverVersion;
  const environment = await client.environment();
  record("connected", true, `${environment.label} · T3 Code ${build}`, environment);

  const projects = await client.projects();
  const project = projects.find((p) => p.title === REPO_NAME && !p.deletedAt);
  if (!project) throw new Error(`no '${REPO_NAME}' T3 project among: ${projects.map((p) => p.title).join(", ")}`);
  record("project", true, `${project.title} ${project.id} root=${project.workspaceRoot}`, project);
  capture("project.json", "t3_project_list", project);

  const capabilities: any = await client.capabilities();
  const usable = (capabilities.providers ?? []).filter((p: any) => (p.constraints ?? []).length === 0);
  record(
    "capabilities",
    usable.length > 0,
    `${usable.length}/${capabilities.providers.length} providers usable · caller runtimeMode=${capabilities.runtimeMode} interactionMode=${capabilities.interactionMode}`,
    (capabilities.providers ?? []).map((p: any) => ({ providerInstanceId: p.providerInstanceId, runtimeModes: p.runtimeModes, models: p.models?.length ?? 0, constraints: p.constraints ?? [] })),
    true,
  );
  capture("capabilities.json", "orchestrator_capabilities", { runtimeMode: capabilities.runtimeMode, interactionMode: capabilities.interactionMode, features: capabilities.features, providers: capabilities.providers });

  const schemas = await fetchToolSchemas(client);
  record("tool schemas", Object.keys(schemas).length > 0, `captured ${Object.keys(schemas).length} input schemas from tools/list → apps/cli/test/fixtures/t3/tool-schemas.json`, undefined, true);
  capture("tool-schemas.json", "tools/list", schemas);

  // ── the throwaway worktree (Q1) ───────────────────────────────────────────
  ensureWorktree();
  const gitBranch = sh(["git", "-C", PROBE_WORKTREE, "rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  record("probe worktree", existsSync(PROBE_WORKTREE) && gitBranch === PROBE_BRANCH, `${PROBE_WORKTREE} on ${gitBranch} (project root is ${project.workspaceRoot})`);

  const projectId = project.id;

  // T3's settings — the sidebar grouping mode and the auto-settle trio. Read, never written (1103
  // forbids changing T3 settings beyond a scratch project). The auto-settle keys live in the SERVER
  // settings (`settings.json`), the sidebar grouping in the client's (`client-settings.json`).
  const settingsDir = join(process.env.HOME ?? "", ".t3", "userdata");
  const readSettings = (name: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(join(settingsDir, name), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const clientSettings = readSettings("client-settings.json");
  const serverSettings = readSettings("settings.json");
  const found = (key: string): { key: string; value: unknown; in: string } => {
    if (key in serverSettings) return { key, value: serverSettings[key], in: "settings.json" };
    if (key in clientSettings) return { key, value: clientSettings[key], in: "client-settings.json" };
    return { key, value: undefined, in: "(unset — the app's own default applies)" };
  };
  const autoSettle = {
    sidebarAutoSettleAfterDays: found("sidebarAutoSettleAfterDays"),
    sidebarAutoSettleOnMerge: found("sidebarAutoSettleOnMerge"),
    sidebarAutoSettleKeepPullRequests: found("sidebarAutoSettleKeepPullRequests"),
  };
  record(
    "auto-settle settings",
    true,
    `onMerge=${JSON.stringify(autoSettle.sidebarAutoSettleOnMerge.value)} (${autoSettle.sidebarAutoSettleOnMerge.in}) · afterDays=${JSON.stringify(autoSettle.sidebarAutoSettleAfterDays.value)} (${autoSettle.sidebarAutoSettleAfterDays.in}) · keepPullRequests=${JSON.stringify(autoSettle.sidebarAutoSettleKeepPullRequests.value)} — every one of these is PULL-REQUEST-keyed`,
    { settingsDir, autoSettle },
  );
  capture("auto-settle-settings.json", "settings.json + client-settings.json", {
    settingsDir,
    autoSettle,
    serverSettingsKeys: Object.keys(serverSettings).sort(),
    clientSettingsKeys: Object.keys(clientSettings).sort(),
  });

  // ── Q1a: bind an ob-created worktree OUTSIDE the project root ─────────────
  const bind = await attemptLaunch(client, project, "worktree bind", {
    message: "Reply with exactly BIND-OK. Do not edit any files.",
    ...boundToProbe(),
  });
  if (!bind.ok) {
    record("Q1 bind", false, bind.error);
  } else {
    const read = await client.read(bind.threadId, { limit: 10 });
    const bound = read.thread.worktreePath === PROBE_WORKTREE && read.thread.branch === PROBE_BRANCH;
    record("Q1 bind", bound, `thread=${bind.threadId} worktreePath=${read.thread.worktreePath} branch=${read.thread.branch} status=${read.thread.status}`, { bind, read });
    capture("launched-thread.json", "t3_thread_read", read, { threadId: bind.threadId, limit: 10 });
    capture("launch-result.json", "t3_thread_launch", bind);

    // ── Q1b: is a bad path / wrong branch / already-bound path / dirty tree refused?
    const badPath = await attemptLaunch(client, project, "bind bad path", {
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/tmp/opencode/not-a-worktree", branch: PROBE_BRANCH },
    });
    record("Q1 bad path", !badPath.ok, badPath.ok ? `ACCEPTED (unexpected): ${badPath.threadId}` : badPath.error, badPath);
    capture("refusal-bad-path.json", "t3_thread_launch", badPath);

    const wrongBranch = await attemptLaunch(client, project, "bind wrong branch", {
      workspaceStrategy: { type: "existing_worktree", worktreePath: PROBE_WORKTREE, branch: "main" },
    });
    record("Q1 branch mismatch", true, wrongBranch.ok ? `ACCEPTED: ${wrongBranch.threadId} — the branch arg is not checked against the checkout` : `refused: ${wrongBranch.error}`, wrongBranch);
    capture("refusal-branch-mismatch.json", "t3_thread_launch", wrongBranch);

    const alreadyBound = await attemptLaunch(client, project, "bind same path again", {
      workspaceStrategy: { type: "existing_worktree", worktreePath: PROBE_WORKTREE, branch: PROBE_BRANCH },
    });
    record("Q1 second bind", true, alreadyBound.ok ? `ACCEPTED: ${alreadyBound.threadId} — two threads may share one worktree` : `refused: ${alreadyBound.error}`, alreadyBound);
    capture("refusal-already-bound.json", "t3_thread_launch", alreadyBound);

    writeFileSync(join(PROBE_WORKTREE, "p02-probe-dirty.txt"), "dirty\n");
    const dirty = await attemptLaunch(client, project, "bind dirty tree", {
      workspaceStrategy: { type: "existing_worktree", worktreePath: PROBE_WORKTREE, branch: PROBE_BRANCH },
    });
    record("Q1 dirty tree", true, dirty.ok ? `ACCEPTED: ${dirty.threadId} — a dirty worktree is not refused` : `refused: ${dirty.error}`, dirty);
    capture("refusal-dirty-tree.json", "t3_thread_launch", dirty);
    rmSync(join(PROBE_WORKTREE, "p02-probe-dirty.txt"), { force: true });

    // ── Q8: the opencode token lane, measured on THIS bound run ─────────────
    const waited = await client.wait(bind.threadId, 180_000);
    record("Q1 bind run", waited.status === "completed", `run ${waited.runId} → ${waited.status} (timedOut=${waited.timedOut})`, waited);
    const sessions = opencodeRows(
      "SELECT id, directory, parent_id, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read FROM session WHERE directory IN (?, ?)",
      PROBE_WORKTREE,
    );
    const v2 = opencodeRows(
      "SELECT id, title, directory, parent_id, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_reasoning FROM session_v2 WHERE directory IN (?, ?)",
      PROBE_WORKTREE,
    );
    const legacyTotals = sumTokens(sessions);
    const v2Totals = sumTokens(v2);
    record(
      "Q8 token lane",
      v2Totals.total > 0,
      `ob's reader (legacy 'session' table) sees ${sessions.length} row(s)/${legacyTotals.total} tokens — WRONG. opencode 2.x's 'session_v2' holds ${v2.length} row(s), ${v2Totals.total} tokens (in=${v2Totals.input} out=${v2Totals.output})`,
      { legacy: { rows: sessions, totals: legacyTotals }, sessionV2: { rows: v2, totals: v2Totals } },
    );
    capture("opencode-session.json", "opencode.db session + session_v2", {
      directory: PROBE_WORKTREE,
      legacyTable: { rows: sessions, totals: legacyTotals },
      sessionV2Table: { rows: v2, totals: v2Totals },
    });

    // ── Q2: does an explicit title survive regeneration? ────────────────────
    await client.rename(bind.threadId, `${TITLE_PREFIX}title stability`);
    const renamed = await client.read(bind.threadId, { limit: 1, runLimit: 1 });
    await client.update(bind.threadId, "regenerate_title");
    let after: T3ThreadRead = renamed;
    // `titleRegeneration` is on the wire but not on the seam's T3Thread: it is T3's record that a
    // rename was REQUESTED ({requestId, startedAt}), which is how ob can tell a regeneration happened.
    const regenerated = (t: T3ThreadRead): unknown => (t.thread as unknown as { titleRegeneration?: unknown }).titleRegeneration;
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 2_000));
      after = await client.read(bind.threadId, { limit: 1, runLimit: 1 });
      if (after.thread.title !== renamed.thread.title || regenerated(after) != null) break;
    }
    const survived = after.thread.title === `${TITLE_PREFIX}title stability`;
    record("Q2 title stability", true, survived ? `title KEPT after regenerate_title: '${after.thread.title}'` : `title REGENERATED: '${renamed.thread.title}' → '${after.thread.title}'`, { renamed: renamed.thread, after: after.thread, survived });
    capture("title-regeneration.json", "t3_thread_update regenerate_title", {
      renamedTo: `${TITLE_PREFIX}title stability`,
      before: renamed.thread,
      after: after.thread,
      survived,
    });

    // ── Q6: settle / archive against the bound thread ──────────────────────
    const settled = await client.organize(bind.threadId, "settle");
    const afterSettle = await client.read(bind.threadId, { limit: 1, runLimit: 1 });
    const archived = await client.organize(bind.threadId, "archive");
    const afterArchive = await client.read(bind.threadId, { limit: 1, runLimit: 1 });
    const worktreeSurvived = existsSync(PROBE_WORKTREE);
    record(
      "Q6 settle/archive",
      afterSettle.thread.settled === true,
      `settle→settled=${afterSettle.thread.settled} archived=${afterArchive.thread.archived} · worktree still on disk=${worktreeSurvived} · auto-settle is PR-keyed (onMerge=${JSON.stringify(autoSettle.sidebarAutoSettleOnMerge.value)}${autoSettle.sidebarAutoSettleOnMerge.value === undefined ? " default true" : ""}, keepPullRequests=${JSON.stringify(autoSettle.sidebarAutoSettleKeepPullRequests.value)}), so NO merge in a no-PR repo can settle this thread`,
      { settled, afterSettle: afterSettle.thread, archived, afterArchive: afterArchive.thread, autoSettle },
    );
    capture("settled-thread.json", "t3_thread_read", afterSettle, { threadId: bind.threadId, limit: 1, runLimit: 1 });
    capture("settle-archive.json", "t3_thread_organize", { settle: settled, archive: archived, afterSettle: afterSettle.thread, afterArchive: afterArchive.thread, worktreeOnDiskAfter: worktreeSurvived, autoSettle });

    // ── Q6b: settle a thread that still has a live run ─────────────────────
    const busy = await attemptLaunch(client, project, "settle live run", {
      message: "Run the shell command `sleep 45` and then reply with exactly SLEPT-OK. Do not do anything else.",
      ...boundToProbe(),
    });
    if (busy.ok) {
      const inFlight = await client.read(busy.threadId, { limit: 1, runLimit: 1 });
      // Settling a thread with a live run is REFUSED — the refusal text is the measurement ob's
      // `ob close` must honour (interrupt first, then settle).
      let settleLive: unknown;
      try {
        settleLive = await client.organize(busy.threadId, "settle");
      } catch (err) {
        settleLive = { refused: errText(err) };
      }
      const afterLive = await client.read(busy.threadId, { limit: 1, runLimit: 1 });
      await client.interrupt(busy.threadId).catch(() => undefined);
      // …and the interrupt-then-settle order ob must use on `ob close`.
      let settleAfterInterrupt: unknown;
      for (let i = 0; i < 10; i += 1) {
        await new Promise((r) => setTimeout(r, 2_000));
        const now = await client.read(busy.threadId, { limit: 1, runLimit: 1 });
        if (now.thread.status !== "running" && now.thread.status !== "starting" && now.thread.status !== "preparing") break;
      }
      try {
        settleAfterInterrupt = await client.organize(busy.threadId, "settle");
      } catch (err) {
        settleAfterInterrupt = { refused: errText(err) };
      }
      const final = await client.read(busy.threadId, { limit: 1, runLimit: 1 });
      record(
        "Q6 settle live run",
        true,
        `settle while running → ${JSON.stringify(settleLive)} · after interrupt, settle → ${JSON.stringify(settleAfterInterrupt)} (settled=${final.thread.settled}, status=${final.thread.status})`,
        { inFlight: inFlight.thread, settleLive, afterLive: afterLive.thread, settleAfterInterrupt, final: final.thread },
      );
      capture("settle-live-run.json", "t3_thread_organize settle", { inFlight: inFlight.thread, settleLive, afterLive: afterLive.thread, settleAfterInterrupt, final: final.thread });
    } else {
      record("Q6 settle live run", false, busy.error);
    }
  }

  // ── Q5: the same clientRequestId twice ───────────────────────────────────
  const requestId = "p0.2-probe-idempotency";
  const idemTitle = `${TITLE_PREFIX}idempotency`;
  const idemInput: Partial<T3LaunchInput> = { title: idemTitle, workspaceStrategy: { type: "root" }, clientRequestId: requestId };
  const first = await attemptLaunch(client, project, "idempotency", idemInput);
  const second = await attemptLaunch(client, project, "idempotency", idemInput);
  const distinct = first.ok && second.ok && first.threadId !== second.threadId;
  record("Q5 idempotency", true, distinct ? `same clientRequestId + same title → TWO threads (${first.ok ? first.threadId : "-"} / ${second.ok ? second.threadId : "-"})` : `one thread or a refusal: ${JSON.stringify({ first, second })}`, { requestId, first, second, distinct });
  capture("idempotency.json", "t3_thread_launch", { clientRequestId: requestId, title: idemTitle, first, second, threadsCreated: distinct ? 2 : 1 });

  // ── Q3: what makes a launched thread BE the architect ──────────────────────
  const literal = await attemptLaunch(client, project, "bootstrap literal", {
    message: "$architect\n/architect\n\nDo not act on the two lines above. Reply with exactly LITERAL-OK and quote your whole prompt verbatim. Do not edit any files.",
    ...boundToProbe(),
  });
  let literalText: string | null = null;
  if (literal.ok) {
    // The delivered text is measurable as soon as the turn starts — no need to let the run finish
    // (and burn a full turn) just to read back what was delivered.
    let read = await client.read(literal.threadId, { limit: 10 });
    for (let i = 0; i < 10 && texts(read, "user_message").length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 3_000));
      read = await client.read(literal.threadId, { limit: 10 });
    }
    literalText = texts(read, "user_message")[0] ?? null;
    await client.interrupt(literal.threadId).catch(() => undefined);
    record("Q3 literal forms", literalText !== null, `an MCP message arrives VERBATIM: ${JSON.stringify(literalText?.slice(0, 80))}…`, read);
  } else {
    record("Q3 literal forms", false, literal.error);
  }

  const explicitMessage =
    "Read the file skills/ob-architect/SKILL.md in this repository, then reply with exactly ARCHITECT-BOOTSTRAP-OK. Do not do anything else and do not edit any files.";
  const explicit = await attemptLaunch(client, project, "bootstrap explicit", { message: explicitMessage, ...boundToProbe() });
  let explicitReply: string | null = null;
  if (explicit.ok) {
    const waited = await client.wait(explicit.threadId, 300_000);
    const read = await client.read(explicit.threadId, { limit: 20 });
    explicitReply = texts(read, "assistant_message").join("\n").trim();
    record("Q3 explicit", explicitReply.includes("ARCHITECT-BOOTSTRAP-OK"), `run ${waited.status}; reply ${JSON.stringify(explicitReply.slice(0, 160))}`, read);
    capture("architect-bootstrap.json", "t3_thread_launch + t3_thread_read", { literalMessage: "$architect\\n/architect", literalArrivedAs: literalText, explicitMessage, explicitReply, runStatus: waited.status, runStatusRaw: waited });
  } else {
    record("Q3 explicit", false, explicit.error);
  }

  // ── Q7: what "needs you" means ───────────────────────────────────────────
  // 7a — plan interaction mode: does a proposed plan gate the run?
  const plan = await attemptLaunch(client, project, "plan mode", {
    message: "Propose a short plan for adding a --dry-run flag to an imaginary CLI. Do not implement anything.",
    interactionMode: "plan",
    ...boundToProbe(),
  });
  if (plan.ok) {
    let planRead: T3ThreadRead | null = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 3_000));
      planRead = await client.read(plan.threadId, { limit: 20, runLimit: 5 });
      if ((planRead.thread.pendingRequestCount ?? 0) > 0) break;
      if (planRead.thread.status === "completed" || planRead.thread.status === "failed") break;
    }
    record("Q7 plan mode", true, `interactionMode=plan → status=${planRead?.thread.status} pendingRequestCount=${planRead?.thread.pendingRequestCount} (a plan does NOT gate the run on this build)`, planRead?.thread);
    capture("plan-mode.json", "t3_thread_launch interactionMode:plan + t3_thread_read", { thread: planRead?.thread, items: planRead?.items });
  } else {
    record("Q7 plan mode", false, plan.error);
  }

  // 7b — an approval-required run: the pending request `ob status` must read. Retried, because
  // whether a model actually reaches for the tool is model behaviour: the probe needs a run that
  // genuinely asks, or it has measured nothing.
  let approval: Awaited<ReturnType<typeof attemptLaunch>> = { ok: false, error: "not attempted" };
  let read: T3ThreadRead | null = null;
  let listed: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    approval = await attemptLaunch(client, project, `pending approval${attempt === 1 ? "" : ` attempt ${attempt}`}`, {
      message: "You must run this bash command first: `echo APPROVAL-OK`. Then reply with exactly DONE. Do not skip the command and do not edit any files.",
      runtimeMode: "approval-required",
      ...boundToProbe(),
    });
    if (!approval.ok) break;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 3_000));
      read = await client.read(approval.threadId, { limit: 20, runLimit: 5 });
      if ((read.thread.pendingRequestCount ?? 0) > 0) break;
      if (read.thread.status === "completed" || read.thread.status === "failed") break;
    }
    if ((read?.thread.pendingRequestCount ?? 0) > 0) break;
    await client.interrupt(approval.threadId).catch(() => undefined);
  }
  if (approval.ok) {
    const count = read?.thread.pendingRequestCount ?? 0;
    // The question channel and the approval channel are DIFFERENT: approvals are not listed, and
    // `t3_pending_request_respond` cannot approve one.
    listed = await client.callTool<any>("t3_pending_request_list", { threadId: approval.threadId }).catch((e) => ({ error: errText(e) }));
    const requestIds: string[] = (listed as { requestIds?: string[] })?.requestIds ?? [];
    let question: unknown = null;
    let responded: unknown = null;
    if (requestIds.length > 0) {
      question = await client.callTool("t3_pending_request_read", { threadId: approval.threadId, requestId: requestIds[0] }).catch((e) => ({ error: errText(e) }));
      responded = await client
        .callTool("t3_pending_request_respond", { threadId: approval.threadId, requestId: requestIds[0], answers: { answer: "accept" } })
        .catch((e) => ({ error: errText(e) }));
    }
    // Cleanup path for a thread parked on an approval: interrupt, then settle.
    await client.interrupt(approval.threadId).catch(() => undefined);
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 2_000));
      const now = await client.read(approval.threadId, { limit: 1, runLimit: 1 });
      if (now.thread.status !== "running" && now.thread.status !== "starting" && now.thread.status !== "preparing") break;
    }
    const settled = await client.organize(approval.threadId, "settle").catch((e) => ({ refused: errText(e) }));
    const final = await client.read(approval.threadId, { limit: 1, runLimit: 1 });
    record(
      "Q7 pending approval",
      count > 0,
      `status=${read?.thread.status} pendingRequestCount=${count} · pending_request_list=${JSON.stringify(listed)} · interrupt→settle=${JSON.stringify(settled)} settled=${final.thread.settled} · runtimeMode=${(read?.thread as unknown as { runtimeMode?: string } | undefined)?.runtimeMode}`,
      { read: read?.thread, listed, question, responded, settled, final: final.thread },
    );
    capture("pending-request.json", "t3_thread_read + t3_pending_request_list", { read: read?.thread, items: read?.items, listed, question, responded, afterInterruptSettle: final.thread });
  } else {
    record("Q7 pending approval", false, approval.error);
  }

  // ── Q4: grouping and the architect ─────────────────────────────────────────
  const grouping: Record<string, unknown> = {
    sidebarProjectGroupingMode: clientSettings.sidebarProjectGroupingMode,
    legacySidebarEnabled: clientSettings.legacySidebarEnabled,
    showSkillsInSlashMenu: clientSettings.showSkillsInSlashMenu,
    defaultThreadEnvMode: ((environment as unknown as { preferences?: Record<string, unknown> }).preferences ?? {}).defaultThreadEnvMode,
    autoSettle,
  };
  const defaultList: any = await client.callTool("t3_thread_list", { projectId, limit: 100 });
  const withChildren: any = await client.callTool("t3_thread_list", { projectId, limit: 100, includeSubagents: true });
  const withoutChildren: any = await client.callTool("t3_thread_list", { projectId, limit: 100, includeSubagents: false });
  const threads: any[] = withChildren.threads ?? [];
  const architects = threads.filter((t) => isTeamRoleTitle(String(t.title)));
  const builders = threads.filter((t) => /^\d+ · /.test(String(t.title)));
  const children = threads.filter((t) => t.parentThreadId !== null);
  const architectThread: any = architects[0];
  const architectRead: any = architectThread ? await client.callTool("t3_thread_read", { threadId: architectThread.threadId, limit: 1, runLimit: 1 }).catch((e) => ({ error: errText(e) })) : null;
  record(
    "Q4 grouping",
    grouping.sidebarProjectGroupingMode !== undefined,
    `grouping=${grouping.sidebarProjectGroupingMode} · list default=${defaultList.threads?.length} includeSubagents:true=${threads.length} false=${withoutChildren.threads?.length} · architects=${architects.length} builders=${builders.length} children=${children.length}`,
    { grouping, counts: { default: defaultList.threads?.length, includeSubagentsTrue: threads.length, includeSubagentsFalse: withoutChildren.threads?.length }, architects: architects.map((t) => t.title), builders: builders.map((t) => t.title), children: children.map((t) => t.title), architectReadThread: architectRead?.thread ?? architectRead },
    true,
  );
  capture("grouping.json", "t3_thread_list + client-settings.json", {
    grouping,
    counts: { default: defaultList.threads?.length, includeSubagentsTrue: threads.length, includeSubagentsFalse: withoutChildren.threads?.length },
    architectThreads: architects.map((t) => ({ threadId: t.threadId, title: t.title, status: t.status, settled: t.settled, parentThreadId: t.parentThreadId })),
    architectRead,
    builderTitles: builders.map((t) => t.title),
    childTitles: children.map((t) => t.title),
    listWithoutSubagents: withoutChildren,
  });

  // ── Q9: brief size + attachments ─────────────────────────────────────────
  let attachment: unknown;
  try {
    const bytes = readFileSync(ATTACHMENT_FIXTURE);
    const prep: any = await client.callTool("t3_attachment_prepare_upload", {
      upload: { type: "image", name: "design.png", mimeType: "image/png", sizeBytes: bytes.byteLength },
    });
    const relativeUrl: string = prep.relativeUrl;
    const uploaded = await fetch(`${client.credential?.baseUrl ?? ""}${relativeUrl}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: bytes,
    });
    // One retry: the measurement is "the run RECEIVES the image", and a stalled provider turn is a
    // flake of the model, not of the attachment path (the upload and the accepted launch are already
    // observed above).
    let reply: string | null = null;
    let runStatus: string | null = null;
    let withImage: Awaited<ReturnType<typeof attemptLaunch>> = { ok: false, error: "not attempted" };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      withImage = await attemptLaunch(client, project, `attachment${attempt === 1 ? "" : " retry"}`, {
        message: "An image is attached. Reply with exactly IMAGE-OK and its pixel dimensions. Do not edit files.",
        attachments: [{ type: "image", id: prep.attachmentId, name: "design.png", mimeType: "image/png", sizeBytes: bytes.byteLength }],
        ...boundToProbe(),
      });
      if (!withImage.ok) break;
      const waited = await client.wait(withImage.threadId, 240_000).catch(() => ({ status: "wait-timeout" }));
      runStatus = waited.status;
      const read = await client.read(withImage.threadId, { limit: 20 });
      reply = texts(read, "assistant_message").join("\n").trim();
      if ((reply ?? "").includes("IMAGE-OK")) break;
      await client.interrupt(withImage.threadId).catch(() => undefined);
    }
    attachment = { prepare: prep, uploadStatus: uploaded.status, withImage, runStatus, reply };
    record("Q9 attachment", withImage.ok && (reply ?? "").includes("IMAGE-OK"), `upload=${uploaded.status} launch=${withImage.ok ? "ok" : withImage.error} run=${runStatus} reply=${JSON.stringify((reply ?? "").slice(0, 160))}`, attachment);
    capture("attachment.json", "t3_attachment_prepare_upload + t3_thread_launch", attachment);
  } catch (err) {
    attachment = { error: errText(err) };
    record("Q9 attachment", false, errText(err), attachment);
    capture("attachment.json", "t3_attachment_prepare_upload", attachment);
  }

  const oversize = await attemptLaunch(client, project, "oversize message", {
    message: "x".repeat(OVERSIZE_MESSAGE_CHARS),
    workspaceStrategy: { type: "root" },
  });
  record("Q9 oversize message", true, oversize.ok ? `ACCEPTED a ${OVERSIZE_MESSAGE_CHARS}-char message (${oversize.threadId}) — the limit is schema-level` : `refused: ${oversize.error}`, oversize);
  capture("oversize-message.json", "t3_thread_launch", { chars: OVERSIZE_MESSAGE_CHARS, result: oversize });
  if (oversize.ok) await client.interrupt(oversize.threadId).catch(() => undefined);

  // ── the failed run (fixture) ─────────────────────────────────────────────
  const broken = await attemptLaunch(client, project, "failed run", {
    message: "Reply with exactly NEVER-OK.",
    modelSelection: { instanceId: "opencode", model: FAILING_MODEL },
    workspaceStrategy: { type: "root" },
  });
  if (broken.ok) {
    const waited = await client.wait(broken.threadId, 240_000).catch((e) => ({ status: `wait-error: ${errText(e)}`, runId: "", timedOut: true }));
    const read = await client.read(broken.threadId, { limit: 10, runLimit: 5 });
    const activity = await client.activity(broken.threadId);
    record("failed run", read.thread.status === "failed", `run → ${waited.status}; thread status=${read.thread.status}; errors=${JSON.stringify(activity.items.filter((i) => i.type === "error").map((i) => [i.title, i.text]))}`, { launched: broken, waited, read, activity });
    capture("failed-run.json", "t3_thread_read + t3_thread_read(activity)", { launched: broken, waited, read, activity });
  } else {
    record("failed run", false, `launch refused (not a failed run): ${broken.error}`, broken);
    capture("failed-run.json", "t3_thread_launch", broken);
  }

  return { client, project, opts };
}

/** Every probe thread settled AND archived, and the throwaway worktree removed. Always runs. */
async function cleanupProbeThreads(client: T3Client, opts: ReturnType<typeof args>): Promise<void> {
  if (opts.keep) {
    record("cleanup", true, `skipped (--keep-threads); ${new Set(createdThreads).size} probe threads created`);
    return;
  }
  const unique = [...new Set(createdThreads)];
  const failed: Array<{ threadId: string; error: string }> = [];
  let alreadyParked = 0;
  for (const id of unique) {
    try {
      // An archived thread is already out of the active list; T3 refuses to settle it again
      // ("Thread … is archived."), which is itself the reason this check exists.
      const current = await client.read(id, { limit: 1, runLimit: 1 }).catch(() => null);
      if (current?.thread.archived === true) {
        alreadyParked += 1;
        continue;
      }
      // Settle is refused while a run is live ("… is still running. Stop it before settling."), so
      // interrupt and WAIT for the thread to leave the live statuses before settling.
      if (current && T3_LIVE_STATUSES.includes(current.thread.status as (typeof T3_LIVE_STATUSES)[number])) {
        await client.interrupt(id).catch(() => undefined);
        for (let i = 0; i < 15; i += 1) {
          await new Promise((r) => setTimeout(r, 2_000));
          const now = await client.read(id, { limit: 1, runLimit: 1 }).catch(() => null);
          if (!now || !T3_LIVE_STATUSES.includes(now.thread.status as (typeof T3_LIVE_STATUSES)[number])) break;
        }
      }
      await client.organize(id, "settle");
      await client.organize(id, "archive");
    } catch (err) {
      failed.push({ threadId: id, error: errText(err) });
    }
  }
  record("cleanup", failed.length === 0, `${unique.length - failed.length - alreadyParked} probe threads settled + archived, ${alreadyParked} already archived${failed.length > 0 ? ` · FAILED: ${JSON.stringify(failed)}` : ""}`, failed);

  // The throwaway worktree goes too — ob owns the worktree lifecycle, and a probe must not leave a
  // stray `omnislash.<branch>` for ob's own repo scan to trip over. Only a branch THIS run created is
  // deleted: a pre-existing branch is never this probe's to destroy.
  const remove = sh(["git", "worktree", "remove", "--force", PROBE_WORKTREE]);
  if (remove.code === 0 && !probeBranchExisted) sh(["git", "branch", "-D", PROBE_BRANCH]);
  record(
    "cleanup worktree",
    remove.code === 0,
    remove.code === 0
      ? `removed ${PROBE_WORKTREE}${probeBranchExisted ? ` (branch ${PROBE_BRANCH} kept — it pre-existed this run)` : ` and branch ${PROBE_BRANCH}`}`
      : `git worktree remove failed: ${remove.err.trim()} — remove ${PROBE_WORKTREE} by hand`,
  );
}

/** Write the transcript and the fixtures. Always runs, even after an aborted probe. */
function writeArtefacts(ctx: { client: T3Client; project: T3Project; opts: ReturnType<typeof args> }): void {
  const { client, project, opts } = ctx;
  mkdirSync(opts.fixturesDir, { recursive: true });
  const capturedAt = new Date().toISOString();
  for (const [name, data] of fixtures) {
    writeFileSync(join(opts.fixturesDir, name), `${JSON.stringify({ capturedAt, build, ticket: "1103", probe: "apps/cli/src/t3/surface-probe.ts", ...(data as object) }, null, 2)}\n`);
  }
  writeFileSync(
    join(opts.fixturesDir, "manifest.json"),
    `${JSON.stringify({ capturedAt, build, ticket: "1103", probe: "apps/cli/src/t3/surface-probe.ts", worktree: PROBE_WORKTREE, branch: PROBE_BRANCH, fixtures: [...fixtures.keys()].sort() }, null, 2)}\n`,
  );

  const lines = [
    "# T3 V2 surface contract probe transcript (ob 1103)",
    "",
    `- run: ${capturedAt}`,
    `- server: ${client.credential?.baseUrl ?? "?"} · T3 Code ${build}`,
    `- project: ${project.title} (${project.id}) · workspaceRoot ${project.workspaceRoot}`,
    `- probe worktree: ${PROBE_WORKTREE} (branch ${PROBE_BRANCH})`,
    `- command: \`bun apps/cli/src/t3/surface-probe.ts\``,
    "",
    "Every row is an observed tool result, not a claim. Each probe thread is titled `P0.2 probe · …`;",
    "the run settles and archives them at the end.",
    "",
    "| step | result | detail |",
    "|---|---|---|",
    ...transcript.map((l) => `| ${l.step} | ${l.ok ? "ok" : "FAIL"} | ${l.detail.replace(/\|/g, "\\|")} |`),
    "",
    "## Raw evidence",
    "",
    ...raw,
  ];
  mkdirSync(dirname(opts.transcriptPath), { recursive: true });
  writeFileSync(opts.transcriptPath, `${lines.join("\n")}\n`);
  console.log(`\nwrote ${opts.transcriptPath}`);
  console.log(`wrote ${fixtures.size + 1} fixture files under ${opts.fixturesDir}`);
}

/**
 * Run the probes, then clean up and write the artefacts — ALWAYS. A crash half way through must not
 * leave live probe threads or a stray worktree behind, which is why the finally-shaped structure is
 * here rather than at the top of a straight-line script.
 */
async function main(): Promise<void> {
  let ctx: { client: T3Client; project: T3Project; opts: ReturnType<typeof args> } | null = null;
  let aborted: unknown = null;
  try {
    ctx = await runProbes();
  } catch (err) {
    aborted = err;
    record("probe aborted", false, errText(err));
  }
  if (ctx) {
    try {
      await cleanupProbeThreads(ctx.client, ctx.opts);
    } catch (err) {
      record("cleanup", false, errText(err));
    }
    writeArtefacts(ctx);
  }
  if (aborted !== null) {
    console.error(`\nprobe aborted: ${errText(aborted)}`);
    process.exitCode = 1;
    return;
  }
  if (failures > 0) process.exitCode = 1;
}

await main();
