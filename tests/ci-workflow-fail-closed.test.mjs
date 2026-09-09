import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('CI package evidence verification preserves failures and remains blocking', () => {
  const match = workflow.match(/- name: Verify package\n\s+run: ([^\n]+)/)
  assert.ok(match, 'CI must define a package verification step')
  const command = match[1].trim()
  const packageStep = workflow.match(/- name: Verify package\n[\s\S]*?(?=\n\s{2}version-check:)/)
  assert.ok(packageStep, 'CI package verification step must be present in the validate job')

  assert.match(command, /^npm run package:evidence -- /)
  assert.match(command, /--target-sha="\$\(git rev-parse HEAD\)"/)
  assert.doesNotMatch(
    command,
    /\|(?:\s|$)/,
    'package evidence must not be piped to a masking command',
  )
  assert.doesNotMatch(
    command,
    /\|\|/,
    'package evidence must not have a fallback that masks failure',
  )
  assert.doesNotMatch(packageStep[0], /continue-on-error:\s*true/)

  const binDir = mkdtempSync(join(tmpdir(), 'ci-pack-contract-'))
  const fakeNpm = join(binDir, 'npm')
  writeFileSync(fakeNpm, '#!/bin/sh\nexit 37\n')
  chmodSync(fakeNpm, 0o755)

  try {
    const result = spawnSync('bash', ['-c', command], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    assert.equal(result.status, 37, 'package evidence failure must fail the workflow step')
  } finally {
    rmSync(binDir, { recursive: true, force: true })
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
