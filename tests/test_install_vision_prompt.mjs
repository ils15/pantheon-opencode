/**
 * test_install_vision_prompt.mjs — focused contract tests for the optional
 * vision step of `pantheon-opencode init` (scripts/install/vision-prompt.mjs)
 * and its wiring in scripts/install/opencode.mjs.
 *
 * Run: node --test tests/test_install_vision_prompt.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { installOpenCode } from '../scripts/install/opencode.mjs'
import {
  globalVisionConfigPath,
  isValidVisionModel,
  mergeVisionModel,
  runVisionPrompt,
} from '../scripts/install/vision-prompt.mjs'

const silentLogger = { log() {}, warn() {}, error() {} }

/** Run `fn` with HOME/XDG_CONFIG_HOME pointed at a throwaway dir. */
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-vision-home-'))
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  try {
    return await fn(home, { ...process.env })
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    rmSync(home, { recursive: true, force: true })
  }
}

/** Fake readline interface returning queued answers (default: empty string). */
function fakeRl(answers) {
  const queue = [...answers]
  return {
    question: async () => (queue.length > 0 ? queue.shift() : ''),
    close() {},
  }
}

test('isValidVisionModel accepts provider/model and rejects malformed input', () => {
  assert.equal(isValidVisionModel('opencode-go/mimo-v2.5'), true)
  assert.equal(isValidVisionModel('  opencode/mimo-v2.6-flash-free  '), true)
  assert.equal(isValidVisionModel('no-slash'), false)
  assert.equal(isValidVisionModel('a/b/c'), false)
  assert.equal(isValidVisionModel('provider/'), false)
  assert.equal(isValidVisionModel('/model'), false)
  assert.equal(isValidVisionModel('has space/model'), false)
  assert.equal(isValidVisionModel(''), false)
})

test('default (Enter) writes nothing', async () => {
  await withTempHome(async (home, env) => {
    const result = await runVisionPrompt({ rl: fakeRl(['']), logger: silentLogger, env })
    assert.equal(result.action, 'auto')
    assert.equal(existsSync(globalVisionConfigPath(env)), false)
    assert.equal(existsSync(join(home, '.config', 'opencode')), false)
  })
})

test('skip writes nothing', async () => {
  await withTempHome(async (_home, env) => {
    const result = await runVisionPrompt({ rl: fakeRl(['3']), logger: silentLogger, env })
    assert.equal(result.action, 'skip')
    assert.equal(existsSync(globalVisionConfigPath(env)), false)
  })
})

test('pin a valid provider/model writes the global config', async () => {
  await withTempHome(async (_home, env) => {
    const result = await runVisionPrompt({
      rl: fakeRl(['2', 'opencode-go/mimo-v2.5']),
      logger: silentLogger,
      env,
    })
    assert.equal(result.action, 'pin')
    assert.equal(result.visionModel, 'opencode-go/mimo-v2.5')
    const written = JSON.parse(readFileSync(globalVisionConfigPath(env), 'utf8'))
    assert.deepEqual(written, { visionModel: 'opencode-go/mimo-v2.5' })
  })
})

