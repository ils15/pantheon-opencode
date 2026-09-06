import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { detectPlatforms } from '../scripts/install/shared.mjs'

const sharedSource = readFileSync('scripts/install/shared.mjs', 'utf8')

test('shared installer utilities only expose OpenCode platform detection', () => {
  assert.deepEqual(detectPlatforms(process.cwd()), ['opencode'])
  assert.doesNotMatch(sharedSource, /(?:claude|cursor|windsurf|copilot|continue|cline):/)
  assert.doesNotMatch(sharedSource, /VS Code|Visual Studio Code|\.vscode/)
  assert.doesNotMatch(sharedSource, /join\([^\n]+['"]platform['"]\)/)
})
