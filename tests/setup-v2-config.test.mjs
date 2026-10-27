import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrateV1toV2 } from '../scripts/install/config-migration.mjs'
import { planArtifactDigest } from '../scripts/install/plan-artifact.mjs'
import { writeConfigWithBackup } from '../scripts/install/shared.mjs'
import { runSetup } from '../scripts/setup.mjs'
import {
  applyConfigChanges,
  inspectConfigFiles,
  prepareV2Config,
  resolveGlobalConfigDirectory,
} from '../scripts/setup-v2-config.mjs'

const CANCEL = Symbol('cancel')
function setupPlanFor(files = [], sourceFingerprint = 'a'.repeat(64)) {
  return {
    schema_version: 1,
    package: { source_fingerprint: sourceFingerprint },
    target: { path: '/private/target' },
    options: { version: 'v2' },
    operations: files.map(({ action, path }) => ({
      action,
      path,
      bytes: 0,
      outputFingerprint: null,
      before: { exists: false, sha256: null, size: 0, mode: null },
    })),
  }
}

function initPreview(files = [], sourceFingerprint) {
  const totals = { create: 0, update: 0, remove: 0, unchanged: 0, conflict: 0 }
  for (const { action } of files) totals[action] += 1
  const setupPlan = setupPlanFor(files, sourceFingerprint)
  return JSON.stringify({
    status: 'planned',
    totals,
    files,
    mcp_servers: [],
    setup_plan: setupPlan,
    setup_plan_digest: planArtifactDigest(setupPlan),
  })
}

const EMPTY_INIT_PLAN = initPreview()

function runSetupWithPreview(options) {
  return runSetup({
    previewInit: async () => ({ status: 0, stdout: EMPTY_INIT_PLAN }),
    confirmInit: async () => true,
    ...options,
  })
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-setup-v2-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function createPrompts({ targets = [], source, ask = {}, review = true, apply = false } = {}) {
  let askIndex = 0
  return {
    multiselect: async () => targets,
    select: async ({ message, options }) => {
      if (message.includes('MCP')) {
        const answer = Object.values(ask)[askIndex++]
        return answer && options.some(({ value }) => value === answer) ? answer : CANCEL
      }
      if (message.includes('verified Pantheon entries')) return 'keep'
      return source ?? CANCEL
    },
    confirm: async ({ message }) => (message.includes('Review and prepare') ? review : apply),
    isCancel: (value) => value === CANCEL,
    cancel() {},
    testApply: apply,
  }
}

async function prepareWithTestApply(options) {
  const result = await prepareV2Config(options)
  if (result.status !== 'planned' || options.prompts?.testApply !== true) return result
  const backup = applyConfigChanges(result.changes, { configDir: result.configDir })
  return { ...result, status: 'applied', backup }
}

function captureOutput() {
  const lines = []
  return { lines, write: (text) => lines.push(String(text)) }
}

test('setup wrapper preserves init --yes and only offers V2 preparation on a detected V2 host', async () => {
  const calls = []
  const runInit = async (args) => {
    calls.push(args)
    return { status: 0 }
  }
  const prepared = []
  await runSetupWithPreview({
    args: ['--yes'],
    env: { OPENCODE_VERSION: 'v1' },
    interactive: true,
    runInit,
    prepare: async (options) => prepared.push(options),
    output: { write() {} },
  })
  assert.deepEqual(calls, [
    ['init', '--yes', '--headless', '--setup-approved-plan-stdin', '--version=v1'],
  ])
  assert.deepEqual(prepared, [])

  await runSetupWithPreview({
    args: [],
    env: { OPENCODE_VERSION: 'v2' },
    interactive: true,
    runInit,
    prepare: async (options) => prepared.push(options),
    output: { write() {} },
  })
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].interactive, true)
})

test('V2 setup previews migration and init before one final authorization and apply', async (t) => {
  const home = fixture(t)
  const configDir = join(home, 'xdg', 'opencode')
  const events = []
  await runSetupWithPreview({
    args: [],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: join(home, 'xdg') },
    home,
    interactive: true,
    previewInit: async () => {
      events.push(['preview-init'])
      return { status: 0, stdout: EMPTY_INIT_PLAN }
    },
    applyConfig: () => events.push(['apply-config']),
    runInit: async (_args, env) => {
      events.push(['init', env.PANTHEON_SETUP_TARGET])
      return { status: 0 }
    },
    prepare: async ({ configDir: target, interactive }) => {
      events.push(['prepare', target, interactive])
      return { status: 'planned', changes: [{ path: 'test' }], configDir }
    },
    confirmInit: async () => {
      events.push(['confirm-init'])
      return true
    },
    output: { write() {} },
  })
  assert.deepEqual(events, [
    ['prepare', configDir, true],
    ['preview-init'],
    ['confirm-init'],
    ['apply-config'],
    ['preview-init'],
    ['init', configDir],
  ])
})

test('V2 setup previews init against the selected post-migration V1 MCP ask outcome', async (t) => {
  const home = fixture(t)
  const xdg = join(home, 'xdg')
  const configDir = join(xdg, 'opencode')
  fs.mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, 'opencode.json')
  const original = JSON.stringify({
    mcp: { servers: { research: { type: 'remote', url: 'https://example.invalid/mcp' } } },
    permission: { mcp: { research: 'ask' } },
  })
  writeFileSync(configPath, original)
  const output = captureOutput()

  const result = await runSetup({
    args: ['--components', 'agents'],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: xdg },
    home,
    cwd: home,
    interactive: true,
    prepare: async (options) =>
      prepareV2Config({
        ...options,
        prompts: createPrompts({
          targets: [configPath],
          ask: { research: 'deny' },
          apply: false,
        }),
      }),
    confirmInit: async () => false,
    output,
  })

  assert.equal(result, 0, output.lines.join(''))
  assert.match(output.lines.join(''), /Policy rule 1: action=research_\*; resource=\*; effect=deny/)
  assert.match(output.lines.join(''), /Init operation: create agents\/zeus\.md/)
  assert.equal(
    readFileSync(configPath, 'utf8'),
    original,
    'preview leaves the original config intact',
  )
  assert.deepEqual(fs.readdirSync(configDir), ['opencode.json'])
})

test('V2 setup converts explicit punctuated MCP outcomes into host-normalized actions', async (t) => {
  const root = fixture(t)
  const configPath = join(root, 'opencode.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      mcp: {
        servers: {
          'my-mcp.server': { type: 'remote', url: 'https://example.invalid/mcp' },
        },
      },
      permission: { mcp: { 'my-mcp.server': 'ask' } },
    }),
  )
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [configPath], ask: { outcome: 'deny' } }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'planned')
  assert.deepEqual(result.changes[0].policy, [
    { action: 'my-mcp.server_*', resource: '*', effect: 'deny' },
    { action: 'my_mcp_server_*', resource: '*', effect: 'deny' },
  ])
})

test('V2 setup requires final authorization after config review even with --yes', async () => {
  let initCalls = 0
  const result = await runSetupWithPreview({
    args: ['--yes'],
    env: { OPENCODE_VERSION: 'v2' },
    interactive: true,
    prepare: async () => ({
      status: 'planned',
      changes: [{ path: 'test' }],
      configDir: '/tmp/test',
    }),
    confirmInit: async () => false,
    runInit: async () => {
      initCalls += 1
      return { status: 0 }
    },
    output: { write() {} },
  })
  assert.equal(result, 0)
  assert.equal(initCalls, 0)
})

