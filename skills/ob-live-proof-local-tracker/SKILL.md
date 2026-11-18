---
name: ob-live-proof-local-tracker
description: Run a REAL end-to-end ob proof (a real close, a real T3/daemon seam, the real launcher) without writing a single row to the live tracker. Use when an acceptance criterion says "live-proven against the running T3/daemon/API", when a fake seam cannot show the failure at all, or before any ob command whose side effects would otherwise land on the human's tracker. Moves the store and the seam; says plainly which half it cannot make real (the daemon, the launch).
---

# Live-proof an ob change without touching the live tracker

A live proof needs the REAL seam (T3 on `127.0.0.1:3773`, the launcher, the git checkouts) and NOT the
live data. On a machine that is an API client those are two independent things, and confusing them writes
rows into the human's tracker (it has happened: a scratch item, a spinoff row and a `repo_checkouts`
config write all landed on the real tracker before the run was noticed).

On a machine where `~/.omnislash_api_url` names your tracker's API (`https://<your-api-host>`), the
on-PATH `ob` is an API client by default and every data command it runs is a request to the live tracker.

## Rule 1: `OB_REMOTE=0` does NOT make ob local

On an API client (`OMNISLASH_API`, or `~/.omnislash_api_url`) every data command goes over HTTP whatever
`OB_REMOTE=0` says. The fully local recipe is:

```sh
export OMNISLASH_API_URL_FILE="$PROOF/no-such-file" # resolveApiBase() -> null: not an API client
export OMNISLASH_STORE=sqlite                       # the built-in default is postgres since the cutover
export OMNISLASH_DB="$PROOF/proof.sqlite"           # a throwaway tracker
export OMNISLASH_DB_CREATE=1                        # creating the database is opt-in
export OB_REMOTE=0                                  # belt and braces: no ssh dispatch either
```

Two things this does and does not cover, and neither is covered by `OB_REMOTE=0`:

- **`OMNISLASH_API` outranks the file.** `resolveApiBase()` reads `OMNISLASH_API` first and only then the file
  named by `OMNISLASH_API_URL_FILE` (`apps/cli/src/api/config.ts`). A shell that exports `OMNISLASH_API` is an
  API client *whatever* the file says, so check `env | grep '^OMNISLASH_API='` before trusting the trick.
- **The T3 seam stays REAL, so also check WHICH seam it is.** Nothing above touches
  `~/.omnislash/t3-mcp-credential.json`, and the default server is `http://127.0.0.1:3773`
  (`apps/cli/src/t3/client.ts`), but `T3_BASE_URL` overrides that default, and a proof against some other
  server is a different seam. Print the resolved one before you send anything:

  ```sh
  ob t3 doctor | sed -n 1,2p          # 'server  http://127.0.0.1:3773': the endpoint ob itself will use
  bun -e 'const {t3BaseUrl}=await import("<checkout>/apps/cli/src/t3/client.ts"); console.log(t3BaseUrl())'
  ```
- **The store is scratch; the seam is not.** That is the point of the split: the sends below are real notes
  in a real thread, and only the rows behind them are disposable.

Use one `$PROOF` directory per proof, so a leftover row is
never mistaken for a fresh one.

## Rule 2: prove the mode BEFORE you write anything

```sh
ob config get repo_checkouts   # the live value, read while still on the API: your "before" copy
export ...                     # Rule 1
bun "$WT/apps/cli/src/index.ts" add "scratch" --type task --project <project> --kind side ; echo "exit=$?"
ls -la "$PROOF/proof.sqlite" ; ob list -q
```

What the probe has to show:

- **the local tracker appears on disk here**, and its item ids start at **1**. If the id looks like a
  plausible live tracker id (four digits), you are on the API and everything below will pollute the
  human's data. A command that "worked" is not evidence of where it worked.
- **exit 0 and the item in `ob list`.** `OMNISLASH_DB_CREATE=1` creates the file on the *first* command, even
  one that then refuses: a refused `add` (measured: `could not infer project from git remote`, exit 2)
  leaves a 700 KB database behind and zero items. The file is not the proof; the row is.
- **`add` needs `--project` and `--kind`** whenever the cwd cannot infer them (not a git checkout, or a
  git checkout with no `origin` remote). Name them rather than moving the proof into the real checkout.

