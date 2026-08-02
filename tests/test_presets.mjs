/**
 * Model routing presets — test harness for:
 *  - src/pantheon/presets.mjs            (resolver, normalizer, validator)
 *  - scripts/install/model-picker.mjs    (interactive picker + persistence)
 *  - bin/pantheon-init.mjs set-tier      (CLI command)
 *  - scripts/validate-routing.mjs        (section F wrapper)
 *  - npm packaging                       (T21)
 *
 * Run: node tests/test_presets.mjs  (also wrapped by tests/test_presets_node.py)
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import * as presets from '../src/pantheon/presets.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const silent = { warn: () => {}, log: () => {}, error: () => {} }

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e) {
    results.push({ name, passed: false, error: e.message })
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e) {
    results.push({ name, passed: false, error: e.message })
  }
}

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'pantheon-presets-'))
}

/** Write a fixture routing.yml and return its path. */
function fixtureRouting(yamlBody) {
  const dir = makeTmp()
  const p = join(dir, 'routing.yml')
  writeFileSync(p, `version: 1.0\n${yamlBody}`)
  return p
}

/** Load repo routing.yml agent names (canonical, minus legacy aliases). */
function repoAgents() {
  const routing = yaml.load(readFileSync(join(ROOT, 'src', 'routing.yml'), 'utf8'))
  return Object.keys(routing.agents || {}).filter((a) => a !== 'zen' && a !== 'zeus_copilot')
}

function runCli(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [join(ROOT, 'bin', 'pantheon-init.mjs'), ...args], {
    cwd: cwd ?? ROOT,
    env: env ?? process.env,
    encoding: 'utf8',
  })
}

/** env for CLI tests: key present, model-preset env unset. */
function cliEnv() {
  const env = { ...process.env, PANTHEON_DEEPSEEK_API_KEY: 'dummy' }
  delete env.PANTHEON_MODEL_PRESET
  return env
}

function presetFile(dir) {
  return join(dir, '.pantheon', 'active-preset.json')
}
function presetBak(dir) {
  return join(dir, '.pantheon', 'active-preset.json.bak')
}

// ─── T1: resolveActivePreset default → null ────────────────────────────
test('T1: no env, no candidate file → null (default)', () => {
  const resolved = presets.resolveActivePreset({
    env: {},
    candidates: [join(makeTmp(), 'nope.json')],
    logger: silent,
  })
  assert.equal(resolved, null)
})

// ─── T2: env beats file ────────────────────────────────────────────────
test('T2: PANTHEON_MODEL_PRESET wins over existing file', () => {
  const file = join(makeTmp(), 'active-preset.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      preset: 'go-fast',
      source: 'cli',
      updated_at: '2026-07-26T00:00:00.000Z',
    }),
  )
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'go-premium' },
    candidates: [file],
    logger: silent,
  })
  assert.ok(resolved)
  assert.equal(resolved.name, 'go-premium')
  assert.equal(resolved.source, 'env')
})

// ─── T3: env 'none' beats file ─────────────────────────────────────────
test('T3: env "none" disables preset even when file exists', () => {
  const file = join(makeTmp(), 'active-preset.json')
  writeFileSync(file, JSON.stringify({ version: 1, preset: 'go-fast', source: 'cli' }))
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'none' },
    candidates: [file],
    logger: silent,
  })
  assert.equal(resolved, null)
})

// ─── T4: unknown env warn-and-noop (file NOT consulted) ────────────────
test('T4: unknown env name → warn + null, no fallthrough to file', () => {
  const file = join(makeTmp(), 'active-preset.json')
  writeFileSync(file, JSON.stringify({ version: 1, preset: 'go-fast', source: 'cli' }))
  let warned = 0
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'bogus' },
    candidates: [file],
    logger: {
      warn: () => {
        warned++
      },
      log: () => {},
      error: () => {},
    },
  })
  assert.equal(resolved, null)
  assert.equal(warned, 1)
})

