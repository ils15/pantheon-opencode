# Atualização do Pantheon

[English](UPGRADING.md)

## Atualização para a v1.0 (somente OpenCode)

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
