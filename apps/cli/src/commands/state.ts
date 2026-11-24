import { type Ctx, emitItem, itemArg } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { decisionOptsOf } from "../decisions.ts";
import { closeAndLand, type CloseAndLandResult } from "../close.ts";
import { emitId, print, warn, type Mode } from "../output.ts";
import { syncIssueState } from "../tracker-link.ts";
import { refsFor } from "../refs.ts";
// 1120: landing settles the ticket's T3 threads (best effort, after the close stands).
import {
  checkoutRootOf,
  dropQueuedReadyNotes,
  ownCloseLine,
  renderLandReplyOutcome,
  renderSettleOutcome,
  renderStaleNoteOutcome,
  replyLandedToBuilders,
  servingSpinoffRows,
  settleT3ThreadsFor,
  retiredCloseLine,
  splitOwnRows,
  storeAgentRegistry,
  type ServingSpinoffRow,
  unjoinedSettleWarning,
  worktreeRepoOf,
} from "../t3/dispatch.ts";
import { landCommitFor, localMergedPrUrl, rowProjectOf } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { storeTeamOf, teamHandoffTarget, type HandoffRoute } from "../team.ts";
import { unresolvedRefWarning } from "../../../../platform/cli-coord/src/spinoff-item.ts";
import {
  assertReopen,
  assertTransition,
  blockItem,
  moveItem,
  readyItem,
  reopenItem,
  startItem,
  unblockItem,
} from "../workflow.ts";

export async function cmdStart(ctx: Ctx): Promise<void> {
  const id = await itemArg(ctx, ctx.args[0]);
  if (!id) throw new UsageError("start requires an <id>");
  await startItem(ctx.store ?? ctx.db, id, decisionOptsOf(ctx));
  await emitItem(ctx, id);
}

export async function cmdReady(ctx: Ctx): Promise<void> {
  const id = await itemArg(ctx, ctx.args[0]);
  if (!id) throw new UsageError("ready requires an <id>");
  await readyItem(ctx.store ?? ctx.db, id, decisionOptsOf(ctx));
  await emitItem(ctx, id);
}

// 77: landing closes BOTH trackers. `ob close`/`ob reopen` move the LOCAL item first (that write is the
// source of truth and always stands), then mirror the move onto the item's linked GitHub issue and report
// exactly which issue it touched. No link → nothing is attempted and the output is unchanged.
// `--no-github` skips the GitHub call only; `--dry-run` writes NOTHING ON EITHER SIDE (the house meaning
// of the flag everywhere else in ob) and just previews both moves. A GitHub failure leaves the local close
// in place and exits 1 with a loud stderr line, because a SILENT half-close is the drift this exists to stop.
async function emitWithIssue(ctx: Ctx, id: string, want: "closed" | "open"): Promise<void> {
  const outcome = await syncIssueState(ctx.store ?? ctx.db, id, want, {
    skip: !!ctx.flags["no-github"],
    dryRun: !!ctx.flags["dry-run"],
  });
  print(renderIssueSync(id, outcome, want, ctx.mode, (await refsFor(ctx.store ?? ctx.db, [id])).get(id)));
  const drift = mirrorDriftWarning(id, outcome, want);
  if (drift) {
    warn(drift);
    ctx.exit = 1;
  }
  // 1120: landing also retires the ticket's T3 threads. Only on a close (a reopen has nothing to settle),
  // and never on the `--dry-run` path above, which writes nothing anywhere.
  if (want === "closed") await settleTicketThreads(ctx, id);
}

/**
 * Settle every T3 thread this ticket's spinoff rows opened (1120), so a finished builder leaves T3's
 * active list when the ticket lands. T3's own 3-day auto-settle is the backstop; this is the door.
 *
 * BEST EFFORT AND LOUD ABOUT IT: the close has already happened in ob, and a settle is a
 * UI-organisation write on another system, so a failure is a WARNING that names the thread — never a
 * rollback of the close, and never silence. Nothing is asked of T3 when the ticket has no t3 rows (a
 * legacy row pays nothing here, not even a credential read). A close that found no row at all
 * says so too, when the ticket's record shows it was dispatched (1163).
 */
