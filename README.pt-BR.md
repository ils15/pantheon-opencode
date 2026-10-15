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
Quando você pede um plano ou inicia `/pantheon-deepwork`, Athena devolve o plano
completo para Zeus, que o apresenta na conversa principal antes de pedir
aprovação. O pedido de aprovação não ficará separado de um plano escondido na
conversa de um subagente.

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

Versão operacional neste checkout: **v1.6.0-beta.1** (primeira beta compatível
com OpenCode 2; esta página não afirma publicação). O Pantheon foi feito para OpenCode e depende da
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
| Registro Pantheon | `src/plugin.ts` mais `src/plugins/pantheon-hooks.ts` | `pantheon-opencode/plugin-v2` (`src/plugin-v2.ts`) |
| Contrato de runtime | Plugin Pantheon V1: 6 ferramentas (`hashline_edit`, as 3 ferramentas de goal, `pantheon_cost`, `pantheon_model`), hooks de evento/ferramenta e tratamento de compactação V1 | Plugin V2 completo: 3 ferramentas de orquestração mais `vision_describe` quando o catálogo de modelos está disponível, 5 assinaturas de eventos, session hooks (`prompt`, `context`), um hook `execute.before` que impõe sessões somente-leitura, além de transforms de configuração |
| APIs V1 | Registradas | Definições próprias de ferramentas via `ctx.tool.transform()` — não pelo caminho do plugin V1 |

O plugin V2 fornece 3 ferramentas de orquestração (`hashline_edit`,
`pantheon_cost`, `pantheon_model`), 4 assinaturas de eventos (`session.created`,
`session.idle`, `session.error`, `session.compacted`), session hooks (`prompt`,
`context`) e um hook de ferramenta `execute.before` que impõe sessões
somente-leitura. As 3 ferramentas de goal **não** são
registradas no V2: o goal loop precisa de um `GoalStore`, de um
`GoalLoopClient` e de um `BackgroundJobBoard`, nenhum dos quais o
`PluginContext` do V2 expõe, então a lacuna é reportada como o marcador de
recurso sem suporte `goal-tools`. Use o contrato V1 se precisar do goal loop.

O V2 também registra `vision_describe` quando `ctx.model.list()` está
disponível. A ferramenta verifica a entrada de imagem no catálogo atual,
prioriza o modelo pago `opencode-go/mimo-v2.6-flash` (modelos free-tier são
excluídos da seleção automática — o gateway direto os rejeita com HTTP 403, só
funcionam de dentro do OpenCode; um pin explícito em
`PANTHEON_VISION_MODEL`/config/preset continua sendo honrado, então seu 403 vira
um erro acionável em vez de uma troca silenciosa) e envia a imagem
diretamente ao endpoint autenticado do OpenCode Zen. A requisição carrega o
session id vivo no header Zen-only `x-opencode-session` exigido pelo gateway
(nunca enviado a um provider não-Zen, e nunca logado). As credenciais vêm de
`opencode auth login` ou `PANTHEON_OPENCODE_API_KEY`; sem modelo compatível ou
credenciais, a ferramenta retorna um erro explícito em vez de inventar uma
descrição. Esse caminho funciona sem a ponte V1 opcional.
O hook de prompt V2 também preserva as referências dos anexos e orienta Zeus a
inspecionar imagens relevantes e repassar a referência e observações concisas a
Aphrodite. Bytes inline não são copiados para o texto persistido do prompt, e a
imagem não autoriza apagar nem reverter alterações fora do escopo.