test('pin merges — existing keys are never overwritten', async () => {
  await withTempHome(async (_home, env) => {
    const configPath = globalVisionConfigPath(env)
    mkdirSync(dirname(configPath), { recursive: true })
    const original = { mode: 'tool', models: ['opencode/*'], imageAnalysisTool: 'custom_tool' }
    writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`)

    const result = await runVisionPrompt({
      rl: fakeRl(['pin', 'opencode-go/minimax-m3']),
      logger: silentLogger,
      env,
    })
    assert.equal(result.action, 'pin')
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.mode, 'tool')
    assert.deepEqual(written.models, ['opencode/*'])
    assert.equal(written.imageAnalysisTool, 'custom_tool')
    assert.equal(written.visionModel, 'opencode-go/minimax-m3')
  })
})

test('invalid input re-asks, then a valid pin is written', async () => {
  await withTempHome(async (_home, env) => {
    const result = await runVisionPrompt({
      rl: fakeRl(['2', 'not-a-model', 'a/b/c', 'opencode-go/mimo-v2.5']),
      logger: silentLogger,
      env,
    })
    assert.equal(result.action, 'pin')
    const written = JSON.parse(readFileSync(globalVisionConfigPath(env), 'utf8'))
    assert.equal(written.visionModel, 'opencode-go/mimo-v2.5')
  })
})

test('repeated invalid input aborts without writing or corrupting', async () => {
  await withTempHome(async (_home, env) => {
    const result = await runVisionPrompt({
      rl: fakeRl(['2', 'bad', 'worse', 'still-bad']),
      logger: silentLogger,
      env,
    })
    assert.equal(result.action, 'skip')
    assert.equal(existsSync(globalVisionConfigPath(env)), false)
  })
})

test('corrupted existing config is left byte-identical', async () => {
  await withTempHome(async (_home, env) => {
    const configPath = globalVisionConfigPath(env)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{ not valid json')

    const result = await runVisionPrompt({
      rl: fakeRl(['2', 'opencode-go/mimo-v2.5']),
      logger: silentLogger,
      env,
    })
    assert.equal(result.action, 'pin')
    assert.equal(result.wrote, false)
    assert.equal(readFileSync(configPath, 'utf8'), '{ not valid json')
  })
})

test('mergeVisionModel creates missing directories and reports created', async () => {
  await withTempHome(async (_home, env) => {
    const result = mergeVisionModel('opencode-go/mimo-v2.5', { env })
    assert.equal(result.reason, 'created')
    assert.equal(existsSync(result.path), true)
  })
})

test('non-interactive install (--yes --headless) never prompts nor writes vision config', async () => {
  await withTempHome(async (_home, env) => {
    const target = mkdtempSync(join(tmpdir(), 'pantheon-vision-install-'))
    try {
      await installOpenCode(target, false, false, ['agents'], {
        yes: true,
        headless: true,
        version: 'v2',
      })
      assert.equal(existsSync(globalVisionConfigPath(env)), false)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })
})

test('mergeVisionModel reports conflict (wrote:false) when config changes concurrently', async () => {
  await withTempHome(async (_home, env) => {
    const configPath = globalVisionConfigPath(env)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify({ mode: 'tool' }, null, 2)}\n`)

    const result = mergeVisionModel('opencode-go/mimo-v2.5', {
      env,
      // Simulate a concurrent writer landing between the read and the swap.
      beforeRecheck: () =>
        writeFileSync(configPath, `${JSON.stringify({ mode: 'native' }, null, 2)}\n`),
    })

    assert.equal(result.reason, 'conflict')
    assert.equal(result.wrote, false)
    // The newer content is preserved, not clobbered.
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { mode: 'native' })
  })
})

test('conflict: runVisionPrompt logs an honest not-saved message (no false "pinned")', async () => {
  await withTempHome(async (_home, env) => {
    const configPath = globalVisionConfigPath(env)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify({ mode: 'tool' }, null, 2)}\n`)

    const warnings = []
    const logger = { log() {}, warn: (msg) => warnings.push(msg), error() {} }
    const result = await runVisionPrompt({
      rl: fakeRl(['2', 'opencode-go/mimo-v2.5']),
      logger,
      env,
      beforeRecheck: () =>
        writeFileSync(configPath, `${JSON.stringify({ mode: 'native' }, null, 2)}\n`),
    })

    assert.equal(result.action, 'pin')
    assert.equal(result.wrote, false)
    assert.ok(
      warnings.some((msg) => /not saved/.test(msg) && /modified concurrently/.test(msg)),
      'honest not-saved warning',
    )
    assert.equal(
      warnings.some((msg) => /pinned/.test(msg)),
      false,
      'no false "pinned" claim on a conflict',
    )
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { mode: 'native' })
  })
})