// ─── T5: unknown file name → warn + null ───────────────────────────────
test('T5: unknown preset in file → warn + null', () => {
  const file = join(makeTmp(), 'active-preset.json')
  writeFileSync(file, JSON.stringify({ version: 1, preset: 'bogus', source: 'cli' }))
  let warned = 0
  const resolved = presets.resolveActivePreset({
    env: {},
    candidates: [file],
    logger: {
      warn: () => {
        warned++
      },
      log: () => {},
      error: () => {},
    },
  })
  assert.equal(resolved, null)
  assert.equal(warned, 1)
})

// ─── T6: malformed file JSON → warn + null ─────────────────────────────
test('T6: malformed file JSON → warn + null', () => {
  const file = join(makeTmp(), 'active-preset.json')
  writeFileSync(file, '{ definitely not json !!!')
  let warned = 0
  const resolved = presets.resolveActivePreset({
    env: {},
    candidates: [file],
    logger: {
      warn: () => {
        warned++
      },
      log: () => {},
      error: () => {},
    },
  })
  assert.equal(resolved, null)
  assert.equal(warned, 1)
})

// ─── T7: partial semantics ─────────────────────────────────────────────
test('T7: only listed agents mutated; others untouched/absent', () => {
  const routing = fixtureRouting(`presets:
  partial:
    providers:
      deepseek: { baseURL: https://api.deepseek.com/v1, apiKeyEnv: PANTHEON_DEEPSEEK_API_KEY }
    agents:
      hermes: { model: deepseek/deepseek-v4-flash, reasoning_effort: medium }
`)
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'partial' },
    candidates: [],
    routingPath: routing,
    logger: silent,
  })
  const config = { agent: { apollo: { model: 'x/y', variant: 'high' } } }
  presets.applyPreset(config, resolved, { env: { PANTHEON_DEEPSEEK_API_KEY: 'k' } })
  // pre-existing agent untouched (not listed in preset)
  assert.deepEqual(config.agent.apollo, { model: 'x/y', variant: 'high' })
  // listed agent created from preset
  assert.equal(config.agent.hermes.model, 'deepseek/deepseek-v4-flash')
  assert.equal(config.agent.hermes.variant, 'medium')
  // unlisted agent never created
  assert.equal(config.agent.athena, undefined)
})

// ─── T8: provider injection + missing key throws ───────────────────────
test('T8: provider options injected; missing key throws PANTHEON_MISSING_API_KEY', () => {
  const routing = fixtureRouting(`presets:
  prov:
    providers:
      deepseek: { baseURL: https://api.deepseek.com/v1, apiKeyEnv: PANTHEON_DEEPSEEK_API_KEY }
    agents: {}
`)
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'prov' },
    candidates: [],
    routingPath: routing,
    logger: silent,
  })
  const config = {}
  presets.applyPreset(config, resolved, { env: { PANTHEON_DEEPSEEK_API_KEY: 'secret' } })
  assert.deepEqual(config.provider.deepseek.options, {
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'secret',
  })

  let thrown = null
  try {
    presets.applyPreset({}, resolved, { env: {} })
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown, 'should throw on missing key')
  assert.equal(thrown.code, 'PANTHEON_MISSING_API_KEY')
  assert.equal(thrown.envVar, 'PANTHEON_DEEPSEEK_API_KEY')
})

// ─── T9: claude variant strip ──────────────────────────────────────────
test('T9: claude models strip variant (variant key deleted)', () => {
  const routing = fixtureRouting(`presets:
  claude-p:
    agents:
      writer: { model: anthropic/claude-sonnet-4-5, reasoning_effort: high }
`)
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'claude-p' },
    candidates: [],
    routingPath: routing,
    logger: silent,
  })
  const config = { agent: { writer: { model: 'old/model', variant: 'high' } } }
  presets.applyPreset(config, resolved, { env: {} })
  assert.equal(config.agent.writer.model, 'anthropic/claude-sonnet-4-5')
  assert.ok(!('variant' in config.agent.writer), 'variant key must be deleted for claude')
  assert.ok(!('fallback_models' in config.agent.writer), 'no fallback_models set when absent')
})

