# Glossary

The domain language of OmniSlash and its `ob` CLI: one word per idea, so tickets, docs and code say the
same thing. Each term is defined once; a word under _Avoid_ is the one to replace when the text around it
is next touched. A new or changed term goes here, in the section it belongs to.

Projects that use `ob` keep their own words in their own repo's glossary. Where a project's glossary and
this one define the same word, the project's wins inside that project.

## Projects

**ob**:
The OmniSlash CLI: one tracker, worklist and coordination layer for every project its owner runs.

**Project**:
One repo or app registered in `ob project list`, with a key (OB, OS) and a stage.

**Stage**:
A project's release level: alpha, beta, rc, stable or legacy. It sets the rule for breaking changes; unset
reads as beta.
_Avoid_: maturity

## Roles and threads

**Team**:
One or more projects that share one architect and one sentinel, with an optional muse.

**Role**:
One of the three standing seats of a team: architect, sentinel, muse.

**Seat**:
The thread a team has bound to a role. Any other thread for that role is retired.

**Role run**:
The one open thread run for a team's role.

**Inbox**:
The stored messages for a team's role, read oldest first.

**Architect**:
The role that plans for a team: it charts, drills, dispatches and keeps the queue moving, and writes no
implementation code.
_Avoid_: planner, planning agent

**Sentinel**:
The role that gates, merges and deploys every pull request of its team. A handoff starts it when none is running.
_Avoid_: lander, verifier

**Muse**:
The optional role that holds the owner's thinking aloud and hands the architect a design once the owner
says it is complete.

**Builder**:
The thread that builds one ticket in its own worktree, opens the PR and stops. It never merges.
_Avoid_: child (for a builder), implementer

## Planning

**Item**:
The tracker's stored record. A ticket is one kind of item; a decision or a learning are others.

**Ticket**:
One unit of planned work on a project's tracker, named by its ref.
_Avoid_: task, issue (an issue is GitHub's)

**Ref**:
A ticket's per-project name, `<KEY>-<number>` (OS-217). It is not the internal item id.

**Brief**:
The body of a ticket, from which a builder's launch prompt is made.

**Done when**:
A ticket's yes or no items that a stranger could sign off.
_Avoid_: acceptance criteria, definition of done

**Spike**:
A ticket that answers questions by trying things and commits no code.
_Avoid_: investigation ticket

**Tier**:
The size label of the complexity score (1 to 10) the architect gives a ticket at dispatch: simple for 1-3,
medium for 4-6, complex for 7-10. The score, not the label, picks the builder's model.

**Priority band**:
A ticket's priority: critical, urgent, flake, high, medium, low or none, in that order.
_Avoid_: P0

**Queue**:
A team's open tickets in the order they will be built.
_Avoid_: backlog

**Focus**:
The focus a user names for the day, on an item tagged `day-focus:<user>`, and the tickets tagged
`focus:<user>` for it. Architects work only those tickets, plus urgents and flakes.
_Avoid_: day theme, theme

## Building and landing

**Spinoff**:
The dispatch of one ticket to a builder, and the row `ob` keeps for it.
_Avoid_: spin-off

**Lease**:
A time-limited hold on a shared resource, such as a ticket, a worktree, a port or the browser slot, with
one live holder.
_Avoid_: lock (for a lease)

**State line**:
The `State:` line that ends every builder commit: landable, needs-human, blocked or partial.

**Landable**:
The state of a build that is gated and ready to merge.
_Avoid_: ready (its old alias)

**Gate**:
The checks a pull request head must pass before it is merged: CI's `gate`, the local-only checks and any
visual check.

**Handoff**:
The builder's declaration that its pull request is ready to gate, which sends the readying note.
_Avoid_: hand-off

**Readying note**:
The message a handoff posts to the team's sentinel.

**Send-back**:
A pull request returned to its builder with what to fix.
_Avoid_: bounce

**Land**:
The whole last step of a ticket: gate, squash-merge, deploy and close. A merge is one part of it.

**Skeptical review**:
The adversarial read of a builder's diff, in which every changed line is presumed wrong until shown right.
_Avoid_: council, adversarial review

**Reader**:
One of the models picked to read in a skeptical review.

**Leg**:
One reader's run on one diff.

**Flake**:
A test that fails and then passes on the same code. A failure seen only under machine overload is not one.
_Avoid_: intermittent

**Watchdog**:
The scheduled check bound to an architect while its builders run.
_Avoid_: poller, babysitter

**Wiring**:
The `.opencode/` files `ob project wire` builds into a checkout: the four `ob-*` plugin shims, the
architect launcher, the architect agent, the `/ob-architect` command and the SOUL.

## Sources and people

**Source**:
An outside system mirrored read-only into `ob`: Gmail, Calendar, WhatsApp.

**Connector**:
The part of `ob` that brings one source in.

**Event**:
A record in `ob`'s append-only store of an outside fact (a pull request, a mail, a message).

**Person**:
An entry in the people registry that senders and attendees map to.

**Interaction**:
A logged contact with a person.
_Avoid_: touchpoint

**Cadence**:
How often the owner means to be in touch with a person.

**Pillar**:
One of the four life areas an item belongs to: personal, business, relationships, health.
_Avoid_: life area

**Secret**:
A value in `ob`'s encrypted store.
