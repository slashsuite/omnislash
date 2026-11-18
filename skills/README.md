# Skills

Agent skills for running `ob`, in the [Claude Code skill format](https://docs.claude.com/en/docs/claude-code/skills): one folder per skill, each with a `SKILL.md` (frontmatter `name` and `description`, then the procedure) and any files it loads.

They tell an agent how to work with `ob`: how to read the live command surface, file a ticket and hand it to a builder, hand finished work back, ask the owner questions, run an unattended night or stop for one, review token usage, and a few general procedures (merge conflicts, local image reading, Slack triage, verifying a signed-in page).

## Use

The skills assume `ob` is on your `PATH`.

Link one skill into your personal skills folder:

```bash
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/<name>" ~/.claude/skills/<name>
```

Or link every skill in this folder:

```bash
mkdir -p ~/.claude/skills
for s in skills/*/; do ln -sfn "$PWD/${s%/}" ~/.claude/skills/; done
```

Run either from the root of your OmniSlash checkout. A linked skill follows the checkout, so a `git pull` updates it.

## What is here

| Skill | What it does |
|---|---|
| `ob-cli` | Loads the live `ob` command index from `ob --help` |
| `ob-ask-one-by-one` | Puts every question to the owner through the question tool, one at a time |
| `ob-refine` | Files the session's durable facts and reusable procedures on demand |
| `ob-new-ticket-implement` | Turns a request into a ticket, a worktree and a spinoff thread |
| `ob-spinoff-handoff` | Hands a finished spinoff to the architect to gate and merge |
| `ob-ux-hill-climb` | Scores a site's UI against rivals and re-scores until it wins every cell |
| `ob-going-to-bed` | Works the buildable queue unattended overnight, logging every call |
| `ob-good-night` | Stops every thread and locks work until 07:00 |
| `ob-muse` | Primes a thread as a team's explorer, which hands over a design only once confirmed |
| `ob-usage-review` | Daily token review: at most three levers, each adopted or skipped |
| `ob-resolving-merge-conflicts` | Resolves an in-progress merge or rebase conflict |
| `ob-vision-understand` | Reads screenshots and images with a local vision model |
| `ob-slack-triage` | Finds unanswered Slack messages and drafts replies from `ob` state |
| `ob-verify-an-auth-gated-page-without-oauth` | Verifies a signed-in page locally when OAuth cannot be completed |

Some skills refer to others (`ob-spinoff`, `ob-land`, `ob-architect` and more) that are not in this folder yet. More skills follow.
