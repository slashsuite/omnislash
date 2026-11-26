export type HelpSection =
  | "Tasks"
  | "Queue & Focus"
  | "Projects & Docs"
  | "Spinoffs & Agents"
  | "T3 & Teams"
  | "Reviews & Models"
  | "Deploy & Ops"
  | "Integrations"
  | "System";

export const HELP_SECTIONS: readonly HelpSection[] = [
  "Tasks",
  "Queue & Focus",
  "Projects & Docs",
  "Spinoffs & Agents",
  "T3 & Teams",
  "Reviews & Models",
  "Deploy & Ops",
  "Integrations",
  "System",
];

export interface FlagHelp {
  flag: string;
  description: string;
}

export interface SubcommandHelp {
  summary: string;
  usage: readonly string[];
  flags?: readonly FlagHelp[];
  examples?: readonly string[];
  notes?: readonly string[];
}

export interface CommandHelp {
  section: HelpSection;
  summary: string;
  usage: readonly string[];
  acceptsPositional?: boolean;
  subcommands?: Readonly<Record<string, SubcommandHelp>>;
  subcommandAliases?: Readonly<Record<string, string>>;
  flags?: readonly FlagHelp[];
  examples?: readonly string[];
  notes?: readonly string[];
}

export interface EnvVarHelp {
  name: string;
  description: string;
}

export const GLOBAL_FLAGS: readonly FlagHelp[] = [
  { flag: "--json", description: "Emit parseable JSON on stdout (non-zero exit on error)" },
  { flag: "--table", description: "Render tabular output where supported" },
  { flag: "-q, --quiet", description: "Print minimal refs, ids, or values for scripting" },
  { flag: "--db <path>", description: "Use a specific local SQLite database file" },
  { flag: "--local", description: "Read from local replica without remote dispatch" },
  { flag: "-h, --help", description: "Show help for ob, a command, or a subcommand" },
];

export const ENV_VARS: readonly EnvVarHelp[] = [
  { name: "OB_DB_CLONE_FILE", description: "db clone profile (default ~/.config/ob/db-clone.json)" },
  { name: "OMNISLASH_API", description: "Base URL of the ob API server (enables HTTPS client mode)" },
  { name: "OMNISLASH_API_URL_FILE", description: "File holding API base URL (default ~/.omnislash_api_url)" },
  { name: "OMNISLASH_API_TOKEN", description: "API bearer token for one call (overrides token file)" },
  { name: "OMNISLASH_API_ACCESS_CLIENT_ID", description: "Cloudflare Access client id header for API requests" },
  { name: "OMNISLASH_API_ACCESS_CLIENT_SECRET", description: "Cloudflare Access client secret header for API requests" },
  { name: "OMNISLASH_API_ACCESS_FILE", description: "File holding Access client id/secret (~/.omnislash_api_access)" },
  { name: "OMNISLASH_API_DEPLOY_ENABLED", description: "Set to 1 on the API host to allow API-triggered deploys" },
  { name: "OMNISLASH_DEPLOY_REQUEST_FILE", description: "Trigger file path watched by the live deploy helper" },
  { name: "OMNISLASH_DEPLOY_SHA", description: "Target commit SHA passed to live deploy scripts" },
  { name: "OMNISLASH_ROLE_API", description: "Second API base URL: team role, inbox and project status routes" },
  { name: "OMNISLASH_ROLE_API_URL_FILE", description: "File holding role API URL (~/.omnislash_role_api_url)" },
  { name: "OB_API_TOKEN_FILE", description: "Bearer token file, mode 0600 (default ~/.ob_api_token)" },
  { name: "OB_API_TOKENS_FILE", description: "Scoped API tokens file, mode 0600 (default ~/.ob_api_tokens.json)" },
  { name: "OB_API_TIMEOUT_MS", description: "Client API call timeout in ms (default 150000)" },
  { name: "OB_API_REQUEST_TIMEOUT_MS", description: "Server per-request timeout in ms (default 120000)" },
  { name: "OB_API_RETRY_MS", description: "Client retry budget for refused connections (default 30000)" },
  { name: "OMNISLASH_STORE", description: "Authoritative DB engine: postgres (default) or sqlite" },
  { name: "OMNISLASH_STORE_TIMEOUT_MS", description: "Postgres transaction/NOTIFY timeout in ms (default 30000)" },
  { name: "OMNISLASH_PG_URL", description: "Postgres connection URL (overrides URL file)" },
  { name: "OMNISLASH_PG_URL_FILE", description: "File holding Postgres URL, mode 0600 (~/.omnislash_pg_url)" },
  { name: "OMNISLASH_DB", description: "Local SQLite database path (--db wins)" },
  { name: "OMNISLASH_DB_CREATE", description: "Set to 1 to allow creating a missing SQLite DB file" },
  { name: "OMNISLASH_SNAPSHOT_DIR", description: "Directory for db snapshot dumps (--dir wins)" },
  { name: "OMNISLASH_MEMORY_PATH", description: "Path to local MEMORY.md (~/.local/share/omnislash/MEMORY.md)" },
  { name: "OMNISLASH_WEB_BIND", description: "Bind address for web (--bind wins; default 127.0.0.1)" },
  { name: "OMNISLASH_WEB_TLS_CERT", description: "PEM certificate chain for web (--tls-cert wins)" },
  { name: "OMNISLASH_WEB_TLS_KEY", description: "PEM private key for web (--tls-key wins)" },
  { name: "OMNISLASH_MASTER_KEY_FILE", description: "Base64 32-byte secret-store master key file, mode 0600" },
  { name: "OMNISLASH_OB_BIN", description: "Path to ob binary invoked by API host background jobs" },
  { name: "OMNISLASH_CLAUDE_PROJECTS_DIR", description: "Override Claude transcripts dir for spinoff token backfill" },
  { name: "OMNISLASH_OPENCODE_DB_PATH", description: "Override OpenCode SQLite DB path for token backfill" },
  { name: "OMNISLASH_OPENCODE_API_SESSIONS", description: "Override OpenCode sessions JSON path for token backfill" },
  { name: "OMNISLASH_SENTRY_ENVIRONMENT", description: "Sentry environment tag for CLI error reporting" },
  { name: "OMNISLASH_DISABLE_FRONTIER", description: "Skip live GitHub issue lookups in wayfinder/next" },
  { name: "OB_T3_CREDENTIAL_FILE", description: "Override T3 Code credential file path" },
  { name: "OB_MODELS_FILE", description: "Path to models.jsonc (default ~/.config/ob/models.jsonc)" },
  { name: "OB_T3_SETTINGS", description: "settings.json models sync-favorites reads (~/.t3/userdata/settings.json)" },
  { name: "OB_REPOS_DIR", description: "Override private repo rules directory" },
  { name: "OB_GITHUB_OWNER", description: "Default GitHub owner for project remote inference" },
  { name: "OB_GITHUB_PR_READ", description: "Set to 'off' to skip live GitHub PR checks in spinoff" },
  { name: "OB_REVIEW_DIFF_BASE", description: "Override diff base ref for review telemetry (origin/main)" },
  { name: "OB_USAGE_TRANSCRIPTS", description: "Override Claude transcript directory for usage day" },
  { name: "OB_USAGE_T3_CACHE", description: "Override T3 usage cache JSON file for weekly pacing" },
  { name: "OB_WIKI_DIR", description: "Override checkout wiki/ directory for wiki commands" },
  { name: "OB_LEASE_RUN_TASKSLASH", description: "Set to 0 to bypass TaskSlash in lease run" },
  { name: "OB_LEASE_RUN_ESCAPE", description: "Control systemd-run escape in lease run (0 off, 1 always)" },
  { name: "OB_REMOTE", description: "Set to 0 to disable legacy remote_host SSH dispatch" },
  { name: "OB_REMOTE_HOP", description: "Loop guard set automatically on SSH hops (1)" },
];

