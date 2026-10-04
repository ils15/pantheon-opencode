import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const escapedRoot = ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const forbidden = new RegExp(
  `(?:${escapedRoot}|\\/home\\/|\\/workspace\\/|pantheon[\\\\/]src[\\\\/])`,
  'i',
)
const executableForbidden = new RegExp(
  `(?:${escapedRoot}|\\/home\\/|\\/workspace\\/|pantheon[\\\\/]src[\\\\/])`,
  'i',
)
const privateUrl =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s"]+\.(?:local|internal|corp))(?:[:/]|$)/i

function pack() {
  // Do not bypass prepack: the published archive is the artifact under test.
  // --json emits the full manifest + file listing (>1MB once the tarball
  // carries every runtime input); the default 1MB child buffer would blow
  // up with ENOBUFS, so raise it explicitly.
  const result = execFileSync('npm', ['pack', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(result)[0].filename
}

function textFiles(root) {
  const files = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) files.push(...textFiles(path))
    else files.push(path)
  }
  return files
}

// Executable configs npm actually publishes. Kept in sync with the
// `files` allow-list in package.json — no hardcoded opencode.json.
const shippedExecutableConfigs = ['plugin.json', 'src/plugins/tui/package.json']

function assertExecutableConfigIsPathFree(packageRoot) {
  for (const rel of shippedExecutableConfigs) {
    const configPath = join(packageRoot, rel)
    assert.ok(existsSync(configPath), `published executable config is missing: ${rel}`)
    const text = readFileSync(configPath, 'utf8')
    assert.doesNotMatch(text, executableForbidden, `machine path in published ${rel}`)
    assert.doesNotMatch(text, privateUrl, `private URL in published ${rel}`)
    const config = JSON.parse(text)
    if (Array.isArray(config.plugin))
      assert.equal(
        config.plugin.some((entry) => entry.startsWith('/')),
        false,
        `${rel} must be a path-free template (no absolute plugin entries)`,
      )
  }
}

test('tarball contains no machine paths and ships the runtime inputs', () => {
  const tarball = pack()
  const work = mkdtempSync(join(tmpdir(), 'pantheon-tarball-'))
  try {
    const listing = execFileSync('tar', ['-tzf', join(ROOT, tarball)], { encoding: 'utf8' })
    assert.doesNotMatch(listing, forbidden)
    assert.doesNotMatch(listing, /(?:^|\/)logs(?:\/|$)|\.log$/i)
    // Python bytecode/build dirs must never ship — the `files` whitelist in
    // package.json carries explicit `!**/__pycache__/**` / `!**/*.pyc`
    // negations because .npmignore is overridden by a files whitelist.
    assert.doesNotMatch(listing, /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/)
    execFileSync('tar', ['-xzf', join(ROOT, tarball), '-C', work])
    const packageRoot = join(work, 'package')
    const codeModeRoot = join(packageRoot, '.pantheon', 'code-mode')
    const codeModeManifest = JSON.parse(readFileSync(join(codeModeRoot, 'manifest.json'), 'utf8'))
    const manifestEntries = Object.entries(codeModeManifest.scripts ?? {})
    const shippedScripts = textFiles(codeModeRoot)
      .filter((file) => /\.(?:py|sh)$/.test(file))
      .map((file) => file.slice(codeModeRoot.length + 1))
      .sort()
    assert.deepEqual(
      manifestEntries.map(([script]) => script).sort(),
      shippedScripts,
      'code-mode manifest must contain exactly the scripts shipped in the tarball',
    )
    for (const [script, expectedHash] of manifestEntries) {
      const scriptPath = join(codeModeRoot, script)
      assert.equal(existsSync(scriptPath), true, `manifest script is missing: ${script}`)
      const actualHash = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
      assert.equal(actualHash, expectedHash, `manifest hash mismatch: ${script}`)
    }
    assertExecutableConfigIsPathFree(packageRoot)
    for (const file of textFiles(join(work, 'package'))) {
      const rel = file.slice(join(work, 'package').length + 1)
      const text = readFileSync(file, 'utf8')
      // Documentation may show safe placeholder commands/paths. Executable
      // configs and archive entries may not contain machine paths or logs.
      if (
        /^(?:README\.md|AGENTS\.md|CHANGELOG\.md|docs\/|src\/skills\/|src\/agents\/|src\/pantheon\/vision\.ts)/.test(
          rel,
        )
      )
        continue
      assert.doesNotMatch(text, forbidden, `forbidden path in ${file}`)
      assert.doesNotMatch(text, /\/tmp\//i, `temporary machine path in ${file}`)
      assert.doesNotMatch(text, privateUrl, `private URL in ${file}`)
    }
    for (const file of ['package/scripts/doctor.mjs', 'package/src/plugins/pantheon-hooks.ts']) {
      assert.match(listing, new RegExp(`^${file.replaceAll('/', '\\/')}$`, 'm'))
    }
    assert.match(listing, /^package\/src\/plugin-v2\/index\.ts$/m)
    assert.match(listing, /^package\/src\/plugin-v2\.ts$/m)
    assert.match(listing, /^package\/bin\/pantheon-init\.mjs$/m)
    // The code-mode payload must ship inside the tarball so fresh installs
    // can seed the runtime scripts directory.
    assert.match(listing, /^package\/\.pantheon\/code-mode\/compress-inline\.py$/m)
    assert.doesNotMatch(
      listing,
      /package\/\.pantheon\/code-mode\/session-end-save\.(?:py|sh)/,
      'retired session-save scripts must not be packaged',
    )
    assert.doesNotMatch(
      listing,
      /package\/\.pantheon\/code-mode\/eval-[^/]+\.py/,
      'evaluation helpers must remain local-only',
    )
    assert.doesNotMatch(
      listing,
      /(?:^|\/)evals?(?:\/|$)|(?:^|\/)promptfoo(?:\/|$)/i,
      'local evals and Promptfoo assets must remain excluded',
    )

    const redaction = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'redaction-gate.mjs'), join(ROOT, tarball)],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(redaction.status, 0, redaction.stderr || redaction.stdout)
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(join(ROOT, tarball), { force: true })
  }
})

