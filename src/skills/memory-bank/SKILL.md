---
name: memory-bank
description: "Memory bank rules, structure, and optimization — complete guide to Pantheon memory management."
---

# Memory Bank

Pantheon memory bank — rules, structure, and maintenance. The rules below change behavior; tables of detail live in `references/`.

---

## Storage Guardrail

Pantheon has no `/memories/repo/` or `/memories/session/` stores. Memory Bank files under `.pantheon/memory-bank/` are read explicitly or on demand via `pantheon://memory-bank/{path}` — never auto-loaded — and are not automatically synchronized across clones; Git tracking follows the repository's ignore/commit policy.

---

## Golden Rules

1. **Never create `.md` files outside `.pantheon/memory-bank/`** (except `README.md`, `CONTRIBUTING.md`)
2. **Never create `ANALYSIS_*.md`, `SUMMARY_*.md`, `STATUS_*.md`** anywhere
3. **`01-active-context.md` is the priority file** — keep it current
4. **`02-progress-log.md` is append-only** — never edit history
5. **`_notes/` decisions are immutable** — supersede, never edit

---

## Session → Project Context Graduation

```
At sprint close:
  @mnemosyne consolidates → .pantheon/memory-bank/01-active-context.md
                          → .pantheon/memory-bank/02-progress-log.md (appended)
```

---

## Who Writes What

| Content | Written by | Where |
|---------|-----------|-------|
| Project overview, architecture | Mnemosyne (at init) | `00-03.md` |
| Sprint context, decisions | Agent / Mnemosyne | `01-active-context.md` |
| Milestone completions | Any agent | `02-progress-log.md` (append) |
| Task records | Mnemosyne (on request) | `_tasks/TASK000X-*.md` |
| Architecture decisions | Mnemosyne (on request) | `_notes/NOTE000X-*.md` |
| Reusable durable fact or decision | Agent with explicit `memory_store` grant, when retention is warranted | `pantheon-memory` |
| Conversation-only goal | Current session instructions / `/pantheon-focus` | Not durable; no `/memories/session/` store |
| Project narrative and ADRs | Mnemosyne on explicit request | `.pantheon/memory-bank/` |

---

## Memory Bank maintenance

Memory Bank cleanup is a manual file-maintenance task, separate from native
conversation compaction. Do it only when requested. Keep active-context files
focused on current decisions and blockers; move old material only when its
destination and retention are clear. Do not enforce line-count or entry-count
targets, rewrite the archive automatically, or create one artifact per phase.

---

## Routing

| Action / trigger | Reference |
|---|---|
| Needing where each memory system stores data, ownership, or lifetime | [references/storage-model.md](references/storage-model.md) |
| Creating/updating files and needing the layout or fill/update cadence | [references/structure-and-frequency.md](references/structure-and-frequency.md) |
| Unsure whether a write pattern (session files, phase handoffs, duplication) is allowed | [references/anti-patterns.md](references/anti-patterns.md) |
| Setting up the memory bank in a product repository | [references/product-adoption.md](references/product-adoption.md) |

A missing reference interrupts the action — read nothing in its place, never improvise from memory.
