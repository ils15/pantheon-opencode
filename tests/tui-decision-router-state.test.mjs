import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  DECISION_ROUTER_MODELS,
  DECISION_ROUTER_PROVIDERS,
} from '../scripts/install/decision-router-config.mjs'
import {
  applyDecisionRow,
  buildDecisionTab,
  DECISION_CONFIG_KEYS,
  DECISION_CONFIG_SCHEMA_VERSION,
  DECISION_KNOWN_MODELS,
  DECISION_KNOWN_PROVIDERS,
  DECISION_PROVIDER_CREDENTIALS,
  DEFAULT_DECISION_CONFIG,
  isValidDecisionConfig,
  readDecisionRouterConfig,
  serializeDecisionConfig,
  setDecisionEnabled,
  writeDecisionRouterConfig,
} from '../src/plugins/tui/src/decision-router-state.ts'

const SOURCE = new URL('../scripts/install/decision-router-config.mjs', import.meta.url)

const config = (overrides = {}) => ({
  ...structuredClone(DEFAULT_DECISION_CONFIG),
  ...overrides,
})

describe('decision router config schema (TUI-local replica)', () => {
  it('drift pins schema version, key set and defaults against the installer source', () => {
    const source = readFileSync(SOURCE, 'utf8')
    assert.ok(
      source.includes(
        `USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION = ${DECISION_CONFIG_SCHEMA_VERSION}`,
      ),
      'schema version drifted',
    )
    for (const key of DECISION_CONFIG_KEYS) {
      assert.ok(
        source.includes(`'${key}'`),
        `config key '${key}' no longer exists in the canonical schema`,
      )
    }
    assert.equal(DEFAULT_DECISION_CONFIG.schema_version, DECISION_CONFIG_SCHEMA_VERSION)
    assert.equal(DEFAULT_DECISION_CONFIG.enabled, false)
    assert.equal(DEFAULT_DECISION_CONFIG.egress_consent, false)
    assert.deepEqual(DEFAULT_DECISION_CONFIG.enabled_candidates, [])
  })

  it('the known providers are exactly the canonical matrix keys', () => {
    assert.deepEqual(
      [...DECISION_KNOWN_PROVIDERS].sort(),
      Object.keys(DECISION_ROUTER_MODELS).sort(),
    )
    // The legacy installer-state provider list is a DIFFERENT surface (names
    // like 'jev'/'auto') — the user-level config never carries those.
    assert.equal(DECISION_KNOWN_PROVIDERS.includes('jev'), false)
    assert.equal(DECISION_KNOWN_PROVIDERS.includes('auto'), false)
    assert.ok(DECISION_ROUTER_PROVIDERS.includes('local'))
  })
})

describe('validation (the exact-key rule is load-bearing)', () => {
  it('accepts the default config', () => {
    assert.equal(isValidDecisionConfig(config()), true)
  })

  it('rejects an unknown key — the runtime would fail-close', () => {
    assert.equal(isValidDecisionConfig({ ...config(), channel: 'beta' }), false)
  })

  it('rejects a missing key', () => {
    const { egress_consent: _dropped, ...rest } = config()
    assert.equal(isValidDecisionConfig(rest), false)
  })

  it('rejects wrong types and legacy schema versions', () => {
    assert.equal(isValidDecisionConfig({ ...config(), enabled: 'yes' }), false)
    assert.equal(isValidDecisionConfig({ ...config(), schema_version: 1 }), false)
    assert.equal(isValidDecisionConfig({ ...config(), selection: { mode: 'yolo' } }), false)
    assert.equal(
      isValidDecisionConfig({ ...config(), enabled_candidates: [{ provider: 'x' }] }),
      false,
    )
  })
})

describe('serialize round-trip', () => {
  it('is stable, sorted and revalidates', () => {
    const rich = {
      schema_version: DECISION_CONFIG_SCHEMA_VERSION,
      enabled: true,
      selection: { mode: 'explicit', provider: 'cloudflare-workers-jev', model: 'clef' },
      egress_consent: true,
      enabled_candidates: [
        { provider: 'opencode-console-jev', model: 'jev-1.13' },
        { provider: 'cloudflare-workers-jev', model: 'clef' },
      ],
    }
    const text = serializeDecisionConfig(rich)
    assert.equal(text, serializeDecisionConfig(rich), 'stable bytes')
    assert.ok(text.startsWith('{\n  "egress_consent"'), 'sorted keys')
    assert.ok(text.endsWith('\n'))
    assert.deepEqual(JSON.parse(text), rich, 'round-trips')
    assert.equal(isValidDecisionConfig(JSON.parse(text)), true)
  })

  it('keeps a model-only selection (no provider)', () => {
    const odd = { ...config(), selection: { mode: 'auto', model: 'jev-1.13' } }
    assert.equal(isValidDecisionConfig(odd), true)
    assert.deepEqual(JSON.parse(serializeDecisionConfig(odd)), odd)
  })
})

