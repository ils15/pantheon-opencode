/**
 * auto-merge-workflow-contract.test.mjs — a red CI run can never merge.
 *
 * Incident this pins: the previous auto-merge workflow ran on
 * `pull_request: [opened, ...]` and executed `gh pr merge --auto --squash`.
 * With no required status checks configured, `--auto` had nothing to wait for
 * and merged immediately — PR #494 merged 2 seconds AFTER `test-suite` went
 * red. The gate is now the CI conclusion for the PR head, and the merge is a
 * direct `gh pr merge` (never `--auto`).
 *
 * Run: node --test tests/auto-merge-workflow-contract.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const autoMerge = readFileSync(
  fileURLToPath(new URL('../.github/workflows/auto-merge.yml', import.meta.url)),
  'utf8',
)

/** Comments explain the incident; they must not satisfy (or break) a gate. */
const withoutComments = autoMerge
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function jobSection(id) {
  const start = withoutComments.search(new RegExp(`^ {2}${id}:$`, 'm'))
  assert.notEqual(start, -1, `auto-merge.yml must define the "${id}" job`)
  const rest = withoutComments.slice(start)
  const next = rest.slice(1).search(/^ {2}[a-z][a-z0-9-]*:$/m)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

/** Return one `- name:` step (env + run) inside a job section. */
function stepSection(jobText, name) {
  const start = jobText.search(new RegExp(`^ {6}- name: ${escapeRegExp(name)}$`, 'm'))
  assert.notEqual(start, -1, `the job must define the step "${name}"`)
  const rest = jobText.slice(start)
  const next = rest.slice(1).search(/^ {6}- name: |^ {2}[a-z][a-z0-9-]*:$/m)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

/** Just the shell program of a step (env `${{ }}` mappings are not shell). */
function runBlock(stepText) {
  const index = stepText.indexOf('run:')
  assert.notEqual(index, -1, 'the step must have a run block')
  return stepText.slice(index)
}

const jqAvailable = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0
const skipWithoutJq = jqAvailable ? false : 'jq is required by the merge path anyway'

test('auto-merge is triggered by a completed CI run, never by PR events', () => {
  assert.match(withoutComments, /^ {2}workflow_run:$/m, 'the trigger must be workflow_run')
  assert.match(withoutComments, /workflows: \['CI'\]/, 'the trigger must watch the CI workflow')
  assert.match(withoutComments, /types: \[completed\]/, 'only completed runs may trigger a merge')
  assert.doesNotMatch(
    withoutComments,
    /^ {4}branches: \[main\]$/m,
    'workflow_run.branches matches the run HEAD branch; PR runs report the PR branch, ' +
      'so this filter would silently disable auto-merge',
  )
  assert.doesNotMatch(
    withoutComments,
    /^ {2}pull_request:$/m,
    'a pull_request trigger merges before CI has a conclusion — the exact PR #494 bug',
  )
})

test('the merge job only runs for a successful pull_request CI run', () => {
  const job = jobSection('auto-merge')
  assert.match(
    job,
    /github\.event\.workflow_run\.event == 'pull_request'/,
    'push runs on main must not re-enter the PR merge path',
  )
  assert.match(
    job,
    /github\.event\.workflow_run\.conclusion == 'success'/,
    'a red or cancelled CI run must never reach the merge command',
  )
  assert.match(job, /runs-on: ubuntu-latest/)
})

test('the PR is resolved from the CI run, not guessed', () => {
  const job = jobSection('auto-merge')
  assert.match(
    job,
    /workflow_run\.pull_requests\[0\]\.number/,
    'the PR number must come from the run that just passed',
  )
  assert.match(
    job,
    /HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
    'the resolved PR must be tied to the SHA the CI run actually tested',
  )
  assert.match(
    job,
    /commits\/\$\{HEAD_SHA\}\/pulls/,
    'a run without pull_requests must resolve the PR from the head SHA',
  )
})

test('the resolve step never interpolates a workflow expression into shell', () => {
  const resolve = stepSection(
    jobSection('auto-merge'),
    'Resolve the pull request that produced this CI run',
  )
  assert.doesNotMatch(
    runBlock(resolve),
    /\$\{\{/,
    'expressions must be mapped through env:, never spliced into the shell program',
  )
  assert.match(
    resolve,
    /RUN_PR_NUMBER: \$\{\{ github\.event\.workflow_run\.pull_requests\[0\]\.number \}\}/,
    'the PR number must arrive through env:',
  )
})

test('owner-authored, non-draft PRs on the exact CI head SHA only', () => {
  const job = jobSection('auto-merge')
  assert.match(job, /author\.login/, 'the author must be checked')
  assert.match(job, /GITHUB_REPOSITORY_OWNER/, 'only the repository owner may auto-merge')
  assert.match(job, /headRepositoryOwner/, 'fork PRs must be refused before --delete-branch')
  assert.match(job, /isDraft/, 'draft PRs must be refused')
  assert.match(job, /baseRefName/, 'the base branch must be asserted explicitly')
  assert.match(job, /"main"/, 'only PRs targeting main may auto-merge')
  assert.match(job, /headRefOid/, 'a newer push than the CI run must invalidate the merge')
  assert.match(job, /"\$head" != "\$HEAD_SHA"/, 'the head must be compared to the tested SHA')
})

test('the merge requires a clean, mergeable PR and no skipped required check', () => {
  const job = jobSection('auto-merge')
  assert.match(job, /mergeable,mergeStateStatus/, 'GitHub mergeability must be read explicitly')
  assert.match(job, /MERGEABLE\/CLEAN/, 'only MERGEABLE/CLEAN may merge')
  assert.match(job, /gh pr checks/, 'the check list must be read explicitly')
  assert.match(
    job,
    /REQUIRED_CHECKS:[^\n]*\btest-suite\b/,
    'test-suite must be asserted by name: a skipped required job reports "skipped"',
  )
  assert.match(
    job,
    /REQUIRED_CHECKS:[^\n]*\bplugin-ts-coverage\b/,
    'plugin-ts-coverage must be asserted by name: a skipped required job reports "skipped"',
  )
  assert.match(job, /"SUCCESS"/, 'only a SUCCESS state counts as passing')
})

test('empty or malformed gh pr checks output can never reach the merge', {
  skip: skipWithoutJq,
}, () => {
  const checksStep = stepSection(
    jobSection('auto-merge'),
    'Require required checks to be SUCCESS, not skipped',
  )
  const guard = runBlock(checksStep).match(/\| jq -e '([^']+)' >\/dev\/null/)
  assert.ok(
    guard,
    'the checks step must validate that gh pr checks returned a non-empty JSON array',
  )
  const program = guard[1]

  for (const [label, fixture] of [
    ['no output', ''],
    ['null', 'null'],
    ['object', '{}'],
    ['empty array', '[]'],
    ['garbage', 'not-json'],
    ['string', '"checks"'],
  ]) {
    const result = spawnSync('jq', ['-e', program], { input: fixture, encoding: 'utf8' })
    assert.notEqual(
      result.status,
      0,
      `${label} check data must fail the guard, not merge unverified (exit ${result.status})`,
    )
  }

  const valid = spawnSync('jq', ['-e', program], {
    input: '[{"name":"validate","state":"SUCCESS"}]',
    encoding: 'utf8',
  })
  assert.equal(valid.status, 0, 'a non-empty array must pass the guard so per-check filtering runs')
})

test('the required-check filter refuses a SKIPPED required job', { skip: skipWithoutJq }, () => {
  const filter = withoutComments.match(
    /jq -r --arg required "\$REQUIRED_CHECKS" '\n([\s\S]*?)\n\s*'\)"/,
  )
  assert.ok(filter, 'the checks step must filter required names by SUCCESS state')

  const required = 'validate test-suite plugin-ts-coverage commitlint security-scan'
  const run = (input) =>
    spawnSync('jq', ['-r', '--arg', 'required', required, filter[1]], {
      input,
      encoding: 'utf8',
    }).stdout.trim()

  assert.equal(
    run(
      JSON.stringify([
        { name: 'validate', state: 'SUCCESS' },
        { name: 'test-suite', state: 'SKIPPED' },
        { name: 'plugin-ts-coverage', state: 'SUCCESS' },
        { name: 'commitlint', state: 'SUCCESS' },
        { name: 'security-scan', state: 'SUCCESS' },
      ]),
    ),
    'test-suite',
    'a skipped required job must be reported as missing',
  )
  assert.equal(
    run(
      JSON.stringify([
        { name: 'validate', state: 'SUCCESS' },
        { name: 'test-suite', state: 'SUCCESS' },
        { name: 'plugin-ts-coverage', state: 'SUCCESS' },
        { name: 'commitlint', state: 'SUCCESS' },
        { name: 'security-scan', state: 'SUCCESS' },
      ]),
    ),
    '',
    'all-SUCCESS checks must produce an empty missing list',
  )
})

test('the merge is direct squash, bound to the tested SHA, never --auto', () => {
  const job = jobSection('auto-merge')
  const merge = stepSection(job, 'Merge (squash, delete branch)')

  assert.match(merge, /gh pr merge[^\n]*--squash/, 'the merge must be a squash merge')
  assert.match(merge, /gh pr merge[^\n]*--delete-branch/, 'the merged branch must be deleted')
  assert.match(
    merge,
    /--match-head-commit "\$HEAD_SHA"/,
    'the merge must refuse a head that moved after the checks read (TOCTOU)',
  )
  assert.match(
    merge,
    /HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
    '--match-head-commit must bind the same SHA the CI run tested',
  )
  assert.doesNotMatch(
    withoutComments,
    /--auto\b/,
    '`--auto` waits for nothing when no required checks exist; the CI conclusion is the gate',
  )
})

test('PR_MERGE_TOKEN is kept so the merge push triggers CI on main', () => {
  const job = jobSection('auto-merge')
  assert.match(
    job,
    /secrets\.PR_MERGE_TOKEN/,
    'GITHUB_TOKEN merges do not trigger push workflows, leaving main without CI evidence',
  )
})

test('the scheduled protection audit is non-blocking and asserts the contract', () => {
  assert.match(withoutComments, /^ {2}schedule:$/m, 'the audit must run on a schedule')
  assert.match(withoutComments, /^ {2}workflow_dispatch:$/m, 'the audit must be manually runnable')

  const audit = jobSection('protection-audit')
  assert.match(
    audit,
    /github\.event_name == 'schedule'/,
    'the audit must not run (and cannot block) on pull_request or workflow_run',
  )
  assert.match(
    audit,
    /github\.event_name == 'workflow_dispatch'/,
    'the audit must be manually runnable for the same non-blocking path',
  )
  assert.match(audit, /branches\/main\/protection/, 'the audit must read main protection')
  assert.match(audit, /required_status_checks\.strict == true/, 'strict must be asserted')
  assert.match(audit, /REQUIRED_CONTEXTS/, 'the documented contexts must be declared')
})

test('the protection audit is read-only', () => {
  const audit = jobSection('protection-audit')
  assert.match(
    audit,
    /permissions:\n\s+contents: read\n\s+pull-requests: read/,
    'the audit only reads; it must not inherit contents/pull-requests write',
  )
})

test('the protection audit rejects required contexts that never report', () => {
  const audit = jobSection('protection-audit')
  assert.match(
    audit,
    /--paginate/,
    'the check-runs read must paginate: >100 checks truncates and creates false phantoms',
  )
  assert.match(
    audit,
    /if \[ -z "\$reporting" \]/,
    'an empty reporting set must be a hard error, not an empty phantom list',
  )
  assert.match(
    audit,
    /::error::no check runs reported/,
    'the empty-reporting error must be explicit',
  )
})

test('the phantom remediation is non-destructive and names the bootstrap window', () => {
  const audit = jobSection('protection-audit')
  assert.match(
    audit,
    /Do NOT remove a context that still protects pull requests/,
    'the remediation must not tell maintainers to delete a protecting context',
  )
  assert.match(
    audit,
    /push trigger/i,
    'the remediation must point at a missing push trigger as the likely cause',
  )
  assert.match(
    audit,
    /bootstrap/i,
    'the message must acknowledge the window before the first push-triggered run',
  )
  assert.doesNotMatch(
    audit,
    /protection\.json/,
    'the remediation must not reference a protection payload file that does not exist',
  )
  assert.doesNotMatch(audit, /remove the phantom/i, 'the old destructive wording must be gone')
  assert.doesNotMatch(audit, /-X PATCH|--method PATCH/, 'protection updates are PUT, not PATCH')
})

test('the phantom jq program is empty only for healthy protection fixtures', {
  skip: skipWithoutJq,
}, () => {
  const step = stepSection(
    jobSection('protection-audit'),
    'Assert main branch protection matches the checks that really report',
  )
  const program = runBlock(step).match(/jq -r --arg names "\$reporting" '\n([\s\S]*?)\n\s*'\)"/)
  assert.ok(program, 'the audit must compute phantom contexts from the reporting names')

  const phantom = (protection, reporting) => {
    const result = spawnSync('jq', ['-r', '--arg', 'names', reporting, program[1]], {
      input: JSON.stringify(protection),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const protection = (contexts) => ({ required_status_checks: { checks: contexts } })

  assert.equal(
    phantom(
      protection([
        { context: 'validate' },
        { context: 'test-suite' },
        { context: 'Analyze (actions)' },
      ]),
      'validate\ntest-suite\nAnalyze (actions)',
    ),
    '',
    'required contexts that all report must produce no phantom',
  )
  assert.equal(
    phantom(protection([{ context: 'CodeQL' }]), 'validate\ntest-suite'),
    'CodeQL',
    'a required context that never reports must be a phantom',
  )
  assert.equal(
    phantom(protection([{ context: 'Analyze (actions)' }]), 'validate\ntest-suite'),
    'Analyze (actions)',
    'a CodeQL matrix leg with no main-head run must be a phantom',
  )
  assert.equal(
    phantom(protection([{ context: 'validate' }]), ''),
    'validate',
    'an empty reporting string must not silently satisfy required contexts',
  )
})