test('installed package resolves hooks to its installed absolute path', () => {
  const tarball = pack()
  const work = mkdtempSync(join(tmpdir(), 'pantheon-prefix-'))
  const project = join(work, 'project')
  mkdirSync(project)
  try {
    // Install the tarball with a redirected OpenCode config dir. Installing our
    // own tarball runs its `postinstall` (`postinstall.mjs && sync-tui.mjs`), and
    // sync-tui resolves the developer's REAL config dir: $XDG_CONFIG_HOME/
    // opencode if it exists, else ~/.opencode. Left unredirected it copies the
    // repo's src/plugins/tui over the live ~/.config/opencode/plugins/pantheon-tui
    // and then runs `npm ci --omit=dev` *there* — silently rewriting the user's
    // environment (and dropping dev deps) while this suite still reports green.
    //
    // The sandbox dir must CONTAIN an `opencode` entry: resolveConfigDir() only
    // falls through to the real ~/.opencode when the XDG path is absent.
    const sandboxConfig = join(work, 'sandbox-config')
    mkdirSync(join(sandboxConfig, 'opencode'), { recursive: true })
    execFileSync('npm', ['install', '--prefix', work, join(ROOT, tarball)], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: sandboxConfig },
    })
    const cli = join(work, 'node_modules', 'pantheon-opencode', 'bin', 'pantheon-init.mjs')
    const result = spawnSync(
      process.execPath,
      [cli, 'init', '--project', '--no-mcp', '--headless', '-y'],
      {
        cwd: project,
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const config = JSON.parse(readFileSync(join(project, 'opencode.json'), 'utf8'))
    const installedRoot = resolve(work, 'node_modules', 'pantheon-opencode')
    // The defaults asserted below are read from the installer's code. Pin that
    // independence here: if a template ever ships again and quietly starts
    // seeding them, this test stops proving the code path it exists to guard.
    assert.equal(
      existsSync(join(installedRoot, 'opencode.json')),
      false,
      'installed package must not ship an opencode.json template',
    )
    // Installer contract: BOTH pantheon plugins are registered unconditionally
    // — the root-level delegation plugin (src/plugin.ts) and the runtime hooks
    // plugin (src/plugins/pantheon-hooks.ts) — resolved to absolute paths
    // inside the INSTALLED package (never dev-machine paths).
    assert.deepEqual(config.plugin, [
      join(installedRoot, 'src', 'plugin.ts'),
      join(installedRoot, 'src', 'plugins', 'pantheon-hooks.ts'),
    ])
    for (const entry of config.plugin) {
      assert.equal(existsSync(entry), true, `registered plugin must exist: ${entry}`)
    }
    // Regression guard (after the packaged opencode.json template was dropped
    // from `files`): the product defaults an install seeds are code constants in
    // scripts/install/opencode.mjs, NOT read from a template that no longer
    // ships. If they move back to a template — or back out of the installer —
    // these two assertions are what fails.
    assert.equal(config.default_agent, 'zeus')
    assert.equal(config.permission.skill['*'], 'allow')
    assert.doesNotMatch(JSON.stringify(config), executableForbidden)
    const tui = JSON.parse(readFileSync(join(project, '.opencode', 'tui.json'), 'utf8'))
    // Installer contract (af40321): the TUI plugin is COPIED to the target
    // config's plugins/pantheon-tui and registered as that directory — never
    // the in-package src/plugins/tui — so installs stay hermetic and
    // idempotent. Assert the registered entry is the absolute copied dir and
    // it carries the loader contract (dist/tui.js).
    const tuiDir = join(project, '.opencode', 'plugins', 'pantheon-tui')
    assert.deepEqual(tui.plugin, [tuiDir])
    assert.equal(existsSync(tuiDir), true)
    assert.equal(existsSync(join(tuiDir, 'dist', 'tui.js')), true)
    assert.equal(
      tui.plugin.some((entry) => !entry.startsWith('/')),
      false,
    )
  } finally {
    rmSync(join(ROOT, tarball), { force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('package validator rejects executable templates with machine paths', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pantheon-package-fixture-'))
  try {
    mkdirSync(join(fixture, 'scripts'), { recursive: true })
    execFileSync('cp', [
      join(ROOT, 'scripts', 'validate-package.mjs'),
      join(fixture, 'scripts', 'validate-package.mjs'),
    ])
    execFileSync('cp', [join(ROOT, 'package.json'), join(fixture, 'package.json')])
    execFileSync('cp', [join(ROOT, 'plugin.json'), join(fixture, 'plugin.json')])
    execFileSync('cp', [
      join(ROOT, 'src', 'plugins', 'tui', 'package.json'),
      join(fixture, 'tui.json'),
    ])
    const configPath = join(fixture, 'plugin.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.plugin = ['/home/checkout/src/plugins/pantheon-hooks.ts']
    writeFileSync(configPath, `${JSON.stringify(config)}\n`)
    const result = spawnSync(process.execPath, [join(fixture, 'scripts', 'validate-package.mjs')], {
      cwd: fixture,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Package validation failed/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
