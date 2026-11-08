/**
 * vision-status.test.mjs — focused contract tests for the offline vision
 * status resolver behind `/pantheon-vision` (scripts/vision-status.mjs).
 *
 * Run: node --test tests/vision-status.test.mjs
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  catalogImageCandidates,
  DEFAULT_VISION_MODEL,
  formatStatus,
  formatVisionList,
  globalVisionConfigPath,
  listVisionCandidates,
  main,
  offlineVisionFor,
  parseDirArg,
  parseModelsOutput,
  resolveVisionStatus,
  setVisionModel,
  visionCredentialSource,
} from '../scripts/vision-status.mjs'

const require = createRequire(import.meta.url)
let sqliteAvailable = true
try {
  require('node:sqlite')
} catch {
  sqliteAvailable = false
}

/** Capture everything `fn` writes to stdout; returns { code, out }. */
function captureStdout(fn) {
  const original = process.stdout.write
  let out = ''
  process.stdout.write = (chunk) => {
    out += chunk
    return true
  }
  try {
    return { code: fn(), out }
  } finally {
    process.stdout.write = original
  }
}

/** A minimal `GET /config/providers` payload. */
function sampleCatalog() {
  return {
    providers: [
      {
        id: 'opencode-go',
        models: {
          'mimo-v2.5': {
            id: 'mimo-v2.5',
            capabilities: { input: { image: true } },
            cost: { input: 0 },
            status: 'active',
          },
          'minimax-m3': {
            id: 'minimax-m3',
            capabilities: { input: { image: true } },
            cost: { input: 1.5 },
            status: 'active',
          },
          'glm-5.3': { id: 'glm-5.3', capabilities: { input: { image: false } } },
          old: { id: 'old', capabilities: { input: { image: true } }, status: 'deprecated' },
        },
      },
      {
        id: 'openrouter',
        models: {
          'google/gemini-2.5-flash': {
            id: 'google/gemini-2.5-flash',
            capabilities: { input: { image: true } },
            cost: { input: 0.1 },
          },
        },
      },
    ],
  }
}

