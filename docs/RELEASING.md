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

Candidate version: the manifests in this checkout express the version being
prepared; they do not confirm a publication. A beta is published only after
the Release workflow completes successfully. To check which version is
actually published, consult the npm `beta` dist-tag.

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

# Advance the committed beta line (X.Y.Z-beta.N → X.Y.Z-beta.(N+1)) and
# promote [Unreleased] → [vX.Y.Z-beta.N], exactly like the stable path.
node scripts/versioning.mjs apply --beta
node scripts/versioning.mjs beta           # alias for apply --beta

# Generate release notes from conventional commits (lastTag..HEAD)
node scripts/release-notes.mjs             # stable vX.Y.Z tags only
node scripts/release-notes.mjs --draft     # last 30 commits, no tag lookup

# CI-side consistency check (run in the version-check workflow job)
node scripts/version-check.mjs

# Dry-run of the release payload (status + release notes + pack)
npm run release:dry-run
```

# beta.5: rebuild the TUI bundle AFTER the version bump — dist embeds the
# package version and the CI "TUI dist freshness" gate fails otherwise.
npm install --prefix src/plugins/tui && npm run build --prefix src/plugins/tui

`apply` syncs the version manifests (`package.json`, `plugin.json`,
`pyproject.toml`, `src/plugins/tui/package.json`) and promotes the
`[Unreleased]` changelog section to a versioned entry. `apply --beta` (alias
`beta`) does the same: it syncs the manifests to the next committed
`X.Y.Z-beta.N` **and** promotes `[Unreleased]` to `## [vX.Y.Z-beta.N]`. Do not
edit `CHANGELOG.md` by hand. Release validation also
keeps the root pair (`package.json` + `package-lock.json`) and the TUI pair
(`src/plugins/tui/package.json` + `src/plugins/tui/package-lock.json`) in the
same versioned inventory. The TUI is a root **workspace**, so CI installs both
with a single `npm ci --ignore-scripts` at the root; the nested TUI lock is
still versioned and still shipped because the user-facing postinstall syncs
against it. **It no longer creates git tags** — tags are
workflow-owned (see below).

---

## Version Bump (the only manual step)

1. Create a branch off `main`.
2. Bump the version:
   ```bash
   node scripts/versioning.mjs apply minor   # or patch/major
   ```
   or edit `package.json` directly — the version is the release signal.
   The TUI manifest (`src/plugins/tui/package.json`) carries the same version;
   `npm run version:check` fails when the two drift. `node_modules/` state is
   irrelevant here: the TUI is a root workspace, so one root `npm ci
   --ignore-scripts` installs it.
3. Fill in the promoted changelog section with the release notes for the
   upcoming version. The release body is **extracted from this section**, so
   it must exist and be accurate.
4. Commit + push + open a PR to `main`. Review the **complete** working-tree
   diff, then stage every intentional release change: all outputs produced by
   `versioning.mjs` and any release docs deliberately edited. The paths below
   are illustrative and incomplete; check the full diff rather than treating
   this list as exhaustive. In particular, **do not omit
   `src/plugins/tui/dist/tui.js`**: the bundle embeds the package version and
   CI checks TUI dist freshness. Leave unrelated changes and untracked RED
   tests out of the release commit.

   ```bash
   git status --short
   git diff
   git add CHANGELOG.md docs/RELEASING.md package.json package-lock.json \
     plugin.json pyproject.toml src/plugins/tui/package.json \
     src/plugins/tui/package-lock.json src/plugins/tui/dist/tui.js
   # Add any other intentional paths found while reviewing the complete diff.
   git diff --cached --check
   git diff --cached --name-only
   git diff --cached
   git commit -m "chore(release): vX.Y.Z"
   git push -u origin <branch>
   ```

5. Wait for CI. The PR must pass `version-check` (package.json must be
   **ahead** of the latest stable tag; pre-releases excluded) plus the other
   required checks before merging.

> No tag is created locally. Merging an ordinary PR does **not** release. To
> publish a stable version, first run `Release validation`, approve its exact
> digest, and then dispatch the separate `Release` workflow after the intended
> commit is on `main`. The workflows enforce the immutable artifact handoff.

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

### Release body by channel

Release validation extracts the curated version section from the source
commit's `CHANGELOG.md` and carries the resulting notes in the immutable package
artifact. Stable attaches those notes to its GitHub Release; beta creates no
GitHub Release. Recovery uses the notes already carried by the previously
validated artifact. Beta versions must be committed as `X.Y.Z-beta.N`; stable
versions use `X.Y.Z`.

### Release flow

1. Prepare and merge the version/changelog change through the normal reviewed
   PR process. A merge alone never publishes.
2. Dispatch [Release validation](../.github/workflows/release-validation.yml)
   from `main` as `ils15`, with the full source commit SHA. The workflow rejects
   off-main commits, reruns, malformed SHAs, and commits not reachable from
   current `origin/main`.
3. Inspect its run summary. Record the workflow ID, run ID, package artifact ID,
   provenance artifact ID, source SHA, package version, and tarball SHA-256.
   Explicitly approve that exact digest in the conversation before any phase-two
   dispatch. The validation workflow has no npm secret and performs no release
   mutation.
4. Dispatch [Release](../.github/workflows/release.yml) from `main` as `ils15`,
   supplying the exact validation run/artifact IDs, source SHA, and the approved
   digest. Choose `stable` or `beta`; recovery additionally supplies the exact
   existing beta `recovery_version`.
