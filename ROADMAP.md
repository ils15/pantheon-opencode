# 🗺️ Pantheon Roadmap

> **Last updated:** v1.5.0 (2026-09-01)
>
> Roadmap atualizado com base em pesquisa do ecossistema awesome-opencode.
> Sem referências a concorrentes. Foco no que Pantheon já tem e no que falta.

---

## ✅ v1.5.0 — Contrato atual

### Entregue e suportado

| Área | Contrato verificável |
|---|---|
| OpenCode V1 | `src/plugin.ts` preserva o plugin legado: `pantheon_delegate`, APIs V1 de leitura/listagem, BackgroundJobBoard, eventos/tool hooks e compaction hook quando registrados no caminho V1. |
| OpenCode V2 | `pantheon-opencode/plugin-v2` (`src/plugin-v2.ts`) é um adapter de configuração separado; transforma drafts de agents/catalog/commands/references/skills e não registra APIs, hooks, Board ou compaction V1. |
| Installer | `v1`, `v2` e `auto` selecionam uma única geração de plugin Pantheon. A seleção remove referências Pantheon da outra configuração e não mistura `plugin` V1 com `plugins` V2. |
| TUI | `pantheon-tui` é componente separado, registrado em `tui.json` somente quando `plugins` é instalado. Native tasks exigem origem, relação parent/child e status fornecidos explicitamente pelo host; ausência de Markdown não é autodetecção. |
| Histórico e recuperação | `.pantheon/delegations/` é o canal histórico de relatórios V1. A compaction carry-forward existe no caminho V1 comprovado; jobs V1 antigos/running não são auto-retomados após restart e são marcados como erro. |

### Limites que não são promessa de roadmap

- `plugin-v2` não é um adapter de paridade do runtime V1 e não adiciona hooks
  Pantheon, delegate tools, Board ou auto-resume.
- `auto` não é autodetecção geral de plataforma/runtime; só usa os hints
  explícitos documentados em [UPGRADING.md](docs/UPGRADING.md).
- A classificação de um native task e qualquer continuidade após restart só
  podem ser ampliadas depois de um contrato do host ser demonstrado e testado.

## 🔭 Próxima iteração — ainda não implementada

- Validar, no host V2, o contrato explícito de origem/status para native tasks
  antes de ampliar a integração da TUI.
- Definir uma migração deliberada para relatórios V1, sem tratá-los como
  protocolo V2 e sem auto-retomar jobs antigos.
- Documentar apenas novas capacidades depois de validação runtime e regressão.

---

## Histórico — plano v1.0-dev (superseded by v1.5.0)

### Entregue desde v3.14.0

| Versão | O que foi entregue |
|--------|-------------------|
| **v3.15.0** | Memory MCP com sqlite-vec + fastembed |
| **v3.16.0** | Level 2 Context Compression, sync engine |
| **v3.17.0** | MCP Resources Server, Code Mode Server |
| **v3.18.0** | Themis review gate, routing.yml, reasoning effort |
| **v3.19.0** | Memory Persistence Protocol, ADR-006, 14 skills |

---

## Histórico — plano v1.0 (superseded by v1.5.0)

### Sprint 1 ✅ — Memory Commands & Limpeza (Concluído)

| Item | Status |
|------|--------|
| `/pantheon-remember`, `/pantheon-search`, `/pantheon-consolidate`, `/pantheon-forget` | ✅ |
| Consolidar 23→14 comandos `/pantheon-*` | ✅ |
| Remover 9 comandos obsoletos | ✅ |
| `/pantheon-optimize` (archive + cache + dry-run) | ✅ |
| Deepwork archive (20→9 ativos) | ✅ |
| Sync engine, MCP servers, ROADMAP.md, research | ✅ |

### Sprint 2 — NPM + CLI Installer (3-5d)

```
@pantheon/cli (npm)
├── npx pantheon-opencode init / update / doctor / status
├── TUI interativo de setup
└── Plugin OpenCode: 14 agentes + 14 skills + 14 comandos + 3 MCPs
```

### Sprint 3 — Themis 2.0 + IntentGate (4-5d) 🚧 Já planejado

