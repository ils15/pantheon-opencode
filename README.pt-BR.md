# Pantheon

**Uma forma mais clara de trabalhar com OpenCode em projetos reais.** O
Pantheon reúne planejamento, implementação, revisão e documentação em uma
experiência guiada. É um plugin e instalador para OpenCode, feito para pessoas
e equipes que querem mais estrutura sem perder o controle do próprio código.

[English](README.md) ·
[Repositório](https://github.com/ils15/pantheon-opencode) · [Licença MIT](LICENSE)

[![Versão](https://img.shields.io/github/v/release/ils15/pantheon-opencode?label=versão)](https://github.com/ils15/pantheon-opencode/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/ils15/pantheon-opencode/ci.yml?branch=main&label=CI)](https://github.com/ils15/pantheon-opencode/actions)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22306637.svg)](https://doi.org/10.5281/zenodo.22306637)

## O que é?

O Pantheon é um companheiro para o [OpenCode](https://opencode.ai/) que ajuda a
transformar uma ideia em uma alteração revisada. Ele oferece uma forma comum
de planejar o trabalho, avançar, conferir resultados e preservar o contexto
útil do projeto.

## Por que usar?

- **Menos troca de contexto:** planeje e construa no mesmo fluxo.
- **Alterações mais conscientes:** peça revisões e verificações antes de
  considerar o trabalho concluído.
- **Um ponto de partida repetível:** use a mesma configuração em projetos e
  com colaboradores diferentes.
- **Você continua no comando:** o Pantheon apoia suas decisões, mas não
  substitui seu julgamento nem a revisão do código gerado.

## Comece em 2 minutos

Requisitos: [OpenCode 1.18.4+](https://opencode.ai/docs/) e Node.js 18+.

No projeto em que você quer usar o Pantheon:

```bash
npx pantheon-opencode init
opencode
```

O instalador orienta você pelas opções disponíveis. Para servidores MCP
opcionais, instalação local no projeto ou uso sem perguntas, consulte o
[guia de instalação](docs/INSTALLATION.md).

## Um exemplo simples

Com o OpenCode em execução, descreva o resultado que você quer:

```text
/pantheon Adicione exportação CSV à página de relatórios, com testes e revisão.
```

O Pantheon ajuda a transformar esse pedido em um plano e em etapas revisadas.

## Para quem é?

Para desenvolvedores, mantenedores e equipes que usam OpenCode e querem uma
forma mais consistente de lidar com correções pequenas e mudanças maiores. É
especialmente útil quando o projeto se beneficia de decisões registradas,
verificações repetíveis e passagens claras entre etapas do trabalho.

## O que inclui?

- Um instalador guiado para disponibilizar o Pantheon no OpenCode.
- Instruções e comandos reutilizáveis para planejar, construir, revisar e
  documentar o trabalho.
- Memória de projeto para preservar contexto relevante entre sessões.
- Integrações opcionais para tarefas comuns de desenvolvimento.

## Status

Versão operacional neste checkout: **v1.5.0-beta.2** (candidata; esta página
não afirma publicação). O Pantheon foi feito para OpenCode e depende da
disponibilidade e da configuração do OpenCode e dos serviços opcionais que você
escolher. Veja as [releases](https://github.com/ils15/pantheon-opencode/releases)
e o [changelog](CHANGELOG.md) para acompanhar as mudanças publicadas.


## Execução code-mode (opt-in explícito)

Scripts executados pelo MCP server `pantheon-code-mode` (`execute_code_script`)
só rodam quando aprovados explicitamente. A aprovação fica em
`.pantheon/code-mode/manifest.json` com o SHA-256 de cada script.

- **Sem manifest → nada executa** (`INVALID_STATE`); nunca há execução implícita.
- **Script fora do manifest → `CONFLICT`**; é preciso aprovar antes.
- **Hash divergente → `CORRUPT_DATA`**; edições após a aprovação são detectadas.

Aprove (ou reaprove) um script com a tool `approve_code_script`. O instalador
semeia o manifest com o hash de todos os scripts empacotados. Os resultados
seguem o contrato de nove códigos (`OK`, `UNSUPPORTED`, `UNAVAILABLE`,
`INVALID_INPUT`, `INVALID_STATE`, `CONFLICT`, `CORRUPT_DATA`, `TIMEOUT`,
`ESCALATE`) e, com `json_output=true`, incluem o campo `status`.


## Novidades da 1.5.0-beta.2

- Instalador exclusivo para OpenCode: guias de plataformas consolidados em um
  único [guia OpenCode](docs/platforms/opencode.md).
- Novo CLI `uninstall` com escopos project/global e checagem de ownership:
  `node scripts/uninstall.mjs --project|--global [--dry-run] [--force]`.
- Recursos MCP endurecidos: correção do `pantheon://agents` e proteção contra
  symlink/traversal nos caminhos de recursos.
- Compatibilidade com OpenCode V2: merge de configuração `plugins` /
  `mcp.servers.enabled` e launch stdio MCP com PWD correto.
- `doctor` e health checks de instalação expandidos.
- Validador de sandbox para instalações globais
  (`scripts/test-opencode-v1-v2-sandbox.sh`) cobrindo OpenCode V1/V2 lado a
  lado — veja [Validação em sandbox](#validação-em-sandbox-v1v2).
- A flag `--prompts` do instalador está planejada para uma release futura.

## OpenCode V1/V2 — Versão dupla (1.5.0-beta.2)

O Pantheon tem dois contratos de plugin OpenCode **exclusivos**. A configuração
comum do OpenCode pode ser compartilhada, mas o registro do plugin Pantheon é
selecionado por instalação; os plugins Pantheon V1 e V2 nunca devem ser
registrados juntos.

| | V1 | V2 |
|---|---|---|
| Chave de config do OpenCode | `plugin` singular | `plugins` plural |
| Registro Pantheon | `src/plugin.ts` mais `src/plugins/pantheon-hooks.ts` | `pantheon-opencode/plugin-v2` (`src/plugin-v2.ts`) |
| Contrato de runtime | Plugin Pantheon legado, incluindo `pantheon_delegate`, ferramentas read/list, hooks de evento/ferramenta e tratamento de compactação V1 | Plugin V2 completo: 9 ferramentas de orquestração, 4 assinaturas de eventos, session hooks (`prompt`, `context`), tool hooks (`execute.before`/`after`), além de transforms de configuração |
| APIs V1 | Registradas | Definições próprias de ferramentas via `ctx.tool.transform()` — não pelo caminho do plugin V1 |

O plugin V2 fornece 9 ferramentas de orquestração (`pantheon_delegate`,
`pantheon_delegation_read`, `pantheon_delegation_list`, `hashline_edit`,
`pantheon_goal_create`, `pantheon_goal_get`, `pantheon_goal_update`,
`pantheon_cost`, `pantheon_model`), 4 assinaturas de eventos (`session.created`,
`session.idle`, `session.error`, `session.compacted`), session hooks (`prompt`,
`context`) e tool hooks (`execute.before`, `execute.after`). O único recurso V2
sem suporte é `legacy-hooks` (a superfície de API de delegate específica do V1).

O pacote expõe os dois contratos como exports importáveis:
`pantheon-opencode/plugin` (V1), `pantheon-opencode/plugin-v2` (V2) e
`pantheon-opencode/v2-bridge` (interop opcional), para que o host carregue
explicitamente o contrato desejado.

A ponte V1→V2 (`src/pantheon/v2-bridge.ts`) habilita interop opcional:
singletons de infraestrutura V1 (BackgroundJobBoard, DelegationClient,
GoalStore, TodoEnforcer, VisionHandler) são repassados via `ctx.options` do V2.
A ponte é opcional — o V2 funciona standalone com degradação graciosa.

Selecione o contrato explicitamente na instalação:

```bash
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2
npx pantheon-opencode init --opencode-version auto
```

`--version v1|v2|auto` é aceito como a grafia antiga do seletor quando usado
depois de `init`. `auto` é conservador, não uma autodetecção geral de
plataforma: `OPENCODE_VERSION=v1|v2` vence; caso contrário, um `OPENCODE_BIN`
terminando em `opencode2` seleciona V2; qualquer outro caso seleciona V1. O
instalador remove referências Pantheon das duas formas de config antes de
gravar apenas o registro Pantheon selecionado. Entradas de terceiros não são
convertidas nem reivindicadas por essa regra.

O relatório `pantheon_cost`, disponível nos plugins V1 e V2, pode selecionar o banco com
`PANTHEON_OPENCODE_VERSION=v1` ou `v2` (`opencode.db` ou `opencode-v2.db`).
`PANTHEON_COST_DB=/caminho/absoluto/para/opencode.db` tem precedência sobre o
seletor de versão, e um `dbPath` explícito fornecido pelo chamador da
ferramenta tem precedência sobre ambos. O resolver nunca consulta o banco da
outra versão e reporta um erro acionável quando o banco selecionado está
ausente ou com schema incompatível.

O instalador continua gravando as configurações de compatibilidade exigidas
pelo host OpenCode selecionado, como `experimental.subagent_depth`; isso não
converte um plugin V1 em V2 nem dá hooks V1 ao V2.

## Releases

A publicação é autorizada **somente** por um `workflow_dispatch` explícito do
workflow `Release` (o input `release_channel` escolhe beta ou stable). Labels
de PR, push, merge e tag nunca publicam nada, e todos os gates de validação são
fail-closed: somente um PASS explícito autoriza release evidence. Consulte
[docs/RELEASING.md](docs/RELEASING.md) para detalhes de validação e recuperação.

A validação mantém cada manifest junto do seu lockfile: o root
`package.json` + `package-lock.json` e o TUI
`src/plugins/tui/package.json` + `src/plugins/tui/package-lock.json`. Ambos usam
`npm ci --ignore-scripts`; uma falha em `npm ci` bloqueia a execução e não há
fallback para `npm install`. Uma release carrega um único tarball `.tgz`, calcula
o SHA-256 desse mesmo artefato e vincula o tarball e o GitHub Release ao
`TARGET_SHA` completo; um segundo pack não é intercambiável.

## Validação em sandbox (V1/V2)

O `scripts/test-opencode-v1-v2-sandbox.sh` valida o pacote instalado
globalmente como um usuário real dentro de um sandbox isolado (com `HOME`,
prefix npm e venv próprios) — nunca o ambiente de desenvolvimento. Ele verifica
OpenCode V1 (`opencode`) e V2 (`opencode2`) lado a lado: binários, conectividade
MCP, `doctor` e — com `--prompts` — uma bateria de prompts cobrindo o recurso
`pantheon://agents`, memory store/recall, escrita no filesystem e delegação de
agente. O gate é fail-closed: todo check obrigatório precisa terminar em PASS
explícito; timeout, falha de auth/rede/provider e pré-requisitos ausentes
bloqueiam a execução.

```bash
scripts/test-opencode-v1-v2-sandbox.sh --prepare          # tarball + install + init no sandbox
scripts/test-opencode-v1-v2-sandbox.sh --run v1 --prompts # validação base + bateria de prompts (V1)
scripts/test-opencode-v1-v2-sandbox.sh --run v2           # apenas validação base (V2)
scripts/test-opencode-v1-v2-sandbox.sh --prompts          # bateria de prompts para as duas versões
scripts/test-opencode-v1-v2-sandbox.sh --reset            # limpa a raiz do sandbox
```

Os modos são combináveis (ex.: `--prepare --run v1 --prompts`). Os binários são
resolvidos estritamente dentro do prefix npm do sandbox — um sandbox não
preparado falha rápido em vez de testar silenciosamente a instalação do host.

Isso valida somente o sandbox isolado e preparado. Um PASS não prova suporte
para todo host real nem para configurações de host que não foram exercitadas.

Variáveis de ambiente:

| Variável | Padrão | Finalidade |
|----------|---------|---------|
| `PANTHEON_SANDBOX_ROOT` | `~/pantheon-sandbox` | Raiz do sandbox (recusada se insegura para `--reset`) |
| `OPENCODE_V1_SPEC` | `opencode-ai@1.18.18` | Spec npm que fornece o binário `opencode` |
| `OPENCODE_V2_SPEC` | `@opencode-ai/cli@beta` | Spec npm que fornece o binário `opencode2` |
| `PANTHEON_SANDBOX_MODEL` | `opencode-go/mimo-v2.5` | Modelo usado pelo init e pelos prompts |
| `PANTHEON_PROMPT_TIMEOUT` | `300` | Timeout por prompt em segundos |

Códigos de saída: `0` sem falhas reais · `1` falha real (veja
`prompts-report.md` na raiz do sandbox) · `2` erro de uso · `3` sandbox não
preparado.

### Divergência intencional do memory MCP

`scripts/memory_mcp_server.py` e `src/mcp/memory_mcp_server.py` são
intencionalmente diferentes. A cópia independente em `scripts/` mantém o
contrato leve de `memory_*`; a cópia instalada em `src/mcp/` também expõe o
schema opcional de codemap e `code_index`, `code_query` e `code_neighbors`. As
outras cópias compartilhadas permanecem idênticas. Não sobrescreva uma cópia de
memória com a outra.

## Documentação

- [Instalação](docs/INSTALLATION.md) · [Início rápido](docs/QUICKSTART.md)
- [Arquitetura](docs/ARCHITECTURE.md) · [Ferramentas MCP](docs/mcp-tools.md)
- [Plataformas](docs/PLATFORMS.md) · [Atualização](docs/UPGRADING.pt-BR.md)
- [Referência de agentes](docs/agents/README.md) · [Referência de skills](src/skills/README.md)
- [Processo de release](docs/RELEASING.md) · [Contribuição](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Contribua

Ideias, relatos de problemas, melhorias na documentação e contribuições de
código são bem-vindos. Leia [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir
uma issue ou pull request.

## Citação e DOI

O Pantheon é distribuído sob a [Licença MIT](LICENSE). Para o registro histórico
publicado da v1.4.3 apenas, use o [DOI do Zenodo](https://doi.org/10.5281/zenodo.22306637);
essa não é a versão operacional atual. Os metadados de citação também estão em
[CITATION.cff](CITATION.cff).

Repositório canônico: <https://github.com/ils15/pantheon-opencode>

---

[Read in English](README.md)
