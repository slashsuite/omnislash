---
type: llm
focus: trace
weight: 1
---

playwright.config.ts as written by the run has retries 0 (not 2 on CI), trace 'retain-on-failure', reuseExistingServer false, and a 127.0.0.1 base URL or webServer url.
