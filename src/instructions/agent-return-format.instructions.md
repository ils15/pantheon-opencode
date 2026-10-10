---
description: "Standardized return format for agent delegation results"
name: "Agent Return Format"
agents: ["*"]
---

# Agent Return Format

Implementation agents (Hermes, Aphrodite, Demeter, Hephaestus, Prometheus) return:

## subtask_summary
**files_changed:** [list of file paths, one per line]
**summary:** What was done, in 2-3 sentences
**tests:** ✅ All passing / ⚠️ X failing / ❌ Not run (reason)
**coverage:** X% (if applicable)
**tokens:** ~N input / ~M output (estimated)
**status:** complete | partial (reason) | escalated (reason)
**blockers:** [list any blockers or null]

Investigation agents (Apollo, Athena) return structured findings with:
- Key findings as bullet points
- File paths with line numbers
- Relevant code snippets (max 3 lines each)

## Memory Context
If this agent used `memory_recall` or `memory_search`, include the relevant memory entries used as context for the response.
