---
description: "Standardized return format for agent delegation results"
name: "Agent Return Format"
agents: ["*"]
---

# Agent Return Format

Implementation agents (Hermes, Aphrodite, Demeter, Hephaestus, Prometheus) MUST return results to Zeus in this format:

## subtask_summary
**files_changed:** [list of file paths, one per line]
**summary:** What was done, in 2-3 sentences
**tests:** ✅ All passing / ⚠️ X failing / ❌ Not run (reason)
**coverage:** X% (if applicable)
**tokens:** ~N input / ~M output (estimated)
**status:** complete | partial (reason) | escalated (reason)
**blockers:** [list any blockers or null]
**memory_context:** {"refs":[{"namespace":"<safe namespace>","key":"<safe key>"}],"takeaway":"<concise relevant takeaway>"} (optional only if memory affected; non-sensitive refs/takeaway, no secrets or copied memory; only in this summary, not Apollo/Athena or council formats)

For investigation agents (Apollo, Athena), return structured findings: key findings as bullets, file paths with line numbers, code snippets of max 3 lines.

### Athena Plan Handoff

When Zeus delegates Athena through the root `subagent` dispatch, its final task result MUST contain the complete Markdown plan (not a summary, artifact path, or approval question): goal, scope and assumptions, phases, affected files or areas, dependencies, verification, risks, open questions, acceptance criteria — unknowns marked, never guessed. This supersedes the structured-findings format. Athena must not call `agent/askQuestions`, pause for user input, or ask for approval in the child session. Zeus publishes the full plan as a normal message before any approval UI, never bundling plan and approval question; if the runtime cannot guarantee that order, Zeus asks for approval in plain text afterwards and waits for the next user message. Direct Athena invocations show the complete plan before requesting approval.

## Council Specialist Response Format

On a `/pantheon` council invocation, specialists MUST return this format. First-round prompts are independent — whether dispatch is parallel or synchronous/sequential — so respond without peer responses: never guess peer positions or claim unseen agreement. Omit `agreement_signals` or write `none` in the first round and cite only peer responses visible in a rebuttal prompt. Zeus derives agreement by comparing actual responses.

```
## specialist_response
**position:** <clear one-sentence position answering the question>
**reasoning:** <2-4 sentences with logical chain>
**trade_offs:** <what's gained vs lost — at least one of each, specific>
**risks:** <what could go wrong, max 3 items>
**confidence:** High | Medium | Low
**agreement_signals:** <omit or `none` in first round; rebuttal may cite only visible peer responses>
**specific_claims:** <optional self-reported count; advisory only, not evidence>
```

Required: position, reasoning, trade_offs, risks, confidence. Optional `agreement_signals` and `specific_claims` are advisory — never speculate or self-reference, and do not treat a self-reported count alone as evidence or proof of confidence. **High** needs ≥3 verifiable claims supported by evidence; **Medium** ≥1; **Low** is opinion-based or speculative. Equal self-reported counts do not by themselves prove fabrication; judge the actual claims.
