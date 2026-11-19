import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/release-body.mjs')
const tempDirs = []

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

    assert.equal(body, "### 🆕 What's New\n\n- **core** — Added widget.\n")
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
      "### 🆕 What's New\n\n- **beta** — Snapshot.\n",
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
      "### 🆕 What's New\n\n- **beta** — Snapshot.\n",
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
  })
})
