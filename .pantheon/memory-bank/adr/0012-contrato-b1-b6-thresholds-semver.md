# ADR-0012: Contrato B1–B6 + Thresholds + SemVer 1.6=dual (proposta oficial)

**Status:** Proposed
**Date:** 2026-10-08
**Author:** @mnemosyne (doc-only, por delegação)

## Context

Wave0 exige contrato canônico congelado antes de qualquer hardening (TASK-003).
Descoberta Apollo: **os documentos originais do contrato B1–B6 não existem no
repositório** — nenhum registro canônico de B1–B6 foi localizado. Este ADR
estabelece B1–B6 como **proposta oficial**; a lane W1 valida o conteúdo e congela.

## Decision

### D1 — B1–B6 como proposta oficial (conteúdo validado e congelado em W1)

| Bloco | Escopo proposto |
|---|---|
| **B1** | Canonical agents contract — campos required/optional de `agents/*.agent.md` |
| **B2** | Routing contract — `routing.yml` como single source of truth |
| **B3** | Permission shape contract — formato canônico de permissões |
| **B4** | Skills/commands metadata contract — metadados de skills e commands |
| **B5** | Version contract — semver 1.x, package.json SSOT (cf. ADR-0007) |
| **B6** | Quality gates contract — `planeja → implementa → checa → aprova → PR`, @themis audita cada gate |

### D2 — Thresholds 20/10/5pp congelam pós-T1

- Os thresholds **20 / 10 / 5pp** (tolerâncias de gate) ficam **congelados após T1**:
  nenhuma alteração de threshold entra após o marco T1 sem ADR que supersede este.
- Valores de referência e medição do baseline são entregues pela lane W1 (Phase 3).

### D3 — Cláusula SemVer: 1.6 = dual

- A série **1.6** é declarada **dual** (legado + nativo coexistem; cf. ADR-0011):
  default permanece legado em 1.5.x; flip de default só em 1.6+ e apenas cumpridos
  os pré-requisitos D5 do ADR-0011.
- Proibido flip de default sem ADR que supersede ADR-0011 + este ADR.

## Consequences

### Positive

- Contrato explícito e versionado elimina "flexibilidade" não documentada (lição TASK-021).
- Freeze pós-T1 dá estabilidade aos gates das lanes W1/W2+.

### Negative

- B1–B6 nascem como proposta — conteúdo canônico real só existe após W1.
- Cláusula dual estende o custo de manutenção dupla até 1.6 (já aceito em ADR-0011).

## Risks & Rollback

- **Risco:** W1 divergir da proposta → mitigação: divergência exige supersede deste ADR, nunca edição silenciosa.
- **Rollback:** status retorna a "inexistente"; lanes pausam até novo Proposed.

## References

- TASK-003 (Wave 0 — Canonical Contract & Baseline), TASK-022 (estado Wave0)
- ADR-0007 (semver 1.x SSOT), ADR-0011 (delegation dual, D5)
- Lanes: `wave0-W1-validate-contrato-baseline/`, `wave0-W2plus-f4-mcp-skills-unificacao/`
