<h1 align="center">Pantheon</h1>

<p align="center">
  <strong>Orquestração multiagente para OpenCode.</strong><br>
  Planeje, implemente, revise e documente software com agentes especializados,
  memória persistente e gates explícitos de qualidade.
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/ils15/pantheon-opencode/releases/tag/v1.4.3">v1.4.3</a> ·
  <a href="LICENSE">Licença MIT</a>
</p>

## O que ele faz

Pantheon é um plugin e instalador para OpenCode que coordena 14 agentes
especializados. Zeus orquestra o trabalho, enquanto planejamento,
implementação, revisão, memória e operações do GitHub são atribuídos a agentes
focados, em vez de um único contexto generalista.

O repositório contém atualmente 21 skills reutilizáveis e 7 definições de
comandos slash. Essas contagens vêm de `src/agents/`, `src/skills/` e
`commands/`.

## Início rápido

Requisitos: Node.js 18+, OpenCode 1.18.4+ e Python 3.11+ quando os servidores
MCP estiverem habilitados.

```bash
cd seu-projeto
npx pantheon-opencode init
npm run doctor
opencode
```

Para configurar MCP, execute `npm run setup`. Consulte o
[guia de instalação](docs/INSTALLATION.md) para opções interativas e headless.

## Documentação

- [Instalação](docs/INSTALLATION.md) · [Início rápido](docs/QUICKSTART.md)
- [Referência de agentes](docs/agents/README.md) · [Referência de skills](src/skills/README.md)
- [Arquitetura](docs/ARCHITECTURE.md) · [Ferramentas MCP](docs/mcp-tools.md)
- [Releases](docs/RELEASING.md) · [Contribuição](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

O README em inglês é a documentação canônica; este arquivo oferece uma visão
geral em português e aponta para os mesmos guias detalhados.

## Releases beta

Um pull request com o label exatamente `release:beta` aciona o fluxo beta do
workflow `Release`. Ele publica uma pré-release no npm com a dist-tag `beta` e
uma pré-release no GitHub; pushes comuns não publicam versões beta. A
recuperação beta só ocorre por dispatch explícito com todos os parâmetros
exigidos. Consulte [docs/RELEASING.md](docs/RELEASING.md) para os detalhes.

## Contribuição

Leia [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir um pull request. As
alterações são validadas pela CI; releases estáveis só são publicadas pelo
dispatch explícito do workflow `Release` do GitHub Actions, descrito em
[docs/RELEASING.md](docs/RELEASING.md).

### Integração de releases com o Zenodo

`.github/workflows/zenodo.yml` é executado apenas para um GitHub Release
publicado ou por dispatch manual com confirmação explícita de produção.
Configure o ambiente protegido `zenodo-production` com o segredo
`ZENODO_TOKEN` e as variáveis não secretas `ZENODO_DEPOSITIONS_URL`,
`ZENODO_FILES_URL_TEMPLATE`, `ZENODO_PUBLISH_URL_TEMPLATE` (os endpoints exatos
documentados pela instância Zenodo selecionada, usando `{id}` quando aplicável)
e `ZENODO_CREATOR_NAME`. O workflow não presume endpoints do Zenodo Cloud ou
Sandbox; confirme esses valores na API da instância antes de habilitar o
ambiente. Ele valida a tag e os manifestos, aceita um `CITATION.cff` opcional,
registra o ID do depósito nas notas da release e nunca inventa um DOI.

## Limites do projeto

O Pantheon é um plugin e instalador para OpenCode, não um serviço hospedado de
orquestração. Ele não fornece acesso a modelos, chaves de API, cotas nem
garantias sobre provedores externos e serviços MCP opcionais. Esses serviços
exigem contas, credenciais, disponibilidade e configuração próprias. Agentes
também podem cometer erros; revise o trabalho gerado e mantenha os gates de
qualidade do repositório habilitados.

## Licença e citação

Pantheon é distribuído sob a [Licença MIT](LICENSE). Os metadados de citação
estão em [CITATION.cff](CITATION.cff).

Repositório canônico: <https://github.com/ils15/pantheon-opencode>