test('V2 setup does not run init after an unresolved migration preview', async () => {
  let initCalls = 0
  const result = await runSetupWithPreview({
    args: ['--yes'],
    env: { OPENCODE_VERSION: 'v2', CI: 'true' },
    interactive: true,
    runInit: async () => {
      initCalls += 1
      return { status: 0 }
    },
    prepare: async () => ({ status: 'preview', changes: [{ path: 'redacted' }] }),
    output: { write() {} },
  })
  assert.equal(result, 0)
  assert.equal(initCalls, 0)
})

test('V2 setup dry-run previews migration and invokes only init dry-run', async () => {
  const events = []
  await runSetupWithPreview({
    args: ['--dry-run', '--yes'],
    env: { OPENCODE_VERSION: 'v2' },
    interactive: true,
    runInit: async (args) => {
      events.push(['unexpected-init', args.includes('--dry-run')])
      return { status: 0 }
    },
    previewInit: async (args) => {
      events.push(['preview-init', args.includes('--dry-run'), args.includes('--json')])
      return { status: 0, stdout: EMPTY_INIT_PLAN }
    },
    prepare: async ({ interactive, dryRun }) => {
      events.push(['prepare', interactive, dryRun])
      return { status: 'preview', changes: [] }
    },
    output: { write() {} },
  })
  assert.deepEqual(events, [
    ['prepare', false, true],
    ['preview-init', true, true],
  ])
})

test('setup wrapper uses init version precedence for explicit CLI selections over environment', async () => {
  const prepared = []
  const run = async (args, env) =>
    runSetupWithPreview({
      args,
      env,
      interactive: true,
      runInit: async () => ({ status: 0 }),
      prepare: async (options) => prepared.push(options),
      output: { write() {} },
    })

  await run(['--opencode-version', 'v2'], { OPENCODE_VERSION: 'v1' })
  assert.equal(prepared.length, 1)
  await run(['--version=v1'], { OPENCODE_VERSION: 'v2' })
  assert.equal(prepared.length, 1)
  await run(['--version', 'v2'], { OPENCODE_VERSION: 'v1' })
  assert.equal(prepared.length, 2)
  await run(['--opencode-version', 'v2', '--version', 'v1'], { OPENCODE_VERSION: 'v2' })
  assert.equal(prepared.length, 2)
})

test('setup resolves auto version once and pins that generation through preflight and init', async (t) => {
  const home = fixture(t)
  const xdg = join(home, 'xdg')
  fs.mkdirSync(xdg)
  let resolutions = 0
  let previewArgs
  let finalArgs

  const result = await runSetup({
    args: ['--version', 'auto'],
    env: { XDG_CONFIG_HOME: xdg },
    home,
    cwd: home,
    interactive: true,
    resolveVersion: () => {
      resolutions += 1
      return resolutions === 1 ? 'v2' : 'v1'
    },
    prepare: async () => ({ status: 'unchanged', changes: [] }),
    previewInit: async (args) => {
      previewArgs = args
      return { status: 0, stdout: EMPTY_INIT_PLAN }
    },
    confirmInit: async () => true,
    runInit: async (args) => {
      finalArgs = args
      return { status: 0 }
    },
    output: captureOutput(),
  })

  assert.equal(result, 0)
  assert.equal(resolutions, 1)
  assert.equal(previewArgs.filter((arg) => arg.startsWith('--version=')).join(), '--version=v2')
  assert.equal(finalArgs.filter((arg) => arg.startsWith('--version=')).join(), '--version=v2')
  assert.equal(finalArgs.includes('--version'), false)
})

test('config drift after authorization aborts before migration or init writes', async (t) => {
  const home = fixture(t)
  const xdg = join(home, 'xdg')
  const configDir = join(xdg, 'opencode')
  fs.mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  const external = '{"permission":{"edit":"allow"}}\n'
  writeFileSync(configPath, original)
  let applyCalls = 0
  let initCalls = 0

  const result = await runSetup({
    args: [],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: xdg },
    home,
    cwd: home,
    interactive: true,
    prepare: (options) =>
      prepareV2Config({
        ...options,
        interactive: true,
        prompts: createPrompts({ targets: [configPath] }),
      }),
    previewInit: async () => ({ status: 0, stdout: EMPTY_INIT_PLAN }),
    confirmInit: async () => {
      writeFileSync(configPath, external)
      return true
    },
    applyConfig: () => {
      applyCalls += 1
    },
    runInit: async () => {
      initCalls += 1
      return { status: 0 }
    },
    output: captureOutput(),
  })

  assert.equal(result, 1)
  assert.equal(applyCalls, 0)
  assert.equal(initCalls, 0)
  assert.equal(readFileSync(configPath, 'utf8'), external)
})

test('installer input drift after authorization stops before init and reports migration recovery', async (t) => {
  const home = fixture(t)
  const installerInput = join(home, 'installer-source.txt')
  const configPath = join(home, 'opencode.json')
  writeFileSync(installerInput, 'reviewed source')
  let previewCalls = 0
  let initCalls = 0
  let migrationCalls = 0
  const output = captureOutput()

  const result = await runSetup({
    args: [],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: join(home, 'xdg') },
    home,
    cwd: home,
    interactive: true,
    prepare: async () => ({
      status: 'planned',
      configDir: home,
      configPreview: '{"permissions":[]}\n',
      changes: [{ path: configPath, original: null, contents: '{"permissions":[]}\n' }],
      configPreconditions: [],
    }),
    previewInit: async () => {
      previewCalls += 1
      const sourceFingerprint = createHash('sha256')
        .update(readFileSync(installerInput))
        .digest('hex')
      return {
        status: 0,
        stdout: initPreview([{ action: 'update', path: configPath }], sourceFingerprint),
      }
    },
    confirmInit: async () => {
      writeFileSync(installerInput, 'changed after consent')
      return true
    },
    applyConfig: async () => {
      migrationCalls += 1
      return { dir: join(home, 'backups', 'reviewed') }
    },
    runInit: async () => {
      initCalls += 1
      return { status: 0 }
    },
    output,
  })

  assert.equal(result, 1)
  assert.equal(previewCalls, 2)
  assert.equal(migrationCalls, 1)
  assert.equal(initCalls, 0)
  assert.match(output.lines.join(''), /Installer inputs or plan drifted/)
  assert.match(output.lines.join(''), /pantheon-opencode restore/)
})

test('invalid explicit versions fail in headless and dry-run CLI modes without writes', (t) => {
  for (const selector of [
    ['--version', 'v3'],
    ['--version=v3'],
    ['--version', 'garbage'],
    ['--version=garbage'],
  ]) {
    for (const mode of ['--headless', '--dry-run']) {
      const root = fixture(t)
      const xdg = join(root, 'xdg')
      const cwd = join(root, 'cwd')
      fs.mkdirSync(xdg)
      fs.mkdirSync(cwd)
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), 'scripts', 'setup.mjs'), ...selector, mode],
        {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: root,
            XDG_CONFIG_HOME: xdg,
            OPENCODE_VERSION: 'v2',
          },
        },
      )
      assert.notEqual(result.status, 0, `${selector.join(' ')} ${mode} must fail`)
      assert.match(`${result.stdout}\n${result.stderr}`, /expected v1, v2, or auto/)
      assert.deepEqual(fs.readdirSync(xdg), [])
      assert.deepEqual(fs.readdirSync(cwd), [])
    }
  }
})

test('setup rejects missing explicit version values before falling back to OPENCODE_VERSION', (t) => {
  for (const selector of [['--version', '--dry-run'], ['--version=']]) {
    const root = fixture(t)
    const xdg = join(root, 'xdg')
    const cwd = join(root, 'cwd')
    fs.mkdirSync(xdg)
    fs.mkdirSync(cwd)
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), 'scripts', 'setup.mjs'), ...selector],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: xdg,
          OPENCODE_VERSION: 'v2',
        },
      },
    )
    assert.notEqual(result.status, 0, selector.join(' '))
    assert.match(`${result.stdout}\n${result.stderr}`, /--version requires a value/i)
    assert.deepEqual(fs.readdirSync(xdg), [])
    assert.deepEqual(fs.readdirSync(cwd), [])
  }
})

