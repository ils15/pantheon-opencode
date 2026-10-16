import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const tuiPackage = join(root, 'src/plugins/tui')
const dist = join(tuiPackage, 'dist')

function readDistSnapshot(directory) {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, readFileSync(join(directory, entry.name))]),
  )
}

test('a clean TUI build reproduces every packaged dist artifact byte-for-byte', () => {
  const before = readDistSnapshot(dist)
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'pantheon-tui-dist-build-'))
  const buildPackage = join(temporaryRoot, 'src/plugins/tui')

  try {
    mkdirSync(join(temporaryRoot, 'src/plugins'), { recursive: true })
    cpSync(join(root, 'tsconfig.json'), join(temporaryRoot, 'tsconfig.json'))
    cpSync(tuiPackage, buildPackage, {
      recursive: true,
      filter: (source) => !relative(tuiPackage, source).split(sep).includes('node_modules'),
    })
    symlinkSync(
      join(root, 'node_modules'),
      join(temporaryRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    execFileSync('npm', ['run', 'build', '--prefix', buildPackage], {
      cwd: root,
      stdio: 'pipe',
    })

    const after = readDistSnapshot(join(buildPackage, 'dist'))
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'dist file list')
    for (const name of Object.keys(before)) {
      assert.deepEqual(after[name], before[name], `${name} must be reproducible`)
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
