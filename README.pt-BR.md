<!-- synced-from: README.md @ 0a6a8e2 -->
# Pantheon

**Uma forma mais clara de trabalhar com OpenCode em projetos de software
reais.** O Pantheon reúne planejamento, implementação, revisão e documentação
numa experiência guiada. É um plugin e instalador para OpenCode, feito para
desenvolvedores e equipes que querem estrutura útil sem abrir mão do controle
sobre o próprio código.

[English](README.md) ·
[Repositório](https://github.com/ils15/pantheon-opencode) · [Licença MIT](LICENSE)

[![Versão](https://img.shields.io/github/v/release/ils15/pantheon-opencode?label=version)](https://github.com/ils15/pantheon-opencode/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/ils15/pantheon-opencode/ci.yml?branch=main&label=CI)](https://github.com/ils15/pantheon-opencode/actions)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22650136.svg)](https://doi.org/10.5281/zenodo.22650136)

## O que é?

O Pantheon é um companheiro do [OpenCode](https://opencode.ai/) que ajuda a ir
de uma ideia a uma mudança revisada. Quatorze agentes especializados
compartilham um único fluxo: planejar, implementar, checar, revisar e registrar
o que importou. Você continua no controle de cada decisão e de cada merge.

## Por que usar?

- **Menos troca de contexto:** planejamento e construção no mesmo fluxo.
- **Mudanças mais deliberadas:** peça revisões e checagens antes de considerar
  o trabalho concluído.
- **Um ponto de partida repetível:** o mesmo setup entre projetos e
  colaboradores.
- **Você no comando:** o Pantheon apoia seu julgamento; não o substitui.
- **Coordenação na medida:** trabalho delimitado vai para um especialista, que
  reúne o contexto necessário. Planejamento, descoberta separada, paralelismo e
  revisão entram quando escopo e risco pedem. `/pantheon-deepwork` continua sendo
  o fluxo com checkpoints para trabalho pesado em várias fases.

## Comece em 2 minutos

Requisitos: [OpenCode](https://opencode.ai/docs/) **2.x** e Node.js
**>=26.4.0** para a CLI e as ferramentas. **OpenCode 2.0.22 tem falha
conhecida**; veja [Compatibilidade](docs/COMPATIBILITY.md).

Em qualquer lugar (global, todos os projetos) ou dentro de um projeto:

```bash
opencode plugin add pantheon-opencode
# ou fixe a versão: opencode plugin add pantheon-opencode@<versão>
opencode
```

Reinicie o OpenCode quando solicitado. O `npx pantheon-opencode init`
sobrevive apenas como caminho de migração do OpenCode 1.x e ferramenta
opcional de scaffolding de projeto.

Depois descreva o resultado desejado:

```text
/pantheon Add CSV export to the reports page, including tests and a review.
```

Quando você pede um plano, Athena devolve o plano a Zeus, que o exibe na
conversa principal antes de pedir aprovação — nunca como um plano escondido na
conversa de um agente filho.

Reinicie o OpenCode depois de instalar ou trocar o plugin. O Pantheon registra
um único plugin; o host nunca carrega dois plugins Pantheon.

Flags do instalador, códigos de saída, planos salvos, backup e restore,
desinstalação, reconcile e pins de MCP estão no
[guia de instalação](docs/INSTALLATION.md). Para os primeiros dez minutos
apenas — `init` → reiniciar → `/dispatch` → primeiro resultado — veja o
[Início rápido](docs/QUICKSTART.md).

## O que está incluído?

- **14 agentes especializados**, com um orquestrador, especialistas de
  implementação, um gate de qualidade e papéis de apoio.
- **23 skills** e instruções reutilizáveis para planejar, construir, revisar e
  documentar.
- **5 servidores MCP locais** para memória de projeto, persistência, recursos,
  execução confinada de scripts e visão.
- **Um roteador de decisão seletivo e consultivo**, com resultados locais
  estruturados e recomendações por turno quando habilitado. O egress direto
  pertencente ao Pantheon é inativo; o egress nativo existe apenas na tool
  explícita `pantheon_jev_decide` (só para o Zeus), que chama a API nativa de
  Decisions do host (Jev/TypeSafe via OpenCode Console ou modelo configurado)
  atrás do consentimento e dos limites de orçamento do usuário — ela nunca
  despacha agentes, executa skills ou altera permissões. Veja a
  [referência do roteador](docs/reference/local-decision-router.md) e o
  [Decisions nativas (Jev)](docs/reference/native-decisions.md).
- **Uma TUI opcional**, com bloco de dispatch na sidebar e painel `/dispatch`
  em largura total. A sidebar mantém a versão do Pantheon, o preset/fonte
  ativos, o estado do git e um bloco `Context` (tokens, medidor de percentual,
  `$<gasto> gastos` e uma linha mutada `cache <n>% · <n.n> tok/s`); o rodapé
  nativo do prompt segue intacto, e o Pantheon só acrescenta
  `▸<preset> · ✦<n> ativos` enquanto há delegações rodando. O comando `/pantheon-settings`
  (ou `Pantheon: Settings` na paleta) abre a janela de configurações inspirada no padrão OpenCode Quota:
  - **Changelog**: destaques da versão e notas de lançamento integradas diretamente na janela.
  - **Atualizações**: escolha de canal (`stable` ou `beta`), verificação em tempo real e ação de atualização direta (`Update now`) ou comandos CLI (`pantheon-opencode update`).
  - **Personalização da TUI e Barras**: escolha o formato das barras de progresso (`line`, `block`, `smooth`, `ascii`, `dots`, `braille`), largura (`standard`, `compact`, `wide`, `full`), indicador de 50% (`evenMark`), separadores e presets de layout (`comfortable` ou `compact`), funcionando tanto no terminal CLI quanto no OpenCode Desktop.
  A TUI não traz mais painel de quota: para ver quota e uso de provedores dentro do OpenCode,
  instale o plugin comunitário recomendado
  [`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota) — veja
  [Quota & uso](docs/tui-v2-quota-providers.md). As tools `pantheon_cost` e
  `pantheon_model` seguem funcionando sem alterações.

A memória MCP fica disponível para busca explícita: o coordenador consulta o
histórico uma vez quando ele pode mudar a tarefa e repassa apenas resultados
úteis. Checkpoints de sessão servem para retomadas entre sessões; memória
durável só é gravada quando solicitada ou autorizada. A compactação nativa do
OpenCode resume a conversa atual, sem salvar cada fase em outro MCP.
Veja [Memória](docs/MEMORY.md).

## Compatibilidade

OpenCode **2.x** é suportado. **OpenCode 2.0.22 tem falha conhecida.** A 2.0
remove o contrato V1 do OpenCode por completo — a 1.7.x foi a última linha com
suporte V1.

A política de suporte, a exceção conhecida e a evidência de versões verificadas
têm um único lar: [Compatibilidade](docs/COMPATIBILITY.md).

## Delegação

O Pantheon delega pelo motor nativo de sessões filhas do host: `subagent` no
runtime raiz relatado pelo usuário, chamado de `task()` na documentação de
host/API. Disponibilidade de ferramenta, suporte a background e observabilidade
de conclusão dependem do runtime; quando a conclusão não é observável, use
dispatch síncrono ou aguarde uma notificação do host.

Todo dispatch raiz leva um briefing conciso — objetivo, escopo limitado,
entradas relevantes, restrições, formato de retorno esperado e verificação. Os
contratos de retorno são específicos por papel: implementação usa
`## subtask_summary`, investigação devolve achados estruturados, Athena devolve
o plano completo e respostas de conselho usam `## specialist_response`.
Trabalho delegado tem no máximo uma retentativa após falha transitória, e o
Pantheon nunca alega fan-in determinístico ou recuperação de job sem um
mecanismo exposto.

O modelo de delegação, a matriz chamador/alvo e os gates de aprovação estão em
[Arquitetura](docs/ARCHITECTURE.md) e
[Permissões, Gates e Delegação](docs/PERMISSIONS-QUALITY-DELEGATION.md).

## Documentação

| Comece aqui | Aprofunde |
|---|---|
| [Instalação](docs/INSTALLATION.md) | [Arquitetura](docs/ARCHITECTURE.md) |
| [Início rápido](docs/QUICKSTART.md) | [MCP](docs/MCP.md) · [Ferramentas MCP](docs/mcp-tools.md) |
| [Atualização](docs/UPGRADING.pt-BR.md) | [Memória](docs/MEMORY.md) |
| [Compatibilidade](docs/COMPATIBILITY.md) | [OpenCode 2.x](docs/opencode.md) |
| [Agentes e Skills](docs/agents/README.md) | [Plataformas](docs/PLATFORMS.md) |
| [Processo de release](docs/RELEASING.md) | [Proteção de branch](docs/BRANCH-PROTECTION.md) |
| [Roteamento de modelos](docs/reference/model-routing.md) | [Variáveis de ambiente](docs/reference/env-vars.md) · [Code Mode](docs/reference/code-mode.md) |
| [Contribuição](CONTRIBUTING.md) | [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) |

> Os demais documentos são publicados apenas em inglês, que é a fonte canônica.
> Este README e o [guia de atualização](docs/UPGRADING.pt-BR.md) são as duas
> páginas mantidas em português.

## Status

Os manifests neste checkout expressam a versão em preparação, não uma publicação
confirmada. Consulte a dist-tag `beta` do npm para saber o que está realmente
publicado. Veja [Compatibilidade](docs/COMPATIBILITY.md) para os hosts
suportados e as [releases](https://github.com/ils15/pantheon-opencode/releases)
para as mudanças publicadas mais recentes.

## Novidades

Veja a [release no GitHub](https://github.com/ils15/pantheon-opencode/releases)
e o [CHANGELOG.md](CHANGELOG.md) para as mudanças da 1.7.0.

## Contribua

Ideias, relatos de bugs, melhorias de documentação e contribuições de código são
bem-vindos. Leia o [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir uma issue ou
pull request. Esse arquivo também define a regra de documentação: um único lar
por fato, com uma lista curta de fatos que não devem ser duplicados.

Em mudanças de código, comece pela verificação relevante mais pequena e amplie
conforme o risco. `npm test` executa a suíte completa do repositório; veja o
[CONTRIBUTING.md](CONTRIBUTING.md) para saber quando usá-la.

## Citação e DOI

O Pantheon é distribuído sob a [Licença MIT](LICENSE). Cite o
[DOI de conceito do Zenodo](https://doi.org/10.5281/zenodo.22650136), que sempre
resolve para a release arquivada mais recente; cada release também tem seu
próprio DOI de versão. Os metadados de citação estão em
[CITATION.cff](CITATION.cff).

Repositório canônico: <https://github.com/ils15/pantheon-opencode>

---

[Read in English](README.md)
