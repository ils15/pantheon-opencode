import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  collectEntries,
  getLastTag,
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
    refs: [],
  })
})

test('parses a commit without scope', () => {
  const entry = parseCommitLine('docs: document RELEASING|')
  assert.equal(entry.scope, null)
  assert.equal(entry.subject, 'document RELEASING')
  assert.deepEqual(entry.refs, [])
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

test('parses Closes #N from the commit body into refs', () => {
  const entry = parseCommitLine('fix(plugin): startup hang|Closes #42')
  assert.deepEqual(entry.refs, [42])
})

test('parses multiple issue refs (Fixes/Resolves/Closes) in order', () => {
  const entry = parseCommitLine('fix(core): harden parser|Fixes #7|Resolves #12|Closes #9')
  assert.deepEqual(entry.refs, [7, 12, 9])
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
// groupCommits — final groups: 🆕 What's New / 🐞 Fixed / ⚠️ Known Issues /
// ✅ Closed Issues. Internal types (chore, refactor, test, ci, build, style,
// revert, unknown) are omitted; breaking keeps its type bucket.
// ---------------------------------------------------------------------------

test('groups feat/fix/docs/breaking/merge/chore into the final buckets', () => {
  const entries = [
    parseCommitLine('feat(tui): real-time Delegations panel|'),
    parseCommitLine('fix(plugin): startup hang|'),
    parseCommitLine('docs: document RELEASING|'),
    parseCommitLine('feat(core)!: drop legacy API|'),
    parseCommitLine('Merge pull request #48 from ils15/feat/x|'),
    parseCommitLine('chore(scripts): release gates|'),
  ].filter(Boolean)

  const groups = groupCommits(entries)
  // feat + docs → What's New (docs are user-facing, no dedicated group);
  // breaking feat! keeps its type bucket (marked, not moved out)
  assert.deepEqual(
    groups.whatsNew.map((e) => e.subject),
    ['real-time Delegations panel', 'document RELEASING', 'drop legacy API'],
  )
  assert.ok(groups.whatsNew.find((e) => e.subject === 'drop legacy API').breaking)
  // fix → Fixed
  assert.deepEqual(
    groups.fixed.map((e) => e.subject),
    ['startup hang'],
  )
  // chore → omitted (internal)
  assert.equal(groups.knownIssues.length, 0)
  assert.equal(groups.closedIssues.length, 0)
})

test('a breaking commit stays in its type group, marked breaking', () => {
  const groups = groupCommits([parseCommitLine('feat(scope)!: drop legacy API|')])
  assert.equal(groups.whatsNew.length, 1)
  assert.equal(groups.whatsNew[0].breaking, true)
})

test('unknown conventional types are omitted (internal)', () => {
  const groups = groupCommits([parseCommitLine('release: v1.2.1 (#13)|')])
  assert.equal(groups.whatsNew.length, 0)
  assert.equal(groups.fixed.length, 0)
})

test('chore/refactor/test/ci/build/style/revert are all omitted', () => {
  const entries = [
    'chore(scripts): release gates',
    'refactor(core): simplify loop',
    'test(plugin): add coverage',
    'ci: speed up validate',
    'build(deps): bump esbuild',
    'style: format',
    'revert: undo change',
  ].map((s) => parseCommitLine(`${s}|`))
  const groups = groupCommits(entries)
  assert.equal(groups.whatsNew.length, 0)
  assert.equal(groups.fixed.length, 0)
  assert.equal(groups.closedIssues.length, 0)
})

test("perf and docs map to What's New; security maps to Fixed", () => {
  const groups = groupCommits([
    parseCommitLine('perf(core): cache lookups|'),
    parseCommitLine('security(auth): harden token parsing|'),
  ])
  assert.deepEqual(
    groups.whatsNew.map((e) => e.type),
    ['perf'],
  )
  assert.deepEqual(
    groups.fixed.map((e) => e.type),
    ['security'],
  )
})

test('null entries (skipped commits) are tolerated', () => {
  const groups = groupCommits([null, parseCommitLine('fix: x|'), null])
  assert.equal(groups.fixed.length, 1)
})

test('Closes/Fixes/Resolves refs from bodies land in closedIssues, deduped', () => {
  const groups = groupCommits([
    parseCommitLine('fix(plugin): startup hang|Closes #42'),
    parseCommitLine('feat(core): new engine|Fixes #7'),
    parseCommitLine('fix(plugin): retry|Closes #42'), // same issue — deduped
  ])
  assert.deepEqual(groups.closedIssues, [
    { ref: 42, subject: 'startup hang' },
    { ref: 7, subject: 'new engine' },
  ])
})

test('knownIssues option populates the Known Issues group', () => {
  const groups = groupCommits([parseCommitLine('feat: x|')], {
    knownIssues: ['Upstream Gemini API may rate-limit'],
  })
  assert.deepEqual(groups.knownIssues, ['Upstream Gemini API may rate-limit'])
})

// ---------------------------------------------------------------------------
// renderMarkdown / renderChangelog
// ---------------------------------------------------------------------------

test('renderMarkdown emits the final emoji sections with the audited bullet format', () => {
  const groups = groupCommits([
    parseCommitLine('feat(tui): real-time Delegations panel|'),
    parseCommitLine('docs: document RELEASING|'),
    parseCommitLine('fix(plugin): startup hang|'),
  ])
  const markdown = renderMarkdown(groups)
  assert.match(
    markdown,
    /^## 🆕 What's New\n- \*\*tui\*\* — real-time Delegations panel\n- \*\*document RELEASING\*\*/,
  )
  assert.match(markdown, /## 🐞 Fixed\n- \*\*plugin\*\* — startup hang$/)
  assert.doesNotMatch(markdown, /## ⚠️ Known Issues/)
  assert.doesNotMatch(markdown, /## ✅ Closed Issues/)
})

test("renderMarkdown marks breaking bullets with 💥 inside What's New", () => {
  const groups = groupCommits([parseCommitLine('feat(core)!: drop legacy API|')])
  const markdown = renderMarkdown(groups)
  assert.match(markdown, /^## 🆕 What's New\n- 💥 \*\*core\*\* — drop legacy API$/)
  assert.doesNotMatch(markdown, /Breaking/)
})

test('renderMarkdown emits ⚠️ Known Issues only when provided', () => {
  const withIssues = groupCommits([parseCommitLine('feat: x|')], {
    knownIssues: ['Known: widget API is unstable'],
  })
  assert.match(renderMarkdown(withIssues), /## ⚠️ Known Issues\n- Known: widget API is unstable/)
  assert.match(renderMarkdown(withIssues), /## 🆕 What's New\n- \*\*x\*\*\n\n## ⚠️ Known Issues/)

  const withoutIssues = groupCommits([parseCommitLine('feat: x|')])
  assert.doesNotMatch(renderMarkdown(withoutIssues), /## ⚠️ Known Issues/)
})

test('renderMarkdown emits ✅ Closed Issues with #N + subject when refs exist', () => {
  const groups = groupCommits([parseCommitLine('fix(plugin): startup hang|Closes #42')])
  const markdown = renderMarkdown(groups)
  assert.match(markdown, /## ✅ Closed Issues\n- #42 - startup hang$/)

  const noRefs = groupCommits([parseCommitLine('fix: x|')])
  assert.doesNotMatch(renderMarkdown(noRefs), /## ✅ Closed Issues/)
})

test('renderMarkdown returns empty string for internal-only commits', () => {
  const groups = groupCommits([
    parseCommitLine('chore(scripts): release gates|'),
    parseCommitLine('refactor(core): simplify|'),
  ])
  assert.equal(renderMarkdown(groups), '')
})

test('renderChangelog emits the same final emoji groups (apply --notes)', () => {
  const groups = groupCommits(
    [
      parseCommitLine('feat(tui): real-time Delegations panel|'),
      parseCommitLine('fix(plugin): startup hang|'),
      parseCommitLine('perf(core): cache lookups|'),
      parseCommitLine('security(auth): harden tokens|'),
      parseCommitLine('docs: document RELEASING|'),
      parseCommitLine('chore(scripts): release gates|'),
      parseCommitLine('feat(core)!: drop legacy API|'),
    ],
    { knownIssues: ['Known: widget API is unstable'] },
  )
  const changelog = renderChangelog(groups)
  assert.equal(changelog, renderMarkdown(groups))
  assert.match(changelog, /## 🆕 What's New/)
  assert.match(changelog, /## 🐞 Fixed/)
  assert.match(changelog, /## ⚠️ Known Issues/)
  // chore is omitted entirely
  assert.doesNotMatch(changelog, /release gates/)
  assert.doesNotMatch(changelog, /### Added/)
  assert.match(changelog, /- 💥 \*\*core\*\* — drop legacy API/)
})

// ---------------------------------------------------------------------------
// CLI smoke (against the real repo — read-only git log, no tags created)
// ---------------------------------------------------------------------------

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' })
}

test('CLI normal mode exits 0 and prints the final emoji sections (lastTag..HEAD)', () => {
  const { status, stdout, stderr } = runCli([])
  assert.equal(status, 0, stderr)
  assert.match(stderr, /release-notes: v\d+\.\d+\.\d+\.\.HEAD/)

  if (stdout.trim() === '') {
    // A range containing only internal commits is a valid release-notes
    // result. Verify the range itself explains the empty output rather than
    // treating an empty stdout as an unconditional success.
    const entries = collectEntries({ since: getLastTag() })
    assert.ok(entries.length > 0, 'empty output requires a non-empty internal-only range')
    const parsed = entries.map(parseCommitLine)
    assert.ok(
      parsed.every(
        (entry) =>
          !entry ||
          (entry.refs.length === 0 &&
            !['feat', 'perf', 'docs', 'fix', 'security'].includes(entry.type)),
      ),
      'empty output is only valid when the range has no user-facing commits or issue references',
    )
    return
  }

  assert.match(stdout, /## 🆕 What's New/)
  assert.match(stdout, /## 🐞 Fixed/)
})

test('CLI --draft exits 0 without reading tags and prints markdown', () => {
  const { status, stdout, stderr } = runCli(['--draft'])
  assert.equal(status, 0, stderr)
  assert.match(stderr, /draft mode — last 30 commits \(no tag lookup\)/)
  assert.match(stdout, /## (🆕 What's New|🐞 Fixed)/)
})

test('CLI --known-issues emits the ⚠️ Known Issues section', () => {
  const { status, stdout, stderr } = runCli([
    '--draft',
    '--known-issues',
    'Upstream Gemini API may rate-limit',
  ])
  assert.equal(status, 0, stderr)
  assert.match(stdout, /## ⚠️ Known Issues\n- Upstream Gemini API may rate-limit/)
})
