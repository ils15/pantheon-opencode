# ADR-0007: Padronização de Release (semver 1.x + Single Source of Truth)

**Status:** Accepted
**Date:** 2026-08-05
**Approval:** Deepwork release-standardization (2026-08-05) — decisões aprovadas, registradas neste ADR.
**Sources:** @apollo (descoberta), @athena (plano), @themis (auditoria de risco), @hermes/@prometheus/@iris (execução por fase)

## Context

A página de releases do GitHub estava quebrada e inconsistente com o estado real do npm:

- **Sintomas:** bodies de release exibindo o cabeçalho "5.0.0"; tags beta falsas ("-beta.9.<sha>"); release v1.2.1 sem tag git correspondente; versões divergentes entre 5 manifestos; clusters de tags com mesmo SHA; RELEASING.md documentando workflows fantasmas.
- **Fato crítico:** o npm é imutável (>72h). dist-tags atuais: `latest=1.2.1`, `beta=1.2.0-beta.9.7bef03e`. O GitHub deve se alinhar AO npm, nunca o contrário. Git tags já seguem v1.x; package.json = 1.2.1.

**Oito causas-raiz (Apollo, 2026-08-05):**

1. `release.yml:105` — `gh release create --notes-file CHANGELOG.md` cru → todo release body mostra o cabeçalho "5.0.0".
2. `workflow_dispatch` input `pr_number` com default `'9'` → tags falsas `-beta.9.<sha>`.
3. `versioning.mjs apply` caminho "already ahead" pula a criação de tag → release v1.2.1 sem tag git.
4. 5 fontes de versão divergentes: package.json 1.2.1, pyproject.toml 1.1.0, plugin.json 1.1.0, tui pkg 1.2.0, CHANGELOG.md 5.0.0.
5. 3 formatos de changelog no mesmo arquivo + blocos `[Unreleased]` vazios promovidos mecanicamente.
6. Clusters de tags com mesmo SHA: v1.1.1-beta.0..18 @748018d; v1.1.3-beta.0 @85827d1 no mesmo commit que v1.1.1.
7. Sem version gate / tag-exists guard.
8. docs/RELEASING.md documenta workflows fantasmas (auto-release.yml, release-gate.yml, release-drafter.yml).

## Decision

Aprovadas as decisões do deepwork release-standardization (2026-08-05):

### D1 — Versão canônica: semver 1.x, package.json como SINGLE SOURCE OF TRUTH
- npm dist-tags são imutáveis (`latest=1.2.1`, `beta=1.2.0-beta.9.7bef03e`); git tags já são v1.x; package.json = 1.2.1.
- Todos os demais manifestos (pyproject.toml, plugin.json, src/plugins/tui/package.json, cabeçalhos do CHANGELOG.md) DEVEM coincidir, com enforcement via version-check no CI.

### D2 — CHANGELOG: entrada "5.0.0" renumerada → 1.0.0
- Conteúdo preservado (descreve a reescrita OpenCode-only v1.0; o link de compare quebrado v4.0.0...v1.0.0 prova o mapeamento).
- Nota de arqueologia adicionada; entradas 3.19.x permanecem como registro histórico da era multi-plataforma.
- Nunca existiu release/tag/pacote npm 5.0.0.

### D3 — Convenção de pré-release: `<base>-beta.<PR>.<short-sha>`, SOMENTE de eventos PR reais
- Criado apenas em `pull_request` com label `release:beta`.
- Removido o input `workflow_dispatch.pr_number` (default '9') — origem das tags falsas `-beta.9.<sha>`.
- `workflow_dispatch` = estável somente, com version gate.

### D4 — Tags criadas APENAS pelo workflow de release, no commit exato do merge em main, APÓS gates
- `versioning.mjs apply` deixa de criar tags git (elimina as causas-raiz de tags com SHA duplicado e do v1.2.1 sem tag).
- Sem reescrita de histórico; a tag v1.2.1 retroativa apontará para o gitHead do npm `757d668e7f2f8d5e7ec98a85fff8bea43c95d0f9`.

### D5 — Body do release = seção extraída do changelog correspondente à versão
- Nunca o arquivo CHANGELOG.md cru (changelog-extract.mjs na Fase 2).

### D6 — Tooling de changelog: changelogen adotado (pinned), git-cliff rejeitado
- git-cliff rejeitado (cliff.toml era config morta); opção manual rejeitada.
- Implementação DEFERIDA até após 2 releases estáveis (YAGNI) — a extração de seção da Fase 2 funciona sem gerador.

### D7 — Política npm: deprecate, nunca unpublish
- Ranges de pré-release ruidosos recebem `npm deprecate`; o estado do npm é a referência imutável; o GitHub se alinha a ele.

### D8 — Commitlint local (prepare:husky) + CI em PRs E pushes diretos em main; branch protection
- Branch protection em main (exigir PR + status checks) aplicado via `gh api`, com validação pré-voo de que as checks existem/passam (mitigação de lockout apontada pela auditoria do Themis).

## Consequences

### Positive
- Fonte única de verdade de versão → fim da divergência entre 5 manifestos.
- Releases page consistente: body == seção do changelog, bijetividade tag↔release, zero clusters de SHA duplicados.
- Betas rastreáveis a PRs reais; workflow idempotente; nenhuma tag criada fora do workflow.
- npm imutável respeitado (deprecate, nunca unpublish); GitHub alinhado ao npm.
- Commitlint + branch protection fecham o caminho de pushes diretos desprotegidos em main.

### Negative
- Renumeração histórica do CHANGELOG ("5.0.0"→"1.0.0") pode confundir leitores antigos sem a nota de arqueologia.
- Tag retroativa v1.2.1 criada sem reescrita de histórico — irreconciliável com qualquer outra tag no mesmo commit.
- Fase 3 (cleanup) exige dry-run e aprovação humana por cluster — custo operacional e atraso.
- Pré-release via PR com label adiciona cerimônia (label + PR real) ao fluxo beta.
- changelogen só entra após 2 releases estáveis — janela em que a geração segue por extração manual de seção.

## Risks & Rollback

- **Snapshots pré-mutação** em `.pantheon/release-audit-2026-08-05/`: changelog-before.md, npm-githead-1.2.1.txt, npm-versions-before.json, releases-before.txt, tags-before.txt.
- **Dry-run obrigatório** para operações destrutivas da Fase 3 (deleção de tags/releases).
- **Aprovação humana por cluster de deleção** (clusters A–E).
- **Proibições:** NUNCA unpublish; NUNCA reescrever histórico.
- **Rollback:** restaurar estado a partir dos snapshots; `npm deprecate` é reversível; deleções exigem snapshot + aprovação.

## Acceptance Criteria (resumo)

1. `version:check` exit 0 (todas as fontes == package.json)
2. Body do release == seção do changelog da versão
3. Bijetividade tag ↔ release
4. Zero clusters de SHA duplicados
5. Tag v1.2.1 existente e anotada (apontando 757d668e…)
6. Workflow idempotente (re-run seguro)
7. Nenhuma tag criada fora do workflow
8. Betas apenas de PRs reais
9. Commitlint ativo local + CI
10. Branch protection documentado
11. RELEASING.md corresponde à realidade (sem workflows fantasmas)
12. Hack TUI "5.0.0" removido (src/plugins/tui/src/index.tsx:195)

## References

- Apollo report (memória): `release-infra-apollo-report-2026-08-05`
- Plano deepwork (memória): `deepwork-release-standardization-plan-2026-08-05`
- Snapshots: `.pantheon/release-audit-2026-08-05/`
- Fase de origem: Phase 0 (baseline + ADR + reparo do changelog)
