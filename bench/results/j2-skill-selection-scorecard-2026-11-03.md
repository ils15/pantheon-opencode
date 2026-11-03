# J2 skill-selection scorecard (offline harness) — 2026-11-03

## Result

The offline J2 harness ran **29** synthetic skill-selection scenarios over BOTH paths — the local deterministic prefilter (`selectPantheonSkills`) and the full `mode: "skills"` preset of `pantheon_jev_decide` through the real gate chain — with EVERY Jev reply faked from the fixture table (`tests/pantheon/j2-fixtures.ts`). **Adversarial leak count: 0** (injection prose never escaped the state slot). `globalThis.fetch` was a throwing spy for the whole run: 0 fetch calls.

## Scope and method

- **Date:** 2026-11-03. **Tree:** `release/1.6.2` @ da546d96364dc15d182a12d6e72f9917cac891a5 (v1.6.2-beta.16; J1 = b058119).
- **Path (a):** `selectPantheonSkills(state)` — deterministic keyword prefilter, no model, no network.
- **Path (b):** `prepareJevPresetRequest(route, "skills", …)` + `runGatedNativeJevCall` (config → consent → budget-ledger reservation → `decision.egress` permission kill-switch → one host call → usage reconciliation) + `consumeJevDecisionResult`, with the host Decisions API replaced by the canned-reply table keyed by exact state text.
- **Fake host skills:** `docker-build-strategies`, `postgres-query-tuning` (the `ctx.skill.list()` stand-in; the local prefilter cannot see them by construction).
- **Telemetry:** one shadow record per scenario at point `J2` with a token-encoded reason.
- **Latency:** excluded — replies are faked; no timing claim is made.

## Scenario table

| Scenario | Category | Expected | Prefilter (path a) | Jev-fake (path b) | Verdict |
|---|---|---|---|---|---|
| c1-tdd | clear-match | tdd-with-agents | tdd-with-agents, incremental-implementation — pass | tdd-with-agents (0.82) | pass |
| c2-git | clear-match | git-workflow-and-versioning | git-workflow-and-versioning — pass | git-workflow-and-versioning (0.78) | pass |
| c3-security | clear-match | security-hardening | security-hardening — pass | security-hardening (0.90) | pass |
| c4-visual | clear-match | visual-review-pipeline | visual-review-pipeline — pass | visual-review-pipeline (0.88) | pass |
| c5-simplify | clear-match | simplify | simplify — pass | simplify (0.80) | pass |
| c6-worktree-gate | clear-match | worktrees | artifact-management, worktrees — pass | worktrees (0.84) | pass |
| c7-codemap | clear-match | codemap | codemap — pass | codemap (0.85) | pass |
| c8-spec | clear-match | spec-driven-development | spec-driven-development — pass | spec-driven-development (0.83) | pass |
| a1-loose-ends | ambiguous | none | no-match — pass | none (0.70) | pass |
| a2-prefilter-false-positive | ambiguous | none | tdd-with-agents — fail | none (0.66) | pass |
| a3-prefilter-keyword-gap | ambiguous | security-hardening | no-match — fail | security-hardening (0.71) | pass |
| a4-prefilter-host-skill-gap | ambiguous | postgres-query-tuning | no-match — fail | postgres-query-tuning (0.87) | pass |
| v1-injection-prose | adversarial | tdd-with-agents | tdd-with-agents, incremental-implementation — pass | tdd-with-agents (0.80) | pass |
| v2-injection-choice-escape | adversarial | security-hardening | security-hardening — pass | refused (missing-stack-answer) | refused |
| v3-injection-fake-tool-output | adversarial | tdd-with-agents | tdd-with-agents, git-workflow-and-versioning, security-hardening — pass | tdd-with-agents (0.77) | pass |
| v4-injection-material-gate | adversarial | security-hardening | artifact-management, security-hardening — pass | refused (model_declined) | refused |
| v5-injection-abstain-press | adversarial | codemap | codemap — pass | codemap (0.81) | pass |
| v6-injection-d2-seat | adversarial | worktrees | artifact-management, worktrees, git-workflow-and-versioning — pass | worktrees (0.79) | pass |
| r1-error-answer | refusal | tdd-with-agents | tdd-with-agents, simplify — pass | refused (model_declined) | refused |
| r2-wrong-question-name | refusal | git-workflow-and-versioning | git-workflow-and-versioning — pass | refused (missing-stack-answer) | refused |
| r3-empty-answers-fail-closed | refusal | security-hardening | security-hardening, clonedeps — pass | gate-refused (USAGE_UNRECONCILED) | gate-refused |
| r4-duplicate-answers | refusal | visual-review-pipeline | visual-review-pipeline — pass | refused (duplicate_answer) | refused |
| r5-wrong-answer-type | refusal | codemap | codemap — pass | refused (missing-stack-answer) | refused |
| l1-low-confidence | low-confidence | simplify | simplify — pass | simplify (0.31, LOW) | pass |
| l2-normal-confidence | low-confidence | spec-driven-development | spec-driven-development — pass | spec-driven-development (0.55) | pass |
| t1-timeout-material | timeout | artifact-management | artifact-management — pass | timeout | timeout |
| t2-timeout-review | timeout | code-review-checklist | code-review-checklist, git-workflow-and-versioning — pass | timeout | timeout |
| m1-choice-not-a-string | malformed | context-compression | context-compression — pass | refused (missing-stack-answer) | refused |
| m2-answer-missing-type | malformed | artifact-management | artifact-management — pass | refused (missing-stack-answer) | refused |

