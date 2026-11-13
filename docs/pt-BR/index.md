# Documentação do Pantheon

> 🇺🇸 **English version available:** [Read in English](../index.md)

O **Pantheon** é um framework de orquestração multi-agente para o **OpenCode**: 14 agentes especializados, 25 skills prontas e um fluxo de trabalho guiado do planejamento à entrega revisada. Esta página é o mapa principal da documentação.

---

## Comece por Aqui

| Se você deseja… | Consulte |
|---|---|
| Construir seu primeiro projeto de ponta a ponta (scaffold → UI → skills → deploy → métricas) | [Guia do Primeiro Projeto](guides/first-project.md) |
| Criar uma ferramenta CLI rápida e testável com a Linha Expressa (`@talos`) | [Utilitário CLI (@talos)](guides/cli-tool.md) |
| Saber exatamente o que cada um dos 14 agentes pode e não pode fazer | [Matriz de Capacidades dos Agentes](AGENT-CAPABILITY-MATRIX.md) |
| Dominar planejamento canônico em JSON, DAGs em Mermaid e aprovações interativas | [Blueprint do Deepwork](guides/deepwork.md) |
| Inspecionar interfaces visuais e screenshots com modelos de visão | [Visão Multimodal](guides/vision.md) |
| Copiar receitas práticas prontas para fluxos de desenvolvimento do dia a dia | [Livro de Receitas (Cookbook)](guides/cookbook.md) |
| Instalar o Pantheon, entender flags do instalador e gerenciar backups | [Instalação](INSTALLATION.md) |
| Obter o primeiro resultado funcional em 10 minutos | [Início Rápido (Quick Start)](QUICKSTART.md) |
| Atualizar uma instalação existente do Pantheon | [Guia de Atualização](../UPGRADING.pt-BR.md) |
| Verificar suporte de versões do OpenCode e Node.js | [Compatibilidade](../COMPATIBILITY.md) |

---

## Entenda o Sistema

| Tópico | Documento |
|---|---|
| Fluxo de orquestração, regras de delegação e contrato do plugin | [Arquitetura](ARCHITECTURE.md) |
| Catálogo dos 14 agentes especialistas e seus arquivos canônicos | [Agentes & Skills](../agents/README.md) |
| Níveis de permissão, portões de qualidade e limites operacionais | [Permissões, Portões & Delegação](../PERMISSIONS-QUALITY-DELEGATION.md) |
| Comportamento no OpenCode 2.x: ciclo de vida, ferramentas nativas e despacho | [OpenCode 2.x](../opencode.md) |

---

## Operação & Ferramentas

| Tópico | Documento |
|---|---|
| Configuração de servidores MCP, pontos de entrada e allowlists | [Servidores MCP](MCP.md) |
| Catálogo de ferramentas MCP disponíveis, incluindo telemetria de custos | [Ferramentas MCP](../mcp-tools.md) |
| Gerenciamento de memória, TTL, limites de contexto e checkpoints de sessão | [Memória](MEMORY.md) |
| Plataformas e ecossistema suportado | [Plataformas](../PLATFORMS.md) |

---

## Referência Técnica

| Tópico | Documento |
|---|---|
| Roteamento inteligente de modelos e fallbacks automáticos | [Roteamento de Modelos](../reference/model-routing.md) |
| Roteador de Decisões Local | [Roteador Local](../reference/local-decision-router.md) |
| Ferramenta nativa de decisão Jev | [Decisões Nativas](../reference/native-decisions.md) |
| Protocolo de avaliação offline de complexidade de tarefas | [Avaliação Offline](../reference/offline-evaluation.md) |
| Custos de desempenho e ajustes de velocidade | [Desempenho](../reference/performance.md) |
| Variáveis de ambiente que configuram o comportamento do Pantheon | [Variáveis de Ambiente](../reference/env-vars.md) |
| Execução em Code Mode para operações de alto volume | [Code Mode](../reference/code-mode.md) |
