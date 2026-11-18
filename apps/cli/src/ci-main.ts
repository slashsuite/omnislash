// OB-2276: GitHub webhooks into ob, and a red run on `main` tells the team's sentinel, else its architect.
//
// GitHub pushes each event to `POST /api/ob/github/webhook` within seconds of it happening, so no agent has to
// poll GitHub to learn that `main` went red. The receiver (api/server.ts) checks GitHub's HMAC signature, records
// the delivery once by its `X-GitHub-Delivery` id, keeps a short summary in the `event` store, and hands a
// completed `workflow_run` to `handleRun` here. This file holds every rule; the server and the CLI only call it.
//
// The rules for a completed run of a workflow on `main`, started by a push:
//   * failure, timed_out or startup_failure (never cancelled): told ONCE per run id to the project's team's
//     sentinel, else its architect (`teamHandoffTarget`). A project in no team is told nobody, but its row is
//     still written, so `ob alerts` shows it until main is green again.
//   * success: when that workflow has a told failure not yet recovered, one "green again" line, once.
// A row in `ci_main_notice` is the record that a run was told. It is claimed BEFORE the send (insert, conflict
// does nothing) and removed again if the send fails, so two deliveries never both send and a failed send leaves
// no row: the hourly catch-up (`ob ci main --notify`, the `ci-main` job) then finds the run unrecorded and tries
// again.
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Store } from "./db/store.ts";
import { nowIso } from "./db.ts";
import { AppError } from "./errors.ts";
import { getSecret, hasSecret, type MasterKey } from "./secrets.ts";
import { recordEventFor } from "./events.ts";
import { settingFor } from "./settings.ts";
import { listProjects, parseRemote, type Project } from "./project.ts";
import { defineSeam } from "./test-seams.ts";
import { storeTeamOf, teamHandoffTarget, teamThreadIdOf } from "./team.ts";
import { T3Error } from "./t3/client.ts";
import { t3Seam, type AgentRegistry, type T3Seam } from "./t3/dispatch.ts";

/** The receiver's path under the API prefix. Matched exactly (method POST) and served without a bearer token. */
export const GITHUB_WEBHOOK_PATH = "/api/ob/github/webhook";
/**
 * Where GitHub sends events: the public URL of the receiver, from the `github_webhook_url` setting (the API's
 * public origin plus GITHUB_WEBHOOK_PATH). Empty by default: `ob ci hooks` refuses until it is set.
 */
export async function githubWebhookUrl(store: Store): Promise<string> {
  const url = await settingFor(store, "github_webhook_url");
  if (!url) throw new AppError(`github_webhook_url is not set (ob config set github_webhook_url https://<api host>${GITHUB_WEBHOOK_PATH})`);
  return url;
}
/** The encrypted-store secret both GitHub and the receiver sign with. Never printed. */
export const WEBHOOK_SECRET_NAME = "github-webhook-secret";
/** The events every hook sends: the CI run, and the PR and push events OB-2277 moves onto (so it needs no second hook). */
export const HOOK_EVENTS: readonly string[] = ["workflow_run", "check_suite", "pull_request", "push"];
/** The conclusions that are a red `main`. `cancelled` is not: it is a person or a newer push stopping the run. */
export const RED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);
/** The branch watched. */
export const MAIN_BRANCH = "main";

/** The webhook secret from the encrypted store, or null when none is stored. */
export async function readWebhookSecret(store: Store, key: MasterKey): Promise<string | null> {
  if (!(await hasSecret(store, WEBHOOK_SECRET_NAME))) return null;
  return getSecret(store, WEBHOOK_SECRET_NAME, key.get());
}

/** The webhook secret, or a refusal naming the command that sets it: `github hooks --yes` signs every hook with it. */
export async function requireWebhookSecret(store: Store, key: MasterKey): Promise<string> {
  const secret = await readWebhookSecret(store, key);
  if (secret === null) throw new AppError(`the webhook secret is not set: ob secret set ${WEBHOOK_SECRET_NAME} (a generated value), then run this again`);
  return secret;
}

// --- GitHub REST --------------------------------------------------------------------------------------------

/** The slice of GitHub's REST API this file uses. A fake in tests; `httpGithubRest` with the `github` secret on the host. */
export interface GithubRest {
  request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T>;
}