test('headless setup previews V2 config even with --yes and never applies it', async () => {
  const prepared = []
  let initCalls = 0
  await runSetupWithPreview({
    args: ['--yes'],
    env: { OPENCODE_VERSION: 'v2', CI: 'true' },
    interactive: true,
    runInit: async () => {
      initCalls += 1
      return { status: 0 }
    },
    prepare: async (options) => prepared.push(options),
    output: { write() {} },
  })
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].interactive, false)
  assert.equal(initCalls, 0)
})

test('headless setup never starts a writing init for V1 or unchanged V2 config', async () => {
  for (const { env, args, prepare } of [
    { env: { OPENCODE_VERSION: 'v1' }, args: ['--headless'] },
    {
      env: { OPENCODE_VERSION: 'v2', CI: 'true' },
      args: ['--yes'],
      prepare: async () => ({ status: 'unchanged', changes: [] }),
    },
  ]) {
    let initCalls = 0
    const result = await runSetupWithPreview({
      args,
      env,
      interactive: true,
      prepare,
      runInit: async () => {
        initCalls += 1
        return { status: 0 }
      },
      output: { write() {} },
    })
    assert.equal(result, 0)
    assert.equal(initCalls, 0)
  }
})

test('config inspection handles JSON only, JSONC only, both files, and neither', (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  writeFileSync(json, '{"permission":{"edit":"deny"}}\n')
  let files = inspectConfigFiles(root)
  assert.deepEqual(
    files.filter(({ exists }) => exists).map(({ name }) => name),
    ['opencode.json'],
  )
  assert.equal(files[0].config.permission.edit, 'deny')

  rmSync(json)
  writeFileSync(
    jsonc,
    '{\n  // keep this note\n  "permissions": [{"action":"edit","resource":"*","effect":"deny"}],\n}\n',
  )
  files = inspectConfigFiles(root)
  assert.deepEqual(
    files.filter(({ exists }) => exists).map(({ name }) => name),
    ['opencode.jsonc'],
  )
  assert.equal(files[1].config.permissions[0].effect, 'deny')

  writeFileSync(json, '{"permission":{"edit":"allow"}}\n')
  files = inspectConfigFiles(root)
  assert.deepEqual(
    files.filter(({ exists }) => exists).map(({ name }) => name),
    ['opencode.json', 'opencode.jsonc'],
  )
  rmSync(json)
  rmSync(jsonc)
  assert.equal(
    inspectConfigFiles(root).some(({ exists }) => exists),
    false,
  )
})

test('config preparation resolves the same default HOME and XDG targets as init', (t) => {
  const home = fixture(t)
  assert.equal(resolveGlobalConfigDirectory({}, home), join(home, '.config', 'opencode'))
  assert.equal(
    resolveGlobalConfigDirectory({ XDG_CONFIG_HOME: join(home, 'xdg') }, home),
    join(home, 'xdg', 'opencode'),
  )
  assert.throws(
    () => resolveGlobalConfigDirectory({ XDG_CONFIG_HOME: 'relative/xdg' }, home),
    /XDG_CONFIG_HOME must be an absolute path/i,
  )
})

test('setup passes init XDG selection through to V2 preparation', async (t) => {
  const home = fixture(t)
  const xdg = join(home, 'xdg')
  let selected
  await runSetupWithPreview({
    args: [],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: xdg },
    home,
    interactive: true,
    runInit: async () => ({ status: 0 }),
    prepare: async ({ configDir }) => {
      selected = configDir
    },
    output: { write() {} },
  })
  assert.equal(selected, join(xdg, 'opencode'))
})

test('setup rejects relative XDG_CONFIG_HOME before config preparation or init', async (t) => {
  const home = fixture(t)
  let prepareCalls = 0
  let initCalls = 0
  const output = captureOutput()
  const result = await runSetupWithPreview({
    args: [],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: 'relative/xdg' },
    home,
    prepare: async () => {
      prepareCalls += 1
      return { status: 'unchanged', changes: [] }
    },
    runInit: async () => {
      initCalls += 1
      return { status: 0 }
    },
    output,
  })
  assert.equal(result, 1)
  assert.equal(prepareCalls, 0)
  assert.equal(initCalls, 0)
  assert.match(output.lines.join(''), /XDG_CONFIG_HOME must be an absolute path/i)
})

test('symlinked config directory is blocked without reading or writing outside it', async (t) => {
  const root = fixture(t)
  const outside = join(root, 'outside')
  const selected = join(root, 'selected')
  fs.mkdirSync(outside)
  const target = join(outside, 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  writeFileSync(target, original)
  symlinkSync(outside, selected, 'dir')

  const output = captureOutput()
  const result = await prepareV2Config({
    configDir: selected,
    interactive: true,
    prompts: createPrompts({ targets: [join(selected, 'opencode.json')], apply: true }),
    output,
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(outside), ['opencode.json'])
})

test('symlinked config ancestor is blocked without outside writes', async (t) => {
  const root = fixture(t)
  const outside = join(root, 'outside')
  const selectedParent = join(root, '.config')
  const selected = join(selectedParent, 'opencode')
  fs.mkdirSync(outside)
  fs.mkdirSync(join(outside, 'opencode'))
  const target = join(outside, 'opencode', 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  writeFileSync(target, original)
  symlinkSync(outside, selectedParent, 'dir')

  const result = await prepareWithTestApply({
    configDir: selected,
    interactive: false,
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(join(outside, 'opencode')), ['opencode.json'])
})

test('preview and interactive review never print credential or unrelated config values', async (t) => {
  const root = fixture(t)
  const secrets = [
    'sk-secret-preview-credential',
    'unrelated-password-value',
    'sk-secret-conflict-credential',
  ]
  const target = join(root, 'opencode.json')
  const conflictTarget = join(root, 'opencode.jsonc')
  const original = JSON.stringify({
    provider: { openai: { options: { apiKey: secrets[0], password: secrets[1] } } },
    theme: 'private-theme-value',
    permission: { edit: 'deny' },
  })
  writeFileSync(target, original)
  writeFileSync(
    conflictTarget,
    JSON.stringify({
      provider: { openai: { options: { apiKey: secrets[2] } } },
      permissions: [{ action: 'edit', resource: '*', effect: 'allow' }],
    }),
  )

  const previewOutput = captureOutput()
  await prepareV2Config({ configDir: root, interactive: false, output: previewOutput })
  const interactiveOutput = captureOutput()
  const promptLines = []
  const prompts = createPrompts({
    targets: [target, conflictTarget],
    source: `${target}#permission`,
    apply: false,
  })
  const select = prompts.select
  prompts.select = async (prompt) => {
    promptLines.push(JSON.stringify({ message: prompt.message, options: prompt.options }))
    return select(prompt)
  }
  await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts,
    output: interactiveOutput,
  })
  for (const text of [
    previewOutput.lines.join('\n'),
    interactiveOutput.lines.join('\n'),
    promptLines.join('\n'),
  ]) {
    for (const secret of secrets) assert.equal(text.includes(secret), false)
    assert.equal(text.includes('private-theme-value'), false)
  }
})

test('inspection reports only exact Pantheon plugin and MCP identities with config values redacted', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  writeFileSync(
    target,
    JSON.stringify({
      provider: { private: { apiKey: 'sk-secret-inspection-value' } },
      plugins: ['src/plugin-v2', 'third-party-plugin'],
      mcp: {
        'pantheon-resources': {
          type: 'local',
          cwd: '/home/user/pantheon',
          command: ['/home/user/pantheon/.venv/bin/python3', 'scripts/mcp_resources.py'],
        },
        'pantheon-code-mode': {
          type: 'local',
          cwd: '/home/user/pantheon',
          command: ['/opt/other/.venv/bin/python3', 'scripts/code_mode.py'],
        },
        'custom-server': { command: ['python', 'scripts/mcp_resources.py'] },
        'pantheon-memory': { command: ['python', 'custom_memory.py'] },
      },
    }),
  )
  const output = captureOutput()
  const result = await prepareV2Config({ configDir: root, interactive: false, output })
  assert.equal(result.status, 'unchanged')
  const printed = output.lines.join('\n')
  assert.match(printed, /V2 plugin/)
  assert.match(printed, /verified Pantheon MCP entries: 1/)
  assert.equal(printed.includes('pantheon-resources'), false)
  assert.equal(printed.includes('custom-server'), false)
  assert.equal(printed.includes('third-party-plugin'), false)
  assert.equal(printed.includes('sk-secret-inspection-value'), false)
})

test('canceling the target review leaves config unchanged', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{\n  "permission": {"edit": "deny"}\n}\n'
  writeFileSync(target, original)
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [] }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'canceled')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('headless preview never writes, even when the legacy policy has no conflicts', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  writeFileSync(target, original)
  const output = captureOutput()
  const result = await prepareV2Config({ configDir: root, interactive: false, output })
  assert.equal(result.status, 'preview')
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.match(output.lines.join('\n'), /Preview only/)
})

