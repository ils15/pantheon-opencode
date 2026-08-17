import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import lint from '@commitlint/lint'
import load from '@commitlint/load'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

async function lintCommit(message) {
  const loaded = await load({}, { cwd: repoRoot })
  return lint(message, loaded.rules, loaded.parserPreset?.parserOpts)
}

test('allows the opencode-v2 migration scope', async () => {
  const result = await lintCommit('chore(opencode-v2): dual-version groundwork (#51)')

  assert.equal(result.valid, true, result.errors.map((error) => error.message).join('; '))
})

test('keeps scope, type, and subject validation strict', async () => {
  const invalidScope = await lintCommit('chore(arbitrary): dual-version groundwork')
  const invalidType = await lintCommit('change(opencode-v2): dual-version groundwork')
  const invalidSubject = await lintCommit('chore(opencode-v2):')

  assert.equal(invalidScope.valid, false)
  assert.ok(invalidScope.errors.some((error) => error.name === 'scope-enum'))
  assert.ok(invalidType.errors.some((error) => error.name === 'type-enum'))
  assert.ok(invalidSubject.errors.some((error) => error.name === 'subject-empty'))
})
