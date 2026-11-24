// OB-1825: measure twice, enforced. The architect scores a ticket, a cheap model scores the launch text blind,
// and `ob spinoff check` records the verdict on the Decisions trail. `refuseUncheckedDispatch` then refuses a
// new dispatch with no `## Drilled` section (OB-1980), no `## Done when` item or no `go` for the item's current body, unless `--no-check '<why>'`
// says why not. ob never calls a model: the architect runs the checker and hands both JSONs over afterwards, so
// nothing here can leak one side's score to the other.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DECISION_SOURCE, DECISION_TYPE, recordDecision } from "../../../apps/cli/src/decisions.ts";
import { AppError, UsageError } from "../../../apps/cli/src/errors.ts";
import { eventsForItemFor, parsePayload } from "../../../apps/cli/src/events.ts";
import { getItem, getLinks, getTags } from "../../../apps/cli/src/items.ts";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { IN_FLIGHT } from "./spinoff-vocab.ts";
import { refuseAmbiguousDispatchRef, spinoffRowsServingItem, ticketItemIdFor } from "./spinoff-item.ts";
import { SPIKE_LINK, isSpikeTagged, sectionItems, spikeGateMissing } from "./spinoff-spike.ts";

const CHECK_CRITERIA = ["problem", "scope", "done", "design", "proof", "unknowns", "size"] as const;
type CheckCriterion = (typeof CHECK_CRITERIA)[number];
/**
 * OB-2131: a new check is `go` or `no-go`, and only an unresolved checker question makes `no-go`. The scores,
 * the gap, a 0 and disjoint file lists are `read:` lines to read, not refusals: the OB-2132 audit found they did
 * not separate planning misses from first-time lands. `investigate` and `read the gap` stay readable because the
 * gate reads the stored word, and an old record carrying one still refuses until the body is checked again.
 */
type CheckVerdict = "go" | "investigate" | "read the gap" | "no-go";

/** Used only for the advisories now (OB-2131). */
const MIN_PCT = 70;
const MAX_GAP = 15;
/** The trail's `from` word for a check, and the `to` a `--no-check` override records. */
const CHECK_FROM = "check";
const NO_CHECK_TO = "no-check";
/** How far back the gate reads an item's trail. A ticket is rechecked at most a handful of times. */
const TRAIL_LIMIT = 200;

const ROUTES = "drill down, run a spike (a ticket tagged spike, no score needed), split the ticket, or dispatch with --no-check '<why>' (what was tried and why waiting would not help)";

interface CheckSide {
  files: string[];
  questions: string[];
  scores: Record<CheckCriterion, number>;
  low?: Record<string, { why?: unknown; raises?: unknown }>;
  [key: string]: unknown;
}

/** OB-2131: how one checker question was settled. `edit` changed the ticket body; `dismiss` says why none is needed. */
export interface CheckResolution {
  q: number;
  how: "edit" | "dismiss";
  note: string;
}

export interface CheckResult {
  ticket: string;
  verdict: CheckVerdict;
  reasons: string[];
  /** OB-2131: the advisories, printed as `read:` lines and stored; they never refuse. */
  read: string[];
  resolutions: CheckResolution[];
  /** The checker's questions no resolution covers, by number, with their text. */
  unresolved: Array<{ q: number; text: string }>;
  architect_pct: number;
  checker_pct: number;
  gap: number;
  low_criteria: string[];
  shared_files: string[];
  body_sha256: string;
  questions_resolved: boolean;
}

/**
 * The verdict rules (OB-2131). Pure. Only an unresolved checker question refuses; everything else the old rules
 * measured comes back in `read`, to be printed and stored. Takes percentages because real scores never land on a
 * gap of 15 or 16.
 */