async function settleTicketThreads(ctx: Ctx, ticketRef: string): Promise<void> {
  const db = ctx.store ?? ctx.db;
  // 1205: FIRST, and before anything that can wait or return early. A readying note QUEUED before this land
  // asks for a gate this close just gave; T3 delivers it when the architect's turn ends, which is minutes
  // later, and it arrives looking like a builder declaring work still to be gated. The withdrawal depends on
  // the ARCHITECT's thread, never on a builder's, so it must not sit behind the land reply's own bounded wait
  // (up to 30s) (a window the architect can end its turn inside) nor behind any of the returns below.
  const serving: Awaited<ReturnType<typeof servingSpinoffRows>> = await servingSpinoffRows(db, ticketRef).catch(
    (err: Error) => {
      // The rows are what the withdrawal, the reply and the settle all read. A read that failed is its own
      // fact, named once here rather than folded into "nothing to join" (1163).
      warn(`t3: ${ticketRef} closed, but its spinoff rows could not be read: ${err.message}`);
      return { rows: [], unresolved: [] };
    },
  );
  // OB-1670 (#80): a builder closing its own ticket from its own worktree keeps its own row out of the
  // land reply and the settle (its thread is the one running this close). Its queued handoff note is still
  // withdrawn with the rest: after the merge it is stale (1205).
  const { own, others, retired } = splitOwnRows(serving.rows, checkoutRootOf());
  for (const row of own) if (ctx.mode === "human") print(ownCloseLine(ticketRef, row));
  for (const row of retired) if (ctx.mode === "human") print(retiredCloseLine(ticketRef, row));
  const rows = serving.rows;
  await withdrawHeldReadyNotes(ctx, ticketRef, rows);
  // 1226: a candidate row the resolution could NOT settle — a ref two items both name, or a tracker read
  // that failed — is NAMED here, not dropped. Its thread is left alone (a wrong join costs a real turn,
  // 1188), so the close owes the human the sentence rather than skipping it. A print, never a wait: the
  // withdrawal above is still the first thing this land does to T3.
  for (const row of serving.unresolved) warn(unresolvedRefWarning(ticketRef, row));
  // 1133: the land, announced back, and it goes before the settle. Measured on the pinned build: a delivered
  // message re-activates a thread, so a settle that runs first is undone by the reply; and the reply waits
  // (bounded) for its own turn to end, which is what lets the settle below stick. A row with no recorded
  // thread id is a named skip; a failed send is a warning and never an exit code, because `ob close`'s
  // exit 1 already means something narrower (the GitHub mirror drifted) and a notifier is not a gate.
  let replies: Awaited<ReturnType<typeof replyLandedToBuilders>> = [];
  try {
    replies = await replyLandedToBuilders(others, ticketRef, {
      // The squash sha is read for the ROW's own dispatch ref, never the closed item's id (1205): a
      // hand-charted ticket's row carries the ref it was dispatched under (1124) while the closed item is
      // its mirror (1134), and the repo's squash subject names the DISPATCH ref. The API close path reads
      // it the same way, per row.
      landShaFor: (row) => landCommitFor(worktreeRepoOf(row.worktree) ?? row.worktree, row.ticket_ref),
    });
  } catch (err) {
    warn(`t3: ${ticketRef} closed, but its builders were not told it landed: ${(err as Error).message}`);
  }
  for (const reply of replies) {
    const rendered = renderLandReplyOutcome(reply);
    if (rendered.warning) warn(rendered.line);
    else if (ctx.mode === "human") print(rendered.line);
  }
  // 1120: the settle, now that the land reply's own turn has ended — and on the SAME rows the withdrawal
  // and the reply just used (1226), not a second selection that could answer differently.
  let outcomes: Awaited<ReturnType<typeof settleT3ThreadsFor>> = [];
  try {
    outcomes = await settleT3ThreadsFor(others, ticketRef);
  } catch (err) {
    warn(`t3: ${ticketRef} closed, but its T3 threads were not settled: ${(err as Error).message}`);
  }
  // 1163: a close that found NO row says so, when the ticket looks like it was dispatched at all. The
  // silent return here is what let the mismatch case survive its own first land. NOT when a row DOES serve
  // the ticket, or when an unresolved candidate was named (1226): "no spinoff row serves it" would
  // contradict either, and an empty settle is not a confirmed miss — a row with no recorded thread id is a
  // named skip elsewhere, not evidence that nothing serves the ticket. The API close path reads it the same
  // way (`mine.length > 0 || unresolved > 0`).
  if (rows.length === 0 && serving.unresolved.length === 0) {
    try {
      const line = await unjoinedSettleWarning(ctx.store ?? ctx.db, ticketRef);
      if (line) warn(line);
    } catch (err) {
      // The rows themselves could not be read: a different failure from "nothing to join", and one that
      // must not be silence either.
      warn(`t3: ${ticketRef} closed, but its spinoff rows could not be read: ${(err as Error).message}`);
    }
    return;
  }
  for (const o of outcomes) {
    const rendered = renderSettleOutcome(o);
    if (rendered.warning) warn(rendered.line);
    else if (ctx.mode === "human") print(rendered.line);
  }
}

