---
name: auto-continue
description: "Auto-continue through todos with idle detection and safety gates. Use for multi-step orchestration."
context: fork
globs: []
alwaysApply: false
---

# Auto-Continue Mode

Disciplined automatic continuation through multi-step tasks. Eliminates unnecessary pauses while preserving mandatory safety gates.

---

## Core Principle

> **Auto-continue through unambiguous work. Stop only at real decision points.**

---

## Mandatory Gates (ALWAYS STOP)

| Gate | Trigger | What happens |
|---|---|---|
| **GATE 0 — Agora Gate** | Agora outputs `AWAITING_APPROVAL` OR `## 🏛️ Agora Council` synthesis block appears | **HARD STOP.** Do not call any tool, do not continue any todo, do not suggest next steps. Wait for user to type: APPROVE / REQUEST CHANGES / DISCARD. "ok", "yes", "sure", "continue" are NOT valid. |
| **GATE 1 — Plan Approval** | Athena generates a plan | User confirms scope before code is written |
| **GATE 2 — Phase Review** | Themis reviews implementation | User sees changes before next phase |
| **GATE 3 — Git Commit** | After each phase is approved | User controls git history; no auto-commit |

> **Agora is always GATE 0**: any response containing `AWAITING_APPROVAL` or a `## 🏛️ Agora Council` block overrides all auto-continue rules.

---

## Auto-Continue Rules

**Continue automatically when:**
- Next todo is a direct consequence of the current one
- Action is reversible (file edits, tests, linting)
- Scope is within the approved plan
- No new ambiguity has emerged

**Stop and ask when:**
- A todo requires a decision not covered by the plan
- An unexpected error changes the approach
- A dependency is missing or broken
- A task would exceed remaining `steps` budget

---

---

## Implementation Pattern

```
1. Create todos for all steps at start
2. Mark first todo in_progress
3. Complete work → mark completed immediately
4. Mark next todo in_progress → repeat
5. Do NOT ask "should I continue?" between clear steps
6. Stop at Gate 1, 2, or 3
7. After gate approval, resume with next todo
```

**Never batch-complete todos.** Mark each completed as soon as done.

---

## Safety Checks Before Continuing

- [ ] Previous step completed successfully (tests pass, no errors)
- [ ] Next step is within approved plan scope
- [ ] No new blocking issues emerged
- [ ] `steps` counter has sufficient budget remaining

---

## Cooldown Pattern

Between phases, execute a brief synthesis handoff to prevent context drift and prepare the next phase:

### Phase Summary Template
```
Phase N complete. Summary:
- What was done: <2 bullet points>
- What changed: <files modified>
- What's next: <Gate 2 review OR next phase>
- Will continue: <YES / after gate approval>
```

### Cooldown Rules
1. **Between parallel waves (no dependency):** No cooldown needed — wave results are independent
2. **Between sequential waves (with dependency):** Always run cooldown — dependencies may have changed context
3. **After Themis review (GATE 2):** Cooldown is mandatory — review findings may change the plan
4. **Session reuse check:** Before starting next phase, check if a specialist session from a previous phase can be reused (see session-goal skill)

### Abbreviated Cooldown
When auto-continuing between sequential non-gated phases, the cooldown is abbreviated to one line:
```
→ Phase N done. Next: Phase N+1. [auto-continuing]
```
Only expand to full cooldown when hitting a mandatory gate.

---

## Timeout & Retry Enforcement

When a delegated agent does not respond in time, enforce the timeout policy defined in
`src/instructions/zeus-timeout-retry.instructions.md`.

**That file is the single authority** for per-role timeouts, retry counts, fallback chains, and
whether partial results are acceptable. It is force-fed into every session via `AGENTS.md`; this
skill is opt-in. Do not restate those values here — a copy in this skill is precisely what drifted
out of sync with them. If a dispatch times out, read the role's row from the instruction file.

### Timeout Parcial (Partial Results)

Whether an agent may return partial results is the **Partial Results OK?** column in that table.
Only agents marked ✅ there may return partial — never implementers, never reviewers.

