import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))

test('package allowlist ships opt-in prompt templates', () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  assert.ok(packageJson.files.includes('prompts/**'))
})
