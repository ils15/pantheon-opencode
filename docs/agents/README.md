# Agent Reference — Pantheon

This directory indexes the definitions for all 14 Pantheon agents. The canonical files live in `src/agents/` and use the `.md` extension; their frontmatter specifies tools, model tier, capabilities, and delegation rules.

## Agents

| Agent | File | Role |
|-------|------|------|
| @zeus | [zeus.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/zeus.md) | Central orchestrator |
| @athena | [athena.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/athena.md) | Strategic planner |
| @apollo | [apollo.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/apollo.md) | Investigation scout |
| @hermes | [hermes.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/hermes.md) | Backend specialist |
| @aphrodite | [aphrodite.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/aphrodite.md) | Frontend specialist |
| @demeter | [demeter.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/demeter.md) | Database specialist |
| @themis | [themis.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/themis.md) | Quality & security gate |
| @prometheus | [prometheus.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/prometheus.md) | Infrastructure & observability specialist |
| @hephaestus | [hephaestus.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/hephaestus.md) | AI pipelines |
| @nyx | [nyx.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/nyx.md) | Chaos & adversarial testing |
| @gaia | [gaia.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/gaia.md) | Remote sensing |
| @iris | [iris.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/iris.md) | GitHub operations |
| @mnemosyne | [mnemosyne.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/mnemosyne.md) | Memory curation |
| @talos | [talos.md](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/talos.md) | Hotfix agent |

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
| prometheus | `docs/infra/conventions.md` — CI stages, envs, containers, observability | Observability absorbed from nyx ✓ |
| hephaestus | `docs/ai/prompt-conventions.md` (candidate — write when the project wires LLMs) | No new tool |
| nyx | `docs/testing/adversarial-corpus.md` — the payloads that broke it, durable for the next run | Fuzzing/adversarial niche — sole owner ✓ |
| gaia | geospatial conventions (candidate, niche deployments) | Vision grant trio ✓ |
| iris | `docs/release/runbook.md` (candidate) — release steps gh actually runs | gh workflows; never pushes/merges without human approval |
| mnemosyne | `.pantheon/memory-bank/` + ADRs — owns it today | `memory_store` grant — sole owner ✓ |
| talos | none — the hotfix lane stays light by design | No tooling; speed is the product |

The convention-doc rule (carried in each owning agent's body): keep the
domain doc current as you work, read it first when it exists, propose it when
the surface exists and the file does not — and update only what you changed;
a stale convention line is worse than a missing one.

## Full Reference

See [AGENTS.global.md](https://github.com/ils15/pantheon-opencode/blob/main/AGENTS.global.md) for shared role summaries and the canonical files above for each agent's full contract.