For the mode itself, `resolveApiBase()` is the function that decides, and it takes one line to print:

```sh
bun -e 'const {resolveApiBase} = await import("<checkout>/apps/cli/src/api/config.ts"); console.log(resolveApiBase())'
# with OMNISLASH_API_URL_FILE -> a path that does not exist: null
# with it unset (the machine as it really is):          "https://<your-api-host>"
```

## Rule 3: A/B: the buggy code and the fixed code, on the same live seam

Live-prove a fix as a DIFFERENCE, not a single green run:

1. run the proof against `main`'s code (`ob` on `$PATH` is usually the main checkout's
   `apps/cli/src/index.ts`, and its output is the reproduction, warning text and all);
2. run the same proof against the worktree's code (`bun <worktree>/apps/cli/src/index.ts …`).

Same temp tracker, same live thread, one run each. (`ob` on `$PATH` is still reading the temp tracker:
it is the *mode* that comes from the environment, and both entries honour it.)

For a T3 queue proof the shape is: seed a row whose architect resolves to a thread you control, announce a
real note into that thread's QUEUE with `ob spinoff handoff <id>` (`mode: queue` holds it while the thread's
turn is running), confirm it is HELD, then **read the queue after EACH leg and withdraw that leg's own
note**, by its own `queuedRunId`. One final "the queue is empty" is not the claim: the second leg's send
would be queued BEHIND the first leg's unread note, so a single empty read at the end cannot say which
note went. Inspect the queue with ob's own client; it needs no daemon:

```ts
const { T3Client } = await import("<checkout>/apps/cli/src/t3/client.ts");
const client = await T3Client.connected();
const read = await client.queue(threadId);          // { items, complete }
// read.items[i].queuedRunId · read.items[i].text (the whole note, not the truncated preview)
await client.queueCancel(threadId, read.items[i].queuedRunId);   // withdraw that leg's note
```

- **Using your OWN running thread as the "architect" is legitimate and free:** it is genuinely busy (so a
  queued note is necessarily HELD), and a withdrawal that fails lands on the agent that ran the proof,
  not on the human. Its id is the `session_id` of your own row in `ob agents --json`.
- **Read `queuedRunId` off the queue list, never reconstruct it**: it is T3's own
  `run:thread:<percent-encoded thread>:ordinal:N`. Match the note you are withdrawing by its first line
  (`handed off: <ticket>`) if the thread holds anything else.
- **Confirm both ends, per leg.** HELD before the cleanup and an empty `items` after it are the two halves
  of the claim; a proof that only shows the send does not show that nothing was left behind.
- A readying note **dates itself**: it carries `row: <id> · <status> (as composed)`,
  `composed: <iso>`, and the commands that settle whether it is still true. Quote `text` in full when the
  proof is about the note.

## Rule 4: put the scratch rows in the temp tracker

`ob spinoff`, `ob agent register` and `ob config set` all resolve against the store the invocation is
using, so under Rule 1 they write to the scratch DB. Nothing needs a fake store layer. The measured seed:

```sh
# 1. the repo resolution the row needs, IN the temp tracker (live value copied aside in Rule 2)
ob config set repo_checkouts '{"<name>":"<fakerepo>"}'

# 2. a fake repo + a sibling <name> worktree with a .git beside it: that pair is enough to resolve.
#    worktreeRepoOf() only probes the "<basename before the first dot>/" sibling for a .git, and
#    the handoff is routed by the project's TEAM (teamHandoffTarget), so no checkout of the real repo is involved.

# 3. the row, without ever launching it: ob spinoff queue <item> --launcher t3 --repo <fakerepo> \
#        --worktree <fakewt> --branch <b> --no-check 'live proof'  # queues only; a bare `ob spinoff <item>` LAUNCHES now
#    ob spinoff claim --id <n>                    # pending -> launching
#    ob spinoff stamp --id <n> --outcome launched --worktree <fakewt> --base-sha <sha> --launcher t3

# 4. the team and the architect whose thread the note resolves to (architect-<team>, launcher t3, session = the thread)
ob t3 team add <team> --projects <name>
ob agent register --id architect-<team> --launcher t3 --session <threadId> --status planning --branch <b>
ob agent register --id <b> --branch <b> --worktree <fakewt> --status readying --note "<gate facts>"
```

