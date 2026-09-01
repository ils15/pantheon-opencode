/** Installation contract tests for the local Pantheon Vision MCP. */

import { strict as assert } from 'node:assert'
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
import { dirname, join } from 'node:path'
import {
  resolveInstalledPlugin,
  resolveTuiCopyTarget,
  syncTuiRegistration,
} from '../scripts/install/opencode.mjs'
import { staleTuiRefs, TUI_STALE_SUFFIXES } from '../scripts/install/plugin.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

const opencodeInstaller = readFileSync('scripts/install/opencode.mjs', 'utf8')
const pluginInstaller = readFileSync('scripts/install/plugin.mjs', 'utf8')
const healthCheck = readFileSync('scripts/install/health-check.mjs', 'utf8')
const catalog = readFileSync('scripts/install-mcp.mjs', 'utf8')
const sourceCatalog = readFileSync('src/mcp/install-mcp.mjs', 'utf8')
const configText = readFileSync('opencode.json', 'utf8')
const visionRequirements = readFileSync('src/mcp/requirements-vision.txt', 'utf8')
const config = JSON.parse(configText)

assert.ok(opencodeInstaller.includes("'pantheon_vision_server.py'"))
assert.ok(opencodeInstaller.includes("join(ROOT, 'src', 'mcp', 'pantheon_vision_server.py')"))
assert.ok(opencodeInstaller.includes("config.mcp['pantheon-vision']"))
assert.ok(opencodeInstaller.includes("join(ROOT, 'src', 'mcp', 'pantheon_vision_server.py')"))
assert.ok(opencodeInstaller.includes('const memoryPython = venvPython'))

// P1-3: the MCP commands must point at the venv setupVenv ACTUALLY creates
// (<target>/.venv), not <target>/.opencode/.venv (runtimeTarget for project
// installs) — otherwise the MCP python executable does not exist on
// init --project and every local MCP fails to launch.
assert.ok(
  opencodeInstaller.includes('venvPythonPath(target)'),
  'installer derives the MCP venv python from the shared venvPythonPath(target) helper',
)
assert.equal(
  opencodeInstaller.includes("join(runtimeTarget, '.venv'"),
  false,
  'MCP commands must never use runtimeTarget/.venv (project installs would miss the real venv)',
)
const visionConfig = opencodeInstaller.slice(
  opencodeInstaller.indexOf("config.mcp['pantheon-vision']"),
  opencodeInstaller.indexOf("config.mcp['pantheon-vision']") + 320,
)
assert.ok(visionConfig.includes("type: 'local'"))
assert.ok(visionConfig.includes('enabled: true'))
assert.ok(opencodeInstaller.includes("config.permission.mcp['pantheon-vision'] = 'ask'"))
assert.ok(healthCheck.includes("'pantheon_vision_server.py'"))

