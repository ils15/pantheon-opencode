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
import { test } from 'node:test'
import { resolveComponentSelection } from '../scripts/install/component-selection.mjs'
import { createDecisionRouterConfig } from '../scripts/install/decision-router-config.mjs'
import {
  PROMPT_CANCELED,
  promptReview,
  runInteractiveInstall,
} from '../scripts/install/interactive.mjs'
import { installOpenCode } from '../scripts/install/opencode.mjs'
import { createInitialState, writeState } from '../scripts/install/state.mjs'

const CANCEL = Symbol('cancel')

/** The one-line cancel message the installer prints for a given point. */
const canceledAt = (point) =>
  `Installation canceled at ${point} — nothing was applied; no configuration was changed.`

function fakePrompts({
  components = ['agents'],
  target = 'global',
  decisionRouter = 'local',
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
      return components
    },
    select: async (options) => {
      calls.push(['select', options])
      if (options.message === 'Install location:') return target
      if (options.message?.startsWith('Decision-router')) return decisionRouter
      return 'inherit'
    },
    confirm: async (options) => {
      calls.push(['confirm', options])
      return confirmed
    },
  }
}

test('interactive selection chooses components and location before one later apply confirmation', async () => {
  const prompts = fakePrompts({ components: ['agents', 'plugins'], target: 'project' })
  const result = await runInteractiveInstall({
    components: ['agents'],
    defaultComponents: ['agents', 'skills'],
    prompts,
    isTTY: true,
  })

  assert.deepEqual([...result.components], ['agents', 'plugins'])
  assert.equal(result.target, 'project')
  assert.deepEqual(result.decisionRouterConfig, {
    schema_version: 1,
    provider: 'local',
    egress_consent: false,
  })
  assert.deepEqual(
    prompts.calls.map(([name]) => name),
    ['intro', 'multiselect', 'select', 'select'],
  )
  assert.deepEqual(prompts.calls[0], ['intro', 'OpenCode Installer'])
  const providerPrompt = prompts.calls.find(([, options]) =>
    options?.message?.startsWith('Decision-router'),
  )[1]
  assert.deepEqual(
    providerPrompt.options.map(({ value }) => value),
    ['local', 'openai-decisions', 'jev', 'auto'],
  )
  assert.equal(providerPrompt.initialValue, 'local')
  assert.match(providerPrompt.message, /installer preference/i)
  assert.match(providerPrompt.message, /runtime provider\/model settings.*managed separately/i)
  assert.match(providerPrompt.message, /installation makes no provider requests/i)
})

test('external provider choice requires separate consent and stores no credentials', async () => {
  const prompts = fakePrompts({ decisionRouter: 'jev', confirmed: false })
  const result = await runInteractiveInstall({ prompts, isTTY: true })

  assert.deepEqual(result.decisionRouterConfig, {
    schema_version: 1,
    provider: 'jev',
    egress_consent: false,
  })
  const consent = prompts.calls.find(([name]) => name === 'confirm')?.[1]
  assert.equal(consent.initialValue, false)
  assert.match(consent.message, /not runtime consent/i)
  assert.match(consent.message, /configure actual user-level consent and caps/i)
  assert.match(consent.message, /installation makes no provider requests/i)
  assert.deepEqual(Object.keys(result.decisionRouterConfig).sort(), [
    'egress_consent',
    'provider',
    'schema_version',
  ])
})

test('an explicit affirmative consent is persisted separately from provider selection', async () => {
  const prompts = fakePrompts({ decisionRouter: 'openai-decisions', confirmed: true })
  const result = await runInteractiveInstall({ prompts, isTTY: true })

  assert.deepEqual(result.decisionRouterConfig, {
    schema_version: 1,
    provider: 'openai-decisions',
    egress_consent: true,
  })
})

