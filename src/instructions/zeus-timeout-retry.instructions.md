---
description: "Timeout enforcement, retry policies, subtask dispatch, and timeout tracking for Zeus"
name: "Zeus Timeout & Retry"
applyTo: "agents/zeus.agent.md"
---

# ⏱️ TIMEOUT & RETRY ENFORCEMENT

When a delegated agent does not respond in time, enforce the timeout policy from `routing.yml`.

## Timeout Behavior by Agent Role

| Agent Role | Timeout | Retry Policy | Fallback Chain | Partial Results OK? | Reasoning Effort |
|------------|---------|-------------|----------|---------------------|------------------|
| Explorer (@apollo) | 60s | 2 retries, exp backoff | @athena (plan) → @hermes (impl) | ✅ Yes | low |
| Implementer (@hermes, @aphrodite, @demeter) | 180s | 3 retries, exp backoff | @talos (hotfix) → @athena (replan) | ❌ No | medium |
| Reviewer (@themis) | 120s | 3 retries, exp backoff | @zeus (escalate) → user | ❌ No | high |
| Infrastructure (@prometheus) | 300s | 3 retries, exp backoff | @hermes (config) → @zeus (escalate) | ❌ No | medium |
| Hotfix (@talos) | 30s | 2 retries, no backoff | @hermes (full fix) | ✅ Yes | low |
| Remote Sensing (@gaia) | 120s | 2 retries, exp backoff | @hermes (generic) | ✅ Yes | high |

## Retry Flow

```
Task dispatch → timeout elapsed → log timeout
  ├─ retry_count > 0 → retry with exponential backoff → decrement retry_count
  │    └─ still failing? → retry again (up to retry_count limit)
  │
  ├─ retries exhausted → FALLBACK CHAIN:
  │    ├─ fallback[0] exists? → dispatch to fallback agent
  │    │    └─ keep original task spec + context; add error context
  │    ├─ fallback[1] exists? → dispatch to second fallback
  │    └─ all fallbacks failed? → ESCALATE
  │
  ├─ no fallbacks defined → return TIMEOUT error to user
  │
  └─ ESCALATE: "Agent X failed after N retries. Fallbacks Y, Z also failed.
                 Options: (a) try different agent, (b) simplify scope, (c) manual"
```



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
When ALL fallbacks fail:
1. Log the full failure chain: which agents were tried, what error each returned
2. Report to user: "Task [X] failed. Tried: [agent list]. Error: [summary]."
3. Offer options: (a) try different approach, (b) simplify scope, (c) manual fix
4. NEVER retry the same chain automatically — break the cycle

### Session Reuse Check
Before dispatching a task, check if a reusable session exists:

```
@hermes — continuing from previous session.
Files already explored: backend/routers/auth.py, backend/services/auth_service.py.
New task: add refresh token rotation.
```

Use `session_max` from routing.yml to determine how many sessions to keep per agent.

---

# 📦 SUBTASK DISPATCH (Lightweight Delegation)

Subtask is a bounded, low-risk delegation mode that **skips** the standard artifact lifecycle. Use it for focused work that doesn't need Themis review.

## When to Use Subtask vs Full Task

> **REGRA DE OURO:** Quando em dúvida, use full task. Subtask é para o que você tem 100% de certeza que é seguro pular revisão.

### Subtask Decision Tree (run BEFORE every delegation)

```
□ Scope: ≤2 files AND ≤10 lines changed?         [YES→continue | NO→full task]
□ Risk: No schema change, no security impact?      [YES→continue | NO→full task]
□ Auth: No authentication/authorization logic?      [YES→continue | NO→full task]
□ Data: No data loss risk, no migration?            [YES→continue | NO→full task]
□ Review: Output does NOT feed into Themis review?  [YES→continue | NO→full task]

ALL YES → subtask (skip artifact + Themis)
ANY NO  → full task (IMPL artifact + Themis review mandatory)
```

### Comparison Table

| Aspect | Subtask | Full Task |
|--------|---------|-----------|
| Scope | Single file, <10 lines, read-only | Feature, multi-file, schema change |
| Risk | Low (no security/data implications) | Any risk level |
| Artifact | ❌ No IMPL artifact | ✅ IMPL artifact required |
| Themis review | ❌ None | ✅ Mandatory |
| Use case | Apollo discovery, Talos hotfix, bounded fix | Feature implementation, migration, API change |

### Concrete Examples

| Task | Scope | Risk | Subtask? | Why |
|------|-------|------|----------|-----|
| Fix typo in CSS class | 1 file, 1 line | None | ✅ | Bounded, no security impact |
| Add error handling to existing endpoint | 1 file, 5 lines | Low | ✅ | No schema change |
| Implement login endpoint | 2+ files, 50+ lines | High (auth) | ❌ | Security-critical, needs Themis |
| Database migration | 1 file, 15 lines | High (data) | ❌ | Data loss risk, needs rollback |
| Apollo codebase search | 0 files | None | ✅ | Read-only investigation |
| Update README | 1 file, 3 lines | None | ✅ | Documentation only |

### Safety Rules
1. **Bounded scope** — single file or read-only investigation
2. **Low risk** — no security implications, no data loss, no breaking changes
3. **No Themis dependency** — output doesn't feed into a phase that requires review

## Subtask Return Format
Expect a `subtask_summary` response with:
```
## subtask_summary
**files_changed:** [paths]
**summary:** What was done
**tests:** ✅ or N/A
**status:** complete | partial | escalated
```

## Timeout Parcial (Partial Results)

Timeout parcial is ONLY for read-only, independent agents:
- ✅ @apollo — can return partial file list ("found 7 of 12 files before timeout")
- ✅ @gaia — can return partial literature findings

- ✅ @talos — can confirm progress if hotfix times out
- ❌ Never for implementers or reviewers — must complete or fail

When dispatching with partial-OK, set expectation:
```
@apollo Search for auth files. Timeout parcial OK — return whatever you have.
```

---

# 📊 TIMEOUT TRACKING

Maintain awareness of in-flight delegations:

| Agent | Timeout | Status | Partial OK? |
|-------|---------|--------|-------------|
| @apollo | 60s | ✅ complete | ✅ |
| @hermes | 180s | ⏳ in progress | ❌ |
| @themis | 120s | ⏳ in progress | ❌ |

Log timeouts to `/memories/session/timeout-log.md` for later analysis.
