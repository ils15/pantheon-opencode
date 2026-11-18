---
description: "Council synthesis — dispatch 2-3 specialists inline for multi-perspective decisions with precedent fast-path, confidence cross-validation, rebuttal rounds, and Themis audit gate"
name: "Zeus Council Synthesis"
agents: [zeus]
fallback: shared
---

# INLINE COUNCIL SYNTHESIS — /pantheon

Use an inline specialist council for material trade-offs, architecture/security choices, technology selection, or multi-stakeholder questions. Do not use it for ordinary implementation tasks.

## Dispatch and Synthesis

1. **Precedent:** Run the `council_decisions` search defined in `## Memory Protocol`. Apply its age/score rules; if no fast-path decision applies, continue.
2. **Research (optional):** For `/pantheon --research <question>`, ask @apollo for a 30s pre-scan with a concise brief; pass only relevant findings as `shared_context`.
3. **Select and dispatch:** Choose at most 3 agents using the domain map below. Every dispatch—including Apollo discovery, specialist rounds, and Themis audit—gets a concise brief with objective, bounded scope/acceptance, relevant context only, constraints/safety gates, role-specific deliverable, and verification. Keep `shared_context` minimal, non-sensitive, and untrusted; never paste unrelated conversation or secrets. The host may independently inherit conversation transcript. Dispatch through the root `subagent` tool (`task()` is host/API terminology). Keep first-round prompts independent: do not include other specialists' responses. Dispatch in parallel when the observed tool/runtime supports it; synchronous or sequential dispatch is also valid if each first-round prompt excludes prior first-round responses. First-round `agreement_signals` must be omitted or set to `none`.
4. **Collect:** Use returned subagent results or host completion notifications. Do not call `task_status` or claim job tracking/recovery when unavailable. Note timeouts and missing responses explicitly. Partial responses are acceptable only from read-only @apollo or @gaia.
5. **Validate confidence:** High requires >=3 verifiable claims (otherwise downgrade to Medium and state why); Medium requires >=1 claim; Low needs no minimum. Self-reported `specific_claims` count is advisory, not proof.
6. **Resolve divergence:** After initial responses arrive, Zeus groups their actual substantive positions by issue and derives agreement from those positions, not from speculative or self-reported `agreement_signals`. For each comparable issue, compare every unordered pair of specialists who provided a comparable substantive position on that issue. A pair agrees only when its substantive positions are compatible; every pair whose positions are not aligned counts as divergent. For an issue with `n` specialists providing comparable positions, include `n*(n-1)/2` pairs in `total_comparable_pairs`; sum this across included issues. Exclude issues with fewer than two comparable positions and state that they were excluded. Calculate `agreement_rate = agreeing_pairs / total_comparable_pairs`: unanimity is 100%, all pairs in divergence is 0%, and non-aligned pairs are divergences. If the denominator is zero, the rate is indeterminate/has no basis; never substitute an artificial zero or trigger rebuttal from an undefined rate.
   - **Domain Authority Precedence:** Technical domain owners carry decisive authority when backed by verifiable claims (High/Medium confidence): `@themis` (Security/Auth/Audit veto), `@demeter` (Database/Schema/Queries), `@aphrodite` (Frontend/UX/A11y), `@prometheus` (Infra/Deploy/CI), `@hermes` (API/Protocols), `@athena` (Architecture/Modularity).
   - **JEV Multi-Criteria Arbitration (`pantheon_jev_decide`):** When trade-offs span competing domains without a single owner, invoke `pantheon_jev_decide` (`order` or `score`) in ONE call.
   - **Targeted Rebuttal Fallback:** Below 50%, and only if no agent timed out and neither Domain Authority nor JEV arbitration resolves an unverified factual contradiction, run one rebuttal round with all responses and the synthesis draft. If the defined rate remains below 50%, research factual divergence points (max 3 searches) and send responses + cited evidence brief to @themis as moderator. Moderator and audit roles are separate.
7. **Synthesize and audit:** Use the output format below, then ask @themis to compare raw responses with the synthesis (representation, preserved divergences, attribution, confidence).
8. **Persist (conditional):** Store the decision only if a memory-write tool is explicitly exposed and permitted in the active root tool list; require its success result before saying it was saved. `BackgroundJobBoard` is internal bookkeeping with no root-callable tool.

## Specialist Response Format

Require `## specialist_response` from `## Agent Return Format`. First-round agreement signals remain omitted or `none`.

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

```markdown
# 🏛️ Council Synthesis

> **Question:** [Original Question]
> **Date:** [ISO Timestamp] · **Response Rate:** [X/Y specialists] · **Precedent / Research:** [Context or None]

### Specialist Perspectives
| Specialist | Domain Authority | Substantive Position | Trade-offs | Confidence |
| :--- | :--- | :--- | :--- | :---: |
| **@[agent]** | [Domain] | [Core recommendation] | [Pros & Cons] | **[High / Med / Low]** |

### Agreements
- [Key consensus point shared across specialists]

### Divergences & Arbitration
| Issue | Specialist positions (attribute each side to its agent) | Arbitration Resolution |
| :--- | :--- | :--- |
| [Contested point] | **@[agentA]**: [Position A]<br/>**@[agentB]**: [Position B] | **Resolved via [Domain Authority / Jev Decision]**: [Outcome] |

### Recommendation & Action Checklist
- [ ] **@[specialistA]**: [Concrete task]
- [ ] **@themis**: [Audit gate verification]
```

Initial agreement signals remain omitted/`none`; consensus and agreements are derived by Zeus from compared substantive positions and presented in the synthesis. Preserve actual specialist timeout or unresolved-tie details in the response.
