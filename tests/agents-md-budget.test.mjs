/**
 * agents-md-budget.test.mjs — beta-10 Fase C (context budget + anti-duplication guard).
 *
 * Every OpenCode session pays for BOTH always-loaded AGENTS.md artifacts (the
 * global one from the user config dir plus the repo-local one), so this file
 * pins two independent contracts:
 *
 *   1. Byte/line ceilings per artifact. A regression here is a silent
 *      per-session cost increase that no functional test would ever catch.
 *   2. Gate-phrase exclusivity: each gate below lives in exactly ONE of the
 *      two always-loaded artifacts, so a session never pays for it twice. A
 *      pointer in the other artifact is allowed; a restatement is not.
 *
 * Prompt files under prompts/ are hand-authored sources, not build output, so
 * their ceilings are a measured growth guard (today's bytes + 10%), not a
 * generation contract. `scripts/build-agents-md.mjs` emits only the two
 * AGENTS.md artifacts.
 *
 * Ceilings were measured from the committed artifacts after the Fase A dedupe
 * (AGENTS.global.md 9.340 B / 118 lines, AGENTS.md 1.703 B) plus an operating
 * margin: 160 B and 22 lines on the global artifact, 97 B on the project one.
 * The ceiling is a BUDGET, not a target — the artifacts deliberately sit below
 * it so a legitimate wording fix does not create pressure to raise the number.
 * Raising a ceiling is a reviewed decision, never the fix for a red test.
 *
 * Gate-phrase exclusivity also documents the two canonical homes chosen in
 * Fase A: the auth/security/coverage gate lives in the global `Test Economy`
 * section (projects only point at it), and the full TDD definition lives in
 * the project AGENTS.md Conventions (the global agent table only names roles).
 *
 * Run: node --test tests/agents-md-budget.test.mjs
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  AGENTS_GLOBAL_MD_PATH,
  AGENTS_MD_PATH,
  logicalLineCount,
} from '../scripts/build-agents-md.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const read = (path) => readFileSync(path, 'utf8')
const bytes = (path) => Buffer.byteLength(read(path), 'utf8')

/** Always-loaded artifacts and their hard ceilings. */
const ARTIFACT_BUDGETS = [
  {
    label: 'AGENTS.global.md',
    path: AGENTS_GLOBAL_MD_PATH,
    maxBytes: 9_500,
    maxLines: 140,
  },
  {
    label: 'AGENTS.md',
    path: AGENTS_MD_PATH,
    maxBytes: 1_800,
  },
]

/**
 * prompts/ growth guard: measured bytes today + 10%, rounded up to a multiple
 * of 50 so the ceiling is stable against rounding noise. A prompt that grows
 * past this needs an explicit, reviewed ceiling bump.
 */
const PROMPT_BUDGETS = {
  'debug-issue.prompt.md': 1_350,
  'focus.prompt.md': 1_200,
  'implement-feature.prompt.md': 2_250,
  'optimize-database.prompt.md': 1_450,
  'orchestrate-with-zeus.prompt.md': 16_000,
  'plan-architecture.prompt.md': 1_700,
  'quick-discovery-large-codebase.prompt.md': 8_450,
  'quick-plan-large-feature.prompt.md': 7_100,
  'semantic-summarize.md': 2_800,
  'sketch.prompt.md': 2_150,
  'subtask.prompt.md': 6_400,
}

/** Ceiling for a prompt file that has no measured baseline yet. */
const DEFAULT_PROMPT_BUDGET = 7_100

const REDUCE_HINT =
  'To reduce: delete a restated rule (each rule lives in one artifact), tighten prose, or move agent-scoped text into src/instructions/*.instructions.md with an explicit `agents: [...]` selector so it renders only into that agent prompt.'

function budgetFailure(label, actual, ceiling, unit) {
  return `${label} is ${actual} ${unit}, over its ${ceiling} ${unit} ceiling (+${
    actual - ceiling
  }). ${REDUCE_HINT}`
}

test('always-loaded artifacts stay inside their byte and line ceilings', () => {
  for (const { label, path, maxBytes, maxLines } of ARTIFACT_BUDGETS) {
    const actualBytes = bytes(path)
    assert.ok(actualBytes <= maxBytes, budgetFailure(label, actualBytes, maxBytes, 'bytes'))
    if (maxLines !== undefined) {
      const actualLines = logicalLineCount(read(path))
      assert.ok(
        actualLines <= maxLines,
        `${label} is ${actualLines} lines, over its ${maxLines}-line ceiling (${
          actualLines - maxLines
        }). ${REDUCE_HINT}`,
      )
    }
  }
})

