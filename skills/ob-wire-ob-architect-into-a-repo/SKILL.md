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

## What is actually missing per repo

1. **No `AGENTS.md`.** The `ob-architect` skill's Step 0 reads the repo's
   `CLAUDE.md` / `AGENTS.md` / `README` to learn its tracker and conventions.
   Without that file the architect adapts to nothing and invents defaults. This
   is the highest-value file you will write.
2. **No ob runtime plugins.** `ob-heartbeat`, `ob-memory`, `ob-skills` and
   `ob-soul` are configured only in OmniSlash's `opencode.json`, so sessions in
   other repos never register in `ob agents`, get no memory or SOUL injection,
   and never file skills.

## A repo that will go public keeps this half in OmniSlash

A public repo cannot carry the ob-specific rules (tracker, visual upload, the PR land, dispatch) or `.opencode/`
wiring whose plugins import this machine's absolute paths, and untracked files do not reach a fresh worktree.
So your OmniSlash checkout owns that half, under `repos/<project>/` (the project is the repo's checkout basename):

- `repos/<project>/AGENTS.md`: the private rules. `ob project rules <project>` prints them (nothing, exit 0, when
  there are none); the architect's Step 0 reads that output next to the repo's own `AGENTS.md`, and every
  `ob spinoff` launch prompt for that repo ends with it.
- `repos/<project>/opencode/`: the wiring, laid out as `.opencode/` is (`SOUL.md`, `agents/architect.md`,
  `commands/ob-architect.md`, `plugins/ob-*.ts`). `ob project wire <project> [--dir <path>]` copies into
  `<path>/.opencode/` every file the checkout does not TRACK, and git-excludes them; a spinoff launch does the
  same for its worktree and fails the launch if the install or the exclude cannot be written (the manual
  command only reports it). A tracked file is never overwritten, so a repo that still commits its own wiring keeps
  working, while ob's own untracked copies are refreshed when `repos/<project>/opencode` changes.

Steps 1 to 4 below still describe what the files contain. For a repo going public, write them into
`repos/<project>/` instead of the repo, and commit them in your OmniSlash checkout.

## Steps

### 1. Write `AGENTS.md`: the repo's conventions

Sections that matter, because the architect and every builder read them:

- **Tracker.** Which one, and what is *not* available. Check first: `git
  remote -v` and `gh auth status`. A repo with no remote and no `gh` auth is
  `ob`-only; say so explicitly so nobody reaches for GitHub issues.
- **Brief format.** On a repo other than OmniSlash `ob spinoff brief` finds no
  ticket brief file, so it falls back to the ob item's title +
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

### 2. Add the repo-local agent, command and SOUL

- `.opencode/agents/architect.md`: `mode: primary`, deny the `subagent` action,
  body loads the `ob-architect` skill and points Step 0 at this repo's `AGENTS.md`.
  It overrides the global `architect` **for this repo only**; verify OmniSlash is
  unaffected.
- `.opencode/commands/ob-architect.md`: frontmatter `agent: architect`, body loads
  the skill and passes `$ARGUMENTS`. Overrides the global command here.
- `.opencode/SOUL.md`: injected into every request. Keep it short; it costs
  tokens on every turn.

### 3. Provide a launcher

The `ob-architect` skill sets `disable-model-invocation: true`, so the model cannot
load it. A session must be switched to the `architect` agent **and** have the
skill body injected. That is why a script is needed rather than
`opencode --agent`. Copy the shape from `<your OmniSlash checkout>/.opencode/architect-tui.sh`:
create a session at the repo root, `POST /api/session/{id}/agent`, pin the
model, `POST /api/experimental/session/{id}/skill {"id":"ob-architect"}`, then
`exec opencode --session "$id" --auto`. Verify the agent and model landed and
exit non-zero if not: never open a TUI that is silently the wrong agent.

### 4. Wire ob's four plugins

**The trap.** A `plugins` entry in `opencode.json(c)` must name a
**directory**, not individual `.ts` files. Naming the files logs
`configured plugin path must be a directory` and loads nothing, with no other
symptom: the session just silently drops out of `ob agents`. OmniSlash's own
`opencode.json` has this defect; its plugins load anyway only because
`.opencode/plugins/` is auto-discovered inside OmniSlash itself.

**The fix.** One-line re-export shims in `<repo>/.opencode/plugins/`. Nothing
to drift, and auto-discovery loads them. The path below assumes your OmniSlash
checkout sits next to the repo; point it at yours:

```ts
// .opencode/plugins/ob-heartbeat.ts
export { default } from "../../../omnislash/.opencode/plugins/ob-heartbeat.ts";
```

One file per plugin: `ob-heartbeat`, `ob-memory`, `ob-skills`, `ob-soul`. Then
**no `opencode.jsonc` is needed at all** for this.

### 5. Check the repo against the standard stack

Read `<your OmniSlash checkout>/skills/ob-new-project/STANDARD-STACK.md` and compare the repo with
each of its sections. File **each deviation as its own ticket** on this repo's `ob` project (`ob add "<deviation>" --project <repo>
--body "<brief>"`, brief headings as in step 1). Do not fix any of them while wiring; they are built
like any other ticket. Check `bunfig.toml` first and always: `linker = "isolated"` and `globalStore = true` are required, and a repo without them is ticketed `high`.

Done when: every section of the standard is either matched or ticketed, and you can name the tickets.

### 6. Verify: both halves

Config that looks right and loads nothing is the whole failure mode here.

```bash
# Plugins: expect 4 ids starting ob-, matching OmniSlash.
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
and the OpenCode launcher above is a fallback. Register the repo checkout as a
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