/**
 * Withdraw the readying notes this land has made moot (1205), from the rows the close already read.
 *
 * BEST EFFORT AND NEVER SILENT ABOUT A FAILURE: the close stands whatever happens here. Only two outcomes
 * are printed (a withdrawal, and a failure) because the ordinary land finds an empty architect queue, and
 * `renderStaleNoteOutcome` returns nothing for that. `dropQueuedReadyNotes` itself never throws; this
 * wrapper only covers the setup it does (the setting read, the seam), which cannot be silent either.
 */
async function withdrawHeldReadyNotes(
  ctx: Ctx,
  ticketRef: string,
  rows: ServingSpinoffRow[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const store = ctx.store ?? ctx.db;
    // OB-2255, OS-181: the note went to the ticket's team's sentinel, so it is withdrawn there.
    // The route is the ticket's, not the repo's, so it is read once.
    let route: Promise<HandoffRoute> | null = null;
    const outcomes = await dropQueuedReadyNotes({
      rows,
      registry: storeAgentRegistry(store),
      targetFor: () =>
        (route ??= teamHandoffTarget({
          ticket: ticketRef,
          projectOf: () => rowProjectOf(store, { ticket_ref: ticketRef, item_id: null }),
          teamOf: storeTeamOf(store),
        })),
    });
    for (const o of outcomes) {
      const rendered = renderStaleNoteOutcome(o);
      if (!rendered) continue;
      if (rendered.warning) warn(rendered.line);
      else if (ctx.mode === "human") print(rendered.line);
    }
  } catch (err) {
    warn(`t3: ${ticketRef} closed, but a queued readying note was not withdrawn: ${(err as Error).message}`);
  }
}

/**
 * The output of a landing verb and its GitHub mirror, from the outcome alone (353). Pure, and shared with
 * the API client so `ob close` reads the same on a laptop as it does on the API host.
 */
