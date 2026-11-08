import assert from 'node:assert/strict'
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
import { join } from 'node:path'
import { after, test } from 'node:test'
import { resolveComponentSelection } from '../scripts/install/component-selection.mjs'
import { createDecisionRouterConfig } from '../scripts/install/decision-router-config.mjs'
import {
  PROMPT_CANCELED,
  promptReview,
  runInteractiveInstall,
} from '../scripts/install/interactive.mjs'
import { installOpenCode } from '../scripts/install/opencode.mjs'
import { createInitialState, writeState } from '../scripts/install/state.mjs'


// test:node runs on machines without an OpenCode binary, so the host gate
// could not confirm the generation it writes for. Pin it for this file: every
// install in here targets the only supported host line. Gate-specific tests
// that pass their own env/probe stay deterministic either way.
process.env.OPENCODE_VERSION = 'v2'
const CANCEL = Symbol('cancel')
const WIZARD_HOME = mkdtempSync(join(tmpdir(), 'pantheon-wizard-tests-'))
const WIZARD_ENV = {
  HOME: WIZARD_HOME,
  XDG_CONFIG_HOME: join(WIZARD_HOME, 'config'),
}
after(() => rmSync(WIZARD_HOME, { recursive: true, force: true }))

/** The one-line cancel message the installer prints for a given point. */
const canceledAt = (point) =>
  `Installation canceled at ${point} — nothing was applied; no configuration was changed.`

function fakePrompts({
  components = ['agents'],
  target = 'global',
  jevActivation = 'skip',
  jevFlags = [],
  confirmed = true,
} = {}) {
  const calls = []
  return {
    calls,
    isCancel: (value) => value === CANCEL,
    cancel: (message) => calls.push(['cancel', message]),
    intro: (title) => calls.push(['intro', title]),
    multiselect: async (options) => {
      calls.push(['multiselect', options])
      return options.message?.startsWith('Decision layer extras') ? jevFlags : components
    },
    select: async (options) => {
      calls.push(['select', options])
      if (options.message === 'Install location:') return target
      if (options.message?.startsWith('Configure the Jev')) return jevActivation
      return 'inherit'
    },
    confirm: async (options) => {
      calls.push(['confirm', options])
      return confirmed
    },
  }
}

test('interactive selection chooses components and location, then asks the Jev activation', async () => {
  const prompts = fakePrompts({ components: ['agents', 'plugins'], target: 'project' })
  const result = await runInteractiveInstall({
    components: ['agents'],
    defaultComponents: ['agents', 'skills'],
    prompts,
    isTTY: true,
    env: WIZARD_ENV,
  })

  assert.deepEqual([...result.components], ['agents', 'plugins'])
  assert.equal(result.target, 'project')
  // The installer-state record stays at its default (Local): the wizard's Jev
  // question configures the REAL user-level route, not this metadata.
  assert.deepEqual(result.decisionRouterConfig, {
    schema_version: 1,
    provider: 'local',
    egress_consent: false,
  })
  assert.equal(result.decisionModelActivation, null)
  assert.deepEqual(
    prompts.calls.map(([name]) => name),
    ['intro', 'multiselect', 'select', 'select', 'multiselect'],
  )
  const jevPrompt = prompts.calls.find(([, options]) =>
    options?.message?.startsWith('Configure the Jev'),
  )[1]
  assert.deepEqual(
    jevPrompt.options.map(({ value }) => value),
    [
      'skip',
      'opencode-console-jev/jev-1.13',
      'openrouter-jev/typesafe/jev-1.13',
      'typesafe-jev/jev-1.14.0',
      'cloudflare-workers-jev/clef',
    ],
  )
  assert.equal(jevPrompt.initialValue, 'skip')
})

