# Branch Protection: `main`

> **Why this matters:** Branch protection prevents force-pushes, requires passing
> CI checks before merge, enforces linear history, and ensures no one (not even
> admins) can bypass the pipeline. Without it, the agent orchestration pipeline
> (Iris → Themis → merge) is just a suggestion, not a guarantee.

---

## Enable Protection via GitHub UI

1. Go to your repo on github.com → **Settings** → **Branches** (sidebar).
2. Click **Add branch protection rule** (or **Add rule**).
3. In **Branch name pattern**, enter: `main`
4. Enable the following checkboxes:

### ✅ Required Settings

| Setting | Checkbox label | Why |
|---|---|---|
| ✅ | **Require a pull request before merging** | All changes go through a PR reviewed by Themis/Iris |
| ✅ | **Require approvals** — set to `1` | At least one reviewer must approve |
| ✅ | **Dismiss stale pull request approvals when new commits are pushed** | Re-review after changes |
| ✅ | **Require status checks to pass before merging** | Block merge if CI fails |
| ✅ | **Require branches to be up to date** | Prevents merge skew |

### 🔍 Required Status Checks

Add these exact check names (they match real workflow jobs; GitHub reports the
job id when a job has no `name:` override):

- `validate`
- `test-suite`
- `plugin-v2-ts-coverage`
- `commitlint`
- `security-scan`
- `CodeQL`

> **`version-check` is not a check.** That job was folded into `validate`.
> There is no `PR Checks` workflow in this repository; do not add
> `PR Checks / label-by-title` or `PR Checks / recommend-version`.
>
> **Applying protection is a manual maintainer action.** No workflow changes
> branch protection and an agent must not do it.

> **Tip:** Type each name in the search box and select it. GitHub will auto-suggest
> matching check names once the workflow has run at least once on `main`.

### 🔒 Additional Protections

| Setting | Checkbox label | Value |
|---|---|---|
| ✅ | **Require linear history** | — (on) — Prevents merge commits, keeps history clean |
| ✅ | **Include administrators** | — (on) — Even admins must follow the rules |
| ❌ | **Allow force pushes** | — (off) — Never allow force pushes |
| ❌ | **Allow deletions** | — (off) — Never allow branch deletion |

### 🚀 Apply Rule

Click **Create** (or **Save changes**).

---

## Alternative: `gh` CLI

If you prefer the command line, use the GitHub CLI to apply the same settings:

```bash
gh api repos/:owner/:repo/branches/main/protection \
  --method PUT \
  --field required_status_checks='{
    "strict": true,
    "checks": [
      {"context": "validate"},
      {"context": "test-suite"},
      {"context": "plugin-v2-ts-coverage"},
      {"context": "commitlint"},
      {"context": "security-scan"},
      {"context": "CodeQL"}
    ]
  }' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  }' \
  --field required_linear_history=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false
```

> **Note:** Replace `:owner` with your GitHub username or org (`ils15`) and
> `:repo` with `pantheon-opencode`. You need `admin` or `write` permissions on
> the repo to run this command. Run it only after every required check has
> passed on `main`; see the pre-flight checklist below.

### MANDATORY pre-flight checklist

If a required check never passes, every push to `main` is locked out, including
the release pipeline. Confirm all of the following before the `PUT`:

- [ ] **(a)** All six checks exist as workflow jobs: `validate`, `test-suite`,
      and `plugin-v2-ts-coverage` in `ci.yml`; `commitlint` in
      `commit-lint.yml`; `security-scan` in `security-scan.yml`; and CodeQL
      analysis in `codeql.yml`.
- [ ] **(b)** They all pass on current `main` (or a PR), including the push run
      on `main`. If any fails, fix the workflow first — never enable protection
      on a failing check.
- [ ] **(c)** Only then apply the `PUT`, and verify with
      `gh api repos/ils15/pantheon-opencode/branches/main/protection`.

### Admin bypass

The command above sets `enforce_admins=true`. If the repository owner needs an
escape hatch to unblock the release pipeline, set it to `false` initially and
restore it after two stable releases:

```bash
gh api -X PATCH repos/ils15/pantheon-opencode/branches/main/protection \
  -F enforce_admins=true
```

### Grandfather policy

Commitlint is enforced from this point forward on all new commits (local
`.husky/commit-msg` hook plus the CI `commitlint` job). Commits before
2026-08 are grandfathered; they are never rewritten or retroactively linted.
`git log -15 --format=%s | npx --no commitlint` will list them as violations;
that output is expected. New commits must follow Conventional Commits.

---

## Verification

After enabling protection, verify it's active:

```bash
gh api repos/ils15/pantheon-opencode/branches/main/protection --jq '.required_status_checks.checks[].context'
```

Expected output:
```json
[
  "validate",
  "test-suite",
  "plugin-v2-ts-coverage",
  "commitlint",
  "security-scan",
  "CodeQL"
]
```

You can also check the GitHub UI: **Settings → Branches → `main` rule** shows
a green "Protection enabled" badge.

---

## How This Enforces the Agent Pipeline

```
                              ┌─────────────────────────────┐
                              │  User pushes to feature/    │
                              │  branch                     │
                              └──────────┬──────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────────────┐
                              │  Iris opens Draft PR        │
                              │  → validate, test-suite,    │
                              │    plugin-v2-ts-coverage,   │
                              │    commitlint, security-scan│
                              │  → CodeQL analysis          │
                              └──────────┬──────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────────────┐
                              │  All status checks pass?    │
                              │  ─── NO ───→ Fix & re-push  │
                              │  ─── YES ───↓               │
                              └──────────┬──────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────────────┐
                              │  Themis reviews & approves  │
                              └──────────┬──────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────────────┐
                              │  User says "merge"          │
                              │  → Iris merges (squash)     │
                              │  → Linear history preserved │
                              └─────────────────────────────┘
```

Without branch protection, any of these steps can be skipped by a force-push
or a direct commit to `main`. Enable it once and never worry about it again.
