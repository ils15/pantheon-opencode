# Auditoria de memória, agentes e skills no OpenCode V2

**Data:** 2026-10-27
**Workspace:** `review/harness-optimization`
**Escopo:** changelog/documentação oficial do OpenCode V2; configuração MCP e permissões dos agentes Pantheon; política de memória/compaction; catálogo de skills e templates.
**Natureza:** auditoria estática inicial e execução das correções recomendadas. Os tempos MCP estão em `bench/results/memory-persistence-mcp-eval-20261027.md`. A verificação isolada não usa autenticação de provider; portanto, não houve avaliação de decisões reais do modelo.

## Resumo executivo

1. **Disponibilidade de MCP e decisão de chamada são camadas diferentes.** Configurar um servidor deixa as ferramentas acessíveis ao host. O agente só pode chamá-las quando suas permissões permitem; a política/instrução orienta quando deve fazê-lo. Instalar o MCP não causa, por si só, uma busca de memória em cada turno.
2. **O problema de conexão MCP foi corrigido e verificado no host.** A auditoria inicial encontrou `enabled: true` e `opencode mcp list` sem servidores. O instalador agora grava o schema V2 nativo; o sandbox limpo conectou exatamente cinco MCPs, `doctor` terminou com código 0 e `pantheon://agents` incluiu Zeus e Hermes.
3. **A busca ambiente foi removida.** O plugin não consulta SQLite na primeira mensagem; memória volta a ser uma chamada explícita de `memory_search`. Checkpoint de outra sessão e memória durável têm regras separadas de compaction nativa.
4. **A política de chamada de memória já é razoável no texto, mas não foi validada com modelo ao vivo.** A intenção é uma busca lexical curta quando o histórico pode mudar a resposta, checkpoint apenas ao retomar trabalho entre sessões e gravação durável só quando houver motivo de retenção.
5. **O inventário de skills foi reconciliado.** Os 14 agentes agora apontam apenas para IDs existentes; as 20 skills têm grants, metadados V2 válidos e permissões V1/V2 testadas. `src/routing.yml` e `skills-lock.json` têm validação de drift.
6. **A política de compressão foi unificada.** OpenCode resume a conversa ativa; checkpoints preservam somente retomadas entre sessões; memória durável continua explícita e separada.

## Resultado da execução do plano

- **MCP V2:** serialização `enabled` → `disabled`, cinco handshakes em sandbox e `doctor` sem erros.
- **Memória:** removidos o hook/plugin de injeção e o toggle de debug; atualizadas as instruções globais, Mnemosyne e documentação para busca seletiva, checkpoint enxuto e escrita durável explícita.
- **Skills:** permissões por agente derivadas de `skills:` com `* deny` e grants explícitos; referências inválidas removidas; campos de frontmatter sem suporte removidos; routing e inventário verificados.
- **Templates:** `$input` e exemplos `<...>` substituídos por `{{UPPER_SNAKE_CASE}}`; comandos usam expansão nativa `$ARGUMENTS`; teste de contrato cobre os dois formatos.
- **Gate de qualidade e orçamento:** o gate anti-slop curto e os limites de artefatos já presentes na branch foram mantidos e cobertos pelo `npm test`.
- **Avaliação comportamental:** não executada porque o sandbox isolado não contém autenticação de provider. Os tempos MCP sintéticos existentes medem servidores/chamadas diretas, não seleção de ferramenta pelo modelo, tokens ou latência fim a fim.

## O que o OpenCode V2 atual oferece

O changelog mais recente é **v2.2.0 (2026-10-27)**. As mudanças mais relevantes para o harness Pantheon são:

- Plugins podem anexar entradas de instrução nomeadas a uma sessão com `ctx.session.instructions.entry.put/list/remove`. O changelog diz que as alterações chegam como atualizações pequenas no próximo passo, sobrevivem à compaction e a reverts e não iniciam outro turno de modelo. Isso serve para estado curto da sessão; não substitui memória durável entre sessões.
- A compaction passou a usar a contagem de tokens informada pelo provider e o histórico da sessão começa na última compaction concluída. Isso torna menos necessário criar um gatilho percentual paralelo no Pantheon.
- O changelog registra correção para preservar `$0` e `$ARGUMENTS` literais em comandos personalizados e para recarregar skills de compatibilidade somente quando as fontes mudam.
- v2.1.4 introduziu background compaction experimental, mas resumos preparados e nunca usados ainda consomem tokens. Não recomendo ativá-la sem uma avaliação de qualidade/custo com os providers usados no Pantheon.

