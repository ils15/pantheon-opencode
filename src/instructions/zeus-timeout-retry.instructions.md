---
description: "Timeout enforcement, retry policies, subtask dispatch, and timeout tracking for Zeus"
name: "Zeus Timeout & Retry"
applyTo: "agents/zeus.agent.md"
---

# ⏱️ TIMEOUT & RETRY ENFORCEMENT

When a delegated agent does not respond in time, enforce the timeout policy from `routing.yml`.

## Timeout Behavior by Agent Role

| Agent Role | Timeout | Retry Policy | Partial Results OK? | Reasoning Effort |
|------------|---------|--------------|---------------------|------------------|
| Explorer (@apollo) | 60s | 1 retry | ✅ Yes | low |
| Implementer (@hermes, @aphrodite, @demeter) | 180s | 1 retry | ❌ No | medium |
| Reviewer (@themis) | 120s | 1 retry | ❌ No | high |
| Infrastructure (@prometheus) | 300s | 1 retry | ❌ No | medium |
| Hotfix (@talos) | 30s | 1 retry | ✅ Yes | low |
| Remote Sensing (@gaia) | 120s | 1 retry | ✅ Yes | high |

## Retry Flow

```
Initial attempt → timeout/failure → log it → make at most one retry
  └─ retry fails → try fallback agents left-to-right with original task/context
       └─ all fallbacks fail (or none exist) → report the chain and escalate
```
`background_delegation.retry_count: 1` means one retry after the initial attempt, not one total attempt. Never restart an exhausted chain automatically.

Apply the retry only to a transient dispatch failure (timeout, crash, or empty response). A failed test, validation, or migration is a result to diagnose, not a reason to repeat the same command or agent blindly. Track agents already tried: each agent may be retried at most once and each listed fallback may be tried at most once. For auth/security/data/schema work, a fallback must preserve specialist competence, Themis review, and human approval; otherwise stop and escalate. Never let full-auto bypass these gates.
An agent refusal or scope-boundary response is not a transient failure: do not retry it with a rephrased prompt. Correct the route once if the right specialist is clear; otherwise stop and ask.

## Fallback Chain Definitions

Each fallback chain is evaluated left-to-right: if the first fallback fails, try the second, etc.

| Agent | Fallback[0] | Fallback[1] | Escalate To |
|-------|------------|------------|-------------|
| @apollo | @athena (plan scoped task) | @hermes (implement search) | @zeus |
| @hermes | @talos (minimal fix) | @athena (replan + simplify) | @zeus |
| @aphrodite | @talos (CSS/UX fix) | @hermes (generic fallback) | @zeus |
| @demeter | @hermes (generic backend) | @athena (replan schema) | @zeus |
| @themis | @zeus (direct escalation) | — | user |
| @prometheus | @hermes (config/deploy) | @zeus | user |
| @talos | @hermes (full implementation) | — | @zeus |
| @hephaestus | @nyx (observability debug) | @hermes (generic) | @zeus |
| @nyx | @hermes (generic) | — | @zeus |
| @iris | @zeus (manual override) | — | user |
| @mnemosyne | @zeus (manual) | — | user |

### Escalation Protocol
When all fallbacks fail, report the tried agents and errors, offer a different approach/simpler scope/manual fix, and stop. Never retry the same chain automatically.

### Session Reuse Check
Check for a reusable session before dispatch and obey `session_max` in `routing.yml`.

---

# 📦 SUBTASK DISPATCH (Lightweight Delegation)

Subtask is a bounded, low-risk delegation mode that **skips** the standard artifact lifecycle. Choose it by risk and need for review, not by a fixed file/line count.

## When to Use Subtask vs Full Task

Use the lightest path that safely meets the request. A multi-file but bounded low-risk change does not automatically need a plan/artifact phase.

### Subtask Decision Tree (run BEFORE every delegation)

```
□ Is the scope clear, bounded, and reversible?                 [YES→continue | NO→clarify/plan]
□ Does it avoid auth/security, data/schema, and destructive risk? [YES→continue | NO→full review/gates]
□ Is there no required Themis/audit handoff for this change?     [YES→continue | NO→preserve that review]

ALL YES → direct/lightweight execution; no routine plan or artifact
ANY NO  → add only the planning, artifact, specialist review, and approval gates the risk requires
```

### Safety Rules
1. **Bounded scope** — can be a small multi-file change or a read-only investigation
2. **Low risk** — no security implications, no data loss, no breaking changes
3. **No required Themis dependency** — sensitive/material output retains its review gate

## Subtask Return Format
Return the required `## subtask_summary` fields defined in `## Agent Return Format`; include `memory_context` when memory was used.

## Timeout Parcial (Partial Results)

Only agents marked ✅ in the Timeout Behavior table above may return partial results: @apollo (partial file list, e.g. "found 7 of 12 files before timeout"), @gaia (partial literature findings) and @talos (confirm progress if a hotfix times out). Never for implementers or reviewers — they must complete or fail. When dispatching with partial-OK, set the expectation: `@apollo Search for auth files. Timeout parcial OK — return whatever you have.`

---

# 📊 TIMEOUT TRACKING

Track in-flight delegations against the Timeout Behavior table above. Log timeouts to `/memories/session/timeout-log.md` for later analysis.
