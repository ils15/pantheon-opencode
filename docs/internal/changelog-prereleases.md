> Internal engineering record — not user guidance.

# Pre-release Changelog (1.6.0-beta.*)

These sections were moved verbatim from `CHANGELOG.md`, newest first. Dates and order are unchanged.

## [v1.6.0-beta.18] - 2026-10-22

- **Persistence goal-schema initialization and migration guidance:** a pristine
  project database now starts with both checkpoint and goal schemas; startup
  does not add goal DDL to an existing database. Existing-DB migration is only
  for users who want manual goal tools. When the schema is absent, the goal tools
  themselves return the exact migration command. User-facing guidance covers
  dry-run first, a stopped server, target confirmation, and verified `0600`
  backups.

## [v1.6.0-beta.17] - 2026-10-21

- **Persistence MCP reduced to six registered tools:** only `context_save`,
  `context_get`, and the four `goal_*` tools remain exposed; the twelve KV and
  context-management tools were unregistered while internal SQLite KV helpers
  remain for checkpoint storage. Goal tools are Zeus-only because goals are
  session-scoped and cannot be read across sessions, so Athena/Themis cannot
  read Zeus's goal or create one in their own root session.
- **Phase 7 — Memory search error contract:** `memory_search` now returns a
  typed, sanitized error when the memory store cannot be read instead of an
  empty list; an empty result now means nothing matched. All-stopword queries
  previously fell back to a literal FTS match and now return no results, making
  the behavior uniform with queries whose stopwords are dropped.
- **Phase 8 — Memory MCP packaging:** `scripts/memory_mcp.py` is now a thin shim
  delegating to canonical `src/mcp/memory_mcp.py`, removing the stale divergent
  copy; the sync test now asserts that their registered tool lists are equal.

## 🆕 What's New

- **V1 goal tools soft-deprecated:** `pantheon_goal_create`,
  `pantheon_goal_update`, and `pantheon_goal_get` remain available with
  unchanged behavior, but stored legacy goals are not automatically continued
  in the current build. The durable manual replacement is the Persistence MCP
  `goal_*` surface available in this branch. Tool removal is deferred to a
  future release and requires explicit human approval.

## 🐞 Fixed

- **Disabled goal loop does not suppress idle enforcement:** `hasActiveGoal`
  now returns false while the loop is disabled, so stored legacy goals do not
  prevent the todo enforcer from receiving idle events.
- **Empty child-dispatch result is an explicit error:** an empty result returned by a child dispatch is now surfaced as an error instead of being passed through as a normal result.

## ⚠️ Known Issues

- **`pantheon_cost` aggregates by agent and phase:** V1 reports both dimensions; V2 reports the literal phase `unknown`. The shipped tool has no per-session, per-model, per-provider or USD dimension; per-session aggregation exists only in the unpublished benchmark harness.
- **An empty child result can arrive as a completed call:** the host supplies the placeholder `Subagent completed without a text response.`; Pantheon’s guard replaces the payload with its explicit error text, while the host’s completed status remains unchanged.
- **A user `opencode.jsonc` can change the effective plugin set:** the host merges `opencode.json` with a sibling `opencode.jsonc` (scalars from `.jsonc` win, arrays are unioned), and Pantheon registers its plugin only in `opencode.json`.

## ✅ Closed Issues

## [v1.6.0-beta.15] - 2026-10-19

## 🆕 What's New

- **Safe memory handoffs and agent contracts:** delegation briefs can pass
  minimized, non-sensitive memory references and takeaways as untrusted context;
  return formats and discovery/review routing are clarified across agent roles.
- **Optional per-session token breakdowns:** benchmark reports can show root and
  descendant usage when session data is complete; incomplete data remains
  unavailable rather than being zero-filled.

## 🐞 Fixed

- **Empty task/subagent results:** empty child-dispatch results are surfaced as
  explicit errors while non-empty structured results remain intact.

## [v1.6.0-beta.14] - 2026-10-17

_Published manually to npm on 2026-10-17; source commit and tag unknown._

## 🆕 What's New

- **Installer model profiles:** choose Inherit, OpenCode Go (hybrid), OpenAI, or
  Anthropic. Inherit leaves the active preset unset; OpenCode Go combines the
  premium lineup for Zeus, Athena, Themis, and Hephaestus with the Go lineup for
  other agents. Existing `go-free`, `go-fast`, and `go-premium` preset IDs remain
  available for compatibility.
- **Anthropic key guidance:** the profile identifies `ANTHROPIC_API_KEY` as the
  required environment variable. The installer does not collect or inspect API
  keys; configure the key in your environment.
- **Modernized installer progress and terminal safety:** Clack spinners are used
  in interactive TTYs, with readable output in headless/non-TTY runs. Canceling
  or selecting no components stops safely without writes; `--no-mcp` continues
  to exclude runtime, and `--yes` does not override an explicit decline.
- **Proportional delegation guidance:** prompts now route bounded work directly
  to the relevant specialist and call for planning, broad discovery, review, or
  parallel work only when the request, uncertainty, dependencies, or risk
  warrant it.

## 🐞 Fixed

