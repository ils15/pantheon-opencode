import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  groupCommits,
  parseCommitLine,
  renderChangelog,
  renderMarkdown,
} from '../scripts/release-notes.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url))

// ---------------------------------------------------------------------------
// parseCommitLine
// ---------------------------------------------------------------------------

test('parses a scoped commit into type/scope/subject', () => {
  const entry = parseCommitLine('feat(tui): real-time Delegations panel|')
  assert.deepEqual(entry, {
    type: 'feat',
    scope: 'tui',
    subject: 'real-time Delegations panel',
    breaking: false,
  })
})

test('parses a commit without scope', () => {
  const entry = parseCommitLine('docs: document RELEASING|')
  assert.equal(entry.scope, null)
  assert.equal(entry.subject, 'document RELEASING')
})

test('detects breaking via type(scope)! bang', () => {
  const entry = parseCommitLine('feat(scope)!: drop legacy API|')
  assert.equal(entry.breaking, true)
  assert.equal(entry.subject, 'drop legacy API')
})

test('detects breaking via type! bang without scope', () => {
  const entry = parseCommitLine('feat!: drop legacy API|')
  assert.equal(entry.breaking, true)
  assert.equal(entry.scope, null)
})

test('detects breaking via BREAKING CHANGE in the body', () => {
  const entry = parseCommitLine('feat(core): new engine|BREAKING CHANGE: old engine removed')
  assert.equal(entry.breaking, true)
  assert.equal(entry.type, 'feat')
})

test('ignores merge commits', () => {
  assert.equal(parseCommitLine('Merge pull request #48 from ils15/feat/compaction-134|'), null)
  assert.equal(parseCommitLine('Merge branch main into feat/compaction-134|'), null)
})

test('ignores empty-subject (trivial) commits', () => {
  assert.equal(parseCommitLine('chore:|'), null)
})

test('keeps a chore with a real subject', () => {
  const entry = parseCommitLine('chore(release): v1.3.4|')
  assert.equal(entry.type, 'chore')
  assert.equal(entry.subject, 'v1.3.4')
})

test('ignores non-conventional subjects', () => {
  assert.equal(parseCommitLine('Fix typo in README|'), null)
})

// ---------------------------------------------------------------------------
// groupCommits — the audited fixture: feat/fix/docs/breaking/merge/chore
// ---------------------------------------------------------------------------

test('groups feat/fix/docs/breaking/merge/chore into the right buckets', () => {
  const entries = [
    parseCommitLine('feat(tui): real-time Delegations panel|'),
    parseCommitLine('fix(plugin): startup hang|'),
    parseCommitLine('docs: document RELEASING|'),
    parseCommitLine('feat(core)!: drop legacy API|'),
    parseCommitLine('Merge pull request #48 from ils15/feat/x|'),
    parseCommitLine('chore(scripts): release gates|'),
  ].filter(Boolean)

  const groups = groupCommits(entries)
  assert.deepEqual(
    groups.features.map((e) => e.subject),
    ['real-time Delegations panel'],
  )
  assert.deepEqual(
    groups.fixed.map((e) => e.subject),
    ['startup hang'],
  )
  assert.deepEqual(
    groups.docs.map((e) => e.subject),
    ['document RELEASING'],
  )
  assert.deepEqual(
    groups.breaking.map((e) => e.subject),
    ['drop legacy API'],
  )
  assert.deepEqual(
    groups.maintenance.map((e) => e.subject),
    ['release gates'],
  )
  assert.equal(groups.performance.length, 0)
  assert.equal(groups.security.length, 0)
})

test('a breaking commit never also appears in its type group', () => {
  const groups = groupCommits([parseCommitLine('feat(scope)!: drop legacy API|')])
  assert.equal(groups.breaking.length, 1)
  assert.equal(groups.features.length, 0)
})

test('unknown conventional types land in maintenance', () => {
  const groups = groupCommits([parseCommitLine('release: v1.2.1 (#13)|')])
  assert.equal(groups.maintenance.length, 1)
})

test('perf and security map to their own buckets', () => {
  const groups = groupCommits([
    parseCommitLine('perf(core): cache lookups|'),
    parseCommitLine('security(auth): harden token parsing|'),
  ])
  assert.equal(groups.performance.length, 1)
  assert.equal(groups.security.length, 1)
})

