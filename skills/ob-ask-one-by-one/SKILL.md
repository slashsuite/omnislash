---
name: ob-ask-one-by-one
description: "How to put ANY question, decision, approval or review item to the owner: always through the harness's question tool (AskUserQuestion), never as plain text, and one question at a time when there are several. Use every time you are about to ask the owner anything, one question or twenty: a yes/no, a pick between options, a \"needs you\" from a builder, a morning review, a batch of PRs or tickets to approve, a grilling round. Triggers: ask the owner, question for the owner, decision for you, needs you, approve, one by one, review these, morning review, going to bed review, a pile of decisions."
---

# Ask with the question tool, one by one

**Every question for the owner goes through the question tool, every time, in every circumstance.**
One question or many, in any session (architect, builder, overnight morning, a grilling round, a one-off chat):
if the owner is expected to answer, they get the question screen, not a question written in the message. A message that
ends "Decision for you: ...?" or "Want me to ...?" in plain text breaks this rule. The only plain-text questions
are on a harness that has no question tool (section 2's fallback).

When there are several things to answer, ask them one at a time, record each answer as you go, and close with a
table (three or more; one or two need no table).

## 1. Gather first

Before the first question, collect every open decision for the owner in one place: the ticket ids, the PR URLs,
the log lines that say "needs you". Order them most consequential first, so the question that matters most comes
first. One item is one call; there is no "small enough to ask inline".

## 2. Ask the tool, one question at a time

Use the harness's question tool, one call per item.

- **Claude Code, or a T3 thread on the Claude lane:** `AskUserQuestion`. One question per call, 2 to 4 options. A T3 thread on the OpenCode lane has no such tool: use the no-tool fallback below.
- **Another harness:** its own question tool, the same shape.
- **No question tool:** send one numbered question per message, with its options as lettered choices, and wait
  for the answer before the next one.

**A grilling round uses the tool too.** A grilling skill asks its whole frontier in one round: send that round as
one `AskUserQuestion` call with up to 4 questions (the tool's limit), and split a bigger frontier over several calls.
This method covers every question, grilling included.

Do not batch unrelated items into one call. Two closely tied items (the same ticket, or one decision that
depends on the other) may share one call, with the question saying so.

## 3. The question shape

Each question stands on its own. The owner should be able to answer it without opening anything else, so it carries:

- **The item:** its ticket ref or PR URL, and a short name (for example `ABC-12 · the docs pointer`).
- **The facts the owner needs:** what the item is, what was found, and what each choice costs or changes. Plain words,
  no file lists, no history. If a command or URL lets them check it, give that.
- **2 to 4 options.** The recommended one comes first and is marked `(Recommended)` in its label. Each option has
  a one-line description of what happens if it is picked.

Never write "judge X" or "what do you think of Y". Write the question they answer: "Ship the wording as written, or
change it?"

## 4. Record each answer in the same turn

Right after an answer, and before the next question, record it where the work lives:

- an `ob note` on the ticket, or `ob close <id>` when the answer closes it, or the action the answer asks for
  (merge, dispatch, reject);
- for an overnight item, an `ob note <ref> '<the answer>'` on the decision it answers (the decisions are `ob` items, `ob overnight show` lists them with their refs), or, when the answer is itself a new call, `ob overnight decide` with `--context '<the owner's words>'`.

If recording fails, say so before moving on. Never ask the next question while the last answer is unrecorded.

## 5. Close with a table

When every item has an answer, end with one table: item, the answer, what was done. Keep it short. Example shape (the refs are placeholders):

```
| Item        | Answer                   | Done                                  |
|-------------|--------------------------|---------------------------------------|
| ABC-12      | Ship as written          | Merged in PR #812                     |
| ABC-10      | Keep the old wording     | Ticket closed, note added             |
| ABC-14      | Defer to next week       | Row left open, dated note added       |
```

Items the owner did not answer (skipped or stopped) appear in the table with `no answer` and stay open.

## Rules

- **Never ask in plain text where a question tool exists.** Not a closing "shall I...?", not a "decision for you" line, not a builder's "needs you" in its final message. A builder that needs the owner's call asks with the tool in its own thread (and still marks `--status needs-human`); an architect relaying a builder's "needs you" asks with the tool.
- **Overnight, the one-by-one walk waits for the morning.** When the owner is asleep, nobody answers: log the items and do
  not ask (see `ob-going-to-bed`). The walk happens when they are back.
- **Never invent an answer.** If an item gets no answer, it stays open and is recorded as `no answer`.
- **No em or en dashes** in any question, option or table.