```
Layer 1 — Heuristic Scanner (zero LLM)
├── 50+ anti-patterns de IA slop
├── Hash-anchored edit verification
├── ruff + Biome + coverage delta (<2s, zero tokens)
└── Score 0-100 + blocking?

Layer 2 — Themis Review (LLM leve, ~500 tokens)
├── Só roda se Layer 1 passar
├── Confidence score por arquivo
└── Regression prediction

Layer 3 — Verification Planning
├── Pré-análise para mudanças N>5 files
└── Themis sugere + executa verificações

IntentGate: routing.yml classifica request antes de delegar (regex, zero LLM)
```

### Sprint 4 — Background Agents + Full-Auto (4-6d) ✅ Entregue (parcial) — ver commit 084a5a5

```
├── Background agents first-class (parallel dispatch, push notification) ✅
├── TODO Enforcer (idle detection, retry automático) 🔲 pendente
├── Hash-anchored edits 🔲 pendente
├── /pantheon-deepwork --full-auto (modo autônomo, gates automáticos) 🔲 pendente
└── Respeitar subagent_depth: 2 ✅
```

> Restante (TODO Enforcer, hash-anchored edits, full-auto) fica para a próxima iteração.

### Sprint 5 — Pruning + Cache + Memory (3-4d) 🚧 Já planejado

```
├── Tool output pruning (relevance scoring, auto-tagging)
├── Memory importance scoring + decay (entradas velhas perdem peso)
├── memory_search reranking
├── Anti-junk filter (threshold 0.4)
└── /pantheon-optimize --cache
```

### Sprint 6 — YAGNI + Code Reuse (2-3d) 🚧 Já planejado

```
├── Escada YAGNI no Zeus (antes de cada delegação)
├── Anti-overengineering no Themis (10+ padrões)
└── Consulta ao codebase antes de implementar
```

---

## Histórico — plano v1.0+ (superseded by v1.5.0)

**Baseado em pesquisa do ecossistema awesome-opencode (9k⭐, 300+ plugins)
por 5 agentes — 2.717 linhas de análise.**

### Sprint 7 — Background Architecture ✅ Entregue (2026-08-10, commit 084a5a5)

*Expande Sprint 4: runtime → API formal de desenvolvedor.*

```
├── Delegate/Read/List 3-Tool API ✅
│   ├── delegate(prompt, agent?) → task_id
│   ├── delegation_read(id) → result
│   └── delegation_list() → tasks[]
├── Read-only background enforcement (edit=deny, write=deny) ✅
├── 15-min timeout + persistence before notification ✅
├── Compaction-aware context (experimental.session.compacting hook) ✅
└── Auth interceptor: plugin hook para providers + multi-account rotation 🔲 pendente
```

### Sprint 8 — Community Integration (3-5d)

```
├── awesome-opencode listing
├── Plugin template repo (pantheon-org/plugin-template)
├── Publicar agentes como templates (canais comunitários)
├── Cross-orchestrator adapters
├── Skill registry leve (YAML catalog + npx pantheon-opencode install)
└── Plugin API contract documentado
```

### Sprint 9 — Dashboard UX (4-6d)

```
├── Token/cost tracking widget (footer: last + total, per-agent)
├── Agent status summary (idle/working/blocked/complete)
├── Multi-channel notifications (OS + push + webhook)
└── Accessibility mode (emoji→ASCII, reduced animation, high contrast)
```

### Sprint 10 — Memory 2.0 (5-8d)

*Expande Sprint 5: importância estática → sistema dinâmico.*

```
├── Confidence/decay system (boost no acesso, decay diário, archive <0.2)
├── Agent self-editable memory (memory_write, memory_forget tools)
├── Memory feedback tool (reforça/penaliza por score)
├── Security scanner em memory_store (detecta secrets antes de persistir)
├── Auto-deduplication (fuzzy matching + merge)
└── Cross-project memory (global namespace + TTL longo)
```

### Sprint 11 — Themis 2.5: Safety (5-7d)

*Expande Sprint 3: código → governança.*

