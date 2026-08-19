# Release Process

## Version Scheme

| Release | Formato | Exemplo |
|---------|---------|---------|
| Beta | `X.Y.Z-beta.<PR>.<SHA>` | `1.2.0-beta.6.a1b2c3d` |
| Stable | `X.Y.Z` | `1.2.0` |

O beta usa o PR number + SHA curto pra garantir unicidade.
Semver: `1.2.0-beta.6.a1b2c3d` < `1.2.0` (beta é menor que a release).

## Labels do GitHub

| Label | Efeito |
|-------|--------|
| `release:beta` | Publica beta no npm + GitHub Pre-release (next patch from npm `latest`) |

## Fluxos

### Beta Release (de um PR aberto)

1. Adicionar a label `release:beta` a um PR aberto
2. O workflow `release.yml` dispara no evento `pull_request: labeled`:
   - Consulta o stable publicado em npm e gera `<next-stable>-beta.<PR>.<SHA>`
   - Publica no npm com tag `beta`
   - Cria GitHub Pre-release com título `Pantheon <versão>`
3. Instalar: `npm install pantheon-opencode@beta`

O único label que dispara o beta é exatamente `release:beta`. Intenções de
próximo `minor` ou `major` não são labels; quando aplicável, são informadas
pelos inputs/lógica do workflow.

Não há republish automático em push. Um beta só é disparado pelo evento de label
exatamente `release:beta`; a recuperação exige um `workflow_dispatch` explícito
com os três inputs de recuperação. O workflow não cria comentários no PR.

### Stable Release (explicit dispatch)

1. Merge o PR de release na `main` com mensagem `chore(release): vX.Y.Z`.
2. No GitHub Actions, execute manualmente `Release` (`workflow_dispatch`) na
   revisão desejada. Um push comum na `main` não inicia uma release.
3. O workflow valida manifests e o SHA exato antes de:
   - Publicar no npm com tag `latest`
   - Criar GitHub Release

### Recuperação de beta já criado

Quando a tag e o GitHub Release já existem, mas o `npm publish` falhou, execute
`Release` manualmente informando juntos `recovery_version` (sem `v`),
`recovery_target_sha` (SHA completo de 40 hex) e `recovery_pr_number`. O modo
valida os três campos antes do checkout, exige a tag e o Release existentes
exatos, não cria nem move recursos no GitHub e publica somente se a versão
exata ainda não estiver no npm. Versões parciais, inválidas, releases ausentes
ou erros de API abortam sem mutação; se a versão já existir, a execução é
idempotente.

## Versões Publicadas Atualmente

| Tag npm | Versão | Git Tag | GitHub Release |
|---------|--------|---------|----------------|
| `latest` | 1.1.1 | `v1.1.1` | ✅ Pantheon v1.1.1 |
| `beta` | 1.1.3-beta.0 | `v1.1.3-beta.0` | ✅ Pantheon v1.1.3-beta.0 |

## Histórico

Antes (removido em jul/2026):
- `release.yml`: publicava beta em todo push pro develop
- Gerava versões `X.Y.Z-beta.N` sequenciais
- Commit spammado `chore(release):` a cada push

Agora:
- `release.yml`: label `release:beta` no PR → beta calculado do npm `latest`
- `release.yml`: stable somente por `workflow_dispatch`
- Sem commits de bump automáticos no develop