/** The real REST client. The token goes in the Authorization header only, never in a message or a URL. */
export function httpGithubRest(token: string, fetchImpl: typeof fetch = fetch): GithubRest {
  return {
    async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
      const res = await fetchImpl(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "omnislash-ob",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = ((await res.json()) as { message?: string }).message ?? "";
        } catch {
          /* no body */
        }
        throw new Error(`GitHub ${method} ${path} -> ${res.status}${detail ? ` (${detail})` : ""}`);
      }
      return (res.status === 204 ? null : await res.json()) as T;
    },
  };
}

/** Test seam: the REST client every path here uses instead of the real one. */
const restSeam = defineSeam<GithubRest | null>("ci-main.githubRest", null);
export function __setGithubRest(next: GithubRest | null): () => void {
  return restSeam.set(next);
}
/** The REST client: the test seam when one is set, else `make()` (which reads the token). */
export async function githubRestFor(make: () => Promise<GithubRest>): Promise<GithubRest> {
  return restSeam.get() ?? (await make());
}

// --- the signature ------------------------------------------------------------------------------------------

/**
 * Does `header` (GitHub's `X-Hub-Signature-256`, `sha256=<hex>`) sign `body` with `secret`? Constant-time on
 * the digest; a missing, malformed or wrong header is false. Pure.
 */
export function verifyWebhookSignature(secret: string, body: string, header: string | null): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const want = createHmac("sha256", secret).update(body, "utf8").digest();
  return timingSafeEqual(want, Buffer.from(given, "hex"));
}

/** The signature GitHub would send for `body`. For tests and for nothing else. Pure. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

// --- a run --------------------------------------------------------------------------------------------------

/** A completed workflow run, from a webhook payload or the REST run list (the two share the run's shape). */
export interface CiRun {
  runId: string;
  /** `owner/name`. */
  repo: string;
  workflowId: string;
  workflow: string;
  branch: string;
  event: string;
  conclusion: string | null;
  sha: string;
  /** The head commit's first line. */
  subject: string;
  url: string;
}

interface RawRun {
  id?: number | string;
  name?: string;
  workflow_id?: number | string;
  head_branch?: string | null;
  event?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  head_commit?: { message?: string } | null;
  display_title?: string;
  html_url?: string;
  created_at?: string;
  repository?: { full_name?: string };
}

/** A REST or webhook run as a `CiRun`; `repo` is the fallback when the run carries no repository. Pure. */
export function ciRunFrom(raw: RawRun, repo?: string): CiRun {
  const message = raw.head_commit?.message ?? raw.display_title ?? "";
  return {
    runId: String(raw.id ?? ""),
    repo: raw.repository?.full_name ?? repo ?? "",
    workflowId: String(raw.workflow_id ?? ""),
    workflow: raw.name ?? "",
    branch: raw.head_branch ?? "",
    event: raw.event ?? "",
    conclusion: raw.conclusion ?? null,
    sha: raw.head_sha ?? "",
    subject: message.split("\n")[0]!.trim(),
    url: raw.html_url ?? "",
  };
}

/** Is this a run on `main` started by a push: the only runs this file acts on. Pure. */
export function isMainPush(run: CiRun): boolean {
  return run.branch === MAIN_BRANCH && run.event === "push";
}

/** The project whose GitHub remote is `repo` (`owner/name`, any case), or null. Pure. */
export function projectForRepo(projects: readonly Project[], repo: string): Project | null {
  const want = repo.toLowerCase();
  return projects.find((p) => repoOfProject(p)?.toLowerCase() === want) ?? null;
}

/** A project's GitHub `owner/name`, from its recorded git remote, or null. Pure. */
export function repoOfProject(p: Pick<Project, "git_remote">): string | null {
  const info = p.git_remote ? parseRemote(p.git_remote) : null;
  return info ? `${info.org}/${info.repo}` : null;
}

/** The names of the jobs that failed in a run, over REST. A failed read is a named line, never a throw. */
export async function failingJobs(rest: GithubRest, run: CiRun): Promise<string> {
  try {
    const res = await rest.request<{ jobs?: Array<{ name?: string; conclusion?: string | null }> }>(
      "GET",
      `/repos/${run.repo}/actions/runs/${run.runId}/jobs?per_page=100&filter=latest`,
    );
    const names = (res.jobs ?? []).filter((j) => j.conclusion && RED_CONCLUSIONS.has(j.conclusion)).map((j) => j.name ?? "(unnamed)");
    return names.length ? names.join(", ") : "(no job reported a failure)";
  } catch (err) {
    return `(could not read the jobs: ${(err as Error).message})`;
  }
}

