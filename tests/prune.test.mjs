/**
 * prune.test.mjs — TDD tests for scripts/prune.mjs (issue #22)
 *
 * Exercises the CLI end-to-end in temp dirs with fake legacy artifacts:
 *   - dry-run lists stale backups + legacy dirs, removes nothing
 *   - --apply removes only stale backups (fresh backups kept)
 *   - legacy dirs are NOT removed without --remove-dirs
 *   - --apply --remove-dirs removes legacy dirs
 *   - active config + active venv are NEVER touched
 *   - old global `pantheon` install is suggested, never removed
 *
 * Run: node tests/prune.test.mjs
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname ?? process.cwd(), '..')
const PRUNE = join(ROOT, 'scripts', 'prune.mjs')
const results = []

function test(name, fn) {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e) {
    results.push({ name, passed: false, error: e.message })
  }
}

function runPrune(args, env = {}) {
  return spawnSync(process.execPath, [PRUNE, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

/** Build a fake config dir with controlled legacy artifacts. Returns tmp root. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'prune-test-'))
  const cfg = join(root, 'config', 'opencode')
  mkdirSync(cfg, { recursive: true })
  // Active config + active venv — must NEVER be touched.
  writeFileSync(join(cfg, 'opencode.json'), JSON.stringify({ $schema: 'x', subagent_depth: 2 }))
  mkdirSync(join(cfg, '.venv'), { recursive: true })
  // Stale backup (old mtime → older than 30 days)
  const staleBak = join(cfg, 'opencode.json.bak.2024-01-01')
  writeFileSync(staleBak, '{ "old": true }')
  const old = new Date(Date.now() - 40 * 86_400_000)
  utimesSync(staleBak, old, old)
  // Fresh backup (kept)
  writeFileSync(join(cfg, 'opencode.json.bak'), '{ "fresh": true }')
  // Legacy dir with dead config (relative agent source)
  const legacyDir = join(cfg, 'pantheon-legacy', 'platform', 'opencode')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(
    join(legacyDir, 'opencode.json'),
    JSON.stringify({ agent: { zeus: { source: 'agents/zeus.md' } } }),
  )
  // Legacy dir with a VALID config (absolute, existing) — must NOT be flagged
  const okLegacyDir = join(cfg, 'legacy')
  mkdirSync(okLegacyDir, { recursive: true })
  writeFileSync(
    join(okLegacyDir, 'opencode.json'),
    JSON.stringify({ agent: { zeus: { source: join(cfg, 'agents', 'zeus.md') } } }),
  )
  mkdirSync(join(cfg, 'agents'), { recursive: true })
  writeFileSync(join(cfg, 'agents', 'zeus.md'), '# zeus')
  return { root, cfg }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

// ─── dry-run (default) ────────────────────────────────────────────────────

test('dry-run lists stale backup + legacy dir, removes nothing', () => {
  const { root, cfg } = makeFixture()
  try {
    const r = runPrune(['--target', cfg, '--age', '30'])
    assert.equal(r.status, 1, `dry-run with findings must exit 1\n${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /opencode\.json\.bak\.2024-01-01/)
    assert.match(r.stdout, /pantheon-legacy/)
    assert.match(r.stdout, /DRY-RUN/)
    // nothing removed
    assert.ok(existsSync(join(cfg, 'opencode.json')))
    assert.ok(existsSync(join(cfg, '.venv')))
    assert.ok(existsSync(join(cfg, 'opencode.json.bak')))
    assert.ok(existsSync(join(cfg, 'opencode.json.bak.2024-01-01')))
  } finally {
    cleanup(root)
  }
})

// ─── --apply ──────────────────────────────────────────────────────────────

test('--apply removes ONLY stale backups; fresh backup, active config, venv, legacy dirs intact', () => {
  const { root, cfg } = makeFixture()
  try {
    const r = runPrune(['--target', cfg, '--age', '30', '--apply'])
    assert.equal(r.status, 1, `legacy dir kept → findings remain, exit 1\n${r.stdout}${r.stderr}`)
    assert.ok(!existsSync(join(cfg, 'opencode.json.bak.2024-01-01')), 'stale backup removed')
    assert.ok(existsSync(join(cfg, 'opencode.json.bak')), 'fresh backup kept')
    assert.ok(existsSync(join(cfg, 'opencode.json')), 'active config untouched')
    assert.ok(existsSync(join(cfg, '.venv')), 'active venv untouched')
    assert.ok(
      existsSync(join(cfg, 'pantheon-legacy')),
      'legacy dir NOT removed without --remove-dirs',
    )
    assert.match(r.stdout, /requires --apply --remove-dirs/)
  } finally {
    cleanup(root)
  }
})

// ─── --apply --remove-dirs ────────────────────────────────────────────────

test('--apply --remove-dirs removes the dead legacy dir but not valid-config legacy dir', () => {
  const { root, cfg } = makeFixture()
  try {
    const r = runPrune(['--target', cfg, '--age', '30', '--apply', '--remove-dirs'])
    assert.equal(r.status, 1, `valid-config legacy dir remains → exit 1\n${r.stdout}${r.stderr}`)
    assert.ok(!existsSync(join(cfg, 'pantheon-legacy')), 'dead legacy dir removed')
    assert.ok(existsSync(join(cfg, 'legacy')), 'legacy dir with valid config NOT removed')
    assert.ok(existsSync(join(cfg, 'opencode.json')), 'active config untouched')
    assert.ok(existsSync(join(cfg, '.venv')), 'active venv untouched')
  } finally {
    cleanup(root)
  }
})

// ─── clean dir → exit 0 ───────────────────────────────────────────────────

test('clean config dir → exit 0 (nothing to clean)', () => {
  // Hermetic: fake HOME with NO npm-global legacy install (the real machine
  // has one, which would legitimately keep the exit code at 1).
  const root = mkdtempSync(join(tmpdir(), 'prune-clean-'))
  try {
    const fakeHome = join(root, 'home')
    const cfg = join(fakeHome, '.config', 'opencode')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'opencode.json'), '{}')
    const r = runPrune(['--target', cfg, '--age', '30'], { HOME: fakeHome })
    assert.equal(r.status, 0, `clean dir must exit 0\n${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /Nothing to clean/)
  } finally {
    cleanup(root)
  }
})

// ─── global legacy install suggestion ─────────────────────────────────────

test('old global ~/.npm-global pantheon install is SUGGESTED, never removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'prune-global-'))
  try {
    const fakeHome = join(root, 'home')
    const pkgDir = join(fakeHome, '.npm-global', 'lib', 'node_modules', 'pantheon')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'pantheon', version: '5.0.0', private: true }),
    )
    const cfg = join(fakeHome, '.config', 'opencode')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'opencode.json'), '{}')
    const r = runPrune(['--target', cfg, '--age', '30'], { HOME: fakeHome })
    assert.equal(r.status, 1, `global install suggestion → exit 1\n${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /pantheon@5\.0\.0/)
    assert.match(r.stdout, /npm uninstall -g pantheon/)
    assert.ok(existsSync(pkgDir), 'npm-managed package dir is NEVER removed by prune')
  } finally {
    cleanup(root)
  }
})

// ─── CLI wiring ───────────────────────────────────────────────────────────

test('pantheon-init.mjs dispatches the prune subcommand (--help mentions it)', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'pantheon-init.mjs'), '--help'], {
    encoding: 'utf-8',
  })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /pantheon-opencode prune/)
})

// ─── summary ──────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length
for (const r of results) {
  if (r.passed) console.log(`  ✅ ${r.name}`)
  else console.log(`  ❌ ${r.name}\n     ${r.error}`)
}
console.log(`\n📊 Results: ${passed} passed, ${results.length - passed} failed`)
process.exit(results.length - passed > 0 ? 1 : 0)
