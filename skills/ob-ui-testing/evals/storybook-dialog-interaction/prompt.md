---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Add an interaction test to the Dialog's Default story: it opens from the button, closes with Escape and with the Close button, and focus goes back to the button that opened it. You can't install packages or run anything here, so just write the files.

Input files: package.json, README.md, src/Dialog.tsx, src/Dialog.stories.tsx
