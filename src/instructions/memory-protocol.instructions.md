---
description: "Universal memory protocol rules for all Pantheon agents with agent-specific overrides"
name: "Memory Protocol"
agents: ["*"]
---

# 🧠 Memory Protocol — Universal Rules

### Retrieval
- Search only when prior project history could change the outcome; skip self-contained questions and bounded changes.
- Delegated work: Zeus searches at most once and passes useful hits; reuse supplied results, and search again only if relevant history is missing.
- Use a targeted query (`top_k=2`) and ignore weak matches; missing or irrelevant results never block current work.

### Persistence
- Use only granted tools: Zeus has `memory_search` and temporary `context_save/get` checkpoints, but no durable writes; Mnemosyne has `memory_store` and other durable tools.
- Let native OpenCode compaction summarize active context. Use `context_save/get` only for cross-session resume; keep the goal, phase, progress, next step, decisions, blockers, and uncertain outcomes — no transcripts or routine logs.
- Store at most one concise, reusable top-level result only on explicit request. Never persist child summaries, test logs, or temporary state. Never store secrets, credentials, or tokens; confirm writes and state failures. Create ADRs only on request.
