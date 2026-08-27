# Pantheon for OpenCode

Complete setup and usage guide for running Pantheon **v1.4.2** in [OpenCode](https://opencode.ai) — 4 presets (`go-free`/`go-fast`/`go-premium`/`openai` puro), wizard 3 perguntas, herança nativa default — the open-source AI coding agent for the terminal, desktop, and IDE.

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

Pantheon ships a hooks plugin at `src/plugins/pantheon-hooks.ts`, backed by the `src/plugins/hook-runner.ts` runner (spawns each script with `node:child_process` and delivers the `{tool_name, tool_input, agent_id, session_id}` payload as JSON on stdin — version-proof, no Bun Shell `$` dependency). It bridges the shell scripts from `scripts/hooks/` to OpenCode events: tool.execute.before (validate-talos-scope, scan-secrets, validate-tool-safety, on-subagent-delegation-start), tool.execute.after (format-multi-language, log-session-start, on-subagent-delegation-stop), and event session.created (log-session-start, validate-post-conditions). Register it explicitly in `opencode.json`: `"plugin": ["<path>/src/plugins/pantheon-hooks.ts"]` (absolute path — project or, for global installs, `<prefix>/lib/node_modules/pantheon-opencode/src/plugins/pantheon-hooks.ts`). It is **not** auto-discovered from `.opencode/plugins/`.

The fastest way to set up Pantheon in any project is with the universal install script:

```bash
npx pantheon-opencode init --project
```

This auto-detects the platform (OpenCode, VS Code, Cursor, etc.), installs agents to the correct directories, and creates platform config files. The generated `opencode.json` includes only `$schema`, `permission`, and `instructions` — model overrides are stripped and resolved at runtime via plan files.

### Desktop App

Pantheon works seamlessly with the OpenCode Desktop app. Agents, skills, and instructions are discovered from the project directory the same way as in the terminal TUI. Use the Desktop app for a richer UI experience with integrated diffs, file tree browsing, and system notifications.

### Manual Setup

```bash
# Clone the repo
git clone https://github.com/ils15/pantheon.git
cd pantheon

# Copy the pre-generated OpenCode agents into your project
mkdir -p /path/to/your-project/.opencode/agents
cp -r platform/opencode/agents/. /path/to/your-project/.opencode/agents/

# Copy the root opencode.json as a starting point
cp opencode.json /path/to/your-project/opencode.json
```

### How It Works

The OpenCode agents live in `platform/opencode/agents/` (generated from canonical `agents/` by `npm run sync`). The adapter (v2.0.0) uses a tool map to convert canonical VS Code tool names to OpenCode-native names, moves permissions from body blocks to frontmatter, and excludes tools not available in OpenCode (`read/problems`, browser tools).

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

### Agent Permissions (adapter v2)

In OpenCode adapter v2, permissions are declared in **frontmatter** rather than appended as body blocks. The sync engine generates them automatically:

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

Body-level permission blocks are no longer used — removed in v2.0.0.

Override generated permissions per-agent in `opencode.json`:

```json
{
  "agent": {
    "hermes": {
      "source": "opencode/agents/hermes.md",
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

OpenCode agents are `.md` files with YAML frontmatter. They live in `.opencode/agents/` (project) or `~/.config/opencode/agents/` (global). The Pantheon sync engine (adapter v2.0.0) generates them from the canonical VS Code `.agent.md` sources into `platform/opencode/agents/`, applying tool name mapping and permissions conversion.

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

### Differences from VS Code Format

The OpenCode adapter v2 (2.0.0) maps canonical VS Code tool names to OpenCode-native names and manages differences:

| Aspect | VS Code (.agent.md) | OpenCode (.md) |
|---|---|---|---|
| **File extension** | `.agent.md` | `.md` |
| **Tools format** | YAML list | YAML list (with name mapping) |
| **Model format** | YAML list | YAML list (identity) |
| **Handoffs** | Full support with UI buttons | **Stripped** — not supported |
| **`agents:` field** | Required for subagent delegation | **Stripped** — OpenCode uses Task tool |
| **`disable-model-invocation`** | Supported | **Stripped** |
| **Permissions** | Set via settings.json / hooks | **Frontmatter** (v2) — body blocks removed |
| **`read/problems`** | Supported | **Excluded** — not available in OpenCode |
| **Browser tools** | `openBrowserPage`, etc. | **Excluded** — no browser in terminal UI |
| **`mode` field** | Not supported | **Added** — `primary` or `subagent` |
| **Skills** | Declared in settings.json | Declared in `opencode.json` skill registry |
| **Instructions** | `.github/copilot-instructions.md` | `instructions` array in `opencode.json` |

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

### TUI Plugin (v4.0)

Pantheon v4.0 ships a **TUI plugin** for OpenCode that provides:
- **Live deepwork status** — see active phases, progress, and checkpoints
- **Activity feed** — real-time agent delegation events
- **Toast notifications** — phase completion, review results, gate approvals

The plugin auto-discovers from `.opencode/plugins/` when running from the project directory. It's also synced globally to `~/.config/opencode/plugins/` via `npm run sync opencode`.

### Themis 2.0

Pantheon v4.0 introduces **Themis 2.0** — a 3-layer review pipeline:
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

> **Default = herdar do chat (sem `active-preset.json`)** — sem preset ativo, delegates herdam nativamente o modelo do chat pai. O plugin (`src/plugin.ts` → `resolveActivePreset`) lê `PANTHEON_MODEL_PRESET` env > primeiro `.pantheon/active-preset.json` (project → `~/.config/opencode` → `~/.opencode`) > **`null` (herança nativa)**. `loadRoutingAgentModels` vazio quando `null`; `delegation.ts` omite `model` em `session.create`/`promptAsync` para herança nativa. `small_model` nunca usado.

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

Desde v1.4.2, personalização fina **por agente** sem tocar `opencode.json` top-level nem `.env`:

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

#### Model Value Types (legado → 1.4.2)

| Valor | Antes (≤1.4.1) | Agora (1.4.2) |
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

// Agora (1.4.2) — sem top-level; use /pantheon-model
// no chat OpenCode:
/pantheon-model set --agent apollo --model opencode/mimo-v2.5-free --effort low --scope project
// persiste em .pantheon/active-preset.json:
// { "preset": "go-fast", "overrides": { "agents": { "apollo": { "model": "opencode/mimo-v2.5-free", "variant": "low" } } } }
```

Apollo agora segue o override (se houver) ou preset agente; se nenhum, herda do chat `/model`.

#### Model Priority Chain (1.4.2)

```
1. explicit model em pantheon_delegate({model: "provider/model-id"})
2. overrides.agents[agent].model em active-preset.json (/pantheon-model set --agent)
3. presets.<active>.agents[agent].model  (loadRoutingAgentModels)
4. (ausência) → herança nativa — OpenCode herda modelo da sessão pai (chat)
   — small_model nunca usado para delegates
   — top-level opencode.json model ignorado (removido no install)
```

---

### Model Tiers (legado → 1.4.2 presets)

> **Legado**: tiers `fast`/`default`/`premium` eram abstrações manuais em `opencode.json` (ex.: `gpt-4o-mini`, `gpt-4o`, `o3`). **Em 1.4.2**, tiers são **pinados via 4 presets** (`go-free`/`go-fast`/`go-premium`/`openai`) em [`src/routing.yml`](../../src/routing.yml) — cada agente recebe `model` + `reasoning_effort` concretos. Veja seção **Model Configuration — 4 Presets** acima para tabelas geradas (`node scripts/generate-preset-docs.mjs`). Sem preset, herança nativa do chat pai.

### ACP (Agent Client Protocol)

OpenCode supports the Agent Client Protocol (ACP), allowing it to be used as an AI coding agent from any ACP-compatible editor or IDE (Zed, JetBrains, Neovim with Avante.nvim or CodeCompanion.nvim, etc.).

Start the ACP server:

```bash
opencode acp
```

This starts OpenCode as an ACP-compatible subprocess communicating via JSON-RPC over stdio. All Pantheon features work through ACP: built-in tools, MCP servers, AGENTS.md rules, custom commands, and the agent/permissions system.

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
