---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Add a smoke test that builds the app, starts it locally and checks /health answers 200 and the home page has the sign-in link. Put it wherever it belongs. You can't install packages or run a browser here, so just write the files.

Input files: package.json, README.md, vitest.smoke.config.ts, smoke/deployed.smoke.test.ts, e2e/pages.spec.ts, playwright.config.ts
