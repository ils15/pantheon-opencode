# Pantheon for OpenCode

Complete setup and usage guide for running Pantheon **v1.5.0** in [OpenCode](https://opencode.ai) — 4 presets (`go-free`/`go-fast`/`go-premium`/`openai` puro), wizard 3 perguntas, herança nativa default, and an explicit V1/V2 plugin contract — the open-source AI coding agent for the terminal, desktop, and IDE.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **OpenCode** installed | Install via `curl -fsSL https://opencode.ai/install.sh | sh` or `npm install -g @opencode/opencode` |
| **Node.js 18+** | Only needed for the sync engine (`npm run sync`) and installer script |
| **Git** | Any recent version |

---

## Installation

OpenCode is available in three form factors:

| Form Factor | How to Get It |
|---|---|
| **Terminal TUI** | Install script, npm, Homebrew, pacman, scoop, choco, Docker — see [opencode.ai](https://opencode.ai) |
| **Desktop app** | Download from [opencode.ai/download](https://opencode.ai/download) — macOS, Linux, Windows |
| **IDE extension** | Available for VS Code, JetBrains, and Zed |

The V1 path includes the security-hook plugin at
`src/plugins/pantheon-hooks.ts`, backed by `src/plugins/hook-runner.ts` (the
runner uses `node:child_process`, not Bun Shell `$`). It bridges the scripts in
`scripts/hooks/` to the V1 OpenCode events. Register it only in the V1
singular `plugin` list; it is not auto-discovered from `.opencode/plugins/`.
The V2 `plugin-v2` adapter does not register this hook plugin or any V1
delegate/event/tool API.

The OpenCode-specific installer is the supported setup path:

```bash
npx pantheon-opencode init --project
```

This installs the selected OpenCode components in the global or project-local
OpenCode directories and updates the selected plugin registration. It does not
autodetect or configure VS Code, Cursor, or other platforms. Use
`--opencode-version v1|v2|auto` to select the plugin contract; `auto` is the
conservative version hint described below, not general platform detection.

### V1/V2 plugin contract

Pantheon 1.5.0 has two mutually exclusive OpenCode registrations. The
installer cleans Pantheon entries from both config shapes and writes only the
selected generation; do not hand-add the other generation afterward.

| Selection | OpenCode key | Pantheon plugin | What it provides |
|---|---|---|---|
| `v1` | singular `plugin` | `src/plugin.ts` (and the V1 `src/plugins/pantheon-hooks.ts` entry) | Legacy `pantheon_delegate`, `pantheon_delegation_read`, `pantheon_delegation_list`, event/tool hooks and the implemented V1 compaction path |
| `v2` | plural `plugins` | `pantheon-opencode/plugin-v2` | Configuration adapter for agent, catalog, command, reference and skill drafts; no V1 runtime APIs |

`plugin-v2` is not a V1 runtime compatibility layer. It does not register the
legacy delegate tools, BackgroundJobBoard integration, V1 hooks, or a
compaction hook. Its unsupported-feature contract includes
`legacy-hooks`, `tool-execute-hooks`, `session-hooks`, `event-stream`, and
`compaction-hook`. OpenCode native `task()` remains a host feature and must not
be documented as `pantheon_delegate` in V2.

Use one of these selectors:

```bash
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2
npx pantheon-opencode init --opencode-version auto
```

The legacy `--version v1|v2` spelling is accepted after `init`; use
`--opencode-version auto` for the conservative selector.
`auto` resolves only from the explicit `OPENCODE_VERSION=v1|v2` hint, then an
`OPENCODE_BIN` path ending in `opencode2`; otherwise it selects V1. It does not
inspect the host generally and never installs both Pantheon plugin generations.
Third-party plugin entries are retained as third-party entries.

The TUI is separate from both registrations. It is copied and added to
`tui.json` only when the `plugins` component is selected; that component does
not imply that the V1 runtime or V2 adapter has been loaded.

### Desktop App

Pantheon works seamlessly with the OpenCode Desktop app. Agents, skills, and instructions are discovered from the project directory the same way as in the terminal TUI. Use the Desktop app for a richer UI experience with integrated diffs, file tree browsing, and system notifications.

### Manual Setup

```bash
# Clone the repo
git clone https://github.com/ils15/pantheon.git
cd pantheon

# Copy the packaged OpenCode agents into your project
mkdir -p /path/to/your-project/.opencode/agents
cp -r src/agents/. /path/to/your-project/.opencode/agents/

```

Choose exactly one plugin contract before creating the config. In Pantheon
1.5.0, the singular `plugin` key selects the preserved V1 runtime; the
plural `plugins` key with `pantheon-opencode/plugin-v2` selects the V2
configuration adapter. Do not register both Pantheon generations.

For the preserved V1 runtime, create `/path/to/your-project/opencode.json`
with the singular `plugin` key. Replace `<pantheon-checkout>` with the
absolute path to the cloned repository so both the legacy plugin and its
explicitly registered V1 hooks are loaded:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "<pantheon-checkout>/src/plugin.ts",
    "<pantheon-checkout>/src/plugins/pantheon-hooks.ts"
  ]
}
```

Use this V1 registration when you need `pantheon_delegate`, the V1
BackgroundJobBoard and its event/tool hooks, or the implemented V1 compaction
path. The hooks are not auto-discovered from `.opencode/plugins/`.

For the V2 adapter, and only when V1 delegate APIs are not expected, copy the
repository's root config as a V2 starting point:

```bash
cp opencode.json /path/to/your-project/opencode.json
```

That file intentionally contains the V2-only registration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["pantheon-opencode/plugin-v2"]
}
```

`plugin-v2` transforms configuration drafts; it does not provide V1 delegate
tools, hooks, BackgroundJobBoard integration, compaction, or automatic resume.
If you prefer the supported installer, use
`npx pantheon-opencode init --project --opencode-version v1` or `v2` instead;
`auto` is only the conservative selector described above, not general
platform detection.

### How It Works

The installer copies the packaged agent Markdown into `.opencode/agents/`
(project-local) or the global OpenCode agent directory. V1 runtime behavior is
provided by the selected V1 plugin. The V2 `plugin-v2` export is a separate
configuration adapter that transforms the host's agent/catalog/command,
reference and skill drafts; it is not a general Markdown-to-runtime converter
and does not add V1 hooks or delegate APIs.

### `/init` Command

OpenCode's built-in `/init` command auto-generates an `AGENTS.md` file by scanning your project. It analyzes build commands, test commands, architecture, and conventions, then produces concise project-specific guidance for future agent sessions.

```
/init
```

If an `AGENTS.md` already exists, `/init` improves it in-place rather than replacing it. This is complementary to Pantheon — `/init` captures project-level context while Pantheon agents provide role-specific behavior.

---

## Configuration

OpenCode uses `opencode.json` (or `opencode.jsonc`) in your project root. Create one with:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "zeus":      { "source": ".opencode/agents/zeus.md" },
    "athena":    { "source": ".opencode/agents/athena.md" },
    "apollo":    { "source": ".opencode/agents/apollo.md" },
    "hermes":    { "source": ".opencode/agents/hermes.md" },
    "aphrodite": { "source": ".opencode/agents/aphrodite.md" },
    "demeter":      { "source": ".opencode/agents/demeter.md" },
    "themis":     { "source": ".opencode/agents/themis.md" },
    "prometheus":        { "source": ".opencode/agents/prometheus.md" },
    "iris":      { "source": ".opencode/agents/iris.md" },
    "mnemosyne": { "source": ".opencode/agents/mnemosyne.md" },
    "talos":     { "source": ".opencode/agents/talos.md" },
    "gaia":      { "source": ".opencode/agents/gaia.md" },
    "hephaestus":   { "source": ".opencode/agents/hephaestus.md" },
    "nyx":       { "source": ".opencode/agents/nyx.md" }
  }
}
```

| Setting | Purpose |
|---|---|
| `agent` | Maps agent names to their `.md` definition files in `.opencode/agents/` |
| `default_agent` | Sets which primary agent is used by default (e.g., `"build"`, `"zeus"`) |

### Default Agent

The `default_agent` option in `opencode.json` controls which primary agent OpenCode uses when starting a session:

```json
{
  "default_agent": "zeus"
}
```

If not set, OpenCode defaults to the built-in `build` agent. This is useful when Pantheon's Zeus orchestrator should be the primary interaction point.

### Agent permissions

OpenCode agent permissions are supplied by the host configuration and the
selected installation. The V1 `tool.execute.before` guard can enforce the
read-only delegate matrix; `plugin-v2` does not add that runtime guard.

```yaml
---
name: hermes
permission:
  edit: N/A (ferramenta nao existe neste runtime)
  bash: allow
  read: allow
  search: allow
