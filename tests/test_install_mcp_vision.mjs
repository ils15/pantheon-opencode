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
import { resolveTuiCopyTarget, syncTuiRegistration } from '../scripts/install/opencode.mjs'
import { staleTuiRefs } from '../scripts/install/plugin.mjs'
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

// P2-4: the hooks plugin must be rewritten at install/sync time to the
// INSTALLED package location (derived from ROOT), never copied verbatim from
// the packaged opencode.json — otherwise global installs leak the developer's
// absolute path and break the plugin for every other machine.
assert.ok(
  opencodeInstaller.includes('function resolveInstalledPlugin'),
  'installer rewrites plugin paths through resolveInstalledPlugin',
)
assert.ok(
  opencodeInstaller.includes('const packaged = join(ROOT, plugin.slice(srcIndex))'),
  'resolved plugin path is derived from the installed package ROOT, never hardcoded',
)
assert.ok(
  opencodeInstaller.includes("const srcIndex = plugin.indexOf('src/')"),
  'resolveInstalledPlugin maps ANY src/ ref (src/plugins/* and root-level src/plugin.ts) into the package',
)
assert.ok(
  opencodeInstaller.includes('config.plugin = config.plugin.filter((p) => basename(p) !== file)'),
  'stale plugin entries with the same basename (e.g. dev paths) are replaced on upgrade',
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
  pluginInstaller.includes("'/src/plugins/tui'") &&
    pluginInstaller.includes("'/plugins/pantheon-tui'") &&
    pluginInstaller.includes("'/src/plugins/tui/dist/tui.tsx'") &&
    pluginInstaller.includes("'/plugins/pantheon-tui/dist/tui.js'"),
  'unregisterPlugin removes stale absolute TUI registrations (package source dir, bare copy dir, dist file refs)',
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
// Every reference shape that must NEVER survive an install:
const STALE_REFS = [
  '/home/olddev/pantheon/src/plugins/tui/dist/tui.tsx', // legacy dist file (tsx era)
  '/home/olddev/pantheon/src/plugins/tui/dist/tui.js', // legacy dist file (js era)
  '/home/olddev/node_modules/pantheon-opencode/src/plugins/tui', // in-package source dir
  '/home/olddev/pantheon/.opencode/plugins/pantheon-tui', // bare copied dir (old target)
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
      [resolveTuiCopyTarget(projectTuiDir)],
      'project target keeps exactly the copied-dir registration',
    )
    for (const p of [global1, global2]) {
      assert.equal(readTuiJson(p)?.plugin.length ?? 0, 0, `old Pantheon TUI refs cleaned from ${p}`)
    }
    const allRefs = [global1, global2, projectTui]
      .filter(existsSync)
      .flatMap((p) => readTuiJson(p)?.plugin ?? [])
      .filter((r) => typeof r === 'string' && r.includes('pantheon-tui'))
    assert.equal(allRefs.length, 1, 'exactly ONE Pantheon TUI reference system-wide after install')
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
// flags every old Pantheon TUI reference shape (dist file, package source,
// bare copy dir, npx). The bare-copy-dir shape is indistinguishable from a
// stale one without knowing the install target, so it is flagged too —
// syncTuiRegistration keeps the current ref by unregister-then-register.
assert.equal(
  resolveTuiCopyTarget('/x/.opencode'),
  join('/x/.opencode', 'plugins', 'pantheon-tui'),
  'resolveTuiCopyTarget appends plugins/pantheon-tui under the config dir',
)
const currentShape = '/home/current/.opencode/plugins/pantheon-tui'
const staleOnly = staleTuiRefs([...STALE_REFS, currentShape])
assert.deepEqual(
  staleOnly,
  [...STALE_REFS, currentShape],
  'staleTuiRefs flags old shapes AND bare copy dirs (current ref is kept by re-registration)',
)

console.log('✅ Pantheon Vision MCP installation contract passed')