export function checkVerdict(input: {
  architectPct: number;
  checkerPct: number;
  /** Each criterion that scored 0, as `<side> <criterion>`. */
  zeros: string[];
  sharedFiles: number;
  questions: string[];
  /** The 1-based indexes of the questions a resolution covers. */
  resolved: number[];
}): { verdict: CheckVerdict; reasons: string[]; read: string[]; unresolved: Array<{ q: number; text: string }> } {
  const { architectPct, checkerPct, zeros, sharedFiles, questions, resolved } = input;
  const read: string[] = [];
  if (architectPct < MIN_PCT) read.push(`architect scored ${architectPct}, under ${MIN_PCT}`);
  if (checkerPct < MIN_PCT) read.push(`checker scored ${checkerPct}, under ${MIN_PCT}`);
  if (zeros.length > 0) read.push(`a criterion scored 0 (${zeros.join(", ")})`);
  const gap = Math.abs(architectPct - checkerPct);
  if (gap > MAX_GAP) read.push(`scores are ${gap} apart, over ${MAX_GAP}`);
  if (sharedFiles === 0) read.push("the two file lists share no path");
  const done = new Set(resolved);
  const unresolved = questions.map((text, i) => ({ q: i + 1, text })).filter((x) => !done.has(x.q));
  if (unresolved.length === 0) return { verdict: "go", reasons: [], read, unresolved };
  const reasons = [
    `checker question${unresolved.length === 1 ? "" : "s"} ${unresolved.map((x) => x.q).join(", ")} not resolved: ` +
      `edit the ticket to answer each, or dismiss it with a reason, then pass --resolutions (one entry per checker question)`,
  ];
  return { verdict: "no-go", reasons, read, unresolved };
}

const RESOLUTION_HOWS = ["edit", "dismiss"] as const;
const RESOLUTIONS_SHAPE = '[{"q": <1-based question number>, "how": "edit"|"dismiss", "note": "<what changed, or why none is needed>"}]';

/**
 * `--resolutions`, validated against the checker's questions (OB-2131): exactly one entry per question, in
 * order. Absent is `[]`. A refusal names the fault and records nothing.
 */