test('conflicting permission layers are blocked before writing either source', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = '{"permission":{"edit":"deny"}}\n'
  const originalJsonc = '{"permissions":[{"action":"edit","resource":"*","effect":"allow"}]}\n'
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [json, jsonc] }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
})

test('permission layers are converted in place without copying one layer over another', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = '{"permission":{"edit":"deny"}}\n'
  const originalJsonc =
    '{\n  // unrelated layer note\n  "permissions": [{"action":"read","resource":"*","effect":"allow"}]\n}\n'
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [json, jsonc],
      apply: true,
    }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  const jsonPolicy = JSON.parse(readFileSync(json, 'utf8')).permissions
  const jsoncAfter = readFileSync(jsonc, 'utf8')
  assert.deepEqual(jsonPolicy, [{ action: 'edit', resource: '*', effect: 'deny' }])
  assert.deepEqual(inspectConfigFiles(root)[1].config.permissions, [
    { action: 'read', resource: '*', effect: 'allow' },
  ])
  assert.match(jsoncAfter, /\/\/ unrelated layer note/)
})

test('conflicting legacy action aliases are blocked before config writes', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"bash":{"git":"allow"},"shell":{"git":"deny"}}}\n'
  writeFileSync(target, original)
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('an MCP ask rule requires an explicit allow or deny choice before it can be changed', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"mcp":{"research":"ask"}}}\n'
  writeFileSync(target, original)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'canceled')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('an explicit MCP ask choice is previewed and requires a separate apply confirmation', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"mcp":{"research":"ask"}}}\n'
  writeFileSync(target, original)
  const output = captureOutput()
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [target],
      ask: { [`${target}#permission#mcp:research`]: 'deny' },
      apply: false,
    }),
    output,
  })
  assert.equal(result.status, 'planned')
  assert.match(output.lines.join('\n'), /ineffective MCP ask/i)
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('an explicit MCP deny choice is applied only after the separate confirmation', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"mcp":{"research":"ask"}}}\n'
  writeFileSync(target, original)
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [target],
      ask: { [`${target}#permission#mcp:research`]: 'deny' },
      apply: true,
    }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  const updated = JSON.parse(readFileSync(target, 'utf8'))
  assert.deepEqual(updated.permissions, [{ action: 'research_*', resource: '*', effect: 'deny' }])
  assert.equal(Object.hasOwn(updated, 'permission'), false)
  assert.equal(readFileSync(join(result.backup.dir, 'opencode.json'), 'utf8'), original)
})

test('a disable choice from the retained policy source disables its nested MCP server', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const output = captureOutput()
  writeFileSync(
    target,
    JSON.stringify({
      mcp: { servers: { research: { type: 'remote', url: 'https://example.invalid/mcp' } } },
      permission: { mcp: { research: 'ask' } },
    }),
  )
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [target],
      ask: { research: 'disable' },
      apply: true,
    }),
    output,
  })

  assert.equal(result.status, 'applied')
  const updated = JSON.parse(readFileSync(target, 'utf8'))
  assert.equal(updated.mcp.servers.research.disabled, true)
  assert.match(output.lines.join(''), /mcp\.servers\[research\]\.disabled = true/)
})

test('a disable choice from a discarded same-file policy source has no server effect', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const output = captureOutput()
  writeFileSync(
    target,
    JSON.stringify({
      mcp: { servers: { research: { type: 'remote', url: 'https://example.invalid/mcp' } } },
      permission: { mcp: { research: 'ask' } },
      permissions: [{ action: 'edit', resource: '*', effect: 'deny' }],
    }),
  )
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [target],
      source: 'opencode.json#permissions',
      ask: { research: 'disable' },
      apply: true,
    }),
    output,
  })

  assert.equal(result.status, 'applied')
  const updated = JSON.parse(readFileSync(target, 'utf8'))
  assert.equal(updated.mcp.servers.research.disabled, undefined)
  assert.deepEqual(updated.permissions, [{ action: 'edit', resource: '*', effect: 'deny' }])
  assert.equal(Object.hasOwn(updated, 'permission'), false)
  assert.doesNotMatch(output.lines.join(''), /mcp\.servers\[research\]\.disabled = true/)
})

test('setup consent preview shows safe operations and policy details without config secrets or paths', async (t) => {
  const home = fixture(t)
  const xdg = join(home, 'xdg')
  const configDir = join(xdg, 'opencode')
  fs.mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, 'opencode.json')
  const secret = 'sk-secret-consent-preview-sentinel'
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: { private: { options: { apiKey: secret } } },
      theme: 'unrelated-private-value',
      permission: { edit: 'deny' },
    }),
  )
  const output = captureOutput()
  const result = await runSetup({
    args: ['--components', 'agents'],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: xdg },
    home,
    interactive: true,
    prepare: async (options) =>
      prepareV2Config({
        ...options,
        interactive: true,
        prompts: createPrompts({ targets: [configPath], apply: false }),
        output,
      }),
    previewInit: async () => ({
      status: 0,
      stdout: initPreview([
        { action: 'create', path: 'agents/zeus.md' },
        { action: 'update', path: '/home/private/opencode.json' },
      ]),
    }),
    confirmInit: async () => false,
    output,
  })

  assert.equal(result, 0)
  const text = output.lines.join('')
  assert.match(text, /Init operation: create agents\/zeus\.md/)
  assert.match(text, /Policy rule 1: action=edit; resource=\*; effect=deny/)
  assert.match(text, /Config operation: opencode\.json permission → permissions/)
  assert.doesNotMatch(text, /sk-secret-consent-preview-sentinel/)
  assert.doesNotMatch(text, /unrelated-private-value/)
  assert.doesNotMatch(text, /\/home\/private\/opencode\.json/)
  assert.equal(text.includes(configDir), false)
})

test('every ineffective MCP ask entry receives its own explicit policy choice', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  writeFileSync(target, '{"permission":{"mcp":{"research":"ask","docs":"ask"}}}\n')
  let mcpPrompts = 0
  const prompts = createPrompts({
    targets: [target],
    ask: { research: 'allow', docs: 'deny' },
    apply: true,
  })
  const select = prompts.select
  prompts.select = async (options) => {
    if (options.message.includes('MCP')) mcpPrompts += 1
    return select(options)
  }
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts,
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  assert.equal(mcpPrompts, 2)
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).permissions, [
    { action: 'research_*', resource: '*', effect: 'allow' },
    { action: 'docs_*', resource: '*', effect: 'deny' },
  ])
})

