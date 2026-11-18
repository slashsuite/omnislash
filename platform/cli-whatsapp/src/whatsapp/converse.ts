import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../../../../apps/cli/src/errors.ts";
import { runHeadless } from "../../../../apps/cli/src/headless-run.ts";
import { settingFor } from "../../../../apps/cli/src/settings.ts";
import { getChatPref } from "./prefs.ts";
import {
  assembleSuggestContext,
  enrichThreadMedia,
  stripReplyPreamble,
  suggestPromptBlocks,
  type ImageDescriber,
  type MessageTranscriber,
  type SuggestContext,
} from "./suggest.ts";
import {
  buildSearchGuard,
  checkSearchQuery,
  guardRules,
  searchGuardHookProgram,
  searchGuardSettings,
  selfTestGuardHook,
  type SearchGuard,
} from "./search-guard.ts";

// ── WhatsApp reply agent — the conversational panel beside the thread (#66) ──────────────────────────
// The one-shot "extra context" field gave a single string in, a single draft out. This is the same
// context (assembleSuggestContext + suggestPromptBlocks — ONE assembly, not a second drifting one) with
// the conversation so far appended, so the owner can ask a question, react to the answer, and only THEN ask
// for a message.
//
// A turn's output is STRUCTURED, not sniffed from prose: the model returns one JSON object with an
// `answer` (what it says in the panel) and an OPTIONAL `message` (a proposed WhatsApp message). That is
// what keeps "what did she say about Tuesday?" from silently overwriting the send box — an answer simply
// carries no `message`. Anything we cannot parse degrades to an ANSWER ONLY; a proposal is never invented.
//
// SAFETY, unchanged: this path can NEVER send. It reads (read-only handle in the dashboard) and returns
// text. A proposal only ever lands in the editable compose box; only the human's explicit "Confirm & send"
// reaches sendWhatsapp with confirm: true. The thread stays untrusted DATA (lethal trifecta framing from
// suggestPromptBlocks), and an `ai_disabled` chat (169) never reaches the model at all.
//
// WEB ACCESS (#121) is granted HERE AND ONLY HERE: this path's headless run gets WebSearch + WebFetch, so
// "is that a good restaurant?" can be answered from sources instead of guessed. The sibling helpers
// (describe.ts's `--allowedTools Read`, suggest.ts's tool-less run, summarize-day) are UNCHANGED - the
// panel has its own argv, its own timeout and its own guard. Because a query is egress, every query and
// URL passes the search-guard PreToolUse hook first (blocked before the network if it carries local
// private detail), is re-checked in process afterwards, and is surfaced in the panel with its sources.

/** How many recent conversation turns ride in the prompt — bounded so a long session can't grow unbounded. */
const MAX_PROMPT_TURNS = 16;

/**
 * Hard cap on a panel turn's headless run. Longer than the suggest cap (SUGGEST_CLAUDE_TIMEOUT_MS) on
 * purpose: a turn may search AND fetch a page before it answers, which the tool-less draft path never does.
 */
export const CONVERSE_TIMEOUT_MS = 180_000;

/**
 * The tools the panel path may use - web lookup ONLY. No Bash, no Write, no Edit, no Read: the panel needs
 * public facts, not the filesystem, and its whole context already arrives in the prompt.
 */
export const CONVERSE_ALLOWED_TOOLS = ["WebSearch", "WebFetch"] as const;

/**
 * Settings ISOLATION for the panel run. `project`/`local` sources resolve against the run's CWD, which is
 * the private per-turn dir (no `.claude` in it), so loading "project" loads NOTHING: the user's own
 * settings, output style and SessionStart hooks do not apply.
 *
 * That matters for more than tone. Those hooks inject extra local context into the process (a worklist of
 * current tickets, client work), and this is the one WhatsApp process with web tools. The egress guard is
 * compiled from the chat context this file assembles, so it cannot cover material injected from somewhere
 * else. Keeping it out of the process is the fix; extending the guard to chase it would be guesswork.
 * `--settings` (the guard hook) is a SEPARATE flag and still applies - verified live against this CLI.
 */
export const CONVERSE_SETTING_SOURCES = "project";

/**
 * The web-access rule the model is held to (layer 1 of the three in search-guard.ts). It states the line in
 * the model's own terms - search the public thing he asked about, never the local detail that decided it -
 * and tells it what a guard denial means so a refusal becomes a cleaner public query, not a dead end.
 */
