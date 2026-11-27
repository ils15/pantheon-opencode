/**
 * gh-json-fields-contract.test.mjs — an invalid `gh --json` field must fail
 * here, not at runtime inside a `set -euo pipefail` step.
 *
 * Incident: `.github/workflows/auto-merge.yml` asked `gh pr view` for
 * `baseRepository`. That node exists in GraphQL but is NOT in `gh pr view
 * --json`'s allowlist in any gh version, so the command substitution exited
 * non-zero and aborted the step BEFORE the author/fork/base/draft/SHA
 * assertions ran. Auto-merge never succeeded after PR #507 merged and nothing
 * was red, because the command was never in a required check.
 *
 * Two contracts are pinned here for every workflow file:
 *   1. every field in a `gh <subcommand> … --json a,b,c` call is accepted by
 *      that subcommand (allowlist pinned below, cross-checked against the local
 *      `gh` binary when it supports `--json` for that subcommand);
 *   2. every `steps.<id>.outputs.<key>` and `env.NAME` expression reference has
 *      a producer/declaration earlier in the same workflow.
 *
 * Run: node --test tests/gh-json-fields-contract.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url))
const INVALID_FIELD = '__pantheon_invalid_field__'

/**
 * Pinned allowlists. Source of truth is the gh CLI itself, not this file:
 *   - `pr view`:  `gh pr view --json __nope__` (gh 2.45.0 here) prints
 *                 "Available fields:"; the same list is in cli/cli
 *                 pkg/cmd/pr/view/view.go. `baseRepository` is absent — that is
 *                 the bug this file exists to catch.
 *   - `pr checks`: local gh 2.45.0 predates the flag entirely
 *                 (`unknown flag: --json`), so this list is pinned from
 *                 `prCheckFields` in cli/cli pkg/cmd/pr/checks/checks.go. The
 *                 flag landed 2024-05-14 and the runner's gh (ubuntu-24.04
 *                 image: 2.105.0) is far newer, so the runner accepts it.
 *                 When the local binary does support it, the derivation below
 *                 validates this list automatically.
 * The derivation is a cross-check, never the only gate: a run without `gh`
 * still enforces the pinned lists.
 */
const PINNED_ALLOWLISTS = {
  'pr view': [
    'additions',
    'assignees',
    'author',
    'autoMergeRequest',
    'baseRefName',
    'body',
    'changedFiles',
    'closed',
    'closedAt',
    'comments',
    'commits',
    'createdAt',
    'deletions',
    'files',
    'headRefName',
    'headRefOid',
    'headRepository',
    'headRepositoryOwner',
    'id',
    'isCrossRepository',
    'isDraft',
    'labels',
    'latestReviews',
    'maintainerCanModify',
    'mergeCommit',
    'mergeStateStatus',
    'mergeable',
    'mergedAt',
    'mergedBy',
    'milestone',
    'number',
    'potentialMergeCommit',
    'projectCards',
    'projectItems',
    'reactionGroups',
    'reviewDecision',
    'reviewRequests',
    'reviews',
    'state',
    'statusCheckRollup',
    'title',
    'updatedAt',
    'url',
  ],
  'pr checks': [
    'name',
    'state',
    'startedAt',
    'completedAt',
    'link',
    'bucket',
    'event',
    'workflow',
    'description',
  ],
}

/** Comments explain incidents; they must neither satisfy nor break a gate.
 *  They are blanked (not deleted) so reported line numbers stay exact. */
function withoutComments(text) {
  return text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n')
}

/** Join `\`-continued shell lines so a multi-line gh call is one logical line.
 *  Emits `{ line, text }` where `line` is the first physical line (1-based). */