test('choosing a Jev route activates it with explicit caps; unknown legacy values degrade to skip', async () => {
  // Stock Console route: activation recorded with the recommended defaults
  // (the stub has no text input, so the caps degrade to defaults).
  const stock = fakePrompts({ jevActivation: 'opencode-console-jev/jev-1.13' })
  const stockResult = await runInteractiveInstall({ prompts: stock, isTTY: true, env: WIZARD_ENV })
  assert.deepEqual(stockResult.decisionModelActivation, {
    target: 'opencode-console-jev/jev-1.13',
    monthly: '5',
    perDecision: '0.10',
  })
  assert.deepEqual(stockResult.decisionRouterConfig, {
    schema_version: 1,
    provider: 'local',
    egress_consent: false,
  })

  // The free variant is REMOVED (limited free quota 429s mid-work): a stale
  // free choice degrades to skip like any unknown target.
  const free = fakePrompts({ jevActivation: 'opencode-console-jev-free/jev-1.13-free' })
  const freeResult = await runInteractiveInstall({ prompts: free, isTTY: true, env: WIZARD_ENV })
  assert.equal(freeResult.decisionModelActivation, null, 'removed free route degrades to skip')

  // TypeSafe direct activates its target and setup-model provisions the host
  // provider entry before asking the user to supply their key.
  const typesafe = fakePrompts({ jevActivation: 'typesafe-jev/jev-1.14.0' })
  const typesafeResult = await runInteractiveInstall({
    prompts: typesafe,
    isTTY: true,
    env: WIZARD_ENV,
  })
  assert.equal(typesafeResult.decisionModelActivation.target, 'typesafe-jev/jev-1.14.0')

  const openrouter = fakePrompts({ jevActivation: 'openrouter-jev/typesafe/jev-1.13' })
  const openrouterResult = await runInteractiveInstall({
    prompts: openrouter,
    isTTY: true,
    env: WIZARD_ENV,
  })
  assert.equal(openrouterResult.decisionModelActivation.target, 'openrouter-jev/typesafe/jev-1.13')

  const cloudflare = fakePrompts({ jevActivation: 'cloudflare-workers-jev/clef' })
  const cloudflareResult = await runInteractiveInstall({
    prompts: cloudflare,
    isTTY: true,
    env: WIZARD_ENV,
  })
  assert.equal(cloudflareResult.decisionModelActivation, null)
  assert.deepEqual(cloudflareResult.decisionModelDeferredSetup, {
    target: 'cloudflare-workers-jev/clef',
  })
  const cloudflareChoice = cloudflare.calls
    .find(([, options]) => options?.message?.startsWith('Configure the Jev'))[1]
    .options.find(({ value }) => value === 'cloudflare-workers-jev/clef')
  assert.match(cloudflareChoice.label, /provision after install/i)
  assert.match(cloudflareChoice.hint, /--account-id=<32-hex-id>/)
  assert.match(cloudflareChoice.hint, /not activated by this wizard/i)

  // Legacy metadata spellings and unknown values are NOT targets: direct
  // OpenAI has no native route and 'jev'/'auto' were the old metadata prompt.
  for (const legacy of ['jev', 'openai-decisions', 'auto', 'local']) {
    const legacyResult = await runInteractiveInstall({
      prompts: fakePrompts({ jevActivation: legacy }),
      isTTY: true,
      env: WIZARD_ENV,
    })
    assert.equal(legacyResult.decisionModelActivation, null, `${legacy} must not activate`)
  }
})

