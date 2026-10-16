/**
 * install-backup-restore.test.mjs — Beta 11 Setup phase 2 (exact backup +
 * restore).
 *
 * Covers:
 *  - backup.mjs unit contracts (no external deps): exact byte-for-byte copies,
 *    modes (dir 0700, files/manifest 0600), absent-entry recording, manifest
 *    hash verification, tampered-set refusal, retention (keep 5) + the path
 *    guard, restore planning/application, and the exact warning wording;
 *  - the `restore` CLI (no external deps): preview by path only, authorization
 *    required, reversible pre-restore backup, dry-run writes nothing;
 *  - the installer integration (needs the installer's declared `js-yaml`; run
 *    with the throwaway shim, or it is skipped): an apply creates the backup set
 *    BEFORE writing, prints the warning once, and never leaks a canary secret
 *    to stdout/stderr.
 *
 * Run: node --test tests/install-backup-restore.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  backupSetPath,
  backupWarning,
  createBackupSet,
  isBackupDirName,
  isDeletableBackupDir,
  listBackupSets,
  planRestore,
  pruneBackups,
  readManifest,
  restoreBackupSet,
  verifyBackupSet,
} from '../scripts/install/backup.mjs'
import { scanText } from '../scripts/secret-scan.mjs'

// The installer-integration case imports scripts/install/*.mjs, which needs the
// declared `js-yaml`. Detect it once: the case is skipped when the dependency is
// absent (incomplete node_modules) and runs under the throwaway js-yaml→yaml
// shim otherwise.
let canRunInstaller = true
try {
  await import('js-yaml')
} catch {
  canRunInstaller = false
}

const ROOT = process.cwd()
const BIN = join(ROOT, 'bin', 'pantheon-init.mjs')
const RESTORE = join(ROOT, 'scripts', 'restore.mjs')

const sha = (value) => createHash('sha256').update(value).digest('hex')
const mode = (path) => statSync(path).mode & 0o777

/** Build a canary that matches the secret-scan pattern without embedding a
 * contiguous literal in this (versionable) file. */
const CANARY = ['sk', '-bf-', 'CANARY', 'VALUE', '0123456789ABCDEF'].join('')

function makeConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-bak-'))
  return dir
}

// ---------------------------------------------------------------------------
// backup.mjs unit contracts
// ---------------------------------------------------------------------------

