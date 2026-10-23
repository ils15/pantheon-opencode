import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const CLI = join(process.cwd(), 'bin', 'pantheon-init.mjs')
const version = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
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

test('--help documents the apply-gate flags and the restore command', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-help-flags-'))
  try {
    const result = run(['--help'], cwd)
    assert.equal(result.status, 0)
    const help = result.stdout
    for (const needle of ['--yes', '-y', '--dry-run', '--headless', ' restore ', 'Exit codes']) {
      assert.ok(help.includes(needle), `help text must mention ${needle}`)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('uninstall command is exposed with project and global scope options', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-uninstall-'))
  try {
    const result = run(['uninstall', '--help'], cwd)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /--project/)
    assert.match(result.stdout, /--global/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('uninstall CLI removes owned project artifacts without touching user files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-uninstall-run-'))
  const owned = join(cwd, '.opencode', 'agents', 'zeus.md')
  const userFile = join(cwd, '.opencode', 'agents', 'user.md')
  try {
    mkdirSync(join(cwd, '.opencode', 'agents'), { recursive: true })
    writeFileSync(owned, '# managed-by: pantheon\n')
    writeFileSync(userFile, '# user agent\n')
    const result = run(['uninstall', '--project', '--force'], cwd)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(owned), false)
    assert.equal(existsSync(userFile), true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('uninstall CLI removes owned global artifacts through the real wrapper', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-uninstall-global-cwd-'))
  const globalDir = mkdtempSync(join(tmpdir(), 'pantheon-init-uninstall-global-'))
  try {
    mkdirSync(join(globalDir, 'agents'), { recursive: true })
    writeFileSync(join(globalDir, 'agents', 'zeus.md'), '# managed-by: pantheon-opencode\n')
    writeFileSync(join(globalDir, 'routing.yml'), '# managed-by: pantheon-opencode\n')
    writeFileSync(join(globalDir, 'user-routing.yml'), '# user-owned\n')

    const result = run(['uninstall', '--global', '--force'], cwd, { PANTHEON_HOME: globalDir })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(globalDir, 'agents', 'zeus.md')), false)
    assert.equal(existsSync(join(globalDir, 'routing.yml')), false)
    assert.equal(readFileSync(join(globalDir, 'user-routing.yml'), 'utf8'), '# user-owned\n')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(globalDir, { recursive: true, force: true })
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

test('V2 project config uses the plural plugin key under isolated HOME/XDG', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-v2-'))
  const home = mkdtempSync(join(tmpdir(), 'pantheon-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-xdg-'))
  try {
    const result = run(['init', '--project', '--no-mcp', '--version', 'v2', '-y'], cwd, {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
    })
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8'))
    assert.ok(Array.isArray(config.plugins))
    assert.equal(config.plugin, undefined)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})

test('explicit --components does not add runtime to the CLI install plan', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-components-scope-'))
  try {
    const result = run(
      [
        'init',
        '--project',
        '--headless',
        '--dry-run',
        '--verbose',
        '--version',
        'v1',
        '--components',
        'agents,skills',
      ],
      cwd,
    )
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const output = `${result.stdout}\n${result.stderr}`
    assert.match(output, /agents\/zeus\.md/)
    assert.match(output, /skills\/agent-coordination\/SKILL\.md/)
    assert.doesNotMatch(output, /Runtime|mcp_resources\.py|\.venv/)
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('V2 rejects both --preset spellings before writing, while V1 accepts equals syntax', () => {
  for (const presetArgs of [['--preset', 'anthropic'], ['--preset=anthropic']]) {
    const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-v2-preset-'))
    try {
      const result = run(
        ['init', '--project', '--headless', '--no-mcp', '--version', 'v2', ...presetArgs, '--yes'],
        cwd,
      )
      assert.notEqual(result.status, 0)
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /--preset is not supported for OpenCode V2/i,
      )
      assert.deepEqual(readdirSync(cwd), [])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-v1-preset-equals-'))
  try {
    const result = run(
      [
        'init',
        '--project',
        '--headless',
        '--no-mcp',
        '--version',
        'v1',
        '--components',
        'agents',
        '--preset=anthropic',
        '--yes',
      ],
      cwd,
    )
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(
      JSON.parse(readFileSync(join(cwd, '.pantheon', 'active-preset.json'), 'utf8')).preset,
      'anthropic',
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('missing or empty --preset value fails before writing', () => {
  for (const presetArgs of [['--preset'], ['--preset='], ['--preset', '--yes']]) {
    const cwd = mkdtempSync(join(tmpdir(), 'pantheon-init-preset-missing-'))
    try {
      const result = run(
        ['init', '--project', '--headless', '--no-mcp', '--version', 'v2', ...presetArgs],
        cwd,
      )
      assert.notEqual(result.status, 0)
      assert.match(`${result.stdout}\n${result.stderr}`, /--preset requires a non-empty value/i)
      assert.deepEqual(readdirSync(cwd), [])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }
})
