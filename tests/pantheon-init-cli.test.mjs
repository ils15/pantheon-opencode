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

// The wrapper runs the doctor with cwd = repo ROOT, whose config only wires
// the bifrost MCPs — so the doctor VALIDATES the repo and exits 2 (missing
// required runtime MCPs). That exit code is the doctor's real validation
// failure, NOT a wrapper defect: the wrapper IS working (it routed the
// command and the banner was emitted). Assert the correct semantics:
//   1. The doctor actually ran → its banner `Validation profile: sandbox`
//      appears in the output (a misrouted command prints the wrapper usage
//      instead and never reaches the doctor).
//   2. The status is NOT the wrapper's usage/help code (1 = unknown command
//      → printUsage + exit(1)), which was the original bug this test caught.
//   3. Args were forwarded verbatim → the doctor never warns about an
//      unknown `--profile` option.
test('doctor wrapper forwards the packaged profile interface', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-doctor-'))
  try {
    const result = run(['doctor', '--profile', 'sandbox'], cwd)
    assert.match(result.stdout, /Validation profile: sandbox/, 'doctor executed (banner emitted)')
    assert.notEqual(result.status, 1, 'wrapper must not fall back to usage/help (original bug)')
    assert.doesNotMatch(result.stdout, /Unknown option: --profile/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
