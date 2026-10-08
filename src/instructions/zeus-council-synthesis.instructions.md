---
description: "Council synthesis — dispatch 2-3 specialists inline for multi-perspective decisions with precedent fast-path, confidence cross-validation, rebuttal rounds, and Themis audit gate"
name: "Zeus Council Synthesis"
applyTo: "agents/zeus.agent.md"
---

# 🏛️ INLINE COUNCIL SYNTHESIS — /pantheon

Use an inline specialist council for material trade-offs, architecture/security choices, technology selection, cost/quality decisions, or multi-stakeholder questions. Do not use it for ordinary implementation tasks.

## Dispatch and Synthesis

1. **Precedent:** Run the separate `council_decisions` search defined in `## Memory Protocol`. Apply its age/score rules; if no fast-path decision applies, continue.
2. **Research (optional):** For `/pantheon --research <question>`, ask @apollo for a 30s pre-scan and pass findings as `shared_context` to every specialist.
3. **Register:** Before dispatch, call `board.registerLaunch` with a council task ID, parent session, Zeus, question, and synthesis objective. This enables crash recovery.
4. **Select and dispatch:** Choose at most 3 agents using the domain map below. Send all `task()` calls in one message. Each prompt includes the question, shared context, required response format, and role timeout (120s reviewers; 60s explorers/implementers).
5. **Collect:** Wait for all responses and note timeouts. Partial responses are acceptable only from read-only @apollo or @gaia.
6. **Validate confidence:** High requires at least 3 verifiable claims; otherwise downgrade to Medium and state why. Medium requires at least 1 claim; Low needs no minimum. Opinions alone are not specific claims.
7. **Resolve divergence:** Compute agreement rate as `min(agreements, divergences) / total_points` from structured `agreement_signals`. Below 50%, and only if no agent timed out, run one rebuttal round with all responses and the current synthesis draft. Treat revised responses as final. If disagreement remains below 50%, research factual divergence points with official docs, benchmarks, or issues (max 3 searches; seek 2 independent sources per point when possible). Skip research for subjective-only disagreements. Send responses and a cited evidence brief to @themis as moderator; request verdicts, overall direction, confidence, and unresolved issues. Low confidence or unresolved points remain explicit in the synthesis. Moderator and audit roles are separate.
8. **Synthesize and audit:** Use the output format below, then ask @themis to compare raw responses with the synthesis. Check representation of every specialist, preserved divergences, accurate attribution, and confidence specificity. Fix any issue before delivery.
9. **Persist:** Store the decision using the `council_decisions` write format in `## Memory Protocol`, then call `board.markReconciled(task_id)`.

If context is lost, use `board.recoverRunningJobs()` and `board.formatForPrompt()` to find unreconciled work. Re-dispatch a crashed council with the same question and label it as a retry.

## Specialist Response Format

Require `## specialist_response` from `## Agent Return Format`: `position`, `reasoning`, `trade_offs`, `risks`, `confidence`, `agreement_signals`, and `specific_claims`.

## Domain Map

| Domain | Candidate agents |
|---|---|
| Architecture | athena, hermes, demeter, themis |
| Security | themis, hermes, prometheus, nyx |
| Database | demeter, hermes, prometheus |
| AI/RAG | hephaestus, nyx |
| Infrastructure | prometheus, hermes, themis |
| Frontend/UX | aphrodite, themis, hermes |
| Observability | nyx, hermes |
| General | athena, themis, hermes |

## User-Facing Synthesis

```text
## 🏛️ Council Synthesis
Question / date / response rate / timed-out agents / precedent / research context

### Specialist Perspectives
| Agent | Position | Trade-offs | Confidence |

### Agreements
- Points shared by multiple specialists

### Divergences
| Issue | Sides | Resolution |

### Evidence & Moderation (when used)
Research points, evidence, moderator verdict, cited sources, unresolved issues

### Recommendation
Decisive conclusion

### Audit Gate
Themis approved, or issues corrected

### Decision Gate
Confidence adjusted for response rate
```

The user invokes this flow with `/pantheon <question>`; `--research` enables the Apollo pre-scan. Preserve actual specialist timeout or unresolved-tie details in the response.
