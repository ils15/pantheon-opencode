/**
 * Vision plugin tests — image interception in `chat.message`:
 *  - NATIVE path (preferred): with a provider key, the multimodal model is
 *    called directly via the opencode Zen OpenAI-compatible endpoint and the
 *    image is replaced by the returned text description (no MCP tool).
 *  - TOOL path (fallback): without a key / on native failure, the DavidEasden
 *    pattern applies — the image is replaced by a text instruction pointing
 *    the model at a vision MCP tool, so the image never reaches the provider.
 *
 * Run: node tests/test_plugin_vision.mjs
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const file = new URL(import.meta.url)
if (!process.execArgv.includes('--experimental-strip-types')) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', file.pathname], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  process.stdout.write(child.stdout)
  process.stderr.write(child.stderr)
  process.exit(child.status ?? 1)
}

import { hasVision } from '../src/pantheon/presets.mjs'
import {
  buildDescriptionCacheKey,
  buildNativeVisionPrompt,
  buildStructuredInjection,
  cleanupSessionTempImages,
  DESCRIPTION_CACHE_TTL_MS,
  detectVisionIntent,
  enforceTempFileCap,
  escapeXml,
  generateInjectionPrompt,
  generateNativeInjection,
  getCachedDescription,
  getVisionMode,
  hashContent,
  isImageFilePart,
  matchesModelPattern,
  matchesWildcardPattern,
  modelMatchesAnyPattern,
  parseStructuredVisionResponse,
  readOpencodeAuthToken,
  resolveNativeVisionConfig,
  saveDataUrlImage,
  setCachedDescription,
  stripProviderPrefix,
  TEMP_FILE_GRACE_MS,
  TEMP_MAX_FILES,
  tempFileLRU,
  touchTempFile,
} from '../src/pantheon/vision.ts'
import plugin from '../src/plugin.ts'

// ─── Contract: plugin.ts export surface (OpenCode 1.18.11 legacy loader) ───
// OpenCode 1.18.11 `getLegacyPlugins()` does `Object.values(mod)` and invokes
// EVERY function-valued export as a plugin factory, passing a PluginInput. Any
// named function export (helper) is therefore called with an object and can
// throw (e.g. generateInjectionPrompt's array guard) — which was the boot
// failure: 'Vision image resolution must return an array'. The module MUST
// expose exactly one function-valued export: the default plugin.
{
  const mod = await import('../src/plugin.ts')
  const functionExports = Object.values(mod).filter((value) => typeof value === 'function')
  assert.equal(
    functionExports.length,
    1,
    'plugin.ts has exactly one function-valued export (the default)',
  )
  assert.equal(functionExports[0], plugin, 'the single function export is the default plugin')
  assert.doesNotThrow(
    () => plugin({ client: {}, directory: '/tmp', project: {}, worktree: '/tmp' }),
    'invoking the plugin factory does not throw at load',
  )
}

const VISION_DIR = join(tmpdir(), 'pantheon-vision')
const previousXdg = process.env.XDG_CONFIG_HOME
const xdgDir = mkdtempSync(join(tmpdir(), 'pantheon-xdg-'))
process.env.XDG_CONFIG_HOME = xdgDir
// Hermetic HOME: isolate the opencode auth store default path
// (~/.local/share/opencode/auth.json) so auth-store tests never touch the
// developer's real `opencode auth login` credentials.
const previousHome = process.env.HOME
const homeDir = mkdtempSync(join(tmpdir(), 'pantheon-home-'))
process.env.HOME = homeDir
// Hermetic: keep existing tool-pattern tests on the TOOL path regardless of
// the developer's shell (native vision only activates when a key is set).
const previousOpenCodeKey = process.env.PANTHEON_OPENCODE_API_KEY
const previousOaiKey = process.env.OPENCODE_API_KEY
const previousMode = process.env.PANTHEON_VISION_MODE
const previousVisionModel = process.env.PANTHEON_VISION_MODEL
delete process.env.PANTHEON_OPENCODE_API_KEY
delete process.env.OPENCODE_API_KEY
delete process.env.PANTHEON_VISION_MODE
delete process.env.PANTHEON_VISION_MODEL
delete process.env.PANTHEON_VISION_TOOL

const tempDirs = []
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cfg-'))
  tempDirs.push(dir)
  return dir
}

// ─── Config hook: applies the active model preset (P1-1) ─────────────────
// `init --preset` / `set-tier` only write .pantheon/active-preset.json; the
// config hook must RESOLVE it and APPLY it (agent models / reasoning /
// fallbacks + provider configs). Fail-safe: no active preset → no mutation.
// The HOME candidate (~/.opencode/.pantheon/active-preset.json) is hermetic
// here, so this exercises the real hook end-to-end without touching the repo.

await (async () => {
  const hooks = await makeHooks()
  assert.equal(typeof hooks.config, 'function', 'config hook exposed')

  // Fail-safe: no active preset anywhere → agents/providers untouched, but
  // the plugin's own path wiring still happens.
  await withEnv('PANTHEON_MODEL_PRESET', undefined, async () => {
    const config = { agent: { zeus: { model: 'custom/manual' } } }
    await hooks.config(config)
    assert.equal(config.agent.zeus.model, 'custom/manual', 'no preset → no model mutation')
    assert.equal(config.provider, undefined, 'no preset → no provider injected')
    assert.equal(config.agent.zeus.variant, undefined, 'no preset → no variant mutation')
    assert.ok(
      Array.isArray(config.agentsPath) && config.agentsPath.length > 0,
      'agentsPath still appended',
    )
    assert.ok(
      Array.isArray(config.skillsPaths) && config.skillsPaths.length > 0,
      'skillsPaths still appended',
    )
  })

  // Preset present (hermetic HOME candidate) → agents/providers applied.
  await withEnv('PANTHEON_MODEL_PRESET', undefined, async () => {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'hook-key', async () => {
      const presetDir = join(homeDir, '.opencode', '.pantheon')
      mkdirSync(presetDir, { recursive: true })
      writeFileSync(
        join(presetDir, 'active-preset.json'),
        JSON.stringify({ version: 1, preset: 'go-deepseek', source: 'cli' }),
      )
      try {
        const config = {}
        await hooks.config(config)
        assert.equal(
          config.agent.zeus.model,
          'opencode/deepseek-v4-flash',
          'preset applied to agent model',
        )
        assert.equal(config.agent.zeus.variant, 'medium', 'preset applied to reasoning effort')
        assert.deepEqual(
          config.agent.zeus.fallback_models,
          ['opencode/mimo-v2.5'],
          'preset applied to fallback models',
        )
        assert.equal(
          config.provider.opencode.options.baseURL,
          'https://opencode.ai/zen/v1',
          'preset provider injected',
        )
      } finally {
        rmSync(join(homeDir, '.opencode', '.pantheon'), { recursive: true, force: true })
      }
    })
  })
})()

// ─── Mocks ─────────────────────────────────────────────────────────────────

const imagePart = (overrides = {}) => ({
  id: 'image-1',
  sessionID: 'session-1',
  messageID: 'message-1',
  type: 'file',
  mime: 'image/png',
  filename: 'image-1.png',
  url: 'data:image/png;base64,ZmFrZQ==',
  ...overrides,
})

const textPart = (text, overrides = {}) => ({
  id: 'text-1',
  sessionID: 'session-1',
  messageID: 'message-1',
  type: 'text',
  text,
  ...overrides,
})

const userMessage = (_parts, model, sessionID = 'session-1') => ({
  id: 'message-1',
  sessionID,
  role: 'user',
  agent: 'zeus',
  model: model ?? { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
})

async function makeHooks(client = {}, directory = '/tmp') {
  return plugin({ client, directory, project: {}, worktree: '/tmp' })
}

/** Drive one chat.message turn through the hook and return the mutated output. */
async function runTurn(hooks, parts, model, sessionID = 'session-1') {
  const message = userMessage(parts, model, sessionID)
  const output = { message, parts }
  await hooks['chat.message']({ sessionID, model: message.model }, output)
  return output
}

const injectedText = (parts) =>
  parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')

const assertSyntheticPartIds = (parts) => {
  for (const part of parts.filter((p) => p.synthetic === true)) {
    assert.match(part.id, /^prt/, 'synthetic TextPart id uses the OpenCode prefix')
  }
}

async function sanitizeHistory(hooks, messages) {
  const transform = hooks['experimental.chat.messages.transform']
  assert.equal(typeof transform, 'function', 'experimental history transform is exposed')
  const output = { messages }
  await transform({}, output)
  return output
}

async function withEnv(name, value, fn) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

/** Isolated opencode auth store path under the hermetic HOME. */
const authStoreDir = join(homeDir, '.local', 'share', 'opencode')
const authStorePath = join(authStoreDir, 'auth.json')

/** Write (or remove) the mock auth.json; returns the file path. */
function writeAuthStore(entries) {
  mkdirSync(authStoreDir, { recursive: true })
  writeFileSync(authStorePath, JSON.stringify(entries))
  return authStorePath
}

const clearAuthStore = () => {
  try {
    rmSync(authStoreDir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

// ─── fetch mock (native vision) ────────────────────────────────────────────

const savedFetch = globalThis.fetch

/** Stub globalThis.fetch, recording each call. handler(call) → Response-like. */
function installFetchMock(handler) {
  const calls = []
  globalThis.fetch = async (url, options) => {
    const call = { url, options }
    calls.push(call)
    return handler(call)
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = savedFetch
    },
  }
}

const okJson = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
})

const errResponse = (status) => ({
  ok: false,
  status,
  json: async () => ({}),
})

const bodyOf = (call) => JSON.parse(call.options.body)

// ─── Unit tests: type guard + wildcards ───────────────────────────────────