---
```

Override permissions per-agent in `opencode.json` when the host supports it:

```json
{
  "agent": {
    "hermes": {
      "source": ".opencode/agents/hermes.md",
      "permission": {
        "edit": "allow",
        "bash": "allow",
        "read": "allow",
        "search": "allow"
      }
    }
  }
}
```

### Task Permissions (Subagent Control)

Control which subagents can be invoked using `permission.task` with glob patterns:

```json
{
  "permission": {
    "task": {
      "*": "allow",
      "apollo": "allow",
      "zeus": "allow",
      "internal-*": "deny"
    }
  }
}
```

This can also be set per-agent to restrict which subagents each Pantheon agent can delegate to:

```json
{
  "agent": {
    "zeus": {
      "source": ".opencode/agents/zeus.md",
      "permission": {
        "task": {
          "hermes": "allow",
          "aphrodite": "allow",
          "themis": "allow",
          "internal-*": "deny"
        }
      }
    }
  }
}
```

---

## Agent Format

OpenCode agents are `.md` files with YAML frontmatter. They live in
`.opencode/agents/` (project) or the global OpenCode agent directory. The
installer copies the packaged agent files; it does not claim a general
VS Code-to-OpenCode conversion layer.

```yaml
---
name: hermes
description: "Backend specialist — FastAPI, Python, async, TDD"
argument-hint: "Backend task: endpoint, service, router, schema, or test"
mode: subagent
tools:
  - agent
  - grep
  - search/usages
  - read/readFile
  - edit
  - bash
  - execute/testFailure
  - execute/getTerminalOutput
  - search/changes
  - webfetch
