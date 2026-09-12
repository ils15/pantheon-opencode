# 🗺️ Pantheon Roadmap

> **Last updated:** v1.5.0-beta.4 (2026-09-12)
>
> **Roadmap zerado:** nenhum item pendente no plano ativo. A próxima iteração
> será definida após o release estável 1.5.0, com base em validação runtime —
> não neste documento.

---

## ✅ Contrato atual — entregue e suportado

| Área | Contrato verificável |
|---|---|
| OpenCode V1 | `src/plugin.ts` preserva o plugin legado: `pantheon_delegate`, APIs V1 de leitura/listagem, BackgroundJobBoard, eventos/tool hooks e compaction hook quando registrados no caminho V1. |
| OpenCode V2 | `pantheon-opencode/plugin-v2` (`src/plugin-v2.ts`) é um adapter de configuração separado; transforma drafts de agents/catalog/commands/references/skills e não registra APIs, hooks, Board ou compaction V1. |
| Installer | `v1`, `v2` e `auto` selecionam uma única geração de plugin Pantheon. A seleção remove referências Pantheon da outra configuração e não mistura `plugin` V1 com `plugins` V2. |
| TUI | `pantheon-tui` é componente separado, registrado em `tui.json` somente quando `plugins` é instalado. Native tasks exigem origem, relação parent/child e status fornecidos explicitamente pelo host; ausência de Markdown não é autodetecção. |
| Histórico e recuperação | `.pantheon/delegations/` é o canal histórico de relatórios V1. A compaction carry-forward existe no caminho V1 comprovado; jobs V1 antigos/running não são auto-retomados após restart e são marcados como erro. |
| Code-mode | Execução de scripts é opt-in via `manifest.json` com SHA-256 por script; resolução project-first (`PANTHEON_PROJECT` → cwd) com fail-closed após seleção; `doctor` valida o manifest sem regenerá-lo. |

### Limites que não são promessa de roadmap

- `plugin-v2` não é um adapter de paridade do runtime V1 e não adiciona hooks
  Pantheon, delegate tools, Board ou auto-resume.
- `auto` não é autodetecção geral de plataforma/runtime; só usa os hints
  explícitos documentados em [UPGRADING.md](docs/UPGRADING.md).
- A classificação de um native task e qualquer continuidade após restart só
  podem ser ampliadas depois de um contrato do host ser demonstrado e testado.

---

## 🔭 Próxima iteração

_Zerada em 2026-09-12. Nenhum item pendente; o próximo plano será escrito
depois do release estável 1.5.0._

---

## Histórico

- **Plano v1.0-dev** (memory commands, context compression, MCP servers,
  Themis review gate, routing): entregue entre v3.15.0 e v3.19.0.
- **Plano v1.0** (sprints 1–6): superseded by v1.5.0. Sprint 1 e 4 (parcial)
  e 7 entregues (commit `084a5a5`); sprints nunca implementados (S2/S3/S5/S6)
  foram removidos do plano ativo.
- **Plano v1.0+** (sprints 7–13): superseded by v1.5.0. Sprints nunca
  implementados (S8–S13) foram removidos do plano ativo — capacidades
  equivalentes que já existem (model routing por tier, redaction gate,
  cost tracking) fazem parte do contrato atual, não de plano futuro.
- Pendências herdadas dos sprints antigos (TODO Enforcer, hash-anchored
  edits, auth interceptor, full-auto) foram descartadas do plano ativo;
  podem voltar em uma próxima iteração se o contrato do host permitir.

| Data | Mudança |
|------|---------|
| 2026-09-12 | **Roadmap zerado.** Plano ativo sem itens pendentes; sprints não implementados (S2/S3/S5/S6/S8–S13) removidos; contrato atual atualizado com code-mode (B3-08). |
| 2026-08-10 | **Sprint 4 (parcial) + Sprint 7 entregues.** 3-tool API de delegação (pantheon_delegate/read/list) sobre BackgroundJobBoard; notificação via session.idle + chat.message flush (spike provou noReply indisponível); timeout 15min + output parcial persistido; enforcement read-only (edit/write/bash/task negados, apollo/gaia); compaction carry-forward; pruning TTL 24h. Commit 084a5a5. TODO Enforcer/full-auto/hash-anchored/auth-interceptor pendentes. |
| 2026-07-24 v6 | **Cleanup:** removidas referências a concorrentes, tabela competitiva removida. Sprints reorganizados: S6 (YAGNI) reconhecido como já planejado, S4 full-auto = modo autônomo, S5 decay já existe. Novos sprints (S7-S13) são expansões do que já existe, não features do zero. |
| 2026-07-24 v5 | Corrigido para v1.0. Revisão Themis aplicada. |
| 2026-07-24 v4 | Pesquisa comunitária. 6 novos sprints. |
| 2026-07-22 v3 | OpenCode v1.18 insights |
| 2026-07-22 v2 | Roadmap reescrito |
| 2026-06-20 | Última v3.14.0 |
