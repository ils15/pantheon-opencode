<!-- synced-from: docs/UPGRADING.md @ 7359e4f -->
# Atualização do Pantheon

> **Nota do 2.0:** o 2.0 removeu a linha de plugin V1. As seções abaixo descrevem
> a migração 1.x → 2.x e são mantidas como histórico; instalações novas são
> exclusivamente 2.x e o instalador registra `src/plugin` (configs anteriores à
> renome ainda registram `src/plugin-v2`, que o `init` migra).

[English](UPGRADING.md)

## Atualizando para o 2.0

O Pantheon 2.0 exige **OpenCode 2.x** e Node.js **>=26.4.0**; a linha de plugin
legado do OpenCode 1.19.x foi removida. O que isso significa para uma instalação
existente:

- **Removido junto com a linha V1:** o próprio plugin V1, o assistente de
  modelo da instalação e os presets estáticos (`init --preset`, `set-tier`,
  `PANTHEON_MODEL_PRESET` — use overrides de projeto do `pantheon_model`), as
  tools de goal V1 e o ciclo do BackgroundJobBoard, e o assistente interativo e
  o escopo global do `/pantheon-model`. Veja [Instalação](INSTALLATION.md) e
  [Model Routing](reference/model-routing.md).
- **Instalações legadas são migradas, não recriadas:** rode
  `npx pantheon-opencode init` uma vez. Um registro pré-2.0 — incluindo o
  caminho descontinuado `src/plugin-v2` — é reconhecido, removido e reescrito
  para a entrada atual `src/plugin`. Um host que se reporta como OpenCode 1.x é
  recusado (atualize o OpenCode primeiro), e um `--opencode-version v1` Explícito
  é recusado com a mensagem do 2.0. A resolução de versão está documentada em
  [Compatibilidade](COMPATIBILITY.md#how-the-generation-is-selected).
- **Aliases descontinuados saem no 2.1:** o alias de export
  `pantheon-opencode/plugin-v2` e os aliases de variável de ambiente
  `PANTHEON_V2_P7_LOOP` / `PANTHEON_V2_P8_GUARDRAIL` ainda funcionam no 2.0 com
  um aviso de descontinuação; renomeie para `pantheon-opencode/plugin` e
  `PANTHEON_P7_LOOP` / `PANTHEON_P8_GUARDRAIL` antes do 2.1. Os nomes canônicos
  estão em [Variáveis de ambiente](reference/env-vars.md).
- Depois de atualizar, rode `pantheon-opencode doctor` e reinicie o OpenCode.

O detalhe versão por versão fica no
[changelog](https://github.com/ils15/pantheon-opencode/blob/main/CHANGELOG.md);
esta página não o duplica.

Este guia cobre dois movimentos: **1.5.2 → 1.6.0**, uma atualização dentro da
linha, e **1.6.x → 2.x**, que cruza a fronteira de suporte do Pantheon. As
versões de host suportadas e a evidência estão em
[Compatibilidade](COMPATIBILITY.md); esta página descreve as ações.

## Atualizando de 1.5.2 para 1.6.0

Instale globalmente primeiro — `update` recusa cópias local, workspace e `npx`:

```bash
npm install -g pantheon-opencode@beta
pantheon-opencode update            # canal beta do npm + refresh de config
pantheon-opencode update --stable   # canal estável
```

`update` compara a versão instalada com a dist-tag do npm, executa
`npm install -g pantheon-opencode@<channel>` e roda de novo `init --yes
--headless` para que merges de config, o venv Python e as entradas MCP
correspondam ao pacote novo. Artefatos de cópia (agents, skills, `AGENTS.md`,
commands, scripts MCP, payload code-mode) são atualizados pelo `postinstall` em
todo `npm install`.

Depois da atualização:

```bash
pantheon-opencode doctor
```

`doctor` avisa quando o pacote é mais novo que a última sincronização e detecta
drift de versão do plugin quando o caminho registrado aponta para uma cópia
antiga em `node_modules/pantheon-opencode`.

Se a atualização for interrompida, rode `init` de novo. Cada passo de cópia é
idempotente por comparação de bytes, e o conjunto de backup exato em
`.pantheon/backups/<timestamp>/` é revertido com `pantheon-opencode restore`.
Detalhes em [Instalação](INSTALLATION.md).

### O que muda na 1.6.0

- **A superfície de tools V2 é de três tools incondicionais** — `hashline_edit`,
  `pantheon_cost`, `pantheon_model` — mais até duas dependentes do host:
  `vision_describe` quando o host expõe o catálogo de modelos, e
  `pantheon_bounded_read` quando o host expõe as APIs de permissão e sessão
  (apenas sessões raiz do Zeus). Não são seis tools.
- **As três tools de goal do V2 não são registradas.** O loop de goal precisa de
  `GoalStore`, `GoalLoopClient` e `BackgroundJobBoard`, que o `PluginContext`
  V2 não expõe. A lacuna é reportada como `goal-tools`.
- **Toda tool V2 declara `output`.** O OpenCode 2.0.x rejeita uma tool cuja
  declaração e resultado não concordam.
- **Sessões read-only do V2 são aplicadas.** Uma sessão delegada de
  `apollo`/`gaia` recebe `deny` para `edit`, `write`, `bash`, `task`,
  `hashline_edit` e `pantheon_model` pelo hook `execute.before` do V2.
- **Goals manuais duráveis passam para o MCP de Persistence.** `goal_create`,
  `goal_get`, `goal_update` e `goal_done` são exclusivos do Zeus e escopados por
  sessão. As tools de goal V1 continuam disponíveis, mas depreciadas.
- **Tetos de passos são removidos em instalações V2.** `steps` é opcional no
  OpenCode 2; ausente significa nenhum teto nativo. Rode o instalador uma vez
  para limpar um valor antigo de um agente gerenciado.
- **A memória ganha cap de 64 KiB e TTL**, e `pantheon_cost` reporta USD por
  agente, modelo e sessão a partir do catálogo models.dev.

### Escolhendo a geração

```bash
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2
npx pantheon-opencode init --opencode-version auto
```

`auto` é o padrão. `--version v1|v2` continua aceito depois de `init` como a
grafia legada. A ordem de resolução e o comportamento de fallback estão
documentados uma única vez em
[Compatibilidade](COMPATIBILITY.md#how-the-generation-is-selected). `auto` nunca
instala as duas gerações do plugin Pantheon.

### Checklist de migração

1. Pare o OpenCode antes de trocar a geração do plugin.
2. Rode `init` uma vez com o seletor desejado (`v1`, `v2` ou `auto`). Não copie
   uma entrada de plugin V1 para uma lista `plugins` V2, nem o contrário.
3. Se quiser a TUI, inclua o componente `plugins` do instalador. V1 usa
   `tui.json`; V2 usa os entrypoints nativos `index.ts` + `tui.ts`. Instalar
   apenas o plugin de servidor V2 não instala a TUI.
4. Inspecione o resultado: entradas Pantheon V1 ficam em `plugin`; a entrada V2
   é o diretório `<installed>/src/plugin` em `plugins`.
5. Reinicie o OpenCode depois de mudar a configuração.
6. Rode `doctor` e confirme que não resta drift de versão do plugin.

### Se o host cair na geração errada

Uma instalação na geração errada significa que o gate não conseguiu ler o host;
não significa que ele adivinhou. Passe `--opencode-version v2`
explicitamente, ou defina `OPENCODE_VERSION=v2`. Para ver o que o gate lê, rode
`opencode --version`.

## Diferenças de runtime após a atualização

- **Delegação:** nenhuma geração registra uma tool de delegação específica do
  Pantheon. Use o motor nativo de sessões filhas do host — `subagent` no runtime
  raiz relatado, `task()` na documentação de host/API. As antigas
  `pantheon_delegate`, `pantheon_delegation_read` e `pantheon_delegation_list`
  foram removidas.
- **V1:** traz `hashline_edit`, as tools de goal/cost/model, o ciclo de vida do
  BackgroundJobBoard e os hooks V1 de evento/tool/compaction.
- **V2:** não registra o BackgroundJobBoard, hooks V1 de evento/tool nem um hook
  de compaction V1. Ele adiciona os hooks V2 documentados em
  [OpenCode 2.x](opencode.md).
- **Recuperação:** ao reiniciar, jobs antigos ou em execução do board V1 são
  marcados como erro; não são retomados automaticamente e o trabalho filho não
  reinicia sozinho. O V2 não adiciona retomada/reinício automático.
- **Relatórios:** os relatórios Markdown em `.pantheon/delegations/` são saída
  histórica do board V1, não um protocolo de tarefa V2.

Não descreva esta atualização como uma migração de paridade V1→V2. É uma escolha
entre um plugin de runtime legado e um adaptador mais estreito, nativo do host.

## Perspectiva histórica: o plano da 1.6.x para a 2.x

A remoção que a linha 1.6.x anunciou para "a partir da 1.7" chegou como **2.0**:
o contrato V1 saiu e o OpenCode 2 é o único host suportado. Os passos de
preparação abaixo são mantidos para quem vem da 1.6.x; o que de fato aconteceu
com cada superfície está em
[Atualizando para o 2.0](#atualizando-para-o-20).

## Notas históricas de atualização

Estas notas estão superadas e são mantidas para quem vem de linhas antigas.

- **v1.0** removeu todo o suporte multiplataforma; o Pantheon roda apenas no
  OpenCode. A instalação passou a ser `npx pantheon-opencode init`.
- **v3.19.0** introduziu o Memory Persistence Protocol. As regras obrigatórias
  de recall/store por agente são históricas: a política atual busca apenas
  quando o histórico do projeto pode mudar o resultado, reutiliza resultados do
  coordenador nas delegações e grava no máximo um resultado reutilizável de
  nível superior quando existe uma tool de escrita permitida. Veja
  [Memória](MEMORY.md).
- `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` não é pré-requisito
  universal. É um gate experimental de alguns runtimes e é definido pelo
  launcher `npm run start` do Pantheon; use apenas quando o runtime documentar e
  exigir.

Para detalhe versão a versão, veja o
[changelog](https://github.com/ils15/pantheon-opencode/blob/main/CHANGELOG.md).