test('native MCP ask rules are chosen only for configured MCP server actions', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  writeFileSync(
    target,
    JSON.stringify({
      mcp: { research: { command: ['python', 'research.py'] } },
      permissions: [
        { action: 'research_*', resource: '*', effect: 'ask' },
        { action: 'shell_*', resource: '*', effect: 'ask' },
      ],
    }),
  )
  let mcpPrompts = 0
  const prompts = createPrompts({ targets: [target], ask: { research: 'deny' }, apply: true })
  const select = prompts.select
  prompts.select = async (options) => {
    if (options.message.includes('MCP')) mcpPrompts += 1
    return select(options)
  }
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts,
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  assert.equal(mcpPrompts, 1)
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).permissions, [
    { action: 'research_*', resource: '*', effect: 'deny' },
    { action: 'shell_*', resource: '*', effect: 'ask' },
  ])
})

test('seeded MCP ask rules use glob matching even when the server is absent', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  writeFileSync(
    target,
    JSON.stringify({
      permissions: [
        { action: 'pantheon_code_mode_*', resource: '**', effect: 'ask' },
        { action: 'pantheon_code_mode_*', resource: 'config/**', effect: 'ask' },
        { action: 'pantheon[._]code_mode_*', resource: '*', effect: 'ask' },
        { action: 'pantheon???ode_mode_*', resource: '**', effect: 'ask' },
        { action: 'unrelated_*', resource: '**', effect: 'ask' },
      ],
    }),
  )
  let mcpPrompts = 0
  const prompts = createPrompts({ targets: [target], ask: { seeded: 'deny' }, apply: true })
  const select = prompts.select
  prompts.select = async (options) => {
    if (options.message.includes('MCP')) mcpPrompts += 1
    return select(options)
  }

  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts,
    output: captureOutput(),
  })

  assert.equal(result.status, 'applied')
  assert.equal(mcpPrompts, 1)
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).permissions, [
    { action: 'pantheon_code_mode_*', resource: '**', effect: 'deny' },
    { action: 'pantheon_code_mode_*', resource: 'config/**', effect: 'ask' },
    { action: 'pantheon[._]code_mode_*', resource: '*', effect: 'ask' },
    { action: 'pantheon???ode_mode_*', resource: '**', effect: 'ask' },
    { action: 'unrelated_*', resource: '**', effect: 'ask' },
  ])
})

test('overlapping legacy MCP deny then allow is blocked before any config write', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"mcp":{"foo_bar":"deny","foo":"allow"}}}\n'
  writeFileSync(target, original)

  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('legacy MCP allow cannot broaden onto a distinct configured normalized server', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = JSON.stringify({
    mcp: {
      'foo-bar': { type: 'remote', url: 'https://one.example/mcp' },
      foo_bar: { type: 'remote', url: 'https://two.example/mcp' },
    },
    permission: { mcp: { 'foo-bar': 'allow' } },
  })
  writeFileSync(target, original)

  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).permissions, undefined)
})

test('same-key legacy deny then allow retains V1 last-match order during setup conversion', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"edit":{"*":"deny","src/**":"allow"}}}\n'
  writeFileSync(target, original)

  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'applied')
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).permissions, [
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'edit', resource: 'src/**', effect: 'allow' },
  ])
})

test('V1 MCP deny aliases are checked against later action rules before writes', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original =
    '{"permission":{"mcp":{"pantheon-code-mode":"deny"},' +
    '"pantheon_code_mode_read_file":"deny","pantheon_code_mode_*":"allow"}}\n'
  writeFileSync(target, original)

  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('flat third-party MCP entries in JSONC block setup before consent or writes', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = '{"permission":{"read":"allow"}}\n'
  const originalJsonc =
    '{\n  // User-owned JSONC must not be rewritten implicitly.\n' +
    '  "mcp": { "third-party": { "type": "remote", "url": "https://example.invalid/mcp" } }\n}\n'
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  const prompts = createPrompts({ targets: [json] })
  let promptCount = 0
  const select = prompts.select
  const multiselect = prompts.multiselect
  prompts.select = async (...args) => {
    promptCount += 1
    return select(...args)
  }
  prompts.multiselect = async (...args) => {
    promptCount += 1
    return multiselect(...args)
  }
  const output = captureOutput()

  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts,
    output,
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /manual.*mcp\.servers|mcp\.servers.*remove/i)
  assert.match(output.lines.join('\n'), /mcp\.<redacted>/)
  assert.equal(promptCount, 0, 'the unsafe JSONC shape blocks before consent prompts')
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
})

test('nested third-party MCP servers in JSONC are preserved during V2 setup', async (t) => {
  const root = fixture(t)
  const jsonc = join(root, 'opencode.jsonc')
  const server = { type: 'remote', url: 'https://example.invalid/mcp', enabled: true }
  writeFileSync(
    jsonc,
    JSON.stringify({ mcp: { servers: { 'third-party': server } }, permission: { read: 'allow' } }),
  )

  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [jsonc], apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'applied')
  assert.deepEqual(JSON.parse(readFileSync(jsonc, 'utf8')).mcp.servers['third-party'], server)
})

test('MCP asks from JSON and JSONC each require an explicit policy outcome', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  writeFileSync(json, JSON.stringify({ permission: { mcp: { research: 'ask' } } }))
  writeFileSync(
    jsonc,
    JSON.stringify({
      mcp: { servers: { docs: { type: 'remote', url: 'https://example.invalid/mcp' } } },
      permissions: [{ action: 'docs_*', resource: '*', effect: 'ask' }],
    }),
  )
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [json, jsonc],
      ask: { legacy: 'allow', native: 'deny' },
      apply: true,
    }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')).permissions, [
    { action: 'research_*', resource: '*', effect: 'allow' },
  ])
  assert.deepEqual(JSON.parse(readFileSync(jsonc, 'utf8')).permissions, [
    { action: 'docs_*', resource: '*', effect: 'deny' },
  ])
})

test('a migrated V1 non-deny after a native V2 deny is blocked before writes', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson =
    '{"permissions":[{"action":"edit","resource":"private/*","effect":"deny"}]}\n'
  const originalJsonc = '{"permission":{"edit":"allow"}}\n'
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [jsonc] }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
})

test('opposite-effect native JSON/JSONC permission layers are blocked without writes', async (t) => {
  for (const [jsonEffect, jsoncEffect] of [
    ['deny', 'allow'],
    ['deny', 'ask'],
    ['allow', 'deny'],
  ]) {
    const root = fixture(t)
    const json = join(root, 'opencode.json')
    const jsonc = join(root, 'opencode.jsonc')
    const originalJson = `${JSON.stringify({ permissions: [{ action: 'edit', resource: '*', effect: jsonEffect }] })}\n`
    const originalJsonc = `${JSON.stringify({ permissions: [{ action: 'edit', resource: '*', effect: jsoncEffect }] })}\n`
    writeFileSync(json, originalJson)
    writeFileSync(jsonc, originalJsonc)

    const result = await prepareV2Config({
      configDir: root,
      interactive: true,
      output: captureOutput(),
    })

    assert.equal(result.status, 'blocked', `${jsonEffect}/${jsoncEffect} conflicts across files`)
    assert.equal(readFileSync(json, 'utf8'), originalJson)
    assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
  }
})

test('overlapping legacy policies in JSON then JSONC are blocked before writes', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = '{"permission":{"edit":"deny"}}\n'
  const originalJsonc = '{"permission":{"edit":"allow"}}\n'
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)

  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [json, jsonc], apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
})