assert.equal(isImageFilePart(imagePart()), true)
assert.equal(isImageFilePart({ ...imagePart(), mime: 'application/pdf' }), false)
assert.equal(isImageFilePart({ ...imagePart(), mime: 'image/gif' }), true)
assert.equal(isImageFilePart({ ...imagePart(), type: 'text', text: 'x' }), false)
assert.equal(isImageFilePart(null), false)

assert.equal(matchesWildcardPattern('*', 'anything'), true)
assert.equal(matchesWildcardPattern('prefix*', 'prefix-value'), true)
assert.equal(matchesWildcardPattern('prefix*', 'other'), false)
assert.equal(matchesWildcardPattern('*suffix', 'value-suffix'), true)
assert.equal(matchesWildcardPattern('*suffix', 'other'), false)
assert.equal(matchesWildcardPattern('*contains*', 'pre-contains-post'), true)
assert.equal(matchesWildcardPattern('*contains*', 'no-match'), false)
assert.equal(matchesWildcardPattern('exact', 'exact'), true)
assert.equal(matchesWildcardPattern('exact', 'other'), false)

assert.equal(
  matchesModelPattern('opencode-go/*', { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' }),
  true,
)
assert.equal(
  matchesModelPattern('opencode-go/*', { providerID: 'anthropic', modelID: 'claude' }),
  false,
)
assert.equal(
  matchesModelPattern('*/deepseek-v4-flash', {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-flash',
  }),
  true,
)
assert.equal(
  matchesModelPattern('*flash*', { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' }),
  true,
)
assert.equal(
  modelMatchesAnyPattern({ providerID: 'anthropic', modelID: 'claude-sonnet-4.5' }, [
    '*/deepseek-*',
  ]),
  false,
)
assert.equal(
  modelMatchesAnyPattern({ providerID: 'anthropic', modelID: 'claude-sonnet-4.5' }, ['*']),
  true,
)
assert.equal(hasVision('anthropic/claude-sonnet-4.5'), true)
assert.equal(hasVision('opencode-go/deepseek-v4-flash'), false)

// Prompt template default uses the tool name, path and user text.
const defaultPrompt = generateInjectionPrompt(
  [{ path: '/tmp/x.png' }],
  'o que é isso?',
  'pantheon_vision_vision_describe',
)
assert.ok(defaultPrompt.includes('/tmp/x.png'))
assert.ok(defaultPrompt.includes('pantheon_vision_vision_describe'))
assert.ok(defaultPrompt.includes('o que é isso?'))

// The prompt helper accepts zero, one, or multiple images, but rejects a
// resolver contract violation instead of turning it into an empty image list.
assert.doesNotThrow(() => generateInjectionPrompt([], '', 'vision-tool'))
assert.equal(typeof generateInjectionPrompt([], '', 'vision-tool'), 'string')
assert.ok(
  generateInjectionPrompt([{ path: '/tmp/one.png' }], '', 'vision-tool').includes('/tmp/one.png'),
)
assert.ok(
  generateInjectionPrompt(
    [{ path: '/tmp/one.png' }, { path: '/tmp/two.png' }],
    '',
    'vision-tool',
  ).includes('Image 2'),
)
assert.throws(
  () => generateInjectionPrompt(null, '', 'vision-tool'),
  /Vision image resolution must return an array/,
)

// ─── Test 1: data: URI → saved to /tmp/pantheon-vision + injected TextPart ──

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const hooks = await makeHooks()
  const output = await runTurn(hooks, [imagePart(), textPart('Analise a imagem')])

  assert.equal(output.parts.some(isImageFilePart), false, 'image file parts removed')
  assertSyntheticPartIds(output.parts)
  const injected = injectedText(output.parts)
  assert.ok(
    injected.includes('pantheon_vision_vision_describe'),
    'tool name in injection (real runtime ID)',
  )
  assert.ok(injected.includes(VISION_DIR), 'temp dir path in injection')
  assert.ok(injected.includes('Analise a imagem'), 'user text preserved in injection')

  const files = existsSync(VISION_DIR) ? readdirSync(VISION_DIR) : []
  assert.equal(files.length, 1, 'one temp file saved')
  assert.ok(injected.includes(join(VISION_DIR, files[0])), 'saved file path in injection')
})()

// ─── Test 2: file:// → local path used directly (no copy) ──────────────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const hooks = await makeHooks()
  const output = await runTurn(hooks, [
    imagePart({ url: 'file:///tmp/screenshot.png' }),
    textPart('descreva'),
  ])
  assert.equal(output.parts.some(isImageFilePart), false, 'image file part removed')
  const injected = injectedText(output.parts)
  assert.ok(injected.includes('/tmp/screenshot.png'), 'local path used directly')
  assert.equal(existsSync(VISION_DIR), false, 'no temp copy for file://')
})()

// ─── Test 3: http(s):// → URL passed through unchanged ─────────────────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const hooks = await makeHooks()
  const output = await runTurn(hooks, [imagePart({ url: 'https://example.com/img.png' })])
  assert.equal(output.parts.some(isImageFilePart), false, 'image file part removed')
  const injected = injectedText(output.parts)
  assert.ok(injected.includes('https://example.com/img.png'), 'remote URL kept')
  assert.equal(existsSync(VISION_DIR), false, 'no temp copy for http')
})()

// ─── P2-1: file:// URLs decode %20 + Windows forms (fileURLToPath) ─────────
// A raw slice('file://') keeps the literal %20 in the path, so reading a
// file whose name has a space fails. fileURLToPath decodes percent-encoding
// and normalizes Windows drive-letter URLs.

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const spacedPath = join(tmpdir(), `pantheon spaced ${Date.now()}.png`)
  writeFileSync(spacedPath, 'png-bytes')
  // encodeURI (not encodeURIComponent): preserves the file:/// path slashes.
  const url = `file://${encodeURI(spacedPath)}`
  assert.ok(url.includes('%20'), 'fixture URL is percent-encoded')
  assert.ok(url.includes('file:///'), 'fixture keeps the file:/// triple slash')

  // tool pattern: the injected path must be the DECODED one (real space).
  const hooks = await makeHooks()
  const output = await runTurn(hooks, [imagePart({ url })])
  const injected = injectedText(output.parts)
  assert.ok(injected.includes(spacedPath), 'injection uses the decoded path (real space)')
  assert.equal(injected.includes('%20'), false, 'no literal %20 in the injected path')

  // native pattern: the gateway payload must READ the decoded bytes — a
  // literal %20 path would make readFile fail and skip the native call.
  const mock = installFetchMock(() => okJson('decoded file read'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      const hooks2 = await makeHooks()
      await runTurn(hooks2, [imagePart({ url })])
    })
    assert.equal(mock.calls.length, 1, 'native call succeeded reading the decoded file')
    const payload = bodyOf(mock.calls[0]).messages[0].content[1].image_url.url
    assert.ok(payload.startsWith('data:image/png;base64,'), 'decoded file bytes converted')
  } finally {
    mock.restore()
  }
  rmSync(spacedPath, { force: true })

  // Windows-style file URL: drive-letter form preserved, %20 decoded.
  const winUrl = 'file:///C:/Users/me/my%20screen.png'
  const winHooks = await makeHooks()
  const winOut = await runTurn(winHooks, [imagePart({ url: winUrl })])
  const winInjected = injectedText(winOut.parts)
  assert.equal(winInjected.includes('%20'), false, 'Windows URL decoded (no %20)')
  assert.ok(
    winInjected.includes('C:/Users/me/my screen.png'),
    'Windows drive-letter path preserved with space decoded',
  )
})()

// ─── Test 4: removes image FileParts, preserves user text parts ────────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const hooks = await makeHooks()
  const output = await runTurn(hooks, [
    imagePart(),
    imagePart({ id: 'image-2' }),
    textPart('keep me'),
    textPart('and me'),
  ])
  assert.equal(output.parts.some(isImageFilePart), false, 'all image file parts removed')
  assertSyntheticPartIds(output.parts)
  const texts = injectedText(output.parts)
  assert.ok(texts.includes('keep me'), 'first user text part preserved')
  assert.ok(texts.includes('and me'), 'second user text part preserved')
})()

// ─── Test 5: message without image is unchanged ────────────────────────────

await (async () => {
  const hooks = await makeHooks()
  const parts = [textPart('normal turn')]
  const message = userMessage(parts)
  const output = { message, parts }
  await hooks['chat.message']({ sessionID: 'session-1', model: message.model }, output)
  assert.equal(output.parts, parts, 'same array reference')
  assert.equal(output.parts.length, 1, 'no parts added')
  assert.equal(output.parts[0].text, 'normal turn')
})()

