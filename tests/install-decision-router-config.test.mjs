import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createDecisionRouterConfig,
  DECISION_PROVIDER_BUDGET_MAPPING,
  DECISION_ROUTER_MODELS,
  DEFAULT_DECISION_ROUTER_CONFIG,
  DEFAULT_USER_DECISION_ROUTER_CONFIG,
  isUserDecisionRouterEnabled,
  migrateDecisionRouterConfig,
  migrateUserDecisionRouterConfig,
  REMOTELY_ELIGIBLE_DECISION_PROVIDERS,
  readUserDecisionRouterConfig,
  resolveDecisionRouterProvider,
  resolveUserDecisionRouterCandidate,
  resolveUserDecisionRouterConfigPath,
  updateUserDecisionRouterConfig,
  writeUserDecisionRouterConfig,
} from '../scripts/install/decision-router-config.mjs'
import { createInitialState, readState, writeState } from '../scripts/install/state.mjs'

test('missing and malformed legacy config migrates to Local with external egress disabled', () => {
  assert.deepEqual(migrateDecisionRouterConfig(undefined), DEFAULT_DECISION_ROUTER_CONFIG)
  assert.deepEqual(migrateDecisionRouterConfig({ provider: 'openai-decisions' }), {
    schema_version: 1,
    provider: 'local',
    egress_consent: false,
  })
})

test('versioned preferences preserve provider and only an explicit boolean consent', () => {
  assert.deepEqual(
    migrateDecisionRouterConfig({
      schema_version: 1,
      provider: 'jev',
      egress_consent: true,
    }),
    { schema_version: 1, provider: 'jev', egress_consent: true },
  )
  assert.deepEqual(createDecisionRouterConfig('local', true), {
    schema_version: 1,
    provider: 'local',
    egress_consent: false,
  })
  assert.deepEqual(createDecisionRouterConfig('auto', false), {
    schema_version: 1,
    provider: 'auto',
    egress_consent: false,
  })
})

test('Auto only returns one explicitly authorized provider with consent and a configured budget', () => {
  const auto = createDecisionRouterConfig('auto', true)
  const options = { budgetConfigured: true }

  assert.equal(
    resolveDecisionRouterProvider(auto, { ...options, authorizedProviders: [] }),
    'local',
  )
  assert.equal(
    resolveDecisionRouterProvider(auto, {
      ...options,
      authorizedProviders: ['openai-decisions', 'jev'],
    }),
    'local',
  )
  assert.equal(
    resolveDecisionRouterProvider(auto, {
      ...options,
      authorizedProviders: ['jev'],
    }),
    'jev',
  )
  assert.equal(
    resolveDecisionRouterProvider(auto, {
      authorizedProviders: ['jev'],
      budgetConfigured: false,
    }),
    'local',
  )
  assert.equal(
    resolveDecisionRouterProvider(createDecisionRouterConfig('openai-decisions', false), {
      ...options,
      authorizedProviders: ['openai-decisions'],
    }),
    'local',
  )
})

test('provider resolution never inspects credentials or environment values', () => {
  const config = createDecisionRouterConfig('auto', true)
  assert.equal(
    resolveDecisionRouterProvider(config, {
      authorizedProviders: [],
      budgetConfigured: true,
    }),
    'local',
  )
  assert.deepEqual(Object.keys(config).sort(), ['egress_consent', 'provider', 'schema_version'])
})

