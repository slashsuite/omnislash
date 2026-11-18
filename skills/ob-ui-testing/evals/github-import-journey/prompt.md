---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Write an e2e test for the journey: a user signs in with Google, connects their GitHub account, picks a repository on the import page and imports it as a project, which then shows in their projects list. You can't install packages or run a browser here, so just write the files and say what the app needs for it.

Input files: package.json, playwright.config.ts, README.md, src/routes/import.tsx, src/routes/projects.tsx, src/projectName.ts, src/api.ts, src/root.tsx
