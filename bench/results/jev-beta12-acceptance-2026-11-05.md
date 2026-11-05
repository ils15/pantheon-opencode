# Jev beta.12 corrections — field acceptance record (2026-11-05)

Base: the field report against **1.6.3-beta.11** (five defects, all with
located root causes). Fixes on `fix/jev-beta12`; installed build during these
probes: the fix-branch pack (version string `1.6.3-beta.11` — the bump
happens on the release line). Gate chain untouched; all live calls
reconciled (`frozen:false`, ~$0.00002/call).

## Acceptance results (live, operator-run)

### Defect 1 — delegation dropped agent descriptions
Five-state probe, preset `delegation`:

| state | pick | verdict |
|---|---|---|
| "endpoint FastAPI com paginacao e testes" | **hermes** | was `none 0.89` |
| "acessibilidade e responsividade React WCAG" | **aphrodite** | was `none 0.67` |
| "migracao Alembic, indice composto, N+1" | **demeter** | was `none 0.77` |
| "auditar seguranca e cobertura antes do release" | **themis** | ✓ |
| "escrever um poema sobre o mar" (control) | **none** | correctly refuses |

**5/5 exact — the worst error class (high-confidence wrong `none`) is gone.**
`none` now carries a description; the catalog's nyx entry was also synced to
the post-reform chaos/adversarial identity.

### Defect 2 — skills candidate-source instrumentation
`candidateSource: "prefilter" | "full-catalog" | "host-skills"` now rides on
the skills-mode result. Live: the audit state matched the prefilter and the
result carried `candidateSource:"prefilter"` with an honest low-confidence
`none` (0.08). The caller can now distinguish "no such skill" from "the
prefilter failed".

### Defect 3 — envelope now enforced on EVERY path
The single gate (`checkJevEnvelope`) runs in the tool before any builder:

| payload | result |
|---|---|
| `{mode:"delegation", state:"x"}` (no schemaVersion) | `PRESET_INVALID` + `SCHEMA_VERSION_INVALID` |
| `{schemaVersion:99, ...}` | `PRESET_INVALID` + `SCHEMA_VERSION_INVALID` |
| `{..., bogus:true}` | `PRESET_INVALID` + `UNKNOWN_INPUT_KEYS` |

Zero host calls for all three (ledger untouched). The beta.10 CHANGELOG
claim is now true for explicit questions, presets, review, rank, and verify.

### Defect 4 — rank cap 8→20
- 16 candidates: **accepted and decided** (winner + fit, reconciled).
- 21 candidates: `CANDIDATE_INVALID` with `detail:"RANK_CANDIDATE_COUNT_RANGE"`
  — the caller learns the accepted range instead of a bare token.
- Schema `maxItems` and the tool description now say 2-20 (mirrors the
  typesafe_rank reference contract).

### Defect 5 — local router
- **D1 (gateStatus inert)**: fixed — `review_required`/`human_approval_required`
  now abstain with reason `GATE_OPEN`; the advisory never routes around an
  open gate. Offline-tested.
- **D2 (artifact-management unreachable)**: already resolved before this
  branch by the material-requirement machinery in
  `local-decision-skills.ts` (probes predate it): "breaking change with
  human approval and a rollback plan across phases" →
  `[artifact-management]` via `SELECTED_BY_MATERIAL_REQUIREMENT`.
- D3/D4 (hermes/medium empty result; dimension polarity) remain open —
  smallest impact, next round.

## Test deltas
`jev-decisions` (descriptions/none/candidateSource/envelope), `jev-rank-verify`
(cap 20, detail token, tolerant tool-level refusals), `local-decision-router`
(GATE_OPEN) — all green; `test:ts` 5/5; lint 0; drift 0.
