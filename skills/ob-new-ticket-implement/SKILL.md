---
name: ob-new-ticket-implement
description: "Create a new `ob` ticket, spin up a dedicated git worktree for it with `wt`, and hand it to `ob spinoff` (an interactive T3 thread on the bare ask). Use when the user wants to \"make a ticket and implement it\", \"spin up a ticket for X and build it\", \"create a ticket and have an agent implement it\", or otherwise turn an idea into a ticket plus an in-flight implementation in one step. Also supports a mid-flow SPINOFF mode (`--spinoff --parent ID`): carve a discovered task off the current ticket into its own `ob add` ticket and `wt` worktree, record the parent→child link, and hand it to `ob spinoff`. Use when the user wants to \"spin this off into its own ticket\", \"carve this out into a new thread\", \"open this in a new tab/thread\", or split follow-up work off an in-progress change to keep it small."
---

# New ticket → worktree → spinoff

Turn a request into three things, in order:

1. An **`ob` ticket**: title, body with ACs, priority.
2. A dedicated **`wt` worktree** on a ticket branch.
3. **`ob spinoff`**, which opens an interactive T3 thread on the ticket's own brief. You steer; you declare it done.

## Conventions

- **No Claude / Claude Code attribution** anywhere: commits, comments, code comments.
- **Never** skip hooks (`--no-verify`).
- Dispatch is **`ob spinoff`**, always interactive. Never a background Agent.

## Steps

### 1. Draft the ticket and confirm

From the user's request, draft:

- **title**: imperative and concise.
- **description**: markdown with context, a Done when list and scope, detailed enough that an agent can implement it without further questions. If the request is thin, flesh out sensible Done when items and explicitly note any assumptions.
- **priority**: if the user named one; otherwise omit and let `ob add` default.

Show the drafted title, description, and priority to the user and get a quick 👍 **before creating**. Skip the confirm only if the user said to just go.

### 2. Create the `ob` ticket

```bash
ob add "<title>" --priority <p> --body "<ACs + testing steps>"
```

Capture the new `ob` id (`ob add --json` to read it machine-readably). If create fails, surface the error and stop.

### 3. Create the worktree

**First make sure `main` is current.** `wt` branches new worktrees off local `main`, which is often badly stale. Fetch and fast-forward it before creating the worktree:

```bash
git fetch origin
git branch -f main origin/main   # main is usually not checked out, so this fast-forwards it safely
# If that errors because main IS checked out in a worktree, instead run in that worktree:
#   git -C <main-worktree> pull --ff-only origin main
```

```bash
BRANCH="<ob-id>-<kebab-title>"
wt switch --create "$BRANCH" -y
```

(`wt` defaults the base to `main`. To be explicit, or to stack on another branch, pass `--base <branch>`.)

`wt` cds the shell it runs in, and that cd does **not** reliably survive to the next command here, so resolve the worktree's absolute path explicitly instead of assuming you moved into it. (Use `grep`+`sed`, not `awk` with positional fields: a `$1`/`$2` in a skill file gets clobbered by argument substitution.)

```bash
WORKTREE=$(git worktree list | grep -F "[$BRANCH]" | sed 's/ .*//')
echo "$WORKTREE"
```

If `wt` reports "command not found", the shell didn't load the function; retry once, and only if it still fails fall back to `git worktree add -b "$BRANCH" "../$(basename "$PWD" | sed 's/\..*//').$BRANCH"`.

### 4. Hand it to `ob spinoff`

`ob spinoff` refuses a new ticket with no `## Drilled` section, no `## Done when` item or no measure-twice `go` on its current body. Run "Measure twice" in `skills/ob-architect` and record it with `ob spinoff check` first, or add `--no-check '<why>'` to the command below.

Write the brief so it survives quoting:

```bash
cat > /tmp/spinoff-brief.md <<'MD'
<id>: <title>

Branch: <BRANCH>   Worktree: <WORKTREE>

## Done when
- ...

## Testing steps
- ...
MD
```

```bash
ob spinoff "<id>" \
  --repo "<repo path or slug>" \
  --branch "$BRANCH" \
  --worktree "$WORKTREE" \
  --complexity <1-10> \
  --brief - < /tmp/spinoff-brief.md
```

- **`--worktree "$WORKTREE"`** points `ob` at the checkout step 3 created.
- **`--brief -`** reads the brief from stdin.
- **`--repo`** takes a path or a slug. Pass it when cwd is not the target repo.
- **`--branch "$BRANCH"`** keeps the builder on the branch step 3 created.
- **`--complexity`** (1 to 10) picks the builder's model from the profile's builder ranges; the model is whatever `ob models get builder.<from>-<to>` prints for the range. Rate it yourself with the rubric in the `ob-architect` skill ("Rate every dispatch"). Omitted = 5, and the queue line says so.

The session opens on the **ticket's own brief** (its title, what to build, acceptance and do not, then the directive to run `ob-spinoff`): the ask, never a self-gating procedure. You steer; you declare it done. `--agent` is a usage error.

### 5. Report to the user

- **Ticket:** `<id>`: [title]
- **Branch / worktree:** `[BRANCH]` at `[WORKTREE]`
- **Complexity:** `<score>` (`<model>`). Say it, so the cost of the dispatch is visible.
- **Launch:** `ob spinoff` opens a T3 thread bound to its worktree in the same invocation (the `t3` launcher) and prints the thread id. When another live session holds its `ticket:`/`worktree:` lease it refuses, names the holder and leaves no pending row; `--holder <id>` dispatches under your own hold.

## Spinoff mode (`--spinoff --parent <id>`)

A **mid-flow** variant: you're already deep in one ticket's worktree and a task surfaces that deserves its **own** ticket (keeps the current change small). Carve it off and hand it to **`ob spinoff`**.

Trigger: the user says "spin this off", "carve this out into its own ticket", "open this in a new tab/thread", etc., **from within the current ticket's session**.

### S1. Infer the parent

If `--parent <id>` is given, use it. Otherwise infer from the current worktree / branch. If you can't confidently infer it, ask the user for `--parent` rather than guessing: the linkage is the point.

### S2. Create the child ticket

Draft **ACs and testing steps from the parent context**. Create with `ob add` as in step 2, and note in the body that it was spun off from `<parent>` to keep that change small.

### S3. Create the worktree

Exactly as **step 3** above.

### S4 and S5. Brief + `ob spinoff`

Exactly as **step 4** above. Include **"spun off from `<parent-id>` to keep that change small"** in the brief.

### S6. Record the parent → child link

```bash
ob link <child-id> spun_off_from <parent-id>
```

### S7. Report to the user

- **Child ticket:** `<child-id>`: [title]
- **Parent link:** spun off from `<parent-id>` (recorded via `ob link`)
- **Branch / worktree:** `<BRANCH>` at `<WORKTREE>`
- **Launch:** queued via `ob spinoff`.
