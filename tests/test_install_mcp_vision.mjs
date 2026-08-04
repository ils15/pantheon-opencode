/** Installation contract tests for the local Pantheon Vision MCP. */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'

const opencodeInstaller = readFileSync('scripts/install/opencode.mjs', 'utf8')
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

assert.ok(catalog.includes("'pantheon-vision':"))
assert.ok(sourceCatalog.includes('../../scripts/install-mcp.mjs'))
assert.ok(catalog.includes("join(ROOT, 'src', 'mcp', 'pantheon_vision_server.py')"))
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

console.log('✅ Pantheon Vision MCP installation contract passed')
