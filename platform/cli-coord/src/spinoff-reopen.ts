import { AppError } from "../../../apps/cli/src/errors.ts";
import type { SpinoffRow } from "./commands/spinoff.ts";
import { spinoffStatusWord } from "./spinoff-vocab.ts";

// `ob spinoff reopen <row> --note '<why>'` (OB-2180): put a row that was marked landed by mistake back to
// building. Row 2022 (OB-2173) was landed by a reconcile while its PR was still open, and nothing could move
// it back, so its builder's handoff refused ("already landed") until the architect merged by hand.
//
// The refusals are decided here, the IO is injected, so the local command and the API client cannot drift
// (the shape `sendback` uses). The git read, "is this ticket's work already on main?", is the caller's: it
// runs on the machine with the checkout, never on the API host.

const LANDED_STORED = "merged"; // the stored word for `landed`; kept local so this module imports only types

/** What a reopen performs. */
export interface ReopenDeps {
  /** landed -> building, with the note on the ticket's trail. */
  flip(note: string): Promise<SpinoffRow>;
  /** Is the row's ticket done? Reconcile lands any building row of a done ticket, so a reopen would not last. */
  ticketDone(row: SpinoffRow): Promise<boolean>;
  /** Why reconcile's git signals would land the row again (`rowRelandReason`), or null. */
  relandReason(row: SpinoffRow): string | null;
}

export interface ReopenResult {
  row: SpinoffRow;
}

/**
 * The refusal a row that cannot be reopened earns, by name; null when it can. A row reconcile would land again
 * is refused: reopening it would last only until the next `ob close` or reconcile anywhere.
 */
async function reopenRefusal(row: SpinoffRow, deps: ReopenDeps): Promise<string | null> {
  const who = `spinoff #${row.id} (${row.ticket_ref})`;
  if (row.status !== LANDED_STORED) {
    return `${who} is ${spinoffStatusWord(row.status)}, not landed: only a landed row can be reopened`;
  }
  if (await deps.ticketDone(row)) {
    return `${who}: ${row.ticket_ref} is done, and reconcile lands every row of a done ticket. Reopen the ticket first (ob reopen ${row.ticket_ref} --note '<why>')`;
  }
  const reason = deps.relandReason(row);
  if (reason) return `${who} ${reason}: its work landed, so it stays landed`;
  return null;
}

export async function reopenSpinoff(row: SpinoffRow, deps: ReopenDeps, note: string): Promise<ReopenResult> {
  const text = note.trim();
  if (!text) throw new AppError("spinoff reopen needs --note '<why>': the ticket's trail records why the land was undone");
  const refusal = await reopenRefusal(row, deps);
  if (refusal) throw new AppError(refusal);
  return { row: await deps.flip(text) };
}

export function renderReopen(r: ReopenResult, json: boolean): string {
  if (json) return JSON.stringify({ id: r.row.id, ticket: r.row.ticket_ref, status: spinoffStatusWord(r.row.status) });
  return [
    `reopened: ${r.row.ticket_ref} (row ${r.row.id}) is building again`,
    `  the builder's next 'ob agent register --id ${r.row.agent_id ?? r.row.branch} ...' brings its agent row and ticket lease back`,
  ].join("\n");
}
