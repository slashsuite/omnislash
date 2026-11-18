---
type: llm
focus: trace
weight: 1
---

The smoke test against the deployed site checks that robots.txt is served as text/plain and sitemap.xml as XML (a content-type check, not only a 200), that each sitemap loc answers 200 without a redirect, and that each page's canonical equals its loc; and TESTING.md or the deploy instructions say the smoke suite runs after every production deploy, not only in the repo.