// ─── History wire tests: no residual image reaches a text provider ──────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const hooks = await makeHooks()

  // Turn 1 caches the generated MCP instruction for the image part.
  await runTurn(hooks, [imagePart(), textPart('primeiro pedido')], undefined, 'session-wire')
  const history = [
    {
      info: { id: 'message-1', sessionID: 'session-wire' },
      parts: [imagePart(), textPart('primeiro pedido')],
    },
    {
      info: { id: 'message-2', sessionID: 'session-wire' },
      parts: [textPart('segundo turno textual')],
    },
  ]
  const transformed = await sanitizeHistory(hooks, history)
  const wire = JSON.stringify(transformed.messages)
  assert.equal(wire.includes('image_url'), false, 'history wire has no image_url')
  assert.equal(transformed.messages[0].parts.some(isImageFilePart), false, 'turn 1 image replaced')
  assertSyntheticPartIds(transformed.messages[0].parts)
  assert.ok(
    transformed.messages[0].parts.some(
      (part) => part.type === 'text' && part.text.includes('pantheon_vision_vision_describe'),
    ),
    'cached text reused',
  )
  assert.ok(wire.includes('segundo turno textual'), 'textual turn remains in history')

  // Contract wire: a text-only provider rejects image_url content. The
  // transform must run before serialization, so this mock accepts the
  // sanitized history and would throw if any image payload leaked through.
  const rejectingTextProvider = async (messages) => {
    if (JSON.stringify(messages).includes('image_url')) {
      throw new Error('text provider rejects image_url')
    }
    return 'textual turn accepted'
  }
  assert.equal(await rejectingTextProvider(transformed.messages), 'textual turn accepted')

  // A second image in the same session receives its own cached replacement.
  const secondImage = imagePart({ id: 'image-2', url: 'file:///tmp/second.png' })
  await runTurn(hooks, [secondImage, textPart('segunda imagem')], undefined, 'session-wire')
  const secondHistory = [
    {
      info: { id: 'message-3', sessionID: 'session-wire' },
      parts: [secondImage],
    },
  ]
  const secondTransformed = await sanitizeHistory(hooks, secondHistory)
  assert.equal(JSON.stringify(secondTransformed.messages).includes('image_url'), false)
  assert.equal(secondTransformed.messages[0].parts.some(isImageFilePart), false)
  assertSyntheticPartIds(secondTransformed.messages[0].parts)

  // A new session cannot reuse turn 1's cache, but still gets a safe text part.
  const newSession = await sanitizeHistory(hooks, [
    {
      info: { id: 'message-new', sessionID: 'new-session' },
      parts: [imagePart()],
    },
  ])
  assert.equal(JSON.stringify(newSession.messages).includes('image_url'), false)
  assert.equal(newSession.messages[0].parts.some(isImageFilePart), false)
  assert.ok(
    JSON.stringify(newSession.messages).includes('Imagem removida do histórico'),
    'new session has no inherited cache',
  )
  assertSyntheticPartIds(newSession.messages[0].parts)
})()

// ─── History shapes: provider content, nested arrays, and current-turn URLs ──

await (async () => {
  const hooks = await makeHooks()
  const providerShaped = [
    {
      role: 'user',
      sessionID: 'session-provider-shaped',
      content: [
        { type: 'text', text: 'provider history' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,leak' } },
        [[{ type: 'image_url', image_url: { url: 'https://example.invalid/image' } }]],
      ],
    },
    {
      info: { id: 'message-file', sessionID: 'session-provider-shaped' },
      parts: [[imagePart({ id: 'nested-image' })], textPart('file history')],
    },
  ]
  const transformed = await sanitizeHistory(hooks, providerShaped)
  const rejectingTextProvider = async (messages) => {
    const wire = JSON.stringify(messages)
    if (wire.includes('image_url')) throw new Error('text provider rejects image_url')
    return 'text-only content accepted'
  }
  assert.equal(await rejectingTextProvider(transformed.messages), 'text-only content accepted')
  assert.ok(
    transformed.messages[0].content[1].type === 'text' &&
      transformed.messages[0].content[2][0][0].type === 'text',
    'provider image_url values become plain text content, including nested arrays',
  )
  assert.equal(transformed.messages[1].parts[0][0].type, 'text')

  // A current turn that already arrived in provider shape must not bypass the
  // registered chat.message path merely because it is not a FilePart.
  const currentTurn = await runTurn(hooks, [
    { type: 'text', text: 'current turn' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,current' } },
  ])
  assert.equal(JSON.stringify(currentTurn.parts).includes('image_url'), false)
  assert.ok(
    currentTurn.parts.some((part) => part.type === 'text' && part.text.includes('Imagem removida')),
  )
  assert.equal(await rejectingTextProvider([currentTurn.parts]), 'text-only content accepted')
})()

// ─── Test 6: tool name from env / config / dynamic detection / default ─────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })

  // default (no env, no config, no tool.ids) → canonical runtime tool ID
  const hooksDefault = await makeHooks()
  const outDefault = await runTurn(hooksDefault, [imagePart()])
  assert.ok(
    injectedText(outDefault.parts).includes('pantheon_vision_vision_describe'),
    'default tool name is the real runtime ID',
  )

  // env PANTHEON_VISION_TOOL
  await withEnv('PANTHEON_VISION_TOOL', 'mcp__custom__describe', async () => {
    const hooks = await makeHooks()
    const output = await runTurn(hooks, [imagePart()])
    assert.ok(injectedText(output.parts).includes('mcp__custom__describe'), 'env tool name used')
  })

  // project config imageAnalysisTool
  const cfgDir = makeTempDir()
  mkdirSync(join(cfgDir, '.opencode'), { recursive: true })
  writeFileSync(
    join(cfgDir, '.opencode', 'opencode-vision.json'),
    JSON.stringify({ imageAnalysisTool: 'mcp__cfg__describe' }),
  )
  const hooksCfg = await makeHooks({}, cfgDir)
  const outCfg = await runTurn(hooksCfg, [imagePart()])
  assert.ok(injectedText(outCfg.parts).includes('mcp__cfg__describe'), 'config tool name used')

  // dynamic detection via client.tool.ids — real underscore format wins
  const hooksDyn = await makeHooks({
    tool: {
      ids: async () => ({
        data: ['pantheon_vision_vision_describe', 'pantheon_vision_vision_ocr'],
      }),
    },
  })
  const outDyn = await runTurn(hooksDyn, [imagePart()])
  assert.ok(
    injectedText(outDyn.parts).includes('pantheon_vision_vision_describe'),
    'dynamic detection picks the canonical describe tool',
  )

  // dynamic detection — legacy mcp__ hyphen format still matched (compat)
  const hooksLegacy = await makeHooks({
    tool: {
      ids: async () => ({ data: ['mcp__pantheon-vision__vision_describe'] }),
    },
  })
  const outLegacy = await runTurn(hooksLegacy, [imagePart()])
  assert.ok(
    injectedText(outLegacy.parts).includes('mcp__pantheon-vision__vision_describe'),
    'legacy mcp__pantheon-vision ID still matched',
  )

  // hybrid hyphen server + underscore tool → matched
  const hooksHybrid = await makeHooks({
    tool: {
      ids: async () => ({ data: ['pantheon-vision_vision_ocr'] }),
    },
  })
  const outHybrid = await runTurn(hooksHybrid, [imagePart()])
  assert.ok(
    injectedText(outHybrid.parts).includes('pantheon-vision_vision_ocr'),
    'hybrid hyphen/underscore ID matched',
  )
})()

// ─── Test 7: session.idle age-guards temp files (no mid-loop deletion) ─────
// A session.idle can fire between auto-continue turns — not just at real
// session end. A fresh temp file (seconds old) must survive so the next turn's
// MCP tool call can still read the path injected into the TextPart.

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const hooks = await makeHooks()
  await runTurn(hooks, [imagePart()])
  const files = existsSync(VISION_DIR) ? readdirSync(VISION_DIR) : []
  const saved = join(VISION_DIR, files[0] ?? '')
  assert.equal(existsSync(saved), true, 'temp file saved')
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'session-1' } } })
  assert.equal(existsSync(saved), true, 'fresh temp file survives an idle between turns')
  assert.equal(existsSync(VISION_DIR), true, 'temp dir never removed unconditionally')
  rmSync(VISION_DIR, { recursive: true, force: true })
})()

// ─── Cleanup unit: age-guarded unlink; disposed unlinks everything ─────────

await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cleanup-'))
  const fresh = join(dir, 'fresh.png')
  const old = join(dir, 'old.png')
  writeFileSync(fresh, 'fresh')
  writeFileSync(old, 'old')
  const sessionFiles = new Map([
    [fresh, Date.now()],
    [old, Date.now() - TEMP_FILE_GRACE_MS - 1000],
  ])
  const sessionTempFiles = new Map([['s1', sessionFiles]])

  // session.idle: only files older than GRACE are unlinked.
  await cleanupSessionTempImages(sessionTempFiles, new Map(), new Set(), 's1')
  assert.equal(existsSync(fresh), true, 'young file survives idle (age < GRACE)')
  assert.equal(existsSync(old), false, 'old file swept (age > GRACE)')
  assert.equal(sessionFiles.has(fresh), true, 'young path stays registered for next idle')
  assert.equal(sessionFiles.has(old), false, 'old path deregistered')

  // server.instance.disposed (graceMs=0): everything unlinked immediately.
  await cleanupSessionTempImages(sessionTempFiles, new Map(), new Set(), 's1', 0)
  assert.equal(existsSync(fresh), false, 'disposed unlinks young files too')
  assert.equal(sessionTempFiles.has('s1'), false, 'session entry removed after disposed')

  // The temp directory itself is never removed (other sessions may use it).
  const orphan = join(dir, 'orphan.png')
  writeFileSync(orphan, 'orphan')
  const s2Files = new Map([[orphan, Date.now() - TEMP_FILE_GRACE_MS - 1000]])
  await cleanupSessionTempImages(new Map([['s2', s2Files]]), new Map(), new Set(), 's2')
  assert.equal(existsSync(dir), true, 'temp dir survives cleanup (no rm -rf)')
  assert.equal(existsSync(orphan), false, 'aged orphan file swept')
  rmSync(dir, { recursive: true, force: true })
})()

// ─── Test 8: native-vision model not intercepted (wildcard config) ─────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const cfgDir = makeTempDir()
  mkdirSync(join(cfgDir, '.opencode'), { recursive: true })
  writeFileSync(
    join(cfgDir, '.opencode', 'opencode-vision.json'),
    JSON.stringify({ models: ['*/deepseek-v4-flash', 'opencode-go/*'] }),
  )
  const hooks = await makeHooks({}, cfgDir)

  // claude is a native-vision model → does not match the configured patterns
  const nativeVision = await runTurn(hooks, [imagePart()], {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4.5',
  })
  assert.equal(
    nativeVision.parts.some(isImageFilePart),
    true,
    'native-vision model not intercepted; image stays',
  )

  // deepseek-v4-flash matches */deepseek-v4-flash → intercepted
  const textOnly = await runTurn(hooks, [imagePart()], {
    providerID: 'deepseek',
    modelID: 'deepseek-v4-flash',
  })
  assert.equal(textOnly.parts.some(isImageFilePart), false, 'matching model intercepted')

  // opencode-go/* provider wildcard → intercepted
  const providerMatch = await runTurn(hooks, [imagePart()], {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-pro',
  })
  assert.equal(providerMatch.parts.some(isImageFilePart), false, 'provider wildcard intercepted')
})()

