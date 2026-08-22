/** Contract tests for the layered doctor healthcheck (issue #18). */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyAgentsMdFreshness,
  classifyPermissionTaskCheck,
  collectMcpConfigs,
  deriveInstalledAgentFiles,
  findMissingPermissionTask,
  hasPermissionTask,
  isValidAgentFile,
  resolveOpenCodeConfigDir,
  summaryMessage,
} from '../scripts/doctor.mjs'

const doctor = readFileSync('scripts/doctor.mjs', 'utf8')

// Layers required by issue #18 (Config layer = section B, existing)
assert.ok(doctor.includes('function checkVenvLayer'), 'venv/python layer present (F)')
assert.ok(doctor.includes('function checkMcpRuntimeSmoke'), 'MCP runtime smoke layer present (B.6)')
assert.ok(
  doctor.includes('function mcpInitializeSmoke'),
  'JSON-RPC initialize smoke helper present',
)
assert.ok(doctor.includes('function collectMcpConfigs'), 'shared config collection helper present')

// The B.5 spawn-path layer must be preserved
assert.ok(doctor.includes('Hermetic spawn check'), 'B.5 spawn-path layer preserved')

// JSON-RPC initialize handshake contract (source shape of the payload)
assert.ok(doctor.includes("jsonrpc: '2.0'"), 'jsonrpc 2.0')
assert.ok(doctor.includes("method: 'initialize'"), 'initialize method sent')
assert.ok(doctor.includes("protocolVersion: '2024-11-05'"), 'protocolVersion 2024-11-05')
assert.ok(
  doctor.includes("clientInfo: { name: 'pantheon-doctor', version: '0.0.0' }"),
  'clientInfo identifies pantheon-doctor',
)
assert.ok(doctor.includes('msg.id === 1'), 'smoke validates the initialize response id')

// Venv layer validates against the exact requirements pins
assert.ok(doctor.includes('requirements-mcp.txt'), 'checks requirements-mcp.txt pins')
assert.ok(doctor.includes('requirements-vision.txt'), 'checks requirements-vision.txt pins')
assert.ok(doctor.includes('parsePipFreeze'), 'pip freeze parser present')
assert.ok(doctor.includes('compareVersions'), 'version comparator present')

// Exit-code contract: critical failures must exit non-zero
assert.ok(doctor.includes('exitCode = 2'), 'errors set exit code 2')
assert.ok(doctor.includes('profile'), 'doctor has global/lite/sandbox profile awareness')
assert.ok(doctor.includes('optional gh_grep MCP not configured'), 'gh_grep is optional')
assert.ok(doctor.includes('optional Context7 MCP not configured'), 'Context7 is optional')
assert.ok(doctor.includes('optional helper skipped'), 'frontmatter helper is optional')
assert.ok(doctor.includes('Required MCP'), 'required MCP absence remains visible')
assert.ok(doctor.includes('warnings are allowed'), 'warnings do not change doctor exit status')
assert.ok(
  doctor.includes('runtime layer skipped for lite profile'),
  'lite profile skips optional runtime',
)

// A blocking error must never be presented as a positive/advisory-only result,
// even when warnings are also present.
const blockedWithWarnings = summaryMessage({ error: 1, warn: 2 }, 2)
assert.match(blockedWithWarnings, /blocking error/i, 'error+warning summary names blocking errors')
assert.match(blockedWithWarnings, /exit code 2/, 'error+warning summary names blocking exit code')
assert.doesNotMatch(
  blockedWithWarnings,
  /No blocking errors|All checks passed/i,
  'error+warning summary is not positive',
)

const warningsOnly = summaryMessage({ error: 0, warn: 1 }, 0)
assert.match(warningsOnly, /warnings are advisory/i, 'warnings-only summary remains advisory')

// Freshness is exercised through a deterministic result harness rather than
// mocking child_process or relying on filesystem timestamps.
assert.equal(
  classifyAgentsMdFreshness({
    targetIsRoot: true,
    agentsMdExists: true,
    generatorExists: true,
    generatorStatus: 1,
  }),
  'stale',
  'generator exit 1 reports stale AGENTS.md',
)
assert.equal(
  classifyAgentsMdFreshness({
    targetIsRoot: true,
    agentsMdExists: true,
    generatorExists: true,
    generatorStatus: 0,
  }),
  'pass',
  'generator exit 0 reports fresh AGENTS.md',
)
assert.equal(classifyPermissionTaskCheck('global', 1, 1), 'error')
assert.equal(classifyPermissionTaskCheck('sandbox', 1, 1), 'error')
assert.equal(classifyPermissionTaskCheck('lite', 1, 1), 'skip')

