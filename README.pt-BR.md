# Pantheon

**Uma forma mais clara de trabalhar com OpenCode em projetos reais.** O
Pantheon reúne planejamento, implementação, revisão e documentação em uma
experiência guiada. É um plugin e instalador para OpenCode, feito para pessoas
e equipes que querem mais estrutura sem perder o controle do próprio código.

[English](README.md) ·
[Repositório](https://github.com/ils15/pantheon-opencode) · [Licença MIT](LICENSE)

[![Versão](https://img.shields.io/github/v/release/ils15/pantheon-opencode?label=versão)](https://github.com/ils15/pantheon-opencode/releases/tag/v1.5.0)
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

Versão atual: **v1.5.0**. O Pantheon foi feito para OpenCode e depende da
disponibilidade e da configuração do OpenCode e dos serviços opcionais que você
escolher. Veja as [releases](https://github.com/ils15/pantheon-opencode/releases)
e o [changelog](CHANGELOG.md) para acompanhar as mudanças.


## Novidades da 1.5.0

- Instalador exclusivo para OpenCode: guias de plataformas consolidados em um
  único [guia OpenCode](docs/platforms/opencode.md).
- Novo CLI `uninstall` com escopos project/global e checagem de ownership:
  `node scripts/uninstall.mjs --project|--global [--dry-run] [--force]`.
- Recursos MCP endurecidos: correção do `pantheon://agents` e proteção contra
  symlink/traversal nos caminhos de recursos.
- Compatibilidade com OpenCode V2: merge de configuração `plugins` /
  `mcp.servers.enabled` e launch stdio MCP com PWD correto.
- `doctor` e health checks de instalação expandidos.
- A flag `--prompts` do instalador está planejada para uma release futura.

## Releases beta

Um pull request com o label exato `release:beta` aciona o fluxo de release beta. Consulte [docs/RELEASING.md](docs/RELEASING.md) para detalhes de validação e recuperação.

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

O Pantheon é distribuído sob a [Licença MIT](LICENSE). Para o registro publicado
da v1.4.3, use o [DOI do Zenodo](https://doi.org/10.5281/zenodo.22306637); os
metadados de citação também estão em [CITATION.cff](CITATION.cff).

Repositório canônico: <https://github.com/ils15/pantheon-opencode>

---

[Read in English](README.md)
