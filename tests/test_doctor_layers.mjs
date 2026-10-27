/** Behavioral tests for the layered doctor healthcheck (issue #18). */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkCodeModeDir,
  checkPluginVersionDrift,
  classifyAgentsMdFreshness,
  classifyNodeSqliteProbe,
  classifyPermissionTaskCheck,
  classifyPluginVersionDrift,
  classifyRequiredRuntimeFile,
  collectMcpConfigs,
  collectRegisteredPluginRefs,
  deriveInstalledAgentFiles,
  findMissingPermissionTask,
  getMcpServerEntries,
  hasPermissionTask,
  isValidAgentFile,
  probeNodeSqlite,
  resolveCodeModeDir,
  resolveInstalledPackageRoot,
  resolveOpenCodeConfigDir,
  resolveRuntimePython,
  summaryMessage,
  validateRequiredRuntimeFile,
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

assert.deepEqual(
  getMcpServerEntries({
    servers: {
      'pantheon-memory': { type: 'local', command: ['/runtime/python'] },
      overlap: { type: 'remote', url: 'https://nested.example/mcp' },
    },
    'flat-user': { type: 'remote', url: 'https://flat.example/mcp' },
    overlap: { type: 'local', command: ['/flat/python'] },
  }),
  {
    'pantheon-memory': { type: 'local', command: ['/runtime/python'] },
    'flat-user': { type: 'remote', url: 'https://flat.example/mcp' },
    overlap: { type: 'remote', url: 'https://nested.example/mcp' },
  },
  'V2 nested entries and distinct V1 flat entries are both visible, with V2 winning duplicates',
)

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
assert.equal(classifyRequiredRuntimeFile(true), 'present')
assert.equal(
  classifyRequiredRuntimeFile(false),
  'error',
  'missing runtime requirements are blocking rather than advisory',
)
const missingRequirements = join(tmpdir(), 'pantheon-doctor-requirements-does-not-exist.txt')
assert.equal(validateRequiredRuntimeFile(missingRequirements).ok, false)

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

  const checkout = join(sandboxHome, 'checkout')
  mkdirSync(join(checkout, '.opencode'), { recursive: true })
  assert.equal(
    resolveRuntimePython({ target: checkout, env: {} }),
    'python3',
    'a checkout without a pre-existing venv falls back to PATH python3',
  )
  assert.equal(
    resolveRuntimePython({ target: checkout, env: { PANTHEON_PYTHON: '/opt/ci/python' } }),
    '/opt/ci/python',
    'PANTHEON_PYTHON explicitly selects the CI interpreter',
  )
} finally {
  rmSync(sandboxHome, { recursive: true, force: true })
}

