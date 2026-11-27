---------------------------- MODULE TeamRestart ----------------------------
\* OS-249 (OS-212 follow-up): the team-restart lifecycle of one role seat, checked by TLC. A seat is one
\* team's one role (the registry row teamRoleAgentId), bound to one T3 thread at a time. A restart asks the
\* bound thread for its handoff, opens a replacement seeded with it, retires the old thread (moves its queue,
\* posts the retired notice, settles it once idle) and only then marks the handoff consumed. Senders reach
\* the seat through `ob t3 team forward`, which finds the current thread by team and role.
\*
\* Code: apps/cli/src/team-restart.ts (restartTeamRole, retireThread, settleWhenIdle, moveQueuedMessages,
\* finishRetiring), apps/cli/src/t3/dispatch.ts (ensureTeamThread's replacing check),
\* apps/cli/src/team-forward.ts (resolveForward). Run it with `bunx moon run state-machine:tlc`.
\*
\* Two restarters model two `ob t3 team restart` runs at once (two terminals, or a re-run while the
\* first is still waiting). Either may stop at any step (a crash, a timeout, a failed T3 call) and run again.
\* Not modelled: pending owner requests (they only make a thread busy), the self-restart refusal, a human or
\* T3's auto-settle settling the bound thread by hand (and the resume path that follows it), the row marker
\* for a launch that never recorded its id, timing, message order inside a queue, more than one seat.
EXTENDS Naturals

CONSTANTS Threads, Restarters, None, MaxSends, MaxStarts

VARIABLES
  bound,    \* the seat's current thread (the registry row)
  opened,   \* threads T3 has made; the first is the seat's original
  settled,  \* threads T3 has settled
  running,  \* threads with a turn in flight
  qmsg,     \* forwarded messages queued in each thread
  qask,     \* handoff requests queued in each thread
  qstray,   \* handoff requests moved to a replacement by moveQueuedMessages
  qnote,    \* retired notices queued in each thread
  noticed,  \* threads sent the retired notice (request id ob-retired-<old>, deduped by T3)
  hcount,   \* handoffs each thread has written
  hcons,    \* each thread's newest handoff is consumed
  stray,    \* a thread ran a handoff request it was not sent (a moved one)
  seed,     \* whose handoff seeded each thread
  pc, old, new, before, \* each restarter's step, the thread it replaces, its replacement, hcount at the ask
  sends, starts

vars == <<bound, opened, settled, running, qmsg, qask, qstray, qnote, noticed, hcount, hcons, stray, seed,
          pc, old, new, before, sends, starts>>

T0 == CHOOSE t \in Threads : TRUE
Queued(t) == qmsg[t] + qask[t] + qstray[t] + qnote[t]
Live(t) == t \in opened /\ t \notin settled
Zero == [t \in Threads |-> 0]

Init ==
  /\ bound = T0 /\ opened = {T0} /\ settled = {} /\ running = {}
  /\ qmsg = Zero /\ qask = Zero /\ qstray = Zero /\ qnote = Zero /\ hcount = Zero
  /\ noticed = [t \in Threads |-> FALSE] /\ hcons = [t \in Threads |-> FALSE] /\ stray = FALSE
  /\ seed = [t \in Threads |-> None]
  /\ pc = [r \in Restarters |-> "idle"] /\ old = [r \in Restarters |-> None]
  /\ new = [r \in Restarters |-> None] /\ before = [r \in Restarters |-> 0]
  /\ sends = 0 /\ starts = 0

\* ---- T3: a thread runs one queued message when idle, and ends its turn. ----
\* A handoff request it was sent: it writes a handoff (`ob t3 team handoff`, a new unconsumed row).
\* One moved to it from a retired thread reads the same, so it writes one too and deletes its scheduled tasks.
TakeTurn(t) ==
  /\ Live(t) /\ t \notin running /\ Queued(t) > 0
  /\ running' = running \cup {t}
  /\ \/ qmsg[t] > 0  /\ qmsg' = [qmsg EXCEPT ![t] = @ - 1]
        /\ UNCHANGED <<qask, qstray, qnote, hcount, hcons, stray>>
     \/ qnote[t] > 0 /\ qnote' = [qnote EXCEPT ![t] = @ - 1]
        /\ UNCHANGED <<qmsg, qask, qstray, hcount, hcons, stray>>
     \/ qask[t] > 0  /\ qask' = [qask EXCEPT ![t] = @ - 1]
        /\ hcount' = [hcount EXCEPT ![t] = @ + 1] /\ hcons' = [hcons EXCEPT ![t] = FALSE]
        /\ UNCHANGED <<qmsg, qstray, qnote, stray>>
     \/ qstray[t] > 0 /\ qstray' = [qstray EXCEPT ![t] = @ - 1]
        /\ hcount' = [hcount EXCEPT ![t] = @ + 1] /\ hcons' = [hcons EXCEPT ![t] = FALSE] /\ stray' = TRUE
        /\ UNCHANGED <<qmsg, qask, qnote>>
  /\ UNCHANGED <<bound, opened, settled, noticed, seed, pc, old, new, before, sends, starts>>

EndTurn(t) ==
  /\ t \in running /\ running' = running \ {t}
  /\ UNCHANGED <<bound, opened, settled, qmsg, qask, qstray, qnote, noticed, hcount, hcons, stray, seed,
                 pc, old, new, before, sends, starts>>

\* ---- ob t3 team forward (team-forward.ts resolveForward + forwardToSeat): the sender names any thread it
\* remembers. The seat's current thread is sent to; one the seat retired (it wrote a handoff and is no longer
\* bound) is redirected to the current thread; any other is refused with nothing sent. A send unsettles a
\* settled thread (T3). Resolve and send are one step here; split, TLC finds OS-282 (see the README). ----
Forward ==
  /\ sends < MaxSends
  /\ \E t \in opened :
       LET to == IF t # bound /\ hcount[t] > 0 THEN bound ELSE t    \* guard:redirect a retired id
       IN /\ to = bound                                              \* guard:redirect refuse any other id
          /\ qmsg' = [qmsg EXCEPT ![to] = @ + 1]
          /\ settled' = settled \ {to}
  /\ sends' = sends + 1
  /\ UNCHANGED <<bound, opened, running, qask, qstray, qnote, noticed, hcount, hcons, stray, seed,
                 pc, old, new, before, starts>>

