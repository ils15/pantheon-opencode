# Contributing to Pantheon

## Git flow

```text
feature/* ──PR──→ develop (staging)
                      │
                      ▼  release PR
                     main
                      │
                      ▼  explicit workflow dispatch
              GitHub Release + npm publish
```

Rules:

1. **Features** → branch `feature/*` → PR **to `develop`**.
2. **Integration** → PRs from `develop` to `main` only with a version bump.
3. **Releases** are published only by the `Release` workflow, dispatched
   manually after the merge to `main`.
4. **Branches** — only `main` and `develop` are maintained. Feature branches are
   deleted after merge.

The beta flow uses the same `workflow_dispatch` with `release_channel=beta` and
publishes with the `beta` dist-tag; PR labels and ordinary pushes never trigger
it. The beta version is **committed** (`X.Y.Z-beta.N`): advance it with
`node scripts/versioning.mjs apply --beta` (or
`node scripts/versioning.mjs beta`), which also promotes `[Unreleased]` in
`CHANGELOG.md` to `## [vX.Y.Z-beta.N]`, and only then dispatch. The workflow
does not compute the version at runtime. See [docs/RELEASING.md](docs/RELEASING.md)
for recovery and validation.

### Branch protection

- `main`: requires a PR and passing CI.
- `develop`: requires a PR and passing CI.

### Versioning

- `package.json`, `package-lock.json`, `plugin.json`, `pyproject.toml`, and
  `src/plugins/tui/package.json` are always synchronized; validate with
  `npm run version:check`.
- `CHANGELOG.md` follows `## [vX.Y.Z]`.
- Beta uses the committed sequential line `X.Y.Z-beta.N`:
  `node scripts/versioning.mjs apply --beta` updates the manifests and promotes
  `[Unreleased]` to `## [vX.Y.Z-beta.N]`; the section is mandatory before a
  `release_channel=beta` dispatch.
- The release gate validates consistency before merge.

### Releases

- Every feature merged to `develop` appears in the next release.
- When `develop` is ready, bump the version and open a PR to `main`.
- After the merge, run the `Release` workflow manually in GitHub Actions; an
  ordinary push to `main` publishes nothing.

## Documentation rule

**One home per fact.** Every durable fact is stated once, in the page that owns
it, and every other page links to it. Duplicating a fact creates two sources of
truth and guarantees they will disagree.

The following facts have a single designated home and **must not be restated**
elsewhere:

| Fact | Home |
|---|---|
| Support matrix, OpenCode 1.x/2.x, Node floor, EOL, known issues | `docs/COMPATIBILITY.md` |
| Installer mechanics: flags, exit codes, saved plans, backup, uninstall, reconcile, MCP pins | `docs/INSTALLATION.md` |
| Release mechanics, gates, tags, rollback | `docs/RELEASING.md` |
| Sandbox, latency, and F1–F3 benchmark evidence | `docs/internal/validation.md` |

Other rules:

- **English is canonical.** Only `README.pt-BR.md` and
  `docs/UPGRADING.pt-BR.md` are maintained in Portuguese, each with a
  `<!-- synced-from: <english-file> @ <short-sha> -->` header. Every other page
  is English-only.
- **Links from `docs/` to repository files** use absolute
  `https://github.com/ils15/pantheon-opencode/blob/main/<path>` URLs, because
  the published site only contains `docs/`. Links between published pages use
  relative paths with a valid anchor.
- Run `npm run docs:lint` before opening a PR. It checks relative Markdown
  targets, anchors, and links that escape `docs/`.
- Run `mkdocs build --strict` with the docs virtualenv; it must exit 0.
- PRs that add or change a feature, environment variable, or command update the
  README and, when the fact has a designated home, that page too — without
  copying the fact into a second home.

## Local checks

```bash
npm run lint          # biome
npm run typecheck     # tsc --noEmit
npm test              # test:ci + test:node + test:ts
npm run docs:lint
```

Tests that require a real install are opt-in via `npm run test:install`.
Coverage is report-only except for the V2 plugin floor described in
`docs/internal/validation.md`.

## TUI media captures

The OpenCode V2 page embeds terminal captures under `docs/assets/tui/`. They are
recorded from committed VHS tapes — never mocked, retouched, or composed.

Prerequisites: `vhs`, `ttyd`, and `ffmpeg` on `PATH`, plus an isolated sandbox
install with a provider credential. Check and record:

```bash
npm run docs:media -- --check   # names every missing prerequisite
scripts/test-opencode-v2-sandbox.sh --prepare
npm run docs:media              # records every docs/assets/tui/*.tape
npm run docs:media v2-sidebar   # or one tape
```

Rules:

- One tape per flow, committed next to its output. A media slot in the docs must
  name the tape that produces it; an image with no tape is a defect.
- Every tape pins `Set Shell`, `Set FontSize`, `Set Width`/`Set Height`, the
  theme, and explicit `Sleep` values. Do not race keystrokes.
- Captures come from a real run: the Dispatch block only renders real child
  sessions, so there is no offline fixture path.
- `.gitattributes` keeps `*.tape` LF and marks `*.gif`/`*.png` binary.
- Do not commit build output, frames, or scratch recordings; only the `.tape`
  files and their declared `.gif`/`.png` outputs belong in the repository.

The current status is recorded in `docs/internal/validation.md#tui-media-gap`.