export const COMMAND_HELP: Readonly<Record<string, CommandHelp>> = {
  // --- Tasks ---
  add: {
    section: "Tasks",
    summary: "Create a task, roadmap, decision, or learning item",
    usage: [
      "add <title> [--project <p>] [--priority <p>] [--body <text>|--body-file <file>]",
      "add --type roadmap|decision|learning <title> [type flags]",
    ],
    flags: [
      { flag: "--type <type>", description: "Item type: task (default), roadmap, decision, learning" },
      { flag: "--project <slug>", description: "Project slug or repo (inferred from git remote if omitted)" },
      { flag: "--repo <slug>", description: "Alias for --project" },
      { flag: "--kind <kind>", description: "Store-side project kind (local store only; refused over API)" },
      { flag: "--priority <p>", description: "critical, urgent, flake, high, medium, low, or none (0-6)" },
      { flag: "--body <text>", description: "Markdown item body" },
      { flag: "--body-file <file>", description: "Read body from a local file (mutually exclusive with --body)" },
      { flag: "--tag <tag>", description: "Attach a tag (repeatable)" },
      { flag: "--link <url>", description: "Link an external URL or GitHub issue" },
      { flag: "--issue", description: "Also create and link a GitHub issue on wayfinder_repo" },
      { flag: "--map <name>", description: "Add map:<name> label when creating a GitHub issue" },
      { flag: "--exec <mode>", description: "Add exec:<mode> label when creating a GitHub issue" },
      { flag: "--triage", description: "Flag item for the triage inbox" },
      { flag: "--from <repo>", description: "Origin repo for --triage (defaults to current repo)" },
      { flag: "--target-date <d>", description: "Roadmap target date (--type roadmap)" },
      { flag: "--source-ref <r>", description: "Roadmap source reference (--type roadmap)" },
      { flag: "--owner <who>", description: "Roadmap owner (--type roadmap)" },
      { flag: "--context <text>", description: "Decision context (--type decision)" },
      { flag: "--choice <text>", description: "Decision choice (--type decision)" },
      { flag: "--rationale <t>", description: "Decision rationale (--type decision)" },
      { flag: "--alternatives <t>", description: "Decision alternatives (--type decision)" },
      { flag: "--learn-kind <k>", description: "Learning kind (--type learning)" },
      { flag: "--progress <t>", description: "Learning progress (--type learning)" },
      { flag: "--source <src>", description: "Learning source (--type learning)" },
      { flag: "--why <text>", description: "Learning rationale (--type learning)" },
    ],
    examples: [
      'add "Fix login timeout" --project app --priority high --tag backend',
      'add "Cache invalidation spec" --project app --body-file spec.md',
      'add --type decision "Use Postgres" --choice postgres --rationale "Single store"',
    ],
    notes: [
      "Flags not accepted by the chosen --type are refused by name.",
      "Every item gets a per-project ref <KEY>-<seq> when its project has a key.",
    ],
  },

  edit: {
    section: "Tasks",
    summary: "Update an item's title, body, priority, or project",
    usage: [
      "edit <id> [--title <t>] [--body <text>|--body-file <file>] [--priority <p>] [--project <p>]",
      "edit <id> --priority <p> [--note <why>] [--holder <id>]",
    ],
    flags: [
      { flag: "--title <text>", description: "Replace the item title" },
      { flag: "--body <text>", description: "Replace the item body" },
      { flag: "--body-file <file>", description: "Replace body from a local file" },
      { flag: "--priority <p>", description: "Set priority (critical, urgent, flake, high, medium, low, none)" },
      { flag: "--project <slug>", description: "Move item to another project (issues a new ref, keeps old alias)" },
      { flag: "--repo <slug>", description: "Alias for --project" },
      { flag: "-m, --note <why>", description: "Why the priority changed, on the Decisions trail" },
      { flag: "--holder <id>", description: "Who changed it (default: human)" },
    ],
    examples: [
      "edit APP-12 --priority high",
      'edit APP-12 --title "Tighten session expiry" --body-file brief.md',
    ],
    notes: [
      "Setting --priority on a triaged item clears its triage flag.",
      "Unrecognized flags for edit are refused by name.",
    ],
  },

  triage: {
    section: "Tasks",
    summary: "List or resolve items in the triage inbox",
    usage: ["triage", "triage clear <id>", "triage reject <id>"],
    acceptsPositional: true,
    subcommands: {
      clear: {
        summary: "Clear the triage flag and keep the item open",
        usage: ["triage clear <id>"],
        examples: ["triage clear APP-12"],
      },
      reject: {
        summary: "Close a triaged item without working it",
        usage: ["triage reject <id> [--note <why>] [--no-github]"],
        flags: [
          { flag: "-m, --note <why>", description: "Record why the item was rejected" },
          { flag: "--no-github", description: "Skip closing any linked GitHub issue" },
        ],
        examples: ['triage reject APP-12 --note "Duplicate of APP-9"'],
      },
    },
    examples: ["triage", "triage clear APP-12", "triage reject APP-14"],
    notes: ["Setting a priority via 'ob edit <id> --priority <p>' also clears the triage flag."],
  },

  note: {
    section: "Tasks",
    summary: "Append a timestamped note to an item",
    usage: ["note <id> <text>"],
    examples: ['note APP-12 "Confirmed root cause in auth middleware"'],
  },

  tag: {
    section: "Tasks",
    summary: "Add one or more tags to an item",
    usage: ["tag <id> <tag>... [--repo <slug>]"],
    flags: [{ flag: "--repo <slug>", description: "Also set the item's project/repo" }],
    examples: ["tag APP-12 backend bug-fix", "tag APP-12 frontend --repo web"],
    notes: ["See the tags already in use, most used first, with 'ob tags'."],
  },

  tags: {
    section: "Tasks",
    summary: "List every tag in use with how many items carry it, most used first",
    usage: ["tags [--project <slug>] [--json]"],
    flags: [
      { flag: "--project <slug>", description: "Count only this project's items" },
      { flag: "--repo <slug>", description: "Alias for --project" },
      { flag: "--json", description: "Print [{ tag, count }]" },
    ],
    examples: ["tags", "tags --project app --json"],
    notes: ["Read from the items themselves, open and closed, so a new tag shows as soon as an item carries it."],
  },

  untag: {
    section: "Tasks",
    summary: "Remove one or more tags from an item",
    usage: ["untag <id> <tag>..."],
    examples: ["untag APP-12 rework"],
  },

  link: {
    section: "Tasks",
    summary: "Create a typed relationship between two items",
    usage: ["link <id> <rel> <other>"],
    examples: [
      "link APP-15 blocks APP-12",
      "link APP-20 spun_off_from APP-12",
    ],
    notes: [
      "Relations: roadmap_member, spun_off_from, references, blocks, supersedes.",
      "'A blocks B': while B is open A ranks at B's priority, down a whole chain.",
      "A's stored priority is unchanged; 'ob show A' names what raised it.",
    ],
  },

  issue: {
    section: "Tasks",
    summary: "Manage links and sync checks with GitHub issues",
    usage: ["issue [list]", "issue <subcommand> [args]"],
    subcommands: {
      list: {
        summary: "List current ob item to GitHub issue pairs",
        usage: ["issue [list]"],
        examples: ["issue list"],
      },
      link: {
        summary: "Pair an existing ob item with an existing GitHub issue",
        usage: ["issue link <id> <#n|url>"],
        examples: ["issue link APP-12 #42"],
        notes: ["Refuses if the issue is linked elsewhere or the item already holds a Linear ref."],
      },
      unlink: {
        summary: "Clear an item's GitHub or Linear external reference",
        usage: ["issue unlink <id>"],
        examples: ["issue unlink APP-12"],
        notes: ["Preserves the item's notes, tags, links, history, and state."],
      },
      landed: {
        summary: "Check local git and spinoff records for whether work landed on main",
        usage: ["issue landed <id|#n> [--repo <path>]"],
        flags: [{ flag: "--repo <path>", description: "Git checkout path to inspect" }],
        examples: ["issue landed APP-12", "issue landed #42 -q"],
        notes: [
          "Runs git locally (never on the API host); -q prints landed, could-not-tell, or not-landed.",
          "Checks merge commits, leading commit scopes, merged branches, and spinoff rows.",
        ],
      },
      reconcile: {
        summary: "Suggest likely unlinked ob item and GitHub issue pairs",
        usage: ["issue reconcile [--limit <n>]"],
        flags: [{ flag: "--limit <n>", description: "Maximum candidate pairs to display" }],
        examples: ["issue reconcile --limit 20"],
        notes: ["Read-only; prints 'ob issue link' commands for human confirmation."],
      },
      drift: {
        summary: "Find drift between open/closed GitHub issues and ob item states",
        usage: ["issue drift [--repo <path>]"],
        flags: [{ flag: "--repo <path>", description: "Git checkout path to inspect" }],
        examples: ["issue drift"],
      },
    },
    examples: ["issue list", "issue link APP-12 #42", "issue landed APP-12"],
  },

  rm: {
    section: "Tasks",
    summary: "Delete an item from local tracking",
    usage: ["rm <id>"],
    examples: ["rm APP-12"],
    notes: ["Removes only ob tracking; linked GitHub issues are not modified."],
  },

  start: {
    section: "Tasks",
    summary: "Move an item to in-progress",
    usage: ["start <id> [--note <why>]"],
    flags: [{ flag: "-m, --note <why>", description: "Record a note on the Decisions trail" }],
    examples: ['start APP-12 --note "Picking up today"'],
  },

  ready: {
    section: "Tasks",
    summary: "Mark an item ready for review or pickup",
    usage: ["ready <id> [--note <why>]"],
    flags: [{ flag: "-m, --note <why>", description: "Record a note on the Decisions trail" }],
    examples: ["ready APP-12"],
  },

  block: {
    section: "Tasks",
    summary: "Mark an item blocked with a reason",
    usage: ["block <id> --reason <text> [--owner <who>] [--note <why>]"],
    flags: [
      { flag: "--reason <text>", description: "Why the item is blocked (or use --note)" },
      { flag: "--owner <who>", description: "Person or team unblocking it" },
      { flag: "-m, --note <why>", description: "Note recorded on the Decisions trail" },
    ],
    examples: ['block APP-12 --reason "Waiting on API token" --owner ops'],
    notes: ["Refuses done items, already-blocked items, and types without a blocked state."],
  },

  unblock: {
    section: "Tasks",
    summary: "Clear a block and restore the item's prior status",
    usage: ["unblock <id> [--note <why>]"],
    flags: [{ flag: "-m, --note <why>", description: "Record a note on the Decisions trail" }],
    examples: ['unblock APP-12 --note "Token rotated"'],
  },

  close: {
    section: "Tasks",
    summary: "Close an item, mirror linked GitHub issue, and land spinoffs",
    usage: ["close <id> [--note <why>] [--no-github] [--dry-run]"],
    flags: [
      { flag: "-m, --note <why>", description: "Record closing summary on the Decisions trail" },
      { flag: "--no-github", description: "Skip closing the linked GitHub issue" },
      { flag: "--dry-run", description: "Validate and preview the close without writing" },
    ],
    examples: ['close APP-12 --note "Merged in PR #88"', "close APP-12 --dry-run"],
    notes: [
      "Marks active spinoff rows landed, settles builder T3 threads, and withdraws queued handoff notes.",
      "Closing a spike retires its spinoff row as failed without marking it landed.",
    ],
  },

  reopen: {
    section: "Tasks",
    summary: "Reopen a closed item and its linked GitHub issue",
    usage: ["reopen <id> [--note <why>] [--no-github] [--dry-run]"],
    flags: [
      { flag: "-m, --note <why>", description: "Record why the item was reopened" },
      { flag: "--no-github", description: "Skip reopening the linked GitHub issue" },
      { flag: "--dry-run", description: "Validate and preview the reopen without writing" },
    ],
    examples: ['reopen APP-12 --note "Regression seen in staging"'],
  },

  state: {
    section: "Tasks",
    summary: "Transition an item to an explicit validated state",
    usage: [
      "state <id> <state> [--note <why>] [--reason <r>] [--no-github] [--dry-run]",
      "state <id> <state> --repair <why>",
    ],
    flags: [
      { flag: "-m, --note <why>", description: "Record a note on the Decisions trail" },
      { flag: "--reason <text>", description: "Reason when moving to blocked" },
      { flag: "--no-github", description: "Skip GitHub issue mirroring when closing or reopening" },
      { flag: "--dry-run", description: "Preview transition without writing" },
      { flag: "--repair <why>", description: "Skip the lifecycle's edge check (target must be in the vocab; not done or blocked); logged" },
    ],
    examples: ["state APP-12 done", 'state APP-12 open --note "Re-queued"', "state APP-12 open --repair 'legacy status qa'"],
    notes: [
      "Moving to done mirrors close; moving off blocked clears the block.",
      "A move the item's lifecycle does not allow is refused (exit 1); blocked needs --reason.",
      "--repair is local only (not over the API) and records 'repair: <why>' on the Decisions trail.",
    ],
  },

  // --- Queue & Focus ---
  next: {
    section: "Queue & Focus",
    summary: "Show prioritized next items to work on",
    usage: ["next [--project <slug|repo>]"],
    flags: [{ flag: "--project <slug>", description: "Show one project's dispatch queue" }],
    examples: ["next", "next --project app"],
    notes: [
      "Order: today_rank -> priority -> kind -> queue_rank -> updated.",
      "Priorities: critical, urgent, flake, high, medium, low, none.",
      "At >=95% weekly usage in the active models profile, lists critical items only.",
    ],
  },

  status: {
    section: "Queue & Focus",
    summary: "Show a live snapshot of agents, T3 threads, PRs, and focus",
    usage: ["status"],
    examples: ["status", "status --json"],
  },

  list: {
    section: "Queue & Focus",
    summary: "List items filtered by status, project, team, priority, or tag",
    usage: ["list [--open] [--status <s>] [--project <p>] [--team <t>] [--priority <p>] [--tag <t>]"],
    flags: [
      { flag: "--open", description: "Include only open items" },
      { flag: "--status <state>", description: "Filter by exact status" },
      { flag: "--kind <kind>", description: "Filter by project kind" },
      { flag: "--project <slug>", description: "Filter by project slug" },
      { flag: "--repo <slug>", description: "Alias for --project" },
      { flag: "--team <name>", description: "Filter to projects belonging to a team" },
      { flag: "--priority <p>", description: "Filter by priority level" },
      { flag: "--type <type>", description: "Filter by item type (task, roadmap, decision, learning, doc)" },
      { flag: "--tag <tag>", description: "Filter by tag (repeatable)" },
      { flag: "--since <when>", description: "Items created since date or duration" },
      { flag: "--updated-after <d>", description: "Items updated after timestamp or date" },
      { flag: "--by <field>", description: "Sort order: priority, updated, or created" },
      { flag: "--limit <n>", description: "Maximum number of items to return" },
    ],
    examples: ["list --open --project app", "list --team core --priority high --limit 20"],
  },

  show: {
    section: "Queue & Focus",
    summary: "Display full detail and Decisions trail for an item",
    usage: ["show <id>"],
    examples: ["show APP-12", "show APP-12 --json"],
    notes: ["Accepts a per-project ref, a historical alias after a move, or a legacy numeric id."],
  },

  brief: {
    section: "Queue & Focus",
    summary: "Show compact status, links, and activity for an item or in-flight work",
    usage: ["brief <id>", "brief --in-flight"],
    flags: [{ flag: "--in-flight", description: "Summarize open PRs and open items across projects" }],
    examples: ["brief APP-12", "brief --in-flight --json"],
  },

  search: {
    section: "Queue & Focus",
    summary: "Full-text search across item titles and bodies",
    usage: ["search <query>"],
    examples: ['search "oauth callback"'],
  },

  today: {
    section: "Queue & Focus",
    summary: "Pin an item to today's focus list or clear pins",
    usage: ["today <id> [--rank <n>]", "today --clear"],
    flags: [
      { flag: "--rank <n>", description: "Explicit position in today's list" },
      { flag: "--clear", description: "Clear all today pins" },
    ],
    examples: ["today APP-12 --rank 1", "today --clear"],
  },

  order: {
    section: "Queue & Focus",
    summary: "Position an open item within its project's priority queue",
    usage: [
      "order <ref> --top [--priority <p>]",
      "order <ref> --before <other>",
      "order <ref> --after <other>",
    ],
    flags: [
      { flag: "--top", description: "Place item at the top of its priority band" },
      { flag: "--priority <p>", description: "Target priority band when using --top" },
      { flag: "--before <ref>", description: "Place immediately before another open item in the project" },
      { flag: "--after <ref>", description: "Place immediately after another open item in the project" },
      { flag: "-m, --note <why>", description: "Why, when the move changes the priority (Decisions trail)" },
      { flag: "--holder <id>", description: "Who moved it (default: human)" },
    ],
    examples: ["order APP-12 --top", "order APP-14 --before APP-12"],
    notes: [
      "Using --before/--after next to an item in another band moves it into that band.",
      "A move that changes the stored priority records it on the Decisions trail.",
    ],
  },

  focus: {
    section: "Queue & Focus",
    summary: "Set or clear the active focus project",
    usage: ["focus <project>", "focus --clear"],
    flags: [{ flag: "--clear", description: "Clear the active focus project" }],
    examples: ["focus app", "focus --clear"],
  },

  log: {
    section: "Queue & Focus",
    summary: "Record or list standup journal entries",
    usage: ['log <kudos|suggestion|comment> "<text>" [--about <handle>] [--item <id>]', "log list [--since <w>]"],
    acceptsPositional: true,
    subcommands: {
      list: {
        summary: "List recorded journal entries",
        usage: ["log list [--since <when>] [--type <kudos|suggestion|comment>]"],
        flags: [
          { flag: "--since <when>", description: "Only entries since date or duration" },
          { flag: "--type <kind>", description: "Filter by kudos, suggestion, or comment" },
        ],
        examples: ["log list --since 7d"],
      },
    },
    flags: [
      { flag: "--about <handle>", description: "Associate entry with a person handle" },
      { flag: "--item <id>", description: "Associate entry with an ob item" },
    ],
    examples: ['log kudos "Clean migration" --about alice', "log list --since 7d"],
  },

  standup: {
    section: "Queue & Focus",
    summary: "Save, view, and mark daily standup notes as posted",
    usage: ["standup [latest]", "standup save|set|posted"],
    subcommands: {
      latest: {
        summary: "Print the latest standup entry",
        usage: ["standup [latest]"],
        examples: ["standup latest", "standup --json"],
      },
      save: {
        summary: "Save a generated standup from stdin",
        usage: ["standup save"],
        examples: ["cat standup.md | ob standup save"],
      },
      set: {
        summary: "Replace the current standup text from stdin",
        usage: ["standup set"],
        examples: ["cat edited.md | ob standup set"],
      },
      posted: {
        summary: "Mark the current standup as posted",
        usage: ["standup posted"],
        examples: ["standup posted"],
      },
    },
    examples: ["standup latest", "standup posted"],
  },

  // --- Projects & Docs ---
  project: {
    section: "Projects & Docs",
    summary: "Manage projects, ref keys, release stages, and repo rules",
    usage: ["project [list]", "project <subcommand> [args]"],
    subcommands: {
      list: {
        summary: "List projects with kind, remote, ref key, labels, stage, and status",
        usage: ["project [list] [--all] [--json]"],
        flags: [{ flag: "--all", description: "Include archived projects (hidden by default)" }],
        examples: ["project list", "project list --all --json"],
      },
      add: {
        summary: "Register a new project",
        usage: ["project add <name> --kind <k> [--remote <url>] [--key <KEY>] [--icon <e>] [--display-name <t>]"],
        flags: [
          { flag: "--kind <kind>", description: "Project kind (required)" },
          { flag: "--remote <url>", description: "Git remote URL" },
          { flag: "--key <KEY>", description: "Unique 2-4 uppercase letter ref key" },
          { flag: "--icon <emoji>", description: "Short icon label for dashboards and threads" },
          { flag: "--display-name <t>", description: "Human display name (up to 40 chars)" },
        ],
        examples: ["project add web --kind product --key WEB --remote https://github.com/org/web"],
      },
      edit: {
        summary: "Update a project's remote, kind, ref key, labels, stage, or status",
        usage: ["project edit <name> [--remote <url>] [--kind <k>] [--key <KEY>] [--stage <s>] [--status <s>]"],
        flags: [
          { flag: "--remote <url>", description: "Update git remote URL" },
          { flag: "--kind <kind>", description: "Update project kind" },
          { flag: "--key <KEY>", description: "Set or change ref key (renumbers items, keeps aliases)" },
          { flag: "--icon <emoji>", description: "Set or clear ('') icon label" },
          { flag: "--display-name <t>", description: "Set or clear ('') display name" },
          { flag: "--stage <stage>", description: "alpha, beta, rc, stable, legacy, or none" },
          { flag: "--status <status>", description: "active, paused, or archived (held projects get no dispatch)" },
        ],
        examples: ["project edit web --stage beta --icon 🌐", "project edit web --status paused"],
      },
      pause: {
        summary: "Pause a project: no dispatch, left out of next and team loops",
        usage: ["project pause <name>"],
        examples: ["project pause web"],
      },
      resume: {
        summary: "Set a paused or archived project back to active",
        usage: ["project resume <name>"],
        examples: ["project resume web"],
      },
      archive: {
        summary: "Archive a project: paused, and hidden from project list without --all",
        usage: ["project archive <name>"],
        examples: ["project archive web"],
      },
      rename: {
        summary: "Rename a project slug in place while preserving item refs",
        usage: ["project rename <old> <new>"],
        examples: ["project rename old-web web"],
      },
      rm: {
        summary: "Remove a project (refuses with open items unless --force)",
        usage: ["project rm <name> [--force]"],
        flags: [{ flag: "--force", description: "Remove even when open items reference the project" }],
        examples: ["project rm legacy-app --force"],
      },
      rules: {
        summary: "Print a project's release stage and private agent rules",
        usage: ["project rules <project>"],
        examples: ["project rules web", "project rules web --json"],
      },
      wire: {
        summary: "Build a checkout's .opencode/ wiring (plugins, launcher, agent) and git-exclude it",
        usage: ["project wire <project> [--dir <path>]"],
        flags: [{ flag: "--dir <path>", description: "Target checkout directory (defaults to cwd)" }],
        examples: ["project wire web --dir ~/dev/web"],
      },
    },
    examples: ["project list", "project edit web --stage alpha", "project pause web", "project rules web"],
  },

  wiki: {
    section: "Projects & Docs",
    summary: "Read, refresh, and audit project wiki pages and incident logs",
    usage: ["wiki [list]", "wiki <name>", "wiki <subcommand> [args]"],
    acceptsPositional: true,
    subcommands: {
      list: {
        summary: "List project and topic pages in wiki/",
        usage: ["wiki [list]"],
        examples: ["wiki list"],
      },
      refresh: {
        summary: "Refresh generated facts blocks on project wiki pages",
        usage: ["wiki refresh [<project>]"],
        examples: ["wiki refresh", "wiki refresh web"],
      },
      check: {
        summary: "Audit wiki pages and incident logs for staleness or bad entries",
        usage: ["wiki check"],
        examples: ["wiki check"],
      },
      incidents: {
        summary: "List incident areas or print an area's incident log",
        usage: ["wiki incidents [<area>]"],
        examples: ["wiki incidents", "wiki incidents deploy"],
      },
      log: {
        summary: "Append a new entry to an area's incident log",
        usage: ['wiki log <area> "<title>" --what <t> [--cause <t>] [--fix <t>] [--ticket <r>] [--date <d>]'],
        flags: [
          { flag: "--what <text>", description: "What happened (required)" },
          { flag: "--cause <text>", description: "Root cause (defaults to unknown)" },
          { flag: "--fix <text>", description: "Fix applied (defaults to open)" },
          { flag: "--ticket <ref>", description: "Related ticket ref(s), comma-separated" },
          { flag: "--date <date>", description: "Incident date YYYY-MM-DD (defaults to today)" },
          { flag: "--new-area", description: "Allow creating a new incident area outside defaults" },
        ],
        examples: ['wiki log deploy "Build failed" --what "Missing asset" --fix "Rebuilt dist"'],
      },
    },
    examples: ["wiki list", "wiki web", "wiki incidents deploy"],
  },

  doc: {
    section: "Projects & Docs",
    summary: "Manage versioned reference documents under a project",
    usage: ["doc [list]", "doc <subcommand> [args]"],
    subcommands: {
      list: {
        summary: "List reference documents",
        usage: ["doc [list] [--project <p>]"],
        flags: [{ flag: "--project <slug>", description: "Filter documents by project" }],
        examples: ["doc list --project personal"],
      },
      add: {
        summary: "Create a reference document under a project",
        usage: ["doc add <title> --project <p> (--body <text> | --body-file <file>)"],
        flags: [
          { flag: "--project <slug>", description: "Project to file the document under (required)" },
          { flag: "--body <text>", description: "Document body text" },
          { flag: "--body-file <file>", description: "Read body text from a local file" },
        ],
        examples: ['doc add "Runbook" --project ops --body-file runbook.md'],
      },
      show: {
        summary: "Print a document or a historical version",
        usage: ["doc show <id|ref> [--version <n>]"],
        flags: [{ flag: "--version <n>", description: "Print version n (1 is oldest)" }],
        examples: ["doc show OPS-4", "doc show OPS-4 --version 1"],
      },
      history: {
        summary: "List saved versions of a document, newest first",
        usage: ["doc history <id|ref>"],
        examples: ["doc history OPS-4"],
      },
      set: {
        summary: "Update a document's body and/or title, preserving prior version",
        usage: ["doc set <id|ref> (--body <text> | --body-file <file>) [--title <t>]"],
        flags: [
          { flag: "--body <text>", description: "Replacement body text" },
          { flag: "--body-file <file>", description: "Read replacement body from a local file" },
          { flag: "--title <text>", description: "Optional new document title" },
        ],
        examples: ["doc set OPS-4 --body-file runbook.md"],
      },
    },
    examples: ["doc list", "doc show OPS-4 --version 1"],
  },

  roadmap: {
    section: "Projects & Docs",
    summary: "View roadmap items and their progress",
    usage: ["roadmap [list | <id>]"],
    acceptsPositional: true,
    subcommands: {
      list: {
        summary: "List roadmap items",
        usage: ["roadmap [list]"],
        examples: ["roadmap list"],
      },
    },
    examples: ["roadmap", "roadmap APP-3"],
  },

  decision: {
    section: "Projects & Docs",
    summary: "View recorded decisions or supersede an older one",
    usage: ["decision [list | <id>]", "decision supersede <new> <old>"],
    acceptsPositional: true,
    subcommands: {
      list: {
        summary: "List decision items",
        usage: ["decision [list]"],
        examples: ["decision list"],
      },
      supersede: {
        summary: "Mark an older decision as superseded by a newer one",
        usage: ["decision supersede <new> <old>"],
        examples: ["decision supersede APP-20 APP-5"],
      },
    },
    examples: ["decision list", "decision APP-20", "decision supersede APP-20 APP-5"],
  },

  learning: {
    section: "Projects & Docs",
    summary: "View recorded learnings",
    usage: ["learning [list | <id>]"],
    acceptsPositional: true,
    subcommands: {
      list: {
        summary: "List learning items",
        usage: ["learning [list]"],
        examples: ["learning list"],
      },
    },
    examples: ["learning list", "learning APP-9"],
  },

  memory: {
    section: "Projects & Docs",
    summary: "Append to or display this machine's capped MEMORY.md",
    usage: ['memory add "<fact>"', "memory show"],
    subcommands: {
      add: {
        summary: "Append a bullet to local MEMORY.md and record a learning item",
        usage: ['memory add "<fact>"'],
        examples: ['memory add "Always run moon lint before pushing"'],
        notes: ["Keeps local MEMORY.md under 4k chars by dropping oldest bullets."],
      },
      show: {
        summary: "Print this machine's MEMORY.md",
        usage: ["memory show"],
        examples: ["memory show"],
      },
    },
    examples: ['memory add "Prefer bun test for unit runs"', "memory show"],
    notes: [
      "Override file location with OMNISLASH_MEMORY_PATH (see 'ob help env').",
      "OpenCode prepends MEMORY.md to every request in a checkout wired by 'ob project wire'.",
    ],
  },

  overnight: {
    section: "Projects & Docs",
    summary: "Track overnight autonomous runs, decisions, and summaries",
    usage: ["overnight <subcommand> [args]"],
    subcommands: {
      start: {
        summary: "Create or show the night's overnight summary doc",
        usage: ["overnight start [--project <p>] [--date <YYYY-MM-DD>]"],
        flags: [
          { flag: "--project <slug>", description: "Project slug (inferred from cwd if omitted)" },
          { flag: "--date <date>", description: "Run date YYYY-MM-DD (defaults to local today)" },
        ],
        examples: ["overnight start --project app"],
      },
      decide: {
        summary: "Record an accepted overnight or daytime architect decision",
        usage: ['overnight decide "<title>" --what <t> --why <t> [--doubt <t>] [--undo <t>] [--night <d>] [--at <when>]'],
        flags: [
          { flag: "--what <text>", description: "Decision made (required)" },
          { flag: "--why <text>", description: "Rationale (required)" },
          { flag: "--doubt <text>", description: "Open doubt or risk" },
          { flag: "--undo <text>", description: "How to revert if needed" },
          { flag: "--context <text>", description: "Additional context" },
          { flag: "--project <slug>", description: "Project slug" },
          { flag: "--night <date>", description: "Attach decision to a specific overnight run YYYY-MM-DD" },
          { flag: "--at <when>", description: "When decided: YYYY-MM-DD (00:00 UTC) or an ISO date-time with a zone; default now" },
        ],
        examples: ['overnight decide "Skip cache" --what "Bypass Redis" --why "Stale reads" --night 2026-11-21'],
      },
      summary: {
        summary: "Append a bullet to a section of the night's summary",
        usage: ["overnight summary <shipped|review|skipped|next> --add <line> [--project <p>] [--date <d>]"],
        flags: [
          { flag: "--add <line>", description: "Bullet text to append (required)" },
          { flag: "--project <slug>", description: "Project slug" },
          { flag: "--date <date>", description: "Run date (defaults to latest run)" },
        ],
        examples: ['overnight summary shipped --add "Merged PR #42"'],
      },
      show: {
        summary: "Display an overnight summary and its decisions",
        usage: ["overnight show [--project <p>] [--date <YYYY-MM-DD>]"],
        flags: [
          { flag: "--project <slug>", description: "Project slug" },
          { flag: "--date <date>", description: "Run date (defaults to latest run)" },
        ],
        examples: ["overnight show --project app"],
      },
      list: {
        summary: "List overnight runs and optionally validate summary headings",
        usage: ["overnight list [--project <p>] [--since <YYYY-MM-DD>] [--check]"],
        flags: [
          { flag: "--project <slug>", description: "Project slug" },
          { flag: "--since <date>", description: "Include runs on/after YYYY-MM-DD" },
          { flag: "--check", description: "Exit 1 if any run summary has malformed headings" },
        ],
        examples: ["overnight list --check"],
      },
      backfill: {
        summary: "Date each decision imported from the wayfinder reviews to its night",
        usage: ["overnight backfill [--project <p>] [--dry-run]"],
        flags: [
          { flag: "--project <slug>", description: "Only this project's decisions" },
          { flag: "--dry-run", description: "Print what would change and write nothing" },
        ],
        examples: ["overnight backfill --dry-run", "overnight backfill"],
        notes: ["Sets decided_at to <night>T00:00:00Z from the overnight:<night> tag. Running it again changes nothing."],
      },
    },
    examples: ["overnight start", "overnight show", "overnight list --check"],
  },

  // --- Spinoffs & Agents ---
  spinoff: {
    section: "Spinoffs & Agents",
    summary: "Dispatch, inspect, hand off, and clean up builder worktrees",
    usage: [
      "spinoff <ticket|#issue> [--repo <slug|path>] [--complexity <1-10>] [--effort <e>] [flags]",
      "spinoff <subcommand> [args]",
    ],
    acceptsPositional: true,
    subcommandAliases: { ready: "handoff" },
    subcommands: {
      queue: {
        summary: "Enqueue a spinoff row without launching it immediately",
        usage: ["spinoff queue <ticket|#issue> [--repo <slug|path>] [--complexity <1-10>] [--effort <e>]"],
        flags: [
          { flag: "--repo <p>", description: "Target repo path or org/name slug" },
          { flag: "--branch <name>", description: "Explicit git branch name" },
          { flag: "--worktree <dir>", description: "Explicit existing worktree path" },
          { flag: "--launcher <l>", description: "Launcher (t3)" },
          { flag: "--complexity <n>", description: "Score 1-10 that picks the builder model (default 5)" },
          { flag: "--tier <tier>", description: "Old alias: simple=2, medium=5, complex=8" },
          { flag: "--effort <lvl>", description: "low, medium, high, xhigh, or max" },
          { flag: "--opus-high <q>", description: "Owner ask quote required for Opus high+ effort" },
          { flag: "--brief <path>", description: "Brief file or '-' for stdin" },
          { flag: "-m, --note <why>", description: "Complexity rationale recorded on the Decisions trail" },
          { flag: "--holder <id>", description: "Dispatch under an existing ticket/worktree lease" },
          { flag: "--no-check <why>", description: "Override the drilled-ticket dispatch gate" },
          { flag: "--no-flake-slot <w>", description: "Bypass the machine-wide flake:slot lease" },
          { flag: "--over-usage <why>", description: "Override the >=95% weekly usage gate" },
          { flag: "--allow-paused <w>", description: "Queue a paused or archived project's ticket" },
          { flag: "--no-trial", description: "Launch a single build during an active model trial" },
        ],
        examples: ["spinoff queue APP-12 --complexity 5"],
      },
      drain: {
        summary: "Reclaim lapsed claims, reconcile landed work, and launch queued rows",
        usage: ["spinoff drain [--repo <slug|path> | --all] [--holder <id>] [--note <why>]"],
        flags: [
          { flag: "--repo <p>", description: "Drain queued rows for a specific repo" },
          { flag: "--all", description: "Drain queued rows across all repos" },
          { flag: "--holder <id>", description: "Drain under an existing lease holder" },
          { flag: "-m, --note <why>", description: "Note recorded on transitions" },
        ],
        examples: ["spinoff drain", "spinoff drain --all"],
      },
      reconcile: {
        summary: "Mark merged/closed spinoffs landed and mirror T3 run state",
        usage: ["spinoff reconcile [--holder <id>] [--note <why>]"],
        flags: [
          { flag: "--holder <id>", description: "Treat this holder's lease as the reviewer's own" },
          { flag: "-m, --note <why>", description: "Note recorded on landed rows" },
        ],
        examples: ["spinoff reconcile"],
        notes: [
          "Matches landing commits on origin/main past base_sha (never chart/docs notes).",
          "Mirrors live T3 run states onto existing agent rows without overwriting workflow status.",
        ],
      },
      watch: {
        summary: "Block watching local SQLite DB dir for newly landed/handed-off rows",
        usage: ["spinoff watch [--once]"],
        flags: [{ flag: "--once", description: "Exit 0 after reporting the first new completion" }],
        examples: ["spinoff watch --once"],
        notes: ["SQLite-only; under Postgres use 'ob spinoff list --status landed'."],
      },
      handoff: {
        summary: "Hand a finished builder row to the sentinel or architect for gating",
        usage: ["spinoff handoff [<ticket|id>] [--note <summary>] [--report <file>] [--tier-fit <r>]"],
        flags: [
          { flag: "-m, --note <text>", description: "One-line summary recorded on the Decisions trail" },
          { flag: "--report <file>", description: "Attach Done check and review report to the trail" },
          { flag: "--tier-fit <r>", description: "Builder tier rating: lower, right, or higher" },
          { flag: "--tier-fit-why <t>", description: "One-line reason for the tier-fit rating" },
          { flag: "--no-note", description: "Stamp handed-off without queueing a team notification" },
          { flag: "--ci-unchecked <w>", description: "Override unreadable CI with a recorded reason" },
        ],
        examples: [
          'spinoff handoff APP-12 --note "Added unit tests" --tier-fit right --tier-fit-why "Fit well"',
        ],
        notes: [
          "Alias: 'spinoff ready'. Releases builder ticket/worktree leases; needs-human does not block.",
          "Refuses dirty worktrees, missing checkouts, already-landed rows, or failing/pending PR CI.",
          "Repeat handoff on an already handed-off row with a removed checkout still releases builder leases.",
        ],
      },
      state: {
        summary: "Record a clean public repo's verdict and gate line on its spinoff row",
        usage: ["spinoff state <ticket|id> <landable|needs-human|blocked|partial> [--reason <r>] [--gate <g>]"],
        flags: [
          { flag: "--reason <line>", description: "Short reason for needs-human, blocked, or partial" },
          { flag: "--gate <line>", description: "Gate summary and skeptical-review tally" },
        ],
        examples: ['spinoff state APP-12 landable --gate "moon gate green; skeptical-review: 0 open"'],
      },
      phase: {
        summary: "Set a spinoff row's role phase inside its status",
        usage: ["spinoff phase <ticket|id> <reviewing|pr_ci|updating_pr|gating|owner_merge_call>"],
        notes: [
          "building holds reviewing, pr_ci and updating_pr; handed-off holds gating and owner_merge_call.",
          "Any other status holds no phase.",
          "A phase the status does not hold is refused (exit 1, 409) and logged for 'ob machine audit'.",
          "handoff sets gating and sendback sets updating_pr; every other move clears it.",
          "A needs-human verdict (before or after the handoff) sets owner_merge_call.",
        ],
        examples: ["spinoff phase APP-12 reviewing", "spinoff phase APP-12 pr_ci --json"],
      },
      mix: {
        summary: "Report the dispatch mix by complexity band (1-3, 4-6, 7-10) against the 50/30/20 target",
        usage: ["spinoff mix [--since <date>]"],
        flags: [{ flag: "--since <date>", description: "Include rows requested on/after YYYY-MM-DD" }],
        examples: ["spinoff mix --since 2026-11-01"],
      },
      abandon: {
        summary: "Retire a launched-but-unbuilt spinoff without marking it landed",
        usage: ["spinoff abandon <row-id|ticket> [--note <why>] [--force]"],
        flags: [
          { flag: "-m, --note <why>", description: "Reason stored on the abandoned row" },
          { flag: "--force", description: "Abandon even if commits exist past base_sha or thread will not settle" },
        ],
        examples: ['spinoff abandon APP-12 --note "Wrong repo"'],
        notes: ["Interrupts the T3 thread, releases builder leases, and refuses rows with commits past base_sha."],
      },
      sendback: {
        summary: "Return a handed-off spinoff to its builder with feedback",
        usage: ['spinoff sendback <ticket|id> --note "<what to fix>" [--over-usage <why>]'],
        flags: [
          { flag: "-m, --note <text>", description: "Feedback queued to the builder thread (required)" },
          { flag: "--over-usage <why>", description: "Override the >=95% weekly usage gate" },
        ],
        examples: ['spinoff sendback APP-12 --note "Fix failing lint check"'],
      },
      resume: {
        summary: "Move a handed-off spinoff back to building; the work continues on the same row",
        usage: ['spinoff resume <row|ticket> --note "<the work that continues>"'],
        flags: [{ flag: "-m, --note <text>", description: "The work that continues, recorded on the ticket trail (required)" }],
        examples: ['spinoff resume APP-12 --note "design doc merged; building the rest"'],
        notes: ["Not a send-back: clears the phase and sends no note to the builder.", "The row leaves the sentinel inbox."],
      },
      reopen: {
        summary: "Move an erroneously landed spinoff row back to building",
        usage: ['spinoff reopen <row|ticket> --note "<why>"'],
        flags: [{ flag: "-m, --note <why>", description: "Reason recorded on the ticket trail (required)" }],
        examples: ['spinoff reopen APP-12 --note "PR was not merged yet"'],
      },
      gateable: {
        summary: "List handed-off spinoffs with verdicts, file coverage, and rebuild targets",
        usage: ["spinoff gateable [--team <name>]"],
        flags: [{ flag: "--team <name>", description: "Filter to projects belonging to a team" }],
        examples: ["spinoff gateable", "spinoff gateable --team core --json"],
        notes: ["Computes rebuild targets from the locked path table and local git diffs."],
      },
      trial: {
        summary: "Run and score blind A/B model trials across paired spinoff builds",
        usage: [
          "spinoff trial start --target <n> --a <model> --b <model> [--range <a-b>] [--name <n>]",
          "spinoff trial status | stop | report",
          "spinoff trial pair <ticket|#pair> [--diffs <dir>]",
          "spinoff trial record <ticket|#pair> (--x <s> --y <s> | --forfeit <X|Y> | --void)",
          "spinoff trial feedback <ticket|#pair> --label <X|Y> --note <t> [--rating <1-5>]",
          "spinoff trial fix <ticket|#pair> --note <t>",
        ],
        flags: [
          { flag: "--target <n>", description: "Number of paired builds in the trial" },
          { flag: "--a <model>", description: "Leg A <provider:model>[#effort]" },
          { flag: "--b <model>", description: "Leg B <provider:model>[#effort]" },
          { flag: "--a-price <csv>", description: "Leg A list prices: in,out,cw,cr per million tokens" },
          { flag: "--b-price <csv>", description: "Leg B list prices: in,out,cw,cr per million tokens" },
          { flag: "--range <a-b>", description: "Complexity range to pair (default 4-6)" },
          { flag: "--tier <tier>", description: "Old alias for its band: 1-3, 4-6 or 7-10" },
          { flag: "--name <name>", description: "Optional trial name" },
          { flag: "--diffs <dir>", description: "Write blind X.diff and Y.diff files into <dir>" },
          { flag: "--x <score>", description: "Blind score for X (0-10, blocked, or partial)" },
          { flag: "--y <score>", description: "Blind score for Y (0-10, blocked, or partial)" },
          { flag: "--notes <file>", description: "JSON scoring notes file for record" },
          { flag: "--forfeit <X|Y>", description: "Score the named stale leg 0" },
          { flag: "--void", description: "Void a pair so it does not count toward target" },
          { flag: "--reason <why>", description: "Reason when voiding a pair" },
          { flag: "--label <X|Y>", description: "Blind label for feedback" },
          { flag: "--rating <1-5>", description: "Owner feedback rating" },
          { flag: "-m, --note <text>", description: "Feedback or fix note" },
        ],
        examples: ["spinoff trial status", "spinoff trial pair APP-12 --diffs /tmp/pair"],
      },
      show: {
        summary: "Display full detail, model, T3 ids, verdict, and brief for one row",
        usage: ["spinoff show <ticket|id>"],
        examples: ["spinoff show APP-12", "spinoff show 42 --json"],
      },
      list: {
        summary: "List spinoff rows with status, launcher, engine, and token totals",
        usage: ["spinoff list [--status <s>] [--team <name>]"],
        flags: [
          { flag: "--status <s>", description: "queued, launching, building, handed-off, landed, or failed" },
          { flag: "--team <name>", description: "Filter to projects belonging to a team" },
        ],
        examples: ["spinoff list", "spinoff list --status building --team core"],
      },
      check: {
        summary: "Record architect and reviewer sheets to pass the pre-dispatch gate",
        usage: ["spinoff check <ref> --architect <json|file> --reviewer <json|file> [--resolutions <json|file>]"],
        flags: [
          { flag: "--architect <j>", description: "Architect readiness JSON or file path (required)" },
          { flag: "--reviewer <j>", description: "Independent reviewer JSON or file path (required; old name --checker)" },
          { flag: "--resolutions <j>", description: "JSON list of resolutions for reviewer questions" },
        ],
        examples: ["spinoff check APP-12 --architect arch.json --reviewer review.json"],
        notes: ["Exit 0 on go, exit 1 on no-go; --questions-resolved is retired in favor of --resolutions."],
      },
      overlap: {
        summary: "Preview the files a ticket shares with live spinoff rows in its repo, without launching",
        usage: ["spinoff overlap <ticket> [--repo <p|slug>] [--json]"],
        flags: [
          { flag: "--repo <p>", description: "The repo to compare in (default: the ticket's live row, else its project)" },
          { flag: "--json", description: "Script output: rows, paths and declared_only" },
        ],
        examples: ["spinoff overlap APP-12", "spinoff overlap APP-12 --json"],
        notes: [
          "Compares the ticket's go check files with each live row's files and its pushed branch's diff.",
          "Dispatch prints the same lines, records one overlap decision and launches anyway. Always exits 0.",
        ],
      },
      conflicts: {
        summary: "Test-merge the running builders' pushed branches and list the pairs that do not merge",
        usage: ["spinoff conflicts [--repo <p|slug>] [--json]"],
        flags: [
          { flag: "--repo <p>", description: "Check one repo only (default: every repo with two or more running rows)" },
          { flag: "--json", description: "Script output: conflicts (with key and line), unpushed and warnings" },
        ],
        examples: ["spinoff conflicts", "spinoff conflicts --repo omnislash --json"],
        notes: [
          "Runs git merge-tree on each pair of fetched origin/<branch> heads in this machine's checkout.",
          "Lockfile-only conflicts and unpushed branches are skipped; a git failure warns.",
          "Records nothing and exits 0; role tick posts each pair to the team's sentinel.",
        ],
      },
      brief: {
        summary: "Print the launch brief that spinoff would send without launching",
        usage: ["spinoff brief <ticket> [--repo <p>] [--branch <b>] [--brief <path>]"],
        flags: [
          { flag: "--repo <p>", description: "Target repo path or slug" },
          { flag: "--branch <name>", description: "Override derived branch name" },
          { flag: "--brief <path>", description: "Custom brief file or '-'" },
        ],
        examples: ["spinoff brief APP-12"],
      },
      cleanup: {
        summary: "Remove clean, merged builder worktrees and local branches",
        usage: ["spinoff cleanup [--repo <path>] [--dry-run] [--force]"],
        flags: [
          { flag: "--repo <path>", description: "Checkout path to clean" },
          { flag: "--dry-run", description: "Preview removals without deleting anything" },
          { flag: "--force", description: "Also remove dirty/unmerged worktrees (still skips live/leased ones)" },
        ],
        examples: ["spinoff cleanup --dry-run", "spinoff cleanup"],
      },
      claim: {
        summary: "Server-side atomic claim moving one queued row to launching",
        usage: ["spinoff claim --id <n> [--holder <id>]"],
        flags: [
          { flag: "--id <n>", description: "Spinoff row id (required)" },
          { flag: "--holder <id>", description: "Lease holder id" },
        ],
        examples: ["spinoff claim --id 42 --json"],
      },
      stamp: {
        summary: "Server-side stamp recording launch outcome, engine, and T3 ids",
        usage: ["spinoff stamp --id <n> --outcome launched|failed [--worktree <p>] [--engine <e>] [flags]"],
        flags: [
          { flag: "--id <n>", description: "Spinoff row id (required)" },
          { flag: "--outcome <o>", description: "launched or failed (required)" },
          { flag: "--worktree <dir>", description: "Worktree path" },
          { flag: "--base-sha <sha>", description: "Base commit SHA" },
          { flag: "--launcher <l>", description: "Launcher name" },
          { flag: "--session <id>", description: "Harness session id" },
          { flag: "--engine <eng>", description: "Harness engine (claude or opencode)" },
          { flag: "--t3-thread <id>", description: "T3 thread id" },
          { flag: "--t3-run <id>", description: "T3 run id" },
          { flag: "--model <id>", description: "Resolved model id" },
          { flag: "--effort <text>", description: "Stamped effort description" },
          { flag: "--raised", description: "Mark complexity as raised (urgent, to 7 or more)" },
          { flag: "--error <msg>", description: "Error text when --outcome failed" },
          { flag: "-m, --note <why>", description: "Note recorded on the ticket trail" },
        ],
        examples: ["spinoff stamp --id 42 --outcome launched --engine claude --t3-thread t1"],
      },
      land: {
        summary: "Server-side write marking a building/handed-off row landed with tokens",
        usage: ["spinoff land --id <n> [--total-tokens <n>] [--pr-url <url>] [--note <why>]"],
        flags: [
          { flag: "--id <n>", description: "Spinoff row id (required)" },
          { flag: "--input-tokens <n>", description: "Input token count" },
          { flag: "--output-tokens <n>", description: "Output token count" },
          { flag: "--cache-creation-tokens <n>", description: "Cache creation token count" },
          { flag: "--cache-read-tokens <n>", description: "Cache read token count" },
          { flag: "--total-tokens <n>", description: "Total token count" },
          { flag: "--pr-url <url>", description: "Merged PR recorded on the landed event (else read with gh)" },
          { flag: "-m, --note <why>", description: "Note recorded on the ticket trail" },
        ],
        examples: ["spinoff land --id 42 --total-tokens 120000"],
      },
      tokens: {
        summary: "Backfill missing token totals on landed rows from local transcripts",
        usage: ["spinoff tokens backfill [--since <date>] [--dry-run]"],
        flags: [
          { flag: "--since <date>", description: "Only rows launched on/after YYYY-MM-DD" },
          { flag: "--dry-run", description: "Preview recoverable token counts without writing" },
        ],
        examples: ["spinoff tokens backfill --dry-run"],
      },
      reclaim: {
        summary: "Reclaim rows whose launch claim lease lapsed before stamping",
        usage: ["spinoff reclaim"],
        examples: ["spinoff reclaim"],
      },
    },
    flags: [
      { flag: "--repo <p>", description: "Repo path or org/name slug (defaults to ticket project, else cwd)" },
      { flag: "--branch <name>", description: "Explicit git branch name" },
      { flag: "--worktree <dir>", description: "Existing worktree checkout path" },
      { flag: "--launcher <l>", description: "Launcher override (only t3 is routable)" },
      { flag: "--complexity <n>", description: "Score 1-10 that picks the builder model (default 5; urgent raises it to 7)" },
      { flag: "--tier <tier>", description: "Old alias: simple=2, medium=5, complex=8; not with --complexity" },
      { flag: "--effort <lvl>", description: "low, medium, high, xhigh, or max" },
      { flag: "--opus-high <q>", description: "Owner ask quote required for Opus at high+ effort" },
      { flag: "--brief <path>", description: "Custom brief file or '-' for stdin" },
      { flag: "-m, --note <why>", description: "Complexity rationale recorded on the Decisions trail" },
      { flag: "--holder <id>", description: "Dispatch under an existing lease holder" },
      { flag: "--no-check <why>", description: "Override the drilled-ticket dispatch gate" },
      { flag: "--no-flake-slot <w>", description: "Launch a flake ticket without taking the flake:slot lease" },
      { flag: "--over-usage <why>", description: "Override the >=95% weekly usage gate (terminal only)" },
      { flag: "--allow-paused <w>", description: "Dispatch a paused or archived project's ticket; the reason goes on the trail" },
      { flag: "--no-trial", description: "Run a single build while a model trial is active" },
    ],
    examples: [
      "spinoff APP-12 --complexity 5",
      "spinoff gateable --team core",
      "spinoff handoff APP-12 --tier-fit right --tier-fit-why 'Clean fit'",
    ],
    notes: [
      "Enqueues, claims, opens/adopts a T3 thread, and stamps in one command.",
      "Flake tickets take the machine-wide flake:slot lease unless --no-flake-slot is passed.",
    ],
  },

  agent: {
    section: "Spinoffs & Agents",
    summary: "Register agent status, send heartbeats, check liveness, and finish runs",
    usage: [
      "agent register [flags]",
      "agent heartbeat <id>",
      "agent active [--within <min>]",
      "agent done <id> [--no-lease] [--note <why>]",
    ],
    subcommands: {
      register: {
        summary: "Write agent registry status and claim ticket/worktree leases",
        usage: ["agent register [--id <id>] [--ticket <ref>] [--status <s>] [--note <text>] [flags]"],
        flags: [
          { flag: "--id <id>", description: "Builder or role agent id (e.g. branch name)" },
          { flag: "--ticket <ref>", description: "Ticket ref to claim ticket:<ref> lease" },
          { flag: "--worktree <dir>", description: "Worktree path to claim worktree:<dir> lease" },
          { flag: "--branch <name>", description: "Git branch name" },
          { flag: "--status <s>", description: "planning, working, readying, needs-human, or blocked" },
          { flag: "-m, --note <text>", description: "Short status payload or question for needs-human" },
          { flag: "--launcher <l>", description: "Where the agent lives (t3)" },
          { flag: "--session <id>", description: "Harness session or T3 thread id" },
          { flag: "--ttl <sec>", description: "Lease TTL in seconds" },
          { flag: "--holder <id>", description: "Register under an existing compatible lease holder" },
          { flag: "--no-lease", description: "Skip acquiring ticket/worktree leases" },
          { flag: "--spawn-failed", description: "Report a launch that produced no session" },
        ],
        examples: ['agent register --id app-12 --ticket APP-12 --status working --note "Building"'],
        notes: [
          "Register ≠ launch: writes registry state only; only 'ob spinoff' launches agents.",
          "On a T3 thread, --status needs-human prefixes the thread title with 🙋.",
        ],
      },
      heartbeat: {
        summary: "Refresh an agent's row TTL and its live leases",
        usage: ["agent heartbeat <id>"],
        examples: ["agent heartbeat app-12"],
      },
      active: {
        summary: "Report whether any agent heartbeated within a recent window",
        usage: ["agent active [--within <min>]"],
        flags: [{ flag: "--within <min>", description: "Liveness window in minutes (default 20)" }],
        examples: ["agent active", "agent active --within 15 --json"],
      },
      done: {
        summary: "Clear an agent row and release leases it acquired",
        usage: ["agent done <id> [--no-lease] [--note <why>]"],
        flags: [
          { flag: "--no-lease", description: "Clear the registry row without releasing leases" },
          { flag: "-m, --note <why>", description: "Note recorded on the ticket trail" },
        ],
        examples: ["agent done app-12"],
        notes: ["Never releases an inherited architect hold."],
      },
    },
    examples: ['agent register --id app-12 --status working --note "Running tests"', "agent active --within 15"],
  },

  agents: {
    section: "Spinoffs & Agents",
    summary: "List active agents across launchers or reset registry state",
    usage: ["agents [--all]", "agents reset [--dry-run]"],
    subcommands: {
      reset: {
        summary: "WIPE the agent registry and release every lease (no --yes prompt)",
        usage: ["agents reset [--dry-run]"],
        flags: [{ flag: "--dry-run", description: "Preview every agent and lease that would be cleared" }],
        examples: ["agents reset --dry-run", "agents reset"],
        notes: [
          "Bare 'agents reset' mutates immediately with no --yes confirmation.",
          "Live processes stay up; spinoff rows, items, and worktrees are untouched.",
        ],
      },
    },
    flags: [{ flag: "--all", description: "Include expired agent rows" }],
    examples: ["agents", "agents --all", "agents reset --dry-run"],
  },

  lease: {
    section: "Spinoffs & Agents",
    summary: "Acquire, run commands under, heartbeat, and release resource leases",
    usage: ["lease [status]", "lease <subcommand> [args]"],
    subcommands: {
      status: {
        summary: "List held and recently expired leases",
        usage: ["lease [status]"],
        examples: ["lease status"],
      },
      acquire: {
        summary: "Acquire a TTL mutex on a resource key",
        usage: ["lease acquire <resource> [--ttl <sec>] [--wait] [--holder <id>]"],
        flags: [
          { flag: "--ttl <sec>", description: "Lease duration in seconds (default 1200)" },
          { flag: "--wait", description: "Wait until the resource is free" },
          { flag: "--holder <id>", description: "Stable holder id (default <pid>@<host>)" },
        ],
        examples: ["lease acquire ticket:APP-12 --holder architect-core --ttl 1800"],
        notes: ["Key classes: ticket:, worktree:, port:, app:, spinoff:, cpu:, flake:slot."],
      },
      run: {
        summary: "Hold a lease (or TaskSlash slot) while running a command",
        usage: ["lease run <resource> [--holder <id>] [--ttl <sec>] [--max <sec>] -- <command...>"],
        flags: [
          { flag: "--holder <id>", description: "Stable holder id" },
          { flag: "--ttl <sec>", description: "Lease TTL in seconds (default 300)" },
          { flag: "--max <sec>", description: "Maximum runtime cap in seconds (1-600 for cpu:*)" },
        ],
        examples: ["lease run cpu:browser -- bunx playwright test"],
        notes: [
          "Always releases on exit or signal; cpu:* runs cap at 10m and use TaskSlash when available.",
          "Escapes finite RLIMIT_RTTIME via systemd-run when needed (OB_LEASE_RUN_ESCAPE=0 disables).",
        ],
      },
      heartbeat: {
        summary: "Extend a live lease you currently hold",
        usage: ["lease heartbeat <resource> [--holder <id>]"],
        flags: [{ flag: "--holder <id>", description: "Holder id used when acquiring" }],
        examples: ["lease heartbeat ticket:APP-12 --holder app-12"],
      },
      release: {
        summary: "Release a lease held by --holder (or force-break a dead holder)",
        usage: ["lease release <resource> [--holder <id>] [--force] [--note <why>]"],
        flags: [
          { flag: "--holder <id>", description: "Must match the --holder used on acquire" },
          { flag: "--force", description: "Break a live hold belonging to a dead session" },
          { flag: "-m, --note <why>", description: "Record forced release reason on the ticket trail" },
        ],
        examples: ["lease release port:5100 --holder app-12"],
      },
    },
    examples: ["lease status", "lease run cpu:browser -- bunx playwright test"],
  },

  ports: {
    section: "Spinoffs & Agents",
    summary: "Inspect or claim a LAN dev server port in 5100-5199",
    usage: ["ports [--all]", "ports next [--holder <id>] [--ticket <ref>] [--ttl <sec>]"],
    subcommands: {
      next: {
        summary: "Lease the lowest free port and print its LAN URL",
        usage: ["ports next [--holder <id>] [--ticket <ref>] [--ttl <sec>]"],
        flags: [
          { flag: "--holder <id>", description: "Lease holder id (defaults to lowercase --ticket)" },
          { flag: "--ticket <ref>", description: "Ticket ref to derive holder id" },
          { flag: "--ttl <sec>", description: "Lease TTL in seconds (default 28800)" },
        ],
        examples: ["ports next -q --holder app-12"],
        notes: ["Start dev servers with --host --port $PORT --strictPort so LAN devices can reach them."],
      },
    },
    flags: [{ flag: "--all", description: "List every port instead of collapsing free ranges" }],
    examples: ["ports", "ports next --holder app-12"],
  },

  // --- T3 & Teams ---
  t3: {
    section: "T3 & Teams",
    summary: "Manage T3 Code auth, teams, role threads, broadcasts, and status",
    usage: ["t3 [doctor]", "t3 <subcommand> [args]"],
    subcommands: {
      doctor: {
        summary: "Check T3 server reachability, auth, projects, and providers",
        usage: ["t3 [doctor]"],
        examples: ["t3 doctor"],
      },
      login: {
        summary: "Mint or renew the local T3 MCP OAuth credential",
        usage: ["t3 login [--ttl <ttl>] [--access <level>] [--base-url <url>]"],
        flags: [
          { flag: "--ttl <ttl>", description: "Requested token TTL" },
          { flag: "--access <level>", description: "MCP access level (default full-access)" },
          { flag: "--base-url <url>", description: "Non-default T3 server base URL" },
        ],
        examples: ["t3 login"],
      },
      team: {
        summary: "Create, edit, inspect, hand off, restart and message project teams",
        usage: [
          "t3 team add <name> [--projects <a,b>] [--icon <e>] [--display-name <t>]",
          "t3 team edit <name> [--icon <e>] [--display-name <t>]",
          "t3 team join <name> <project>... | t3 team leave <project>...",
          "t3 team list | t3 team show <name> | t3 team rm <name> [--force]",
          "t3 team handoff <team> --role <r> (--body <t>|--body-file <f>|--show)",
          "t3 team restart <team>|--all [--role <r>] [--force] [--timeout <min>]",
          "t3 team forward [<team>] [--role <r>] [--thread <id>] (--body <t>|--body-file <f>)",
        ],
        flags: [
          { flag: "--projects <csv>", description: "Initial member projects for team add" },
          { flag: "--icon <emoji>", description: "Team icon label" },
          { flag: "--display-name <t>", description: "Team display name" },
          { flag: "--role <role>", description: "architect, sentinel, or muse (comma-list on restart)" },
          { flag: "--body <text>", description: "Handoff body text" },
          { flag: "--body-file <file>", description: "Read handoff body from a file" },
          { flag: "--show", description: "Print the latest stored handoff for a role" },
          { flag: "--all", description: "Restart all teams" },
          { flag: "--force", description: "Force remove team or interrupt busy threads on restart" },
          { flag: "--timeout <min>", description: "Minutes to wait for handoff on restart (default 15)" },
          { flag: "--thread <id>", description: "forward: a thread id you had; retired ones are redirected, others refused" },
        ],
        examples: [
          "t3 team list",
          "t3 team join core web api",
          "t3 team handoff core --role architect --show",
          "t3 team forward core --role sentinel --body-file note.md",
        ],
      },
      architect: {
        summary: "Ensure or adopt a team's pinned architect thread",
        usage: ["t3 architect [<team>] [--thread <id>]"],
        flags: [{ flag: "--thread <id>", description: "Adopt an existing live T3 thread" }],
        examples: ["t3 architect core", "t3 architect --thread mcp:launch:abc"],
      },
      sentinel: {
        summary: "Ensure, adopt, or remove a team's sentinel thread",
        usage: ["t3 sentinel <team> [--thread <id>]", "t3 sentinel <team> --remove"],
        flags: [
          { flag: "--thread <id>", description: "Adopt an existing live T3 thread" },
          { flag: "--remove", description: "Unbind the sentinel role and unpin its thread" },
        ],
        examples: ["t3 sentinel core", "t3 sentinel core --remove"],
      },
      muse: {
        summary: "Ensure, adopt, or remove a team's muse thread",
        usage: ["t3 muse <team> [--thread <id>]", "t3 muse <team> --remove"],
        flags: [
          { flag: "--thread <id>", description: "Adopt an existing live T3 thread" },
          { flag: "--remove", description: "Unbind the muse role and unpin its thread" },
        ],
        examples: ["t3 muse core", "t3 muse core --remove"],
      },
      broadcast: {
        summary: "Queue one message to all active architects or all active threads",
        usage: [
          't3 broadcast architects "<msg>" [--message-file <path>] [--dry-run]',
          't3 broadcast threads "<msg>" [--message-file <path>] [--dry-run]',
        ],
        flags: [
          { flag: "--message-file <p>", description: "Read broadcast message from a file" },
          { flag: "--dry-run", description: "List recipients without sending" },
        ],
        examples: ['t3 broadcast architects "Freeze merges for deploy" --dry-run'],
      },
      status: {
        summary: "Show T3 health, active threads, and threads needing attention",
        usage: ["t3 status"],
        examples: ["t3 status", "t3 status --json"],
      },
      projects: {
        summary: "List live registered T3 projects and default models",
        usage: ["t3 projects"],
        examples: ["t3 projects"],
      },
      tree: {
        summary: "Display the T3 thread hierarchy joined to ob tickets and roles",
        usage: ["t3 tree [--subagents]"],
        flags: [{ flag: "--subagents", description: "Include delegated subagent child threads" }],
        examples: ["t3 tree", "t3 tree --subagents"],
      },
      open: {
        summary: "Resolve a ticket or thread id and print its t3-thread:// link",
        usage: ["t3 open <ticket|thread-id>"],
        examples: ["t3 open APP-12 -q"],
      },
    },
    examples: ["t3 doctor", "t3 status", "t3 team list"],
    notes: ["Every t3 subcommand refuses flags it does not read with exit 2."],
  },

  role: {
    section: "T3 & Teams",
    summary: "Manage team role runs, start briefs, successor notes, and ticks",
    usage: ["role <subcommand> [args]"],
    subcommands: {
      start: {
        summary: "Reuse or start the single live run for a team role",
        usage: ["role start <team> <architect|sentinel|muse>"],
        examples: ["role start core architect"],
      },
      status: {
        summary: "Show open role runs, live T3 status, and last context size",
        usage: ["role status <team> [<role>]"],
        examples: ["role status core", "role status core sentinel --json"],
      },
      end: {
        summary: "Settle and unpin a role run's thread and release its lease",
        usage: ["role end <team> <role> [--reason idle|context|gone|manual|superseded]"],
        flags: [{ flag: "--reason <r>", description: "End reason: idle, context, gone, manual (default), superseded" }],
        examples: ["role end core architect --reason manual"],
      },
      brief: {
        summary: "Print the computed start brief for a team role",
        usage: ["role brief <team> <role> [--peek]"],
        flags: [{ flag: "--peek", description: "Print the waiting successor note without marking it shown" }],
        examples: ["role brief core architect --peek"],
      },
      note: {
        summary: "Store a capped successor note (<=40 lines, <=4000 chars) on the role run",
        usage: ['role note <team> <role> (--body "<text>" | --body-file <path>)'],
        flags: [
          { flag: "--body <text>", description: "Successor note text" },
          { flag: "--body-file <p>", description: "Read successor note from a file" },
        ],
        examples: ["role note core architect --body-file note.md"],
      },
      tick: {
        summary: "Run one pass checking stale builders/flakes/idle repos/branch conflicts and ending quiet runs",
        usage: ["role tick [--team <t>[,<t>...]]"],
        flags: [{ flag: "--team <csv>", description: "Limit tick pass to named team(s)" }],
        examples: ["role tick", "role tick --team core"],
      },
    },
    examples: ["role status core", "role brief core architect --peek", "role tick"],
  },

  send: {
    section: "T3 & Teams",
    summary: "Store a message in a team role's inbox and deliver it to its run",
    usage: ['send <team> <role> "<text>" [--body-file <path>] [--from <id>] [--no-deliver]'],
    flags: [
      { flag: "--body-file <p>", description: "Read message text from a local file" },
      { flag: "--from <id>", description: "Sender identifier (default owner)" },
      { flag: "--no-deliver", description: "Store in inbox without delivering or starting a run" },
    ],
    examples: ['send core architect "Prioritize APP-12 next"'],
    notes: ["Role must be architect or a bound role on the team."],
  },

  inbox: {
    section: "T3 & Teams",
    summary: "List or mark read messages in a team role's inbox",
    usage: [
      "inbox <team> <role> [--all]",
      "inbox <team> <role> --read <id> [<id>...] --by <run|agent-id>",
    ],
    flags: [
      { flag: "--all", description: "Include read and withdrawn messages" },
      { flag: "--read <id>", description: "First message id to mark read (more follow positionally)" },
      { flag: "--by <id>", description: "Reader run or agent id (required with --read)" },
    ],
    examples: ["inbox core architect", "inbox core architect --read 10 11 --by role-run-5"],
  },

  // --- Reviews & Models ---
  review: {
    section: "Reviews & Models",
    summary: "Run a ticket's skeptical review; configure its readers per complexity",
    usage: ["review run <ticket> [--complexity <1-10>] [--answers <file>]", "review readers [--complexity <1-10>]", "review readers set|rm|range ..."],
    subcommands: {
      run: {
        summary: "Gate, one reader, two more only if round 1 calls for it; records legs",
        usage: ["review run <ticket> [--complexity <1-10>] [--json]", "review run <ticket> --answers <file>"],
        flags: [
          { flag: "--complexity <n>", description: "The row's score (default: `ob spinoff show`'s, else 5); picks the round-1 reader" },
          { flag: "--answers <file>", description: "The rebuttal round: '## <leg>' sections of fixed:/rebutted: answers to the previous round" },
          { flag: "--json", description: "Print the run record" },
        ],
        examples: ["review run <ticket>", "review run <ticket> --answers answers.md"],
        notes: [
          "Fixed steps: mark the row reviewing, run `ob gate run` (red stops it), then round 1's one reader.",
          "Escalates on a failed leg, no score, a wrong, an unproven or a score under 8, to one more reader.",
          "The extra reader is Opus only, never neon or a fallback: another Opus reader, else a second seat (opus-2).",
          "Legs run through review-leg.ts with OB_REVIEW_RUN_ID; tokens are read back from review-legs.jsonl.",
          "Briefs and findings: <git dir>/ob-review/<ticket>/<run id>/. Records: review-runs.jsonl.",
        ],
      },
      readers: {
        summary: "List or edit skeptical-review readers and the complexity ranges they run on",
        usage: [
          "review readers [--complexity <1-10>]",
          "review readers set <leg> --model <id>",
          "review readers rm <leg>",
          "review readers range <from-to> <leg>...",
        ],
        flags: [
          { flag: "--complexity <n>", description: "The readers a row scored n runs (the range covering n)" },
          { flag: "--tier <tier>", description: "Old spelling: simple, medium, complex read as scores 2, 5, 8" },
          { flag: "--model <id>", description: "Model id for 'review readers set'" },
        ],
        examples: [
          "review readers --complexity 7 -q",
          "review readers set opus --model claude-opus-5-5",
          "review readers range 4-6 neon opus",
        ],
        notes: [
          "The ranges cover 1-10 with no gap and no overlap; a range you set is carved out of the ones it overlaps.",
          "'tier <simple|medium|complex>' is the old spelling of the ranges 1-3, 4-6 and 7-10, kept for one release.",
          "Default when unset: opus on every score, no fallback (readers are Opus only).",
        ],
      },
    },
    examples: ["review run <ticket>", "review readers", "review readers --complexity 5 -q"],
  },

  machine: {
    section: "System",
    summary: "Audit rows against the lifecycle machines, read-only",
    usage: ["machine audit [--json] [--since <date>] [--stale-days N]"],
    subcommands: {
      audit: {
        summary: "List unresolvable statuses, stale spinoff rows and would-refuse events",
        usage: ["machine audit [--json] [--since <date>] [--stale-days N]"],
        flags: [
          { flag: "--since <date>", description: "Would-refuse events from this date or ISO time (default 7 days ago)" },
          { flag: "--stale-days <n>", description: "A launching/launched row unmoved this many days is stale (default 7)" },
          { flag: "--json", description: "Print {unresolvable, stale, wouldRefuse}" },
        ],
        examples: ["machine audit", "machine audit --stale-days 14 --since 2026-11-01 --json"],
        notes: ["Changes nothing and always exits 0."],
      },
    },
    examples: ["machine audit"],
  },

  "review-miss": {
    section: "Reviews & Models",
    summary: "Log and rank defects missed during code review",
    usage: ['review-miss add --pr <url> --class <tag> "<finding>"', "review-miss top [--scope <s>]"],
    subcommands: {
      add: {
        summary: "Record a review miss against a PR and defect class",
        usage: ['review-miss add --pr <url> --class <tag> "<finding>"'],
        flags: [
          { flag: "--pr <url>", description: "Pull request URL" },
          { flag: "--class <tag>", description: "Defect classification tag" },
        ],
        examples: ['review-miss add --pr https://github.com/org/repo/pull/9 --class race "Missing lock"'],
      },
      top: {
        summary: "Show most frequent review-miss classes",
        usage: ["review-miss top [--scope <scope>]"],
        flags: [{ flag: "--scope <scope>", description: "Optional scope filter" }],
        examples: ["review-miss top"],
      },
    },
    examples: ["review-miss top"],
  },

  tournament: {
    section: "Reviews & Models",
    summary: "Run and record blind persona-scored candidate tournaments",
    usage: ["tournament <subcommand> [args]"],
    subcommands: {
      add: {
        summary: "Create a new tournament with scoring criteria",
        usage: ["tournament add --subject <text> --repo <slug> --criteria <a,b,...> [--ref <ticket>]"],
        flags: [
          { flag: "--subject <text>", description: "Tournament subject (required)" },
          { flag: "--repo <slug>", description: "Repository slug (required)" },
          { flag: "--criteria <csv>", description: "Comma-separated scoring criteria (required)" },
          { flag: "--ref <ticket>", description: "Optional related ticket ref" },
        ],
        examples: ['tournament add --subject "Hero layout" --repo site --criteria clarity,hierarchy'],
      },
      candidate: {
        summary: "Register or update a tournament candidate and its images",
        usage: ["tournament candidate <id> <key> [--label <t>] [--image <path>]... [--revises <key>]"],
        flags: [
          { flag: "--label <text>", description: "Human label for the candidate" },
          { flag: "--image <path>", description: "Repo-relative image path (repeatable)" },
          { flag: "--revises <key>", description: "Prior candidate key this one revises" },
        ],
        examples: ['tournament candidate 1 a --label "Warm card" --image shots/a.png'],
      },
      record: {
        summary: "Validate and store one match JSON result file",
        usage: ["tournament record <id> --match <file> [--replace]"],
        flags: [
          { flag: "--match <file>", description: "Path to match result JSON file (required)" },
          { flag: "--replace", description: "Overwrite an existing match with the same name" },
        ],
        examples: ["tournament record 1 --match round1.json"],
      },
      pick: {
        summary: "Record the owner's final pick between finalists",
        usage: ["tournament pick <id> <candidate> [--note <why>]"],
        flags: [{ flag: "-m, --note <why>", description: "Optional rationale for the pick" }],
        examples: ['tournament pick 1 b --note "Stronger hierarchy"'],
      },
      list: {
        summary: "List tournaments",
        usage: ["tournament list [--repo <slug>]"],
        flags: [{ flag: "--repo <slug>", description: "Filter by repository slug" }],
        examples: ["tournament list"],
      },
      show: {
        summary: "Show tournament criteria, candidates, matches, and finalists",
        usage: ["tournament show <id>"],
        examples: ["tournament show 1 --json"],
      },
    },
    examples: ["tournament list", "tournament show 1"],
  },

  models: {
    section: "Reviews & Models",
    summary: "Which model runs every use: routes, profiles, chains, review readers",
    usage: ["models [show|get|set|unset|use|reader|sync-favorites|list|init|legs]"],
    subcommands: {
      show: {
        summary: "Print the active profile and every route, labelled local, server or default",
        usage: ["models [show] [--json]"],
        examples: ["models show", "models show --json"],
      },
      get: {
        summary: "Print the model a route runs now (first chain entry under its weekly limit)",
        usage: ["models get <route>"],
        examples: ["models get sweep.first", "models get builder.4-6"],
      },
      set: {
        summary: "Set a route's fallback chain (and effort) in a server profile",
        usage: ["models set <route> <model>[,<model>...] [--effort <level>] [--profile <p>]"],
        flags: [
          { flag: "--effort <level>", description: "low, medium, high, xhigh or max" },
          { flag: "--profile <p>", description: "The profile to write (default: the active one, else 'default')" },
        ],
        examples: ["models set builder.4-6 claudeAgent:claude-opus-5-5,antigravity:gemini-4-neon", "models set job.nightly claude-haiku-5-5 --effort low"],
      },
      unset: {
        summary: "Remove a route from a server profile (it falls back to its default)",
        usage: ["models unset <route> [--profile <p>]"],
        examples: ["models unset builder.4-6"],
      },
      use: {
        summary: "Make a profile active on the server (a local active wins on its machine)",
        usage: ["models use <profile>"],
        examples: ["models use claude"],
      },
      reader: {
        summary: "Add or remove a review reader, or set the readers a complexity range runs",
        usage: ["models reader add <leg> <model>", "models reader remove <leg>", "models reader range <from-to> <leg>... (old: reader tier <tier>)"],
        flags: [{ flag: "--profile <p>", description: "The profile to write (default: the active one)" }],
        examples: ["models reader add glm glm-5.3-flash", "models reader range 1-3 glm"],
      },
      "sync-favorites": {
        summary: "Store this machine's T3 favourite models on the server",
        usage: ["models sync-favorites [--json]"],
        examples: ["models sync-favorites"],
      },
      list: {
        summary: "List this machine's models-file profiles and mark its active one",
        usage: ["models list"],
        examples: ["models list"],
      },
      init: {
        summary: "Copy models.example.jsonc to ~/.config/ob/models.jsonc",
        usage: ["models init"],
        examples: ["models init"],
      },
      legs: {
        summary: "Summarize skeptical-review leg latency, failures, and timeouts",
        usage: ["models legs [--days <n>]"],
        flags: [{ flag: "--days <n>", description: "Trailing UTC days to include (default 14)" }],
        examples: ["models legs --days 7"],
      },
    },
    examples: ["models show", "models get sweep.first", "models use claude", "models legs"],
    notes: [
      "Builder routes: builder.<from>-<to>, covering 1-10; builder.simple|medium|complex read 1-3, 4-6, 7-10.",
      "The dashboard's Models page edits, splits and merges the builder and review ranges as rows.",
      "Routes: builder.*, reviewer, role.<role>, sweep.first|escalate, subagent.explore|fixup, job.<name>.",
      "Precedence: the local models file, then the server's model_routes, then the default.",
      "builder.* and role.* routes need <provider>:<model>: set refuses a bare id, show flags one stored.",
      "A launch moves along a route's chain only on a credit or quota error.",
      "On a client, reads and writes go to the API server; OB_MODELS_FILE moves the local file.",
    ],
  },
  "api-token": {
    section: "System",
    summary: "Issue, list and revoke read-only API tokens scoped to named projects",
    usage: ["api-token add|list|revoke"],
    subcommands: {
      add: {
        summary: "Issue a token for <user>, printed once; only its sha256 is kept",
        usage: ["api-token add <user> --project <p>[,<p>...]"],
        flags: [{ flag: "--project <p>[,<p>...]", description: "The projects the token reaches (names or ids)" }],
        examples: ["api-token add alice --project omnislash"],
      },
      list: {
        summary: "Print each scoped user with its projects and families (never a hash)",
        usage: ["api-token list [--json]"],
        examples: ["api-token list", "api-token list --json"],
      },
      revoke: {
        summary: "Remove a user's token; the API refuses it on the next request",
        usage: ["api-token revoke <user>"],
        examples: ["api-token revoke alice"],
      },
    },
    notes: [
      "File: ~/.ob_api_tokens.json (OB_API_TOKENS_FILE moves it), mode 0600 or every scoped token is refused.",
      "GET only on items, next, search and projects, filtered to its projects; other routes are 403.",
      "Runs on this machine only: the API host reads the file on every request.",
    ],
  },

  usage: {
    section: "Reviews & Models",
    summary: "Inspect local Claude token usage and weekly pacing",
    usage: ["usage day [--since <iso>] [--until <iso>] [--compare] [--limit <n>]"],
    subcommands: {
      day: {
        summary: "Summarize token usage by model, class, project, and session",
        usage: ["usage day [--since <iso>] [--until <iso>] [--compare] [--limit <n>]"],
        flags: [
          { flag: "--since <iso>", description: "Window start timestamp (default last 24h)" },
          { flag: "--until <iso>", description: "Window end timestamp (default now)" },
          { flag: "--compare", description: "Compare against the immediately preceding equal window" },
          { flag: "--limit <n>", description: "Top projects/sessions to display (default 10)" },
        ],
        examples: ["usage day", "usage day --compare --limit 5"],
      },
    },
    examples: ["usage day --compare"],
    notes: ["Reads local transcripts (~/.claude/projects) and the active profile's T3 weekly cache."],
  },

  vision: {
    section: "Reviews & Models",
    summary: "Run local mlx-vlm layout and chrome-tone screenshot comparisons",
    usage: [
      "vision compare <left> <right> [--as design|old|flag] [--design <path>] [--no-enforce]",
      "vision compare --as old|design --on <before> <after> --off <before> <after> [--design <p>]",
    ],
    subcommands: {
      compare: {
        summary: "Compare UI screenshots locally for layout and chrome-tone diffs",
        usage: [
          "vision compare <left> <right> [--as design|old|flag] [--design <path>] [--no-enforce]",
          "vision compare --as old|design --on <b1> <a1> --off <b0> <a0> [--design <path>]",
        ],
        flags: [
          { flag: "--as <mode>", description: "Comparison mode: design, old, or flag" },
          { flag: "--design <path>", description: "Design mockup image to match against" },
          { flag: "--on <b a>", description: "Before/after image pair with feature flag on" },
          { flag: "--off <b a>", description: "Before/after image pair with feature flag off" },
          { flag: "--no-enforce", description: "Print diffs and exit 0 after a successful model run" },
        ],
        examples: ["vision compare before.png after.png --as design"],
      },
    },
    examples: ["vision compare mockup.png actual.png --as design"],
    notes: ["Runs locally via mlx-vlm; images never leave this machine."],
  },

  // --- Deploy & Ops ---
  deploy: {
    section: "Deploy & Ops",
    summary: "Check deploy status, record deploys, and trigger live deploys",
    usage: ["deploy status", "deploy run [--sha <sha>] [--ssh]", "deploy record [flags]"],
    subcommands: {
      status: {
        summary: "Show deployed SHA, host, unit, and last result per target",
        usage: ["deploy status"],
        examples: ["deploy status", "deploy status --json"],
      },
      run: {
        summary: "Trigger fire-and-forget live deploy via API (or --ssh fallback)",
        usage: ["deploy run [--sha <sha>] [--ssh]"],
        flags: [
          { flag: "--sha <sha>", description: "Pin deploy to an exact commit SHA (7+ chars)" },
          { flag: "--ssh", description: "Last-resort SSH kick when the API is down" },
        ],
        examples: ["deploy run --sha 82ecccc"],
      },
      record: {
        summary: "Record a deploy attempt outcome for a target (called by deploy scripts)",
        usage: ["deploy record --target <t> --host <h> --unit <u> --sha <s> --result <r> [--at <iso>]"],
        flags: [
          { flag: "--target <name>", description: "Deploy target name (required)" },
          { flag: "--host <host>", description: "Target host (required)" },
          { flag: "--unit <unit>", description: "Service unit name (required)" },
          { flag: "--sha <sha>", description: "Deployed git SHA (required)" },
          { flag: "--result <res>", description: "ok, rolled-back, or refused (required)" },
          { flag: "--at <iso>", description: "Explicit ISO timestamp" },
        ],
        examples: ["deploy record --target live --host srv --unit omnislash-web --sha 82ecccc --result ok"],
      },
    },
    examples: ["deploy status", "deploy run --sha 82ecccc"],
  },

  web: {
    section: "Deploy & Ops",
    summary: "Build and serve the OB dashboard (or another app) with optional TLS",
    usage: ["web [--bind <addr>] [--port <n>] [--prebuilt] [--app <name>] [--tls-cert <p> --tls-key <p>]"],
    flags: [
      { flag: "--bind <addr>", description: "Bind address (default 127.0.0.1; OMNISLASH_WEB_BIND)" },
      { flag: "--port <n>", description: "HTTP/HTTPS listener port (default 5050)" },
      { flag: "--prebuilt", description: "Serve existing dist/ without running a build" },
      { flag: "--app <name>", description: "Serve apps/<name> instead of apps/ob-dashboard" },
      { flag: "--tls-cert <pem>", description: "TLS PEM certificate chain (requires --tls-key)" },
      { flag: "--tls-key <pem>", description: "TLS PEM private key (requires --tls-cert)" },
    ],
    examples: ["web", "web --prebuilt --bind 10.0.0.2"],
    notes: ["Refuses to start if TLS is configured with a missing or mismatched cert/key."],
  },

  cert: {
    section: "Deploy & Ops",
    summary: "Inspect or renew the LAN TLS certificate via DNS-01",
    usage: ["cert status", "cert renew [--force] [--staging] [--wait]"],
    subcommands: {
      status: {
        summary: "Check served and installed TLS cert expiry, permissions, and key match",
        usage: ["cert status"],
        examples: ["cert status --json"],
      },
      renew: {
        summary: "Issue or renew the TLS certificate via lego DNS-01",
        usage: ["cert renew [--force] [--staging] [--wait]"],
        flags: [
          { flag: "--force", description: "Renew even when not near expiry" },
          { flag: "--staging", description: "Use Let's Encrypt staging CA for rehearsals" },
          { flag: "--wait", description: "Wait for the API host job to finish" },
        ],
        examples: ["cert renew --staging --wait"],
      },
    },
    examples: ["cert status", "cert renew --wait"],
  },

  daemon: {
    section: "Deploy & Ops",
    summary: "Install, uninstall, or check the client role-tick scheduler",
    usage: ["daemon install | uninstall | status"],
    subcommands: {
      install: {
        summary: "Install the 15-minute client role-tick timer (launchd or systemd user)",
        usage: ["daemon install"],
        examples: ["daemon install"],
      },
      uninstall: {
        summary: "Remove the installed client timer",
        usage: ["daemon uninstall"],
        examples: ["daemon uninstall"],
      },
      status: {
        summary: "Show installed client scheduler status",
        usage: ["daemon status"],
        examples: ["daemon status"],
      },
    },
    examples: ["daemon status", "daemon install"],
  },

  db: {
    section: "Deploy & Ops",
    summary: "Postgres snapshots, backups, and refreshing a personal test copy",
    usage: [
      "db snapshot [flags]",
      "db fetch <snapshot> [--out <dir>] [--force]",
      "db backup [--dry-run]",
      "db clone [--target <db>] [--grant-role <role> | --no-grant] [--dry-run]",
    ],
    subcommands: {
      clone: {
        summary: "Refresh a personal test copy of live Postgres from a fresh dump, grants included",
        usage: ["db clone [--target <db>] [--grant-role <role> | --no-grant] [--dry-run]"],
        flags: [
          { flag: "--target <db>", description: "Database to refresh (default: the profile's target)" },
          { flag: "--grant-role <role>", description: "Login role given read and write on the copy (default: the profile's grantRole)" },
          { flag: "--no-grant", description: "Grant no role on the copy" },
          { flag: "--dry-run", description: "Print the commands it would run; run nothing" },
        ],
        notes: [
          "Runs here, never via the ob API: pct on the Proxmox host, else the profile's ssh words.",
          "Profile: OB_DB_CLONE_FILE, else ~/.config/ob/db-clone.json (keys in the cli README).",
          "Installs the script when missing or stale, then runs it with OBPG_DB, OBPG_DEV_DB, OBPG_GRANT_ROLE.",
          "Refuses the live database, any protected name, postgres, template*, and the clone's own scratch names.",
        ],
        examples: ["db clone", "db clone --dry-run", "db clone --target scratch_copy --no-grant"],
      },
      snapshot: {
        summary: "Create or list rotated local pg_dump snapshots",
        usage: ["db snapshot [--dir <path>] [--keep-hourly <n>] [--keep-daily <n>] [--max-bytes <n>] [--list]"],
        flags: [
          { flag: "--dir <path>", description: "Snapshot output directory (refused over API)" },
          { flag: "--keep-hourly <n>", description: "Hourly snapshots to retain (default 24)" },
          { flag: "--keep-daily <n>", description: "Daily snapshots to retain (default 14)" },
          { flag: "--max-bytes <n>", description: "Total retention size cap in bytes (default 12 GiB)" },
          { flag: "--list", description: "List retained snapshots" },
          { flag: "--dry-run", description: "Preview without writing a dump" },
          { flag: "--wait", description: "Wait for the API host job to finish" },
        ],
        examples: ["db snapshot --list", "db snapshot --wait"],
      },
      fetch: {
        summary: "Download a snapshot from the API host to this machine (mode 0600)",
        usage: ["db fetch <snapshot> [--out <dir>] [--force]"],
        flags: [
          { flag: "--out <dir>", description: "Destination directory (default $TMPDIR/ob-db-snapshots)" },
          { flag: "--force", description: "Overwrite an existing local file" },
        ],
        examples: ["db fetch omnislash-2026-11-21.dump"],
      },
      backup: {
        summary: "Run off-machine backup to a private GitHub release (alias for backup)",
        usage: ["db backup [--dry-run] [--wait]"],
        flags: [
          { flag: "--dry-run", description: "Print planned command without running pg_dump" },
          { flag: "--wait", description: "Wait for the API host job to finish" },
        ],
        examples: ["db backup --dry-run"],
      },
    },
    examples: ["db snapshot --list", "db backup --dry-run", "db clone"],
  },

  backup: {
    section: "Deploy & Ops",
    summary: "Run off-machine Postgres backup to a private GitHub release",
    usage: ["backup [--dry-run] [--wait]"],
    flags: [
      { flag: "--dry-run", description: "Print the pg_dump command without writing a backup" },
      { flag: "--wait", description: "Wait for the API host job when run as an API client" },
    ],
    examples: ["backup --dry-run", "backup --wait"],
    notes: ["Verifies pg_dump with pg_restore --list and prunes releases older than 12 months."],
  },

  jobs: {
    section: "Deploy & Ops",
    summary: "Show scheduled job health and API host background jobs",
    usage: ["jobs", "jobs host [<id> | fetch <id>]"],
    subcommands: {
      host: {
        summary: "List, inspect, or fetch files from API host jobs (db/backup/cert/sync)",
        usage: ["jobs host", "jobs host <id>", "jobs host fetch <id>"],
        examples: ["jobs host", "jobs host 14"],
      },
    },
    examples: ["jobs", "jobs host"],
  },

  alerts: {
    section: "Deploy & Ops",
    summary: "List proactive alerts, print morning digest, or snooze an alert",
    usage: ["alerts [--digest [--notify]]", "alerts snooze <key>"],
    subcommands: {
      snooze: {
        summary: "Snooze an alert by its key",
        usage: ["alerts snooze <key>"],
        examples: ["alerts snooze job:gmail-sync"],
      },
    },
    flags: [
      { flag: "--digest", description: "Print the single-message morning summary" },
      { flag: "--notify", description: "Push action alerts or digest through Home Assistant" },
    ],
    examples: ["alerts", "alerts --digest --notify", "alerts snooze stale:APP-12"],
  },

  cloudflare: {
    section: "Deploy & Ops",
    summary: "Inspect Cloudflare zones, tunnel versions, and manage DNS records",
    usage: ["cloudflare zones", "cloudflare tunnels [--floor <ver>]", "cloudflare dns <list|add|rm> ..."],
    subcommands: {
      zones: {
        summary: "List Cloudflare zones accessible to the stored token",
        usage: ["cloudflare zones"],
        examples: ["cloudflare zones"],
      },
      tunnels: {
        summary: "Check cloudflared connector versions across tunnels (exit 1 if stale)",
        usage: ["cloudflare tunnels [--floor <version>]"],
        flags: [{ flag: "--floor <ver>", description: "Minimum acceptable cloudflared version (e.g. 2026.10.2)" }],
        examples: ["cloudflare tunnels --floor 2026.10.2"],
      },
      dns: {
        summary: "List, add, or remove DNS records in a zone (writes require --yes)",
        usage: [
          "cloudflare dns list <zone>",
          "cloudflare dns add <zone> <type> <name> <content> [--proxied] [--ttl <sec>] [--yes]",
          "cloudflare dns rm <zone> <record-id|name> [--yes]",
        ],
        flags: [
          { flag: "--proxied", description: "Enable Cloudflare proxy (A, AAAA, CNAME only)" },
          { flag: "--ttl <sec>", description: "TTL in seconds (1 for auto, or 60..86400)" },
          { flag: "-y, --yes", description: "Apply the DNS write (without --yes, performs a dry run)" },
        ],
        examples: ["cloudflare dns list example.com", "cloudflare dns add example.com A app 1.2.3.4 --yes"],
      },
    },
    examples: ["cloudflare zones", "cloudflare tunnels", "cloudflare dns list example.com"],
  },

  // --- Integrations ---
  sync: {
    section: "Integrations",
    summary: "Ingest GitHub PR events into the event store",
    usage: ["sync [--source github] [--since <when>] [--backfill]"],
    flags: [
      { flag: "--source <src>", description: "Event source to sync (github)" },
      { flag: "--since <when>", description: "Start window date or duration" },
      { flag: "--backfill", description: "Backfill historical PR data" },
    ],
    examples: ["sync --source github", "sync --source github --since 7d"],
    notes: ["Served over the API: runs on the API host using the stored GitHub token."],
  },

  ci: {
    section: "Integrations",
    summary: "Check latest GitHub Actions push runs on main across projects",
    usage: ["ci main [--project <slug>] [--notify]"],
    subcommands: {
      main: {
        summary: "Show latest completed push run on main per project workflow",
        usage: ["ci main [--project <slug>] [--notify]"],
        flags: [
          { flag: "--project <slug>", description: "Check a single project" },
          { flag: "--notify", description: "Notify the team's sentinel/architect on red runs and recovery" },
        ],
        examples: ["ci main", "ci main --project app --notify"],
      },
    },
    examples: ["ci main"],
  },

  github: {
    section: "Integrations",
    summary: "Audit or configure GitHub webhooks for tracked projects",
    usage: ["github hooks [--yes]"],
    subcommands: {
      hooks: {
        summary: "Check or repair project webhooks pointing at the ob webhook receiver",
        usage: ["github hooks [--yes]"],
        flags: [{ flag: "-y, --yes", description: "Create or update webhooks (dry run without --yes)" }],
        examples: ["github hooks", "github hooks --yes"],
      },
    },
    examples: ["github hooks"],
  },

  gmail: {
    section: "Integrations",
    summary: "Sync, search, read, draft, edit, and send Gmail messages",
    usage: ["gmail <subcommand> [args]"],
    subcommands: {
      sync: {
        summary: "Poll Gmail into the local/Postgres store",
        usage: ["gmail sync [--backfill] [--days <n>|--since <when>|--query <q>] [--max <n>]"],
        flags: [
          { flag: "--backfill", description: "Run bounded backfill (default last 30 days)" },
          { flag: "--days <n>", description: "Backfill window in days" },
          { flag: "--since <when>", description: "Start date for backfill" },
          { flag: "--query <q>", description: "Raw Gmail search query" },
          { flag: "--max <n>", description: "Max messages per run (default 500)" },
        ],
        examples: ["gmail sync", "gmail sync --backfill --days 14"],
      },
      search: {
        summary: "Full-text search over ingested email",
        usage: ["gmail search <query>"],
        examples: ['gmail search "invoice"'],
      },
      list: {
        summary: "List recent ingested emails",
        usage: ["gmail list [--since <when>] [--limit <n>]"],
        flags: [
          { flag: "--since <when>", description: "Only messages since date or duration" },
          { flag: "--limit <n>", description: "Max messages to list" },
        ],
        examples: ["gmail list --limit 20"],
      },
      read: {
        summary: "Read one email message and list its attachments",
        usage: ["gmail read <message-id>"],
        examples: ["gmail read 18c9a1b2c3d4"],
      },
      attachment: {
        summary: "Download attachments from a Gmail message to this machine",
        usage: ["gmail attachment <message-id> [--name <file>] [--out <dir>] [--force]"],
        flags: [
          { flag: "--name <file>", description: "Download only the named attachment" },
          { flag: "--out <dir>", description: "Output directory (default $TMPDIR/ob-gmail/<id>/)" },
          { flag: "--force", description: "Overwrite existing files" },
        ],
        examples: ["gmail attachment 18c9a1b2c3d4 --out ./downloads"],
      },
      draft: {
        summary: "Create a Gmail draft (never sends automatically)",
        usage: ["gmail draft --to <addr> [--subject <s>] (--body <t>|--body-file <f>) [--attach <f>]..."],
        flags: [
          { flag: "--to <addr>", description: "Recipient address (required)" },
          { flag: "--subject <text>", description: "Email subject" },
          { flag: "--body <text>", description: "Plain-text body" },
          { flag: "--body-file <f>", description: "Read body from a local file" },
          { flag: "--cc <addr>", description: "CC recipient(s)" },
          { flag: "--from <addr>", description: "Verified Gmail Send-as address" },
          { flag: "--reply-to <id>", description: "Thread onto an existing message id" },
          { flag: "--attach <file>", description: "Attach a local file (repeatable, 10 MB total)" },
        ],
        examples: ['gmail draft --to alice@example.com --subject "Update" --body "See attached."'],
      },
      drafts: {
        summary: "List Gmail drafts newest first",
        usage: ["gmail drafts [--limit <n>]"],
        flags: [{ flag: "--limit <n>", description: "Maximum drafts to list (default 20)" }],
        examples: ["gmail drafts"],
      },
      "draft-edit": {
        summary: "Modify an existing Gmail draft in place",
        usage: ["gmail draft-edit <draft-id> [--to <addr>] [--subject <s>] [--body <t>|--body-file <f>]"],
        flags: [
          { flag: "--from <addr>", description: "Replace Send-as address" },
          { flag: "--to <addr>", description: "Replace recipient" },
          { flag: "--cc <addr>", description: "Replace or clear ('') CC" },
          { flag: "--subject <text>", description: "Replace subject" },
          { flag: "--body <text>", description: "Replace body text" },
          { flag: "--body-file <f>", description: "Replace body from a local file" },
          { flag: "--attach <file>", description: "Replace attachments (repeatable)" },
          { flag: "--no-attach", description: "Remove all attachments" },
        ],
        examples: ['gmail draft-edit r123 --subject "Revised update"'],
      },
      "draft-delete": {
        summary: "Permanently delete a Gmail draft (requires --confirm)",
        usage: ["gmail draft-delete <draft-id> --confirm"],
        flags: [{ flag: "--confirm", description: "Required confirmation (prints preview without it)" }],
        examples: ["gmail draft-delete r123 --confirm"],
      },
      "send-draft": {
        summary: "Send an existing draft matching its preview hash",
        usage: ["gmail send-draft <draft-id> --confirm --hash <hex>"],
        flags: [
          { flag: "--confirm", description: "Required human confirmation" },
          { flag: "--hash <hex>", description: "Draft content hash printed by preview (required)" },
        ],
        examples: ["gmail send-draft r123 --confirm --hash a1b2c3d4"],
      },
    },
    examples: ["gmail list --limit 10", "gmail drafts", "gmail search invoice"],
    notes: ["Served over the API: runs on the host using stored secret 'google'."],
  },

  cal: {
    section: "Integrations",
    summary: "Sync Google Calendar events and view today's agenda",
    usage: ["cal sync [--backfill] [--since <when>] [--max <n>]", "cal agenda"],
    subcommands: {
      sync: {
        summary: "Poll Google Calendar into the store",
        usage: ["cal sync [--backfill] [--since <when>] [--max <n>]"],
        flags: [
          { flag: "--backfill", description: "Full sync over the window" },
          { flag: "--since <when>", description: "Widen sync start date (default 30d)" },
          { flag: "--max <n>", description: "Max events per calendar (default 500)" },
        ],
        examples: ["cal sync"],
      },
      agenda: {
        summary: "Print today's calendar events",
        usage: ["cal agenda"],
        examples: ["cal agenda"],
      },
    },
    examples: ["cal agenda", "cal sync"],
    notes: ["Served over the API: runs on the host using stored secret 'google'."],
  },

  agenda: {
    section: "Integrations",
    summary: "Print today's calendar agenda (shorthand for cal agenda)",
    usage: ["agenda"],
    examples: ["agenda", "agenda --json"],
  },

  google: {
    section: "Integrations",
    summary: "Authenticate Google OAuth locally or via hosted consent URL",
    usage: ["google auth [flags]", "google auth-url"],
    subcommands: {
      auth: {
        summary: "Run loopback OAuth on this machine and store secret 'google'",
        usage: ["google auth [--client <json> | --client-id <id> --client-secret <s>] [--scopes <csv>]"],
        flags: [
          { flag: "--client <file>", description: "Path to Google client_secret.json" },
          { flag: "--client-id <id>", description: "OAuth client id" },
          { flag: "--client-secret <s>", description: "OAuth client secret" },
          { flag: "--scopes <csv>", description: "Override default gmail.modify + calendar scopes" },
        ],
        examples: ["google auth --client client_secret.json"],
        notes: ["Split over API: runs browser/loopback on this machine and persists via host secret store."],
      },
      "auth-url": {
        summary: "Print a hosted OAuth authorize URL served by the API host",
        usage: ["google auth-url"],
        examples: ["google auth-url"],
        notes: ["Served over the API: mints a one-time state for tap-to-reauth on any device."],
      },
    },
    examples: ["google auth", "google auth-url"],
  },

  whatsapp: {
    section: "Integrations",
    summary: "Sync, search, send, and configure WhatsApp chats and bridge",
    usage: ["whatsapp <subcommand> [args]"],
    subcommands: {
      sync: {
        summary: "Ingest messages and receipts from the WhatsApp bridge",
        usage: ["whatsapp sync [--backfill] [--since <when>|--days <n>] [--max <n>]"],
        flags: [
          { flag: "--backfill", description: "Backfill older bridge history" },
          { flag: "--since <when>", description: "Start timestamp or date" },
          { flag: "--days <n>", description: "Number of days to backfill" },
          { flag: "--max <n>", description: "Max messages per run (default 2000)" },
        ],
        examples: ["whatsapp sync"],
      },
      search: {
        summary: "Full-text search over ingested WhatsApp messages",
        usage: ["whatsapp search <query>"],
        examples: ['whatsapp search "flight"'],
      },
      recent: {
        summary: "List most-recent ingested WhatsApp messages",
        usage: ["whatsapp recent [--limit <n>] [--since <when>]"],
        flags: [
          { flag: "--limit <n>", description: "Maximum messages to print" },
          { flag: "--since <when>", description: "Only messages since date or duration" },
        ],
        examples: ["whatsapp recent --limit 20"],
      },
      send: {
        summary: "Send a WhatsApp message or PDF/image attachment with confirmation",
        usage: ["whatsapp send --to <jid> (--body <text> | --file <path>...) [--yes] [--resend]"],
        flags: [
          { flag: "--to <jid>", description: "Recipient JID (required)" },
          { flag: "--body <text>", description: "Message text (or caption for first file)" },
          { flag: "--file <path>", description: "Attach PDF, jpg, or png (repeatable, <=11.9 MB each)" },
          { flag: "-y, --yes", description: "Skip interactive y/N confirmation prompt" },
          { flag: "--resend", description: "Send past a 24h unknown-outcome duplicate guard" },
        ],
        examples: ['whatsapp send --to 27820001111@s.whatsapp.net --body "On my way"'],
        notes: ["Confirmation always runs on this terminal before any send request is made."],
      },
      bridge: {
        summary: "Manage the local Go WhatsApp bridge lifecycle or check status",
        usage: ["whatsapp bridge run | start | stop | status"],
        examples: ["whatsapp bridge status"],
        notes: ["Over the API only 'status' is served; run/start/stop belong to the server host."],
      },
      bio: {
        summary: "Show, set, or clear the global self-bio for suggested replies",
        usage: ["whatsapp bio [<text>]", "whatsapp bio --clear"],
        flags: [{ flag: "--clear", description: "Remove the stored self-bio" }],
        examples: ['whatsapp bio "Short and direct"'],
      },
      hide: {
        summary: "Hide a chat JID from the dashboard feed",
        usage: ["whatsapp hide <chat_jid>"],
        examples: ["whatsapp hide 12345@g.us"],
      },
      show: {
        summary: "Un-hide a chat JID or list currently hidden chats",
        usage: ["whatsapp show [<chat_jid>]"],
        examples: ["whatsapp show", "whatsapp show 12345@g.us"],
      },
      "ai-off": {
        summary: "Disable AI-suggested replies for a chat",
        usage: ["whatsapp ai-off <chat_jid>"],
        examples: ["whatsapp ai-off 12345@g.us"],
      },
      "ai-on": {
        summary: "Re-enable AI-suggested replies for a chat",
        usage: ["whatsapp ai-on <chat_jid>"],
        examples: ["whatsapp ai-on 12345@g.us"],
      },
      favorite: {
        summary: "Favorite a chat JID or list favorited chats",
        usage: ["whatsapp favorite [<chat_jid>]"],
        examples: ["whatsapp favorite"],
      },
      unfavorite: {
        summary: "Remove favorite status from a chat JID",
        usage: ["whatsapp unfavorite <chat_jid>"],
        examples: ["whatsapp unfavorite 12345@g.us"],
      },
    },
    examples: ["whatsapp recent --limit 10", "whatsapp bridge status"],
    notes: ["Served over the API: search/recent/send/prefs/status talk to the API host; send confirms here."],
  },

  slack: {
    section: "Integrations",
    summary: "Read previously ingested Slack messages (read-only)",
    usage: ["slack unread [--limit <n>]"],
    subcommands: {
      unread: {
        summary: "List ingested unread Slack messages",
        usage: ["slack unread [--limit <n>]"],
        flags: [{ flag: "--limit <n>", description: "Maximum messages to show" }],
        examples: ["slack unread --limit 20"],
      },
    },
    examples: ["slack unread"],
  },

  person: {
    section: "Integrations",
    summary: "Manage people directory records and communication handles",
    usage: ["person <add|set|list|show|rm> [args]"],
    subcommands: {
      add: {
        summary: "Add a person record",
        usage: ['person add "<real name>" [--role <r>] [--github <h>] [--email <e>] [flags]'],
        flags: [
          { flag: "--role <role>", description: "Role or title" },
          { flag: "--github <handle>", description: "GitHub username" },
          { flag: "--linear <id>", description: "Linear user id" },
          { flag: "--linear-name <n>", description: "Linear display name" },
          { flag: "--slack <id>", description: "Slack user id" },
          { flag: "--slack-handle <h>", description: "Slack handle" },
          { flag: "--whatsapp-jid <j>", description: "WhatsApp JID" },
          { flag: "--email <addr>", description: "Email address" },
          { flag: "--notes <text>", description: "General notes" },
          { flag: "--relationship <r>", description: "Relationship label" },
          { flag: "--comms-style <s>", description: "Communication style" },
          { flag: "--comms-notes <t>", description: "Communication notes" },
          { flag: "--id-number <id>", description: "SA identity number (masked on all outputs)" },
        ],
        examples: ['person add "Jane Doe" --github janedoe --email jane@example.com'],
      },
      set: {
        summary: "Update fields on an existing person record",
        usage: ["person set <id> [--role <r>] [--github <h>] [--email <e>] [same flags as add]"],
        flags: [
          { flag: "--role <role>", description: "Role or title" },
          { flag: "--github <handle>", description: "GitHub username" },
          { flag: "--email <addr>", description: "Email address" },
          { flag: "--whatsapp-jid <j>", description: "WhatsApp JID" },
          { flag: "--notes <text>", description: "General notes" },
          { flag: "--id-number <id>", description: "SA identity number (masked on all outputs)" },
        ],
        examples: ["person set 3 --github janedoe"],
      },
      list: {
        summary: "List all people in the directory",
        usage: ["person list"],
        examples: ["person list"],
      },
      show: {
        summary: "Show one person by id, handle, or name",
        usage: ["person show <id|handle|name> [--reveal]"],
        flags: [{ flag: "--reveal", description: "Print unmasked --id-number (hidden by default)" }],
        examples: ["person show janedoe"],
      },
      rm: {
        summary: "Remove a person record",
        usage: ["person rm <id>"],
        examples: ["person rm 3"],
      },
    },
    examples: ["person list", "person show janedoe"],
    notes: ["Served over the API. Identity numbers are masked unless 'person show --reveal' is used."],
  },

  whois: {
    section: "Integrations",
    summary: "Resolve a GitHub, Linear, Slack handle, or email to a person",
    usage: ["whois <handle>"],
    examples: ["whois janedoe", "whois jane@example.com"],
  },

  // --- System ---
  config: {
    section: "System",
    summary: "Read or update tracker configuration key/value pairs",
    usage: ["config", "config get <key>", "config set <key> <value>"],
    subcommands: {
      get: {
        summary: "Print a single configuration value",
        usage: ["config get <key>"],
        examples: ["config get spinoff_engine"],
      },
      set: {
        summary: "Set a configuration value",
        usage: ["config set <key> <value>"],
        examples: ["config set spinoff_engine claude"],
      },
    },
    examples: ["config", "config get spinoff_engine", "config set wayfinder_repo org/repo"],
    notes: ["Over the API, reads/writes the server config table (remote_host is refused)."],
  },

  cursor: {
    section: "System",
    summary: "Get or set per-skill opaque cursor values",
    usage: ["cursor get <skill> <key>", "cursor set <skill> <key> <value>"],
    subcommands: {
      get: {
        summary: "Read a stored skill cursor value",
        usage: ["cursor get <skill> <key>"],
        examples: ["cursor get sync last_id"],
      },
      set: {
        summary: "Write a stored skill cursor value",
        usage: ["cursor set <skill> <key> <value>"],
        examples: ["cursor set sync last_id 42"],
      },
    },
    examples: ["cursor get sync last_id"],
  },

  secret: {
    section: "System",
    summary: "Store, retrieve, list, and delete AES-256-GCM encrypted secrets",
    usage: ["secret <set|get|list|rm|import> [name]"],
    subcommands: {
      set: {
        summary: "Encrypt and store a secret value read from stdin",
        usage: ["secret set <name>"],
        examples: ['printf "%s" "$TOKEN" | ob secret set github'],
      },
      get: {
        summary: "Decrypt and print a stored secret value",
        usage: ["secret get <name>"],
        examples: ["secret get github"],
      },
      list: {
        summary: "List secret names and ages (never prints values)",
        usage: ["secret list"],
        examples: ["secret list"],
      },
      rm: {
        summary: "Delete a stored secret",
        usage: ["secret rm <name>"],
        examples: ["secret rm old-token"],
      },
      import: {
        summary: "Import legacy local token files into the encrypted store (local only)",
        usage: ["secret import"],
        examples: ["secret import"],
      },
    },
    examples: ["secret list", "secret get github"],
    notes: ["Over the API, set/get/list/rm travel over HTTPS while decryption stays on the host."],
  },

  creds: {
    section: "System",
    summary: "List credential inventory and verify live credential health",
    usage: ["creds", "creds check (<name> | --all)"],
    subcommands: {
      check: {
        summary: "Verify one credential or all credentials against their providers",
        usage: ["creds check <name>", "creds check --all"],
        flags: [{ flag: "--all", description: "Check every credential in the inventory" }],
        examples: ["creds check github", "creds check --all"],
        notes: ["Exits 1 if any checked credential is FAILED and records the verdict."],
      },
    },
    examples: ["creds", "creds check --all"],
  },

  gate: {
    section: "System",
    summary: "Run the repo's gate.json, cached by commit and file hash (CI runs it)",
    usage: ["gate run [--force] [--json]"],
    subcommands: {
      run: {
        summary: "Run gate.json's steps in order; stop at the first that fails",
        usage: ["gate run", "gate run --force"],
        flags: [
          { flag: "--force", description: "Run even when this sha and gate.json hash have a stored result, and store the new one" },
          { flag: "--json", description: "Print the result: sha, file_hash, ok, failed, steps with exit and wall time, cached" },
        ],
        examples: ["gate run", "gate run --force"],
      },
    },
    notes: [
      'gate.json at the repo root: {"steps": [{"name", "run", "env"?}]}; each run is a bash command.',
      "Results are stored in <git common dir>/ob-gate/ by HEAD sha and gate.json hash, red ones too.",
      "A second run at the same pair prints the stored result and runs nothing.",
      "A dirty worktree is run and never stored. Exit 1 on red. Needs no tracker.",
    ],
    examples: ["gate run"],
  },

  skills: {
    section: "System",
    summary: "Check the skill links in ~/.claude/skills against the omnislash copies",
    usage: ["skills doctor [--fix] [--json]"],
    subcommands: {
      doctor: {
        summary: "One line per link into omnibus or omnislash: <name> <target> same|differs|omnibus-only",
        usage: ["skills doctor", "skills doctor --fix"],
        flags: [{ flag: "--fix", description: "Repoint a differing link at omnislash, only when omnislash's last commit is newer" }],
        examples: ["skills doctor", "skills doctor --fix"],
      },
    },
    notes: [
      "Checkouts: the repo_checkouts setting, else ~/dev/omnibus and ~/dev/omnislash. Honours HOME.",
      "A link omnibus is newer on is listed, not changed; omnibus-only links are left alone.",
      "Nothing else is written.",
    ],
    examples: ["skills doctor"],
  },

  "test-user": {
    section: "System",
    summary: "Manage test-account registry entries and encrypted credentials",
    usage: ["test-user <add|list|show|check> [args]"],
    subcommands: {
      add: {
        summary: "Register a test user (reads secret value from stdin)",
        usage: ["test-user add <label> [--role <r>] [--email <e>] [--workspace <w>] [--env <e>]"],
        flags: [
          { flag: "--role <role>", description: "Test account role" },
          { flag: "--email <addr>", description: "Test account email" },
          { flag: "--workspace <w>", description: "Workspace name" },
          { flag: "--env <env>", description: "Target environment" },
          { flag: "--secret-ref <r>", description: "Secret store key override" },
          { flag: "--notes <text>", description: "Additional notes" },
        ],
        examples: ['printf "pass" | ob test-user add smoke-admin --role admin --env staging'],
      },
      list: {
        summary: "List registered test users",
        usage: ["test-user list"],
        examples: ["test-user list"],
      },
      show: {
        summary: "Show metadata for a test user",
        usage: ["test-user show <label>"],
        examples: ["test-user show smoke-admin"],
      },
      check: {
        summary: "Verify a test user's stored secret is present",
        usage: ["test-user check <label>"],
        examples: ["test-user check smoke-admin"],
      },
    },
    examples: ["test-user list", "test-user check smoke-admin"],
  },
};