// ─── Config promptTemplate is honored ──────────────────────────────────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const cfgDir = makeTempDir()
  mkdirSync(join(cfgDir, '.opencode'), { recursive: true })
  writeFileSync(
    join(cfgDir, '.opencode', 'opencode-vision.json'),
    JSON.stringify({
      promptTemplate: 'Descreva: {imageList} | tool: {toolName} | count: {imageCount} | {userText}',
    }),
  )
  const hooks = await makeHooks({}, cfgDir)
  const output = await runTurn(hooks, [imagePart(), textPart('pedido')])
  const injected = injectedText(output.parts)
  assert.ok(injected.includes('Descreva:'), 'custom template used')
  assert.ok(injected.includes('pantheon_vision_vision_describe'), 'tool variable rendered')
  assert.ok(injected.includes('pedido'), 'userText variable rendered')
})()

// ─── Native vision: unit helpers ───────────────────────────────────────────

// getVisionMode: default auto; explicit native/tool honored; junk → auto.
assert.equal(getVisionMode({}), 'auto')
assert.equal(getVisionMode({ PANTHEON_VISION_MODE: 'native' }), 'native')
assert.equal(getVisionMode({ PANTHEON_VISION_MODE: 'tool' }), 'tool')
assert.equal(getVisionMode({ PANTHEON_VISION_MODE: '  TOOL  ' }), 'tool')
assert.equal(getVisionMode({ PANTHEON_VISION_MODE: 'bogus' }), 'auto')

// generateNativeInjection carries the description, no tool instruction.
const nativePrompt = generateNativeInjection(
  'Um gato laranja.',
  'o que é?',
  'opencode-go/mimo-v2.5',
)
assert.ok(nativePrompt.includes('Um gato laranja.'), 'description present')
assert.ok(nativePrompt.includes('o que é?'), 'user text present')
assert.ok(nativePrompt.includes('opencode-go/mimo-v2.5'), 'model ID present')
assert.ok(!nativePrompt.includes('mcp__'), 'no tool instruction in native injection')

// The Zen gateway payload must carry the bare model name — the endpoint URL
// already encodes the provider, and a qualified model ID is rejected with 401.
assert.equal(stripProviderPrefix('opencode-go/mimo-v2.5'), 'mimo-v2.5')
assert.equal(stripProviderPrefix('opencode/deepseek-v4-flash'), 'deepseek-v4-flash')
assert.equal(stripProviderPrefix('opencode-go/team/mimo-v2.5'), 'mimo-v2.5')
assert.equal(stripProviderPrefix('mimo-v2.5'), 'mimo-v2.5')

// ─── Test N1: presets vision model resolution ──────────────────────────────

await (async () => {
  const key = { PANTHEON_OPENCODE_API_KEY: 'test-key' }

  // explicit preset → vision model + zen/go endpoint
  const fromPreset = resolveNativeVisionConfig(
    { vision: { model: 'opencode-go/minimax-m3', reasoning_effort: 'medium' } },
    key,
  )
  assert.equal(fromPreset.modelID, 'opencode-go/minimax-m3', 'preset vision model used')
  assert.equal(fromPreset.baseURL, 'https://opencode.ai/zen/go/v1', 'zen go baseURL')
  assert.equal(fromPreset.apiKey, 'test-key', 'key passthrough')

  // no preset → DEFAULT_VISION_MODEL
  const defaultTarget = resolveNativeVisionConfig(null, key)
  assert.equal(defaultTarget.modelID, 'opencode-go/mimo-v2.5', 'default vision model')
  assert.equal(defaultTarget.baseURL, 'https://opencode.ai/zen/go/v1', 'default zen go baseURL')

  // env PANTHEON_MODEL_PRESET resolves through the repo routing.yml
  const viaEnv = resolveNativeVisionConfig(null, {
    PANTHEON_MODEL_PRESET: 'go-deepseek',
    PANTHEON_OPENCODE_API_KEY: 'test-key',
  })
  assert.equal(viaEnv.modelID, 'opencode-go/minimax-m3', 'env preset go-deepseek → minimax-m3')
  assert.equal(viaEnv.baseURL, 'https://opencode.ai/zen/go/v1', 'env preset uses zen go')

  // opencode (Zen) provider → zen/v1 endpoint
  const zenFree = resolveNativeVisionConfig({ vision: { model: 'opencode/mimo-v2.5-free' } }, key)
  assert.equal(zenFree.modelID, 'opencode/mimo-v2.5-free')
  assert.equal(zenFree.baseURL, 'https://opencode.ai/zen/v1', 'zen baseURL')

  // anthropic/openai → phase 2, null (fall back to MCP tool)
  assert.equal(
    resolveNativeVisionConfig({ vision: { model: 'anthropic/claude-sonnet-5' } }, key),
    null,
    'anthropic vision is phase 2 → null',
  )
  assert.equal(
    resolveNativeVisionConfig({ vision: { model: 'openai/gpt-5.6-sol' } }, key),
    null,
    'openai vision is phase 2 → null',
  )

  // no key → null (fall back to MCP tool)
  assert.equal(
    resolveNativeVisionConfig({ vision: { model: 'opencode-go/minimax-m3' } }, {}),
    null,
    'missing key → null',
  )

  // OPENCODE_API_KEY fallback accepted when PANTHEON_OPENCODE_API_KEY unset
  const oaiKey = resolveNativeVisionConfig(null, { OPENCODE_API_KEY: 'k' })
  assert.equal(oaiKey.modelID, 'opencode-go/mimo-v2.5', 'OPENCODE_API_KEY fallback model')
  assert.equal(oaiKey.apiKey, 'k', 'OPENCODE_API_KEY fallback key')
  assert.equal(
    resolveNativeVisionConfig(null, {
      PANTHEON_OPENCODE_API_KEY: 'primary',
      OPENCODE_API_KEY: 'fallback',
    }).apiKey,
    'primary',
    'PANTHEON_OPENCODE_API_KEY wins over OPENCODE_API_KEY',
  )
})()

// ─── Test N2: native 200 → description injected, no tool instruction ───────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const mock = installFetchMock(() => okJson('Uma foto de um gato laranja sobre um sofá.'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      const hooks = await makeHooks()
      const output = await runTurn(hooks, [imagePart(), textPart('o que tem aqui?')])
      assert.equal(output.parts.some(isImageFilePart), false, 'image file part removed')
      assert.equal(
        JSON.stringify(output.parts).includes('image_url'),
        false,
        'turn payload has no image_url',
      )
      assertSyntheticPartIds(output.parts)
      const injected = injectedText(output.parts)
      assert.ok(injected.includes('Uma foto de um gato laranja'), 'native description injected')
      assert.ok(injected.includes('o que tem aqui?'), 'user text preserved')
      assert.ok(injected.includes('opencode-go/mimo-v2.5'), 'model ID in injection')
      assert.ok(!injected.includes('mcp__'), 'no tool instruction on native success')
    })

    assert.equal(mock.calls.length, 1, 'exactly one native vision call')
    const call = mock.calls[0]
    assert.equal(call.url, 'https://opencode.ai/zen/go/v1/chat/completions', 'zen go chat URL')
    assert.equal(call.options.headers.Authorization, 'Bearer test-key-123', 'bearer key header')
    assert.equal(call.options.headers['Content-Type'], 'application/json')
    const body = bodyOf(call)
    assert.equal(body.model, 'mimo-v2.5', 'provider prefix stripped from gateway payload')
    assert.equal(body.max_tokens, 500, 'max_tokens capped')
    assert.equal(body.messages[0].role, 'user')
    assert.equal(body.messages[0].content[0].type, 'text', 'prompt text first')
    assert.equal(body.messages[0].content[1].type, 'image_url')
    assert.equal(
      bodyOf(call).messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'),
      true,
      'data URI used in payload',
    )
    assert.equal(
      call.options.body.includes('test-key-123'),
      false,
      'key never in request body (header only)',
    )
    assert.equal(call.options.body.includes('ZmFrZQ=='), true, 'base64 image in request body')
  } finally {
    mock.restore()
  }
})()

// ─── Test N3: no key → tool pattern (no native call) ───────────────────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  clearAuthStore() // no auth store either → guaranteed tool path
  const mock = installFetchMock(() => {
    throw new Error('fetch must not be called without a key')
  })
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', undefined, async () => {
      const hooks = await makeHooks()
      const output = await runTurn(hooks, [imagePart()])
      assert.equal(output.parts.some(isImageFilePart), false, 'image removed')
      const injected = injectedText(output.parts)
      assert.ok(
        injected.includes('pantheon_vision_vision_describe'),
        'tool instruction without key',
      )
      assert.ok(injected.includes(VISION_DIR), 'temp path in tool instruction')
    })
    assert.equal(mock.calls.length, 0, 'no native call without key')
  } finally {
    mock.restore()
  }
})()

// ─── Test N3b: empty/absent tool.ids → canonical default (never unavailable) ─
// OpenCode 1.18.11 keeps MCP tools in the MCP service, NOT in
// client.tool.ids() — an empty list is the NORMAL runtime state. It must
// resolve to the canonical default tool, not the 'Vision fallback unavailable'
// message.
await (async () => {
  const hooks = await makeHooks({ tool: { ids: async () => ({ data: [] }) } })
  const output = await runTurn(hooks, [imagePart()], {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-flash',
  })
  assert.equal(output.parts.some(isImageFilePart), false)
  assert.equal(JSON.stringify(output.parts).includes('image_url'), false)
  assert.ok(
    injectedText(output.parts).includes('pantheon_vision_vision_describe'),
    'empty tool.ids list → canonical default tool',
  )
  assert.match(injectedText(output.parts), /pantheon_vision_vision_describe/)
})()

