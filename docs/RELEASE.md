# Release Process

## Versão operacional e esquema de versão

Este checkout usa **v1.5.0-beta.2** como versão operacional local. Este texto
não afirma que uma beta futura foi publicada; use os placeholders
`vX.Y.Z` e `vX.Y.Z-beta.<RUN>.<SHORT_SHA>` ao descrever releases futuras. A
referência publicada **v1.4.3** é somente histórica e corresponde ao registro
no [Zenodo](https://doi.org/10.5281/zenodo.22306637); ela não é a versão
operacional atual nem um alvo de release.

| Release | Formato | Exemplo |
|---------|---------|---------|
| Beta | `X.Y.Z-beta.<RUN>.<SHORT_SHA>` | `vX.Y.Z-beta.<RUN>.<SHORT_SHA>` |
| Stable | `X.Y.Z` | `vX.Y.Z` |

O beta usa o run number do workflow + SHA curto para garantir unicidade.
Semver: `X.Y.Z-beta.<RUN>.<SHORT_SHA>` < `X.Y.Z` (beta é menor que a release).

## Canais de Release

| Canal | Formato | Exemplo | Como publicar |
|-------|---------|---------|---------------|
| Beta | `X.Y.Z-beta.<RUN>.<SHORT_SHA>` | `vX.Y.Z-beta.<RUN>.<SHORT_SHA>` | `workflow_dispatch` com `release_channel=beta` |
| Stable | `X.Y.Z` | `vX.Y.Z` | `workflow_dispatch` com `release_channel=stable` (default) |

O beta usa o run number do workflow + SHA curto para garantir unicidade.
Semver: `X.Y.Z-beta.<RUN>.<SHORT_SHA>` < `X.Y.Z` (beta é menor que a release).

## Fluxos

Toda publicação é autorizada **somente** por um `workflow_dispatch` explícito.
Labels de PR, push, merge e tag **não** disparam nenhum fluxo de release.

### Beta Release (dispatch explícito)

1. No GitHub Actions, execute manualmente `Release` (`workflow_dispatch`) com
   `release_channel=beta` na revisão desejada:
   - Consulta o stable publicado em npm e gera `<next-stable>-beta.<RUN>.<SHORT_SHA>`
   - Publica no npm com tag `beta`
   - Cria GitHub Pre-release com título `Pantheon <versão>`
2. Instalar: `npm install pantheon-opencode@beta`

### Stable Release (dispatch explícito)

1. Merge o PR de release na `main` com mensagem `chore(release): vX.Y.Z`.
2. No GitHub Actions, execute manualmente `Release` (`workflow_dispatch`) na
   revisão desejada. Um push comum na `main` não inicia uma release.
3. O workflow valida os manifests e locks do root (`package.json` +
   `package-lock.json`) e do TUI (`src/plugins/tui/package.json` +
   `src/plugins/tui/package-lock.json`) com `npm ci --ignore-scripts`, sem
   fallback para `npm install`, e valida o SHA exato antes de:
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

## Evidência do artefato

- Cada release cria exatamente um tarball `.tgz` do npm.
- O SHA-256 é calculado para esse mesmo arquivo e o digest acompanha o tarball
  da validação até a publicação; não há um segundo `npm pack` para substituir o
  artefato validado.
- O tarball, a tag e o GitHub Release ficam vinculados ao mesmo `TARGET_SHA`
  completo.

Falha em qualquer `npm ci` bloqueia a execução. A variável
`PANTHEON_ALLOW_NPM_INSTALL_FALLBACK` não é suportada.

## Divergência intencional do memory MCP

`scripts/memory_mcp_server.py` e `src/mcp/memory_mcp_server.py` são
intencionalmente diferentes. A cópia em `scripts/` mantém o contrato leve de
`memory_*`; a cópia instalada em `src/mcp/` também expõe o schema opcional de
codemap e as ferramentas `code_index`, `code_query` e `code_neighbors`. As
outras cópias compartilhadas permanecem idênticas; não sobrescreva uma cópia
com a outra.

O gate em sandbox valida somente o sandbox preparado e isolado. Um resultado
PASS não prova suporte para todo host real ou para combinações de ambiente que
não foram exercitadas.

## Placeholders para referências futuras

| Tag npm | Versão | Git Tag | GitHub Release |
|---------|--------|---------|----------------|
| `latest` | `<stable-version>` | `<vX.Y.Z>` | `<GitHub Release>` |
| `beta` | `<beta-version>` | `vX.Y.Z-beta.<RUN>.<SHORT_SHA>` | `<GitHub Pre-release>` |

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
