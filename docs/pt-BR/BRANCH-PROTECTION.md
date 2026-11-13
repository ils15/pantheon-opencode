# Proteção da Branch `main`

> 🇺🇸 **English version available:** [Read in English](../BRANCH-PROTECTION.md)

> **Por que isso é essencial:** A proteção de branches impede force-pushes acidentais, exige aprovação em todos os testes e linters da CI antes do merge, impõe histórico linear limpo e assegura que ninguém (nem mesmo administradores) consiga burlar a esteira de qualidade do repositório.

---

## Configuração de Proteção no GitHub

1. Acesse o repositório em github.com → **Settings** → **Branches** (barra lateral).
2. Clique em **Add branch protection rule** (ou **Add rule**).
3. No campo **Branch name pattern**, digite: `main`
4. Habilite as seguintes configurações recomendadas:

### ✅ Regras Obrigatórias

| Configuração | Descrição | Motivo |
|---|---|---|
| ✅ | **Require a pull request before merging** | Toda e qualquer alteração entra via PR |
| ✅ | **Require approvals** — definido como `1` | Exige revisão antes do merge |
| ✅ | **Dismiss stale pull request approvals when new commits are pushed** | Exige nova validação caso novos commits sejam enviados |
| ✅ | **Require status checks to pass before merging** | Bloqueia o merge se qualquer teste de CI falhar |
| ✅ | **Require branches to be up to date** | Impede desvios e conflitos com a ponta do `main` |

### 🔍 Status Checks Obrigatórios da CI

Adicione exatamente os seguintes nomes de checks que rodam nas esteiras do GitHub Actions:

- `validate`
- `test-suite`
- `plugin-ts-coverage`
- `commitlint`
- `security-scan`
- `CodeQL`

### 🔒 Proteções Adicionais

| Configuração | Valor | Benefício |
|---|---|---|
| ✅ **Require linear history** | Ativado | Impede commits de merge espúrios, mantendo o histórico de commits linear |
| ✅ **Do not allow bypassing the above settings** | Ativado | Aplica as mesmas regras estritas até para administradores |
| ❌ **Allow force pushes** | Desativado | Jamais permitir sobrescrita de histórico com `git push --force` |
| ❌ **Allow deletions** | Desativado | Jamais permitir deleção acidental da branch `main` |

---

## Aplicação via GitHub CLI (`gh`)

Se preferir aplicar as regras via terminal com o GitHub CLI:

```bash
gh api repos/:owner/:repo/branches/main/protection \
  --method PUT \
  --header "Accept: application/vnd.github+json" \
  --input - << 'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "validate",
      "test-suite",
      "plugin-ts-coverage",
      "commitlint",
      "security-scan",
      "CodeQL"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true
}
EOF
```