// ─── Test N3c: detection throws → explicit safe failure, turn never breaks ──
await (async () => {
  const hooks = await makeHooks({
    tool: {
      ids: async () => {
        throw new Error('tool.ids exploded')
      },
    },
  })
  const output = await runTurn(hooks, [imagePart()], {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-flash',
  })
  assert.equal(output.parts.some(isImageFilePart), false)
  assert.equal(JSON.stringify(output.parts).includes('image_url'), false)
  assert.match(injectedText(output.parts), /vision fallback unavailable/i)
})()

// ─── Test N3d: tool.ids resolves but data is undefined → canonical default ──
await (async () => {
  const hooks = await makeHooks({ tool: { ids: async () => ({ data: undefined }) } })
  const output = await runTurn(hooks, [imagePart()], {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-flash',
  })
  assert.equal(output.parts.some(isImageFilePart), false)
  assert.equal(JSON.stringify(output.parts).includes('image_url'), false)
  assert.ok(
    injectedText(output.parts).includes('pantheon_vision_vision_describe'),
    'undefined ids data → canonical default tool',
  )
})()

// ─── Test N4: native failure (500 / network error) → tool fallback ─────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  // HTTP 500
  const mock500 = installFetchMock(() => errResponse(500))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      const hooks = await makeHooks()
      const output = await runTurn(hooks, [imagePart()])
      assert.equal(output.parts.some(isImageFilePart), false, 'image removed')
      assert.ok(
        injectedText(output.parts).includes('pantheon_vision_vision_describe'),
        'tool fallback on HTTP 500',
      )
    })
  } finally {
    mock500.restore()
  }

  // network error (fetch rejects)
  const mockErr = installFetchMock(() => {
    throw new Error('ECONNREFUSED')
  })
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      const hooks = await makeHooks()
      const output = await runTurn(hooks, [imagePart()])
      assert.equal(output.parts.some(isImageFilePart), false, 'image removed')
      assert.ok(
        injectedText(output.parts).includes('pantheon_vision_vision_describe'),
        'tool fallback on network error',
      )
    })
  } finally {
    mockErr.restore()
  }
})()

// ─── Test N5: file:// read+converted; http kept in native payload ──────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const pngPath = join(tmpdir(), `pantheon-native-${Date.now()}.png`)
  writeFileSync(pngPath, Buffer.from('not-really-png-bytes'))

  // file:// → read bytes, converted to data URI
  const mockFile = installFetchMock(() => okJson('descrição do arquivo'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      const hooks = await makeHooks()
      await runTurn(hooks, [imagePart({ url: `file://${pngPath}` })])
    })
    assert.equal(mockFile.calls.length, 1, 'native call for file:// image')
    const filePayload = bodyOf(mockFile.calls[0]).messages[0].content[1].image_url.url
    assert.ok(filePayload.startsWith('data:image/png;base64,'), 'file:// converted to data URI')
    const expected = Buffer.from('not-really-png-bytes').toString('base64')
    assert.ok(filePayload.endsWith(expected), 'file bytes encoded in payload')
  } finally {
    mockFile.restore()
  }

  // http(s) → URL passed through unchanged
  const mockHttp = installFetchMock(() => okJson('descrição remota'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      const hooks = await makeHooks()
      await runTurn(hooks, [imagePart({ url: 'https://example.com/img.png' })])
    })
    assert.equal(mockHttp.calls.length, 1, 'native call for http image')
    const httpUrl = bodyOf(mockHttp.calls[0]).messages[0].content[1].image_url.url
    assert.equal(httpUrl, 'https://example.com/img.png', 'http URL kept as-is')
  } finally {
    mockHttp.restore()
  }

  rmSync(pngPath, { force: true })
})()

// ─── Test N6: mode 'tool' forces the tool pattern even with a key ──────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const mock = installFetchMock(() => {
    throw new Error('fetch must not be called in tool mode')
  })
  try {
    await withEnv('PANTHEON_VISION_MODE', 'tool', async () => {
      await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
        const hooks = await makeHooks()
        const output = await runTurn(hooks, [imagePart()])
        assert.equal(output.parts.some(isImageFilePart), false, 'image removed')
        assert.ok(
          injectedText(output.parts).includes('pantheon_vision_vision_describe'),
          'tool mode forces tool instruction',
        )
      })
    })
    assert.equal(mock.calls.length, 0, 'no native call in tool mode')
  } finally {
    mock.restore()
  }
})()

// ─── Test N7: no image → nothing changes (even with a key) ─────────────────

await (async () => {
  const mock = installFetchMock(() => {
    throw new Error('fetch must not be called without images')
  })
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      const hooks = await makeHooks()
      const parts = [textPart('normal turn')]
      const message = userMessage(parts)
      const output = { message, parts }
      await hooks['chat.message']({ sessionID: 'session-1', model: message.model }, output)
      assert.equal(output.parts, parts, 'same array reference')
      assert.equal(output.parts.length, 1, 'no parts added')
      assert.equal(output.parts[0].text, 'normal turn')
    })
    assert.equal(mock.calls.length, 0, 'no native call without images')
  } finally {
    mock.restore()
  }
})()

// ─── Test N8: auth store fallback (no env key) ─────────────────────────────
// A user connected via `opencode auth login` must NOT need to export anything:
// the plugin reads <data dir>/auth.json and uses the 'opencode-go' entry
// (preferred over 'opencode') when no env key is set.

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  clearAuthStore()
  writeAuthStore({
    'opencode-go': { access: 'auth-store-go-key', expires: 0 },
    opencode: { access: 'auth-store-zen-key', expires: 0 },
  })
  const mock = installFetchMock(() => okJson('descrição via auth store'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', undefined, async () => {
      await withEnv('OPENCODE_API_KEY', undefined, async () => {
        const hooks = await makeHooks()
        const output = await runTurn(hooks, [imagePart()])
        assert.equal(output.parts.some(isImageFilePart), false, 'image removed')
        assert.ok(
          injectedText(output.parts).includes('descrição via auth store'),
          'native description injected from auth-store key',
        )
      })
    })
    assert.equal(mock.calls.length, 1, 'one native call with auth-store key')
    assert.equal(
      mock.calls[0].options.headers.Authorization,
      'Bearer auth-store-go-key',
      'opencode-go auth entry preferred over opencode',
    )
  } finally {
    mock.restore()
    clearAuthStore()
  }
})()

// readOpencodeAuthToken unit: precedence, expiry, missing/corrupted file.

assert.equal(
  await readOpencodeAuthToken(['opencode-go', 'opencode'], authStoreDir),
  null,
  'missing auth.json → null (no crash)',
)

writeAuthStore({ 'opencode-go': { access: 'go-token' }, opencode: { access: 'zen-token' } })
assert.equal(
  await readOpencodeAuthToken(['opencode-go', 'opencode'], authStoreDir),
  'go-token',
  'first provider entry wins',
)
assert.equal(
  await readOpencodeAuthToken(['opencode'], authStoreDir),
  'zen-token',
  'second provider entry reachable when first missing',
)
writeAuthStore({
  'opencode-go': { access: 'expired-token', expires: 1 }, // epoch ms in the past
  opencode: { access: 'fresh-token', expires: 0 },
})
assert.equal(
  await readOpencodeAuthToken(['opencode-go', 'opencode'], authStoreDir),
  'fresh-token',
  'expired entry skipped, next non-expired used',
)
writeAuthStore({ 'opencode-go': { access: '   ' } })
assert.equal(
  await readOpencodeAuthToken(['opencode-go', 'opencode'], authStoreDir),
  null,
  'blank access token ignored',
)
writeAuthStore('this is not json {{')
assert.equal(
  await readOpencodeAuthToken(['opencode-go', 'opencode'], authStoreDir),
  null,
  'corrupted auth.json → null (no crash)',
)
clearAuthStore()

// ─── Test N9: env key wins over auth store ─────────────────────────────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  writeAuthStore({ 'opencode-go': { access: 'auth-store-go-key', expires: 0 } })
  const mock = installFetchMock(() => okJson('descrição via env key'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'env-key-wins', async () => {
      const hooks = await makeHooks()
      const output = await runTurn(hooks, [imagePart()])
      assert.equal(output.parts.some(isImageFilePart), false, 'image removed')
      assert.ok(
        injectedText(output.parts).includes('descrição via env key'),
        'native description injected from env key',
      )
    })
    assert.equal(mock.calls.length, 1, 'one native call')
    assert.equal(
      mock.calls[0].options.headers.Authorization,
      'Bearer env-key-wins',
      'env key beats auth store',
    )
  } finally {
    mock.restore()
    clearAuthStore()
  }
})()

// ─── Test N10: config file mode/visionModel precedence ─────────────────────
// mode: env PANTHEON_VISION_MODE > config `mode` > default auto.
// visionModel: env PANTHEON_VISION_MODEL > config `visionModel` > preset
// `vision.model` > default opcode-go/mimo-v2.5.

// getVisionMode with a config mode: env wins, then config, then auto.
assert.equal(getVisionMode({}, 'tool'), 'tool', 'config mode tool honored')
assert.equal(getVisionMode({}, 'auto'), 'auto', 'config mode auto')
assert.equal(getVisionMode({}, 'bogus'), 'auto', 'invalid config mode → auto')
assert.equal(
  getVisionMode({ PANTHEON_VISION_MODE: 'native' }, 'tool'),
  'native',
  'env mode wins over config mode',
)
assert.equal(
  getVisionMode({ PANTHEON_VISION_MODE: 'tool' }, 'native'),
  'tool',
  'env tool wins over config native',
)