export const WEB_ACCESS_RULES = [
  "WEB ACCESS - you have WebSearch and WebFetch for this panel, and nothing else. Use them when answering",
  "needs current public fact (a restaurant, a place, opening hours, reviews, prices) rather than guessing,",
  "and fetch a page when a snippet is not enough. Name what you used in your answer so he can check it.",
  "A SEARCH LEAVES THIS MACHINE. Everything above is local and private, so:",
  "- Search ONLY the public thing being asked about: a place, a suburb, a cuisine, a business, a topic",
  '  ("Asian restaurants Elmsworth Cape Town", "<restaurant name> Cape Town reviews", "opening hours").',
  "- NEVER put local private detail in a query or a URL: no contact or person names, no phone numbers or",
  "  jids, no quoted or paraphrased message text, no ob work items, nothing from his bio. That context is",
  "  for DECIDING what to look up; it must never appear in what goes out.",
  "- Every query and URL is checked locally BEFORE it goes out and is SHOWN to the owner in the panel. A query",
  "  carrying private detail is BLOCKED and comes back as an error - when that happens, say plainly what you",
  "  tried, drop the private part, and search the public part instead.",
  "- If something genuinely cannot be looked up without private detail, say so instead of sending it.",
].join("\n");

/**
 * What replaces the web rules when web access could NOT be established for this turn (the fail-CLOSED
 * path). The panel then behaves exactly as it did before web access existed, and the honest denial the model
 * already gives in that situation is the desired outcome - far better than searching unguarded.
 */
export const NO_WEB_ACCESS_NOTICE = [
  "NO WEB ACCESS THIS TURN. You have NO tools at all: no search, no page fetch, nothing. The local egress",
  "guard that must fence a search could not be established for this turn, so web lookup was withheld on",
  "purpose rather than run unguarded.",
  "Answer from the local context above only. If answering properly needs a public fact you do not have (a",
  "place's reviews, opening hours, prices), SAY PLAINLY that you cannot look it up this turn and say why it",
  "would have helped. Never imply you checked anything, and never guess a fact and present it as checked.",
].join("\n");

/** One turn of the panel conversation. `proposal` is set only on an agent turn that proposed a message. */
export interface AgentTurn {
  role: "user" | "agent";
  /** The user's message, or the agent's panel-side answer. Never the proposed message itself. */
  text: string;
  /** The WhatsApp message this agent turn proposed, when it proposed one. */
  proposal?: string | null;
}

/** One turn's outcome: what to show in the panel, plus an optional message for the compose box. */
export interface AgentReply {
  /** What the agent says in the panel. Never sent to anyone. */
  answer: string;
  /** The proposed WhatsApp message — null unless the model explicitly proposed one. */
  proposal: string | null;
}

/**
 * One web lookup a turn actually performed - READ BACK OFF THE RUN, not self-reported by the model, so the
 * panel shows what genuinely left the machine (or was stopped from leaving) and where an answer came from.
 */
export interface WebLookup {
  tool: "WebSearch" | "WebFetch";
  /** Exactly what went out (or was blocked): the search query, or the fetched URL. */
  query: string;
  /** The URLs the lookup came back with (a search's links, or the fetched page). Bounded. */
  sources: string[];
  /** True when the call came back an error - the guard denial included. `note` says which. */
  blocked?: boolean;
  /** The error/denial text, trimmed - the guard's own reason is preserved verbatim, never generified. */
  note?: string;
  /** True when a lookup that DID go out trips the guard on re-check (the hook failed to fire). */
  leaked?: boolean;
  /** True when the guard has no record of checking this query, so it cannot be shown to have been fenced. */
  unguarded?: boolean;
}

/** One panel turn's full result: the reply plus the web lookups it made along the way. */
export interface AgentTurnResult extends AgentReply {
  lookups: WebLookup[];
  /**
   * Set when web access was WITHHELD for this turn (the guard could not be proven), with the reason. The turn
   * ran tool-less, exactly as the panel behaved before web access existed.
   */
  webUnavailable?: string;
}

/** What one panel `claude -p` run produced: the final text, and the lookups observed on the way to it. */
export interface ConverseRun {
  text: string;
  lookups: WebLookup[];
}

/**
 * Web access for ONE turn, or the absence of it. `settingsPath` is null when the guard could not be proven
 * to work, in which case NO web tool is granted for the turn (fail closed).
 */
