---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Add e2e coverage for creating a project on the projects page: the happy path, plus the edge cases (empty name, a 65 character name, illegal characters, a duplicate name in a different case, the server failing). Write the test files and any config or helpers they need. You can't install packages or run a browser here, so just write the files.

Input files: package.json, playwright.config.ts, README.md, src/routes/projects.tsx, src/projectName.ts, src/api.ts, src/components/ThemeToggle.tsx, src/root.tsx