/** The note a red run sends. Pure. */
export function redNote(run: CiRun, jobs: string): string {
  return [
    `main is red: ${run.repo} · ${run.workflow}`,
    `  conclusion: ${run.conclusion}`,
    `  commit:     ${run.sha.slice(0, 7)} ${run.subject}`,
    `  failed:     ${jobs}`,
    `  run:        ${run.url}`,
    "",
    "A commit on main can be a combination no PR ran (a PR behind main merges without a re-run when nothing",
    "overlaps). Read the run, then fix it on a branch and its PR, or ticket it.",
  ].join("\n");
}

/** The one line a recovery sends. Pure. */
export function greenNote(run: CiRun, told: number): string {
  return `main is green again: ${run.repo} · ${run.workflow} at ${run.sha.slice(0, 7)} (${told === 1 ? "the red run" : `${told} red runs`} before it now recovered) ${run.url}`;
}

// --- telling ------------------------------------------------------------------------------------------------

/** What one run did. `told` and `recovered` sent a note; `recorded` wrote a row with nobody to tell. */
export interface CiOutcome {
  runId: string;
  repo: string;
  workflow: string;
  conclusion: string | null;
  action: "told" | "recorded" | "recovered" | "already" | "ignored" | "failed";
  /** The agent row told (`sentinel-<team>` or `architect-<team>`), or null. */
  target: string | null;
  /** Why, for every action but `told` and `recovered`. */
  reason: string | null;
}

export interface CiDeps {
  rest: GithubRest;
  registry: AgentRegistry;
  /** The T3 seam; left undefined in production, where `t3Seam()` connects. */
  seam?: T3Seam;
  /** The wait before the one retry of a failed send. */
  sleep?: (ms: number) => Promise<void>;
}

/** How long a failed note waits before its one retry, as the readying note does (OB-2172). */
export const CI_NOTE_RETRY_MS = 5_000;
const retryMs = defineSeam<number>("ci-main.retryMs", CI_NOTE_RETRY_MS);
export function __setCiRetryMs(ms: number): () => void {
  return retryMs.set(ms);
}

type Route = { kind: "thread"; agentId: string; threadId: string } | { kind: "nobody"; reason: string } | { kind: "failed"; reason: string };

/** Where a repo's note goes: its project's team's sentinel, else its architect, or the named reason there is none. */
async function routeFor(store: Store, registry: AgentRegistry, repo: string): Promise<Route> {
  const project = projectForRepo(await listProjects(store), repo);
  if (!project) return { kind: "nobody", reason: `${repo} is no ob project's git remote` };
  const route = await teamHandoffTarget({ ticket: repo, projectOf: async () => project.id, teamOf: storeTeamOf(store), registry });
  if (route.kind === "skip") return { kind: "nobody", reason: route.reason };
  if (route.kind === "failed") return { kind: "failed", reason: route.reason };
  let row: Awaited<ReturnType<AgentRegistry["read"]>>;
  try {
    row = await registry.read(route.target.agentId);
  } catch (err) {
    return { kind: "failed", reason: `could not read ${route.target.agentId}: ${(err as Error).message}` };
  }
  const threadId = teamThreadIdOf(row);
  // A team whose thread is not up yet is a failed route, never "nobody": the run is left unclaimed so the hourly
  // catch-up tells the thread once it exists. Only a project in no team (or a repo that is no project) is nobody.
  if (!threadId) return { kind: "failed", reason: `no ${route.target.label} thread: run \`ob t3 architect ${route.target.team}\`` };
  return { kind: "thread", agentId: route.target.agentId, threadId };
}

/** Send one queued note, with one retry unless the credential itself is the problem. Null on success, else why. */
async function sendNote(deps: CiDeps, threadId: string, message: string, clientRequestId: string): Promise<string | null> {
  let permanent = false;
  const attempt = async (): Promise<string | null> => {
    try {
      const seam = deps.seam ?? (await t3Seam());
      await seam.send({ threadId, message, mode: "queue", clientRequestId });
      return null;
    } catch (err) {
      permanent =
        err instanceof T3Error && (err.kind === "credential_missing" || err.kind === "credential_expired" || err.kind === "credential_rejected");
      const remedy = err instanceof T3Error && err.remedy ? ` (${err.remedy})` : "";
      return `T3 did not take the note for thread ${threadId}: ${(err as Error).message}${remedy}`;
    }
  };
  let reason = await attempt();
  if (reason !== null && !permanent) {
    await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(retryMs.get());
    reason = await attempt();
  }
  return reason;
}