\* ---- ob t3 team restart, one restarter r (restartTeamRole). ----
SetPc(r, p) == pc' = [pc EXCEPT ![r] = p]
Frame == UNCHANGED <<bound, opened, settled, running, qmsg, qask, qstray, qnote, noticed, hcount, hcons,
                     stray, seed, sends>>

\* The resume branch: the bound thread was seeded from a handoff nobody consumed, so an earlier run opened it
\* and stopped before the consume; finish retiring the thread it replaced (finishRetiring).
Resumable(b) == Live(b) /\ seed[b] # None /\ ~hcons[seed[b]]

Resume(r) ==
  /\ pc[r] = "idle" /\ starts < MaxStarts /\ starts' = starts + 1
  /\ Resumable(bound)
  /\ old' = [old EXCEPT ![r] = seed[bound]] /\ new' = [new EXCEPT ![r] = bound]
  /\ SetPc(r, IF Live(seed[bound]) THEN "move" ELSE "consume")
  /\ Frame /\ UNCHANGED before

\* (a) a busy thread is skipped unless --force, which interrupts it; (b) the handoff request is queued.
Ask(r) ==
  /\ pc[r] = "idle" /\ starts < MaxStarts /\ starts' = starts + 1
  /\ Live(bound) /\ ~Resumable(bound)
  /\ \E force \in BOOLEAN :
       LET busy == bound \in running \/ Queued(bound) > 0
       IN /\ busy => force
          /\ running' = running \ {bound}
  /\ qask' = [qask EXCEPT ![bound] = @ + 1]
  /\ old' = [old EXCEPT ![r] = bound] /\ before' = [before EXCEPT ![r] = hcount[bound]]
  /\ SetPc(r, "wait")
  /\ UNCHANGED <<bound, opened, settled, qmsg, qstray, qnote, noticed, hcount, hcons, stray, seed, sends, new>>

\* (c) a handoff newer than the ask, from the thread asked.
GotHandoff(r) == pc[r] = "wait" /\ hcount[old[r]] > before[r] /\ SetPc(r, "open") /\ Frame
                 /\ UNCHANGED <<old, new, before, starts>>

\* (e) ensureTeamThread with replacing = old: it opens a new thread only while the row still names old (or a
\* thread that is not live); a row naming another live thread is reported, nothing opened, and the run fails.
Open(r) ==
  /\ pc[r] = "open"
  /\ \/ /\ bound = old[r] \/ ~Live(bound)                                   \* guard:replacing
        /\ \E t \in Threads \ opened :
             /\ opened' = opened \cup {t} /\ bound' = t
             /\ seed' = [seed EXCEPT ![t] = old[r]]
             /\ running' = running \cup {t}                                 \* (f) the seed turn
             /\ new' = [new EXCEPT ![r] = t]
        /\ SetPc(r, "move")
     \/ /\ ~(bound = old[r] \/ ~Live(bound))
        /\ SetPc(r, "idle") /\ UNCHANGED <<bound, opened, seed, running, new>>
  /\ UNCHANGED <<settled, qmsg, qask, qstray, qnote, noticed, hcount, hcons, stray, sends, old, before, starts>>