describe('the enable guard', () => {
  it('enables freely when local-only', () => {
    const result = setDecisionEnabled(config(), true)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.config.enabled, true)
  })

  it('refuses to enable remote candidates without egress consent', () => {
    const remote = config({
      selection: { mode: 'auto' },
      enabled_candidates: [{ provider: 'cloudflare-workers-jev', model: 'clef' }],
      egress_consent: false,
    })
    const result = setDecisionEnabled(remote, true)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /egress consent/)
  })

  it('enables remote candidates once consent is granted', () => {
    const remote = config({
      selection: { mode: 'auto' },
      enabled_candidates: [{ provider: 'cloudflare-workers-jev', model: 'clef' }],
      egress_consent: true,
    })
    assert.equal(setDecisionEnabled(remote, true).ok, true)
  })

  it('never touches egress_consent', () => {
    const result = setDecisionEnabled(config({ egress_consent: false }), true)
    if (result.ok) assert.equal(result.config.egress_consent, false)
  })
})

describe('disk I/O', () => {
  it('writes 0600, atomic, and reads back identical', () => {
    const home = mkdtempSync(join(tmpdir(), 'pantheon-decision-'))
    try {
      const env = { XDG_CONFIG_HOME: join(home, 'config') }
      const enabled = setDecisionEnabled(config(), true)
      assert.equal(enabled.ok, true)
      if (enabled.ok) writeDecisionRouterConfig(enabled.config, env)
      const path = join(home, 'config', 'pantheon', 'decision-router.json')
      const mode = statSync(path).mode & 0o777
      assert.equal(mode, 0o600, 'the canonical writer persists 0600')
      const read = readDecisionRouterConfig(env)
      assert.equal(read.corrupt, false)
      assert.equal(read.config.enabled, true)
      assert.deepEqual(read.config, enabled.ok ? enabled.config : {})
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a corrupt file reads as corrupt + defaults, never a guess', () => {
    const home = mkdtempSync(join(tmpdir(), 'pantheon-decision-'))
    try {
      const env = { XDG_CONFIG_HOME: join(home, 'config') }
      mkdirSync(join(home, 'config', 'pantheon'), { recursive: true })
      writeFileSync(join(home, 'config', 'pantheon', 'decision-router.json'), '{oops', 'utf8')
      const read = readDecisionRouterConfig(env)
      assert.equal(read.corrupt, true)
      assert.equal(read.config.enabled, false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a missing file reads as the default, not corrupt', () => {
    const home = mkdtempSync(join(tmpdir(), 'pantheon-decision-'))
    try {
      const read = readDecisionRouterConfig({ XDG_CONFIG_HOME: join(home, 'config') })
      assert.equal(read.corrupt, false)
      assert.deepEqual(read.config, DEFAULT_DECISION_CONFIG)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('decision section rows', () => {
  it('surfaces live-apply and refuses writes on a corrupt file', () => {
    const clean = buildDecisionTab({ config: config({ enabled: true }), corrupt: false })
    const enabledRow = clean.groups
      .flatMap((g) => g.rows)
      .find((row) => row.id === 'decision.enabled')
    assert.equal(enabledRow.value, 'enabled')
    assert.deepEqual(enabledRow.cycle, ['enabled', 'disabled'])
    assert.match(enabledRow.note, /applies live/)

    const corrupt = buildDecisionTab({ config: DEFAULT_DECISION_CONFIG, corrupt: true })
    const corruptRow = corrupt.groups
      .flatMap((g) => g.rows)
      .find((row) => row.id === 'decision.enabled')
    assert.equal(corruptRow.cycle, undefined, 'no staging on a corrupt file')
    assert.match(corruptRow.note, /fail-closes/)
    assert.match(corruptRow.note, /setup-model/)
  })
})

describe('selection / consent staging (applyDecisionRow)', () => {
  it('selection.mode stages local (candidates cleared) and explicit (candidates set)', () => {
    const remote = {
      ...structuredClone(DEFAULT_DECISION_CONFIG),
      selection: { mode: 'explicit', provider: 'cloudflare-workers-jev', model: 'clef' },
      enabled_candidates: [{ provider: 'cloudflare-workers-jev', model: 'clef' }],
    }
    const local = applyDecisionRow(remote, 'decision.selection.mode', 'local')
    assert.equal(local.selection.mode, 'local')
    assert.deepEqual(local.enabled_candidates, [], 'local clears candidates')
    const auto = applyDecisionRow(local, 'decision.selection.mode', 'auto')
    assert.equal(auto.selection.mode, 'auto')
    assert.equal(isValidDecisionConfig(auto), true)
  })

  it('selection.target stages the explicit provider/model pair + candidate', () => {
    const next = applyDecisionRow(
      structuredClone(DEFAULT_DECISION_CONFIG),
      'decision.selection.target',
      'typesafe-jev/jev-1.14.0',
    )
    assert.deepEqual(next.selection, {
      mode: 'explicit',
      provider: 'typesafe-jev',
      model: 'jev-1.14.0',
    })
    assert.deepEqual(next.enabled_candidates, [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }])
    assert.equal(isValidDecisionConfig(next), true)
  })

  it('target refuses unknown providers and wrong model pairs (fail-closed)', () => {
    const base = structuredClone(DEFAULT_DECISION_CONFIG)
    assert.equal(
      applyDecisionRow(base, 'decision.selection.target', 'bogus/jev-9'),
      base,
      'unknown provider',
    )
    assert.equal(
      applyDecisionRow(base, 'decision.selection.target', 'typesafe-jev/WRONG'),
      base,
      'wrong model',
    )
  })

  it('consent stages granted/not-granted without touching anything else', () => {
    const next = applyDecisionRow(
      structuredClone(DEFAULT_DECISION_CONFIG),
      'decision.consent',
      'granted',
    )
    assert.equal(next.egress_consent, true)
    assert.equal(next.enabled, false, 'consent alone never enables the router')
    const off = applyDecisionRow(next, 'decision.consent', 'not granted')
    assert.equal(off.egress_consent, false)
  })

  it('unknown rows are no-ops', () => {
    const base = structuredClone(DEFAULT_DECISION_CONFIG)
    assert.equal(applyDecisionRow(base, 'decision.bogus', 'x'), base)
  })
})

describe('credential status surface', () => {
  it('drift pins the env var names against the installer/runtime sources', () => {
    const installer = readFileSync(
      new URL('../scripts/decision-router.mjs', import.meta.url),
      'utf8',
    )
    assert.ok(installer.includes('TYPESAFE_API_KEY'), 'TYPESAFE_API_KEY drifted')
    assert.equal(DECISION_PROVIDER_CREDENTIALS['typesafe-jev'].env, 'TYPESAFE_API_KEY')
    assert.ok(installer.includes('OPENROUTER_API_KEY'), 'OPENROUTER_API_KEY drifted')
    assert.equal(DECISION_PROVIDER_CREDENTIALS['openrouter-jev'].env, 'OPENROUTER_API_KEY')
    assert.ok(installer.includes('AI_GATEWAY_API_KEY'), 'AI_GATEWAY_API_KEY drifted')
    assert.equal(DECISION_PROVIDER_CREDENTIALS['vercel-gateway-jev'].env, 'AI_GATEWAY_API_KEY')
    assert.ok(installer.includes('CLOUDFLARE_API_TOKEN'), 'CLOUDFLARE_API_TOKEN drifted')
    assert.equal(
      DECISION_PROVIDER_CREDENTIALS['cloudflare-workers-jev'].env,
      'CLOUDFLARE_API_TOKEN',
    )
  })

  it('console-jev rides the login (no env) — never invents a key var', () => {
    assert.equal(DECISION_PROVIDER_CREDENTIALS['opencode-console-jev'].env, undefined)
    assert.match(DECISION_PROVIDER_CREDENTIALS['opencode-console-jev'].note, /OpenCode login/)
  })

  it('the tab renders SET/MISSING from the injected env, never values', () => {
    const tab = buildDecisionTab(
      { config: structuredClone(DEFAULT_DECISION_CONFIG), corrupt: false },
      {
        TYPESAFE_API_KEY: 'sk-secret-should-never-appear',
      },
    )
    const rows = tab.groups.flatMap((g) => g.rows)
    const typesafe = rows.find((row) => row.id === 'decision.key.typesafe-jev')
    assert.equal(typesafe.value, 'set')
    const missing = rows.find((row) => row.id === 'decision.key.openrouter-jev')
    assert.equal(missing.value, 'MISSING')
    const whole = JSON.stringify(tab)
    assert.doesNotMatch(whole, /sk-secret-should-never-appear/, 'key values NEVER enter the window')
  })
})