// ─── T10: normalizeCapability matrix ───────────────────────────────────
test('T10: normalizeCapability matrix', () => {
  // flash clamps HIGH → MEDIUM (not low)
  assert.deepEqual(presets.normalizeCapability('deepseek/deepseek-v4-flash', 'high'), {
    variant: 'medium',
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('deepseek/deepseek-v4-flash', 'medium'), {
    variant: 'medium',
    clamped: false,
  })
  // pro accepts high
  assert.deepEqual(presets.normalizeCapability('deepseek/deepseek-v4-pro', 'high'), {
    variant: 'high',
    clamped: false,
  })
  // undefined requested → entry maxEffort
  assert.deepEqual(presets.normalizeCapability('deepseek/deepseek-v4-pro', undefined), {
    variant: 'high',
    clamped: false,
  })
  // claude strips effort
  assert.deepEqual(presets.normalizeCapability('anthropic/claude-sonnet-4-5', 'high'), {
    variant: null,
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('anthropic/claude-sonnet-4-5', undefined), {
    variant: null,
    clamped: false,
  })
  // o-series accept high
  assert.deepEqual(presets.normalizeCapability('openai/o3', 'high'), {
    variant: 'high',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('openai/o4-mini', 'medium'), {
    variant: 'medium',
    clamped: false,
  })
  // mimo clamps
  assert.deepEqual(presets.normalizeCapability('mimo/v2.5', 'medium'), {
    variant: 'low',
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('mimo/v2.5', undefined), {
    variant: 'low',
    clamped: false,
  })
  // -free suffix matches flash capability
  assert.deepEqual(presets.normalizeCapability('deepseek/deepseek-v4-flash-free', 'low'), {
    variant: 'low',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('deepseek/deepseek-v4-flash-free', 'high'), {
    variant: 'medium',
    clamped: true,
  })
  // gpt-5.6 family: longest-prefix wins (luna-fast → low, not generic medium)
  assert.deepEqual(presets.normalizeCapability('openai/gpt-5.6-sol', 'high'), {
    variant: 'high',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('openai/gpt-5.6-luna-fast', 'high'), {
    variant: 'low',
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('openai/gpt-5.6-terra', 'high'), {
    variant: 'medium',
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('openai/gpt-5.6-luna', 'medium'), {
    variant: 'low',
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('openai/gpt-5.6', 'high'), {
    variant: 'medium',
    clamped: true,
  })
  // claude strip applies to the new 2026 models too (no per-model entries)
  assert.deepEqual(presets.normalizeCapability('anthropic/claude-opus-4-8', 'high'), {
    variant: null,
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('anthropic/claude-sonnet-5', undefined), {
    variant: null,
    clamped: false,
  })
  // opencode-go (OpenCode Go subscription): bare segment prefix matches
  // opencode-go/deepseek-v4-flash via segment; provider-scoped deepseek/
  // entry still wins by length for deepseek/ models
  assert.deepEqual(presets.normalizeCapability('opencode-go/deepseek-v4-flash', 'medium'), {
    variant: 'medium',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('deepseek/deepseek-v4-flash', 'high'), {
    variant: 'medium',
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('opencode-go/deepseek-v4-pro', 'high'), {
    variant: 'high',
    clamped: false,
  })
  // opencode-go model families
  assert.deepEqual(presets.normalizeCapability('opencode-go/kimi-k2.6', 'high'), {
    variant: 'high',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('opencode-go/qwen3.7-plus', 'high'), {
    variant: 'medium',
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('opencode-go/qwen3.7-max', 'high'), {
    variant: 'high',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('opencode-go/minimax-m2.7', 'medium'), {
    variant: 'medium',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('opencode-go/glm-5.1', 'medium'), {
    variant: 'medium',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('opencode-go/glm-5.2', 'medium'), {
    variant: 'medium',
    clamped: false,
  })
  // opencode (Zen free tier): big-pickle clamps high→medium; nemotron
  // accepts high; north-mini-code-free accepts low
  assert.deepEqual(presets.normalizeCapability('opencode/big-pickle', 'high'), {
    variant: 'medium',
    clamped: true,
  })
  assert.deepEqual(presets.normalizeCapability('opencode/nemotron-3-ultra-free', 'high'), {
    variant: 'high',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('opencode/north-mini-code-free', 'low'), {
    variant: 'low',
    clamped: false,
  })
  assert.deepEqual(presets.normalizeCapability('opencode/deepseek-v4-flash-free', 'medium'), {
    variant: 'medium',
    clamped: false,
  })
  // unknown model throws
  assert.throws(() => presets.normalizeCapability('unknown/model-x', 'low'), /no capability entry/)
})

// ─── T11: overrides merge ──────────────────────────────────────────────
test('T11: file overrides win per-agent and per-provider', () => {
  const file = join(makeTmp(), 'active-preset.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      preset: 'go-deepseek',
      source: 'cli',
      updated_at: '2026-07-26T00:00:00.000Z',
      overrides: {
        agents: { hermes: { model: 'deepseek/deepseek-v4-pro', variant: 'high' } },
        providers: {
          deepseek: {
            baseURL: 'https://alt.deepseek.com/v1',
            apiKeyEnv: 'PANTHEON_DEEPSEEK_API_KEY',
          },
        },
      },
    }),
  )
  const resolved = presets.resolveActivePreset({ env: {}, candidates: [file], logger: silent })
  assert.ok(resolved)
  assert.equal(resolved.name, 'go-deepseek')
  assert.equal(resolved.source, 'file')
  assert.ok(resolved.overrides, 'overrides should be present')
  // per-agent override wins; variant becomes reasoning_effort
  assert.equal(resolved.agents.hermes.model, 'deepseek/deepseek-v4-pro')
  assert.equal(resolved.agents.hermes.reasoning_effort, 'high')
  // non-overridden agent keeps preset value
  assert.equal(resolved.agents.athena.model, 'deepseek/deepseek-v4-pro')
  // provider override wins
  assert.equal(resolved.providers.deepseek.baseURL, 'https://alt.deepseek.com/v1')
})

// ─── T12: validator passes repo presets ────────────────────────────────
test('T12: validatePresetDefs passes on repo routing.yml presets', () => {
  const defs = presets.loadPresetDefs()
  const result = presets.validatePresetDefs(defs, { agents: repoAgents() })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.equal(Object.keys(defs).length, 8)
  // go-claude / go-openai validate clean (claude strip rule, gpt entries exist)
  for (const name of ['go-claude', 'go-openai']) {
    const r = presets.validatePresetDefs({ [name]: defs[name] }, { agents: repoAgents() })
    assert.equal(r.ok, true, `preset "${name}" should validate clean: ${JSON.stringify(r.errors)}`)
    assert.deepEqual(r.errors, [])
  }
  // go-olympus / go-muses validate clean (all models have capability entries,
  // providers valid)
  for (const name of ['go-olympus', 'go-muses']) {
    const r = presets.validatePresetDefs({ [name]: defs[name] }, { agents: repoAgents() })
    assert.equal(r.ok, true, `preset "${name}" should validate clean: ${JSON.stringify(r.errors)}`)
    assert.deepEqual(r.errors, [])
  }
})

// ─── T13: validator fail fixtures ──────────────────────────────────────
test('T13: validatePresetDefs rejects bad fixtures', () => {
  // reserved name 'none'
  let r = presets.validatePresetDefs({ none: { agents: {} } })
  assert.equal(r.ok, false)
  assert.ok(
    r.errors.some((e) => e.includes('none')),
    JSON.stringify(r.errors),
  )

  // unknown agent
  r = presets.validatePresetDefs(
    { p: { agents: { herms: { model: 'deepseek/deepseek-v4-pro', reasoning_effort: 'high' } } } },
    { agents: ['hermes'] },
  )
  assert.equal(r.ok, false)
  assert.ok(
    r.errors.some((e) => e.includes('unknown agent')),
    JSON.stringify(r.errors),
  )

  // invalid reasoning_effort
  r = presets.validatePresetDefs({
    p: { agents: { hermes: { model: 'deepseek/deepseek-v4-pro', reasoning_effort: 'extreme' } } },
  })
  assert.equal(r.ok, false)
  assert.ok(
    r.errors.some((e) => e.includes('reasoning_effort')),
    JSON.stringify(r.errors),
  )

  // model with no capability entry
  r = presets.validatePresetDefs({
    p: { agents: { hermes: { model: 'unknown/model-x', reasoning_effort: 'low' } } },
  })
  assert.equal(r.ok, false)
  assert.ok(
    r.errors.some((e) => e.includes('no capability entry')),
    JSON.stringify(r.errors),
  )

  // missing model
  r = presets.validatePresetDefs({ p: { agents: { hermes: { reasoning_effort: 'low' } } } })
  assert.equal(r.ok, false)
  assert.ok(
    r.errors.some((e) => e.includes('model')),
    JSON.stringify(r.errors),
  )

  // fallback_models not strings
  r = presets.validatePresetDefs({
    p: {
      agents: {
        hermes: {
          model: 'deepseek/deepseek-v4-pro',
          reasoning_effort: 'low',
          fallback_models: [42],
        },
      },
    },
  })
  assert.equal(r.ok, false)
  assert.ok(
    r.errors.some((e) => e.includes('fallback_models')),
    JSON.stringify(r.errors),
  )

  // baseURL not http(s)
  r = presets.validatePresetDefs({
    p: { providers: { deepseek: { baseURL: 'ftp://x', apiKeyEnv: 'PANTHEON_K' } } },
  })
  assert.equal(r.ok, false)
  assert.ok(
    r.errors.some((e) => e.includes('baseURL')),
    JSON.stringify(r.errors),
  )

  // provider missing baseURL / apiKeyEnv
  r = presets.validatePresetDefs({ p: { providers: { deepseek: { baseURL: 'https://x.com' } } } })
  assert.equal(r.ok, false)
  assert.ok(
    r.errors.some((e) => e.includes('apiKeyEnv')),
    JSON.stringify(r.errors),
  )

  // warnings: apiKeyEnv prefix + description year
  r = presets.validatePresetDefs({
    p: {
      description: 'no year here',
      providers: { d: { baseURL: 'https://x.com', apiKeyEnv: 'MY_KEY' } },
      agents: {},
    },
  })
  assert.equal(r.ok, true)
  assert.ok(
    r.warnings.some((w) => w.includes('PANTHEON_')),
    JSON.stringify(r.warnings),
  )
  assert.ok(
    r.warnings.some((w) => w.includes('year')),
    JSON.stringify(r.warnings),
  )
})

// ─── T14: set-tier writes file + backup ────────────────────────────────
test('T14: set-tier writes active-preset.json + .bak on second run', () => {
  const dir = makeTmp()
  let r = runCli(['set-tier', 'go-fast', '--project'], { cwd: dir, env: cliEnv() })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const file = presetFile(dir)
  assert.ok(existsSync(file), 'active-preset.json should exist')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(data.version, 1)
  assert.equal(data.preset, 'go-fast')
  assert.equal(data.source, 'cli')
  assert.ok(!Number.isNaN(Date.parse(data.updated_at)), 'updated_at must be ISO')

  const firstContent = readFileSync(file, 'utf8')
  r = runCli(['set-tier', 'go-free', '--project'], { cwd: dir, env: cliEnv() })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const bak = presetBak(dir)
  assert.ok(existsSync(bak), 'backup should exist')
  assert.equal(readFileSync(bak, 'utf8'), firstContent, 'backup must equal previous file')
  const data2 = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(data2.preset, 'go-free')
})

// ─── T15: unknown name → exit 1, lists presets ─────────────────────────
test('T15: set-tier unknown name exits 1 and lists go-deepseek', () => {
  const r = runCli(['set-tier', 'bogus', '--project'], { cwd: makeTmp(), env: cliEnv() })
  assert.equal(r.status, 1)
  assert.ok((r.stdout + r.stderr).includes('go-deepseek'), r.stdout + r.stderr)
})

// ─── T16: fail-fast missing key ────────────────────────────────────────
test('T16: set-tier fails fast when API key env missing, writes nothing', () => {
  const env = { ...process.env }
  delete env.PANTHEON_MODEL_PRESET
  delete env.PANTHEON_DEEPSEEK_API_KEY
  const dir = makeTmp()
  const r = runCli(['set-tier', 'go-fast', '--project'], { cwd: dir, env })
  assert.equal(r.status, 1)
  assert.ok((r.stdout + r.stderr).includes('Missing required API key configuration'), r.stdout + r.stderr)
  assert.ok(!existsSync(presetFile(dir)), 'no file should be written on fail-fast')
})

// ─── T17: set-tier none clears ─────────────────────────────────────────
test('T17: set-tier none clears file, keeps backup, prints cleared', () => {
  const dir = makeTmp()
  let r = runCli(['set-tier', 'go-fast', '--project'], { cwd: dir, env: cliEnv() })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const file = presetFile(dir)
  assert.ok(existsSync(file))
  const prev = readFileSync(file, 'utf8')

  r = runCli(['set-tier', 'none', '--project'], { cwd: dir, env: cliEnv() })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!existsSync(file), 'active-preset.json should be removed')
  assert.ok(existsSync(presetBak(dir)), 'backup should remain')
  assert.equal(readFileSync(presetBak(dir), 'utf8'), prev, 'backup equals previous preset')
  assert.ok((r.stdout + r.stderr).toLowerCase().includes('cleared'), r.stdout + r.stderr)
})

// ─── T18: picker dry-run writes nothing ────────────────────────────────
await testAsync('T18: picker dry-run does not write', async () => {
  const picker = await import('../scripts/install/model-picker.mjs')
  const dir = makeTmp()
  const defs = { 'go-fast': { description: 'fast' } }
  const mockRl = { question: async () => 'go-fast', close: () => {} }
  const chosen = await picker.runModelPicker({
    presetDir: dir,
    presets: defs,
    dryRun: true,
    logger: silent,
    rl: mockRl,
  })
  assert.equal(chosen, 'go-fast')
  assert.ok(!existsSync(presetFile(dir)), 'dry-run must not write file')
  const res = picker.writeActivePreset(dir, 'go-fast', { dryRun: true })
  assert.equal(res.written, false)
  assert.ok(!existsSync(presetFile(dir)), 'dry-run writeActivePreset must not write file')
})

// ─── T19: picker persists + autoYes skip guard ─────────────────────────
await testAsync('T19: picker persists; opencode.mjs gates on autoYes/opts.preset', async () => {
  const picker = await import('../scripts/install/model-picker.mjs')
  const dir = makeTmp()
  const defs = { 'go-fast': { description: 'fast' } }
  const mockRl = { question: async () => 'go-fast', close: () => {} }
  const chosen = await picker.runModelPicker({
    presetDir: dir,
    presets: defs,
    dryRun: false,
    logger: silent,
    rl: mockRl,
  })
  assert.equal(chosen, 'go-fast')
  const file = presetFile(dir)
  assert.ok(existsSync(file), 'picker must persist choice')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).preset, 'go-fast')

  // opencode.mjs must (a) export isGlobalConfigDir, (b) skip picker on autoYes / opts.preset
  const src = readFileSync(join(ROOT, 'scripts', 'install', 'opencode.mjs'), 'utf8')
  assert.ok(src.includes('export function isGlobalConfigDir'), 'isGlobalConfigDir must be exported')
  assert.ok(src.includes('!autoYes'), 'picker must be gated by !autoYes')
  assert.ok(src.includes('!opts.preset'), 'picker must be gated by !opts.preset')
  assert.ok(src.includes('runModelPicker'), 'opencode.mjs must import/use runModelPicker')
})

// ─── T20: validate-routing passes with 8 presets ───────────────────────
test('T20: validate-routing exits 0 and reports 8 presets', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'validate-routing.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(r.stdout.includes('Presets defined: 8'), r.stdout)
})

// ─── T21: packaging smoke ──────────────────────────────────────────────
test('T21: npm pack includes presets.mjs + model-picker.mjs', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024, // pack JSON listing is ~1MB+; avoid default 1MB kill
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  let out
  try {
    out = JSON.parse(r.stdout)
  } catch {
    assert.fail(`npm pack output not JSON: ${r.stdout.slice(0, 500)}`)
  }
  const files = (out[0]?.files ?? []).map((f) => f.path)
  assert.ok(
    files.includes('src/pantheon/presets.mjs'),
    `presets.mjs missing from pack: ${files.join(',')}`,
  )
  assert.ok(
    files.includes('scripts/install/model-picker.mjs'),
    `model-picker.mjs missing from pack: ${files.join(',')}`,
  )
})

// ─── T22: applyPreset go-openai (repo presets) ─────────────────────────
test('T22: applyPreset go-openai injects OpenAI provider + gpt-5.6 agents', () => {
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'go-openai' },
    candidates: [],
    logger: silent,
  })
  assert.ok(resolved, 'go-openai should resolve from repo presets')
  assert.equal(resolved.name, 'go-openai')
  assert.equal(resolved.source, 'env')

  const config = {}
  presets.applyPreset(config, resolved, { env: { PANTHEON_OPENAI_API_KEY: 'sk-openai' } })
  assert.deepEqual(config.provider.openai.options, {
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-openai',
  })
  // tiering: sol → high, terra → medium, luna-fast → low
  assert.equal(config.agent.athena.model, 'openai/gpt-5.6-sol')
  assert.equal(config.agent.athena.variant, 'high')
  assert.equal(config.agent.hermes.model, 'openai/gpt-5.6-terra')
  assert.equal(config.agent.hermes.variant, 'medium')
  assert.equal(config.agent.apollo.model, 'openai/gpt-5.6-luna-fast')
  assert.equal(config.agent.apollo.variant, 'low')
  assert.equal(config.agent.talos.model, 'openai/gpt-5.6-luna-fast')
  assert.equal(config.agent.talos.variant, 'low')

  let thrown = null
  try {
    presets.applyPreset({}, resolved, { env: {} })
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown, 'should throw on missing OpenAI key')
  assert.equal(thrown.code, 'PANTHEON_MISSING_API_KEY')
  assert.equal(thrown.envVar, 'PANTHEON_OPENAI_API_KEY')
})

// ─── T23: applyPreset go-claude (repo presets) ─────────────────────────
test('T23: applyPreset go-claude strips variant for claude models', () => {
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'go-claude' },
    candidates: [],
    logger: silent,
  })
  assert.ok(resolved, 'go-claude should resolve from repo presets')
  assert.equal(resolved.name, 'go-claude')

  const config = {}
  presets.applyPreset(config, resolved, { env: { PANTHEON_ANTHROPIC_API_KEY: 'sk-ant' } })
  assert.deepEqual(config.provider.anthropic.options, {
    baseURL: 'https://api.anthropic.com',
    apiKey: 'sk-ant',
  })
  assert.equal(config.agent.athena.model, 'anthropic/claude-opus-4-8')
  assert.ok(!('variant' in config.agent.athena), 'claude variant key must be stripped')
  assert.equal(config.agent.hermes.model, 'anthropic/claude-sonnet-5')
  assert.ok(!('variant' in config.agent.hermes), 'claude variant key must be stripped')
  assert.equal(config.agent.apollo.model, 'anthropic/claude-haiku-4-5')
  assert.ok(!('variant' in config.agent.apollo), 'claude variant key must be stripped')
})

// ─── T24: applyPreset go-olympus (repo presets) ────────────────────────
test('T24: applyPreset go-olympus injects opencode-go provider + tiered agents', () => {
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'go-olympus' },
    candidates: [],
    logger: silent,
  })
  assert.ok(resolved, 'go-olympus should resolve from repo presets')
  assert.equal(resolved.name, 'go-olympus')
  assert.equal(resolved.source, 'env')

  const config = {}
  presets.applyPreset(config, resolved, { env: { PANTHEON_OPENCODE_API_KEY: 'sk-gogo' } })
  assert.deepEqual(config.provider['opencode-go'].options, {
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKey: 'sk-gogo',
  })
  // tiering: GLM-5.1 zeus, V4 Pro athena (high), Qwen3.7 Max themis,
  // MiniMax M2.7 hermes, Kimi K2.6 aphrodite, V4 Flash apollo (low)
  assert.equal(config.agent.zeus.model, 'opencode-go/glm-5.1')
  assert.equal(config.agent.zeus.variant, 'medium')
  assert.equal(config.agent.athena.model, 'opencode-go/deepseek-v4-pro')
  assert.equal(config.agent.athena.variant, 'high')
  assert.equal(config.agent.themis.model, 'opencode-go/qwen3.7-max')
  assert.equal(config.agent.themis.variant, 'high')
  assert.equal(config.agent.hermes.model, 'opencode-go/minimax-m2.7')
  assert.equal(config.agent.hermes.variant, 'medium')
  assert.equal(config.agent.aphrodite.model, 'opencode-go/kimi-k2.6')
  assert.equal(config.agent.aphrodite.variant, 'medium')
  assert.equal(config.agent.apollo.model, 'opencode-go/deepseek-v4-flash')
  assert.equal(config.agent.apollo.variant, 'low')
  assert.equal(config.agent.talos.model, 'opencode-go/deepseek-v4-flash')
  assert.equal(config.agent.talos.variant, 'low')

  let thrown = null
  try {
    presets.applyPreset({}, resolved, { env: {} })
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown, 'should throw on missing OpenCode Go key')
  assert.equal(thrown.code, 'PANTHEON_MISSING_API_KEY')
  assert.equal(thrown.envVar, 'PANTHEON_OPENCODE_API_KEY')
})

// ─── T25: applyPreset go-muses (repo presets) ──────────────────────────
test('T25: applyPreset go-muses injects opencode provider + free models', () => {
  const resolved = presets.resolveActivePreset({
    env: { PANTHEON_MODEL_PRESET: 'go-muses' },
    candidates: [],
    logger: silent,
  })
  assert.ok(resolved, 'go-muses should resolve from repo presets')
  assert.equal(resolved.name, 'go-muses')

  const config = {}
  presets.applyPreset(config, resolved, { env: { PANTHEON_OPENCODE_API_KEY: 'sk-zen' } })
  assert.deepEqual(config.provider.opencode.options, {
    baseURL: 'https://opencode.ai/zen/v1',
    apiKey: 'sk-zen',
  })
  // Big Pickle zeus (medium), Nemotron 3 Ultra Free athena (high),
  // North Mini Code apollo (low), flash-free implementers
  assert.equal(config.agent.zeus.model, 'opencode/big-pickle')
  assert.equal(config.agent.zeus.variant, 'medium')
  assert.equal(config.agent.athena.model, 'opencode/nemotron-3-ultra-free')
  assert.equal(config.agent.athena.variant, 'high')
  assert.equal(config.agent.apollo.model, 'opencode/north-mini-code-free')
  assert.equal(config.agent.apollo.variant, 'low')
  assert.equal(config.agent.hermes.model, 'opencode/deepseek-v4-flash-free')
  assert.equal(config.agent.hermes.variant, 'medium')

  let thrown = null
  try {
    presets.applyPreset({}, resolved, { env: {} })
  } catch (e) {
    thrown = e
  }
  assert.ok(thrown, 'should throw on missing OpenCode Zen key')
  assert.equal(thrown.code, 'PANTHEON_MISSING_API_KEY')
  assert.equal(thrown.envVar, 'PANTHEON_OPENCODE_API_KEY')
})

// ─── Summary ───────────────────────────────────────────────────────────
const passed = results.filter((r) => r.passed).length
const failed = results.filter((r) => !r.passed)

console.log('')
for (const r of results) {
  console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}${r.error ? ': [redacted]' : ''}`)
}
console.log(`\n📊 Results: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length > 0 ? 1 : 0)
