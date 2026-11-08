# Session Goal — Session Reuse (Cross-Task Continuity)

Detail companion for `SKILL.md`. Read on demand when deciding whether a
follow-up delegation reuses an agent session or starts fresh. Goal pinning,
alignment checks, and persistence guardrails stay in `SKILL.md`.

---

Reuse agent sessions between related delegations to avoid re-reading files and re-building context.

### When to Reuse

Prefer reusing an existing session when:
- Follow-up task touches the **same files** or **same feature thread** as a previous delegation
- The specialist already loaded relevant file context in the prior session
- Debugging continues on the same stack trace or module

### When to Start Fresh

Force a new session when:
- Unrelated feature or different part of the codebase
- Previous session has too much noise from an abandoned investigation
- The specialist's accumulated context would mislead the new task

### How to Signal Reuse

When dispatching a follow-up task, include the session reuse context explicitly:

```
@hermes — continuing the auth endpoint work from the previous session.
Files already explored: backend/routers/auth.py, backend/services/auth_service.py.
New task: add refresh token rotation.
```

### Session Tracking

Zeus tracks active sessions with a `task_id` per delegation:

| Agent | Active Session | Files in Context | Max Age |
|-------|---------------|-----------------|---------|
| hermes | ses_abc123 | 4 files | 15 min |
| aphrodite | ses_def456 | 3 files | 15 min |

When `session_max: 2` is set in routing.yml, Zeus keeps the last 2 sessions for that agent and discards older ones. This prevents stale context from accumulating.