const base = (run: CiRun) => ({ runId: run.runId, repo: run.repo, workflow: run.workflow, conclusion: run.conclusion });

/**
 * Act on one completed run: tell a red `main` once, or send one recovery line. Never throws for a failed send
 * or route: that is a `failed` outcome, and it leaves no row so the catch-up tries again.
 */
export async function handleRun(store: Store, run: CiRun, deps: CiDeps): Promise<CiOutcome> {
  if (!isMainPush(run)) return { ...base(run), action: "ignored", target: null, reason: `not a push run on ${MAIN_BRANCH}` };
  if (run.conclusion && RED_CONCLUSIONS.has(run.conclusion)) return tellRed(store, run, deps);
  if (run.conclusion === "success") return recover(store, run, deps);
  return { ...base(run), action: "ignored", target: null, reason: `conclusion ${run.conclusion ?? "none"} is neither red nor green` };
}

async function tellRed(store: Store, run: CiRun, deps: CiDeps): Promise<CiOutcome> {
  const t = store.t.ciMainNotice;
  const route = await routeFor(store, deps.registry, run.repo);
  if (route.kind === "failed") return { ...base(run), action: "failed", target: null, reason: route.reason };
  // Claim the run first: a second delivery (or the catch-up running at the same moment) finds the row and stops.
  const claimed = (await store.q
    .insert(t)
    .values({
      run_id: run.runId,
      repo: run.repo,
      workflow_id: run.workflowId,
      workflow: run.workflow,
      conclusion: run.conclusion ?? "",
      sha: run.sha,
      run_url: run.url,
      target: route.kind === "thread" ? route.agentId : null,
      told_at: nowIso(),
      recovered_at: null,
    })
    .onConflictDoNothing()
    .returning({ run_id: t.run_id })) as Array<{ run_id: string }>;
  if (claimed.length === 0) return { ...base(run), action: "already", target: null, reason: `run ${run.runId} was already told` };
  if (route.kind === "nobody") return { ...base(run), action: "recorded", target: null, reason: route.reason };
  const note = redNote(run, await failingJobs(deps.rest, run));
  const failed = await sendNote(deps, route.threadId, note, `ob-ci-red-${run.runId}`);
  if (failed !== null) {
    await store.q.delete(t).where(eq(t.run_id, run.runId));
    return { ...base(run), action: "failed", target: route.agentId, reason: failed };
  }
  return { ...base(run), action: "told", target: route.agentId, reason: null };
}

async function recover(store: Store, run: CiRun, deps: CiDeps): Promise<CiOutcome> {
  const t = store.t.ciMainNotice;
  const open = (await store.q
    .select({ run_id: t.run_id, target: t.target })
    .from(t)
    .where(and(eq(t.repo, run.repo), eq(t.workflow_id, run.workflowId), isNull(t.recovered_at)))) as Array<{ run_id: string; target: string | null }>;
  // Only failures up to this run recover: a green delivery that arrives late must not clear a newer red. The same
  // run id counts: a re-run ("Re-run failed jobs") keeps the id and only raises run_attempt, so a green with the
  // told run's own id is that run passing on a later attempt.
  const older = open.filter((r) => Number(r.run_id) <= Number(run.runId)).map((r) => r.run_id);
  if (older.length === 0) return { ...base(run), action: "ignored", target: null, reason: "no told failure is waiting for this green" };
  const now = nowIso();
  const mine = ((await store.q
    .update(t)
    .set({ recovered_at: now })
    .where(and(inArray(t.run_id, older), isNull(t.recovered_at)))
    .returning({ run_id: t.run_id, target: t.target })) as Array<{ run_id: string; target: string | null }>);
  if (mine.length === 0) return { ...base(run), action: "already", target: null, reason: "another delivery already recovered it" };
  if (!mine.some((r) => r.target !== null)) return { ...base(run), action: "recovered", target: null, reason: "nobody was told the red, so nobody is told the green" };
  const route = await routeFor(store, deps.registry, run.repo);
  const undo = async () => {
    await store.q.update(t).set({ recovered_at: null }).where(inArray(t.run_id, mine.map((r) => r.run_id)));
  };
  if (route.kind !== "thread") {
    if (route.kind === "nobody") return { ...base(run), action: "recovered", target: null, reason: route.reason };
    await undo();
    return { ...base(run), action: "failed", target: null, reason: route.reason };
  }
  const failed = await sendNote(deps, route.threadId, greenNote(run, mine.length), `ob-ci-green-${run.runId}`);
  if (failed !== null) {
    await undo();
    return { ...base(run), action: "failed", target: route.agentId, reason: failed };
  }
  return { ...base(run), action: "recovered", target: route.agentId, reason: null };
}