---
```

### Agent Modes

OpenCode supports two agent modes declared in frontmatter:

| Mode | Description |
|---|---|
| `primary` | Main assistant you interact with directly. Can cycle via Tab key. Has full tool access based on permissions. |
| `subagent` | Specialized assistant invoked by primary agents or via `@mention`. Used for delegated tasks. |

Pantheon agents are configured as `mode: subagent` by default, with Zeus as the primary orchestrator. You can also configure mode via `opencode.json`:

```json
{
  "agent": {
    "zeus": {
      "source": ".opencode/agents/zeus.md",
      "mode": "primary"
    }
  }
}
```

### V1/V2 agent behavior

Both paths can expose the installed agent Markdown to OpenCode, but the runtime
contracts are different:

| Concern | V1 | V2 |
|---|---|---|
| Agent runtime | Legacy Pantheon plugin plus OpenCode agent config | `plugin-v2` transforms agent drafts and sets Zeus to `primary` |
| Delegation | Pantheon `pantheon_delegate` tools and V1 board | No Pantheon delegate tools; use native OpenCode behavior only where supported |
| Hooks/events | V1 plugin and separately registered V1 hooks | Not registered by `plugin-v2` |
| Compaction/restart | Only the V1 paths documented below | No Pantheon compaction or auto-resume contract |

The former “adapter v2.0.0” description is superseded by this table. It does not
claim conversion or feature parity with another editor's Markdown format.

### Frontmatter Fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Agent identifier used for `@name` invocation |
| `description` | Yes | Shown in agent picker |
| `argument-hint` | No | Example usage shown when invoking |
| `mode` | No | `primary` or `subagent` |
| `model` | No | Ordered list of preferred model IDs |
| `tools` | No | Tools the agent may use (YAML list) |
| `temperature` | No | Response randomness (0.0–1.0) |

---

## OpenCode-Specific Features

### TUI Plugin (1.5.0)

Pantheon 1.5.0 ships an optional **TUI plugin** for OpenCode that provides:
- **Live deepwork status** — see active phases, progress, and checkpoints
- **Activity feed** — real-time agent delegation events
- **Toast notifications** — phase completion, review results, gate approvals

The installer copies the TUI package to the selected OpenCode config and writes
its registration to `tui.json` only when the `plugins` component is selected.
It is not auto-discovered from `.opencode/plugins/`, and this separate TUI
registration does not load either the V1 runtime plugin or the V2 adapter.

The panel can follow native OpenCode `task()` children only when OpenCode
provides explicit origin, parent/child and status metadata. A child without
that contract remains a generic child; absence of a Markdown report is not
evidence that it is a native task. Markdown reports in
`.pantheon/delegations/` are historical output from the V1 delegate/board
path, not a V2 task protocol.

### Recovery and compaction limits

The V1 `experimental.session.compacting` hook carries forward the V1 board
context where that host hook is available. On process restart, running legacy
board jobs are marked errored; old jobs are not auto-resumed and child work is
not restarted automatically. `plugin-v2` registers no Pantheon compaction
hook, BackgroundJobBoard lifecycle, or automatic resume/restart behavior.

### Themis 2.0 (available in 1.5.0)

Pantheon 1.5.0 includes **Themis 2.0** — a 3-layer review pipeline:
1. **Heuristic Scanner** — zero-LLM static analysis (ruff, biome, anti-pattern detection, hash verification)
2. **Deep Review** — LLM-powered code review with OWASP Top 10, coverage enforcement, and correctness checks
3. **Verification Planning** — structured verification plan with test gap analysis

Run via `/pantheon-audit` with `--light` (layer 1 only), `--full` (layers 1-3), or `--plan` (layer 3 only).

### YAGNI Ladder

Built into every agent's workflow, the **YAGNI Ladder** prevents overengineering:
- **Step 1**: Solve the problem directly (no abstraction)
- **Step 2**: Extract only if duplication appears 3+ times
- **Step 3**: Abstract only when the pattern is proven stable

### Model Configuration — 4 Presets (gerado de `src/routing.yml`)

> **Default = herdar do chat (sem `active-preset.json`) no caminho V1** — sem preset ativo, os delegates V1 herdam nativamente o modelo do chat pai. O plugin V1 (`src/plugin.ts` → `resolveActivePreset`) lê `PANTHEON_MODEL_PRESET` env > primeiro `.pantheon/active-preset.json` (project → `~/.config/opencode` → `~/.opencode`) > **`null` (herança nativa)**. `loadRoutingAgentModels` vazio quando `null`; `delegation.ts` omite `model` em `session.create`/`promptAsync` para herança nativa. `small_model` nunca usado. O V2 adapter não registra `pantheon_delegate` nem aplica esta cadeia de delegate.

Tabelas abaixo são **geradas a partir de [`src/routing.yml`](../../src/routing.yml)** via `node scripts/generate-preset-docs.mjs` (sem hardcodar segredos — só `PANTHEON_OPENCODE_API_KEY` / `OPENAI_API_KEY` nomes + `baseURL`s). Pricing 2026 verificado via `scripts/install/model-picker.mjs` (`PRESET_PRICE`).

#### Presets — resumo (provider / BaseURL / key / pricing / vision)

| Preset | Provider / BaseURL | Key env (nome) | Pricing 2026 | Vision (fallback) | Papéis / Modelos |
|---|---|---|---|---|---|
| `go-free` | `opencode` `https://opencode.ai/zen/v1` (env: `PANTHEON_OPENCODE_API_KEY`) | `PANTHEON_OPENCODE_API_KEY` | Gratuito — Zen free, sem custo, quota limitada, só modelos `-free` | `opencode/mimo-v2.5-free` [low] 👁️ vision | zeus: `opencode/big-pickle` [medium]<br>athena: `opencode/nemotron-3-super-free` [high]<br>themis: `opencode/qwen3.6-plus-free` [high]<br>hermes,aphrodite,demeter,prometheus,hephaestus: `opencode/deepseek-v4-flash-free` [medium]<br>apollo,nyx,gaia,iris,mnemosyne,talos: `opencode/mimo-v2.5-free` [low] |
| `go-fast` | `opencode-go` `https://opencode.ai/zen/go/v1` (env: `PANTHEON_OPENCODE_API_KEY`) | `PANTHEON_OPENCODE_API_KEY` | Baixo custo — Go gateway, baixa latência (kimi-k2.7-code / glm-5.3-flash) | `opencode-go/mimo-v2.5` [low] 👁️ vision | athena: `opencode-go/kimi-k2.7-code` [high]<br>themis: `opencode-go/glm-5.3-flash` [high]<br>zeus: `opencode-go/kimi-k2.7-code` [medium]<br>hermes,prometheus: `opencode-go/deepseek-v4-flash` [medium]<br>aphrodite,hephaestus: `opencode-go/mimo-v2.5` [low]<br>demeter: `opencode-go/gpt-5.6-luna` [low]<br>apollo,nyx,gaia,iris,mnemosyne,talos: `opencode-go/gpt-5.6-luna-fast` [low] |
| `go-premium` | `opencode-go` `https://opencode.ai/zen/go/v1` (env: `PANTHEON_OPENCODE_API_KEY`) | `PANTHEON_OPENCODE_API_KEY` | Premium — Go gateway, melhor qualidade (gpt-5.6-sol / qwen3.8-max / deepseek-v4-pro) | `opencode-go/gpt-5.6-sol` [high] 👁️ vision | zeus: `opencode-go/gpt-5.6-sol` [medium]<br>athena: `opencode-go/deepseek-v4-pro` [high]<br>themis: `opencode-go/qwen3.8-max` [high]<br>hermes,demeter,hephaestus: `opencode-go/gpt-5.6-terra` [medium]<br>aphrodite,prometheus: `opencode-go/kimi-k3` [medium]<br>apollo,nyx,gaia,iris,mnemosyne,talos: `opencode-go/gpt-5.6-luna` [low] |
| `openai` | `openai` `https://api.openai.com/v1` (env: `OPENAI_API_KEY`) | `OPENAI_API_KEY` | Pago (OpenAI) — Direto OpenAI, `gpt-5.6` family | `openai/gpt-5.6-sol` [high] 👁️ vision | athena,themis,zeus: `openai/gpt-5.6-sol` [high]<br>hermes,aphrodite,demeter,prometheus,hephaestus: `openai/gpt-5.6-luna` [high]<br>apollo,nyx,gaia,iris,mnemosyne,talos: `openai/gpt-5.6-luna-fast` [low] |