\* (g) moveQueuedMessages: copy each queued message to the replacement (request id ob-retired-move-...), then
\* withdraw it from the old thread. A queued handoff request (a second restart's, or a --force re-run's) is
\* withdrawn and never moved (OS-249). A queued retired notice (an earlier run's, its settle ran out) stays.
Move(r) ==
  /\ pc[r] = "move"
  /\ LET o == old[r]  n == new[r] IN
     /\ qmsg' = [qmsg EXCEPT ![n] = @ + qmsg[o], ![o] = 0]
     /\ qstray' = [qstray EXCEPT ![n] = @ + qstray[o], ![o] = 0]                 \* guard:withdraw-ask
     /\ qask' = [qask EXCEPT ![o] = 0]
     /\ qnote' = qnote                                                           \* guard:keep-notice
  /\ SetPc(r, "notice")
  /\ UNCHANGED <<bound, opened, settled, running, noticed, hcount, hcons, stray, seed, sends,
                 old, new, before, starts>>

\* The retired notice, queued; T3 drops a second send with the same request id (ob-retired-<old>).
Notice(r) ==
  /\ pc[r] = "notice"
  /\ LET o == old[r] IN
     IF ~noticed[o]                                                         \* guard:dedup
       THEN /\ qnote' = [qnote EXCEPT ![o] = @ + 1] /\ noticed' = [noticed EXCEPT ![o] = TRUE]
            /\ settled' = settled \ {o}
       ELSE UNCHANGED <<qnote, noticed, settled>>
  /\ SetPc(r, "settle")
  /\ UNCHANGED <<bound, opened, running, qmsg, qask, qstray, hcount, hcons, stray, seed, sends,
                 old, new, before, starts>>

\* settleWhenIdle: a settled header is done; a live run or a queued message is waited out; then settle. The
\* wait can run out (retireTimeoutMs) with the thread unsettled, and the run goes on to the consume check.
Settle(r) ==
  /\ pc[r] = "settle"
  /\ LET o == old[r] IN
     \/ o \in settled /\ UNCHANGED settled
     \/ /\ o \notin settled
        /\ o \notin running                                                 \* guard:idle
        /\ Queued(o) = 0                                                    \* guard:drain
        /\ settled' = settled \cup {o}
     \/ UNCHANGED settled
  /\ SetPc(r, "consume")
  /\ UNCHANGED <<bound, opened, running, qmsg, qask, qstray, qnote, noticed, hcount, hcons, stray, seed,
                 sends, old, new, before, starts>>

\* (h) the handoff is consumed only once the old thread settled; a settle that timed out fails the role.
Consume(r) ==
  /\ pc[r] = "consume"
  /\ hcons' = IF old[r] \in settled                                         \* guard:consume
                THEN [hcons EXCEPT ![old[r]] = TRUE] ELSE hcons
  /\ SetPc(r, "idle")
  /\ UNCHANGED <<bound, opened, settled, running, qmsg, qask, qstray, qnote, noticed, hcount, stray, seed,
                 sends, old, new, before, starts>>

\* A run stops part way: a wait timed out (the handoff, the turn, the settle), a T3 call failed, or the
\* process died. The store and T3 keep what it did; a re-run starts from the top.
Stop(r) == pc[r] \notin {"idle", "consume"} /\ SetPc(r, "idle") /\ Frame /\ UNCHANGED <<old, new, before, starts>>

Next ==
  \/ \E t \in Threads : TakeTurn(t) \/ EndTurn(t)
  \/ Forward
  \/ \E r \in Restarters : Resume(r) \/ Ask(r) \/ GotHandoff(r) \/ Open(r) \/ Move(r) \/ Notice(r)
                           \/ Settle(r) \/ Consume(r) \/ Stop(r)
Spec == Init /\ [][Next]_vars

\* ---- The rules. ----
TypeOK == bound \in opened /\ opened \subseteq Threads /\ settled \subseteq opened /\ running \subseteq opened
\* The seat always has a live thread: the replacement is bound before the old thread is settled.
SeatLive == Live(bound)
\* A settled thread holds no queued message: nothing sent to the seat is stranded where no turn will run it.
SettledHoldsNothing == \A t \in settled : Queued(t) = 0 /\ t \notin running
\* A handoff is consumed only once the thread that wrote it is settled, so a re-run still finishes the retire.
ConsumedOnlyRetired == \A t \in Threads : hcons[t] => t \in settled
\* One handoff seeds one replacement: the seat never has two threads opened from one handoff.
OneSeedPerHandoff == \A a, b \in opened : a # b /\ seed[a] # None => seed[a] # seed[b]
\* Only a thread a restart asked writes a handoff: a replacement is never told to hand off and drop its tasks.
NoStrayHandoff == ~stray

\* The seat's current thread never holds a retired notice: only a retired thread is told it is retired.
NoNoticeToSeat == qnote[bound] = 0
\* A retired thread, once settled, stays settled: nothing wakes it back into the sidebar.
RetiredStaysSettled == [][\A t \in settled : t # bound => t \in settled']_vars
=============================================================================