- **Reduce duplicated CI work:** plugin V2 coverage now measures one focused
  TypeScript contract test while retaining its required 80% line-coverage
  threshold. The hook canary has one CI owner (`test:node`); its duplicate
  standalone CI invocation was removed. This records the CI configuration
  change, not a claim that the current CI run passed.

## [v1.6.0-beta.13] - 2026-10-17

## 🆕 What's New

- **Modernize interactive TTY setup** with `@clack/prompts` while keeping the
  existing component, install-location, authorization, and worktree guidance
  choices. Canceling the setup wizard leaves configuration unchanged; headless,
  `--yes`, dry-run, and non-TTY behavior remain available.

## 🐞 Fixed

- **Let npm finish on an unsupported Node runtime:** postinstall now warns and
  skips Node-dependent TUI/config sync, leaving the CLI to show its explicit
  Node >=26.4.0 hard gate and user-managed upgrade instructions.
- **Synchronize Beta 13 package and release metadata** across manifests and
  lockfiles without changing the Node >=26.4.0 engine floor.

## [v1.6.0-beta.12] - 2026-10-17

## 🆕 What's New

- **Raise the Node.js support floor to 26.4.0** for the package, CLI, installer,
  and Node-based tooling. This release drops Node 22, Node 24, and Node
  26.0–26.3; the npm `beta` dist-tag remains the intended publication channel.
- **Clarify runtime boundaries:** this package requirement is not a universal
  OpenCode host-runtime claim. Official OpenCode V2.0.31 has a Bun runtime path
  and a separate Node build pinned to 26.4.0; no Bun minimum is asserted.
- **Keep `node:sqlite` as a separate capability threshold:** Node >=22.5 may
  provide the optional `pantheon_cost` backend, but does not imply package
  support on that Node version.
- **Recommend a persistent external Git worktree location** in interactive TTY
  setup summaries and the shipped worktrees skill. This is guidance only;
  Pantheon does not create worktrees or directories automatically.

## 🐞 Fixed

- **Synchronize Beta 12 version metadata and Node engine policy** across package
  manifests, locks, citation/release metadata, CLI guards, doctor, and CI.

## [v1.6.0-beta.11] - 2026-10-15

## 🆕 What's New

- **record final Beta 11 scope decisions**
- **record Setup delivery and final-gate lessons in roadmap**
- **forbid hook bypass in Iris commit contract**
- **add installer failure reporting and secret-safe output audit**
- **detect drift between installer plan and apply**
- **require explicit --yes authorization before installer apply**
- **exact installer backup set with restore**
- **add Beta 11 test-economy requirement to shared instructions**
- **preview per-file change set in installer dry-run**
- **reconcile Beta 11 roadmap status with completed phases**
- **describe pantheon_cost window and aggregation limits**
- **align lean-flow guidance and cost wording**
- **add project-scoped V2 model overrides**
- **align host tool and background contracts**

## 🐞 Fixed

- **restore explicit "both" in zeus memory operations instruction**
- **correct council protocol and persistence bounds**

## [v1.6.0-beta.10] - 2026-10-12

## 🆕 What's New

- **Visible plan approval:** Zeus displays Athena's complete plan in the main
  conversation before requesting approval, including for `/pantheon-deepwork`.
- **OpenCode V2 Vision:** adds `vision_describe` using the live image-capable
  model catalog and OpenCode Zen authentication; relative image paths resolve
  from the active project directory.

- **Menos contexto de instruções duplicadas no OpenCode V2:** regras comuns
  entre as instruções globais e de projeto são emitidas uma vez, preservando
  regras exclusivas. Na medição intercalada do beta-10 com OpenCode v2.0.29, o
  proxy de contexto do primeiro request caiu 11,8%; input total e latência de
  parede permanecem inconclusivos.

- **Admissão segura de subagents no OpenCode V2:** quando o host registra o
  hook de permissões, Pantheon correlaciona o
  agente, a sessão e o alvo do evento nativo `subagent` com o `source` da
  avaliação de permissão, antes da criação da sessão filha. A matriz permite
  Zeus→Apollo em uma sessão root e nega dispatches fora da matriz ou originados
  em uma sessão filha. A canary isolada passou em 18/18 verificações no
  OpenCode v2.0.29.

Evidência de F1 e F4A: `bench/results/f1-di-v229-interleaved-2026-10-14.md` e
`bench/results/f4a-v229-admission-identity-2026-10-14.md`. O resultado de
latência total e wall de F1 segue inconclusivo.

- **Especialista explícito como root no V2 (F3a):** no cenário one-shot B,
  Talos iniciado explicitamente como agente root produziu o artefato correto
  sem child em 5/5 runs na amostra inicial. Um recheck de integração posterior
  encontrou 4/5; a instrução de Talos passou a exigir que arquivos pedidos
  sejam realmente gravados com a ferramenta nativa. Uma nova coorte
  pré-registrada passou em 5/5, sem children nem chamadas `subagent`. Nessa
  coorte, o proxy de contexto do primeiro request foi 9.675 tokens para Talos
  e 13.009 para Zeus (−25,6%, confirmado contra o spread intra-braço). Input
  total e wall permanecem sem claim de ganho; não há claim de economia
  monetária ou roteamento geral. O primeiro recheck e o follow-up são mantidos
  separadamente em `bench/results/beta10-final-integration-2026-10-15.md` e
  `bench/results/beta10-final-integration-followup-2026-10-15.md`; a evidência
  inicial está em `bench/results/f3a-root-paired-2026-10-14.md`.