test('backup: createBackupSet preserves bytes, records absence and sets modes', () => {
  const configDir = makeConfigDir()
  try {
    writeFileSync(join(configDir, 'opencode.json'), '{"a":1}\n')
    mkdirSync(join(configDir, 'sub'), { recursive: true })
    writeFileSync(join(configDir, 'sub', 'b.txt'), 'hello')

    const { dir, name, manifest } = createBackupSet({
      configDir,
      entries: ['opencode.json', 'sub/b.txt', 'new.json'],
      packageVersion: '9.9.9',
      clock: () => new Date('2026-10-15T12:00:00.000Z'),
    })

    assert.equal(name, '2026-10-15T12-00-00Z')
    assert.equal(dir, backupSetPath(configDir, name))
    assert.equal(manifest.packageVersion, '9.9.9')
    assert.equal(manifest.configDir, configDir)

    const byRel = Object.fromEntries(manifest.entries.map((e) => [e.relativePath, e]))
    assert.equal(byRel['opencode.json'].existed, true)
    assert.equal(byRel['opencode.json'].sha256, sha('{"a":1}\n'))
    assert.equal(byRel['opencode.json'].bytes, 8)
    assert.equal(byRel['new.json'].existed, false)
    assert.equal(byRel['new.json'].sha256, null)

    // Byte-for-byte copies, behind 0600 files in a 0700 tree.
    assert.equal(readFileSync(join(dir, 'opencode.json'), 'utf8'), '{"a":1}\n')
    assert.equal(readFileSync(join(dir, 'sub', 'b.txt'), 'utf8'), 'hello')
    assert.equal(mode(join(dir, 'opencode.json')), 0o600)
    assert.equal(mode(join(dir, 'manifest.json')), 0o600)
    assert.equal(mode(dir), 0o700)
    assert.equal(mode(join(dir, 'opencode.json')) & 0o077, 0)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('backup: refuses a symlinked backup ancestor without creating files outside configDir', () => {
  const configDir = makeConfigDir()
  const outside = makeConfigDir()
  try {
    writeFileSync(join(configDir, 'opencode.json'), '{"safe":true}\n')
    symlinkSync(outside, join(configDir, '.pantheon'), 'dir')
    assert.throws(() => createBackupSet({ configDir, entries: ['opencode.json'] }), /symlink/i)
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('backup: verifyBackupSet accepts a clean set and refuses a tampered one', () => {
  const configDir = makeConfigDir()
  try {
    writeFileSync(join(configDir, 'opencode.json'), '{"secret":"x"}\n')
    const { dir } = createBackupSet({ configDir, entries: ['opencode.json'] })
    assert.equal(verifyBackupSet(dir).ok, true)

    // Tamper the backup copy (not the source).
    writeFileSync(join(dir, 'opencode.json'), '{"secret":"y"}\n')
    const result = verifyBackupSet(dir)
    assert.equal(result.ok, false)
    assert.deepEqual(result.mismatches, ['opencode.json'])
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('backup: planRestore classifies create/update/remove/unchanged by path only', () => {
  const configDir = makeConfigDir()
  try {
    writeFileSync(join(configDir, 'opencode.json'), '{"v":1}\n')
    writeFileSync(join(configDir, 'gone.json'), 'bye')
    const { dir } = createBackupSet({
      configDir,
      entries: ['opencode.json', 'gone.json', 'brand-new.json'],
      clock: () => new Date('2026-10-15T13:00:00.000Z'),
    })

    // Mutate the "current" state.
    writeFileSync(join(configDir, 'opencode.json'), '{"v":2}\n') // → update
    rmSync(join(configDir, 'gone.json')) // existed before → create
    writeFileSync(join(configDir, 'brand-new.json'), 'new') // absent before → remove

    const plan = planRestore(dir, configDir)
    const byRel = Object.fromEntries(plan.entries.map((e) => [e.relativePath, e.action]))
    assert.equal(byRel['opencode.json'], 'update')
    assert.equal(byRel['gone.json'], 'create')
    assert.equal(byRel['brand-new.json'], 'remove')
    // opencode.json is planned LAST.
    assert.equal(plan.entries.at(-1).relativePath, 'opencode.json')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('backup: restore rejects a symlinked target ancestor without deleting outside files', () => {
  const configDir = makeConfigDir()
  const outside = makeConfigDir()
  const externalFile = join(outside, 'gone.json')
  try {
    const { dir } = createBackupSet({ configDir, entries: ['nested/gone.json'] })
    writeFileSync(externalFile, 'keep me')
    symlinkSync(outside, join(configDir, 'nested'), 'dir')

    const plan = planRestore(dir, configDir)
    assert.equal(plan.error, 'unsafe-target-path')
    assert.throws(() => restoreBackupSet(dir, configDir), /not restorable/i)
    assert.equal(readFileSync(externalFile, 'utf8'), 'keep me')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('backup: restore rejects a symlinked config root', () => {
  const configDir = makeConfigDir()
  const aliasDir = makeConfigDir()
  const rootAlias = join(aliasDir, 'root')
  try {
    const { dir } = createBackupSet({ configDir, entries: ['missing.json'] })
    symlinkSync(configDir, rootAlias, 'dir')

    assert.equal(planRestore(dir, rootAlias).error, 'unsafe-target-root')
    assert.throws(() => restoreBackupSet(dir, rootAlias), /not restorable/i)
  } finally {
    rmSync(aliasDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('backup: restoreBackupSet reproduces bytes and recorded mode', () => {
  const configDir = makeConfigDir()
  try {
    writeFileSync(join(configDir, 'opencode.json'), '{"v":1}\n')
    chmodSync(join(configDir, 'opencode.json'), 0o640)
    const { dir } = createBackupSet({ configDir, entries: ['opencode.json'] })

    writeFileSync(join(configDir, 'opencode.json'), '{"v":2}\n')
    chmodSync(join(configDir, 'opencode.json'), 0o600)

    restoreBackupSet(dir, configDir, { dryRun: false })
    assert.equal(readFileSync(join(configDir, 'opencode.json'), 'utf8'), '{"v":1}\n')
    assert.equal(mode(join(configDir, 'opencode.json')), 0o640)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('backup: restore never chmods a pre-existing directory (F1)', () => {
  const configDir = makeConfigDir()
  try {
    mkdirSync(join(configDir, 'sub'))
    chmodSync(join(configDir, 'sub'), 0o755)
    writeFileSync(join(configDir, 'sub', 'f.txt'), 'one')
    const { dir } = createBackupSet({ configDir, entries: ['sub/f.txt'] })

    writeFileSync(join(configDir, 'sub', 'f.txt'), 'two')
    restoreBackupSet(dir, configDir, { dryRun: false })

    assert.equal(readFileSync(join(configDir, 'sub', 'f.txt'), 'utf8'), 'one')
    assert.equal(mode(join(configDir, 'sub')), 0o755, 'existing dir mode must be untouched')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('backup: manifest rejects absolute and .. entry paths (F2)', () => {
  const configDir = makeConfigDir()
  try {
    for (const bad of ['../escape.json', '/etc/passwd']) {
      const { dir } = createBackupSet({ configDir, entries: ['opencode.json'] })
      const manifestPath = join(dir, 'manifest.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.entries.push({
        relativePath: bad,
        existed: false,
        sha256: null,
        bytes: 0,
        mode: null,
      })
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      assert.equal(readManifest(dir).reason, 'unsafe-path')
      assert.equal(verifyBackupSet(dir).ok, false)
      assert.throws(() => restoreBackupSet(dir, configDir, {}), /not restorable/i)
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('backup: restoreBackupSet refuses a tampered set (no partial restore)', () => {
  const configDir = makeConfigDir()
  try {
    writeFileSync(join(configDir, 'opencode.json'), '{"v":1}\n')
    const { dir } = createBackupSet({ configDir, entries: ['opencode.json'] })
    writeFileSync(join(dir, 'opencode.json'), '{"tampered":true}\n')
    assert.throws(() => restoreBackupSet(dir, configDir, {}), /not restorable/i)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('backup: retention keeps the 5 newest and the path guard rejects out-of-tree', () => {
  const configDir = makeConfigDir()
  try {
    const dates = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 0, 1, 0, i, 0)))
    for (const date of dates) {
      createBackupSet({ configDir, entries: ['opencode.json'], clock: () => date, keep: 0 })
    }
    assert.equal(listBackupSets(configDir).length, 7)

    const pruned = pruneBackups(configDir, 5)
    const remaining = listBackupSets(configDir).map((s) => s.name)
    assert.equal(remaining.length, 5)
    assert.deepEqual(pruned.removed.sort(), ['2026-01-01T00-00-00Z', '2026-01-01T00-01-00Z'])
    // Newest kept.
    assert.ok(remaining.includes('2026-01-01T00-06-00Z'))

    // Path guard: only timestamped, in-tree dirs are deletable.
    assert.equal(
      isDeletableBackupDir(
        configDir,
        join(configDir, '.pantheon', 'backups', '2026-01-01T00-00-00Z'),
      ),
      true,
    )
    assert.equal(isBackupDirName('not-a-timestamp'), false)
    assert.equal(
      isDeletableBackupDir(configDir, join(configDir, '.pantheon', 'backups', 'not-a-timestamp')),
      false,
    )
    assert.equal(isDeletableBackupDir(configDir, join(configDir, 'opencode.json')), false)
    assert.equal(isDeletableBackupDir(configDir, join(configDir, '..', 'elsewhere')), false)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('backup: warning wording is fixed and secret-safe', () => {
  const text = backupWarning('/x/.pantheon/backups/2026-10-15T12-00-00Z')
  assert.match(
    text,
    /^Backup created at \/x\/\.pantheon\/backups\/2026-10-15T12-00-00Z \(mode 0600\)\. It is an exact copy of your current files and therefore also contains any API keys or tokens already present in them\. It is never printed\. Restore with: pantheon-opencode restore$/,
  )
})

// ---------------------------------------------------------------------------
// restore CLI (no external deps: restore.mjs imports only backup.mjs)
// ---------------------------------------------------------------------------

test('cli restore: --yes restores bytes and creates a reversible pre-restore backup', () => {
  const configDir = makeConfigDir()
  try {
    writeFileSync(join(configDir, 'opencode.json'), '{"v":1}\n')
    const { dir, name } = createBackupSet({
      configDir,
      entries: ['opencode.json'],
      clock: () => new Date('2026-10-15T12:00:00.000Z'),
    })
    assert.ok(existsSync(dir))
    writeFileSync(join(configDir, 'opencode.json'), '{"v":2}\n')

    const result = spawnSync(process.execPath, [RESTORE, '--project', '--from', name, '--yes'], {
      cwd: configDir,
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(result.status, 0, `restore must succeed:\n${result.stdout}\n${result.stderr}`)
    assert.equal(readFileSync(join(configDir, 'opencode.json'), 'utf8'), '{"v":1}\n')

    // A pre-restore backup of the CURRENT state exists (restore is reversible).
    const sets = listBackupSets(configDir)
    assert.ok(sets.length >= 2, 'pre-restore backup must be created')
    const current = sets.find((s) => {
      const p = join(s.dir, 'opencode.json')
      return existsSync(p) && readFileSync(p, 'utf8') === '{"v":2}\n'
    })
    assert.ok(current, 'pre-restore backup must hold the pre-restore bytes')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('cli restore: non-TTY without --yes refuses and writes nothing', () => {
  const configDir = makeConfigDir()
  try {
    writeFileSync(join(configDir, 'opencode.json'), '{"v":1}\n')
    const { name } = createBackupSet({ configDir, entries: ['opencode.json'] })
    writeFileSync(join(configDir, 'opencode.json'), '{"v":2}\n')

    const result = spawnSync(process.execPath, [RESTORE, '--project', '--from', name], {
      cwd: configDir,
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.notEqual(result.status, 0, 'must refuse without --yes')
    assert.equal(readFileSync(join(configDir, 'opencode.json'), 'utf8'), '{"v":2}\n')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('cli restore: --dry-run previews and writes nothing', () => {
  const configDir = makeConfigDir()
  try {
    writeFileSync(join(configDir, 'opencode.json'), '{"v":1}\n')
    const { name } = createBackupSet({ configDir, entries: ['opencode.json'] })
    writeFileSync(join(configDir, 'opencode.json'), '{"v":2}\n')
    const before = listBackupSets(configDir).length

    const result = spawnSync(
      process.execPath,
      [RESTORE, '--project', '--from', name, '--dry-run'],
      {
        cwd: configDir,
        encoding: 'utf8',
        timeout: 60_000,
      },
    )
    assert.equal(result.status, 0, `dry-run must exit 0:\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /Restore plan/)
    assert.equal(readFileSync(join(configDir, 'opencode.json'), 'utf8'), '{"v":2}\n')
    assert.equal(listBackupSets(configDir).length, before, 'dry-run must not create a backup')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Installer integration + canary (needs the installer's declared js-yaml)
// ---------------------------------------------------------------------------

test('installer apply: exact backup before writes, warning once, no canary leak', {
  skip: canRunInstaller ? false : 'js-yaml not installed (run under the shim)',
}, () => {
  const configDir = mkdtempSync(join(tmpdir(), 'pantheon-canary-'))
  const home = mkdtempSync(join(tmpdir(), 'pantheon-canary-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-canary-xdg-'))
  try {
    const seed = `{\n  "theme": "seed",\n  "apiKey": "${CANARY}"\n}\n`
    writeFileSync(join(configDir, 'opencode.json'), seed)
    // A legacy plugin file the run deletes (copyPluginFiles rm) — it must be
    // captured before the write, like every sibling tree.
    const pluginDir = join(configDir, '.opencode', 'plugins', 'pantheon-tui')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'index.tsx'), '//legacy\n')
    // A bulk file under node_modules: the walk must PRUNE it (never an entry);
    // it is only reported as not revertible.
    mkdirSync(join(pluginDir, 'node_modules'), { recursive: true })
    writeFileSync(join(pluginDir, 'node_modules', 'dep.js'), '//bulk\n')
    // Pre-seed a fake venv so setupVenv skips `python3 -m venv`; the absent pip
    // fails fast and is non-fatal. This exercises the plugins+runtime paths.
    mkdirSync(join(configDir, '.venv', 'bin'), { recursive: true })
    writeFileSync(join(configDir, '.venv', 'bin', 'python3'), '')

    // Preview (real dry run) must not leak the secret either.
    const preview = spawnSync(
      process.execPath,
      [
        BIN,
        'init',
        '--project',
        '--dry-run',
        '--yes',
        '--headless',
        '--version',
        'v1',
        '--no-mcp',
        '--components',
        'agents,commands',
      ],
      {
        cwd: configDir,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
      },
    )
    assert.equal(preview.status, 0, `preview must exit 0:\n${preview.stdout}\n${preview.stderr}`)
    assert.deepEqual(scanText(`${preview.stdout}\n${preview.stderr}`), [], 'preview must not leak')

    const result = spawnSync(
      process.execPath,
      [
        BIN,
        'init',
        '--project',
        '--yes',
        '--headless',
        '--version',
        'v1',
        '--components',
        'agents,skills,instructions,commands,plugins,runtime',
      ],
      {
        cwd: configDir,
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
      },
    )
    const output = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 0, `apply must succeed:\n${output}`)

    // The canary never appears in stdout/stderr (raw or via the secret scanner).
    assert.equal(output.includes(CANARY), false, 'canary must not appear in output')
    assert.deepEqual(scanText(output), [], 'secret scanner must find nothing in output')

    // The warning is printed exactly once.
    const warningNeedle = 'Backup created at '
    assert.equal(output.split(warningNeedle).length - 1, 1, 'backup warning printed once')

    // The backup set exists BEFORE-openstate, byte-for-byte, at 0600 in a 0700 tree.
    const sets = listBackupSets(configDir)
    assert.equal(sets.length, 1, 'exactly one backup set')
    const backupDir = sets[0].dir
    assert.equal(mode(backupDir), 0o700)
    const backedUpConfig = join(backupDir, 'opencode.json')
    assert.equal(readFileSync(backedUpConfig, 'utf8'), seed, 'byte-for-byte pre-apply copy')
    assert.equal(mode(backedUpConfig), 0o600)
    assert.equal(mode(backedUpConfig) & 0o077, 0, 'backup file must not be group/world readable')
    assert.equal(mode(join(backupDir, 'manifest.json')), 0o600)
    // The canary IS present in the backup (it is an exact copy) — but that copy
    // is 0600 under a 0700 dir.
    assert.ok(scanText(readFileSync(backedUpConfig, 'utf8')).length >= 1, 'backup holds the canary')

    // Restore rewrites the config from the backup and must not leak it either.
    const restored = spawnSync(process.execPath, [RESTORE, '--project', '--yes'], {
      cwd: configDir,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
    })
    assert.equal(restored.status, 0, `restore must exit 0:\n${restored.stdout}\n${restored.stderr}`)
    assert.deepEqual(
      scanText(`${restored.stdout}\n${restored.stderr}`),
      [],
      'restore must not leak',
    )

    // F3: the bulk dir and the out-of-target global files are recorded honestly
    // (not copied) rather than silently omitted.
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
    assert.ok(
      manifest.notRevertible.some((p) => p.endsWith('.venv')),
      `venv must be listed notRevertible: ${manifest.notRevertible}`,
    )
    assert.ok(
      manifest.notRevertible.some((p) => p.endsWith('tui.json')),
      'out-of-target tui.json must be listed notRevertible',
    )
    // The plugin dir's existing/legacy files are captured; node_modules is
    // pruned from entries and is the ONLY plugin path listed not revertible.
    const relPaths = manifest.entries.map((e) => e.relativePath)
    assert.ok(
      relPaths.includes('.opencode/plugins/pantheon-tui/index.tsx'),
      'seeded legacy plugin file must be captured in entries',
    )
    assert.ok(
      relPaths.every((p) => !p.includes('/node_modules/')),
      `node_modules must be pruned from entries: ${relPaths.filter((p) => p.includes('/node_modules/'))}`,
    )
    assert.deepEqual(
      manifest.notRevertible.filter((p) => p.includes('pantheon-tui')),
      ['.opencode/plugins/pantheon-tui/node_modules'],
      'node_modules must be the ONLY plugin notRevertible path',
    )
  } finally {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})

test('canary: drift-abort and failure paths never leak the secret', {
  skip: canRunInstaller ? false : 'js-yaml not installed (run under the shim)',
}, async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const run = async (makeDeps) => {
    const target = mkdtempSync(join(tmpdir(), 'pantheon-canary-path-'))
    writeFileSync(join(target, 'opencode.json'), `{"apiKey":"${CANARY}"}\n`)
    let out = ''
    const ow = process.stdout.write.bind(process.stdout)
    const ew = process.stderr.write.bind(process.stderr)
    process.stdout.write = (c) => {
      out += String(c)
      return true
    }
    process.stderr.write = (c) => {
      out += String(c)
      return true
    }
    let result = null
    try {
      result = await installOpenCode(target, false, false, ['agents', 'commands'], {
        yes: true,
        headless: true,
        version: 'v1',
        deps: makeDeps(target),
      })
    } catch {
      result = null
    } finally {
      process.stdout.write = ow
      process.stderr.write = ew
    }
    rmSync(target, { recursive: true, force: true })
    return { out, result }
  }

  const drift = await run((target) => ({
    betweenPlanAndApply: () => writeFileSync(join(target, 'opencode.json'), '{"mutated":true}\n'),
  }))
  assert.equal(drift.result?.reason, 'drift')
  assert.deepEqual(scanText(drift.out), [], 'drift-abort must not leak')

  const failure = await run(() => ({ failAfter: 2 }))
  assert.equal(failure.result, null, 'the injected failure must throw')
  assert.deepEqual(scanText(failure.out), [], 'failure must not leak')
})

// ---------------------------------------------------------------------------
// Retention safety on restore (F1)
// ---------------------------------------------------------------------------

test('cli restore: restoring the oldest set never prunes the set being restored', () => {
  const configDir = makeConfigDir()
  try {
    // Fill the retention window with 5 sets.
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(configDir, 'opencode.json'), `{"v":${i}}\n`)
      createBackupSet({
        configDir,
        entries: ['opencode.json'],
        clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      })
    }
    const oldest = listBackupSets(configDir).at(-1).name
    writeFileSync(join(configDir, 'opencode.json'), '{"v":"current"}\n')

    const result = spawnSync(process.execPath, [RESTORE, '--project', '--from', oldest, '--yes'], {
      cwd: configDir,
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(result.status, 0, `restore must succeed:\n${result.stdout}\n${result.stderr}`)
    // The set being restored still exists, and a pre-restore snapshot was added.
    assert.ok(existsSync(backupSetPath(configDir, oldest)), 'source set must still exist')
    assert.ok(listBackupSets(configDir).length >= 6, 'pre-restore snapshot must exist')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})
