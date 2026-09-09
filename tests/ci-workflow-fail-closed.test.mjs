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
  assert.match(
    workflow,
    /npm ci --prefix src\/plugins\/tui --ignore-scripts/,
    'CI must install isolated TUI plugin deps from its committed lockfile so test:ts resolves solid-js',
  )
  assert.match(
    workflow,
    /pip install[^\n]*pytest-asyncio==\d+\.\d+\.\d+/,
    'CI must install locked pytest-asyncio before pytest so asyncio_mode=auto resolves async tests',
  )
  assert.match(
    workflow,
    /pip install[^\n]*-r src\/mcp\/requirements-mcp\.txt/,
    'CI must install locked MCP runtime deps before pytest so mcp/sqlite-vec imports resolve',
  )
  assert.match(
    workflow,
    /pip install[^\n]*-r src\/mcp\/requirements-vision\.txt/,
    'CI must install locked vision deps before pytest so httpx imports resolve',
  )
  assert.doesNotMatch(workflow, /pip install[^\n]*\|\|/)
  assert.ok(
    workflow.indexOf('pytest-asyncio==') < workflow.indexOf('npm run test:ci'),
    'Locked pytest-asyncio pip install must run BEFORE the pytest gate',
  )
  assert.ok(
    workflow.indexOf('requirements-mcp.txt') < workflow.indexOf('npm run test:ci'),
    'Locked MCP pip install must run BEFORE the pytest gate',
  )
  assert.ok(
    workflow.indexOf('requirements-vision.txt') < workflow.indexOf('npm run test:ci'),
    'Locked vision pip install must run BEFORE the pytest gate',
  )
  assert.doesNotMatch(workflow, /npm install(?!.*--dry-run)/)
  assert.doesNotMatch(workflow, /\|\| true/)
  assert.doesNotMatch(workflow, /echo ["']?(?:test|audit) warnings/i)
})
