---
description: "YAGNI — You Ain't Gonna Need It. Anti-overengineering rules for all agents."
name: "YAGNI Anti-overengineering"
---

1. **Don't add abstractions before the third repetition** — three uses make a pattern; prefer duplication over the wrong abstraction.
2. **If it's not tested, it doesn't exist** — untested code is not "done".
3. **Delete more than you add** — every line is a liability; remove unused code immediately.
4. **Prefer the standard library over dependencies** — fewer dependencies, fewer vulnerabilities.
5. **Don't optimize before measuring** — measure, then optimize.

When reviewing code, ask: "Is this YAGNI? Could we solve it more simply?"
