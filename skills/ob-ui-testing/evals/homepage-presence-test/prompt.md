---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Add an e2e test that checks the home page has everything on it: the header with the Acme logo, the Projects and Pricing nav links, the hero, the three feature cards and the footer. You can't install packages or run a browser here, so just write the files.

Input files: package.json, playwright.config.ts, README.md, src/routes/projects.tsx, src/projectName.ts, src/api.ts, src/components/ThemeToggle.tsx, src/root.tsx
