# Perguntas Frequentes (FAQ)

### 1. Qual a melhor forma de instalar o Pantheon no OpenCode 2.x?
Use o gerenciador nativo de plugins do próprio OpenCode:

```bash
opencode plugin add pantheon-opencode
```

Isso carrega os 14 agentes, 25 skills, comandos slash e as 26 ferramentas nativas em memória **sem copiar arquivos para o repositório**, funcionando em qualquer diretório ou worktree. Use `npx pantheon-opencode init` apenas se quiser gerar `.opencode/` ou `AGENTS.md` em disco.

### 2. Como atualizar e remover caches ou arquivos antigos (evitar dados stale)?
Dentro do OpenCode, rode `/pantheon-settings` e vá na aba **Atualizações** (`/pantheon-updates`). Lá você pode checar o canal (`latest` vs `beta`), atualizar o plugin e clicar em **Escanear obsoletos** / **Migrar & limpar** para remover cópias antigas em `.opencode/` e caches coexistentes em `~/.cache/opencode/npm/pantheon-opencode*` sem tocar no bundle ativo nem nos seus agentes/skills customizados.

### 3. Como ler planos Deepwork e relatórios grandes no terminal?
Execute `/pantheon-artifacts` (ou `/artifacts`). O visualizador lista `PLAN.md` (`.pantheon/deepwork/*/PLAN.md`), relatórios (`.pantheon/reports/*.md`) e ADRs (`docs/adr/*.md`) com leitura paginada e suporte a teclado e mouse — inclusive quando você está trabalhando dentro de uma git worktree.

### 4. Memória FTS5 e artefatos funcionam dentro de `git worktree`?
Sim! Tanto a memória SQLite FTS5 (`.pantheon/memory/memory.db`) quanto o visualizador `/pantheon-artifacts` detectam `--git-common-dir` e resolvem automaticamente para a raiz do repositório principal, mantendo memória e planos compartilhados entre worktrees (você pode isolar memória por worktree definindo `PANTHEON_ISOLATE_WORKTREE_MEMORY=1`).

### 5. Como usar no Windows + OpenCode Desktop?
O ambiente totalmente suportado hoje no Windows é rodar via **WSL2 (Linux)** (inclusive conectando o OpenCode Desktop ao workspace WSL2). No Windows nativo (`win32`) sem WSL2 há limitações conhecidas por chamadas POSIX e shell `/bin/bash`; veja [Plataformas](../docs/PLATFORMS.md).

### 6. Por que o `@zeus` não edita código diretamente?
O Zeus é o orquestrador central (fail-closed: sem acesso de escrita ou shell direto). Ele analisa o pedido, planeja com `@athena`/`@apollo` e delega a execução para especialistas (`@hermes`, `@aphrodite`, `@demeter`, `@prometheus`, `@talos`) com revisão da `@themis`.

### 7. Como resolver um bug urgente rapidamente sem planejamento longo?
Chame diretamente o **`@talos`**:

```text
@talos corrija o typo na mensagem de erro do arquivo auth.ts
```

### 8. Onde vejo custos da sessão, subagentes e documentações completas?
- **Sidebar ao vivo & `/dispatch`:** mostram tokens, cache, tool calls e custo agregado por subagente.
- **Tool `pantheon_cost`:** consulta detalhada por período/sessão.
- **Guias completos:** [Documentação PT-BR](../docs/pt-BR/index.md) · [English Docs](../docs/index.md) · [Site Oficial](https://ils15.github.io/pantheon-opencode/).
