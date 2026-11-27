---
name: ob-usage-review
description: The daily Claude token review. Reads `ob usage day --compare`, names at most three levers that would cut the most dollars, asks the owner about each, and turns each adopted lever into a rule or a ticket the same day. Use when the owner asks what they can do better with their tokens, why usage is high, for the token or usage review, or when a scheduled daily review fires.
---

# ob-usage-review

The point: find out every day what could be done better with the tokens, so the owner can refine how they work and get more done with the same tokens.

The review itself must be cheap. Run it in a fresh thread, start no subagents, and never read a whole transcript: the report is the evidence.

**Projects are the ones in `ob project list`, nothing else** (`skills/ob-architect`). The report's project lines are already only those; everything outside their checkouts is the one `not an ob project` line. Never name a lever after a directory, a scratch thread or a repo that is not an `ob` project: a lever on that line is about the line as a whole.

## Steps

1. **Read the numbers.** `ob usage day --compare` (last 24 hours against the 24 before). Note the total, the weekly window line (points ahead or behind pace), and the biggest rows in each section.
2. **Read the last levers.** The levers log in your main repo (for example `docs/usage-levers.md`): what was adopted on which day, and the numbers it was meant to move. If a lever's figure did not move in the `--compare` deltas, say so; it is a candidate to drop or redo.
3. **Name at most three levers**, largest dollar size first. Each one is:
   - the figure it moves, with its dollars and its share of the day from today's report (`cache read $516, 65%`); state the saving as a share of the day's usage too, not only dollars, and say it is the total across threads, not per ticket,
   - the cause read off the report (a session whose peak context sits at 360k, one thread doing most of the cost, subagents above 15%, a higher-range model on work a lower range could do),
   - one concrete change: a rule (compact or start fresh past a context size, a tier for a kind of ticket), a polling or watchdog loop to cut or slow, a role thread to retire, a skill to make shorter.
   A lever with no dollar figure behind it is not a lever. Skip anything under 5% of the day.
4. **Ask the owner about each lever** through the question tool (`AskUserQuestion`, `skills/ob-ask-one-by-one`), one question per lever: adopt, change, or skip. Put your recommendation first.
5. **Make each adopted lever real the same day.**
   - A rule for agents goes into the skill or `CLAUDE.md` that the affected thread reads, on a branch and its PR (`docs(skill): …`).
   - Code (a loop in `ob`, a default tier) becomes a ticket: `ob add "<title>" --project <project> --body "<lever, figure, dollars>"`, on the project whose code it changes (OmniSlash's own for a change to `ob`).
6. **Log it.** Append one entry per lever (adopted or skipped) to the levers log, in the same PR when there is one:

   ```
   ## 2026-11-18: <lever in a few words>
   - Figure: cache read $516 (65%) of $797; weekly 24% used at 10% of the week
   - Change: <the rule or ticket ref>, or skipped: <why>
   - Check: <which line of `ob usage day` should move, and which way>
   ```

7. **Close short.** One line per lever (adopted, ticket or PR, or skipped) and the total. No tables of every figure: the report has them.

## Reading the report

| Line | Usually means | Typical lever |
|---|---|---|
| cache read is most of the cost | long contexts re-read on every call | compact or start a fresh thread past a size; shorter skill loads |
| cache write is high | contexts rebuilt often (new threads, cache expiry) | fewer short-lived threads; avoid idle gaps longer than the cache life |
| one architect session leads | the planning thread rides a big context all day | hand off to a fresh thread at a context size |
| subagents above 15% | review legs or explorers fanned out | fewer legs, or a cheaper model for them |
| a higher-range model on most calls | builders on 4-6 or 7-10 by default | a lower range for a kind of ticket |
| a session named by its slug | a thread `ob` cannot map (scratch, another tool) | find out what it was before calling it waste |
| `not an ob project` is large | scratch threads and repos outside `ob project list` | ask the owner whether the repo should become an `ob` project (only the owner adds one), or move that work into a project |

Prices are estimates fitted to recorded costs (within about 20%); compare days with each other, not with a bill.