export function renderIssueSync(
  id: string,
  outcome: Awaited<ReturnType<typeof syncIssueState>>,
  want: "closed" | "open",
  mode: Mode,
  ref?: string | null,
): string {
  if (mode === "json") {
    return JSON.stringify({
      id,
      ref: ref ?? null,
      issue: outcome.link ? outcome.link.number : null,
      issue_url: outcome.link ? outcome.link.url : null,
      issue_state: outcome.change ? outcome.change.state : null,
      already: outcome.change ? outcome.change.already : null,
      skipped: outcome.skipped,
      error: outcome.error,
    });
  }
  // 1949: the echo is the item's ref when it has one; --json keeps the legacy id beside it.
  const shown = ref ?? id;
  if (mode === "quiet") return shown;
  return outcome.link ? `${shown}\n  ${issueLine(outcome, want)}` : shown;
}

/** The stderr line a mirror drift earns, or null when the two trackers agree. Pure. */
export function mirrorDriftWarning(
  id: string,
  outcome: Awaited<ReturnType<typeof syncIssueState>>,
  want: "closed" | "open",
): string | null {
  if (!outcome.error) return null;
  return (
    `warning: ${id} is ${want === "closed" ? "closed" : "open"} locally but issue #${outcome.link?.number} was NOT ` +
    `${want === "closed" ? "closed" : "reopened"}: ${outcome.error}\n` +
    `the two trackers are now out of sync; retry 'ob ${want === "closed" ? "close" : "reopen"} ${id}' or fix the issue by hand`
  );
}

/** `--dry-run`: preview BOTH moves, write nothing. The transition was already validated by the caller. */
async function previewBoth(ctx: Ctx, id: string, want: "closed" | "open"): Promise<void> {
  const outcome = await syncIssueState(ctx.store ?? ctx.db, id, want, { skip: !!ctx.flags["no-github"], dryRun: true });
  print(renderIssuePreview(id, outcome, want, ctx.mode));
}

/** `--dry-run`'s preview of both moves, from the outcome alone (353). Pure, and shared with the client. */
export function renderIssuePreview(
  id: string,
  outcome: Awaited<ReturnType<typeof syncIssueState>>,
  want: "closed" | "open",
  mode: Mode,
): string {
  const verb = want === "closed" ? "close" : "reopen";
  if (mode === "json") {
    return JSON.stringify({
      id,
      dry_run: true,
      would: verb,
      issue: outcome.link ? outcome.link.number : null,
      issue_url: outcome.link ? outcome.link.url : null,
      skipped: outcome.skipped,
    });
  }
  if (mode === "quiet") return id;
  const head = `${id}  would ${verb} ob ${id}  (--dry-run, nothing written)`;
  return outcome.link ? `${head}\n  ${issueLine(outcome, want)}` : head;
}

export function issueLine(outcome: Awaited<ReturnType<typeof syncIssueState>>, want: "closed" | "open"): string {
  const link = outcome.link!;
  const verb = want === "closed" ? "closed" : "reopened";
  if (outcome.error) return `issue #${link.number} NOT ${verb} (${outcome.error})  ${link.url}`;
  switch (outcome.skipped) {
    case "flag":
      return `issue #${link.number} left alone (--no-github)  ${link.url}`;
    case "dry-run":
      return `would ${want === "closed" ? "close" : "reopen"} issue #${link.number}  ${link.url}  (--dry-run, nothing sent)`;
    case "foreign-repo":
      return `issue #${link.number} is on ${link.repo}, not the tracker repo, left alone  ${link.url}`;
    default:
      return outcome.change?.already
        ? `issue #${link.number} was already ${verb}  ${link.url}`
        : `${verb} issue #${link.number}  ${link.url}`;
  }
}

export async function cmdClose(ctx: Ctx): Promise<void> {
  const id = await itemArg(ctx, ctx.args[0]);
  if (!id) throw new UsageError("close requires an <id>");
  if (ctx.flags["dry-run"]) {
    await assertTransition(ctx.store ?? ctx.db, id, "done");
    await previewBoth(ctx, id, "closed");
    return;
  }
  await closeLocally(ctx, id);
}

/**
 * The whole local close (OB-1928): `ob close`, `ob state <id> done` and `ob triage reject` all land here.
 * The validated close and the spinoff land (closeAndLand), then the GitHub mirror and the thread settle.
 */