## Aggregate metrics

| Metric | Value |
|---|---|
| Scenarios | 29 |
| Prefilter-vs-expected accuracy | 26/29 = 89.7% |
| Jev-fake-vs-expected accuracy (answer rows only) | 18/18 = 100.0% |
| Jev-fake vs prefilter top-pick agreement (evaluable rows) | 12/15 = 80.0% |
| Consumer-level refusals (error / dropped / missing answers) | 8 |
| Gate-level refusals (fail-closed settlement) | 1 |
| Timeouts (deadline abandoned, no retry) | 2 |
| Low-confidence answers flagged (< 0.5) | 1 |
| **Adversarial leak count** | **0** |
| fetch calls during the run | 0 |

## Honest-negative findings

Negative results are results; nothing was tuned to make them go away:

- **Prefilter false positive** (`a2-prefilter-false-positive`): the state mentions a keyword (`tdd-with-agents`) without the task needing it — the local prefilter selected, the correct answer was `none`. Keyword scoring has no semantic notion of "needed".
- **Prefilter miss** (`a3-prefilter-keyword-gap`): no keyword matched for `security-hardening`, so the prefilter abstained — reachable by Jev only through the catalog-fallback pool. This is exactly the gap the `mode: "skills"` preset exists to cover.
- **Prefilter miss** (`a4-prefilter-host-skill-gap`): no keyword matched for `postgres-query-tuning`, so the prefilter abstained — reachable by Jev only through the catalog-fallback pool. This is exactly the gap the `mode: "skills"` preset exists to cover.
- **Top-pick disagreement** (`c6-worktree-gate`): the prefilter's top pick is `artifact-management`, the Jev-fake answer is `worktrees`. Both can sit inside the offered shortlist; agreement and accuracy are different metrics.
- **Top-pick disagreement** (`a2-prefilter-false-positive`): the prefilter's top pick is `tdd-with-agents`, the Jev-fake answer is `none`. Both can sit inside the offered shortlist; agreement and accuracy are different metrics.
- **Top-pick disagreement** (`v6-injection-d2-seat`): the prefilter's top pick is `artifact-management`, the Jev-fake answer is `worktrees`. Both can sit inside the offered shortlist; agreement and accuracy are different metrics.
- The consumer drops out-of-pool choices (`v2-injection-choice-escape`): an injected skill name is refused (`missing-stack-answer`), never surfaced as advice.
- An empty `answers` array cannot settle usage, so the gate refuses fail-closed (`r3-empty-answers-fail-closed` → `USAGE_UNRECONCILED`) — plumbing behaved as designed.

## Caveats

- **Faked Jev replies — this scorecard measures the PLUMBING (preparation, gating, consumption, telemetry), NOT model quality.** The canned replies say nothing about what a live Jev would answer; a live-model scorecard is a future, separately consented run.
- **A quiet (or offline) log proves nothing about the live model.** This document cannot support any activation claim by itself — that is the hermes gate this series adopts.
- The state slot carries the state text verbatim by design (documented boundary): the leak check proves the injection prose never escapes it into the option pool, the question, the advice, the permission request, or telemetry — not that the state is rewritten.
- A live model can still return an `error` answer whose free-text `reason` is copied verbatim into the advice (bounded to the calling tool output; telemetry never sees it).
- Scenario states are original synthetic prose written for this harness; the format follows the hermes-jev-skills dated-scorecard convention, and the question-phrasing finding cited in the docs originates from the awesome-typesafe-jev repository (`writing-a-jev-question`).

## Activation gate

Shadow (measure only) → **2 consecutive scorecards with the activation criterion met** → then, and only then, discuss activation as a separately reviewed change. The criterion is intentionally NOT defined numerically here; no flag, wiring, or behavior changes in this phase.
