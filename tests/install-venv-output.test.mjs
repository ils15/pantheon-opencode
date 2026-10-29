import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()

function seedPipFixture(target) {
  const bin = join(target, '.venv', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const pip = join(bin, 'pip')
  writeFileSync(
    pip,
    '#!/bin/sh\nprintf "PIP_CALL %s\\n" "$*"\n' +
      'case " $* " in *" --verbose "*) printf "PIP_DIAGNOSTIC resolver detail\\n" ;; esac\n',
    { mode: 0o755 },
  )
  chmodSync(pip, 0o755)
}

function runSetupVenv(target, verbose) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { setupVenv } from './scripts/install/venv.mjs'; " +
        "setupVenv(process.env.PANTHEON_TEST_TARGET, { verbose: process.env.PANTHEON_TEST_VERBOSE === 'true' });",
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PANTHEON_TEST_TARGET: target,
        PANTHEON_TEST_VERBOSE: String(verbose),
      },
    },
  )
}

test('pip output is compact by default and includes diagnostics with --verbose', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-venv-output-'))
  const quietTarget = join(root, 'quiet')
  const verboseTarget = join(root, 'verbose')
  try {
    seedPipFixture(quietTarget)
    seedPipFixture(verboseTarget)

    const quiet = runSetupVenv(quietTarget, false)
    assert.equal(quiet.status, 0, `${quiet.stderr}\n${quiet.stdout}`)
    assert.match(quiet.stdout, /PIP_CALL install --quiet/)
    assert.doesNotMatch(quiet.stdout, /PIP_DIAGNOSTIC/)

    const verbose = runSetupVenv(verboseTarget, true)
    assert.equal(verbose.status, 0, `${verbose.stderr}\n${verbose.stdout}`)
    assert.match(verbose.stdout, /PIP_CALL install --verbose/)
    assert.match(verbose.stdout, /PIP_DIAGNOSTIC resolver detail/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