O caminho nativo do turno de chat escolhe o modelo de visão numa precedência
fixa: a variável `PANTHEON_VISION_MODEL`, depois `visionModel` em
`opencode-vision.json`, depois `vision.model` do preset ativo, depois descoberta
automática no catálogo de providers do host (`GET /config/providers`) e, por
fim, o padrão embutido. A descoberta é conservadora e somente paga: mantém
apenas entradas com imagem (`capabilities.input.image`) cujo provider é Zen
confiável ou cujo pacote `npm` é OpenAI-compatível (`@ai-sdk/openai-compatible` /
`@ai-sdk/openai`), EXCLUI entradas free-tier (`-free` ou `cost.input <= 0` — o
gateway direto as rejeita com HTTP 403), escolhe a entrada mais barata restante
e faz cache do catálogo por 60
segundos por processo; um modelo incompatível simplesmente cai no fallback da
tool MCP de visão. A base URL vem do `api.url` da entrada do catálogo, e os
endpoints Zen legados permanecem como fallback quando não há catálogo. As
credenciais seguem o endpoint: para um endpoint Zen, as variáveis compartilhadas
`PANTHEON_OPENCODE_API_KEY` / `OPENCODE_API_KEY` são tentadas primeiro e depois o
auth store do OpenCode (o provider resolvido primeiro, depois as entradas legadas
`opencode-go` / `opencode`); para um endpoint não-Zen, apenas a entrada do próprio
provider no auth store é usada — as variáveis compartilhadas e as entradas Zen
legadas nunca são anexadas a uma base URL não-Zen. Um modelo de visão
configurado explicitamente e qualificado sempre vence a descoberta — um pin que
não qualifica (não-Zen, text-only ou fora do catálogo) é descartado e a seleção
automática assume. O `pantheon-opencode init` oferece um
passo opcional de vision em sessões TTY interativas — a descoberta automática é
o default e não grava nada; pinar faz merge de `visionModel` no
`opencode-vision.json` global; fluxos não-interativos nunca perguntam nem gravam.

A pergunta do usuário é injetada no prompt de visão nos caminhos nativo e V2,
aparada e limitada a 2000 caracteres; a mesma imagem com uma pergunta diferente
gera nova descrição, enquanto uma repetição idêntica dentro do TTL de cache
reutiliza o texto guardado. O describe nativo é robusto por construção: o
timeout escala de uma base de 20 segundos a cerca de 10 segundos por MB de
payload até um teto de 300 segundos, e uma checagem de orientação EXIF sem
dependências (JPEG) adiciona uma dica textual para o vision model descrever a
imagem rotacionada ou espelhada na posição correta — só detecção, os pixels
nunca são reescritos, e a orientação entra na chave do cache.

A visão degrada numa cadeia explícita — nativa → tool MCP de visão → local.
Quando a nativa está indisponível e a tool MCP de visão não está presente, a
imagem é substituída por extração local determinística: dimensões, formato e
tamanho do header PNG/JPEG/GIF/WebP, cores dominantes para PNG RGB/RGBA e OCR
somente quando o binário `tesseract` está no `PATH`. Nunca fabrica conteúdo — a
degradação é declarada explicitamente. As tools `vision_describe` e `vision_ocr`
do MCP degradam para esse modo local quando não há credencial de gateway, sem
dependências novas. (A `vision_analyze` exige credencial de gateway e retorna um
erro explícito.) Trade-offs deliberados, registrados para não serem
revertidos por acidente: o Pantheon descreve cada imagem uma vez e mantém o
texto no histórico (council 2026-08-03) em vez de preservar a imagem original
para re-observação a cada turno; o describe-always prioriza latência zero em vez
de uma tool `describe_image` sob demanda. A sanitização multi-turno
(`experimental.chat.messages.transform`) é invariante obrigatória — garante que
`image_url` / `FilePart` nunca cheguem a um provider textual e não é
configurável. O Bifrost permanece opt-in, nunca padrão, conforme o incidente de
credencial em [SECURITY.md](SECURITY.md).

O hook `execute.before` do V2 é o ponto de imposição de sessões somente-leitura
dessa superfície: o host inclui o agente ativo no evento, um agente somente-leitura
(`apollo`, `gaia`) registra sua sessão, e o `createEnforcementGuard`
compartilhado lança para negar `edit`, `write`, `bash`, `task`,
`hashline_edit` e `pantheon_model`. Ele **não** depende do hook
`tool.execute.before` do V1, que vive em `src/plugin.ts` e não é carregado
quando apenas `plugin-v2` está configurado. Quando o host registra o hook
`permission.evaluate`, ele aplica no V2 a matriz caller/target a todos os itens
do array `resources` do host para destinos gerenciados pelo Pantheon. Sem o
registro do hook, a matriz não fica disponível e o host mantém o controle.
Recursos exclusivamente nativos são repassados sem alteração à política de
permissões do OpenCode; pedidos mistos (nativos/Pantheon) ou com vários destinos
são negados.
Para destinos Pantheon, a política exige uma chamada nativa `subagent` cujo
session ID, message ID e tool-call ID no `source` coincidam com o evento do host
`tool.execute.before`; também confirma que a sessão não tem `parentID`. O campo
`permission.evaluate.agent`, sozinho, não identifica o chamador. Origins
ausentes, expirados, repetidos ou incompatíveis são negados. A canary no
OpenCode v2.0.29 admite Zeus→Apollo na raiz e nega dispatches inválidos ou
originados em uma filha; veja o [relatório de F4A](bench/results/f4a-v229-admission-identity-2026-10-14.md).
Uma negação explícita do host é final, e dados de recursos ausentes ou
desconhecidos são negados por padrão. O `execute.after` do
V2 executa a cadeia de resultados concluídos `task-result-guard` →
`context-sandbox` → `read-enhancer`; eventos de erro permanecem inalterados.