// P2-4: only exact managed plugin references may be treated as Pantheon-owned.
// A third-party checkout can use either of the historical directory names, so
// the directory name alone must never rewrite its absolute path.
assert.ok(
  opencodeInstaller.includes('function resolveInstalledPlugin'),
  'installer handles plugin paths through resolveInstalledPlugin',
)
assert.ok(
  resolveInstalledPlugin(join(ROOT, 'src', 'plugin.ts')) === join(ROOT, 'src', 'plugin.ts') &&
    resolveInstalledPlugin(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')) ===
      join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
  'exact installed Pantheon paths remain managed',
)
assert.equal(
  resolveInstalledPlugin('/old/vendor/src/plugin.ts'),
  '/old/vendor/src/plugin.ts',
  'external paths with the same filename remain untouched',
)
assert.equal(
  resolveInstalledPlugin('/tmp/vendor/pantheon-opencode/src/plugin.ts'),
  '/tmp/vendor/pantheon-opencode/src/plugin.ts',
  'external paths under a pantheon-opencode directory remain untouched',
)
assert.equal(
  resolveInstalledPlugin('/tmp/vendor/pantheon/src/plugin.ts'),
  '/tmp/vendor/pantheon/src/plugin.ts',
  'external paths under a pantheon directory remain untouched',
)
assert.equal(
  opencodeInstaller.includes('basename(p) !== file'),
  false,
  'plugin cleanup must not dedupe unrelated user plugins by basename',
)

// P2-5: the TUI plugin must be COPIED from the single source of truth
// (src/plugins/tui) into the target config's plugins/pantheon-tui and
// registered by THAT copied directory — never by the in-package source dir.
// A registration pointing at the installed package breaks on package
// reinstall/upgrade (the dir is replaced under a live registration) and can
// accumulate diverging copies; the copied dir keeps exactly one absolute
// reference per install. The loader reads the copied package.json exports:
//   exports["./tui"]    → dist/tui.js     (COMPILED Solid output)
//   exports["./server"] → dist/server.js  (no-op server() stub)
assert.ok(
  opencodeInstaller.includes('function resolveTuiCopyTarget'),
  'installer exposes pure resolveTuiCopyTarget(configDir) to derive the copied plugin dir',
)
assert.ok(
  opencodeInstaller.includes('const tuiCopyDir = resolveTuiCopyTarget(configDir)'),
  'syncTuiRegistration points at the COPIED directory, not the package source dir',
)
assert.ok(
  opencodeInstaller.includes('copyPluginFiles(tuiSrcDir, tuiCopyDir'),
  'syncTuiRegistration ALWAYS copies src/plugins/tui into <config>/plugins/pantheon-tui',
)
assert.ok(
  opencodeInstaller.includes("const tuiSrcDir = join(ROOT, 'src', 'plugins', 'tui')"),
  'the copy source is the package src/plugins/tui (single source of truth)',
)
assert.ok(
  opencodeInstaller.includes('registerPlugin(targetTuiConfigPath, tuiCopyDir'),
  'the copied directory is what gets registered in the target tui.json',
)
assert.ok(
  opencodeInstaller.includes("unregisterPlugin(tuiConfigPath, 'plugins/pantheon-tui'"),
  'old broken relative tui refs are removed on upgrade',
)
assert.ok(
  opencodeInstaller.includes("join(homedir(), '.opencode', 'tui.json')") &&
    opencodeInstaller.includes("join(xdgConfig, 'opencode', 'tui.json')") &&
    opencodeInstaller.includes("join(target, '.opencode', 'tui.json')"),
  'cleanup covers ALL three tui.json locations OpenCode reads (global + project)',
)
assert.ok(
  pluginInstaller.includes('function staleTuiRefs'),
  'plugin.mjs exposes the pure staleTuiRefs() filter',
)
assert.ok(
  TUI_STALE_SUFFIXES.includes('plugins/pantheon-tui') &&
    TUI_STALE_SUFFIXES.includes('plugins/pantheon-tui/dist/tui.js'),
  'unregisterPlugin exposes exact stale TUI registration markers',
)

// P2-5c: the TUI plugin package must expose the opencode loader contract that
// the directory registration relies on — compiled tui entry + no-op server
// stub (the reference opencode-delegations-sidebar pattern).
const tuiPkg = JSON.parse(readFileSync('src/plugins/tui/package.json', 'utf8'))
assert.equal(
  tuiPkg.exports['./tui'],
  './dist/tui.js',
  'exports["./tui"] points at the COMPILED tui entry (Solid transforms applied), never the raw tsx',
)
assert.equal(
  tuiPkg.exports['./server'],
  './dist/server.js',
  'exports["./server"] points at the compiled no-op server stub (loader requires every plugin to expose server())',
)
const tsdownConfig = readFileSync('src/plugins/tui/tsdown.config.ts', 'utf8')
assert.ok(
  /entry:\s*\{[^}]*server:\s*'src\/server\.ts'/.test(tsdownConfig),
  'tsdown builds the server entry into dist/server.js',
)
const serverStub = readFileSync('src/plugins/tui/src/server.ts', 'utf8')
assert.ok(
  /export default function server\(\)/.test(serverStub),
  'src/server.ts default-exports the no-op server() stub',
)

assert.ok(catalog.includes("'pantheon-vision':"))
assert.ok(sourceCatalog.includes('../../scripts/install-mcp.mjs'))
assert.ok(
  catalog.includes(
    "PANTHEON_VISION_SERVER = resolveServerScript('src/mcp/pantheon_vision_server.py')",
  ),
  'catalog resolves the vision server through the hermetic PANTHEON_VISION_SERVER constant',
)
assert.ok(catalog.includes('args: [PANTHEON_VISION_SERVER]'))
assert.ok(catalog.includes('requirements-vision.txt'))
assert.ok(catalog.includes("vscode: {\n        type: 'stdio'"))

// The package entry point must delegate to the same implementation rather
// than maintaining a second, subtly different catalog.
assert.equal(sourceCatalog.includes("'pantheon-vision':"), false)

assert.equal(existsSync('scripts/pantheon_vision_server.py'), false)
assert.ok(existsSync('src/mcp/pantheon_vision_server.py'))
assert.equal(existsSync('src/pantheon/pantheon_vision_server.py'), false)
assert.ok(config.mcp?.bifrost?.url)
assert.equal(config.mcp.bifrost.headers, undefined)
const bifrostHeader = ['x', '-bf-', 'vk'].join('')
const bifrostTokenPrefix = ['sk', '-bf-'].join('')
assert.equal(new RegExp(bifrostHeader, 'i').test(configText), false)
assert.equal(new RegExp(bifrostTokenPrefix, 'i').test(configText), false)
assert.equal(/(?:api[_-]?key|token|secret)\s*[:=]\s*["'][^"']{12,}/i.test(configText), false)
assert.deepEqual(
  visionRequirements
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[<>=!~]/, 1)[0])
    .filter(Boolean),
  ['mcp', 'fastmcp', 'httpx'],
)
for (const dependency of ['pillow', 'paddle', 'gemini', 'torch']) {
  assert.equal(new RegExp(`^${dependency}(?:[<>=!~]|$)`, 'mi').test(visionRequirements), false)
}

// ---------------------------------------------------------------------------
// P2-5b: behavioral — single source of truth for the TUI plugin. OpenCode
// reads tui.json from ~/.opencode, $XDG_CONFIG_HOME/opencode AND
// <project>/.opencode, so stale absolute refs from old checkouts/package/npx
// installs must be cleaned from ALL of them, while the CURRENT plugin is
// copied into <config>/plugins/pantheon-tui and registered by that single
// absolute directory reference.
// ---------------------------------------------------------------------------
const PACKAGE_TUI_SRC = join(ROOT, 'src', 'plugins', 'tui')
// Old Pantheon references are removed only when their identity is unambiguous;
// the same-suffix user path below is intentionally retained.
const STALE_REFS = [
  join(PACKAGE_TUI_SRC, 'dist', 'tui.tsx'), // legacy dist file (tsx era)
  join(PACKAGE_TUI_SRC, 'dist', 'tui.js'), // legacy dist file (js era)
  PACKAGE_TUI_SRC, // in-package source dir
  '/home/olddev/.opencode/plugins/pantheon-tui', // user-owned same-suffix dir
  'plugins/pantheon-tui', // bare relative id (pre-1.19 writes)
  '/home/olddev/.npm/_npx/ab12cd34/node_modules/pantheon-tui', // npx cache copy
  'npx -y pantheon-tui', // npx spec string
]

function readTuiJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function withGlobalDirs(run) {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-tui-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-tui-xdg-'))
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = xdg
  try {
    run({ home, xdg })
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
}

const tuiAt = (dir, global_) =>
  global_ ? join(dir, 'tui.json') : join(dir, '.opencode', 'tui.json')

// (a) clean global install → exactly 1 registration, pointing at the COPIED
// directory, and that directory exists with dist/tui.js (the loader entry).
withGlobalDirs(({ home, xdg }) => {
  const target = join(home, '.opencode')
  mkdirSync(target, { recursive: true })
  const status = syncTuiRegistration(target, { isGlobal: true, dryRun: false })
  assert.equal(status, 'created', 'clean install registers the copied TUI dir')
  const targetCfg = readTuiJson(tuiAt(target, true))
  assert.ok(targetCfg, 'target tui.json created')
  assert.equal(targetCfg.plugin.length, 1, 'exactly one TUI registration')
  const [ref] = targetCfg.plugin
  const copyDir = resolveTuiCopyTarget(target)
  assert.equal(ref, copyDir, 'the registered ref is the copied plugin directory')
  assert.ok(existsSync(ref), 'copied plugin dir exists')
  assert.ok(existsSync(join(ref, 'dist', 'tui.js')), 'copied dir has dist/tui.js (loader entry)')
  assert.ok(existsSync(join(ref, 'package.json')), 'copied dir has package.json (exports map)')
  const other = tuiAt(join(xdg, 'opencode'), true)
  assert.equal(
    readTuiJson(other)?.plugin.length ?? 0,
    0,
    'the non-target global location has no TUI registrations',
  )
})

// (b) idempotency: a second install produces a byte-identical tui.json with
// the same single registration, and the copied dist files are untouched.
withGlobalDirs(({ home, xdg }) => {
  const target = join(home, '.opencode')
  mkdirSync(target, { recursive: true })
  syncTuiRegistration(target, { isGlobal: true, dryRun: false })
  const targetTui = tuiAt(target, true)
  const first = readFileSync(targetTui, 'utf8')
  const copyDir = resolveTuiCopyTarget(target)
  const firstDist = readFileSync(join(copyDir, 'dist', 'tui.js'), 'utf8')

  syncTuiRegistration(target, { isGlobal: true, dryRun: false })

  assert.equal(
    readFileSync(targetTui, 'utf8'),
    first,
    'reinstall is a byte-identical no-op on tui.json',
  )
  const cfg = readTuiJson(targetTui)
  assert.equal(cfg.plugin.length, 1, 'still exactly one registration')
  assert.equal(cfg.plugin[0], copyDir, 'registration unchanged after reinstall')
  assert.equal(
    readFileSync(join(copyDir, 'dist', 'tui.js'), 'utf8'),
    firstDist,
    'copied dist files unchanged after reinstall',
  )
  const other = tuiAt(join(xdg, 'opencode'), true)
  assert.equal(readTuiJson(other)?.plugin.length ?? 0, 0, 'other location stays clean')
})

// (c) stale refs (dist file, package source, bare copy, npx) seeded in ALL
// THREE tui.json locations are cleaned; the project target keeps exactly the
// copied-dir registration — one Pantheon TUI reference system-wide.
withGlobalDirs(({ home, xdg }) => {
  const project = mkdtempSync(join(tmpdir(), 'pantheon-tui-proj-'))
  try {
    const projectTuiDir = join(project, '.opencode')
    mkdirSync(projectTuiDir, { recursive: true })
    const global1 = join(home, '.opencode', 'tui.json') // ~/.opencode
    const global2 = join(xdg, 'opencode', 'tui.json') // ~/.config/opencode
    const projectTui = join(projectTuiDir, 'tui.json') // <project>/.opencode
    for (const p of [global1, global2, projectTui]) {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify({ plugin: [...STALE_REFS] }, null, 2))
    }

    syncTuiRegistration(project, { isGlobal: false, dryRun: false })

    assert.deepEqual(
      readTuiJson(projectTui).plugin,
      [STALE_REFS[3], resolveTuiCopyTarget(projectTuiDir)],
      'project target keeps the user plugin and adds exactly one copied-dir registration',
    )
    for (const p of [global1, global2]) {
      assert.deepEqual(
        readTuiJson(p)?.plugin ?? [],
        [STALE_REFS[3]],
        `same-suffix user plugin is preserved in ${p}`,
      )
    }
    const allRefs = [global1, global2, projectTui]
      .filter(existsSync)
      .flatMap((p) => readTuiJson(p)?.plugin ?? [])
      .filter((r) => typeof r === 'string' && r.includes('pantheon-tui'))
    assert.equal(
      allRefs.filter((ref) => ref !== STALE_REFS[3]).length,
      1,
      'exactly ONE Pantheon TUI reference is installed system-wide',
    )
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// (d) the copied <config>/plugins/pantheon-tui is byte-identical to the
// source of truth (dist/* + package.json + index.tsx).
withGlobalDirs(({ home }) => {
  const target = join(home, '.opencode')
  mkdirSync(target, { recursive: true })
  syncTuiRegistration(target, { isGlobal: true, dryRun: false })
  const copyDir = resolveTuiCopyTarget(target)
  for (const f of readdirSync(join(PACKAGE_TUI_SRC, 'dist'))) {
    assert.equal(
      readFileSync(join(copyDir, 'dist', f), 'utf8'),
      readFileSync(join(PACKAGE_TUI_SRC, 'dist', f), 'utf8'),
      `dist/${f} is byte-identical to the source of truth`,
    )
  }
  assert.equal(
    readFileSync(join(copyDir, 'package.json'), 'utf8'),
    readFileSync(join(PACKAGE_TUI_SRC, 'package.json'), 'utf8'),
    'package.json is byte-identical to the source of truth',
  )
  assert.equal(
    readFileSync(join(copyDir, 'index.tsx'), 'utf8'),
    readFileSync(join(PACKAGE_TUI_SRC, 'src', 'index.tsx'), 'utf8'),
    'index.tsx is byte-identical to src/index.tsx',
  )
})

// (e) pure helpers: resolveTuiCopyTarget derives the copy dir; staleTuiRefs
// flags old Pantheon TUI references only when their identity is unambiguous;
// a user-owned plugin with the same suffix must survive cleanup.
assert.equal(
  resolveTuiCopyTarget('/x/.opencode'),
  join('/x/.opencode', 'plugins', 'pantheon-tui'),
  'resolveTuiCopyTarget appends plugins/pantheon-tui under the config dir',
)
const currentShape = '/home/current/.opencode/plugins/pantheon-tui'
const userSameSuffix = '/home/user/plugins/pantheon-tui'
const staleOnly = staleTuiRefs([...STALE_REFS, currentShape, userSameSuffix])
assert.deepEqual(
  staleOnly,
  STALE_REFS.filter((ref) => !ref.includes('/home/olddev/.opencode/plugins/pantheon-tui')),
  'staleTuiRefs flags identifiable Pantheon refs but preserves same-suffix user plugins',
)

console.log('✅ Pantheon Vision MCP installation contract passed')
