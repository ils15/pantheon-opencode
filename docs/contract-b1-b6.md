# 📜 Contrato B1–B6 — congelado (W1)

| Campo | Valor |
|---|---|
| **Status** | FROZEN (`congela-pos-T1`) |
| **Fonte** | ADR-0012 D1 — proposta oficial Athena (ADR permanece **Proposed**) |
| **Origem nominal** | lista nomeada SOL **ausente** no repositório (Apollo: originais inexistentes) → adotada a proposta Athena |
| **Máquina** | `benchmarks/beta2/fixtures/contract-b1-b6.json` (`pantheon.contract.b1-b6.v1`) |
| **Baseline** | `benchmarks/beta2/baseline-t1.json` / `benchmarks/beta2/baseline-t1.md` |
| **Harness** | `benchmarks/beta2/t1.py` |
| **Data** | 2026-10-08 |

> A lista nominal B1–B6 do plano SOL não foi localizada no repositório (blocker
> explícito do plano Athena GLM-max). Conforme a lane W1, o contrato congelado usa
> a **proposta Athena (ADR-0012 D1)** como conteúdo canônico. O ADR-0012 permanece
> **Proposed** — a promoção a Accepted depende do gate @themis + aprovação humana,
> nunca de edição silenciosa.

## Blocos nominais B1–B6

| Bloco | Nome | Escopo | Fontes canônicas |
|---|---|---|---|
| **B1** | Canonical agents contract | Campos required/optional de `agents/*.agent.md` | `src/agents/*.md` |
| **B2** | Routing contract | `routing.yml` como single source of truth | `src/routing.yml` |
| **B3** | Permission shape contract | Formato canônico de permissões (`permission.task` + `read_only_agents` + schema) | `src/routing.yml`, `pantheon.schema.json` |
| **B4** | Skills/commands metadata contract | Metadados de skills (`SKILL.md`) e commands | `src/skills/*/SKILL.md`, `commands/*.md` |
| **B5** | Version contract | SemVer 1.x, `package.json` SSOT (cf. ADR-0007) | `package.json`, `plugin.json`, `pyproject.toml` |
| **B6** | Quality gates contract | `planeja → implementa → checa → aprova → PR`; @themis audita cada gate | `AGENTS.md`, `src/instructions/*.instructions.md` |

## Thresholds (congelam pós-T1)

| Métrica | Tolerância | Direção de regressão |
|---|---:|---|
| Tokens | **20%** | head > base |
| Latência | **10%** | head > base |
| Qualidade | **5pp** | head < base (queda em pontos percentuais) |

Nenhuma alteração de threshold entra após o marco T1 sem ADR que supersede o ADR-0012.

## SemVer

- Série **1.6 = dual** (legado + nativo coexistem; cf. ADR-0011). Default permanece
  legado em 1.5.x; flip de default só em 1.6+ e apenas cumpridos os D5 do ADR-0011.

## Exclusões explícitas do baseline

- **Sem moeda** (nenhum campo de custo/currency).
- **Sem JEVS** (métrica JEVS não é coletada nem reportada).

O guard `contains_excluded_metrics` rejeita qualquer relatório que vaze `currency` ou `JEVS`.

## Baseline T1 (offline static)

- Snapshots: base `850191c` → head `dc9018d` · 5 repetições · ordem alternada.
- Relatórios versionados: `benchmarks/beta2/baseline-t1.json` e `baseline-t1.md`.
- **Gate de comparação inelegível** (`eligible: false`): o baseline offline mede o
  **tamanho das fontes canônicas** (`estimate_tokens`), não o uso real do modelo.
- **B6 −31% tokens = encolhimento de fonte, não economia de modelo.** O selective
  lean merge (`dc9018d`) estreitou `AGENTS.md` / `src/instructions/*.md`; a queda é do
  tamanho da fonte, **não** do consumo do modelo. B1–B5 ficam *within*.
- **Bloqueio live documentado:** medição live de tokens/latência/tools por modelo
  exige provider (`*_API_KEY` ausente no ambiente) — rodar
  `python -m benchmarks.beta2.t1 --mode live --binary <opencode> --model <id>` quando
  houver credencial.