function parseResolutions(raw: unknown, questionCount: number): CheckResolution[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new UsageError(`--resolutions must be a JSON list: ${RESOLUTIONS_SHAPE}. Nothing was recorded`);
  const out: CheckResolution[] = [];
  raw.forEach((entry: unknown, i: number) => {
    const at = `--resolutions entry ${i + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new UsageError(`${at} must be an object: ${RESOLUTIONS_SHAPE}. Nothing was recorded`);
    const e = entry as Record<string, unknown>;
    if (typeof e.q === "number" && e.q > questionCount) {
      throw new UsageError(`${at} is an extra index: q ${e.q}, but the checker asked ${questionCount} question${questionCount === 1 ? "" : "s"}. Nothing was recorded`);
    }
    if (e.q !== i + 1) {
      throw new UsageError(
        `${at} has q ${JSON.stringify(e.q)} where q ${i + 1} belongs: question ${i + 1} is missing or out of order (one entry per checker question, in order). Nothing was recorded`,
      );
    }
    if (!RESOLUTION_HOWS.includes(e.how as (typeof RESOLUTION_HOWS)[number])) {
      throw new UsageError(`${at} has how ${JSON.stringify(e.how)}: it must be "edit" (the ticket was changed to answer it) or "dismiss" (no change needed, why in note). Nothing was recorded`);
    }
    if (typeof e.note !== "string" || e.note.trim() === "") throw new UsageError(`${at} has an empty note: say what changed, or why no change is needed. Nothing was recorded`);
    out.push({ q: e.q, how: e.how as CheckResolution["how"], note: e.note });
  });
  if (out.length < questionCount) {
    const missing = Array.from({ length: questionCount - out.length }, (_, k) => out.length + k + 1);
    throw new UsageError(`--resolutions is missing question${missing.length === 1 ? "" : "s"} ${missing.join(", ")}: one entry per checker question. Nothing was recorded`);
  }
  return out;
}

/** A check input: inline JSON when the value starts with `{` (or `[`, for `--resolutions`), else a file to read. */
export function readCheckInput(name: string, value: string): unknown {
  const inline = /^[{[]/.test(value.trimStart());
  let text = value;
  if (!inline) {
    try {
      text = readFileSync(value, "utf8");
    } catch (e) {
      throw new UsageError(`--${name}: cannot read '${value}': ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`--${name}: not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function asCheckSide(name: string, raw: unknown): CheckSide {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError(`--${name} must be a JSON object`);
  const side = raw as CheckSide;
  if (!Array.isArray(side.files) || side.files.some((f) => typeof f !== "string")) {
    throw new UsageError(`--${name} needs "files", a list of paths`);
  }
  if (side.questions !== undefined && !Array.isArray(side.questions)) throw new UsageError(`--${name} "questions" must be a list`);
  const scores = side.scores as Record<string, unknown> | undefined;
  for (const c of CHECK_CRITERIA) {
    const n = scores?.[c];
    if (n !== 0 && n !== 1 && n !== 2) throw new UsageError(`--${name} needs scores.${c} as 0, 1 or 2`);
  }
  return side;
}

/** A criterion the architect scored under 2 owes a why-low and a raises-it line (the skill's rule). */
function refuseUnexplainedLow(architect: CheckSide): void {
  const missing = CHECK_CRITERIA.filter((c) => {
    if (architect.scores[c] >= 2) return false;
    const line = architect.low?.[c];
    return !(typeof line?.why === "string" && line.why.trim() && typeof line?.raises === "string" && line.raises.trim());
  });
  if (missing.length > 0) {
    throw new UsageError(
      `architect scores under 2 need a line saying why and what raises it: add low: {"<criterion>": {"why": "...", "raises": "..."}} for ${missing.join(", ")}. Nothing was recorded`,
    );
  }
}

const percent = (side: CheckSide): number =>
  Math.round((CHECK_CRITERIA.reduce((sum, c) => sum + side.scores[c], 0) / (CHECK_CRITERIA.length * 2)) * 100);

/** A path as a model writes it: `./a.ts`, `` `a.ts` `` and `a.ts:12` are all `a.ts`. Pure. */
function normalizePath(path: string): string {
  return path.trim().replace(/^`|`$/g, "").replace(/^\.\//, "").replace(/:\d+(?::\d+)?$/, "");
}

function bodyHash(body: string | null | undefined): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

/** The item behind a ref, or a refusal by name: a check and a gate both need a body to read. */
async function requireItem(store: Store, ref: string): Promise<{ id: string; body: string | null }> {
  const id = await ticketItemIdFor(store, ref);
  const item = id ? await getItem(store, id) : null;
  if (!item) throw new AppError(`no ob item for '${ref}': the measure-twice check reads an item's body. Nothing was recorded or queued`);
  return { id: item.id, body: item.body };
}

/** Compute a check's verdict and put it on the ticket's Decisions trail. The server's half of `ob spinoff check`. */
export async function recordSpinoffCheck(
  db: Database | Store,
  ref: string,
  inputs: { architect: unknown; checker: unknown; resolutions?: unknown },
  opts: { actor?: string | null } = {},
): Promise<CheckResult> {
  const store = asStore(db);
  const architect = asCheckSide("architect", inputs.architect);
  const checker = asCheckSide("checker", inputs.checker);
  refuseUnexplainedLow(architect);
  const questions = (checker.questions ?? []).map(String);
  const resolutions = parseResolutions(inputs.resolutions, questions.length);
  await refuseAmbiguousDispatchRef(store, ref);
  const item = await requireItem(store, ref);

  const architectPct = percent(architect);
  const checkerPct = percent(checker);
  const checkerFiles = new Set(checker.files.map(normalizePath));
  const sharedFiles = [...new Set(architect.files.map(normalizePath))].filter((f) => f && checkerFiles.has(f));
  const zeros = (["architect", "checker"] as const).flatMap((side) =>
    CHECK_CRITERIA.filter((c) => (side === "architect" ? architect : checker).scores[c] === 0).map((c) => `${side} ${c}`),
  );
  const { verdict, reasons, read, unresolved } = checkVerdict({
    architectPct,
    checkerPct,
    zeros,
    sharedFiles: sharedFiles.length,
    questions,
    resolved: resolutions.map((r) => r.q),
  });
  const lowCriteria = CHECK_CRITERIA.filter((c) => architect.scores[c] < 2 || checker.scores[c] < 2).map(
    (c) => `${c} (architect ${architect.scores[c]}, checker ${checker.scores[c]})`,
  );
  const result: CheckResult = {
    ticket: ref,
    verdict,
    reasons,
    read,
    resolutions,
    unresolved,
    architect_pct: architectPct,
    checker_pct: checkerPct,
    gap: Math.abs(architectPct - checkerPct),
    low_criteria: lowCriteria,
    shared_files: sharedFiles,
    body_sha256: bodyHash(item.body),
    // Kept for old readers: true exactly when every checker question has a resolution.
    questions_resolved: unresolved.length === 0,
  };
  const { ticket: _ticket, architect_pct, ...facts } = result;
  await recordDecision(store, item.id, CHECK_FROM, verdict, {
    actor: opts.actor,
    // Scores and reasons stay in the payload, off the note: `ob show` prints notes, and the checker on a
    // recheck may `ob show` this ticket, so a score in a note would end its blindness.
    // The checker's sheet is stored as received; the architect's answers live in `resolutions` beside it (OB-2131).
    // The payload keeps its stored names (OB-2256): the architect's sheet and score are `planner` and `planner_pct`.
    extra: { ...facts, [STORED_ARCHITECT_PCT]: architect_pct, [STORED_ARCHITECT]: architect, checker },
  });
  return result;
}

/** What `ob spinoff check` prints. Pure. */
export function renderCheckResult(r: CheckResult): string[] {
  const lines = [`${r.verdict}: ${r.ticket} · architect ${r.architect_pct} · checker ${r.checker_pct} · gap ${r.gap} · body ${r.body_sha256.slice(0, 8)}`];
  for (const reason of r.reasons) lines.push(`  ${reason}`);
  for (const advisory of r.read ?? []) lines.push(`  read: ${advisory}`);
  for (const u of r.unresolved ?? []) lines.push(`  question ${u.q}: ${u.text}`);
  if (r.verdict === "go") lines.push(`  recorded; 'ob spinoff ${r.ticket}' will launch while the body stays as it is (an 'ob note' needs a new check)`);
  else lines.push(...nextSteps(r.verdict, r.low_criteria));
  return lines;
}

function nextSteps(verdict: CheckVerdict, low: string[]): string[] {
  if (verdict === "investigate") {
    return [`  low criteria: ${low.join(", ") || "none"}`, `  more planning is owed: ${ROUTES}`];
  }
  if (verdict === "read the gap") {
    return ["  architect high and checker low: the plan is in your head, not the ticket. Checker high and architect low: you know something unwritten. Change the ticket and check again"];
  }
  return ["  fix what is named, then check again"];
}

/** The items of a ticket's `## Done when` section. Pure. An empty bullet or a sub-heading is not an item. */
export function doneWhenItems(body: string | null | undefined): string[] {
  return sectionItems(body, "Done when");
}

/**
 * A LIVE spinoff row (pending, launching, launched, ready-for-gate) already serving this ref or its item: a
 * sendback or a double dispatch, not a new build. A failed or merged row does not exempt (OB-1924): the ticket
 * that most needs a fresh check is the one whose last build failed.
 */
async function hasSpinoffRow(store: Store, item: { id: string; body?: string | null }): Promise<boolean> {
  const t = store.t.spinoff;
  const columns = { id: t.id, ticket_ref: t.ticket_ref, item_id: t.item_id, status: t.status };
  const all = (await store.q.select(columns).from(t)) as Array<{ id: number; ticket_ref: string; item_id: string | null; status: string }>;
  const rows = all.filter((r) => IN_FLIGHT.has(r.status));
  return (await spinoffRowsServingItem(store, rows, item)).rows.length > 0;
}

/** Empty `--no-check` reasons are refused before anything else happens, on every route. */
function refuseEmptyNoCheck(reason: string | null | undefined): void {
  if (reason !== undefined && reason !== null && reason.trim() === "") {
    throw new UsageError("--no-check needs a reason: say what was tried and why waiting would not help. Nothing was queued");
  }
}

interface RecordedCheck {
  to: string;
  note?: string;
  body_sha256?: string;
  reasons?: string[];
  low_criteria?: string[];
}

/**
 * The gate. Called at the two enqueue call sites (the local `spinoff`/`spinoff queue` and the API's), never
 * inside `enqueueSpinoff`, and on the host that holds the store, so an old client cannot skip it. Throws
 * before any row exists. Returning means dispatch; a returned string is a warning the caller must show its human.
 */
export async function refuseUncheckedDispatch(
  db: Database | Store,
  ref: string,
  opts: { noCheck?: string | null; actor?: string | null } = {},
): Promise<string | null> {
  const store = asStore(db);
  refuseEmptyNoCheck(opts.noCheck);
  const itemId = await ticketItemIdFor(store, ref);
  const item = itemId ? await getItem(store, itemId) : null;

  if (opts.noCheck) {
    if (!item) return `--no-check reason not on a trail: '${ref}' has no ob item to hold it`;
    await recordDecision(store, item.id, CHECK_FROM, NO_CHECK_TO, { actor: opts.actor, note: opts.noCheck });
    return null;
  }
  // OB-1834: no item is refused before the row exemption, so a junk word that already has a row
  // (e.g. "status") cannot be re-dispatched into a builder.
  if (!item) {
    throw new AppError(
      `not dispatched: '${ref}' resolves to no single ob item, so there is no body to check. Nothing was queued. ` +
        `File it with 'ob add' (a GitHub issue: 'ob issue link'), or override with 'ob spinoff ${ref} --no-check '<why>''`,
    );
  }
  if (await hasSpinoffRow(store, item)) return null;

  const fix = (what: string): AppError =>
    new AppError(
      `not dispatched: ${what}. Nothing was queued. Run "Measure twice" in skills/ob-architect, record it with ` +
        `'ob spinoff check ${ref} --architect <json> --checker <json> [--resolutions <json>]', then dispatch again; ` +
        `or override with 'ob spinoff ${ref} --no-check '<why>''`,
    );
  // OB-1826: a spike investigates what reading cannot settle, so asking it for confidence first would be
  // circular. It needs its shape instead: the three sections and the ticket it serves. Never a score.
  if (isSpikeTagged(await getTags(store, item.id))) {
    const hasParent = (await getLinks(store, item.id)).some((l) => l.rel_type === SPIKE_LINK && l.direction === "out");
    const missing = spikeGateMissing(item.body, hasParent);
    if (missing.length > 0) {
      throw new AppError(
        `not dispatched: ${ref} is tagged spike and is missing ${missing.join("; ")}. Nothing was queued. ` +
          `A spike needs '## Questions', '## Box' and '## Done when', and a ${SPIKE_LINK} link to the ticket it serves ` +
          `(see "Spikes" in skills/ob-architect); it takes no measure-twice score. Or override with 'ob spinoff ${ref} --no-check '<why>''`,
      );
    }
    return null;
  }
  // OB-1980: a ticket nobody drilled into is refused like one with no Done when. One refusal names every
  // missing section, so the architect fixes both in one pass.
  const noDrilled = sectionItems(item.body, "Drilled").length === 0;
  const noDoneWhen = doneWhenItems(item.body).length === 0;
  if (noDrilled || noDoneWhen) {
    const lacking = [noDrilled && "'## Drilled' section", noDoneWhen && "'## Done when' item"].filter(Boolean).join(" and no ");
    throw fix(
      `${ref} has no ${lacking}. Drilled records what you found out before dispatching; Done when is yes/no items someone else could check ` +
        `(see "Drill down before you dispatch" and "Every dispatched ticket has ## Done when" in skills/ob-architect)`,
    );
  }

  const hash = bodyHash(item.body);
  const events = await eventsForItemFor(store, item.id, TRAIL_LIMIT, { source: DECISION_SOURCE, type: DECISION_TYPE });
  const checks = events
    .map((e) => parsePayload<RecordedCheck & { from?: string }>(e))
    .filter((p) => p.from === CHECK_FROM && p.to !== NO_CHECK_TO);
  // The newest check on this body decides: a `go` that a later recheck overturned does not stand.
  const current = checks.find((c) => c.body_sha256 === hash);
  if (current?.to === "go") return null;
  if (current) {
    const verdict = current.to as CheckVerdict;
    const detail = [...(current.reasons ?? []), ...nextSteps(verdict, current.low_criteria ?? []).map((l) => l.trim())].join("; ");
    throw fix(`${ref}'s check on this body says '${verdict}': ${detail}`);
  }
  throw fix(checks.length > 0 ? `${ref}'s last check was on an older body; the ticket changed since, so it needs a new one` : `${ref} has no measure-twice check`);
}

/**
 * The stored names of the architect's sheet and score in a recorded check's payload (OB-2256). The role was the
 * planner when the payload shape was set; storage names stay, so the Decisions trail keeps one shape across the
 * rename. Only the store call and {@link plannedFilesOf} use them; everything a person reads says architect.
 */
const STORED_ARCHITECT = "planner";
const STORED_ARCHITECT_PCT = "planner_pct";

/** A sheet's file entry that names one file: a directory (`apps/`) or a glob (`*.ts`) is not one. Pure. */
function isPlannedFile(path: string): boolean {
  return path !== "" && !path.endsWith("/") && !path.includes("*");
}

/** One side of a recorded check, as the payload stores it. */
type RecordedSide = { files?: unknown };

/** A recorded check's payload: the architect's sheet is stored under `planner` ({@link STORED_ARCHITECT}). */
type StoredCheckSheets = { planner?: RecordedSide; checker?: RecordedSide };

/** The planned files of a recorded check: both sheets' `files`, normalised, directories and globs left out. Pure. */
export function plannedFilesOf(check: StoredCheckSheets): string[] {
  return declaredFilesOf(check).filter(isPlannedFile);
}

/** The sheets of the ticket's newest `go` check, on any body; `null` when it has none (or no item to hold one). */
async function newestGoCheck(db: Database | Store, ref: string, itemId?: string | null): Promise<StoredCheckSheets | null> {
  const store = asStore(db);
  const id = itemId ?? (await ticketItemIdFor(store, ref));
  if (!id) return null;
  const events = await eventsForItemFor(store, id, TRAIL_LIMIT, { source: DECISION_SOURCE, type: DECISION_TYPE });
  const go = events
    .map((e) => parsePayload<{ from?: string; to?: string } & StoredCheckSheets>(e))
    .find((p) => p.from === CHECK_FROM && p.to === "go");
  return go ?? null;
}

/**
 * OB-2131: the files the ticket's newest `go` check planned, on any body, for the `files:` line of `ob spinoff
 * gateable` and `show`. `null` when the ticket has no `go` check (or no item to hold one).
 */
export async function plannedFilesFor(db: Database | Store, ref: string, itemId?: string | null): Promise<string[] | null> {
  const go = await newestGoCheck(db, ref, itemId);
  return go ? plannedFilesOf(go) : null;
}

/**
 * OS-47: the declared files of a recorded check, for the overlap check before a parallel dispatch: both sheets'
 * `files`, normalised, keeping the directory (`apps/`, `apps/**`) and glob (`*.ts`) entries {@link plannedFilesOf}
 * leaves out, since a directory a builder declared is a claim on every file under it. Pure.
 */
export function declaredFilesOf(check: StoredCheckSheets): string[] {
  const out = new Set<string>();
  for (const side of [check[STORED_ARCHITECT], check.checker]) {
    const files = Array.isArray(side?.files) ? side.files : [];
    for (const f of files) {
      if (typeof f !== "string") continue;
      const p = normalizePath(f);
      if (p !== "") out.add(p);
    }
  }
  return [...out].sort();
}

/** OS-47: {@link plannedFilesFor}, keeping directory and glob entries. `null` when the ticket has no `go` check. */
export async function declaredFilesFor(db: Database | Store, ref: string, itemId?: string | null): Promise<string[] | null> {
  const go = await newestGoCheck(db, ref, itemId);
  return go ? declaredFilesOf(go) : null;
}
