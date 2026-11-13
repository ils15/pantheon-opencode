# Guia de Deepwork: Planejamento Rigoroso

O **Deepwork** é o sistema de planejamento disciplinado do Pantheon.

---

## 1. Princípios

1. **O plano vive em `.pantheon/deepwork/<slug>/`:**
   - `plan.json`: O estado canônico estrito.
   - `journal.ndjson`: O histórico auditável de eventos.
   - `PLAN.md`: A projeção visual em Markdown com grafo Mermaid.
2. **Zero HTML:** O Pantheon utiliza diálogos interativos nativos (`question` tool) no próprio OpenCode para decisões e aprovações.
3. **Decisões Humanas Primeiro:** Incertezas técnicas e escolhas de escopo são apresentadas com opções recomendadas `(Recomendado)` para aprovação com 1 clique.

---

## 2. Como Usar

No chat do OpenCode:

```text
/pantheon-deepwork Adicionar suporte a autenticação por Passkey
```

Ou delegando ao Zeus:

```text
@zeus elabore um plano de deepwork para a issue #42
```