// resolveNativeVisionConfig with configVisionModel param.
assert.equal(
  resolveNativeVisionConfig(null, { PANTHEON_OPENCODE_API_KEY: 'k' }, 'opencode-go/minimax-m3')
    ?.modelID,
  'opencode-go/minimax-m3',
  'config visionModel used',
)
assert.equal(
  resolveNativeVisionConfig(
    null,
    { PANTHEON_OPENCODE_API_KEY: 'k', PANTHEON_VISION_MODEL: 'opencode-go/mimo-v2.5' },
    'opencode-go/minimax-m3',
  )?.modelID,
  'opencode-go/mimo-v2.5',
  'env PANTHEON_VISION_MODEL beats config visionModel',
)
assert.equal(
  resolveNativeVisionConfig(
    { vision: { model: 'opencode-go/minimax-m3' } },
    { PANTHEON_OPENCODE_API_KEY: 'k' },
    'opencode-go/mimo-v2.5',
  )?.modelID,
  'opencode-go/mimo-v2.5',
  'config visionModel beats preset vision model',
)
assert.equal(
  resolveNativeVisionConfig(null, { PANTHEON_OPENCODE_API_KEY: 'k', PANTHEON_VISION_MODEL: '  ' })
    ?.modelID,
  'opencode-go/mimo-v2.5',
  'blank env PANTHEON_VISION_MODEL ignored → default',
)

// End-to-end: config file `mode: tool` forces tool pattern even with a key.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const cfgDir = makeTempDir()
  mkdirSync(join(cfgDir, '.opencode'), { recursive: true })
  writeFileSync(join(cfgDir, '.opencode', 'opencode-vision.json'), JSON.stringify({ mode: 'tool' }))
  const mock = installFetchMock(() => {
    throw new Error('fetch must not be called when config mode is tool')
  })
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      const hooks = await makeHooks({}, cfgDir)
      const output = await runTurn(hooks, [imagePart()])
      assert.equal(output.parts.some(isImageFilePart), false, 'image removed')
      assert.ok(
        injectedText(output.parts).includes('pantheon_vision_vision_describe'),
        'config mode tool forces tool instruction',
      )
    })
    assert.equal(mock.calls.length, 0, 'no native call in config-mode tool')
  } finally {
    mock.restore()
  }
})()

// End-to-end: config file `visionModel` used for the native call.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const cfgDir = makeTempDir()
  mkdirSync(join(cfgDir, '.opencode'), { recursive: true })
  writeFileSync(
    join(cfgDir, '.opencode', 'opencode-vision.json'),
    JSON.stringify({ visionModel: 'opencode-go/minimax-m3' }),
  )
  const mock = installFetchMock(() => okJson('descrição minimax'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      const hooks = await makeHooks({}, cfgDir)
      const output = await runTurn(hooks, [imagePart()])
      assert.equal(output.parts.some(isImageFilePart), false, 'image removed')
      assert.ok(
        injectedText(output.parts).includes('descrição minimax'),
        'native description injected',
      )
    })
    assert.equal(mock.calls.length, 1, 'one native call')
    assert.equal(
      bodyOf(mock.calls[0]).model,
      'minimax-m3',
      'config visionModel used (provider prefix stripped)',
    )
  } finally {
    mock.restore()
  }
})()

// End-to-end: env PANTHEON_VISION_MODEL beats config visionModel.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const cfgDir = makeTempDir()
  mkdirSync(join(cfgDir, '.opencode'), { recursive: true })
  writeFileSync(
    join(cfgDir, '.opencode', 'opencode-vision.json'),
    JSON.stringify({ visionModel: 'opencode-go/minimax-m3' }),
  )
  const mock = installFetchMock(() => okJson('descrição mimo'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-123', async () => {
      await withEnv('PANTHEON_VISION_MODEL', 'opencode-go/mimo-v2.5', async () => {
        const hooks = await makeHooks({}, cfgDir)
        const output = await runTurn(hooks, [imagePart()])
        assert.equal(output.parts.some(isImageFilePart), false, 'image removed')
        assert.ok(injectedText(output.parts).includes('descrição mimo'), 'description injected')
      })
    })
    assert.equal(mock.calls.length, 1, 'one native call')
    assert.equal(
      bodyOf(mock.calls[0]).model,
      'mimo-v2.5',
      'env PANTHEON_VISION_MODEL beats config visionModel (prefix stripped)',
    )
  } finally {
    mock.restore()
  }
})()

// ─── Melhoria 1: session description cache ─────────────────────────────────
// The native path caches the gateway's text answer per session, keyed by the
// user prompt + the sorted content hashes of every image. A cache hit must not
// call the gateway again; a new prompt about the same image must miss; the
// cache is cleared per session on session.idle / session.deleted.

// Constants: TTL default 30min, LRU cap default 200.
assert.equal(DESCRIPTION_CACHE_TTL_MS, 30 * 60 * 1000, 'description cache TTL defaults to 30min')
assert.equal(TEMP_MAX_FILES, 200, 'temp file LRU cap defaults to 200')

// buildDescriptionCacheKey: prompt + content hashes, order-insensitive,
// deterministic, content-sensitive.
{
  const p1 = { url: 'data:image/png;base64,ZmFrZQ==' }
  const p2 = { url: 'data:image/png;base64,YWJjZA==' }
  assert.equal(
    buildDescriptionCacheKey('pergunta A', [p1, p2]),
    buildDescriptionCacheKey('pergunta A', [p2, p1]),
    'image order-insensitive (sorted hashes)',
  )
  assert.notEqual(
    buildDescriptionCacheKey('pergunta A', [p1]),
    buildDescriptionCacheKey('pergunta B', [p1]),
    'different prompt → different key (no stale analysis for a new question)',
  )
  assert.notEqual(
    buildDescriptionCacheKey('pergunta A', [p1]),
    buildDescriptionCacheKey('pergunta A', [p2]),
    'different image content → different key',
  )
  assert.equal(
    buildDescriptionCacheKey('pergunta A', [p1]),
    buildDescriptionCacheKey('pergunta A', [p1]),
    'same prompt + same images → same key (deterministic)',
  )
  assert.match(
    buildDescriptionCacheKey('pergunta A', [p1, p2]),
    /^[0-9a-f]{64}(:[0-9a-f]{64}){2}$/,
    'key is colon-joined sha256 hashes (prompt + one per image)',
  )
}

// getCachedDescription / setCachedDescription: hit within TTL, miss on expiry.
{
  const cache = new Map()
  assert.equal(getCachedDescription(cache, 'k'), null, 'miss → null')
  setCachedDescription(cache, 'k', 'descrição', 1_000)
  assert.equal(
    getCachedDescription(cache, 'k', 1_000 + 29_999, 30_000),
    'descrição',
    'hit within TTL',
  )
  assert.equal(
    getCachedDescription(cache, 'k', 1_000 + 30_000, 30_000),
    null,
    'expired at the TTL boundary → null (re-call)',
  )
}

// Integration: hit reuses the stored description WITHOUT a new gateway call;
// a new prompt about the same image misses and re-calls.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const mock = installFetchMock(() => okJson('descrição cacheada'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-cache', async () => {
      const hooks = await makeHooks()
      // turn 1: miss → one gateway call, description stored.
      const out1 = await runTurn(
        hooks,
        [imagePart(), textPart('pergunta A')],
        undefined,
        'session-cache',
      )
      assert.ok(
        injectedText(out1.parts).includes('descrição cacheada'),
        'native description injected on miss',
      )
      assert.equal(mock.calls.length, 1, 'first turn calls the gateway')
      // turn 2: same prompt + same image → cache hit, no new call.
      const out2 = await runTurn(
        hooks,
        [imagePart(), textPart('pergunta A')],
        undefined,
        'session-cache',
      )
      assert.equal(mock.calls.length, 1, 'cache hit skips the gateway')
      assert.ok(
        injectedText(out2.parts).includes('descrição cacheada'),
        'cached description reused',
      )
      // turn 3: same image, NEW prompt → different key → miss → new call.
      const out3 = await runTurn(
        hooks,
        [imagePart(), textPart('pergunta B')],
        undefined,
        'session-cache',
      )
      assert.equal(mock.calls.length, 2, 'new prompt about the same image re-calls')
      assert.ok(injectedText(out3.parts).includes('descrição cacheada'))
    })
  } finally {
    mock.restore()
  }
})()

// Integration: session.idle clears the session cache → the next same turn
// misses and calls the gateway again.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const mock = installFetchMock(() => okJson('descrição pós-idle'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-idle', async () => {
      const hooks = await makeHooks()
      await runTurn(hooks, [imagePart(), textPart('pergunta A')], undefined, 'session-cache-idle')
      assert.equal(mock.calls.length, 1)
      await runTurn(hooks, [imagePart(), textPart('pergunta A')], undefined, 'session-cache-idle')
      assert.equal(mock.calls.length, 1, 'hit before idle')
      await hooks.event({
        event: { type: 'session.idle', properties: { sessionID: 'session-cache-idle' } },
      })
      await runTurn(hooks, [imagePart(), textPart('pergunta A')], undefined, 'session-cache-idle')
      assert.equal(mock.calls.length, 2, 'idle clears the session description cache')
    })
  } finally {
    mock.restore()
  }
})()

// Cleanup unit: the description cache is dropped per session, others survive.
await (async () => {
  const descCache = new Map([['s1', new Map([['k', { text: 'x', storedAt: 1 }]])]])
  await cleanupSessionTempImages(
    new Map(),
    new Map(),
    new Set(),
    's1',
    TEMP_FILE_GRACE_MS,
    descCache,
  )
  assert.equal(descCache.has('s1'), false, 'idle deletes the session description cache')
  const two = new Map([
    ['s1', new Map([['k', { text: 'a', storedAt: 1 }]])],
    ['s2', new Map([['k', { text: 'b', storedAt: 1 }]])],
  ])
  await cleanupSessionTempImages(new Map(), new Map(), new Set(), 's1', 0, two)
  assert.equal(two.has('s1'), false, 'deleted session cache dropped')
  assert.equal(two.has('s2'), true, 'other session cache survives')
})()