#### Leitura bounded do workspace (F3b)

No OpenCode v2.0.29, o plugin V2 pode registrar `pantheon_bounded_read` quando
o host oferece as APIs nativas de permissão e sessão. Só uma sessão root do
Zeus pode usá-la. Cada chamada pede ao host permissão `read` para um arquivo
relativo exato do workspace, com escopo de persistência vazio; o conteúdo só é
lido após aprovação e passa pelo scanner de segredos fail-closed existente.
Os limites são duas chamadas e dois arquivos distintos, 400 linhas e 32 KiB
por mensagem do assistant. Travessia de diretórios, symlinks, diretórios,
escopos sensíveis, formatos binários/mídia reconhecidos e falhas do scanner são
negados. O escopo suportado é um workspace local sem escritores concorrentes;
isso não promete isolamento contra filesystem adversarial nem classificação
binária do arquivo inteiro. Evidência host-backed:
[`bench/results/f3b-v229-bounded-read-2026-10-15.md`](bench/results/f3b-v229-bounded-read-2026-10-15.md).

Toda ferramenta V2 declara um schema `output`. O OpenCode 2.0.x exige que a
declaração e o resultado resolvido concordem nos dois sentidos, então uma
ferramenta sem declaração — ou que retorne `output` sem declará-lo — falha em
toda chamada. Os recursos V2 sem suporte são `legacy-hooks` (a superfície de
hooks específica do V1), `catalog-transform`, `integration-transform`,
`skill-transform` e `goal-tools`.

O pacote expõe os dois contratos como exports importáveis:
`pantheon-opencode/plugin` (V1), `pantheon-opencode/plugin-v2` (V2) e
`pantheon-opencode/v2-bridge` (interop opcional), para que o host carregue
explicitamente o contrato desejado.

A ponte V1→V2 (`src/pantheon/v2-bridge.ts`) habilita interop opcional:
singletons de infraestrutura V1 (BackgroundJobBoard,
GoalStore, TodoEnforcer, VisionHandler) são repassados via `ctx.options` do V2.
A ponte é opcional — o V2 funciona standalone com degradação graciosa.

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
# Sem instalação global, SEMPRE fixe o dist-tag — `npx pantheon-opencode`
# puro resolve a tag `latest`, que é o release estável (1.4.3):
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
  você nunca precisa re-rodar `init` só para atualizar arquivos. O config dir
  global recebe o **artefato global** agnóstico de repositório
  (`AGENTS.global.md`: tabela de agentes + regras compartilhadas), enquanto o
  `AGENTS.md` de cada projeto carrega apenas o setup específico do projeto —
  os dois são esculpidos para serem disjuntos (trabalho de latência beta-10),
  então nenhuma regra é paga duas vezes por sessão. A instalação é
  conservadora: conteúdo fora da região gerenciada (regras próprias do
  usuário) é preservado verbatim, um `AGENTS.md` legado totalmente gerado é
  atualizado in place, e qualquer merge é reportado com um aviso.
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

Se a seção de uma versão candidata já existir, atualize as notas com
`node scripts/versioning.mjs changelog <versão>`; o comando mescla `[Unreleased]`
na versão indicada sem avançar o número do pacote.

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

## Benchmark de latência (bench/)

O `bench/` mede a latência de sessão de ponta a ponta do CLI `opencode`
instalado com o plugin V2 do repositório — o baseline contra o qual toda
mudança de performance de uma release deve ser comparada. Executa dois
cenários N vezes cada, intercalados (não-interativo, um diretório de sandbox
novo por run), coleta métricas por run do `opencode.db` em modo READ-ONLY
(tokens root + sessões filhas sem dupla contagem, tool calls por nome, número
de sessões filhas) e tempos de hook das linhas `[bench]` que o plugin anexa ao
`hooks.log`:

