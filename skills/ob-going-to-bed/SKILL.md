---
name: ob-going-to-bed
description: Overnight autonomous mode. Invoke when the user is going to sleep and wants the agent to work the ENTIRE buildable ticket queue to completion unattended, deciding and logging every key call for good morning. Progress over perfection; anything wrong gets fixed in the morning. Triggers on "going to bed", "overnight", "work through the night / the queue while I sleep", "run till it's done".
---

The user is going to sleep. **Work the entire buildable ticket queue to completion, unattended:** make reasonable calls on anything that would normally need them, **log every key decision** for good morning, and **keep going until the frontier is empty**. **Progress over perfection: anything wrong gets fixed in the morning.** You build on top of the `/ob-architect` role (charts, delegates, gates, lands); this skill sets the OVERNIGHT operating posture.

## The mandate
- **Keep going until the frontier is EMPTY.** Dispatch → gate → land → pick the next → repeat. Never stop after one ticket. Never ask "what next?": **there is no one to answer.**
- **Never block on the user.** Do NOT use AskUserQuestion / EnterPlanMode / any "confirm?": the user is asleep. For every decision, pick the most reasonable option, **LOG it** with `ob overnight decide` (what, why, doubt, undo), and continue.
- **Keep the pipeline MOVING, one builder per repo.** Dispatch one buildable ticket per repo; gate and land it when its completion re-invokes you (the notification chain IS the overnight engine); then dispatch the next. A second builder in the same repo only when the architect clears `ob-architect`'s 98% no-conflict bar.
- **Retry transient failures once**, then move on and log it (a stalled or API-errored subagent is not a reason to stop the night).

## The floor that does NOT move: "progress over perfection" is not shipping broken
- **Still GATE every merge** exactly as the repo requires: typecheck clean · tests green (twice for DB) · smoke checks · migrations additive. "Progress over perfection" licenses imperfect **decisions and polish** (logged for morning); it does **NOT** license merging red or broken code. **A build that won't gate green is LOGGED as blocked and left uncommitted, never forced onto `main`.**
- **Standing safety lines are PERMANENT, never crossed, even in asleep mode:**
  - **Nothing sends to an external service** (WhatsApp / Slack / email / PR comment / posting a standup): drafts ONLY, always. No sends, ever, without a waking human.
  - **No destructive or irreversible action on real data**, especially financial. A data migration that needs a backup and a source freeze is a **needs-you** item: LOG it, do NOT run it.
  - **Migrations additive and non-destructive only**; back up first; never a destructive migration on the live DB.
  - **Secrets** stay in their token files (never committed); **DBs never in git**.
  - **Device or physical work** you can't do (no phone in hand) → LOG as needs-you.
- **Interactive / "feel" tickets** (prompt wording, UX, voice, visual polish): build the **functional/mechanical** version, gate it, land it if green, and **LOG "needs your feel-review in the morning."** NEVER self-declare the FEEL done: you cannot judge taste while the user sleeps; that stays the user's call.

## What to work, in priority order
1. **Buildable-now, fully-specifiable** (one at a time, unless the user asked for parallel): the bulk of the night.
2. **Blocked chains**: as each dependency lands, dispatch the newly-unblocked node.
3. **Interactive/feel** → build the functional core, land if green, flag for review.
4. **Needs-you / unsafe** (device · financial-data migration · anything requiring an external send or a human decision that materially risks real state) → **SKIP and LOG**, never force.

## The morning deliverable (this is the point)
- **The overnight log lives in ob, not in a file.** Every machine reads it, and only these commands write it, so its format cannot drift. Never write a review file into the repo.
  1. **Start the night:** `ob overnight start --project <your project>` before the first dispatch. It creates the night's run doc (or prints the existing one) and prints the date to pass as `--night`; the night is the date the run started, local time. Architects in other repos log on their own project the same way.
  2. **Log every key call as you make it** (don't batch at the end: if the session dies, the log survives): `ob overnight decide "<the decision, one line>" --what '<what you did>' --why '<why>' --doubt '<how sure, what could be wrong>' --undo '<how to change it in the morning>' --project <p> --night <date>`. Pass `--doubt` and `--undo` every time; leave one out only when there is truly nothing to say, and it shows as `not recorded`. Add `--context '<the user's words>'` when a call answers something the user said. A later change to a call is an `ob note <ref> '...'` on that decision, never a new edit of what you logged.
  3. **Write the morning summary** as the run ends, one bullet per call: `ob overnight summary shipped|review|skipped|next --add '<line>' --project <p> --date <date>`.
     - **shipped**: each ticket and its gate result (test counts).
     - **review**: every autonomous decision you're not fully sure about, most consequential first, each with how to reverse it (name the decision's ref).
     - **skipped**: device, data migration, feel review, external send, genuine forks, with exactly what you need from the user to proceed.
     - **next**: the ordered list for when the user wakes up.
  4. **End with the night itself:** `ob overnight show --project <p> --date <date>` is your final message, as it prints.
- Mirror major calls onto the tracker where the work is (`ob log`, and issue comments) as before.
- **File every "needs you" item as a ticket (for `ob-good-morning`).** Each item in **Review these** and **Skipped / needs you** that needs the user's decision is also an `ob add` on your project with `--tag needs-owner`, its body the item block: `Architect: <slug>, thread <your threadId from t3_thread_configuration>`, `Question:`, `Options:` (and what happens on each), `Recommended:`, `Source:` (the decision's ref). File it when you log it, not at the end. In the morning the user runs `ob-good-morning` in one thread: it gathers these from every architect, asks one by one and queues each answer into your thread, so act on an answer that arrives that way like one typed to you. An architect in another repo files it on its own project the same way; the ticket is ob's, never the repo's.
- **Morning lists.** When the user is back and the **Review these** and **Skipped / needs you** lists hold more than two items, walk them with `skills/ob-ask-one-by-one`; across several architects, `skills/ob-good-morning` does it in one thread. The overnight run itself still never blocks.
- End: set your `ob` agent note to "overnight run complete, see ob overnight show --project <p> --date <date>".

## Loop shape (the engine)
1. Read the frontier (`ob next` / the repo tracker / GitHub-issues frontier). Classify every item: buildable-now · interactive/feel · needs-you/unsafe.
2. Dispatch the first buildable ticket (the rest follow one by one); register each in `ob`; `ob overnight start` and log the plan as the first `ob overnight decide`.
3. On each completion notification: **gate hard → land (the repo's flow: gate the builder's PR, merge it) → log the decision(s) → dispatch newly-unblocked or next-frontier work.**
4. Repeat until only needs-you/unsafe items remain.
5. Write the morning summary; update the `ob` note. Then stop; do not invent busywork.

## Adapt to the repo (inherits `/ob-architect` Step 0)
Each repo brings its own tracker, gate, migration safety net and landing flow. Use that repo's landing and gate discipline; this skill only changes the *posture* (unattended, decide-and-log, run-to-empty), never the safety floor.