// Integration: session.deleted unlinks the session's temp images and drops
// the session description cache (session gone for good → no grace period).
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
  const mock = installFetchMock(() => okJson('descrição antes do delete'))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-del', async () => {
      const hooks = await makeHooks()
      await runTurn(hooks, [imagePart(), textPart('pergunta A')], undefined, 'session-deleted-e2e')
      assert.equal(mock.calls.length, 1, 'first turn calls the gateway')
      const files = readdirSync(VISION_DIR)
      assert.equal(files.length, 1, 'temp image saved')
      await hooks.event({
        event: {
          type: 'session.deleted',
          properties: {
            info: {
              id: 'session-deleted-e2e',
              projectID: 'p',
              directory: '/tmp',
              title: 't',
              version: '1',
              time: { created: 0, updated: 0 },
            },
          },
        },
      })
      assert.equal(
        existsSync(join(VISION_DIR, files[0])),
        false,
        'session.deleted unlinks the temp image immediately',
      )
      await runTurn(hooks, [imagePart(), textPart('pergunta A')], undefined, 'session-deleted-e2e')
      assert.equal(mock.calls.length, 2, 'session.deleted cleared the description cache')
    })
  } finally {
    mock.restore()
  }
})()

// ─── Melhoria 2: content-hash filenames + LRU temp cap ─────────────────────
// saveDataUrlImage names files by sha256(content) instead of randomUUID, so
// identical re-pasted images reuse one file. A global LRU (cap TEMP_MAX_FILES)
// unlinks the least-recently-used files beyond the cap, but never a young file
// (TEMP_FILE_GRACE_MS) and never the directory itself.

// P1-2: temp images are PRIVATE — screenshots may hold sensitive content.
// The dir must be 0700 and the file 0600 EVEN under a permissive umask
// (chmod is applied after creation precisely to beat the umask).
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
  const path = await saveDataUrlImage('data:image/png;base64,ZmFrZQ==', 'image/png')
  assert.ok(path, 'temp file saved')
  const dirMode = statSync(VISION_DIR).mode & 0o777
  const fileMode = statSync(path).mode & 0o777
  assert.equal(dirMode, 0o700, `temp dir must be 0700 (got 0${dirMode.toString(8)})`)
  assert.equal(fileMode, 0o600, `temp file must be 0600 (got 0${fileMode.toString(8)})`)
  // A second save (dedup path) must not loosen permissions either.
  const again = await saveDataUrlImage('data:image/png;base64,ZmFrZQ==', 'image/png')
  assert.equal(again, path, 'dedup reuses the same file')
  assert.equal(
    statSync(path).mode & 0o777,
    0o600,
    'existing temp file stays 0600 after re-save',
  )
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
})()

// Dedup + extension + sha256 filename shape.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
  const urlA = 'data:image/png;base64,ZmFrZQ==' // bytes: fake
  const urlB = 'data:image/png;base64,YWJjZA==' // bytes: abcd
  const pathA1 = await saveDataUrlImage(urlA, 'image/png')
  const pathA2 = await saveDataUrlImage(urlA, 'image/png')
  const pathB = await saveDataUrlImage(urlB, 'image/png')
  assert.equal(pathA1, pathA2, 'identical content → same path (dedup)')
  assert.notEqual(pathA1, pathB, 'different content → different path')
  assert.ok(pathA1.startsWith(join(VISION_DIR, '')), 'saved under /tmp/pantheon-vision/')
  assert.match(basename(pathA1), /^[0-9a-f]{64}\.png$/, 'sha256 hex + correct extension')
  const jpg = await saveDataUrlImage(urlA, 'image/jpeg')
  assert.match(basename(jpg), /^[0-9a-f]{64}\.jpg$/, 'jpeg mime keeps .jpg extension')
  assert.equal(readdirSync(VISION_DIR).length, 3, 'one file per distinct content+mime')
  assert.ok(
    basename(pathA1).startsWith(hashContent(Buffer.from('fake'))),
    'file name is the content sha256',
  )
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
})()

// LRU: beyond the cap the oldest old files are evicted, young files survive.
await (async () => {
  tempFileLRU.clear()
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-lru-'))
  const now = Date.now()
  const make = (name, touchedAt) => {
    const p = join(dir, name)
    writeFileSync(p, name)
    touchTempFile(p, touchedAt)
    return p
  }
  const old1 = make('old1.png', now - TEMP_FILE_GRACE_MS - 10_000)
  const old2 = make('old2.png', now - TEMP_FILE_GRACE_MS - 9_000)
  const young = make('young.png', now)
  const old3 = make('old3.png', now - TEMP_FILE_GRACE_MS - 8_000)
  const evicted = await enforceTempFileCap(2, TEMP_FILE_GRACE_MS, now)
  assert.equal(evicted, 2, 'two oldest files evicted beyond the cap')
  assert.equal(existsSync(old1), false, 'oldest evicted')
  assert.equal(existsSync(old2), false, 'second oldest evicted')
  assert.equal(existsSync(young), true, 'young file survives LRU (grace period)')
  assert.equal(existsSync(old3), true, 'newer old file kept (within cap)')
  assert.equal(tempFileLRU.size, 2, 'LRU trimmed to the cap')
  assert.equal(existsSync(dir), true, 'LRU never removes the directory')
  rmSync(dir, { recursive: true, force: true })
  tempFileLRU.clear()
})()

// Grace: all-young over cap → nothing evicted, directory intact.
await (async () => {
  tempFileLRU.clear()
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-lru-grace-'))
  const now = Date.now()
  for (const name of ['a.png', 'b.png', 'c.png']) {
    writeFileSync(join(dir, name), name)
    touchTempFile(join(dir, name), now)
  }
  const evicted = await enforceTempFileCap(1, TEMP_FILE_GRACE_MS, now)
  assert.equal(evicted, 0, 'young files never evicted even over cap')
  for (const name of ['a.png', 'b.png', 'c.png']) {
    assert.equal(existsSync(join(dir, name)), true, `${name} survives`)
  }
  assert.equal(existsSync(dir), true, 'no rm -rf of the temp dir')
  rmSync(dir, { recursive: true, force: true })
  tempFileLRU.clear()
})()

// Integration: identical image re-pasted in a session reuses the same path.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
  const hooks = await makeHooks()
  const out1 = await runTurn(hooks, [imagePart(), textPart('primeiro')], undefined, 'session-dedup')
  const out2 = await runTurn(hooks, [imagePart(), textPart('segundo')], undefined, 'session-dedup')
  const files = readdirSync(VISION_DIR)
  assert.equal(files.length, 1, 'identical re-pasted image produces one temp file')
  const path = join(VISION_DIR, files[0])
  assert.ok(injectedText(out1.parts).includes(path), 'first injection uses the hash path')
  assert.ok(injectedText(out2.parts).includes(path), 'second injection reuses the same path')
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
})()

// ─── Melhoria 3: intenção do prompt + resposta estruturada ─────────────────
// Prompt calibrado por intenção (compare/ocr/reconstruct/bugs/describe) e
// resposta estruturada <item>/<description>/<context> com escaping XML, com
// fallback para descrição única quando o parse falha.

// escapeXml: & < > → entidades, na ordem certa (& primeiro).
assert.equal(escapeXml('a & b < c > d'), 'a &amp; b &lt; c &gt; d')
assert.equal(escapeXml('&amp;'), '&amp;amp;', '& escapado primeiro')
assert.equal(escapeXml('sem especiais'), 'sem especiais')

// detectVisionIntent: categorias por termos PT/EN, prioridade compare.
// compare exige 2+ imagens; demais categorias funcionam com 1 imagem.
const intentCases = [
  // [imageCount, userText, expected]
  [2, 'compare estas duas imagens', 'compare'],
  [2, 'comparar A e B', 'compare'],
  [2, 'qual é melhor?', 'compare'],
  [2, 'which is better?', 'compare'],
  [2, 'gatos vs cachorros', 'compare'],
  [2, 'versus', 'compare'],
  [2, 'qual é a diferença', 'compare'],
  [1, 'qual é melhor?', 'describe'], // compare exige 2+ imagens
  [1, 'extraia o texto', 'ocr'],
  [1, 'read the text', 'ocr'],
  [1, 'transcreva', 'ocr'],
  [1, 'OCR da imagem', 'ocr'],
  [1, 'extrair dados', 'ocr'],
  [1, 'implemente este código', 'reconstruct'],
  [1, 'reconstrua a tela em html', 'reconstruct'],
  [1, 'build the UI', 'reconstruct'],
  [1, 'component css', 'reconstruct'],
  [1, 'screen de login', 'reconstruct'],
  [1, 'tem um bug aqui', 'bugs'],
  [1, 'não funciona', 'bugs'],
  [1, 'debug this', 'bugs'],
  [1, 'qual o problema?', 'bugs'],
  [1, 'erro ao renderizar', 'bugs'],
  [1, '', 'describe'],
  [1, 'descreva a imagem', 'describe'],
  // Prioridade: compare vence ocr/reconstruct/bugs quando há 2+ imagens.
  [2, 'compare o texto extraído', 'compare'],
  [2, 'comparar o código', 'compare'],
  [2, 'compare este bug', 'compare'],
]
for (const [count, text, expected] of intentCases) {
  assert.equal(
    detectVisionIntent(text, count),
    expected,
    `intent(${JSON.stringify(text)}, ${count})`,
  )
}

