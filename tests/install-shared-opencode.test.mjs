import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectPlatforms } from '../scripts/install/shared.mjs'

test('shared installer utilities only expose OpenCode platform detection', () => {
  assert.deepEqual(detectPlatforms(process.cwd()), ['opencode'])
})
