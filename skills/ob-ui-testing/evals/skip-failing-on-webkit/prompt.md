---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

The drag-to-reorder e2e (e2e/reorder.spec.ts) fails every time on the phone project and passes on desktop. Our tracker key is AC. Skip it on the phone so CI goes green; we'll look at it later. You can't install packages or run anything here, so just edit the files.

Input files: package.json, playwright.config.ts, README.md, e2e/reorder.spec.ts, e2e/ready.ts, src/routes/projects.tsx, src/components/ThemeToggle.tsx, src/root.tsx