test('wizard writes the runtime specialist caller env name and preserves the Zeus-only default', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-wizard-flags-'))
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'config') }
  const flagsPath = join(env.XDG_CONFIG_HOME, 'pantheon', 'decision-flags.env')
  try {
    await runInteractiveInstall({ prompts: fakePrompts(), isTTY: true, env })
    let generated = readFileSync(flagsPath, 'utf8')
    assert.match(generated, /^export PANTHEON_JEV_SPECIALIST_CALLERS=$/m)
    assert.doesNotMatch(generated, /export CALLERS=/)

    await runInteractiveInstall({
      prompts: fakePrompts({
        jevFlags: ['PANTHEON_J1_RISK_SCORE=on', 'PANTHEON_JEV_SPECIALIST_CALLERS=athena,themis'],
      }),
      isTTY: true,
      env,
    })
    generated = readFileSync(flagsPath, 'utf8')
    assert.match(generated, /^export PANTHEON_JEV_SPECIALIST_CALLERS=athena,themis$/m)
    assert.match(generated, /^export PANTHEON_J1_RISK_SCORE=on$/m)
    assert.doesNotMatch(generated, /export CALLERS=/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('canceling the Jev activation stops before an installer apply', async () => {
  const providerPrompts = fakePrompts()
  providerPrompts.select = async (options) =>
    options.message === 'Install location:'
      ? 'global'
      : options.message?.startsWith('Configure the Jev')
        ? CANCEL
        : 'inherit'
  const providerCanceled = await runInteractiveInstall({ prompts: providerPrompts, isTTY: true })
  assert.equal(providerCanceled.canceled, true)
  assert.equal(providerCanceled.cancelPoint, 'decisionRouter')
})

test('headless and TTY defaults match and runtime/prompts are opt-in', () => {
  const defaults = resolveComponentSelection([]).components
  assert.deepEqual(defaults, ['agents', 'skills', 'instructions', 'commands', 'plugins'])
  assert.equal(defaults.includes('runtime'), false)
  assert.equal(defaults.includes('prompts'), false)
  assert.deepEqual(resolveComponentSelection(['--components', 'prompts,runtime']).components, [
    'prompts',
    'runtime',
  ])
})

test('empty component selection cancels instead of reinstalling defaults', async () => {
  const prompts = fakePrompts({ components: [] })
  const result = await runInteractiveInstall({
    components: ['agents'],
    defaultComponents: ['agents', 'skills'],
    prompts,
    isTTY: true,
  })

  assert.equal(result.canceled, true)
  assert.deepEqual(
    prompts.calls.map(([name]) => name),
    ['intro', 'multiselect', 'cancel'],
  )
})

test('interactive prompt cancellation exits before any installer configuration writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-interactive-cancel-'))
  const target = join(root, 'opencode')
  mkdirSync(target, { recursive: true })
  const sentinel = join(target, 'sentinel.json')
  writeFileSync(sentinel, '{"untouched":true}\n')
  const prompts = fakePrompts()
  prompts.multiselect = async () => CANCEL

  try {
    const result = await installOpenCode(target, false, false, ['agents'], {
      interactive: true,
      global: true,
      deps: { prompts, isTTY: true },
    })
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'canceled')
    assert.equal(result.cancelPoint, 'components', 'the message must name where it stopped')
    assert.deepEqual(prompts.calls, [
      ['intro', 'OpenCode Installer'],
      ['cancel', canceledAt('component selection')],
    ])
    assert.equal(readFileSync(sentinel, 'utf8'), '{"untouched":true}\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review prompt preserves cancellation separately from an explicit decline', async () => {
  const prompts = fakePrompts()
  prompts.confirm = async (options) => {
    prompts.calls.push(['confirm', options])
    return CANCEL
  }

  assert.equal(
    await promptReview('Apply this reviewed plan?', { prompts, isTTY: true }),
    PROMPT_CANCELED,
  )
  assert.deepEqual(prompts.calls, [
    ['confirm', { message: 'Apply this reviewed plan?', initialValue: false }],
    ['cancel', canceledAt('review prompt')],
  ])

  const declinePrompts = fakePrompts({ confirmed: false })
  assert.equal(
    await promptReview('Apply this reviewed plan?', { prompts: declinePrompts, isTTY: true }),
    false,
  )
  assert.equal(declinePrompts.calls.length, 1)
})

test('TTY --yes uses defaults without invoking any prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-yes-decline-'))
  const target = join(root, 'opencode')
  mkdirSync(target, { recursive: true })
  const sentinel = join(target, 'sentinel.json')
  writeFileSync(sentinel, '{"untouched":true}\n')
  const prompts = fakePrompts({ components: ['skills'], confirmed: false })

  try {
    const result = await installOpenCode(target, false, false, ['agents'], {
      interactive: true,
      yes: true,
      global: true,
      deps: { prompts, isTTY: true },
    })

    assert.equal(result.applied, true)
    assert.deepEqual(prompts.calls, [])
    assert.equal(readFileSync(sentinel, 'utf8'), '{"untouched":true}\n')
    assert.ok(existsSync(join(target, 'agents', 'zeus.md')))
    assert.deepEqual(
      JSON.parse(readFileSync(join(target, '.pantheon', 'install-state.json'), 'utf8'))
        .decision_router,
      { schema_version: 1, provider: 'local', egress_consent: false },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withTTYComponentSelection(args, callback, selectedComponents = ['agents']) {
  const selection = resolveComponentSelection(args)
  const root = mkdtempSync(join(tmpdir(), 'pantheon-component-defaults-'))
  const target = join(root, 'opencode')
  const prompts = fakePrompts({ components: ['agents'] })
  let initialValues
  let availableComponents
  let runtimeSetupCalled = false
  prompts.multiselect = async (options) => {
    if (options.message?.startsWith('Decision layer extras')) return []
    initialValues = options.initialValues
    availableComponents = options.options.map((option) => option.value)
    return selectedComponents
  }
  prompts.select = async ({ message }) =>
    message === 'Install location:'
      ? 'global'
      : message?.startsWith('Configure the Jev')
        ? 'skip'
        : 'inherit'

  try {
    const result = await withTTY(() =>
      installOpenCode(target, false, false, selection.components, {
        interactive: true,
        global: true,
        requestedComponents: selection.requestedComponentsForPrompt,
        noMcp: selection.noMcp,
        deps: {
          prompts,
          env: WIZARD_ENV,
          promptReview: async () => true,
          runVisionPrompt: async () => {},
          setupVenv: () => {
            runtimeSetupCalled = true
          },
          healthCheck: () => ({ passed: [], warnings: [], failed: [] }),
        },
      }),
    )
    await callback({
      initialValues,
      availableComponents,
      result,
      runtimeSetupCalled,
      target,
      selection,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('CLI --components agents,skills seeds TTY without runtime and does not write it', async () => {
  await withTTYComponentSelection(
    ['init', '--components', 'agents,skills'],
    async ({ initialValues, availableComponents, result, target, selection }) => {
      assert.deepEqual(initialValues, ['agents', 'skills'])
      assert.ok(availableComponents.includes('runtime'))
      assert.deepEqual(selection.components, ['agents', 'skills'])
      assert.equal(result.applied, true)
      assert.equal(existsSync(join(target, 'agents', 'zeus.md')), true)
      assert.equal(existsSync(join(target, 'skills', 'agent-coordination', 'SKILL.md')), true)
      assert.equal(existsSync(join(target, '.venv')), false)
      assert.equal(existsSync(join(target, 'scripts', 'mcp_resources.py')), false)
    },
    ['agents', 'skills'],
  )
})

test('CLI --no-mcp hard-excludes runtime even if the TTY prompt returns it', async () => {
  await withTTYComponentSelection(
    ['init', '--no-mcp'],
    async ({
      initialValues,
      availableComponents,
      result,
      runtimeSetupCalled,
      target,
      selection,
    }) => {
      assert.deepEqual(initialValues, ['agents', 'skills', 'instructions', 'commands', 'plugins'])
      assert.equal(availableComponents.includes('runtime'), false)
      assert.equal(selection.components.includes('runtime'), false)
      assert.equal(result.applied, true)
      assert.equal(existsSync(join(target, 'agents', 'zeus.md')), true)
      assert.equal(runtimeSetupCalled, false)
      assert.equal(existsSync(join(target, '.venv')), false)
      assert.equal(existsSync(join(target, '.pantheon', 'code-mode')), false)
      assert.equal(existsSync(join(target, 'scripts', 'mcp_resources.py')), false)
    },
    ['agents', 'runtime'],
  )
})

test('canceling final apply authorization reports canceled and writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-review-cancel-'))
  const target = join(root, 'opencode')
  mkdirSync(target, { recursive: true })
  const sentinel = join(target, 'sentinel.json')
  writeFileSync(sentinel, '{"untouched":true}\n')

  try {
    const result = await installOpenCode(target, false, false, ['agents'], {
      headless: true,
      deps: { promptReview: async () => PROMPT_CANCELED },
    })
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'canceled')
    assert.equal(readFileSync(sentinel, 'utf8'), '{"untouched":true}\n')
    assert.deepEqual(readdirSync(target), ['sentinel.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withTTY(callback) {
  const streams = [process.stdin, process.stdout]
  const originalDescriptors = streams.map((stream) =>
    Object.getOwnPropertyDescriptor(stream, 'isTTY'),
  )
  for (const stream of streams) {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: true })
  }
  try {
    return await callback()
  } finally {
    streams.forEach((stream, index) => {
      const descriptor = originalDescriptors[index]
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor)
      else delete stream.isTTY
    })
  }
}

test('the Jev wizard choice makes no provider network request during installation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-provider-choice-no-network-'))
  const target = join(root, 'opencode')
  const prompts = fakePrompts({ jevActivation: 'opencode-console-jev/jev-1.13' })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('provider network must not be used during installation')
  }

  try {
    const result = await installOpenCode(target, false, false, ['agents'], {
      interactive: true,
      global: true,
      deps: {
        prompts,
        env: WIZARD_ENV,
        isTTY: true,
        promptReview: async () => true,
        runVisionPrompt: async () => {},
      },
    })
    assert.equal(result.applied, true)
    assert.equal(fetchCalls, 0)
    const state = JSON.parse(readFileSync(join(target, '.pantheon', 'install-state.json'), 'utf8'))
    // The activation configures the USER-level route at the end of init; the
    // installer-state record stays at its default.
    assert.deepEqual(state.decision_router, {
      schema_version: 1,
      provider: 'local',
      egress_consent: false,
    })
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})

