---
description: "Standardized return format for agent delegation results"
name: "Agent Return Format"
agents: ["*"]
---

# Agent Return Format

All implementation agents (Hermes, Aphrodite, Demeter, Hephaestus, Prometheus) MUST return results to Zeus in this format:

## subtask_summary
**files_changed:** [list of file paths, one per line]
**summary:** What was done, in 2-3 sentences
**tests:** ✅ All passing / ⚠️ X failing / ❌ Not run (reason)
**coverage:** X% (if applicable)
**tokens:** ~N input / ~M output (estimated)
**status:** complete | partial (reason) | escalated (reason)
**blockers:** [list any blockers or null]
**memory_context:** {"refs":[{"namespace":"<safe namespace>","key":"<safe key>"}],"takeaway":"<concise relevant takeaway>"} (optional; omit when memory did not affect the result)

For investigation agents (Apollo, Athena), return structured findings with:
- Key findings as bullet points
- File paths with line numbers
- Relevant code snippets (max 3 lines each)

### Athena Plan Handoff

When Athena is delegated to create a plan, its final task result MUST contain
the complete Markdown plan, not just a summary, artifact path, or approval
question. Include the goal, scope and assumptions, actionable phases, affected
files or areas, dependencies, verification, risks, open questions, and
acceptance criteria; mark unknowns instead of guessing. When called by Zeus,
this plan contract supersedes the generic structured-findings format above.
Athena must not call `agent/askQuestions`, pause for user input, or ask for
approval in the child session. Zeus must publish the returned full plan as a
normal message in the main conversation before triggering any approval UI;
the plan and approval question must not be bundled or reversed. If the runtime
cannot guarantee this order, Zeus asks for approval in plain text after the
plan and waits for the next user message. For direct Athena invocations, show
the complete plan in the current conversation before requesting approval.

## Council Specialist Response Format

When responding to a `/pantheon` council synthesis invocation, specialists MUST return this structured format. First-round specialists receive independent prompts without peer responses, whether dispatch is parallel or synchronous/sequential; they therefore cannot know actual peer positions. Do not guess them, claim agreement/disagreement with unseen peers, or self-reference in agreement signals. Omit `agreement_signals` or write `none` in the first round. In a rebuttal round, signals may reference only peer responses included in that round's prompt. Zeus derives agreement and disagreement during synthesis by comparing actual responses.

```
## specialist_response
**position:** <clear one-sentence position answering the question>
**reasoning:** <2-4 sentences with logical chain>
**trade_offs:** <what's gained vs lost, specific>
**risks:** <what could go wrong, max 3 items>
**confidence:** High | Medium | Low
**agreement_signals:** <omit or `none` in first round; rebuttal may cite only visible peer responses>
**specific_claims:** <optional self-reported count; advisory only, not evidence>
```

### Field Rules

| Field | Required | Validation |
|-------|----------|------------|
| position | ✅ | Single sentence, must directly answer the question |
| reasoning | ✅ | 2-4 sentences with logical chain |
| trade_offs | ✅ | At least one gain and one loss, specific to context |
| risks | ✅ | Max 3 bullet points |
| confidence | ✅ | One of: High, Medium, Low |
| agreement_signals | Optional | Omit or use `none` in the first round. In rebuttal, reference only peer responses visible in the prompt; never speculate or self-reference. Zeus derives synthesis positions from actual responses, not these signals. |
| specific_claims | Optional | Self-reported integer count only; advisory and not independently validated. Do not treat the count alone as evidence or proof of confidence. |

### Confidence Guidelines

- **High**: Position backed by at least 3 verifiable claims supported by evidence in the response; a self-reported count alone does not qualify
- **Medium**: Position backed by at least 1 verifiable claim supported by evidence in the response
- **Low**: Position is opinion-based or speculative

Equal self-reported counts (for example, several specialists each reporting 7) do not by themselves prove fabrication; assess whether the actual response contains verifiable, supported claims.

### Example
```
## specialist_response
**position:** Use a bounded local cache for the read-heavy endpoint.
**reasoning:** The endpoint repeatedly reads the same reference data. A bounded cache reduces repeated lookups, while a short TTL limits staleness.
**trade_offs:** Gain: fewer repeated reads. Lose: results may remain stale until the TTL expires.
**risks:** Cache invalidation may lag after updates.
**confidence:** Medium
**agreement_signals:** none
**specific_claims:** 2 (self-reported; advisory)
```

## Memory Context
If memory affected the result, state the takeaway briefly; do not repeat the entry or task context. The optional machine-readable `memory_context` field belongs to `## subtask_summary` only when that return format applies; it does not change the Apollo/Athena structured-findings format or the council specialist-response contract. Both its refs and takeaway must be non-sensitive and contain no secrets or irrelevant memory content. The `refs` array may be empty if no source reference is safe to disclose. Never copy memory contents or duplicate the original task/entry; omit the field entirely when memory did not affect the result. If persistence was expected but no write tool was exposed or a write failed, state that it was not persisted; never imply a successful store without confirmation.
