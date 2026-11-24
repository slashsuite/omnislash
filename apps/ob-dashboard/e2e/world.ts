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
