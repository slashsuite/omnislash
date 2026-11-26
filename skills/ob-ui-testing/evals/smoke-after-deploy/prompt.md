---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Add a smoke test that runs right after each deploy against production to check that sign-in works and that a user can create a project. You can't install packages or run anything here, so just write the files and say what else is needed.

Input files: package.json, playwright.config.ts, README.md, src/routes/projects.tsx, src/projectName.ts, src/api.ts, src/components/ThemeToggle.tsx, src/root.tsx
