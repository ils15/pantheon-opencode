/**
 * commit-lint-pr-title-contract.test.mjs — the PR title is linted as a commit.
 *
 * Incident this pins: PR #519 passed `Commit Lint` on all four of its commits,
 * then the push run on main failed on the squash commit —
 *   ✖   subject must not be sentence-case  [subject-case]
 * because a squash subject is derived from the PR TITLE, and nothing validated
 * the title. The one artifact that actually lands was the only one unchecked.
 *
 * The fix has two halves, both asserted here:
 *   1. `commit-lint.yml` lints `github.event.pull_request.title` and re-runs on
 *      `edited` (a retitled PR must be re-linted).
 *   2. `commitlint.config.cjs` swaps the acronym-intolerant built-in
 *      `subject-case` for the local `acronym-subject-case` rule, so a
 *      legitimate title such as `OIDC-capable dist-tag writes` passes while
 *      Title Case still fails.
 *
 * Run: node --test tests/commit-lint-pr-title-contract.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'commit-lint.yml')
const CONFIG_PATH = join(ROOT, 'commitlint.config.cjs')
const PLUGIN_PATH = join(ROOT, 'scripts', 'commitlint-acronym-subject-case.mjs')
const COMMITLINT_BIN = join(ROOT, 'node_modules', '.bin', 'commitlint')

const workflow = readFileSync(WORKFLOW_PATH, 'utf8')
/** Comments explain the incident; they must not satisfy (or break) a gate. */
const code = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The `commitlint` job body. Anti-vacuity: a missing job is a hard failure, so
 * deleting the job (or renaming it) fails this test instead of passing an
 * empty string through `assert.doesNotMatch`.
 */
function commitlintJob() {
  const start = code.search(/^ {2}commitlint:$/m)
  assert.notEqual(start, -1, 'commit-lint.yml must define the "commitlint" job')
  const rest = code.slice(start)
  const next = rest.slice(1).search(/^ {2}[a-z][a-z0-9-]*:$/m)
  const job = next === -1 ? rest : rest.slice(0, next + 1)
  assert.ok(job.trim().length > 0, 'the "commitlint" job must not be empty')
  return job
}

/** One `- name:` step inside a job, name line included. */
function step(jobText, name) {
  const start = jobText.search(new RegExp(`^ {6}- name: ${escapeRegExp(name)}$`, 'm'))
  assert.notEqual(start, -1, `the job must define the step "${name}"`)
  const rest = jobText.slice(start)
  const next = rest.slice(1).search(/^ {6}- name: |^ {2}[a-z][a-z0-9-]*:$/m)
  const body = next === -1 ? rest : rest.slice(0, next + 1)
  assert.ok(body.trim().length > 0, `the step "${name}" must not be empty`)
  return body
}

test('the pull_request trigger includes edited so a retitled PR is re-linted', () => {
  const trigger = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'))
  assert.match(trigger, /pull_request:/)
  const typesLine = /types:\s*\[([^\]]*)\]/.exec(trigger)
  assert.ok(typesLine, 'pull_request must declare an explicit types list')
  const types = typesLine[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  assert.ok(
    types.includes('edited'),
    `pull_request types must include "edited": ${types.join(', ')}`,
  )
  // The default-set events must not be lost by adding `edited`.
  for (const event of ['opened', 'synchronize', 'reopened']) {
    assert.ok(types.includes(event), `pull_request types must still include "${event}"`)
  }
})

