#!/usr/bin/env bun
// Usage: bun scripts/check-workflows.ts <file.yml>...
//
// Every job must run on a GitHub-hosted runner: its `runs-on` is a string starting with `ubuntu-`,
// `macos-` or `windows-`, and holds no expression. A job that calls a reusable workflow (`uses:`)
// is checked through its `with.runs-on`, if it sets one. Exits 1 naming each job that fails.
import { basename } from "node:path";

const HOSTED_PREFIXES = ["ubuntu-", "macos-", "windows-"];

type Job = { "runs-on"?: unknown; uses?: unknown; with?: unknown };
type Workflow = { jobs?: Record<string, Job> };

function hostedLabel(runsOn: unknown): boolean {
  return (
    typeof runsOn === "string" &&
    HOSTED_PREFIXES.some((prefix) => runsOn.startsWith(prefix)) &&
    !runsOn.includes("${{")
  );
}

export function checkWorkflow(name: string, text: string): string[] {
  const wf = (Bun.YAML.parse(text) ?? {}) as Workflow;
  const failures: string[] = [];
  for (const [id, raw] of Object.entries(wf.jobs ?? {})) {
    const job = (raw ?? {}) as Job;
    if (job.uses !== undefined) {
      const withRunsOn = (job.with as Record<string, unknown> | undefined)?.["runs-on"];
      if (withRunsOn !== undefined && !hostedLabel(withRunsOn)) {
        failures.push(`${name}: job ${id} calls a workflow on runs-on ${JSON.stringify(withRunsOn)}, not a GitHub-hosted runner`);
      }
      continue;
    }
    if (!hostedLabel(job["runs-on"])) {
      failures.push(`${name}: job ${id} runs-on ${JSON.stringify(job["runs-on"] ?? null)}, not a GitHub-hosted runner`);
    }
  }
  return failures;
}

if (import.meta.main) {
  const files = Bun.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: bun scripts/check-workflows.ts <file.yml>...");
    process.exit(2);
  }
  const failures: string[] = [];
  for (const file of files) {
    failures.push(...checkWorkflow(basename(file), await Bun.file(file).text()));
  }
  if (failures.length) {
    for (const line of failures) console.error(`FAIL ${line}`);
    process.exit(1);
  }
  console.log(`ok: ${files.length} workflow(s)`);
}
