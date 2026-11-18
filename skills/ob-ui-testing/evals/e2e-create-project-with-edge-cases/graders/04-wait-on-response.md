---
type: llm
focus: trace
weight: 1
---

The happy-path e2e starts page.waitForResponse (or an equivalent wait on the create call) before clicking Create, or waits on the created row appearing, with no waitForTimeout, networkidle or fixed sleep.
