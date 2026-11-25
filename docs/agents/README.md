# Agent Reference — Pantheon

This directory indexes the definitions for all 8 canonical Pantheon agents. Beyond them, `spawn_ephemeral` spawns a short-lived worker for any valid role slug (`^[a-z0-9][a-z0-9-]{0,31}$`); 7 built-in archetype presets supply defaults for `hotfix`, `infra-ci`, `ai-pipeline`, `observability`, `geospatial`, `memory-adr` and `memory-consolidate`, but they are presets, not an allowlist. The canonical files live in `src/agents/` and use the `.md` extension; their frontmatter specifies tools, model tier, capabilities, and delegation rules.

## Agents

| Agent | File | Role |
|-------|------|------|
| @zeus | [zeus.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/zeus.md) | Central orchestrator |
| @athena | [athena.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/athena.md) | Strategic planner |
| @apollo | [apollo.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/apollo.md) | Investigation scout |
| @hermes | [hermes.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/hermes.md) | Backend, infra & execution specialist |
| @aphrodite | [aphrodite.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/aphrodite.md) | Frontend specialist |
| @demeter | [demeter.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/demeter.md) | Database specialist |
| @themis | [themis.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/themis.md) | Quality & security gate |
| @iris | [iris.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/iris.md) | GitHub ops & memory-bank custodian |

## Domain artifacts and exclusivity (measured 2026-11-05)

Each specialist owns the durable artifact of its domain — the file the NEXT
session reads first — and the exclusivity that pays is already enforced by
grants, not by new tooling (the MCP usage audit found no delivery friction a
new exclusive tool would remove; new exclusive tools fail the measured bar).

| Agent | Domain artifact (authors/maintains) | Exclusive tooling verdict |
|-------|--------------------------------------|---------------------------|
| zeus | `AGENTS.md` managed region, `routing.yml` | Gate chain, budget ledger, persistence goal tools — grant-exclusive ✓ |
| athena | `docs/plans/<slug>.md` — the plan artifact a session executes against | Plan-only contract is the exclusivity |
| apollo | none — read-only; delivers structured Briefs in-session | Read-only contract is the exclusivity |
| hermes | `docs/api/conventions.md` — REST shapes, errors, auth, async patterns | Shared `execute_code_script`; no new tool |
| aphrodite | `docs/ui/conventions.md` — tokens, layout, a11y, component patterns — kept current whenever the project has a graphical surface | Vision grant trio (describe/ocr/analyze) — grant-exclusive ✓ |
| demeter | `docs/data/conventions.md` — schema style, migration rules, N+1 doctrine | No new tool; SQL via shared code-mode |
| themis | `docs/review/checklist.md` — the gates actually enforced per project | Secret scan is platform-level, not agent-owned |
| iris | `docs/release/runbook.md` (candidate), `.pantheon/memory-bank/` + ADRs | gh workflows + `memory_store` grant; never pushes/merges without human approval |

The convention-doc rule (carried in each owning agent's body): keep the
domain doc current as you work, read it first when it exists, propose it when
the surface exists and the file does not — and update only what you changed;
a stale convention line is worse than a missing one.

## Full Reference

See [AGENTS.global.md](https://github.com/ils15/pantheon-opencode/blob/main/AGENTS.global.md) for shared role summaries and the canonical files above for each agent's full contract.