/** Isolated HOME/XDG_CONFIG_HOME + project dir; env has no vision vars. */
function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-vision-status-'))
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  }
  return {
    home,
    project,
    env,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

function writeVisionConfig(configPath, data) {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`)
}

test('env model wins with origin "env"', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const status = resolveVisionStatus({
      dir: project,
      env: { ...env, PANTHEON_VISION_MODEL: 'opencode-go/minimax-m3' },
    })
    assert.equal(status.model, 'opencode-go/minimax-m3')
    assert.equal(status.origin, 'env')
    assert.equal(status.sourcePath, null)
  } finally {
    cleanup()
  }
})

test('project config model resolves with origin "config"', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    writeVisionConfig(join(project, '.opencode', 'opencode-vision.json'), {
      visionModel: 'opencode-go/mimo-v2.5',
    })
    const status = resolveVisionStatus({ dir: project, env })
    assert.equal(status.model, 'opencode-go/mimo-v2.5')
    assert.equal(status.origin, 'config')
    assert.equal(status.sourcePath, join(project, '.opencode', 'opencode-vision.json'))
  } finally {
    cleanup()
  }
})

test('global config model resolves when no project config exists', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    writeVisionConfig(globalVisionConfigPath(env), { visionModel: 'opencode/mimo-v2.6-flash-free' })
    const status = resolveVisionStatus({ dir: project, env })
    assert.equal(status.model, 'opencode/mimo-v2.6-flash-free')
    assert.equal(status.origin, 'config')
    assert.equal(status.sourcePath, globalVisionConfigPath(env))
  } finally {
    cleanup()
  }
})

test('project config beats global config', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    writeVisionConfig(globalVisionConfigPath(env), { visionModel: 'opencode/global' })
    writeVisionConfig(join(project, '.opencode', 'opencode-vision.json'), {
      visionModel: 'opencode/project',
    })
    const status = resolveVisionStatus({ dir: project, env })
    assert.equal(status.model, 'opencode/project')
    assert.equal(status.origin, 'config')
  } finally {
    cleanup()
  }
})

test('active preset vision.model resolves with origin "preset"', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    writeVisionConfig(join(project, '.pantheon', 'active-preset.json'), { preset: 'go-fast' })
    const status = resolveVisionStatus({ dir: project, env })
    assert.equal(status.origin, 'preset')
    assert.equal(status.model, 'opencode-go/mimo-v2.5')
  } finally {
    cleanup()
  }
})

test('no explicit model reports origin "auto" (discovery at session start), not an invented value', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const status = resolveVisionStatus({ dir: project, env })
    assert.equal(status.model, null)
    assert.equal(status.origin, 'auto')
    assert.equal(status.fallbackModel, DEFAULT_VISION_MODEL)
  } finally {
    cleanup()
  }
})

test('mode precedence: env > config > default auto', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const base = resolveVisionStatus({ dir: project, env })
    assert.equal(base.mode, 'auto')
    assert.equal(base.modeOrigin, 'default')

    writeVisionConfig(globalVisionConfigPath(env), { mode: 'tool' })
    const fromConfig = resolveVisionStatus({ dir: project, env })
    assert.equal(fromConfig.mode, 'tool')
    assert.equal(fromConfig.modeOrigin, 'config')

    const fromEnv = resolveVisionStatus({
      dir: project,
      env: { ...env, PANTHEON_VISION_MODE: 'native' },
    })
    assert.equal(fromEnv.mode, 'native')
    assert.equal(fromEnv.modeOrigin, 'env')
  } finally {
    cleanup()
  }
})

test('corrupted config JSON is ignored, not crashed on', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const configPath = join(project, '.opencode', 'opencode-vision.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{ broken')
    const status = resolveVisionStatus({ dir: project, env })
    assert.equal(status.model, null)
    assert.equal(status.origin, 'auto')
  } finally {
    cleanup()
  }
})

test('parseDirArg accepts both --dir <path> and --dir=<path>', () => {
  assert.equal(parseDirArg(['--dir', '/a/b']), '/a/b')
  assert.equal(parseDirArg(['--dir=/a/b']), '/a/b')
  assert.equal(parseDirArg(['--json', '--dir=/a/b']), '/a/b')
  assert.equal(parseDirArg(['--dir=/a/b', '--json']), '/a/b')
})

test('parseDirArg falls back to cwd when --dir is missing or empty', () => {
  assert.equal(parseDirArg(['--json']), process.cwd())
  assert.equal(parseDirArg(['--dir']), process.cwd())
  assert.equal(parseDirArg(['--dir=']), process.cwd())
})

test('main honors --dir=<path> with real effect (resolves from that project)', () => {
  const { project, env, cleanup } = makeEnv()
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  const prevModel = process.env.PANTHEON_VISION_MODEL
  const originalWrite = process.stdout.write
  let captured = ''
  process.stdout.write = (chunk) => {
    captured += chunk
    return true
  }
  process.env.HOME = env.HOME
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME
  delete process.env.PANTHEON_VISION_MODEL
  try {
    writeVisionConfig(join(project, '.opencode', 'opencode-vision.json'), {
      visionModel: 'opencode-go/mimo-v2.5',
    })
    // If `--dir=` were ignored, dir would fall back to cwd and the project
    // config would not be found → model null. Matching the project value
    // proves the equals form is actually used.
    const code = main([`--dir=${project}`, '--json'])
    assert.equal(code, 0)
    const status = JSON.parse(captured)
    assert.equal(status.model, 'opencode-go/mimo-v2.5')
    assert.equal(status.sourcePath, join(project, '.opencode', 'opencode-vision.json'))
  } finally {
    process.stdout.write = originalWrite
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    if (prevModel === undefined) delete process.env.PANTHEON_VISION_MODEL
    else process.env.PANTHEON_VISION_MODEL = prevModel
    cleanup()
  }
})

// ─── --list: candidate enumeration ────────────────────────────────────────

test('parseModelsOutput drops blank/whitespace lines and dedupes', () => {
  assert.deepEqual(parseModelsOutput(''), [])
  assert.deepEqual(parseModelsOutput('a/b\n\n  c/d  \nwith space/e\nno-slash\nc/d\n'), [
    'a/b',
    'c/d',
  ])
})

test('catalog candidates keep only image-capable, non-deprecated entries', () => {
  const candidates = catalogImageCandidates(sampleCatalog())
  assert.deepEqual(candidates.map((c) => c.model).sort(), [
    'opencode-go/mimo-v2.5',
    'opencode-go/minimax-m3',
    'openrouter/google/gemini-2.5-flash',
  ])
  assert.equal(
    candidates.every((c) => c.confidence === 'catalog'),
    true,
  )
})

test('offline heuristic consults CAPABILITY_TABLE then name families', () => {
  assert.deepEqual(offlineVisionFor('opencode-go/mimo-v2.5'), { vision: true, confidence: 'table' })
  assert.deepEqual(offlineVisionFor('opencode-go/mimo-v2.5-pro'), {
    vision: false,
    confidence: 'table',
  })
  assert.deepEqual(offlineVisionFor('opencode-go/glm-5.3-flash'), {
    vision: false,
    confidence: 'table',
  })
  assert.deepEqual(offlineVisionFor('google/gemini-3.5-flash'), {
    vision: true,
    confidence: 'name',
  })
  assert.deepEqual(offlineVisionFor('acme/vision-vl'), { vision: true, confidence: 'name' })
  assert.deepEqual(offlineVisionFor('acme/pure-text'), { vision: false, confidence: 'name' })
})

test('--list marks source "catalog" and free-first ordering with the resolved target', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    writeVisionConfig(join(project, '.opencode', 'opencode-vision.json'), {
      visionModel: 'opencode-go/minimax-m3',
    })
    const list = listVisionCandidates({ dir: project, env, catalog: sampleCatalog() })
    assert.equal(list.source, 'catalog')
    assert.equal(list.reason, null)
    assert.deepEqual(
      list.candidates.map((c) => c.model),
      ['opencode-go/mimo-v2.5', 'opencode-go/minimax-m3', 'openrouter/google/gemini-2.5-flash'],
    )
    assert.deepEqual(
      list.candidates.map((c) => c.access),
      ['free', 'paid', 'paid'],
    )
    assert.equal(list.candidates[0].target, false)
    assert.equal(list.candidates[1].target, true)

    const text = formatVisionList(list)
    assert.match(text, /Source: host catalog/)
    assert.match(text, /2\s+opencode-go\/minimax-m3\s+paid\s+.*<- current target/)
  } finally {
    cleanup()
  }
})

test('--list falls back to heuristic source and marks confidence per candidate', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const modelsText = [
      'opencode-go/mimo-v2.5',
      'opencode-go/mimo-v2.5-pro',
      'opencode-go/glm-5.3-flash',
      'google/gemini-3.5-flash',
      'acme/pure-text',
    ].join('\n')
    const list = listVisionCandidates({ dir: project, env, modelsText })
    assert.equal(list.source, 'heuristic')
    assert.deepEqual(
      list.candidates.map((c) => c.model),
      ['google/gemini-3.5-flash', 'opencode-go/mimo-v2.5'],
    )
    assert.equal(
      list.candidates.find((c) => c.model === 'opencode-go/mimo-v2.5').confidence,
      'table',
    )
    assert.equal(
      list.candidates.find((c) => c.model === 'google/gemini-3.5-flash').confidence,
      'name',
    )
    assert.match(formatVisionList(list), /Source: heuristic/)
  } finally {
    cleanup()
  }
})

test('--list with no source reports "none" with a reason (never invents models)', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const list = listVisionCandidates({ dir: project, env, modelsText: null })
    assert.equal(list.source, 'none')
    assert.equal(list.candidates.length, 0)
    assert.match(list.reason, /opencode models/)
    assert.match(formatVisionList(list), /No vision-capable models enumerated/)
  } finally {
    cleanup()
  }
})

// ─── --list: credential presence per provider ─────────────────────────────

test('credential presence follows env / legacy Zen / own-provider rules', () => {
  const base = { envKey: false, authStorePath: '/x', authStoreIds: [], authStoreProviderIds: [] }
  // env key satisfies any Zen endpoint
  assert.equal(visionCredentialSource('opencode-go', { ...base, envKey: true }), 'env')
  assert.equal(visionCredentialSource('opencode', { ...base, envKey: true }), 'env')
  // non-Zen ignores the shared env key
  assert.equal(visionCredentialSource('openrouter', { ...base, envKey: true }), null)
  // Zen accepts the legacy shared entries
  assert.equal(
    visionCredentialSource('opencode-go', { ...base, authStoreProviderIds: ['opencode'] }),
    'store',
  )
  // non-Zen accepts ONLY its own entry
  assert.equal(
    visionCredentialSource('openrouter', { ...base, authStoreProviderIds: ['openrouter'] }),
    'store',
  )
  assert.equal(
    visionCredentialSource('openrouter', { ...base, authStoreProviderIds: ['opencode-go'] }),
    null,
  )
})

test('--list reports credential presence from a V1 auth.json store', () => {
  const { home, project, env, cleanup } = makeEnv()
  try {
    const authPath = join(home, '.local', 'share', 'opencode', 'auth.json')
    mkdirSync(dirname(authPath), { recursive: true })
    writeFileSync(authPath, `${JSON.stringify({ 'opencode-go': { access: 'secret-token' } })}\n`)

    const list = listVisionCandidates({ dir: project, env, catalog: sampleCatalog() })
    const zen = list.candidates.find((c) => c.model === 'opencode-go/mimo-v2.5')
    assert.equal(zen.credential, true)
    assert.equal(zen.credentialSource, 'store')
    // openrouter has no own entry -> no credential even though a legacy Zen entry exists
    const nonZen = list.candidates.find((c) => c.model === 'openrouter/google/gemini-2.5-flash')
    assert.equal(nonZen.credential, false)
    assert.equal(nonZen.credentialSource, null)
  } finally {
    cleanup()
  }
})

test('--list reads credential presence from the V2 SQLite store', {
  skip: sqliteAvailable ? false : 'node:sqlite unavailable',
}, () => {
  const { home, project, env, cleanup } = makeEnv()
  try {
    const { DatabaseSync } = require('node:sqlite')
    const dataDir = join(home, '.local', 'share', 'opencode')
    mkdirSync(dataDir, { recursive: true })
    const db = new DatabaseSync(join(dataDir, 'opencode.db'))
    db.exec('CREATE TABLE credential (integration_id TEXT, active INTEGER, value TEXT)')
    db.prepare('INSERT INTO credential (integration_id, active, value) VALUES (?, ?, ?)').run(
      'opencode-go',
      1,
      '{"type":"key","key":"secret"}',
    )
    db.close()

    const list = listVisionCandidates({ dir: project, env, catalog: sampleCatalog() })
    const zen = list.candidates.find((c) => c.model === 'opencode-go/mimo-v2.5')
    assert.equal(zen.credential, true)
    assert.equal(zen.credentialSource, 'store')
  } finally {
    cleanup()
  }
})

test('--list honors OPENCODE_DB for a relocated V2 credential store', {
  skip: sqliteAvailable ? false : 'node:sqlite unavailable',
}, () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const { DatabaseSync } = require('node:sqlite')
    const relocated = join(project, 'sandbox', 'opencode.db')
    mkdirSync(dirname(relocated), { recursive: true })
    const db = new DatabaseSync(relocated)
    db.exec('CREATE TABLE credential (integration_id TEXT, active INTEGER, value TEXT)')
    db.prepare('INSERT INTO credential (integration_id, active, value) VALUES (?, ?, ?)').run(
      'opencode-go',
      1,
      '{"type":"key","key":"secret"}',
    )
    db.close()

    // Without OPENCODE_DB the default XDG db is absent → no credential found.
    const off = listVisionCandidates({ dir: project, env, catalog: sampleCatalog() })
    assert.equal(off.candidates.find((c) => c.model === 'opencode-go/mimo-v2.5').credential, false)

    // With OPENCODE_DB the relocated store is read → credential found.
    const on = listVisionCandidates({
      dir: project,
      env: { ...env, OPENCODE_DB: relocated },
      catalog: sampleCatalog(),
    })
    const onZen = on.candidates.find((c) => c.model === 'opencode-go/mimo-v2.5')
    assert.equal(onZen.credential, true)
    assert.equal(onZen.credentialSource, 'store')
  } finally {
    cleanup()
  }
})

// ─── XDG_DATA_HOME parity with the plugin / native / MCP consumers ────────

test('V1 auth.json resolution honors XDG_DATA_HOME (relocated data root)', () => {
  const { home, project, env, cleanup } = makeEnv()
  try {
    const dataHome = join(home, 'xdg-data')
    const authPath = join(dataHome, 'opencode', 'auth.json')
    mkdirSync(dirname(authPath), { recursive: true })
    writeFileSync(authPath, `${JSON.stringify({ openrouter: { apiKey: 'sk-fixture' } })}\n`)

    // Relocated data root → the same store the plugin/native/MCP resolve.
    const relocated = resolveVisionStatus({
      dir: project,
      env: { ...env, XDG_DATA_HOME: dataHome },
    })
    assert.equal(relocated.auth.authStorePath, authPath)
    assert.deepEqual(relocated.auth.authStoreProviderIds, ['openrouter'])
    assert.equal(visionCredentialSource('openrouter', relocated.auth), 'store')
    const text = formatStatus(relocated)
    assert.match(text, /Auth:.*credential store openrouter/)
    assert.equal(text.includes('sk-fixture'), false, 'status never echoes the token')

    // No XDG_DATA_HOME → default ~/.local/share/opencode (empty here) → none.
    const fallback = resolveVisionStatus({ dir: project, env })
    assert.equal(
      fallback.auth.authStorePath,
      join(home, '.local', 'share', 'opencode', 'auth.json'),
    )
    assert.match(formatStatus(fallback), /Auth:.*credential store none/)
  } finally {
    cleanup()
  }
})

test('V2 credential db resolution honors XDG_DATA_HOME (relocated data root)', {
  skip: sqliteAvailable ? false : 'node:sqlite unavailable',
}, () => {
  const { home, project, env, cleanup } = makeEnv()
  try {
    const { DatabaseSync } = require('node:sqlite')
    const dataHome = join(home, 'xdg-data')
    const dataDir = join(dataHome, 'opencode')
    mkdirSync(dataDir, { recursive: true })
    const db = new DatabaseSync(join(dataDir, 'opencode.db'))
    db.exec('CREATE TABLE credential (integration_id TEXT, active INTEGER, value TEXT)')
    db.prepare('INSERT INTO credential (integration_id, active, value) VALUES (?, ?, ?)').run(
      'opencode-go',
      1,
      '{"type":"key","key":"sk-fixture"}',
    )
    db.close()

    // Relocated data root → the db sibling of auth.json is found.
    const relocated = formatStatus(
      resolveVisionStatus({ dir: project, env: { ...env, XDG_DATA_HOME: dataHome } }),
    )
    assert.match(relocated, /Auth:.*credential store opencode-go/)
    assert.equal(relocated.includes('sk-fixture'), false, 'status never echoes the token')

    // No XDG_DATA_HOME → default db absent here → none (the override is honored).
    const fallback = formatStatus(resolveVisionStatus({ dir: project, env }))
    assert.match(fallback, /Auth:.*credential store none/)
  } finally {
    cleanup()
  }
})

// ─── status: extended credential detection (V1 auth.json + V2 db) ─────────

test('formatStatus reports a non-legacy V1 auth.json provider (not "none")', () => {
  const { home, project, env, cleanup } = makeEnv()
  try {
    const authPath = join(home, '.local', 'share', 'opencode', 'auth.json')
    mkdirSync(dirname(authPath), { recursive: true })
    writeFileSync(authPath, `${JSON.stringify({ openrouter: { apiKey: 'sk-fixture' } })}\n`)

    const text = formatStatus(resolveVisionStatus({ dir: project, env }))
    assert.match(text, /Auth:.*credential store openrouter/)
    assert.equal(text.includes('sk-fixture'), false, 'status never echoes the token')
  } finally {
    cleanup()
  }
})

test('formatStatus reports a V2 credential-db provider (not "none")', {
  skip: sqliteAvailable ? false : 'node:sqlite unavailable',
}, () => {
  const { home, project, env, cleanup } = makeEnv()
  try {
    const { DatabaseSync } = require('node:sqlite')
    const dataDir = join(home, '.local', 'share', 'opencode')
    mkdirSync(dataDir, { recursive: true })
    const db = new DatabaseSync(join(dataDir, 'opencode.db'))
    db.exec('CREATE TABLE credential (integration_id TEXT, active INTEGER, value TEXT)')
    db.prepare('INSERT INTO credential (integration_id, active, value) VALUES (?, ?, ?)').run(
      'opencode-go',
      1,
      '{"type":"key","key":"sk-fixture"}',
    )
    db.close()

    const text = formatStatus(resolveVisionStatus({ dir: project, env }))
    assert.match(text, /Auth:.*credential store opencode-go/)
    assert.equal(text.includes('sk-fixture'), false, 'status never echoes the token')
  } finally {
    cleanup()
  }
})

test('formatStatus reports "none" when neither env key nor store credential exists', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const text = formatStatus(resolveVisionStatus({ dir: project, env }))
    assert.match(text, /Auth: {3}env key not set; credential store none/)
  } finally {
    cleanup()
  }
})

// ─── Secret-leak guard ────────────────────────────────────────────────────

test('a credential fixture never leaks into --list, status, or --set output', () => {
  const { home, project, env, cleanup } = makeEnv()
  const FIXTURE = 'sk-live-fixture-01337'
  const saved = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    PANTHEON_OPENCODE_API_KEY: process.env.PANTHEON_OPENCODE_API_KEY,
  }
  try {
    // Plant the fixture in BOTH a credential source and the env key.
    const authPath = join(home, '.local', 'share', 'opencode', 'auth.json')
    mkdirSync(dirname(authPath), { recursive: true })
    writeFileSync(authPath, `${JSON.stringify({ 'opencode-go': { access: FIXTURE } })}\n`)
    const catalogPath = join(project, 'catalog.json')
    writeFileSync(catalogPath, `${JSON.stringify(sampleCatalog())}\n`)

    process.env.HOME = env.HOME
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME
    process.env.PANTHEON_OPENCODE_API_KEY = FIXTURE

    const status = captureStdout(() => main([`--dir=${project}`]))
    assert.equal(status.code, 0)
    assert.equal(status.out.includes(FIXTURE), false, 'status must not leak the token')
    assert.match(status.out, /Auth:/)

    const list = captureStdout(() => main(['--list', '--catalog', catalogPath, `--dir=${project}`]))
    assert.equal(list.code, 0)
    assert.equal(list.out.includes(FIXTURE), false, '--list must not leak the token')

    const set = captureStdout(() => main(['--set', 'opencode-go/minimax-m3', `--dir=${project}`]))
    assert.equal(set.code, 0)
    assert.equal(set.out.includes(FIXTURE), false, '--set must not leak the token')
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME
    else process.env.HOME = saved.HOME
    if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME
    if (saved.PANTHEON_OPENCODE_API_KEY === undefined) delete process.env.PANTHEON_OPENCODE_API_KEY
    else process.env.PANTHEON_OPENCODE_API_KEY = saved.PANTHEON_OPENCODE_API_KEY
    cleanup()
  }
})

// ─── --set: atomic merge ──────────────────────────────────────────────────

test('setVisionModel merges into the project config, preserving existing keys', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const configPath = join(project, '.opencode', 'opencode-vision.json')
    writeVisionConfig(configPath, { mode: 'tool', models: ['opencode/*'], imageAnalysisTool: 'x' })

    const result = setVisionModel('opencode-go/minimax-m3', { dir: project, env })
    assert.equal(result.ok, true)
    assert.equal(result.wrote, true)
    assert.equal(result.path, configPath)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.mode, 'tool')
    assert.deepEqual(written.models, ['opencode/*'])
    assert.equal(written.imageAnalysisTool, 'x')
    assert.equal(written.visionModel, 'opencode-go/minimax-m3')
  } finally {
    cleanup()
  }
})

test('setVisionModel --global target writes the global vision config', () => {
  const { env, cleanup } = makeEnv()
  try {
    const result = setVisionModel('opencode-go/mimo-v2.5', { env, target: 'global' })
    assert.equal(result.ok, true)
    assert.equal(result.path, globalVisionConfigPath(env))
    assert.deepEqual(JSON.parse(readFileSync(result.path, 'utf8')), {
      visionModel: 'opencode-go/mimo-v2.5',
    })
  } finally {
    cleanup()
  }
})

test('setVisionModel leaves corrupted JSON byte-identical and reports it', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const configPath = join(project, '.opencode', 'opencode-vision.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{ broken')

    const result = setVisionModel('opencode-go/mimo-v2.5', { dir: project, env })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'corrupt')
    assert.equal(readFileSync(configPath, 'utf8'), '{ broken')
  } finally {
    cleanup()
  }
})

test('setVisionModel rejects a malformed model without touching the config', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const result = setVisionModel('no-slash', { dir: project, env })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'invalid-format')
    assert.equal(existsSync(join(project, '.opencode', 'opencode-vision.json')), false)
  } finally {
    cleanup()
  }
})

test('setVisionModel reports a write failure without corrupting the target', () => {
  const { project, env, cleanup } = makeEnv()
  try {
    const configPath = join(project, '.opencode', 'opencode-vision.json')
    mkdirSync(dirname(configPath), { recursive: true })
    const realPath = join(project, 'real.json')
    writeFileSync(realPath, '{ "mode": "tool" }\n')
    symlinkSync(realPath, configPath)

    const result = setVisionModel('opencode-go/mimo-v2.5', { dir: project, env })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'write-failed')
    // the symlink and its target are untouched
    assert.equal(readFileSync(configPath, 'utf8'), '{ "mode": "tool" }\n')
  } finally {
    cleanup()
  }
})

// ─── main CLI dispatch ────────────────────────────────────────────────────

test('main --set writes and exits 0; malformed model exits 1', () => {
  const { project, cleanup } = makeEnv()
  try {
    const ok = captureStdout(() => main(['--set', 'opencode-go/mimo-v2.5', '--dir', project]))
    assert.equal(ok.code, 0)
    assert.match(ok.out, /pinned opencode-go\/mimo-v2.5/)
    assert.equal(
      JSON.parse(readFileSync(join(project, '.opencode', 'opencode-vision.json'), 'utf8'))
        .visionModel,
      'opencode-go/mimo-v2.5',
    )

    const bad = captureStdout(() => main(['--set', 'nope', '--dir', project]))
    assert.equal(bad.code, 1)
    assert.match(bad.out, /not saved/)
  } finally {
    cleanup()
  }
})

test('main --list --catalog prints the numbered catalog list', () => {
  const { project, cleanup } = makeEnv()
  try {
    const catalogPath = join(project, 'catalog.json')
    writeFileSync(catalogPath, `${JSON.stringify(sampleCatalog())}\n`)
    const { code, out } = captureStdout(() =>
      main(['--list', '--catalog', catalogPath, '--dir', project]),
    )
    assert.equal(code, 0)
    assert.match(out, /Source: host catalog/)
    assert.match(out, /1\s+opencode-go\/mimo-v2.5\s+free/)
  } finally {
    cleanup()
  }
})
