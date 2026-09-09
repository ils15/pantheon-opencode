# Release Process

## Version Scheme

| Release | Formato | Exemplo |
|---------|---------|---------|
| Beta | `X.Y.Z-beta.<PR>.<SHA>` | `1.2.0-beta.6.a1b2c3d` |
| Stable | `X.Y.Z` | `1.2.0` |

O beta usa o PR number + SHA curto pra garantir unicidade.
Semver: `1.2.0-beta.6.a1b2c3d` < `1.2.0` (beta é menor que a release).

## Canais de Release

| Canal | Formato | Exemplo | Como publicar |
|-------|---------|---------|---------------|
| Beta | `X.Y.Z-beta.<RUN>.<SHA>` | `1.2.0-beta.642.a1b2c3d` | `workflow_dispatch` com `release_channel=beta` |
| Stable | `X.Y.Z` | `1.2.0` | `workflow_dispatch` com `release_channel=stable` (default) |

O beta usa o run number do workflow + SHA curto pra garantir unicidade.
Semver: `1.2.0-beta.642.a1b2c3d` < `1.2.0` (beta é menor que a release).

## Fluxos

Toda publicação é autorizada **somente** por um `workflow_dispatch` explícito.
Labels de PR, push, merge e tag **não** disparam nenhum fluxo de release.

### Beta Release (dispatch explícito)

1. No GitHub Actions, execute manualmente `Release` (`workflow_dispatch`) com
   `release_channel=beta` na revisão desejada:
   - Consulta o stable publicado em npm e gera `<next-stable>-beta.<RUN>.<SHA>`
   - Publica no npm com tag `beta`
   - Cria GitHub Pre-release com título `Pantheon <versão>`
2. Instalar: `npm install pantheon-opencode@beta`

### Stable Release (dispatch explícito)

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

## Fail-closed

Nenhum caminho de release tem fallback. Validação que não termina em PASS
explícito bloqueia a publicação; WARN, SKIP, AMBIENTAL e NOT_TESTED nunca
autorizam release evidence. Ausência de credencial, metadado ou tag é erro
fatal, não degradação silenciosa.

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

Depois (set/2026 — fail-closed):
- `release.yml`: beta e stable somente por `workflow_dispatch` explícito
  (`release_channel` escolhe o canal; nenhum label de PR publica)
- Sem commits de bump automáticos no develop
- Toda validação é PASS-only: status não-PASS bloqueia, nunca degrada
