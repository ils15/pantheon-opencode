# Pantheon for OpenCode

Complete setup and usage guide for running Pantheon **v1.6.0-beta.18** in [OpenCode](https://opencode.ai) — the open-source AI coding agent for the terminal, desktop, and IDE.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **OpenCode** installed | Follow the [OpenCode installation guide](https://opencode.ai/docs/) or use `npm install -g opencode-ai` |
| **Node.js >=26.4.0** | Required by Pantheon's CLI, installer, and Node-based tooling |
| **Git** | Any recent version |

This package floor does not assert that every OpenCode host uses Node. Official
OpenCode V2.0.31 has a Bun runtime path and a separate Node build pinned to
26.4.0; no Bun minimum is stated. The optional `pantheon_cost` backend's
`node:sqlite` threshold (Node >=22.5) is a separate capability, not package
support.

With npm's default configuration, an incompatible Node version may produce an
`EBADENGINE` warning; Pantheon's postinstall skips Node/config sync, and its CLI
then hard-stops with an explicit version message before setup writes. Use a
user-managed version manager to switch to Node 26.4.0; see the
[installation guide](../INSTALLATION.md) for nvm, fnm, and Volta commands.

---

## Installation

OpenCode is available in three form factors:

| Form Factor | How to Get It |
|---|---|
| **Terminal TUI** | Install script, npm, Homebrew, pacman, scoop, choco, Docker — see [opencode.ai](https://opencode.ai) |
| **Desktop app** | Download from [opencode.ai/download](https://opencode.ai/download) — macOS, Linux, Windows |
| **IDE extension** | Available for VS Code, JetBrains, and Zed |

The installer registers Pantheon's runtime integrations automatically. It writes the singular `plugin` configuration key for OpenCode V1 and converts it to the plural `plugins` key for OpenCode V2; do not add either key manually. The TUI integration is copied to `plugins/pantheon-tui` in the selected OpenCode config directory. V1 uses `tui.json`; V2 loads its native local-plugin `index.ts` + `tui.ts` entrypoints.

The OpenCode-specific installer is the supported setup path:

```bash
npx pantheon-opencode init --project
```

This installs agents, runtime files, MCP servers, and the required OpenCode configuration in the project directory. Run `npx pantheon-opencode init` without `--project` for the global installation.

### Desktop App

Pantheon works seamlessly with the OpenCode Desktop app. Agents, skills, and instructions are discovered from the project directory the same way as in the terminal TUI. Use the Desktop app for a richer UI experience with integrated diffs, file tree browsing, and system notifications.

### Manual Setup

```bash
# Clone the repo
git clone https://github.com/ils15/pantheon.git
cd pantheon

# Copy the OpenCode agents from this checkout into your project
mkdir -p /path/to/your-project/.opencode/agents
cp -r src/agents/. /path/to/your-project/.opencode/agents/

```

Choose exactly one plugin contract before creating the config. In Pantheon
1.5.0, the singular `plugin` key selects the preserved V1 runtime; the
plural `plugins` key with the `<installed>/src/plugin-v2` directory selects the V2
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

Use this V1 registration when you need the V1 BackgroundJobBoard and its
event/tool hooks, or the implemented V1 compaction path. Delegation itself uses
OpenCode's native `task()`. The hooks are not auto-discovered from
`.opencode/plugins/`.

For the V2 adapter, and only when V1 delegate APIs are not expected, copy the
repository's root config as a V2 starting point:

```bash
cp opencode.json /path/to/your-project/opencode.json
```

That file intentionally contains the V2-only registration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["<installed>/src/plugin-v2"]
}
```

`plugin-v2` transforms configuration drafts; it does not provide V1 delegate
tools, hooks, BackgroundJobBoard integration, compaction, or automatic resume.
If you prefer the supported installer, use
`npx pantheon-opencode init --project --opencode-version v1` or `v2` to pin the
generation. `auto` is the default and resolves the generation from the host by
probing its `--version`; see the installer docs for the full precedence order.

### How It Works

The installed OpenCode agents live in `.opencode/agents/` (project) or `~/.config/opencode/agents/` / `~/.opencode/agents/` (global flat layouts). The installer copies the supported agent definitions and configuration into the selected location; there is no separate platform sync step.

### `/init` Command

OpenCode's built-in `/init` command auto-generates an `AGENTS.md` file by scanning your project. It analyzes build commands, test commands, architecture, and conventions, then produces concise project-specific guidance for future agent sessions.

```
/init
```

If an `AGENTS.md` already exists, `/init` improves it in-place rather than replacing it. This is complementary to Pantheon — `/init` captures project-level context while Pantheon agents provide role-specific behavior.

---

## Configuration

OpenCode uses `opencode.json` (or `opencode.jsonc`) in your project root. See the [configuration documentation](https://opencode.ai/docs/config/) for schema validation, then create one with:

```json
{
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

Pantheon registers its plugin in `opencode.json`; the installer never writes
`opencode.jsonc`. The host loads a sibling `opencode.jsonc` from the same config
directory when one exists, and merges it with `opencode.json`: scalars from
`.jsonc` win, and arrays are unioned. A `plugin`/`plugins` entry in `.jsonc`
therefore changes the effective plugin set instead of being ignored. The merge
is silent, so a host can load a plugin that appears only in `.jsonc`.

### Default Agent

The `default_agent` option in `opencode.json` controls which primary agent OpenCode uses when starting a session:

```json
{
  "default_agent": "zeus"
}
```

If not set, OpenCode defaults to the built-in `build` agent. This is useful when Pantheon's Zeus orchestrator should be the primary interaction point.

### Agent permissions

Permissions are declared in **frontmatter** rather than appended as body blocks:

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

OpenCode agents are `.md` files with YAML frontmatter. They live in `.opencode/agents/` (project) or `~/.config/opencode/agents/` / `~/.opencode/agents/` (global). The installer copies the definitions from `src/agents/` into the selected OpenCode location.

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
| Delegation | Native OpenCode `task()`; V1 board lifecycle retained | Native OpenCode V2 `subagent` tool; no Pantheon-specific delegate tool |
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

### TUI Plugin (v1.5.0)

Pantheon v1.5.0 ships a **TUI plugin** for OpenCode that provides:
- **Live deepwork status** — see active phases, progress, and checkpoints
- **Activity feed** — real-time agent delegation events
- **Toast notifications** — phase completion, review results, gate approvals

For a project installation use `npx pantheon-opencode init --project`; for a global flat installation use `npx pantheon-opencode init`. The installer registers the copied TUI plugin in `tui.json` rather than relying on directory auto-discovery.

The panel can follow native OpenCode `task()` children only when OpenCode
provides explicit origin, parent/child and status metadata. A child without
that contract remains a generic child; absence of a Markdown report is not
evidence that it is a native task. Markdown reports in
`.pantheon/delegations/` are historical output from the V1 delegate/board
path, not a V2 task protocol.

Pantheon v1.5.0 includes **Themis 2.0** — a 3-layer review pipeline:
1. **Heuristic Scanner** — zero-LLM static analysis (ruff, biome, anti-pattern detection, hash verification)
2. **Deep Review** — LLM-powered code review with OWASP Top 10, coverage enforcement, and correctness checks
3. **Verification Planning** — structured verification plan with test gap analysis

Run via `/pantheon-audit` with `--light` (layer 1 only), `--full` (layers 1-3), or `--plan` (layer 3 only).

### YAGNI Ladder

Built into every agent's workflow, the **YAGNI Ladder** prevents overengineering:
- **Step 1**: Solve the problem directly (no abstraction)
- **Step 2**: Extract only if duplication appears 3+ times
- **Step 3**: Abstract only when the pattern is proven stable

### Model Configuration — 6 Presets (V1 legacy; gerado de `src/routing.yml`)

> **Estas tabelas são somente o caminho legado V1; não são rotas ativas no V2.** No V1, sem preset ativo, os filhos herdam nativamente o modelo do chat pai. O plugin V1 (`src/plugin.ts` → `resolveActivePreset`) lê `PANTHEON_MODEL_PRESET` env > primeiro `.pantheon/active-preset.json` (project → `~/.config/opencode` → `~/.opencode`) > **`null` (herança nativa)**. `loadRoutingAgentModels` vazio quando `null`; nenhum modelo é imposto aos filhos, então o `task()` nativo herda o modelo do chat pai. `small_model` nunca usado. No V2, markers de preset e `PANTHEON_MODEL_PRESET` são ignorados; o modelo do host permanece intacto sem override manual. Apenas overrides manuais project-scoped `overrides.agents.<agent>.model` e seu `variant` opcional são aplicados no transform do agente; arquivos globais não são lidos nem aplicados. O tool V2 não aceita mutações globais ou flags de autorização na mesma chamada. Suporte global futuro exige autorização humana explícita independente e não é suportado agora. Não há wizard nem seleção implícita. O V1 permanece inalterado até decisão de compatibilidade.

O wizard TTY oferece exatamente **Inherit**, **OpenCode Go**, **OpenAI** e
**Anthropic**. OpenCode Go persiste o ID interno `go-hybrid`; Inherit não grava
um preset. Os legados `go-free`, `go-fast` e `go-premium` permanecem disponíveis
para arquivos salvos e uso explícito. O wizard mostra apenas nomes de variáveis
de ambiente, não lê nem valida chaves e não consulta catálogo/rede.

Tabelas abaixo derivam de [`src/routing.yml`](../../src/routing.yml) (sem hardcodar segredos — apenas nomes de env vars e `baseURL`s). Pricing do OpenCode Go/OpenAI permanece dependente da conta; Anthropic usa o preço da conta/provedor.

#### Presets — resumo (provider / BaseURL / key / pricing / vision)

| Preset | Provider / BaseURL | Key env (nome) | Pricing 2026 | Vision (fallback) | Papéis / Modelos |
|---|---|---|---|---|---|
| `go-free` | `opencode` `https://opencode.ai/zen/v1` (env: `PANTHEON_OPENCODE_API_KEY`) | `PANTHEON_OPENCODE_API_KEY` | Gratuito — Zen free, sem custo, quota limitada, só modelos `-free` | `opencode/mimo-v2.5-free` [low] 👁️ vision | zeus: `opencode/big-pickle` [medium]<br>athena: `opencode/nemotron-3-super-free` [high]<br>themis: `opencode/qwen3.6-plus-free` [high]<br>hermes,aphrodite,demeter,prometheus,hephaestus: `opencode/deepseek-v4-flash-free` [medium]<br>apollo,nyx,gaia,iris,mnemosyne,talos: `opencode/mimo-v2.5-free` [low] |
| `go-fast` | `opencode-go` `https://opencode.ai/zen/go/v1` (env: `PANTHEON_OPENCODE_API_KEY`) | `PANTHEON_OPENCODE_API_KEY` | Baixo custo — Go gateway, baixa latência (kimi-k2.7-code / glm-5.3-flash) | `opencode-go/mimo-v2.5` [low] 👁️ vision | athena: `opencode-go/kimi-k2.7-code` [high]<br>themis: `opencode-go/glm-5.3-flash` [high]<br>zeus: `opencode-go/kimi-k2.7-code` [medium]<br>hermes,prometheus: `opencode-go/deepseek-v4-flash` [medium]<br>aphrodite,hephaestus: `opencode-go/mimo-v2.5` [low]<br>demeter: `opencode-go/gpt-5.6-luna` [low]<br>apollo,nyx,gaia,iris,mnemosyne,talos: `opencode-go/gpt-5.6-luna-fast` [low] |
| `go-premium` | `opencode-go` `https://opencode.ai/zen/go/v1` (env: `PANTHEON_OPENCODE_API_KEY`) | `PANTHEON_OPENCODE_API_KEY` | Premium — Go gateway, melhor qualidade (gpt-5.6-sol / qwen3.8-max / deepseek-v4-pro) | `opencode-go/gpt-5.6-sol` [high] 👁️ vision | zeus: `opencode-go/gpt-5.6-sol` [medium]<br>athena: `opencode-go/deepseek-v4-pro` [high]<br>themis: `opencode-go/qwen3.8-max` [high]<br>hermes,demeter,hephaestus: `opencode-go/gpt-5.6-terra` [medium]<br>aphrodite,prometheus: `opencode-go/kimi-k3` [medium]<br>apollo,nyx,gaia,iris,mnemosyne,talos: `opencode-go/gpt-5.6-luna` [low] |
| `go-hybrid` (visible: OpenCode Go) | `opencode-go` `https://opencode.ai/zen/go/v1` | `PANTHEON_OPENCODE_API_KEY` | Híbrido — premium para Zeus/Athena/Themis/Hephaestus; Go rápido para todos os outros | `opencode-go/gpt-5.6-sol` [high] | Zeus `gpt-5.6-sol`, Athena `deepseek-v4-pro`, Themis `qwen3.8-max`, Hephaestus `gpt-5.6-terra`; demais agentes seguem `go-fast` |
| `openai` | `openai` `https://api.openai.com/v1` (env: `OPENAI_API_KEY`) | `OPENAI_API_KEY` | Pago (OpenAI) — Direto OpenAI, `gpt-5.6` family | `openai/gpt-5.6-sol` [high] 👁️ vision | athena,themis,zeus: `openai/gpt-5.6-sol` [high]<br>hermes,aphrodite,demeter,prometheus,hephaestus: `openai/gpt-5.6-luna` [high]<br>apollo,nyx,gaia,iris,mnemosyne,talos: `openai/gpt-5.6-luna-fast` [low] |
| `anthropic` | `anthropic` `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | Conforme a conta Anthropic | — | Todos os 14 agentes: `anthropic/claude-sonnet-5-5` [medium] |

#### Provider / BaseURL / Key env (nomes, sem valores)

| Preset | Provider | BaseURL | Key env |
|---|---|---|---|
| `go-free` | `opencode` | `https://opencode.ai/zen/v1` | `PANTHEON_OPENCODE_API_KEY` |
| `go-fast` | `opencode-go` | `https://opencode.ai/zen/go/v1` | `PANTHEON_OPENCODE_API_KEY` |
| `go-premium` | `opencode-go` | `https://opencode.ai/zen/go/v1` | `PANTHEON_OPENCODE_API_KEY` |
| `go-hybrid` | `opencode-go` | `https://opencode.ai/zen/go/v1` | `PANTHEON_OPENCODE_API_KEY` |
| `openai` | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |

> `OPENCODE_GO_API_KEY` continua aceito como alias pelo helper de compatibilidade para perfis Go. Nenhum `.env` é escrito; o wizard atual não lê nem valida chaves.

#### Pricing 2026

| Preset | Pricing 2026 | Detalhe | Gateway / Custo |
|---|---|---|---|
| `go-free` | Gratuito | Zen free – sem custo, quota limitada, só modelos `-free` | `opencode` — $0 (free-tier Zen) |
| `go-fast` | Baixo custo | Go gateway – baixa latência, kimi-k2.7-code / glm-5.3-flash | `opencode-go` — Baixo custo, baixa latência |
| `go-premium` | Premium | Go gateway – melhor qualidade, gpt-5.6-sol / qwen3.8-max / deepseek-v4-pro | `opencode-go` — Premium, melhor qualidade |
| `go-hybrid` | Misto | Rotas premium para quatro especialistas e rotas Go rápidas para os demais | `opencode-go` — custos dependem do modelo/conta |
| `openai` | Pago (OpenAI) | Direto OpenAI – https://api.openai.com/v1, gpt-5.6 family | `openai` — Pago por uso |
| `anthropic` | Pago (Anthropic) | `claude-sonnet-5-5` para todos os agentes | `anthropic` — conforme conta/provedor |

*Pricing verificado 2026 via `PRESET_PRICE` + `routing.yml` descrições. Custos reais dependem de conta/assinatura.

#### 14 agentes × 6 presets — modelo + effort + vision

| Agente | `go-free` | `go-fast` | `go-premium` | `go-hybrid` | `openai` | `anthropic` |
|---|---|---|---|---|---|---|
| `zeus` | `opencode/big-pickle` [medium] · | `opencode-go/kimi-k2.7-code` [medium] · | `opencode-go/gpt-5.6-sol` [medium] 👁️ | `opencode-go/gpt-5.6-sol` [medium] 👁️ | `openai/gpt-5.6-sol` [high] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `athena` | `opencode/nemotron-3-super-free` [high] · | `opencode-go/kimi-k2.7-code` [high] · | `opencode-go/deepseek-v4-pro` [high] · | `opencode-go/deepseek-v4-pro` [high] | `openai/gpt-5.6-sol` [high] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `themis` | `opencode/qwen3.6-plus-free` [high] · | `opencode-go/glm-5.3-flash` [high] · | `opencode-go/qwen3.8-max` [high] · | `opencode-go/qwen3.8-max` [high] | `openai/gpt-5.6-sol` [high] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `hermes` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/deepseek-v4-flash` [medium] · | `opencode-go/gpt-5.6-terra` [medium] 👁️ | `opencode-go/deepseek-v4-flash` [medium] | `openai/gpt-5.6-luna` [high] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `aphrodite` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/mimo-v2.5` [low] 👁️ | `opencode-go/kimi-k3` [medium] · | `opencode-go/mimo-v2.5` [low] 👁️ | `openai/gpt-5.6-luna` [high] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `demeter` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/gpt-5.6-luna` [low] 👁️ | `opencode-go/gpt-5.6-terra` [medium] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `openai/gpt-5.6-luna` [high] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `prometheus` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/deepseek-v4-flash` [medium] · | `opencode-go/kimi-k3` [medium] · | `opencode-go/deepseek-v4-flash` [medium] | `openai/gpt-5.6-luna` [high] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `hephaestus` | `opencode/deepseek-v4-flash-free` [medium] · | `opencode-go/mimo-v2.5` [low] 👁️ | `opencode-go/gpt-5.6-terra` [medium] 👁️ | `opencode-go/gpt-5.6-terra` [medium] 👁️ | `openai/gpt-5.6-luna` [high] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `apollo` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `nyx` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `gaia` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `iris` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `mnemosyne` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |
| `talos` | `opencode/mimo-v2.5-free` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `opencode-go/gpt-5.6-luna` [low] 👁️ | `opencode-go/gpt-5.6-luna-fast` [low] 👁️ | `openai/gpt-5.6-luna-fast` [low] 👁️ | `anthropic/claude-sonnet-5-5` [medium] 👁️ |

`·` = text-only, `👁️` = vision (image-input) via `CAPABILITY_TABLE` (`src/pantheon/presets.mjs`). Ex.: `mimo-v2.5*` e `gpt-5.6*` são multimodais; `deepseek*`, `kimi-k2.7-code`, `glm-5.3-flash`, `qwen3.6-plus-free`, `big-pickle`, `nemotron-3-super-free` são text-only.

#### Capability — text-only vs multimodal + esforço máximo

| Prefix | Max Effort | Vision | Strip Effort | Uso nos presets |
|---|---|---|---|---|
| `deepseek/deepseek-v4-pro` | high | — | no | `go-premium` athena |
| `deepseek/deepseek-v4-flash` | medium | — | no | `go-free` implementers, `go-fast` hermes/prometheus |
| `claude` | — | 👁️ | yes | `anthropic/claude-sonnet-5-5` (preset Anthropic) |
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

> **V2:** `pantheon_model` supports only explicit `status`, `show`, `set` and
> `reset` actions; it has no model-route wizard or static preset selection. Only
> `overrides.agents.<agent>.model` and its optional `variant` apply through the
> V2 agent transform. An explicit project override wins for that agent while
> absent project keys keep the host model and variant; global files are neither
> read nor applied. Global mutation is unsupported in this tool; future support
> requires separate explicit human authorization, not flags in the same call.
> File `preset` markers and `PANTHEON_MODEL_PRESET` are ignored and are never
> deleted.

The interactive route wizard and preset resolution described below are **V1
legacy only**. They do not describe V2 behavior.

Desde v1.5.0, personalização fina **por agente** sem tocar `opencode.json` top-level nem `.env`:

```bash
# V1 legacy only: wizard interativo (agente → modelo → effort → scope)
/pantheon-model
# status — 14 agentes com modelo/effort/origem (preset|override|env|none), sem segredos
/pantheon-model status   # alias: show
# set por agente — validação CAPABILITY_TABLE + clamp + hasVision warning
/pantheon-model set --agent hermes --model opencode-go/gpt-5.6-terra --effort medium --scope project
/pantheon-model set --agent apollo --model opencode/mimo-v2.5-free --effort low
/pantheon-model reset --agent hermes --scope project
```

No V2, use somente chamadas explícitas, por exemplo:

```text
pantheon_model(action="status")
pantheon_model(action="set", agent="hermes", model="openai/gpt-5.6", effort="medium", scope="project")
pantheon_model(action="reset", agent="hermes", scope="project")
```

- Valida `agent ∈ {zeus, athena, apollo, hermes, aphrodite, demeter, themis, prometheus, hephaestus, nyx, gaia, iris, mnemosyne, talos}`.
- Valida `provider/model-id` via `MODEL_REF_PATTERN` e `capabilityEntry(model)` (sem entrada → erro); clampa `effort` via `normalizeCapability`; avisa se `hasVision(model)===false` para uso multimodal.
- No fluxo legado V1, persiste em `.pantheon/active-preset.json` em `overrides.agents[agent].model` + `variant` (mapeado para `reasoning_effort` no merge) — escrita atômica `tmp`+`rename` com `.bak` + lock por path + `O_NOFOLLOW` + health-check. Default scope `project`; no V1, `global` exige `confirm`+`authorize_global`.
- No V1, nunca escreve `.env` nem injeta `model`/`small_model` global — herança nativa segue: `explicit model` > `overrides.agents` > `preset agents` > nativo. Essa cadeia não descreve o V2, que ignora presets e arquivos globais.

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
1. overrides.agents[agent].model em active-preset.json (/pantheon-model set --agent)
2. presets.<active>.agents[agent].model  (loadRoutingAgentModels)
3. (ausência) → herança nativa — OpenCode herda modelo da sessão pai (chat)
   — small_model nunca usado
   — top-level opencode.json model ignorado (removido no install)
```

This priority chain is V1 model resolution for native `task()` children. It is
not a V2 `plugin-v2` API or a promise about OpenCode `task()` model selection.

---

### Model Tiers (legado → 1.5.0 presets)

> **Legado superseded**: tiers `fast`/`default`/`premium` eram abstrações manuais em `opencode.json` (ex.: `gpt-4o-mini`, `gpt-4o`, `o3`). No V1, os seis perfis de `src/routing.yml` pinam `model` + `reasoning_effort` por agente. Veja **Model Configuration — 6 Presets** acima. Sem preset, a herança nativa documentada aplica-se à delegação V1; o V2 adapter não registra essa API.

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

OpenCode offers a customizable TUI with built-in themes (tokyonight, catppuccin, gruvbox, nord, etc.) and custom themes. See the [TUI documentation](https://opencode.ai/docs/tui/) and configure via `tui.json`:

```json
{
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

Example generation script:
```bash
#!/bin/bash
# Generate dynamic prompts
AGENTS=$(ls .opencode/agents/ | sed 's/.md//' | paste -sd ', ' -)

sed -e "s/{{agents}}/$AGENTS/g" \
    prompts/templates/council-template.txt \
    > prompts/dynamic/council-generated.txt
```

### Limitations

- Not true runtime generation (generated at plan-switch time)
- Requires manual regeneration when agents change
- OpenCode-specific (OpenCode supports `{file:...}`)

---

[Main Documentation](../../README.md)