#### Provider / BaseURL / Key env (nomes, sem valores)

| Preset | Provider | BaseURL | Key env |
|---|---|---|---|
| `go-free` | `opencode` | `https://opencode.ai/zen/v1` | `PANTHEON_OPENCODE_API_KEY` |
| `go-fast` | `opencode-go` | `https://opencode.ai/zen/go/v1` | `PANTHEON_OPENCODE_API_KEY` |
| `go-premium` | `opencode-go` | `https://opencode.ai/zen/go/v1` | `PANTHEON_OPENCODE_API_KEY` |
| `openai` | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |

> Alias `OPENCODE_GO_API_KEY` aceito no wizard Q2 para `go-*` (mesma chave `PANTHEON_OPENCODE_API_KEY`). Nenhum `.env` é escrito.

#### Pricing 2026

| Preset | Pricing 2026 | Detalhe | Gateway / Custo |
|---|---|---|---|
| `go-free` | Gratuito | Zen free – sem custo, quota limitada, só modelos `-free` | `opencode` — $0 (free-tier Zen) |
| `go-fast` | Baixo custo | Go gateway – baixa latência, kimi-k2.7-code / glm-5.3-flash | `opencode-go` — Baixo custo, baixa latência |
| `go-premium` | Premium | Go gateway – melhor qualidade, gpt-5.6-sol / qwen3.8-max / deepseek-v4-pro | `opencode-go` — Premium, melhor qualidade |
| `openai` | Pago (OpenAI) | Direto OpenAI – https://api.openai.com/v1, gpt-5.6 family | `openai` — Pago por uso |

