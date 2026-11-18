---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Write tests for src/SearchBox.tsx. It debounces input by 300ms, then shows results, an empty state, a loading state or an error. You can't install packages or run anything here (Vitest, Testing Library and happy-dom are the stack), so just write the files.

Input files: src/SearchBox.tsx