// --- the receiver -------------------------------------------------------------------------------------------

export interface WebhookRequest {
  event: string | null;
  delivery: string | null;
  signature: string | null;
  body: string;
}

/** What the receiver answers, and the work it leaves to run after the answer (GitHub waits 10 s at most). */
export interface WebhookResult {
  status: 200 | 202 | 400 | 401 | 503;
  body: Record<string, unknown>;
  /** The run to act on after answering, when there is one. */
  run: CiRun | null;
}

/**
 * Check, record and classify one delivery. Records nothing unless the signature is good. A delivery id seen
 * before answers 200 and does nothing (GitHub's redelivery). A `workflow_run` completed comes back as `run` for
 * the caller to hand to `handleRun` once the answer is sent.
 */
export async function receiveWebhook(store: Store, req: WebhookRequest, secret: string | null): Promise<WebhookResult> {
  if (secret === null) {
    return { status: 503, body: { error: { code: "api_disabled", message: `the webhook secret is not set on this host: ob secret set ${WEBHOOK_SECRET_NAME}` } }, run: null };
  }
  if (!verifyWebhookSignature(secret, req.body, req.signature)) {
    return { status: 401, body: { error: { code: "unauthorized", message: "a valid X-Hub-Signature-256 is required" } }, run: null };
  }
  if (!req.delivery || !req.event) {
    return { status: 400, body: { error: { code: "invalid_request", message: "X-GitHub-Delivery and X-GitHub-Event are required" } }, run: null };
  }
  let payload: { action?: string; zen?: string; workflow_run?: RawRun; repository?: { full_name?: string } };
  try {
    payload = JSON.parse(req.body);
  } catch {
    return { status: 400, body: { error: { code: "invalid_request", message: "the body is not JSON" } }, run: null };
  }
  const t = store.t.githubDelivery;
  const now = nowIso();
  const fresh = (await store.q
    .insert(t)
    .values({ delivery_id: req.delivery, event: req.event, received_at: now })
    .onConflictDoNothing()
    .returning({ delivery_id: t.delivery_id })) as Array<{ delivery_id: string }>;
  if (fresh.length === 0) return { status: 200, body: { delivery: req.delivery, duplicate: true }, run: null };

  const repo = payload.repository?.full_name ?? null;
  const run = req.event === "workflow_run" && payload.workflow_run ? ciRunFrom(payload.workflow_run, repo ?? undefined) : null;
  await recordEventFor(store, {
    ts: now,
    source: "github",
    type: `webhook:${req.event}`,
    payload: {
      delivery: req.delivery,
      action: payload.action ?? null,
      repo,
      ...(run ? { run_id: run.runId, workflow: run.workflow, branch: run.branch, run_event: run.event, conclusion: run.conclusion, sha: run.sha } : {}),
    },
  });
  if (req.event === "ping") return { status: 200, body: { delivery: req.delivery, ping: true }, run: null };
  const act = run !== null && payload.action === "completed" && isMainPush(run);
  return { status: 202, body: { delivery: req.delivery, event: req.event, acting: act }, run: act ? run : null };
}

// --- the catch-up: `ob ci main` -----------------------------------------------------------------------------

/** One project's latest completed push runs on `main`, one per workflow, newest first. */
export interface CiMainReport {
  project: string;
  repo: string | null;
  runs: CiRun[];
  /** A named line instead of runs: no remote, no runs on main, or a read that failed. */
  note: string | null;
  /** True when the read failed (the job exits 1). */
  error: boolean;
}