test('null entries (skipped commits) are tolerated', () => {
  const groups = groupCommits([null, parseCommitLine('fix: x|'), null])
  assert.equal(groups.fixed.length, 1)
})

// ---------------------------------------------------------------------------
// renderMarkdown / renderChangelog
// ---------------------------------------------------------------------------

test('renderMarkdown emits emoji sections with the audited bullet format', () => {
  const groups = groupCommits([
    parseCommitLine('feat(tui): real-time Delegations panel|'),
    parseCommitLine('docs: document RELEASING|'),
  ])
  const markdown = renderMarkdown(groups)
  assert.match(markdown, /^## ✨ Features\n- \*\*tui\*\* — real-time Delegations panel/)
  assert.match(markdown, /## 📚 Documentation\n- \*\*document RELEASING\*\*$/)
})

test('renderMarkdown emits Breaking first', () => {
  const groups = groupCommits([
    parseCommitLine('feat!: drop legacy API|'),
    parseCommitLine('fix: startup hang|'),
  ])
  const markdown = renderMarkdown(groups)
  assert.ok(markdown.indexOf('💥 Breaking') < markdown.indexOf('🐞 Fixed'))
  assert.doesNotMatch(markdown, /✨ Features/)
})

test('renderMarkdown returns empty string when nothing is groupable', () => {
  assert.equal(renderMarkdown(groupCommits([])), '')
})

test('renderChangelog maps groups to Keep-a-Changelog subsections', () => {
  const groups = groupCommits([
    parseCommitLine('feat(tui): real-time Delegations panel|'),
    parseCommitLine('fix(plugin): startup hang|'),
    parseCommitLine('perf(core): cache lookups|'),
    parseCommitLine('security(auth): harden tokens|'),
    parseCommitLine('docs: document RELEASING|'),
    parseCommitLine('chore(scripts): release gates|'),
    parseCommitLine('feat(core)!: drop legacy API|'),
  ])
  const changelog = renderChangelog(groups)
  const added = /### Added\n- \*\*tui\*\* — real-time Delegations panel/.exec(changelog)
  assert.ok(added, 'feat → ### Added')
  const fixed = /### Fixed\n- \*\*plugin\*\* — startup hang/.exec(changelog)
  assert.ok(fixed, 'fix → ### Fixed')
  const security = /### Security\n- \*\*auth\*\* — harden tokens/.exec(changelog)
  assert.ok(security, 'security → ### Security')
  // breaking + perf + docs + maintenance all land in ### Changed
  assert.ok(changelog.includes('### Changed'))
  assert.ok(/### Changed\n- \*\*core\*\* — drop legacy API/.test(changelog))
  assert.ok(/### Changed\n(?:- \*\*[^*]+\*\*.*\n)*- \*\*core\*\* — cache lookups/.test(changelog))
  assert.ok(/### Changed[\s\S]*\*\*document RELEASING\*\*/.test(changelog))
  assert.ok(/### Changed[\s\S]*- \*\*scripts\*\* — release gates/.test(changelog))
  assert.ok(changelog.indexOf('### Added') < changelog.indexOf('### Changed'))
  assert.ok(changelog.indexOf('### Changed') < changelog.indexOf('### Fixed'))
})

// ---------------------------------------------------------------------------
// CLI smoke (against the real repo — read-only git log, no tags created)
// ---------------------------------------------------------------------------

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' })
}

test('CLI normal mode exits 0 and prints emoji sections (lastTag..HEAD)', () => {
  const { status, stdout, stderr } = runCli([])
  assert.equal(status, 0, stderr)
  assert.match(stderr, /release-notes: v\d+\.\d+\.\d+\.\.HEAD/)
  assert.match(stdout, /## ✨ Features/)
  assert.match(stdout, /## 🐞 Fixed/)
})

test('CLI --draft exits 0 without reading tags and prints markdown', () => {
  const { status, stdout, stderr } = runCli(['--draft'])
  assert.equal(status, 0, stderr)
  assert.match(stderr, /draft mode — last 30 commits \(no tag lookup\)/)
  assert.match(stdout, /## (✨ Features|🐞 Fixed|🔧 Maintenance)/)
})