// User config resolution must follow the same isolated HOME/XDG/PANTHEON_HOME
// roots used by init/OpenCode, rather than the doctor's current working dir.
const sandboxHome = mkdtempSync(join(tmpdir(), 'pantheon-doctor-home-'))
try {
  const sandboxConfigDir = join(sandboxHome, '.config', 'opencode')
  mkdirSync(sandboxConfigDir, { recursive: true })
  const sandboxConfig = join(sandboxConfigDir, 'opencode.json')
  writeFileSync(sandboxConfig, JSON.stringify({ mcp: { 'pantheon-memory': { type: 'local' } } }))

  assert.equal(
    resolveOpenCodeConfigDir({ HOME: sandboxHome }),
    sandboxConfigDir,
    'sandbox HOME resolves to its OpenCode config root',
  )
  assert.ok(
    collectMcpConfigs({ target: sandboxHome, env: { HOME: sandboxHome } }).some(
      (cfg) => cfg.path === sandboxConfig,
    ),
    'doctor discovers MCPs from the effective sandbox user config',
  )

  const xdgConfigDir = join(sandboxHome, 'xdg')
  assert.equal(
    resolveOpenCodeConfigDir({ HOME: sandboxHome, XDG_CONFIG_HOME: xdgConfigDir }),
    join(xdgConfigDir, 'opencode'),
    'XDG_CONFIG_HOME overrides HOME/.config',
  )
  assert.equal(
    resolveOpenCodeConfigDir({ HOME: sandboxHome, PANTHEON_HOME: sandboxConfigDir }),
    sandboxConfigDir,
    'PANTHEON_HOME takes precedence and is already the config root',
  )
} finally {
  rmSync(sandboxHome, { recursive: true, force: true })
}

// B3 installer/doctor checks: installed agents are derived from config source
// paths, never from a hardcoded home-directory layout.
const doctorFixture = mkdtempSync(join(tmpdir(), 'pantheon-doctor-'))
try {
  const configPath = join(doctorFixture, 'opencode.json')
  const agentsDir = join(doctorFixture, '.opencode', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  const installedAgent = join(agentsDir, 'legacy.md')
  writeFileSync(installedAgent, '---\nmode: subagent\n---\n')
  const files = deriveInstalledAgentFiles([
    {
      path: configPath,
      data: { agent: { legacy: { source: '.opencode/agents/legacy.md' } } },
    },
  ])
  assert.deepEqual(files, [installedAgent])
  assert.equal(hasPermissionTask(readFileSync(installedAgent, 'utf8')), false)
  assert.deepEqual(findMissingPermissionTask(files), [installedAgent])
  writeFileSync(installedAgent, '---\npermission:\n  task:\n    "*": deny\n---\n')
  assert.deepEqual(findMissingPermissionTask(files), [])
  assert.equal(hasPermissionTask('---\nmode: primary\n---\n'), false)
} finally {
  rmSync(doctorFixture, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// isValidAgentFile — frontmatter validation for agent detection
// ---------------------------------------------------------------------------

// Valid agent files with frontmatter containing agent-defining fields
assert.equal(isValidAgentFile('---\nname: zeus\n---\n'), true, 'name field → valid')
assert.equal(
  isValidAgentFile('---\ndescription: Orchestrator\n---\n'),
  true,
  'description field → valid',
)
assert.equal(isValidAgentFile('---\nmode: all\n---\n'), true, 'mode field → valid')
assert.equal(
  isValidAgentFile('---\nname: hermes\ndescription: Backend\nmode: all\n---\n'),
  true,
  'all fields → valid',
)

// Invalid — no frontmatter
assert.equal(isValidAgentFile('# README\n\nSome text'), false, 'no frontmatter → invalid')

// Invalid — frontmatter present but no agent-defining fields
assert.equal(
  isValidAgentFile('---\ntemperature: 0.3\nsteps: 50\n---\n'),
  false,
  'frontmatter without agent fields → invalid',
)
assert.equal(
  isValidAgentFile('---\ncustom_field: value\n---\n'),
  false,
  'unrelated frontmatter → invalid',
)

// Real-world: README.md has no frontmatter
const readmeContent = '# Agent Reference — Pantheon\n\nThis directory contains...'
assert.equal(isValidAgentFile(readmeContent), false, 'README.md content → invalid')

// Blank / empty
assert.equal(isValidAgentFile(''), false, 'empty file → invalid')

// ---------------------------------------------------------------------------
// deriveInstalledAgentFiles excludes non-agent .md files
// ---------------------------------------------------------------------------

const readmeFixture = mkdtempSync(join(tmpdir(), 'pantheon-doctor-readme-'))
try {
  const configPath = join(readmeFixture, 'opencode.json')
  const agentsDir = join(readmeFixture, '.opencode', 'agents')
  mkdirSync(agentsDir, { recursive: true })

  // Create a valid agent
  const agentPath = join(agentsDir, 'zeus.md')
  writeFileSync(agentPath, '---\nname: zeus\ndescription: Orchestrator\n---\n')

  // Create a README.md (no frontmatter)
  const readmePath = join(agentsDir, 'README.md')
  writeFileSync(readmePath, '# Agent Reference\n\nThis directory has agents.')

  // Create a .md file with frontmatter but no agent fields
  const notesPath = join(agentsDir, 'NOTES.md')
  writeFileSync(notesPath, '---\ntitle: Meeting Notes\n---\n')

  const files = deriveInstalledAgentFiles([
    {
      path: configPath,
      data: { agent: { zeus: { source: '.opencode/agents/zeus.md' } } },
    },
  ])

  assert.deepEqual(
    files,
    [agentPath],
    'only valid agent .md returned; README.md and NOTES.md excluded',
  )
  assert.ok(!files.includes(readmePath), 'README.md is NOT listed as installed agent')
  assert.ok(!files.includes(notesPath), 'NOTES.md is NOT listed as installed agent')
} finally {
  rmSync(readmeFixture, { recursive: true, force: true })
}

console.log('✅ Doctor layered healthcheck contract passed')
