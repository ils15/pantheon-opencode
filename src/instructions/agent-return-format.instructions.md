---
description: "Standardized return format for agent delegation results"
name: "Agent Return Format"
agents: ["*"]
---

# Agent Return Format

All agents check each result against the request and evidence; remove unrelated work, generic filler, unsupported claims, and unnecessary complexity; state uncertainty and preserve safety constraints. Implementation agents (Hermes, Aphrodite, Demeter, Hephaestus, Prometheus) MUST return results to Zeus in this format:

## subtask_summary
**files_changed:** [list of file paths, one per line]
**summary:** What was done, in 2-3 sentences
**tests:** [PASS | WARN | FAIL] `<command>` (targets: N, duration: <X>s, selection: <reason>)
**coverage:** X% (if applicable)
**tokens:** ~N input / ~M output (estimated)
**status:** complete | partial (reason) | escalated (reason)
**blockers:** [list any blockers or null]
**memory_context:** {"refs":[{"namespace":"<safe namespace>","key":"<safe key>"}],"takeaway":"<concise relevant takeaway>"} (optional only if memory affected; non-sensitive refs/takeaway, no secrets or copied memory; only in this summary, not Apollo/Athena or council formats)

For investigation agents (Apollo, Athena), return structured findings: key findings as bullets, file paths with line numbers, code snippets of max 3 lines.

### Athena Plan Handoff

When Zeus delegates Athena through the root `subagent` dispatch, its final task result MUST contain the complete Markdown plan (not a summary, artifact path, or approval question): goal, scope and assumptions, phases, affected files or areas, dependencies, verification, risks, open questions, acceptance criteria — unknowns marked, never guessed. This supersedes the structured-findings format. Athena must not call `question`, pause for user input, or ask for approval in the child session. Zeus publishes the full plan before approval UI, never bundling them; if order is not guaranteed, Zeus asks in plain text afterwards. For Open Questions or decisions needed, Zeus prompts via the native `question` tool with structured options and marked recommended defaults, never leaving inert text bullets. Direct Athena invocations show the complete plan before requesting approval.

## Council Specialist Response Format

On a `/pantheon` council invocation, specialists MUST return this format. First-round prompts are independent — whether dispatch is parallel or synchronous/sequential — so respond without peer responses: never guess peer positions or claim unseen agreement. Omit `agreement_signals` or write `none` in the first round and cite only peer responses visible in a rebuttal prompt. Zeus derives agreement by comparing actual responses.

```
## specialist_response
**position:** <one-sentence answer>
**reasoning:** <2-4 sentence chain>
**trade_offs:** <specific gains vs losses>
**risks:** <max 3 failure risks>
**confidence:** High | Medium | Low
**agreement_signals:** <omit or `none` in first round; rebuttal cites visible peer `#seq`>
**specific_claims:** <optional count; advisory only>
```

Required: position, reasoning, trade_offs, risks, confidence. `agreement_signals` and `specific_claims` are advisory — never speculate or self-reference, and do not treat a self-reported count alone as evidence or proof of confidence. **High** ≥3 evidenced claims; **Medium** ≥1; **Low** speculative. Equal self-reported counts do not by themselves prove fabrication; judge actual claims. Rebuttals/board handoffs cite `#seq` (`replyToSeq`), converge with `[consensus]`/`[deadlock]`, and tag only next peer.
