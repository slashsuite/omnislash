---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Two things keep regressing. On /compare, dragging the overlay opacity slider should fade the top image. On /docs, the side rail should stay stuck to the top while you scroll. Add tests so we catch both. You can't install packages or run a browser here, so just write the files.

Input files: package.json, README.md, pixelslash.config.json, src/components/OverlaySlider.tsx, src/components/DocsRail.tsx, playwright.config.ts
