---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I just added the /archive page (src/routes/archive.tsx). It lists archived projects and shows a message when there are none. Get it covered by our tests. You can't install packages or run a browser here, so just write the files.

Input files: package.json, README.md, pixelslash.config.json, src/pages.ts, e2e/pages.spec.ts, src/api.ts, src/test/store.ts, src/routes/archive.tsx, playwright.config.ts
