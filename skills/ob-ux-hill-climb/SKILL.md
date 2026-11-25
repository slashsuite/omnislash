---
name: ob-ux-hill-climb
description: UI hill climbing. Score our site's UI against one or more rival sites on eight metrics, in light and dark, with the table at the end, then keep re-scoring until every cell beats the best rival. Use to compare sites, hill climb the UX or UI, or re-score after fixes. UI only; backend and planning climbs are separate skills.
---

# UX hill climb

A **climb** compares our site against rivals until ours wins every cell. The caller may be any repo's architect. Rivals are only looked at: no asset, copy or code is taken from them. The fix work is ordinary tickets, dispatched with `ob spinoff`; this skill never builds a fix.

## Terms

- **Cell**: one metric, in one theme, for one site.
- **Leg**: steps 1 to 6. **A climb is one kit per leg**: a leg captures afresh into its own kit and reads no earlier kit's PNGs.
- **Kit**: `~/dev/ux-hill-climb/<us>-vs-<rival>-<date>/`, outside any repo, because many repos are public and scores must not reach them. The PNGs sit in `shots/`; briefs, `rounds/` and `report.md` sit beside it.
- **Stage**: how many readers a leg runs. Stage 1 is `opus` alone (`sonnet` is its old name), round 1 only. Stage 2 adds `neon`, Opus's default fallback reader, and runs round 1 and round 2. DeepSeek and Luna are retired (OS-206) and no stage runs them.
- **Reader swap.** Older kits may have run `deepseek` or `luna` as readers. Their comparisons stand until a new first leg re-baselines with `neon` and `opus`.
- **Comparison**: the latest two-reader result, from stage 2 or from a first leg. **First leg**: a leg while no comparison exists yet (no earlier kit, or only provisional ones). It runs stage 2 outright, and its result is the comparison once both readers ran.
- **Bar**: for each theme, the best rival's cell in the comparison. A theme where a rival is `n/a` skips that rival; a theme where our site is `n/a` (or every rival is) is skipped in the bar check and the stop test.
- **Our score** for a cell: stage 1, the one reader's round 1 score. Stage 2, the median of the readers' round 2 scores (with two readers, their midpoint). When a reader did not run, the round 1 scores of the readers that did (the median again).
- **`provisional`**: a reader the stage needed did not run. A planned smaller stage is not provisional.
- **Frozen**: a cell that fell short and showed no gain in two re-scores in a row, at the same stage with the same readers. Gain means our score rose from the previous re-score.

## The eight metrics

- **Typography:** the type's choice, scale, weight and line length.
- **Hierarchy:** what the eye reads first, second and third, and whether that matches what matters.
- **Space and density:** how the page uses room: rhythm, alignment, no dead zones, no crowding.
- **Colour and contrast:** a palette that holds together, and text and controls that stay legible.
- **Iconography:** icons that are coherent, the right size, and carry meaning.
- **Consistency and polish:** the same parts behave and look the same across pages; no visible defects.
- **Clarity:** how quickly a stranger understands what this is, who it is for and what to do next.
- **Overall:** the reader's judgement of the whole, not computed, so later legs compare with the first leg.

## Steps

### 1. Inputs

Fix our site, at least one rival, and the pages to compare (default: home, pricing, docs, where they exist). Find our site's `ob` project in `ob project list`. If our site has no `ob` project, stop and ask the owner; tickets never go on another project instead. Make the kit directory, with `shots/` and `rounds/` inside. A later leg reads its re-score ticket for the earlier kit paths.

Done when the kit exists (with `shots/` and `rounds/`), the project is known, and you know whether this is a first leg (stage 2) or a re-score (stage 1).

### 2. Capture

Capture every site afresh, rivals included, in the T3 browser (load the `preview_*` tools with ToolSearch; `preview_open` with `open: false`; close the tab at the end).

