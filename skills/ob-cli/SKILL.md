---
name: ob-cli
description: Loads the live `ob` command surface, the current OmniSlash CLI commands grouped by section, plus the conventions for running them. Use when you need to know what `ob` can do, find the right subcommand or flags, run an `ob` read, create or close, or check an `ob` command's semantics after the surface changed. Front-loads `ob`, "`ob` commands", "ob --help", "what can `ob` do", "run ob". No static snapshot: it loads the commands fresh each run so it can never go stale.
---

# ob-cli: load the current `ob` command surface

`ob` (the OmniSlash CLI, `apps/cli`) is a large, fast-moving surface. The docs
requirement is that EVERY CLI change updates `ob --help` and
the CLI docs (`apps/cli/docs/`) in the same change, so the help IS the up-to-date source.
Load the commands **fresh from `ob --help`**, never from memory or a static list.

## 0. Load: print the live command index (always do this first)

Run the index loader, which shells out to `ob --help` and prints the command
decls grouped by section (names and short usage only, prose dropped):

```bash
bash skills/ob-cli/index.sh
```

(the path is relative to your OmniSlash checkout).

This gives you the whole current surface in about 150 lines: what commands exist,
their names, and their top-level flags. **Never skip this step to "remember"
the commands**: the surface changes weekly and a remembered command may be
renamed, reflagged or deleted.

## 1. Dive into one command's semantics

The index has only the one-line decl. For the full flag semantics, prose and
edge cases:

```bash
ob --help 2>&1 | sed -n '/^  <command> /,/^  [a-z][a-z-]* /p'   # that command's block
ob <command> --help                                             # sub-help, where supported
rg -n "\| \`?<command>" apps/cli/docs/commands.md                # the command reference
```

`apps/cli/docs/guide.md` is the real user guide (the "how it fits together" model, conventions and
workflows) and `apps/cli/docs/commands.md` the command reference by area. Consult it when the question is *why/when*
rather than *what flags*. For the build and land flow and what a spun-off agent
must run, use the `ob-spinoff` skill instead.

## 2. Conventions to respect when running ob

- **Machine output:** use `--json`, the stable skill contract; parse
  it with `jq`, don't string-match human tables. `--table` = aligned columns,
  `-q/--quiet` = ids only (scripts).
- **Exit codes:** `0` success (including a clean empty result: empty is not an error,
  test output not exit); `1` runtime error; `2` usage error.
- **Global flags:** `--db PATH` (or `OMNISLASH_DB`) and `--no-daemon` (open
  SQLite directly, bypass the daemon) are always accepted.
- **Two trackers, one truth:** `ob` item numbers and GitHub issue numbers
  on the linked repo are **independent sequences that collide**. Never assume
  item 75 is issue `#75`; check the link (`ob issue list` / `ob issue landed`).
- **State changes have side effects:** `ob close`/`reopen` also close/reopen
  the linked GitHub issue unless `--no-github`. Prefer `--dry-run` where it
  exists. Use `ob log`/`ob note` over ad-hoc recording.
- **Never mutate the live DB destructively.** A gentle read-only `ob` command
  (`list`, `show`, `status`, `next`, `search`) answers most questions before
  anything that writes.
- **The command is only done when the docs match:** if this session changes
  the CLI, both `ob --help` (the HELP string in `apps/cli/src/cli.ts`, every
  HANDLERS command must appear) and the CLI docs (`apps/cli/docs/`) must change in the
  same commit.

## 3. When to use which top-level command (the short version)

The index is authoritative; these are just the common ones:

- Read state: `ob list` / `ob show <id>` / `ob status` / `ob next` / `ob search <q>` /
  `ob brief <id>` (work-state for a topic).
- Create/change: `ob add "<title>" [--issue]` · `ob edit` / `note` / `tag` /
  `link` · `ob start | ready | close | block | state <id> <state>`.
- Trackers: `ob issue list|link|unlink|landed|reconcile|drift`.
- Coordination: `ob lease` (holds everything live) · `ob agent register|heartbeat|done|agents`
  · `ob spinoff <ref>|drain|list|watch`.
- Measurement: the old measurement layer (metrics, report, audit) is gone. What is left:
  `ob status` · `ob alerts` · `ob jobs` · `ob sync` (GitHub PR ingest).

If a command's full name or a flag looks unfamiliar from the index, verify via
step 1 rather than guessing: a wrong flag is a usage error (exit 2), and a
wrong assumption about a side effect can close the wrong issue.