function logicalLines(code) {
  const lines = code.split('\n')
  const logical = []
  for (let index = 0; index < lines.length; index += 1) {
    let text = lines[index]
    let consumed = 0
    while (/\\$/.test(text) && index + consumed + 1 < lines.length) {
      consumed += 1
      text = `${text.replace(/\\$/, '')} ${lines[index + consumed].trim()}`
    }
    logical.push({ line: index + 1, text })
    index += consumed
  }
  return logical
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort()

assert.ok(workflowFiles.length > 0, `.github/workflows must contain workflow files`)

const workflows = workflowFiles.map((name) => {
  const raw = readFileSync(`${WORKFLOWS_DIR}${name}`, 'utf8')
  const code = withoutComments(raw)
  return { name, code, logicalLines: logicalLines(code) }
})

/** `gh <subcommand> … --json a,b,c` occurrences, comments removed. */
function ghJsonCalls({ name, logicalLines }) {
  const calls = []
  const pattern = /\bgh\s+([a-z][a-z-]+)(?:\s+([a-z][a-z-]+))?[^\n]*?--json\s+([A-Za-z0-9_,.-]+)/g
  for (const { line, text } of logicalLines) {
    for (const match of text.matchAll(pattern)) {
      const subcommand = match[2] ? `${match[1]} ${match[2]}` : match[1]
      calls.push({
        file: name,
        line,
        subcommand,
        fields: match[3]
          .split(',')
          .map((field) => field.trim())
          .filter(Boolean),
      })
    }
  }
  return calls
}

const derivationCache = new Map()

/**
 * Ask the local gh binary what it accepts. `--json <invalid>` is validated
 * before any network/repo resolution, so a repo-less query still answers.
 * Returns null when the binary is missing or does not support `--json` here.
 */
function derivedAllowlist(subcommand) {
  if (derivationCache.has(subcommand)) return derivationCache.get(subcommand)
  let fields = null
  try {
    const result = spawnSync('gh', [...subcommand.split(' '), '--json', INVALID_FIELD], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    const block = output.match(/Available fields:\n((?:\s{2}[A-Za-z][A-Za-z0-9]*\n?)+)/)
    if (block)
      fields = block[1]
        .split('\n')
        .map((field) => field.trim())
        .filter(Boolean)
  } catch {
    fields = null
  }
  derivationCache.set(subcommand, fields)
  return fields
}

test('every gh --json call in .github/workflows uses real fields', () => {
  const calls = workflows.flatMap(ghJsonCalls)
  assert.ok(
    calls.length > 0,
    'the extractor found no `gh … --json` calls — a silent extractor must not pass',
  )

  for (const call of calls) {
    const pinned = PINNED_ALLOWLISTS[call.subcommand]
    assert.ok(
      pinned,
      `${call.file}:${call.line}: no pinned allowlist for "gh ${call.subcommand} --json"; ` +
        'add one from that command\'s own "Available fields:" output',
    )
    for (const field of call.fields) {
      assert.ok(
        pinned.includes(field),
        `${call.file}:${call.line}: "gh ${call.subcommand} --json" rejects "${field}" ` +
          `(valid: ${pinned.join(', ')})`,
      )
    }
  }

  for (const subcommand of Object.keys(PINNED_ALLOWLISTS)) {
    const derived = derivedAllowlist(subcommand)
    if (!derived) {
      // Local gh is older than the flag (e.g. `gh pr checks --json` on 2.45.0)
      // or gh is not installed: the pinned list stands alone.
      continue
    }
    for (const field of PINNED_ALLOWLISTS[subcommand]) {
      assert.ok(
        derived.includes(field),
        `pinned "${subcommand}" field "${field}" is not accepted by the local gh; ` +
          'remove it from PINNED_ALLOWLISTS (pinned lists must stay in sync)',
      )
    }
    for (const call of calls.filter((entry) => entry.subcommand === subcommand)) {
      for (const field of call.fields) {
        assert.ok(
          derived.includes(field),
          `${call.file}:${call.line}: local gh rejects "${field}" for "${subcommand}"`,
        )
      }
    }
  }
})

test('auto-merge.yml never asks gh pr view for baseRepository again', () => {
  const offenders = workflows
    .flatMap(ghJsonCalls)
    .filter((call) => call.subcommand === 'pr view' && call.fields.includes('baseRepository'))
  assert.deepEqual(
    offenders.map((call) => `${call.file}:${call.line}`),
    [],
    'baseRepository is a GraphQL node, not a gh pr view --json field; read the base ' +
      'repository from `gh api repos/$GITHUB_REPOSITORY/pulls/<n> --jq .base.repo.full_name`',
  )
})

/** Step blocks (6-space `- ` entries) with their starting line number. */
function stepBlocks(code) {
  const blocks = []
  let current = null
  for (const [index, line] of code.split('\n').entries()) {
    if (/^ {6}- /.test(line)) {
      current = { start: index, lines: [line] }
      blocks.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  return blocks.map((block) => ({
    start: block.start,
    text: block.lines.join('\n'),
    id: block.lines.join('\n').match(/^ {8}id: ([A-Za-z0-9_-]+)$/m)?.[1] ?? null,
  }))
}

/**
 * Keys a step actually writes to $GITHUB_OUTPUT. Over-collecting assignments is
 * intentional: a missed producer is the failure this contract prevents, extra
 * matches only weaken it. A step with no $GITHUB_OUTPUT write emits nothing.
 */
function emittedKeys(stepText) {
  const keys = new Set()
  if (!/GITHUB_OUTPUT/.test(stepText)) return keys
  for (const match of stepText.matchAll(/(?:^|[^A-Za-z0-9_])([a-z][a-z0-9_]*)=/gm)) {
    keys.add(match[1])
  }
  return keys
}

test('every steps.<id>.outputs.<key> reference is produced earlier in its workflow', () => {
  let checked = 0
  for (const { name, code } of workflows) {
    const blocks = stepBlocks(code)
    for (const match of code.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
      const [, stepId, key] = match
      checked += 1
      const referenceLine = lineOf(code, match.index)
      const producers = blocks.filter(
        (block) => block.id === stepId && emittedKeys(block.text).has(key),
      )
      assert.ok(
        producers.length > 0,
        `${name}:${referenceLine}: steps.${stepId}.outputs.${key} is referenced but the ` +
          `"${stepId}" step never writes "${key}=" to $GITHUB_OUTPUT (later steps would read ` +
          'an empty string)',
      )
      assert.ok(
        producers.some((block) => block.start + 1 < referenceLine),
        `${name}:${referenceLine}: steps.${stepId}.outputs.${key} is produced only in a later ` +
          'step, so this reference reads nothing',
      )
    }
  }
  assert.ok(checked > 0, 'the extractor found no steps.<id>.outputs.<key> references')
})

test('every env.NAME expression reference is declared by an env: block', () => {
  let checked = 0
  for (const { name, code } of workflows) {
    for (const match of code.matchAll(/\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
      const [, key] = match
      checked += 1
      assert.match(
        code,
        new RegExp(`^\\s+${key}:`, 'm'),
        `${name}:${lineOf(code, match.index)}: an expression reads env.${key} but no env: ` +
          'block declares it',
      )
    }
  }
  assert.ok(checked > 0, 'the extractor found no env.NAME expression references')
})
