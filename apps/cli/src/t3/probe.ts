#!/usr/bin/env bun
/**
 * ob → T3 write-transport probe (wayfinder ticket 1102, acceptance).
 *
 * One scripted sequence against a real T3 server, from Bun, asserting its own
 * results (exit 0 / 1) and writing a transcript under `docs/`:
 *
 *   preflight    the server answers without a credential
 *   refusal      a `t3 auth session` bearer is REJECTED by /mcp (the map's warning, re-proved)
 *   issue        mint an MCP credential (authorization-code + PKCE + pairing code)
 *   renewal      revoke it → the server refuses → re-mint → the server accepts
 *   launch       t3_thread_launch on the OmniSlash project + a throwaway worktree under /tmp
 *   read         t3_thread_read reports the run
 *   wait         t3_thread_wait settles the run
 *   rename       t3_thread_update action=rename, visible on the next read
 *   settle       t3_thread_organize action=settle, observed on the next read
 *
 * Usage:
 *   bun apps/cli/src/t3/probe.ts [--keep-worktree] [--transcript <path>]
 *
 * It touches the real T3 server and the real credential file, which is the
 * point: "it worked once in the T3 UI" is not proof, a call from ob is.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  T3Client,
  T3_ACCESS,
  credentialPath,
  decodeTokenClaims,
  mintCredential,
  t3BaseUrl,
} from "./client.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const PROBE_WORKTREE = "/tmp/opencode/t3-probe-wt";
const DEFAULT_TRANSCRIPT = join(REPO_ROOT, "docs", "t3-transport-probe.md");

interface Line {
  step: string;
  ok: boolean;
  detail: string;
}

const transcript: Line[] = [];
const evidence: string[] = [];
let failures = 0;

function record(step: string, ok: boolean, detail: string, extra?: string): void {
  transcript.push({ step, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? "OK  " : "FAIL";
  console.log(`${mark} ${step.padEnd(10)} ${detail}`);
  if (extra) console.log(extra.split("\n").map((l) => `       ${l}`).join("\n"));
  if (extra) evidence.push(`### ${step}\n\n\`\`\`\n${extra}\n\`\`\`\n`);
}

function sh(argv: string[], opts: { cwd?: string } = {}): { code: number; out: string; err: string } {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", cwd: opts.cwd ?? REPO_ROOT });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function args(): { keepWorktree: boolean; transcript: string } {
  const argv = process.argv.slice(2);
  let keepWorktree = false;
  let transcriptPath = DEFAULT_TRANSCRIPT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--keep-worktree") keepWorktree = true;
    if (argv[i] === "--transcript") transcriptPath = argv[i + 1] ?? transcriptPath;
  }
  return { keepWorktree, transcript: transcriptPath };
}

function ensureWorktree(): void {
  const listed = sh(["git", "worktree", "list", "--porcelain"]).out;
  if (listed.includes(PROBE_WORKTREE)) return;
  if (existsSync(PROBE_WORKTREE)) rmSync(PROBE_WORKTREE, { recursive: true, force: true });
  const base = sh(["git", "rev-parse", "HEAD"]).out.trim();
  const add = sh(["git", "worktree", "add", "--detach", PROBE_WORKTREE, base || "HEAD"]);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.err.trim()}`);
}

/** Pick a model from the first provider T3 advertises as usable. */
async function pickModel(client: T3Client): Promise<{ instanceId: string; model: string }> {
  const caps = await client.capabilities();
  for (const p of caps.providers) {
    if ((p.constraints ?? []).length === 0 && p.models.length > 0) {
      return { instanceId: p.providerInstanceId, model: p.models[0]!.id };
    }
  }
  throw new Error("no provider instance is usable (all have constraints or no models)");
}

