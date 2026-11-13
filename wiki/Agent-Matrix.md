# Matriz de Capacidades dos Agentes

Esta tabela consolida o que cada um dos 14 agentes pode e não pode fazer dentro do OpenCode.

| Agente | Domínio Principal | Edit Code? | Bash / Shell? | Quando Chamar? |
|---|---|:---:|:---:|---|
| **@zeus** | Orquestração & Coordenação | ❌ `deny` | ❌ `deny` | Para tarefas multi-etapa, features completas e roteamento. |
| **@athena** | Arquitetura & Deepwork | ❌ `deny` | ❌ `deny` | Para planejar arquitetura antes de escrever código (`/plan`). |
| **@apollo** | Batedor Investigativo | ❌ `deny` | ❌ `deny` | Para pesquisar código e referências sem alterar nada. |
| **@hermes** | Backend & APIs | ✅ `allow` | ✅ `allow` | Endpoints REST, regras de negócio, testes unitários backend. |
| **@aphrodite** | Frontend & UI/UX | ✅ `allow` | ✅ `allow` | Componentes React/Next, Tailwind, acessibilidade WCAG. |
| **@demeter** | Banco de Dados & SQL | ✅ `allow` | ✅ `allow` | Migrations (Alembic/Prisma), schemas e otimização de queries. |
| **@themis** | Auditoria & Segurança | ❌ `deny` | ✅ `allow` (read) | Revisão de código, linters, checagem de segredos e conformidade. |
| **@talos** | Hotfixes Express | ✅ `allow` | ✅ `allow` | Ajustes rápidos, correção de bugs pontuais e pequenos CSS. |
| **@prometheus**| DevOps & Docker | ✅ `allow` | ✅ `allow` | Dockerfiles, pipelines CI/CD do GitHub Actions e deploy. |
| **@hephaestus**| IA & Pipelines LLM | ✅ `allow` | ✅ `allow` | Integração com provedores de IA, prompts e pipelines de embeddings. |
| **@gaia** | Sensoriamento Remoto | ❌ `deny` | ❌ `deny` | Processamento de imagens de satélite e dados geoespaciais. |
| **@iris** | Git & Releases | ✅ `allow` | ✅ `allow` (git) | Abertura de PRs, criação de tags e notas de release. |
| **@mnemosyne** | Memory Bank & ADRs | ⚠️ `.pantheon/**` | ❌ `deny` | Documentação de decisões de arquitetura duráveis. |
| **@nyx** | Testes Adversariais | ❌ `deny` | ❌ `deny` | Testes de estresse, caos e simulação de entradas anômalas. |
