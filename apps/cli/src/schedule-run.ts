// OS-311: run one claimed command job on THIS machine (`ob role tick`), never on the API server. `sh -c <command>`
// in the job's cwd, stdout and stderr read together as they arrive, the last 4000 characters kept, stopped after a
// timeout. A command that cannot start, fails or times out is an outcome to record, never a thrown error.
import { homedir } from "node:os";
import { boundTail, OUTPUT_TAIL_MAX, type ClaimedCommand } from "./scheduled-jobs.ts";

/** How long a scheduled command may run before it is stopped. */
const COMMAND_TIMEOUT_MS = 5 * 60_000;

export interface CommandOutcome {
  status: "succeeded" | "failed";
  exit_code: number | null;
  output_tail: string;
}

/** A job's cwd with a leading `~` read as the home directory. Pure aside from `home`. */
export function expandCwd(cwd: string | null, home: string = homedir()): string | undefined {
  if (cwd === null) return undefined;
  if (cwd === "~") return home;
  if (cwd.startsWith("~/")) return `${home}${cwd.slice(1)}`;
  return cwd;
}

/** Run a claimed command: exit 0 is `succeeded`, anything else (a non-zero exit, a timeout, no start) `failed`. */
export async function runClaimedCommand(job: Pick<ClaimedCommand, "command" | "cwd">, opts: { timeoutMs?: number } = {}): Promise<CommandOutcome> {
  const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
  let tail = "";
  const keep = (chunk: string): void => {
    tail = boundTail(tail + chunk, OUTPUT_TAIL_MAX * 2);
  };
  let proc: ReturnType<typeof Bun.spawn>;
  const cwd = expandCwd(job.cwd);
  try {
    proc = Bun.spawn(["sh", "-c", job.command], { ...(cwd === undefined ? {} : { cwd }), detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return { status: "failed", exit_code: null, output_tail: boundTail(`could not start: ${err instanceof Error ? err.message : String(err)}`) };
  }
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      keep(decoder.decode(value, { stream: true }));
    }
    keep(decoder.decode());
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // The command runs in its own process group, so a timeout stops what it started too, not only the shell.
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, timeoutMs);
  const drained = Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>), drain(proc.stderr as ReadableStream<Uint8Array>)]).catch(() => {});
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  // A child the command left running can hold the pipes open after the shell exits: the output is read for a moment
  // more, never waited on for good.
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([drained, new Promise((resolve) => (grace = setTimeout(resolve, 2000)))]);
  clearTimeout(grace);
  if (timedOut) {
    keep(`\n[stopped: still running after ${Math.round(timeoutMs / 1000)}s]`);
    return { status: "failed", exit_code: null, output_tail: boundTail(tail) };
  }
  const code = proc.exitCode;
  return { status: code === 0 ? "succeeded" : "failed", exit_code: code, output_tail: boundTail(tail) };
}
