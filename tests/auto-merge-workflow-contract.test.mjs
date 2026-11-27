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

function jobSection(id) {
  const start = withoutComments.search(new RegExp(`^ {2}${id}:$`, 'm'))
  assert.notEqual(start, -1, `auto-merge.yml must define the "${id}" job`)
  const rest = withoutComments.slice(start)
  const next = rest.slice(1).search(/^ {2}[a-z][a-z0-9-]*:$/m)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

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

test('owner-authored, non-draft PRs on the exact CI head SHA only', () => {
  const job = jobSection('auto-merge')
  assert.match(job, /author\.login/, 'the author must be checked')
  assert.match(job, /GITHUB_REPOSITORY_OWNER/, 'only the repository owner may auto-merge')
  assert.match(job, /headRepositoryOwner/, 'fork PRs must be refused before --delete-branch')
  assert.match(job, /isDraft/, 'draft PRs must be refused')
  assert.match(job, /baseRefName/, 'the base branch must be asserted explicitly')
  assert.match(job, /"main"/, 'only PRs targeting main may auto-merge')
  assert.match(job, /headRefOid/, 'a newer push than the CI run must invalidate the merge')
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

test('the merge is direct squash, never --auto', () => {
  const job = jobSection('auto-merge')
  assert.match(job, /gh pr merge[^\n]*--squash/, 'the merge must be a squash merge')
  assert.match(job, /gh pr merge[^\n]*--delete-branch/, 'the merged branch must be deleted')
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
  assert.match(
    audit,
    /CodeQL[\s\S]{0,160}Analyze/,
    'the CodeQL check must be matched by its real name',
  )
})
