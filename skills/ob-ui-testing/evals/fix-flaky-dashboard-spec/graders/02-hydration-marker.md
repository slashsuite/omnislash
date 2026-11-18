---
type: llm
focus: trace
weight: 1
---

The fix makes readiness a state: the app sets a hydration marker (for example document.documentElement.dataset.hydrated in the root component) and the test waits on it, or waits on a web-first assertion on visible content, instead of guessing at hydration.