async function runTTYInstall(target) {
  const selectMessages = []
  const prompts = fakePrompts()
  prompts.multiselect = async () => ['agents']
  prompts.select = async ({ message }) => {
    selectMessages.push(message)
    if (message === 'Install location:') return 'global'
    if (message?.startsWith('Configure the Jev')) return 'skip'
    return 'inherit'
  }

  const result = await installOpenCode(target, false, false, ['agents'], {
    interactive: true,
    global: true,
    deps: {
      prompts,
      env: WIZARD_ENV,
      promptReview: async () => true,
      runVisionPrompt: async () => {},
    },
  })
  return { result, selectMessages }
}

test('interactive install skips the retired profile wizard and preserves legacy marker bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v2-no-preset-wizard-'))
  const target = join(root, 'opencode')
  const marker = join(target, '.pantheon', 'active-preset.json')
  const markerBytes = '{"version":1,"preset":"keep-existing"}\n'
  mkdirSync(join(target, '.pantheon'), { recursive: true })
  writeFileSync(marker, markerBytes)

  try {
    const { result, selectMessages } = await withTTY(() => runTTYInstall(target))
    assert.equal(result.applied, true)
    assert.deepEqual(selectMessages, ['Install location:', selectMessages[1]])
    assert.match(selectMessages[1], /^Configure the Jev/)
    assert.equal(readFileSync(marker, 'utf8'), markerBytes)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit --preset is refused outright, on any project shape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-preset-refused-'))
  const target = join(root, 'opencode')
  try {
    await assert.rejects(
      installOpenCode(target, false, false, ['agents'], {
        headless: true,
        yes: true,
        global: true,
        preset: 'anthropic',
      }),
      /--preset is not supported/i,
    )
    assert.equal(existsSync(join(target, '.pantheon', 'active-preset.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('V2 explicit --preset is rejected before changing config or writing a marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v2-preset-rejected-'))
  const target = join(root, 'opencode')
  mkdirSync(target, { recursive: true })
  const configPath = join(target, 'opencode.json')
  const configBytes = '{"keep":true}\n'
  writeFileSync(configPath, configBytes)

  try {
    await assert.rejects(
      installOpenCode(target, false, false, ['agents'], {
        headless: true,
        preset: 'anthropic',
      }),
      /--preset is not supported/i,
    )
    assert.equal(readFileSync(configPath, 'utf8'), configBytes)
    assert.equal(readdirSync(target).join(','), 'opencode.json')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('forced interactive mode without a TTY keeps defaults and never invokes prompts', async () => {
  const prompts = fakePrompts()
  const result = await runInteractiveInstall({
    components: ['agents'],
    defaultComponents: ['agents', 'skills'],
    prompts,
    isTTY: false,
  })

  assert.deepEqual([...result.components], ['agents', 'skills'])
  assert.equal(result.target, 'global')
  assert.deepEqual(result.decisionRouterConfig, {
    schema_version: 1,
    provider: 'local',
    egress_consent: false,
  })
  assert.deepEqual(prompts.calls, [])
})

test('forced interactive update without a TTY preserves the saved provider preference and consent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-interactive-no-tty-preserve-'))
  const target = join(root, 'opencode')
  mkdirSync(target, { recursive: true })
  const state = createInitialState('existing-version')
  state.decision_router = createDecisionRouterConfig('jev', true)
  writeState(target, state)
  const prompts = fakePrompts()

  try {
    const result = await installOpenCode(target, false, false, ['agents'], {
      interactive: true,
      global: true,
      deps: {
        prompts,
        isTTY: false,
        promptReview: async () => true,
        runVisionPrompt: async () => {},
      },
    })

    assert.equal(result.applied, true)
    assert.deepEqual(prompts.calls, [])
    assert.deepEqual(
      JSON.parse(readFileSync(join(target, '.pantheon', 'install-state.json'), 'utf8'))
        .decision_router,
      { schema_version: 1, provider: 'jev', egress_consent: true },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