test('an explicit same-file source choice excludes the discarded policy from conflict analysis', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  writeFileSync(
    target,
    '{"permission":{"edit":"deny"},"permissions":[{"action":"edit","resource":"*","effect":"allow"}]}\n',
  )

  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], source: 'opencode.json#permissions', apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'applied')
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).permissions, [
    { action: 'edit', resource: '*', effect: 'allow' },
  ])
})

test('native cross-layer effect conflicts block overlaps but permit disjoint actions or resources', async (t) => {
  const cases = [
    {
      name: 'overlapping action and resource',
      native: { action: 'foo_*', resource: 'foo/*', effect: 'deny' },
      legacy: { foo_bar: { 'foo/bar': 'allow' } },
      expected: 'blocked',
    },
    {
      name: 'disjoint actions',
      native: { action: 'foo_*', resource: 'foo/*', effect: 'deny' },
      legacy: { 'bar_*': { 'bar/*': 'allow' } },
      expected: 'applied',
    },
    {
      name: 'disjoint resources',
      native: { action: 'foo_*', resource: 'foo/*', effect: 'deny' },
      legacy: { foo_bar: { 'bar/*': 'allow' } },
      expected: 'applied',
    },
  ]

  for (const scenario of cases) {
    const root = fixture(t)
    const json = join(root, 'opencode.json')
    const jsonc = join(root, 'opencode.jsonc')
    const originalJson = `${JSON.stringify({ permissions: [scenario.native] })}\n`
    const originalJsonc = `${JSON.stringify({ permission: scenario.legacy })}\n`
    writeFileSync(json, originalJson)
    writeFileSync(jsonc, originalJsonc)

    const result = await prepareWithTestApply({
      configDir: root,
      interactive: true,
      prompts: createPrompts({ targets: [jsonc], apply: true }),
      output: captureOutput(),
    })

    assert.equal(result.status, scenario.expected, scenario.name)
    if (scenario.expected === 'blocked') {
      assert.equal(readFileSync(json, 'utf8'), originalJson)
      assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
    } else {
      assert.equal(readFileSync(jsonc, 'utf8').includes('"permissions"'), true, scenario.name)
    }
  }
})

test('a legacy MCP ask chosen as allow cannot supersede an earlier native deny', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = '{"permissions":[{"action":"research_*","resource":"*","effect":"deny"}]}\n'
  const originalJsonc = '{"permission":{"mcp":{"research":"ask"}}}\n'
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [jsonc], ask: { research: 'allow' } }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
})

test('cross-layer V1/native effect collisions are blocked regardless of which effect is stricter', async (t) => {
  for (const [legacyEffect, nativeEffect] of [
    ['allow', 'deny'],
    ['deny', 'allow'],
  ]) {
    const root = fixture(t)
    const json = join(root, 'opencode.json')
    const jsonc = join(root, 'opencode.jsonc')
    const originalJson = `${JSON.stringify({ permission: { edit: legacyEffect } })}\n`
    const originalJsonc = `${JSON.stringify({ permissions: [{ action: 'edit', resource: 'private/*', effect: nativeEffect }] })}\n`
    writeFileSync(json, originalJson)
    writeFileSync(jsonc, originalJsonc)
    const result = await prepareV2Config({
      configDir: root,
      interactive: true,
      prompts: createPrompts({ targets: [json, jsonc], apply: true }),
      output: captureOutput(),
    })
    assert.equal(result.status, 'blocked')
    assert.equal(readFileSync(json, 'utf8'), originalJson)
    assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
  }
})

test('only explicitly selected policy files are rewritten', async (t) => {
  for (const selected of ['json', 'jsonc']) {
    const root = fixture(t)
    const json = join(root, 'opencode.json')
    const jsonc = join(root, 'opencode.jsonc')
    const originalJson =
      selected === 'json'
        ? '{"permission":{"edit":"deny"}}\n'
        : '{"permissions":[{"action":"edit","resource":"*","effect":"deny"}],"theme":"dark"}\n'
    const originalJsonc =
      selected === 'jsonc'
        ? '{\n  // keep JSONC formatting\n  "permission": {"read": "deny"}\n}\n'
        : '{\n  // unselected policy file\n  "permissions": [{"action":"shell","resource":"*","effect":"deny"}],\n  "theme": "dark"\n}\n'
    writeFileSync(json, originalJson)
    writeFileSync(jsonc, originalJsonc)
    const selectedPath = selected === 'json' ? json : jsonc
    const unselectedPath = selected === 'json' ? jsonc : json
    const unselectedBytes = selected === 'json' ? originalJsonc : originalJson
    const result = await prepareWithTestApply({
      configDir: root,
      interactive: true,
      prompts: createPrompts({ targets: [selectedPath], apply: true }),
      output: captureOutput(),
    })
    assert.equal(result.status, 'applied')
    assert.equal(result.changes.length, 1)
    assert.equal(readFileSync(unselectedPath, 'utf8'), unselectedBytes)
  }
})

test('safe JSONC managed plugin and MCP entries move without changing effective order', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const managedServer = {
    type: 'local',
    cwd: '/home/user/pantheon',
    command: ['/home/user/pantheon/.venv/bin/python3', 'scripts/mcp_resources.py'],
  }
  writeFileSync(json, JSON.stringify({ plugins: ['existing-plugin'], mcp: { servers: {} } }))
  writeFileSync(
    jsonc,
    JSON.stringify({
      plugins: ['src/plugin-v2', 'jsonc-plugin'],
      mcp: { servers: { 'pantheon-resources': managedServer } },
      theme: 'dark',
    }),
  )
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [json, jsonc], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  const targetConfig = JSON.parse(readFileSync(json, 'utf8'))
  const sourceConfig = JSON.parse(readFileSync(jsonc, 'utf8'))
  assert.deepEqual(targetConfig.plugins, ['existing-plugin', 'src/plugin-v2'])
  assert.deepEqual(Object.keys(targetConfig.mcp.servers), ['pantheon-resources'])
  assert.deepEqual(sourceConfig.plugins, ['jsonc-plugin'])
  assert.deepEqual(sourceConfig.mcp.servers, {})
  assert.equal(sourceConfig.theme, 'dark')
})

test('disabling a JSONC managed MCP entry applies disabled to its JSON migration destination', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const managedServer = {
    type: 'local',
    cwd: '/home/user/pantheon',
    command: ['/home/user/pantheon/.venv/bin/python3', 'scripts/mcp_resources.py'],
  }
  writeFileSync(json, JSON.stringify({ mcp: { servers: {} } }))
  writeFileSync(
    jsonc,
    JSON.stringify({
      mcp: { servers: { 'pantheon-resources': managedServer } },
      permission: { mcp: { 'pantheon-resources': 'ask' } },
    }),
  )

  const output = captureOutput()
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({
      targets: [json, jsonc],
      ask: { 'pantheon-resources': 'disable' },
      apply: true,
    }),
    output,
  })

  assert.equal(result.status, 'applied')
  assert.equal(result.changes.length, 2)
  const targetConfig = JSON.parse(readFileSync(json, 'utf8'))
  const sourceConfig = JSON.parse(readFileSync(jsonc, 'utf8'))
  assert.equal(targetConfig.mcp.servers['pantheon-resources'].disabled, true)
  assert.deepEqual(sourceConfig.mcp.servers, {})
  assert.equal(sourceConfig.permission, undefined)
  assert.match(
    output.lines.join(''),
    /Config operation: opencode\.json mcp\.servers\[pantheon-resources\]\.disabled = true/,
  )
  assert.doesNotMatch(output.lines.join(''), /cannot preserve the existing config safely/)
})