*Pricing verificado 2026 via `PRESET_PRICE` + `routing.yml` descrições. Custos reais dependem de conta/assinatura.

#### 14 agentes × 4 presets — modelo + effort + vision

| Agente | `go-free` | `go-fast` | `go-premium` | `openai` |
|---|---|---|---|---|
| `zeus` | `opencode/big-pickle` [medium] · | `opencode-go/kimi-k2.7-code` [medium] · | `opencode-go/gpt-5.6-sol` [medium] 👁️ | `openai/gpt-5.6-sol` [high] 👁️ |
| `athena` | `opencode/nemotron-3-super-free` [high] · | `opencode-go/kimi-k2.7-code` [high] · | `opencode-go/deepseek-v4-pro` [high] · | `openai/gpt-5.6-sol` [high] 👁️ |
| `themis` | `opencode/qwen3.6-plus-free` [high] · | `opencode-go/glm-5.3-flash` [high] · | `opencode-go/qwen3.8-max` [high] · | `openai/gpt-5.6-sol` [high] 👁️ |
| `hermes` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/deepseek-v4-flash` [medium] · | `opencode-go/gpt-5.6-terra` [medium] 👁️ | `openai/gpt-5.6-luna` [high] 👁️ |
| `aphrodite` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/mimo-v2.5` [low] 👁️ | `opencode-go/kimi-k3` [medium] · | `openai/gpt-5.6-luna` [high] 👁️ |
| `demeter` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/gpt-5.6-luna` [low] 👁️ | `opencode-go/gpt-5.6-terra` [medium] 👁️ | `openai/gpt-5.6-luna` [high] 👁️ |
| `prometheus` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/deepseek-v4-flash` [medium] · | `opencode-go/kimi-k3` [medium] · | `openai/gpt-5.6-luna` [high] 👁️ |
| `hephaestus` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/mimo-v2.5` [low] 👁️ | `opencode-go/gpt-5.6-terra` [medium] 👁️ | `openai/gpt-5.6-luna` [high] 👁️ |
| `apollo` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ |
| `nyx` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ |
| `gaia` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ |
| `iris` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ |
| `mnemosyne` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ |
| `talos` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ |

`·` = text-only, `👁️` = vision (image-input) via `CAPABILITY_TABLE` (`src/pantheon/presets.mjs`). Ex.: `mimo-v2.5*` e `gpt-5.6*` são multimodais; `deepseek*`, `kimi-k2.7-code`, `glm-5.3-flash`, `qwen3.6-plus-free`, `big-pickle`, `nemotron-3-super-free` são text-only.

#### Capability — text-only vs multimodal + esforço máximo

| Prefix | Max Effort | Vision | Strip Effort | Uso nos presets |
|---|---|---|---|---|
| `deepseek/deepseek-v4-pro` | high | — | no | `go-premium` athena |
| `deepseek/deepseek-v4-flash` | medium | — | no | `go-free` implementers, `go-fast` hermes/prometheus |
| `claude` | — | 👁️ | yes | não usado nos 4 presets atuais (legado `go-claude` removido) |
| `gpt-5.6-sol` | high | 👁️ | no | `go-premium` zeus/vision, `openai` planners/vision |
| `gpt-5.6-terra` | medium | 👁️ | no | `go-premium` implementers |
| `gpt-5.6-luna-fast` | low | 👁️ | no | scouts `go-fast`/`openai` |
| `gpt-5.6-luna` | low | 👁️ | no | scouts `go-premium`, implementer `go-fast` demeter |
| `gpt-5.6` | medium | 👁️ | no | fallback `gpt-5.6*` |
| `mimo/` | low | 👁️ | no | `mimo` family gateway |
| `mimo-v2.5` | low | 👁️ | no | `go-fast` visão + aphrodite/hephaestus |
| `mimo-v2.5-free` | low | 👁️ | — | `go-free` scouts + visão |
| `mimo-v2.5-pro` | low | — | no | text-only (não usado nos presets ativos) |
| `glm-5.3-flash` | high | — | no | `go-fast` themis |
| `kimi-k2.7-code` | high | — | no | `go-fast` athena/zeus |
| `kimi-k3` | medium | — | no | `go-premium` aphrodite/prometheus |
| `qwen3.8-max` | high | — | no | `go-premium` themis |
| `qwen3.6-plus-free` | medium | — | no | `go-free` themis |
| `big-pickle` | medium | — | no | `go-free` zeus |
| `nemotron-3-super-free` | high | — | no | `go-free` athena |
| `deepseek-v4-flash` | medium | — | no | bare prefix para `opencode-go/deepseek-v4-flash` |
| `deepseek-v4-pro` | high | — | no | bare prefix para `opencode-go/deepseek-v4-pro` |

*Tabela gerada de `CAPABILITY_TABLE` em `presets.mjs` (verificado 2026-08-27 via `models.dev`). `stripEffort` = remove `reasoning_effort` (ex.: `claude`). `maxEffort` = teto clamped via `normalizeCapability`/`EFFORT_RANK`.*

#### Per-agent overrides — `/pantheon-model set --agent`

Desde v1.5.0, personalização fina **por agente** sem tocar `opencode.json` top-level nem `.env`:

```bash
# wizard interativo (agente → modelo → effort → scope)
/pantheon-model
# status — 14 agentes com modelo/effort/origem (preset|override|env|none), sem segredos
/pantheon-model status   # alias: show
# set por agente — validação CAPABILITY_TABLE + clamp + hasVision warning
/pantheon-model set --agent hermes --model opencode-go/gpt-5.6-terra --effort medium --scope project
/pantheon-model set --agent apollo --model opencode/mimo-v2.5-free --effort low
/pantheon-model reset --agent hermes --scope project
```

- Valida `agent ∈ {zeus, athena, apollo, hermes, aphrodite, demeter, themis, prometheus, hephaestus, nyx, gaia, iris, mnemosyne, talos}`.
- Valida `provider/model-id` via `MODEL_REF_PATTERN` e `capabilityEntry(model)` (sem entrada → erro); clampa `effort` via `normalizeCapability`; avisa se `hasVision(model)===false` para uso multimodal.
- Persiste em `.pantheon/active-preset.json` em `overrides.agents[agent].model` + `variant` (mapeado para `reasoning_effort` no merge) — escrita atômica `tmp`+`rename` com `.bak` + lock por path + `O_NOFOLLOW` + health-check. Default scope `project`; `global` exige `confirm`+`authorize_global`.
- Nunca escreve `.env` nem injeta `model`/`small_model` global — herança nativa segue: `explicit model` > `overrides.agents` > `preset agents` > nativo.

#### Model Value Types (legado → 1.5.0)

| Valor | Antes (≤1.4.1) | Agora (1.5.0) |
|---|---|---|
| **String explícita** `provider/model-id` | `agent.model` em `opencode.json` | `presets.<name>.agents[agent].model` em `routing.yml` + `overrides.agents[agent].model` via `/pantheon-model set --agent` |
| **`"auto"`** | herdava `chat` via `/model` | deprecated — herança nativa automática quando sem preset/override (sem `model` enviado) |
| **`null`** | fallback para top-level `model` | não usado — sem top-level `model`; ausência = herança nativa |
| **Ausência** | default do OpenCode | **herança nativa** — delegação omite `model` e OpenCode herda da sessão pai (chat) |

#### Switching from Hardcoded to Per-agent Override

```json
// Antes (≤1.4.1) — top-level opencode.json
{
  "agent": {
    "apollo": { "model": "opencode/deepseek-v4-flash" }
  }
}