Two things this buys that a fake seam cannot: the real `spinoff` queue states, and the real
`announceReadyNote` path: its compose, its `clientRequestId` idempotence and its
`t3_thread_send … mode: queue` all run for real, against a row that exists only in the temp file.

`ob spinoff stamp` takes the flags the *local* parser accepts; `--engine` is advertised in `ob --help` but
rejected with `Unknown option` on this path (measured), so do not reach for it.

## Rule 5: if it DID reach the live tracker

1. **Stop the leak first**: a queued spinoff row could be launched by a manual `ob spinoff drain`. `ob spinoff stamp --id <n>
   --outcome failed --error "<why>"` (there is no `spinoff rm`; `failed` is the tombstone), then `ob rm
   <id>` for the item. Check `ob agents` and `ob lease status` (`ob lease list` does not exist) for rows
   and leases the run created.
2. **A `config` key is a plain upsert with NO audit trail**, and the hourly dumps are the only history.
   `pg_restore` takes ONE dump file, so pick the newest one from BEFORE the write rather than globbing:
   a glob hands it several arguments and it reads only the first:

   ```sh
   ssh <tracker-server> 'ls -t <snapshot dir>/*-snap-*.dump | head -5'   # newest first: pick one
   ssh <tracker-server> 'pg_restore -f - --data-only -t config <snapshot dir>/<...>.dump'
   ```

   That prints the COPY rows with no database needed (`pg_restore -l <dump>` lists tables).
   Read the snapshot directory from the `db snapshot` entry of `ob --help` and `OMNISLASH_SNAPSHOT_DIR` on the
   server, never from memory: an older default directory can still hold stale dumps beside the live
   ones. Then `ob config set <key> '<exact old value>'` and diff the key set
   against the dump to prove nothing else moved.

The cheapest defence is still Rule 2: `ob config get` the keys you are about to write, *before* you write
them, while the live store is still the one you are reading.

## Scope: which of the three halves this recipe moves, and which it cannot

A proof has three halves and only two of them are redirectable:

- **the store: scratch** (Rule 1). Every row ob writes lands in the temp file.
- **the seam: real** (Rule 3/4): the T3 credential, the thread, `announceReadyNote`'s compose and its
  `mode: queue` send, the queue read and the withdrawal.
- **the launch: NOT redirectable.** `ob spinoff <ref>` and the manual `ob spinoff drain` open a real T3
  thread from the authoritative store, so a launch cannot be aimed at the temp database; a proof whose
  subject really is the launch proves it on the live queue or it does not prove it at all (the drain daemon
  is retired). What this recipe does instead is seed the row with `claim` + `stamp` (Rule 4), which is
  exactly what `ob spinoff <ref>` does around its launch.

Say which half a claim belongs to. "A real close" is legitimate under this recipe (`ob close` really runs,
its T3 sends are real, and only the row is disposable), but a claim about the daemon is not, and a proof
that quietly proves two of the three halves while claiming all three is the failure this skill exists to
prevent.

## Rule 6: say it out loud

Report a live proof as the exact command and the exact output on **both** sides, and name the seam that
was real versus the store that was scratch. A proof whose tracker provenance is unstated is the kind of
claim this ticket family exists to refuse.

```
leg A (provenance): OMNISLASH_API_URL_FILE -> no-such-file, OMNISLASH_STORE=sqlite, OMNISLASH_DB=$PROOF/proof.sqlite
   resolveApiBase() -> null ; without the variable -> https://<your-api-host>
   ob add "scratch" -> 1 ; ls -la proof.sqlite -> present ; ob list -q -> 1 2
leg B (the REAL seam): ob spinoff handoff 1 -> "note:      queued for <sha7> on mcp:<your-thread>"
   T3Client.queue(mcp:<your-thread>) -> complete:true, held:[{queuedRunId:
   run:thread:mcp%3A<your-thread>:ordinal:2, text:"handed off: 1 …"}]
   queueCancel -> "cancelled …ordinal:2" ; re-read -> held: []
leg C (the negative): on the LIVE tracker (no overrides): items matching the proof 0, spinoff rows 0,
   agents 0, repo_checkouts unchanged
```
