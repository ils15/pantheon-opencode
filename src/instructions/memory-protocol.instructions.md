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
- A memory write is optional and conditional on a write tool being exposed and permitted in the active session. Grants are agent- and runtime-specific: Zeus's installed allowlist grants `memory_search` and temporary `context_save`/`context_get` checkpoints, not durable memory writes; Mnemosyne's installed allowlist includes `memory_store` and other durable-memory tools. Do not infer one agent's tools from another's; use only the active tool list.
- Store at most one concise, reusable top-level result; never persist routine child summaries, phase updates, test logs, or temporary state. Confirm a successful write before claiming persistence.
- Never store secrets, credentials, or tokens in durable memory. The current `memory_store` handler stores submitted values and metadata; automatic secret scrubbing/redaction is not guaranteed. Omit sensitive content or redact it before storage.
- If no write tool is available or the write did not succeed, say that the information was not persisted. Do not imply automatic memory storage or recovery. Add ADRs to the memory bank only when explicitly requested.

### Relevance and permanent records
Ignore weak matches; routine summaries do not belong in durable memory.