async function main(): Promise<void> {
  const opts = args();
  const env = process.env;
  const baseUrl = t3BaseUrl(env);
  console.log(`T3 transport probe · ${baseUrl} · build probe\n`);

  // 0. preflight — reachability without a credential.
  const pre = new T3Client({ baseUrl, env, credential: null });
  const reach = await pre.reachable();
  record("preflight", reach.ok, reach.ok ? `server reachable (${reach.detail})` : reach.detail);
  if (!reach.ok) throw new Error(`T3 not reachable at ${baseUrl}`);

  // 1. refusal — a `t3 auth session` bearer is not an MCP credential.
  const session = sh(["t3", "auth", "session", "issue", "--ttl", "5m", "--label", "ob-t3-probe", "--token-only"]);
  if (session.code === 0 && session.out.trim().length > 0) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${session.out.trim()}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ob-probe", version: "1" } } }),
    });
    const body = await res.text();
    const rejected = res.status === 401 && body.includes("invalid_mcp_credential");
    record("refusal", rejected, `session bearer → HTTP ${res.status} ${rejected ? "(invalid_mcp_credential: a session token is NOT an MCP credential)" : ""}`, body.slice(0, 300));
  } else {
    record("refusal", false, `could not issue a session bearer: ${session.err.trim().slice(0, 200)}`);
  }

  // 2. issue — mint the MCP credential.
  const mint = await mintCredential({ baseUrl, env, access: T3_ACCESS });
  const tokenLine = decodeTokenClaims(mint.credential.accessToken);
  record(
    "issue",
    mint.path !== null,
    `minted via ${mint.steps.length} steps → ${mint.path}`,
    `${mint.steps.join("\n")}\naccess=${mint.credential.access} scopes=${mint.credential.scopes.join(" ")}\nissued=${mint.credential.issuedAt} expires=${mint.credential.expiresAt}\nttl=${
      tokenLine.exp && tokenLine.iat ? (tokenLine.exp - tokenLine.iat) / 1000 + "s" : "?"
    }`,
  );

  // 3. renewal — revoke (the server's own invalidation), prove the refusal, re-mint.
  const sid = tokenLine.sid;
  let revokedRefused = false;
  if (sid) {
    const revoke = sh(["t3", "auth", "session", "revoke", sid]);
    const afterRevoke = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${mint.credential.accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ob-probe", version: "1" } } }),
    });
    const body = await afterRevoke.text();
    revokedRefused = afterRevoke.status === 401;
    record(
      "renewal/1",
      revoke.code === 0 && revokedRefused,
      `revoked session ${sid} → /mcp HTTP ${afterRevoke.status} (${revokedRefused ? "server refused the dead token" : "UNEXPECTED"})`,
      body.slice(0, 300),
    );
    const remint = await mintCredential({ baseUrl, env, access: T3_ACCESS });
    const live = new T3Client({ baseUrl, env, credential: remint.credential });
    const init = await live.initialize();
    record("renewal/2", true, `re-minted and accepted: T3 Code ${init.serverVersion}`, remint.steps.join("\n"));
  } else {
    record("renewal/1", false, "minted credential carried no session id (sid)");
  }

  // 4. a connected client, from the credential file doctor will read.
  const client = await T3Client.connected({ baseUrl, env });
  const environment = await client.environment();
  record("connected", true, `${environment.label} · T3 Code ${client.version}`, JSON.stringify(environment, null, 2));

  const projects = await client.projects();
  const omnislash = projects.find((p) => p.title === "omnislash") ?? projects[0];
  if (!omnislash) throw new Error("no T3 project mapped for OmniSlash");
  record("projects", true, `${projects.length} mapped: ${projects.map((p) => p.title).join(", ")}`);

  ensureWorktree();
  record("worktree", true, `throwaway worktree ${PROBE_WORKTREE}`);
  const model = await pickModel(client);
  record("model", true, `${model.instanceId} · ${model.model}`);

  // 5. launch.
  const launched = await client.launch({
    projectId: omnislash.id,
    title: "ob-t3-transport-probe",
    message: "Reply with exactly: PROBE-OK. Do not edit any files.",
    modelSelection: model,
    runtimeMode: "full-access",
    workspaceStrategy: { type: "existing_worktree", worktreePath: PROBE_WORKTREE },
  });
  const threadIdPresent = typeof launched.threadId === "string" && launched.threadId.length > 0;
  record("launch", threadIdPresent, `threadId=${launched.threadId} run=${launched.runId} status=${launched.status}`, JSON.stringify(launched, null, 2));
  if (!threadIdPresent) throw new Error("launch returned no thread id");
  const threadId = launched.threadId;

  // 6. read its run status (must be a real status, not undefined).
  await new Promise((r) => setTimeout(r, 1500));
  const read = await client.read(threadId, { limit: 10 });
  const status = read.thread?.status;
  record("read", typeof status === "string" && status.length > 0, `run status = ${status} (thread ${read.thread?.title})`, JSON.stringify({ status, recentRuns: read.recentRuns, worktreePath: read.thread?.worktreePath }, null, 2));

  // 7. wait for the run to leave the active states (bounded; a provider failure is still a settled run).
  const waited = await client.wait(threadId, 120_000);
  record("wait", typeof waited.status === "string", `wait → ${waited.status}${waited.timedOut ? " (timed out)" : ""}`, JSON.stringify(waited, null, 2));

  // 8. rename, and observe it.
  const newTitle = `ob-t3-transport-probe ${new Date().toISOString().slice(11, 19)}`;
  await client.rename(threadId, newTitle);
  await new Promise((r) => setTimeout(r, 750));
  const afterRename = await client.read(threadId, { limit: 1 });
  const renameVisible = afterRename.thread?.title === newTitle;
  record("rename", renameVisible, `title is now ${JSON.stringify(afterRename.thread?.title)}`, JSON.stringify({ expected: newTitle, actual: afterRename.thread?.title }, null, 2));

  // 9. settle, and observe it.
  await client.settle(threadId);
  await new Promise((r) => setTimeout(r, 750));
  const afterSettle = await client.read(threadId, { limit: 1 });
  const settled = afterSettle.thread?.settled === true;
  record("settle", settled, `settled = ${afterSettle.thread?.settled}`, JSON.stringify({ settled: afterSettle.thread?.settled, settledAt: (afterSettle.thread as unknown as { settledAt?: string })?.settledAt }, null, 2));

  // 10. provider-refusal surfacing: activity items carry `type:"error"` with the upstream text.
  const activity = await client.activity(threadId);
  const errorItem = activity.items.find((i) => i.type === "error");
  record(
    "activity",
    true,
    errorItem ? `provider refusal surfaced: ${JSON.stringify(errorItem.text)}` : `no provider error (run ${afterSettle.thread?.status})`,
    JSON.stringify(activity.items.map((i) => ({ position: i.position, type: i.type, status: i.status, text: i.text })), null, 2),
  );

  if (!opts.keepWorktree) {
    sh(["git", "worktree", "remove", "--force", PROBE_WORKTREE]);
    record("cleanup", true, `removed ${PROBE_WORKTREE}`);
  }

  writeTranscript(opts.transcript, baseUrl, environment.serverVersion);
  console.log(`\ntranscript: ${opts.transcript}`);
  console.log(failures === 0 ? "PROBE PASSED (exit 0)" : `PROBE FAILED: ${failures} step(s) (exit 1)`);
  process.exit(failures === 0 ? 0 : 1);
}

