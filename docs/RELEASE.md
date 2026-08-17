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
| `release:beta:minor` / `release:beta:major` | Beta usando o próximo minor/major publicado |

## Fluxos

### Beta Release (de um PR aberto)

1. PR aberto (develop → main)
2. Adicionar label `release:beta` no PR
3. Workflow `release.yml` dispara:
   - Consulta o stable publicado em npm e gera `next-stable-beta.<PR>.<SHA>`
   - Publica no npm com tag `beta`
   - Cria GitHub Pre-release
   - Comenta no PR com link de instalação
4. Instalar: `npm install pantheon-opencode@beta`

Re-publish automático: se label já está no PR e novo commit é pushado, o workflow re-publica com novo SHA.

### Stable Release (explicit dispatch)

1. Merge o PR de release na `main` com mensagem `chore(release): vX.Y.Z`.
2. No GitHub Actions, execute manualmente `Release` (`workflow_dispatch`) na
   revisão desejada. Um push comum na `main` não inicia uma release.
3. O workflow valida manifests e o SHA exato antes de:
   - Publicar no npm com tag `latest`
   - Criar GitHub Release

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
