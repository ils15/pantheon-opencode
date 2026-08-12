/** Installation contract tests for the local Pantheon Vision MCP. */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncTuiRegistration } from '../scripts/install/opencode.mjs'
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

// P2-5: the TUI plugin must be registered by the ABSOLUTE PACKAGE DIRECTORY
// inside the installed package — relative entries ("plugins/pantheon-tui")
// make opencode's tui loader run `npm install plugins/pantheon-tui` →
// NpmInstallFailedError, and FILE entries (dist/tui.tsx) bypass package.json
// exports so the loader mounts the raw (non-reactive) JSX. Pointing at the
// directory lets the loader read exports["./tui"] → the COMPILED dist/tui.js
// (Solid transforms applied) + exports["./server"] → the no-op server stub.
assert.ok(
  opencodeInstaller.includes(
    "const tuiPluginRef = join(ROOT, 'src', 'plugins', 'tui')",
  ),
  'tui.json registration uses the hermetic package DIRECTORY derived from the installed package ROOT (loader reads package.json exports)',
)
assert.ok(
  opencodeInstaller.includes("unregisterPlugin(tuiConfigPath, 'plugins/pantheon-tui'"),
  'old broken relative tui refs are removed on upgrade',
)
assert.ok(
  opencodeInstaller.includes('registerPlugin(targetTuiConfigPath, tuiPluginRef'),
  'the absolute tui dist path is what gets registered',
)
assert.ok(
  opencodeInstaller.includes('const tuiConfigPaths = [targetTuiConfigPath]') &&
    opencodeInstaller.includes("join(homedir(), '.opencode', 'tui.json')") &&
    opencodeInstaller.includes("join(xdgConfig, 'opencode', 'tui.json')"),
  'global init cleans stale TUI refs from both OpenCode config locations',
)
assert.ok(
  pluginInstaller.includes(
    "const staleRefs = [pluginId, `${pluginId}/dist/tui.tsx`, `${pluginId}/dist/tui.js`]",
  ),
  'unregisterPlugin removes the bare relative plugin id too',
)
assert.ok(
  pluginInstaller.includes("'/src/plugins/tui/dist/tui.tsx'") &&
    pluginInstaller.includes("'/plugins/pantheon-tui/dist/tui.tsx'") &&
    pluginInstaller.includes("'/plugins/pantheon-tui'"),
  'unregisterPlugin removes stale absolute TUI registrations from previous installs (dist file refs + bare plugin dir ref)',
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
// P2-5b: behavioral — cross-location TUI registration sync. OpenCode loads
// tui.json from BOTH ~/.opencode AND $XDG_CONFIG_HOME/opencode when they
// exist, so stale absolute refs left in the NON-target location (old
// checkouts/package installs) must be cleaned too, while the current plugin
// is registered ONLY in the selected target.
// ---------------------------------------------------------------------------
const CURRENT_TUI_REF = join(ROOT, 'src', 'plugins', 'tui')
const STALE_ABS_REF = '/home/olddev/pantheon/src/plugins/tui/dist/tui.tsx'
const STALE_REL_REF = 'plugins/pantheon-tui'
const STALE_DIST_REF = '/home/olddev/pantheon/plugins/pantheon-tui/dist/tui.js'

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

// (a) clean global install → destination has exactly 1 registration, the
// other global location stays empty (no stale refs, no created file).
withGlobalDirs(({ home, xdg }) => {
  const target = join(home, '.opencode')
  mkdirSync(target, { recursive: true })
  const status = syncTuiRegistration(target, { isGlobal: true, dryRun: false })
  assert.equal(status, 'created', 'clean install registers the current plugin')
  const targetCfg = readTuiJson(tuiAt(target, true))
  assert.ok(targetCfg, 'target tui.json created')
  assert.deepEqual(
    targetCfg.plugin,
    [CURRENT_TUI_REF],
    'target holds exactly the current registration',
  )
  const other = tuiAt(join(xdg, 'opencode'), true)
  assert.equal(
    readTuiJson(other)?.plugin.length ?? 0,
    0,
    'the non-target global location has no TUI registrations',
  )
})

// (b) pre-existing stale refs in the OTHER global location are cleaned on
// install, even though it is not the destination.
withGlobalDirs(({ home, xdg }) => {
  const target = join(home, '.opencode')
  mkdirSync(target, { recursive: true })
  const otherDir = join(xdg, 'opencode')
  mkdirSync(otherDir, { recursive: true })
  const otherTui = tuiAt(otherDir, true)
  writeFileSync(
    otherTui,
    JSON.stringify({ plugin: [STALE_ABS_REF, STALE_REL_REF, STALE_DIST_REF] }, null, 2),
  )
  syncTuiRegistration(target, { isGlobal: true, dryRun: false })
  assert.deepEqual(
    readTuiJson(otherTui).plugin,
    [],
    'stale absolute + relative + dist refs removed from the non-target location',
  )
  assert.deepEqual(
    readTuiJson(tuiAt(target, true)).plugin,
    [CURRENT_TUI_REF],
    'destination still holds exactly the current registration',
  )
})

// (c) an already-correct registration in the destination is preserved
// (no duplicate, no stale-ref removal of the current ref).
withGlobalDirs(({ home, xdg }) => {
  const target = join(home, '.opencode')
  mkdirSync(target, { recursive: true })
  const targetTui = tuiAt(target, true)
  writeFileSync(targetTui, JSON.stringify({ plugin: [CURRENT_TUI_REF] }, null, 2))
  syncTuiRegistration(target, { isGlobal: true, dryRun: false })
  assert.deepEqual(
    readTuiJson(targetTui).plugin,
    [CURRENT_TUI_REF],
    're-install preserves the current registration exactly once',
  )
  const other = tuiAt(join(xdg, 'opencode'), true)
  assert.equal(
    readTuiJson(other)?.plugin.length ?? 0,
    0,
    're-install keeps the other global location clean',
  )
})

console.log('✅ Pantheon Vision MCP installation contract passed')
