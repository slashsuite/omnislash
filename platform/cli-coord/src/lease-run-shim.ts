// The command runner inside the transient user service `ob lease run` starts (OB-2161). See
// `escapeRttime` in lease-run.ts for why the service exists.
//
//   bun lease-run-shim.ts <env file> <ob pid> -- <command...>
//
// The service starts with the user manager's environment and none of the caller's, so `ob` writes the
// caller's environment to a 0600 file and this shim reads and deletes it before anything else: the values
// never sit in the unit's properties or a process's argv. It then runs the command with that environment
// and inherited stdio, passes on the signals `ob` sends it (`systemctl --user kill --kill-whom=main`), and
// exits with the command's code, or 128 + the signal when the command died by one. systemd would read a
// signal death of the service itself as a clean exit 0, so the shim always exits with a plain code.
//
// If `ob` itself disappears (kill -9), nobody is left to stop the unit, so the shim polls `ob`'s pid and
// ends the command when it is gone. Standalone on purpose: no imports from the rest of ob.
import { readFileSync, rmSync } from "node:fs";
import { constants } from "node:os";

const OB_GONE_POLL_MS = 2_000;
const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const [envFile, obPidArg, sep, ...command] = process.argv.slice(2);
if (!envFile || !obPidArg || sep !== "--" || command.length === 0) {
  console.error("usage: lease-run-shim.ts <env file> <ob pid> -- <command...>");
  process.exit(2);
}

let env: Record<string, string>;
try {
  env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
} finally {
  rmSync(envFile, { force: true });
}

let child: ReturnType<typeof Bun.spawn>;
try {
  child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
} catch (err) {
  console.error(`ob lease run: cannot run '${command[0]}': ${(err as Error).message}`);
  process.exit(127);
}

for (const sig of FORWARDED) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      // already exited
    }
  });
}

const obPid = Number(obPidArg);
const watch = setInterval(() => {
  try {
    process.kill(obPid, 0);
  } catch {
    // ob is gone: nobody will release or stop anything, so end the run rather than leave it orphaned.
    clearInterval(watch);
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
}, OB_GONE_POLL_MS);

const code = await child.exited;
clearInterval(watch);
process.exit(code ?? 128 + ((constants.signals as Record<string, number>)[child.signalCode ?? ""] ?? 1));
