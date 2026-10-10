# Atualização do Pantheon — 1.6.0

[English](UPGRADING.md)

> ### ⚠️ Antes de atualizar: verifique o limite de linha
>
> **A linha 1.6.x é a última do Pantheon que suporta um host OpenCode 1.X. A
> partir da 1.7, toda release é uma breaking change com alvo no OpenCode 2.**
> Atualizar de qualquer release 1.6.x para 1.7+ cruza, portanto, tanto um
> limite de suporte do Pantheon quanto um limite de major do OpenCode ao mesmo
> tempo. A política, a matriz de suporte e o que é verificado contra qual host
> estão na [seção de compatibilidade do README](../README.pt-BR.md) e, com mais
> detalhe, em [INSTALLATION.md](INSTALLATION.md#opencode-v1v2--contrato-de-plugin).
> Todo o restante deste documento vale para atualizações *dentro* da linha 1.6.

O Pantheon 1.6.0 documenta dois contratos de plugin OpenCode exclusivos. Antes
de atualizar, escolha o contrato que corresponde ao host OpenCode que você vai
rodar:

| Seletor | Chave de config | Entrada Pantheon | Escopo |
|---|---|---|---|
| `v1` | `plugin` singular | `src/plugin.ts` e o V1 `src/plugins/pantheon-hooks.ts` | Plugin Pantheon V1: 6 ferramentas (`hashline_edit`, as 3 ferramentas de goal, `pantheon_cost`, `pantheon_model`), ciclo de vida do board, hooks V1 e caminho de compactação implementado |
| `v2` | `plugins` plural | Pacote npm exato `pantheon-opencode@<versão>` (o export da raiz do pacote carrega `src/plugin-v2.ts`) | Plugin V2: 3 ferramentas (`hashline_edit`, `pantheon_cost`, `pantheon_model`), 5 assinaturas de eventos, session hooks, hooks de permissão read-only e caller/target, além de transforms de configuração |

**Mudou na 1.6.0 — a superfície de ferramentas do V2 são 3 ferramentas, não 6.**
As três ferramentas de goal (`pantheon_goal_create`, `pantheon_goal_get`,
`pantheon_goal_update`) **não são registradas no contrato V2**. O goal loop
exige um `GoalStore`, um `GoalLoopClient` e um `BackgroundJobBoard`, nenhum dos
quais o `PluginContext` do V2 expõe, e a bridge V1 resolve para `null` fora do
V1. Antes, elas eram registradas como placeholders que devolviam uma string
explicativa — mas no OpenCode 2.0.x uma tool assim falha em **todas** as
chamadas com `Tool result declared output without an output schema`, de modo
que o placeholder nunca rodou de forma útil. Agora elas simplesmente estão
ausentes. `getUnsupportedFeatures()` reporta a lacuna com o marcador
`goal-tools`. Use o contrato V1 se você precisa do goal loop.

Três correções V2 adicionais acompanham essa mudança:

- Toda tool V2 agora declara `output`. O host exige que a declaração e o
  resultado resolvido estejam de acordo, nos dois sentidos; uma tool sem
  declaração falha em 100% das chamadas.
- O hook `execute.before` da tool V2 **impõe sessões somente-leitura** em vez
  de ser um no-op. As três ferramentas V2 — incluindo a primitiva de escrita
  `hashline_edit` e o `pantheon_model`, que escreve `active-preset.json` em
  escopo de projeto *e* global — estavam acessíveis a partir de uma sessão
  delegada `apollo`/`gaia`, porque o hook `tool.execute.before` do V1 que
  deveria negá-las vive em `src/plugin.ts`, que não é carregado quando apenas
  `plugin-v2` está configurado. O plugin V2 agora instancia o mesmo
  `createEnforcementGuard` e nega `edit`, `write`, `bash`, `task`,
  `hashline_edit` e `pantheon_model` numa sessão somente-leitura. O host coloca
  o agente ativo no próprio evento `execute.before`, então o V2 não precisa de
  um hook equivalente a `chat.params` para popular o registro.
- O `pantheon_model` no V2 não tem wizard interativo (uma chamada de tool não
  tem terminal). Passe `action="status"` para ler os overrides, ou `agent` +
  `model` com `action="set"`.

### Comportamento de delegação e hooks no V2

O V2 aplica a matriz caller/target para alvos gerenciados pelo Pantheon em
todas as entradas do array `resources` de `permission.evaluate`. Recursos
exclusivamente nativos passam intactos para o OpenCode; requisições mistas
nativo/Pantheon e multi-alvo são negadas a menos que todo alvo Pantheon esteja
explicitamente permitido para o caller autoritativo. Negações explícitas do
host permanecem finais, e dados de recurso malformados ou desconhecidos falham
fechados (fail-closed). O probe de sandbox V2.0.25 observou `resources`,
`agent`, `sessionID` e `effect` no evento de permissão, com um argumento de
saída mutável. Se esse argumento de saída estiver ausente, uma negação de
política lança erro em vez de depender silenciosamente de uma mutação de
status que não pode ocorrer.

O `execute.after` do V2 roda a cadeia de paridade de resultado concluído nesta
ordem: `task-result-guard` → `context-sandbox` → `read-enhancer`. Os hooks
`session.prompt` e de compactação permanecem apenas registrados; a intercepção
de visão e a construção de contexto de compactação seguem exclusivas do V1. O
`context-sandbox` é uma transformação pós-resultado, não um limite de
autorização nem um controle geral fail-closed.

#### Configuração `context_sandbox` do V2 e escopo de segurança

O host V2 não preserva a configuração `context_sandbox` de topo do V1. Num
probe isolado contra um host vivo `opencode2 v0.0.0-beta-19271` (2026-10-09),
o `GET /api/config` omitia um `context_sandbox` de topo fornecido, enquanto o
`options.context_sandbox` da entrada de plugin chegava intacto em
`ctx.options`. Uma configuração V2 direta no topo é portanto
**não-suportada/inerte**; não a trate como proteção ativa. O installer V2
traduz um bloco de topo legado para o `plugins[].options.context_sandbox` do
plugin Pantheon, preservando a cópia de topo para um downgrade posterior a V1.
Os testes do installer cobrem a tradução, a precedência por folha, a validação
e a idempotência. Ao editar uma config V2 manualmente, use a opção aninhada do
plugin.

"Fail closed" tem escopo deliberadamente limitado à política de delegação V2 e
aos caminhos de falha do secret scanner exercitados com falhas injetadas. Não
é uma afirmativa sobre todo hook V2, toda chave de config, ou a transformação
de resultado do `context-sandbox`.

O installer remove as entradas Pantheon das duas formas de config e escreve
apenas a geração selecionada. O V1 mantém caminhos locais do pacote; o V2
escreve a versão npm exata do pacote em vez de um caminho absoluto para um
prefixo global ou cache `npx` transitório. Ele não mistura as entradas V1 com
o pacote V2; entradas de terceiros não relacionadas são retidas e não são
convertidas. O export da raiz do pacote é a entrada do plugin V2, enquanto
`pantheon-opencode/plugin` permanece o export explícito do V1.

#### Verificação V2 repetível e waiver da TUI interativa

O gate isolado de install/MCP/doctor é repetível sem carregar plugins de
terceiros:

```bash
bash scripts/test-opencode-v2-sandbox.sh --prepare
bash ~/pantheon-sandbox/run-test.sh
```

O replay local do read-hook e a fatia host-backed de hooks são checagens
separadas; a primeira usa eventos de fixture explícitos em vez de depender de
um modelo chamar `read`, e a segunda exercita o despacho de hooks pelo host
OpenCode isolado. Os testes de contrato V2 exercitam decisões de delegação com
eventos de permissão controlados. `tests/tui-packaged-smoke.test.mjs` verifica
que o plugin TUI empacotado registra sua sidebar, trata um evento de task e
faz dispose. Este é um waiver explícito para uma *sessão interativa de TUI*
automatizada: nenhuma afirmativa de tecla interativa/sessão é feita pelas
checagens headless de MCP, hooks, contrato ou smoke do plugin empacotado.

```bash
# Fixar um contrato para esta configuração do OpenCode
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2

# O padrão. Lê a geração do host: OPENCODE_VERSION explícito vence; caso
# contrário um OPENCODE_BIN terminando em opencode2 seleciona V2; caso
# contrário o --version do próprio host decide (major >= 2 => V2).
npx pantheon-opencode init --opencode-version auto
```

`--version v1|v2` permanece aceito após o `init` como a grafia legada. `auto`
é o padrão e nunca instala as duas gerações de plugin Pantheon.

### Depuração: o host está na geração errada

Um install que caiu na geração errada significa que o gate não conseguiu ler o
host — não que ele adivinhou errado. O `auto` cai no V1 — com um aviso visível
— em exatamente três situações:

- **O probe não pôde rodar.** O `opencode` não estava no `PATH`, ou o
  `OPENCODE_BIN` apontava para algo não executável. O aviso cita o erro do
  spawn. Corrija o caminho, ou passe `--opencode-version v2` explicitamente.
- **O banner não tinha versão legível.** Alguns hosts imprimem uma data de
  build (`built 2026.10.04`) em vez de uma versão; uma data nunca é lida como
  major. O aviso cita o que o probe retornou.
- **O banner se contradizia.** Tokens parecidos com versão em desacordo, sem
  nome de tool para desempatar, por exemplo `1.18.33 (runtime 2.0.0)`. O aviso
  lista os majors encontrados. Passe a geração explicitamente.

Para ver o que o gate realmente lê, rode o binário do host você mesmo:

```bash
opencode --version
```

O gate prefere o token de versão imediatamente seguinte ao nome da tool, então
`node v22.1.0 (opencode 1.18.33)` resolve como host 1.x e
`opencode v1.18.33 built 2026.10.04` também resolve como 1.x. Se a resolução
ainda não for a esperada, `--opencode-version v1|v2` sobrepõe outright e
`OPENCODE_VERSION` sobrepõe tudo, exceto a flag explícita.

### Histórico: atualização entre betas da linha 1.5.0

O fluxo abaixo se aplicava ao canal beta da linha 1.5.0. Para uma instalação
1.6.0, use o checklist de migração mais abaixo.

1. Feche o OpenCode.
2. Rode `npx pantheon-opencode@beta update` (canal beta, o padrão durante os
   prereleases 1.5.0) ou `npx pantheon-opencode@beta update --stable`. No npx,
   fixe sempre `@beta` — `npx pantheon-opencode` puro resolve a tag `latest`
   (o release estável), que é anterior ao comando `update`. O comando compara
   a versão instalada com o dist-tag do npm, instala o pacote novo
   globalmente e re-executa `init --yes --headless` para alinhar merge de
   config, venv e entradas MCP com o pacote novo. Com instalação global,
   `pantheon-opencode update` (sem npx) faz o mesmo.
3. Se a atualização for interrompida, rode `init` de novo — cada passo de
   cópia é idempotente (byte-compare) e a escrita do config deixa um
   `opencode.json.bak` com o conteúdo anterior.
4. Abra o OpenCode e confirme com `npx pantheon-opencode doctor` (ele compara
   o marker de versão instalada com o pacote e avisa em caso de drift).

Artefatos de cópia (agents, skills, AGENTS.md, commands, scripts MCP e o
payload code-mode) são atualizados automaticamente pelo postinstall do
pacote a cada `npm install`; `init`/`update` só é necessário para merge de
config, venv e entradas MCP.

### Checklist de migração

1. Feche o OpenCode antes de trocar a geração do plugin.
2. Rode o `init` uma vez com o seletor desejado (`v1`, `v2` ou `auto`). Não
   copie uma entrada de plugin V1 para uma lista `plugins` V2, nem o
   contrário.
3. Se quiser a TUI, inclua o componente `plugins` do installer. A TUI é um
   registro separado em `tui.json`; instalar o V2 não implica que a TUI ou o
   runtime V1 estejam carregados.
4. Inspecione o resultado: entradas Pantheon V1 pertencem a `plugin`; a
   entrada Pantheon V2 é um pacote `pantheon-opencode@<versão>` versionado em
   `plugins`.
5. Reinicie o OpenCode depois de mudar a configuração. Esse restart recarrega
   o plugin selecionado; não é um resume automático de trabalho delegado.

### Diferenças de runtime após a atualização

- **Delegação:** nenhuma das gerações registra uma tool de delegação
  Pantheon — ambas usam o `task()` nativo do OpenCode. As antigas tools
  `pantheon_delegate`, `pantheon_delegation_read` e `pantheon_delegation_list`
  foram removidas do plugin V1.
- **V1:** entrega adicionalmente `hashline_edit`, as tools de goal/cost/model,
  o ciclo de vida do BackgroundJobBoard e os hooks registrados explicitamente
  para o V1.
- **V2:** o `plugin-v2` não registra o BackgroundJobBoard, os hooks V1 de
  evento/tool, nem um hook de compactação Pantheon. O `task()` nativo do
  OpenCode é uma capacidade do host, não uma API Pantheon do V2.
- **TUI:** native tasks só podem ser seguidas quando o OpenCode expõe metadados
  explícitos de origem, parent/child e status. A ausência de um relatório em
  Markdown não basta para classificar um filho como nativo.
- **Relatórios:** os relatórios `.pantheon/delegations/` em Markdown são saída
  histórica do delegate/board V1. Não são um protocolo de tasks V2 e não são
  convertidos automaticamente.
- **Recuperação:** o carry-forward de compactação do V1 está disponível apenas
  pelo seu caminho `experimental.session.compacting` implementado. No restart,
  jobs V1 antigos/running do board são marcados como erro; eles não são
  retomados automaticamente e o trabalho filho não é reiniciado
  automaticamente. O V2 não adiciona comportamento automático de
  resume/restart.

Não descreva esta atualização como uma migração V1-para-V2 de paridade de
funcionalidades. É uma escolha entre um plugin de runtime legado e um adapter
de configuração mais estreito.

## Notas históricas de atualização (superadas)

As notas abaixo descrevem releases antigas e são mantidas como referência
histórica. Não são o contrato de instalação ativo da 1.6.0.

### Atualização para a v1.0 (somente OpenCode)

A v1.0 removeu o suporte a múltiplas plataformas. O Pantheon passou a funcionar
exclusivamente no OpenCode.

### Mudanças incompatíveis
1. **Não há mais suporte a**: Claude Code, Cursor, Windsurf, Cline, Continue.dev e VS Code Copilot
2. **Instalação alterada**: use `npx pantheon-opencode init` em vez dos scripts específicos por plataforma
3. **Delegação em segundo plano**: requer `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`
4. **Somente OpenCode**: o suporte multiplataforma foi removido. Use `npx pantheon-opencode init` para configurar.

### Etapas de migração
1. Desinstale as configurações específicas da plataforma antiga
2. Execute `npx pantheon-opencode init` para instalar os agentes globalmente
3. Execute `npm run setup` para configurar servidores MCP, skills e TUI
4. Adicione `export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` ao perfil do shell

### Rollback
Para fazer rollback, use a tag da versão anterior do Pantheon compatível com sua implantação.

## Atualização para a v3.19.0

> **Histórico:** estas notas foram preservadas para usuários que atualizam de versões legadas.
> Novas instalações devem seguir o [INSTALLATION.md](INSTALLATION.md).

### Protocolo de Persistência de Memória

O Pantheon v3.19.0 introduziu o Memory Persistence Protocol — um sistema
padronizado para persistência e recuperação de memória pelos agentes.

Principais mudanças:
- Os 14 arquivos de agentes passaram a incluir uma seção `## 🧠 Memory Protocol` com regras obrigatórias
- Os agentes devem chamar `memory_recall()` antes do trabalho (top_k=3, ignorando resultados abaixo de 0,3)
- Os agentes devem chamar `memory_store()` depois do trabalho (máximo de 2 linhas, importância de 0,4 a 0,9)
- O Zeus armazena automaticamente o retorno dos agentes — nenhuma ação extra é necessária
- O salvamento automático de sessão é executado no encerramento da sessão
- O Memory Bank é atualizado apenas no fechamento do sprint (importância ≥ 0,6 é promovida)

**Nenhuma migração manual é necessária.** O protocolo é aplicado no nível das instruções dos agentes.

### Atualizações anteriores

Para atualizar de versões anteriores à v3.19.0, consulte o CHANGELOG para as mudanças específicas de cada versão.
