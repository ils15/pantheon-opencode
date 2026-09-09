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

Operational version in this checkout: **v1.5.0-beta.2**. The published
**v1.4.3** reference below is historical Zenodo material only; it is not the
current release version or a release target.

---

## Version Commands

```bash
# Show current version, latest stable git tag, and pending release status
node scripts/versioning.mjs status

# Sync all manifests + promote [Unreleased] → [vX.Y.Z] (recommended bump)
node scripts/versioning.mjs apply          # type auto (from commits)
node scripts/versioning.mjs apply minor    # explicit type: patch | minor | major
node scripts/versioning.mjs apply --notes  # pre-fill the promoted entry with
                                           # release notes generated from commits

# Generate release notes from conventional commits (lastTag..HEAD)
node scripts/release-notes.mjs             # stable vX.Y.Z tags only
node scripts/release-notes.mjs --draft     # last 30 commits, no tag lookup

# CI-side consistency check (run in the version-check workflow job)
node scripts/version-check.mjs

# Dry-run of the release payload (status + release notes + pack)
npm run release:dry-run
```

`apply` syncs the version manifests (`package.json`, `plugin.json`,
`pyproject.toml`, `src/plugins/tui/package.json`) and promotes the
`[Unreleased]` changelog section to a versioned entry. Release validation also
keeps the root pair (`package.json` + `package-lock.json`) and the TUI pair
(`src/plugins/tui/package.json` + `src/plugins/tui/package-lock.json`) in the
same versioned inventory. **It no longer creates git tags** — tags are
workflow-owned (see below).

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
4. Commit + push + open a PR to `main`. Stage only these intentional release
   files; do not include untracked RED tests, generated artifacts, or any
   other paths:

   ```bash
   git add CHANGELOG.md docs/RELEASING.md package.json package-lock.json \
     plugin.json pyproject.toml src/plugins/tui/package.json \
     src/plugins/tui/package-lock.json
   git diff --cached --check
   git diff --cached --name-only
   git commit -m "chore(release): vX.Y.Z"
   git push -u origin <branch>
   ```

5. Wait for CI. The PR must pass `version-check` (package.json must be
   **ahead** of the latest stable tag; pre-releases excluded) plus the other
   required checks before merging.

> No tag is created locally. Merging an ordinary PR does **not** release. To
> publish a stable version, use the explicit `Release` workflow dispatch after
> the intended commit is on `main`; it validates manifests and preserves the
> exact target-SHA/idempotency checks.

---

## Release Notes

Release notes are **generated from conventional commits**, never written
from scratch. Commitlint (12 types / 40 scopes) validates every commit
before it merges, so the generator can always group the history.

### Type → section mapping

Release notes use the final emoji group format — **🆕 What's New /
🐞 Fixed / ⚠️ Known Issues / ✅ Closed Issues**:

| Commit type | Release notes section |
|---|---|
| `feat`, `perf`, `docs` | `## 🆕 What's New` (docs are user-facing — no dedicated group) |
| `fix`, `security` | `## 🐞 Fixed` |
| `--known-issues "text"` (CLI flag, repeatable) | `## ⚠️ Known Issues` (omitted when the flag is absent — never emitted empty) |
| `Closes #N` / `Fixes #N` / `Resolves #N` in the commit **body** | `## ✅ Closed Issues` — bullet `- #N - <subject>` (deduped; omitted when no refs exist) |
| `chore`, `refactor`, `test`, `ci`, `build`, `style`, `revert` (and unknown types) | **omitted** — internal, never user-facing |
| `BREAKING CHANGE` footer or `type!:` / `type(scope)!:` | `💥` prefix on the bullet **inside** What's New (e.g. `- 💥 **scope** — subject`) — no dedicated Breaking group |

Merge commits ("Merge …") and empty-subject chores are skipped. Bullets use
`- **<scope>** — <subject>` (the scope as the bold prefix; without a scope
the whole subject is bolded). Section order is What's New → Fixed → Known
Issues → Closed Issues.

### Generate the notes

```bash
# Commits since the latest stable tag (strict vX.Y.Z, pre-releases excluded)
node scripts/release-notes.mjs

# Same output without reading git tags (last 30 commits) — quick preview or
# pre-first-tag use
node scripts/release-notes.mjs --draft

# Add a manual Known Issues entry (repeatable; omitted from output when absent)
node scripts/release-notes.mjs --known-issues "widget API is unstable"

# Pre-merge review: version status + generated notes + pack dry-run
npm run release:dry-run
```