- **Leitura bounded no OpenCode V2:** adiciona `pantheon_bounded_read` para
  sessões root do Zeus, com aprovação nativa por arquivo, sem grant persistente,
  limites de chamadas/arquivos/linhas/bytes e scanner de segredos fail-closed.
  Validado no OpenCode v2.0.29; detalhes e limitações em
  `bench/results/f3b-v229-bounded-read-2026-10-15.md`.

## [v1.6.0-beta.9] - 2026-10-12

&lt;!-- Add new changes here. Running `node scripts/versioning.mjs apply` will
     move this section to a versioned entry and reset the template below. --&gt;

## 🆕 What's New

- **Entry point TUI dedicado ao OpenCode V2.** O pacote agora compila e instala
  separadamente os loaders V1/V2, e adiciona `/pantheon-focus` para foco de
  sessão sem depender das goal-tools ausentes no host V2.

## 🐞 Fixed

- **Instalação V2:** agentes e slash commands de projeto são instalados nos
  diretórios descobertos pelo host; o TUI seleciona o bundle da geração correta
  e o estado dos componentes só é marcado como instalado após sucesso.
- **`/pantheon-audit`:** inclui o scanner heurístico no pacote e localiza a cópia
  instalada antes de executar a primeira camada.
- **`/pantheon-consolidate`:** delega a consolidação ao agente Mnemosyne, dono
  da qualidade do banco de memória.

## ⚠️ Known Issues

- **Sidebar V2 na sessão inicial:** a captura do TUI recém-aberto ainda não
  mostra o conteúdo Pantheon antes do primeiro prompt; validar o render inicial
  interativo continua sendo um gate aberto para a beta.
- **Goal persistente no OpenCode V2:** as goal-tools não fazem parte da
  superfície V2 suportada; `/pantheon-focus` não substitui uma goal-tool
  persistente/removível do host.

## [v1.6.0-beta.8] - 2026-10-11

&lt;!-- Add new changes here. Running `node scripts/versioning.mjs apply` will
     move this section to a versioned entry and reset the template below. --&gt;

## 🐞 Fixed

- **opencode-v2** — repair session lookup and beta sandbox reuse
- **scripts** — isolate beta background service port
## [v1.6.0-beta.7] - 2026-10-10

&lt;!-- Add new changes here. Running `node scripts/versioning.mjs apply` will
     move this section to a versioned entry and reset the template below. --&gt;

## 🆕 What's New

- **Permissões MCP nativas por agente no OpenCode V1 e V2.** O instalador
  converte a allowlist `mcp_tools` de cada agente em regras nativas: nega por
  padrão os servidores Pantheon omitidos, libera apenas as ferramentas
  declaradas e preserva MCPs de terceiros. O V2 mantém os servidores
  conectados; as regras limitam quais ferramentas cada agente vê.
- **Guarda V2 de delegação alinhada ao contrato de permissões.** Os hooks de
  permissão e de sessão aplicam as restrições de sessão somente-leitura e a
  matriz caller→target sem conceder acesso além do configurado pelo host.
- **Menos chamadas automáticas de memória e compressão.** A busca de contexto
  do Zeus reutiliza o resultado de início de tarefa, e o protocolo de
  compressão deixa de recomendar pipelines automáticos extensos.
- **Prova de identidade da instalação do sandbox.** O teste global compara a
  versão e arquivos do pacote instalado com este checkout e rejeita referências
  npm antigas nas configurações ativas antes de validar o runtime.
- O `--prepare` agora gera `start-pantheon.sh` para abrir o TUI interativo com o
  beta instalado e HOME, configuração XDG, projeto e banco de dados isolados do
  sandbox. O launcher fixa a porta do serviço gerenciado em `49376` e falha sem
  parar serviços existentes se a porta dedicada já estiver ocupada.

## 🐞 Fixed

- Referências versionadas/alias do pacote Pantheon que sobravam na lista
  `plugins` agora são reconhecidas pelo instalador e substituídas pelo caminho
  do plugin local correto, sem afetar plugins de terceiros com nomes parecidos.
- A suíte CI foi separada do caminho crítico de instalação/empacotamento para
  reduzir o tempo até o resultado das verificações do pacote.
- O `run-test.sh` gerado agora define seu timeout do `mcp list` antes do uso
  sob `set -u`; antes, a variável ausente interrompia o teste antes de chamar
  o CLI. A saída do comando também fica disponível quando o gate falha.

## ⚠️ Known Issues

- **A delegação real ainda precisa de confirmação nesta beta.** O teste manual
  anterior de `HERMES-PONG` foi negado com
  `Pantheon delegation denied: authoritative caller session is unavailable`;
  a correção de permissões e a instalação isolada precisam ser verificadas no
  TUI OpenCode V2 antes de considerar a delegação validada.
