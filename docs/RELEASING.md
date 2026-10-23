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

# Merge pending notes into an already-promoted candidate without a version bump
node scripts/versioning.mjs changelog 1.6.0-beta.10

# Generate release notes from conventional commits (lastTag..HEAD)
node scripts/release-notes.mjs             # stable vX.Y.Z tags only
node scripts/release-notes.mjs --draft     # last 30 commits, no tag lookup

# CI-side consistency check (run in the `validate` job of ci.yml)
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
edit `CHANGELOG.md` by hand. When the target version section already exists,
`versioning.mjs changelog <version>` merges `[Unreleased]` into that section
and resets the template without advancing the package version or duplicating
the release heading. Release validation also
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

5. Wait for CI. The PR must pass `validate` (version manifests, engine,
   packaging, sandbox), `test-suite`, `plugin-v2-ts-coverage`, `commitlint`,
   `security-scan`, and `CodeQL` before merging. `ci.yml` also runs on pushes
   to `main`, so the merged SHA carries its own CI evidence.

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

### Release body by channel

`release.yml` extracts the release body from the committed `CHANGELOG.md` for
both dispatch channels; only the stable channel attaches it to a GitHub Release:

| Channel | Notes source |
|---------|--------------|
| stable | `node scripts/changelog-extract.mjs X.Y.Z` reads the curated `## [X.Y.Z]` section from `CHANGELOG.md`; the dispatch fails if the section is missing. Used as the GitHub Release body. |
| beta | `node scripts/changelog-extract.mjs X.Y.Z-beta.N` reads the curated `## [X.Y.Z-beta.N]` section from `CHANGELOG.md`; the dispatch fails if the section is missing. Carried in the release artifact only — beta creates no GitHub Release. |
| recovery | Static note (`Recovery publish for existing tag ...`); the original notes are not regenerated. |

The version is committed, so a `CHANGELOG.md` section is authorable before the
dispatch and is required for **both** channels. Beta does not use generated
conventional-commit notes.

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
4. **Release body by channel** — `node scripts/changelog-extract.mjs <version>`
   pulls the curated versioned section into the GitHub Release body for both
   stable (`X.Y.Z`) and beta (`X.Y.Z-beta.N`), and fails if the section is
   missing; recovery uses a static note and does not regenerate notes.
5. **Publish** — the workflow tags the exact dispatch target SHA and publishes
   to npm (stable or beta per the `release_channel` input).

---

## Stable Release (manual dispatch)

