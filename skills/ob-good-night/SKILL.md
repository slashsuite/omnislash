---
name: ob-good-night
description: End the owner's working day. Stops every builder after a checkpoint, tells every architect, sentinel and muse to stop, pauses their scheduled watchdogs, and locks work until 07:00 so the owner goes to sleep. The opposite of ob-going-to-bed, which keeps working overnight. Triggers on "good night", "goodnight", "shut it all down for the night", "I'm done for the day", /ob-good-night. Also read by any agent that finds the lock on.
---

# ob-good-night

Unlike going to bed, good night runs no tasks. It shuts down all the planners and everything else for the day, and it stops the owner from doing more work until the next morning around 07:00, so they get more sleep.

The owner chose a hard lock, and asked to be called out when a request made during the lock is not urgent.

This skill runs no tickets, lands nothing and dispatches nothing. Use `ob-going-to-bed` for a night of work; use this one for a night of sleep.

## The lock

The lock ends at 07:00 local time on the next morning.

The lock is the file `~/.cache/ob-good-night`, holding the end time as an ISO timestamp. Write it with `date -d 'tomorrow 07:00' --iso-8601=seconds > ~/.cache/ob-good-night` (use `today 07:00` when it is already past midnight and before 07:00). It is locked while that time is in the future.

## Saying good night (the thread the owner says it in)

Do every step without asking the owner anything. They are going to sleep.

1. **Find what is running.** `ob t3 team list` and `ob t3 team show <team>` for every architect, sentinel and muse thread. `ob spinoff list --status building` for builder threads. `list_scheduled_tasks` for each T3 project (`t3_project_list`) for the scheduled tasks.
2. **Builders: checkpoint, then stop.** Send each running builder thread (`t3_thread_send`, mode `steer`): "Good night (ob-good-night). Stop now: commit your work in progress on your branch as `chore(<ref>): wip checkpoint` with `State: partial`, write `ob note <ref>` saying where you are and what is next, push the branch, open no PR, then end your turn. Start nothing else until 07:00." Give them 10 minutes. Then `t3_thread_interrupt` any builder still running, and say which in the table.
3. **Role threads: stop.** Send each architect, sentinel and muse thread (mode `queue`): "Good night until 07:00 (ob-good-night). Dispatch, gate, merge and deploy nothing. Answer any message with: Good night is on until 07:00. Go to sleep." Do not settle or restart them.
4. **Pause the scheduled tasks.** Every scheduled task that would run before 07:00 is set `enabled: false` with `schedule_task` (`scheduledTaskId`, `enabled: false`). Keep a list of their ids. Leave tasks that first run at or after 07:00 alone, and leave one-off reminders for later days alone.
5. **The morning wake.** One `schedule_task`, `type: once`, `runAt` the lock's end, `bindToCurrentThread: false`, titled `Good morning: lift good night`, whose prompt re-enables exactly the paused task ids (listed in the prompt), removes `~/.cache/ob-good-night`, and tells each role thread "Good night is over; carry on." It sends the owner nothing: `ob-good-morning` is theirs to run.
6. **Lock.** Write the lock (above).
7. **Say it, then stop.** One short table: builders checkpointed or interrupted, role threads told, tasks paused, the lock's end. Then one line: "Good night. Everything is stopped until 07:00." End the turn.

## While the lock is on (every agent, every thread)

Check the lock at the start of every turn that would do work: read `~/.cache/ob-good-night`.

- **Locked:** do no work. Reply only: "Good night is on until 07:00. Go to sleep." Capturing a thought is allowed: `ob add` it, say it is saved for the morning, and stop.
- **The owner says it is urgent:** judge it honestly before you agree. Urgent means something is broken for real people right now, data is at risk, a security problem, or a hard deadline before 07:00. A bug, an idea, a refactor, a ticket the owner is curious about, or "it will only take a minute" is not urgent: say so plainly ("That is not urgent. It will still be there at 7. Go to sleep.") and do nothing. The owner asked to be called out.
- **It is urgent:** lift the lock for that one thing (delete the file and log the why with `ob overnight decide`), do only that, then lock again with the same end time and say good night again.
- A builder or scheduled run that wakes during the lock ends its turn at once without doing anything.

## Rules

- No questions to the owner at good night: the decisions are made here. Every message follows the house rules: no em or en dashes.
- Nothing is merged, deployed, closed or sent externally after good night.
- Do not settle, restart or delete any thread: the morning picks up where the night stopped.
