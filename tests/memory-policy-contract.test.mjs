import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT } from '../scripts/install/shared.mjs'

test('V2 memory retrieval is an explicit MCP call, with no ambient injection hook', () => {
  const plugin = readFileSync(join(ROOT, 'src', 'plugin-v2.ts'), 'utf8')
  for (const retiredReference of [
    'memory-context.ts',
    'memoryInjectionCache',
    'applyMemoryInjection',
  ]) {
    assert.equal(
      plugin.includes(retiredReference),
      false,
      `plugin still references ${retiredReference}`,
    )
  }
  assert.equal(existsSync(join(ROOT, 'src', 'pantheon', 'memory-context.ts')), false)
})