/** Latest completed push run per workflow on `main` for one repo. */
export async function latestMainRuns(rest: GithubRest, repo: string): Promise<CiRun[]> {
  const res = await rest.request<{ workflow_runs?: RawRun[] }>(
    "GET",
    `/repos/${repo}/actions/runs?branch=${MAIN_BRANCH}&event=push&status=completed&per_page=100`,
  );
  const seen = new Set<string>();
  const out: CiRun[] = [];
  for (const raw of res.workflow_runs ?? []) {
    const run = ciRunFrom(raw, repo);
    if (!isMainPush(run) || seen.has(run.workflowId)) continue;
    seen.add(run.workflowId);
    out.push(run);
  }
  return out;
}

/** Every project (or one), read in parallel. */
export async function ciMainList(store: Store, rest: GithubRest, opts: { project?: string } = {}): Promise<CiMainReport[]> {
  let projects = await listProjects(store);
  if (opts.project) {
    projects = projects.filter((p) => p.id === opts.project || p.name === opts.project);
    if (projects.length === 0) throw new AppError(`no project '${opts.project}'`);
  }
  return Promise.all(
    projects.map(async (p): Promise<CiMainReport> => {
      const repo = repoOfProject(p);
      if (!repo) return { project: p.id, repo: null, runs: [], note: `no GitHub remote recorded (ob project edit ${p.id} --remote <url>)`, error: false };
      try {
        const runs = await latestMainRuns(rest, repo);
        return { project: p.id, repo, runs, note: runs.length ? null : `no runs on ${MAIN_BRANCH}`, error: false };
      } catch (err) {
        return { project: p.id, repo, runs: [], note: `could not read: ${(err as Error).message}`, error: true };
      }
    }),
  );
}

/** `ob ci main --notify`: list, then act on each latest run, so a delivery the receiver missed is caught up. */
export async function ciMainNotify(
  store: Store,
  deps: CiDeps,
  opts: { project?: string } = {},
): Promise<{ reports: CiMainReport[]; outcomes: CiOutcome[] }> {
  const reports = await ciMainList(store, deps.rest, opts);
  const outcomes: CiOutcome[] = [];
  for (const r of reports) for (const run of r.runs) outcomes.push(await handleRun(store, run, deps));
  return { reports, outcomes };
}

/** Printed form of the list. Pure. */
export function renderCiMain(reports: readonly CiMainReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    if (r.note) {
      lines.push(`${r.project}: ${r.note}`);
      continue;
    }
    lines.push(`${r.project} (${r.repo})`);
    for (const run of r.runs) {
      lines.push(`  ${run.workflow.padEnd(20)} ${(run.conclusion ?? "none").padEnd(16)} ${run.sha.slice(0, 7)}  ${run.url}`);
    }
  }
  return lines.length ? lines.join("\n") : "no projects";
}

/** Printed form of what `--notify` did, skipping the runs it had nothing to do for. Pure. */
export function renderCiOutcomes(outcomes: readonly CiOutcome[]): string {
  const acted = outcomes.filter((o) => o.action !== "ignored" && o.action !== "already");
  if (acted.length === 0) return "notify: nothing to send";
  return acted
    .map((o) => `notify: ${o.action} ${o.repo} · ${o.workflow} run ${o.runId}${o.target ? ` -> ${o.target}` : ""}${o.reason ? `: ${o.reason}` : ""}`)
    .join("\n");
}

// --- alerts -------------------------------------------------------------------------------------------------

export interface OpenNotice {
  run_id: string;
  repo: string;
  workflow_id: string;
  workflow: string;
  conclusion: string;
  sha: string | null;
  run_url: string | null;
  target: string | null;
  told_at: string;
}

/** Every told red run not yet recovered, oldest first. */
export async function openCiNotices(store: Store): Promise<OpenNotice[]> {
  const t = store.t.ciMainNotice;
  const rows = (await store.q
    .select({
      run_id: t.run_id,
      repo: t.repo,
      workflow_id: t.workflow_id,
      workflow: t.workflow,
      conclusion: t.conclusion,
      sha: t.sha,
      run_url: t.run_url,
      target: t.target,
      told_at: t.told_at,
    })
    .from(t)
    .where(isNull(t.recovered_at))) as OpenNotice[];
  return rows.sort((a, b) => a.told_at.localeCompare(b.told_at) || Number(a.run_id) - Number(b.run_id));
}

// --- hooks: `ob github hooks` -------------------------------------------------------------------------------

