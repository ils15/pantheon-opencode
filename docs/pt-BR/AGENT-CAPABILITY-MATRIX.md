# Matriz de Capacidades dos Agentes do Pantheon

> 🇺🇸 **English version available:** [Read in English](../AGENT-CAPABILITY-MATRIX.md)

Esta matriz consolida a autoridade de domínio, permissões no host, MCPs permitidos e restrições absolutas de cada um dos 8 agentes canônicos do Pantheon no OpenCode (além dos arquétipos efêmeros via `spawn_ephemeral`).

---

## 1. Fluxograma de Decisão: Quem Acionar?

Use este guia visual para escolher o especialista certo para o seu objetivo:

```mermaid
flowchart TD
    Start(["🎯 Qual é o seu objetivo?"]) --> Type{Tipo de Tarefa}

    Type -->|"Feature grande / Múltiplos arquivos"| Zeus["⚡ @zeus (Orquestrador)"]
    Type -->|"Planejamento / Arquitetura prévia"| Athena["🏛️ @athena (Arquiteta)"]
    Type -->|"Slice isolado (hotfix/infra/IA/obs)"| Eph["🧩 spawn_ephemeral (Worker)"]
    Type -->|"Backend / API / Infra / Regra de Negócio"| Hermes["✉️ @hermes (Backend TDD)"]
    Type -->|"Frontend / React / CSS / Acessibilidade"| Aphrodite["🎨 @aphrodite (Frontend UX)"]
    Type -->|"Banco de dados / SQL / Migrations"| Demeter["🌾 @demeter (Database)"]
    Type -->|"Auditoria pré-PR / Testes / Segurança"| Themis["⚖️ @themis (Auditora)"]
    Type -->|"Git / Releases / Memory Bank / ADRs"| Iris["🌿 @iris (Ops & Memória)"]
    Type -->|"Investigar código sem alterar nada"| Apollo["🔍 @apollo (Read-Only)"]

    Zeus -->|"Delega planejamento"| Athena
    Athena -->|"Pesquisa de código"| Apollo
    Zeus -->|"Despacha implementação"| Hermes & Aphrodite & Demeter & Eph
    Hermes & Aphrodite & Demeter -->|"Submete para auditoria"| Themis
```

---

## 2. Visão Geral de Permissões e Ferramentas

| Agente | Domínio | Edit Code? | Bash / Shell? | Subagentes (`task`) | Question Tool? | MCPs Permitidos |
|---|---|:---:|:---:|:---:|:---:|---|
| **@zeus** | Orquestração Central & Roteamento | ❌ `deny` | ❌ `deny` | ✅ `all` | ✅ `allow` | `resources`, `memory_search`, `persistence`, `vision` |
| **@athena** | Arquitetura & Planejamento | ❌ `deny` | ❌ `deny` | ❌ `deny` (filho) | ✅ `allow` | `resources`, `memory_search` |
| **@hermes** | Backend, APIs, Infra & Execução | ✅ `allow` | ✅ `allow` | ⚠️ `@apollo` | ❌ `deny` | `resources`, `memory_search`, `code-mode` |
| **@aphrodite** | Frontend, UX, React & CSS | ✅ `allow` | ✅ `allow` | ⚠️ `@apollo` | ❌ `deny` | `resources`, `memory_search`, `vision`, `code-mode` |
| **@demeter** | Banco de Dados, SQL & Migrações | ✅ `allow` | ✅ `allow` | ❌ `deny` | ❌ `deny` | `resources`, `memory_search`, `code-mode` |
| **@themis** | Auditoria de Segurança & Portão de Qualidade | ❌ `deny` | ✅ `allow` (read-only) | ❌ `deny` | ❌ `deny` | `resources`, `memory_search` |
| **@apollo** | Investigação & Busca Exploratória | ❌ `deny` | ❌ `deny` | ❌ `deny` | ❌ `deny` | `resources`, `memory_search`, `webfetch` |
| **@iris** | Git, Releases, Memory Bank & ADRs | ❌ `deny` | ✅ `allow` (git/gh) | ❌ `deny` | ❌ `deny` | `resources`, `memory_store`, `code-mode` |

