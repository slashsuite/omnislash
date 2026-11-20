# Briefs for ob-ux-hill-climb

The two brief templates of an earlier skeptical design review, with the site names, file lists and theme facts as placeholders. Keep the wording as it is, so scores stay comparable across legs. Fill only the `{{…}}` placeholders. Write each filled brief into the kit directory (`brief-round1.md` once per leg, `brief-round2-s<stage>.md` per stage). Round 2 exists only with two or more readers: a stage with one reader runs round 1 alone.

Placeholders:

- `{{PRODUCT_KIND}}`: what the sites are, plural, as a short phrase (the worked example used `visual-testing product websites`). Describe the kind of product only, never which site is ours.
- `{{ROLE}}`: how the reader is introduced. Round 1, always: `a senior product designer`, so one brief serves every stage of the leg. Round 2, by the readers that ran: `one of two senior product designers on a design council`, `one of three senior product designers on a design council`.
- `{{READERS}}`: round 2 only. `three readers, A, B and C` or `two readers, A and B`.
- `{{COUNT}}`: the number of sites in words (`two`, `three`), so "two" follows the real count.
- `{{SITE_A}}`, `{{SITE_B}}` and `{{DOMAIN_A}}`, `{{DOMAIN_B}}`: the sites in a random order, so which one is ours is not disclosed. With more sites, add each one to the sentence ("{{SITE_A}} (…), {{SITE_B}} (…) and {{SITE_C}} (…)") and a light and dark column pair to every table. With more than two sites, "either" in "no stake in either" reads "any of them". Skip a site's column in a theme where it has no screenshots (`n/a`).
- `{{FILES}}`: the PNG names in `shots/`, space separated, from `ls`.
- `{{THEME_FACTS}}`: one bullet per site from the capture record (step 2): which pages exist in which theme, and which column rests on which pages. Measured facts only. No scores, no targets, no mention of which site is ours.
- `{{COLUMNS}}`: the table header, `Category | {{SITE_A}} light | {{SITE_A}} dark | {{SITE_B}} light | {{SITE_B}} dark`.
- `{{ROUND1_TABLES}}`: round 2 only. Every reader's round 1 answer, in full, headed `=== READER A ===`, `=== READER B ===` and, with three readers, `=== READER C ===`, in a random order, with no model names.
- `{{CHECKS}}`: round 2 only. Facts checked on the live sites since round 1, one bullet each, or leave the list out when there are none.

If a reader's round 1 failed, leave it out of round 2 and say how many readers there are.

## Round 1 (`brief-round1.md`)

```
This is a visual design review, not a code review, so there is no diff or git history. The evidence is the PNG screenshots in the current directory. Your read tool can open PNG files: open every one before you score anything. If you truly cannot see image contents, write only "CANNOT READ IMAGES" and stop. Never score from file names.

You are {{ROLE}}. Give an independent, sceptical view of how {{COUNT}} {{PRODUCT_KIND}} compare: {{SITE_A}} ({{DOMAIN_A}}) and {{SITE_B}} ({{DOMAIN_B}}). You have no stake in either. A 10 is rare; 5 is competent but unremarkable. Do not favour a site for its size, its fame or its features: score the design as shown.

Screenshots: desktop tiles are 1440x900 viewports taken while scrolling down a page, so sticky headers repeat and that is real. "-mobile" is a 390 wide phone view. Animations had finished. Names are <site>-<theme>-<page>-<n>.png.
Files: {{FILES}}

Theme facts, measured:
{{THEME_FACTS}}
Say so where a column rests on only some pages, and where it limits your judgement.

Score each out of 10 (whole or half numbers). Output exactly:

1. A table: {{COLUMNS}}
   Rows: Typography, Hierarchy, Space and density, Colour and contrast, Iconography, Consistency and polish, Clarity, Overall.
2. One evidence line per category, naming the files you relied on.
3. "Worst problems:" up to 3 per site, each naming a file.
4. "Which is better overall and why:" two sentences.

Be concrete. Do not write anything to disk. Your final message is your whole answer.
```

## Round 2 (`brief-round2-s<stage>.md`)

```
This is a visual design review, not a code review, so there is no diff or git history. The evidence is the PNG screenshots in the current directory. Your read tool can open PNG files: open every one before you score anything. If you truly cannot see image contents, write only "CANNOT READ IMAGES" and stop. Never score from file names.

You are {{ROLE}}. Give an independent, sceptical view of how {{COUNT}} {{PRODUCT_KIND}} compare: {{SITE_A}} ({{DOMAIN_A}}) and {{SITE_B}} ({{DOMAIN_B}}). You have no stake in either. A 10 is rare; 5 is competent but unremarkable. Do not favour a site for its size, its fame or its features: score the design as shown.

Screenshots: desktop tiles are 1440x900 viewports taken while scrolling down a page, so sticky headers repeat and that is real. "-mobile" is a 390 wide phone view. Animations had finished. Names are <site>-<theme>-<page>-<n>.png.
Files: {{FILES}}

Theme facts, measured:
{{THEME_FACTS}}
Say so where a column rests on only some pages, and where it limits your judgement.

This is round 2 of the council. Round 1 below was written independently by {{READERS}}. You are one of them. The council gives one verdict, so argue it out: where you disagree with another reader, open the file in question, look again, then either hold your score with a reason or move. Do not average for the sake of it, and do not move only to agree.

Checks made on the live sites since round 1. Treat these as fact:
{{CHECKS}}

Output exactly:
1. A table with your final scores out of 10: {{COLUMNS}}. Rows: Typography, Hierarchy, Space and density, Colour and contrast, Iconography, Consistency and polish, Clarity, Overall.
2. "Moved:" each score you changed by 0.5 or more, and why, in one line each.
3. "Holding against the others:" any score where you still disagree with another reader by 1.5 or more, and why.
4. "Agreed verdict:" two sentences on which site is better and where the other one wins.

Do not write anything to disk. Your final message is your whole answer.

{{ROUND1_TABLES}}
```
