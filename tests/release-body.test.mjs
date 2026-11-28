import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ZENODO_CITATION_FOOTER, ZENODO_CONCEPT_DOI } from '../scripts/zenodo-record.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-body.mjs')
const tempDirs = []

/**
 * Every composed body ends with the generic citation footer, separated by a
 * horizontal rule. Version-bearing content never reaches this constant, so a
 * release body cannot cite a DOI that does not exist yet.
 */
function withCitationFooter(body) {
  return `${String(body).trimEnd()}\n\n---\n\n${ZENODO_CITATION_FOOTER}\n`
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-release-body-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('scripts/release-body.mjs', () => {
  test('uses canonical changelog notes untouched when no curated release page exists', async () => {
    const { composeReleaseBody } = await import(SCRIPT)
    const dir = makeTempDir()
    const releasesDir = join(dir, 'docs', 'releases')
    mkdirSync(releasesDir, { recursive: true })

    const changelogNotes = "### 🆕 What's New\n\n- **core** — Added widget.\n"
    const body = composeReleaseBody({
      version: '2.2.0',
      channel: 'stable',
      recovery: false,
      changelogNotes,
      repoRoot: dir,
      releasesDir,
      repo: 'ils15/pantheon-opencode',
      ref: 'v2.2.0',
    })

    assert.equal(body, withCitationFooter("### 🆕 What's New\n\n- **core** — Added widget."))
  })

  test('passes through canonical changelog notes for beta channel and recovery mode even if curated page exists', async () => {
    const { composeReleaseBody } = await import(SCRIPT)
    const dir = makeTempDir()
    const releasesDir = join(dir, 'docs', 'releases')
    mkdirSync(releasesDir, { recursive: true })
    writeFileSync(join(releasesDir, 'v2.2.0.md'), '# Rich Release Page\n', 'utf8')

    const changelogNotes = "### 🆕 What's New\n\n- **beta** — Snapshot.\n"

    assert.equal(
      composeReleaseBody({
        version: '2.2.0-beta.1',
        channel: 'beta',
        recovery: false,
        changelogNotes,
        repoRoot: dir,
        releasesDir,
        repo: 'ils15/pantheon-opencode',
        ref: 'v2.2.0-beta.1',
      }),
      withCitationFooter("### 🆕 What's New\n\n- **beta** — Snapshot."),
    )

    assert.equal(
      composeReleaseBody({
        version: '2.2.0',
        channel: 'stable',
        recovery: true,
        changelogNotes,
        repoRoot: dir,
        releasesDir,
        repo: 'ils15/pantheon-opencode',
        ref: 'v2.2.0',
      }),
      withCitationFooter("### 🆕 What's New\n\n- **beta** — Snapshot."),
    )
  })

  test('composes rich GitHub release body with rewritten asset/doc URLs and collapsible changelog ledger', async () => {
    const { composeReleaseBody } = await import(SCRIPT)
    const dir = makeTempDir()
    const releasesDir = join(dir, 'docs', 'releases')
    const assetsDir = join(dir, 'docs', 'assets', 'tui')
    mkdirSync(releasesDir, { recursive: true })
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(dir, 'docs', 'INSTALLATION.md'), '# Install\n', 'utf8')
    writeFileSync(join(assetsDir, 'cockpit-overview.png'), 'png', 'utf8')

    const curated = [
      '# Pantheon `v2.2.0`',
      '',
      '![Cockpit Overview](../assets/tui/cockpit-overview.png "Live Cockpit")',
      '',
      'See [Installation](../INSTALLATION.md#quickstart) and [Highlights](./highlights.md).',
      '',
      '```markdown',
      '![Inside Code](../assets/tui/ignored.png)',
      '```',
      '',
      'Inline code `![Inline](../assets/tui/ignored.png)` stays untouched.',
      '',
    ].join('\n')
    writeFileSync(join(releasesDir, 'v2.2.0.md'), curated, 'utf8')

    const changelogNotes = "### 🆕 What's New\n\n- **cockpit** — 3-page mission control.\n"
    const result = composeReleaseBody({
      version: 'v2.2.0',
      channel: 'stable',
      recovery: false,
      changelogNotes,
      repoRoot: dir,
      releasesDir,
      repo: 'ils15/pantheon-opencode',
      ref: 'v2.2.0',
    })

    assert.match(
      result,
      /!\[Cockpit Overview\]\(https:\/\/raw\.githubusercontent\.com\/ils15\/pantheon-opencode\/v2\.2\.0\/docs\/assets\/tui\/cockpit-overview\.png "Live Cockpit"\)/,
    )
    assert.match(
      result,
      /\[Installation\]\(https:\/\/github\.com\/ils15\/pantheon-opencode\/blob\/v2\.2\.0\/docs\/INSTALLATION\.md#quickstart\)/,
    )
    assert.match(
      result,
      /\[Highlights\]\(https:\/\/github\.com\/ils15\/pantheon-opencode\/blob\/v2\.2\.0\/docs\/releases\/highlights\.md\)/,
    )
    assert.match(result, /!\[Inside Code\]\(\.\.\/assets\/tui\/ignored\.png\)/)
    assert.match(result, /`!\[Inline\]\(\.\.\/assets\/tui\/ignored\.png\)`/)
    assert.match(result, /<details>/)
    assert.match(result, /Full Keep a Changelog Ledger \(v2\.2\.0\)/)
    assert.match(result, /\*\*cockpit\*\* — 3-page mission control\./)
  })

  test('CLI writes composed output to --out cleanly', () => {
    const dir = makeTempDir()
    const releasesDir = join(dir, 'docs', 'releases')
    mkdirSync(releasesDir, { recursive: true })
    writeFileSync(
      join(releasesDir, 'v2.2.0.md'),
      '# Pantheon `v2.2.0`\n\n![Img](../assets/tui/home-status.png)\n',
      'utf8',
    )
    const notesPath = join(dir, 'changelog-notes.md')
    const outPath = join(dir, 'release-notes.md')
    writeFileSync(notesPath, "### 🆕 What's New\n\n- **core** — Shipped.\n", 'utf8')

    execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--version',
        '2.2.0',
        '--channel',
        'stable',
        '--changelog-notes',
        notesPath,
        '--repo-root',
        dir,
        '--releases-dir',
        releasesDir,
        '--repo',
        'ils15/pantheon-opencode',
        '--ref',
        'v2.2.0',
        '--out',
        outPath,
      ],
      { cwd: ROOT, stdio: 'pipe' },
    )

    const written = readFileSync(outPath, 'utf8')
    assert.match(
      written,
      /https:\/\/raw\.githubusercontent\.com\/ils15\/pantheon-opencode\/v2\.2\.0\/docs\/assets\/tui\/home-status\.png/,
    )
    assert.match(written, /\*\*core\*\* — Shipped\./)
    assert.ok(written.endsWith(`---\n\n${ZENODO_CITATION_FOOTER}\n`))
  })

  test('appends the citation footer to every composed body shape, exactly once', async () => {
    const { composeReleaseBody } = await import(SCRIPT)
    const dir = makeTempDir()
    const releasesDir = join(dir, 'docs', 'releases')
    mkdirSync(releasesDir, { recursive: true })
    writeFileSync(join(releasesDir, 'v2.2.0.md'), '# Curated page\n', 'utf8')
    writeFileSync(join(releasesDir, 'v2.2.1.md'), '', 'utf8')

    const changelogNotes = "### 🆕 What's New\n\n- **core** — Shipped.\n"
    const shapes = {
      'canonical-only (no curated page)': { version: '2.2.2' },
      'canonical-only (empty curated page)': { version: '2.2.1' },
      'curated page': { version: '2.2.0' },
      beta: { version: '2.2.0-beta.1', channel: 'beta' },
      recovery: { version: '2.2.0', recovery: true },
    }

    for (const [label, shape] of Object.entries(shapes)) {
      const body = composeReleaseBody({
        changelogNotes,
        repoRoot: dir,
        releasesDir,
        repo: 'ils15/pantheon-opencode',
        ref: 'v2.2.0',
        ...shape,
      })
      assert.equal(
        countOccurrences(body, ZENODO_CITATION_FOOTER),
        1,
        `${label} must carry the footer exactly once`,
      )
      assert.ok(
        body.trimEnd().endsWith(ZENODO_CITATION_FOOTER),
        `${label} must end with the footer`,
      )
      assert.ok(body.includes('- **core** — Shipped.'), `${label} must keep the changelog notes`)
    }
  })

  test('cites the concept DOI, never a version DOI', async () => {
    assert.equal(ZENODO_CONCEPT_DOI, '10.5281/zenodo.22650136')
    assert.equal(
      ZENODO_CITATION_FOOTER,
      'Cite this release via the concept DOI [10.5281/zenodo.22650136](https://doi.org/10.5281/zenodo.22650136).',
    )
    // A version DOI (`zenodo.<record id>`) is unknown at build time; the
    // footer may only ever name the concept recid.
    assert.doesNotMatch(ZENODO_CITATION_FOOTER, /zenodo\.(?!22650136)\d+/)
  })

  test('does not duplicate a footer already present in a curated release doc', async () => {
    const { composeReleaseBody } = await import(SCRIPT)
    const dir = makeTempDir()
    const releasesDir = join(dir, 'docs', 'releases')
    mkdirSync(releasesDir, { recursive: true })
    writeFileSync(
      join(releasesDir, 'v2.3.0.md'),
      `# Curated page\n\n${ZENODO_CITATION_FOOTER}\n`,
      'utf8',
    )

    const body = composeReleaseBody({
      version: '2.3.0',
      changelogNotes: "### 🆕 What's New\n\n- **core** — Shipped.\n",
      repoRoot: dir,
      releasesDir,
      repo: 'ils15/pantheon-opencode',
      ref: 'v2.3.0',
    })

    assert.equal(countOccurrences(body, ZENODO_CITATION_FOOTER), 1)
  })
})