**How to signal timeout parcial:**
When dispatching, set the expectation explicitly:
```
@apollo Search for all auth-related files. If you hit timeout, return whatever you have found so far — partial results are acceptable.
```

### Timeout Tracking Table

Maintain a mental table of in-flight delegations:

| Agent | Started | Timeout | Status | Partial OK? |
|-------|---------|---------|--------|-------------|
| apollo | T+0s | T+60s | ✅ complete | ✅ |
| hermes | T+0s | T+180s | ⏳ in progress | ❌ |

---

## Examples

**Good (auto-continues):**
```
✅ Wrote migration file.
→ Running migration tests...
✅ Tests pass (3/3).
→ Next: write UserRepository query methods.
```

**Good (stops at Gate 2):**
```
✅ Phase 1 complete: migration + repository layer.
⏸️ GATE 2 — Themis review summary:
  - Coverage: 87% ✅ | No OWASP issues ✅
Ready for Phase 2? Waiting for go-ahead.
```

**Bad (stops unnecessarily):**
```
✅ Wrote the migration file.
Should I now run the migration tests? [waiting]
```

## Session Heartbeat & Checkpoints

Session state is **not** file-based. It lives in **pantheon-persistence** under the
`checkpoint:<slug>` namespace and is cleaned up automatically by a 4h TTL.

Write state with `context_save(slug, key, value, session_id=...)` and read it back with
`context_get(slug, "latest", session_id=...)`. Capture `session_id` from the first `context_save`
of the session and reuse it for the rest of the session, so the `latest` pointer survives
compaction.

### Heartbeat Check
- If `context_get(slug, "heartbeat")` returns a checkin older than 300s, log a stall warning and resume
- Write a heartbeat after every anti-stall recovery action

### Checkpoint Rules
1. Save a checkpoint before **every** delegate dispatch and after every agent returns
2. Include current phase, turn count, and remaining tasks
3. On resume: `context_get(slug, "latest")` restores the most recent checkpoint

> Do not create `heartbeat.json`, `checkpoint-<N>.json`, or `session.json` under
> `.pantheon/deepwork/`. That file-based mechanism is retired — TTL handles cleanup, and reading
> a file that nothing writes back returns stale state.

---

## Safety Policy Configuration

Configurable gates for different platforms and risk levels:

| Gate | Default | Auto-Approval Condition |
|------|---------|------------------------|
| GATE 0 — Council/Plan | Always Ask | N/A — always requires human |
| GATE 1 — Plan Approval | Always Ask | Plan matches acceptance criteria + no risks flagged |
| GATE 2 — Themis Review | Ask by Default | Auto-approve if: Themis APPROVED + no CRITICAL/HIGH issues + coverage ≥80% |
| GATE 3 — Git Commit | Never Auto | N/A — always manual |
| Deploy | Always Ask | N/A — always requires human |
| Destructive DB Ops | Always Ask | N/A — always requires human |

### Configuration Format (for agents/PLAN.md)

```yaml
auto-continue:
  checkpoint_interval: 5     # turns between checkpoints
  idle_warning: 60           # seconds before warning
  idle_stall: 120            # seconds before stall detection
  idle_pause: 300            # seconds before auto-pause
  gates:
    plan_approval: always_ask
    themis_review: auto_approve_if_clean
    git_commit: never_auto
    deploy: always_ask
    destructive_ops: always_ask
```

### Idle Detection

| Condition | Action |
|-----------|--------|
| No tool call for 60s | Log warning heartbeat (status: warning) |
| No tool call for 120s | Trigger anti-stall protocol |
| No tool call for 300s | Auto-save checkpoint and pause session |
| Resume | User must acknowledge and restart |

---

## Scope

**Applies to:** Zeus (multi-phase), Hermes/Aphrodite/Demeter (TDD cycles), Apollo (parallel searches), Talos (bug fixes).

**Does NOT apply to:** Athena planning (always presents plan = Gate 1), Iris (confirms before push), destructive operations (always ask).
