<!-- synced-from: README.md -->
# Pantheon

Plugin de orquestração multiagente para o OpenCode que leva um pedido do plano até a
alteração revisada com 14 agentes especializados, TDD obrigatório e gates de aprovação
humana — para desenvolvedores e equipes que querem estrutura sem abrir mão do controle
do código.

[English](README.md) · [Repositório](https://github.com/ils15/pantheon-opencode) · [Licença MIT](LICENSE)

[![Licença](https://img.shields.io/badge/licen%C3%A7a-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A526.4.0-339933)](package.json)
[![OpenCode](https://img.shields.io/badge/opencode-2.x-black)](https://opencode.ai/)
[![Docs](https://img.shields.io/badge/docs-portal-indigo)](https://ils15.github.io/pantheon-opencode/pt-BR/)

## O que é

Um agente único planejando, escrevendo, testando, revisando e documentando ao mesmo tempo
produz contexto fragmentado e testes pulados. O Pantheon divide esse trabalho entre
especialistas que compartilham um fluxo único: Zeus orquestra, Athena planeja, os agentes
de implementação escrevem, Themis revisa, e cada fase para esperando sua aprovação.
Micro-edições limitadas pulam a cerimônia e verificam em segundos; trabalho pesado de
várias fases roda como plano com checkpoints, retomável entre sessões. É um plugin do
OpenCode mais um instalador — sem runtime separado, sem auto-merge, sem mudança silenciosa
de permissões.

Cada despacho carrega um handoff brief conciso — objetivo, escopo limitado, entradas
relevantes, restrições, formato de retorno esperado e verificação — e o trabalho é roteado
**qualitativamente**, por incerteza, domínio, dependências, risco e verificação, não por
limites fixos de arquivos ou linhas.

## Instalação

Requisitos: [OpenCode](https://opencode.ai/docs/) **2.x** e Node.js **≥ 26.4.0**
([compatibilidade](docs/COMPATIBILITY.md)).

```bash
# Opção A — como plugin do OpenCode (global ou do projeto)
opencode plugin add pantheon-opencode

# Opção B — instalação global via CLI com todo o ferramental MCP
npm install -g pantheon-opencode@beta
pantheon-opencode init --yes

# Verificar a instalação
pantheon-opencode doctor

# Depois: atualizar sem perder modelos, presets ou permissões
pantheon-opencode update
```

## Uso

Dentro do OpenCode, acione o orquestrador ou um fluxo:

```text
@zeus: Adicione exportação CSV na página de relatórios
/pantheon-deepwork "Implemente o fluxo de autenticação OAuth2 PKCE"
```

`@zeus` roteia para os especialistas poliglotas (`@hermes` para backend/APIs, `@aphrodite`
para UI, `@demeter` para dados/migrações, `@talos` para correções rápidas, `@themis` para
revisão); `/pantheon` arbitra escolhas de arquitetura entre especialistas; `/pantheon-deepwork`
executa um plano multifase com recibos mecânicos via `pantheon_step_ledger` e gates; e
`pantheon_agent_forge` cria especialistas customizados de domínio em `.opencode/agents/<name>.md`
sob demanda. Você aprova cada gate e executa cada commit.

## Estrutura

```
src/agents/       14 definições canônicas de agentes poliglotas (roster.json + build-roster)
src/pantheon/     tools nativas TypeScript, Agent Forge, Step-Ledger, memória FTS5, codemap, receipts
src/skills/       25 skills carregadas sob demanda
src/mcp/          ponte MCP nativa em Node.js (pantheon-mcp-server.mjs)
src/plugins/      plugin do OpenCode + TUI de alta densidade e configurações
scripts/          instalador, doctor, test-slice, ferramental de release
bin/              CLI pantheon-opencode
docs/             portal de documentação bilíngue
examples/         projetos de referência executáveis
tests/            suítes de teste em Node e TypeScript
```

## Documentação

| Comece por | Aprofunde |
|---|---|
| [Portal de docs](https://ils15.github.io/pantheon-opencode/pt-BR/) | [Arquitetura](docs/pt-BR/ARCHITECTURE.md) |
| [Início rápido](docs/pt-BR/QUICKSTART.md) | [Visão geral e escadas de roteamento](docs/OVERVIEW.md) |
| [Instalação](docs/pt-BR/INSTALLATION.md) | [Modos de execução](docs/guides/execution-modes.md) |
| [Primeiro projeto ponta a ponta](docs/pt-BR/guides/first-project.md) | [Matriz de capacidade dos agentes](docs/pt-BR/AGENT-CAPABILITY-MATRIX.md) |
| [Configurações e janela TUI](docs/SETTINGS.md) | [Permissões, gates e delegação](docs/PERMISSIONS-QUALITY-DELEGATION.md) |
| [Destaques de versões](docs/releases/highlights.md) | [CHANGELOG](CHANGELOG.md) |

Exemplos executáveis: [dashboard SaaS](examples/saas-dashboard/) e
[CLI de saúde do repositório](examples/cli-tool/). Contribuição:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

MIT — veja [LICENSE](LICENSE). Citação via DOI de conceito Zenodo
[10.5281/zenodo.22650136](https://doi.org/10.5281/zenodo.22650136)
([CITATION.cff](CITATION.cff)).
