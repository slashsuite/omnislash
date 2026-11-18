---
tags: [ob-ui-testing]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Our marketing site has no tests. Set up its test suite: write the test files and any config they need, and a short TESTING.md saying what each part checks. You can't install packages or run a build or browser here, so just write the files.

Input files: package.json, README.md, public/_redirects, src/pages/index.astro, src/pages/pricing.astro, src/pages/docs.astro, src/pages/about.astro
