/**
 * branch-protection-contract.test.mjs — the documented merge gate must match
 * the checks the repository actually produces.
 *
 * `docs/BRANCH-PROTECTION.md` and `docs/RELEASING.md` told maintainers to
 * require `plugin-v2-ts-coverage`, but the workflow job has always been
 * `plugin-ts-coverage`. A required check that does not exist can never be
 * reported, which is one of the ways a PR can look "green" while a real gate
 * is absent. This test also pins that branch protection is documented as
 * EXTERNAL configuration (it cannot live in the repo) and that the scheduled
 * audit reads the documented set.
 *
 * Run: node --test tests/branch-protection-contract.test.mjs
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (relPath) =>
  readFileSync(fileURLToPath(new URL(`../${relPath}`, import.meta.url)), 'utf8')
const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url))

const workflows = new Map(
  readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => [file, read(`.github/workflows/${file}`)]),
)

const branchProtection = read('docs/BRANCH-PROTECTION.md')
const releasing = read('docs/RELEASING.md')
const autoMerge = workflows.get('auto-merge.yml')

/** Canonical required-check list, as documented for `main`. */
const DOCUMENTED_CHECKS = [
  'validate',
  'test-suite',
  'plugin-ts-coverage',
  'commitlint',
  'security-scan',
]

/**
 * CodeQL's advanced workflow reports one check per matrix language. These are
 * the contexts the docs must register — `CodeQL` never reports on this repo.
 */
const CODEQL_CHECKS = ['Analyze (actions)', 'Analyze (javascript-typescript)']

function jobIdsIn(text) {
  return new Set([...text.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]))
}

test('every documented required check exists as a real workflow job', () => {
  const allJobIds = new Set([...workflows.values()].flatMap((text) => [...jobIdsIn(text)]))
  for (const name of DOCUMENTED_CHECKS) {
    assert.ok(
      allJobIds.has(name),
      `documented required check "${name}" has no job id in .github/workflows — ` +
        'a required check that never reports blocks or silently skips the gate',
    )
  }

  // CodeQL's check name is the matrix job name, not the workflow name.
  assert.ok(autoMerge, 'auto-merge.yml must exist')
  const codeql = workflows.get('codeql.yml')
  assert.ok(codeql, 'codeql.yml must exist')
  assert.match(
    codeql,
    /^ {2}analyze:\n(?:.*\n)*? {4}name: Analyze \(\$\{\{ matrix\.language \}\}\)$/m,
    'CodeQL must keep the matrix-named Analyze job documented in BRANCH-PROTECTION.md',
  )
  for (const name of CODEQL_CHECKS) {
    const language = name.slice('Analyze ('.length, -1)
    assert.match(
      codeql,
      new RegExp(`^ {8}- language: ${language}$`, 'm'),
      `ci must define the ${language} CodeQL matrix leg that reports "${name}"`,
    )
  }
})

test('docs register the CodeQL contexts that really report, not a phantom', () => {
  assert.doesNotMatch(
    branchProtection,
    /\{"context": "CodeQL"\}/,
    'the actionable PUT payload must not require CodeQL, which never reports on this repo',
  )
  for (const name of CODEQL_CHECKS) {
    assert.ok(
      branchProtection.includes(`{"context": "${name}"}`),
      `BRANCH-PROTECTION.md must require ${name} in the PUT payload`,
    )
  }
  assert.match(
    branchProtection,
    /check-runs[\s\S]{0,120}--jq '\.check_runs\[\]\.name'/,
    'BRANCH-PROTECTION.md must show how to discover the real check-run names',
  )
  assert.match(
    branchProtection,
    /"Analyze \(actions\)"/,
    'the verification expected-output must list Analyze (actions)',
  )
})

test('docs name the real plugin coverage job and never the phantom one', () => {
  for (const [label, text] of [
    ['docs/BRANCH-PROTECTION.md', branchProtection],
    ['docs/RELEASING.md', releasing],
  ]) {
    assert.doesNotMatch(
      text,
      /plugin-v2-ts-coverage/,
      `${label} must not document plugin-v2-ts-coverage: the job is plugin-ts-coverage`,
    )
    assert.match(
      text,
      /plugin-ts-coverage/,
      `${label} must document plugin-ts-coverage as a required check`,
    )
  }
})

test('branch protection is documented as external configuration with an audit', () => {
  assert.match(
    branchProtection,
    /external repository configuration/i,
    'BRANCH-PROTECTION.md must state that protection is external repository configuration',
  )
  assert.match(
    branchProtection,
    /protection-audit/,
    'BRANCH-PROTECTION.md must point at the scheduled protection-audit job',
  )
  assert.match(
    branchProtection,
    /manual maintainer action/i,
    'applying protection must remain a manual maintainer action',
  )
})

test('the scheduled protection audit reads the documented check set', () => {
  assert.ok(autoMerge, 'auto-merge.yml must define the protection audit')
  assert.match(autoMerge, /^ {2}protection-audit:$/m)

  const requiredMatch = autoMerge.match(/REQUIRED_CONTEXTS: '([^']+)'/)
  assert.ok(requiredMatch, 'protection-audit must declare REQUIRED_CONTEXTS')
  const audited = requiredMatch[1].split('|').filter(Boolean)
  for (const name of [...DOCUMENTED_CHECKS, ...CODEQL_CHECKS]) {
    assert.ok(
      audited.includes(name),
      `protection-audit must require "${name}" — the documented merge gate`,
    )
  }

  assert.match(
    autoMerge,
    /required_status_checks\.strict == true/,
    'protection-audit must assert strict (up-to-date) status checks',
  )
  assert.match(
    autoMerge,
    /commits\/main\/check-runs/,
    'protection-audit must cross-check required contexts against real check names',
  )
})
