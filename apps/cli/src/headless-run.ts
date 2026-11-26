import { homedir } from "node:os";
import { AppError } from "./errors.ts";

export const OPENCODE_HEADLESS_MODEL = "opencode-go/deepseek-v4-flash";
export const OPENCODE_HEADLESS_VISION_MODEL = "opencode-go/deepseek-v4-flash-vision-exp";

export type HeadlessRunOpts = {
  prompt: string;
  model?: string;
  files?: string[];
  cwd?: string;
  timeout?: number;
};

function resolveModel(model?: string): string {
  const t = (model ?? "").trim();
  return t || OPENCODE_HEADLESS_MODEL;
}

export function headlessRunArgv(opts: {
  model?: string | undefined;
  prompt?: string | undefined;
  files?: string[] | undefined;
}): string[] {
  const argv = ["opencode", "run", "-m", resolveModel(opts.model), "--auto"];
  for (const f of opts.files ?? []) argv.push("--file", f);
  if (opts.prompt !== undefined) argv.push(opts.prompt);
  return argv;
}

export async function runHeadless(opts: HeadlessRunOpts): Promise<string> {
  // OB-1982: the prompt goes on stdin, never in argv. Linux caps one argv string at 128 KiB
  // (MAX_ARG_STRLEN), so a day summary over that failed to spawn with E2BIG. `opencode run`
  // with no message argument reads the message from piped stdin (proven in OB-1981).
  const proc = Bun.spawn(headlessRunArgv({ model: opts.model, files: opts.files }), {
    cwd: opts.cwd ?? homedir(),
    stdin: new Blob([opts.prompt]),
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.timeout !== undefined && { timeout: opts.timeout }),
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new AppError(
      `headless run exited ${proc.exitCode}${err ? `: ${err.slice(0, 200)}` : ""}`,
    );
  }
  return out;
}
