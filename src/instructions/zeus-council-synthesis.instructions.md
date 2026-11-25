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
3. **Select and dispatch (Round 1 Agora):** Open a council channel via `pantheon_board(action="channel", channel="council", threadId="<slug>", goal="<question>")`. Choose at most 3 agents using the domain map below. Every dispatch—including Apollo discovery, specialist rounds, and Themis audit—gets a concise brief with objective, bounded scope/acceptance, relevant context only, constraints/safety gates, role-specific deliverable, and verification. Keep `shared_context` minimal, non-sensitive, and untrusted; never paste unrelated conversation or secrets. The host may independently inherit conversation transcript. Dispatch through the root `subagent` tool (`task()` is host/API terminology). Keep first-round prompts independent: do not include other specialists' responses. Dispatch in parallel when the observed tool/runtime supports it; synchronous or sequential dispatch is also valid if each first-round prompt excludes prior first-round responses. First-round `agreement_signals` must be omitted or set to `none`.
4. **Collect & record `#seq` slots:** Use returned subagent results or host completion notifications. Do not call `task_status` or claim job tracking/recovery when unavailable. Record each returned `specialist_response` on `pantheon_board(action="post", channel="council", threadId="<slug>", from="<agent>", tag="note", body=...)` so every position gets an addressable `#seq` ID. Note timeouts and missing responses explicitly. Partial responses are acceptable only from read-only @apollo.
5. **Validate confidence:** High requires >=3 verifiable claims (otherwise downgrade to Medium and state why); Medium requires >=1 claim; Low needs no minimum. Self-reported `specific_claims` count is advisory, not proof.
6. **Resolve divergence & `#seq` convergence:** After initial responses arrive, Zeus groups their actual substantive positions by issue and derives agreement from those positions, not from speculative or self-reported `agreement_signals`. For each comparable issue, compare every unordered pair of specialists who provided a comparable substantive position on that issue. A pair agrees only when its substantive positions are compatible; every pair whose positions are not aligned counts as divergent. For an issue with `n` specialists providing comparable positions, include `n*(n-1)/2` pairs in `total_comparable_pairs`; sum this across included issues. Exclude issues with fewer than two comparable positions and state that they were excluded. Calculate `agreement_rate = agreeing_pairs / total_comparable_pairs`: unanimity is 100%, all pairs in divergence is 0%, and non-aligned pairs are divergences. If the denominator is zero, the rate is indeterminate/has no basis; never substitute an artificial zero or trigger rebuttal from an undefined rate.
   - **Domain Authority Precedence:** Technical domain owners carry decisive authority when backed by verifiable claims (High/Medium confidence): `@themis` (Security/Auth/Audit veto), `@demeter` (Database/Schema/Queries), `@aphrodite` (Frontend/UX/A11y), `@hermes` (Backend/API/Infra), `@athena` (Architecture/Modularity).
   - **JEV Multi-Criteria Arbitration (`pantheon_jev_decide`):** When trade-offs span competing domains without a single owner, invoke `pantheon_jev_decide` (`order` or `score`) in ONE call.
   - **Targeted `#seq` Rebuttal & `[consensus]`/`[deadlock]` Convergence:** Below 50%, and only if no agent timed out and neither Domain Authority nor JEV arbitration resolves an unverified factual contradiction, run one targeted rebuttal round citing visible Round 1 `#seq` IDs (`replyToSeq` / `@agent #seq`) and requiring `[consensus]` or `[deadlock]`. On `[consensus]`, post `pantheon_board(action="post", channel="council", threadId="<slug>", tag="consensus", replyToSeq=<seq>, body=...)` and synthesize. If `[deadlock]` persists or the defined rate remains below 50%, research factual divergence points (max 3 searches), post `pantheon_board(action="post", channel="council", threadId="<slug>", tag="deadlock", replyToSeq=<seq>, body=...)` (surfacing in the Cockpit Attention Queue as `decision`), and escalate 2–3 concrete options to the user via the native `question` tool (or @themis as separate moderator, keeping moderator and audit roles separate).
7. **Synthesize and audit:** Use the output format below, then ask @themis (citing the council `#seq` via `replyToSeq` when using `pantheon_board`) to compare raw responses with the synthesis (representation, preserved divergences, attribution, confidence).
8. **Persist (conditional):** Keep the council thread in `pantheon_board`; store durable memory only if a memory-write tool is explicitly exposed and permitted in the active root tool list, requiring its success result before saying it was saved. `BackgroundJobBoard` tracks runtime job bookkeeping separately from `pantheon_board`.

## Specialist Response Format

Require `## specialist_response` from `## Agent Return Format`. First-round agreement signals remain omitted or `none`.

## Domain Map

| Domain | Candidate agents |
|---|---|
| Architecture | athena, hermes, demeter, themis |
| Security | themis, hermes, athena |
| Database | demeter, hermes, athena |
| AI/RAG | hermes, athena, themis |
| Infrastructure | hermes, themis, athena |
| Frontend/UX | aphrodite, themis, hermes |
| Observability | hermes, themis, apollo |
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
