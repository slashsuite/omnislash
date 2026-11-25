// OS-146: the one place the e2e run's port, temp store and models file are named. Read by playwright.config.ts,
// by e2e/serve.ts (which builds this world and serves the built app on it) and by the specs (which reseed it and
// run the CLI against it). Node-safe: no bun imports, since Playwright's runner loads it too.
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PORT = 5197;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Wiped and rebuilt by e2e/serve.ts on every run, so a run never reads a stale store. */
export const E2E_DIR = join(process.env.TMPDIR || tmpdir(), `ob-dashboard-e2e-${PORT}`);
export const DB_PATH = join(E2E_DIR, "ob.sqlite");
/** This host's models file: the server's own copy, read to show what it overrides. */
export const MODELS_FILE = join(E2E_DIR, "config", "models.jsonc");

/** The server's model_routes every test starts from: `claude` active with a scheduled job, and `alt`. */
export const SEED_ROUTES = {
  active: "claude",
  profiles: {
    claude: {
      routes: {
        "builder.complex": { chain: ["claude-opus-5-5"], effort: "high" },
        "job.nightly": { chain: ["claude-sonnet-5-5"] },
      },
      review: {
        readers: { neon: { model: "opencode-go/neon" }, opus: { model: "claude-opus-5-5" } },
        tiers: { simple: ["opus"], medium: ["neon", "opus"], complex: ["neon", "opus"] },
      },
    },
    alt: { routes: { "builder.simple": { chain: ["claude-haiku-5-5"] } } },
  },
};

/** OS-23: the last `ob creds check opencode-go` every test starts from: ok, at a fixed time. */
export const SEED_CREDIT_AT = "2026-11-24T08:30:12.000Z";

/** OS-24: the home page's world. A builder parked on a human for REVIEW_REF, and two items ranked into Today. */
export const REVIEW_REF = "OS-1";
export const REVIEW_TITLE = "Wire the home page";
export const REVIEW_NOTE = "is the empty-state wording right?";
export const FOCUS_TITLES = ["Ship the header nav", "Fix the drawer save"] as const;

/**
 * OS-25: the Queue page's world. QUEUE_PROJECT's open items, band by band in the order the page and
 * `ob next --project` list them (queue_rank 1, 2, ... inside each band). critical, flake, low and none are empty.
 */
export const QUEUE_PROJECT = "omnislash";
export const QUEUE_SEED = [
  { title: "Fix the login loop", priority: 1, tags: ["auth"] },
  { title: "Wire the queue page", priority: 2, tags: ["ui"] },
  { title: "Band headings", priority: 2, tags: [] },
  { title: "Row priority select", priority: 2, tags: [] },
  { title: "Phone drag check", priority: 3, tags: [] },
  { title: "Empty band copy", priority: 3, tags: [] },
] as const;

/**
 * OS-185: the group both pages open on. GROUP_TEAM holds QUEUE_PROJECT, TIMELINE_PROJECT and SIBLING_PROJECT, whose
 * one open item (high, opened inside the timeline's week) shows in the group's queue and timeline beside theirs.
 */
export const GROUP_TEAM = { name: "slash", icon: "⚔️", display_name: "Slash" } as const;
export const GROUP_LABEL = "⚔️ Slash";
export const SIBLING_PROJECT = "taskslash";
export const SIBLING_TITLE = "Sibling project task";
export const SIBLING_OPENED = "2026-11-14T10:00:00.000Z";

/**
 * OS-27: the Timeline page's world, in its own project so the Queue page never sees it, over one fixed week
 * (the spec opens the page with this from and to, so the world never drifts out of the range).
 * - CLOSED_FROM_BLOCKED opens on the 9th, is blocked on the 10th and goes from blocked to done on the 12th: one
 *   Closed line "done after 3.0 d · after 2.0 d blocked", and no Unblocked line.
 * - BUILT has two spinoff rows: row 9001 lands at 12:00 on the 11th with a PR ("built, row 9001, 4 h" and
 *   "merged, PR #42"); row 9002 is still building ("row 9002, building").
 * - DECISION is a decision accepted an hour after it opened: it counts in Closed but not in the task-only median,
 *   which is 3.0 d (with it, the median would be 1.5 d).
 * - BUSY takes BUSY_MOVES status moves early on the 9th, so the feed passes one 200 line page.
 * Opened 4, Closed 2, Net +2.
 */
export const TIMELINE_PROJECT = "timeline-lab";
export const TIMELINE_FROM = "2026-11-09";
export const TIMELINE_TO = "2026-11-15";
export const TIMELINE_TITLES = {
  closedFromBlocked: "Timeline: closed from blocked",
  built: "Timeline: built in two rows",
  decision: "Timeline: a decision",
  busy: "Timeline: a busy ticket",
} as const;
export const TIMELINE_PR = "https://github.com/example/omnislash/pull/42";
export const BUSY_MOVES = 200;

/**
 * OS-165: the Machine page's world, in its own project. Three open tickets with one spinoff row each, at fixed ids:
 * MACHINE_ROWS.queued is `pending` (the spec claims it from the CLI and watches the dot move to launching),
 * MACHINE_ROWS.handed is handed off, and MACHINE_ROWS.failed is `failed` (the spec closes its ticket from the CLI).
 */
export const MACHINE_PROJECT = "machine-lab";
export const MACHINE_ROWS = {
  queued: { id: 9101, title: "Machine: a queued ticket", status: "pending" },
  handed: { id: 9102, title: "Machine: handed to the architect", status: "ready-for-gate" },
  failed: { id: 9103, title: "Machine: a failed launch", status: "failed" },
} as const;

/** This host's file: no `active` (the server's stands), and one route it overrides in `claude`. */
export const MODELS_FILE_TEXT = `// e2e: this host's override
{ "profiles": { "claude": { "routes": { "sweep.first": { "chain": ["local-sweeper"] } } } } }
`;

/** A CLI process on this world's store: SQLite at DB_PATH, this models file, and never the API. */
export function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "OMNISLASH_API") env[k] = v;
  return {
    ...env,
    OMNISLASH_STORE: "sqlite",
    OMNISLASH_DB: DB_PATH,
    OB_MODELS_FILE: MODELS_FILE,
    // No API base file, so the CLI uses its own store, as a client machine would not.
    OMNISLASH_API_URL_FILE: join(E2E_DIR, "no-api-url"),
    OMNISLASH_DISABLE_FRONTIER: "1",
  };
}