test('a PR title step pipes the title into commitlint', () => {
  const job = commitlintJob()
  const titleStep = step(job, 'Lint PR title')

  assert.match(titleStep, /\$\{\{\s*github\.event\.pull_request\.title\s*\}\}/)
  assert.match(titleStep, /PR_TITLE:/)
  assert.match(titleStep, /commitlint --edit/)
  // The title is written to a file, never interpolated into the shell.
  assert.doesNotMatch(titleStep, /npx[^\n]*\$\{\{\s*github\.event\.pull_request\.title/)
  assert.match(titleStep, /if:\s*github\.event_name == 'pull_request'/)
})

test('the commit-range step is skipped when only the title changed', () => {
  const job = commitlintJob()
  const rangeStep = step(job, 'Validate commits')
  assert.match(
    rangeStep,
    /if:\s*github\.event_name != 'pull_request' \|\| github\.event\.action != 'edited'/,
  )
})

test('the config replaces the acronym-intolerant subject-case rule', () => {
  const require = createRequire(import.meta.url)
  const config = require(CONFIG_PATH)
  assert.deepEqual(config.rules['subject-case'], [0])
  assert.equal(config.rules['acronym-subject-case'][0], 2)
  const pluginRid = (config.plugins ?? []).find((entry) => entry?.rules?.['acronym-subject-case'])
  assert.ok(pluginRid, 'the config must register the local acronym-subject-case plugin')
  assert.equal(typeof pluginRid.rules['acronym-subject-case'], 'function')
})

test('the acronym allowlist is non-empty and covers OIDC', async () => {
  const { DEFAULT_ACRONYMS } = await import(PLUGIN_PATH)
  assert.ok(Array.isArray(DEFAULT_ACRONYMS))
  assert.ok(DEFAULT_ACRONYMS.length > 0, 'the acronym allowlist must not be empty')
  assert.ok(DEFAULT_ACRONYMS.includes('OIDC'), 'the allowlist must cover OIDC')
  for (const acronym of DEFAULT_ACRONYMS) {
    assert.equal(acronym, acronym.toUpperCase(), `${acronym} must be spelled in caps`)
  }
})

test('the rule tolerates acronyms and rejects Title Case', async () => {
  const { acronymSubjectCase } = await import(PLUGIN_PATH)
  const passes = (subject) => acronymSubjectCase({ subject })[0]
  const fails = (subject) => !acronymSubjectCase({ subject })[0]

  // The title of #519: rejected by the built-in rule, accepted here.
  assert.ok(passes('OIDC-capable dist-tag writes, curated v2.4.0 page'))
  assert.ok(passes('OIDC-capable dist-tag writes'))
  assert.ok(passes('Oidc-capable dist-tag writes'), 'a normal sentence start is fine')
  assert.ok(passes('OIDC'), 'an acronym-only subject is a legitimate squash subject')
  assert.ok(passes('add OIDC support'))
  // Real history must not regress: proper nouns and camelCase identifiers pass.
  assert.ok(passes('record Zenodo DOI for v1.4.3'))
  assert.ok(passes('stop asking gh pr view for baseRepository in auto-merge'))

  assert.ok(fails('Did The Thing.'))
  assert.ok(fails('Did The Thing'), 'Title Case fails even without the full stop')
  assert.ok(fails('ADD STUFF'))
  assert.ok(fails('Add Feature'))
})

test('the real commitlint CLI agrees on all five title fixtures', (t) => {
  if (!existsSync(COMMITLINT_BIN)) {
    t.skip('commitlint is not installed (run npm ci)')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-pr-title-'))
  try {
    const run = (title) => {
      try {
        execFileSync(COMMITLINT_BIN, ['--verbose'], {
          cwd: ROOT,
          input: `${title}\n`,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        return { ok: true, output: '' }
      } catch (error) {
        return { ok: false, output: String(error.stdout || '') + String(error.stderr || '') }
      }
    }

    assert.equal(run('fix(release): OIDC-capable dist-tag writes').ok, true)
    assert.equal(run('fix(release): Oidc-capable dist-tag writes').ok, true)
    assert.equal(run('fix(release): OIDC').ok, true)

    const titleCase = run('fix(release): Did The Thing.')
    assert.equal(titleCase.ok, false)
    assert.match(titleCase.output, /acronym-subject-case/)

    const unconvention = run('not a conventional commit')
    assert.equal(unconvention.ok, false)
    assert.match(unconvention.output, /type-empty/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
