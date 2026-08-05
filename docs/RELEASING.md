# Pantheon Release Process

> How versioning, releases, and packaging work.

---

## Versioning Policy

Pantheon follows **Semantic Versioning** based on [Conventional Commits](https://www.conventionalcommits.org/):

| Commit pattern | Version bump |
|---|---|
| `BREAKING CHANGE` or `type!:` in scope | **MAJOR** (x.0.0) |
| `feat:` | **MINOR** (x.y.0) |
| `fix:`, `chore:`, `docs:`, `refactor:`, etc. | **PATCH** (x.y.z) |

Current version: **v1.2.2**

---

## Version Commands

```bash
# Show current version, latest stable git tag, and pending release status
node scripts/versioning.mjs status

# Sync all manifests + promote [Unreleased] → [vX.Y.Z] (recommended bump)
node scripts/versioning.mjs apply          # type auto (from commits)
node scripts/versioning.mjs apply minor    # explicit type: patch | minor | major

# CI-side consistency check (run in the version-check workflow job)
node scripts/version-check.mjs

# Dry-run of the release payload (status + pack)
npm run release:dry-run
```

`apply` syncs all version manifests (`package.json`, `plugin.json`,
`pyproject.toml`, `src/plugins/tui/package.json`) and promotes the
`[Unreleased]` changelog section to a versioned entry. **It no longer creates
git tags** — tags are workflow-owned (see below).

---

## Version Bump (the only manual step)

1. Create a branch off `main`.
2. Bump the version:
   ```bash
   node scripts/versioning.mjs apply minor   # or patch/major
   ```
   or edit `package.json` directly — the version is the release signal.
3. Fill in the promoted changelog section with the release notes for the
   upcoming version. The release body is **extracted from this section**, so
   it must exist and be accurate.
4. Commit + push + open a PR to `main`:
   ```bash
   git add -A && git commit -m "chore(release): vX.Y.Z"
   git push -u origin <branch>
   ```
5. Wait for CI. The PR must pass `version-check` (package.json must be
   **ahead** of the latest stable tag; pre-releases excluded) plus the other
   required checks before merging.

> No tag is created locally and no release is created at merge time by a
> separate workflow — everything downstream happens in `release.yml` on the
> merge commit.

---

## Stable Release (merge to `main`)

Merging the version-bump PR to `main` triggers
[`.github/workflows/release.yml`](../.github/workflows/release.yml) on
`push: main` (ignores `github-actions[bot]` pushes):

1. **Type**: channel=`stable`, npm dist-tag=`latest`.
2. **Version gate** — package.json must be a clean `X.Y.Z` and not strictly
   behind the latest stable git tag (exact `vX.Y.Z` tags only; `-beta.*`
   pre-release tags are excluded from the comparison). Fails loudly if the
   version was never bumped.
3. **Pack and verify** — `npm pack --dry-run` sanity check.
4. **Idempotent guard** — if tag `vX.Y.Z` exists AND its GitHub Release
   exists, exit 0 (already released). If the tag exists but the release is
   missing, continue and complete the release (tag creation is skipped).
5. **Release body** — `node scripts/changelog-extract.mjs X.Y.Z` extracts the
   `## [X.Y.Z] - date` section from `CHANGELOG.md` into
   `.github/release-notes.md`; fails if the section is missing.
6. **Tag creation (workflow-owned)** — an annotated tag
   `git tag -a vX.Y.Z -m "chore(release): vX.Y.Z"` is created **on the exact
   merge commit** (`github.sha`) and pushed.
7. **GitHub Release** —
   `gh release create vX.Y.Z --target <merge-sha> --verify-tag --title "Pantheon vX.Y.Z" --notes-file .github/release-notes.md`.
8. **npm publish (LAST)** — gated by `npm_check` (version already on npm
   `latest`? skip) then
   `npm publish --tag latest --access public --provenance`.

A global concurrency group (`release`, no cancel-in-progress) serializes
runs so beta and stable paths can never double-publish.

---

## Beta Releases (PR labeled `release:beta`)

Labeling a PR with `release:beta` triggers `release.yml` on
`pull_request: labeled` — **no workflow_dispatch inputs, no default PR
number** (the old fake `pr_number=9` hack is gone; the real
`github.event.number` is used):

1. Type: channel=`beta`, npm dist-tag=`beta`.
2. **Version gate** — the base package.json version must be **strictly**
   ahead of the latest stable tag.
3. **Beta version** — `<base>-beta.<PR>.<short-sha>` (e.g. `1.2.2-beta.12.abc1234`),
   applied with `npm version --no-git-tag-version`.
4. Tag is created on the **PR head**, the GitHub Release is created with
   `--prerelease` and titled `Pantheon <ver> (PR #<n>)`.
5. `npm publish --tag beta`, then a comment is posted on the PR:
   ```
   📦 Beta <ver> published.
   npm install pantheon-opencode@<ver>
   npm install pantheon-opencode@beta
   ```

---

## Recovery / Failure Handling

The pipeline is designed so **reruns are safe**:

- **Already fully released** → the idempotent guard exits 0; nothing is
  re-tagged, re-released, or re-published.
- **Crash between tag push and release create** → tag exists but release is
  missing; a rerun skips tag creation and completes the release.
- **Crash after npm publish** → a rerun hits the idempotent guard (exit 0),
  and `npm_check` blocks a republish even if the guard is bypassed.
- **changelog-extract fails** → the `[X.Y.Z]` section is missing from
  `CHANGELOG.md`; add it in the bump PR and rerun.

State snapshots from the standardization audit live in
`.pantheon/release-audit-2026-08-05/` (`tags-before.txt`,
`releases-before.txt`, `npm-versions-before.json`, `changelog-before.md`) —
use them to verify the expected pre-run state before a manual rerun.

---

## npm Policy

**Deprecate, never unpublish.** A published package version is permanent —
removing it breaks downstream installs and the `npm_check` idempotency gate.
To retire a broken version:

```bash
npm deprecate pantheon-opencode@<ver> "reason: <why it should not be used>"
```

---

## Branch Protection (main)

> **Status: ACTIVE as of Phase 5 (release-standardization).** `main` requires
> a PR review plus 5 passing checks. Enabling required checks on an existing
> `main` is effectively a one-way door — verify the pre-flight checklist
> before applying changes.

### Protection

- `required_pull_request_reviews[required_approving_review_count]=1`
- 5 required status checks: **`version-check`**, **`validate`**,
  **`commitlint`**, **`security-scan`**, **`CodeQL`**
- `enforce_admins=false` initially (owner/admin bypass for release unblock)

### Enable / verify

```bash
gh api -X PUT repos/ils15/pantheon-opencode/branches/main/protection \
  -F required_status_checks[strict]=true \
  -f 'required_status_checks[checks][][context]=version-check' \
  -f 'required_status_checks[checks][][context]=validate' \
  -f 'required_status_checks[checks][][context]=commitlint' \
  -f 'required_status_checks[checks][][context]=security-scan' \
  -f 'required_status_checks[checks][][context]=CodeQL' \
  -F 'required_pull_request_reviews[required_approving_review_count]=1' \
  -F enforce_admins=false
```

> GitHub reports checks by **job name** (or the name set by the action).
> The contexts above map to: `validate` + `version-check` (jobs in
> `.github/workflows/ci.yml`), `commitlint` (job in
> `commit-lint.yml`), `security-scan` (job in `security-scan.yml`), and
> `CodeQL` (analysis reported by `github/codeql-action` in `codeql.yml`).
> Verify the exact reported names before enforcing:

```bash
gh api repos/ils15/pantheon-opencode/commits/HEAD/check-runs \
  --jq '.check_runs[].name' | sort -u
```

### MANDATORY pre-flight checklist

If a required check never passes, **every** push to `main` is locked out,
including the release pipeline. Confirm ALL of the following before the PUT:

- [ ] **(a)** All 5 checks exist as workflow jobs: `ci.yml`
      (`validate`, `version-check`), `commit-lint.yml` (`commitlint`),
      `security-scan.yml` (`security-scan`), `codeql.yml` (`analyze`/CodeQL).
- [ ] **(b)** They all PASS on current `main` (or a PR). If any fails, fix
      the workflow first — never enable protection on a failing check.
- [ ] **(c)** ONLY then apply the PUT. After the fact, verify with:
      ```bash
      gh api repos/ils15/pantheon-opencode/branches/main/protection
      ```

### Admin bypass

- **Initial:** `enforce_admins=false` — repo owner can push past failing
  checks to unblock the release pipeline.
- **After 2 stable releases:** remove the bypass:
  ```bash
  gh api -X PATCH repos/ils15/pantheon-opencode/branches/main/protection \
    -F enforce_admins=true
  ```

### Grandfather policy

Commitlint is enforced **from this point forward** on all new commits (local
`.husky/commit-msg` hook + CI `commitlint` job). **All commits before
2026-08 are grandfathered** — they are never rewritten or retroactively
linted. Known example in current history:

- `release: v1.2.1 (#13)` — type `release` is not a conventional type

`git log -15 --format=%s | npx --no commitlint` will list such commits as
violations; that output is expected and accepted. New commits must follow
Conventional Commits (see `commitlint.config.js`).

---

## Pre-Release Checklist

Before cutting a release, verify:

- [ ] `node scripts/versioning.mjs status` shows a pending release
      (`tag < pkg`)
- [ ] `CHANGELOG.md` has a `## [X.Y.Z] - date` entry for the new version
- [ ] Version manifests match: `package.json` == `plugin.json` ==
      `pyproject.toml` == `src/plugins/tui/package.json`
- [ ] All required checks green on the bump PR (`version-check`, `validate`,
      `commitlint`, `security-scan`, `CodeQL`)
- [ ] `npm run release:dry-run` passes (status + pack)

---

## Consumption Options

| Method | Best for | How |
|---|---|---|
| **npm package** | Dev workflow / CI | `npm install pantheon-opencode` (stable) or `npm install pantheon-opencode@beta` |
| **Pantheon Installer** | New / existing projects | `npx pantheon-opencode init` |
| **GitHub Release** | Downloads / CI | Source archives from [Releases page](https://github.com/ils15/pantheon-opencode/releases) |
| **GitHub Template** | New projects | "Use this template" on GitHub |
| **Git clone + copy** | Selective setup | `git clone` and copy only what you need |

---

## Release Assets

Each release includes:

| Asset | Description |
|---|---|
| `Source code (zip)` | GitHub auto-generated |
| `Source code (tar.gz)` | GitHub auto-generated |
| `pantheon-opencode@<ver>` on npm | Published with `latest` (stable) or `beta` dist-tag, provenance-signed |
