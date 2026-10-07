# Release Process

## Versão operacional e esquema de versão

Os manifests deste checkout expressam a versão candidata, não confirmam uma
publicação. Uma versão beta só é publicada depois que o workflow Release
termina com sucesso. Para saber qual versão está realmente publicada,
consulte a dist-tag `beta` do npm. A referência
publicada **v1.4.3** é somente histórica e pertence a uma **família Zenodo
anterior** (pré-1.6.x): seu registro é a **version** DOI
[10.5281/zenodo.22306637](https://doi.org/10.5281/zenodo.22306637). As versões
atuais (**1.6.x**) usam a família **ativa**, cujo **concept** DOI é
[10.5281/zenodo.22650136](https://doi.org/10.5281/zenodo.22650136)
(`conceptrecid 22650136`), que sempre resolve para a última versão arquivada.
A integração Zenodo↔GitHub arquiva **toda** GitHub Release (sem filtro de
pre-release); como apenas o canal stable cria Release, apenas versões stable
entram na família Zenodo. O v1.4.3 não é a versão operacional atual nem um
alvo de release.

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
| Beta | `X.Y.Z-beta.N` | `vX.Y.Z-beta.N` | `Release validation` + aprovação do digest + `Release` (`beta`) |
| Stable | `X.Y.Z` | `vX.Y.Z` | `Release validation` + aprovação do digest + `Release` (`stable`) |

## Fluxos

Toda publicação usa dois fluxos manuais, ambos limitados em runtime à `main`,
ao ator e triggering actor `ils15` e à primeira tentativa:

1. Execute `Release validation` com o SHA completo do commit desejado, alcançável
   pela `main`. O fluxo empacota uma vez e gera artefatos imutáveis de pacote e
   proveniência; o resumo mostra versão, IDs e SHA-256.
2. Revise o resumo e aprove explicitamente o digest exato na conversa. Só então
   despache `Release` com os mesmos IDs do run/artefatos, SHA e digest aprovados.
   Um verificador sem credenciais valida o run, a proveniência e os bytes; o job
   de publicação aguarda a aprovação do ambiente `beta-release`, baixa os mesmos
   artefatos por ID e verifica o digest novamente. Não há novo empacotamento.

Stable cria tag e GitHub Release e publica com dist-tag `latest`. Beta cria a tag
e publica com `beta`, sem GitHub Release. Recovery é somente para beta e exige
que a tag existente aponte para o mesmo SHA do artefato validado. A remoção de
dist-tag usa o mesmo gate de ambiente e recusa `latest` e `beta`.

**Pré-requisito operacional: antes de despachar `Release` ou remoção de
dist-tag, configure manualmente `BETA_RELEASE_NPM_TOKEN` como secret do ambiente
GitHub `beta-release`, remova os secrets `NPM_TOKEN` dos escopos de repositório
e organização e confirme que não existe `BETA_RELEASE_NPM_TOKEN` nesses escopos.**
O workflow referencia somente o nome único do secret de ambiente; este repositório
não lê, migra nem remove credenciais. A validação pode rodar sem esse secret, mas
não autoriza publicação: não despache os fluxos `Release` ou remoção de dist-tag
até cumprir todos os pré-requisitos. O ambiente deve exigir revisão de `ils15`,
permitir auto-revisão e restringir deployments à `main`; configure-o
separadamente.

Consulte [docs/RELEASING.md](RELEASING.md) para o procedimento e os detalhes do
contrato de proveniência. Merge de PR, validação bem-sucedida ou tag não publica
por si só; cada etapa é uma ação separada com aprovação humana.

## Notas de release por canal

O corpo (release notes) de cada publicação vem da seção versionada do
`CHANGELOG.md`, extraída por `scripts/changelog-extract.mjs`. O dispatch falha se
a seção não existir.

| Canal | Fonte das notas |
|-------|-----------------|
| Stable | Seção curada `## [X.Y.Z]` do `CHANGELOG.md`. Falha se ausente. |
| Beta | Seção curada `## [X.Y.Z-beta.N]` do `CHANGELOG.md`. Falha se ausente. |
| Recuperação | Notas já incluídas no artefato imutável validado; não há novo empacotamento. |

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
- O manifesto vincula SHA de origem, versão, IDs do workflow/run/artefato e
  digest; a tag e o GitHub Release ficam vinculados ao mesmo SHA completo.

Falha em qualquer `npm ci` bloqueia a execução. A variável
`PANTHEON_ALLOW_NPM_INSTALL_FALLBACK` não é suportada.

## Divergência intencional do memory MCP

`scripts/memory_mcp.py` e `src/mcp/memory_mcp.py` são
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
| `latest` | `<stable-version>` | `<vX.Y.Z>` | `<GitHub Release>` (arquivada no Zenodo) |
| `beta` | `<beta-version>` | `vX.Y.Z-beta.N` | — (beta não cria Release; não arquivada no Zenodo) |

## Histórico

Antes (removido em jul/2026):
- `release.yml`: publicava beta em todo push pro develop
- Gerava versões `X.Y.Z-beta.N` sequenciais
- Commit spammado `chore(release):` a cada push

Depois (set/2026 — fail-closed):
- `release-validation.yml` cria artefato imutável; `release.yml` verifica e
  publica apenas após digest aprovado e ambiente protegido
- Sem commits de bump automáticos no develop
- Toda validação é PASS-only: status não-PASS bloqueia, nunca degrada
