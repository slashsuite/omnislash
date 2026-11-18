// ---------------------------------------------------------------------------
// Terminal prompts (209).
//
// One credential in ob is deliberately NOT stored anywhere: the router admin
// password. It is typed in when a pull needs it, so the only way to obtain it is
// to ask the terminal. Everything here is therefore about a secret that must
// never be echoed, never appear in argv (a shell would put it in history and in
// every process listing) and never be written to disk.
// ---------------------------------------------------------------------------

import { AppError } from "./errors.ts";

/** Ask a human for a secret. Injected in tests so nothing ever reads a real terminal. */
export type SecretPrompt = (label: string) => Promise<string>;

/** Toggle terminal echo on the inherited tty. Best-effort: a missing stty must not lose the prompt. */
function setEcho(on: boolean): void {
  try {
    Bun.spawnSync(["stty", on ? "echo" : "-echo"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch {
    // no stty: the prompt still works, it just echoes.
  }
}

/**
 * Read a secret from the terminal with echo off. The label goes to STDERR so a
 * `--json` caller's stdout stays machine-readable, and the value is returned to
 * the caller only: it is never printed, logged or persisted.
 */
export const promptSecretTty: SecretPrompt = async (label) => {
  if (!process.stdin.isTTY) {
    throw new AppError(`cannot ask for ${label}: stdin is not a terminal`);
  }
  process.stderr.write(`${label}: `);
  setEcho(false);
  try {
    // One line, read straight off stdin. The terminal is still in canonical mode, so
    // the line arrives on Enter; echo is what was turned off, not line editing.
    let buffered = "";
    for await (const chunk of process.stdin as AsyncIterable<Uint8Array | string>) {
      buffered += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      const nl = buffered.indexOf("\n");
      if (nl >= 0) return buffered.slice(0, nl).trim();
    }
    throw new AppError(`no ${label} was entered`);
  } finally {
    setEcho(true);
    process.stderr.write("\n");
  }
};
