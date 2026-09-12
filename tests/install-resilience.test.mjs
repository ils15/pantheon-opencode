/**
 * install-resilience.test.mjs — beta.5 installer resilience contracts.
 *
 * 1. Preflight: a missing python3/npm fails BEFORE any file is written
 *    (child-process run with a stripped PATH).
 * 2. Config backup: rewriting opencode.json leaves the previous content
 *    in opencode.json.bak.
 * 3. Runtime phase is non-fatal: a venv failure returns false (MCP entries
 *    must then be omitted) and never throws.
 * 4. CLI flag contracts: --opencode-version auto accepted, --components
 *    validated, unknown flags warned (not silently ignored).
 *
 * Run: node --test tests/install-resilience.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setupRuntimePhase } from '../scripts/install/opencode.mjs'
import { checkRuntimePrerequisites } from '../scripts/install/shared.mjs'

const ROOT = process.cwd()
const BIN = join(ROOT, 'bin', 'pantheon-init.mjs')

test('preflight: missing python3 fails the install before any file is written', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-preflight-'))
  try {
    const result = spawnSync(process.execPath, [BIN, 'init', '--project', '--yes', '--headless'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: '/nonexistent-dir',
        HOME: target,
        XDG_CONFIG_HOME: join(target, 'xdg'),
      },
    })
    assert.notEqual(result.status, 0, 'install must fail without python3/npm')
    assert.match(
      `${result.stderr}${result.stdout}`,
      /python3 not found|runtime prerequisites missing/,
      'failure must name the missing prerequisite',
    )
    assert.equal(
      existsSync(join(target, 'opencode.json')),
      false,
      'preflight failure must happen BEFORE the config is written',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('checkRuntimePrerequisites reports both missing tools on a stripped PATH', () => {
  const problems = checkRuntimePrerequisites({ PATH: '/nonexistent-dir' })
  assert.equal(problems.length, 2, `expected python3+npm problems, got: ${problems.join('; ')}`)
  assert.ok(problems[0].startsWith('python3'))
  assert.ok(problems[1].startsWith('npm'))
})

test('config rewrite leaves the previous content in opencode.json.bak', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-bak-'))
  try {
    await installOpenCode(target, false, false, ['agents'], {
      yes: true,
      headless: true,
      version: 'v1',
    })
    const first = readFileSync(join(target, 'opencode.json'), 'utf8')

    // User edits the config between installs; the next write must back it up.
    const edited = `${first.trimEnd()}\n// user edit\n`.replace('// user edit\n', '')
    const custom = JSON.stringify({ ...JSON.parse(first), theme: 'user-custom' }, null, 2)
    writeFileSync(join(target, 'opencode.json'), custom)
    assert.notEqual(custom, first)

    await installOpenCode(target, false, false, ['agents'], {
      yes: true,
      headless: true,
      version: 'v1',
    })

    assert.ok(existsSync(join(target, 'opencode.json.bak')), 'opencode.json.bak must exist')
    const bak = JSON.parse(readFileSync(join(target, 'opencode.json.bak'), 'utf8'))
    assert.equal(bak.theme, 'user-custom', 'bak must hold the PREVIOUS (edited) content')
    assert.notEqual(edited, '')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('runtime phase is non-fatal: venv failure returns false and warns', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-runtimefail-'))
  try {
    const stats = { created: 0, skipped: 0, errors: 0, warnings: 0 }
    const ok = setupRuntimePhase(target, { dryRun: false, clean: false, isGlobal: true }, stats, {
      setupVenv: () => {
        throw new Error('pip: no network')
      },
      healthCheck: () => ({ passed: [], warnings: [], failed: [] }),
    })
    assert.equal(ok, false, 'venv failure must return false (MCP entries omitted)')
    assert.equal(stats.warnings, 1, 'failure must surface as a warning, not a throw')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('CLI accepts --opencode-version auto and --components; warns on unknown flags', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-flags-'))
  try {
    const base = ['init', '--project', '--yes', '--headless', '--dry-run']

    const auto = spawnSync(process.execPath, [BIN, ...base, '--opencode-version', 'auto'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(auto.status, 0, `--version auto must be accepted: ${auto.stderr}`)

    const comps = spawnSync(process.execPath, [BIN, ...base, '--components', 'agents,skills'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(comps.status, 0, `--components must be accepted: ${comps.stderr}`)

    const badComps = spawnSync(process.execPath, [BIN, ...base, '--components', 'agents,wat'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.notEqual(badComps.status, 0, 'unknown component must fail fast')
    assert.match(badComps.stderr, /Invalid --components/)

    const unknown = spawnSync(process.execPath, [BIN, ...base, '--frobnicate'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(unknown.status, 0, 'unknown flag must not fail the install')
    assert.match(unknown.stderr, /Unknown option ignored: --frobnicate/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('install prunes Pantheon refs from stale install locations, keeps third-party', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-stale-refs-'))
  try {
    const seed = {
      plugin: [
        '/home/old/.nvm/versions/node/v22.22.2/lib/node_modules/pantheon-opencode/src/plugin.ts',
        '/home/old/.nvm/versions/node/v22.22.2/lib/node_modules/pantheon-opencode/src/plugins/pantheon-hooks.ts',
        '/home/old/.npm/_npx/deadbeef/node_modules/pantheon-opencode/src/plugin.ts',
        '/tmp/vendor/src/plugin.ts',
        '@scope/user-plugin',
      ],
    }
    writeFileSync(join(target, 'opencode.json'), JSON.stringify(seed, null, 2))

    await installOpenCode(target, false, false, ['agents'], {
      yes: true,
      headless: true,
      version: 'v1',
    })

    const refs = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')).plugin
    const stale = refs.filter((r) => typeof r === 'string' && r.includes('/old/'))
    assert.deepEqual(stale, [], `stale install refs must be pruned: ${JSON.stringify(refs)}`)
    assert.ok(
      refs.includes(join(ROOT, 'src', 'plugin.ts')) &&
        refs.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      'current install refs must be present',
    )
    assert.ok(refs.includes('/tmp/vendor/src/plugin.ts'), 'third-party preserved')
    assert.ok(refs.includes('@scope/user-plugin'), 'user plugin preserved')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
