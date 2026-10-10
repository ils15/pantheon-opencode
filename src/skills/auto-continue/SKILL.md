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

## Risk-Proportional Gates

| Gate | Trigger | What happens |
|---|---|---|
| **GATE 0 — Explicit Council** | User explicitly invokes council and it returns `AWAITING_APPROVAL` | Stop and follow the approval the council requests; do not launch a council automatically for ordinary implementation. |
| **GATE 1 — Plan Approval** | A plan was requested or scope/risk makes planning necessary | Ask before implementation only when the plan introduces a material choice or risk; omit this gate for a bounded, clear fix. |
| **GATE 2 — Risk Review** | Auth/security, data/schema/migration, API contract, production configuration, or other material risk | Themis review and human approval before sensitive or irreversible action. For a trivial, isolated, reversible edit, provide a concise result instead of manufacturing a review phase. |
| **GATE 3 — Git / External Action** | Commit, push, merge, production deploy, destructive operation, global configuration, or broad permission change | Always stop for explicit human approval. Full-auto never authorizes these actions by implication. |

An explicit `AWAITING_APPROVAL` from an invoked council remains a hard stop. Authentication/security and data/schema changes retain their review and approval gates even in full-auto.

---

## Auto-Continue Rules

**Continue automatically when:**
- Next todo is a direct consequence of the current one
- Action is reversible (file edits, tests, linting)
- Scope is within the user's explicitly authorized task (a prior plan is not required for a small clear fix)
- No new ambiguity has emerged

**Stop and ask when:**
- A todo requires a decision not covered by the plan
- An unexpected error changes the approach
- A dependency is missing or broken
- Remaining context is too thin to carry the task through — write an explicit handoff instead
- The task reaches a sensitive gate in the table above; full-auto does not override it

### Full-auto Authorization

Full-auto may continue only within a task and scope the user explicitly authorized. It may run reversible edits and proportionate verification; it must stop for auth/security, data/schema changes with risk, destructive or global changes, broad permissions, deploy, push, or merge. Never infer permission to expand the scope from a full-auto request.

---

## Implementation Pattern

```
1. Create todos only for multi-step work; a one-step fix needs no todo ceremony
2. Mark first todo in_progress
3. Complete work → mark completed immediately
4. Mark next todo in_progress → repeat
5. Do NOT ask "should I continue?" between clear steps
6. Stop at any applicable risk gate; do not require a plan/review gate for a low-risk edit
7. After gate approval, resume with next todo
```

**Never batch-complete todos.** Mark each completed as soon as done.

---

## Safety Checks Before Continuing

- [ ] Previous step completed successfully (tests pass, no errors)
- [ ] Next step is within approved plan scope
- [ ] No new blocking issues emerged
- [ ] Remaining context can carry the next step, or an explicit handoff will be written

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
2. **Between sequential phases:** Summarize when dependencies or risk changed; skip ceremony for one-step work
3. **After required Themis review:** Reassess findings before continuing
4. **Session reuse check:** Reuse a prior specialist session only when it reduces real context duplication

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

Use checkpoints only when `context_save` and `context_get` are explicitly
present in the active session's tool list. If unavailable, do not attempt a
checkpoint or guess a session ID; carry the handoff in the normal response.

When available, call `context_save` with `content=JSON.stringify(state)` and an
explicit `session_id`. A successful save needs no immediate `context_get`; read
only when resuming or when the save result is uncertain. Reuse the same session
ID so the `latest` pointer survives compaction. `state` must be an object — never pass a bare string as `content`: its
`goal`/`phase`/`delegations`/`heartbeat` values are objects and `tail` is an array.
`goal` is optional; when unset, omit the key rather than passing a string placeholder.

### Heartbeat Check
- Check heartbeat only when checkpoint tools are available and the workflow needs a durable resume.
- Write a heartbeat after anti-stall recovery only when the current session exposes checkpoint tools.

### Checkpoint Rules
1. Save checkpoints only for long-running/multi-phase work, context-loss risk, or substantive parallel work — not a one-off command or bounded fix
2. Include current phase and remaining tasks when a checkpoint is warranted
3. On resume, read the latest checkpoint only with a known session ID; otherwise request the missing handoff context.

> Do not create `heartbeat.json`, `checkpoint-<N>.json`, or `session.json` under
> `.pantheon/deepwork/`. That file-based mechanism is retired — TTL handles cleanup, and reading
> a file that nothing writes back returns stale state.

---

## Safety Policy Configuration

Configurable gates for different platforms and risk levels:

| Gate | Default | Auto-Approval Condition |
|------|---------|------------------------|
| Council | Only when explicitly invoked | Never auto-start a council for ordinary implementation |
| Plan approval | Only for requested or risk-required plans | Skip for bounded, clear work |
| Themis review | Required for sensitive/material changes | May omit for trivial isolated edits; never auto-bypass required findings |
| Git / external actions | Never Auto | Commit, push, merge, deploy, destructive/global changes require explicit approval |
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
    plan_approval: when_required_by_scope_or_risk
    themis_review: required_for_sensitive_or_material_changes
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