Dispatching [`.github/workflows/release.yml`](https://github.com/ils15/pantheon-opencode/blob/main/.github/workflows/release.yml)
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
   the runner temp path `$RUNNER_TEMP/release-notes.md` (published as
   `release-artifact/release-notes.md`); fails if the section is missing.
6. **Tag creation (workflow-owned)** — a tag ref is created through the
   repository-scoped GitHub API **on the exact dispatch target SHA**.
7. **GitHub Release** —
   `gh release create vX.Y.Z --target <dispatch-sha> --verify-tag --title "Pantheon vX.Y.Z" --notes-file release-artifact/release-notes.md`.
8. **npm publish (final step)** — gated by the idempotency
   lookup, then that same tarball (without repacking) is published with
   `--tag latest --access public --provenance`. The SHA-256 validated in the
   validation job is therefore the SHA-256 of the file published to npm.

A global concurrency group (`release`, no cancel-in-progress) serializes
runs so beta and stable paths can never double-publish.

---

## Package and evidence contract

The release evidence is fail-closed and has one artifact identity:

- root dependencies and the TUI workspace use one `npm ci --ignore-scripts`
  with `package.json` and `package-lock.json`;
- the TUI manifest and lockfile remain independently validated as package and
  publish evidence;
- a release creates one npm `.tgz` tarball, computes one SHA-256, and carries
  that exact file and digest from validation to publication; a second `npm
  pack` is not a valid replacement;
- the tarball and GitHub tag/release are bound to the same full `TARGET_SHA`.

Any `npm ci` failure blocks the run. There is no `npm install` fallback, and
`PANTHEON_ALLOW_NPM_INSTALL_FALLBACK` is not part of the current contract.

### Six release gates

The `validate` job of `release.yml` runs six gates on the frozen `TARGET_SHA`.
Each prints `GATE <name>: PASS` and writes a named evidence file to
`$RUNNER_TEMP/gate-evidence/<name>.json`; the directory is uploaded as
`release-gate-evidence-<run_id>` (90-day retention). There is no fallback: a
command that cannot run, a missing artifact, an unsupported host, or a `SKIP`
is a failed gate, and a failed gate aborts before the artifact upload and
before any release credential is exposed.

| Gate | Executed by | Fails when | Evidence |
|---|---|---|---|
| (a) tests | `scripts/release-gates.mjs tests`: pytest + `src/mcp` coverage ≥ 80, `test:node`, `test:ts`, `coverage:plugin-v2`, `test:install`; pytest runs in an isolated venv built from `src/mcp/requirements-mcp.txt` | any suite, coverage threshold, or the mandatory install tier fails; an unsatisfiable or unverified pin set fails the gate | `tests.json` |
| (b) host compatibility | `scripts/release-gates.mjs host`: each **measured** host installed and exercised in an isolated sandbox; the gate reports a supported family with no row as "supported, unmeasured" instead of failing it | a measured row fails, or a known-broken host is listed | `host.json` |
| (c) install | `scripts/release-gates.mjs install`: the immutable `.tgz` installed globally, headless init, `validate-sandbox-install.mjs`, and a host-backed tool canary | install, init, source comparison, MCP/doctor checks, or canary fails or skips | `install.json`, `install-canary.log` |
| (d) package | `scripts/release-gates.mjs package`: SHA-256 recomputed over the same `.tgz`, payload inspected, `package:validate` | the digest, name, version, target SHA, or payload disagree; no second `npm pack` is accepted | `package.json` |
| (e) changelog | `scripts/release-gates.mjs changelog`: `changelog-extract.mjs` | the `[version]` section is missing or empty; recovery checks the tag instead | `changelog.json`, `changelog.md` |
| (f) metadata | `scripts/release-gates.mjs metadata`: `version-check.mjs` + `validate-node-engine-policy.mjs` | manifests drift, the channel/version shape is wrong, or the SHA is not 40 hex | `metadata.json` |

The host evidence matrix is declared in `release.yml` (`PANTHEON_RELEASE_MATRIX`)
and is validated by the gate, not trusted. Support is family-level: the gate
requires no row per family, reports a family with no row as "supported,
unmeasured", and fails only when a measured row fails or a known-broken host is
listed. See [Compatibility](COMPATIBILITY.md) for the support policy and the
known-broken set. A measured row that cannot run is a failure — the release path
has no `SKIP`.

#### Python test environment (gate a)

The Python suite imports `fastmcp`/`mcp` at collection time, so its verdict only
means something against the pins in `src/mcp/requirements-mcp.txt`. Gate (a)
therefore does **not** use the runner's ambient interpreter:

- the `validate` job creates `$RUNNER_TEMP/gate-venv` with `python3 -m venv`
  from the interpreter pinned by `actions/setup-python`
  (`python-version: '3.12'`, i.e. CPython 3.12.x on `ubuntu-latest`; the
  package metadata declares `requires-python >= 3.11`), installs
  `coverage pytest pyyaml`, `pytest-asyncio==1.3.0`, and
  `-r src/mcp/requirements-mcp.txt -r src/mcp/requirements-vision.txt`;
- `PANTHEON_PYTHON` is exported to that venv and `release-gates.mjs` resolves
  every Python command through it. A set-but-missing or non-executable
  `PANTHEON_PYTHON` is a hard failure, never a fallback to the ambient
  `python3`;
- `pip check` and an explicit assertion that every `==` pin in both
  requirements files is installed at exactly that version run **before** pytest.
  A failed venv creation, download, install, or pin assertion aborts the job
  (fail-closed via `set -euo pipefail`); no failure is downgraded to a skip;
- `actions/setup-python`'s `cache: pip` still applies: the venv's pip shares
  `~/.cache/pip`, so the download cache is reused while the install itself
  stays isolated;
- the CI `test-suite` job builds the same venv (`$RUNNER_TEMP/ci-venv`) and
  points `PANTHEON_PYTHON` at it, so CI and the release gate share one
  environment contract;
- `tests.json` records the interpreter path and `python --version` used for the
  run.

Local equivalent of the gate's Python step:

```bash
python3 -m venv /tmp/pantheon-gate-venv
/tmp/pantheon-gate-venv/bin/python -m pip install -r src/mcp/requirements-mcp.txt -r src/mcp/requirements-vision.txt
PANTHEON_PYTHON=/tmp/pantheon-gate-venv/bin/python \
  node scripts/release-gates.mjs tests --evidence-dir /tmp/gate-evidence
```

Running `pytest` on an interpreter without these pins is not evidence: with
`fastmcp 3.4.2` / `mcp 1.28.0` on `PATH`, `tests/test_persistence_goals.py`
fails at **collection** by design, which is an environment defect, not a
product defect.

### Test tiers

- **Default (developer loop):** `npm run test:node` runs `tests/*.mjs` and
  `tests/pantheon/*.mjs` **excluding** `tests/install-opencode.test.mjs` and
  `tests/install-e2e.test.mjs`. A bare `node --test` over those files skips
  their cases with an explicit reason unless the tier is opted into.
- **Heavy tier (optional locally, mandatory in release):**
  `npm run test:install` sets `PANTHEON_RUN_INSTALL_TESTS=1` and runs both
  real-install files. `npm test` / `test:all` does not include it, so the local
  loop stays fast; gate (a) always includes it.

### Coverage contract

- **Required:** Python `src/mcp` branch coverage **≥ 80%**
  (`coverage report --fail-under=80`) and the `src/plugin-v2.ts` line
  measurement (`npm run coverage:plugin-v2`). Both run in gate (a).
- **Not PASS:** Node coverage (`npm run coverage`) is report-only and enforces
  no threshold; TypeScript under `src/` outside the plugin-v2 measurement is
  unmeasured. Neither may be cited as evidence that a threshold passed.
- No new threshold is introduced by this contract.

### Memory MCP packaging

`src/mcp/memory_mcp.py` is the canonical Memory MCP server. The
`scripts/memory_mcp.py` source-tree entrypoint delegates to it, and the runtime
installer copies the canonical source into the installed scripts directory.
`tests/test_mcp_scripts_sync.py` checks that the compatibility entrypoint exposes
the same tool list as the canonical server.

---

## Beta Releases (explicit dispatch with `release_channel=beta`)

Publication is authorized **only** by an explicit `workflow_dispatch` of
`release.yml`. PR labels, pushes, merges, and tags never trigger or authorize a
release. Dispatching with `release_channel=beta` runs the beta path; a beta
recovery is triggered by a dispatch carrying `recovery_version` plus
`recovery_target_sha` (and `recovery_pr_number` only for the legacy format); a
dispatch without recovery inputs and `release_channel=stable` (the default) is
the stable path.

1. Type: channel=`beta`, npm dist-tag=`beta`.
2. **Committed version** — `apply --beta` advanced `package.json` (and the
   other manifests) to `X.Y.Z-beta.N` before the dispatch. The workflow reads
   the committed version; it never computes a beta version and never queries
   npm for a baseline. A version that is not `X.Y.Z-beta.N` fails the gate.
3. **CHANGELOG** — the bump PR must contain a `## [X.Y.Z-beta.N] - date` section;
   the release body is extracted from it and the dispatch fails if it is
   missing. Beta does not use generated conventional-commit notes.
4. **Tag** — the immutable tag `vX.Y.Z-beta.N` is created on the **dispatch
   target SHA**. Beta creates **no** GitHub Release: the official Zenodo ↔
   GitHub integration archives every Release (pre-releases included), so a beta
   Release would add an unwanted version to the Zenodo family. The git tag alone
   backs by-tag recovery.
5. `npm publish --tag beta` publishes the immutable artifact. The workflow does
   not create a PR comment.

---

## Recovery / Failure Handling

### Beta npm-publish recovery (explicit dispatch)

If a beta's git tag already exists but npm publishing failed, rerun `Release`
with `recovery_version` (the committed `X.Y.Z-beta.N`, without `v`) and
`recovery_target_sha` (the full 40-hex commit SHA). The legacy
`X.Y.Z-beta.<pr>.<sha7>` format is still accepted but additionally requires
`recovery_pr_number` matching the version and the seven-character SHA suffix.
For the current `X.Y.Z-beta.N` format only the version and SHA are needed. The
workflow checks these values before checkout, requires the remote `v<version>`
tag to exist on the recovery target SHA, and never creates or moves a tag or
release in this mode (beta creates no GitHub Release, so recovery is bound to
the tag alone). It packs the immutable checkout and publishes only when that
exact npm version is absent; an existing npm version is a successful no-op.
Partial or invalid inputs, a missing tag, API errors, and tag mismatches fail
closed.

The recovery path is beta-only and does not calculate a new version or change
the normal stable dispatch and beta-channel dispatch paths.

The pipeline is designed so **reruns are safe**:

- **Already fully released** → the idempotent guard exits 0; nothing is
  re-tagged, re-released, or re-published.
- **Crash between tag push and release create (stable)** → tag exists but
  release is missing; a rerun skips tag creation and completes the release.
  Beta creates no Release, so its reruns proceed to the npm step.
- **Crash after npm publish** → a rerun hits the idempotent guard (exit 0),
  and the npm existence check prevents publishing the same version again.
- **changelog-extract fails on a stable or beta dispatch** → the `[X.Y.Z]` /
  `[X.Y.Z-beta.N]` section is missing from `CHANGELOG.md`; add it in the bump PR
  and rerun. Both non-recovery channels extract the release body from the
  committed `CHANGELOG.md`; recovery uses a static note.

Before a manual rerun, verify the expected pre-run state (`git tag`, GitHub
releases, and the npm version) directly against the live registries.

---

## npm Policy

**Deprecate, never unpublish.** A published package version is permanent —
removing it breaks downstream installs and the `npm_check` idempotency gate.
To retire a broken version:

```bash
npm deprecate pantheon-opencode@<ver> "reason: <why it should not be used>"
```

---

## Rollback

> **Manual step with human approval.** The release workflow never rolls back —
> it publishes forward only. Re-pointing the npm `latest` tag is decided and
> executed by a maintainer, outside the automated path.

A rollback re-points the `latest` dist-tag. It does not delete the released
artifact and it does not rewrite history.

### Trigger

Roll back when a blocking defect is discovered **after** the stable publication
and `latest` carries a regression that prevents use — for example an installer
that cannot complete, or a package that does not start on the supported OpenCode
line. A defect that can wait for the next patch does not qualify: publish
forward instead.

### Restore the stable channel

```bash
npm dist-tag add pantheon-opencode@1.5.2 latest
```

Syntax: `npm dist-tag add <package-spec (with version)> [<tag>]`
(`npm dist-tag --help`).

`1.6.0` **remains published** on npm — only the `latest` pointer moves back to
`1.5.2`. Consumers without a lockfile resolve `1.5.2` again, while the
regressed version stays reachable by exact version. Nothing is re-tagged on
git, and no workflow runs.

### Do not

- **Do not `npm unpublish`.** Unpublishing is destructive and irreversible: it
  breaks every consumer whose lockfile pins the affected version, and it defeats
  the `npm_check` idempotency gate. Versions are deprecated, never removed (see
  [npm Policy](#npm-policy)).
- **Do not rewrite the GitHub Release without a note.** The Release is the
  published record of what shipped; editing or deleting it silently hides the
  incident from everyone who reads the changelog later.

### What a rollback does not undo

- **Zenodo archival** — once the GitHub Release exists, the Zenodo integration
  has deposited the record and version DOI. That deposit is irreversible.
- **The git tag** — `v1.6.0` stays on its commit. The tag is immutable and is
  not moved or deleted during a rollback.

### Required record

Log the rollback on the release (or the tracking issue) before or immediately
after the command runs:

- the defect that triggered it, with evidence;
- the command executed, verbatim;
- the resulting `npm view pantheon-opencode dist-tags` output.

Without that record, a later reader cannot tell a rollback apart from a failed
publication.

---

## Retiring the `next` dist-tag

> **Manual step with human approval.** Not part of the automated release
> workflow.

`next` was the pre-stable preview channel. Once stable `v1.6.0` is published and
verified it has no remaining purpose, and leaving it in place invites new
releases to be tagged into a channel nobody resolves. It is removed exactly
once.

**Prerequisite:** the post-publication verification of the stable release
passed — `npm view pantheon-opencode dist-tags` reports `latest` = `1.6.0`, and
installing `pantheon-opencode@1.6.0` from the public registry works. Removing
`next` before that check leaves consumers who follow `next` without a
resolution target while the stable channel is still unproven.

```bash
# Only after the post-publication verification passed.
npm dist-tag rm pantheon-opencode next

# Prove the result: latest = 1.6.0, beta preserved, next absent.
npm view pantheon-opencode dist-tags
```

Syntax: `npm dist-tag rm <package-spec> <tag>` (`npm dist-tag --help`).

The removal only drops a tag — no published version is deleted. `beta`
continues to point at the beta line and is **not** touched by this step.

---

## Branch protection (main)

The `main` protection policy — required checks, admin bypass, and the manual
enable/verify procedure — lives in [Branch Protection](BRANCH-PROTECTION.md).
The release job still re-runs the six gates on the frozen `TARGET_SHA`;
protection does not replace them.

## Pre-Release Checklist

Before cutting a release, verify:

- [ ] `node scripts/versioning.mjs status` shows a pending release
      (`tag < pkg`)
- [ ] `CHANGELOG.md` has a `## [X.Y.Z] - date` entry for the new version
- [ ] Version manifests match: `package.json` == `plugin.json` ==
      `pyproject.toml` == `src/plugins/tui/package.json`
- [ ] All required checks green on the bump PR **and on the push run for the
      merged `main` SHA** (`validate`, `test-suite`, `plugin-v2-ts-coverage`,
      `commitlint`, `security-scan`, `CodeQL`)
- [ ] The six release gates are expected to PASS for the frozen `TARGET_SHA`;
      the dispatch's `validate` job is the authority (it re-runs all six)
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

[`.zenodo.json`](https://github.com/ils15/pantheon-opencode/blob/main/.zenodo.json) is the source of the deposited metadata
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