test('setup blocks managed-entry migration when JSONC has a malformed nested MCP map', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = '{"mcp":{"servers":{}}}\n'
  const originalJsonc = `${JSON.stringify(
    {
      mcp: {
        servers: {
          'valid-user': { type: 'remote', url: 'https://valid.example/mcp' },
          'malformed-user': false,
          'pantheon-resources': {
            type: 'local',
            command: ['/private/python', 'scripts/mcp_resources.py'],
          },
        },
      },
    },
    null,
    2,
  )}\n`
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)

  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [json, jsonc], apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
})

test('setup blocks a malformed flat MCP server entry before modifying config', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"mcp":{"broken":"not-a-server-config"}}\n'
  writeFileSync(target, original)

  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('V2 setup returns failure before init or writes for array-shaped MCP maps', async (t) => {
  for (const [label, mcp] of [
    ['top-level', [{ type: 'remote', url: 'https://array.example/mcp' }]],
    ['nested', { servers: [{ type: 'remote', url: 'https://array.example/mcp' }] }],
  ]) {
    const home = fixture(t)
    const xdg = join(home, 'xdg')
    const configDir = join(xdg, 'opencode')
    fs.mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'opencode.json')
    const original = `${JSON.stringify({ mcp }, null, 2)}\n`
    writeFileSync(configPath, original)
    let previewCalls = 0
    let initCalls = 0

    const result = await runSetup({
      args: [],
      env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: xdg },
      home,
      cwd: home,
      interactive: true,
      prepare: (options) => prepareV2Config(options),
      previewInit: async () => {
        previewCalls++
        return { status: 0, stdout: EMPTY_INIT_PLAN }
      },
      runInit: async () => {
        initCalls++
        return { status: 0 }
      },
      confirmInit: async () => true,
      applyConfig: () => assert.fail('blocked malformed MCP must not apply config'),
      output: captureOutput(),
    })

    assert.equal(result, 1, `${label} MCP array returns a failing setup status`)
    assert.equal(previewCalls, 0, `${label} MCP array fails before installer preflight`)
    assert.equal(initCalls, 0, `${label} MCP array fails before init`)
    assert.equal(
      readFileSync(configPath, 'utf8'),
      original,
      `${label} MCP config remains byte-identical`,
    )
    assert.deepEqual(fs.readdirSync(configDir), ['opencode.json'])
  }
})

test('exact cross-layer Pantheon plugin duplicates are removed from JSONC', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  writeFileSync(json, JSON.stringify({ plugins: ['before', 'src/plugin-v2', 'after'] }))
  writeFileSync(
    jsonc,
    JSON.stringify({ plugins: ['jsonc-before', 'src/plugin-v2', 'jsonc-middle', 'src/plugin-v2'] }),
  )

  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [jsonc], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')).plugins, [
    'before',
    'src/plugin-v2',
    'after',
  ])
  assert.deepEqual(JSON.parse(readFileSync(jsonc, 'utf8')).plugins, [
    'jsonc-before',
    'jsonc-middle',
  ])
})

test('setup moves one exact duplicate managed plugin and leaves no duplicate if init fails', async (t) => {
  const home = fixture(t)
  const xdg = join(home, 'xdg')
  const configDir = join(xdg, 'opencode')
  fs.mkdirSync(configDir, { recursive: true })
  const json = join(configDir, 'opencode.json')
  const jsonc = join(configDir, 'opencode.jsonc')
  writeFileSync(json, JSON.stringify({ theme: 'dark' }))
  writeFileSync(jsonc, JSON.stringify({ plugins: ['src/plugin-v2', 'src/plugin-v2', 'user'] }))

  const result = await runSetup({
    args: ['--components', 'agents'],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: xdg },
    home,
    cwd: home,
    interactive: true,
    prepare: (options) =>
      prepareV2Config({
        ...options,
        prompts: createPrompts({ targets: [json, jsonc] }),
      }),
    previewInit: async () => ({ status: 0, stdout: EMPTY_INIT_PLAN }),
    confirmInit: async () => true,
    runInit: async () => ({ status: 1 }),
    output: captureOutput(),
  })

  assert.equal(result, 1)
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')).plugins, ['src/plugin-v2'])
  assert.deepEqual(JSON.parse(readFileSync(jsonc, 'utf8')).plugins, ['user'])
})

test('setup refuses differing duplicate managed plugin entries before any write', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = JSON.stringify({ theme: 'dark' })
  const originalJsonc = JSON.stringify({
    plugins: [
      { package: 'src/plugin-v2', options: { mode: 'first' } },
      { package: 'src/plugin-v2', options: { mode: 'second' } },
    ],
  })
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  let promptCalls = 0

  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: {
      multiselect: async () => {
        promptCalls++
        return [json, jsonc]
      },
      select: async () => {
        promptCalls++
        return 'keep'
      },
      isCancel: () => false,
    },
    output: captureOutput(),
  })

  assert.equal(result.status, 'blocked')
  assert.equal(promptCalls, 0)
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
})

test('cross-layer Pantheon plugin duplicates with differing options block before prompts or writes', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const originalJson = JSON.stringify({
    plugins: [{ package: 'src/plugin-v2', options: { mode: 'json' } }],
  })
  const originalJsonc = JSON.stringify({
    plugins: [{ package: 'src/plugin-v2', options: { mode: 'jsonc' } }],
  })
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  let promptCalls = 0
  const prompts = {
    multiselect: async () => {
      promptCalls += 1
      return []
    },
    select: async () => {
      promptCalls += 1
      return 'keep'
    },
    isCancel: () => false,
  }

  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts,
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(promptCalls, 0)
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
  assert.match(result.reason, /cannot be migrated or deduplicated safely/i)
})

test('moving a nested Pantheon MCP entry preserves flat user servers in the V2 conversion', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const userServer = { type: 'remote', url: 'https://user.example/mcp', enabled: true }
  const managedServer = {
    type: 'local',
    cwd: '/home/user/pantheon',
    command: ['/home/user/pantheon/.venv/bin/python3', 'scripts/mcp_resources.py'],
  }
  writeFileSync(json, JSON.stringify({ mcp: { 'user-server': userServer } }))
  writeFileSync(
    jsonc,
    JSON.stringify({ mcp: { servers: { 'pantheon-resources': managedServer } } }),
  )

  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [json, jsonc], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')

  const staged = JSON.parse(readFileSync(json, 'utf8'))
  assert.deepEqual(staged.mcp['user-server'], userServer)
  assert.deepEqual(staged.mcp.servers['pantheon-resources'], managedServer)
  const converted = migrateV1toV2(staged)
  assert.deepEqual(converted.mcp.servers['user-server'], {
    type: 'remote',
    url: 'https://user.example/mcp',
    disabled: false,
  })
  assert.deepEqual(converted.mcp.servers['pantheon-resources'], managedServer)
})

test('moving a JSONC managed MCP entry preserves a flat server literally named servers', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const flatServers = { type: 'remote', url: 'https://flat-servers.example/mcp' }
  const managedServer = {
    type: 'local',
    cwd: '/home/user/pantheon',
    command: ['/home/user/pantheon/.venv/bin/python3', 'scripts/mcp_resources.py'],
  }
  writeFileSync(json, JSON.stringify({ mcp: { servers: flatServers } }))
  writeFileSync(
    jsonc,
    JSON.stringify({ mcp: { servers: { 'pantheon-resources': managedServer } } }),
  )

  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [json, jsonc], apply: true }),
    output: captureOutput(),
  })

  assert.equal(result.status, 'applied')
  const targetConfig = JSON.parse(readFileSync(json, 'utf8'))
  assert.deepEqual(targetConfig.mcp.servers.servers, flatServers)
  assert.deepEqual(targetConfig.mcp.servers['pantheon-resources'], managedServer)
  assert.deepEqual(migrateV1toV2(targetConfig).mcp.servers.servers, flatServers)
})

