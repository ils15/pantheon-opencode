import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
)

test('CI dependency installation and required gates are fail-closed', () => {
  assert.doesNotMatch(workflow, /npm ci[^\n]*\|\|[^\n]*npm install/)
  assert.doesNotMatch(workflow, /(?:pytest|npm audit)[^\n]*\|\|/)
  for (const command of [
    'npm run lint',
    'npm run typecheck',
    'npm run test:ts',
    'npm run test:node',
    'npm run test:ci',
    'npm run audit',
  ]) {
    assert.ok(workflow.includes(command), `CI must run ${command}`)
  }
})

test('CI validates YAML and installs locked dependencies only', () => {
  assert.match(workflow, /python3 scripts\/ci-validate-yaml\.py/)
  assert.match(workflow, /npm ci --ignore-scripts/)
  assert.doesNotMatch(workflow, /echo ["']?(?:test|audit) warnings/i)
})
