---
type: llm
focus: trace
weight: 1
---

The final spec and its helpers locate everything a user sees or acts on by role, label or text; the only CSS selector anywhere is the html[data-hydrated] ready marker; no '.card', 'ul li', 'input', 'main[...]' or class selectors, and no page.fill/page.click with a selector string.