5. The read-only verifier confirms the successful first-attempt validation run,
   exact workflow path/ID, actor, main ref, artifact ownership, manifest,
   version, source SHA, and package digest. It reports all exact values in the
   run summary. The separate `publish` job then waits for `beta-release`
   environment approval, re-downloads the same immutable artifact IDs, and
   verifies the digest again before mutation.
6. Stable creates/verifies the immutable `vX.Y.Z` tag, creates the GitHub
   Release, and publishes the same `.tgz` with npm `latest`. Beta creates or
   verifies the `vX.Y.Z-beta.N` tag and publishes with npm `beta`; it does not
   create a GitHub Release because the Zenodo integration archives releases.
   Recovery is beta-only, requires the existing tag to point to the artifact's
   exact source SHA, does not move/create a tag, and publishes only the exact
   validated artifact if the version is not already on npm.

Every validation and release dispatch rejects `github.ref != refs/heads/main`,
any actor or triggering actor other than `ils15`, and `run_attempt != 1`. A
failed attempt must be replaced by a new, separately reviewed first-attempt run;
reruns are intentionally unavailable. The separate dist-tag-removal workflow
uses the same operator/ref/attempt policy, prints the target package/tag in a
preflight summary before its environment gate, and refuses the protected tags
`latest` and `beta`.

### Required GitHub environment and credential migration

Before dispatching `Release` or npm dist-tag removal, configure the
`beta-release` GitHub Environment
with required reviewer `ils15`, self-review allowed, and deployment branches
restricted to `main`. Manually add the npm credential as the unique
`BETA_RELEASE_NPM_TOKEN` **environment secret**. Remove repository- and
organization-level `NPM_TOKEN` secrets, and ensure no repository- or
organization-level `BETA_RELEASE_NPM_TOKEN` exists. The workflows reference
only `secrets.BETA_RELEASE_NPM_TOKEN` and do not inspect, read, migrate, or
remove any credential. Therefore the operator setup/removal is a hard
prerequisite: **do not manually dispatch Release or npm dist-tag removal until
it is complete**. Release validation has no npm token reference and may run
before this migration, but it never authorizes publication by itself.

### Package and provenance contract

- `release-validation.yml` checks out only the requested full source SHA after
  confirming it is reachable from current `origin/main`; dependencies install
  with `npm ci --ignore-scripts`.
- The package-evidence command runs once and produces exactly one npm `.tgz`.
  Its SHA-256 and source/version metadata are checked before upload.
- The package and provenance manifest are separate immutable Actions artifacts
  because the package artifact ID is only known after upload. The manifest binds
  source SHA, version, validation workflow ID/path, run ID, package artifact ID,
  tarball filename, and tarball digest. The workflow summary provides both
  artifact IDs.
- Phase two fetches the validation run and artifact list with read-only
  `actions:read`, requires the named artifacts to belong to that exact run and
  not be expired, then downloads by numeric artifact IDs (never by mutable
  artifact name or latest run).
- The protected job downloads those same IDs again and independently verifies
  the manifest, tarball bytes, npm package name/version, and approved digest.
  No checkout, install, package, or repack occurs after artifact handoff.
- Artifact retention is 90 days. An expired/missing artifact, unknown API
  response, malformed input, mismatched identity, or failed digest check blocks
  publication.

### Recovery and interruption handling

Recovery is no longer an alternate build or direct-publish route. It uses the
same verified phase-one artifact and phase-two gate as every other publication.
The requested `recovery_version` must be `X.Y.Z-beta.N`, match the package and
manifest version, and its existing `v<version>` tag must point at the artifact's
source commit. Missing/moved tags and any source/version/hash mismatch fail
closed. Reruns are rejected; if an operation fails, review the exact partial
state and start a new first-attempt dispatch with the same still-valid artifact
only after separately confirming it remains appropriate.

The workflow checks public npm metadata for an existing exact version before
publishing; an existing exact version is a no-op, while any lookup error other
than an explicit not-found fails closed. The environment secret is exposed only
to the single `npm publish` step and mapped to `NODE_AUTH_TOKEN` there. GitHub
write credentials are confined to the tag and GitHub Release mutation steps.

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

[Zenodo](https://zenodo.org/) preserves releases for citation and long-term
access through the **official Zenodo ↔ GitHub integration** on
[`ils15/pantheon-opencode`](https://github.com/ils15/pantheon-opencode). Each
published GitHub Release is archived automatically as a new version, giving that
release a **version DOI**; all versions share the stable **concept DOI**
[10.5281/zenodo.22650136](https://doi.org/10.5281/zenodo.22650136)
(`conceptrecid 22650136`), which always resolves to the latest archived release.

The integration has **no pre-release filter**: it archives *every* GitHub
Release. Only the stable channel creates a GitHub Release, so only stable
versions are archived. Beta releases create a git tag and publish to npm but no
Release, and are therefore intentionally absent from the Zenodo family.

[`.zenodo.json`](../.zenodo.json) is the source of the deposited metadata
(title, creators/ORCID, description, license, keywords, and related
identifiers). `scripts/versioning.mjs` bumps its `version`, `publication_date`,
and `url` alongside the other manifests on every release, so the file must stay
in sync for the next archive. The deposited `title` is read from `.zenodo.json`
at the tagged commit and is **not** applied retroactively to versions already
archived.

The integration is configured in Zenodo and runs on Zenodo's side — no
workflow, token, or protected environment is stored in this repository. If a
Release is not archived automatically, trigger a sync from the repository's
Zenodo GitHub settings, then verify the concept DOI, the per-release version
DOI, and the record metadata on Zenodo.
