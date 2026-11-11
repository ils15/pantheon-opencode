# Auto-Continue — details under demand

Moved out of SKILL.md (cost inventory beta.27: the body was 2,656 tokens and
most of it only matters mid-task). Read on demand.

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

Delegate through the root `subagent` tool observed in the Beta 10 runtime. `task()` is
host/API terminology, not an assumed root tool; call shape and background support are
runtime-dependent. Prefer synchronous dispatch unless the active schema exposes background
and the host provides an observable completion notification. Do not assume `task_status`,
`cancel_task`, or board-based tracking/recovery tools are available. When no completion
mechanism is observable, use synchronous dispatch or state the limitation; do not claim
that jobs are being tracked or recovered.

When a delegated agent does not respond in time, enforce the timeout policy defined in
`src/instructions/zeus-timeout-retry.instructions.md`.

**That file is the single authority** for per-role timeouts, retry counts, fallback chains, and
whether partial results are acceptable. It is force-fed into every session via `AGENTS.md`; this
skill is opt-in. Do not restate those values here — a copy in this skill is precisely what drifted
out of sync with them. If a dispatch times out, read the role's row from the instruction file.

### Partial Results on Timeout

Whether an agent may return partial results is the **Partial Results OK?** column in that table.
Only agents marked YES there may return partial — never implementers, never reviewers.

**How to signal partial timeout:**
When dispatching, set the expectation explicitly:
```
@apollo Search for all auth-related files. If you hit timeout, return whatever you have found so far — partial results are acceptable.
```

### Timeout Tracking Table

Maintain an in-context (not persistent/native) checklist of delegations when needed:

| Agent | Started | Timeout | Status | Partial OK? |
|-------|---------|---------|--------|-------------|
| apollo | T+0s | T+60s | complete | YES |
| hermes | T+0s | T+180s | in progress | NO |

---

## Examples

**Good (auto-continues):**
```
Wrote migration file.
-> Running migration tests...
Tests pass (3/3).
-> Next: write UserRepository query methods.
```

**Good (stops at Gate 2):**
```
Phase 1 complete: migration + repository layer.
GATE 2 — Themis review summary:
  - Coverage: 87% | No OWASP issues
Ready for Phase 2? Waiting for go-ahead.
```

**Bad (stops unnecessarily):**
```
Wrote the migration file.
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
