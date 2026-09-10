# Release Process

## Versão operacional e esquema de versão

Este checkout usa **v1.5.0-beta.2** como versão operacional local. Este texto
não afirma que uma beta futura foi publicada; use os placeholders
`vX.Y.Z` e `vX.Y.Z-beta.N` ao descrever releases futuras. A referência
publicada **v1.4.3** é somente histórica e corresponde ao registro no
[Zenodo](https://doi.org/10.5281/zenodo.22306637); ela não é a versão
operacional atual nem um alvo de release.

| Release | Formato | Exemplo |
|---------|---------|---------|
| Beta | `X.Y.Z-beta.N` | `vX.Y.Z-beta.N` |
| Stable | `X.Y.Z` | `vX.Y.Z` |

A versão é **sempre a versão commitada** em `package.json` (e espelhada nos
demais manifests). Nada é calculado no runtime do workflow. O beta avança a
linha sequencial `-beta.N`; semver: `X.Y.Z-beta.N` < `X.Y.Z`.

## Canais de Release

| Canal | Formato | Exemplo | Como publicar |
|-------|---------|---------|---------------|
| Beta | `X.Y.Z-beta.N` | `vX.Y.Z-beta.N` | `workflow_dispatch` com `release_channel=beta` |
| Stable | `X.Y.Z` | `vX.Y.Z` | `workflow_dispatch` com `release_channel=stable` (default) |

## Fluxos

Toda publicação é autorizada **somente** por um `workflow_dispatch` explícito.
Labels de PR, push, merge e tag **não** disparam nenhum fluxo de release.

### Beta Release (dispatch explícito)

1. Na branch de release, avance a versão beta commitada:
   ```bash
   node scripts/versioning.mjs apply --beta   # ou: node scripts/versioning.mjs beta
   ```
   O comando escreve `X.Y.Z-beta.(N+1)` (ou `X.Y.(Z+1)-beta.1` se a versão
   atual for stable) em todos os manifests e promove o `[Unreleased]` do
   `CHANGELOG.md` para `## [vX.Y.Z-beta.N]`, exatamente como o caminho stable.
   Não edite o `CHANGELOG.md` manualmente.
2. Commit e push do inventário de versão + `CHANGELOG.md`.
3. No GitHub Actions, execute manualmente `Release` (`workflow_dispatch`) com
   `release_channel=beta` na revisão desejada. O workflow lê a versão
   commitada, exige `X.Y.Z-beta.N`, extrai as notas da seção do `CHANGELOG.md`,
   cria a tag `vX.Y.Z-beta.N` e publica no npm com tag `beta`.
4. Instalar: `npm install pantheon-opencode@beta`

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
`Release` manualmente informando `recovery_version` (sem `v`) e
`recovery_target_sha` (SHA completo de 40 hex). Para a versão commitada
`X.Y.Z-beta.N` basta esse par; o `recovery_pr_number` é aceito apenas para
recuperar o formato legado `X.Y.Z-beta.<pr>.<7-char-sha>`, no qual os três
campos são obrigatórios. O modo valida os campos antes do checkout, exige a tag
e o Release existentes exatos, não cria nem move recursos no GitHub e publica
somente se a versão exata ainda não estiver no npm. Versões parciais, inválidas,
releases ausentes ou erros de API abortam sem mutação; se a versão já existir, a
execução é idempotente.

## Notas de release por canal

O corpo (release notes) de cada publicação vem da seção versionada do
`CHANGELOG.md`, extraída por `scripts/changelog-extract.mjs`. O dispatch falha se
a seção não existir.

| Canal | Fonte das notas |
|-------|-----------------|
| Stable | Seção curada `## [X.Y.Z]` do `CHANGELOG.md`. Falha se ausente. |
| Beta | Seção curada `## [X.Y.Z-beta.N]` do `CHANGELOG.md`. Falha se ausente. |
| Recuperação | Nota estática (`Recovery publish for existing GitHub Release ...`); as notas originais não são re-geradas. |

Adicionar a seção do `CHANGELOG.md` é obrigatório para os dois canais, inclusive
beta — assim o mesmo artefato commitado é a única fonte de verdade.

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
| `beta` | `<beta-version>` | `vX.Y.Z-beta.N` | `<GitHub Pre-release>` |

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
