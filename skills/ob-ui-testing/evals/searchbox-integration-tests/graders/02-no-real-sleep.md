---
type: llm
focus: trace
weight: 1
---

No test waits with a real setTimeout, a new Promise around setTimeout or a fixed delay; the debounce is handled with fake timers or findBy/waitFor.