function formatAlignedRows(rows: readonly (readonly [string, string])[], minColWidth = 14): string[] {
  const maxKey = rows.reduce((acc, [key]) => Math.max(acc, key.length), minColWidth);
  const colWidth = maxKey + 2;
  return rows.map(([key, desc]) => `  ${key.padEnd(colWidth)}${desc}`);
}

export function renderRootHelp(): string {
  const lines: string[] = [
    "ob — OmniSlash personal task tracker",
    "",
    "Usage: ob <command> [args] [flags]",
  ];

  const entries = Object.entries(COMMAND_HELP);
  const maxCmdLen = entries.reduce((acc, [name]) => Math.max(acc, name.length), 12);

  for (const section of HELP_SECTIONS) {
    const group = entries.filter(([, meta]) => meta.section === section);
    if (group.length === 0) continue;
    lines.push("", `${section}:`);
    for (const [name, meta] of group) {
      lines.push(`  ${name.padEnd(maxCmdLen + 2)}${meta.summary}`);
    }
  }

  lines.push(
    "",
    "Global flags:",
    ...formatAlignedRows(
      GLOBAL_FLAGS.map((f) => [f.flag, f.description] as const),
      14,
    ),
    "",
    "More:",
    "  ob <command> --help               Show command usage, flags, subcommands, and examples",
    "  ob help <command> [subcommand]    Show help for a command or subcommand",
    "  ob help env                       Show OMNISLASH_* and OB_* environment variables",
    "  Exit codes: 0 ok/help, 1 runtime error, 2 usage error",
  );

  return lines.join("\n");
}