export interface HookPlanRow {
  project: string;
  repo: string | null;
  /** ok · create · fix · skip (no remote) · error (the read failed). After `--yes`: created · fixed · failed. */
  action: "ok" | "create" | "fix" | "skip" | "error" | "created" | "fixed" | "failed";
  hookId: number | null;
  detail: string | null;
}

interface RawHook {
  id?: number;
  active?: boolean;
  events?: string[];
  config?: { url?: string; content_type?: string };
}

/** What is wrong with an existing hook, or null when it is right. Pure. */
export function hookProblems(hook: RawHook): string | null {
  const problems: string[] = [];
  const events = new Set(hook.events ?? []);
  const missing = HOOK_EVENTS.filter((e) => !events.has(e));
  if (missing.length) problems.push(`missing events ${missing.join(", ")}`);
  if (hook.active === false) problems.push("inactive");
  if (hook.config?.content_type !== "json") problems.push(`content type ${hook.config?.content_type ?? "unset"}, not json`);
  return problems.length ? problems.join("; ") : null;
}

/** Per project with a GitHub remote, whether its hook to `url` exists and is right. Reads only. */
export async function hooksPlan(store: Store, rest: GithubRest, webhookUrl?: string): Promise<HookPlanRow[]> {
  const url = webhookUrl ?? (await githubWebhookUrl(store));
  const projects = await listProjects(store);
  return Promise.all(
    projects.map(async (p): Promise<HookPlanRow> => {
      const repo = repoOfProject(p);
      if (!repo) return { project: p.id, repo: null, action: "skip", hookId: null, detail: "no GitHub remote recorded" };
      try {
        const hooks = await rest.request<RawHook[]>("GET", `/repos/${repo}/hooks?per_page=100`);
        const hook = (hooks ?? []).find((h) => h.config?.url === url);
        if (!hook) return { project: p.id, repo, action: "create", hookId: null, detail: `events ${HOOK_EVENTS.join(", ")}` };
        const problems = hookProblems(hook);
        return { project: p.id, repo, action: problems ? "fix" : "ok", hookId: hook.id ?? null, detail: problems };
      } catch (err) {
        return { project: p.id, repo, action: "error", hookId: null, detail: (err as Error).message };
      }
    }),
  );
}

/** Create or fix each hook the plan names. `secret` is the webhook secret; it goes in the request body only. */
export async function hooksApply(store: Store, rest: GithubRest, secret: string, webhookUrl?: string): Promise<HookPlanRow[]> {
  const url = webhookUrl ?? (await githubWebhookUrl(store));
  const plan = await hooksPlan(store, rest, url);
  const body = { name: "web", active: true, events: [...HOOK_EVENTS], config: { url, content_type: "json", secret, insecure_ssl: "0" } };
  const out: HookPlanRow[] = [];
  for (const row of plan) {
    if (row.action !== "create" && row.action !== "fix") {
      out.push(row);
      continue;
    }
    try {
      if (row.action === "create") {
        const made = await rest.request<{ id?: number }>("POST", `/repos/${row.repo}/hooks`, body);
        out.push({ ...row, action: "created", hookId: made?.id ?? null });
      } else {
        await rest.request("PATCH", `/repos/${row.repo}/hooks/${row.hookId}`, body);
        out.push({ ...row, action: "fixed" });
      }
    } catch (err) {
      out.push({ ...row, action: "failed", detail: (err as Error).message });
    }
  }
  return out;
}

/** Printed form of a plan or its result. Pure. */
export function renderHooks(rows: readonly HookPlanRow[], dryRun: boolean): string {
  const word: Record<HookPlanRow["action"], string> = {
    ok: "ok",
    create: "would create",
    fix: "would fix",
    skip: "skip",
    error: "could not read",
    created: "created",
    fixed: "fixed",
    failed: "FAILED",
  };
  const lines = rows.map((r) => `${r.project.padEnd(18)} ${(r.repo ?? "-").padEnd(40)} ${word[r.action]}${r.detail ? `: ${r.detail}` : ""}`);
  const pending = rows.filter((r) => r.action === "create" || r.action === "fix").length;
  if (dryRun) lines.push(pending ? `dry run: ${pending} hook(s) to create or fix; nothing changed. Run again with --yes to apply.` : "dry run: nothing to change.");
  return lines.join("\n");
}
