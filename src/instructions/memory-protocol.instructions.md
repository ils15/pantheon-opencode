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
- Use only tools granted in the active session: Zeus has `memory_search` and temporary `context_save`/`context_get` checkpoints but no durable writes; Mnemosyne has `memory_store` and other durable tools.
- Store at most one concise, reusable top-level result; never persist routine child summaries, phase updates, test logs, or temporary state. Confirm a successful write before claiming persistence. Never store secrets, credentials, or tokens; `memory_store` does not guarantee redaction, so omit or redact sensitive content first.
- If no write tool is available or the write did not succeed, say the information was not persisted; never imply automatic storage or recovery. Add ADRs to the memory bank only when explicitly requested.
