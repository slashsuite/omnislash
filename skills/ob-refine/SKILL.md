---
name: ob-refine
description: >
  Force-run the Hermes learning loop for THIS session, on demand. Files durable
  facts to always-on memory and reusable procedures as agent-created skill
  tickets, instead of waiting for the live turn's model to judge the turn
  non-trivial or for the session.idle backstop. Triggers: /ob-refine, refine,
  force-run the learning loop, file what we learned, capture memory and skills
  now. Not a spinoff; never a SKILL.md written straight into git skills/.
argument-hint: "[what to focus on]"
---

# ob-refine

The Hermes learning loop files two things out of a working session: **facts** into
this machine's always-on `MEMORY.md`, and **reusable procedures** as skill tickets
the architect can land. Normally the live turn's model makes that call after a
non-trivial turn, and `session.idle` is the backstop when it forgot. This skill is
the human's **force-run** of that same step: run it now, over the whole session,
without waiting for the idle backstop and without re-litigating whether the turn
was "non-trivial enough".

## What to file

1. **Facts → `ob memory add "<fact>"`, for what is true of this machine.** One
   bullet per durable fact: a measured result, a local path or flag worth
   remembering next session. A rule about how to work reaches other machines
   only from the repo, so it goes to the governing skill or `CLAUDE.md` through
   a ticket; a personal value goes in `ob secret set`. `memory add` appends to this machine's XDG
   `MEMORY.md` (capped at 4k chars, oldest bullets dropped) **and** writes the
   same fact as an `ob add --type learning` item. Facts are about *what this machine
   does*, not ticket state.
2. **Reusable procedures → `ob add` a skill ticket.** Title
   `skill: <what it does>`. The `--body` **is** the SKILL.md: frontmatter with the
   `agent_created: true` marker, a kebab `name` starting with `ob-` (own
   skills carry the prefix, upstream ones keep theirs), and a trigger `description`, then
   the numbered procedure. `--tag skill` groups it with the other skill tickets
   (tagging varies; the `agent_created` marker, not the tag, is what the plugin
   reads). No `--issue` and **no spinoff**: a skill reaches the repo only when the
   architect lands the ticket.

## Rules (locked)

- **Git `skills/` stays pinned.** Never write a SKILL.md into the repo checkout.
  The only path into `skills/` is a ticket the architect lands. No silent skills on
  main.
- **No spinoff, no second model.** This skill files; it does not dispatch work and
  does not fork another model to second-guess the session. Idle stays the backstop.
- **File the delta.** Read `ob memory show` and scan `ob list` for what this
  session already filed; file what is missing, not the same fact twice.
- **Be concrete.** A fact or procedure that cannot be re-read and acted on later is
  noise. Tie each to what actually happened: a path, a command, a measured result,
  a decision.
- Keep `agent_created: true` in the `ob add` command you run: it is the marker the
  OpenCode plugin reads to see the session filed something.

## Steps

1. Scan the session (not just the last turn) for facts and reusable procedures.
   `$ARGUMENTS` narrows the focus if given.
2. File each fact: `ob memory add "<fact>"`.
3. File each reusable procedure:
   `ob add "skill: <title>" --tag skill --body $'---\nagent_created: true\nname: ob-<kebab>\ndescription: <trigger sentence>\n---\n# <title>\n\n<procedure>'`
4. Report exactly what you filed (the item ids returned by `ob memory add` /
   `ob add`), or say there was nothing durable to file. Do not invent tickets to
   look busy.