// Global and sandbox profiles require the core MCPs, while lite intentionally
// keeps the MCP layer optional.
const mcpProfileFixture = mkdtempSync(join(tmpdir(), 'pantheon-doctor-mcp-profile-'))
try {
  writeFileSync(join(mcpProfileFixture, 'opencode.json'), JSON.stringify({ mcp: {} }))
  const configHome = join(mcpProfileFixture, 'config')
  const privateTmp = join(mcpProfileFixture, 'tmp')
  mkdirSync(privateTmp)
  const env = {
    ...process.env,
    HOME: mcpProfileFixture,
    XDG_CONFIG_HOME: configHome,
    PANTHEON_HOME: join(configHome, 'opencode'),
    TMPDIR: privateTmp,
  }
  const doctor = join(ROOT, 'scripts', 'doctor.mjs')
  const hasRequiredMcp = (report, name, state) =>
    report.findings.some(({ code, server }) => code === `required_mcp_${state}` && server === name)
  const requiredProfile = spawnSync(
    process.execPath,
    [doctor, '--target', mcpProfileFixture, '--profile', 'global', '--json'],
    { encoding: 'utf8', env },
  )
  assert.equal(
    hasRequiredMcp(JSON.parse(requiredProfile.stdout), 'pantheon-persistence', 'missing'),
    true,
    'global doctor profile requires pantheon-persistence',
  )

  writeFileSync(
    join(mcpProfileFixture, 'opencode.json'),
    JSON.stringify({
      mcp: {
        'pantheon-persistence': {
          enabled: false,
          type: 'remote',
          url: 'https://persistence.example/mcp',
        },
      },
    }),
  )
  const presenceOnlyProfile = spawnSync(
    process.execPath,
    [doctor, '--target', mcpProfileFixture, '--profile', 'global', '--json'],
    { encoding: 'utf8', env },
  )
  assert.equal(
    hasRequiredMcp(JSON.parse(presenceOnlyProfile.stdout), 'pantheon-persistence', 'present'),
    true,
    'required MCP check reports presence without asserting enabled or usable transport',
  )

  const runJsonDoctor = (mcp) => {
    writeFileSync(join(mcpProfileFixture, 'opencode.json'), JSON.stringify({ mcp }))
    const result = spawnSync(
      process.execPath,
      [doctor, '--target', mcpProfileFixture, '--profile', 'global', '--json'],
      { encoding: 'utf8', env },
    )
    assert.ok(result.stdout, result.stderr || 'doctor JSON invocation produced no report')
    return JSON.parse(result.stdout)
  }

  const validRequiredServers = {
    'pantheon-resources': {
      type: 'remote',
      url: 'https://resources.example/mcp',
      headers: { Accept: 'application/json' },
      oauth: false,
    },
    'pantheon-persistence': {
      type: 'local',
      command: ['python3', 'server.py'],
      cwd: '.',
      environment: { MODE: 'test' },
      enabled: false,
    },
  }

  const injectedGhGrepHeader = 'local\n⚠️ forged warning \u001b[31mGH_GREP_SECRET_SENTINEL'
  const ghGrepConfig = {
    gh_grep: {
      type: 'remote',
      url: 'https://custom.example/mcp',
      headers: { 'X-Test': injectedGhGrepHeader },
    },
  }
  writeFileSync(join(mcpProfileFixture, 'opencode.json'), JSON.stringify({ mcp: ghGrepConfig }))
  const textGhGrepReport = spawnSync(
    process.execPath,
    [doctor, '--target', mcpProfileFixture, '--profile', 'lite', '--verbose'],
    { encoding: 'utf8', env },
  )
  assert.ok(
    textGhGrepReport.stdout,
    textGhGrepReport.stderr || 'doctor text invocation produced no output',
  )
  assert.equal(
    textGhGrepReport.status,
    2,
    'text doctor completes with its expected unrelated fixture errors',
  )
  assert.doesNotMatch(
    `${textGhGrepReport.stdout}\n${textGhGrepReport.stderr}`,
    /Doctor crashed:/,
    'text doctor emits a report instead of crashing',
  )
  assert.match(
    textGhGrepReport.stdout,
    /gh_grep MCP may need review — expected a remote MCP at the recommended endpoint/,
    'text report includes the generic gh_grep diagnostic',
  )
  const textGhGrepOutput = `${textGhGrepReport.stdout}\n${textGhGrepReport.stderr}`
  for (const sentinel of ['GH_GREP_SECRET_SENTINEL', 'forged warning', '\u001b[31m']) {
    assert.equal(
      textGhGrepOutput.includes(sentinel),
      false,
      `text stdout/stderr do not emit gh_grep sentinel ${JSON.stringify(sentinel)}`,
    )
  }
  writeFileSync(join(mcpProfileFixture, 'opencode.json'), JSON.stringify({ mcp: ghGrepConfig }))
  const jsonGhGrepProcess = spawnSync(
    process.execPath,
    [doctor, '--target', mcpProfileFixture, '--profile', 'lite', '--json'],
    { encoding: 'utf8', env },
  )
  assert.ok(
    jsonGhGrepProcess.stdout,
    jsonGhGrepProcess.stderr || 'doctor JSON invocation produced no report',
  )
  const jsonGhGrepReport = JSON.parse(jsonGhGrepProcess.stdout)
  assert.equal(
    jsonGhGrepProcess.status,
    jsonGhGrepReport.summary.exit_code,
    'JSON process exit code matches the completed doctor report',
  )
  assert.equal(
    jsonGhGrepProcess.status,
    2,
    'JSON doctor exits with the expected unrelated fixture errors',
  )
  assert.equal(
    jsonGhGrepReport.findings.some(({ code }) => code === 'doctor_failure'),
    false,
    'JSON doctor produced a normal report instead of a crash fallback',
  )
  assert.ok(
    jsonGhGrepReport.findings.some(
      ({ category, message }) =>
        category === 'warn' &&
        /gh_grep MCP may need review — expected a remote MCP at the recommended endpoint/.test(
          message,
        ),
    ),
    'JSON report includes the generic gh_grep diagnostic',
  )
  const jsonGhGrepOutput = `${jsonGhGrepProcess.stdout}\n${jsonGhGrepProcess.stderr}`
  for (const sentinel of ['GH_GREP_SECRET_SENTINEL', 'forged warning', '\u001b[31m']) {
    assert.equal(
      jsonGhGrepOutput.includes(sentinel),
      false,
      `JSON stdout/stderr do not emit gh_grep sentinel ${JSON.stringify(sentinel)}`,
    )
  }

  for (const [server, malformed] of [
    ['context7', 'CONTEXT7_SCALAR_SECRET_SENTINEL'],
    ['gh_grep', null],
  ]) {
    const report = runJsonDoctor({ [server]: malformed })
    assert.ok(
      report.findings.some(
        ({ category, message }) =>
          category === 'warn' && /MCP server entry is invalid/.test(message),
      ),
      `scalar ${server} MCP entry gets a generic invalid-entry warning`,
    )
    assert.doesNotMatch(
      JSON.stringify(report),
      new RegExp(`optional ${server === 'context7' ? 'Context7' : 'gh_grep'} MCP not configured`),
      `scalar ${server} MCP entry is not described as absent`,
    )
    assert.equal(
      JSON.stringify(report).includes(server),
      false,
      `scalar ${server} MCP config key is not echoed in diagnostics`,
    )
  }

  const invalidGhGrepReport = runJsonDoctor({
    gh_grep: {
      type: 'remote',
      url: 'https://mcp.grep.app',
      headers: { Authorization: 7, Debug: 'GH_GREP_INVALID_SECRET_SENTINEL' },
    },
  })
  assert.ok(
    invalidGhGrepReport.findings.some(
      ({ category, message }) => category === 'warn' && /MCP server entry is invalid/.test(message),
    ),
    'malformed gh_grep entry is explicitly flagged invalid',
  )
  assert.equal(
    invalidGhGrepReport.findings.some(
      ({ category, message }) =>
        category === 'pass' && /gh_grep MCP configured correctly/.test(message),
    ),
    false,
    'malformed gh_grep entry cannot pass the special detector',
  )
  assert.doesNotMatch(
    JSON.stringify(invalidGhGrepReport),
    /GH_GREP_INVALID_SECRET_SENTINEL/,
    'invalid gh_grep values are not echoed in JSON findings',
  )

  for (const command of [
    ['context7-mcp', 7],
    [7, 'context7-mcp'],
  ]) {
    writeFileSync(
      join(mcpProfileFixture, 'opencode.json'),
      JSON.stringify({
        mcp: {
          context7: {
            type: 'local',
            command,
            cwd: 'CONTEXT7_SECRET_SENTINEL',
          },
        },
      }),
    )
    const context7Report = spawnSync(
      process.execPath,
      [doctor, '--target', mcpProfileFixture, '--profile', 'lite', '--verbose'],
      { encoding: 'utf8', env },
    )
    const output = `${context7Report.stdout}\n${context7Report.stderr}`
    assert.equal(
      context7Report.status,
      2,
      `malformed Context7 argv ${JSON.stringify(command)} completes with expected fixture errors`,
    )
    assert.doesNotMatch(
      output,
      /Doctor crashed:/,
      'malformed Context7 input does not crash the doctor',
    )
    assert.match(
      output,
      /MCP server entry is invalid/,
      'malformed Context7 entry is explicitly flagged invalid',
    )
    assert.doesNotMatch(
      output,
      /Context7 MCP configured correctly/,
      'malformed Context7 entry is never reported successful',
    )
    assert.doesNotMatch(
      output,
      /CONTEXT7_SECRET_SENTINEL/,
      'malformed Context7 values are not printed',
    )
  }

  const malformedNestedEntries = [
    ['partial cwd-only entry', { cwd: '/private/DO_NOT_PRINT' }],
    ['unsupported type', { type: 'stdio', command: ['python3'] }],
    ['V2 local command is not an argv array', { type: 'local', command: 'SECRET_COMMAND' }],
    ['empty V2 local command', { type: 'local', command: [] }],
    ['V2 local command contains non-string argv', { type: 'local', command: ['python3', 7] }],
    [
      'V2 timeout must be a supported positive-integer map',
      {
        type: 'local',
        command: ['python3'],
        timeout: { catalog: 0 },
      },
    ],
    [
      'V2 timeout must use its supported map shape',
      {
        type: 'local',
        command: ['python3'],
        timeout: 60000,
      },
    ],
    ['remote entry has no URL', { type: 'remote' }],
    ['non-object nested entry', 'SECRET_ENTRY'],
    ['null nested entry', null],
  ]
  for (const [label, malformed] of malformedNestedEntries) {
    const report = runJsonDoctor({
      servers: { 'pantheon-memory': malformed, ...validRequiredServers },
    })
    assert.ok(
      hasRequiredMcp(report, 'pantheon-memory', 'missing'),
      `${label}: malformed nested required entry is not counted as present`,
    )
    assert.ok(
      report.findings.some(
        ({ category, message }) =>
          category === 'warn' && /MCP server entry is invalid/.test(message),
      ),
      `${label}: malformed nested entry gets a generic invalid-entry warning`,
    )
    assert.ok(
      !hasRequiredMcp(report, 'pantheon-memory', 'present'),
      `${label}: doctor does not report the malformed entry as present`,
    )
    assert.doesNotMatch(
      JSON.stringify(report.findings),
      /DO_NOT_PRINT|SECRET_COMMAND/,
      `${label}: malformed user values are not included in doctor findings`,
    )
  }

  for (const [label, url] of [
    ['malformed remote URL', 'not-a-URL'],
    ['relative remote URL', '/mcp'],
    ['non-HTTP remote URL', 'file:///tmp/mcp'],
  ]) {
    const report = runJsonDoctor({
      servers: {
        'pantheon-memory': { type: 'remote', url },
        ...validRequiredServers,
      },
    })
    assert.ok(
      hasRequiredMcp(report, 'pantheon-memory', 'missing'),
      `${label}: malformed remote endpoint is not counted as present`,
    )
  }

  const validNestedReport = runJsonDoctor({
    servers: {
      'pantheon-memory': {
        type: 'local',
        command: ['python3'],
        cwd: '.',
        environment: { MODE: 'test' },
        enabled: false,
        timeout: { catalog: 5000 },
      },
      ...validRequiredServers,
    },
  })
  for (const name of ['pantheon-memory', 'pantheon-resources', 'pantheon-persistence']) {
    assert.ok(
      hasRequiredMcp(validNestedReport, name, 'present'),
      `valid V2 local/remote entry ${name} is reported present`,
    )
  }

  const validV1FlatReport = runJsonDoctor({
    'pantheon-memory': { type: 'local', command: ['python3', '-V'], timeout: 5000 },
    ...validRequiredServers,
  })
  assert.ok(
    hasRequiredMcp(validV1FlatReport, 'pantheon-memory', 'present'),
    'V1 flat local argv-array shape remains supported',
  )

  const validEmptyArgReport = runJsonDoctor({
    servers: {
      'pantheon-memory': { type: 'local', command: ['python3', ''] },
      ...validRequiredServers,
    },
  })
  assert.ok(
    hasRequiredMcp(validEmptyArgReport, 'pantheon-memory', 'present'),
    'an empty string is accepted as a valid process argument',
  )

  const validHttpRemoteReport = runJsonDoctor({
    servers: {
      'pantheon-memory': { type: 'remote', url: 'http://localhost:3000/mcp' },
      ...validRequiredServers,
    },
  })
  assert.ok(
    hasRequiredMcp(validHttpRemoteReport, 'pantheon-memory', 'present'),
    'an absolute HTTP Streamable MCP endpoint is accepted',
  )

  for (const [label, url, secret] of [
    [
      'username only',
      'https://REMOTE_USERNAME_SECRET_SENTINEL@memory.example/mcp',
      'REMOTE_USERNAME_SECRET_SENTINEL',
    ],
    [
      'password only',
      'https://:REMOTE_PASSWORD_SECRET_SENTINEL@memory.example/mcp',
      'REMOTE_PASSWORD_SECRET_SENTINEL',
    ],
    [
      'username and password',
      'https://user:REMOTE_URL_SECRET_SENTINEL@memory.example/mcp',
      'REMOTE_URL_SECRET_SENTINEL',
    ],
  ]) {
    const report = runJsonDoctor({
      servers: {
        'pantheon-memory': { type: 'remote', url },
        ...validRequiredServers,
      },
    })
    assert.ok(
      hasRequiredMcp(report, 'pantheon-memory', 'missing'),
      `${label}: remote MCP URL with embedded credentials is rejected`,
    )
    const output = JSON.stringify(report)
    assert.match(
      output,
      /environment variables for authentication/,
      `${label}: credential rejection advises using environment variables`,
    )
    assert.ok(
      !output.includes(url) && !output.includes(secret),
      `${label}: credential rejection does not echo the URL or secret`,
    )
  }

  const malformedV1ScalarReport = runJsonDoctor({
    'pantheon-memory': { type: 'local', command: 'SECRET_COMMAND', args: ['SECRET_ARG'] },
    ...validRequiredServers,
  })
  assert.ok(
    hasRequiredMcp(malformedV1ScalarReport, 'pantheon-memory', 'missing'),
    'legacy scalar V1 command plus args is rejected; V1 command must be an argv array',
  )

  const liteProfile = spawnSync(
    process.execPath,
    [doctor, '--target', mcpProfileFixture, '--profile', 'lite', '--json'],
    { encoding: 'utf8', env },
  )
  assert.equal(
    JSON.parse(liteProfile.stdout).findings.some(({ code }) => code === 'required_mcp_missing'),
    false,
    'lite doctor profile leaves all MCPs optional',
  )
} finally {
  rmSync(mcpProfileFixture, { recursive: true, force: true })
}

