# Pantheon Platforms

Installation guide for OpenCode.

---

## Quick Install

```bash
git clone https://github.com/ils15/pantheon.git
cd pantheon

npx pantheon-opencode init

# Or target a specific project
npx pantheon-opencode init --project
```

---

## OpenCode Guide

| Platform | Link | Install Method | Config File(s) |
|---|---|---|---|---|
| **OpenCode** | [`opencode.md`](opencode.md) | `npx pantheon-opencode init` | `opencode.json` |

---

## Step Limits (opencode.json)

Configuration `steps` per agent — controls how many tool calls the agent can make before being forced to respond:

| Agent | Steps | Justification |
|---|---|---|
| Zeus | 30 | Orchestrator — delegates to 5+ sub-agents |
| Hermes, Aphrodite | 30 | TDD: test → code → test → refactor → lint |
| Demeter | 20 | Migrations + queries + indexes |
| Hephaestus | 25 | RAG pipelines + embeddings + chains |
| Themis | 20 | Multi-file review: lint + coverage + OWASP |
| Athena | 20 | Planning + research + Zeus council synthesis |
| Gaia | 20 | Multi-provider configuration |
| **Mnemosyne** | **20** | ADR: read code → write → verify → commit |
| Apollo | 15 | Parallel search (3-10 searches) |
| Nyx | 15 | Observability |
| Iris | 12 | GitHub: branch → commit → push → PR |
| Prometheus | 15 | Docker + CI/CD |
| **Talos** | **5** | Fast hotfix (1 file, no TDD) |

> Adjust `steps` in `opencode.json` as needed. Each tool call counts as 1 step.

## Provider Usage Capability (B3-02)

Pantheon exposes a pure, in-memory tracker for **exact** provider usage and
context-limit data. A complete payload must include non-negative finite numeric
`usage.inputTokens`, `usage.outputTokens`, and `limit.contextTokens`, plus
non-empty `sessionId`, `providerId`, and `modelId`. Duplicate event/part IDs and
stale sequence values are ignored per isolated stream.

V1 and V2 capability probes are independent and return the canonical
`UNSUPPORTED` status when exact data is absent, partial, stringified, invalid,
or only represented as a percentage. They do not estimate tokens, limits,
percentages, or dollars, and do not use credentials, retries, cache, polling,
or TUI state. No host/provider is declared supported by this contract alone;
integration remains conditional on observed exact host data.

---

## C9/tool ceiling (B3-07)

The C9 ceiling is calculated only from a live host/SDK response containing
exact usage and context-limit fields. Pantheon never estimates a ceiling from
text or query terms; when the SDK does not expose filtering the result is
`UNSUPPORTED` (also called `NOT_SUPPORTED`), while a failed live probe is
`UNAVAILABLE` and malformed host data is `CORRUPT_DATA`.

## File Structure (after install)

```
your-project/
├── agents/              # (copied from pantheon/agents/)
│   ├── zeus.agent.md
│   ├── athena.agent.md
│   └── ...
├── skills/              # (copied from pantheon/skills/)
├── instructions/        # (copied from pantheon/instructions/)
├── prompts/             # (copied from pantheon/prompts/)
└── opencode.json        # Main OpenCode config
```
