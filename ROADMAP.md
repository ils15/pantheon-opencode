# 🗺️ Pantheon Roadmap

> **Charter updated:** 2026-10-20
> **Previous header/status snapshot:** v1.6.0-beta.4 / 2026-10-05 — superseded by later entries in the body; the current readiness was reconciled on 2026-10-20 (beta.15 published and field-tested; beta.16 branch open).
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

## Road to Stable — charter

Este `ROADMAP.md` é a única fonte-mestre Road-to-Stable: **um charter com três
workstreams, não três roadmaps concorrentes**. O charter não reclassifica nem
revalida os itens históricos abaixo.

**Base de decisão (council de 2026-10-19):** 3/3 especialistas recomendaram
três workstreams; houve divergência sobre quantos arquivos de plano separados
deveriam existir. A resolução foi manter um charter mestre com três seções e
criar planos executivos detalhados somente quando necessários.

1. **Product & Agent-Workflow Contract** — definir o contrato do produto e do
   fluxo de agentes. [PR #248](https://github.com/ils15/pantheon-opencode/pull/248)
   é uma feature lane; não constitui evidência de release readiness.
2. **Runtime & Distribution Validation** — provar que pacote, installer,
   plugins e MCPs cumprem o contrato na matriz explicitamente suportada de
   hosts. A matriz de compatibilidade e uma identidade única do candidato
   conectam este trabalho ao restante.
3. **Stable Release & Evidence Gate** — após congelar um candidato SHA exato e
   obter evidência dos workstreams 1 e 2, validar testes, compatibilidade,
   instalação, pacote, changelog e metadados; considerar release somente quando
   todos os gates aplicáveis estiverem explicitamente `PASS`.

Os workstreams 1 e 2 podem avançar em paralelo quando independentes; o 3 depende
do candidato congelado e da evidência dos dois primeiros. O objetivo é um
artefato stable reproduzível, vinculado ao `TARGET_SHA` completo e ao SHA-256 do
tarball, com `PASS` em cada gate aplicável. Evidência ausente ou marcada
`NOT_TESTED`, `WARN`, `SKIP` ou `AMBIENTAL` não é `PASS`; riscos não resolvidos
são blockers ou precisam ser aceitos explicitamente, nunca aprovados em silêncio.

**Readiness atual: `beta.15` PUBLICADA; `beta.16` aberta, com source/docs e
validação local final concluídos, mas `PR CI` pendente.** O NO-GO da alegação de
prontidão stable com base no relatório beta.6 é precedente histórico; esta
atualização não declara prontidão para release. A `v1.6.0-beta.15` (`fd22b0c`)
está publicada e foi testada em campo contra `opencode v2.0.30`; a branch
`feat-v1.6.0-beta.16` está aberta sobre ela, com as seis alterações de
source/docs descritas na seção **Beta 16** concluídas. A validação final local
passou sob Node `26.4.0` / npm `11.17.0`; a CI do PR continua pendente. O
candidato beta.16 não está publicado nem é release-ready. Os contratos existentes em
[docs/RELEASE.md](docs/RELEASE.md),
[docs/RELEASING.md](docs/RELEASING.md) e
[docs/INSTALLATION.md](docs/INSTALLATION.md) continuam referenciados. Planos
executivos detalhados só serão criados quando um workstream ativo precisar
deles, com links para evitar duplicar requisitos. O modelo permanece um master
com três seções/workstreams; nenhum número de planos adicionais é presumido.

---

## ✅ Contrato atual — entregue e suportado

| Área | Contrato verificável |
|---|---|
| OpenCode V1 | `src/plugin.ts` preserva o plugin V1 **em código**: `hashline_edit`, as 3 goal tools, `pantheon_cost`, `pantheon_model`, BackgroundJobBoard, eventos/tool hooks e compaction hook. Sob um host V2 a entrada `.ts` que essa geração registra é rejeitada; sob um host V1 ela é a superfície. O caso que a derrubava — o seletor de geração escolhendo `v1` contra um host V2 — foi corrigido pelo PR #202 (P0-1, `CLOSED (code)`). |
| OpenCode V2 | O host da série 2.x **rejeita caminhos de arquivo `.ts`** nas arrays de plugin e descarta a entrada. A recusa foi **medida em runtime** no host `2.0.22`, cujo log traz `configured plugin path must be a directory` — essa string é do **host**, não do repositório: código, testes e docs do repo citam apenas a paráfrase `must be a directory`. Arquivos dentro de um **diretório** `<configDir>/plugin/` ou `<configDir>/plugins/` são aceitos. As chaves singular `plugin` e plural `plugins` são ambas lidas — a normalização concatena a singular na plural. **A forma do lado V2 está correta e comprovadamente carrega**: `src/plugin-v2.ts:1078-1079` declara `plugin = define({` com `id: 'pantheon-opencode-v2'`, `:1081` define `async setup`, e `:1220` faz `export default`; `define` é identidade no SDK instalado, e `src/plugin-v2/` contém o `index.ts` que o resolver acha sem `package.json`. O que derrubava a superfície era o installer **remover** essa entrada, não ela ser inválida (P0-1, corrigido pelo PR #202). O adapter continua sem registrar Board nem compaction V1, e não é um adapter de paridade do runtime V1. |
| Installer | Seleciona **uma única** geração (`v1`, `v2` ou `auto`). `v1` registra **arquivos** `.ts` sob a chave singular `plugin`; `v2` registra o **diretório** `src/plugin-v2` sob a chave plural `plugins`. `auto` é o **default** e resolve contra o host, na ordem: explícito > `OPENCODE_VERSION` > `OPENCODE_BIN` casando `/(?:^\|[\\/])opencode2(?:\.exe)?$/i` > probe de `--version` do host (major ≥ 2 → `v2`) > aviso e fallback `v1` (`scripts/install/opencode-version.mjs:213-288`). O default `'v1'` que curto-circuitava era o defeito de **P0-1**, corrigido pelo PR #202 (`80bac52`, 2026-10-04): `bin/pantheon-init.mjs:427`, `scripts/install/opencode.mjs:528` e a assinatura do resolver (`scripts/install/opencode-version.mjs:213`) passam `'auto'`. P0-5 e P0-6 são defeitos independentes do gate de geração e seguem `OPEN`. |
| MCP servers | Os 5 servidores rodam em MCP2.2 + FastMCP 4.0.10, com `httpx==0.28.1` pinado no runtime compartilhado. Fontes canônicas em `src/mcp/*.py`; o installer copia de lá. A cópia `scripts/memory_mcp_server.py` é **intencionalmente divergente** (contrato de memória leve, sem ferramentas de codemap) e essa assimetria é portada por `tests/test_mcp_scripts_sync.py` — é desenho, não drift. |
| TUI | `pantheon-tui` é componente separado, registrado em `tui.json` somente quando `plugins` é instalado. Native tasks exigem origem, relação parent/child e status fornecidos explicitamente pelo host; ausência de Markdown não é autodetecção. |
| Histórico e recuperação | `.pantheon/delegations/` guarda relatórios históricos do antigo engine V1 de delegação (removido em favor do `task()` nativo). Jobs antigos/running não são auto-retomados após restart. |
| Code-mode | Execução de scripts é opt-in via `manifest.json` com SHA-256 por script; resolução project-first (`PANTHEON_PROJECT` → cwd) com fail-closed após seleção; `doctor` valida o manifest sem regenerá-lo. |
| Native tasks no painel | O mirror de children de `task(background=true)` no board compartilhado (singleton globalThis, à prova do double-load npm+repo) está implementado em `src/plugin.ts`, e o painel de Delegations o lê. É um recurso **V1-only**: sob V2 o `src/plugin.ts` não é a superfície, então **não tratar como entrega de paridade V2**. |
| Painel de Delegations v2 | Atividade ao vivo por delegação (`↳ <tool> <resumo>` via message.part), estado `retry` distinto (⟳) e seção `Archived (n)` paginada para relatórios terminais antigos. |
| Update e freshness | `pantheon-opencode update` instala o novo pacote pelo dist-tag e re-roda init; o postinstall sincroniza todos os artefatos de cópia; marker `install-state.json` + `doctor` detectam drift de versão; CI falha se o `dist/` da TUI commitada estiver stale. |
| Installer resiliente | Pré-checagens de python3/npm antes de escrever; `opencode.json` atômico com `.bak`; venv falha → instalação completa sem entradas MCP (aviso); refs Pantheon de instalações antigas (node_modules de outros prefixes/caches npx) são podadas a cada init. A poda resolve refs *velhos*; não resolve ref *que aponta para a árvore de instalação errada* — a config grava um caminho absoluto re-resolvido só no `init` (P0-6). |
| Estado entregue | v1.6.0-beta.4 está em `main` (PR #197). O PR #196 (migração MCP2/FastMCP4) foi mergeado. |

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
> **Reconciliação de 2026-10-19:** o limite acima descreve o estado anterior ao
> source wiring pós-#248; veja a reconciliação de P2-12 abaixo.

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
não por esta reescrita; a referência nomeia o PR e é datada. `CLOSED (runtime)` — canary local passou; `OPEN` — o defeito
persiste e o item continua vivo. `WITHDRAWN` — a alegação do registro foi
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

**Contagem.** Um **item** é um registro vivo — `OPEN` ou `CLOSED` (de qualquer
tipo). O tombstone `WITHDRAWN` preserva o id e não conta como item, porque não
descreve trabalho. São 30 registros: 29 itens (4 `CLOSED (doc)`, 2
`CLOSED (code)` — P0-1 e P1-6 — e 23 `OPEN`) e 1 tombstone, **P0-2**, cuja
alegação remanescente vive em **P2-10**.

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

**P0-3 — `doctor` dá verde ao backend de uma tool sem checar seu registro (OS-2).**
**Status: OPEN.** `probeNodeSqlite` (`scripts/doctor.mjs:1810-1822`) importa
`node:sqlite` num child process e `classifyNodeSqliteProbe` (`:1831-1842`) emite
`pantheon_cost read-only backend supported` (L1835); `checkNodeRuntime`
(`:1844-1855`) chama `pass()` nesse resultado. O probe valida o **backend**,
não o **registro no plugin**: um `pantheon_cost` ausente da superfície por
qualquer causa ainda recebe verde — inclusive a causa que P0-1 era, hoje
corrigida por #202. Gate de saúde que dá falso verde é pior que gate
ausente: mascara a ausência em vez de expô-la.

**P0-4 — O catálogo de tools oscila dentro de uma mesma sessão.**
**Status: OPEN — nunca diagnosticado.** Uma tool existente e depois ausente
entre turnos torna qualquer verificação que dependa dela **inviável por
construção**: não há medida confiável enquanto o instrumento muda. Numa sessão
de validação o catálogo foi completo → parcial → completo → parcial → completo,
cinco transições, e a oscilação causou uma falha de escrita real que só pôde
ser contornada. Isso é pior que qualquer falha individual de tool, porque
invalida o próprio instrumento de medição — e por isso precede tudo que dependa
de observação de catálogo, incluído o probe que originou P0-1. Sem diagnóstico:
não se sabe se a causa é cache de catálogo, ciclo de vida de plugin, ou
re-registro concorrente.

**P0-5 — Nomes de ação de permissão desatualizados quebram o enforcement
read-only em host V2.**
**Status: OPEN.**
**Independente de P0-1 (já corrigido):** este defeito é de **config gravada em
disco**, então morde com o plugin carregando normalmente. P0-1 removia um módulo
do processo; P0-5 remove um *deny*.

**O que é entregue, não interno.** Os 14 templates em `src/agents/*.md` declaram
`permission.bash` (14/14) e `permission.task` (14/14); `src/agents/mnemosyne.md:39`
declara `permission.write`. `scripts/install/opencode.mjs:948-950` copia o bloco
`permission` do frontmatter **verbatim** para a config instalada, e
`src/routing.yml:531-533` semeia um `permission.task` de topo. São regras
entregues ao usuário.

**O tradutor não conhece duas das três chaves.** No ramo `v2`,
`scripts/install/config-migration.mjs:441-444` converte o `permission` de cada
agente para `permissions` através de `convertPermissionsV1toV2`. O mapa
`V1_PERMISSION_TO_ACTION` (`:33-39`) tem **quatro** entradas — `bash`, `skill`,
`edit`, `websearch`. **`task` e `write` não estão nele**, e caem no passthrough
`V1_PERMISSION_TO_ACTION[key] || key` (`:53`), que emite a chave V1 **como se já
fosse um nome de ação V2**. O mapa reverso (`:75-80`) herda exatamente a mesma
lacuna, então o drift também não é detectável na volta.

**A direção do mismatch não é resolvível a partir do repositório — e isso também
é o defeito.** O mapa do repo afirma `bash → shell` (`:34`), enquanto a
documentação de permissões do host, auditada em 2026-10-03, continua chaveando
permissão por **nome de tool** (`bash`, `task`, com `write` coberto por `edit`).
O repo não pode estar certo nas duas direções. O item é escrito assim de
propósito: **quaisquer que sejam os nomes reais, `task` e `write` são as duas
chaves que o tradutor do repo não conhece** — e a cobertura do tradutor é
incompleta em relação às chaves que o próprio repo entrega. Auditoria datada da
documentação do host; a lista de defaults do host também é propriedade de uma
versão, não do repositório.

**Efeito líquido.** O enforcement read-only dos 14 agentes — `bash: deny`,
`task: deny`, e o `write` restrito do `mnemosyne` — chega ao host V2 com `task` e
`write` emitidos sob o nome da chave V1, que a documentação do host não lista
como nome de ação. **O que o host faz com uma chave que não reconhece não é
verificável a partir do repositório**, e por isso não é afirmado aqui. Nota: o
ramo `v1` não executa **nenhuma** dessa tradução
(`scripts/install/opencode.mjs:1348-1350`); isso é correto num host V1, e o ponto
do item é a cobertura do tradutor que roda no ramo `v2`.

**P0-6 — A config grava um caminho absoluto para a árvore de instalação, e ele
só é re-resolvido no `init`.**
**Status: OPEN.**
Isto faz um upgrade **não ter efeito silenciosamente**, que é a classe de falha
mais cara que existe: nada quebra, nada avisa, e a versão antiga continua
rodando.

**O defeito estrutural.** `resolveInstalledPlugin` resolve refs Pantheon para
caminho **absoluto** — `join(ROOT, normalized)`
(`scripts/install/opencode.mjs:215`, e `:218` para o ref legado) — e o ramo `v2`
grava esse absoluto na config (`scripts/install/opencode.mjs:1134-1139`). `ROOT` é
onde quer que o pacote
tenha sido resolvido no momento daquele `init`: um prefixo global, ou a árvore de
um cache de `npx`. Um registro que aponta para dentro de um cache não é uma
instalação durável: limpeza de cache, ou qualquer ambiente onde esse cache não
existe, deixa o registro pendurado.

**Por que `update` não fecha o buraco.** `bin/pantheon-init.mjs:173` faz
`npm install -g`, e `:183` re-roda `init --yes --headless` — então o caminho de
`update` **re-resolve**. O buraco está em toda rota de upgrade que não passa por
esse comando: `npm i -g` direto, um `npx` que resolve uma versão mais nova do que
a config registra, ou uma árvore de instalação que muda de lugar. A poda que a
tabela de contrato já descreve limpa refs *velhos*; ela não conserta um ref que
aponta para a árvore errada.

**Corroboração externa.** A documentação de plugins do host afirma que plugins
npm resolvidos são instalados em startup e cacheados em um diretório de cache
próprio, sem invalidação declarada — logo um restart normal não puxa uma versão
cacheada mais nova. Auditoria datada da documentação do host, 2026-10-03.

**Auditoria datada (2026-10-04), não estado durável:** naquela máquina o registro
vivo resolvia para dentro de um cache de `npx` em vez de uma instalação global
durável, a instalação global estava uma versão atrás da cópia cacheada, e o
marker de freshness existia só sob o cache. Esses números mudam; o defeito — um
caminho absoluto para uma árvore de cache gravado na config, re-resolvido apenas
no `init` — é do código.

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
`scan-secrets.sh` casa **valores** de secret no input da tool call — as expressões
de `HIGH_CONFIDENCE_PATTERNS` e `LOW_CONFIDENCE_PATTERNS`,
`scripts/hooks/scan-secrets.sh:19-38` — e o hook dispara em
`tool.execute.before` (`src/plugins/pantheon-hooks.ts:1172`, payload montado de
`output.args` em `:1183`), ou seja, sobre **argumentos**, nunca sobre acesso ao
sistema de arquivos. O input de uma chamada `read` é um **caminho de arquivo**, e
um caminho não casa com nenhum padrão de valor. O hook **não tem capacidade de
gating por leitura**: um agente que já sabe o caminho lê o arquivo sem que nada
intervenha, e a documentação de plugins do host mostra o caminho oposto como
idiomático — o exemplo de `.env protection` intercepta `input.tool === "read"` e
inspeciona `output.args.filePath`. Auditoria datada da documentação do host,
2026-10-03.

**Onde a correção pertence.** Qualquer modelo de permissão que queira restringir
**leituras** tem de viver nos grants de `permission` que o installer semeia —
`scripts/install/opencode.mjs:948-950` (cópia do bloco `permission` do
frontmatter de cada agente), `:998-999` (grant de `bash` por agente),
`:1158-1211` (bloco `permission` de topo, com a lista `bash` de allow por
prefixo) e `:1325-1341` (defaults de `permission.mcp` por servidor MCP). O
secret scanner é a camada errada para essa pergunta, porque a pergunta não é
"esse texto é um segredo" e sim "esse caminho deveria poder ser lido".

**P1-12 — A matriz caller/target de delegação não é replicada no contrato V2.**
**Status: OPEN.**
O guard V2 é construído sem `getSessionAgent`, `isRootSession` e `isChildSession`
(`src/plugin-v2.ts:870`), então a matriz é uma **convenção** e não um controle no
V2. Duas causas independentes, e a distinção importa porque a que parece estrutural
não é a que nega: (1) **falta `getSessionAgent`** — o V2 não mantém mapa
session→agente, lendo o agente do próprio evento `execute.before`, e sem lookup o
guard chamaria `isDelegationAllowed(undefined, target)` → `false`
(`src/pantheon/delegation-enforce.ts:145`) e lançaria *caller agent is unavailable*
em **toda** chamada `task()`; (2) **hierarquia não semeada** — o registry controla
exatamente duas coisas (o deny de depth-2 e o gate de root) e, sem seed, `isChild` é
`false` para toda sessão. Um `isRoot` não semeado devolve `true` e **`true` passa**
o gate de root (`src/pantheon/delegation-enforce.ts:110`) — ele não nega. A causa foi
**corrigida em 2026-10-04 no PR #204** (a cadeia invertida que este item carregava
antes foi reescrita em `src/plugin-v2.ts`, `docs/UPGRADING.md` e no seed
compartilhado); o que #204 **não** fechou é a lacuna, que ele declarou fora de
escopo. **Bloqueado numa observação que só uma run beta pode fazer:** se o campo
`agent` do evento `execute.before` é o agente **delegante** no meio do handoff de uma
chamada `task()`. Nada no repositório mede isso — o canary registra
`Object.keys(ctx)`, não payloads de evento
(`tests/canary/plugin-v2-tool-canary.test.mjs:524`) — e a resposta decide se o
`getSessionAgent` ausente tem substituto. Até essa run, o item não é
implementável. Mapeado em
[PERMISSIONS-QUALITY-DELEGATION.md](docs/PERMISSIONS-QUALITY-DELEGATION.md) §3.5.

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

**P2-12 — `execute.after` no V2: guard de resultado vazio e dispatch filho verificados ao vivo. Status: CLOSED (runtime canary).**
**Reconciliação de 2026-10-20.** A descrição anterior dizia que o hook V2 não
tinha comportamento próprio, e a revisão seguinte dizia incorretamente que o
guard não reconhecia o placeholder do host e que havia lacunas de código no
adapter. O adapter atual cria o guard (`src/pantheon/v2-execute-after.ts:156-160`),
preserva payload estruturado significativo sem texto e deixa conteúdo textual
vazio chegar ao guard (`src/pantheon/v2-execute-after.ts:184-188`), e executa a
cadeia do guard/sandbox/read enhancer
(`src/pantheon/v2-execute-after.ts:203-205`). O comportamento de guard e as
regressões correspondentes estão implementados e os testes passam; não há
alteração de código pendente neste item. O canary scripted-provider local no host exato
OpenCode `v2.0.30` (`V2 host replaces a no-text child result with an error and preserves completed status`, `tests/canary/plugin-v2-tool-canary.test.mjs`) passou: 19 passed, 0 failed, 3 optional skipped; filho sem texto → `EMPTY_TASK_ERROR`, status da tool do pai `completed`. Sem credenciais/chamadas reais de provedor; sem alegação de isolamento abrangente de egress.

As cadeias restantes — `permission.evaluate`, `session.prompt` e compaction —
seguem **fora de escopo**, declaradas em
[PERMISSIONS-QUALITY-DELEGATION.md](docs/PERMISSIONS-QUALITY-DELEGATION.md) §3.5 e
em [UPGRADING.md](docs/UPGRADING.md).

### Beta 11 — Runtime, governança, persistência e release

**Status da Beta 11: ENTREGUE E PUBLICADA — superada pela beta.15.**
**Inventário reconciliado em 2026-10-20:** `main` == `origin/main` ==
`v1.6.0-beta.15` (`fd22b0c`); a branch `feat/v1.6.0-beta.16` está **aberta**
sobre ela. A contagem de "18 commits locais à frente de `origin/main`" que esta
seção citava era **datada** e **não** descreve mais o estado do repositório —
não reaproveitar. O registro de fases abaixo é **histórico** e permanece como
está. Commits de fase: `c2f5698` (contrato de ferramentas e governança
runtime), `6fedf83` (council e claims + limites de persistência), `1d9b20a`
(overrides manuais V2 project-scoped de modelo), `2848075` (caminho
enxuto/proporcional e redação de custo), `c6f5280` (janela e limites de agregação
do `pantheon_cost`) e os cinco commits da fase **Setup** — `66bf918`, `2f53f01`,
`2e4066d`, `4ae5283`, `55ecef4`, mais o commit extra de preparação de release
`8a11282` (`chore(release): v1.6.0-beta.11`) na ponta desta branch. As fases 1 e 2
passaram (`c2f5698`,
`6fedf83`); a fase de persistência foi entregue em `6fedf83` com limites
documentados e testes de fronteira; o subconjunto de overrides manuais da fase de
modelo ativo está **IMPLEMENTED — COMMITTED — REVIEWED** em `1d9b20a` (Themis
PASS_WITH_NOTES e verificação de dependência isolada); a documentação do caminho
enxuto/proporcional foi entregue em `2848075`, com a medição ainda aberta; a
fatia de relatório de custo em `src/pantheon/cost-command.ts` está **COMMITTED —
REVIEWED** em `c6f5280` (`docs: describe pantheon_cost window and aggregation
limits`; Themis PASS_WITH_NOTES e validação isolada: 36/36 testes, typecheck pass,
Biome direcionado pass); a fase **Setup** está **DELIVERED — COMMITTED —
REVIEWED** nos cinco commits `66bf918`, `2f53f01`, `2e4066d`, `4ae5283`,
`55ecef4` (o que foi entregue e a verificação estão na fase 6). Permanecem
abertos: a medição de orquestração (fase 4, **bloqueada por capacidade**, não
entregue), o tratamento de `specific_claims` (fase 2) e quais capacidades runtime
estão realmente disponíveis para todo/background/board. Foram **decididos** nesta
rodada: V2/empacotamento/catalog (**manter como está**), presets/catálogo V1
(**congelado**, sem migração) e economia de testes/tiers (fase 10, regra
normativa entregue via `src/instructions/test-economy.instructions.md`, **split
não aplicado**); registry/release está **autorizado**: a preparação de release
está commitada (`8a11282`, `chore(release): v1.6.0-beta.11`) e o PR **#241** está
aberto para `main`; a publicação fica **pendente** de um dispatch manual do
workflow `Release` (`release_channel=beta`, dist-tag `beta`) **após o merge e o
CI verde**. O push de tag não publica — é o workflow que cria a tag. **Nada está
publicado** enquanto esse workflow não rodar, e a Beta 11 não está "released" até
a publicação concluir com sucesso. A própria atualização deste
ROADMAP permanece não commitada nesta árvore; nada nesta atualização declara
Beta 11 nem qualquer trabalho não commitado como entregue.

**Objetivo.** Reconciliar os contratos documentados com o runtime observado,
fortalecer a verificação de persistência e setup, e preparar o pacote/catalog para
V2 sem expandir permissões implicitamente. Medir resultados antes de alterar a
orquestração ou alegar redução de custo.

**Evidência Beta-10 (resultado, não trabalho Beta-11).** Um projeto externo React
19 + Vite 8 + TypeScript passou 67/67 testes, buildou em 203 ms e teve zero
vulnerabilidades em `npm audit`. No browser foram verificados fetch runtime de
`/offers.json`, atualização de dados sem rebuild, acessibilidade, teclado,
responsividade e retry. A correção de URL scheme ocorreu naquele projeto externo,
em `/home/ils15/projetos/site_ofertas`, que não é este repositório e não deve ser
alterado. O follow-up MED sobre tamanho do link foi aceito após o teste; não abre
trabalho no Pantheon.

#### Fases e status

1. **Contrato de ferramentas e governança runtime — PASSED (commit local `c2f5698`).** Inventariar e
   reconciliar catálogo, instruções, documentação e comportamento real de todo,
   `memory_store`, acompanhamento de background e board. O runtime observado
   expôs `subagent`, `glob`, `grep`, `read`, `skill`, `question`, `webfetch`,
   `websearch` e `execute`, mas não `todo_write`, `memory_store`, `task_status` nem
   `board.registerLaunch`. A allowlist MCP de memória não concede
   `memory_store`; métodos do board são internos. Validar `task_status` no
   runtime antes de documentá-lo como disponível; não declarar `todo_write`
   callable sem prova. Corrigir a nomenclatura `task()` vs `subagent` e avaliar o
   overhead do caminho indireto `execute` + busca. **Limite:** priorizar contrato
   e documentação, sem expansão de tools/permissões. Qualquer nova
   permissão/tool/API requer aprovação explícita do usuário e revisão Themis.
   **Verificação:** fase aprovada/concluída; resultado registrado no commit
   local `c2f5698` (`docs: align host tool and background contracts`).
2. **Council e claims — PASSED (commit local `6fedf83`).** Definir que a primeira rodada paralela pode
   omitir `agreement_signals` ou retornar `none`; derivar consenso das posições
   efetivamente coletadas; proibir autorreferência e limitar rebuttal a respostas
   visíveis. Avaliar `specific_claims` — hoje autorrelato sem validador — como
   advisory, opcional ou removível, e como validar claims na síntese. O relato de
   fabricação na Beta-10 é um relato, não prova de defeito no código; três
   contagens iguais a 7 são sinal, não prova. **Dependência:** fase 1 para alinhar
   contrato e evidência runtime. **Verificação:** fase aprovada/concluída;
   resultado registrado no commit local `6fedf83` (`fix: correct council
   protocol and persistence bounds`).
3. **Persistence — PASSED (commit local `6fedf83`).** Documentar e testar os limites existentes de
   `context_save`: 65.536 bytes no total; até 100 itens tail; 4.096 bytes por
   linha do tail; soma do tail limitada a 65.536 bytes. Os erros passaram a ser
   específicos e acionáveis (nomeiam o limite e o valor observado) em vez do
   erro genérico antes emitido, sem truncar ou descartar tail silenciosamente.
   **Verificação:** entregue em `6fedf83` — `src/mcp/mcp_persistence.py` e
   `scripts/mcp_persistence.py` rejeitam excesso com a mensagem específica,
   `docs/persistence-mcp.md` documenta os limites e a rejeição sem truncamento, e
   `tests/test_mcp_persistence_server.py` adicionou testes de fronteira para cada
   limite: conteúdo (65.536/65.537 bytes), contagem de itens tail (100/101),
   bytes por linha do tail (4.096 bytes aceitos / 4.097 rejeitados; no caso
   multibyte UTF-8, 2.048 caracteres `é` = 4.096 bytes aceitos / 2.049 = 4.098
   bytes rejeitados) e soma agregada do tail (65.536/65.537 bytes). Os testes
   verificam a rejeição explícita, com mensagem específica do limite e do valor
   observado; eles não releem o conteúdo previamente armazenado para comprová-lo.
   A preservação do que já estava salvo é a semântica documentada de
   rejeitar-sem-truncar (`docs/persistence-mcp.md`), não uma alegação que estes
   testes verifiquem diretamente.
4. **Orquestração proporcional e medição — caminho enxuto DOCUMENTED (`2848075`); medição OPEN — BLOCKED BY CAPABILITY.** Propor um caminho enxuto
   para tarefa pequena/reversível (um especialista adequado, sem plano/council de
   rotina) e manter todos os gates para trabalho material/sensível. Medir
   overhead, resultado e risco antes de reduzir agentes; não usar `general` ou
   `explore` e não remover agentes com base em uma tarefa. O baseline citado de
   ~10M tokens / nominal 24h abrangia cerca de 20 dias de sessões, não uma tarefa.
   A tool publicada `pantheon_cost` agrega tokens **por agente** — por agente
   **e fase** no ramo V1, e por agente com a fase reportada como o literal
   `'unknown'` no ramo V2 — e **não** tem dimensão de sessão, modelo, provedor
   nem USD; `days=1` é janela móvel, não isolamento de tarefa. A agregação
   **por sessão existe apenas no harness `bench/`**
   (`bench/lib/aggregate.mjs` → `aggregateSessionTree`, com o
   `sessionBreakdown` por sessão introduzido na beta.15 em
   `bench/lib/collector.mjs`), e `bench/` **não é publicado** de propósito (sem
   entrada `bench` em `files` no `package.json`) — portanto ela **não** é uma
   capacidade da tool entregue. Registrar timestamps e janelas; não alegar
   savings ou delta específico sem atribuição. **Entregue em `2848075`:** a
   orientação do
   caminho enxuto/proporcional e a redação de custo/modelo
   (`docs/PERMISSIONS-QUALITY-DELEGATION.md` §3.6, `src/agents/zeus.md`,
   `src/instructions/zeus-timeout-retry.instructions.md`, `docs/QUICKSTART.md`,
   `docs/mcp-tools.md` e `README.md`). A alteração de redação/saída do relatório
   de custo em `src/pantheon/cost-command.ts` está agora **commitada e revisada**
   em `c6f5280` (`docs: describe pantheon_cost window and aggregation limits`;
   Themis PASS_WITH_NOTES e validação isolada: 36/36 testes, typecheck pass,
   Biome direcionado pass) e não é mais trabalho não commitado. **Dependências:**
   fases 1 e 2 para
   classificar chamadas/custos e evidência. **Verificação planejada (medição):**
   comparação com janelas e atribuição explícitas, com risco e resultado
   registrados; nenhum delta será promovido sem medição atribuível.
   **Bloqueio de capacidade (registrado):** a tool publicada `pantheon_cost`
   agrega tokens **por agente** — por agente **e fase** no ramo V1, e por agente
   com a fase reportada como o literal `'unknown'` no ramo V2 — e **não** isola
   tarefa/sessão/modelo/provedor nem produz USD. A agregação **por sessão só
   existe no harness `bench/`**, que **não é publicado**
   (`bench/lib/aggregate.mjs` → `aggregateSessionTree`; `sessionBreakdown` por
   sessão introduzido na beta.15 em `bench/lib/collector.mjs`), logo nenhum
   delta atribuível foi produzido e nenhuma economia deve ser alegada. A
   medição permanece **aberta, bloqueada por capacidade** — não entregue.
5. **Modelo ativo — subconjunto de overrides manuais V2 IMPLEMENTED — COMMITTED — REVIEWED (`1d9b20a`); itens residuais abertos.** **Decisão de política:** V2 não aplica presets
   estáticos nem `PANTHEON_MODEL_PRESET`; preserva o modelo default do host e só
   aplica overrides manuais **project-scoped** por agente (`model` e `variant`)
   no transform de agente; arquivos globais não são lidos nem aplicados. V2
   `set`/`reset` são project-only e rejeitam `scope=global` e flags de autorização
   explícitas, sem escrita. Não existe prompt/API V2 de aprovação independente;
   overrides globais exigem autorização humana explícita futura e não são
   suportados por esta ferramenta. Marker legado não é apagado nem ativa
   provider/modelo. Não há wizard de rotas. V1 mantém o comportamento legado, sem
   alteração. `status` informa a configuração project-scoped, não prova qual modelo
   executou a completion. **Decisão aprovada
   explicitamente pelo usuário:** warnings de overrides são acessíveis por
   `pantheon_model status`. O server plugin V2 não tem API documentada de toast
   ou notificação visível durante o transform; portanto, não há toast nem aviso
   proativo prometido. Override inválido/malformado preserva o modelo do host e
   registra diagnóstico interno; o usuário deve chamar `status` para ver o
   warning. Continua pendente rastrear o mismatch observado entre preset
   go-free/config Zeus
   `opencode/big-pickle` e runtime `opencode-go/deepseek-v4.1-flash`, sem
   presumir restart lag (item residual aberto: rastrear esse mismatch de runtime).
   **Dependência:** fase 1 para definir evidência runtime. **Verificação:**
   subconjunto de overrides manuais V2 entregue, commitado e revisado em
   `1d9b20a` (`feat: add project-scoped V2 model overrides`) — Themis
   PASS_WITH_NOTES e verificação de dependência isolada: 5 testes focados,
   incluindo `plugin-v2-contract` 113/113, typecheck pass e Biome direcionado
   pass; o lint completo tem apenas um erro pré-existente no inalterado
   `tests/agents-baseline-contract.test.mjs`. Permanece planejado capturar, para
   a mesma operação, configuração e observação runtime como campos distintos, ou
   registrar explicitamente quando o runtime não fornece esta última.
6. **Setup — DELIVERED — COMMITTED — REVIEWED (`66bf918`, `2f53f01`, `2e4066d`,
   `4ae5283`, `55ecef4`).** Entrega em cinco fases commitadas: (1) `66bf918` —
   preview **por arquivo** do change set no dry-run, com **zero escritas**;
   (2) `2f53f01` — **conjunto de backup exato** (cópia byte-a-byte) gravado
   **antes da primeira escrita**, em diretório `0700` com arquivos e manifest
   `0600`, retendo os 5 conjuntos mais recentes, mais o comando `restore`, que
   **recusa restaurar** um conjunto que falhe na verificação de integridade;
   (3) `2e4066d` — **gate de autorização explícita `--yes`** antes do apply, com
   cancelamento e códigos de saída `0` (ok / plan-only, nada aplicado), `1`
   (falha), `2` (apply sem autorização), `3` (drift) e `130` (cancelado);
   (4) `4ae5283` — **detecção de drift** entre plano e apply **dentro de uma única
   execução** (exit `3`) — drift **entre invocações distintas não é detectável**,
   pois nenhum plano é persistido; (5) `55ecef4` — **relatório de falha** com os
   caminhos já aplicados e dica de recuperação via `restore` (**sem rollback
   automático**), mais **auditoria de saída secret-safe** (canário + secret-scanner
   sobre stdout/stderr). **Verificação:** gates do Themis, validações isoladas em
   tiers por fase e um gate final de suíte completa (ver "Critérios de verificação"
   e a lição do gate final em "Riscos"). **Limites:** o `restore` recupera a partir
   do conjunto de backup e não é rollback automático; o drift cobre apenas a
   coerência plano↔apply de uma execução; a auditoria de segredos cobre as saídas
   do installer, não todo o repositório.
7. **V2, empacotamento e model catalog — PLANNED — DECIDED: keep as-is (no change this beta).** Reconciliar o pacote atual —
   root pinado em `@opencode-ai/plugin@1.18.33` e `@opencode-ai/sdk@1.18.33`,
   exports apontando para `.ts` e sem build root — com a recomendação do council
   de ESM compilado em `dist/`, exports `types`/`default`, `.d.ts`, sem pin exato,
   peer range + runtime detection e `@opencode/plugin` 2.x. A recomendação fica
   **registrada, não aplicada**. **Decisão (Beta 11):** manter como está — root
   pinado em `@opencode-ai/plugin@1.18.33`/`@opencode-ai/sdk@1.18.33`, exports
   `.ts` e sem build root — para não arriscar consumidores existentes; a migração
   será revisitada depois. Testar fontes, `dist/` e tarball quando ela for
   reconsiderada. As observações de hosts `2.0.22` e `2.0.27` não estabelecem uma
   versão universal. **Dependência (resolvida nesta rodada):** o formato de
   entrada foi decidido como "manter como está"; qualquer alteração de
   metadados/build fica adiada. **Verificação planejada:** build reproduzível,
   exports/types/assets corretos no artefato compilado e inspeção/teste de
   consumo do tarball.
8. **Presets e catálogo — V1 CONGELADO (subconjunto de overrides manuais V2 IMPLEMENTED — COMMITTED — REVIEWED `1d9b20a`).** **Decisão V2:** presets estáticos são
   aposentados como seleção efetiva; não haverá wizard nem ativação implícita.
   V2 usa apenas overrides manuais project-scoped por agente e deixa o default do host intacto
   quando não houver override. Arquivos globais não são lidos/aplicados; mutações
   globais não são suportadas por `pantheon_model`, pois não há API V2 de aprovação
   humana independente. Suporte futuro exigirá autorização explícita separada.
   Markers `preset` e `PANTHEON_MODEL_PRESET` são
   legados/ignorados, sem apagar arquivos. O caminho V1 permanece **congelado**:
   inalterado, mantendo os IDs estáticos de `routing.yml`, sem migração de
   presets neste beta. Configuração inválida/malformada mantém o modelo do
   host, registra diagnóstico interno e expõe warning via `pantheon_model status`;
   não há toast nem notificação proativa documentada no transform V2. Essa
   limitação foi explicitamente aprovada pelo usuário. `src/routing.yml` contém
   IDs estáticos; sua migração V1 está **congelada** (não autorizada neste beta);
   `.pantheon/tiers.json` é MCP tier. A separação do catálogo legado e a
   migração V1 dos presets ficam **congeladas** para este beta,
   sem wizard ou validação de preset V2. **Dependência:** fase 7 para
   compatibilidade de pacote. **Verificação:** subconjunto de overrides manuais
   V2 entregue e revisado em `1d9b20a` (default host intacto, marker legado
   inerte, override/variant manual aplicado ao agente correto e reset sem
   fallback para preset). A migração V1 dos presets e a separação do catálogo
   legado ficam **congeladas** (sem migração neste beta).
9. **Registry e release — AUTORIZADO (preparação commitada; publicação pendente).** Incluir `mcpName` onde o schema exigir e
   validar conteúdo do tarball, exports/types/assets, frescor do build e consumer
   smoke. Validar instalação global no sandbox `~/pantheon-sandbox/`, não no
   ambiente de desenvolvimento. **Dependências:** fases 7 e 8 para artefatos e
   catálogo finais. **Verificação planejada:** checks do pacote publicado no
   sandbox, smoke test de consumidor e confirmação do estado do tarball.
   **Decisão (Beta 11):** **autorizado** pelo usuário — a preparação de
   release está commitada (`8a11282`, `chore(release): v1.6.0-beta.11`) e o PR
   **#241** está aberto para `main`; a publicação fica **pendente** de um
   dispatch manual do workflow `Release` (`release_channel=beta`, dist-tag
   `beta`) **após o merge e o CI verde**. O push de tag não publica — é o
   workflow que cria a tag. **Nada está publicado** enquanto esse workflow não
   rodar, e a Beta 11 **não está "released"** até a publicação concluir com
   sucesso.
10. **Test economy e suites em tiers — IN PROGRESS (regra normativa entregue;
    DECIDED: split não aplicado — manter como está).** Os agentes devem escrever testes menores e
    focados e parar de produzir suítes exaustivas/repetitivas que tornam cada
    fase lenta: um comportamento → um teste direcionado, sem duplicar a mesma
    cobertura entre arquivos; sem E2E/full-install ou testes dependentes de rede
    a menos que a mudança altere de fato esse caminho ponta a ponta; sem
    asserções redundantes de cópia/formatação nem asserções que apenas
    reafirmam a implementação ("testar o teste"). A regra normativa
    compartilhada é `src/instructions/test-economy.instructions.md`, incluída em
    `AGENTS.global.md` (sem `agents:` scoping) e portanto entregue a todos os
    agentes. Suítes pesadas/lentas — hoje `tests/install-opencode.test.mjs`
    (~12 min) e `tests/install-e2e.test.mjs` (~13 min), por realizarem
    instalações reais (venv/pip, `npm install` em diretórios temporários) — devem
    ser **opt-in** por script/tier separado, nunca por edição nem por fase;
    roda-se apenas o subconjunto afetado. A regra não enfraquece gates
    existentes: auth, segurança, integridade de dados e thresholds de cobertura
    exigidos permanecem obrigatórios. **Verificação planejada:** o tier rápido
    roda por default; as suítes pesadas de instalação/E2E ficam opt-in e
    reservadas a gates de release/pré-release; a validação por fase permanece sob
    um orçamento explícito. **Proposta de split NÃO aplicada (preserva CI):**
    `package.json` e CI não foram alterados porque `test:all` está travado por
    `tests/ci-workflow-fail-closed.test.mjs` para incluir `npm run test:node` (a
    suíte completa, incluindo as suítes pesadas) e o job `test-suite` do CI roda
    `npm run test:node` diretamente; tornar o rápido o default exigiria editar
    esse gate test e o workflow de CI, o que está fora do escopo desta entrega.
    Aplicar o split apenas junto da edição revisada daquele contrato e do CI.
    **Decisão (Beta 11):** manter o **split não aplicado** — `test:node` e o CI
    permanecem como estão (suítes pesadas incluídas); a validação por fase
    seleciona o tier manualmente e o `npm run test:node` completo continua sendo o
    gate de release.

**Critérios de verificação da Beta 11.** Cada fase deve manter evidência
reproduzível e registrar separadamente resultado, limitações e decisões. Fases
1/2 passaram e a fase 3 foi entregue em `6fedf83`; a fase 6 (Setup) foi entregue
nos cinco commits `66bf918`/`2f53f01`/`2e4066d`/`4ae5283`/`55ecef4`; o
subconjunto de overrides manuais V2 (`1d9b20a`) e a documentação do caminho
enxuto (`2848075`) estão commitados e revisados, mas mantêm itens
residuais/medição abertos; os demais critérios continuam pendentes conforme os
status acima. Validar documentação contra o runtime, testar limites e fluxos de
falha, e verificar o artefato distribuído — não apenas os fontes. Manter gates de
Themis para mudanças materiais, de segurança, permissão ou dados. Só marcar uma
fase entregue após sua própria implementação e verificação. **Gate de release
(suíte completa):** a validação por fase em tiers não substitui o gate de
release — `npm run test:node` (a suíte completa, incluindo as suítes pesadas)
deve rodar antes de release/pré-release, porque regressões em suítes que a fase
não tocou só aparecem ali (ver a lição do `c2f5698` em "Riscos"); isso é
consistente com o orçamento de economia de testes da fase 10: o tier rápido
serve ao ciclo por fase, não ao gate final.

**Riscos.** Contratos do host podem variar entre versões; observações locais podem
ser confundidas com garantias do pacote; erro pode surgir em camada de renderização
e não na persistência; métricas agregadas podem induzir falsa atribuição; alterar
peer range, build ou migração de presets sem decisão pode quebrar consumidores ou
instalações existentes. Evitar expansão de permissão e mudanças irreversíveis sem
aprovação/review apropriadas.

**Lição do gate final (regressão entre suítes).** A validação em tiers por fase
pode não pegar regressões em suítes não relacionadas à fase. Caso real desta
branch: uma regressão em `tests/memory-delegation-prompt.test.mjs`, introduzida
por `c2f5698` (que removeu o "both" explícito de
`src/instructions/zeus-memory-operations.instructions.md`) e corrigida em
`1b9607c`, só apareceu no gate final de suíte completa. Guardrail: rodar
`npm run test:node` (suíte completa) nos gates de release; o tier rápido por
fase não o substitui — consistente com o orçamento de economia de testes da
fase 10.

**Lição de higiene de hooks (`--no-verify`).** Dois commits foram feitos com
`--no-verify`; o conteúdo foi verificado limpo, sem segredos. O contrato do Iris
(`src/agents/iris.md`) agora proíbe explicitamente pular hooks. Guardrail: não
usar `--no-verify`/`-n` nem qualquer bypass de hook — o hook de segredos é um
gate.

**Decisões em aberto.** Decididas nesta rodada (registradas, sem alteração de
implementação): (a) entrada V2-only ou `.ts`/`dist` — **decidida manter como
está** (root pinado, exports `.ts`, sem build root), para não arriscar
consumidores existentes; (b) peer range/`*` com compat manifest — **decidida
manter o pin exato** neste beta; (c) bundler/build — **decidida não introduzir**
neste beta; (e) migração V1 dos IDs de preset — **congelada**: V1 mantém o
caminho legado e o `routing.yml` estático, sem migração. Continuam em aberto:
(d) tratamento de `specific_claims`; (f) quais capacidades runtime estão
realmente disponíveis para todo/background/board. A medição de orquestração
(fase 4) permanece **bloqueada por capacidade**: a tool publicada
`pantheon_cost` agrega tokens **por agente** — por agente **e fase** no ramo
V1, e por agente com a fase reportada como o literal `'unknown'` no ramo V2 — e
**não** isola tarefa/sessão/modelo/provedor nem produz USD. A agregação por
sessão existe **apenas no harness `bench/`**, que **não é publicado**
(`bench/lib/aggregate.mjs` → `aggregateSessionTree`; `sessionBreakdown` por
sessão introduzido na beta.15 em `bench/lib/collector.mjs`), então nenhum delta
atribuível pode ser produzido e nenhuma economia deve ser alegada. As
diferenças de versão de host observadas não resolvem essas decisões.

**Exclusões.** Não puxar automaticamente os 23 itens `OPEN` do roadmap; considerar
P0-5/P0-6 somente se vínculo direto com Beta 11 for confirmado e manter os demais
para triagem futura. F5 permanece deferred porque falhou paridade de rota; não
declarar aceito. F2-V2/F4B/F6 não foram encontrados no repositório e não devem ser
inventados. Não alterar o projeto React externo nem abrir trabalho Pantheon pelo
follow-up MED de tamanho do link. Esta seção registra o progresso **histórico**
da Beta 11: a preparação de release estava commitada (`8a11282`,
`chore(release): v1.6.0-beta.11`) com o PR **#241**
aberto para `main`, e a fatia de relatório de custo em
`src/pantheon/cost-command.ts` estava commitada e revisada (`c6f5280`) junto com
os cinco commits da fase Setup. **Esse inventário foi recontado em 2026-10-20**
(ver o status no topo desta seção): a Beta 11 foi **publicada** e **superada** —
hoje `main` == `origin/main` == `v1.6.0-beta.15` (`fd22b0c`) e a branch
`feat/v1.6.0-beta.16` está aberta. A contagem de commits locais que esta seção
citava era datada e **não** deve ser reaproveitada.

### Beta 16 — Resultado vazio de dispatch, contrato verdadeiro e piso de runtime

**Status da Beta 16: SOURCE/DOCS concluídos; validação local final aprovada; PR CI
pendente — branch `feat-v1.6.0-beta.16` aberta sobre `v1.6.0-beta.15`
(`fd22b0c`).** A beta.15 está **publicada** e foi testada em campo contra o host
`opencode v2.0.30`; esta beta parte do relatório de campo e implementa/documenta
as correções escopadas. A execução preliminar do Themis sob Node `v24.15.0` era
abaixo do piso `>=26.4.0` e foi supersedida pela validação final sob Node
`26.4.0` / npm `11.17.0` (detalhes em **Verificação**). Os testes locais, o
sandbox e a validação do tarball passaram; a CI do PR continua pendente. **Nada
aqui está publicado ou release-ready.** O canary local de dispatch filho também
passou; ver P2-12.

**Objetivo.** Fazer o resultado vazio de um dispatch filho aparecer como **erro
explícito** em hosts OpenCode V2 — em vez de silêncio lido como sucesso — e
tornar a documentação **verdadeira** sobre o catálogo de tools V2, a ferramenta
de custo, o merge de configuração do host e o piso de runtime Node.

**Escopo concluído no source/docs (seis itens).**

1. **Guard e placeholder do host — implementados e cobertos por regressões.**
   O host `opencode v2.0.30` usa `Subagent completed without a text response.`
   para dispatch filho sem texto; o guard reconhece esse placeholder por
   correspondência exata após `trim` e o transforma em erro explícito. Os
   testes de regressão passam; o canary scripted-provider live em OpenCode `v2.0.30` confirmou a conversão do resultado sem texto; ver P2-12.
2. **Rótulos e payload estruturado no adapter — implementados e cobertos por
   regressões.** O adapter encaminha `task` e `subagent` ao guard e preserva
   payload estruturado significativo, enquanto conteúdo textual vazio chega ao
   guard (`src/pantheon/v2-execute-after.ts:184-188`). Os testes passam; não há
   lacuna de implementação restante neste item.
3. **Catálogo de tools V2 — documentação corrigida para "3 + até 2", não "3".**
   O adapter registra **3 tools incondicionais** — `hashline_edit`,
   `pantheon_cost`, `pantheon_model`
   (`src/pantheon/v2-tools.ts:380-416`) — e **até 2 tools dependentes do host**:
   `vision_describe`, que só existe quando o host expõe o catálogo de modelos
   (`host.model.list`, com gate em `src/plugin-v2.ts:475-480`; caso contrário
   o marker `vision-tool` é marcado), e `pantheon_bounded_read`, que só é
   registrada quando o hook `execute.before` foi registrado
   (`src/plugin-v2.ts:1697-1704`; marker `bounded-read`). A
   documentação agora distingue as 3 tools incondicionais e as 2 condicionais
   dependentes do host.
4. **Granularidade do `pantheon_cost` — documentação corrigida nos três pontos.**
   A tool publicada agrega tokens **por agente** — por agente **e fase**
   no ramo V1, e por agente com a fase reportada como o literal `'unknown'` no
   ramo V2 — e **não** tem dimensão de sessão, modelo, provedor nem USD. A
   agregação **por sessão existe apenas no harness `bench/`**
   (`bench/lib/aggregate.mjs` → `aggregateSessionTree`, com o
   `sessionBreakdown` por sessão introduzido na beta.15 em
   `bench/lib/collector.mjs`), e `bench/` **não é publicado** de propósito (sem
   entrada `bench` em `files` no `package.json`) — logo ela **não** é
   capacidade da tool entregue; essa distinção está registrada nos três blocos
   de capacidade.
5. **Merge de configuração do host — documentação corrigida.** O
   installer escreve `opencode.json`; o host **lê também** um `opencode.jsonc`
   irmão e o mescla — escalares do `.jsonc` **vencem**, arrays são **unidos**.
   Uma entrada de usuário no `.jsonc` pode, portanto, mudar o **conjunto
   efetivo de plugins** que o host carrega, mesmo com o `opencode.json` do
   installer correto; o texto de instalação registra esse comportamento.
6. **Política de piso de Node — documentação corrigida.**
   `engines.node >= 26.4.0` é a **política de alinhamento do próprio pacote**
   com o build Node oficial do OpenCode — o CI fixa **exatamente** `26.4.0`
   (`.github/workflows/ci.yml:60`, `:242`, `:279`) — e **não** um requisito
   derivado do host. Abaixo do piso o `postinstall` **avisa e pula** o sync de
   TUI/configuração (`scripts/postinstall.mjs:14-17` e
   `scripts/sync-tui.mjs:261-267`). `node:sqlite`, que o backend opcional do
   `pantheon_cost` usa, é uma garantia **separada**: disponível só a partir de
   **Node >= 22.5** (`src/pantheon/cost-command.ts:7`) — e esse limiar de
   capacidade **não** derruba o piso de suporte do pacote.

**Fora de escopo (explícito).** Publicar no npm; mudar o piso de
`engines.node`; implementar quebra por sessão **dentro** da tool `pantheon_cost`
publicada (a granularidade por sessão permanece exclusiva do `bench/` não
publicado); mudar comportamento do host; qualquer alteração nos artefatos de
render/proof (`src/plugins/tui/dist/`, `.pantheon/code-mode/`).

**Verificação final local (Node `26.4.0`, npm `11.17.0`).** `test:ts` passou;
`test:node`: 893 passed, 0 failed, 7 skipped; `test:ci`: 501 passed, 1 skipped;
`test:tool-canary`: 14 passed, 0 failed, 8 skipped; `test:hooks`: 14 passed,
0 failed, 7 skipped. Lint verificou 258 arquivos; typecheck, `version:check`,
`package:validate` e `secret-scan` terminaram com exit code 0.

A validação final do pacote no sandbox isolado passou (exit 0): `git diff --binary -- src`
(SHA-256 somente fontes) `77fa26fe9148ef4fd0ffd3098f9db4b6a27f850da00f2785bfd21c2f11a7f1ec`;
tarball SHA-256 `387b062937bb1510e3ca5ce3e539da66daa221701c6d6f09e406ae0892d35fea`; todos os 53
arquivos `src/**/*.ts` empacotados corresponderam ao worktree. Binário copiado do host exato
OpenCode `v2.0.30` verificado; cinco MCPs conectaram; `doctor` passou; `Base validation v2: PASS`.
O npm avisou que lifecycle hooks não estavam allowlisted, mas a instalação/validação-base passou;
o manifesto ainda informa beta15, embora o conteúdo validado seja o candidato beta16.

O canary scripted-provider em host exato OpenCode `v2.0.30` passou: 19 passed,
0 failed, 3 optional skipped. Demonstrou que resultado vazio de child vira
`EMPTY_TASK_ERROR` e o status permanece `completed`; não usou credenciais nem
chamadas reais de provedor, e não demonstra isolamento abrangente de egress.
**A CI do PR continua pendente; estes resultados não tornam a beta release-ready.**

**Decisão aberta para o mantenedor — política de piso de Node.** Manter
`>=26.4.0` como política de alinhamento (**recomendado**) ou passar a suportar
hosts em Node 24. Registrar que a lacuna atual é que um runtime de host **não
suportado degrada em silêncio** em vez de falhar alto: o `postinstall` apenas
avisa, e o `init`/`doctor` só detectam o desvio quando são executados de fato
(`bin/pantheon-init.mjs:40`, `scripts/doctor.mjs:1859`).

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
| 2026-10-20 | **Reconciliação de inventário: beta.15 publicada, beta.16 aberta; P2-12 e `pantheon_cost` reconciliados.** O inventário datado foi recontado: `main` == `origin/main` == `v1.6.0-beta.15` (`fd22b0c`), branch `feat/v1.6.0-beta.16` aberta; a seção Beta 11 deixou de descrever "IN PROGRESS / 18 commits locais à frente de `origin/main`" e passa a registrar a Beta 11 como **publicada e superada**. **P2-12:** a afirmação original de que `execute.after` no V2 não tinha comportamento próprio era falsa; uma reconciliação posterior também descreveu incorretamente o guard do placeholder e lacunas do adapter como pendentes. O código atual cria o guard (`src/pantheon/v2-execute-after.ts:156-160`), trata payload estruturado (`:184-188`) e executa a cadeia (`:203-205`); o comportamento e as regressões estão implementados e os testes passam. **P2-12 permanece `OPEN` somente para a verificação live de dispatch filho em OpenCode `v2.0.30`.** **Blocos de capacidade do `pantheon_cost` corrigidos nos três pontos:** a tool publicada agrega tokens **por agente** (V1 também por fase; ramo V2 reporta o literal `'unknown'`) e **não** tem dimensão de sessão/modelo/provedor/USD — a agregação por sessão existe **apenas no harness `bench/`** (`bench/lib/aggregate.mjs` → `aggregateSessionTree`; `sessionBreakdown` por sessão introduzido na beta.15), que **não é publicado**. Readiness deixou de ser `UNKNOWN / NOT RECONCILED`; nenhuma contagem de item mudou. |
| 2026-10-20 | **Reconciliação final posterior ao snapshot acima.** O canary scripted-provider no host exato OpenCode `v2.0.30` passou (19 passed, 0 failed, 3 optional skipped), confirmou `EMPTY_TASK_ERROR` com status `completed` e fechou **P2-12** (`CLOSED (runtime canary)`). A validação local final sob Node `26.4.0` / npm `11.17.0`, o sandbox e o tarball passaram; detalhes, contagens e SHAs constam na seção **Beta 16**, em **Verificação final local**. A CI do PR permanece pendente: candidato beta.16 não publicado nem release-ready.
| 2026-10-19 | O council estabeleceu o charter Road to Stable com três workstreams; readiness permanece **`UNKNOWN / NOT RECONCILED`**. |
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
