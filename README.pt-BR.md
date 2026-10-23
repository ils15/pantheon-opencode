<!-- synced-from: README.md @ 7359e4f -->
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
- **Coordenação na medida:** trabalho limitado vai para um especialista;
  planejamento, descoberta, trabalho paralelo e revisão entram quando escopo e
  risco pedem. `/pantheon-deepwork` continua sendo o fluxo com checkpoints para
  trabalho pesado em várias fases.

## Comece em 2 minutos

Requisitos: [OpenCode](https://opencode.ai/docs/) **1.19.x** (V1) ou **OpenCode
2.x** (V2), e Node.js **>=26.4.0** para a CLI e as ferramentas. **OpenCode 2.0.22
tem falha conhecida**; veja [Compatibilidade](docs/COMPATIBILITY.md).

No projeto onde você quer usar o Pantheon:

```bash
npx pantheon-opencode init
opencode
```

Depois descreva o resultado desejado:

```text
/pantheon Add CSV export to the reports page, including tests and a review.
```

Quando você pede um plano, Athena devolve o plano a Zeus, que o exibe na
conversa principal antes de pedir aprovação — nunca como um plano escondido na
conversa de um agente filho.

Reinicie o OpenCode depois de instalar ou trocar a geração do plugin. O
instalador seleciona uma geração por instalação; plugins V1 e V2 nunca são
registrados juntos.

Flags do instalador, códigos de saída, planos salvos, backup e restore,
desinstalação, reconcile e pins de MCP estão no
[guia de instalação](docs/INSTALLATION.md). Para os primeiros dez minutos
apenas — `init` → reiniciar → `/dispatch` → primeiro resultado — veja o
[Início rápido](docs/QUICKSTART.md).

## O que está incluído?

- **14 agentes especializados**, com um orquestrador, especialistas de
  implementação, um gate de qualidade e papéis de apoio.
- **20 skills** e instruções reutilizáveis para planejar, construir, revisar e
  documentar.
- **5 servidores MCP locais** para memória de projeto, persistência, recursos,
  execução confinada de scripts e visão.
- **Uma TUI opcional**, com bloco de dispatch na sidebar e painel `/dispatch`
  em largura total.

A memória é usada seletivamente: o coordenador busca uma vez apenas quando o
histórico do projeto pode afetar a tarefa e repassa os resultados relevantes aos
especialistas. Grave um resultado conciso e reutilizável ao concluir a tarefa
quando ele for importar depois; resumos rotineiros de filhos ficam no handoff.
Veja [Memória](docs/MEMORY.md).

## Compatibilidade

OpenCode **1.19.x** (plugin V1) e **OpenCode 2.x** (plugin V2) são suportados.
**OpenCode 2.0.22 tem falha conhecida.** A partir da 1.7, a linha abandona o
contrato V1 e mira apenas o OpenCode 2.

A política de suporte, a exceção conhecida e a evidência de versões verificadas
têm um único lar: [Compatibilidade](docs/COMPATIBILITY.md).

A matriz de suporte, o piso de Node e as notas de host/build, as regras de
geração OpenCode 1.x/2.x, a posição de fim de vida e os problemas conhecidos têm
um único lar: [Compatibilidade](docs/COMPATIBILITY.md).

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
| [Compatibilidade](docs/COMPATIBILITY.md) | [OpenCode V2](docs/opencode-v2.md) |
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
e o [CHANGELOG.md](CHANGELOG.md) para as mudanças da 1.6.0.

## Contribua

Ideias, relatos de bugs, melhorias de documentação e contribuições de código são
bem-vindos. Leia o [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir uma issue ou
pull request. Esse arquivo também define a regra de documentação: um único lar
por fato, com uma lista curta de fatos que não devem ser duplicados.

## Citação e DOI

O Pantheon é distribuído sob a [Licença MIT](LICENSE). Cite o
[DOI de conceito do Zenodo](https://doi.org/10.5281/zenodo.22650136), que sempre
resolve para a release arquivada mais recente; cada release também tem seu
próprio DOI de versão. Os metadados de citação estão em
[CITATION.cff](CITATION.cff).

Repositório canônico: <https://github.com/ils15/pantheon-opencode>

---

[Read in English](README.md)