// Agora (1.5.0) — sem top-level; use /pantheon-model
// no chat OpenCode:
/pantheon-model set --agent apollo --model opencode/mimo-v2.5-free --effort low --scope project
// persiste em .pantheon/active-preset.json:
// { "preset": "go-fast", "overrides": { "agents": { "apollo": { "model": "opencode/mimo-v2.5-free", "variant": "low" } } } }
```

Apollo agora segue o override (se houver) ou preset agente; se nenhum, herda do chat `/model`.

#### Model Priority Chain (V1, 1.5.0)

```
1. explicit model em pantheon_delegate({model: "provider/model-id"})
2. overrides.agents[agent].model em active-preset.json (/pantheon-model set --agent)
3. presets.<active>.agents[agent].model  (loadRoutingAgentModels)
4. (ausência) → herança nativa — OpenCode herda modelo da sessão pai (chat)
   — small_model nunca usado para delegates
   — top-level opencode.json model ignorado (removido no install)
```

This priority chain is V1 `pantheon_delegate` behavior. It is not a V2
`plugin-v2` API or a promise about native OpenCode `task()` model selection.

---

### Model Tiers (legado → 1.5.0 presets)

> **Legado superseded**: tiers `fast`/`default`/`premium` eram abstrações manuais em `opencode.json` (ex.: `gpt-4o-mini`, `gpt-4o`, `o3`). **Em 1.5.0**, tiers são **pinados via 4 presets** (`go-free`/`go-fast`/`go-premium`/`openai`) em [`src/routing.yml`](../../src/routing.yml) — cada agente recebe `model` + `reasoning_effort` concretos no caminho V1. Veja seção **Model Configuration — 4 Presets** acima para tabelas geradas (`node scripts/generate-preset-docs.mjs`). Sem preset, a herança nativa documentada aplica-se à delegação V1; o V2 adapter não registra essa API.

### ACP (Agent Client Protocol)

OpenCode supports the Agent Client Protocol (ACP), allowing it to be used as an AI coding agent from any ACP-compatible editor or IDE (Zed, JetBrains, Neovim with Avante.nvim or CodeCompanion.nvim, etc.).

Start the ACP server:

```bash
opencode acp
```

This starts OpenCode as an ACP-compatible subprocess communicating via JSON-RPC over stdio. ACP does not change the selected plugin contract: V1 hook/delegate behavior still depends on V1 host events, while `plugin-v2` remains a configuration adapter without V1 runtime APIs. Verify the selected registration in the OpenCode config before relying on a feature.

For Zed, configure in `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "OpenCode": {
      "command": "opencode",
      "args": ["acp"]
    }
  }
}
```

### Claude Code Compatibility

OpenCode reads Claude Code's file conventions as fallbacks when Pantheon's AGENTS.md doesn't exist:

| Fallback | Path |
|---|---|
| Project rules | `CLAUDE.md` in project root (used if no `AGENTS.md` exists) |
| Global rules | `~/.claude/CLAUDE.md` (used if no `~/.config/opencode/AGENTS.md` exists) |
| Skills | `.claude/skills/` directory |

To disable Claude Code compatibility:

```bash
export OPENCODE_DISABLE_CLAUDE_CODE=1    # Disable all .claude support
export OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1   # Disable only ~/.claude/CLAUDE.md
export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1   # Disable only .claude/skills
```

### Config Sync with GitHub

OpenCode supports remote configuration via `.well-known/opencode` endpoints, allowing organizations to push default settings. Config is loaded in this precedence order:

1. **Remote** — `.well-known/opencode` (org defaults)
2. **Global** — `~/.config/opencode/opencode.json` (user preferences)
3. **Custom** — `$OPENCODE_CONFIG` env var
4. **Project** — `opencode.json` in project root
5. **`.opencode/`** — agents, commands, plugins

Later sources override earlier ones. Non-conflicting keys are merged.

For GitHub Actions integration, run `opencode github install` to set up automated issue triage, PR review, and fix workflows.

### MCP Server Support

OpenCode supports both local and remote MCP servers via `opencode.json`:

```json
{
  "mcp": {
    "internet-search": {
      "type": "local",
      "command": ["npx", "-y", "@opencontext/mcp-server-search"],
      "enabled": true
    }
  }
}
```

MCP tools are automatically available to agents alongside built-in tools. You can scope them per-agent using the `tools` permission key.

### Theme Customization

OpenCode offers a customizable TUI with built-in themes (tokyonight, catppuccin, gruvbox, nord, etc.) and custom themes. Configure via `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "theme": "catppuccin-macchiato"
}
```

Create custom themes in `~/.config/opencode/themes/` or `.opencode/themes/`.

Quick theme switching in-session: `/themes`

---

## File Locations

```
your-project/
├── opencode.json                     # Project config (model, agents, instructions)
├── AGENTS.md                         # Project rules (auto-generated by /init)
├── .opencode/agents/                  # Generated agent .md files
│   ├── zeus.md
│   ├── athena.md
│   ├── apollo.md
│   ├── hephaestus.md
│   ├── hermes.md
│   ├── aphrodite.md
│   ├── demeter.md
│   ├── themis.md
│   ├── prometheus.md
│   ├── iris.md
│   ├── mnemosyne.md
│   ├── nyx.md
│   ├── talos.md
│   └── gaia.md
├── agents/                           # Canonical VS Code .agent.md sources
├── skills/                           # Skill definitions
├── instructions/                     # *.instructions.md files
├── prompts/                          # *.prompt.md files
└── .claude/                          # Fallback Claude Code files (optional)
```

### Global Location

```
~/.config/opencode/
├── opencode.json                     # Global user preferences
├── AGENTS.md                         # Global project rules
├── agents/                           # Global custom agents
├── themes/                           # Custom theme files
└── tui.json                          # TUI settings (theme, keybinds)
```

---

## Troubleshooting

### Agents Not Showing Up

- Ensure agents are placed in `.opencode/agents/` or referenced via the `agent` key in `opencode.json`
- Run `opencode agent list` to verify agents are registered
- Check that agent `.md` files have valid YAML frontmatter

### Default Agent Not Working

- Check the `default_agent` value in `opencode.json` — it must match an agent name exactly
- Verify the referenced agent exists and has `mode: primary`
- Fall back to OpenCode's built-in `build` agent by removing the `default_agent` key

### Model Not Available

- Models must use `provider/model` format — verify with `opencode models`
- Ensure the provider's API key is set via `opencode auth login` or environment variables
- The VS Code `(copilot)` suffix model IDs will not resolve in OpenCode — override models in `opencode.json`

### Instructions Not Loading

- Paths in the `instructions` array are relative to the config file location
- Verify files exist at the specified paths
- Instructions are merged across all config layers (global + project)

### MCP Server Not Connecting

- Run `opencode mcp list` to check server status
- For OAuth servers, run `opencode mcp auth <server-name>` to authenticate
- Check network connectivity for remote MCP servers
- Increase `timeout` in the MCP config for slow servers

### ACP Server Not Starting

- Check that port is available (default uses stdio for JSON-RPC)
- For TCP mode, verify `--port` is not already in use
- Ensure the calling editor/IDE supports ACP protocol

### Skills Not Discovered

- Ensure `"permission": { "skill": { "*": "allow" } }` is set in `opencode.json`
- Skills must be registered via skill-registry or placed in `.opencode/skills/`

### Desktop App Issues

- Fully quit and relaunch the app
- Try disabling plugins via `~/.config/opencode/opencode.json`
- Clear the cache: `rm -rf ~/.cache/opencode`
- On Linux with Wayland, try `OC_ALLOW_WAYLAND=1`; on Windows, ensure WebView2 runtime is installed
- Check system requirements: modern GPU, 4GB+ RAM, latest OS updates

### Slow Responses

- Use faster models (Haiku, Gemini Flash) for exploration agents (Apollo, Talos)
- Reduce the number of `instructions` loaded per agent
- Reserve powerful models (Sonnet, Opus) for implementation and review
- Use per-agent `model` overrides to assign cheap models for discovery tasks

### Debugging

- Run `opencode run` with logging: `opencode --log-level DEBUG run "prompt"`
- Check logs at `~/.local/share/opencode/log/`
- Use `/troubleshoot #session` in-session for real-time diagnostics

