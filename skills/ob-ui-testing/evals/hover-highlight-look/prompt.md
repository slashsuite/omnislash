---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

When you hover a box in the Composition view, its row in the list should light up, and hovering a row should light up its box. Add tests so we know that works and that the highlight looks right. Change the component if you need to. You can't install packages or run a browser here, so just write the files.

Input files: package.json, README.md, pixelslash.config.json, src/components/Composition.tsx, src/components/Composition.stories.tsx, playwright.config.ts