- Theme: `preview_set_appearance`, then `preview_navigate` again. Check by eye the first tile in both light and dark: the same look means the page has no theme of that name. Also look for a theme toggle on the page and use it.
- Size: `preview_resize` to 1440x900 for desktop and 390x844 for phone. The size applies on the next navigate, so confirm `innerWidth` with `preview_evaluate`.
- Tiles are viewports down the page, never a stitched page. Warm up first: scroll in 600px steps, 350 ms apart (set `scroll-behavior: auto` on the root first), then back to the top and wait 1500 ms. Read `scrollHeight`, take tiles with the last one ending at the page bottom, scroll to each with `preview_evaluate` using `scrollTo({top, behavior: "instant"})` (smooth scrolling can leave the page where it was), wait about 1300 ms, then settle the page in the same `preview_evaluate`: `document.getAnimations().forEach(a => a.finish())`, wait 300 ms, then `preview_snapshot` with `save: true`. A tab opened with `open: false` freezes the animation clock until a snapshot wakes it, so a bare wait leaves reveal animations and counters half-run (a first run showed a blank hero and a "0" counter that way, and the reader scored the blur). Settle every tile of every site the same way. Read `scrollHeight` again after the last tile and add tiles if the page grew. A snapshot that times out saved nothing: reload, warm up, jump straight to that tile and retake it.
- Phone: two tiles per page and theme, the hero and the next viewport.
- Name files `<site>-<theme>-<page>-<n>.png`, and `<site>-<theme>-<page>-mobile-<n>.png` for the phone. `mv` each PNG from the path its `preview_snapshot` result gives into the kit's `shots/` as you take it. The browser's artifact folder also holds earlier runs' PNGs, so never glob it.
- Every site gets the same tab setup. The PNG may be a scaled copy of the viewport; check that the dimensions match across sites and say so in the report.

Record for each site which pages exist in which theme. A theme that none of the compared pages shows is `n/a`, never a score. A column that rests on only some pages says so in the report.

Done when every site, page and theme the record lists has its tiles in `shots/`, and the record names each `n/a` and each column that rests on some pages only.

### 3. Score: pick the stage, run round 1

Stage: a first leg runs stage 2. A re-score starts at stage 1.

Fill the round 1 template in `briefs.md` once per leg into `brief-round1.md` in the kit, and reuse that file for every stage of the leg. The brief is blind: which site is ours is not disclosed, the sites appear in random order, and it carries no earlier score, target, ticket, PR or repo name. Readers run from a copy of `shots/` under a neutral name (`cp -r <kit>/shots $TMPDIR/uxr-$RANDOM`), because the kit path names our site. That keeps the briefs, `rounds/` and the report out of the working directory; the OpenCode readers can still open any path by name, so the brief names no path outside it.

Run each reader the leg has not yet run, independently, on the same brief, in the background:

```bash
K=<kit>; W=$TMPDIR/uxr-$RANDOM; cp -r $K/shots $W; cd $W
for leg in opus neon; do   # only the readers of this stage that have no round 1 answer yet
  { bun ~/.claude/skills/ob-skeptical-review/review-leg.ts $leg < $K/brief-round1.md > $K/rounds/r1-$leg.txt 2> $K/rounds/r1-$leg.err; echo "$leg exit $?" >> $K/rounds/r1.status; } &
done; wait; cd; rm -rf $W
```

Each reader scores every metric out of 10 (whole or half numbers) for every site and theme, with one evidence line per metric naming a file. A reader that exits non-zero, or answers `CANNOT READ IMAGES`, did not run. A later stage keeps the round 1 answers already in `rounds/` and never re-runs those readers.

Done when every reader the stage needs has an answer in `rounds/r1-<reader>.txt`, or is recorded as not run.

### 4. Score: round 2, then the bar

Round 2 applies only with two or more readers that ran. Fill the round 2 template into `brief-round2-s<stage>.md`: each reader sees all the round 1 answers, unattributed and in random order, and may move its scores. Run every reader of the stage as step 3 does, from a copy of `shots/`, into `rounds/r2-s<stage>-<reader>.txt`. A later stage writes new files and overwrites none.

Then, and only then, compare with the bar. Brief stays blind; the comparison happens after the readers have answered.

