---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

e2e/dashboard.spec.ts fails about one run in ten on CI (the 'creates' test times out or finds the wrong last row). Fix it. You can't install packages or run a browser here, so edit the files and explain what you changed.

Input files: package.json, playwright.config.ts, README.md, src/routes/projects.tsx, src/projectName.ts, src/api.ts, src/components/ThemeToggle.tsx, src/root.tsx, e2e/dashboard.spec.ts