// Invalid local MCP entries must not reach path diagnostics or runtime spawn.
// The doctor runs in an isolated HOME/XDG config, and the configured marker
// process would write a file if an invalid entry were launched.
const malformedMcpFixture = mkdtempSync(join(tmpdir(), 'pantheon-doctor-mcp-redaction-'))
try {
  const privateCwd = join(malformedMcpFixture, 'PATH_SENTINEL')
  mkdirSync(privateCwd)
  const commandScript = join(malformedMcpFixture, 'COMMAND_SENTINEL.js')
  const spawnMarker = join(malformedMcpFixture, 'spawned')
  writeFileSync(
    commandScript,
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(spawnMarker)}, 'spawned')\n`,
  )
  const config = {
    mcp: {
      servers: {
        context7: 'CONTEXT7_SCALAR_SECRET_SENTINEL',
        gh_grep: 7,
        MALFORMED_SERVER_NAME_SENTINEL: 'MALFORMED_ENTRY_VALUE_SENTINEL',
        malformed: {
          type: 'local',
          command: [process.execPath, commandScript, 'ARGS_SENTINEL.py'],
          cwd: privateCwd,
          environment: { ENV_KEY_SENTINEL: { secret: 'ENV_VALUE_SENTINEL' } },
        },
        malformedCommand: {
          type: 'local',
          command: [process.execPath, commandScript, 'ARGS_SENTINEL.py', 7],
          cwd: privateCwd,
          environment: { ENV_KEY_SENTINEL: { secret: 'ENV_VALUE_SENTINEL' } },
        },
      },
    },
  }
  writeFileSync(join(malformedMcpFixture, 'opencode.json'), JSON.stringify(config))
  const privateHome = join(malformedMcpFixture, 'home')
  const privateXdg = join(malformedMcpFixture, 'xdg')
  const privateTmp = join(malformedMcpFixture, 'tmp')
  mkdirSync(privateHome)
  mkdirSync(privateXdg)
  mkdirSync(privateTmp)
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'doctor.mjs'), '--target', malformedMcpFixture, '--profile', 'lite'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: privateHome,
        XDG_CONFIG_HOME: privateXdg,
        PANTHEON_HOME: join(privateXdg, 'opencode'),
        TMPDIR: privateTmp,
      },
    },
  )
  const doctorOutput = `${result.stdout}\n${result.stderr}`
  assert.match(
    doctorOutput,
    /MCP server entry is invalid/,
    'malformed non-special and scalar MCP entries get a generic diagnostic',
  )
  assert.doesNotMatch(
    doctorOutput,
    /optional (?:Context7|gh_grep) MCP not configured/,
    'present scalar special MCP entries are not described as absent',
  )
  for (const sentinel of [
    'COMMAND_SENTINEL',
    'ARGS_SENTINEL',
    'ENV_KEY_SENTINEL',
    'ENV_VALUE_SENTINEL',
    'PATH_SENTINEL',
    'CONTEXT7_SCALAR_SECRET_SENTINEL',
    'MALFORMED_SERVER_NAME_SENTINEL',
    'MALFORMED_ENTRY_VALUE_SENTINEL',
  ]) {
    assert.ok(!doctorOutput.includes(sentinel), `doctor output/error redacts ${sentinel}`)
  }
  assert.equal(existsSync(spawnMarker), false, 'invalid local entry is never spawned')
} finally {
  rmSync(malformedMcpFixture, { recursive: true, force: true })
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
  // has no node_modules copy to compare and is skipped, never flagged. The
  // referenced tree has to EXIST for that shape to be real: a relative ref that
  // resolves nowhere is a dangling registration and the doctor fails closed on
  // it (P0-6, tests/doctor-plugin-path-staleness.test.mjs).
  mkdirSync(join(driftFixture, 'src', 'plugin-v2'), { recursive: true })
  writeFileSync(join(driftFixture, 'src', 'plugin-v2', 'index.ts'), '// dev entry\n')
  writeFileSync(join(driftFixture, 'opencode.json'), JSON.stringify({ plugins: ['src/plugin-v2'] }))
  assert.equal(
    checkPluginVersionDrift({ target: driftFixture, env: { HOME: driftFixture } }),
    'skip',
    'non-node_modules registration is skipped, not flagged',
  )
} finally {
  rmSync(driftFixture, { recursive: true, force: true })
}
// K. Node Runtime — node:sqlite availability probe (issue #114)
// ---------------------------------------------------------------------------

// Classification is a pure function of the probe result, so the unsupported
// path is asserted without depending on the host Node version.
const supported = classifyNodeSqliteProbe({ available: true, version: 'v22.22.2' })
assert.equal(supported.status, 'ok', 'available node:sqlite classifies as ok')
assert.match(supported.message, /node:sqlite available/, 'ok message names node:sqlite')

const unsupported = classifyNodeSqliteProbe({ available: false, version: 'v18.20.0' })
assert.equal(unsupported.status, 'unsupported', 'missing node:sqlite classifies as unsupported')
assert.match(
  unsupported.message,
  /pantheon_cost will report UNSUPPORTED on Node v18\.20\.0 — node:sqlite requires Node >= 22\.5/,
  'unsupported message names the tool, the runtime version and the floor',
)

// The probe itself is exercised end-to-end: a builtin that cannot exist fails
// the real spawn+exit-status path, proving UNSUPPORTED is detected without
// mocking process.version.
const missing = probeNodeSqlite({ module: 'node:sqlite-pantheon-nonexistent' })
assert.equal(missing.available, false, 'probe reports unavailable for a missing builtin')
assert.ok(missing.reason, 'probe surfaces a reason string on failure')
assert.ok(missing.version, 'probe always reports the running Node version')

console.log('✅ Doctor layered healthcheck contract passed')