The script exits 0 whenever it can generate. stdout is markdown ready to
paste into the `[Unreleased]` CHANGELOG section (diagnostics go to stderr).

### Flow

1. **Commit** — Conventional Commits enforced by commitlint (local hook + CI).
2. **Generate** — `node scripts/release-notes.mjs` → paste the output into the
   `[Unreleased]` section, or let `apply --notes` do it automatically.
3. **CHANGELOG** — `node scripts/versioning.mjs apply minor [--notes]` bumps
   the manifests and promotes `[Unreleased]` → `[vX.Y.Z]`. With `--notes` the
   promoted entry is pre-filled from the grouped commits (mapped to the final
   emoji groups `## 🆕 What's New / 🐞 Fixed / ⚠️ Known Issues /
   ✅ Closed Issues`); without it the flow stays manual. `--notes`
   **replaces** any manual `[Unreleased]` content — review the diff before
   committing.
4. **Extract** — `release.yml` runs `node scripts/changelog-extract.mjs X.Y.Z`
   to pull the versioned section into the GitHub Release body.
5. **Publish** — the workflow tags the exact dispatch target SHA and publishes
   to npm (stable or beta per the `release_channel` input).

---

## Stable Release (manual dispatch)

Dispatching [`.github/workflows/release.yml`](../.github/workflows/release.yml)
without recovery inputs runs the stable release path:

1. **Type**: channel=`stable`, npm dist-tag=`latest`.
2. **Version gate** — package.json must be a clean `X.Y.Z` and not strictly
   behind the latest stable git tag (exact `vX.Y.Z` tags only; `-beta.*`
   pre-release tags are excluded from the comparison). Fails loudly if the
   version was never bumped.
3. **Pack and verify** — the validation job packs exactly one immutable npm
   tarball with lifecycle scripts disabled. It records that tarball's
   SHA-256 together with the full `TARGET_SHA`; the release job recomputes the
   digest and rejects any mismatch.
4. **Idempotent guard** — if tag `vX.Y.Z` exists AND its GitHub Release
   exists, exit 0 (already released). If the tag exists but the release is
   missing, continue and complete the release (tag creation is skipped).
5. **Release body** — `node scripts/changelog-extract.mjs X.Y.Z` extracts the
   `## [X.Y.Z] - date` section from `CHANGELOG.md` into
   `.github/release-notes.md`; fails if the section is missing.
6. **Tag creation (workflow-owned)** — a tag ref is created through the
   repository-scoped GitHub API **on the exact dispatch target SHA**.
7. **GitHub Release** —
   `gh release create vX.Y.Z --target <dispatch-sha> --verify-tag --title "Pantheon vX.Y.Z" --notes-file release-artifact/release-notes.md`.
8. **npm publish (LAST)** — gated by the idempotency lookup, then that same
   tarball (without repacking) is published with `--tag latest --access public
   --provenance`. The SHA-256 validated in the validation job is therefore the
   SHA-256 of the file published to npm.

A global concurrency group (`release`, no cancel-in-progress) serializes
runs so beta and stable paths can never double-publish.

---

## Package and evidence contract

The release evidence is fail-closed and has one artifact identity:

- root dependencies use `npm ci --ignore-scripts` with `package.json` and
  `package-lock.json`;
- the TUI is checked independently with
  `npm ci --prefix src/plugins/tui --ignore-scripts` and its own manifest and
  lockfile;
- a release creates one npm `.tgz` tarball, computes one SHA-256, and carries
  that exact file and digest from validation to publication; a second `npm
  pack` is not a valid replacement;
- the tarball and GitHub tag/release are bound to the same full `TARGET_SHA`.

Any `npm ci` failure blocks the run. There is no `npm install` fallback, and
`PANTHEON_ALLOW_NPM_INSTALL_FALLBACK` is not part of the current contract.

### Intentional MCP source divergence

`scripts/memory_mcp_server.py` and `src/mcp/memory_mcp_server.py` are
intentionally divergent. The standalone `scripts/` copy preserves the
lightweight `memory_*` server contract; the installed `src/mcp/` copy also
loads the optional codemap schema and exposes `code_index`, `code_query`, and
`code_neighbors`. The other shared MCP copies remain byte-identical. The
separate behavior and required markers are tested by
`tests/test_mcp_scripts_sync.py`; do not resolve this pair by copying one file
over the other.

