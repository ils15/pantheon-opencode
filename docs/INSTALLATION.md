# Pantheon Installation Guide — v1.6.0-beta.17 (OpenCode 2)

Pantheon v1.6.0-beta.17 é **compatível com OpenCode 2**. `npx pantheon-opencode init` instala a geração selecionada. O seletor interativo V1 oferece **Inherit**, **OpenCode Go**, **OpenAI** e **Anthropic**; ele pergunta o escopo de gravação apenas para um perfil salvo e não é uma rota de modelo V2. No V2, `pantheon_model` oferece somente `status`, `show`, `set` e `reset` manuais, sem wizard de presets: o default do host fica intacto sem override explícito por agente; markers `preset` e `PANTHEON_MODEL_PRESET` são ignorados e preservados. Herança nativa para delegates: sem preset, os filhos herdam o modelo do chat pai no caminho V1. As tabelas dos presets abaixo são referência V1 legada e derivadas de `src/routing.yml` (sem hardcodar segredos: só nomes de variáveis e `baseURL`s).

## TL;DR (Quick Start)

```bash
# Instalar agentes Pantheon globalmente (a seleção de presets é V1 legacy)
npx pantheon-opencode init

# Headless (CI/scripts, usa defaults) — apply não-interativo exige --yes
npx pantheon-opencode init --headless --yes

# (Opcional) Servidores MCP + skills + plugin TUI
npm run setup

# Verificar instalação
npm run doctor
```

- Requisitos: **Node.js >=26.4.0** para a CLI/instalador/ferramentas Node do Pantheon, **OpenCode v1.18.4+**, **Python 3.11+** (opcional, MCP servers). Node 22, Node 24 e Node 26.0–26.3 não são compatíveis com Beta 13.
- Com a configuração padrão do npm, versões incompatíveis podem gerar `EBADENGINE` como aviso durante a instalação. O postinstall do Pantheon então pula a sincronização Node/config e permite que o pacote termine de instalar; a CLI bloqueia a configuração com uma mensagem explícita antes de gravar arquivos. `engine-strict=true` pode fazer o próprio npm interromper a instalação. Para atualizar sem instalação global/system-wide, use um gerenciador de Node do usuário:

  ```bash
  nvm install 26.4.0 && nvm use 26.4.0
  # ou: fnm install 26.4.0 && fnm use 26.4.0
  # ou: volta install node@26.4.0
  ```
- Isso não pressupõe um runtime Node universal para o host OpenCode: o OpenCode V2.0.31 oficial tem um caminho de runtime Bun e um build Node separado fixado em Node 26.4.0; nenhum mínimo de Bun é declarado. `node:sqlite` >=22.5 é apenas um limite de capacidade do backend opcional `pantheon_cost`, não o requisito de suporte do pacote.
- No resumo de uma configuração interativa em TTY, o instalador recomenda um local persistente externo para futuros worktrees: `<project-parent>/.pantheon-worktrees/<exact-repository-directory-basename>/<task>` (por exemplo, `/home/user/.pantheon-worktrees/My Project/feature-name`). Use o nome exato do diretório do projeto, incluindo espaços; não o normalize como slug. A recomendação é apenas orientação para agentes; o Pantheon não cria worktrees Git nem diretórios automaticamente.
- A configuração interativa em TTY usa prompts Clack para selecionar componentes, escolher instalação global/projeto e confirmar a revisão antes de aplicar. Cancelar não altera a configuração. `--yes`, `--headless`, `--dry-run` e os caminhos sem TTY mantêm seus comportamentos.
- Delegação e modo background dependem das ferramentas expostas pela versão/runtime do host. Na sessão Beta 10 reportada, Zeus tinha a ferramenta `subagent`, sem `task_status`/`cancel_task` ou garantia de acompanhamento/recuperação. Verifique o schema e a documentação do runtime; não presuma que `task()` ou background estejam disponíveis. A variável experimental abaixo só se aplica a hosts/versões que a documentem.
- Passo a passo de 5 minutos: [QUICKSTART.md](QUICKSTART.md).

## Revisão, autorização e recuperação do instalador

`init --dry-run` mostra as operações de arquivos gerenciados sem aplicá-las. Para
revisar em uma execução e autorizar em outra, salve um plano versionado:

```bash
# Preview legível ou JSON (somente no stdout)
npx pantheon-opencode init --project --no-mcp --components agents --dry-run
npx pantheon-opencode init --project --no-mcp --components agents --dry-run --json

# Salvar e aplicar o plano revisado; sem --yes, uma sessão TTY pergunta
npx pantheon-opencode init --project --no-mcp --components agents --dry-run \
  --save-plan .pantheon-install-plan.json
npx pantheon-opencode init --apply-plan .pantheon-install-plan.json --yes
```

O artefato é JSON versionado, gravado atomicamente com permissões `0600`; guarda
identidades, opções, snapshots/fingerprints e operações, não o conteúdo dos
arquivos gerados. Ele fica vinculado ao caminho original do artefato, ao alvo e
à identidade do pacote. Na aplicação, o instalador recalcula o plano e compara a
origem e os destinos; se houver drift, aborta antes de escrever (código de saída
`3`). `--apply-plan` aceita somente o caminho do plano e autorização (`--yes`/
`-y` ou prompt TTY). Planos salvos com `--force`/`--clean` não são suportados.

Para manter o preview livre de efeitos colaterais no host, `--dry-run` não
executa `opencode --version`: sem um hint de versão configurado, assume V1 e
informa isso como advisory. Use `--opencode-version v1` ou
`--opencode-version v2` para selecionar a geração do preview e do plano salvo.
O plano descreve operações de
arquivos gerenciados; não representa integralmente efeitos em lote ou externos,
como criar/atualizar um ambiente Python. `postinstall`/`sync-tui` também fica
fora do fluxo de aprovação do `init` e pode atualizar artefatos TUI sem prompt.
Não trate o preview como transação nem como promessa de rollback automático.

Antes das primeiras gravações gerenciadas, `init` cria um backup exato em
`.pantheon/backups/<timestamp>/` (diretório `0700`, arquivos `0600`, retenção das
5 cópias mais recentes). Como o backup é byte a byte, pode conter credenciais já
presentes nos arquivos; não o compartilhe. Para recuperar, use
`npx pantheon-opencode restore [--project] [--yes]`. Uma falha/interrupção pode
deixar alterações parciais; a recuperação é manual pelo comando `restore`, não
um rollback automático.

### Remoção e purge

O desinstalador também pode ser revisado antes de aplicar:

```bash
npx pantheon-opencode uninstall --project --dry-run
npx pantheon-opencode uninstall --project --force
```

Sem `--force`, a aplicação pede confirmação em TTY e falha fechada em ambiente
não interativo. O desinstalador remove apenas itens identificados como do
Pantheon, preserva symlinks e cria backup dos arquivos regulares que serão
alterados/removidos; os backups não são apagados pelo uninstall. `--purge-data`
é mais restrito: só permite remover `.pantheon/install-state.json` quando for um
arquivo regular e um estado schema-v2 verificável. Não é uma limpeza geral de
`.pantheon` nem remove os backups. Primeiro revise com `--dry-run`; para aplicar
purge em modo não interativo, combine `--purge-data --force`.

### Revisar drift de arquivos instalados

Instalações novas mantêm um inventário versionado por arquivo regular gerenciado
(caminho relativo exato, componente/layout, hash e modo; nenhum conteúdo é salvo).
Use `reconcile` para identificar arquivos que saíram da fonte atual e permanecem
idênticos à última gravação do instalador:

