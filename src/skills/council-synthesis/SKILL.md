---
name: council-synthesis
description: "Structured multi-agent council for explicit /pantheon requests and material decisions needing distinct perspectives. Load only when a council is actually needed."
---

# Council synthesis — `/pantheon`

Use only when the user invokes `/pantheon` or a material decision genuinely needs distinct specialist views. Ordinary implementation, explanation, and bounded fixes do not need a council.

## Run one useful round

1. Search `council_decisions` for a directly relevant precedent. Reuse a fresh, matching decision with a warning to re-check current context; otherwise treat it as context, not authority.
2. Select two specialists by default. Add a third only when the question spans a separate domain; include @themis when security, correctness, or a material quality gate requires review.
3. Ask each specialist the same focused question and request a position, evidence, trade-offs, key risks, and confidence. Dispatch independent work together only when native background delegation is enabled; otherwise use normal `task()` calls.
4. Synthesize after one response round. State agreements, real disagreements, missing responses, and uncertainty. Do not run a routine rebuttal, duplicate moderator/audit pass, or repeat the panel. Check a disputed factual claim only when it could change the recommendation; ask one focused follow-up if evidence remains insufficient.
5. Give the user a concise recommendation with the main trade-off and any unresolved risk. Cite external research when used. Preserve human approval and Themis gates for sensitive or irreversible actions.
6. Persist only a reusable, material decision in `council_decisions`; do not store routine opinions or user-specific details without a need.

## Specialist response

```text
position: one sentence answering the question
evidence: the key facts or reasoning (2–4 sentences)
trade-offs: one concrete gain and loss
risks: up to 3
confidence: High | Medium | Low
```

Use High only with multiple verifiable facts, Medium with some evidence, and Low for mainly judgment-based conclusions. Do not invent consensus or confidence.
