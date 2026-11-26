---------------------------- MODULE Spinoff ----------------------------
\* OS-211 (OS-112): the spinoff row lifecycle, checked by TLC. One row, its branch's commits past main, its PR
\* and its recorded verdict. `Edges` is SPINOFF_EDGES (platform/state-machine/src/spinoff.ts) written out, and
\* test/tla-parity.test.ts fails when the two differ, so a change to the machine re-checks this model.
\* Run it with `bunx moon run state-machine:tlc` (model/tlc.sh). The ticket lease and the close are the
\* OS-104 spike's model (OS-109, OS-110); this one keeps to the row's own writes.
\*
\* Statuses are the stored words: launched = building, ready-for-gate = handed-off, merged = landed.
\* Not modelled: the send-back restore (`restoreSentBackRow`), which undoes a send-back the builder could not be
\* told of and so puts the row back where it was; races below one guarded UPDATE (the model's steps are atomic,
\* as `moveSpinoff`'s `WHERE status = <read>` is); timing; more than one row.
EXTENDS Naturals

States == {"pending", "launching", "launched", "ready-for-gate", "merged", "failed"}
Events == {"claim", "stamp", "retry", "fail", "handoff", "sendback", "resume", "land", "reopen"}

\* SPINOFF_EDGES as <<from, event, to>>. Keep one triple per line: the parity test reads them.
Edges == {
  <<"pending", "claim", "launching">>,
  <<"pending", "fail", "failed">>,
  <<"launching", "stamp", "launched">>,
  <<"launching", "retry", "pending">>,
  <<"launching", "fail", "failed">>,
  <<"launched", "stamp", "launched">>,
  <<"launched", "handoff", "ready-for-gate">>,
  <<"launched", "land", "merged">>,
  <<"launched", "retry", "pending">>,
  <<"launched", "fail", "failed">>,
  <<"ready-for-gate", "sendback", "launched">>,
  <<"ready-for-gate", "resume", "launched">>,
  <<"ready-for-gate", "land", "merged">>,
  <<"ready-for-gate", "fail", "failed">>,
  <<"merged", "reopen", "launched">>
}

CONSTANT MaxRound   \* how many times the row may go back to building; bounds the state space
VARIABLES st, commits, pr, verdict, vround, round
vars == <<st, commits, pr, verdict, vround, round>>

\* The moves that send work back to building start a new round of it; the verdict judged the last one.
NewRound == {"sendback", "resume", "reopen"}

Init == st = "pending" /\ commits = FALSE /\ pr = FALSE /\ verdict = FALSE /\ vround = 0 /\ round = 0

\* moveSpinoff (cli-coord/src/commands/spinoff.ts): a move only by an edge of the machine, from the stored state.
\* handoff: handoff-ci.ts noPr refuses a branch with commits past main and no open PR (a no-commit scan passes).
\* sendback, resume, reopen: markSpinoffSentBack / Resumed / Reopened write CLEARED_VERDICT with the move.
Move(e) ==
  /\ \E edge \in Edges : edge[1] = st /\ edge[2] = e /\ st' = edge[3]
  /\ e = "handoff" => (pr \/ ~commits)
  /\ IF e \in NewRound
       THEN round < MaxRound /\ round' = round + 1 /\ verdict' = FALSE
       ELSE UNCHANGED <<round, verdict>>
  /\ UNCHANGED <<commits, pr, vround>>

\* The builder commits in its worktree while it builds.
Commit == st = "launched" /\ ~commits /\ commits' = TRUE /\ UNCHANGED <<st, pr, verdict, vround, round>>

\* `gh pr create`: a branch with a commit, from a building row.
OpenPR == st = "launched" /\ commits /\ ~pr /\ pr' = TRUE /\ UNCHANGED <<st, commits, verdict, vround, round>>

\* recordSpinoffVerdict (`ob spinoff state`): only a row a builder is on, guarded on the status it read.
Record == st \in {"launching", "launched", "ready-for-gate"}
          /\ verdict' = TRUE /\ vround' = round /\ UNCHANGED <<st, commits, pr, round>>

Next == \/ \E e \in Events : Move(e)
        \/ Commit \/ OpenPR \/ Record
Spec == Init /\ [][Next]_vars

\* The rules.
TypeOK == st \in States /\ round \in 0..MaxRound /\ vround \in 0..MaxRound
\* OS-111: a build hands off through its PR; only a run with nothing past main hands off without one.
HandedOffHasPR == st = "ready-for-gate" => (pr \/ ~commits)
\* OS-93: a recorded verdict judges the current round of work, never one the gate already sent back.
VerdictFresh == verdict => vround = round
\* `failed` is terminal: once failed, always failed.
FailedTerminal == [][st = "failed" => st' = "failed"]_vars
\* `merged` leaves only by reopen, back to building.
MergedLeavesByReopen == [][st = "merged" /\ st' # "merged" => st' = "launched" /\ round' = round + 1]_vars
=============================================================================