```bash
# Preview somente leitura; selecione --global ou --target PATH quando apropriado
npx pantheon-opencode reconcile --project --dry-run
npx pantheon-opencode reconcile --project --dry-run --components agents,skills
npx pantheon-opencode reconcile --global --target /caminho/config-opencode --dry-run
npx pantheon-opencode reconcile --target /caminho/projeto --dry-run

# Plano revisável, aplicado em outra chamada com autorização explícita
npx pantheon-opencode reconcile --project --components agents --save-plan .pantheon-reconcile.json
npx pantheon-opencode reconcile --apply-plan .pantheon-reconcile.json --yes

# Alternativa: revisar e aplicar na mesma chamada
npx pantheon-opencode reconcile --project --apply --yes
```

O preview não grava nem remove arquivos. A aplicação revalida o inventário, os
hashes e o conjunto exato de operações; qualquer drift cancela antes da remoção.
Antes de apagar, cria um backup restaurável em `.pantheon/backups/`; use
`pantheon-opencode restore` para recuperar. Somente arquivos regulares e exatos
são removidos — diretórios nunca são apagados recursivamente. Componentes não
selecionados permanecem fora da reconciliação.

Estados v1/v2 e instalações anteriores ao inventário migram para uma lista vazia:
seus arquivos existentes são desconhecidos/ambíguos e nunca são inferidos como
propriedade do Pantheon nem removidos automaticamente. Arquivos alterados,
ausentes, symlinks, caminhos inválidos ou layouts incompatíveis também são
preservados. `doctor` diferencia arquivos previamente gerenciados que foram
modificados ou desapareceram; quando o payload atual não está disponível, informa
que só verificou o hash registrado. `reconcile` aceita `--project`, `--global` ou
`--target PATH`; um alvo explícito usa o layout de projeto por padrão. Combine
`--global --target PATH` para indicar que um alvo global explícito usa o layout
global plano. Essa escolha não é inferida nem reinterpretada pelo caminho. Sem
inventário legível, não há limpeza automática.

## Prerequisites

