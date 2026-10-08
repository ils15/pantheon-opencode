import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const biome = JSON.parse(readFileSync(new URL('biome.json', root), 'utf8'))

const allowedExclusions = [
  '!src/plugins/tui/dist',
  '!tests/integration',
  '!.mypy_cache',
  '!.pytest_cache',
  '!.ruff_cache',
  '!.venv',
  '!.opencode',
  '!.pantheon/autocontinue',
  '!.pantheon/board',
  '!.pantheon/deepwork/board-signals',
  '!.pantheon/goals',
  '!logs',
]

function exclusionMatchesPath(pattern, filePath) {
  const glob = pattern.slice(1).replaceAll('\\', '/')
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escaped.replaceAll('**', '.*').replaceAll('*', '[^/]*')}(?:/.*)?$`)
  return regex.test(filePath)
}

test('Biome exclusions are restricted to approved generated and non-source paths', () => {
  assert.ok(biome.files.includes.includes('**'), 'Biome must keep its repository-wide lint surface')
  const excludes = biome.files.includes.filter((entry) => entry.startsWith('!')).sort()
  assert.deepEqual(excludes, [...allowedExclusions].sort())
})

test('Biome exclusions do not cover application or fixture source', () => {
  const excludes = biome.files.includes.filter((entry) => entry.startsWith('!'))
  const protectedFiles = [
    'src/plugin.ts',
    'scripts/versioning.mjs',
    'src/plugins/tui/src/index.ts',
    '.pantheon/code-mode/checkpoint_session.py',
    'tests/fixtures/opencode-v2-hook-canary/index.ts',
  ]

  for (const filePath of protectedFiles) {
    assert.equal(
      excludes.some((pattern) => exclusionMatchesPath(pattern, filePath)),
      false,
      `${filePath} must remain in the Biome lint surface`,
    )
  }
})
