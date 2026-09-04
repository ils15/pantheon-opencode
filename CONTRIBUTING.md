# Contributing to Pantheon

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

## Git Flow

```
feature/* ──PR──→ develop (staging)
                      │
                      ▼  release PR
                     main
                      │
                      ▼  explicit workflow dispatch
              GitHub Release + npm publish
```

### Rules
1. **Features** → branch `feature/*` → PR **para `develop`**
2. **Integração** → PRs de `develop` para `main` apenas com bump de versão
3. **Releases** → publicadas somente pelo workflow `Release`, acionado manualmente
   após o merge na `main`
4. **Branches** — apenas `main` e `develop` são mantidas. Feature branches são deletadas após merge

O fluxo beta é separado: um PR com o label exatamente `release:beta` aciona o
workflow `Release` e publica com a dist-tag `beta`; pushes comuns não o acionam.
Consulte [docs/RELEASING.md](docs/RELEASING.md) para recuperação e validações.

### Branch Protection
- `main`: requer PR + CI passando
- `develop`: requer PR + CI passando

### Versionamento
- `package.json`, `package-lock.json`, `plugin.json`, `pyproject.toml` e
  `src/plugins/tui/package.json` — sempre sincronizados; valide com
  `npm run version:check`
- CHANGELOG.md segue formato `## [vX.Y.Z]`
- Release gate valida consistência antes do merge

### Releases
- Toda feature mergeada em `develop` aparece na próxima release
- Quando `develop` estiver pronto, bump de versão + PR para `main`
- Após o merge, execute manualmente o workflow `Release` em GitHub Actions;
  um push comum na `main` não publica uma release