function formatExample(example: string): string {
  return /\bob\s/.test(example) ? example : `ob ${example}`;
}

export function renderCommandHelp(command: string): string {
  if (!Object.hasOwn(COMMAND_HELP, command)) {
    throw new Error(`unknown command '${command}'`);
  }
  const meta = COMMAND_HELP[command]!;
  const lines: string[] = [`ob ${command} — ${meta.summary}`, "", "Usage:"];
  for (const u of meta.usage) {
    lines.push(`  ob ${u}`);
  }

  if (meta.subcommands) {
    const subEntries = Object.entries(meta.subcommands);
    lines.push(
      "",
      "Subcommands:",
      ...formatAlignedRows(
        subEntries.map(([sub, info]) => [sub, info.summary] as const),
        12,
      ),
    );
  }

  if (meta.flags && meta.flags.length > 0) {
    lines.push(
      "",
      "Flags:",
      ...formatAlignedRows(
        meta.flags.map((f) => [f.flag, f.description] as const),
        14,
      ),
    );
  }

  if (meta.examples && meta.examples.length > 0) {
    lines.push("", "Examples:");
    for (const ex of meta.examples) {
      lines.push(`  ${formatExample(ex)}`);
    }
  }

  if (meta.notes && meta.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of meta.notes) {
      lines.push(`  - ${note}`);
    }
  }

  if (meta.subcommands) {
    lines.push("", `Run 'ob ${command} <subcommand> --help' for subcommand details.`);
  }

  return lines.join("\n");
}

