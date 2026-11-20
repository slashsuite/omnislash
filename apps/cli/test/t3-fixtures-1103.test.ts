import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Plain code-unit order of the string form, what a bare sort() gives.
const byCodeUnit = (x: string | null, y: string | null) => (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0);

// ob 1103 — the T3 V2 surface-contract fixtures.
//
// These are captured live from T3 Code 0.1.0 by `apps/cli/src/t3/surface-probe.ts`
// (transcript: docs/t3-surface-contract-probe.md). The launcher ticket tests against these fakes
// instead of a live T3, so the fixtures' SHAPE is a contract in its own right: this suite fails
// when a fixture is truncated, renamed, or stops answering the question it was captured for.
//
// It asserts the facts 1103 measured out of the launch tool's own schema and the captured reads.
// Nothing here needs a T3 server or a credential.

const DIR = join(import.meta.dir, "fixtures", "t3");

function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, name), "utf8")) as T;
}

function fixtureNames(): string[] {
  return readdirSync(DIR).filter((n) => n.endsWith(".json") && n !== "manifest.json").sort();
}

describe("ob 1103 — the T3 surface-contract fixtures", () => {
  test("every fixture is an envelope with its provenance", () => {
    for (const name of fixtureNames()) {
      const f = fixture(name);
      expect(f.capturedAt, `${name}: capturedAt`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof f.build, `${name}: build`).toBe("string");
      expect(typeof f.tool, `${name}: tool`).toBe("string");
      expect(f.ticket, `${name}: ticket`).toBe("1103");
      expect(f.result, `${name}: result`).toBeDefined();
    }
  });

  test("the manifest names exactly the fixtures on disk", () => {
    const manifest = fixture("manifest.json");
    expect([...(manifest.fixtures as string[])].sort(byCodeUnit)).toEqual(fixtureNames());
    expect(manifest.build).toBe("0.1.0");
    expect(manifest.probe).toBe("apps/cli/src/t3/surface-probe.ts");
  });

  test("Q1 — a launched thread is bound to an ob worktree outside the project root", () => {
    const read = fixture("launched-thread.json").result;
    expect(read.thread.worktreePath).toBe("/home/owner/dev/acme.p02-probe");
    expect(read.thread.branch).toBe("p02-probe");
    expect(read.thread.parentThreadId).toBeNull();
    expect(read.thread.runtimeMode).toBe("full-access");
    expect(read.thread.creationSource).toBe("mcp");
    expect(read.thread.title).toBe("P0.2 probe · worktree bind");
    expect(read.recentRuns[0].runId).toBeString();

    // The refusals are measurements too: a bad path is refused, the branch arg is NOT validated,
    // and a dirty / already-bound worktree is not refused at all.
    expect(fixture("refusal-bad-path.json").result.error).toContain("worktreePath must be one of the project's git worktrees");
    expect(fixture("refusal-branch-mismatch.json").result.ok).toBe(true);
    expect(fixture("refusal-already-bound.json").result.ok).toBe(true);
    expect(fixture("refusal-dirty-tree.json").result.ok).toBe(true);
  });

  test("Q2 — an explicit title survives regenerate_title, and the request is recorded", () => {
    const r = fixture("title-regeneration.json").result;
    expect(r.survived).toBe(true);
    expect(r.after.title).toBe("P0.2 probe · title stability");
    expect(r.after.titleRegeneration.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.before.titleRegeneration).toBeNull();
  });

  test("Q3 — an MCP message arrives verbatim; the explicit instruction is what bootstraps a skill", () => {
    const r = fixture("architect-bootstrap.json").result;
    expect(r.literalArrivedAs).toContain("$architect");
    expect(r.literalArrivedAs).toContain("/architect");
    expect(r.explicitReply).toContain("ARCHITECT-BOOTSTRAP-OK");
    expect(r.runStatus).toBe("completed");
  });

  test("Q4 — grouping is repository-mode, and children are in the list unless includeSubagents:false", () => {
    const r = fixture("grouping.json").result;
    expect(r.grouping.sidebarProjectGroupingMode).toBe("repository");
    expect(r.counts.includeSubagentsTrue).toBe(r.counts.default);
    expect(r.counts.includeSubagentsFalse).toBeLessThan(r.counts.includeSubagentsTrue);
    expect(r.architectThreads[0].title).toBe("acme · architect");
    // The pin is a write-only assertion from this surface: no read returns it.
    expect(Object.keys(r.architectRead.thread)).not.toContain("pinned");
  });

  test("Q5 — the same clientRequestId creates TWO threads: there is no retry key", () => {
    const r = fixture("idempotency.json").result;
    expect(r.threadsCreated).toBe(2);
    expect(r.first.threadId).not.toBe(r.second.threadId);
    const launchSchema = fixture("tool-schemas.json").result["t3_thread_launch"].inputSchema;
    expect(Object.keys(launchSchema.properties)).not.toContain("clientRequestId");
    expect(launchSchema.additionalProperties).toBe(true);
  });

  test("Q6 — settle is refused while a run is live; interrupt-then-settle is the way; cleanup is off by default", () => {
    const live = fixture("settle-live-run.json").result;
    expect(live.settleLive.refused).toContain("is still running. Stop it before settling.");
    expect(live.settleAfterInterrupt.sequence).toBeNumber();
    expect(live.final.settled).toBe(true);

    const settled = fixture("settled-thread.json").result;
    expect(settled.thread.settled).toBe(true);
    expect(fixture("settle-archive.json").result.afterArchive.archived).toBe(true);
    expect(fixture("settle-archive.json").result.worktreeOnDiskAfter).toBe(true);

    // T3's auto-settle knobs are all pull-request-keyed: a squash-landed branch with no PR settles
    // nothing, so `ob close` is the only merge-driven settle in this repo.
    const auto = fixture("auto-settle-settings.json").result.autoSettle;
    expect(auto.sidebarAutoSettleOnMerge.key).toBe("sidebarAutoSettleOnMerge");
    expect(auto.sidebarAutoSettleAfterDays.key).toBe("sidebarAutoSettleAfterDays");
    expect(auto.sidebarAutoSettleKeepPullRequests.key).toBe("sidebarAutoSettleKeepPullRequests");
  });

  test("Q7 — pendingRequestCount is the needs-you signal; approvals are not on the question channel", () => {
    const r = fixture("pending-request.json").result;
    expect(r.read.pendingRequestCount).toBe(1);
    expect(r.read.status).toBe("running");
    expect(r.read.runtimeMode).toBe("approval-required");
    expect(r.listed.requestIds).toEqual([]);
    expect(r.afterInterruptSettle.settled).toBe(true);
    // A plan does not gate the run on this build.
    expect(fixture("plan-mode.json").result.thread.pendingRequestCount).toBe(0);
    expect(fixture("plan-mode.json").result.thread.status).toBe("completed");
  });

  test("Q8 — the T3-launched opencode run is in session_v2, which ob's reader does not read", () => {
    const r = fixture("opencode-session.json").result;
    expect(r.legacyTable.totals.total).toBe(0);
    expect(r.sessionV2Table.rows.length).toBeGreaterThan(0);
    expect(r.sessionV2Table.totals.input).toBeGreaterThan(0);
    for (const row of r.sessionV2Table.rows) expect(row.directory).toBe("/home/owner/dev/acme.p02-probe");
  });

  test("Q9 — a brief carries an image through a pending upload, and the 120,000-char cap is enforced", () => {
    const r = fixture("attachment.json").result;
    expect(r.prepare.attachmentId).toStartWith("pending-");
    expect(r.uploadStatus).toBe(204);
    expect(r.reply).toContain("IMAGE-OK");
    expect(r.reply).toMatch(/1\s*[x×]\s*1/);

    const launchSchema = fixture("tool-schemas.json").result["t3_thread_launch"].inputSchema;
    expect(launchSchema.properties.message.anyOf[0].maxLength).toBe(120000);
    expect(launchSchema.properties.attachments.anyOf[0].maxItems).toBe(8);
    const oversize = fixture("oversize-message.json").result;
    expect(oversize.chars).toBe(120001);
    expect(oversize.result.ok).toBe(false);
    expect(oversize.result.error).toContain("at most 120000");
  });

  test("a failed run is a failed RUN, not a refused launch", () => {
    const r = fixture("failed-run.json").result;
    expect(r.launched.ok).toBe(true);
    const errors = r.activity.items.filter((i: any) => i.type === "error");
    expect(errors[0].title).toBe("Provider error");
    expect(errors[0].text).toContain("Model unavailable");
    expect(r.read.thread.status).toBe("failed");
    expect(r.waited.status).toBe("failed");
    expect(r.waited.runId).toEndWith("ordinal:1");
  });
});