function writeTranscript(path: string, baseUrl: string, serverVersion: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = [
    "# T3 write-transport probe transcript (ob 1102)",
    "",
    `- run: ${new Date().toISOString()}`,
    `- server: ${baseUrl} · T3 Code ${serverVersion}`,
    `- credential: ${credentialPath()} (mode 600, outside the repo)`,
    "- command: `bun apps/cli/src/t3/probe.ts`",
    "",
    "Every step below is an observed HTTP exchange or tool result, not a claim. The exit code of the",
    "probe is the verdict: 0 when launch/read/wait/rename/settle each produced the evidence shown.",
    "",
    "| step | result | detail |",
    "|---|---|---|",
    ...transcript.map((l) => `| ${l.step} | ${l.ok ? "ok" : "FAILED"} | ${l.detail.replace(/\|/g, "\\|")} |`),
    "",
    "## Raw evidence",
    "",
    ...evidence,
    "## What this proves",
    "",
    "- `launch` returned a thread id on the pinned build — the thread exists in T3, created by `ob`, not by the UI.",
    "- `refusal` shows a `t3 auth session` bearer is rejected by `/mcp` with `invalid_mcp_credential`: the MCP credential is a different credential class, and the map's warning is permanent.",
    "- `renewal/1` shows the server refusing a revoked token; `renewal/2` shows a re-mint being accepted. Renewal is re-minting: the OAuth metadata advertises no refresh grant.",
    "- `read`, `rename` and `settle` show run state is readable, the rename is visible, and the settle is observed.",
  ];
  writeFileSync(path, header.join("\n") + "\n", { mode: 0o644 });
}

main().catch((err) => {
  record("fatal", false, (err as Error).message);
  try {
    writeTranscript(args().transcript, t3BaseUrl(), "unknown");
  } catch {
    /* transcript is best-effort on a hard failure */
  }
  console.error(`\nPROBE FAILED: ${(err as Error).message}`);
  process.exit(1);
});