## [v1.6.0-beta.6] - 2026-10-05

&lt;!-- Add new changes here. Running `node scripts/versioning.mjs apply` will
     move this section to a versioned entry and reset the template below. --&gt;

## 🆕 What's New

- **Política de suporte documentada: a linha 1.6.x é a ÚLTIMA compatível com OpenCode 1.X.** A partir de **1.7, toda release é breaking change com alvo em OpenCode 2.** O limite está escrito no `README.md` (seção "Compatibility and support policy", com matriz de suporte) e em `docs/INSTALLATION.md` (seção "OpenCode V1/V2 — contrato de plugin"), não duplicado em um documento novo: os dois arquivos já eram o ponto de entrada do contrato de plugin, e um terceiro documento seria um terceiro lugar para divergir. O texto distingue as duas células da linha 1.6.x — a célula 1.X é o contrato V1 (6 tools, lifecycle do board, hooks V1, compaction V1) e a célula OpenCode 2 é o contrato V2, que é real porém **menor**: 3 tools, sem as `pantheon_goal_*` e sem a matriz de delegação caller→target. **O suporte a OpenCode 2 na linha 1.6 é documentado como parcial, e não como completo**, por duas razões verificadas: (a) o canário de ferramentas V2 foi escrito contra `opencode 2.0.22`, host que não é publicado em nenhum canal npm — contra o `@opencode-ai/cli` instalável o mesmo canário falha 12/12, porque `/api/experimental/session/{id}/wait` foi promovido para `/api/session/{id}/wait` (404 no caminho antigo) e `ctx.tool.list` não existe mais; corrigindo apenas a rota, 10/12 passam no mesmo host, o que caracteriza descasamento canário/host e não regressão medida do plugin (issue #216, PR #213); (b) não existe perna V1 de validação end-to-end — `scripts/test-opencode-v2-sandbox.sh` é V2-only e rejeita `--run v1` — portanto a versão exata de host 1.X exercitada end-to-end pela linha 1.6 fica registrada como **não verificada**, e o caminho 1.X é sustentado pelo pin de dependência (`@opencode-ai/plugin` / `@opencode-ai/sdk` `1.18.33`), pelos testes unitários do gate de geração e pelos testes end-to-end do installer sobre a config emitida.

## 🐞 Fixed

- **Os exemplos de chamada MCP nos arquivos de prompt ensinavam um contrato que não existe no schema real.** Um `pantheon-persistence.kv_get` ao vivo foi rejeitado com `namespace: Missing key`; a linha que o produziu foi `src/agents/zeus.md:189` (`depth = kv_get("deleg:depth") ?? 0`), cuja cópia instalada em `~/.config/opencode/agents/zeus.md` é a que executou. A causa não era o servidor MCP: os arquivos de agente e de instrução ensinavam chamadas posicionais sem `namespace`, enquanto o schema real é `kv_get({ namespace /* obrigatório, sem default */, key, scope? })` — `kv_store.namespace` é igualmente obrigatório e `kv_store.value` é `str`. **A correção está nos docs, e não em adicionar um `namespace` default:** um default escreveria estado de coordenação no namespace errado silenciosamente, então *obrigatório* é o desenho correto. A mesma classe de defeito foi corrigida em `context_save` (posicional, com um helper `json()` inexistente e sem o `session_id` obrigatório → forma por palavra-chave com `content=JSON.stringify(...)`), em `memory_store` (`value` precisa ser uma string JSON codificada → agora iguala o padrão já correto de `metadata`, o que resolveu uma aut contradição no mesmo arquivo), na aritmética de profundidade (envolvida em `String(...)`, porque `kv_store.value` é `str` e não `int`) e em `memory_search(query, ...)` → `query=` em todas as instâncias. `AGENTS.md` é artefato gerado e foi reconstruído, nunca editado à mão.
- **Um bypass de permissão vivo: `edit: deny` não cobria `hashline_edit`.** A regra `edit: deny` é avaliada por nome de ferramenta, e `hashline_edit` não é `edit` — então os agentes restritos a `edit: deny` (`zeus`, `athena`, `iris`, `nyx`, `themis`) podiam editar arquivos assim mesmo, escrevendo no disco por um caminho que a negação não cobria. `hashline_edit: deny` foi adicionado a esses cinco agentes. **Não era uma condição de corrida nem um erro de configuração: era uma tabela de permissões incompleta**, o que significa que a negação nunca esteve de fato aplicada a quem só deveria ler.
- **`test:node` reportava sucesso tendo coletado zero testes.** `node --test <glob>` sai com 0 quando o glob não expande (Node >= 22), e foi exatamente o que aconteceu: um glob que nunca expandiu produziu um gate verde que não executou nada. Pior, `tests/` estava ausente da allow-list `files` do pacote, então um consumidor que rodasse `npm test` recebia esse verde. Agora os scripts de teste falham em voz alta quando a coleta é zero, e a guarda tem teste próprio (`tests/run-node-tests.test.mjs`) que a dirige como subprocesso — o contrato é o código de saída, então testá-la em processo não provaria nada.
## [v1.6.0-beta.5] - 2026-10-05

&lt;!-- Add new changes here. Running `node scripts/versioning.mjs apply` will
     move this section to a versioned entry and reset the template below. --&gt;

## 🆕 What's New

- **O gate de geração do plugin passa a ler a versão do host — e a superfície de ferramentas deixa de desaparecer num host OpenCode 2.x.** O seletor de geração tinha três defaults `'v1'` (`bin/pantheon-init.mjs`, `scripts/install/opencode.mjs` e a assinatura do resolver em `scripts/install/opencode-version.mjs`). Nesse ramo, o installer grava caminhos de arquivo `.ts` na chave singular `plugin`; um host 2.x rejeita caminhos de arquivo ali (`configured plugin path must be a directory`), **descarta** as entradas e, ao fazer isso, **remove** a entrada de diretório V2 que já estava registrada e funcionando. O sintoma era um host aparentemente saudável — a frota MCP subia normalmente — com um único WARN no log e **nenhuma** ferramenta do plugin no catálogo: sem `pantheon_cost`, sem `hashline_edit`, sem `pantheon_model`, sem BackgroundJobBoard e sem hooks. Os três defaults passam a `'auto'`, e `auto` consulta a versão do host. Precedência: flag explícita > `OPENCODE_VERSION` > basename `opencode2` > probe de `--version` > aviso e fallback `v1`. Isto restaura as **3** ferramentas que o contrato V2 registra (`hashline_edit`, `pantheon_cost`, `pantheon_model`); não é paridade com o V1 — ver **Issues Conhecidas**.
- **Uma instalação na geração V2 e o `doctor` agora declaram a superfície reduzida em vez de deixá-la ser descoberta.** A lista de recursos não suportados no V2 (`getUnsupportedFeatures()`) não tinha nenhum consumidor em produção — só testes a liam. O installer passa a imprimi-la ao lado do aviso de destino V2, e o `doctor` a reporta como um achado próprio, sem alterar o código de saída (uma instalação V2 é uma configuração suportada, não quebrada). A V2 registra 3 ferramentas, não 6, e não tem BackgroundJobBoard; as 3 ferramentas de goal não são registradas na V2 por desenho. O texto agora é único, vindo de `src/pantheon/v2-unsupported.mjs`.
- **Renomeação dos entrypoints MCP (issue #198).** Os cinco entrypoints Python deixaram de compartilhar o token `server.py`, então um `pkill -f server.py` amplo não derruba mais a frota inteira como efeito colateral. Inclui uma migração em tempo de instalação para que as instalações existentes não fiquem órfãs.
- **O pacote npm deixou de versionar e distribuir a configuração pessoal de desenvolvimento do OpenCode.** `opencode.json` e `.opencode/` (comandos, plugins e skills) saíram do controle de versão: a config carregava um endpoint MCP privado e overrides de permissão por desenvolvedor, e o harness V1 de comandos/plugins foi substituído por `src/plugin-v2.ts`. O `init` continua gerando a config do projeto do usuário, então instalações não são afetadas; para contribuidores, um `opencode.json` pessoal deve ir em `.git/info/exclude`.
- **Documentação: `ROADMAP.md` reescrito e um novo documento de fronteira.** O roadmap foi reescrito com as causas-raiz verificadas, e um novo documento — `docs/PERMISSIONS-QUALITY-DELEGATION.md` — mapeia os gates de qualidade, as quatro camadas de permissão e a delegação num só lugar, marcando explicitamente o que ainda não foi verificado.

## 🐞 Fixed

- **A leitura do banner de versão do host era quadrática.** Um banner longo custava **11,1 s** para ser interpretado, contra o timeout de **5 s** do spawn de `--version`; o timeout guarda o processo, não a leitura, então um host verboso conseguia estourá-lo. A interpretação passou a ser **linear**.
- **O `readOnlyRegistry` do V2 não era podado no `session.deleted`.** O registro é global ao processo e nunca era limpo quando uma sessão do V2 terminava, então entradas de sessões encerradas acumulavam. O `session.deleted` do V2 passa a podar o registro, como a V1 já fazia.

## ⚠️ Known Issues

- **Ação necessária: re-executar o `init` numa instalação afetada.** O `postinstall` **não** roda o `init`. Quem teve a configuração corrompida por uma instalação `v1` anterior **não** é auto-corrigido apenas por atualizar o pacote — é preciso rodar o installer de novo (`npx pantheon-opencode init`). Uma escolha correta de geração **auto-corrige** a configuração (o ramo V2 já remove as referências `.ts` do V1), mas só quando o installer roda. O mesmo vale para a renomeação dos entrypoints: instalações existentes continuam funcionando porque os arquivos antigos são mantidos, mas os caminhos só são corrigidos numa nova execução do installer; até lá, esses usuários permanecem nos entrypoints antigos e sujeitos ao efeito colateral do `server.py`.
- **A superfície V2 é menor que a V1 por desenho.** A V2 registra 3 ferramentas (`hashline_edit`, `pantheon_cost`, `pantheon_model`), não 6, e não tem BackgroundJobBoard; as 3 `pantheon_goal_*` são V1-only e a matriz de delegação caller→target não é replicada. O installer e o `doctor` agora **dizem** isso (ver What's New), mas a funcionalidade ausente não é restaurada.
- **O fallback continua a ser `v1`.** Quando o probe do host falha, não consegue ser interpretado, ou traz versões contraditórias, o resolver avisa **uma vez** e cai para `v1`, em vez de arriscar um host 1.x com uma entrada `plugins` que ele ignoraria. É um erro alto e visível, mas ainda é uma queda para a configuração V1.

## ✅ Closed Issues

- **A justificativa da matriz de delegação V1→V2 foi corrigida.** O texto dizia que o V2 "não expõe esse caminho de semeadura"; os tipos do SDK refutam isso. A causa real da matriz não replicada não é a ausência de um caminho de semeadura (`session.created` do V2 traz `properties.info: Session` com `parentID?`, o mesmo campo que a V1 semeia), mas a *segunda* fonte da V1 — o seed de `client.session.list()` para sessões anteriores ao carregamento do plugin — porque o `PluginContext` do V2 não expõe `client`. Se um host 2.0.22 ao vivo popula `info.parentID` nesse evento continua **não verificado** (nenhum canário lê payload de evento). A linha publicada em `v1.6.0-beta.4` fica como registro.
## [v1.6.0-beta.4] - 2026-10-03

&lt;!-- Add new changes here. Running `node scripts/versioning.mjs apply` will
     move this section to a versioned entry and reset the template below. --&gt;

## 🆕 What's New

- **Canário host-backed que dirige `hashline_edit` end-to-end** (`tests/canary/plugin-v2-tool-canary.test.mjs`, 12 casos): carrega `src/plugin-v2.ts` pelo loader real do host `opencode 2.0.22` e registra `Object.keys(ctx)` de dentro do host — medidos, `tool`/`event`/`permission`/`session` existem e `catalog` não. É o primeiro gate que dirige uma ferramenta do Pantheon por um host real. O canário existente só dirige o `read` embutido, e foi por isso que `draft.add()` sem `output` sobreviveu 26 dias com todos os testes verdes.
- **Os quatro domínios que o SDK `@opencode-ai/plugin` não tipa** (`tool`, `event`, `permission`, `session`) passaram a uma declaração estrutural local (`HostPluginContext`) e **um** cast documentado (`hostDomains()`), no lugar de seis `as unknown as Record<string, unknown>` que não verificavam tipo nenhum. Todo membro continua opcional e todo chamador reconferir antes de usar. A linha estável do SDK é `1.18.x` e não carrega o contrato do host — `1.18.34` (`latest`) é idêntica a `1.18.33`, então seguir o `dev` diário resolveria pior, não melhor.

## 🐞 Fixed

- `pantheon_cost` respondia `CORRUPT_DATA` em **toda** chamada contra o host 2.0.22: exigia a tabela `message`, que não existe nesse banco. Os tokens de assistant **estão** legíveis em `session_message`. **Não é renomeação:** `session_message` tem coluna `data`, mas não tem a chave `role` dentro dela — `json_type(data,'$.role')` é nulo em **0 de 40 307** linhas válidas. O V1 marca turnos de assistant com `data.role`; o V2 marca pela **coluna** `type`. Trocar apenas o nome da tabela casaria com nada e devolveria `status: OK` em silêncio. A detecção passa a ser por **presença de tabela**, porque as duas famílias coexistem em bancos migrados.
- `PANTHEON_OPENCODE_VERSION` nunca selecionou o schema: só mudava o **nome do arquivo**, e `opencode-v2.db` é o isolamento do sandbox via `OPENCODE_DB`, não um banco de host 2.x. A distinção v1/v2 é o **schema detectado**; a variável agora apenas restringe um conjunto já detectado e falha rápido quando pede uma família ausente.
- `scripts/cost.mjs` duplicava o mesmo bug literal, com o mesmo assert — o fallback continuava morto. `probe-pantheon-cost.mjs` acompanha.
- O report agora **declara a cobertura temporal** que ele mediu (janela varrida, linha mais antiga), em vez de apresentar totais como se cobrissem meses.

## ⚠️ Known Issues

- O canário **host-backed pula no CI**: o runner não tem binário `opencode`. O skip é **visível** no log (`::notice`), e os dois casos sem host rodam incondicionalmente, com `PANTHEON_TOOL_CANARY_BIN` apontado para um caminho inexistente. Rodar de verdade exige um modo no script de sandbox — **não feito**.
- A cobertura de custo do banco v2 é de **~8,3 dias** nesta máquina (primeiro registro em 2026-09-25). O histórico v1 (~96 dias) fica num diretório irmão com nome de epoch, que **não** é contrato e por isso não é descoberto automaticamente. Quem quiser aponta `PANTHEON_COST_DB`.
- `metadata.phase` nunca existiu em v1 nem em v2 — medido: 0 linhas de `session_message` têm `$.metadata.phase` nem `$.phase`. A coluna Phase sempre foi `unknown`. Não é regressão, é feature que nunca funcionou.
## [v1.6.0-beta.3] - 2026-10-03

&lt;!-- Add new changes here. Running `node scripts/versioning.mjs apply` will
     move this section to a versioned entry and reset the template below. --&gt;

## 🆕 What's New
- **Três ferramentas V2 agora executam de verdade**: `hashline_edit`,
  `pantheon_cost` e `pantheon_model` rodam no host `opencode v2.0.x`. Antes
  eram placeholders que declaravam sucesso sem fazer nada.
- **Enforcement de sessão read-only no caminho V2**: `apollo` e `gaia` voltam
  a ter escrita bloqueada, com o guard registrado no próprio plugin V2 — sem
  depender de uma ponte que a instalação V2 não monta.
- **Varredura de segredos de alta confiança no caminho V2**: o único hard block
  de segurança que a V1 tinha, e que estava inerte por viver num plugin que a
  instalação V2 não carrega, passa a rodar.

## 🐞 Fixed
- **As 6 ferramentas de plugin do V2 falhavam em 100% das chamadas**:
  `hashline_edit`, `pantheon_cost` e `pantheon_model` lançavam
  `Tool result declared output without an output schema` em toda invocação. A
  causa era assimetria local — `draft.add()` não declarava `output` enquanto o
  `execute` resolvia `{ output: string }`. O host exige simetria nos dois
  sentidos: resultado com `output` e nenhuma declaração lança, assim como
  declaração sem `output` no resultado. `output` passou a ser **obrigatório** na
  interface `V2ToolDef`, então o compilador exige a declaração daqui em diante.
- **A suíte exigia o defeito**: `tests/pantheon/plugin-v2-contract.test.ts`
  afirmava que o resultado carregava `.output` string — literalmente a condição
  de falha, contra um mock que não reproduzia a exigência do host. O teste foi
  reescrito para o invariante de simetria, contra um mock que constrói o
  `outputSchema` a partir de `def.output` como o host faz
  (`output: I.outputSchema ?? {}`), cobrindo as duas direções do bicondicional.
- **A imposição read-only não existia na superfície V2**: `createEnforcementGuard`
  só era instanciado em `src/plugin.ts`, que o `opencode.json` da release não
  declara — V2 nunca carrega V1. Com `hashline_edit` funcional, uma sessão
  somente-leitura podia escrever arquivos. O guard passou a ser registrado no
  hook `execute.before` do V2, e `pantheon_model` — que escreve
  `active-preset.json` em escopo project e global — foi acrescentado a
  `DEFAULT_BLOCKED_TOOLS`, o que corrige também a V1. `pantheon_cost` ficou de
  fora de propósito: só lê `opencode.db`.
- **O único hard block de segurança da V1 estava inerte**: o scan de segredos de
  alta confiança vivia em `src/plugins/pantheon-hooks.ts`, um plugin que a
  instalação V2 não carrega — inerte por construção, não por má configuração.
  Passou a rodar dentro do `execute.before` do V2
  (`scripts/hooks/scan-secrets.sh`; exit 2 bloqueia, exit 1 é advisory e só
  registra). O caminho do script foi verificado a partir do tarball instalado,
  não só do repo.
- **Cinco comentários afirmavam cobertura que não existe** ("wired through the
  V1…"). Corrigidos — é o defeito "anunciado como vivo, morto no caminho", a
  mesma classe do bug original, transferida do tool para o controle de segurança.

## ⚠️ Known Issues
- **A release entrega 3 ferramentas V2 funcionais, não 6**:
  `pantheon_goal_create`, `pantheon_goal_get` e `pantheon_goal_update` foram
  **removidos** da superfície V2. `GoalLoopDeps` exige `store`, `client` e
  `board`, que não existem no `PluginContext` V2, e a bridge V1 resolve para
  `null` fora da V1. Registrá-las como placeholders não funcionais seria pior
  que a ausência: anunciá-las seria mentira silenciosa. Marcador `goal-tools`
  em `V2_UNSUPPORTED_FEATURES`. **Breaking** para quem usava esses tools no
  host V2 — o contrato V1 permanece disponível para o goal loop.
- **A matriz de delegação nativa da V1 não é replicada na V2**: o guard V2 cobre
  a lista de ferramentas bloqueadas, mas não a matriz caller→target nem a negação
  de `task` em sessão filha. A matriz precisa de uma hierarquia de sessões
  semeada a partir dos metadados de sessão, e o V2 não expõe esse caminho de
  semeadura — `SessionHierarchyRegistry.isRoot` reporta `true` para sessões
  desconhecidas enquanto não semeada, então semeá-la pela metade negaria todo
  `task()`. O branch é pulado em vez de negado indiscriminadamente. Marcador
  `delegation-matrix`. `task` continua negada em sessão somente-leitura pela
  lista de ferramentas bloqueadas, então a profundidade 2 se sustenta; o que
  não existe é a matriz. Coberto por `experimental.subagent_depth` nesta
  configuração, mas a garantia do plugin não existe.
- **O log do scan de segredos escreve só em `.pantheon/logs/hooks.log`**: o
  `PluginContext` V2 não expõe `client` nem `directory`, então os canais de log
  estruturado e de toast da V1 não existem nessa superfície. É menos
  observabilidade, não menos bloqueio.
- **Falha de infraestrutura do scanner é fail-open por decisão**: script ausente
  ou timeout não bloqueiam. `runHook` nunca rejeita e um erro de infraestrutura
  não deve negar chamadas não relacionadas. Ausência do script não bloqueia.

## ✅ Closed Issues
- **Drift de documentação no `README.pt-BR.md`**: a tabela de contrato de
  runtime e o parágrafo de superfície listavam 6 ferramentas V2 e as 3 de goal,
  que não estão registradas. Corrigido para 3 ferramentas, com a razão da
  ausência e o ponto de imposição read-only.
- **Cinco comentários de falsa cobertura** sobre a imposição read-only e o scan
  de segredos.
- **Shim do loader JSON do ajv elevado a bootstrap de módulo**: o patch de
  `Module._extensions['.json']` era aplicado de dentro de `loadAjv()` e ficava
  vivo durante todo o run, podendo vazar entre arquivos de teste e se manifestar
  longe da causa. Agora instala, carrega e restaura em nível de módulo, antes de
  qualquer corpo de teste, com `finally`.
## [v1.6.0-beta.2] - 2026-10-02

## 🆕 What's New
- **`steps` não é mais definido pelo Pantheon**: removido dos 14 agentes em
  `src/agents/`. No OpenCode 2 o campo é opcional e **sem default** — ausente
  significa **sem teto nativo**. O host não impõe teto; o Pantheon estava
  escrevendo um.
- **Instalador v2 remove `steps` residual**: configs já instalados passam a ter
  o `steps` apagado dos agentes gerenciados. Escopo restrito aos agentes que o
  Pantheon gerencia — um agente definido pelo usuário nunca é tocado. O bloco V1
  singular `agent` é deliberadamente intocado (V1 em retirada).
- **Substitutos ao teto**: `task(background=true)` para trabalho fora da
  foreground, `experimental.subagent_depth` para aninhamento de subagentes e
  paralelismo entre delegações independentes.
- **Limpeza**: `max_steps` e `max_compaction_items` removidos de
  `src/routing.yml`. `loadRoutingMaxSteps` nunca teve um único import — 2
  matches no repo (definição e typedef), ambos removidos.

## 🐞 Fixed
- **`migrateV1toV2` descartava campos gerenciados**: com os blocos `agent` (V1)
  e `agents` (V2) coexistindo — o caso de qualquer config já instalado — o
  spread raso fazia um substituir o outro por inteiro. Na ordem de chaves do
  `opencode.json` real, o lado perdedor era o do usuário. Agora **mescla**: a
  base é o bloco V2, os campos gerenciados do V1 sobrescrevem, e os campos do
  usuário são preservados. Mesma semântica já usada em `install/opencode.mjs`.
- **`docs/platforms/README.md` tinha tabela de step limits errada**: 14 linhas
  listando limites por agente, **nenhum valor batendo** com `src/agents/`.
  Tabela removida e a seção reescrita.

## ⚠️ Known Issues
- **Permissões de agente**: V1 usa `permission` e V2 usa `permissions`; ao mesclar esses blocos, a chave legada `permission` pode permanecer inerte ao lado de `permissions`.
- **Migração — rode o init uma vez**: `npx pantheon-opencode init
  --opencode-version=v2` **uma única vez** limpa o `steps` residual. Sem isso o
  config instalado continua carregando o teto antigo.
- **O `.md` de agente instalado é sobrescrito no próximo sync**: editar
  `~/.config/opencode/agents/*.md` esperando persistência **não funciona**.
  Comportamento **pré-existente**, não é regressão desta mudança — mas agora
  está documentado para não ser reportado como uma.
- **`steps` definido à mão num agente gerenciado é removido a cada install v2**:
  o instalador não distingue um valor que ele escreveu de um valor que você
  escreveu (mesma chave, mesmo valor). Workaround: definir no frontmatter do
  agente — e lembrar que ele **também** é sobrescrito no próximo sync.
## [v1.6.0-beta.1] - 2026-09-30

<!-- Add new changes here. Running `node scripts/versioning.mjs apply` will
     move this section to a versioned entry and reset the template below. -->

## 🆕 What's New
- **OpenCode 2** — first Pantheon beta compatible with the OpenCode 2 plugin
  contract.
- **memory** — preserve SQLite FTS5/BM25 keyword search and the `code_*` codemap
  tools.

## 🐞 Fixed
- **memory** — remove the legacy vector-memory scripts and embedding/KNN/RRF
  path.
- **CI/release** — keep validation fail-closed; expand `doctor` checks and add
  the OpenCode 2 V2-only sandbox validator.

---

## Archive notes

No `v1.6.0-beta.16` tag or section exists in this repository. `v1.6.0-beta.14` has a section but no local tag. This archive holds 17 sections for the 16 local `v1.6.0-beta.*` tags.