---

## Beta Releases (explicit dispatch with `release_channel=beta`)

Publication is authorized **only** by an explicit `workflow_dispatch` of
`release.yml`. PR labels, pushes, merges, and tags never trigger or authorize a
release. Dispatching with `release_channel=beta` runs the beta path; a beta
recovery is triggered only by a dispatch with all three recovery inputs; a
dispatch without recovery inputs and `release_channel=stable` (the default) is
the stable path.

1. Type: channel=`beta`, npm dist-tag=`beta`.
2. **Published stable lookup** — the workflow queries npm `dist-tags.latest` at
   release time; git tags and the branch's package version are not used as the
   beta base.
3. **Beta version** — the next semver patch of npm latest by default,
   `<next-stable>-beta.<RUN>.<short-sha>` (e.g. `1.3.5-beta.412.abc1234`), where
   `<RUN>` is `GITHUB_RUN_NUMBER`. The
   short SHA is exactly the first seven lowercase hexadecimal characters of
   the full commit SHA (`sha.slice(0, 7)`), matching `release-beta-version.mjs`.
   Recovery dispatches fail closed unless the version PR and seven-character
   suffix both match `recovery_pr_number` and `recovery_target_sha`.
   All manifests are rewritten to the calculated
   version and `version-check` blocks publishing if they diverge.
4. Tag is created on the **dispatch target SHA**, and the GitHub Release is
   created with
   `--prerelease`, title `Pantheon <ver>`, and the generated release notes.
5. `npm publish --tag beta` publishes the immutable artifact. The workflow does
   not create a PR comment.

---

## Recovery / Failure Handling

### Beta npm-publish recovery (explicit dispatch)

If a beta's GitHub tag and Release already exist but npm publishing failed,
rerun `Release` with **all three** recovery inputs: `recovery_version`
(`X.Y.Z-beta.PR.SHA`, without `v`), `recovery_target_sha` (the full 40-hex
commit SHA), and `recovery_pr_number`. The workflow checks these values before
checkout, checks that the remote `v<version>` tag and existing GitHub Release
match exactly, and never creates or moves a tag/release in this mode. It packs
the immutable checkout and publishes only when that exact npm version is
absent; an existing npm version is a successful no-op. Partial or invalid
inputs, missing releases, API errors, and tag mismatches fail closed.

The recovery path is beta-only and does not calculate a new version or change
the normal stable dispatch and beta-channel dispatch paths.

The pipeline is designed so **reruns are safe**:

- **Already fully released** → the idempotent guard exits 0; nothing is
  re-tagged, re-released, or re-published.
- **Crash between tag push and release create** → tag exists but release is
  missing; a rerun skips tag creation and completes the release.
- **Crash after npm publish** → a rerun hits the idempotent guard (exit 0),
  and the npm existence check prevents publishing the same version again.
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

## Preserved Releases: Zenodo

[Zenodo](https://zenodo.org/) preserves releases for citation and long-term access. A published GitHub release automatically triggers **Publish release to Zenodo**; the workflow checks out the exact commit identified by the tag, creates or resumes the deposition idempotently, and does not create duplicates.

For a manual run, open **Actions → Publish release to Zenodo** and set `release_tag=v1.4.3`, `confirm_production=true`, and `publish_deposition=false` to create or resume a draft. Review the draft before running again with `publish_deposition=true`; use that value only after human approval.

The protected `zenodo-production` environment must contain secret `ZENODO_TOKEN` and vars `ZENODO_DEPOSITIONS_URL`, `ZENODO_FILES_URL_TEMPLATE`, `ZENODO_PUBLISH_URL_TEMPLATE`, and `ZENODO_CREATOR_NAME`. Never put token values in logs or code. Use sandbox configuration for rehearsal and production only for the reviewed deposition.

The workflow validates metadata, the release archive, and its SHA-256 checksum; after publication it persists the DOI in the GitHub release notes. Post-execution checklist: metadata correct; version **1.4.3**; license **MIT**; `pantheon-opencode-1.4.3.zip`/archive present; SHA-256 matches; state **Published**; DOI present in the Zenodo record and release notes.

Verify the record and DOI on Zenodo and via the DOI link; **v1.4.3** DOI: [10.5281/zenodo.22306637](https://doi.org/10.5281/zenodo.22306637).
