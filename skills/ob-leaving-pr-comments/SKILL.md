---
name: ob-leaving-pr-comments
description: "Use whenever leaving a comment on GitHub on the owner's behalf: a PR comment, an inline review comment, a reply to a bot or reviewer, or the note explaining a dismissed finding. Every comment needs the owner's confirmation of the exact text first."
---

# Leaving PR comments

Adapted from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) `leaving-pr-comments` (see `skills/README.md`).

A comment posted on GitHub goes out under the owner's account, to people outside this machine. It is an external send,
so your global agent rules for external sends apply: **nothing goes out until the owner has confirmed the exact text.**

## Confirm first

1. Draft the full comment, with the note below, and show it to the owner in the chat, verbatim.
2. Wait for the owner's yes on that exact text. A yes to a different draft, or a yes to "reply to the bot", is not a yes to this one.
3. Post only the text the owner confirmed. If they edit it, show the edit and confirm again.

This applies to every comment, including a one-line reply to a bot and a note that resolves a thread. The one exception is
a comment the owner explicitly asked you to post verbatim, in their own words, in that message.

## Attribution note

Prefix every agent-authored comment with this GitHub note callout:

```md
> [!NOTE]
> 🤖 **<model> responding on behalf of <user>**

Actual comment starts here.
```

Use the verified public name of the model that wrote the comment, and the user's name or GitHub login. If the harness does
not expose a model name, use the harness name. Do not guess.

The context line must start with the robot emoji. Do not add a horizontal rule, Setext underline, heading, signature footer
or a second attribution. Keep the attribution inside the note and the reply outside it.

This is a comment attribution, not a commit attribution. The "no AI attribution" rule for commits and PR bodies is separate:
never add a `Co-Authored-By` trailer or an AI footer to a commit or a PR body.

## Secret scan

Before you post, check the entire comment, including quoted text, code blocks and attachments, for secrets and private
details: tokens, keys, `.env` values, the ob secret store contents, phone numbers, addresses, private message text, the
contents of `ob` databases. A secret that was pasted once stays in GitHub's history. If one is already in a comment, stop and
tell the owner; do not post a correction that repeats it.

## Writing the comment

- Lead with the conclusion.
- Cite the relevant code, behaviour, check or reproduction.
- Keep it short. No filler, canned thanks or status narration ("still working on it").
- Separate verified facts from judgment.

Preview the final Markdown before you post, so quoting and blank lines render as they will read.

## After posting

Verify that GitHub returned the comment or review URL, and report it. Resolve a review thread only after its reply posted
successfully. Do not post a follow-up comment unless it serves a request the owner made.