test('ambiguous duplicate flat and nested MCP server names fail closed without writes', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const original = JSON.stringify({
    mcp: {
      research: { type: 'local', command: ['node', 'flat.mjs'] },
      servers: { research: { type: 'remote', url: 'https://nested.example/mcp' } },
    },
  })
  writeFileSync(json, original)

  await assert.rejects(
    prepareV2Config({ configDir: root, interactive: true, output: captureOutput() }),
    /conflicting flat and nested MCP server entries/i,
  )
  assert.equal(readFileSync(json, 'utf8'), original)
})

test('unsafe plugin order and same-name MCP overrides fail closed when JSONC plugin cannot be represented', async (t) => {
  const root = fixture(t)
  const json = join(root, 'opencode.json')
  const jsonc = join(root, 'opencode.jsonc')
  const override = { type: 'remote', url: 'https://user.example/mcp' }
  const managedServer = {
    type: 'local',
    cwd: '/home/user/pantheon',
    command: ['/home/user/pantheon/.venv/bin/python3', 'scripts/mcp_resources.py'],
  }
  const originalJson = JSON.stringify({
    plugins: ['existing-plugin'],
    mcp: { servers: { 'pantheon-resources': override } },
  })
  const originalJsonc = JSON.stringify({
    plugins: ['jsonc-plugin', 'src/plugin-v2'],
    mcp: { servers: { 'pantheon-resources': managedServer } },
  })
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [json, jsonc], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
  assert.match(result.reason, /cannot be migrated or deduplicated safely in the V2 init preview/)
  assert.equal(JSON.parse(readFileSync(json, 'utf8')).plugins.includes('src/plugin-v2'), false)
  assert.equal(
    JSON.parse(readFileSync(jsonc, 'utf8')).plugins.filter((p) => p === 'src/plugin-v2').length,
    1,
  )
  assert.deepEqual(fs.readdirSync(root).sort(), ['opencode.json', 'opencode.jsonc'])
})

test('a JSONC managed plugin behind a JSON selector fails closed before setup init', async (t) => {
  const home = fixture(t)
  const xdg = join(home, 'xdg')
  const configDir = join(xdg, 'opencode')
  fs.mkdirSync(configDir, { recursive: true })
  const json = join(configDir, 'opencode.json')
  const jsonc = join(configDir, 'opencode.jsonc')
  const originalJson = '{"plugins":["-src/plugin-v2"]}\n'
  const originalJsonc = '{"plugins":["src/plugin-v2"]}\n'
  writeFileSync(json, originalJson)
  writeFileSync(jsonc, originalJsonc)
  const output = captureOutput()
  let initCalls = 0
  const result = await runSetup({
    args: ['--headless'],
    env: { OPENCODE_VERSION: 'v2', XDG_CONFIG_HOME: xdg },
    home,
    cwd: home,
    interactive: false,
    prepare: async (options) =>
      prepareV2Config({
        ...options,
        prompts: createPrompts(),
        output,
      }),
    runInit: async () => {
      initCalls += 1
      return { status: 0 }
    },
    output,
  })
  assert.equal(result, 1)
  assert.equal(initCalls, 0)
  assert.equal(readFileSync(json, 'utf8'), originalJson)
  assert.equal(readFileSync(jsonc, 'utf8'), originalJsonc)
  assert.match(
    output.lines.join(''),
    /cannot be migrated or deduplicated safely in the V2 init preview/,
  )
  assert.equal(
    JSON.parse(readFileSync(jsonc, 'utf8')).plugins.filter((p) => p === 'src/plugin-v2').length,
    1,
  )
})

test('JSONC comments and unrelated settings survive a reviewed application', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.jsonc')
  const original =
    '{\n  // retain the host note\n  "theme": "dark",\n  "permission": {"edit": "deny"}\n}\n'
  writeFileSync(target, original)
  const result = await prepareWithTestApply({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'applied')
  const updated = readFileSync(target, 'utf8')
  assert.match(updated, /\/\/ retain the host note/)
  assert.match(updated, /"theme": "dark"/)
  assert.match(updated, /"permissions"/)
  assert.doesNotMatch(updated, /"permission"\s*:/)
  assert.ok(result.backup.dir)
})

test('a JSONC comment inside a value that would be rewritten blocks writes', async (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.jsonc')
  const original = '{"permission": { /* keep */ "edit": "deny"}}\n'
  writeFileSync(target, original)
  const result = await prepareV2Config({
    configDir: root,
    interactive: true,
    prompts: createPrompts({ targets: [target], apply: true }),
    output: captureOutput(),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(readFileSync(target, 'utf8'), original)
})

test('apply creates a recovery backup before sequential writes and does not claim cross-file atomicity', (t) => {
  const root = fixture(t)
  const first = join(root, 'opencode.json')
  const second = join(root, 'opencode.jsonc')
  const originalFirst = '{"theme":"dark"}\n'
  const originalSecond = '{"theme":"light"}\n'
  writeFileSync(first, originalFirst)
  writeFileSync(second, originalSecond)
  let writes = 0
  assert.throws(
    () =>
      applyConfigChanges(
        [
          { path: first, original: originalFirst, contents: '{"theme":"new"}\n' },
          { path: second, original: originalSecond, contents: '{"theme":"new"}\n' },
        ],
        {
          writeConfig(filePath, contents, dryRun, options) {
            writes += 1
            if (writes === 2) throw new Error('simulated second-file failure')
            return writeConfigWithBackup(filePath, contents, dryRun, options)
          },
        },
      ),
    /simulated second-file failure/,
  )
  assert.equal(readFileSync(first, 'utf8'), '{"theme":"new"}\n')
  assert.equal(readFileSync(second, 'utf8'), originalSecond)
  const backupRoot = join(root, '.pantheon', 'backups')
  const [backupName] = fs.readdirSync(backupRoot)
  assert.equal(readFileSync(join(backupRoot, backupName, 'opencode.json'), 'utf8'), originalFirst)
  assert.equal(readFileSync(join(backupRoot, backupName, 'opencode.jsonc'), 'utf8'), originalSecond)
})

test('apply aborts on review drift before creating backups or replacing config', (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const reviewed = '{"permission":{"edit":"deny"}}\n'
  const external = '{"permission":{"edit":"allow"}}\n'
  writeFileSync(target, reviewed)
  writeFileSync(target, external)
  assert.throws(
    () =>
      applyConfigChanges([{ path: target, original: reviewed, contents: '{"permissions":[]}\n' }]),
    /changed after review/,
  )
  assert.equal(readFileSync(target, 'utf8'), external)
  assert.deepEqual(fs.readdirSync(root), ['opencode.json'])
})

test('apply detects a same-content target replacement by file identity', (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const replacement = join(root, 'replacement.json')
  const original = '{"theme":"dark"}\n'
  writeFileSync(target, original)
  const identity = fs.statSync(target)
  writeFileSync(replacement, original)
  fs.renameSync(replacement, target)

  assert.throws(
    () =>
      applyConfigChanges([
        {
          path: target,
          original,
          contents: '{"theme":"new"}\n',
          identity: { dev: identity.dev, ino: identity.ino },
        },
      ]),
    /changed after review/,
  )
  assert.equal(readFileSync(target, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(root), ['opencode.json'])
})

test('atomic apply preserves the existing file mode', (t) => {
  const root = fixture(t)
  const target = join(root, 'opencode.json')
  const original = '{"permission":{"edit":"deny"}}\n'
  writeFileSync(target, original)
  fs.chmodSync(target, 0o640)
  applyConfigChanges([{ path: target, original, contents: '{"permissions":[]}\n' }])
  assert.equal(fs.statSync(target).mode & 0o777, 0o640)
})
