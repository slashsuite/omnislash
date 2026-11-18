---
name: ob-good-morning
description: "Morning catch-up across every architect. Gathers what each architect shipped and everything it left for the owner overnight (or while they were away), shows one short digest, then walks every open item one question at a time and sends each answer back to the architect that asked, so the owner never has to visit architect threads one by one. Use when they say good morning, I'm back, morning review, catch me up, what needs me, or run /ob-good-morning. Runs in any thread; it routes answers and never does the architects' work itself."
---

# ob-good-morning

After a night away, every report and everything that needs the owner should be answerable in one thread: all the questions from all the planners that left something overnight, resolved one by one, instead of going to each planner to work out what it needs.

This thread is a switchboard. It reads, asks and routes. It does not land, dispatch, deploy, send anything external or change code: each answer goes back to the architect that owns the item, and that architect acts on it. Run it in a fresh thread (or any architect thread) from anywhere; it needs only `ob` and the T3 tools.

Never use an em dash or an en dash in anything this skill writes (questions, notes, messages).

## 1. Gather

Collect every item that waits on the owner, from all four sources. Read only. Load the T3 tools with ToolSearch first (`t3_thread_list`, `t3_thread_read`, `t3_thread_send`).

1. **Tickets tagged `needs-owner`, every project.** Run `ob list --open --tag needs-owner --by priority` from any directory (no `--project` reads them all), then `ob show <ref>` for each. This is the main source: `ob-going-to-bed` files every "needs you" item this way, with the question, the options, the architect's recommendation and the architect's thread id in the body.
2. **Every live architect thread.** `t3_thread_list` with `allProjects: true` and `titleContains: "· architect"`; skip cancelled or settled ones. `t3_thread_read` each and read its messages since yesterday evening: the morning summary (`ob-going-to-bed` ends with one) and any question or "needs you" line that has no `needs-owner` ticket yet. An architect that wrote its question only in its thread still counts; you file the ticket for it in step 2.
3. **Overnight runs.** `ob overnight list --since <yesterday>` lists every architect's runs (a run that started before midnight carries yesterday's date); `ob overnight show --project <p> --date <d>` prints each one's morning summary and its decisions. Read "Review these" and "Skipped / needs you".
4. **Builds waiting on the owner's yes.** `ob agents` rows reading `needs-human`, and `ob spinoff gateable` entries whose state is `needs-human` (those wait for the owner's `/ob-spinoff-handoff`).

Then de-duplicate: the same question can show up in a ticket, a thread and a log. One item per decision, with every source noted.

## 2. File what has no ticket

For each item found only in a thread, a log or a row, file it so the answer has a home:

```
ob add "<the question, as a decision>" --project <the architect's project> --priority <as urgent as it is> \
  --tag needs-owner --body "<the item block below>"
```

The item block, the same one `ob-going-to-bed` writes:

```
Architect: <architect slug>, thread <threadId>
Question: <one sentence>
Options: <each option, and what happens on it>
Recommended: <the architect's pick, and why>
Source: <log path and entry, or thread, or row>
```

An item that needs no decision (pure information: "this ticket stays open until the next failure prints") is not an item. It goes in the digest only.

## 3. Show the digest

One message, short, before the first question:

- Per architect, one line: what shipped overnight (refs, not prose) and how many items wait on the owner.
- Anything already pushed to the owner's phone overnight, so they know it is covered here.
- The order you will ask in: anything urgent or blocking a builder first, then decisions that unblock queued work, then reviews and taste calls, then housekeeping. Within a level, the oldest first.

No question goes in this message.

## 4. Ask, one at a time

Follow `ob-ask-one-by-one`: every item through `AskUserQuestion`, one per call, each answer recorded before the next question. Each question stands on its own: name the project, the ticket by name and ref, what the architect found, and the options with the architect's recommendation first and marked (Recommended). Add an option "Later" (leave it open) to every question.

A question the owner cannot answer from the dialog alone (a page to look at, a diff, a theme check) says where to look, with the LAN URL or the file path, and offers "I looked: yes", "I looked: no, because…" and "Later".

## 5. Route each answer, at once

As soon as an answer comes back, before the next question:

1. `ob note <ref> "Owner, <YYYY-MM-DD>: <their answer, in their words where they gave words>"`.
2. `ob untag <ref> needs-owner` (a "Later" keeps the tag and gets no note).
3. Tell the owning architect: `t3_thread_send` with `mode: "queue"` to its thread (from the item block, or found by `t3_thread_list` with `titleContains` its architect title), one message: `The owner answered <ref> (<title>): <answer>. The note is on the ticket; act on it.` If that architect thread is gone, the note on the ticket stands and its next architect picks it up from `ob next`; say so in the closing table.
4. If the answer is "yes, land it" for a `needs-human` build, that is the owner's handoff: the architect runs `/ob-spinoff-handoff` and the land. Do not run it here.

An answer that asks for an external send or a destructive step is routed like any other: the architect still shows the owner the exact content (or the backup) and asks again before it acts. This skill's answer is never that confirmation.

A new rule the owner gives while answering ("from now on…") goes in a skill or `CLAUDE.md` the same turn: route it to the OmniSlash architect to chart.

## 6. Close

When every item has an answer or a "Later", end with one table:

| Project | Ticket | Question | Answer | Sent to |
|---|---|---|---|---|

Then a line for what is still open ("Later" items and anything an architect could not be reached for). Nothing else: no recap of the digest.

## Done when

- Every open `needs-owner` ticket and every architect question found in step 1 has the owner's answer or a "Later".
- Every answered item has its note, has lost its tag, and its architect thread has the answer queued (or the closing table says why not).
- The closing table is the last message.
