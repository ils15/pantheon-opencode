/** Behavioral tests for the layered doctor healthcheck (issue #18). */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkCodeModeDir,
  checkPluginVersionDrift,
  classifyAgentsMdFreshness,
  classifyPermissionTaskCheck,
  classifyPluginVersionDrift,
  collectMcpConfigs,
  collectRegisteredPluginRefs,
  deriveInstalledAgentFiles,
  findMissingPermissionTask,
  hasPermissionTask,
  isValidAgentFile,
  resolveCodeModeDir,
  resolveInstalledPackageRoot,
  resolveOpenCodeConfigDir,
  summaryMessage,
} from '../scripts/doctor.mjs'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))

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

// ---------------------------------------------------------------------------
// F.2 Code-mode scripts directory check
// ---------------------------------------------------------------------------

// Project layout: missing <target>/.opencode/.pantheon/code-mode is created
// with a warning (no throw, no exit-code change beyond warnings).
const codeModeFixture = mkdtempSync(join(tmpdir(), 'pantheon-doctor-codemode-'))
try {
  mkdirSync(join(codeModeFixture, '.opencode'), { recursive: true })
  const created = checkCodeModeDir({ target: codeModeFixture })
  assert.equal(
    created,
    join(codeModeFixture, '.opencode', '.pantheon', 'code-mode'),
    'F.2 resolves the project runtime code-mode dir',
  )
  // Second call: dir now exists → pass path, no creation needed.
  const existing = checkCodeModeDir({ target: codeModeFixture })
  assert.equal(existing, created, 'F.2 is idempotent when the dir exists')
} finally {
  rmSync(codeModeFixture, { recursive: true, force: true })
}

