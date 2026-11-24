import { AppError } from "../../../apps/cli/src/errors.ts";
import { hashText } from "../../../apps/cli/src/t3/dispatch.ts";
import type { SpinoffRow } from "./commands/spinoff.ts";
import { spinoffStatusWord } from "./spinoff-vocab.ts";

const HANDED_OFF_STORED = "ready-for-gate"; // READY_FOR_GATE in commands/spinoff.ts, kept local so this module imports only types from it

// `ob spinoff sendback <ref> --note '<what to fix>'` (OB-1805): the architect's half of a send-back.
//
// Before it, an architect that found a failing gate or UI review on a handed-off PR just messaged the builder
// by hand. The row stayed `handed-off`, so `ob spinoff gateable` kept listing it as landable while the
// builder reworked it, and the builder's second `ob spinoff handoff` could not tell the architect anything
// (the note was keyed on the State line, which a fix leaves unchanged; now it is keyed on the head SHA).
//
// The sequence is shared by the local command and the API client, exactly like `abandon`: one decision
// order, with the IO injected, so the two cannot drift.

/** The refusal a row that cannot be sent back earns, by name; null when it can. Pure. */
function sendBackRefusal(row: Pick<SpinoffRow, "id" | "ticket_ref" | "status" | "launcher" | "t3_thread_id">): string | null {
  const who = `spinoff #${row.id} (${row.ticket_ref})`;
  if (row.status !== HANDED_OFF_STORED) {
    return `${who} is ${spinoffStatusWord(row.status)}, not handed-off: only a handed-off row can be sent back`;
  }
  if (!row.t3_thread_id || row.launcher !== "t3") {
    return `${who} has no builder thread to tell (launcher ${row.launcher ?? "unknown"}, no T3 thread recorded): message the builder yourself and re-run the handoff`;
  }
  return null;
}

/** The message the builder's thread receives. Pure. */
function sendBackMessage(row: Pick<SpinoffRow, "ticket_ref" | "branch">, note: string): string {
  return [
    `sent back: ${row.ticket_ref} (${row.branch})`,
    "",
    "The sentinel gated your PR and is sending it back. Fix this:",
    note.trim(),
    "",
    "Your row is building again and is off the gateable list. When the fix is committed and pushed to the",
    "same PR, re-run the local-only checks, register the NEW gate facts (`ob agent register --id <branch> --status",
    "readying --note '<gate facts; review line>'`: the handoff reads that note, and it now holds this send-back) and run",
    "`ob spinoff handoff` again with the PR URL. A new commit sends the gating thread a new note; a handoff on the same",
    "commit sends nothing new.",
  ].join("\n");
}

/** The note's retry key: row + branch head + the note text, so a lost response retries safely and a second, different send-back is a second message. Pure. */
function sendBackRequestId(rowId: number, headSha: string | null, note: string): string {
  return `ob-sendback-${rowId}-${headSha ?? "no-head"}-${hashText(note)}`;
}

/** The IO a send-back performs. */
export interface SendBackDeps {
  /** handed-off -> building, with the note on the ticket's trail. */
  flip(): Promise<void>;
  /** building -> handed-off again: the undo for a send that failed. */
  restore(): Promise<void>;
  /** Deliver the message into the builder's thread. */
  send(threadId: string, message: string, clientRequestId: string): Promise<void>;
  /** Head SHA of the row's branch, or null. */
  headSha(row: SpinoffRow): string | null;
}

interface SendBackResult {
  id: number;
  ticket: string;
  branch: string;
  threadId: string;
  status: string;
  note: string;
}

/**
 * Send one handed-off row back to its builder. Refuses by name BEFORE anything changes; flips the row, then
 * posts the note; if the post fails the row is put back to handed-off and the failure is the error, so a
 * row never reads "building" with a builder that was never told.
 */
export async function sendBackSpinoff(row: SpinoffRow, deps: SendBackDeps, note: string): Promise<SendBackResult> {
  const text = note.trim();
  if (!text) throw new AppError(`spinoff sendback needs --note '<what to fix>': the builder only learns what to fix from it`);
  const refusal = sendBackRefusal(row);
  if (refusal) throw new AppError(refusal);
  const threadId = row.t3_thread_id as string;
  try {
    await deps.flip();
  } catch (err) {
    // An API client can lose the response after the server committed the change: say the row is unknown, not unchanged.
    throw new AppError(
      `could not confirm the send-back of ${row.ticket_ref}: ${(err as Error).message}. The row may already read building and the builder was NOT told: ` +
        `check 'ob spinoff show ${row.ticket_ref}', then send the same command again if it still reads handed-off, or message the builder yourself if it reads building.`,
    );
  }
  try {
    await deps.send(threadId, sendBackMessage(row, text), sendBackRequestId(row.id, deps.headSha(row), text));
  } catch (err) {
    let restored = true;
    try {
      await deps.restore();
    } catch {
      restored = false;
    }
    throw new AppError(
      `could not tell the builder thread ${threadId}: ${(err as Error).message}. ` +
        (restored ? `The row is still handed-off; nothing was changed.` : `The row was moved to building and could NOT be put back: run 'ob spinoff handoff ${row.ticket_ref} --no-note' to restore it.`),
    );
  }
  return { id: row.id, ticket: row.ticket_ref, branch: row.branch, threadId, status: spinoffStatusWord("launched"), note: text };
}

export function renderSendBack(r: SendBackResult, json: boolean): string {
  if (json) return JSON.stringify(r, null, 2);
  return [
    `sent back #${r.id} (${r.ticket}): now ${r.status}, off \`ob spinoff gateable\` until handed off again`,
    `  builder:   note queued for ${r.threadId} (T3 does not report a dropped repeat); it re-runs \`ob spinoff handoff\` when the fix is pushed`,
  ].join("\n");
}