test('every prompts/ file has a measured ceiling and stays under it', () => {
  const dir = join(ROOT, 'prompts')
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort()

  for (const file of files) {
    const ceiling = PROMPT_BUDGETS[file] ?? DEFAULT_PROMPT_BUDGET
    const actual = bytes(join(dir, file))
    assert.ok(
      actual <= ceiling,
      `prompts/${file} is ${actual} bytes, over its ${ceiling}-byte ceiling (+${
        actual - ceiling
      }). ` +
        'Update PROMPT_BUDGETS only after reviewing why the prompt needs to grow, or move detail into a skill/reference file.',
    )
  }

  // A prompt added without a baseline entry silently inherits the default
  // ceiling; make that visible instead of implicit.
  const unmeasured = files.filter((file) => !(file in PROMPT_BUDGETS))
  assert.deepEqual(
    unmeasured,
    [],
    `prompts/${unmeasured.join(', prompts/')} has no measured ceiling; add one to PROMPT_BUDGETS (measured bytes + 10%).`,
  )
})

test('prompt ceilings are not stale padding above measured usage', () => {
  const dir = join(ROOT, 'prompts')
  for (const [file, ceiling] of Object.entries(PROMPT_BUDGETS)) {
    const actual = bytes(join(dir, file))
    assert.ok(
      actual <= ceiling,
      `prompts/${file} exceeds its measured ceiling (${actual} > ${ceiling})`,
    )
    assert.ok(
      ceiling <= Math.ceil((actual * 1.25) / 50) * 50,
      `prompts/${file} ceiling (${ceiling}) is more than 25% above measured usage (${actual}); tighten the ceiling so growth stays reviewed`,
    )
  }
})

/** Gate phrases that must live in exactly one always-loaded artifact. */
const GATE_PHRASES = [
  ['iris-approval-gate', 'Never pushes or merges without explicit human approval'],
  ['apollo-read-only', 'No edits, no commands'],
  ['athena-zeus-plan-only', 'never implements'],
  ['sandbox-not-dev-env', 'NUNCA no ambiente de dev'],
  ['memory-no-secrets', 'Never store secrets, credentials, or tokens'],
  ['coverage-and-security-gates', 'does NOT weaken stronger gates'],
  ['worktree-path', '<project-parent>/.pantheon-worktrees/<basename-do-repo>/<task>'],
  ['tdd-cycle-definition', 'RED→GREEN→REFACTOR'],
  ['subtask-files-changed', '**files_changed:**'],
  ['subtask-summary-field', '**summary:**'],
  ['subtask-tests-field', '**tests:**'],
  ['subtask-coverage-field', '**coverage:**'],
  ['subtask-tokens-field', '**tokens:**'],
  ['subtask-status-field', '**status:**'],
  ['subtask-blockers-field', '**blockers:**'],
]

const normalize = (text) => text.replace(/\s+/g, ' ').toLowerCase()

test('each gate phrase appears in exactly one always-loaded artifact', () => {
  const artifacts = [
    { label: 'AGENTS.global.md', text: normalize(read(AGENTS_GLOBAL_MD_PATH)) },
    { label: 'AGENTS.md', text: normalize(read(AGENTS_MD_PATH)) },
  ]

  for (const [id, phrase] of GATE_PHRASES) {
    const needle = normalize(phrase)
    const hits = artifacts.filter((artifact) => artifact.text.includes(needle))
    assert.equal(
      hits.length,
      1,
      hits.length === 0
        ? `gate "${id}" (${phrase}) is in neither always-loaded artifact; keep it in exactly one.`
        : `gate "${id}" (${phrase}) is duplicated across ${hits
            .map((hit) => hit.label)
            .join(' + ')}; keep the rule in one and leave at most a short pointer in the other.`,
    )
  }
})

test('budget tests are wired into the default suite and the CI release gate', () => {
  const pkg = JSON.parse(read(join(ROOT, 'package.json')))
  assert.match(
    pkg.scripts['test:node'],
    /tests\/\*\.mjs/,
    'test:node must keep collecting tests/*.mjs so this file runs in the default suite',
  )

  const ci = read(join(ROOT, '.github', 'workflows', 'ci.yml'))
  assert.match(
    ci,
    /run: npm run test:node/,
    'CI must keep running npm run test:node, which collects this guard',
  )
  assert.ok(basename(AGENTS_GLOBAL_MD_PATH) === 'AGENTS.global.md', 'artifact path sanity check')
})
