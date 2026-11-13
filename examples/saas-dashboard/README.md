# Exemplo: SaaS Performance Dashboard

Este projeto demonstra uma aplicação web fullstack moderna construída utilizando a orquestração multi-agente do **Pantheon** no OpenCode.

---

## 🏛️ Papéis dos Agentes Neste Projeto

Cada parte deste repositório foi produzida e validada pelo especialista correspondente do Pantheon:

* **⚡ @zeus:** Coordenou as etapas e mediou as decisões de negócio.
* **🏛️ @athena:** Desenhou a arquitetura do plano Deepwork em `.pantheon/deepwork/PLAN_001_metrics-dashboard/`.
* **✉️ @hermes:** Implementou o servidor HTTP (`src/server/index.mjs`), o serviço de streaming de CSV (`src/server/metrics.mjs`) e a suíte de testes automatizados (`tests/metrics-api.test.mjs`).
* **🎨 @aphrodite:** Criou o componente React acessível (`src/client/MetricsDashboard.jsx`) com Tailwind CSS e conformidade WCAG AA.
* **⚖️ @themis:** Conduziu a auditoria de qualidade e segurança emitindo o veredicto `PASS`.

---

## 🚀 Como Executar

### 1. Rodar os Testes Automatizados (TDD)

```bash
node --test tests/metrics-api.test.mjs
```

### 2. Iniciar o Servidor

```bash
npm start
```

O servidor iniciará em `http://localhost:3000`.

### 3. Endpoints Disponíveis

* `GET /api/health` — Checagem de integridade do serviço.
* `GET /api/metrics` — Retorna snapshot das métricas em JSON.
* `GET /api/metrics/export` — Gera download em streaming do relatório consolidado em CSV.

---

## 📜 Plano Canônico Deepwork

Veja a especificação técnica e o grafo de execução em:
* [PLAN.md](.pantheon/deepwork/PLAN_001_metrics-dashboard/PLAN.md) — Projeção legível com diagrama Mermaid.
* [plan.json](.pantheon/deepwork/PLAN_001_metrics-dashboard/plan.json) — Estado canônico em JSON.
* [journal.ndjson](.pantheon/deepwork/PLAN_001_metrics-dashboard/journal.ndjson) — Histórico de eventos append-only.
