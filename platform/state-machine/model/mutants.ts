// OS-249: prove TeamRestart.tla is not vacuous. Each mutant removes one guard the code has: on the model's lines
// tagged `\* guard:<name>` it swaps `from` for `to`, and TLC must then break `rule`. A mutant TLC passes means
// the model no longer covers that guard, and this exits 1. `bunx moon run state-machine:tlc` runs it after the
// models; run it alone with `bun model/mutants.ts` from platform/state-machine.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Mutant = { name: string; swaps: [from: string, to: string][]; rule: string; code: string };

const MUTANTS: Mutant[] = [
  { name: "replacing", swaps: [["/\\ bound = old[r] \\/ ~Live(bound)", "/\\ TRUE"]], rule: "OneSeedPerHandoff", code: "ensureTeamThread opens a thread although the row names another live one" },
  { name: "drain", swaps: [["/\\ Queued(o) = 0", "/\\ TRUE"]], rule: "SettledHoldsNothing", code: "settleWhenIdle settles a thread still holding queued messages" },
  { name: "idle", swaps: [["/\\ o \\notin running", "/\\ TRUE"]], rule: "SettledHoldsNothing", code: "settleWhenIdle settles a thread mid-turn" },
  { name: "consume", swaps: [["IF old[r] \\in settled", "IF TRUE"]], rule: "ConsumedOnlyRetired", code: "the handoff is consumed although the settle timed out" },
  { name: "dedup", swaps: [["IF ~noticed[o]", "IF TRUE"]], rule: "RetiredStaysSettled", code: "the retired notice has no request id, so a second restart's notice wakes the settled thread" },
  { name: "redirect", swaps: [["THEN bound ELSE t", "THEN t ELSE t"], ["/\\ to = bound", "/\\ TRUE"]], rule: "RetiredStaysSettled", code: "a send goes to a remembered thread id, retired or not" },
  { name: "keep-notice", swaps: [["/\\ qnote' = qnote", "/\\ qnote' = [qnote EXCEPT ![n] = @ + qnote[o], ![o] = 0]"]], rule: "NoNoticeToSeat", code: "moveQueuedMessages moves an earlier run's queued retired notice to the replacement" },
  { name: "withdraw-ask", swaps: [["+ qstray[o]", "+ qstray[o] + qask[o]"]], rule: "NoStrayHandoff", code: "moveQueuedMessages moves a queued handoff request to the replacement" },
];

const here = import.meta.dirname;
const model = readFileSync(join(here, "TeamRestart.tla"), "utf8");
const tmp = process.env.TMPDIR ?? join(homedir(), ".cache", "tmp");
mkdirSync(tmp, { recursive: true });

// Every tagged guard has a mutant, so a guard tagged later cannot go unchecked.
const tagged = new Set([...model.matchAll(/\\\* guard:([\w-]+)/g)].map((x) => x[1]));
const untested = [...tagged].filter((g) => !MUTANTS.some((m) => m.name === g));
if (untested.length) throw new Error(`guard(s) tagged in TeamRestart.tla with no mutant: ${untested.join(", ")}`);

function mutate(m: Mutant): string {
  let changed = 0;
  const lines = model.split("\n").map((line) => {
    if (!line.includes(`guard:${m.name}`)) return line;
    for (const [from, to] of m.swaps) {
      if (line.includes(from)) {
        line = line.replace(from, to);
        changed++;
      }
    }
    return line;
  });
  if (changed < m.swaps.length) throw new Error(`mutant ${m.name}: a swap found no guard:${m.name} line to change; the model moved, update mutants.ts`);
  return lines.join("\n");
}

let failed = false;
for (const m of MUTANTS) {
  const dir = mkdtempSync(join(tmp, `tlc-mutant-${m.name}-`));
  try {
    writeFileSync(join(dir, "TeamRestart.tla"), mutate(m));
    copyFileSync(join(here, "TeamRestart.cfg"), join(dir, "TeamRestart.cfg"));
    const run = Bun.spawnSync(["bash", join(here, "tlc.sh"), "--here", "TeamRestart"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const out = run.stdout.toString() + run.stderr.toString();
    const broke = run.exitCode !== 0 && new RegExp(`(Invariant|Action property|Temporal properties?).*${m.rule}|${m.rule}.*violated`).test(out);
    const steps = (out.match(/^State \d+:/gm) ?? []).length;
    if (broke) console.log(`mutant ${m.name} (${m.code}): TLC breaks ${m.rule} in ${steps} steps`);
    else {
      failed = true;
      console.error(`mutant ${m.name} (${m.code}): TLC did NOT break ${m.rule}\n${out.split("\n").slice(-15).join("\n")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
