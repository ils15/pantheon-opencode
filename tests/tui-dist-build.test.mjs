import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'src/plugins/tui/dist')

function readDistSnapshot() {
  return Object.fromEntries(
    readdirSync(dist, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, readFileSync(join(dist, entry.name))]),
  )
}

test('a clean TUI build reproduces every packaged dist artifact byte-for-byte', () => {
  const before = readDistSnapshot()

  execFileSync('npm', ['run', 'build', '--prefix', 'src/plugins/tui'], {
    cwd: root,
    stdio: 'pipe',
  })

  const after = readDistSnapshot()
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'dist file list')
  for (const name of Object.keys(before)) {
    assert.deepEqual(after[name], before[name], `${name} must be reproducible`)
  }
})
