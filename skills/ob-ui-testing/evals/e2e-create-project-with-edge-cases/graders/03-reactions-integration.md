---
type: llm
focus: trace
weight: 1
---

The screen's reactions (a validation message with nothing saved, the duplicate 409 message, the 500 retry message) are covered by integration tests (Vitest with Testing Library) or are explicitly placed at the integration layer, not e2e.
