---
name: ob-marketing-copy
description: Write or change the copy on any marketing site of an ob project (slashslash.build, the Hack Cove site, future ones). Facts first, then an outline the owner approves in a Claude Doc, several independent drafts, a persona knockout, the owner's pick, and a builder who transcribes it word for word. Use for a new page, a rewrite, a headline, a pitch, a product claim or a share card on a marketing site, or when a ticket asks a builder to write site copy.
---

# ob-marketing-copy

Copy written by a model alone came out poor, with four faults: facts and clarity, voice, structure, and pitch and audience. The causes, seen across the copy PRs of the Slash sites: builders wrote copy straight into code as part of feature work with no brief, there were no agreed facts per product (facts drifted: a developers page still called PixelSlash "open source (MIT)" a week after it moved to Elastic 2.0), tests policed wording and not meaning, and model personas were the only review. This process is the answer: copy that is reviewed and that makes sense.

**Marketing copy** is every word a visitor reads on a marketing site: headlines, the pitch, section text, product claims, calls to action, the footer line, the share card and the meta description. In-app UI strings are not marketing copy.

The architect of the team that owns the site runs this skill (the muse may run steps 1 and 2 with the owner). Each step ends on the approval named in it; the next step starts only after that approval. Ask every approval with the question tool, one question per call (`ob-ask-one-by-one`). No em or en dashes anywhere: not in the doc, the drafts, the tickets or the copy. Never use the word Tesla, as a name, comparison or metaphor, anywhere: not in the doc, the drafts, the posts, the tickets or the copy, because it makes people very upset these days. This holds for every draft post too, such as the release posts of the marketing queue.

## 1. Facts

Every product the page talks about has a `FACTS.md` at its repo root, beside the README, in the standard format (what it is, today, planned, licence, where it runs), checked against `main` at a stated SHA.

- Read each one on `origin/main` of its repo. A product with no `FACTS.md`, or one whose stated SHA is behind a change to what the product does, gets a facts ticket on its own tracker and this run waits for it.
- The facts are the only source of claims. A draft may say less than the facts; it never says more.

**Done when:** every product the page names has a current `FACTS.md` that the owner approved (its facts ticket records their yes).

## 2. Message and outline, in a Claude Doc

Create one Claude Doc per page (the Claude Docs connector), titled `<site> <page>: copy`, with:

- **Audience:** who lands on this page and what they came for, drawn from the repo's five personas (`docs/personas/`).
- **The one thing** a visitor takes away, in one sentence.
- **Section order:** each section's job in one line, and which facts it draws on (by product and heading in `FACTS.md`).
- **The one headline's job:** the page has one headline, used in the h1, the footer and the share card alike.

No prose yet. Send the owner the doc link and ask whether the outline is approved; on a no, revise the doc and ask again.

**Done when:** the owner has said yes to the outline doc as it stands.

## 3. Several drafts

Write at least three drafts, each from a separate run in its own T3 delegate (`delegate_task` on the model `ob models get job.marketing-draft` prints, so the architect stays free to take messages; if that route prints nothing, stop and tell Jacobus; read its output as ob-architect's Measure twice says: entries in order, moving to the next only on a model error; if an entry's provider `delegate_task` cannot run, stop and tell Jacobus) that gets only the approved outline, the `FACTS.md` files and its own **style brief**, and never sees another draft. Give each run a different style brief (for example: plain and direct; warm and story led; terse and technical), and say in each brief: no claim beyond the facts, no em or en dashes, never the word Tesla, one headline.

Add each draft to the doc as its own tab, labelled with a neutral letter (Draft A, B, C), and keep the style briefs in a separate tab.

**Done when:** the doc holds three or more complete drafts, each covering every section of the outline, each checked line by line against the facts (a claim the facts do not back is cut before the knockout).

## 4. Persona knockout

The repo's five personas judge the drafts in a persona knockout: candidates shown as neutral letters, every match played in both orders, the user base question first. Use the personas as they are; this run does not edit them.

Put the result in the doc (the winner, each persona's vote and reasons, and the finalists). The panel advises; it does not decide.

**Done when:** the knockout record is in the doc and names a winner and a runner up.

## 5. The owner picks and edits

Ask the owner which draft they take (the winner first, the runner up second, with the doc link). They edit it in the doc as much as they like. Then ask them whether the text in the doc is final.

**Done when:** the owner has said the doc's text is final. That text, as it stands at their yes, is the approved copy.

## 6. Transcription by a builder

Ticket the change on the site's tracker and dispatch it like any other ticket (`ob-architect`: drill, Done when, measure twice). The ticket carries:

- the approved copy pasted in full into its body, section by section, with where each piece goes (file and component), since a builder cannot read the Claude Doc;
- the rule: transcribe it word for word, with no rewording, trimming, reordering or added words; a line that will not fit the layout is reported back, never edited to fit;
- `## Done when`: the live page's text matches the approved copy exactly (a test or a diff of the rendered text against the ticket's text), the headline is the same in the h1, the footer and the share card, and the site's facts check passes where the site has one.

After the merge, read the live page against the doc once, and tell the owner only if it differs.

**Done when:** the live page carries the approved copy word for word.

## Feature work and copy

A feature PR changes no marketing copy. When a feature needs new words on a marketing site, it ships with the copy as it was, and the builder names the gap in its handoff; the architect runs this skill for it. The builder rule lives in `ob-spinoff` step 1.