// F.2 parity with the MCP resolver (_has_usable_scripts): an EMPTY project
// overlay must NOT mask a lower-priority `.pantheon/code-mode` that actually
// ships scripts. Before the fix, existsSync let the empty overlay win and the
// manifest check reported a false missing-manifest error.
const overlayFixture = mkdtempSync(join(tmpdir(), 'pantheon-doctor-codemode-overlay-'))
try {
  const emptyOverlay = join(overlayFixture, '.opencode', '.pantheon', 'code-mode')
  mkdirSync(emptyOverlay, { recursive: true })
  const seeded = join(overlayFixture, '.pantheon', 'code-mode')
  mkdirSync(seeded, { recursive: true })
  writeFileSync(join(seeded, 'seed.sh'), '#!/usr/bin/env bash\necho seed\n')

  assert.equal(
    resolveCodeModeDir({ target: overlayFixture }),
    seeded,
    'F.2 skips an empty overlay and resolves the seeded project dir',
  )
  assert.equal(
    checkCodeModeDir({ target: overlayFixture }),
    seeded,
    'F.2 check uses the same usability rule as the MCP resolver',
  )
} finally {
  rmSync(overlayFixture, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// H3. Plugin version drift (issue #158)
// ---------------------------------------------------------------------------
// A lockfile-pinned npm install can keep an installed pantheon-opencode copy
// on an older version while the running package moved on (e.g. 1.5.0 removed
// the pantheon_delegate tool). The opencode.json keeps pointing at that stale
// copy, so the user silently runs an obsolete tool surface. The doctor must
// detect the drift and warn; a healthy install must stay quiet.

// Only paths INSIDE a node_modules/pantheon-opencode tree count as an
// installed copy — dev checkouts and third-party dirs are never flagged.
assert.equal(
  resolveInstalledPackageRoot('/home/admin/node_modules/pantheon-opencode/src/plugin.ts'),
  '/home/admin/node_modules/pantheon-opencode',
  'absolute node_modules V1 path resolves to its package root',
)
assert.equal(
  resolveInstalledPackageRoot(
    '/home/admin/node_modules/pantheon-opencode/src/plugins/pantheon-hooks.ts',
  ),
  '/home/admin/node_modules/pantheon-opencode',
  'hooks plugin resolves to the same package root',
)
assert.equal(
  resolveInstalledPackageRoot(
    '/home/admin/.npm/_npx/abc/node_modules/pantheon-opencode/src/plugin-v2',
  ),
  '/home/admin/.npm/_npx/abc/node_modules/pantheon-opencode',
  'npx-cache copy resolves to its package root',
)
assert.equal(
  resolveInstalledPackageRoot('src/plugin.ts'),
  null,
  'relative V1 ref is not an installed copy',
)
assert.equal(
  resolveInstalledPackageRoot('src/plugin-v2'),
  null,
  'relative V2 ref is not an installed copy',
)
assert.equal(
  resolveInstalledPackageRoot('/home/dev/pantheon/src/plugin.ts'),
  null,
  'dev checkout outside node_modules is not an installed copy',
)
assert.equal(resolveInstalledPackageRoot(null), null, 'non-string ref is ignored')

// Classification: a stable release outranks any beta of the same core version.
assert.equal(classifyPluginVersionDrift('1.4.1', '1.5.0'), 'drift', 'older installed copy is drift')
assert.equal(classifyPluginVersionDrift('1.5.0', '1.5.0'), 'sync', 'same version is sync')
assert.equal(classifyPluginVersionDrift('1.5.0', '1.4.1'), 'drift', 'newer installed copy is drift')
assert.equal(
  classifyPluginVersionDrift('1.5.0-beta.9', '1.5.0'),
  'drift',
  'beta installed vs stable package is drift',
)
assert.equal(
  classifyPluginVersionDrift('1.5.0', '1.5.0-beta.9'),
  'drift',
  'stable installed vs beta package is drift',
)
assert.equal(
  classifyPluginVersionDrift('1.5.0-beta.9', '1.5.0-beta.9'),
  'sync',
  'same beta is sync',
)
assert.equal(
  classifyPluginVersionDrift(null, '1.5.0'),
  'unknown',
  'missing registered version is unknown',
)
assert.equal(
  classifyPluginVersionDrift('1.5.0', null),
  'unknown',
  'missing package version is unknown',
)

// Registered refs are collected from BOTH the V1 `plugin` and V2 `plugins`
// lists, preserving the config they came from (relative refs resolve against
// the config directory, never against cwd).
assert.deepEqual(
  collectRegisteredPluginRefs([
    {
      path: '/c1/opencode.json',
      data: { plugin: ['/abs/node_modules/pantheon-opencode/src/plugin.ts', 'third-party'] },
    },
    { path: '/c2/opencode.json', data: { plugins: ['src/plugin-v2'] } },
  ]).map((r) => r.path),
  ['/abs/node_modules/pantheon-opencode/src/plugin.ts', 'third-party', 'src/plugin-v2'],
  'both plugin lists are collected in order',
)
assert.deepEqual(
  collectRegisteredPluginRefs([{ path: '/c/opencode.json', data: {} }]),
  [],
  'no plugin keys → no refs',
)

// End-to-end: a project whose opencode.json registers a plugin inside a
// node_modules copy pinned to an older version must be flagged as drift.
const driftFixture = mkdtempSync(join(tmpdir(), 'pantheon-doctor-drift-'))
try {
  const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const staleCopy = join(driftFixture, 'node_modules', 'pantheon-opencode')
  mkdirSync(join(staleCopy, 'src'), { recursive: true })
  writeFileSync(join(staleCopy, 'src', 'plugin.ts'), '// stale pinned copy\n')
  writeFileSync(
    join(staleCopy, 'package.json'),
    JSON.stringify({ name: 'pantheon-opencode', version: '1.4.1' }),
  )
  mkdirSync(join(driftFixture, '.config', 'opencode'), { recursive: true })
  writeFileSync(
    join(driftFixture, 'opencode.json'),
    JSON.stringify({ plugin: [join(staleCopy, 'src', 'plugin.ts')] }),
  )

  assert.equal(
    checkPluginVersionDrift({ target: driftFixture, env: { HOME: driftFixture } }),
    'drift',
    'doctor flags a plugin registered inside an older installed copy',
  )

  // Healthy state: the installed copy carries the SAME version as the running
  // package — no warning, no false positive.
  writeFileSync(
    join(staleCopy, 'package.json'),
    JSON.stringify({ name: 'pantheon-opencode', version: packageVersion }),
  )
  assert.equal(
    checkPluginVersionDrift({ target: driftFixture, env: { HOME: driftFixture } }),
    'sync',
    'same-version installed copy reports sync (no false positive)',
  )

  // A project that registers the plugin by relative/ROOT path (dev checkout)
  // has no node_modules copy to compare and is skipped, never flagged.
  writeFileSync(join(driftFixture, 'opencode.json'), JSON.stringify({ plugins: ['src/plugin-v2'] }))
  assert.equal(
    checkPluginVersionDrift({ target: driftFixture, env: { HOME: driftFixture } }),
    'skip',
    'non-node_modules registration is skipped, not flagged',
  )
} finally {
  rmSync(driftFixture, { recursive: true, force: true })
}

console.log('✅ Doctor layered healthcheck contract passed')
