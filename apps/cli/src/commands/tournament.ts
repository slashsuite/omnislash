// OB-2271: `ob tournament`. The subcommand tree, the flags and every printed line live HERE, once; the local
// command and the API client differ only in the backend they pass (the store, or HTTP), so the two cannot drift
// into two formats or two sets of exit codes. The rules (the match file contract, the refusals) are in
// ../tournament.ts.
import { readFileSync } from "node:fs";
import type { Ctx, Flags } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print, type Mode } from "../output.ts";
import {
  addTournament,
  listTournaments,
  parseTournamentId,
  pickTournament,
  recordMatch,
  renderTournamentList,
  renderTournamentShow,
  setCandidate,
  showTournament,
  type CandidateInput,
  type Tournament,
  type TournamentCandidate,
  type TournamentListRow,
  type TournamentMatch,
  type TournamentView,
} from "../tournament.ts";
import { refuseUnreadFlags } from "./capture.ts";

export interface TournamentAddInput {
  subject: string;
  repo: string;
  criteria: string[];
  ref: string | null;
}

export interface TournamentBackend {
  add(input: TournamentAddInput): Promise<Tournament>;
  candidate(id: number, input: CandidateInput): Promise<TournamentCandidate>;
  /** `match` is the parsed match file, unvalidated: the backend's store validates it. */
  record(id: number, match: unknown, replace: boolean): Promise<TournamentMatch>;
  pick(id: number, candidate: string, note: string | null): Promise<Tournament>;
  list(repo?: string): Promise<TournamentListRow[]>;
  show(id: number): Promise<TournamentView>;
}

interface TournamentCtx {
  args: string[];
  flags: Record<string, unknown>;
  mode: Mode;
}

const SUBCOMMANDS = "add|candidate|record|pick|list|show";

/** The flags each subcommand reads; any other is refused by name before anything is written or sent. */
const TOURNAMENT_READS: Record<string, readonly string[]> = {
  add: ["subject", "repo", "criteria", "ref"],
  candidate: ["label", "image", "revises"],
  record: ["match", "replace"],
  pick: ["note"],
  list: ["repo"],
  show: [],
};

function flag(ctx: TournamentCtx, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" ? v : undefined;
}

function images(ctx: TournamentCtx): string[] | undefined {
  const v = ctx.flags.image;
  if (v === undefined) return undefined;
  return (Array.isArray(v) ? v : [v]).filter((a): a is string => typeof a === "string");
}

function emit(ctx: TournamentCtx, value: unknown, quiet: string, plain: string): void {
  if (ctx.mode === "json") print(JSON.stringify(value, null, 2));
  else if (ctx.mode === "quiet") print(quiet);
  else print(plain);
}

/** Read and parse a match file on THIS machine, so over the API the file never has to be on the host. */
function readMatchFile(path: string | undefined): unknown {
  if (!path) throw new UsageError("record needs --match <file>");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new UsageError(`cannot read the match file ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`the match file ${path} is not JSON: ${(e as Error).message}`);
  }
}

export async function runTournament(ctx: TournamentCtx, be: TournamentBackend): Promise<void> {
  const sub = ctx.args[0] ?? "list";
  const rest = ctx.args.slice(1);
  const reads = TOURNAMENT_READS[sub];
  if (!reads) throw new UsageError(`unknown tournament subcommand '${sub}' (${SUBCOMMANDS})`);
  refuseUnreadFlags(`tournament ${sub}`, ctx.flags as unknown as Flags, reads);

  if (sub === "add") {
    const subject = flag(ctx, "subject") ?? "";
    if (!subject.trim()) throw new UsageError("tournament add needs --subject <text>");
    const repo = flag(ctx, "repo");
    if (!repo) throw new UsageError("tournament add needs --repo <slug>");
    const criteria = flag(ctx, "criteria");
    if (!criteria) throw new UsageError("tournament add needs --criteria <a,b,...>");
    const t = await be.add({ subject, repo, criteria: criteria.split(",").map((c) => c.trim()).filter(Boolean), ref: flag(ctx, "ref") ?? null });
    emit(ctx, t, String(t.id), String(t.id));
    return;
  }

  if (sub === "list") {
    const rows = await be.list(flag(ctx, "repo"));
    if (ctx.mode === "json") print(JSON.stringify(rows, null, 2));
    else if (ctx.mode === "quiet") print(rows.map((r) => r.id).join("\n"));
    else print(rows.length ? renderTournamentList(rows) : "no tournaments");
    return;
  }

  const id = parseTournamentId(rest[0]);

  if (sub === "show") {
    const v = await be.show(id);
    emit(ctx, v, String(v.id), renderTournamentShow(v));
    return;
  }

  if (sub === "candidate") {
    const c = await be.candidate(id, { key: rest[1] ?? "", label: flag(ctx, "label") ?? null, images: images(ctx) ?? null, revises: flag(ctx, "revises") ?? null });
    emit(ctx, c, c.key, `tournament ${id}: candidate ${c.key}${c.label ? ` (${c.label})` : ""}${c.revises ? `, revises ${c.revises}` : ""}`);
    return;
  }

  if (sub === "record") {
    const m = await be.record(id, readMatchFile(flag(ctx, "match")), ctx.flags.replace === true);
    emit(ctx, m, m.name, `tournament ${id}: recorded ${m.round} '${m.name}', ${m.x} v ${m.y}, winner ${m.winner}, ${m.calls.length} calls`);
    return;
  }

  // pick
  const candidate = rest[1];
  if (!candidate) throw new UsageError("tournament pick needs <id> <candidate>");
  const t = await be.pick(id, candidate, flag(ctx, "note") ?? null);
  emit(ctx, t, t.picked ?? "", `tournament ${id}: picked ${t.picked}`);
}

/** The backend over a store this process opened. */
function storeTournamentBackend(store: Ctx["store"]): TournamentBackend {
  return {
    add: (input) => addTournament(store, input),
    candidate: (id, input) => setCandidate(store, id, input),
    record: (id, match, replace) => recordMatch(store, id, match, { replace }),
    pick: (id, candidate, note) => pickTournament(store, id, candidate, note),
    list: (repo) => listTournaments(store, { repo }),
    show: (id) => showTournament(store, id),
  };
}

export async function cmdTournament(ctx: Ctx): Promise<void> {
  await runTournament({ args: ctx.args, flags: ctx.flags as unknown as Record<string, unknown>, mode: ctx.mode }, storeTournamentBackend(ctx.store));
}
