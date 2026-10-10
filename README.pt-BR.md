# Pantheon

**Uma forma mais clara de trabalhar com OpenCode em projetos reais.** O
Pantheon reúne planejamento, implementação, revisão e documentação em uma
experiência guiada. É um plugin e instalador para OpenCode, feito para pessoas
e equipes que querem mais estrutura sem perder o controle do próprio código.

[English](README.md) ·
[Repositório](https://github.com/ils15/pantheon-opencode) · [Licença MIT](LICENSE)

[![Versão](https://img.shields.io/github/v/release/ils15/pantheon-opencode?label=versão)](https://github.com/ils15/pantheon-opencode/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/ils15/pantheon-opencode/ci.yml?branch=main&label=CI)](https://github.com/ils15/pantheon-opencode/actions)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22650136.svg)](https://doi.org/10.5281/zenodo.22650136)

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

Requisitos: [OpenCode 1.18.4+](https://opencode.ai/docs/) e Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`.

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
Perguntas sem mudança no repositório são respondidas diretamente; correções
pequenas usam uma única delegação. Discovery, planejamento, paralelismo e
revisão em council ficam para quando o escopo ou o risco justificarem.

Para uma correção pequena e bem delimitada, chame `@talos` diretamente (por
exemplo, `@talos corrija este typo`). Assim você pula a chamada de orquestração
do Zeus; use `/pantheon` para planejamento, delegação, mudanças em vários
arquivos ou gates de qualidade.

O procedimento completo de council só é carregado em `/pantheon` ou quando uma
decisão material realmente exige perspectivas distintas. Falhas de dispatch
podem ser tentadas novamente uma vez; testes reprovados e recusas não são
repetidos automaticamente.

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

Versão candidata neste checkout: **v1.6.0 estável** (manifestos preparados;
publicação ainda não confirmada). O histórico das betas permanece no
[changelog](CHANGELOG.md). O Pantheon foi feito para OpenCode e depende da
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

O code-mode resolve primeiro o projeto: `.opencode/.pantheon/code-mode` vem
antes de `.pantheon/code-mode`. `PANTHEON_PROJECT` sobrescreve o diretório de
trabalho, e o MCP instalado usa `cwd: "."` para receber o workspace do
OpenCode. O diretório global só é usado sem um diretório de projeto utilizável;
depois de selecionar um diretório de projeto, manifest ausente ou corrompido
falha fechado, sem fallback silencioso. O `doctor` valida o manifest e o
SHA-256 de cada script sem regenerá-lo.


## Novidades da 1.6.0-beta.1

- Primeira beta compatível com o contrato de plugin do OpenCode 2.
- Remoção do pipeline legado de vector-memory, preservando a busca por palavras-
  chave SQLite FTS5/BM25 e as ferramentas de codemap `code_*`.
- Validações de CI e release fail-closed; `doctor` e o sandbox exclusivo V2
  cobrem o caminho de instalação do OpenCode 2.

## OpenCode V1/V2 — Versão dupla (1.6.0-beta.1)

Esta é a primeira beta compatível com o OpenCode 2. O Pantheon tem dois contratos de plugin OpenCode **exclusivos**. A configuração
comum do OpenCode pode ser compartilhada, mas o registro do plugin Pantheon é
selecionado por instalação; os plugins Pantheon V1 e V2 nunca devem ser
registrados juntos.

| | V1 | V2 |
|---|---|---|
| Chave de config do OpenCode | `plugin` singular | `plugins` plural |
| Registro Pantheon | `src/plugin.ts` mais `src/plugins/pantheon-hooks.ts` | pacote npm `pantheon-opencode@<versão>` fixado à versão instalada (export raiz aponta para `src/plugin-v2.ts`) |
| Contrato de runtime | Plugin Pantheon V1: 6 ferramentas (`hashline_edit`, as 3 ferramentas de goal, `pantheon_cost`, `pantheon_model`), hooks de evento/ferramenta e tratamento de compactação V1 | Plugin V2: 3 ferramentas (`hashline_edit`, `pantheon_cost`, `pantheon_model`), 5 assinaturas de eventos, session hooks (`prompt`, `context`), hooks de execução/permissão e transforms de configuração |
| APIs V1 | Registradas | Definições próprias de ferramentas via `ctx.tool.transform()` — não pelo caminho do plugin V1 |

O plugin V2 fornece 3 ferramentas de orquestração (`hashline_edit`,
`pantheon_cost`, `pantheon_model`), 5 assinaturas de eventos (`session.created`,
`session.idle`, `session.deleted`, `session.error`, `session.compacted`), session hooks (`prompt`,
`context`) e um hook de ferramenta `execute.before` que impõe sessões
somente-leitura. As 3 ferramentas de goal **não** são
registradas no V2: o goal loop precisa de um `GoalStore`, de um
`GoalLoopClient` e de um `BackgroundJobBoard`, nenhum dos quais o
`PluginContext` do V2 expõe, então a lacuna é reportada como o marcador de
recurso sem suporte `goal-tools`. Use o contrato V1 se precisar do goal loop.

O hook `execute.before` do V2 é o ponto de imposição de sessões somente-leitura
dessa superfície: o host inclui o agente ativo no evento, um agente somente-leitura
(`apollo`, `gaia`) registra sua sessão, e o `createEnforcementGuard`
compartilhado lança para negar `edit`, `write`, `bash`, `task`,
`hashline_edit` e `pantheon_model`. Ele **não** depende do hook
`tool.execute.before` do V1, que vive em `src/plugin.ts` e não é carregado
quando apenas `plugin-v2` está configurado. O hook `permission.evaluate`
aplica no V2 a matriz caller/target para destinos gerenciados pelo Pantheon,
considerando todos os itens do array `resources` do host. Recursos
exclusivamente nativos são repassados sem alteração à política de permissões do
OpenCode; pedidos mistos (nativos/Pantheon) e com vários destinos são negados,
a menos que todos os destinos Pantheon sejam explicitamente permitidos para o
chamador autoritativo. Uma negação explícita do host é final, e dados de
recursos ausentes ou desconhecidos são negados por padrão. O `execute.after` do
V2 executa a cadeia de resultados concluídos `task-result-guard` →
`context-sandbox` → `read-enhancer`; eventos de erro permanecem inalterados.

Toda ferramenta V2 declara um schema `output`. O OpenCode 2.0.x exige que a
declaração e o resultado resolvido concordem nos dois sentidos, então uma
ferramenta sem declaração — ou que retorne `output` sem declará-lo — falha em
toda chamada. Os recursos V2 sem suporte são `legacy-hooks` (a superfície de
hooks específica do V1), `catalog-transform`, `integration-transform`,
`skill-transform` e `goal-tools`.

Ao migrar uma config V1 com `init --opencode-version v2`, o instalador traduz
`task` para a ação V2 `subagent` e `write` para `edit` (que também cobre as
tools host `write`/`patch`). Se regras legadas `edit` e `write` colidirem no
mesmo recurso, a migração preserva o efeito mais restritivo. Configs V2
editadas manualmente devem usar o array nativo `permissions` com
`action`/`resource`/`effect`.

O pacote expõe os dois contratos: a raiz e `pantheon-opencode/plugin-v2`
carregam V2; `pantheon-opencode/plugin` carrega V1. `pantheon-opencode/v2-bridge`
é atualmente apenas uma utility importável: o setup de produção não a conecta
ao plugin V2, então ela não fornece interoperabilidade em runtime nem restaura
as ferramentas de goal/board do V1.

Selecione o contrato explicitamente na instalação:

```bash
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2
npx pantheon-opencode init --opencode-version auto
```

`auto` é o padrão. `--version v1|v2|auto` é aceito como a grafia antiga do seletor
quando usado depois de `init`. `auto` resolve a geração a partir do host nesta
ordem: um `OPENCODE_VERSION=v1|v2` explícito vence; caso contrário, um
`OPENCODE_BIN` terminando em `opencode2` seleciona V2; caso contrário o binário
do host é consultado com `--version` e uma major >= 2 seleciona V2. Qualquer
outro caso — uma sonda ilegível, um banner não interpretável, ou um banner
cujos tokens de versão se contradizem sem um nome de ferramenta que desfaça o
empate — avisa uma vez e volta para V1, porque uma entrada de diretório em
`plugins` plural em um host 1.x desconhecido perde o plugin inteiro.

A sonda prefere o token que vem logo após o nome da ferramenta, então um token
de runtime antes dele (`node v22.1.0 (opencode 1.18.33)`) ou uma data de build
no final (`opencode v1.18.33 built 2026.10.04`) não conseguem virar a geração.
O instalador remove referências Pantheon das duas formas de config antes de
gravar apenas o registro Pantheon selecionado. Entradas de terceiros não são
convertidas nem reivindicadas por essa regra.

O relatório `pantheon_cost`, disponível nos plugins V1 e V2, resolve o banco por
CAMINHO, nesta ordem: um `dbPath` explícito fornecido pelo chamador da
ferramenta, depois `PANTHEON_COST_DB=/caminho/absoluto/para/opencode.db`,
depois `OPENCODE_DB`, e por fim o padrão do XDG `opencode.db`. Não há nome de
arquivo por versão nessa cadeia: `opencode-v2.db` não é um banco de um host 2.x
— é o nome que um sandbox dá ao próprio banco de estado via `OPENCODE_DB`.

A distinção v1/v2 é o SCHEMA DETECTADO, não o nome do arquivo. O relatório
procura as tabelas `message` e `session_message` e lê aquele que o banco aberto
realmente tiver, porque um banco migrado carrega as duas famílias ao mesmo
tempo. `PANTHEON_OPENCODE_VERSION=v1|v2` não seleciona arquivo nenhum: apenas
estreita um conjunto já detectado para uma família de tabelas, e falha rápido
quando o valor não é `v1` nem `v2` ou quando a família pedida não existe lá.
Sem a variável, todas as famílias detectadas são lidas. Um banco sem nenhuma
das duas tabelas volta como erro acionável (`CORRUPT_DATA`), e um ledger que
existe mas não produz tokens legíveis como `UNSUPPORTED` — nunca como um
relatório vazio com sucesso.

O instalador continua gravando as configurações de compatibilidade exigidas
pelo host OpenCode selecionado, como `experimental.subagent_depth`; isso não
converte um plugin V1 em V2 nem dá hooks V1 ao V2.

O Pantheon não define mais um teto de passos para os agentes. No OpenCode 2 o
campo `steps` é opcional e não tem default: ausente significa que o host não
aplica nenhum limite nativo. Uma config escrita antes dessa mudança ainda
carrega o valor antigo, e o caminho de instalação v2 o remove de todos os
agentes que o Pantheon gerencia — um agente definido por você nunca é tocado,
e o bloco V1 singular `agent`, em retirada, é deixado intacto. Rode o
instalador uma vez para limpar um valor antigo de uma config existente:

```bash
npx pantheon-opencode init --opencode-version=v2
```

O controle de contexto não é uma configuração do Pantheon. Qualquer orçamento
que um agente terá vem das settings de compactação do próprio host OpenCode,
e o Pantheon não as define.

Quando um bloco V1 `agent` e um bloco V2 `agents` coexistem — o que acontece
em qualquer `opencode.json` já instalado — a conversão V1→V2 mescla os dois em
vez de deixar um substituir o outro. O bloco V2 é a base, os campos
gerenciados que vêm do V1 sobrescrevem, e os seus próprios campos são
preservados, com a mesma precedência que o instalador já aplica em outros
pontos. A ordem das chaves não muda o resultado.

## Atualizando entre releases (beta.5+)

Um comando mantém uma instalação existente em dia:

```bash
# Sem instalação global, fixe o dist-tag desejado. `latest` aponta para a
# release estável publicada mais recente, não para um candidato não publicado:
npx pantheon-opencode@beta update            # canal beta do npm + refresh do config
npx pantheon-opencode@beta update --stable   # canal estável

# Com instalação global, use o bin global (o padrão é o canal beta):
pantheon-opencode update
```

O `update` compara a versão instalada com o dist-tag do npm, roda
`npm install -g pantheon-opencode@<canal>` e re-executa `init --yes
--headless` para alinhar merge de config, venv e entradas de MCP com o novo
pacote. Duas garantias de freshness sustentam isso:

- **Sync de artifacts no postinstall** — depois de qualquer `npm install`, os
  artefatos de cópia (agents, skills, AGENTS.md, commands, scripts MCP,
  payload code-mode) são atualizados automaticamente no config dir existente;
  você nunca precisa re-rodar `init` só para atualizar arquivos.
- **Detecção de drift** — o instalador grava a versão instalada em
  `.pantheon/install-state.json` e o `doctor` avisa quando o pacote é mais
  novo que o último sync, apontando para o `update`.

O `init` também ganhou `--components agents,skills,...` (instalação enxuta),
`--clean` (alias de `--force`), `--opencode-version auto`, escrita atômica do
config com backup em `opencode.json.bak`, pré-checagens de python3/npm antes
de escrever qualquer arquivo e runtime Python não-fatal: se a venv falha, a
instalação completa mas as entradas MCP ficam de fora (com aviso) em vez de
apontar para um interpretador quebrado.

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

## Validação em sandbox (V2)

O `scripts/test-opencode-v2-sandbox.sh` valida o pacote instalado
globalmente como um usuário real dentro de um sandbox isolado (com `HOME`,
prefix npm e venv próprios) — nunca o ambiente de desenvolvimento. Ele verifica
a perna OpenCode V2: o binário, conectividade MCP, `doctor` e — com
`--prompts` — uma bateria de prompts cobrindo o recurso `pantheon://agents`,
memory store/recall, escrita no filesystem e delegação de agente. O gate é
fail-closed: todo check obrigatório precisa terminar em PASS explícito;
timeout, falha de auth/rede/provider e pré-requisitos ausentes bloqueiam a
execução.

"V2" aqui se refere somente ao canário de hooks observado em um host OpenCode
v2.0.18, no qual ao menos um callback testado foi disparado; isso não
estabelece compatibilidade com o SDK estável `@opencode/plugin@2.0.18` nem com
o contrato 2.x completo. Esta branch ainda fixa a dependência transitória
`@opencode-ai/plugin@1.18.30`. Em hosts com `opencode` e `opencode2`, este
último costuma ser um shim que executa o mesmo binário; a comparação lado a
lado anterior, portanto, não provava nada sobre o binário em si. O projeto é
exclusivo V2, portanto há uma única perna.

```bash
scripts/test-opencode-v2-sandbox.sh --prepare     # tarball + install + init no sandbox
scripts/test-opencode-v2-sandbox.sh --run v2      # apenas validação base
scripts/test-opencode-v2-sandbox.sh --prompts     # validação base + bateria de prompts
scripts/test-opencode-v2-sandbox.sh --rehydrate   # sondas offline de rehydration/summary de sessão
scripts/test-opencode-v2-sandbox.sh --hooks       # canário de callbacks de hooks V2
scripts/test-opencode-v2-sandbox.sh --rehydrate --hooks # executa os dois canários
scripts/test-opencode-v2-sandbox.sh --reset       # limpa a raiz do sandbox
```

Os modos são combináveis (ex.: `--prepare --run v2 --prompts`). `--rehydrate`
executa sondas offline de `context_rehydrate` e `context_session_summary`.
`--hooks` executa um canário de hooks V2 com o binário do sandbox para verificar
se os callbacks de hooks são disparados; ele não testa os efeitos dos callbacks
de transform nem comprova o enforcement de segurança `execute.before` do
Pantheon. Com o par de sondas `--rehydrate --hooks` (sem `--run`, `--prompts` ou
`--cost`), o canário de hooks ainda é executado se a rehydration falhar, e o
comando retorna falha em seguida. Esses canários de teste/sandbox não são prova
de enforcement de segurança do Pantheon. Os binários são resolvidos estritamente
dentro do prefix npm do sandbox — um sandbox não preparado falha rápido em vez
de testar silenciosamente a instalação do host.

Isso valida somente o sandbox isolado e preparado. Um PASS não prova suporte
para todo host real nem para configurações de host que não foram exercitadas.

## Cobertura TypeScript do Plugin V2

`npm run coverage:plugin-v2` executa a suíte `tests/pantheon/*.test.ts` com a
cobertura nativa do Node habilitada para source maps e exige pelo menos 80% de
cobertura de linhas somente para `src/plugin-v2.ts`. Requer Node `v24.15.0`;
coberturas de branches e funções são informativas, não gates. Isso não é uma
alegação de cobertura do repositório inteiro.

Variáveis de ambiente:

| Variável | Padrão | Finalidade |
|----------|---------|---------|
| `PANTHEON_SANDBOX_ROOT` | `~/pantheon-sandbox` | Raiz do sandbox (recusada se insegura para `--reset`) |
| `OPENCODE_V1_SPEC` | `opencode-ai@1.18.18` | Configura somente o plugin V1; o runner de sandbox exclusivo V2 não consome nem oferece suporte a essa variável |
| `OPENCODE_V2_SPEC` | `@opencode-ai/cli@beta` | Spec npm que fornece o binário `opencode2` |
| `PANTHEON_SANDBOX_MODEL` | `opencode-go/mimo-v2.5` | Modelo usado pelo init e pelos prompts |
| `PANTHEON_PROMPT_TIMEOUT` | `300` | Timeout por prompt em segundos |

Códigos de saída: `0` sem falhas reais · `1` falha real (veja
`prompts-report.md` na raiz do sandbox) · `2` erro de uso · `3` sandbox não
preparado.

### Divergência intencional do memory MCP

`scripts/memory_mcp.py` e `src/mcp/memory_mcp.py` são
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

O Pantheon é distribuído sob a [Licença MIT](LICENSE). Cite o
[DOI conceitual do Zenodo](https://doi.org/10.5281/zenodo.22650136), que sempre
resolve para a última release arquivada; cada release também tem seu próprio
version DOI. Os metadados de citação também estão em [CITATION.cff](CITATION.cff).

Repositório canônico: <https://github.com/ils15/pantheon-opencode>

---

[Read in English](README.md)
