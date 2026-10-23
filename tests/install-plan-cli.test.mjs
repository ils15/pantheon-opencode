import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
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
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'

const CLI = join(process.cwd(), 'bin', 'pantheon-init.mjs')
const HAS_SCRIPT = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0

// These fixtures model the V1 layout (.opencode/agents/...). Pin the host
// generation so a preview never depends on which OpenCode binary happens to be
// installed on the machine running the tests.
function baseEnv(cwd) {
  return {
    ...process.env,
    HOME: cwd,
    XDG_CONFIG_HOME: join(cwd, '.config'),
    OPENCODE_VERSION: 'v1',
  }
}

function run(cwd, ...args) {
  return spawnSync(process.execPath, [CLI, 'init', ...args], {
    cwd,
    encoding: 'utf8',
    env: baseEnv(cwd),
  })
}

function runWithEnv(cwd, env, ...args) {
  return spawnSync(process.execPath, [CLI, 'init', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...baseEnv(cwd), ...env },
  })
}

function runAsync(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'init', ...args], {
      cwd,
      env: baseEnv(cwd),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function runInteractiveInput(cwd, input, ...args) {
  return new Promise((resolve, reject) => {
    const command = [process.execPath, CLI, 'init', ...args].map(shellQuote).join(' ')
    const child = spawn('script', ['-q', '-e', '-c', `exec ${command}`, '/dev/null'], {
      cwd,
      env: baseEnv(cwd),
    })
    let stdout = ''
    let stderr = ''
    let sentInput = false
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Timed out waiting for apply authorization prompt. Output: ${stdout}`))
    }, 15_000)
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
      if (!sentInput && stdout.includes('Reviewed plan:')) {
        sentInput = true
        setTimeout(() => child.stdin.write(input), 300)
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (status) => {
      clearTimeout(timeout)
      resolve({ status, stdout, stderr, sentInput })
    })
  })
}

function savePlan(root) {
  const target = join(root, 'target')
  const plan = join(root, 'reviewed-plan.json')
  mkdirSync(target)
  const result = run(
    target,
    '--project',
    '--no-mcp',
    '--components',
    'agents',
    '--dry-run',
    '--save-plan',
    plan,
  )
  assert.equal(result.status, 0, result.stderr)
  return { target, plan, result }
}

test('init dry-run JSON is stdout-only structured output and writes no target files', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-init-json-'))
  const target = join(root, 'target')
  try {
    mkdirSync(target)
    const result = run(
      target,
      '--project',
      '--no-mcp',
      '--components',
      'agents',
      '--dry-run',
      '--json',
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr.includes('outputFingerprint'), false)
    const report = JSON.parse(result.stdout)
    assert.equal(report.schema_version, 1)
    assert.equal(report.command, 'init')
    assert.equal(report.status, 'planned')
    assert.ok(report.files.some((file) => file.path === '.opencode/agents/zeus.md'))
    assert.equal(existsSync(join(target, '.opencode')), false)
    assert.deepEqual(readdirSync(target), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('init dry-run JSON names the MCP servers the apply will configure', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-init-mcp-json-'))
  const target = join(root, 'target')
  try {
    mkdirSync(target)
    const result = run(target, '--project', '--components', 'runtime', '--dry-run', '--json')
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.mcp_servers, [
      'pantheon-resources',
      'pantheon-code-mode',
      'pantheon-memory',
      'pantheon-persistence',
      'pantheon-vision',
    ])
    assert.equal(report.mcp_server_count, 5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('init dry-run JSON reports no phantom no-op operations on a fresh target', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-init-ghost-json-'))
  const target = join(root, 'target')
  const planPath = join(root, 'plan.json')
  try {
    mkdirSync(target)
    const result = run(
      target,
      '--project',
      '--components',
      'agents,plugins',
      '--dry-run',
      '--save-plan',
      planPath,
      '--json',
    )
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    const ghosts = report.files.filter((file) => file.action === 'unchanged' && file.bytes === 0)
    assert.deepEqual(
      ghosts.map((file) => file.path),
      [],
      'a plan must not list a no-op operation for a path that exists nowhere',
    )
    // The same invariant on the reviewed artifact, which carries `before`.
    const artifact = JSON.parse(readFileSync(planPath, 'utf8'))
    assert.deepEqual(
      artifact.operations
        .filter(
          (operation) =>
            operation.action === 'unchanged' &&
            operation.bytes === 0 &&
            operation.before.exists === false,
        )
        .map((operation) => operation.path),
      [],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the default plan probes the host and matches an explicit V2 plan', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-init-probe-'))
  const fakeBin = join(root, 'bin')
  const target = join(root, 'target')
  mkdirSync(fakeBin)
  mkdirSync(target)
  // A host that reports 2.x. The default dry run must USE this answer instead
  // of assuming V1 — otherwise its plan describes tui.json/index.ts backwards.
  writeFileSync(join(fakeBin, 'opencode'), '#!/bin/sh\necho "opencode v2.1.2"\n', {
    mode: 0o755,
  })
  const invoke = (...args) => {
    const env = baseEnv(target)
    // This test is ABOUT resolving the host, so it must not inherit the V1 pin.
    delete env.OPENCODE_VERSION
    env.PATH = `${fakeBin}:${process.env.PATH}`
    return spawnSync(
      process.execPath,
      [CLI, 'init', '--project', '--components', 'agents', '--dry-run', '--json', ...args],
      { cwd: target, encoding: 'utf8', env },
    )
  }
  // The reviewed-plan timestamp embeds the second it ran; a default and a
  // pinned preview may straddle a second boundary.
  const normalize = (files) => {
    const relative = (filePath) =>
      filePath.replace(/^\.pantheon\/backups\/[^/]+\//, '.pantheon/backups/<ts>/')
    return files
      .map((file) => ({ path: relative(file.path), action: file.action }))
      .sort((left, right) => left.path.localeCompare(right.path))
  }
  try {
    const auto = invoke()
    const pinned = invoke('--opencode-version', 'v2')
    assert.equal(auto.status, 0, auto.stderr)
    assert.equal(pinned.status, 0, pinned.stderr)
    const autoReport = JSON.parse(auto.stdout)
    const pinnedReport = JSON.parse(pinned.stdout)
    assert.equal(autoReport.open_code_version, 'v2', 'the default plan must use the probed host')
    assert.deepEqual(autoReport.advisories, [], 'a successful probe is not an assumption')
    assert.deepEqual(normalize(autoReport.files), normalize(pinnedReport.files))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('saved plan has mode 0600 and unauthorized apply writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-install-plan-auth-'))
  try {
    const { target, plan } = savePlan(root)
    assert.equal(statSync(plan).mode & 0o777, 0o600)
    const artifact = JSON.parse(readFileSync(plan, 'utf8'))
    assert.equal(artifact.schema_version, 1)
    assert.ok(artifact.operations.some((operation) => operation.outputFingerprint))
    assert.equal(readFileSync(plan, 'utf8').includes('# Pantheon Agent System'), false)

    const result = run(target, '--apply-plan', plan)
    assert.equal(result.status, 2)
    assert.equal(existsSync(join(target, 'agents')), false)
    assert.equal(existsSync(join(target, '.pantheon', 'backups')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('canceling interactive --apply-plan exits 130 and leaves the target unchanged', {
  skip: !HAS_SCRIPT,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-install-plan-cancel-'))
  try {
    const { target, plan } = savePlan(root)
    const sentinel = join(target, 'user-sentinel.txt')
    writeFileSync(sentinel, 'keep this file\n')
    const before = readdirSync(target).sort()

    const result = await runInteractiveInput(target, '\x03', '--apply-plan', plan)

    assert.equal(result.sentInput, true, result.stdout)
    assert.equal(result.status, 130, result.stderr || result.stdout)
    // One message, naming where it stopped (issue #262).
    assert.match(result.stdout, /Installation canceled at review prompt/)
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep this file\n')
    // The ONLY thing a canceled run may add is its own record: a re-run has to
    // be able to tell from disk that the previous one was canceled here.
    assert.deepEqual(readdirSync(target).sort(), [...before, '.pantheon'].sort())
    const record = JSON.parse(readFileSync(join(target, '.pantheon', 'last-run.json'), 'utf8'))
    assert.equal(record.status, 'canceled')
    assert.equal(record.cancel_point, 'review')
    assert.equal(record.applied, false)
    assert.match(record.summary, /canceled at review/)
    assert.equal(existsSync(join(target, '.opencode')), false)
    assert.equal(existsSync(join(target, 'opencode.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('declining interactive --apply-plan exits successfully and leaves the target unchanged', {
  skip: !HAS_SCRIPT,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-install-plan-decline-'))
  try {
    const { target, plan } = savePlan(root)
    const sentinel = join(target, 'user-sentinel.txt')
    writeFileSync(sentinel, 'keep this file\n')
    const before = readdirSync(target).sort()

    const result = await runInteractiveInput(target, '\r', '--apply-plan', plan)

    assert.equal(result.sentInput, true, result.stdout)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    // A decline is not a silent no-op: it names the point and the consequence.
    assert.match(result.stdout, /Installation declined at review prompt/)
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep this file\n')
    assert.deepEqual(readdirSync(target).sort(), [...before, '.pantheon'].sort())
    const record = JSON.parse(readFileSync(join(target, '.pantheon', 'last-run.json'), 'utf8'))
    assert.equal(record.status, 'declined')
    assert.equal(record.cancel_point, 'review')
    assert.equal(record.applied, false)
    assert.equal(existsSync(join(target, '.opencode')), false)
    assert.equal(existsSync(join(target, 'opencode.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('saved project plan safely records and applies external global TUI cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-install-plan-tui-'))
  const target = join(root, 'project')
  const home = join(root, 'home')
  const xdg = join(root, 'xdg')
  const plan = join(root, 'reviewed-plan.json')
  const externalTui = join(home, '.opencode', 'tui.json')
  try {
    mkdirSync(target)
    mkdirSync(join(home, '.opencode'), { recursive: true })
    mkdirSync(join(xdg, 'opencode'), { recursive: true })
    writeFileSync(externalTui, JSON.stringify({ plugin: ['plugins/pantheon-tui'] }))
    const preview = runWithEnv(
      target,
      { HOME: home, XDG_CONFIG_HOME: xdg },
      '--project',
      '--no-mcp',
      '--components',
      'plugins',
      '--opencode-version',
      'v1',
      '--dry-run',
      '--save-plan',
      plan,
    )
    assert.equal(preview.status, 0, preview.stderr)
    const artifact = JSON.parse(readFileSync(plan, 'utf8'))
    assert.ok(artifact.operations.some((operation) => operation.path === externalTui))

    const applied = runWithEnv(
      target,
      { HOME: home, XDG_CONFIG_HOME: xdg },
      '--apply-plan',
      plan,
      '--yes',
    )
    assert.equal(applied.status, 0, applied.stderr)
    assert.deepEqual(JSON.parse(readFileSync(externalTui, 'utf8')).plugin, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('JSON dry-run reports plan-save failures as one JSON document', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-init-json-plan-error-'))
  const target = join(root, 'target')
  const outside = join(root, 'outside')
  const link = join(root, 'linked')
  try {
    mkdirSync(target)
    mkdirSync(outside)
    symlinkSync(outside, link, 'dir')
    const result = run(
      target,
      '--project',
      '--no-mcp',
      '--components',
      'agents',
      '--dry-run',
      '--json',
      '--save-plan',
      join(link, 'plan.json'),
    )
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).status, 'error')
    assert.match(result.stderr, /symlink/i)
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('JSON save-plan rejects a collision with a planned target and preserves its sentinel', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-init-plan-collision-'))
  const target = join(root, 'target')
  const plannedFile = join(target, '.opencode', 'agents', 'zeus.md')
  const sentinel = 'user-managed sentinel\n'
  try {
    mkdirSync(dirname(plannedFile), { recursive: true })
    writeFileSync(plannedFile, sentinel)

    const result = run(
      target,
      '--project',
      '--no-mcp',
      '--components',
      'agents',
      '--dry-run',
      '--json',
      '--save-plan',
      plannedFile,
    )

    assert.equal(result.status, 1, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'error')
    assert.match(report.error, /planned operation/i)
    assert.equal(readFileSync(plannedFile, 'utf8'), sentinel)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent dry-run plan saves never replace the first destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-init-plan-race-'))
  const target = join(root, 'target')
  const plan = join(root, 'reviewed-plan.json')
  try {
    mkdirSync(target)
    const args = [
      '--project',
      '--no-mcp',
      '--components',
      'agents',
      '--dry-run',
      '--json',
      '--save-plan',
      plan,
    ]
    const results = await Promise.all([runAsync(target, ...args), runAsync(target, ...args)])

    assert.deepEqual(results.map(({ status }) => status).sort(), [0, 1])
    const reports = results.map(({ stdout }) => JSON.parse(stdout))
    assert.deepEqual(reports.map(({ status }) => status).sort(), ['error', 'planned'])
    assert.equal(JSON.parse(readFileSync(plan, 'utf8')).schema_version, 1)
    assert.deepEqual(readdirSync(root).sort(), ['reviewed-plan.json', 'target'])
    assert.equal(existsSync(join(target, '.opencode')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('saved plan drift aborts before writes with exit 3', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-install-plan-drift-'))
  try {
    const { target, plan } = savePlan(root)
    writeFileSync(join(target, 'opencode.json'), '{"user":true}\n')
    const result = run(target, '--apply-plan', plan, '--yes')
    assert.equal(result.status, 3)
    assert.match(result.stderr, /Reviewed install plan drifted/)
    assert.equal(existsSync(join(target, 'agents')), false)
    assert.equal(existsSync(join(target, '.pantheon', 'backups')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('authorized saved plan applies reviewed files and creates its backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-install-plan-apply-'))
  try {
    const { target, plan } = savePlan(root)
    const result = run(target, '--apply-plan', plan, '--yes')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(target, '.opencode', 'agents', 'zeus.md')), true)
    assert.equal(existsSync(join(target, '.pantheon', 'backups')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('saved plugin plan reviews legacy removals, detects drift, and preserves unreviewed files', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-plan-plugin-removals-'))
  const fakeBin = join(root, 'bin')
  const target = join(root, 'target')
  const pluginDir = join(target, '.opencode', 'plugins', 'pantheon-tui')
  const distDir = join(pluginDir, 'dist')
  const plan = join(root, 'reviewed-plan.json')
  const legacyPaths = [
    join(pluginDir, 'index.tsx'),
    join(distDir, 'tui.tsx'),
    join(pluginDir, 'index.ts'),
  ]
  const unreviewedPath = join(distDir, 'user-extra.tsx')

  mkdirSync(fakeBin)
  mkdirSync(target)
  mkdirSync(distDir, { recursive: true })
  writeFileSync(join(fakeBin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  legacyPaths.forEach((file, index) => {
    writeFileSync(file, `legacy-${index}`)
  })

  const invoke = (...args) =>
    spawnSync(process.execPath, [CLI, 'init', ...args], {
      cwd: target,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: target,
        XDG_CONFIG_HOME: join(target, '.config'),
        PATH: `${fakeBin}:${process.env.PATH}`,
        // Legacy-removal semantics differ per generation: V1 drops the V2
        // `index.ts` shim. Pin V1 rather than depend on the host binary.
        OPENCODE_VERSION: 'v1',
      },
    })

  try {
    const preview = invoke(
      '--project',
      '--no-mcp',
      '--components',
      'plugins',
      '--dry-run',
      '--verbose',
      '--save-plan',
      plan,
    )
    assert.equal(preview.status, 0, preview.stderr)
    const relativeLegacyPaths = legacyPaths.map((file) => relative(target, file))
    for (const file of relativeLegacyPaths) assert.ok(preview.stdout.includes(file))
    const saved = JSON.parse(readFileSync(plan, 'utf8'))
    for (const file of relativeLegacyPaths) {
      const operation = saved.operations.find((item) => item.path === file)
      assert.equal(operation?.action, 'remove', `saved plan must review removal of ${file}`)
      assert.equal(operation.before.exists, true, `saved plan must snapshot ${file}`)
    }
    assert.ok(
      legacyPaths.every((file) => existsSync(file)),
      'preview must not delete legacy files',
    )

    writeFileSync(unreviewedPath, 'user-owned extra')
    writeFileSync(legacyPaths[0], 'drifted legacy file')
    const drift = invoke('--apply-plan', plan, '--yes')
    assert.notEqual(drift.status, 0, drift.stdout + drift.stderr)
    assert.match(`${drift.stdout}${drift.stderr}`, /index\.tsx/)
    assert.ok(
      legacyPaths.every((file) => existsSync(file)),
      'drift must abort before any deletion',
    )
    assert.equal(readFileSync(legacyPaths[0], 'utf8'), 'drifted legacy file')

    writeFileSync(legacyPaths[0], 'legacy-0')
    const refreshedPlan = join(root, 'reviewed-plan-after-drift.json')
    const refreshedPreview = invoke(
      '--project',
      '--no-mcp',
      '--components',
      'plugins',
      '--dry-run',
      '--save-plan',
      refreshedPlan,
    )
    assert.equal(refreshedPreview.status, 0, refreshedPreview.stderr)
    const applied = invoke('--apply-plan', refreshedPlan, '--yes')
    assert.equal(applied.status, 0, applied.stdout + applied.stderr)
    assert.ok(
      legacyPaths.every((file) => !existsSync(file)),
      'reviewed legacy paths are removed',
    )
    assert.equal(readFileSync(unreviewedPath, 'utf8'), 'user-owned extra')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--force cleanup is rejected from JSON preview', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-json-force-'))
  const plan = join(root, 'force-plan.json')
  try {
    mkdirSync(join(root, '.opencode', 'commands'), { recursive: true })
    writeFileSync(join(root, '.opencode', 'commands', 'user.md'), 'user command')
    const savedPlan = run(
      root,
      '--project',
      '--components',
      'commands',
      '--dry-run',
      '--force',
      '--save-plan',
      plan,
    )
    assert.notEqual(savedPlan.status, 0)
    assert.equal(existsSync(plan), false)

    const result = run(
      root,
      '--project',
      '--components',
      'commands',
      '--dry-run',
      '--force',
      '--json',
    )
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}${result.stderr}`, /--force.*--json|--json.*--force/i)
    assert.equal(
      readFileSync(join(root, '.opencode', 'commands', 'user.md'), 'utf8'),
      'user command',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--dry-run --force lists plugin, agent, and skill subtree removals without deleting', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-force-removal-preview-'))
  const extraFiles = [
    join(target, '.opencode', 'plugins', 'pantheon-tui', 'user-extra.js'),
    join(target, '.opencode', 'agents', 'user-agent.md'),
    join(target, '.opencode', 'skills', 'user-skill', 'notes.txt'),
  ]
  try {
    for (const file of extraFiles) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'user-owned data')
    }

    const result = run(
      target,
      '--project',
      '--no-mcp',
      '--components',
      'plugins,agents,skills',
      '--dry-run',
      '--force',
      '--verbose',
    )

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Removal review/)
    for (const file of extraFiles) {
      const rel = relative(target, file)
      assert.ok(
        result.stdout.split('\n').some((line) => line.includes('remove') && line.includes(rel)),
        `preview must list removal of ${rel}`,
      )
      assert.ok(existsSync(file), `preview must preserve ${rel}`)
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
