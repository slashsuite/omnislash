---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

The primary button should be violet-600 instead of blue-600. Make the change and add a test so it doesn't regress. You can't install packages or run anything here, so just edit and write the files.

Input files: package.json, playwright.config.ts, README.md, src/components/PrimaryButton.tsx, src/routes/projects.tsx, src/projectName.ts, src/api.ts, src/root.tsx