export async function closeLocally(ctx: Ctx, id: string): Promise<void> {
  const store = ctx.store ?? ctx.db;
  const r = await closeAndLand(store, id, decisionOptsOf(ctx), {}, localMergedPrUrl(store));
  await emitWithIssue(ctx, id, "closed");
  reportSpinoffsLanded(ctx, id, r);
}

/**
 * The close is the land (1589): the ticket's own building / handed-off rows read `landed` now, not after a
 * reconcile. Best effort and loud: the close stands whatever happens here.
 */
function reportSpinoffsLanded(ctx: Ctx, id: string, r: CloseAndLandResult): void {
  if (r.error) warn(`spinoff: ${id} closed, but its spinoff rows were not marked landed: ${r.error} (ob spinoff reconcile)`);
  if (r.landed.length > 0 && ctx.mode === "human") print(`marked landed: ${r.landed.join(", ")}`);
  // OB-1826: a closed spike merged nothing, so it is reported as ended, never as landed.
  if (r.ended.length > 0 && ctx.mode === "human") print(`spike closed (not a landing): ${r.ended.join(", ")}`);
}

export async function cmdReopen(ctx: Ctx): Promise<void> {
  const id = await itemArg(ctx, ctx.args[0]);
  if (!id) throw new UsageError("reopen requires an <id>");
  if (ctx.flags["dry-run"]) {
    await assertReopen(ctx.store ?? ctx.db, id);
    await previewBoth(ctx, id, "open");
    return;
  }
  await reopenItem(ctx.store ?? ctx.db, id, decisionOptsOf(ctx));
  await emitWithIssue(ctx, id, "open");
}

export async function cmdBlock(ctx: Ctx): Promise<void> {
  const id = await itemArg(ctx, ctx.args[0]);
  if (!id) throw new UsageError("block requires an <id>");
  // --note is the same words as --reason (1515): either names why, and the transition records it.
  const reason = ctx.flags.reason ?? ctx.flags.note;
  if (!reason) throw new UsageError("block requires --reason <r> (or --note <r>)");
  await blockItem(ctx.store ?? ctx.db, id, reason, ctx.flags.owner ?? null, decisionOptsOf(ctx, { note: ctx.flags.note ?? reason }));
  await emitItem(ctx, id);
}

export async function cmdUnblock(ctx: Ctx): Promise<void> {
  const id = await itemArg(ctx, ctx.args[0]);
  if (!id) throw new UsageError("unblock requires an <id>");
  await unblockItem(ctx.store ?? ctx.db, id, decisionOptsOf(ctx));
  await emitItem(ctx, id);
}

export async function cmdState(ctx: Ctx): Promise<void> {
  const id = await itemArg(ctx, ctx.args[0]);
  const to = ctx.args[1];
  if (!id || !to) throw new UsageError("state requires <id> <state>");
  // `state <id> done` is the SAME landing as `close <id>`, so it mirrors and lands the same way (77,
  // OB-1928). Leaving it unmirrored made it a second, undocumented door to the half-close.
  if (to === "done") {
    if (ctx.flags["dry-run"]) {
      await assertTransition(ctx.store ?? ctx.db, id, "done");
      await previewBoth(ctx, id, "closed");
      return;
    }
    await closeLocally(ctx, id);
    return;
  }
  // OB-1928: every other target goes through the one move function the API's `/state` `set` also uses.
  const moved = await moveItem(ctx.store ?? ctx.db, id, to, {
    reason: ctx.flags.reason ?? null,
    owner: ctx.flags.owner ?? null,
    decision: decisionOptsOf(ctx),
  });
  // A reopen through `state` owes the same mirror `ob reopen` runs.
  if (moved === "reopened") {
    await emitWithIssue(ctx, id, "open");
    return;
  }
  await emitItem(ctx, id);
}