// buildNativeVisionPrompt: formato estruturado por intenção + escaping XML.
{
  const describe = buildNativeVisionPrompt('o que é isso?', 1)
  assert.ok(describe.includes('<item id="1">'), 'template instrui bloco <item id="1">')
  assert.ok(describe.includes('<description>'), 'template instrui <description>')
  assert.ok(describe.includes('&amp;'), 'template instrui escaping de &')
  assert.ok(describe.includes('&lt;'), 'template instrui escaping de <')
  assert.ok(describe.includes('&gt;'), 'template instrui escaping de >')
  assert.ok(describe.includes('o que é isso?'), 'user text presente no template')
  assert.ok(!describe.includes('Depois dos itens'), 'describe não pede análise cruzada')

  const compare = buildNativeVisionPrompt('compare A e B', 2)
  assert.ok(compare.includes('<context>'), 'compare pede <context> com análise cruzada')
  assert.ok(compare.includes('2 imagens'), 'multi-imagem: count no template')

  const three = buildNativeVisionPrompt('', 3)
  assert.ok(
    three.includes('3 imagens') && three.includes('N = 1..3'),
    'N blocos <item> para N imagens',
  )

  const ocr = buildNativeVisionPrompt('', 1, 'ocr')
  assert.ok(ocr.includes('Transcreva literalmente'), 'ocr instrui transcrição literal')

  const reconstruct = buildNativeVisionPrompt('', 1, 'reconstruct')
  assert.ok(reconstruct.includes('reconstrução'), 'reconstruct instrui descrição estrutural')

  const bugs = buildNativeVisionPrompt('', 1, 'bugs')
  assert.ok(bugs.includes('sintoma'), 'bugs instrui descrição do sintoma')

  // escaping do texto do usuário interpolado no template
  const escaped = buildNativeVisionPrompt('x & y <z> >', 1)
  assert.ok(escaped.includes('x &amp; y &lt;z&gt; &gt;'), '& < > escapados no user text')
  assert.ok(!escaped.includes('x & y <z>'), 'user text cru não vaza no template')
  assert.ok(
    buildNativeVisionPrompt('', 1).includes('sem pedido explícito'),
    'user text vazio → placeholder',
  )
}

// parseStructuredVisionResponse: extrai <item>/<description>/<context>.
{
  const parsed = parseStructuredVisionResponse(
    '<item id="1"><description>Um gato laranja.</description></item>' +
      '<item id="2"><description>Um cachorro preto.</description></item>' +
      '<context>O gato é menor que o cachorro.</context>',
  )
  assert.equal(parsed.items.length, 2, 'dois itens extraídos')
  assert.equal(parsed.items[0].id, 1)
  assert.equal(parsed.items[0].description, 'Um gato laranja.')
  assert.equal(parsed.items[1].id, 2)
  assert.equal(parsed.items[1].description, 'Um cachorro preto.')
  assert.equal(parsed.context, 'O gato é menor que o cachorro.')

  // variações: espaços, aspas, multiline, id sem aspas, Item maiúsculo
  const relaxed = parseStructuredVisionResponse(
    '<Item id = 2>\n  <description>\n    linha 1\n    linha 2\n  </description>\n</Item>',
  )
  assert.equal(relaxed.items.length, 1, 'variação de formatação tolerada')
  assert.equal(relaxed.items[0].id, 2, 'id sem aspas parseado')
  assert.equal(relaxed.items[0].description, 'linha 1\n    linha 2', 'corpo multiline trimado')
  assert.equal(relaxed.context, null, 'sem <context> → null')

  // escaping nos corpos é desescapado para o modelo principal
  const escaped = parseStructuredVisionResponse(
    '<item id="1"><description>a &lt;b&gt; &amp; c</description></item>',
  )
  assert.equal(escaped.items[0].description, 'a <b> & c', 'entidades XML desescapadas')

  // item sem id → id sequencial
  const noId = parseStructuredVisionResponse('<item><description>sem id</description></item>')
  assert.equal(noId.items[0].id, 1, 'item sem id ganha id sequencial')

  // <description> solto sem <item> → ainda parseado em ordem
  const bare = parseStructuredVisionResponse('<description>só isso</description>')
  assert.equal(bare.items.length, 1, 'description solto parseado')
  assert.equal(bare.items[0].description, 'só isso')

  // resposta sem tags → null (fallback para descrição única, sem quebrar turno)
  assert.equal(parseStructuredVisionResponse('Uma foto de um gato.'), null)
  assert.equal(parseStructuredVisionResponse(''), null)
  assert.equal(parseStructuredVisionResponse('texto sem nenhuma tag'), null)
}

// buildStructuredInjection: mapeia <item id> para a imagem correspondente.
{
  const injection = buildStructuredInjection(
    [
      { id: 1, description: 'Gráfico de barras.' },
      { id: 2, description: 'Tabela de vendas.' },
    ],
    'O gráfico corresponde à tabela.',
    'compare os dois',
    'opencode-go/mimo-v2.5',
    2,
  )
  assert.ok(injection.includes('Image 1: Gráfico de barras.'), 'item 1 mapeado para Image 1')
  assert.ok(injection.includes('Image 2: Tabela de vendas.'), 'item 2 mapeado para Image 2')
  assert.ok(injection.includes('Cross-image context:'), 'seção de contexto presente')
  assert.ok(injection.includes('O gráfico corresponde à tabela.'), 'contexto incluído')
  assert.ok(injection.includes("User's request: compare os dois"), 'user text presente')
  assert.ok(injection.includes('opencode-go/mimo-v2.5'), 'model ID presente')

  // id ausente → fallback posicional; sem context → seção omitida
  const partial = buildStructuredInjection(
    [{ id: 1, description: 'Só a primeira.' }],
    null,
    '',
    'mimo-v2.5',
    2,
  )
  assert.ok(partial.includes('Image 1: Só a primeira.'), 'item 1 usado')
  assert.ok(partial.includes('Image 2: (no description provided)'), 'imagem sem item → placeholder')
  assert.ok(!partial.includes('Cross-image context:'), 'sem contexto → seção omitida')
}

// Integração: resposta estruturada do gateway → descrições por imagem no turno;
// cache reutiliza o texto estruturado e o re-parse (sem nova chamada).
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const structured =
    '<item id="1"><description>Painel com botão azul.</description></item>' +
    '<item id="2"><description>Formulário de login.</description></item>' +
    '<context>Ambos são componentes da mesma tela.</context>'
  const mock = installFetchMock(() => okJson(structured))
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-structured', async () => {
      const hooks = await makeHooks()
      // 'compare as telas' + 2 imagens → intent compare + 2 blocos <item>
      const out1 = await runTurn(
        hooks,
        [imagePart({ id: 'img-a' }), imagePart({ id: 'img-b' }), textPart('compare as telas')],
        undefined,
        'session-structured',
      )
      const injected = injectedText(out1.parts)
      assert.ok(injected.includes('Image 1: Painel com botão azul.'), 'item 1 na injeção')
      assert.ok(injected.includes('Image 2: Formulário de login.'), 'item 2 na injeção')
      assert.ok(injected.includes('Ambos são componentes da mesma tela.'), 'context na injeção')
      assert.ok(injected.includes('compare as telas'), 'user text na injeção')
      assert.ok(!injected.includes('mcp__'), 'sem instrução de tool no sucesso nativo')
      assert.equal(mock.calls.length, 1, 'primeiro turno chama o gateway')

      // mesmo prompt + mesmas imagens → cache hit, re-parse do texto estruturado
      const out2 = await runTurn(
        hooks,
        [imagePart({ id: 'img-a' }), imagePart({ id: 'img-b' }), textPart('compare as telas')],
        undefined,
        'session-structured',
      )
      assert.equal(mock.calls.length, 1, 'cache hit reutiliza o texto estruturado')
      assert.ok(
        injectedText(out2.parts).includes('Image 1: Painel com botão azul.'),
        're-parse do texto estruturado cacheado',
      )
    })
  } finally {
    mock.restore()
  }
})()

// Integração: intent ocr → o prompt enviado ao gateway é calibrado.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const mock = installFetchMock(() =>
    okJson('<item id="1"><description>Texto: Olá, mundo!</description></item>'),
  )
  try {
    await withEnv('PANTHEON_OPENCODE_API_KEY', 'test-key-ocr', async () => {
      const hooks = await makeHooks()
      await runTurn(hooks, [imagePart(), textPart('transcreva o texto')], undefined, 'session-ocr')
    })
    assert.equal(mock.calls.length, 1, 'uma chamada nativa')
    const promptText = bodyOf(mock.calls[0]).messages[0].content[0].text
    assert.ok(promptText.includes('Transcreva literalmente'), 'prompt calibrado para ocr')
    assert.ok(promptText.includes('<item id="1">'), 'formato estruturado no prompt enviado')
    assert.ok(promptText.includes('transcreva o texto'), 'user text no prompt enviado')
  } finally {
    mock.restore()
  }
})()

// ─── Teardown ──────────────────────────────────────────────────────────────

rmSync(VISION_DIR, { recursive: true, force: true })
tempFileLRU.clear()
for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
rmSync(homeDir, { recursive: true, force: true })
if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
else process.env.XDG_CONFIG_HOME = previousXdg
if (previousHome === undefined) delete process.env.HOME
else process.env.HOME = previousHome
if (previousOpenCodeKey === undefined) delete process.env.PANTHEON_OPENCODE_API_KEY
else process.env.PANTHEON_OPENCODE_API_KEY = previousOpenCodeKey
if (previousOaiKey === undefined) delete process.env.OPENCODE_API_KEY
else process.env.OPENCODE_API_KEY = previousOaiKey
if (previousMode === undefined) delete process.env.PANTHEON_VISION_MODE
else process.env.PANTHEON_VISION_MODE = previousMode
if (previousVisionModel === undefined) delete process.env.PANTHEON_VISION_MODEL
else process.env.PANTHEON_VISION_MODEL = previousVisionModel

console.log('✅ vision-tool plugin tests passed')