test('install-state migration gives old installs Local/disabled and persists versioned preference', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-decision-router-state-'))
  try {
    const stateDir = join(target, '.pantheon')
    mkdirSync(stateDir)
    const statePath = join(stateDir, 'install-state.json')
    writeFileSync(statePath, `${JSON.stringify({ pantheon_version: 'legacy' })}\n`)

    assert.deepEqual(readState(target).decision_router, DEFAULT_DECISION_ROUTER_CONFIG)
    const state = createInitialState('test-version', '2026-10-29T00:00:00.000Z')
    state.decision_router = createDecisionRouterConfig('jev', true)
    writeState(target, state, { updatedAt: '2026-10-29T00:00:00.000Z' })

    const persisted = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.deepEqual(persisted.decision_router, {
      schema_version: 1,
      provider: 'jev',
      egress_consent: true,
    })
    assert.deepEqual(readState(target).decision_router, persisted.decision_router)
    assert.doesNotMatch(readFileSync(statePath, 'utf8'), /api[_-]?key|token|secret/i)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('user-level config migrates invalid data to local-only without consent', () => {
  assert.deepEqual(migrateUserDecisionRouterConfig(undefined), DEFAULT_USER_DECISION_ROUTER_CONFIG)
  assert.deepEqual(
    migrateUserDecisionRouterConfig({
      schema_version: 1,
      selection: { mode: 'explicit', provider: 'openai-decisions', model: 'wrong-model' },
      egress_consent: true,
      enabled_candidates: [{ provider: 'openai-decisions', model: 'gpt-6-luna' }],
    }),
    DEFAULT_USER_DECISION_ROUTER_CONFIG,
  )
})

test('user config uses a private user-level path and survives atomic read/write', () => {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-user-router-'))
  try {
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config') }
    const config = {
      schema_version: 2,
      enabled: true,
      selection: { mode: 'explicit', provider: 'openai-decisions', model: 'gpt-6-luna' },
      egress_consent: true,
      enabled_candidates: [{ provider: 'openai-decisions', model: 'gpt-6-luna' }],
    }
    const target = writeUserDecisionRouterConfig(config, { env })
    assert.equal(target, resolveUserDecisionRouterConfigPath(env))
    assert.equal(readUserDecisionRouterConfig({ env }).selection.provider, 'openai-decisions')
    assert.equal(readFileSync(target, 'utf8').includes('secret'), false)
    assert.equal(statSync(target).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, '.config', 'pantheon')).mode & 0o777, 0o700)
    assert.notEqual(target.includes('install-state.json'), true)
    chmodSync(target, 0o644)
    assert.throws(() => readUserDecisionRouterConfig({ env }), /permissions must be private/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('provider selection, egress consent, candidate enablement, and cap validity are independent', () => {
  const enabled = [{ provider: 'openai-decisions', model: 'gpt-6-luna' }]
  const selectedButNoConsent = {
    schema_version: 1,
    selection: { mode: 'explicit', provider: 'openai-decisions', model: 'gpt-6-luna' },
    egress_consent: false,
    enabled_candidates: enabled,
  }
  assert.equal(resolveUserDecisionRouterCandidate(selectedButNoConsent, enabled), null)
  assert.equal(
    resolveUserDecisionRouterCandidate(
      {
        ...selectedButNoConsent,
        egress_consent: true,
        enabled_candidates: [],
      },
      enabled,
    ),
    null,
  )
  assert.equal(
    resolveUserDecisionRouterCandidate(
      {
        ...selectedButNoConsent,
        egress_consent: true,
      },
      [],
    ),
    null,
  )
  assert.deepEqual(
    resolveUserDecisionRouterCandidate({ ...selectedButNoConsent, egress_consent: true }, enabled),
    enabled[0],
  )
})

test('Auto cardinality counts exact provider/model candidates and excludes unverified Console variants', () => {
  assert.deepEqual(DECISION_ROUTER_MODELS['opencode-console-jev-free'], ['jev-1.13-free'])
  const config = {
    schema_version: 1,
    selection: { mode: 'auto' },
    egress_consent: true,
    enabled_candidates: [
      { provider: 'openai-decisions', model: 'gpt-6-luna' },
      { provider: 'jev', model: 'jev-1.14.0' },
      { provider: 'opencode-console-jev-free', model: 'jev-1.13-free' },
    ],
  }
  assert.equal(resolveUserDecisionRouterCandidate(config, config.enabled_candidates), null)
  assert.deepEqual(
    resolveUserDecisionRouterCandidate(config, [config.enabled_candidates[0]]),
    config.enabled_candidates[0],
  )
})

test('config update does not couple explicit provider selection to consent or enablement', () => {
  const next = updateUserDecisionRouterConfig(DEFAULT_USER_DECISION_ROUTER_CONFIG, {
    selection: { mode: 'explicit', provider: 'typesafe-jev', model: 'jev-1.14.0' },
  })
  assert.equal(next.selection.provider, 'typesafe-jev')
  assert.equal(next.egress_consent, false)
  assert.deepEqual(next.enabled_candidates, [])
})

test('turn selection stays off unless explicitly enabled, even with consent and candidates', () => {
  const config = {
    schema_version: 2,
    enabled: false,
    selection: { mode: 'explicit', provider: 'openai-decisions', model: 'gpt-6-luna' },
    egress_consent: true,
    enabled_candidates: [{ provider: 'openai-decisions', model: 'gpt-6-luna' }],
  }
  assert.equal(isUserDecisionRouterEnabled(config), false)
  assert.equal(resolveUserDecisionRouterCandidate(config, config.enabled_candidates), null)
  assert.equal(isUserDecisionRouterEnabled({ ...config, enabled: true }), true)
})

test('legacy v1 user config migrates intent to the explicit enabled switch', () => {
  const migrated = migrateUserDecisionRouterConfig({
    schema_version: 1,
    selection: { mode: 'explicit', provider: 'jev', model: 'jev-1.14.0' },
    egress_consent: true,
    enabled_candidates: [{ provider: 'jev', model: 'jev-1.14.0' }],
  })
  assert.equal(migrated.schema_version, 2)
  assert.equal(migrated.enabled, true)
  assert.deepEqual(migrated.selection, {
    mode: 'explicit',
    provider: 'typesafe-jev',
    model: 'jev-1.14.0',
  })
  assert.deepEqual(migrated.enabled_candidates, [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }])
  assert.equal(
    migrateUserDecisionRouterConfig({
      schema_version: 1,
      selection: { mode: 'local' },
      egress_consent: true,
      enabled_candidates: [],
    }).enabled,
    false,
  )
})

test('the user provider matrix maps onto ledger accounting providers exactly once', async () => {
  const { LOCAL_DECISION_BUDGET_PROVIDERS } = await import(
    '../src/pantheon/local-decision-budget.ts'
  )
  const ledgerProviders = new Set(LOCAL_DECISION_BUDGET_PROVIDERS)
  for (const [provider, accounting] of Object.entries(DECISION_PROVIDER_BUDGET_MAPPING)) {
    assert.ok(DECISION_ROUTER_MODELS[provider], `${provider} is missing from the model matrix`)
    assert.equal(DECISION_ROUTER_MODELS[provider].length, 1)
    assert.ok(ledgerProviders.has(accounting), `${provider} maps outside the ledger`)
  }
  assert.deepEqual(REMOTELY_ELIGIBLE_DECISION_PROVIDERS, ['openai-decisions', 'typesafe-jev'])
})
