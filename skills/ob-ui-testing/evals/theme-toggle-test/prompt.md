---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Write a test for the dark mode toggle in the header so we know it works and remembers the choice. Change the component if you need to. You can't install packages or run a browser here, so just write the files.

Input files: package.json, playwright.config.ts, README.md, src/components/ThemeToggle.tsx, src/routes/projects.tsx, src/projectName.ts, src/api.ts, src/root.tsx