- **OpenCode v1.18.4+** — [Install OpenCode](https://opencode.ai/docs/)
- **Node.js >=26.4.0** — for `npx pantheon-opencode init` and Node-based Pantheon tooling (`engines.node` = `>=26.4.0`). Node 22, Node 24, and Node 26.0–26.3 are unsupported. The optional `pantheon_cost` backend separately needs `node:sqlite` (Node >=22.5); this capability threshold does not lower package support. Official OpenCode V2.0.31 has a Bun runtime path and a separate Node build pinned to 26.4.0; no Bun minimum is implied.
- **Python 3.11+** — for MCP servers (optional, used by `npm run setup`)
- **Git** — for version detection in TUI sidebar

## Package and dependency contract

The TUI plugin is a **root workspace**. `package.json` declares
`"workspaces": ["src/plugins/tui"]`, and the root `package-lock.json` carries a
`link: true` entry for `node_modules/pantheon-tui` resolving to
`src/plugins/tui`. A single `npm ci --ignore-scripts` at the root installs the
root project **and** the TUI subpackage; there is no second install step, and
`npm ci --prefix src/plugins/tui` is no longer part of any workflow.

For a checkout validation:

```bash
npm ci --ignore-scripts
```

`npm ci` is the only accepted path: there is no fallback to `npm install`, and
`PANTHEON_ALLOW_NPM_INSTALL_FALLBACK` is not a supported escape hatch. The
post-install TUI sync likewise propagates a failing `npm ci`; it does not
silently repair or rewrite a lockfile.

### The nested TUI lockfile is still shipped, and still load-bearing

Two lockfiles exist and both are committed, but they now serve **different**
consumers, which is worth being explicit about:

- **root `package-lock.json`** — what the workspace install and CI use.
- **`src/plugins/tui/package-lock.json`** — a *published artifact*. It is
  copied by `scripts/sync-tui.mjs` into the user's live plugin dir, where
  `npm ci --omit=dev` runs against **it**, not the root one. A manifest/lock
  divergence there makes every end user's `npm install pantheon-opencode`
  hard-fail inside `postinstall`.

That second lock can no longer be regenerated in place: under a `workspaces`
parent, `npm install --package-lock-only` in the member directory reports "up
to date" and folds the change into the root lock instead, and neither
`--workspaces=false` nor `--ignore-workspace-root-check` changes that. Hand
applying the same version to both files is valid **only for a version change on
a dependency already present in the lock's tree**; adding or removing one
requires generating the lock in an isolated directory (no workspace parent)
and copying it back — and that regeneration re-resolves the entire transitive
tree, so its diff must be reviewed. `tests/tui-workspace-lock.test.mjs` is the
gate that catches a drift in either direction.

### Why `overrides: { "rolldown": "1.2.7" }` exists

`tsdown@0.23.0` requires `rolldown: "~1.2.7"`. The exact `1.2.7` override
satisfies that range and keeps the workspace and standalone TUI installs on
the same bundler, whose minifier output is part of the committed bundle. Pinning
tsdown alone does not pin its dependency; a direct `devDependency` would not
hold either because Node resolution can prefer a nearer nested copy. The root
and standalone TUI overrides both enforce the same version. tsdown 0.23.0's
engine range (`^22.18.0 || ^24.11.0 || >=26.0.0`) includes the project's
declared Node support floor (`>=26.4.0`).

Two consequences a maintainer must know before touching it:

- `overrides` **bypasses** range validation rather than erroring, so it can
  silently contradict a dependent's declared range. `tests/tui-workspace-lock.test.mjs`
  asserts the override against `tsdown`'s declared range and that the root lock
  resolves exactly one `rolldown`; CI additionally asserts the installed
  version is exactly `1.2.7`.
- Changing it can alter minifier output and break the `TUI dist freshness`
  gate. Update both overrides, regenerate both locks, rebuild `dist`, and
  review the generated diff together.

### TUI production security overrides

The root and standalone TUI manifests override `@babel/core` to `7.29.7`
(security floor `>=7.29.6`) and `seroval` to `1.6.8` (security floor
`>=1.6.3`). The affected packages are reachable from the shipped TUI runtime;
these pins clear the audited production advisories while upstream
`@opentui/solid@0.5.10` still pins Babel `7.28.0` and Solid `1.9.12`.

`seroval@1.6.8` is outside Solid `1.9.12`'s declared `~1.5.0` range. Keep
`solid-js` pinned to the exact `1.9.12` peer required by OpenTUI rather than
allowing a workspace copy of `1.9.15`; `tests/tui-workspace-lock.test.mjs`
checks both lock trees and exercises the Seroval serializer API used by
Solid's server renderer. Run that regression, both clean install paths, and
the production audit before changing these overrides. Remove them only when
upstream dependency ranges accept patched releases and the production audit
remains clear without them.

## Coverage reporting

`npm run coverage` runs `test:node` under Node's built-in
`--experimental-test-coverage` and prints line/branch/function coverage for the
`.mjs`/`.js` modules under `scripts/`, `src/` and `bin/`. It adds **no**
dependencies and enforces **no** threshold — the repository has no established
coverage floor, so a percentage gate would fail immediately on pre-existing
untested code and block unrelated work. The number is a baseline to improve
against, not a gate.

What it does **not** cover: `test:ts` is a hand-rolled `tsx` loop with no
`node --test` runner, so the 41 TypeScript files under `src/` and `bin/` are
entirely unmeasured by this command; `test:ci` is pytest and reports no
JavaScript coverage at all. Python coverage additionally requires
`pytest-cov`, which is not declared in any requirements file — see
`src/mcp/requirements-mcp.txt`.

## OpenCode V1/V2 — contrato de plugin

### Support boundary — 1.6.x is the last OpenCode 1.X line

> **OpenCode 1.X support ends after the 1.6 line.** From 1.7 onward every
> release is a breaking change targeting OpenCode 2. Read this before
> installing or upgrading across the 1.6 → 1.7 boundary.

| Pantheon line | OpenCode 1.X host | OpenCode 2 host |
|---|---|---|
| **1.6.x** | **Supported** — V1 contract, selected automatically | Supported with a reduced surface — V2 contract |
| **1.7 and later** | **Not supported** — breaking change | Target of the 1.7+ work |

The two 1.6.x cells are different claims. The 1.X cell is the V1 plugin
(`src/plugin.ts` + `src/plugins/pantheon-hooks.ts` under the singular `plugin`
key, 6 tools including the goal tools, board lifecycle, V1 hooks and the V1
compaction path). The OpenCode 2 cell is the V2 plugin, which is a real
orchestration surface and a **narrower** one: 3 unconditional tools plus up to
2 host-dependent ones, no goal tools, no V1
caller→target delegation matrix. Neither generation is ever registered together
with the other.

**OpenCode 2 support on the 1.6 line is real but partial — do not read the
table as "OpenCode 2 is done":**

- The V2 tool surface ships real `input`/`output` schemas and real enforcement
  (`ctx.tool.transform()`, a read-only-enforcing `execute.before`), verified
  against `opencode 2.0.22` by `tests/canary/plugin-v2-tool-canary.test.mjs`.
- That host version is **not published on any npm channel**. Against the
  installable `@opencode-ai/cli` the same canary fails 12/12, because
  `/api/experimental/session/{id}/wait` was promoted to
  `/api/session/{id}/wait` (old path → 404) and `ctx.tool.list` is absent. With
  only the route corrected, 10/12 pass on that host — so this is a
  canary/host-generation mismatch, not a measured plugin regression. Tracked in
  issue #216; the fail-closed CI step is PR #213.
- **No V1 host leg exists for end-to-end validation.** The sandbox runner
  (`scripts/test-opencode-v2-sandbox.sh`) is V2-only and rejects `--run v1`. The
  exact 1.X host version the 1.6 line is exercised against end-to-end is
  therefore **unverified**; the 1.X path is covered by the dependency pin
  (`@opencode-ai/plugin` / `@opencode-ai/sdk` `1.18.33`), the generation-gate
  unit tests and the installer end-to-end tests over emitted config.

The full policy, including the verification table, is in the
[README compatibility section](../README.md#compatibility-and-support-policy).

### Escolha de geração

Pantheon 1.6.0-beta.1 does not load both Pantheon plugin generations in one
installation. The ordinary OpenCode settings may be merged, but the installer
removes Pantheon references from both config shapes before registering only the
selected generation:

| Selection | OpenCode key | Pantheon registration | Contract |
|---|---|---|---|
| `v1` | singular `plugin` | `src/plugin.ts` and `src/plugins/pantheon-hooks.ts` | Pantheon V1 plugin: `hashline_edit` + goal/cost/model tools, board lifecycle, V1 events/tool hooks and V1 compaction path |
| `v2` | plural `plugins` | `<installed>/src/plugin-v2` directory (`index.ts` re-exports `src/plugin-v2.ts`) | Full V2 plugin: 3 unconditional tools (`hashline_edit`, `pantheon_cost`, `pantheon_model`) plus up to 2 host-dependent ones (`vision_describe` when the host exposes its model catalog, `pantheon_bounded_read` when the host exposes its permission and session APIs), 5 event subscriptions, session hooks, a read-only-enforcing tool `execute.before` hook, plus configuration transforms |

The V2 plugin is now a **full orchestration plugin** — not just a configuration
adapter. It registers 3 unconditional tools via `ctx.tool.transform()` plus up
to 2 host-dependent ones — `vision_describe` when the host exposes its model
catalog, and `pantheon_bounded_read` when the host exposes its permission and
session APIs (root Zeus sessions only) — subscribes to 5
session lifecycle events, and wires session hooks plus a tool `execute.before`
hook that enforces read-only sessions (`apollo`/`gaia` are denied `edit`,
`write`, `bash`, `task`, `hashline_edit` and `pantheon_model`). The 3 goal
tools are
not registered on V2 because the goal loop requires V1 infrastructure the V2
context does not expose; `getUnsupportedFeatures()` reports this as
`goal-tools`. The host-native child-session API (called `task()` in hosts that
expose that API) is not a V2 Pantheon delegate API. Do not add the V1 plugin
beside `plugin-v2` to try to restore V1-specific features: that is an
unsupported mixed registration.

Choose the target explicitly when needed:

```bash
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2
npx pantheon-opencode init --opencode-version auto
```

`auto` is the default, so the flag is only needed to override it.
`--version v1|v2` remains accepted after `init` as the legacy spelling.
`auto` reads the generation from the host: `OPENCODE_VERSION=v1|v2` wins;
otherwise an `OPENCODE_BIN` path ending in `opencode2` selects V2; otherwise
the host binary is asked for its `--version` and a major of 2 or more selects
V2. Any other case — an unreadable probe, an unparseable banner, or
contradictory version tokens with no tool name to break the tie — warns once
and selects V1. It never installs both Pantheon plugin generations. Third-party
plugin entries are retained as third-party entries and are not converted by
this selection.

### Config nativo V2

O installer V2 grava campos nativos V2 em vez de shims V1:

- `providers` — configuração de provedores de modelo (formato V2 nativo)
- `permissions` — array de regras de permissão de tools (formato V2 nativo)
- `mcp.servers` — registro de servidores MCP (formato V2 nativo)

Exemplo de `opencode.json` V2:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["<installed>/src/plugin-v2"],
  "providers": {
    "opencode": {
      "baseURL": "https://opencode.ai/zen/v1"
    }
  },
  "permissions": [
    {
      "tool": "task",
      "allow": ["zeus", "athena"]
    }
  ],
  "mcp": {
    "servers": {
      "pantheon-memory": { "command": "python", "args": ["-m", "pantheon.mcp.memory"] },
      "pantheon-persistence": { "command": "python", "args": ["-m", "pantheon.mcp.persistence"] }
    }
  }
}
```

Contrato: a entrada V2 do servidor é o diretório `<installed>/src/plugin-v2` (cujo `index.ts` re-exporta `src/plugin-v2.ts`). O TUI é um componente separado: V1 usa `tui.json`; V2 descobre `index.ts` + `tui.ts` no diretório local e usa `@opencode/plugin/tui`.

Diferenças do V1:

| Aspecto | V1 | V2 |
|---|---|---|
| Plugin registration | singular `plugin` | plural `plugins` |
| Config shape | `plugin` array | `plugins` array + `providers` + `permissions` |
| MCP servers | Via `scripts/hooks/` | Via `mcp.servers` nativo |
| Tools | Via V1 tool hook API | Via `ctx.tool.transform()` |
| Events | Via V1 event hook API | Via `ctx.event.subscribe()` |

The TUI plugin is a separate component. Its host-specific entry is installed
only when the installer component set includes `plugins`; the presence of the
V2 TUI entry does not imply the V1 runtime was loaded.

## Interactive Model Setup (V1 legacy routing)

This model selector applies to the legacy V1 preset path only. V2 ignores static
presets and `PANTHEON_MODEL_PRESET`; use `pantheon_model` for explicit
per-agent overrides. In V1, **Inherit** is the default and writes no
`active-preset.json`, so delegates keep the parent chat model.

The TTY wizard uses `@clack/prompts` and offers exactly these choices:

| Visible choice | Saved preset | Provider / model | Environment variable |
|---|---|---|---|
| Inherit | none | Current chat model | — |
| OpenCode Go | `go-hybrid` | OpenCode Go; premium routes for Zeus, Athena, Themis, and Hephaestus; existing Go-fast routes for all others, including Demeter | `PANTHEON_OPENCODE_API_KEY` |
| OpenAI | `openai` | OpenAI profile | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `anthropic/claude-sonnet-5-5` for every agent | `ANTHROPIC_API_KEY` |

For a saved profile, the wizard asks whether to save project-local or global;
**Inherit** skips that question and writes no active preset. It reports the
required environment-variable **name only**: it does not read or validate API
keys, print secret values, write `.env`, or contact a provider/catalog. Configure
the appropriate key in the environment yourself before using a paid profile.

The internal `go-free`, `go-fast`, and `go-premium` definitions are unchanged
for old saved profiles and explicit CLI use, for example
`pantheon-opencode init --preset go-fast`. The selected profile is persisted
atomically via `writeActivePreset()` with backup and JSON health-check.

```bash
# Interativo padrão (TTY → wizard; pipe → plano, exige --yes para aplicar)
npx pantheon-opencode init

# Forçar o fluxo interativo quando houver um TTY
npx pantheon-opencode init --interactive

# Pular o seletor e ativar um preset explicitamente (V1)
npx pantheon-opencode init --preset go-hybrid
npx pantheon-opencode init --preset anthropic --project
npx pantheon-opencode init --preset go-fast
npx pantheon-opencode init --preset openai --project

# Headless (sem perguntas, usa defaults; exige --yes para aplicar)
npx pantheon-opencode init --headless --yes
npx pantheon-opencode init --headless --yes --no-mcp  # sem Python/MCPs
```

> Tabelas acima refletem `src/routing.yml` + `PRESET_PRICE` + `CAPABILITY_TABLE`.

### Vision (opcional) — prompt pós-wizard

Após o wizard, uma sessão **TTY interativa** oferece um passo opcional de vision
(`scripts/install/vision-prompt.mjs`), com três opções:

1. **Descoberta automática** (default, Enter) — não grava nada; o modelo é resolvido no início da sessão (catálogo do host).
2. **Pinar provider/modelo** — pede `provider/model` (ex. `opencode-go/mimo-v2.5`), valida o formato e grava `visionModel` no config **global** `~/.config/opencode/opencode-vision.json` via **merge** (chaves existentes preservadas; gravação atômica com `.bak`; diretório criado se faltar).
3. **Pular** — não grava nada.

Fluxos **não-interativos** (`--yes`, `--headless`, pipe/CI, sandbox automatizado)
**nunca** perguntam e nunca gravam config de vision: a descoberta automática
continua sendo o default em qualquer fluxo não-interativo. O passo não usa
tokens/segredos e nunca exibe credenciais. O comando `/pantheon-vision` mostra o
alvo resolvido + origem (env / config / preset / descoberta / default).

O comando também traz um **picker de modelos**: `node scripts/vision-status.mjs
--list` enumera os candidatos image-capable (fonte marcada como `host catalog`
quando o catálogo ao vivo está acessível, ou `heuristic` a partir de
`opencode models`), com `free`/`paid` e **presença de credencial** por provider
(sem nunca exibir o token); o usuário escolhe por número e o comando aplica via
`node scripts/vision-status.mjs --set <provider/model> [--global|--project]`,
que grava `visionModel` com o mesmo merge atômico do prompt de init.

## Quick Install

```bash
# 1. Install Pantheon agents globally
npx pantheon-opencode init --headless --yes

# 2. (Optional) Install MCP servers + skills + TUI plugin
npm run setup

# 3. Launch OpenCode
opencode
```

Only if the active OpenCode version/runtime documents support for and requires
the experimental background setting, set it before launch (for example, in
`~/.zshrc` or `~/.bashrc`):

```bash
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
opencode
```

This variable is not a general prerequisite and does not guarantee a background
dispatch tool, status/cancel tools, completion tracking, or recovery.

## Install Modes

| Mode | Command | Installs | Time | Dependencies |
|------|---------|----------|------|-------------|
| **Interactive** 🎯 | `npx pantheon-opencode init` (default TTY) | seletor visual de componentes | ~variavel | Node.js >=26.4.0 |
| **Minimal** 🟢 | `npx pantheon-opencode init --headless --yes --no-mcp` | agents + commands | ~2s | None |
| **Full** 🔵 | `npx pantheon-opencode init --headless --yes` | agents + MCPs + skills + TUI | ~60s | Python 3.11+ |
| **Runtime** 🟡 | `npm run setup` | MCP servers + venv | ~30s | Python 3.11+ |

```bash
# Minimal — just the agent rules, no Python dependencies (non-interactive)
npx pantheon-opencode init --headless --yes --no-mcp

# Full setup — agents + MCP servers (memory, persistence, resources, vision)
npx pantheon-opencode init --headless --yes

# Add MCP servers to an existing minimal install
npm run setup
```

## Global vs Project-Local

By default, `npx pantheon-opencode init` installs agents **globally** to `~/.config/opencode/agents/`. This makes Pantheon available in all your projects.

For project-local installation (e.g., team-shared config):

```bash
npx pantheon-opencode init --project
```

This installs to `.opencode/agents/` in the current project directory.

## Herança Nativa — sem `active-preset.json` (default)

No caminho de instalação V1 desde **v1.5.0**, o instalador **não cria** `model`/`small_model` top-level em `opencode.json` e o seletor **não grava** `active-preset.json` quando o usuário escolhe **Inherit** (default). O fluxo V2 não ativa presets. Comportamento V1:

- **Sem preset = herança nativa**: `resolveActivePreset()` retorna `null`; `loadRoutingAgentModels()` retorna `{}`; nenhum modelo é imposto aos filhos — o dispatch nativo do host (por exemplo, `task()` onde exposto) herda o modelo do chat pai conforme a semântica desse host. `small_model` nunca é usado.
- **Ordem de resolução do modelo filho** (fontes sem hardcode de segredos, só nomes):
  1. override per-agent em `.pantheon/active-preset.json` (via `/pantheon-model set --agent`)
  2. `presets.<active>.agents[agent].model` (via `loadRoutingAgentModels`)
  3. omitir → herança nativa (herda modelo atual da sessão pai)
- O instalador **remove** `model`/`small_model` antigos de `config.agent[agentName]` durante `installOpencode()` (limpeza de legado), preservando apenas campos gerenciados (`MANAGED_FIELDS`). Flags `--model`/`--small-model` ainda existem para override explícito, mas **não são necessárias** para o fluxo padrão; se usadas, validam `provider/model-id` via `MODEL_REF_PATTERN` e nunca tocam o outro campo.
- Provider/model disponibilidade **não** é inferida da string: deve existir no OpenCode e via conta/assinatura/endpoint configurado (`PANTHEON_OPENCODE_API_KEY` para `opencode`/`opencode-go`, `OPENAI_API_KEY` para `openai`, `ANTHROPIC_API_KEY` para `anthropic`). O seletor só informa o nome da variável; não lê nem valida chaves.

```bash
# Default (recomendado) — herda do chat, sem preset ativo
npx pantheon-opencode init            # Inherit → sem active-preset.json
opencode
# /model opencode-go/gpt-5.6-sol  (no chat) → delegates herdam automaticamente

# Com preset (quando precisa de pinagem por agente)
npx pantheon-opencode init --preset go-fast
# ou interativo: OpenCode Go/OpenAI/Anthropic → scope → grava active-preset.json

# Override explícito pontual (sem preset, ou sobre preset)
# via comando Pantheon (ver próxima seção) — nunca via top-level opencode.json
```

> **Nota:** A validação de `provider/model-id` usa `MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/` (em `src/pantheon/model-command.ts`, hint sem expor segredos). Model inválido → erro `model must use provider/model-id format`.

## `/pantheon-model` — Per-agent Overrides em `active-preset.json` (V1 legacy)

> Os comandos `/pantheon-model` e o wizard abaixo são o caminho legado V1. V2
> expõe a ferramenta `pantheon_model` com ações explícitas `status`, `show`,
> `set` e `reset`, sem wizard de rotas ou presets. No V2, só overrides manuais
> project-scoped por agente são aplicados; arquivos globais não são lidos nem
> aplicados. `set`/`reset` rejeitam `scope=global` e flags `confirm`/
> `authorize_global`; a mesma chamada não é aprovação humana independente. O
> suporte global futuro exigirá autorização explícita separada e não é suportado
> nesta ferramenta. Markers `preset` e `PANTHEON_MODEL_PRESET` são ignorados,
> não removidos, e o default do host fica intacto sem override.
> Ambos os caminhos gravam overrides em `active-preset.json` e nunca escrevem
> `.env` nem injetam `model`/`small_model` top-level em `opencode.json`.

No V1, a delegação usa herança nativa (sem modelo → herda chat/preset); o
caminho V2 não registra a API de delegação V1.

O comando V1 é determinístico (`src/pantheon/model-command.ts`) — leitura/escrita local sem resolver providers externos, backup `.bak` + rename atômico + `O_NOFOLLOW` + lock por path. No V1, escopo default `project`; `global` exige `confirm` + `authorize_global` separados (`-y` não basta). A ferramenta V2 aceita apenas `project` e rejeita flags de autorização.

```text
# status — lista 14 agentes canônicos com modelo/effort/origem (preset|override|env|none), sem segredos
/pantheon-model status          # alias: show

# V1 legacy only: wizard interativo (sem args) — via askQuestions:
/pantheon-model                 # agente → modelo (provider/model-id) → effort (low/medium/high) → scope (project|global)
/pantheon-model                 # valida agente ∈ {zeus, athena, apollo, hermes, aphrodite, demeter, themis, prometheus, hephaestus, nyx, gaia, iris, mnemosyne, talos}
                               # valida modelo via CAPABILITY_TABLE capabilityEntry() + clamp via normalizeCapability()
                               # avisa via hasVision() se modelo for text-only but solicitado para visão

# set per-agent (persiste em overrides.agents[agent])
/pantheon-model set --agent hermes --model opencode-go/gpt-5.6-terra --effort medium --scope project
/pantheon-model set --agent apollo --model opencode/mimo-v2.5-free --effort low --scope project
/pantheon-model set --agent zeus --model openai/gpt-5.6-sol --effort high --scope global  # requer confirm+authorize_global

# reset — remove override
/pantheon-model reset --agent hermes --scope project
/pantheon-model reset --agent apollo --scope global
```

**Validações (sem hardcodar segredos):**

- Agente inválido → `unknown agent "X"; known agents: zeus, athena, apollo, hermes, aphrodite, demeter, themis, prometheus, hephaestus, nyx, gaia, iris, mnemosyne, talos`
- Modelo sem `provider/model-id` (`MODEL_REF_PATTERN`) → `model must use provider/model-id format`
- Modelo sem entrada em `CAPABILITY_TABLE` → erro de `capabilityEntry(model)` (ex.: modelo inexistente)
- `effort` inválido → `effort must be one of low, medium, high`; se válido mas acima do teto (`maxEffort`), é **clamped** (`normalizeCapability` retorna `{variant, clamped:true}`) e loga aviso
- `hasVision(model)` = false mas usado como visão → warning `hasVision` via logger (não bloqueia, mas avisa)
- No V1, `--scope global` sem `--confirm --authorize-global` → `global set/reset requires explicit confirmation and separate global authorization; -y is not sufficient`
- No V2, `scope=global`, `confirm` ou `authorize_global` → erro project-only; nenhuma escrita é feita
- Modelo é apenas referência `provider/model-id` — provider/model disponibilidade depende de `opencode` config + credenciais (`PANTHEON_OPENCODE_API_KEY` ou `OPENAI_API_KEY`) + conta/assinatura/endpoint

**Persistência:**

- No V1, lê candidatos `active-preset.json` (`project` → `global` → legacy) via `readRegularFile` + `O_NOFOLLOW` + validação JSON; inválido → equivale a ausência (log warn, sem segredos). No V2, somente o arquivo do projeto é lido; arquivo global não contribui overrides nem warnings.
- Escreve via `writeActivePresetAtomically(path, data, current)` — `mkdir -p`, backup `.bak` (se existia), `atomicReplace(path, JSON.stringify(data,null,2))` (`tmp`+`rename` + `fsync` dir), lock `pathLocks` por `path`, preserva `mode` (default `600`)
- No V1, reinicie OpenCode após sucesso (sem hot-swap); V2 lê overrides em um próximo configuration load. `status` nunca exibe valores de chaves.

**Histórico superseded (≤1.4.1):** antes manipulava `model`/`small_model` top-level em `opencode.json`; em 1.5.0 manipula apenas `overrides.agents`. Instrução em `commands/pantheon-model.md` usa `agent: zeus` + per-agent semantics.

## OpenCode V2 `subagent` Tool and Runtime Delegation

OpenCode V2 documents `subagent` as the child-session tool. It is a host tool,
not a Pantheon-specific delegation API; verify that it is exposed in the active
session. The following shows its V2 tool arguments, not a promise that other
hosts or versions expose the same schema:

```json
{
  "agent": "apollo",
  "description": "Find X",
  "prompt": "Search the codebase for X."
}
```

A foreground call waits for the child to finish and returns its result. To
request background execution where the active tool schema supports it, add
`"background": true`:

```json
{
  "agent": "apollo",
  "description": "Find X",
  "prompt": "Search the codebase for X.",
  "background": true
}
```

In OpenCode V2, a background call returns immediately; its response includes a
`sessionID` for continuing that child, and the parent is notified when the child
finishes. The exact tool availability and behavior remain runtime-dependent.
Some older or host-specific documentation uses `task()` to refer to native
child-session dispatch; that name does not guarantee a root tool named `task`.
Do not assume `task_status`, `cancel_task`, a Pantheon BackgroundJobBoard, or
other status/recovery facilities are available in V2.

The experimental environment variable below is a gate used by some supported
runtime versions; it is not a universal prerequisite and does not install or
guarantee a background tool. Pantheon's `npm run start` launcher sets it, but
that launcher does not detect runtime support. Set it only when the active
runtime documents and requires it:

```bash
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
opencode
```

The Pantheon launcher can be used for that same runtime-specific case:

```bash
npm run start
```

The reported Beta 10 Zeus-root toolset also exposed `subagent`; other runtimes
may expose different tools or options. Follow the active schema and use
background only when supported by that schema.

**Suggested dispatch style (only when the active root schema supports it):**

| Agent/task kind | Preference | Why |
|-----------------|------------|-----|
| Independent, long-running work (e.g. discovery or implementation) | Background only if explicitly supported and completion is observable | May benefit from concurrency |
| Short, dependent, or context-sensitive work (e.g. plan or review handoff) | Synchronous | Keeps result and dependency visible |

See the **Delegation (root `subagent`; host/API `task()`)** section in the
[README](../README.md) for the runtime distinction and historical notes.

V1 compaction carry-forward is implemented by
`experimental.session.compacting`. It is not available through `plugin-v2`.
When the V1 process restarts, running legacy board jobs are marked errored;
old jobs are not auto-resumed and child work is not restarted automatically.
The persisted Markdown reports remain historical V1 records. A native V2 task
may be followed by the TUI only when OpenCode supplies explicit child origin,
parent and status metadata; a missing Markdown report is not that metadata.

## TUI Sidebar Plugin

Pantheon includes an optional TUI sidebar plugin (reduced sidebar with a real-time
Delegations panel) showing:

```
Pantheon v1.5.0
⎇ main
⚡ Preset: go-fast (file)      ← or "Preset: default" (herança nativa)
────────────────────────────
▼ Sessions (12)
▼ Delegations (3)                 ← real-time panel
  ⠋ [apo-1] apollo — WORKING — find X
  ✓ [native-task] hermes — DONE (quando o host fornece origem explícita)
```

- **Header** — Pantheon version, current git branch, and the active model
  preset (`⚡ Preset: <name> (source)`, or `Preset: default`).
- **Sessions** — collapsible recent-sessions list (click a row to open).
- **Delegations (real-time)** — the panel can follow children sourced from
  `api.client.session.children`. Native `task()` children require explicit
  origin, parent and status metadata from OpenCode; the panel must not infer a
  native task from a missing Markdown report. Historical V1 board reports still
  render from `.pantheon/delegations/`. Animated states
  (DELEGATING / WORKING / READING RESULT / DONE / DONE (TIMED OUT) / ERROR /
  CANCELLED) with a 140ms spinner; clicking a row navigates to the child
  session. Also reads `.pantheon/delegations/` reports from all sessions, so
  the full delegation history renders even without a focused session.
  Diagnostics: every re-fetch logs `panel: children=N md=N events=N` to
  `.pantheon/logs/hooks.log` (silence-by-default).

The TUI plugin is installed by `npm run setup` or a selected install that
includes the `plugins` component. The installer selects a host-specific entry:
OpenCode V1 uses the legacy `tui.json` registration and V1 plugin API; OpenCode
V2 discovers the local plugin's `index.ts` + `tui.ts` pair and uses the native
`@opencode/plugin/tui` API. Without the `plugins` component, neither entry is
installed.

### TUI dev build (local development)

To iterate on the TUI from a git checkout without publishing, build both host
bundles:

```bash
# 1. Install the root workspace (including the TUI) + build the bundle
npm ci --ignore-scripts --no-audit --no-fund
npm run build --prefix src/plugins/tui

# 2. For V1 only, register the repo path (merged into the array, not clobbered)
node --input-type=module -e "import { registerPlugin } from './scripts/install/plugin.mjs'; registerPlugin('.opencode/tui.json', process.cwd() + '/src/plugins/tui')"
```

For V2, install the built plugin into `.opencode/plugins/pantheon-tui` with the
installer so the directory contains the V2 `index.ts` and `tui.ts` entrypoints.
TUI plugins are loaded at process start, so restart OpenCode after each build.

| Host | Discovery | Written by |
|------|-----------|------------|
| OpenCode V1 | `tui.json` → `<configDir>/plugins/pantheon-tui` | installer |
| OpenCode V2 | local plugin `index.ts` + `tui.ts` under the config plugins directory | installer |
| V1 development | `<repo>/src/plugins/tui` in project `tui.json` | manual `registerPlugin` (gitignored) |

Notes:

- `.opencode/tui.json` is gitignored; it is machine-specific and must not be
  committed.
- **Never** add `src/plugins/tui` to `opencode.json`. That file is packaged and
  merged into user configs by the installer, so a repo-relative path would leak
  into third-party installs and fail the CI package gates.
- While in dev mode, do **not** run `init` inside this repo: the installer treats
  the repo path as a stale Pantheon TUI reference and removes it.

## Commands

Type these in the OpenCode chat:

| Command | Description |
|---------|-------------|
| `/pantheon` | Multi-perspective council synthesis via inline agents |
| `/pantheon-audit` | 3-layer code audit: heuristic scan → Themis deep review → OWASP Top 10 |
| `/pantheon-deepwork` | Heavy multi-phase task with persisted checkpoints and Themis review gates |
| V1 `/pantheon-model` (wizard) e ações; V2 ferramenta `pantheon_model` (`status\|show\|set\|reset`) | Overrides manuais per-agent em `active-preset.json` (`overrides.agents[agent]`). V2: ações explícitas sem wizard de presets, project-only; `status` mostra overrides e warnings do projeto; `set` recebe `agent`, `model`, `effort` opcional e opcionalmente `scope: project`; `reset` recebe `agent` e opcionalmente `scope: project`. Arquivos globais não são lidos nem aplicados. Mutação global exige autorização humana explícita futura, indisponível nesta ferramenta; `scope=global` e flags de autorização são rejeitados. Escrita atômica `.bak`+lock; nunca escreve `.env` nem top-level `model`. O wizard sem argumentos é legado V1 apenas. |
| `/pantheon-optimize` | Project optimization: bloat scan, deepwork archive, cache migration, token report |
| `/pantheon-consolidate` | Merge and deduplicate memory entries through the persistence MCP server |

## Troubleshooting — Chaves e Presets

> Esta seção descreve o caminho legado V1 de instalação e presets. No OpenCode
> V2, `PANTHEON_MODEL_PRESET` e markers `preset` não ativam modelos; somente
> overrides per-agent explícitos do projeto são aplicados, arquivos globais são
> ignorados e sem override o modelo do host permanece intacto. Mutação global
> requer autorização humana explícita futura e não é suportada pela ferramenta.
> V1 continua inalterado até a decisão de compatibilidade.

**Sem segredos hardcoded — só nomes de env vars + `baseURL`s abaixo.**

### Diagnóstico rápido

```bash
# ver preset ativo (env vence arquivo)
echo $PANTHEON_MODEL_PRESET
cat .pantheon/active-preset.json 2>/dev/null || cat ~/.config/opencode/.pantheon/active-preset.json 2>/dev/null || echo "nenhum active-preset.json (herança nativa)"
cat ~/.config/opencode/opencode.json | grep -A2 '"model"' || echo "sem model top-level (esperado no fluxo 1.5.0)"

# status per-agent (sem segredos)
/pantheon-model status
# ou
/pantheon-model show

# validar preset defs
node scripts/validate-routing.mjs
# ou
node -e "import('./src/pantheon/presets.mjs').then(m=>console.log(m.validatePresetDefs(m.loadPresetDefs())))"
```

### Environment variables por preset (nomes, sem valores)

| Preset | Provider | BaseURL | Key env (nome) | Alias de compatibilidade | Quando é exigido |
|---|---|---|---|---|---|
| `go-free` (legacy) | `opencode` | `https://opencode.ai/zen/v1` | `PANTHEON_OPENCODE_API_KEY` | `OPENCODE_GO_API_KEY` | Quando esse V1 profile é aplicado |
| `go-fast` (legacy) | `opencode-go` | `https://opencode.ai/zen/go/v1` | `PANTHEON_OPENCODE_API_KEY` | `OPENCODE_GO_API_KEY` | Quando esse V1 profile é aplicado |
| `go-premium` (legacy) | `opencode-go` | `https://opencode.ai/zen/go/v1` | `PANTHEON_OPENCODE_API_KEY` | `OPENCODE_GO_API_KEY` | Quando esse V1 profile é aplicado |
| `go-hybrid` (OpenCode Go) | `opencode-go` | `https://opencode.ai/zen/go/v1` | `PANTHEON_OPENCODE_API_KEY` | `OPENCODE_GO_API_KEY` | Quando esse V1 profile é aplicado |
| `openai` | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | — | Quando esse V1 profile é aplicado |
| `anthropic` | `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | — | Quando esse V1 profile é aplicado |
| (sem preset) | — | — | — | — | Herança nativa — usa modelo do chat (`/model ...`) |

- Configure a variável adequada no ambiente antes de usar o profile. O wizard mostra apenas o nome da variável: não coleta nem valida chaves, não imprime valores secretos e não escreve `.env`.
- A configuração do provider no runtime V1 continua usando a variável apropriada quando o preset está ativo. Logs de instalação informam nomes/estado, nunca valores de chave.

### Erros comuns

| Sintoma | Causa | Solução |
|---|---|---|
| Provider sem credencial no runtime V1 | Profile Go/OpenAI/Anthropic ativo, mas a variável esperada não está disponível | Configure `PANTHEON_OPENCODE_API_KEY` (alias `OPENCODE_GO_API_KEY` para Go), `OPENAI_API_KEY` ou `ANTHROPIC_API_KEY`, conforme o profile |
| `unknown agent "foo"` em `/pantheon-model set` | agente não canônico | Use um dos 14: `zeus`, `athena`, `apollo`, `hermes`, `aphrodite`, `demeter`, `themis`, `prometheus`, `hephaestus`, `nyx`, `gaia`, `iris`, `mnemosyne`, `talos` |
| `model must use provider/model-id format` | modelo sem barra ou com espaço/`..` | Use `provider/model-id` ex.: `openai/gpt-5.6-sol`, `opencode-go/kimi-k2.7-code` (valida `MODEL_REF_PATTERN`) |
| No V1, `global set/reset requires explicit confirmation...` | `--scope global` sem confirmação | No V1, adicione `--confirm --authorize-global` (ou use `--scope project`, default seguro). Na ferramenta V2, global não é suportado. |
| `.pantheon/active-preset.json has invalid JSON` | arquivo corrompido | Apague ou corrija JSON; `readActivePresetRaw` trata como ausência + log `warn` sem segredos; `write` preserva anterior se falhar |
| `health-check: active-preset.json verification failed` | `writeActivePreset` gravou mas `preset` mismatch | Verifique permissões (`mode` default `600`, `O_NOFOLLOW`, `fsync` dir); wizard loga warning, não expõe chave |
| `[pantheon-delegate] no model resolved for agent "X" — omitting model...` | sem preset e sem override, herança nativa | Normal em default (herança nativa); para pinar, `npx pantheon-opencode set-tier <preset>` ou `/pantheon-model set --agent X ...` |
| Modelo `text-only` com `hasVision` warning | usou `big-pickle`/`kimi-k2.7-code` etc. para visão | Troque para multimodal (`mimo-v2.5*`, `gpt-5.6*`, `minimax-m3`) ou aceite limitação (`vision:false` no `CAPABILITY_TABLE`) |
| `Presets defined: 6` falha em `validate-routing.mjs` | `routing.yml` corrompido | `node --check src/pantheon/presets.mjs` + `yamllint src/routing.yml` |

### Headless / CI (sem TTY)

> **Apply não-interativo exige `--yes`.** Sem TTY, `init` imprime o plano e
> **não altera nada** sem `--yes` (alias `-y`). Exit codes: `0` ok/plan-only
> (nada aplicado) · `2` apply pedido sem autorização · `3` drift (um alvo
> planejado mudou entre o plano e o apply) · `130` cancelado · `1` falha.

#### Backup, restore e fluxo de aprovação

- **Preview**: `init --dry-run` imprime o plano e **não grava no alvo**. Para
  revisão entre execuções, use `--save-plan <arquivo>`; para aplicar o artefato
  revisado, use `--apply-plan <arquivo> --yes` (ou confirme no TTY). O plano
  versionado é gravado com modo `0600`, inclui metadados/fingerprints e não
  inclui conteúdo gerado. Está vinculado ao caminho original, alvo e pacote; o
  apply recalcula operações e snapshots e aborta com código `3` se houver drift.
  Planos salvos com `--force`/`--clean` não são aceitos.
- **Geração OpenCode no preview**: para evitar efeitos colaterais, o dry-run não
  executa `opencode --version`; sem um hint de versão configurado, assume V1 e
  emite um aviso advisory. Passe `--opencode-version v1` ou `v2` para fixar a
  geração.
- **Limites do preview**: o plano representa operações de arquivos gerenciados,
  não todos os efeitos em lote ou externos, como setup do ambiente Python.
  `postinstall`/`sync-tui` fica fora do fluxo de aprovação. Não é uma transação
  nem garante rollback automático.
- **Backup exato**: antes da primeira escrita, `init` salva um conjunto exato em
  `.pantheon/backups/<timestamp>/` (diretório `0700`, arquivos e manifest `0600`;
  mantém os **5** mais recentes). É uma cópia byte-a-byte e, portanto, **também
  contém quaisquer API keys/tokens já presentes nos seus arquivos** — por isso
  nunca é impresso (nem seus hashes).
- **Restore**: `pantheon-opencode restore [--project] [--from <dir>] [--dry-run] [--yes]`.
  Verifica a integridade do manifest e se recusa a restaurar um conjunto
  adulterado; faz um backup do estado atual antes de reverter. Em execução não
  interativa, exige `--yes`; num TTY pergunta (default **não**).
- **Falha no meio do apply**: aborta as escritas restantes, limpa arquivos
  temporários (`<arquivo>.tmp-<pid>`), lista os caminhos já aplicados (sem
  conteúdo) e imprime a instrução de recuperação. **Não há rollback automático** —
  o backup exato + `restore` é o caminho de recuperação (um apply interrompido é
  recuperável do mesmo modo).
- **Fora do fluxo de aprovação**: `postinstall`/`sync-tui` apenas ressincroniza
  artefatos da TUI; não faz prompt nem passa pelo gate de `--yes`.

```bash
# Preset explícito pula o seletor interativo
PANTHEON_OPENCODE_API_KEY=... npx pantheon-opencode init --headless --yes --preset go-fast
OPENAI_API_KEY=... npx pantheon-opencode init --headless --yes --preset openai --project

# Env override (vence arquivo) — útil em CI
PANTHEON_MODEL_PRESET=go-premium opencode run "hello"

# Nenhum preset (herança nativa) em CI
PANTHEON_MODEL_PRESET=none opencode run "hello"
# ou simplesmente não definir preset e não gravar active-preset.json

# Per-agent override headless (via Node, sem TUI)
node -e "
import('./src/pantheon/model-command.ts').then(m=>console.log('import ok'))
"
# ou no chat OpenCode (determinístico, backup .bak):
# /pantheon-model set --agent hermes --model opencode-go/gpt-5.6-terra --effort medium --scope project
```

## Verification

After installation, verify everything works:

```bash
# 1. Check agents are installed
ls ~/.config/opencode/agents/
# Should show 14 .md files

# 2. Check MCP servers
ls ~/.config/opencode/scripts/

# 3. Launch normally; use the conditional setting below only when supported.
opencode

# 4. Test delegation with the actual tool schema shown to Zeus
# In the reported Beta 10 runtime, dispatch through `subagent`; request
# background only if the active schema offers it.

# 5. Run health check
npm run doctor
```

If (and only if) the active host version/runtime documents and requires the
experimental background setting, export
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` before launching OpenCode.
Verify delegation against the tools actually exposed to Zeus; do not infer
completion tracking or recovery from a successful dispatch.

**Instalação global isolada:** para testar o pacote instalado em um sandbox
isolado (sem contaminar o ambiente de dev, que mistura várias instalações), use
`~/pantheon-sandbox/` — rode `bash ~/pantheon-sandbox/run-test.sh` (mcp list 5/5
+ doctor + TUI isolado). Esse gate cobre o sandbox preparado; não é uma alegação
de suporte para todo host real. O runner instala o CLI estável atual de
`@opencode/cli` por padrão; `OPENCODE_V2_SPEC` permite selecionar outro build.
Descarte com `rm -rf ~/pantheon-sandbox`; detalhes
em `~/pantheon-sandbox/README.md`.

## Troubleshooting

### TUI runtime versus development build

The installer treats `src/plugins/tui` as the single source of truth and always
copies it into the target config as `plugins/pantheon-tui` (the bundled `dist/`
+ `package.json`). OpenCode's TUI loader reads the copied `package.json` `exports`
map (`./tui` → `dist/tui.js`, `./server` → `dist/server.js`), so users do not
need `tsconfig.json`, `tsdown`, or development dependencies after installation.
The TUI `build` and `typecheck` scripts are maintainer/development tasks for the
repository, not post-install health checks; their failure in
`~/.config/opencode/plugins/pantheon-tui` does not indicate a broken runtime.

Every install (global or project) registers exactly ONE Pantheon TUI reference
system-wide — the copied `plugins/pantheon-tui` directory in the installed
config. Stale references from older installs (dist file paths, in-package
`src/plugins/tui` dirs, bare `plugins/pantheon-tui` copies, npx paths) are
removed from all `tui.json` locations OpenCode reads: `~/.opencode/tui.json`,
`~/.config/opencode/tui.json` and `<project>/.opencode/tui.json`.

> **Windows/WSL:** each environment (Windows native vs. WSL/Linux) uses its own
> OpenCode binary, config directory, and Node/npx install. Run the installer
> separately inside each environment — never share a config dir or copy
> `tui.json` references between them, since paths are environment-specific.

| Problem | Solution |
|---------|----------|
| Agents not found | Run `npx pantheon-opencode init` again |
| MCP servers not starting | Check Python 3.11+, run `npm run setup` |
| Background delegation not available | Check the active host version/runtime's tool schema and documentation. Set `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` only if that version documents support and requires it; the setting does not guarantee status, completion tracking, or recovery tools. |
| TUI sidebar not showing | Check the installed config's `tui.json` has exactly one `plugins/pantheon-tui` entry (absolute path) |
| Plugin not loading | Ensure `<config>/plugins/pantheon-tui/dist/tui.js` exists (copied at install time) |
| Health check fails | Run `npm run doctor` for detailed diagnostics |

### Memory MCP packaging

`src/mcp/memory_mcp.py` is the canonical Memory MCP server. The source-tree
`scripts/memory_mcp.py` entrypoint delegates to it, and the runtime installer
copies the canonical source into the installed scripts directory.
`install-mcp.mjs` first resolves that installed copy and falls back to the
source-tree entrypoint when running from a checkout. The script-sync test checks
that both entrypoints expose the same tool list.

### MCP servers e falha de spawn (ENOENT)

Pantheon's MCP servers (resources, code-mode, memory, persistence, vision) are
spawned by OpenCode as local child processes. Two facts shape how spawn
failures behave:

1. **OpenCode 1.18 does not retry a failed local MCP server.** If the spawn
   fails at startup, the server stays in `failed` state for the whole TUI
   process. There is no reconnect hook; the only recovery is restarting the
   TUI. Session data and persistence are safe — they live in the SQLite
   database, not in the MCP process.
2. **`posix_spawn ENOENT` means the command path does not exist.** The most
   common cause is a stale hardcoded path (e.g. a config that still points at
   `/home/admin/.config/opencode/...` after the home directory was migrated)
   or a path relative to an ambiguous root. OpenCode spawns the command
   verbatim — a missing interpreter or script fails with ENOENT before any
   Python code runs.

**Diagnosis**

```bash
# Verify the interpreter and script exist for each configured server
ls /home/ils15/.config/opencode/.venv/bin/python3
ls /home/ils15/.config/opencode/scripts/mcp_resources.py
# etc. — compare against the paths in ~/.config/opencode/opencode.json

# Static check — `npm run doctor` (or `pantheon-opencode doctor`) validates
# that every local MCP command's executable and absolute script args exist
npm run doctor -- --target /home/ils15/.config/opencode
```

If the doctor reports `MCP "..." executable does not exist`, fix the path in
`~/.config/opencode/opencode.json` (or re-run the installer, which resolves
hermetic absolute paths — see below) and **restart the OpenCode TUI**.

**Recovery**

```bash
# Close the TUI (Ctrl+C / exit) and relaunch. Sessions and data persist.
opencode
# Verify MCP servers are back:
opencode mcp list
```

**Hermetic path policy (P2, 2026-08-05)**

- `scripts/install-mcp.mjs` generates commands with **absolute** interpreter
  and script paths, resolved in this order: canonical user install
  (`~/.config/opencode/.venv/bin/python3` + `~/.config/opencode/scripts/*.py`),
  then the local checkout (`<ROOT>/.venv` + `<ROOT>/scripts|src/mcp`), with a
  warning fallback to PATH `python3`.
- `scripts/doctor.mjs` now includes a **hermetic spawn check**: every local MCP
  entry is verified for an existing executable and existing absolute script
  args, so the ENOENT class is caught statically before OpenCode tries to
  spawn.
- Avoid editing MCP commands to relative paths or paths under another user's
  home — they reproduce this failure class.

## Installation Flow

```mermaid
flowchart LR
    A["npx pantheon-opencode init"] --> B{"--project?"}
    B -->|No| C["~/.config/opencode/agents/ (global)"]
    B -->|Yes| D[".opencode/agents/ (project-local)"]
    C --> E["npm run setup"]
    D --> E
    E --> F["MCP servers + skills + TUI"]
    F --> G["Check background support; configure only if documented"]
    G --> H["opencode"]
    H --> I["🚀 Pantheon v1.5.0 ready"]
```

## Host/API `task()` Delegation Concept

This is an API-level illustration for hosts that expose the documented native
`task()` shape and completion semantics. It is not a guarantee that Zeus has a
root `task()` tool, that this signature is available, or that dispatch returns
a trackable result. In the reported Beta 10 Zeus-root runtime, dispatch was via
`subagent`; `task_status` and `cancel_task` were not exposed, and no status,
completion-tracking, or recovery guarantee follows from this diagram. Check the
active runtime's tool schema and documentation. Background support, the
experimental environment variable, and completion notifications are
version/runtime-dependent.

```mermaid
sequenceDiagram
    participant Z as Zeus
    participant A as Apollo (child)
    participant H as OpenCode host

    Z->>H: host API dispatch (e.g. task(), if exposed)
    H-->>A: child session starts (host-dependent)
    A-->>H: child completion (if emitted by host)
    opt Host exposes a result or completion notification
        H-->>Z: host-defined result/notification
    end

    Note over Z,H: Illustrative host API only; no Pantheon-specific delegate API
```

## TUI Sidebar Layout

```mermaid
block-beta
    columns 1
    block["Pantheon v1.5.0"]
        block("⎇ main")
        end
        block Sessions["▶ Sessions (N total)"]
        end
        block Commands["▶ Commands (5)"]
        end
        block Agents["▶ Agents (14)"]
        end
        block Config["▶ Config"]
        end
        block Memory["▶ Memory"]
        end
    end
```