---

## Quick Reference

| Action | Command / Config |
|---|---|
| Start OpenCode (TUI) | `opencode` |
| Start OpenCode (Desktop) | Desktop app from [opencode.ai/download](https://opencode.ai/download) |
| Run non-interactive | `opencode run "prompt"` |
| Initialize project rules | `/init` (in-session) |
| Invoke an agent | `@zeus: Implement email verification` |
| List agents | `opencode agent list` |
| Create agent interactively | `opencode agent create` |
| List models | `opencode models` |
| Start ACP server | `opencode acp` |
| Add MCP server | `opencode mcp add` |
| Add provider key | `opencode auth login` |
| Switch theme | `/themes` in-session |
| Install GitHub integration | `opencode github install` |
| View sessions | `opencode session list` |
| View token stats | `opencode stats` |
| Debug MCP auth | `opencode mcp debug <server>` |

## 🚀 Advanced: Background Orchestration with opencode-pty

By default, OpenCode's `task` tool runs synchronously — the parent waits for the child to complete. For long-running operations (builds, tests, data processing), you can use the **opencode-pty** plugin to run agents in background.

### Installation

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "opencode-sm",
    "shekohex/opencode-pty"
  ]
}
```

Then install:
```bash
opencode plugin install shekohex/opencode-pty
```

### Tools Added

| Tool | Purpose |
|------|---------|
| `pty_spawn` | Start a process in background (returns PID) |
| `pty_read` | Read output from a background process |
| `pty_list` | List active background processes |
| `pty_kill` | Terminate a background process |
| `pty_snapshot_wait` | Wait for process to reach a condition |

### Usage in Pantheon

When Zeus delegates a long-running task:

```text
Zeus: "@hermes — run the full test suite in background"
Hermes: Uses pty_spawn to start pytest
Zeus: Continues with other work
Later: Zeus checks pty_read for results
```

### Example Workflow

```json
{
  "tool": "pty_spawn",
  "command": "pytest --tb=short -q",
  "cwd": "/workspace/project"
}
→ Returns: { "pid": "pty-123", "status": "running" }