Fontes primárias: [changelog oficial do OpenCode](https://github.com/anomalyco/opencode/blob/dev/CHANGELOG.md), [MCP servers V2](https://dev.opencode.ai/v2/docs/mcp-servers/), [Agent Skills V2](https://dev.opencode.ai/v2/docs/skills/), [Agents V2](https://dev.opencode.ai/v2/docs/agents/) e [API de plugins V2](https://dev.opencode.ai/v2/docs/build/plugins/server).

## Evidência da auditoria pré-correção

Os itens abaixo registram o estado que motivou as mudanças. O resultado depois
das correções está em *Resultado da execução do plano*.

### Servidor MCP, grants e chamadas

- `scripts/install/opencode.mjs` semeia `pantheon-resources`, `pantheon-code-mode`, `pantheon-memory`, `pantheon-persistence` e `pantheon-vision`. Para uma configuração V2, o código as põe em `mcp.servers`, mas ainda escreve `enabled: true`; `config-migration.mjs` preserva essa forma. A documentação V2 atual especifica que servidores conectam automaticamente e que `disabled: true` é a forma de mantê-los desconectados. Essa diferença de esquema precisa ser corrigida e comprovada no host instalado.
- O relatório anterior registrou que `opencode mcp list` no sandbox mostrou **“No MCP servers configured”**, apesar das entradas no `opencode.json`. A avaliação direta dos processos MCP mediu os servidores, mas não provou descoberta pelo host. O primeiro critério de aceite deve ser que o host liste, conecte e exponha cada servidor corretamente.
- Os 14 agentes Pantheon declaram `pantheon-memory: [memory_search]`. A instalação transforma `mcp_tools` em permissões por agente e por ferramenta; Mnemosyne, em particular, tem grants duráveis como `memory_store`. Isso limita gravações por função, mas a autorização técnica não causa uma chamada automática.
- A política compartilhada em `src/instructions/memory-protocol.instructions.md` é mais seletiva que o grant: buscar apenas se história anterior puder mudar o resultado, `top_k=2`, reutilizar achados passados pelo Zeus e ignorar resultados fracos. Essa é a orientação correta para não pesquisar em todo turno.

OpenCode documenta servidor MCP como origem de ferramentas e permissões por ferramenta/agente; também documenta `disabled` como chave de conexão do servidor. Portanto, a configuração de conexão, os grants e a decisão do modelo devem continuar sendo avaliados separadamente.

### O que “usar memória” deve significar

| Camada | Uso correto | Pantheon hoje |
|---|---|---|
| Contexto da conversa | Fatos necessários para a tarefa atual | Mensagens atuais e resultado de delegação |
| Compaction nativa | Resumir histórico quando o host atingir o limite | OpenCode escolhe o momento; o plugin aplica poda estrutural antes do resumo |
| Entrada de instrução da sessão (V2.2) | Estado curto, atualizável e necessário após compaction, dentro da mesma sessão | API nova ainda não usada pelo plugin |
| Checkpoint de persistência | Retomar uma tarefa longa em outra sessão | `context_save/get`, com regras de uso explícito/risco de perda |
| Memória durável | Fato ou decisão reutilizável em sessões futuras | `memory_store`, com escrita restrita a Mnemosyne |
| Injeção ambiente | Consultar SQLite e incluir resultados no primeiro prompt sem chamada MCP do modelo | `memory_injection.enabled`, desligada por padrão |

O toggle `memory_injection.enabled` não é um “liga/desliga do MCP”. Ele ativa essa última camada, que duplica parte da finalidade de `memory_search` com uma busca lexical feita pelo plugin. Como ela lê a primeira mensagem e acrescenta dados ao prompt automaticamente, tem efeitos diferentes de “a ferramenta está disponível”.

**Recomendação:** o usuário que instala Pantheon deve receber o servidor MCP de memória conectado por padrão (exceto se escolheu `--no-mcp`, o runtime não pôde ser configurado ou desativou o servidor na própria configuração OpenCode). Não criar um toggle Pantheon para bloquear `memory_search`; a política do agente e o grant por ferramenta são suficientes. Para simplificar, remover a injeção ambiente do caminho padrão e aposentar sua opção depois de uma migração compatível. Se ela for mantida como recurso experimental, documentá-la como “injeção automática no primeiro prompt”, com opt-in separado e limite explícito.

### Desempenho e limites observados

O benchmark MCP já registrado usou processos stdio isolados e dados sintéticos pequenos:

- Inicialização + `initialize`: memória **1.284 ms**, persistência **674 ms**.
- Chamadas aquecidas: `memory_search` mediana **1,38 ms**; `memory_recall` **1,20 ms**; `context_get` **1,04 ms**; gravações entre **7,79 e 8,38 ms** nas amostras medidas.
- A busca é FTS5/BM25 lexical; não é busca semântica/vetorial. Sinônimos sem termos em comum podem não retornar memória.

Esses números indicam que SQLite/MCP aquecido não é o custo dominante de uma tarefa complexa. Não medem custo do provider, escolha do agente, geração de argumentos, chamadas em série, início do host ou tempo total de ACP/CLI. A falha de descoberta no sandbox também impede afirmar que a integração OpenCode está pronta.

## Skills, agentes e templates

### Inconsistências verificadas

1. **Inventário e referências:** 20 diretórios de skill; `aphrodite` referencia `file-prompts`, `hermes` referencia `file-prompts` e `streaming-patterns`, nenhum dos quais existe em `src/skills`. `clonedeps`, `codemap`, `loop-engineering`, `reflect`, `simplify`, `verification-planning` e `worktrees` não são referenciadas nos blocos `skills:` dos 14 agentes. O README lista algumas como “All agents”, mas isso não equivale a uma permissão/runtime grant.
2. **Formato V2:** oito skills contêm `context: fork`, `globs` e `alwaysApply`. A documentação oficial V2 descreve a descoberta por `SKILL.md`, ID derivado do caminho, `description`, chamada explícita da ferramenta `skill` e regras de permissão por agente; campos não reconhecidos não devem ser tratados como controles do OpenCode. No V2, limitar um agente a skills específicas deve usar permissões `skill` por ID, não depender de `skills:` no frontmatter legado.
3. **Proveniência de skill:** hoje há uma lista manual em `src/skills/README.md`, listas manuais em agentes e os próprios diretórios. Sem uma verificação que compare as três fontes com o que o instalador grava, referências podem ficar inválidas silenciosamente.
4. **Duplicação de memória/compaction:** `memory-protocol.instructions.md`, `zeus-memory-operations.instructions.md`, `context-compression/SKILL.md`, `memory-bank/SKILL.md` e `mnemosyne.md` repetem regras sobre quando buscar, salvar checkpoint, gravar dado durável e não guardar segredos. A repetição aumenta chance de instruções divergentes.
5. **Placeholder não tipado:** em comandos como `/pantheon`, `$ARGUMENTS` é expansão do host. Em prompts e instruções, `<target agent>`, `<safe key>` e `{path}` são exemplos a preencher, não necessariamente variáveis avaliadas. Hoje isso está claro para quem leu as convenções, mas não existe um contrato único que diga nome, origem, obrigatoriedade, escape/quoting, default e se o literal deve sobreviver à expansão.
6. **Gate de qualidade:** este workspace já inclui um gate curto compartilhado no formato de retorno: comparar resultado com pedido/evidência, retirar conteúdo genérico ou sem suporte, declarar incerteza e preservar restrições. Isso atende melhor como instrução sempre ativa mínima; não é necessário carregar uma skill longa de “anti-slop” em todas as tarefas.

### Estrutura alvo recomendada

| Local | Responsabilidade | Deve conter |
|---|---|---|
| `src/instructions/` | Regras pequenas e sempre ativas | Segurança, escopo, qualidade de resposta e política mínima de memória |
| `src/agents/` | Papel, roteamento e grants | Responsabilidade do agente, limites e ferramenta necessária; sem cópia integral de skills |
| `src/skills/<id>/SKILL.md` | Procedimento carregado sob demanda | Descrição de seleção clara, passos específicos, limite de escopo, saída/checagem e referências auxiliares |
| `prompts/` | Briefs/templates de trabalho reutilizáveis | Inputs nomeados e estruturados; não duplicar políticas globais ou comandos |
| `commands/` | Interfaces slash invocáveis | Uso e variáveis que o host realmente expande (`$ARGUMENTS`, `$1` etc.) |
| Gerador/validador | Contrato único | README de skills, referências de agente, frontmatter V2, IDs e placeholders consistentes |

Para skills V2, manter os campos portáveis aceitos e usados (`name`, `description`, opcionalmente `compatibility`, `license` e `metadata`). Especificar seleção no `description`; usar `permissions` para esconder/carregar por agente. IDs vêm do caminho da skill, então os diretórios devem ser únicos e consistentes. Placeholder de exemplo deve ser claramente marcado como valor ilustrativo; variáveis de runtime devem ser enumeradas e testadas com espaços, aspas e valores literais que contenham `$ARGUMENTS`.

## Plano de simplificação e execução

### P0 — Fazer o MCP chegar ao host — concluído

1. ✅ Serializador emite `disabled: false` e migra `enabled` legado.
2. ✅ Instalação global limpa: cinco MCPs conectados, `doctor` exit 0 e recurso `pantheon://agents` com Zeus/Hermes.
3. ✅ Grants do instalador cobertos por testes; o host reconheceu os servidores antes de qualquer interpretação sobre comportamento do modelo.

### P1 — Tornar uma política de memória canônica — concluído

1. ✅ MCP disponível; chamada seletiva de `memory_search` em vez de busca em todo turno.
2. ✅ `context_save/get` para retomada entre sessões, `memory_store` para resultado durável autorizado e compaction nativa para histórico atual.
3. ✅ Removidos o recurso de injeção ambiente e o debug associado. Configuração antiga é preservada como opção desconhecida, mas ignorada.
4. ⏸️ API `ctx.session.instructions.entry` continua fora do escopo até haver cenário e avaliação de custo/qualidade.

### P2 — Higienizar skills sem apagar especialidades por suposição — concluído

1. ✅ Inventário verificado; `file-prompts` e `streaming-patterns` foram removidas das listas porque não existem.
2. ✅ As sete skills antes sem grant receberam escopo conforme o README: quatro skills gerais para todos e skills especializadas nos agentes pertinentes.
3. ✅ Frontmatter V2 restrito a `name` e `description`; permissões do agente agora negam `*` e permitem apenas IDs declarados.
4. ✅ Mnemosyne e a skill `context-compression` seguem compaction nativa e checkpoints mínimos; removido pipeline duplicado de fase/indexação.
5. ✅ Gate anti-slop permanece curto e always-on; procedimentos continuam carregados sob demanda.

### P3 — Contrato de placeholders e testes de integridade — concluído

1. ✅ `prompts/README.md` define variáveis do host versus entrada manual nomeada e quoting pelo caller.
2. ✅ Templates usam `{{UPPER_SNAKE_CASE}}`; comandos continuam com `$ARGUMENTS` nativo.
3. ✅ Contratos verificam skills ausentes, atribuições, metadados, routing drift, permissões e placeholders. `npm run skills:lock` atualiza os digests; `node scripts/validate-routing.mjs` valida o inventário.

### P4 — Avaliar decisões reais dos agentes — aguardando credencial de teste

Para executar cenários com provider isolado, é necessária autenticação de teste não presente no sandbox. Os cenários continuam definidos para uma sessão autenticada:

1. pergunta independente — nenhuma chamada;
2. alteração pequena sem relevância histórica — nenhuma busca/checkpoint;
3. tarefa cuja decisão depende de ADR/histórico — uma busca focal e uso correto do resultado;
4. tarefa longa retomada em nova sessão — um checkpoint e uma recuperação ao retomar;
5. pedido explícito de memória durável — escrita concisa apenas por Mnemosyne;
6. dado sensível apresentado — nenhum segredo persistido;
7. pressão de contexto — observar compaction nativa e preservar objetivo/decisões sem chamadas de memória redundantes.

Comparar políticas, não só latência. A métrica principal é decisão correta com o menor número suficiente de chamadas e sem perda de contexto. Manter uma baseline antes de alterar grants ou prompts.

## Critérios de aceite e estado

- ✅ Sandbox lista/conecta os cinco MCPs; `doctor` retorna zero erros.
- ⏸️ Decisões reais de chamada por agentes requerem provider auth; nenhuma conclusão é inferida dos grants estáticos.
- ✅ Política de escrita/retrieval está documentada; o comportamento real de armazenamento permanece sujeito à chamada observada do modelo.
- ✅ Checkpoint tem escopo, forma e condições de uso explícitos; compaction nativa não dispara escrita MCP.
- ✅ Skills existentes, metadados V2 reconhecidos e grants V1/V2 testados.
- ✅ Placeholders têm formato e origem documentados; teste rejeita as formas antigas nos templates.
- ⏸️ Tokens, latência por chamada do modelo e qualidade de recall não foram medidos sem provider auth.

## Conclusão

A arquitetura agora separa conexão MCP, grant por agente e decisão de chamada:
**MCP conectado por padrão, recuperação seletiva e gravação durável restrita**.
O sandbox provou a conexão dos cinco servidores, e testes de instalação
confirmaram as permissões de skills por agente. Falta apenas uma avaliação
model-backed com credencial de teste isolada para medir decisões de chamada,
tokens e latência fim a fim; medições SQLite/MCP aquecidas não substituem esse
ensaio.