- **Stage 1:** if every cell of ours (frozen cells left out) is at or above the bar in the same theme, go back to step 3 and add the next reader, on the same kit and captures. If any cell is below, stop at this stage and go to step 5 with those cells.
- **Stage 2:** go to step 5 with each cell that is not strictly above the best rival in this same run. This result becomes the comparison (a first leg's own run is its comparison, so its bar columns read the same run).
- **A reader the stage needs did not run:** stop at this stage, say which reader, and mark the result `provisional`. It cannot pass the bar, end the climb or freeze a cell. An `opencode-go` reader that did not run because the account is out of credits (`ob creds check opencode-go` reports FAILED) also files the owed ticket, in the same step as the report, with the `ob add` line and body of ob-skeptical-review's Out of credits rule. Its title names the kit (not a ticket that may not exist yet), and the body carries this leg's kit path and the stage. Paying it back runs that stage's readers on the same kit (ob-architect, Owed reviews). A planned smaller stage is not provisional and owes nothing.

Done when the stage's cells are scored, the bar check has run, and you know which cells fell short, or that the result is `provisional`.

### 5. Stop

The climb ends when the result is a stage 2 result with both readers and every cell of ours is either strictly above the best rival in the same theme and the same run, or frozen. A stage 1 result never ends it, and neither does a `provisional` one.

A **frozen** cell is not looped on and gets no fix ticket. Stage 1 leaves frozen cells out of the bar check, so a leg can reach stage 2. Log frozen cells for the owner with `ob note <re-score ticket>` and in the report.

Say which test ended it, or that it did not end.

Done when the report's `Ended:` field can say one of: `every cell strictly above`, `every remaining cell frozen`, `not yet, re-score ticket <ref>`, `provisional, re-score ticket <ref>`.

### 6. Keep the climb alive

For each cell that fell short, file one fix ticket per problem with `ob add --project <our project>`, naming the cells and the files. A frozen cell gets none. Each fix ticket's body says its PR body carries a `## UX hill climb` section: the table described in step 7, with this leg's row, and for a private repo also this leg's report tables as filed and the kit path. Check with `gh repo view <repo> --json visibility` (the repo is in `ob project list`). A public repo's section shows our scores only, with no rival name and no rival score; the full tables stay in the kit and on the private `ob` ticket.

When step 5 did not end the climb, file the next re-score ticket the same way, on our project, with `--priority high`. Its body carries: the kit path of this leg, the kit path of the comparison, every earlier kit path oldest first, this skill's name (`ob-ux-hill-climb`), and the lines "a re-score starts at stage 1" and "the architect runs this in its own thread, not through `ob spinoff` (it captures and scores and builds nothing), and closes it with `ob close` once its report is filed". Record each fix ticket as its blocker with `ob link <fix ticket> blocks <re-score ticket>`. With no fix tickets, nothing blocks it. Whenever step 4 filed an owed ticket for this leg, link it as a blocker too, with or without fix tickets: `ob link <owed ticket> blocks <re-score ticket>`, so a reader that cannot run does not loop the climb.

The leg is not done until the re-score ticket exists, blocked by that leg's fix tickets, and the report names it. When step 5 ends the climb, no ticket is filed and the report says which test ended it.

### 7. Record and report

First, append this leg to the `## UX hill climb` section of each PR of the previous leg's fix tickets, merged ones included (find them with `ob show <fix ticket>` or `gh pr list --state all --search <ref>`), using `gh pr edit <pr> --body-file <file>`. A re-score has no PR of its own.

The section is one table, `Leg | Stage | Readers | Theme | Typography | Hierarchy | Space and density | Colour and contrast | Iconography | Consistency and polish | Clarity | Overall`, with a row per theme of our scores. The fix ticket's PR starts it with the leg that filed the ticket; each leg appends its rows and overwrites nothing. A private repo's section also holds the filing leg's report tables as filed and the kit path. A public repo's never holds a rival name or score.

Then write the report to `report.md` in the kit and print it. **The report table is the last thing in the output.**

```markdown
## UX hill climb

Leg: 2 · Stage: 1 of 2 · Readers: 1 of 1 · Ended: not yet, re-score ticket <ref>
Bar: leg 1, 2 of 2 readers
Rests on: rival.com light is docs only

| Reader | Round 1 | Round 2 |
| --- | --- | --- |
| claude-sonnet-5-5 (high) | 7/10 | n/a |

| Metric | Us light (first leg) | Us light | Us dark (first leg) | Us dark | Rival light | Rival dark | Bar light | Bar dark |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Typography | 5/10 | 8/10 | 6.5/10 | 8/10 | 7.5/10 | 7.5/10 | 7.5/10 | 7.5/10 |
| Overall | 5/10 | 7.5/10 | 6.5/10 | 8/10 | 7/10 | n/a | 7/10 | n/a |
```

- The Reader rows show each reader's Overall for our site, round 2 when the stage has one. A reader that did not run reads `failed`, or `skipped (no credits), owed <ref>` when step 4 filed its owed ticket.
- `Readers: <ran> of <the stage needs>`; fewer reads `provisional` on the `Ended:` line, and names the readers that ran. If a reader answers `CANNOT READ IMAGES`, it counts as not run.
- Every metric gets a row. Several rivals add a column per rival theme. Both `Bar` columns are the best rival's cell in the comparison.
- A first leg fills the `(first leg)` columns with its own scores. A later leg reads the first leg's `report.md` for them only now, when writing the report, never in a reader's brief.
- A frozen cell is marked `(frozen)` in the table and listed on a line above the tables; the tables stay last.

Done when `report.md` exists, the PR sections are appended, the re-score ticket (if any) is filed, and the last lines of the output are the report's tables.