export interface WebAccess {
  /** The `--settings` file wiring the proven guard hook, or null when web access is withheld. */
  settingsPath: string | null;
  /** The private per-turn dir: guard program, settings, attestation log, and the run's cwd. */
  dir: string | null;
  /** Where the hook appends each decision it made, so the run can be attested afterwards. */
  logPath: string | null;
  /** Why web access is off, when it is off. Told to the model and shown in the panel. */
  reason?: string;
}

/**
 * The panel's runner seam. Tests inject one so no real `claude` process starts; it may return plain text
 * (no lookups) or a full ConverseRun. It receives the chat's guard and the turn's web access, so the real
 * runner knows whether the web tools may be granted at all.
 */
export type ConverseRunner = (
  prompt: string,
  run: { guard: SearchGuard; web: WebAccess },
) => Promise<string | ConverseRun>;

/** How many source URLs one lookup keeps - enough to check a recommendation, not a link dump. */
const MAX_LOOKUP_SOURCES = 6;

/**
 * The Claude-era panel argv (web tools + settings isolation). Kept so the fail-closed grant tests stay
 * assertable; the default spawn is the shared `opencode run` runner.
 */
export function converseClaudeArgs(settingsPath: string | null): string[] {
  const args = [
    "-p",
    "--model",
    "sonnet",
    "--setting-sources",
    CONVERSE_SETTING_SOURCES,
    "--strict-mcp-config",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (!settingsPath) return args;
  return [...args, "--allowedTools", CONVERSE_ALLOWED_TOOLS.join(","), "--settings", settingsPath];
}

/**
 * Establish web access for one turn, FAIL CLOSED. Writes the compiled guard program, its `--settings`
 * wiring and the attestation log into a private temp dir, then PROVES the program works by running it
 * (selfTestGuardHook). Only a proven guard yields a `settingsPath`; anything wrong - the dir or files cannot
 * be written, the runtime is missing, the program crashes or misjudges its canary - returns web access OFF
 * with a reason, and the turn then runs with no tools rather than searching unguarded.
 */
export async function prepareWebAccess(
  guard: SearchGuard,
  opts?: { runtime?: string; tmpRoot?: string },
): Promise<WebAccess> {
  const runtime = opts?.runtime ?? process.execPath;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(opts?.tmpRoot ?? tmpdir(), "ob-wa-panel-"));
    const hookPath = join(dir, "search-guard.js");
    const logPath = join(dir, "guard-decisions.log");
    const settingsPath = join(dir, "settings.json");
    await Bun.write(hookPath, searchGuardHookProgram(guardRules(guard), logPath));
    await Bun.write(settingsPath, JSON.stringify(searchGuardSettings(hookPath, runtime)));
    await Bun.write(logPath, "");

    const proof = await selfTestGuardHook(hookPath, runtime);
    if (!proof.ok) return { settingsPath: null, dir, logPath: null, reason: proof.reason };
    return { settingsPath, dir, logPath };
  } catch (e) {
    return {
      settingsPath: null,
      dir,
      logPath: null,
      reason: `the egress guard could not be set up: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Remove a turn's private dir (guard program, settings, decisions). Never throws. */
export async function releaseWebAccess(web: WebAccess): Promise<void> {
  if (!web.dir) return;
  await rm(web.dir, { recursive: true, force: true }).catch(() => {});
}

/** Flatten a tool_result's content (a string, or a block array) to text for URL/error extraction. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : JSON.stringify(b)))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** The distinct URLs mentioned in a tool result, bounded - a search's links, or a fetched page's own. */
function urlsIn(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'\\<>)\]]+/g) ?? [];
  const seen: string[] = [];
  for (const raw of found) {
    const url = raw.replace(/[.,]+$/, "");
    if (!seen.includes(url)) seen.push(url);
    if (seen.length >= MAX_LOOKUP_SOURCES) break;
  }
  return seen;
}

/**
 * Parse a panel run's `--output-format stream-json` NDJSON into the final answer text plus the OBSERVED web
 * lookups (WebSearch queries, WebFetch URLs, their sources, and any denial/error verbatim).
 *
 * Deliberately forgiving: unparseable lines are skipped, the final text falls back to the assistant's own
 * text blocks and then to the raw output, so a stream-shape change degrades to the plain-text behaviour
 * instead of breaking a turn.
 */
export function parseConverseStream(stdout: string): ConverseRun {
  const raw = (stdout ?? "").trim();
  if (!raw) return { text: "", lookups: [] };

  const lookups: WebLookup[] = [];
  const pending = new Map<string, WebLookup>();
  const assistantText: string[] = [];
  let resultOut: string | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = event.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];

    if (event.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") assistantText.push(block.text);
        if (block.type !== "tool_use") continue;
        const tool = block.name === "WebSearch" ? "WebSearch" : block.name === "WebFetch" ? "WebFetch" : null;
        if (!tool) continue;
        const input = (block.input ?? {}) as { query?: unknown; url?: unknown };
        const query = typeof input.query === "string" ? input.query : typeof input.url === "string" ? input.url : "";
        const lookup: WebLookup = {
          tool,
          query,
          sources: tool === "WebFetch" && typeof input.url === "string" ? [input.url] : [],
        };
        lookups.push(lookup);
        if (typeof block.id === "string") pending.set(block.id, lookup);
      }
      continue;
    }

    if (event.type === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const lookup = pending.get(block.tool_use_id);
        if (!lookup) continue;
        const text = resultText(block.content);
        if (block.is_error) {
          lookup.blocked = true;
          lookup.note = text.trim().slice(0, 500);
          continue;
        }
        for (const url of urlsIn(text)) {
          if (lookup.sources.length >= MAX_LOOKUP_SOURCES) break;
          if (!lookup.sources.includes(url)) lookup.sources.push(url);
        }
      }
      continue;
    }

    if (event.type === "result" && typeof event.result === "string") resultOut = event.result;
  }

  const text = (resultOut ?? assistantText.join("\n")).trim();
  return { text: text || raw, lookups };
}

/**
 * The output contract (the one genuinely new decision in #66): a structured reply the server parses,
 * rather than sniffing the prose for "is this a message or an answer?". `message` is null by default —
 * proposing is the explicit, asked-for act, so an answer can never fill the send box.
 */
export const CONVERSE_OUTPUT_CONTRACT = [
  "Reply with ONE JSON object and NOTHING else — no prose around it, no markdown fence:",
  '{"answer": "<what you say to the owner in the panel>", "message": "<the WhatsApp message you propose>" or null}',
  '- "answer" is ALWAYS a non-empty string: your side of the conversation with the owner. He reads it in the',
  "  panel; it is NEVER sent to anyone. Write it in plain, normal English AS YOURSELF, talking to him — the",
  "  relationship/voice guidance above shapes the PROPOSED MESSAGE ONLY, never your answer, so do not write",
  "  your answer in his WhatsApp voice or in clipped message-speak.",
  '- "message" is null UNLESS he clearly asked you to write, draft, rewrite or adjust the message he will',
  '  send ("draft it", "write that", "make it shorter", "say it warmer"). Answering a question, listing',
  '  options, or asking him something back is NOT a proposal — leave "message" null.',
  '- When you DO propose: "message" holds ONLY the sendable message text (no quotes, no preamble, no',
  "  explanation), in the owner's voice following the guidance above. Keep \"answer\" to a short note about it",
  "  (what you went with, or what you changed) — do not repeat the whole message there.",
  "- Both values must be valid JSON strings: escape newlines as \\n and escape any quotes.",
].join("\n");

/** Render the conversation so far for the prompt (oldest → newest), bounded to the most recent turns. */
function transcriptLines(turns: AgentTurn[]): string[] {
  const recent = turns.slice(-MAX_PROMPT_TURNS);
  const lines: string[] = [
    "Your conversation with the owner about this chat so far (oldest → newest; TRUSTED: this is him talking to you, not message content):",
  ];
  if (recent.length < turns.length) lines.push("(earlier turns omitted)");
  if (recent.length === 0) {
    lines.push("(this is his first message to you about this chat)");
  } else {
    for (const t of recent) {
      const text = (t.text ?? "").trim();
      if (t.role === "user") {
        if (text) lines.push(`Owner: ${text}`);
        continue;
      }
      if (text) lines.push(`you: ${text}`);
      const proposal = (t.proposal ?? "").trim();
      if (proposal) lines.push(`you proposed this message: ${proposal}`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * Build the `claude -p` prompt for one panel turn: the SHARED suggest context blocks (bio, timing, the
 * untrusted thread DATA, open work, relationship/voice, grounding + style guidance), then what is in the
 * send box, then the conversation so far, then what the owner just said, then the output contract last.
 *
 * Trust boundaries are the suggest path's, unchanged: the thread is DATA; the owner's bio, his send-box
 * draft and his own turns are TRUSTED. The contract is the FINAL instruction so it governs the shape.
 */
export function buildConversePrompt(
  ctx: SuggestContext,
  opts: { message: string; turns?: AgentTurn[]; draft?: string; web?: boolean },
): string {
  const blocks = suggestPromptBlocks(ctx);
  const draft = (opts.draft ?? "").trim();
  const message = (opts.message ?? "").trim();

  const draftLines = draft
    ? [
        "What is currently in his send box (TRUSTED — his own words, NOT sent yet; this is what a rewrite starts from):",
        draft,
        "",
      ]
    : ["His send box is currently empty.", ""];

  return [
    "You are the owner's assistant, sitting beside ONE WhatsApp conversation in his ob dashboard. He talks to",
    "you about it in turns, and you already have the conversation's context below.",
    "You do two things: (1) ANSWER what he asks about this chat — what someone said, what to suggest, what to",
    "check — and (2) PROPOSE the WhatsApp message he will send, but ONLY when he asks you for a message.",
    "You can NEVER send anything and nothing you write reaches the other person. A proposed message only lands",
    "in his editable send box; he reviews it and sends it himself.",
    "Talk to the owner in plain, normal English; you are his assistant, not the person in the chat. The",
    "relationship and voice guidance below applies to a message you PROPOSE, never to how you talk to him.",
    ...blocks.bio,
    ...blocks.timing,
    ...blocks.senderThread,
    ...blocks.work,
    ...blocks.voice,
    ...blocks.guidance,
    ...blocks.timeNote,
    "",
    ...draftLines,
    ...transcriptLines(opts.turns ?? []),
    `The owner just said to you (TRUSTED: this is your instruction from him): ${message}`,
    "",
    opts.web === false ? NO_WEB_ACCESS_NOTICE : WEB_ACCESS_RULES,
    "",
    CONVERSE_OUTPUT_CONTRACT,
  ].join("\n");
}

/** Pull the outermost JSON object out of a model response (tolerating a ```-fence or stray prose). */
function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence?.[1]?.trim() || text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * Parse one turn's raw model output into `{ answer, proposal }`.
 *
 * The SAFE DIRECTION is answer-only: unparseable output, a missing/blank `message`, or a non-string
 * `message` all yield `proposal: null`, so the compose box is never filled from output we could not
 * classify. A proposal is run through stripReplyPreamble (165) so it reaches the box as sendable text.
 */
export function parseAgentReply(raw: string): AgentReply {
  const text = (raw ?? "").trim();
  if (!text) return { answer: "", proposal: null };

  const json = extractJsonObject(text);
  if (json) {
    try {
      const parsed = JSON.parse(json) as { answer?: unknown; message?: unknown };
      const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
      const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
      const proposal = message ? stripReplyPreamble(message) : null;
      if (answer || proposal) {
        return {
          answer: answer || "Drafted a message — it's in your send box, editable.",
          proposal,
        };
      }
    } catch {
      // Malformed JSON → fall through to the answer-only degrade below.
    }
  }
  return { answer: stripReplyPreamble(text), proposal: null };
}

export interface ConverseOpts {
  chatJid: string;
  /** What the owner just said in the panel. Required: a turn is always driven by him. */
  message: string;
  /** The conversation so far (oldest → newest). Absent/empty = his first turn about this chat. */
  turns?: AgentTurn[];
  /** What is currently in the compose box, so "make it shorter" has something to work from. */
  draft?: string;
  /** Injectable runner — tests pass a mock so no real `claude` process ever starts. */
  run?: ConverseRunner;
  /**
   * Injectable web access - tests pass one to pin the granted/withheld path. Absent = established (and
   * released) per turn by prepareWebAccess, which fails CLOSED.
   */
  web?: WebAccess;
  /** Injectable voice-note transcriber (198a) — tests stub it so nothing shells out to whisper/ffmpeg. */
  transcribe?: MessageTranscriber;
  /** Injectable image describer (198b) — tests stub it so nothing shells out to `claude -p`/the bridge. */
  describeImage?: ImageDescriber;
}

/**
 * Run ONE turn of the reply-agent conversation for `chatJid`. Assembles the same read-only context as a
 * suggested draft, appends the conversation, and returns the structured turn. NEVER sends.
 */
export async function converseWhatsappAgent(
  store: Store,
  opts: ConverseOpts,
): Promise<AgentTurnResult> {
  if (!opts.chatJid) throw new AppError("converseWhatsappAgent requires a chatJid");
  const message = (opts.message ?? "").trim();
  if (!message) throw new AppError("converseWhatsappAgent requires a message");

  await enrichThreadMedia(store, opts.chatJid, opts);
  const ctx = await assembleSuggestContext(store, opts.chatJid);
  const guard = buildSearchGuard(ctx, { draft: opts.draft });
  const web = opts.web ?? (await prepareWebAccess(guard));
  try {
    const prompt = buildConversePrompt(ctx, {
      message,
      turns: opts.turns,
      draft: opts.draft,
      web: web.settingsPath !== null,
    });
    const run =
      opts.run ??
      (async (p, ctx) => {
        const text = await runHeadless({
          prompt: p,
          model: await settingFor(store, "opencode_headless_model"),
          cwd: ctx.web.dir ?? undefined,
          timeout: CONVERSE_TIMEOUT_MS,
        });
        return { text, lookups: [] as WebLookup[] };
      });
    const out = await run(prompt, { guard, web });
    const { text, lookups } = typeof out === "string" ? { text: out, lookups: [] as WebLookup[] } : out;
    const raw = (text ?? "").trim();
    if (!raw) throw new AppError("the reply assistant returned nothing (headless run failed or returned empty)");
    const reply = parseAgentReply(raw);
    if (!reply.answer && !reply.proposal) {
      throw new AppError("the reply assistant returned nothing usable");
    }
    const attested = attestLookups(flagLeaks(lookups, guard), await readGuardDecisions(web), web);
    return { ...reply, lookups: attested, ...(web.reason ? { webUnavailable: web.reason } : {}) };
  } finally {
    if (!opts.web) await releaseWebAccess(web);
  }
}

/** The decisions the guard hook recorded during the run (empty when there was no guard, or no log). */
async function readGuardDecisions(web: WebAccess): Promise<{ decision: string; input: string }[]> {
  if (!web.logPath) return [];
  try {
    const text = await Bun.file(web.logPath).text();
    return text
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as { decision?: unknown; input?: unknown };
          return typeof parsed.decision === "string" && typeof parsed.input === "string"
            ? [{ decision: parsed.decision, input: parsed.input }]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * ATTEST every lookup against the guard's own record of what it decided. A query the guard never saw is
 * marked `unguarded` and shown as such in the panel: the pre-flight self-test prevents the known failure
 * modes, and this catches the residual one (the CLI not invoking the hook at all) instead of presenting an
 * unfenced search as a clean sourced answer. A lookup at all while web access was OFF is unguarded by
 * definition.
 */
function attestLookups(
  lookups: WebLookup[],
  decisions: { decision: string; input: string }[],
  web: WebAccess,
): WebLookup[] {
  const unguardedNote =
    "the local egress guard has no record of checking this query, so it cannot be shown to have been fenced";
  return lookups.map((lookup) => {
    if (lookup.blocked) return lookup;
    const seen = decisions.some((d) => (lookup.query ? d.input.includes(lookup.query) : false));
    if (web.settingsPath !== null && seen) return lookup;
    return { ...lookup, unguarded: true, note: lookup.note ?? unguardedNote };
  });
}

/**
 * Re-check what ACTUALLY went out against the same guard the hook enforces (layer 3). The hook should have
 * stopped a leaking query before the network; if one still got through, the panel says so rather than
 * quietly showing a sourced answer.
 *
 * Only the QUERY/URL is re-checked - the sources came BACK from the web and are not egress of local data
 * (their long review-page ids would otherwise read as phone numbers).
 */
function flagLeaks(lookups: WebLookup[], guard: SearchGuard): WebLookup[] {
  return lookups.map((lookup) => {
    if (lookup.blocked) return lookup;
    const verdict = checkSearchQuery(lookup.query, guard);
    return verdict.ok ? lookup : { ...lookup, leaked: true, note: lookup.note ?? verdict.reason };
  });
}

/** One turn's result over the AI gate (169): a refusal carries no answer, no proposal and no lookups. */
export interface GatedAgentReply extends AgentTurnResult {
  /** True when the chat is marked ai_disabled — nothing was assembled and claude was NOT invoked. */
  aiDisabled?: boolean;
}

/**
 * The AI-gated panel turn (169) — the same defense in depth as suggestReplyGated, so the conversational
 * panel is NOT a second route to Claude that bypasses the per-chat pref. A chat marked `ai_disabled`
 * REFUSES here: no context assembly, no claude, no matter what the client sends.
 */
export async function converseGated(
  store: Store,
  opts: ConverseOpts,
): Promise<GatedAgentReply> {
  if ((await getChatPref(store, opts.chatJid)).ai_disabled) {
    return { answer: "", proposal: null, lookups: [], aiDisabled: true };
  }
  return await converseWhatsappAgent(store, opts);
}