```
├── Agent contract registry (allowed/forbidden per agent, YAML + Zod)
├── Step confirmation hooks (pause a cada N tool calls)
├── Output redaction (API keys, tokens, 74+ patterns)
└── Regression prediction from diff
```

### Sprint 12 — Multi-Model Routing (3-5d)

```
├── Tier 1 (cheap): exploração → flash/haiku
├── Tier 2 (balanced): implementação → sonnet/gpt-4o
└── Auto-select baseado na tarefa
```

### Sprint 13 — Stabilization (3-5d)

`Buffer: integração, documentação, performance, tech debt.`

---

## Histórico — decisões de arquitetura (v1.x)

1. **IntentGate heurístico** — Zero LLM, regex no routing.yml.
2. **Themis é o diferencial** — Gate de qualidade multi-camada.
3. **npm primeiro** — Sem adoção, não importa o quão bom é.
4. **Integrar com OpenCode, não competir** — Usar APIs nativas.
5. **subagent_depth: 2** — Zeus → Especialista, nunca sub-sub.
6. **Memory contínuo** — Confidence decay, agent-writable, auto-dedup.
7. **Background first-class** — Delegate/read/list API.
8. **Sem Rego/OPA por enquanto** — JSON/YAML + Zod é suficiente.
9. **Acessibilidade como diferencial** — Ninguém resolve isso em terminal.
10. **Sem tmux isolation** — Git worktree basta, menos complexidade.

---

## Histórico — métricas de sucesso planejadas (v1.0)

| Métrica | Atual no plano histórico | v1.0 Target |
|---------|-------|-------------|
| **npm downloads** | 0 | 500/mo |
| **awesome-opencode listed** | ❌ | ✅ |
| **GitHub stars** | — | 500+ |
| **Community plugins** | 0 | 5+ |
| **Themis patterns** | 20 | 50+ |
| **Tests** | ~119 TS + 97 pytest | 200+ |
| **Coverage** | ~60% | >80% |

---

## Histórico — fontes da pesquisa

### Deepwork Session: roadmap-v4-community
5 agentes, 2.717 linhas de análise:

| Agente | Relatório | Foco |
|--------|-----------|------|
| 🛸 Apollo | DISCOVERY-APOLLO.md | Mapeamento do ecossistema |
| 🏛 Hermes | DISCOVERY-HERMES.md | Backend e infraestrutura |
| 🎨 Aphrodite | DISCOVERY-APHRODITE.md | UX e frontend |
| 🌾 Demeter | DISCOVERY-DEMETER.md | Memória e dados |
| ⚖️ Themis | DISCOVERY-THEMIS.md | Segurança e governança |

### Repositórios de Referência
- [awesome-opencode/awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)
- [smc2315/harness-memory](https://github.com/smc2315/harness-memory)
- [xenitV1/lemma](https://github.com/xenitV1/lemma)
- [kdcokenny/opencode-background-agents](https://github.com/kdcokenny/opencode-background-agents)

---

## Changelog

| Data | Mudança |
|------|---------|
| 2026-08-10 | **Sprint 4 (parcial) + Sprint 7 entregues.** 3-tool API de delegação (pantheon_delegate/read/list) sobre BackgroundJobBoard; notificação via session.idle + chat.message flush (spike provou noReply indisponível); timeout 15min + output parcial persistido; enforcement read-only (edit/write/bash/task negados, apollo/gaia); compaction carry-forward; pruning TTL 24h. Commit 084a5a5. TODO Enforcer/full-auto/hash-anchored/auth-interceptor pendentes. |
| 2026-07-24 v6 | **Cleanup:** removidas referências a concorrentes, tabela competitiva removida. Sprints reorganizados: S6 (YAGNI) reconhecido como já planejado, S4 full-auto = modo autônomo, S5 decay já existe. Novos sprints (S7-S13) são expansões do que já existe, não features do zero. |
| 2026-07-24 v5 | Corrigido para v1.0. Revisão Themis aplicada. |
| 2026-07-24 v4 | Pesquisa comunitária. 6 novos sprints. |
| 2026-07-22 v3 | OpenCode v1.18 insights |
| 2026-07-22 v2 | Roadmap reescrito |
| 2026-06-20 | Última v3.14.0 |
