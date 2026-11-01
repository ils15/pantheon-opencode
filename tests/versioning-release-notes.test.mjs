import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT_FILES = [
  'scripts/versioning.mjs',
  'scripts/changelog-merge.mjs',
  'scripts/manifest-inventory.mjs',
  'scripts/release-beta-version.mjs',
  'scripts/release-notes.mjs',
]
const RELEASE_FILES = [
  'package.json',
  'package-lock.json',
  'plugin.json',
  'pyproject.toml',
  '.zenodo.json',
  'CITATION.cff',
  'src/plugins/tui/package.json',
  'src/plugins/tui/package-lock.json',
]
const BETA_VERSION = '1.6.2-beta.4'
const fixtures = []

test.after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true })
})

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function createFixture({ version = BETA_VERSION, unreleasedNote = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-beta-release-notes-'))
  fixtures.push(root)
  for (const file of [...SCRIPT_FILES, ...RELEASE_FILES, 'CHANGELOG.md']) {
    const target = join(root, file)
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(join(ROOT, file), target)
  }

  if (version !== BETA_VERSION) setFixtureVersion(root, version)
  if (unreleasedNote) {
    const changelogPath = join(root, 'CHANGELOG.md')
    const changelog = readFileSync(changelogPath, 'utf8')
    writeFileSync(
      changelogPath,
      changelog.replace(
        '## [Unreleased]\n',
        `## [Unreleased]\n\n## 🆕 What's New\n\n- ${unreleasedNote}\n`,
      ),
    )
  }

  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.name', 'Release Tooling Test'])
  git(root, ['config', 'user.email', 'release-tooling@example.invalid'])
  writeFileSync(join(root, 'history.txt'), 'fixture baseline\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'chore: initialize release fixture'])
  return root
}

function setFixtureVersion(root, version, currentVersion = BETA_VERSION) {
  for (const file of RELEASE_FILES) {
    const path = join(root, file)
    const content = readFileSync(path, 'utf8')
    writeFileSync(path, content.replaceAll(currentVersion, version))
  }
}

function addCommit(root, subject) {
  const historyPath = join(root, 'history.txt')
  writeFileSync(historyPath, `${readFileSync(historyPath, 'utf8')}${subject}\n`)
  git(root, ['add', 'history.txt'])
  git(root, ['commit', '--quiet', '-m', subject])
}

function runApply(root, ...args) {
  return spawnSync(process.execPath, [join(root, 'scripts/versioning.mjs'), 'apply', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function snapshot(root, directory = root) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...snapshot(root, path))
    else files.push([relative(root, path), readFileSync(path).toString('base64')])
  }
  return files.sort(([left], [right]) => left.localeCompare(right))
}

test('beta --notes uses the newest beta baseline and promotes the generated range', () => {
  const root = createFixture({ version: '1.6.2-beta.3' })
  git(root, ['tag', 'v1.6.2-beta.3'])
  addCommit(root, 'feat(beta): shipped before beta four')
  setFixtureVersion(root, BETA_VERSION, '1.6.2-beta.3')
  git(root, ['add', ...RELEASE_FILES])
  git(root, ['commit', '--quiet', '-m', 'chore(release): v1.6.2-beta.4'])
  git(root, ['tag', 'v1.6.2-beta.4'])

  git(root, ['tag', 'v1.6.2'])
  addCommit(root, 'feat(beta): add beta dashboard')
  addCommit(root, 'fix(beta): repair beta dashboard')

  const result = runApply(root, '--beta', '--notes')
  assert.equal(result.status, 0, result.stderr)
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /^## \[v1\.6\.2-beta\.5\] - \d{4}-\d{2}-\d{2}$/m)
  assert.match(changelog, /- \*\*beta\*\* — add beta dashboard/)
  assert.match(changelog, /- \*\*beta\*\* — repair beta dashboard/)
  assert.doesNotMatch(changelog, /shipped before beta four/)
  assert.match(result.stdout, /generated from 2 commits since v1\.6\.2-beta\.4/)
})

test('beta --notes fails without a prior beta tag and leaves files untouched', () => {
  const root = createFixture()
  git(root, ['tag', 'v1.6.2'])
  addCommit(root, 'feat(beta): would otherwise be generated')
  const before = snapshot(root)

  const result = runApply(root, '--beta', '--notes')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no prior beta tag found/)
  assert.deepEqual(snapshot(root), before)
})

test('beta --notes fails on an empty generated range without partial writes', () => {
  const root = createFixture({ unreleasedNote: 'Keep the manually curated note.' })
  git(root, ['tag', 'v1.6.2-beta.4'])
  addCommit(root, 'chore(beta): internal-only change')
  const before = snapshot(root)

  const result = runApply(root, '--beta', '--notes')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no generated notes since v1\.6\.2-beta\.4/)
  assert.deepEqual(snapshot(root), before)
})

test('stable apply --notes continues to generate from the latest stable tag', () => {
  const root = createFixture({ version: '1.6.2' })
  git(root, ['tag', 'v1.6.2'])
  addCommit(root, 'feat(stable): include stable-range feature')
  git(root, ['tag', 'v1.6.2-beta.4'])
  addCommit(root, 'fix(stable): include stable-range fix')

  const result = runApply(root, 'patch', '--notes')
  assert.equal(result.status, 0, result.stderr)
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /^## \[v1\.6\.3\] - \d{4}-\d{2}-\d{2}$/m)
  assert.match(changelog, /include stable-range feature/)
  assert.match(changelog, /include stable-range fix/)
  assert.match(result.stdout, /generated from 2 commits/)
})

test('beta apply without --notes still promotes the manual Unreleased body', () => {
  const root = createFixture({ unreleasedNote: 'Keep the manually curated beta note.' })
  git(root, ['tag', 'v1.6.2-beta.4'])
  addCommit(root, 'feat(beta): do not replace the manual beta note')

  const result = runApply(root, '--beta')
  assert.equal(result.status, 0, result.stderr)
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /^## \[v1\.6\.2-beta\.5\] - \d{4}-\d{2}-\d{2}$/m)
  assert.match(changelog, /Keep the manually curated beta note\./)
  assert.doesNotMatch(changelog, /do not replace the manual beta note/)
})