```bash
node bench/bin/bench.mjs            # 5 runs por cenário (A e B), ~1h
BENCH_MODEL=opencode-go/glm-5.3-flash node bench/bin/bench.mjs   # fixar modelo
node bench/bin/bench.mjs --runs 1   # smoke: um run por cenário
```

Os resultados vão para `bench/results/<label>-<git-sha>.json` (mediana +
p80 + falhas por cenário); o label padrão é `baseline` e o harness recusa
sobrescrever um resultado existente, então a identidade do run fica no nome do
arquivo. O cenário A faz pesquisa web real, então a variância de rede é
registrada por run.

### Perfis de medição (explícitos, nunca inferidos)

As instruções são injetadas por duas superfícies: o diretório de config global
e o diretório do projeto. O harness declara qual delas exercita, porque um
resultado só significa algo no perfil onde a mudança atua:

| `--profile` | `AGENTS.md` global | `AGENTS.md` de projeto | Uso |
|---|---|---|---|
| `host` (padrão) | diretório de config do host (ou `--global-agents`) | nenhum — run dirs ficam vazios | a injeção real do host, sem alteração |
| `double-injection` | diretório de config do host (ou `--global-agents`) | `--project-agents`, escrito em cada run dir | o perfil no repo onde global+projeto se sobrepõem |

O padrão mede os cenários A e B. Use `--scenarios B` para isolar o claim
one-shot de F1; o cenário selecionado ainda roda N vezes (`--runs 5` por
padrão).

```bash
# braço candidato: artefato global carveado + artefato de projeto carveado
node bench/bin/bench.mjs --runs 5 --scenarios B --profile double-injection \
  --global-agents AGENTS.global.md --project-agents AGENTS.md --label f1-candidate
```

Cada braço registra, por run e lido do banco, a identidade (caminho, bytes,
sha256) de cada arquivo de instrução que a sessão de fato carregou
(`instruction_state` + `instruction_blob`) — a prova de fidelidade de que o
que foi medido é o que foi gerado. Um claim só pode se apoiar num run cuja
provenance mostre que os artefatos global **e** de projeto pretendidos foram
carregados.

### Sinal vs ruído

Wall time é pista, não critério: o spread same-day chega a ~8× no cenário A e
~13× no B. Um efeito só é **confirmado** quando excede o spread same-day (ou
exige N maior); caso contrário é registrado como **inconclusivo**. Prefira
medianas de tokens, bem mais estáveis. O wall do cenário A não é métrica de
claim — ele faz pesquisa web real, então a variância de rede domina.

### Proxy do 1º request e evidência de F1

O payload de instruções injetado só incide no primeiro request, então o
`tokens.input` total da árvore (somado em todo turno) é dominado pela variância
de duração da sessão. Cada run também registra `firstRequest` — o
`tokens.input` + `tokens.cache.read` da primeira linha assistant — o proxy que
isola o payload.

Uma rodada intercalada no OpenCode v2.0.29 (C1/K1…C5/K5, N=5/braço) mediu o
contexto do 1º request em 17555 tokens no controle e 15489 na candidata
(**−2066, −11,8%**; spread intra-braço de 14 tokens em cada braço). D4 confirmou
22350 B carregados no controle e 13400 B na candidata (−8950 B, −40,0%); o
oráculo pré-registrado passou em 5/5 nos dois braços. O efeito no primeiro
request está confirmado contra o spread intra-braço; a aceitação final de F1
aguarda revisão do Themis. O input total da árvore caiu da mediana de 47594 para
38253 tokens, mas os ranges se sobrepõem e a hipótese de ≤30k não foi atingida.
As medianas de wall foram 30,078 s e 24,130 s, com spread alto; input total e
wall permanecem **inconclusivos**. Não há claim de ganho de wall ou custo
monetário. Detalhes e artefatos por run:
`bench/results/f1-di-v229-interleaved-2026-10-14.md`. O par sequencial anterior
permanece somente como evidência de apoio em
`bench/results/f1-di-v229-clean-2026-10-14.md`. As rodadas exploratórias
anteriores foram preservadas separadamente em
`bench/results/f1-double-injection.md` e
`bench/results/f1-di-v229-preliminary-2026-10-14.md`.


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
