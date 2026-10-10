# 🗺️ Pantheon Roadmap

> **Last updated:** 1.6.0 release-candidate audit (2026-10-10)
>
> **Roadmap reativado.** O plano havia sido zerado em 2026-09-12 a partir de
> validação de código. A validação runtime de 2026-10-04 provou que a
> superfície de tools do plugin estava morta em runtime (P0-1) e que dois
> contratos documentados eram rejeitados pelo servidor (P1-1, P1-2).
>
> **Correção de 2026-10-04, rodada seguinte.** A leitura anterior tratava a
> superfície morta como um **gap passivo** e a atribuía à forma do registro. As
> duas metades dessa leitura foram falsificadas: a forma de registro já era a
> correta e **provadamente carregava**, e o que a derrubou foi uma **regressão
> introduzida pelo installer**. P0-1 foi reescrito nesse enquadramento, o slot
> P0-2 virou tombstone `WITHDRAWN` com a alegação remanescente em P2-10, e dois
> P0 novos entraram (P0-5, P0-6).
>
> **Reconciliação de 2026-10-05.** A causa raiz de P0-1 — os três defaults
> `'v1'` do seletor de geração — foi corrigida pelo PR #202 (`80bac52`,
> 2026-10-04): os defaults passaram a `'auto'` e `auto` ganhou um probe de
> `--version` do host. **P0-1** e **P1-6** estão `CLOSED (code)`. O corpo de
> P0-1 abaixo é o **registro histórico** do defeito (estado pré-#202): as
> citações `arquivo:linha` são as daquele estado e não descrevem o código atual.
>
> **Regra de inclusão (agnosticidade).** Todo item abaixo é uma propriedade do
> **repositório**, reproduzível em qualquer máquina. Não entra aqui nada que
> dependa da configuração de um host, da conta de um usuário, de um endpoint de
> terceiro ou do catálogo momentâneo de um provedor. Onde a evidência original
> foi uma observação de máquina, o item registra o **defeito estrutural** e a
> observação aparece marcada como auditoria datada — ela data a descoberta, não
> um fato durável. Citações `arquivo:linha` foram lidas e re-derivadas contra o
> estado deste branch (pós-PR #204). A exceção é o **registro histórico de
> P0-1**, que descreve o estado **pré-#202** (`80bac52^`) e está marcado como
> tal.
>
> **Reconciliação do candidato 1.6.0 (2026-10-10).** P0-3, P0-5 e P0-6 foram
> fechados por ajustes de diagnóstico, migração de permissões e registro V2
> versionado. P1-12 também foi fechado: a matriz V2 já está implementada em
> `permission.evaluate`; documentação e comentário de código que ainda a
> descreviam como ausente foram corrigidos. P0-4 foi **waivado** como Known
> Issue para a 1.6.0 stable (decisão do mantenedor em 2026-10-10): a oscilação
> de catálogo é comportamento do host OpenCode, fora do escopo deste
> repositório, e já está listada nos Known Issues do CHANGELOG; o harness de
> reprodução fica como follow-up. A validação host-backed segue pendente:
> canário E2E com 403 e TUI interativo com modelo ainda não verificado.

---

## ✅ Contrato atual — entregue e suportado

| Área | Contrato verificável |
|---|---|
| OpenCode V1 | `src/plugin.ts` preserva o plugin V1 **em código**: `hashline_edit`, as 3 goal tools, `pantheon_cost`, `pantheon_model`, BackgroundJobBoard, eventos/tool hooks e compaction hook. Sob um host V2 a entrada `.ts` que essa geração registra é rejeitada; sob um host V1 ela é a superfície. O caso que a derrubava — o seletor de geração escolhendo `v1` contra um host V2 — foi corrigido pelo PR #202 (P0-1, `CLOSED (code)`). |
| OpenCode V2 | A instalação registra `pantheon-opencode@<versão>` sob `plugins`; o export raiz do pacote carrega `src/plugin-v2.ts`. Specs npm versionados são suportados pela documentação oficial do host. O adapter não registra Board nem compaction V1 e não é paridade total de runtime. |
| Installer | Seleciona **uma única** geração (`v1`, `v2` ou `auto`). `v1` registra **arquivos** `.ts` sob a chave singular `plugin`; `v2` registra a versão npm exata `pantheon-opencode@<versão>` sob a chave plural `plugins`. `auto` é o **default** e resolve contra o host, na ordem: explícito > `OPENCODE_VERSION` > `OPENCODE_BIN` casando com `opencode2` > probe de `--version` do host (major ≥ 2 → `v2`) > aviso e fallback `v1`. P0-5 e P0-6 estão fechados nesta rodada; compatibilidade por versão de host continua sendo um gate separado. |
| MCP servers | Os 5 servidores rodam em MCP2.2 + FastMCP 4.0.10, com `httpx==0.28.1` pinado no runtime compartilhado. Fontes canônicas em `src/mcp/*.py`; o installer copia de lá. A cópia `scripts/memory_mcp_server.py` é **intencionalmente divergente** (contrato de memória leve, sem ferramentas de codemap) e essa assimetria é portada por `tests/test_mcp_scripts_sync.py` — é desenho, não drift. |
| TUI | `pantheon-tui` é componente separado, registrado em `tui.json` somente quando `plugins` é instalado. Native tasks exigem origem, relação parent/child e status fornecidos explicitamente pelo host; ausência de Markdown não é autodetecção. |
| Histórico e recuperação | `.pantheon/delegations/` guarda relatórios históricos do antigo engine V1 de delegação (removido em favor do `task()` nativo). Jobs antigos/running não são auto-retomados após restart. |
| Code-mode | Execução de scripts é opt-in via `manifest.json` com SHA-256 por script; resolução project-first (`PANTHEON_PROJECT` → cwd) com fail-closed após seleção; `doctor` valida o manifest sem regenerá-lo. |
| Native tasks no painel | O mirror de children de `task(background=true)` no board compartilhado (singleton globalThis, à prova do double-load npm+repo) está implementado em `src/plugin.ts`, e o painel de Delegations o lê. É um recurso **V1-only**: sob V2 o `src/plugin.ts` não é a superfície, então **não tratar como entrega de paridade V2**. |
| Painel de Delegations v2 | Atividade ao vivo por delegação (`↳ <tool> <resumo>` via message.part), estado `retry` distinto (⟳) e seção `Archived (n)` paginada para relatórios terminais antigos. |
| Update e freshness | `pantheon-opencode update` instala o novo pacote pelo dist-tag e re-roda init; o postinstall sincroniza todos os artefatos de cópia; marker `install-state.json` + `doctor` detectam drift de versão; CI falha se o `dist/` da TUI commitada estiver stale. |
| Installer resiliente | Pré-checagens de python3/npm antes de escrever; `opencode.json` atômico com `.bak`; venv falha → instalação completa sem entradas MCP (aviso); V2 registra um spec npm versionado estável em vez de path de prefixo/cache, e `doctor` compara o pin ao pacote ativo. |
| Estado entregue | Candidato 1.6.0 na branch `release/1.6.0-stable`, PR #225 em draft; sem merge, tag ou publicação. Há correções de release em andamento. |

### Limites que não são promessa de roadmap

- `auto` **não** é autodetecção geral de plataforma/runtime; ele usa os hints
  explícitos documentados em [UPGRADING.md](docs/UPGRADING.md) e, na ausência
  deles, faz um probe de `--version` do binário do host. Sem hint legível nem
  probe interpretável, ele avisa uma vez e cai no fallback `v1` — que não é
  mais o default.
- A classificação de um native task e qualquer continuidade após restart só
  podem ser ampliadas depois de um contrato do host ser demonstrado e testado.
- `plugin-v2` não é um adapter de paridade do runtime V1 e não adiciona hooks
  Pantheon, Board ou auto-resume.

### Validação de orquestração — evidência positiva

Uma run de validação em workspace separado (2026-10-04) mediu o que **funciona**,
para que a lista de defeitos abaixo não seja lida como "tudo quebra":

| Medida | Resultado |
|---|---|
| Dispatches / agentes distintos | 16 / 9 |
| Timeouts | 0 |
| Recusas de escopo | 0 |
| Sucesso | 93,75% |
| Retries necessários | 0 |
| Concorrência máxima | 4 |

- **Resume de sessão funciona.** Reusar uma única `sessionID` três vezes
  preservou 46 medidas de contraste e o histórico de bugs — mais contexto
  preservado do que qualquer prompt conseguiria transportar.
- **A taxa de erro estava em coordenação, não em execução.** Cinco erros de
  orquestração foram cometido e **cada um foi pego por um agente**, não por um
  gate. Nenhum erro chegou a produzir resultado incorreto.
- **O sinal de qualidade mais forte foi recusa honesta.** Cinco agentes
  recusaram trabalho que deviam recusar: aplicar um limite não autorizado,
  corrigir fora de escopo, reportar resultado falso ao descobrir que o próprio
  harness media contra um servidor stale, pontuar um ataque que não conseguiu
  construir, e declarar uma medida de contraste que falhava no próprio design.

Leitura: o que falta são **gates**, não agentes. Três dos cinco erros têm gate
mecânico já mapeado no backlog — limite não autorizado → P1-7 (permissão),
correção fora de escopo → P2-4 (grafo de propriedade declarado), resultado
falso após descobrir que o harness media contra servidor stale → P0-4
(catálogo oscilando). Os outros dois — pontuar um ataque que não se consegue
construir, e declarar uma medida que falha no próprio design — **não têm gate
mecânico possível**; foram pegos por julgamento de agente, e é assim que têm de
ser pegos.

---

## 🔭 Próxima iteração

Vinte e nove itens verificados, ordenados por severidade. Cada item carrega um
marcador `Status:` próprio — nenhum precisa ser inferido.

**Legenda de status.** `CLOSED (doc)` — o defeito era de documentação e foi
corrigido por esta reescrita; nada além do próprio texto depende dele.
`CLOSED (code)` — o defeito foi resolvido por um **PR de código já mergeado**,
não por esta reescrita; a referência nomeia o PR e é datada. `OPEN` — o defeito
persiste e o item continua vivo. `WAIVED` — o mantenedor decidiu
explicitamente conviver com o defeito nesta release, registrado como Known
Issue; o item não bloqueia a publicação, mas continua descrevendo um defeito
vivo e não equivale a fechamento. `WITHDRAWN` — a alegação do registro foi
falsificada por auditoria posterior: o registro vira **tombstone**, preserva o
id e o histórico, e não descreve mais defeito nenhum.

**Escopo desta mudança.** Nenhum defeito de **código** é corrigido neste branch:
a mudança é exclusivamente de documentação. Os itens `CLOSED (doc)` são os
defeitos de documentação que vivem nos arquivos que este branch efetivamente
alterou; o critério é **escopo de arquivo**, não classe de defeito. Os itens
`CLOSED (code)` — P0-1 e P1-6 — foram fechados por um PR de código já mergeado,
`80bac52` (PR #202, 2026-10-04), e não por esta reescrita.

**Rodada de 2026-10-05 (após o PR #204).** O PR #204 fecha **nenhum** item deste
backlog — as três fatias de paridade que ele entregou (relato da redução V2 no
install e no `doctor`, correção da cadeia causal invertida, poda do registro
read-only em `session.deleted`) **não tinham item aqui**. O que a rodada faz é o
contrário: **abre** três itens `OPEN` para o que #204 deixou explicitamente de fora
(P1-12, P2-11, P2-12) e reconcilia contagens e legendas. Ver o registro em
[Histórico](#histórico).

**Reconciliação de 2026-10-05 (P0-1 contra o PR #202).** A rodada anterior, após
#204, não reconciliou P0-1 contra o PR #202 — que já o havia corrigido — e por
isso ele ainda aparecia `OPEN` descrevendo um defeito morto. Esta rodada fecha
**P0-1** e **P1-6** como `CLOSED (code)`, define esse status na legenda e
reconcilia contrato, contagens e âncoras. Ver o registro em
[Histórico](#histórico).

**Contagem.** Um **item** é um registro vivo — `OPEN`, `CLOSED` (de qualquer
tipo) ou `WAIVED`. O tombstone `WITHDRAWN` preserva o id e não conta como item,
porque não descreve trabalho. São 30 registros: 29 itens (4 `CLOSED (doc)`, 6
`CLOSED (code)` — P0-1, P0-3, P0-5, P0-6, P1-6 e P1-12 —, 18 `OPEN` e 1
`WAIVED` — P0-4) e 1 tombstone,
**P0-2**, cuja alegação remanescente vive em **P2-10**.

**P0-1 — Regressão: uma run do installer desregistrou a entrada V2 que
carregava.**
**Status: CLOSED (code) — corrigido pelo PR #202 (`80bac52`, 2026-10-04).**
**Corrigido.** Os três defaults `'v1'` viraram `'auto'`:
`bin/pantheon-init.mjs:427`, `scripts/install/opencode.mjs:528` e a assinatura
do resolver (`scripts/install/opencode-version.mjs:213`). `auto` passou a
consultar a versão do host (`probeHostVersion`,
`scripts/install/opencode-version.mjs:44-55`), com precedência
`explícito > OPENCODE_VERSION > basename opencode2 > probe > warn-and-fallback-v1`
(`scripts/install/opencode-version.mjs:213-288`). Sob um host 2.x, `auto`
resolve `v2` e a entrada de diretório que sempre carregou volta a ser
registrada. O limite do conserto — 3 tools, não 6, e sem o Board — está abaixo.

**Registro histórico (estado pré-#202).** O texto abaixo é o registro datado do
defeito: descreve o código como estava **antes** da correção. Em particular, as
três citações do seletor — `bin/pantheon-init.mjs:425`,
`scripts/install/opencode.mjs:518`, `scripts/install/opencode-version.mjs:40` —
apontam para o estado pré-#202 (`80bac52^`), não para o código atual. A
observação de 2026-10-04 data a descoberta; o defeito não está mais vivo.

A superfície de tools do plugin estava morta em runtime: nenhuma tool registrada
pelo plugin aparecia no catálogo (observação de 2026-10-04). São 6 registradas em
`src/plugin.ts:407-417` (`hashline_edit`, as 3 `pantheon_goal_*`,
`pantheon_cost`, `pantheon_model`) e 3 de `plugin-v2`; só os 5 servidores MCP
estavam vivos. Nota: `pantheon_delegate`/`_read`/`_list` **não** contam aqui — foram
removidos do plugin V1 em 1.5.0 (`docs/UPGRADING.md:195-198`) e nunca foram
registrados nesta geração.

**O enquadramento anterior estava errado nos dois lados.** A leitura anterior
era *gap passivo, forma do registro errada, registre o diretório em vez do
arquivo*. Auditoria posterior falsificou as duas metades — e a correção é mais
grave, porque troca "falta" por "quebra":

- **A forma de registro já era a correta e carregava.** `src/plugin-v2.ts:1078-1079`
  declara `plugin = define({` com `id: 'pantheon-opencode-v2'`, `:1081` define
  `async setup` e `:1220` faz `export default`; `define` é identidade no SDK
  instalado (`@opencode-ai/plugin/dist/v2/promise/plugin.js`), e
  `src/plugin-v2/` contém apenas `index.ts` — sem `package.json`, que o resolver
  não exige. Auditoria datada (2026-10-03) registrou 104 carregamentos limpos
  dessa entrada ao longo do dia, sem WARN de falha acompanhante. **Não há o que
  corrigir no plugin** — nenhuma mudança de `define`/`id`/`setup`, nenhuma
  entrada `server.*` em `src/plugin-v2/`.
- **Não era gap passivo: foi uma run do installer.** A mesma auditoria achou a
  superfície viva e depois a perdeu. Uma reescrita de config removeu da array
  plural `plugins` a entrada de diretório `…/src/plugin-v2` que funcionava, e
  adicionou à array singular `plugin` os dois caminhos de arquivo `.ts` que o
  host recusa. A reescrita também inscreveu **os dois dialetos de config de uma
  vez** (`agents`+`agent`, `permissions`+`permission`, `providers`+`provider`) —
  assinatura de um merge com forma V1 rodando contra um host V2. O primeiro WARN
  de rejeição veio **+1.3 s** depois da reescrita, apontado exatamente para
  aqueles dois alvos `.ts`; depois dele, zero carregamentos V2 pelo resto do dia.
  Auditoria datada: os números datam a descoberta, não são estado durável.

**Causa raiz e local exato do defeito (OS-1): o gate de versão — dois defaults,
em `bin/pantheon-init.mjs:425` e `scripts/install/opencode.mjs:518`, e nenhum
detector entre eles** — não o plugin, não o call site de registro. Cadeia
verificada no estado pré-#202, toda neste repositório:

- **São dois defaults, e o que chegava ao usuário é o segundo.**
  `bin/pantheon-init.mjs:425` passava `version: versionOpt ?? 'v1'` — um `'v1'`
  **concreto** em toda run sem flag (`versionOpt` é `null` sem flag,
  `bin/pantheon-init.mjs:335-340`). Esse valor explícito fazia curto-circuito em
  `scripts/install/opencode-version.mjs:40` (`if (requested === 'v1' ||
  requested === 'v2') return requested`), **antes** dos hints de
  `OPENCODE_VERSION` / `OPENCODE_BIN` em `:42-46`. **Logo o default de
  `scripts/install/opencode.mjs:518` — `resolveOpenCodeVersion(opts.version ?? 'v1')` — nunca era
  alcançado em produção** pela CLI. *Consequência prática que orientou a
  correção:* mudar **só** `scripts/install/opencode.mjs:518` era **inerte**, e mudar **só**
  `bin/pantheon-init.mjs:425` também era, se a biblioteca do installer fosse chamada
  direto sem `version`. O mínimo eram os **dois** defaults mais um ramo de detecção.
- `scripts/install/opencode.mjs:1056` — o ramo `v1` rodava
  `removePantheonPluginReferences(config.plugins)`: **apagou uma entrada V2 de
  diretório que estava funcionando**.
- `scripts/install/opencode.mjs:1077-1078` — `ensurePantheonPlugin('src/plugin.ts')` e
  `ensurePantheonPlugin('src/plugins/pantheon-hooks.ts')`: **escreveram os dois
  caminhos `.ts` rejeitados**.
- `scripts/install/opencode.mjs:1082-1115` — o ramo `v2` **nunca rodou**. Teria removido esses
  refs `.ts` de `config.plugin` em `:1086-1088`; eles ainda estão lá.
- `scripts/install/opencode.mjs:231` / `:234` / `:213` — `PANTHEON_V2_PLUGIN` **já era o
  diretório**, e `PANTHEON_V2_LEGACY_FILE` era mapeado para ele por
  `resolveInstalledPlugin`. **A forma correta já estava no código e simplesmente
  nunca era alcançada no ramo `v1`.**
- `scripts/install/opencode.mjs:34` / `:1354` — `detectVersion` já era importado e já era usado no
  fluxo, mas **não serve aqui e não é o que a frase anterior alegava.**
  `detectVersion(target)` lê `<target>/.pantheon/install-state.json` e devolve a
  **versão do próprio pacote Pantheon** (`scripts/install/migrate.mjs:36-40` →
  `readState`, `scripts/install/state.mjs:61-62` →
  `state.pantheon_version || state.version`), e o call site em `:1354` o consome
  como entrada da escada de migração **do pacote** (`runMigrations`, `:1356`).
  Reutilizá-lo aqui compararia `1.6.0-beta.4` contra nada. **O que existia era um
  seletor de versão, não um detector de versão do host: não havia detector em lugar
  nenhum do pacote** — o único sinal de geração do
  host era o regex de nome de binário em
  `scripts/install/opencode-version.mjs:46`, que é um **hint de `OPENCODE_BIN`**,
  alcançado só por `auto`. Foi por isso que #202 teve de **escrever** o detector
  de host (`probeHostVersion`), não reaproveitar um.

**Limite honesto desta auditoria.** Não foi possível determinar **qual**
invocação do installer produziu a reescrita: nenhum log do lado do installer
sobrevive nesse caminho. A conclusão se sustenta sem essa identificação — o
delta da config e o WARN de +1.3 s, apontado exatamente para os dois alvos `.ts`,
são evidência independente e suficiente, e são consistentes entre si.

**O que este item proíbe como correção.** Nenhuma mudança no plugin resolve
isto: adicionar `Plugin.define`/`id`/`setup`, ou uma entrada `server.*` em
`src/plugin-v2/`, são edições em código que já está correto e comprovadamente
carregando.

**Limite do conserto: um gate resolvido devolve 3 tools, não 6 — e não devolve o
Board.** Para que o conserto de #202 não seja lido como "a superfície inteira
volta":
`src/pantheon/v2-tools.ts:391` (`createV2ToolDefinitions`) devolve **3**
definições — `hashline_edit`, `pantheon_cost`, `pantheon_model` — e é isso que
o ramo `v2` registra. As 3 `pantheon_goal_*` **não voltam**: estão fora da
superfície V2 **por desenho**, não por acidente —
`src/pantheon/v2-tools.ts:5-15` e o marker `goal-tools` de
`V2_UNSUPPORTED_FEATURES` (`src/pantheon/v2-unsupported.mjs:71-76`) registram que
`GoalStore`, `GoalLoopClient` e `BackgroundJobBoard` não existem no
`PluginContext` V2 e que a bridge V1 resolve para `null` fora do V1. O
**BackgroundJobBoard é V1-only**. Ou seja: o conserto devolve **3** tools, não as
**6** de `src/plugin.ts:407-417`, e não devolve o Board. **Isto é limitação do
conserto, não defeito novo** — não abre item; a ausência de Board/goal tools no
V2 é tratada em P2-11.

**Auto-cura, e por que ainda é preciso `init` manual.** Uma escolha de versão
correta **auto-cura** uma config já corrompida, e **não há migração separada a
escrever**: o ramo `v2` remove os refs `.ts` V1 da chave **singular**
(`scripts/install/opencode.mjs:1086-1088`, `removePantheonPluginReferences(config.plugin)`), e o
casamento por identidade cobre refs **in-tree** e de **cache `node_modules`** —
`managedPluginIdentity` (`:261-303`) compara o absoluto contra
`INSTALLED_PANTHEON_PLUGIN_PATHS` (`:274-278`) e casa por **sufixo** atrás de
`/node_modules/pantheon-opencode/` (`:290-299`), o que cobre prefixos de `npx` e
de outros `nvm`; refs em forma de objeto entram por `pluginMetadataReferences`
(`:253-259`). **Falha só para path relativo não canônico** — `./src/plugin.ts`,
`./src/plugin-v2`, `src/plugins/../plugin.ts`: `normalizePluginRef` (`:221-223`)
normaliza separador e barra final mas **não absolutiza**, e `isAbsolute` em
`:274` é falso — `normalizePluginRef` não é `resolve()`. O installer nunca grava
essa forma (`:210` grava `join(ROOT, normalized)`, sempre absoluto), logo a
config corrompida pela **própria** run do `v1` é sempre auto-curável. **Mas
`postinstall` não roda `init`** — `scripts/postinstall.mjs:35` apenas **imprime**
o hint `npx pantheon-opencode init` — então o usuário afetado precisa **re-rodar
`init` à mão**. **Isto é material de release note, não um item novo.**

**P0-2 — O secret scanner não protege contra a leitura de um arquivo de
credencial.**
**Status: WITHDRAWN.**
**Tombstone. Não descreve defeito e não pede correção.** O slot fica porque este
id já é citado por outras rodadas e pelo histórico deste documento.

A alegação original: os 14 agentes (`read: allow`) poderiam ler um arquivo de
credencial e gravar o token real num arquivo versionado, com raio "segredos +
repo público". A premissa que a sustentava — que o hook de secret-scanning nunca
carrega — era ela própria falsa: o log que a provava era saída de teste, não
superfície viva.

**Retirada, por dois motivos que a sustentam de pé.**

- **O controle assumido não pode funcionar naquele caminho.** O hook casa
  **valores** de secret nos argumentos da tool call, e o input de uma chamada
  `read` é um **caminho de arquivo** — que não casa com padrão de valor nenhum.
  Ele não tem gating por leitura, carregue ou não.
- **A classe de caminho não é deste pacote.** Era a configuração pessoal de uma
  máquina: nenhuma fase do installer, caminho de postinstall ou componente de
  runtime deste pacote cria um diretório `secrets/` nem grava credencial no
  diretório de config.

A parte que sobrevive é mais estreita e está em **P2-10**.

**P0-3 — `doctor` dava verde ao backend de uma tool sem checar seu registro (OS-2).**
**Status: CLOSED (code).** O check continua testando apenas o pré-requisito do
backend `node:sqlite`, mas agora a mensagem explicita que não verifica o
registro de `pantheon_cost` (`scripts/doctor.mjs:1916-1918`); o teste fixa essa
distinção em `tests/test_doctor_layers.mjs`. Não há mais afirmação de que a
tool esteja registrada, e a checagem runtime continua advisory/backend-only.

**P0-4 — O catálogo de tools oscila dentro de uma mesma sessão.**
**Status: WAIVED — known issue (1.6.0 stable).** Waivado pelo mantenedor em
2026-10-10: a oscilação é comportamento do host OpenCode, fora do escopo deste
repositório, e já está listada nos Known Issues do CHANGELOG da 1.6.0. O
harness de reprodução fica como follow-up. O registro abaixo permanece válido
como descrição do defeito. Uma tool existente e depois ausente
entre turnos torna qualquer verificação que dependa dela **inviável por
construção**: não há medida confiável enquanto o instrumento muda. Numa sessão
de validação o catálogo foi completo → parcial → completo → parcial → completo,
cinco transições, e a oscilação causou uma falha de escrita real que só pôde
ser contornada. Isso é pior que qualquer falha individual de tool, porque
invalida o próprio instrumento de medição — e por isso precede tudo que dependa
de observação de catálogo, incluído o probe que originou P0-1. Sem diagnóstico:
não se sabe se a causa é cache de catálogo, ciclo de vida de plugin, ou
re-registro concorrente.

**P0-5 — Nomes de ação de permissão desatualizados quebravam o enforcement
read-only em host V2.**
**Status: CLOSED (code).** A migração agora traduz `task → subagent` e
`write → edit`, que também cobre os tools `write` e `patch` no host V2. Quando
`edit` e `write` colidem no mesmo recurso, preserva a regra mais restritiva,
independente da ordem das chaves no objeto. O mesmo tradutor atende permissões
globais e de agentes; regressão coberta por
`tests/install-config-migration.test.mjs` (task/write, deny preservado e nested
agent permissions). Mapeamento alinhado à documentação V2 de permissões do
OpenCode, consultada em 2026-10-10.

**P0-6 — A config gravava um caminho absoluto para a árvore de instalação.**
**Status: CLOSED (code).** O installer V2 agora grava `pantheon-opencode@<versão>`
e o pacote exporta o plugin V2 na raiz; o registro não depende mais do prefixo
global nem do cache temporário de `npx`. A versão exata evita atualização
silenciosa por mudança de pacote, e o `doctor` detecta um pin antigo tanto em
entrada string quanto no objeto `{ package, options }`. Cobertura em
`tests/install-opencode.test.mjs`, `tests/install-e2e.test.mjs`,
`tests/v2-package-consumer.test.mjs` e `tests/test_doctor_layers.mjs`. Limite
conhecido: antes de publicar a versão do checkout, executar `init` dali ainda
grava um pin npm que o host não resolve; o installer emite um aviso explícito.
O fluxo suportado de consumidor via pacote publicado (`npx`/global) não tem
esse problema.

**P1-1 — Contrato documentado de `memory_store` é rejeitado.**
**Status: CLOSED (doc) — corrigido por esta reescrita.**
`metadata` precisa ser uma string JSON-encoded; as instruções documentam um
objeto cru em dois lugares. Toda chamada documentada falha.

**P1-2 — Contrato documentado de `context_save` é rejeitado.**
**Status: CLOSED (doc) — corrigido por esta reescrita.**
`content.phase` precisa ser um objeto `{current, total, name}`; as instruções
documentam um número solto. Toda chamada de checkpoint documentada falha.

**P1-3 — `pantheon_cost` documentado como ligado.**
**Status: CLOSED (doc) — premissa desfeita pelo PR #202.**
Estava fora da superfície viva de tools enquanto P0-1 existia. A causa raiz era
P0-1, não um defeito independente: com P0-1 corrigido (`80bac52`, 2026-10-04),
a tool volta à superfície V2 (as 3 de `createV2ToolDefinitions`) e à V1
(`src/plugin.ts:407-417`).

**P1-4 — `ROADMAP.md` desatualizado.**
**Status: CLOSED (doc) — este documento, corrigido por esta reescrita.**
Este documento. Corrigido por esta reescrita.

**P1-5 — `routing.yml` não tem gate contra o catálogo do provedor.**
**Status: OPEN.**
**Defeito estrutural:** `src/routing.yml` fixa identificadores de modelo
literais nos quatro presets (`go-free` L3-26, `go-fast` L27-50, `go-premium`
L51-74, `openai` L75-98), e nenhum gate do repositório valida esses
identificadores antes ou depois do deploy — não há `doctor` check, não há
teste, não há preflight no installer. Um preset pode portanto nomear um modelo
que o provedor não oferece e o deploy continua verde. **Auditoria datada
(2026-10-04)** registrou, naquele momento: `gpt-5.6-luna-fast` (usado por slots
de scout em `go-fast` e `openai` — em `go-premium` os mesmos seis slots usam
`opencode-go/gpt-5.6-luna`, sem o sufixo `-fast`) fora do catálogo; `gpt-5.6-sol`
e `gpt-5.6-luna` superados pela linha `gpt-6.x`; `deepseek-v4-flash` virado
`deepseek-v4.1-flash`; e `mimo-v2.5-free`, `qwen3.6-plus-free`,
`nemotron-3-super-free` não mais oferecidos. Essa lista **não** é um fato
durável — o catálogo de um provedor muda sem alterar o repositório. O defeito é
a ausência do gate; a lista é o sintoma de uma data. Em especial, disponibilidade
de modelo é propriedade de uma **conta**, não do repositório: um achado de
"modelo X existe" não pode ser promovido a fato de projeto (ver P2-9).

**P1-6 — `docs/INSTALLATION.md` anuncia `pantheon_cost` sem ressalva (OS-3).**
**Status: CLOSED (code) — corrigido pelo PR #202 (`80bac52`, 2026-10-04).**
`docs/INSTALLATION.md:125` lista `pantheon_cost` entre as 3 tools do plugin V2 e
L127-131 repete a contagem. A ressalva que faltava era sobre a seleção default do
installer (`v1`, P0-1) deixar a tool desregistrada. O default passou a `auto`
(`bin/pantheon-init.mjs:427`, `scripts/install/opencode.mjs:528`): num host 2.x
ele resolve `v2`, que registra a tool; num host V1, `src/plugin.ts:407-417`
também a registra. A doc passa a bater com o comportamento. Mesmo mecanismo de
P1-3, em outro arquivo.

**P1-7 — Validar permissões antes de despachar.**
**Status: OPEN.**
Dois arquivos foram atribuídos a agentes cujo bloco `permission` nega `edit`
— ambos teriam falhado no contato. Sete dos 14 agentes declaram `edit: deny`
(`apollo`, `athena`, `gaia`, `iris`, `nyx`, `themis`, `zeus` —
`src/agents/*.md`), e o `mnemosyne` nega `edit` fora de
`.pantheon/memory-bank/**` e `.pantheon/deepwork/**` (issue #111). Um gate que
cruze o prompt de dispatch contra o bloco `permission` do agente alvo pega isso
automaticamente. É o **único** erro de orquestração aqui que é detectável
mecanicamente **hoje, sem mudança de código** — os outros gates do backlog
(P2-4) dependem de um artefato que ainda não existe.

**P1-8 — Preservar a `sessionID` em dispatch abortado.**
**Status: OPEN.**
Um dispatch abortado devolveu erro sem `sessionID`; o agente perdeu todo o
contexto e refez o trabalho do zero. Uma falha de infraestrutura deveria ser
recuperável do mesmo jeito que uma falha de agente já é — o modo de retomada
existe e só foi exercitado no caminho de sucesso. Sem `sessionID` no erro não
há o que retomar.

**P1-9 — `pantheon-vision` falha em imagens válidas.**
**Status: OPEN.**
Duas falhas em duas tentativas sobre PNGs válidos, enquanto o caminho nativo de
leitura de imagem funcionava corretamente — e foi ele que tornou o trabalho
possível. O gateway de visão (`src/mcp/pantheon_vision_server.py`, tools
`vision_describe` L565-566, `vision_ocr` L575-576, `vision_analyze` L585-588) é
hoje **estritamente inferior** ao fallback nativo: em caso de falha ele só
perde. `_gateway` (L468) acumula os candidatos de endpoint e devolve
`See the pantheon.vision error log for the paths tried.` (L476) só depois de
esgotar todos, então o diagnóstico não volta para quem chamou.

**P1-10 — Matcher de caminho de tool sugere a string que rejeitou.**
**Status: OPEN.**
Chamar uma tool pelo seu caminho dinâmico produziu `Unknown tool 'X'` seguido
imediatamente de `Did you mean X?`, onde `X` é byte-idêntica ao caminho
rejeitado. É bug de parsing no matcher de caminho ou na formatação do erro; o
efeito prático é o agente desistir em vez de tentar a alternativa sugerida — a
sugestão é pior que nenhuma, porque confirma que a rota por caminho dinâmico
funciona.

**P1-11 — `docs/MEMORY.md` publica a assinatura retirada de `memory_store`.**
**Status: OPEN.**
`docs/MEMORY.md:84-92` documenta `memory_store(content=, category=, agent=,
session_id=, importance=, truncate=, links=)` — sete parâmetros que a
assinatura viva não aceita: o servidor aceita apenas `value, namespace, key,
metadata` (`src/mcp/memory_mcp_server.py:527-540`). Toda chamada copiada da
seção *Tool Reference* é rejeitada, exatamente como em P1-1. O banner de
sistema ChromaDB retirado (`:460-464`) cita a assinatura correta, mas nomeia
só a tabela logo abaixo dele: o *Tool Reference* acima e as *Performance Tips*
(`:478`, `truncate=True`) continuam anunciando a API morta. Defeito
pré-existente em `origin/main`, em arquivo que este branch não toca — mesma
classe de P1-1, outra página, mesmo fora de escopo que P1-6.

**P2-1 — Duplicação de sistemas de versão no installer.**
**Status: OPEN.**
`prepareDocumentVersion` (`scripts/manifest-inventory.mjs:313`) escreve
`['version']` e `['packages','','version']` em cada lock — nunca a entrada
aninhada `packages["src/plugins/tui"]`, que existe em `package-lock.json`.
`validateLock` (`:151-178`) inspeciona só `packages[""]`, então
`package-lock.json` pode divergir de `src/plugins/tui/package.json` e o
`npm ci` não pega isso — invisível a todos os gates atuais.

**P2-2 — Limite de `phase.name` sem teste de fronteira (OS-5).**
**Status: OPEN.**
`MAX_PHASE_NAME_LENGTH = 256` (`src/mcp/mcp_persistence_server.py:639`,
aplicado em `:892`) é rejeitado acima do teto por
`tests/test_mcp_persistence_server.py:1306` (257 chars via `context_save`),
mas nada testa o lado **aceitar**: nenhum caso usa exatamente 256 e nenhum
teste referencia a constante. Alterar o limite não quebra suíte. A doc F5
(`src/instructions/zeus-anti-stall.instructions.md:75`) já declara o teto,
portanto o guard e a doc concordam — falta só o teste de fronteira.

**P2-3 — `memory_search` deve expor que é lexical.**
**Status: OPEN.**
A recuperação é FTS5/BM25 pura — não há embedding, nem vetor, nem passo
semântico: `_build_fts_query` (`src/mcp/memory_mcp_server.py:291`) faz
OR-join dos termos, e `_score_hits` (`:396`) rankeia por `bm25` (com
`decay_days`, multiplicado por `2^(-days/decay_days)`). A descrição da tool já
avisa ("no semantic/vector retrieval", `:582-587`); o **payload de resultado
não**. Cada hit volta como o dict da entry mais um `score` arredondado
(`:675`) — nada no resultado diz que essa pontuação é um BM25 cuja escala não
é comparável entre queries. Numa validação, uma busca por um conceito devolveu
um documento de score alto que compartilhava um único token com a query: o
oráculo mecânico aceita, e o chamador não tem como saber que aquilo foi
coincidência lexical, não relevância.

**P2-4 — Serializar quem compartilha arquivo com edição pendente.**
**Status: OPEN.**
Dois agentes foram despachados para editar dois arquivos diferentes — correto.
Um terceiro foi despachado contra um arquivo que outro agente já tinha com
edições pendentes: corrida real, capturada em voo por sorte de leitura. Nenhum
gate declara exclusão mútua; o contrato de escrita é implícito e não está em
nenhum artefato. Um grafo de dependência declarado tornaria a exclusão mecânica
em vez de acidental.

**P2-5 — Reduzir o tamanho da saída de Wave 0.**
**Status: OPEN.**
Cerca de 750 linhas foram repassadas **por paráfrase** a 4 agentes. Funcionou,
mas paráfrase deriva: cada retelling perde detalhe, e o receptor não tem como
saber o que mudou. O agente que já tem direito de escrita deveria gravar o
contrato num arquivo e os demais leriam a fonte única, em vez de quatro cópias
recontadas de memória.

**P2-6 — Definir o papel do `nyx`.**
**Status: OPEN.**
`src/agents/nyx.md:11` declara `edit: deny`, e a linha 26 reforça
`ANALYSIS ONLY — NEVER implement, never edit files, never write code.`
(L27: "If you identify a configuration change needed, report the finding — do
not implement it yourself"). Mas a descrição do agente é *observability &
monitoring specialist*, cujo produto natural — tracer, dashboard, alerta,
instrumentação — é código. O agente não pode produzir nada do que é definido
para produzir. Ou ganha direito de escrita, ou o papel é redefinido como
análise apenas. Enquanto isso, qualquer trabalho de instrumentação que exija
alteração em repo é, por construção, trabalho de outro agente.

**P2-7 — Tornar o `mnemosyne` utilizável fora do repositório.**
**Status: OPEN.**
`src/agents/mnemosyne.md:37-47` restringe `write`/`edit` a
`.pantheon/memory-bank/**` e `.pantheon/deepwork/**` (`"*": deny`). Em qualquer
workspace que não tenha esses diretórios — um clone recém-criado, um repo
externo, um sandbox de validação — o agente é **inerte**: não pode criar o
diretório que ele mesmo existe para gerenciar. O guard é correto como
proteção (issue #111) e incompleto como capacidade: falta a diretiva de criar
a raiz do memory bank quando ela não existe.

**P2-8 — Issue #198: os entrypoints MCP compartilham o token `server.py`.**
**Status: OPEN.**
Os cinco entrypoints Python terminam em `_server.py` — `code_mode_server.py`,
`memory_mcp_server.py`, `mcp_persistence_server.py`, `mcp_resources_server.py`,
`pantheon_vision_server.py` (todos em `src/mcp/`, referenciados por
`scripts/install/opencode.mjs:806-812` e documentados em `docs/MCP.md:37-53`).
Qualquer `pkill -f server.py` — um idioma comum em tooling de agente — casa
com todas as command lines MCP e mata a frota inteira como dano colateral.
Observação datada (2026-10-04): 20 processos em 4 workspaces saíram dentro de
uma janela de 91 ms por um SIGTERM externo; OOM, banner em stderr e divergência
de venv foram cada um falsificados como causa. *Referenciado, não implementado
aqui.* Correção proposta: renomear os entrypoints, o que toca a config gerada
pelo installer, `docs/MCP.md`, `pyproject.toml`, a suíte de testes, comentários
de CI e configs já instaladas — logo, instalações existentes exigiriam re-execução
do installer. Rastrear pelo link da issue. **Lição durável, independente do
issue:** matar por PID ou por porta, nunca por substring de nome de arquivo.

**P2-9 — Apollo precisa rotular achados como portáteis ou específicos de
ambiente.**
**Status: OPEN.**
Consequência direta de uma falha real ocorrida **nesta mesma dobragem**: um
agente read-only reportou, com alta confiança, que um padrão de secret de alta
confiança estava ausente de um arquivo — tendo lido apenas um trecho dele. O
padrão existia, montado em outra linha do mesmo arquivo. A alegação falsa foi
promovida pelo orquestrador a um briefing, depois a documentação de projeto, e
teve de ser retractada — **já tendo sido retractada antes, por outro agente,
numa sessão anterior**. A classe de erro é um agente ler parte de um arquivo e
reportar ausência para o arquivo inteiro. Achados do Apollo devem vir rotulados
por item como *portátil no repo* ou *específico do ambiente*, para que o
orquestrador não possa promover um snapshot local a fato de projeto. A mesma
regra vale para achados de disponibilidade de modelo, que são propriedade de uma
conta e não do repositório (ver P1-5).

**P2-10 — O secret scanner não protege contra a leitura de um arquivo de
credencial cujo caminho o agente já sabe.**
**Status: OPEN.**
`scanSecretPayload` em `src/pantheon/secret-scanner.ts` examina o input serializado
da tool call. O call site V1 é `tool.execute.before` em
`src/plugins/pantheon-hooks.ts:1170-1186` (usa `output.args`, com fallback para
`input.args`); o V2 fica em `src/plugin-v2.ts:1042-1059` (usa `output.args`). Em
ambos, o scanner recebe **argumentos da ferramenta**, não controla acesso ao
sistema de arquivos nem restringe leituras por caminho. Assim, saber o caminho de
um arquivo de credencial ainda permite tentar lê-lo; a documentação de plugins do
host mostra o caminho oposto como idiomático — o exemplo de `.env protection`
intercepta `input.tool === "read"` e inspeciona `output.args.filePath`. Auditoria
datada da documentação do host, 2026-10-03.

**Onde a correção pertence.** Qualquer modelo de permissão que queira restringir
**leituras** tem de viver nos grants de `permission` que o installer semeia —
`scripts/install/opencode.mjs:948-950` (cópia do bloco `permission` do
frontmatter de cada agente), `:998-999` (grant de `bash` por agente),
`:1158-1211` (bloco `permission` de topo, com a lista `bash` de allow por
prefixo) e `:1325-1341` (defaults de `permission.mcp` por servidor MCP). O
secret scanner é a camada errada para essa pergunta, porque a pergunta não é
"esse texto é um segredo" e sim "esse caminho deveria poder ser lido".

**P1-12 — A matriz caller/target de delegação não é replicada no contrato V2.**
**Status: CLOSED (code).** A premissa ficou obsoleta: V2 aplica a matriz em
`permission.evaluate`, consulta a identidade autoritativa com `session.get()` e
rejeita sessões-filhas, sem depender do evento `execute.before` nem do guard V1.
Cobertura em `src/pantheon/v2-delegation-enforce.ts`,
`tests/pantheon/v2-delegation-enforce.test.ts` e no teste integrado de
`tests/pantheon/plugin-v2-contract.test.ts` (“permission hook denies disallowed
V2 delegation using authoritative session identity”). O canário live continua
sendo necessário para compatibilidade por versão do host, mas não para provar a
regra implementada em código.

**P2-11 — Board e goal tools não existem no contrato V2, e a bridge que os
carregaria nunca foi ligada.**
**Status: OPEN.**
A factory e o accessor existem (`src/pantheon/v2-bridge.ts:89`,
`src/pantheon/v2-bridge.ts:110`) e **nenhum path de produção chama a factory** — só a
suíte. Logo o accessor resolve para `null` em toda configuração real, e esse `null` é
tratado **não registrando** as tools dependentes em vez de registrá-las como
não-funcionais; a ausência é declarada pelo marker `goal-tools`
(`src/pantheon/v2-unsupported.mjs:76`). **O que o PR #204 mudou (2026-10-04) foi o
relato, não a capacidade:** o install passa a listar os markers numa instalação
V2-generation (`scripts/install/opencode.mjs:546`) e o `doctor` reporta a redução
como achado H4 (`scripts/doctor.mjs:1560`), ambos lendo o mesmo seed congelado
(`src/pantheon/v2-unsupported.mjs:55`) — de modo que a ausência agora é **anunciada**
antes de ser encontrada, em vez de só ser deduzida de um workflow que não retorna.
Falta ligar `createV2Bridge` no `setup()` do plugin V1 e decidir se o alvo é
replicar board/goal tools no V2 ou declarar a redução como permanente. Mapeado em
[PERMISSIONS-QUALITY-DELEGATION.md](docs/PERMISSIONS-QUALITY-DELEGATION.md) §3.5 e em
[UPGRADING.md](docs/UPGRADING.md).

**P2-12 — Hooks V2 registrados sem comportamento próprio de visão/compaction.**
**Status: OPEN — escopo reduzido.** A premissa original de que `execute.after`
e `permission.evaluate` eram vazios ficou obsoleta: o primeiro executa
`task-result-guard → context-sandbox → read-enhancer`, e o segundo aplica a
matriz caller/target em `src/plugin-v2.ts`. Permanecem sem implementação V2 o
hook `session.prompt` de visão e a construção de contexto no hook `compaction`;
ambos são explicitamente no-op e seus comportamentos equivalentes vivem na
superfície V1 (`src/plugin-v2.ts`, `src/plugins/pantheon-hooks.ts`). A contagem
de cinco eventos/hooks registrados não deve ser interpretada como cinco
comportamentos equivalentes ao V1. Ver também [UPGRADING.md](docs/UPGRADING.md).

---

## Histórico

- **Plano v1.0-dev** (memory commands, context compression, MCP servers,
  Themis review gate, routing): entregue entre v3.15.0 e v3.19.0.
- **Plano v1.0** (sprints 1–6): superseded by v1.5.0. Sprint 1 e 4 (parcial)
  e 7 entregues (commit `084a5a5`); sprints nunca implementados (S2/S3/S5/S6)
  foram removidos do plano ativo.
- **Plano v1.0+** (sprints 7–13): superseded by v1.5.0. Sprints nunca
  implementados (S8–S13) foram removidos do plano ativo — capacidades
  equivalentes que já existem (model routing por tier, redaction gate,
  cost tracking) fazem parte do contrato atual, não de plano futuro.
- Pendências herdadas dos sprints antigos (TODO Enforcer, hash-anchored
  edits, auth interceptor, full-auto) foram descartadas do plano ativo;
  podem voltar em uma próxima iteração se o contrato do host permitir.

| Data | Mudança |
|------|---------|
| 2026-10-05 | **Reconciliação de P0-1 contra o PR #202: 29 itens, 2 fechados.** O PR #202 (`80bac52`, 2026-10-04) corrigiu os três defaults `'v1'` do seletor de geração para `'auto'` (`bin/pantheon-init.mjs:427`, `scripts/install/opencode.mjs:528`, assinatura em `scripts/install/opencode-version.mjs:213`) e adicionou um probe de `--version` do host (`scripts/install/opencode-version.mjs:44-55`; precedência `explícito > OPENCODE_VERSION > basename opencode2 > probe > warn-and-fallback-v1`). Fechou **P0-1** — cujo corpo fica preservado como **registro histórico pré-#202** — e **P1-6**, cuja premissa era o default `v1` deixar `pantheon_cost` desregistrada. **Legenda estendida** com `CLOSED (code)`: `CLOSED (doc)` é estritamente *documentação corrigida por reescrita* e não expressa um defeito fechado por PR de código. Contrato, "Limites", P0-3, P0-5, P0-6 e âncoras de arquivo único (sem diretório) reconciliados com o código atual. Nota: P1-3, antes fechado como "indisponível", teve a premissa desfeita por #202 — `pantheon_cost` volta à superfície. Contagem: 29 itens (4 `CLOSED (doc)`, 2 `CLOSED (code)`, 23 `OPEN`) + 1 tombstone `WITHDRAWN` (P0-2). |
| 2026-10-05 | **Reconciliação pós-PR #204: 26 → 29 itens, nenhum fechado.** #204 entregou três fatias de paridade — relato da redução V2 no install (`scripts/install/opencode.mjs:546`) e no `doctor` como achado H4 (`scripts/doctor.mjs:1560`), correção da cadeia causal invertida atrás da matriz de delegação não replicada, e poda do registro read-only em `session.deleted` (`src/plugin-v2.ts:493`) — e **nenhuma delas tinha item neste backlog**, então **nenhum `Status:` foi virado**: os três itens abertos são o que #204 deixou de fora, não o que ele entregou. **Três itens novos, todos `OPEN`:** **P1-12** (a matriz caller/target não é replicada no V2 — bloqueado numa observação que só uma run beta pode fazer, se o `agent` de `execute.before` é o delegante no meio do handoff; nada no repositório mede payloads de evento, o canary registra só `Object.keys(ctx)`), **P2-11** (board e goal tools ausentes no V2, com a bridge `createV2Bridge` nunca ligada — o que #204 mudou foi o *relato*, não a capacidade), **P2-12** (a cadeia `execute.after` no V2 é ponto de registro vazio, e o mesmo vale para `permission.evaluate`, `session.prompt` e compaction). Cada um remete para §3.5 de [PERMISSIONS-QUALITY-DELEGATION.md](docs/PERMISSIONS-QUALITY-DELEGATION.md) em vez de repetir o mapa. **Falso pressuposto de contagem registrado:** a legenda trata `CLOSED (doc)` como *documentação* corrigida por reescrita, e nenhum dos quatro já fechados se aplica a estas fatias de código — por isso a rodada **abre** e não fecha. Contagem e markers reconciliados: 29 itens vivos (4 `CLOSED (doc)`, 25 `OPEN`) mais 1 tombstone `WITHDRAWN` (P0-2). |
| 2026-10-04 | **Três correções factuais em P0-1, sem mudança de escopo.** (1) A alegação de que "a capacidade de detectar a geração existe e não é consultada" era **falsa**: `detectVersion` (`scripts/install/migrate.mjs:36-40`) devolve a versão do **próprio pacote** Pantheon, e **não existe detector de versão do host em nenhum lugar do pacote** — há seletor, não detector. (2) O local do defeito estava **incompleto**: o default que chega ao usuário é `bin/pantheon-init.mjs:425`, e ele curto-circuita em `scripts/install/opencode-version.mjs:40` antes de `scripts/install/opencode.mjs:518` — mudar **só** um dos dois é inerte. (3) Acrescentado o **limite do conserto**: um gate resolvido devolve **3** tools, não as 6, e não devolve o Board — as `pantheon_goal_*` são **V1-only por desenho**. Registrada a **auto-cura** (o ramo `v2` já remove os refs `.ts` da chave singular e o casamento por identidade cobre in-tree e cache `node_modules`, então **não há migração nova**) com a ressalva de que **`postinstall` não roda `init`** — material de release note. Enquadramento, severidade e todos os `Status:` preservados; **nenhuma contagem mudou**. |
| 2026-10-04 | **Rodada de correção de severidade: 24 → 26 itens.** Duas alegações P0 foram falsificadas por auditoria posterior e uma delas foi retirada. **P0-1 reescrito:** a superfície de tools não estava morta por *gap passivo* nem por forma de registro errada — a forma de registro já era a correta e carregava, e o que a derrubou foi uma **run do installer** que rodou o ramo `v1` (default em `scripts/install/opencode.mjs:518`) contra um host V2, apagando a entrada de diretório V2 que funcionava e escrevendo dois caminhos `.ts` rejeitados. Causa raiz realçada para o **gate de versão**; proibidas como correção as mudanças em `define`/`id`/`setup` e a entrada `server.*` em `src/plugin-v2/`, que editariam código já correto. **P0-2 retirado e virado tombstone `WITHDRAWN`, com a parte remanescente promovida a P2-10**: a premissa "o hook de secret-scanning nunca carrega" era falsa — o log que a provava era saída de teste, não superfície viva — e a alegação não se sustentava por dois motivos independentes: o scanner casa **valores** em argumentos de tool call, e o input de uma chamada `read` é um caminho, então ele não tem gating por leitura, carregue ou não; e o caminho de credencial era da configuração pessoal de uma máquina, que este pacote não cria. **Dois P0 novos:** P0-5 (nomes de ação de permissão desatualizados — o tradutor do repo conhece `bash`/`skill`/`edit`/`websearch` mas não `task` nem `write`, que o repo entrega; degrada o enforcement read-only dos 14 agentes, independente de P0-1) e P0-6 (a config grava caminho absoluto para a árvore de instalação, re-resolvido só no `init`, o que faz upgrade não ter efeito silenciosamente). Duas frases foram retiradas por serem refutadas: uma tratava entrada de log de hook como prova de superfície viva, e uma atribuía a uma sessão anterior ao rewrite o módulo ainda carregado — a run relevante começou três horas **depois** do rewrite. Contagem e markers reconciliados: 26 itens vivos (4 `CLOSED (doc)`, 22 `OPEN`) mais 1 tombstone `WITHDRAWN` (P0-2). Gate de agnosticidade re-aplicado a tudo que foi escrito; duas citações de linha do briefing não resolveram e foram corrigidas na fonte (`config-migration.mjs` e o seeding de `permission` no installer). |
| 2026-10-04 | **Backlog dobrado para 24 itens + evidência positiva de orquestração.** Gate de agnosticidade aplicado ao documento inteiro: reescritos P0-1 (defeito estrutural do installer em vez de contagem de log de uma máquina), P0-2 (removido caminho de credencial específico de um host; hoje tombstone `WITHDRAWN`) e P1-5 (ausência de gate contra catálogo de provedor, com a lista de modelos rebaixada a auditoria datada). Adicionados P0-4 (oscilação de catálogo de tools numa mesma sessão — nunca diagnosticada), P1-7..P1-11 (gate de permissões pré-dispatch, `sessionID` em dispatch abortado, `pantheon-vision` inferior ao fallback nativo, matcher que sugere a string rejeitada, `docs/MEMORY.md` publicando a assinatura retirada de `memory_store`) e P2-3..P2-9 (`memory_search` expõe léxico, exclusão de arquivo, briefing Wave 0 por paráfrase, papel do `nyx`, `mnemosyne` inerte fora do repo, issue #198 do token `server.py`, rotulagem portátil/específico de ambiente no Apollo). Adicionada seção de validação: 16 dispatches / 9 agentes, 0 timeouts, 93,75% de sucesso, resume de sessão preservando 46 medidas, 5/5 erros de orquestração pegos por agentes, 5 recusas honestas. Dois achados de MCP de terceiro foram descartados pelo gate de agnosticidade — não são componente Pantheon. |
| 2026-10-04 | **Roadmap reativado** após o zeramento de 2026-09-12. Superfície de tools do plugin provada morta em runtime, com causa isolada na seleção de geração (P0-1); `pantheon_cost` corrigido para indisponível (P1-3); contratos de `memory_store` (P1-1) e `context_save` (P1-2) corrigidos; backlog de 8 itens reescrito a partir de probe runtime. |
| 2026-10-04 | **Backlog ampliado para 11 itens** com 5 achados posteriores à reescrita: local exato do defeito de P0-1 no installer, que se contradiz (OS-1); falso verde do check K do `doctor`, que probeia o backend e não o registro da tool (OS-2); `docs/INSTALLATION.md` anunciando `pantheon_cost` sem ressalva (OS-3); e falta de teste de fronteira para o limite de `phase.name` (OS-5). Contrato de `.ts` vs diretório já estava correto na tabela (OS-4) e não foi duplicado. |
| 2026-09-12 | **beta.5/beta.6 entregues.** Native tasks no painel (mirror no board), painel v2 (atividade ao vivo, Archived paginado, retry), `update` + garantia de freshness (postinstall sync, drift no doctor, CI anti-stale), installer resiliente (preflight, config atômico + .bak, venv não-fatal, poda de refs velhas), i18n pt/en auto-detect. |
| 2026-09-12 | **Roadmap zerado.** Plano ativo sem itens pendentes; sprints não implementados (S2/S3/S5/S6/S8–S13) removidos; contrato atual atualizado com code-mode (B3-08). |
| 2026-08-10 | **Sprint 4 (parcial) + Sprint 7 entregues.** 3-tool API de delegação (pantheon_delegate/read/list) sobre BackgroundJobBoard; notificação via session.idle + chat.message flush (spike provou noReply indisponível); timeout 15min + output parcial persistido; enforcement read-only (edit/write/bash/task negados, apollo/gaia); compaction carry-forward; pruning TTL 24h. Commit 084a5a5. TODO Enforcer/full-auto/hash-anchored/auth-interceptor pendentes. |
| 2026-07-24 v6 | **Cleanup:** removidas referências a concorrentes, tabela competitiva removida. Sprints reorganizados: S6 (YAGNI) reconhecido como já planejado, S4 full-auto = modo autônomo, S5 decay já existe. Novos sprints (S7-S13) são expansões do que já existe, não features do zero. |
| 2026-07-24 v5 | Corrigido para v1.0. Revisão Themis aplicada. |
| 2026-07-24 v4 | Pesquisa comunitária. 6 novos sprints. |
| 2026-07-22 v3 | OpenCode v1.18 insights |
| 2026-07-22 v2 | Roadmap reescrito |
| 2026-06-20 | Última v3.14.0 |