{
  "tool": "pty_read",
  "pid": "pty-123",
  "offset": 0,
  "limit": 100
}
→ Returns: { "output": "...test results...", "status": "running" }

{
  "tool": "pty_snapshot_wait",
  "pid": "pty-123",
  "pattern": "passed|failed",
  "timeout": 300000
}
→ Returns: { "output": "...", "status": "completed" }
```

### Limitations

- Background tasks run on the **same machine** (not distributed)
- No automatic retry or failure recovery (must be handled manually)
- Process state is lost if OpenCode restarts
- Requires `opencode-pty` plugin (not available in all OpenCode installations)

### Alternative: Manual Background

Without the plugin, use standard Unix backgrounding:

```bash
# Start in background, redirect output to file
nohup pytest --tb=short -q > /tmp/test-results.log 2>&1 &
echo $! > /tmp/test-pid.txt

# Later, check results
cat /tmp/test-results.log
```

This is the approach used by Pantheon's built-in hooks.

---

## 📝 Advanced: Dynamic Prompts with File Templates

OpenCode prompts are static templates (e.g., `{{input}}`). For dynamic prompt generation based on context, use **file-based templates** with the `{file:...}` syntax.

### How It Works

1. Pre-generate prompt templates for common scenarios
2. Store them in `prompts/dynamic/` directory
3. Reference them in `opencode.json` commands

### Example: Dynamic Council Prompt (/pantheon)

Create `prompts/dynamic/council-architecture.txt`:
```
You are convening a council on architecture decisions.
Active agents: {{agents}}
Context: {{context}}

Consult these specialists:
- @athena for planning
- @hermes for implementation feasibility
- @demeter for database impact

Synthesize their perspectives into a single recommendation.
```

Reference in `opencode.json`:
```json
{
  "command": {
    "pantheon": {
      "template": "{file:./prompts/dynamic/council-architecture.txt}"
    }
  }
}
```

### Generation Script

Add to `scripts/generate-prompts.sh`:
```bash
#!/bin/bash
# Generate dynamic prompts
AGENTS=$(ls platform/opencode/agents/ | sed 's/.md//' | paste -sd ', ' -)

sed -e "s/{{agents}}/$AGENTS/g" \
    prompts/templates/council-template.txt \
    > prompts/dynamic/council-generated.txt
```

### Limitations

- Not true runtime generation (generated at plan-switch time)
- Requires manual regeneration when agents change
- Platform-specific (OpenCode supports `{file:...}`, others may not)

---

[Main Documentation](../../README.md)
