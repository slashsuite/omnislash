# Spike: enforcing the role state machine with a state machine library (OS-167)

**The question.** SS-130 wrote down the role state machine as it runs today (slashslash `docs/role-state-machine.json`,
`.md` and `.mmd`, merged in slashslash #93 as `80b883d`). This spike asks what it would take to define that machine
once, in code, with a real state machine library, and to send every move through it.

**The short answer.**

- Only 10 of the 44 transitions are enforced by code today. Another 7 are partly enforced, and 27 are enforced by
  nothing. Those 27 are not missing checks. Their states are not stored anywhere, so no library can guard them
  until a column holds them.
- Two stored machines already exist: the item status and the spinoff row status. The row machine is already a
  typed table with a guarded `UPDATE` (`moveSpinoff`). The item machine is a typed table checked before the write,
  but the write is not guarded and is not in a transaction.
- **Use XState v5, as pure functions only** (`transition`, `resolveState`, `snapshot.can`, `toJSON`). No actors run
  on the server. Put it in a new `platform/state-machine` package behind the existing writers (`workflow.ts` and
  `moveSpinoff`), so the CLI, the API and the dashboard do not change.
- A throwaway proof passes 6 of 6 tests, on SQLite and on a real Postgres cluster. It defines the item lifecycle in
  XState, matches `status.ts` edge for edge, and routes `ob block` through it with a guarded `UPDATE` and the trail
  decision in one transaction. A writer that wins the race is refused, and nothing is written. Its code and output
  are in the appendix.

**Sources and the commits read.** The JSON and `.md` are at slashslash `origin/main`. The JSON says it was read
against omnislash `08b9917`. This spike reads omnislash at `2e0279a` (2026-11-24). Nothing under
`platform/cli-coord/src` changed between the two, so every `platform/` line number in the JSON still holds.
`apps/cli/src/workflow.ts` changed in `b1e3560` (block owner on the trail), and the lines below are read at
`2e0279a`. Library facts come from the libraries' own docs and the type declarations they ship. They are cited
inline.

## 1. Where each transition is enforced today

**What "enforced" means here.** **E**: code refuses the move when its from-state is wrong, by name. **P**: code
checks part of it, for example the dispatch shape, or the target but not the source. **N**: nothing in omnislash
refuses it. Only the skill describes it, or the state is not stored at all.

### The two stored machines underneath

Every state in the JSON sits on top of two stored columns. These are the only places code can enforce anything
today.

| Machine | Column | Table and check | Writer | Atomic? |
|---|---|---|---|---|
| Item | `item.status`: free TEXT, with no enum or CHECK (`apps/cli/src/status.ts:15-18`) | `BASIC_TRANSITIONS` and the four per-type tables (`status.ts:27-117`), checked by `canTransition` (`status.ts:129-148`) | `transitionTo`, `blockItem`, `unblockItem`, `reopenItem` and `moveItem` (`apps/cli/src/workflow.ts:54-216`), which write through `setStatus`, `setBlocked` and `clearBlock` (`apps/cli/src/items.ts:290-331`) | **No.** `assertTransition` reads and checks, then `setStatus` updates `WHERE id = ?` only (`items.ts:305-309`), then `recordDecision` inserts. These are three statements in no transaction (`workflow.ts:54-65`). `clearBlock` is two updates (`items.ts:327-331`). |
| Spinoff row | `spinoff.status` (`platform/cli-coord/src/commands/spinoff.ts:476`) | `SPINOFF_TRANSITIONS` (`spinoff.ts:497-506`) | `moveSpinoff`, the only status writer (`spinoff.ts:531-545`) | **The status, yes:** `UPDATE ... WHERE id = ? AND status IN (<from>)` with `RETURNING`, and a typed `SpinoffTransitionRefused` when no row moved (`spinoff.ts:513-521`). **The trail decision, no:** `recordRowDecision` runs after it, outside a transaction (for example `spinoff.ts:3539-3540`, `:3580-3581`). |

Every caller reaches those writers, and nothing else writes a status. A search for `update(...t.item)` across
`apps/` and `platform/` finds no other status write outside test seeds.

- **CLI:** `apps/cli/src/commands/state.ts:43, 50, 315, 339, 349, 356, 376`.
- **API:** `apps/cli/src/api/handlers.ts:626, 986, 993, 1025, 1028, 1035, 1040, 1057`.
- **Dashboard:** `platform/dashboard-kit/src/server/item-transition.ts:26-52`.
- **Decision supersede:** `apps/cli/src/commands/decision.ts:111-112`.

### Every transition in the JSON

| # | From → to | Enforced | By what (file:line at `2e0279a`) |
|---|---|---|---|
| 1 | idea → exploring | N | No stored state. The muse lives in the owner's thread. |
| 2 | exploring → confirm_complete | N | No stored state. |
| 3 | confirm_complete → exploring | N | No stored state. |
| 4 | confirm_complete → ticketed | N | `ob add` creates an `open` item (`status.ts:85-98`). Nothing checks that the owner said yes. |
| 5 | exploring → parked_idea | N | `ob add` plus the `idea` tag. No check. |
| 6 | parked_idea → confirm_complete | N | No stored state. |
| 7 | ticketed → drilling | N | "Drilled" is a section of the body, not a status. |
| 8 | drilling → checking | N | `ob spinoff check` records scores (`platform/cli-coord/src/spinoff-check.ts:97-102`). Nothing requires a seal first. |
| 9 | checking → go | P | The go is a recorded check, read only at dispatch by `refuseUncheckedDispatch` (`spinoff-check.ts:329-380`). |
| 10 | checking → drilling | N | "At most twice" is in the skill only. |
| 11 | drilling → owner_plan_call | N | No stored state. |
| 12 | owner_plan_call → drilling | N | No stored state. |
| 13 | drilling → spike | P | The spike's shape (Questions, Box, Done when, a link to its parent) is refused at dispatch (`spinoff-check.ts:360-371`). |
| 14 | spike → drilling | N | `ob note` on the parent. No check. |
| 15 | spike → spike_closed | P | `ob close` goes through `closeAndLand` (`apps/cli/src/close.ts:20-27`), which ends the row as `failed` with a spike error (`spinoff.ts:3183-3192`). The item side is only `canTransition(*, done)`. |
| 16 | drilling → go (`--no-check`) | P | An empty reason is refused, and the reason goes on the trail (`spinoff-check.ts:336-345`). Nothing checks "under 70 after two tries". |
| 17 | go → queued | E | `refuseUncheckedDispatch` at `spinoff.ts:6340` throws before any row exists. |
| 18 | queued → launching | E | `moveSpinoff(..., ["pending"])` (`spinoff.ts:1991`), behind the claim lease (`:1981`). |
| 19 | launching → building | E | `moveSpinoff` to `launched` (`spinoff.ts:2067`). |
| 20 | launching → queued | E | `spinoff.ts:2142`, from `["launching"]` only, under `MAX_LAUNCH_ATTEMPTS` (`:2814`). |
| 21 | launching → failed | E | `spinoff.ts:2144`. |
| 22 | queued → failed | E | The table edge `pending → failed` (`spinoff.ts:498`). |
| 23 | building → failed | E | `spinoff.ts:2096` and `:2294` (the trial loser). |
| 24 | building → reviewing | N | No stored state. The agent status `readying` is free to set at any time. |
| 25 | reviewing → building | N | No stored state. |
| 26 | reviewing → pr_ci | N | No stored state. Nothing checks that the review had 0 open findings. |
| 27 | pr_ci → building | P | The handoff refuses red or pending CI (`assertHandoffCiForRow`, `spinoff.ts:6036`), but `pr_ci` is not stored. |
| 28 | pr_ci → handed_off | E | `moveSpinoff(READY_FOR_GATE, ["launched"])` (`spinoff.ts:3539`), the CI check (`:6036`) and the leak check (`:6031`). |
| 29 | pr_ci → needs_human | N | The verdict is the `State:` line in git. `recordSpinoffVerdict` (`spinoff.ts:3741-3760`) checks the word only, and only for clean repos. |
| 30 | needs_human → handed_off | P | The same code as #28. Nothing checks that the human ran it. |
| 31 | needs_human → building | N | The verdict is not a stored state. |
| 32 | building → blocked | N | The verdict only. |
| 33 | building → partial | N | The verdict only. |
| 34 | blocked → building | N | The verdict only. |
| 35 | partial → building | N | The verdict only. |
| 36 | handed_off → gating | N | The inbox lists messages oldest first (`apps/cli/src/inbox.ts:93-99`). Reading one moves nothing. The lease is taken by the skill. |
| 37 | gating → building (sendback) | E | `markSpinoffSentBack` refuses a row that is not handed off, then `moveSpinoff(..., [READY_FOR_GATE])` (`spinoff.ts:3574-3580`). |
| 38 | gating → updating_pr | N | No stored state. |
| 39 | updating_pr → gating | N | No stored state. |
| 40 | gating → owner_merge_call | N | No stored state. |
| 41 | owner_merge_call → gating | N | No stored state. |
| 42 | gating → merged_deployed | N | `gh pr merge` and `ob deploy run` are separate commands. Reconcile lands the row afterwards (`spinoff.ts:3175-3185`). |
| 43 | merged_deployed → closed | P | `closeAndLand` → `closeItem` (`workflow.ts:76-80`) → `canTransition` (`status.ts:129`). Nothing checks for a merge or a deploy: `ob close` works on any open item. |
| 44 | closed → building (reopen) | E | `markSpinoffReopened` refuses a row that is not `merged`, then the table edge `merged → launched` (`spinoff.ts:503`, `:3616-3622`). |

**Counts:** 10 E, 7 P, 27 N.

### Moves nothing enforces, and inconsistencies

- **The 27 N moves**, above. 22 of them sit on states with no column at all: the muse phase, drilling, checking,
  reviewing, the verdict phases, and the four sentinel sub-states. SS-130 already noted that `gating`,
  `updating_pr` and `owner_merge_call` "cannot be told apart from stored data today".
- **A block's reason is checked in some callers and not others.** `ob block` checks it (`commands/state.ts:347`),
  and so do the API `block` action (`handlers.ts:1034`) and the dashboard (`item-transition.ts:51`). But
  `ob state <id> blocked` and the API `/state` `set blocked` pass `reason: null` straight into `blockItem`
  (`state.ts:376-380`, `handlers.ts:1057-1061`), and it is accepted. A guard in the machine definition closes all
  five doors at once.
- **The item is never `in_progress`, `ready` or `merged` during a build.** The vocabulary allows them
  (`status.ts:18`), but no spinoff path writes them, and the live store holds 0 items in each (29 are `blocked`,
  from `ob list --status <s>` on 2026-11-24). The item machine is wider than the flow that runs.
- **`done → done` counts as a move.** `canTransition` treats from = to as allowed (`status.ts:135`), so a retried
  close is a success. A state machine library refuses a self-move unless it is declared. The wrapper must keep this
  as a no-op, as the proof does.
- **The trail decision can be lost.** On both machines it is written after the status, outside a transaction. A
  crash between the two leaves a move with no decision behind it.

## 2. Which library

The candidates are XState v5 (5.33.4), robot3 (1.4.0), and the typed table we already have.

| | XState v5 | robot3 | Our own typed table (`SPINOFF_TRANSITIONS` style) |
|---|---|---|---|
| **TypeScript** | Typed events and context through `setup({ types })`. Needs TS 5.0 or later; typegen is gone in v5 ([typescript](https://stately.ai/docs/typescript)). Event payloads are typed, so `{ type: "block", reason }` is checked. | Generics infer the state keys (`index.d.ts:39-54`, `Machine<S, C, K>` at `:184-187`). Events are plain strings. | Full: a `Record<Status, Status[]>`. No events, only targets. |
| **Server use with no actor runtime** | Yes. `transition(machine, snapshot, event)` returns `[nextSnapshot, actions]` and is pure ([pure-transitions](https://stately.ai/docs/pure-transitions), `dist/declarations/src/transition.d.ts:8`). Added in 5.19.0 ([transitions](https://stately.ai/docs/transitions)). | No pure transition is exported. Events go through `interpret(machine)` and `service.send` (`index.d.ts:121-126`, `:225`). It can run per request, but it is a runtime. | Yes: an array lookup. |
| **State from a Postgres row** | `machine.resolveState({ value, context })` builds a snapshot from a stored value ([persistence](https://stately.ai/docs/persistence); `StateMachine.d.ts:37`). An unknown value throws `State 'qa' does not exist on 'item'` (tried in this spike). | `createMachine(initial, states)` takes the initial state as its first argument (`index.d.ts:39-43`), so you build one machine per row. | The status string is the state. |
| **Guards** | Named in `setup({ guards })`. "Guards should be pure, synchronous functions" ([guards](https://stately.ai/docs/guards)). They take params and event data, and compose with `and`, `or` and `not`. | `guard(fn)` on a transition (`index.d.ts:97`). | None. Each writer adds its own `if`, which is how the block reason drifted (section 1). |
| **Definition to JSON** | `machine.toJSON()` (`StateMachine.d.ts:72`) and `machine.definition` (`:71`). `JSON.stringify(machine)` gives states, `on` edges with `eventType`, `target` and `guard` names, plus `meta` on states and transitions (tried in this spike). | Not documented. `Machine.states` holds the objects, but the guards are closures. | Trivial for the edges. Labels, roles and sources would need a second table. |
| **Nested states** (the role machine needs them: `building` holds reviewing and pr_ci) | Yes. | Nested machines through `invoke`. | No. |
| **Bundle (measured: `bun build --minify`, gzip -9)** | 13.8 kB gz (`setup` + `transition` + `createActor`). The docs state no size. | 1.0 kB gz. | 0 kB. |
| **Maintenance** | Last npm publish 2026-11-23. | Last npm publish 2026-10-05. Its docs site, `thisrobot.life`, did not resolve in DNS on 2026-11-24, so only the README and the shipped `.d.ts` could be read. | Ours. |

**Recommendation: XState v5, used only as pure functions on the server.**

- It is the only candidate with all three things the ticket needs: typed event payloads, named guards that live in
  the definition, and a definition that serialises to JSON with `meta`. The JSON is what lets OS-165 and the
  slashslash diagram be generated instead of copied by hand.
- Nested states let the role machine (section 6) be one definition, with the item and row machines as its stored
  layers.
- Its size does not matter on the server. The dashboard does not need the runtime: it reads the generated JSON.
  It imports XState (13.8 kB gz) only if it ever wants `snapshot.can` live, to enable buttons.
- robot3 is smaller, but it has no pure transition and no documented serialisation, and its docs site is gone.
- Our own table already enforces the row machine well. On its own terms it is good enough. It loses on guards, on
  event payloads and on generating the diagram, which are the reasons for this ticket.

## 3. Where the machine lives and how it is called

**A new package, `platform/state-machine`.** It holds three definitions and one write helper:

- `item.ts`: the task lifecycle (today's `BASIC_TRANSITIONS`), plus the roadmap, decision, learning and reference
  tables as small machines of their own. `linear_ref` gets the `LINEAR_TRANSITIONS` machine.
- `spinoff.ts`: the row machine (today's `SPINOFF_TRANSITIONS`). Its events are `claim`, `stamp`, `retry`, `fail`,
  `handoff`, `sendback`, `land` and `reopen`, so the trail records events, not bare targets.
- `role.ts`: the role machine from slashslash, with each state's `meta.stored` saying which item or row state it
  rides on. It is the source for section 6.
- `decide(machine, from, event)`: pure. It returns the target, or a refusal with the reason.
- `applyMove(store, { table, id, from, event, set, decision })`: the guarded write described in section 4.

**The callers do not change.** `workflow.ts` (`transitionTo`, `blockItem`, `unblockItem`, `reopenItem`,
`moveItem`) and `moveSpinoff` become thin wrappers over `decide` and `applyMove`. The CLI (`commands/state.ts`),
the API (`api/handlers.ts`) and the dashboard (`dashboard-kit/src/server/item-transition.ts`) already go through
those functions, so none of them changes. The package depends only on drizzle and the `Store` type. Today
`platform/dashboard-kit` already imports `apps/cli/src` directly, so the dependency direction is no worse.

**How a refused move shows up:**

| Where | Today | With the machine |
|---|---|---|
| Error type | A bare `AppError` for items (`workflow.ts:50`). `SpinoffTransitionRefused extends AppError` for rows (`spinoff.ts:513`). | `TransitionRefused extends AppError`, with `machine`, `id`, `from`, `event` and `why: "machine" \| "guard" \| "race"`. `SpinoffTransitionRefused` becomes a subclass, so existing `instanceof` checks still hold. |
| CLI | `error: <message>`, exit 1 for an `AppError` (`apps/cli/src/cli.ts:870-873`). | The same. The message names the state and the event: `item 'OS-1' is done: 'block' is not a move from there`. A lost race says `... moved while 'block' was deciding; nothing changed, re-run`. |
| HTTP | 409 `refused` for an `AppError` (`apps/cli/src/api/server.ts:578`). 400 for a `UsageError` (`:577`). | 409 `refused` for `machine` and `race`. A failed guard is also 409, since the request was well formed and refused. Payload validation stays a 400 `ApiFault`. |
| Dashboard | The server function throws, and the drawer shows the message. | The same. |

## 4. Persistence and concurrency

**One move is one transaction.** `applyMove` does four things:

1. It reads the row's status.
2. It runs `decide` in memory: `resolveState`, then `snapshot.can`, then `transition`.
3. It opens `store.txn` (`apps/cli/src/db/store.ts:99-112`: `BEGIN IMMEDIATE` on SQLite, the driver's
   transaction on Postgres).
4. Inside the transaction:
   - `UPDATE <table> SET status = <to>, ... WHERE id = ? AND status = <from> RETURNING id`.
   - If no row came back, it throws `TransitionRefused(why: "race")`.
   - Otherwise it writes the trail decision.

**Why this is atomic without a lock on the read.** The machine decided the move on `from`. The `WHERE status = from`
makes the write true only if the row is still in `from`. Another writer that moved the row in between makes the
update match no rows, and the move and its decision are both rolled back. This is the pattern `moveSpinoff`
already uses (`spinoff.ts:541-545`). It extends to items, and it pulls the decision inside the same transaction.
The proof shows it on SQLite and on Postgres. The test seam closes the item between the decision and the write,
and the block is refused with no decision written.

**Rows already in a state the machine would not allow:**

- The item status is free TEXT, so a value outside the vocabulary can exist. `resolveState` throws on an unknown
  state, so `decide` must catch that and return `why: "machine"` with "unknown state". It must not crash the read.
- Reads, `ob show`, the dashboard and the Timeline must never go through the machine. They render the stored word
  as it is.
- **Repair is a named, logged event.** Each machine gets one `repair` event, legal from any state including an
  unknown one, that goes to a valid state. It is written by a `--repair '<why>'` flag, on the trail as
  `<legacy> → <to> (repair: why)`. A legacy row stays readable, and the only way out of it is on the record.
- **The live store on 2026-11-24:**
  - No item sits in `in_progress`, `ready` or `merged`.
  - 137 rows are `launched` (`ob spinoff list --status launched`). 135 of them were requested before 2026-11-17, and
    their tickets do not resolve from this store.
  - These are not illegal states. They are stale ones (building for a week or more), and the audit in PR 3 lists
    them so they can be repaired or failed on purpose.

## 5. Migration path

Each step can land alone and leaves the product working.

1. **Add `platform/state-machine` with the item and spinoff machines in XState, and no callers.** A parity test
   checks every from-to pair against `canTransition` and `SPINOFF_TRANSITIONS`, like the proof's first test. The
   `xstate` dependency goes in this PR.
2. **Log what the machine would refuse, read-only.** `transitionTo`, `blockItem`, `unblockItem`, `reopenItem` and
   `moveSpinoff` call `decide` next to their current check. When the two disagree, they write a
   `machine_would_refuse` event (actor, machine, from, event, why) and carry on with today's answer. Nothing
   changes in behaviour. The architect reads the count after a week.
3. **Add `ob machine audit`, read-only.** It lists rows whose status the machine cannot resolve, rows parked in a
   long-running state (such as the 135 old `launched` rows), and the would-refuse events from step 2.
4. **Make item writes atomic, on today's table.** `setStatus`, `setBlocked` and `clearBlock` become one guarded
   `UPDATE ... WHERE status = from`, with `recordDecision` in the same `store.txn`. This fixes the race and the
   lost decision on its own, before any switch. The trail decision for `moveSpinoff` moves into its transaction in
   the same PR.
5. **Enforce the item machine.** `canTransition` and the transition tables in `status.ts` are deleted, and
   `workflow.ts` calls `decide` and `applyMove`. The block-reason guard now covers `ob state` and the API `set`
   too: a change in behaviour, called out in the PR. Self-moves stay no-ops. A `repair` event is added.
6. **Enforce the spinoff machine.** `moveSpinoff` calls `decide` and `applyMove`, `SPINOFF_TRANSITIONS` becomes the
   generated view, and the row's trail records the event names.
7. **Generate the JSON.** `bunx moon run state-machine:export` writes `role-state-machine.json` and `.mmd` from the
   definitions. A CI check fails when the committed copy drifts (section 6).
8. **Decision for Jacobus: store the role phases that are not stored today.** This is an additive column
   (`spinoff.phase`: `reviewing`, `pr_ci`, `gating`, `updating_pr`, `owner_merge_call`), plus commands or hooks
   that move it through the machine. Only after this can any of the 22 unstored N moves be enforced. It is several
   tickets, one per phase group, and it is worth doing only for the phases OS-165 needs to tell apart.

The first seven steps change nothing that a user sees, except the block-reason guard in step 5. Step 8 is new
product.

## 6. What slashslash's `docs/role-state-machine.json` becomes

**It becomes generated.** The role machine is defined in `platform/state-machine/src/role.ts`:

- Each state carries `meta: { label, role, human_required, stored }`. `terminal` comes from `type: "final"`.
- Each transition carries `meta: { label, actor, source }` on an event named after the JSON's `event`.
- XState keeps `meta` through `JSON.stringify(machine)`. This spike tried it: state `meta` and transition `meta`
  both come through as written.
- An export script maps the definition to today's v1 schema (`version`, `roles`, `states`, `transitions` with
  `from`, `to`, `label`, `event`, `actor` and `source`), so OS-165 and anything reading the file need no change. The
  same script writes the `.mmd`, which today is copied by hand (slashslash `docs/role-state-machine.md`, opening
  section).

**`source` changes meaning.** A hand-kept `file:line` drifts with every edit. In the generated file, a transition
the code enforces gets its source from the definition: the symbol that applies it, for example
`platform/state-machine/src/item.ts#block`. A skill-only transition keeps a written `meta.source` pointing at its
skill.

**The job:**

- In omnislash CI, `state-machine:export --check` fails a PR whose definitions changed without the regenerated
  file. The generated copy lives at `docs/role-state-machine.json` in omnislash.
- On a push to omnislash `main` that changes the file, a GitHub Actions job opens a PR in slashslash that replaces
  its `.json` and `.mmd`. The slashslash PR keeps its own review, and its `/how-it-works` checks run there.
- **This needs a decision from Jacobus:** a token that can open PRs in slashslash, stored as an omnislash Actions
  secret. The alternative is a scheduled slashslash job that pulls the file. That needs a read token for
  omnislash instead, and it lags until the schedule runs.

## Draft tickets (for the architect to file if the sequence is agreed)

The spike files none of these.

1. `feat(state-machine)`: add `platform/state-machine` with XState item and spinoff machines and a parity test. No
   callers.
2. `feat(state-machine)`: log moves the machine would refuse (`machine_would_refuse` events). No change in
   behaviour.
3. `feat(cli)`: `ob machine audit` lists unresolvable and stale rows and the would-refuse events.
4. `fix(cli)`: item status moves and their trail decision are one guarded transaction, and so is the spinoff
   row's decision.
5. `feat(cli)`: item moves are enforced by the machine. The block-reason guard covers `ob state` and the API, and
   `repair` is a logged event.
6. `feat(cli-coord)`: spinoff row moves are enforced by the machine, and the trail records events.
7. `ci`: generate `role-state-machine.json` and `.mmd` from the definitions, check for drift in CI, and open a PR
   in slashslash on change. **needs-human** for the cross-repo token.
8. `feat`, **needs-human** (a decision first): store the role phases (`spinoff.phase`) that OS-165 must tell apart,
   then enforce their moves.

## Appendix: the proof

The proof is under `spikes/state-machine/` in the spike's worktree and is **not committed**. The spike rule allows
only documentation in the PR. It is reproduced here in full.

- **What it does.** It defines the task item lifecycle in XState v5.33.4 and checks it against `canTransition` for
  every pair.
- **One real transition through it:** `ob block`, as `machineBlock`, with a guarded `UPDATE` and the decision in
  one `store.txn`. The tests also check that the output matches `blockItem` field for field, that a block on a done
  item and a block with no reason are both refused, that a lost race is refused on SQLite and Postgres with no
  decision written, and that `toJSON` gives the edges with guard names.
- **It is never wired into the live CLI.**

```
$ TMPDIR=~/.cache/tmp bun test spikes/state-machine
spikes/state-machine/item-machine.test.ts:
[{"from":"open","to":"in_progress","event":"start"},{"from":"open","to":"ready","event":"ready"},{"from":"open","to":"blocked","event":"block","guard":"hasReason"},{"from":"open","to":"done","event":"close"}]

 6 pass
 0 fail
 47 expect() calls
Ran 6 tests across 1 file. [941.00ms]
```

`spikes/state-machine/item-machine.ts`:

```ts
// OS-167 throwaway proof: the task item lifecycle (status.ts BASIC_TRANSITIONS) defined once in XState v5,
// used as pure functions only (no actor), and `ob block` routed through it with a guarded UPDATE in one
// transaction. Never wired into the live CLI.
import { setup, transition } from "xstate";
import { and, eq } from "../../apps/cli/node_modules/drizzle-orm";
import { AppError } from "../../apps/cli/src/errors.ts";
import { asStore, type Store } from "../../apps/cli/src/db/store.ts";
import { nowIso } from "../../apps/cli/src/db.ts";
import { recordDecision } from "../../apps/cli/src/decisions.ts";

export type ItemStatus = "open" | "in_progress" | "ready" | "merged" | "blocked" | "done";
export type ItemEvent =
  | { type: "start" }
  | { type: "ready" }
  | { type: "merge" }
  | { type: "block"; reason: string | null; owner: string | null }
  | { type: "close" }
  | { type: "open" };

// One event per target status, so the table below is BASIC_TRANSITIONS edge for edge.
export const itemMachine = setup({
  types: { events: {} as ItemEvent },
  guards: {
    // Today the CLI (state.ts) and the dashboard (item-transition.ts) each check this on their own.
    hasReason: ({ event }) => event.type === "block" && !!event.reason?.trim(),
  },
}).createMachine({
  id: "item",
  initial: "open",
  states: {
    open: { on: { start: "in_progress", ready: "ready", block: { target: "blocked", guard: "hasReason" }, close: "done" } },
    in_progress: { on: { ready: "ready", block: { target: "blocked", guard: "hasReason" }, close: "done", open: "open" } },
    ready: { on: { merge: "merged", start: "in_progress", block: { target: "blocked", guard: "hasReason" }, close: "done" } },
    merged: { on: { close: "done", block: { target: "blocked", guard: "hasReason" }, open: "open" } },
    blocked: { on: { open: "open", start: "in_progress", ready: "ready", close: "done" } },
    done: { on: { open: "open" } },
  },
});

/** A move the machine refuses, or one another writer won. AppError, so the API answers 409 and the CLI exits 1. */
export class ItemTransitionRefused extends AppError {
  constructor(id: string, from: string, event: string, why: "machine" | "race") {
    super(
      why === "machine"
        ? `item '${id}' is ${from}: '${event}' is not a move from there`
        : `item '${id}' moved while '${event}' was deciding (it is no longer ${from}); nothing changed, re-run`,
    );
    this.name = "ItemTransitionRefused";
  }
}

/** Pure: the status `event` leads to from `from`, or null when the machine refuses it. No actor, no I/O. */
export function nextStatus(from: ItemStatus, event: ItemEvent): ItemStatus | null {
  const snap = itemMachine.resolveState({ value: from, context: {} });
  if (!snap.can(event)) return null;
  const [next] = transition(itemMachine, snap, event);
  return next.value as ItemStatus;
}

/**
 * `ob block` through the machine: read, decide, then ONE transaction holding the guarded UPDATE
 * (`WHERE id = ? AND status = <from>`) and the trail decision. Zero rows updated means another writer moved
 * it between the read and the write, and nothing (not even the decision) is written.
 */
export async function machineBlock(
  db: Store,
  id: string,
  reason: string | null,
  owner: string | null,
  /** Test seam: runs between the decision and the write, to let another writer win the race. */
  beforeWrite: () => Promise<void> = async () => {},
): Promise<void> {
  const s = asStore(db);
  const rows = (await s.q.select({ status: s.t.item.status }).from(s.t.item).where(eq(s.t.item.id, id)).limit(1)) as Array<{ status: string }>;
  if (!rows[0]) throw new AppError(`no item with id '${id}'`);
  const from = rows[0].status as ItemStatus;
  const event: ItemEvent = { type: "block", reason, owner };
  const to = nextStatus(from, event);
  if (to === null) throw new ItemTransitionRefused(id, from, "block", "machine");
  await beforeWrite();
  await s.txn("block the item", async (tx) => {
    const moved = (await tx.q
      .update(tx.t.item)
      .set({ status: to, block_reason: reason, block_owner: owner, updated_at: nowIso() })
      .where(and(eq(tx.t.item.id, id), eq(tx.t.item.status, from)))
      .returning({ id: tx.t.item.id })) as Array<{ id: string }>;
    if (moved.length === 0) throw new ItemTransitionRefused(id, from, "block", "race");
    await recordDecision(tx, id, from, to, { note: reason, extra: owner ? { block_owner: owner } : undefined });
  });
}

/** The machine as the role-state-machine.json shape: states and from/to/event edges, read off `toJSON()`. */
export function itemMachineJson(): { states: string[]; transitions: Array<{ from: string; to: string; event: string; guard?: string }> } {
  // Through JSON text on purpose: this is what a generator job would write and read.
  const def = JSON.parse(JSON.stringify(itemMachine)) as {
    states: Record<string, { on: Record<string, Array<{ target: string[]; guard?: string }>> }>;
  };
  const transitions: Array<{ from: string; to: string; event: string; guard?: string }> = [];
  for (const [from, node] of Object.entries(def.states)) {
    for (const [event, edges] of Object.entries(node.on)) {
      for (const e of edges) {
        const to = String(e.target[0]).replace(/^#item\./, "");
        transitions.push({ from, to, event, ...(e.guard ? { guard: e.guard } : {}) });
      }
    }
  }
  return { states: Object.keys(def.states), transitions };
}
```

`spikes/state-machine/item-machine.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { freshDbPath } from "../../apps/cli/test/helpers.ts";
import { openStore, type Store } from "../../apps/cli/src/db/store.ts";
import { createItem, getItem } from "../../apps/cli/src/items.ts";
import { registerProject } from "../../apps/cli/src/project.ts";
import { blockItem, closeItem } from "../../apps/cli/src/workflow.ts";
import { decisionsForItem } from "../../apps/cli/src/decisions.ts";
import { canTransition, statusVocab } from "../../apps/cli/src/status.ts";
import { ItemTransitionRefused, itemMachine, itemMachineJson, machineBlock, nextStatus, type ItemEvent, type ItemStatus } from "./item-machine.ts";

const paths: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const p of paths.splice(0)) rmSync(p, { force: true });
});
async function store(): Promise<Store> {
  const p = freshDbPath();
  paths.push(p);
  const s = await openStore({ kind: "sqlite", path: p, create: true });
  stores.push(s);
  await registerProject(s, { name: "alpha", kind: "side" });
  return s;
}
const EVENTS: Record<ItemStatus, ItemEvent> = {
  in_progress: { type: "start" },
  ready: { type: "ready" },
  merged: { type: "merge" },
  blocked: { type: "block", reason: "r", owner: null },
  done: { type: "close" },
  open: { type: "open" },
};

test("the machine allows exactly the moves status.ts allows for a task (from != to)", () => {
  const vocab = statusVocab("task", "side") as ItemStatus[];
  for (const from of vocab)
    for (const to of vocab) {
      if (from === to) continue;
      const machine = nextStatus(from, EVENTS[to]) === to;
      expect({ from, to, machine }).toEqual({ from, to, machine: canTransition(from, to, "task", "side") });
    }
});

test("ob block through the machine writes what blockItem writes", async () => {
  const s = await store();
  const a = await createItem(s, { type: "task", title: "a", projectId: "alpha" });
  const b = await createItem(s, { type: "task", title: "b", projectId: "alpha" });
  await blockItem(s, a, "needs a key", "jacobus");
  await machineBlock(s, b, "needs a key", "jacobus");
  const [ia, ib] = [await getItem(s, a), await getItem(s, b)];
  for (const k of ["status", "block_reason", "block_owner"] as const) expect(ib![k]).toBe(ia![k]);
  const [da, db] = [await decisionsForItem(s, a), await decisionsForItem(s, b)];
  expect(db.map((d) => [d.from, d.to, d.note])).toEqual(da.map((d) => [d.from, d.to, d.note]));
});

test("the machine refuses a block on a done item and with no reason; nothing is written", async () => {
  const s = await store();
  const id = await createItem(s, { type: "task", title: "c", projectId: "alpha" });
  await expect(machineBlock(s, id, "   ", null)).rejects.toBeInstanceOf(ItemTransitionRefused);
  await closeItem(s, id);
  await expect(machineBlock(s, id, "why", null)).rejects.toThrow(/is done: 'block' is not a move from there/);
  expect((await getItem(s, id))!.status).toBe("done");
  expect((await decisionsForItem(s, id)).map((d) => d.to)).toEqual(["done"]);
});

test("a writer that wins between the decision and the write: the guarded UPDATE refuses, no decision recorded", async () => {
  const s = await store();
  const id = await createItem(s, { type: "task", title: "d", projectId: "alpha" });
  await expect(machineBlock(s, id, "why", null, () => closeItem(s, id))).rejects.toThrow(/no longer open/);
  expect((await getItem(s, id))!.status).toBe("done");
  expect((await decisionsForItem(s, id)).map((d) => d.to)).toEqual(["done"]);
});

test("toJSON gives the diagram's states and edges, guard names included", () => {
  const j = itemMachineJson();
  expect(j.states).toEqual(["open", "in_progress", "ready", "merged", "blocked", "done"]);
  expect(j.transitions).toHaveLength(20);
  expect(j.transitions).toContainEqual({ from: "open", to: "blocked", event: "block", guard: "hasReason" });
  console.log(JSON.stringify(j.transitions.slice(0, 4)));
  void itemMachine;
});

import { leaseRealPgDb } from "../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../apps/cli/test/helpers.ts";
test(
  "postgres: block through the machine, and the lost race, behave the same",
  async () => {
    const lease = await leaseRealPgDb();
    const s = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
    try {
      await registerProject(s, { name: "alpha", kind: "side" });
      const a = await createItem(s, { type: "task", title: "a", projectId: "alpha" });
      await machineBlock(s, a, "needs a key", "jacobus");
      expect((await getItem(s, a))!.status).toBe("blocked");
      const b = await createItem(s, { type: "task", title: "b", projectId: "alpha" });
      await expect(machineBlock(s, b, "why", null, () => closeItem(s, b))).rejects.toThrow(/no longer open/);
      expect((await decisionsForItem(s, b)).map((d) => d.to)).toEqual(["done"]);
    } finally {
      await s.close();
      await lease.release();
    }
  },
  spawnBudget(2),
);
```
