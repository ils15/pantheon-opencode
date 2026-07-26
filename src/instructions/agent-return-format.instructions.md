---
description: "Standardized return format for agent delegation results"
name: "Agent Return Format"
applyTo: "agents/*.agent.md"
---

# Agent Return Format

All implementation agents (Hermes, Aphrodite, Demeter, Hephaestus, Prometheus) MUST return results to Zeus in this format:

## subtask_summary
**files_changed:** [list of file paths, one per line]
**summary:** What was done, in 2-3 sentences
**tests:** ✅ All passing / ⚠️ X failing / ❌ Not run (reason)
**coverage:** X% (if applicable)
**status:** complete | partial (reason) | escalated (reason)
**blockers:** [list any blockers or null]

For investigation agents (Apollo, Athena), return structured findings with:
- Key findings as bullet points
- File paths with line numbers
- Relevant code snippets (max 3 lines each)

## Council Specialist Response Format

When responding to a `/pantheon` council synthesis invocation, specialists MUST return this structured format:

```
## specialist_response
**position:** <clear one-sentence position answering the question>
**reasoning:** <2-4 sentences with logical chain>
**trade_offs:** <what's gained vs lost, specific>
**risks:** <what could go wrong, max 3 items>
**confidence:** High | Medium | Low
**agreement_signals:** agree:@agent1 on <issue>, agree:@agent2 on <issue> | disagree:@agent3 on <issue>
**specific_claims:** <count of specific factual claims in response>
```

### Field Rules

| Field | Required | Validation |
|-------|----------|------------|
| position | ✅ | Single sentence, must directly answer the question |
| reasoning | ✅ | 2-4 sentences with logical chain |
| trade_offs | ✅ | At least one gain and one loss, specific to context |
| risks | ✅ | Max 3 bullet points |
| confidence | ✅ | One of: High, Medium, Low |
| agreement_signals | Optional | Format: `agree:@agent on issue \| disagree:@agent on issue`. Use only when you can reference other specialists expected positions. |
| specific_claims | ✅ | Integer count of verifiable factual statements in the response |

### Confidence Guidelines

- **High**: Position backed by 3+ specific claims with evidence or direct experience
- **Medium**: Position backed by 1-2 specific claims
- **Low**: Position is opinion-based or speculative

### Example
```
## specialist_response
**position:** The BackgroundJobBoard should be used for council crash recovery
**reasoning:** The board already supports running→completed→reconciled state machine with persistence. Registering council dispatches there adds ~50ms overhead but prevents total session loss on context crash. The WAL pattern ensures no data loss on restart.
**trade_offs:** Gain: crash recovery for multi-minute council sessions. Lose: ~50ms registration overhead per council.
**risks:** Board persistence failure could block council start — implement with fire-and-forget error handling
**confidence:** High
**agreement_signals:** agree:@themis on persist-before-notify
**specific_claims:** 3
```

## Memory Context
If this agent used `memory_recall` or `memory_search`, include the relevant memory entries
used as context for the response.
