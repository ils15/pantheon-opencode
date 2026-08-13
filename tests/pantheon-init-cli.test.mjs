import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const CLI = join(process.cwd(), 'bin', 'pantheon-init.mjs')
const version = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
}

for (const flag of ['--version', '-v']) {
  test(`${flag} prints only the package version and does not install`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-version-'))
    try {
      const result = run([flag], cwd)
      assert.equal(result.status, 0)
      assert.equal(result.stdout, `${version}\n`)
      assert.equal(result.stderr, '')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}

test('--help documents version flags without mutating the cwd', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-help-'))
  try {
    const result = run(['--help'], cwd)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /--version, -v/)
    assert.equal(result.stderr, '')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('doctor wrapper forwards the packaged profile interface', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-doctor-'))
  try {
    const result = run(['doctor', '--profile', 'sandbox'], cwd)
    assert.notEqual(result.status, 2, result.stderr || result.stdout)
    assert.doesNotMatch(result.stdout, /Unknown option: --profile/)
    assert.match(result.stdout, /Validation profile: sandbox/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