export function renderSubcommandHelp(command: string, subcommand: string): string {
  if (!Object.hasOwn(COMMAND_HELP, command)) {
    throw new Error(`unknown command '${command}'`);
  }
  const meta = COMMAND_HELP[command]!;
  if (!meta.subcommands || !Object.hasOwn(meta.subcommands, subcommand)) {
    throw new Error(`unknown subcommand '${subcommand}' for 'ob ${command}'`);
  }
  const sub = meta.subcommands[subcommand]!;
  const lines: string[] = [`ob ${command} ${subcommand} — ${sub.summary}`, "", "Usage:"];
  for (const u of sub.usage) {
    lines.push(`  ob ${u}`);
  }

  if (sub.flags && sub.flags.length > 0) {
    lines.push(
      "",
      "Flags:",
      ...formatAlignedRows(
        sub.flags.map((f) => [f.flag, f.description] as const),
        14,
      ),
    );
  }

  if (sub.examples && sub.examples.length > 0) {
    lines.push("", "Examples:");
    for (const ex of sub.examples) {
      lines.push(`  ${formatExample(ex)}`);
    }
  }

  if (sub.notes && sub.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of sub.notes) {
      lines.push(`  - ${note}`);
    }
  }

  return lines.join("\n");
}

export function renderEnvHelp(): string {
  const lines: string[] = [
    "ob environment variables",
    "",
    ...formatAlignedRows(
      ENV_VARS.map((v) => [v.name, v.description] as const),
      26,
    ),
    "",
    "Run 'ob --help' to list commands.",
  ];
  return lines.join("\n");
}

export function resolveHelp(args: readonly string[]): { text: string } | { error: string } {
  if (args.length === 0) {
    return { text: renderRootHelp() };
  }
  if (args.length === 1 && args[0] === "env") {
    return { text: renderEnvHelp() };
  }

  const [cmd, sub] = args;
  if (!cmd || !Object.hasOwn(COMMAND_HELP, cmd)) {
    return { error: `unknown command '${cmd ?? ""}'. Run 'ob --help' to list commands.` };
  }

  if (sub === undefined) {
    return { text: renderCommandHelp(cmd) };
  }

  const entry = COMMAND_HELP[cmd]!;
  const canonicalSub =
    entry.subcommandAliases && Object.hasOwn(entry.subcommandAliases, sub)
      ? entry.subcommandAliases[sub]!
      : sub;
  if (entry.subcommands && Object.hasOwn(entry.subcommands, canonicalSub)) {
    return { text: renderSubcommandHelp(cmd, canonicalSub) };
  }

  if (!entry.subcommands || entry.acceptsPositional === true) {
    return { text: renderCommandHelp(cmd) };
  }

  return {
    error: `unknown subcommand '${sub}' for 'ob ${cmd}'. Run 'ob ${cmd} --help' to list subcommands.`,
  };
}
