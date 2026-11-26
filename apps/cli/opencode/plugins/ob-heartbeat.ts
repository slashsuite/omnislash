import { bindV2Hooks, locationPaths, type V2SetupCtx } from "../lib/v2-setup.ts";

export const HEARTBEAT_MIN_MS = 15_000;
const NOTE_MAX = 80;

const COMMIT_STATES = ["landable", "ready", "needs-human", "blocked", "partial"] as const;
type CommitState = (typeof COMMIT_STATES)[number];

const COMMIT_STATE_ACTION: Record<CommitState, { status: string; spinoffReady: boolean }> = {
  landable: { status: "readying", spinoffReady: true },
  ready: { status: "readying", spinoffReady: true },
  "needs-human": { status: "needs-human", spinoffReady: true },
  blocked: { status: "blocked", spinoffReady: false },
  partial: { status: "needs-human", spinoffReady: false },
};

export function parseCommitState(command: string): CommitState | null {
  if (!/\bgit\s+commit\b/.test(command)) return null;
  const matches = [...command.matchAll(/^State:\s+(\S+)/gm)];
  const inline = command.match(/(?:-m|--message)(?:\s+|=)['"]State:\s+([^'"\s]+)/);
  const token = matches[matches.length - 1]?.[1] ?? inline?.[1];
  if (!token) return null;
  return (COMMIT_STATES as readonly string[]).includes(token) ? (token as CommitState) : null;
}

type AgentJson = { id: string; worktree?: string | null };

type ObResult = { ok: boolean; stdout: string };

type ToolAfterInput = { tool: string; args?: Record<string, unknown> };
type ToolAfterOutput = { title?: string };

function stripSlash(p: string): string {
  const s = p.replace(/\/+$/, "");
  return s.length === 0 ? "/" : s;
}

function matchAgentId(rows: AgentJson[], directory: string, worktree: string): string | null {
  const dir = stripSlash(directory);
  const wt = stripSlash(worktree);
  const hits = rows.filter((r) => {
    if (!r.worktree) return false;
    const row = stripSlash(r.worktree);
    return row === wt || row === dir;
  });
  return hits.length === 1 ? hits[0]!.id : null;
}

function formatToolNote(tool: string, output: ToolAfterOutput, args?: Record<string, unknown>): string {
  const fromArgs =
    typeof args?.filePath === "string"
      ? args.filePath
      : typeof args?.path === "string"
        ? args.path
        : typeof args?.command === "string"
          ? args.command
          : "";
  const extra = (output.title?.trim() || fromArgs).replace(/\s+/g, " ").trim();
  const raw = extra ? `${tool} ${extra}` : tool;
  return raw.length > NOTE_MAX ? `${raw.slice(0, NOTE_MAX - 1)}…` : raw;
}

async function spawnOb(args: string[]): Promise<ObResult> {
  try {
    const proc = Bun.spawn([process.env.OB_BIN || "ob", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export function createHeartbeatHooks(input: { directory: string; worktree: string }) {
  let cachedId: string | undefined;
  let lastBeat = 0;
  let disposed = false;

  async function resolveId(): Promise<string | null> {
    if (cachedId) return cachedId;
    const listed = await spawnOb(["agents", "--json"]);
    if (!listed.ok) return null;
    let rows: unknown;
    try {
      rows = JSON.parse(listed.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    const id = matchAgentId(rows as AgentJson[], input.directory, input.worktree);
    if (id) cachedId = id;
    return id;
  }

  async function heartbeat(id: string): Promise<boolean> {
    const t = Date.now();
    if (t - lastBeat < HEARTBEAT_MIN_MS) return true;
    lastBeat = t;
    const beat = await spawnOb(["agent", "heartbeat", id]);
    if (!beat.ok) {
      cachedId = undefined;
      lastBeat = 0;
      return false;
    }
    return true;
  }

  async function onActivity(note?: string): Promise<void> {
    if (disposed) return;
    const id = await resolveId();
    if (!id) return;
    await heartbeat(id);
    if (note === undefined) return;
    if (disposed) return;
    await spawnOb(["agent", "register", "--id", id, "--note", note]);
  }

  async function stampStatus(status: string): Promise<void> {
    if (disposed) return;
    const id = await resolveId();
    if (!id) return;
    if (disposed) return;
    await spawnOb(["agent", "register", "--id", id, "--status", status]);
  }

  return {
    dispose: async () => {
      disposed = true;
    },
    event: async (input: { event: { type?: string } }) => {
      if (input.event.type === "session.idle") await stampStatus("needs-human");
    },
    "chat.message": async () => {
      await onActivity();
      if (disposed) return;
      const id = await resolveId();
      if (!id) return;
      await stampStatus(id.startsWith("architect-") ? "planning" : "working");
    },
    "tool.execute.after": async (toolInput: ToolAfterInput, output: ToolAfterOutput) => {
      await onActivity(formatToolNote(toolInput.tool, output, toolInput.args));
      if (disposed) return;
      const command = typeof toolInput.args?.command === "string" ? toolInput.args.command : "";
      const state = parseCommitState(command);
      if (!state) return;
      const id = await resolveId();
      if (!id) return;
      const action = COMMIT_STATE_ACTION[state];
      await spawnOb(["agent", "register", "--id", id, "--status", action.status]);
      if (action.spinoffReady) await spawnOb(["spinoff", "ready"]);
    },
  };
}

export default {
  id: "ob-heartbeat",
  async setup(ctx: V2SetupCtx) {
    return bindV2Hooks(ctx, createHeartbeatHooks(locationPaths(ctx)));
  },
};
