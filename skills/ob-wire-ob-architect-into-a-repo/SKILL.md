---
name: ob-wire-ob-architect-into-a-repo
description: Set up a repo other than OmniSlash so ob's planning workflow works in it, with the architect agent, the /ob-architect command, a launcher, a SOUL, the repo conventions the architect adapts to, and ob's four runtime plugins. Use when someone asks for "an ob architect for this project", wants a repo to use ob's skills and resources, or the repo's sessions are not appearing in `ob agents`.
---

# Wire the ob architect into a repo

Make a repo other than OmniSlash a first-class scope for ob's planning workflow. Worked
end to end on a marketing site.

## What already works everywhere (do not rebuild it)

The global config `~/.config/opencode/opencode.jsonc` already gives **every**
repo:

- ob's skills: `{"skills": {"paths": ["<your OmniSlash checkout>/skills"]}}`,
  so `ob-cli`, `ob-spinoff`, `ob-land`, `ob-architect`, `ob-skeptical-review` resolve.
- the `ob-*` slash commands, symlinked into `~/.config/opencode/command/`.
- the `architect` agent: symlinked into `~/.config/opencode/agent/`.

So the repo-local work is the **conventions** and the **runtime plugins**, not
the skills or commands.

`ob project wire <project>` builds the repo-local half from any OmniSlash checkout, a fresh clone
included: the sources it builds from ship in `apps/cli/opencode/` (the four plugins, the launcher and
the starting points for the agent, the command and the SOUL). No `.opencode/` is committed to OmniSlash.

## What is actually missing per repo

1. **No `AGENTS.md`.** The `ob-architect` skill's Step 0 reads the repo's
   `CLAUDE.md` / `AGENTS.md` / `README` to learn its tracker and conventions.
   Without that file the architect adapts to nothing and invents defaults. This
   is the highest-value file you will write.
2. **No ob runtime plugins.** `ob-heartbeat`, `ob-memory`, `ob-skills` and
   `ob-soul` are configured only in OmniSlash's `opencode.json`, so sessions in
   other repos never register in `ob agents`, get no memory or SOUL injection,
   and never file skills. `ob project wire` fixes this (step 2).

## A repo that will go public keeps this half in OmniSlash

A public repo cannot carry the ob-specific rules (tracker, visual upload, the PR land, dispatch) or `.opencode/`
wiring whose plugins import this machine's absolute paths, and untracked files do not reach a fresh worktree.
So your OmniSlash checkout owns that half, under `repos/<project>/` (the project is the repo's checkout basename):

- `repos/<project>/AGENTS.md`: the private rules. `ob project rules <project>` prints them (nothing, exit 0, when
  there are none); the architect's Step 0 reads that output next to the repo's own `AGENTS.md`, and every
  `ob spinoff` launch prompt for that repo ends with it.
- `repos/<project>/opencode/`: optional overrides, laid out as `.opencode/` is (`SOUL.md`, `agents/architect.md`,
  `commands/ob-architect.md`, anything else). `ob project wire` installs each one in place of the built file of the
  same path, and a spinoff launch installs them into its worktree too (failing the launch if the install or the
  exclude cannot be written). Put a repo's SOUL or architect agent here once it is worth keeping, since the
  copies `ob project wire` writes into a checkout are untracked and a fresh worktree does not have them.

Whatever is installed, only files the checkout does not TRACK are written, and each one is git-excluded. A repo
that still commits its own wiring keeps it.

## Steps

### 1. Write `AGENTS.md`: the repo's conventions

Sections that matter, because the architect and every builder read them:

- **Tracker.** Which one, and what is *not* available. Check first: `git
  remote -v` and `gh auth status`. A repo with no remote and no `gh` auth is
  `ob`-only; say so explicitly so nobody reaches for GitHub issues.
- **Brief format.** On a repo other than OmniSlash `ob spinoff brief` finds no
  `wayfinder/tickets/<ref>-*.md`, so it falls back to the ob item's title +
  body. That fallback IS the mechanism: put the brief in the body with
  `## What to build` / `## Acceptance` / `## Do not`.
- **The gate.** Exact commands, run from the worktree, plus anything the
  build needs beyond typecheck/test (a deploy dry-run, a browser check). Note
  that a fresh spinoff worktree has no `node_modules`.
- **Landing.** The repo's convention: branch, then PR, then `ob-land` squash-merge (the architect's). Outside
  OmniSlash the verdict is recorded with `ob spinoff state`, never a `State:` line, and nothing of ob goes in
  the branch, commits or PR.
- **Invariants.** The rules this codebase punishes you for breaking. This is
  where the repo's real knowledge goes; keep the ones that cost an actual bug.

### 2. Run `ob project wire`

From the repo checkout (or with `--dir <path>`):

```bash
ob project wire <project>
```

It writes into `.opencode/`, untracked and git-excluded:

- `plugins/ob-heartbeat.ts`, `ob-memory.ts`, `ob-skills.ts`, `ob-soul.ts`: one-line shims that
  re-export the plugin from your OmniSlash checkout by absolute path. Auto-discovery loads them, so
  **no `opencode.jsonc` is needed**. Do not list plugin files in `opencode.json(c)` instead: a `plugins`
  entry must name a directory, and naming files logs `configured plugin path must be a directory` and
  loads nothing, so the session silently drops out of `ob agents`.
- `architect-tui.sh`: the launcher. The `ob-architect` skill sets `disable-model-invocation: true`, so a
  session must be switched to the `architect` agent **and** have the skill injected, which
  `opencode --agent` cannot do. The script creates the session, sets the agent, pins the model
  (`OB_ARCHITECT_MODEL=<provider>/<model id>`), injects the skill, verifies the agent and model landed
  (exit 1 if not) and opens the TUI. Run it from the repo root.
- `agents/architect.md` (`mode: primary`, the `subagent` action denied, loads `ob-architect` and points
  Step 0 at this repo's `AGENTS.md` and `ob project rules <project>`), `commands/ob-architect.md`
  (`agent: architect`, passes `$ARGUMENTS`) and `SOUL.md` (injected into every request, so keep it
  short). These three are starting points, written only when missing: edit them, and a re-run keeps
  your edits. They override the global `architect` and command for this repo only; check OmniSlash is
  unaffected.

Re-run it after moving or updating your OmniSlash checkout: the shims and launcher are refreshed.

### 3. Keep what is worth keeping

The files above live only in this checkout. Anything you edited and want in every future worktree goes
into `repos/<project>/opencode/` in your OmniSlash checkout (see above), and commit it there.

### 4. Check the repo against the standard stack

Read `<your OmniSlash checkout>/skills/ob-new-project/STANDARD-STACK.md` and compare the repo with
each of its sections. File **each deviation as its own ticket** on this repo's `ob` project (`ob add "<deviation>" --project <repo>
--body "<brief>"`, brief headings as in step 1). Do not fix any of them while wiring; they are built
like any other ticket. Check `bunfig.toml` first and always: `linker = "isolated"` and `globalStore = true` are required, and a repo without them is ticketed `high`.

Done when: every section of the standard is either matched or ticketed, and you can name the tickets.

### 5. Verify: both halves

Config that looks right and loads nothing is the whole failure mode here.

```bash
# Plugins: expect the 4 ids ob-heartbeat, ob-memory, ob-skills, ob-soul.
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD" \
  | python3 -c "import json,sys;print(sorted(p['id'] for p in json.load(sys.stdin)['data'] if p['id'].startswith('ob-')))"

# The architect agent at this location is the repo-specific one.
opencode api get "/api/agent?location%5Bdirectory%5D=$PWD"

# And OmniSlash still gets its own.
opencode api get "/api/agent?location%5Bdirectory%5D=<your OmniSlash checkout>"
```

`/api/plugin` returns **builtins only** when a location's plugins fail to
load, so `total` alone proves nothing: count the `ob-` ids. Passing no
`location` defaults to `$HOME` and shows nothing useful.

Read `~/.local/share/opencode/log/opencode.log` when it still looks wrong;
that is where `configured plugin path must be a directory` appears.

### 6. Bind the repo's architect T3 thread

T3 Code is the only harness, so the repo's architect is a T3 thread
and the OpenCode launcher from step 2 is a fallback. Register the repo checkout as a
T3 project with a default model first. Put the project in a team: `ob t3 team join <team> <slug>` for an
existing team (`ob t3 team list`), or let the next command make a team of one. Then, from the thread that will
be the architect, read its own id with the T3 MCP tool `t3_thread_configuration` (no
arguments) and run, in the repo checkout:

```bash
ob t3 architect [<team>] --thread <threadId>
```

That records the id on `architect-<team>`, pins the thread, turns auto-settle off and titles it
`<icon> <display name> · architect` from the team's `ob t3 team edit <team> --icon <emoji> --display-name <Name>`.
Without `--thread` it opens a fresh architect thread seeded with `/ob-architect`. **Never hand-title the thread.**
`ob` keeps the title on every run and routes by the recorded thread id, not the title. Re-running must print
`already live … nothing created`. A sentinel or a muse is the owner's call: `ob t3 sentinel|muse <team>`.

## Gotchas

- Never `pkill -f "vite dev"` or similar from inside the repo you are working
  in: `-f` matches your own shell's command line and kills it.
- The ob service restarting mid-task loses a tool result mid-edit. Re-run the
  verification rather than assuming.
- Do not restart the opencode service to force config reloads: you are running
  inside that service. Prefer mechanisms that work without a restart
  (auto-discovery) over ones that might only apply at startup.
- `is directory a git repo` in the environment block is unreliable; check with
  `git status` when it matters.