---

## 2. O que Cada Agente PODE e NÃO PODE Fazer

### @zeus (Orquestrador)
- **PODE:** Decidir fluxos, despachar especialistas ou workers `spawn_ephemeral` (`hotfix`, `infra-ci`, `ai-pipeline`, `observability`, `geospatial`, `memory-adr`), coordenar `pantheon_board`, arbitrar dúvidas via Jev (`pantheon_jev_decide`), abrir perguntas interativas (`question`), ler até 50 linhas para roteamento rápido.
- **NÃO PODE:** Editar código diretamente (`edit: deny`), executar comandos no terminal (`bash: deny`), pedir ao usuário para rodar comandos de terminal, ou realizar varreduras recursivas em `.git/**` ou `node_modules/**`.

### @athena (Arquiteta)
- **PODE:** Criar especificações arquiteturais, analisar trade-offs, definir blueprints de implementação e planos técnicos detalhados (`PLAN.md`).
- **NÃO PODE:** Implementar ou editar código (`edit: deny`), rodar testes/shell (`bash: deny`), ou abrir diálogos de aprovação dentro da sessão filha (retorna o plano ao Zeus).

### @hermes (Backend & Execução)
- **PODE:** Escrever endpoints FastAPI/Node, regras de negócio, configs de infra/CI, hotfixes e testes unitários backend; executar comandos de teste e linting via bash.
- **NÃO PODE:** Alterar schemas de banco de dados (delegar a `@demeter`) ou criar interfaces visuais (delegar a `@aphrodite`).

### @aphrodite (Frontend)
- **PODE:** Criar componentes React/Next, estilizar com Tailwind/CSS, validar acessibilidade WCAG, rodar dev server e testes de interface (Vitest/Playwright).
- **NÃO PODE:** Implementar rotas ou lógica interna de backend, alterar schemas de persistência, ou ignorar contrastes e padrões a11y.

### @demeter (Banco de Dados)
- **PODE:** Criar e alterar migrações (Alembic/Prisma), otimizar queries SQL, prevenir problemas N+1, validar integridade referencial.
- **NÃO PODE:** Fazer alterações em componentes frontend ou implementar regras de negócio fora da camada de persistência.

### @themis (Revisora & Auditora)
- **PODE:** Executar suites de teste e linters em modo de leitura para avaliar conformidade (Biome, ruff, pytest), emitir veredictos (`PASS`, `PASS_WITH_NOTES`, `BLOCK`, `BLOCK_INTENT`).
- **NÃO PODE:** Modificar arquivos ou corrigir código encontrado (`edit: deny` absoluto — separação estrita de poderes).

### @apollo (Investigador)
- **PODE:** Varrer o código com `grep`, `glob` e `read`, pesquisar referências na web com `webfetch`, sintetizar descobertas estruturadas.
- **NÃO PODE:** Modificar nenhum arquivo (`edit: deny`), executar scripts/comandos de terminal (`bash: deny`).

### @iris (GitHub Ops & Custódia de Memória)
- **PODE:** Gerenciar branches/PRs/issues/releases (via `git`/`gh`), executar `/pantheon-consolidate` e curar entradas duráveis em `pantheon-memory` (`memory_store`/`memory_forget`) e ADRs sob solicitação explícita.
- **NÃO PODE:** Fazer push ou merge sem aprovação humana explícita, nem editar código de aplicação.

---

## 3. Subagentes e Arbitragem Jev

Por padrão, apenas o orquestrador `@zeus` invoca `pantheon_jev_decide`. Subagentes podem ser autorizados explicitamente definindo a variável de ambiente:

```bash
export PANTHEON_JEV_SPECIALIST_CALLERS="athena,hermes,aphrodite,apollo"
```