test('canceling provider or consent selection stops before an installer apply', async () => {
  const providerPrompts = fakePrompts()
  providerPrompts.select = async (options) =>
    options.message === 'Install location:'
      ? 'global'
      : options.message?.startsWith('Decision-router')
        ? CANCEL
        : 'inherit'
  const providerCanceled = await runInteractiveInstall({ prompts: providerPrompts, isTTY: true })
  assert.equal(providerCanceled.canceled, true)
  assert.equal(providerCanceled.cancelPoint, 'decisionRouter')

  const consentPrompts = fakePrompts({ decisionRouter: 'jev' })
  consentPrompts.confirm = async () => CANCEL
  const consentCanceled = await runInteractiveInstall({ prompts: consentPrompts, isTTY: true })
  assert.equal(consentCanceled.canceled, true)
  assert.equal(consentCanceled.cancelPoint, 'egressConsent')
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
      version: 'v1',
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
      version: 'v1',
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
    initialValues = options.initialValues
    availableComponents = options.options.map((option) => option.value)
    return selectedComponents
  }
  prompts.select = async ({ message }) =>
    message === 'Install location:'
      ? 'global'
      : message?.startsWith('Decision-router')
        ? 'local'
        : 'inherit'

  try {
    const result = await withTTY(() =>
      installOpenCode(target, false, false, selection.components, {
        interactive: true,
        version: 'v1',
        global: true,
        requestedComponents: selection.requestedComponentsForPrompt,
        noMcp: selection.noMcp,
        deps: {
          prompts,
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
      version: 'v1',
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

test('interactive provider selection persists preference without any provider network request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-provider-choice-no-network-'))
  const target = join(root, 'opencode')
  const prompts = fakePrompts({ decisionRouter: 'openai-decisions', confirmed: true })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('provider network must not be used during installation')
  }

  try {
    const result = await installOpenCode(target, false, false, ['agents'], {
      interactive: true,
      version: 'v1',
      global: true,
      deps: {
        prompts,
        isTTY: true,
        promptReview: async () => true,
        runVisionPrompt: async () => {},
      },
    })
    assert.equal(result.applied, true)
    assert.equal(fetchCalls, 0)
    const state = JSON.parse(readFileSync(join(target, '.pantheon', 'install-state.json'), 'utf8'))
    assert.deepEqual(state.decision_router, {
      schema_version: 1,
      provider: 'openai-decisions',
      egress_consent: true,
    })
    assert.deepEqual(Object.keys(state.decision_router).sort(), [
      'egress_consent',
      'provider',
      'schema_version',
    ])
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})

async function runTTYInstall(target, version) {
  const selectMessages = []
  const prompts = fakePrompts()
  prompts.multiselect = async () => ['agents']
  prompts.select = async ({ message }) => {
    selectMessages.push(message)
    if (message === 'Install location:') return 'global'
    if (message?.startsWith('Decision-router')) return 'local'
    return 'inherit'
  }

  const result = await installOpenCode(target, false, false, ['agents'], {
    interactive: true,
    version,
    global: true,
    deps: {
      prompts,
      promptReview: async () => true,
      runVisionPrompt: async () => {},
    },
  })
  return { result, selectMessages }
}

test('V2 interactive install skips the V1 profile wizard and preserves legacy marker bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v2-no-preset-wizard-'))
  const target = join(root, 'opencode')
  const marker = join(target, '.pantheon', 'active-preset.json')
  const markerBytes = '{"version":1,"preset":"keep-existing"}\n'
  mkdirSync(join(target, '.pantheon'), { recursive: true })
  writeFileSync(marker, markerBytes)

  try {
    const { result, selectMessages } = await withTTY(() => runTTYInstall(target, 'v2'))
    assert.equal(result.applied, true)
    assert.deepEqual(selectMessages, ['Install location:', selectMessages[1]])
    assert.match(selectMessages[1], /^Decision-router/)
    assert.equal(readFileSync(marker, 'utf8'), markerBytes)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('V1 interactive install retains the model profile wizard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v1-preset-wizard-'))
  const target = join(root, 'opencode')
  try {
    const { result, selectMessages } = await withTTY(() => runTTYInstall(target, 'v1'))
    assert.equal(result.applied, true)
    assert.deepEqual(selectMessages, [
      'Install location:',
      selectMessages[1],
      'Choose the default model profile for Pantheon agents.',
    ])
    assert.match(selectMessages[1], /^Decision-router/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('V1 explicit --preset continues to write the active preset marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v1-explicit-preset-'))
  const target = join(root, 'opencode')
  try {
    await installOpenCode(target, false, false, ['agents'], {
      headless: true,
      yes: true,
      version: 'v1',
      global: true,
      preset: 'anthropic',
    })
    assert.equal(
      JSON.parse(readFileSync(join(target, '.pantheon', 'active-preset.json'), 'utf8')).preset,
      'anthropic',
    )
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
        version: 'v2',
        preset: 'anthropic',
      }),
      /--preset is not supported for OpenCode V2/i,
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
      version: 'v1',
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
