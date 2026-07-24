# Copilot Instructions
# ─────────────────────────────────────────────────────────────
# This file is automatically read by GitHub Copilot on every
# interaction in VSCode. Customize it for your product.
#
# INSTRUCTION LOADING HIERARCHY (Feb 2026, #297179):
#   ~/.copilot/instructions/     → personal, cross-repo preferences (you only)
#   .github/copilot-instructions.md → THIS FILE: team-shared, repo-level standards
#   .vscode/settings.json        → per-file-pattern rules via codeGeneration.instructions
#
# Keep team/product standards HERE. Personal style goes in ~/.copilot/instructions/.
# ─────────────────────────────────────────────────────────────

## Memory Bank

Always read `.pantheon/memory-bank/01-active-context.md` before answering any task.
Always read `.pantheon/memory-bank/00-project.md` for project scope, architecture, agents, and tech stack.

> These two files are your primary source of truth for the current project state.

---

## Stack
# ⬇️ Customize this section for your project

# Backend: Python 3.12 + FastAPI
# Frontend: React 18 + TypeScript
# Database: PostgreSQL + SQLAlchemy 2.0 + Alembic
# Infra: Docker + Traefik + VPS

---

## Coding Standards
# ⬇️ Adapt these to your product's conventions

# - Use async/await in all FastAPI routes (no sync DB calls inside routes)
# - All DB queries via Repository Pattern — no raw queries in route handlers
# - Pydantic v2 for all models and schemas
# - PEP8 + Black formatter for Python
# - TypeScript strict mode, no `any`
# - WCAG AA accessibility for all frontend components
# - AGENT TEST EXECUTION: Agents running automated tests MUST use non-interactive commands (e.g. `npx vitest run` instead of `vitest` watch mode, or `pytest -v` without `pdb`). Never use watch modes or commands that prompt for user action.

---

## Agent Research Phase Timeouts (CRITICAL)

| Agent | Phase | Max Time | Max Searches |
|---|---|---|---|
| @athena | Planning | 5 min | 3 searches |
| @apollo | Discovery | 8 min | 10/batch, 5 iterations |
| @hermes/@aphrodite/@demeter | Implementation | 30 min | 2–3/phase |
| @themis | Review | 2 min | None (review only) |

**Early termination:** 80% convergence or 5 iterations → STOP. No perfect results.

---

## Agent Lifecycle Hooks

> **Platform reality:** `.github/hooks/*.json` are reference documentation for hook behavior and future-proofing — they are NOT auto-loaded by VS Code Copilot (no such native API exists). Runtime hooks run as follows:
> - **Claude Code**: `.claude/settings.json` (PreToolUse, PostToolUse, Stop)
> - **OpenCode**: `opencode-hooks-plugin` reads `.claude/settings.json` — same config works on both
> - **VS Code Copilot**: no native hooks API; hooks are enforced via CI (`.github/workflows/ci.yml`)

| Hook | Spec | Runtime Phase | Blocks / Does |
|---|---|---|---|
| `security.json` | `.github/hooks/security.json` | PreToolUse | rm -rf, DROP TABLE, TRUNCATE |
| `format.json` | `.github/hooks/format.json` | PostToolUse | Auto-formats (Python: Black+isort, JS/TS: Biome, YAML/JSON: yamlfmt) |
| `logging.json` | `.github/hooks/logging.json` | SessionStart | Logs agent session metadata |
| `delegation-start.json` | `.github/hooks/delegation-start.json` | SubagentStart | Logs delegation start |
| `delegation-stop.json` | `.github/hooks/delegation-stop.json` | SubagentStop | Logs completion (success/failure) |
| `type-check.json` | `.github/hooks/type-check.json` | PostToolUse | Validates Python (pyright) + TS (tsc) |
| `import-audit.json` | `.github/hooks/import-audit.json` | PostToolUse | Blocks `from X import *`, suspicious patterns |
| `secret-scan.json` | `.github/hooks/secret-scan.json` | PreToolUse | Blocks hardcoded API keys, tokens, passwords |

Audit logs: `logs/agent-sessions/delegations.log` + `delegation-failures.log`

---

## Agent Coordination

When implementing a feature across multiple layers, follow this workflow:
1. `@athena` plans the full feature (creates implementation plan)
2. User approves the plan
3. `@zeus` coordinates implementation agents (hermes, aphrodite, demeter) in parallel
4. **MANDATORY: Every implementing agent IMMEDIATELY calls @themis after completing code**
   - Hermes (backend) → Themis (quality checks + security review)
   - Aphrodite (frontend) → Themis (quality checks + accessibility review)
   - Demeter (database) → Themis (quality checks + correctness review)
   - Prometheus (infra) → Themis (quality checks + deployment review)
5. @themis runs lightweight quality checks (trailing spaces, hard tabs, wild imports) + manual review
6. Only after APPROVED: proceed to next phase
7. `@mnemosyne` closes the sprint (updates memory bank)

---

## CRITICAL — runSubagent Restrictions

**NEVER call `runSubagent` with custom agent names** (`athena`, `apollo`, `hermes`, `aphrodite`, `demeter`, `prometheus`, `themis`, `mnemosyne`, `hephaestus`, `gaia`, `zeus`).

These are VS Code custom agents (`.agent.md` files). They are NOT available in the `runSubagent` registry. Calling them will always fail silently or throw an error.

**The only agent available via `runSubagent` is `Explore`** (read-only codebase exploration).

**Correct invocation pattern — always tell the user to use `@` in chat:**
```
❌ runSubagent("athena", ...) — NEVER do this
✅ Tell the user: "@athena Plan the feature"
✅ Tell the user: "@zeus /implement-feature ..."
```

When a user asks you to "use Athena", "invoke Apollo", "call Zeus", etc. — respond by telling them the exact `@agentname` command to type in VS Code chat. Do NOT attempt to call `runSubagent` with those names.

---

## Memory Bank Protocol

When completing a task, update `.pantheon/memory-bank/`:
- **01-active-context.md** — update current focus, recent decision, next steps
- **02-progress-log.md** — append a milestone entry (never edit previous entries)

When making a significant architectural decision:
```
@mnemosyne Document decision: [topic]
```

When completing a major feature:
```
@mnemosyne Close sprint: [brief summary of what was delivered]
```
