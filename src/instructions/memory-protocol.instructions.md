---
description: "Universal memory protocol rules for all Pantheon agents with agent-specific overrides"
name: "Memory Protocol"
agents: ["*"]
---

# 🧠 Memory Protocol — Universal Rules

These rules apply to all agents; each agent file may add domain-specific rules.

## Universal Rules

### Retrieval
- Search only when prior project history could change the outcome; skip self-contained questions and bounded changes.
- For delegated work, Zeus searches at most once and passes useful hits to the specialist. Reuse supplied results; search separately only if relevant history is needed but missing.
- Use a targeted query (`top_k=2`); do not search the whole prompt by default. Missing or irrelevant results never block current work.

### Persistence
- `memory_store()` is manual, not automatic. Store at most one concise, reusable top-level result; never persist routine child summaries, phase updates, test logs, or temporary state.
- Confirm the store succeeded before claiming persistence. There is no automatic memory WAL or recovery. Add ADRs to the memory bank only when explicitly requested.

### Relevance and permanent records
Ignore weak matches; routine summaries do not belong in durable memory.
