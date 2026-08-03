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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const {
  default: plugin,
  generateInjectionPrompt,
  generateNativeInjection,
  getVisionMode,
  isImageFilePart,
  matchesModelPattern,
  matchesWildcardPattern,
  modelMatchesAnyPattern,
  readOpencodeAuthToken,
  resolveNativeVisionConfig,
} = await import('../src/plugin.ts')

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

// Prompt template default uses the tool name, path and user text.
const defaultPrompt = generateInjectionPrompt(
  [{ path: '/tmp/x.png' }],
  'o que é isso?',
  'mcp__pantheon-vision__vision_describe',
)
assert.ok(defaultPrompt.includes('/tmp/x.png'))
assert.ok(defaultPrompt.includes('mcp__pantheon-vision__vision_describe'))
assert.ok(defaultPrompt.includes('o que é isso?'))

// ─── Test 1: data: URI → saved to /tmp/pantheon-vision + injected TextPart ──

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const hooks = await makeHooks()
  const output = await runTurn(hooks, [imagePart(), textPart('Analise a imagem')])

  assert.equal(output.parts.some(isImageFilePart), false, 'image file parts removed')
  const injected = injectedText(output.parts)
  assert.ok(injected.includes('mcp__pantheon-vision__vision_describe'), 'tool name in injection')
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
  assert.ok(
    transformed.messages[0].parts.some(
      (part) => part.type === 'text' && part.text.includes('mcp__pantheon-vision__vision_describe'),
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
})()

// ─── Test 6: tool name from env / config / dynamic detection / default ─────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })

  // default (no env, no config, no tool.ids)
  const hooksDefault = await makeHooks()
  const outDefault = await runTurn(hooksDefault, [imagePart()])
  assert.ok(
    injectedText(outDefault.parts).includes('mcp__pantheon-vision__vision_describe'),
    'default tool name used',
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

  // dynamic detection via client.tool.ids — prefer describe_image
  const hooksDyn = await makeHooks({
    tool: {
      ids: async () => ({
        data: ['mcp__other__vision', 'mcp__pantheon-vision__vision_describe'],
      }),
    },
  })
  const outDyn = await runTurn(hooksDyn, [imagePart()])
  assert.ok(
    injectedText(outDyn.parts).includes('mcp__pantheon-vision__vision_describe'),
    'dynamic detection picks describe_image',
  )
})()

// ─── Test 7: session.idle cleanup removes /tmp/pantheon-vision ─────────────

await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  const hooks = await makeHooks()
  await runTurn(hooks, [imagePart()])
  assert.equal(existsSync(VISION_DIR), true, 'temp dir created on data: save')
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'session-1' } } })
  assert.equal(existsSync(VISION_DIR), false, 'temp dir removed on session.idle')
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
  assert.ok(injected.includes('mcp__pantheon-vision__vision_describe'), 'tool variable rendered')
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
    assert.equal(body.model, 'opencode-go/mimo-v2.5', 'default vision model')
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
        injected.includes('mcp__pantheon-vision__vision_describe'),
        'tool instruction without key',
      )
      assert.ok(injected.includes(VISION_DIR), 'temp path in tool instruction')
    })
    assert.equal(mock.calls.length, 0, 'no native call without key')
  } finally {
    mock.restore()
  }
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
        injectedText(output.parts).includes('mcp__pantheon-vision__vision_describe'),
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
        injectedText(output.parts).includes('mcp__pantheon-vision__vision_describe'),
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
          injectedText(output.parts).includes('mcp__pantheon-vision__vision_describe'),
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
        injectedText(output.parts).includes('mcp__pantheon-vision__vision_describe'),
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
    assert.equal(bodyOf(mock.calls[0]).model, 'opencode-go/minimax-m3', 'config visionModel used')
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
      'opencode-go/mimo-v2.5',
      'env PANTHEON_VISION_MODEL beats config visionModel',
    )
  } finally {
    mock.restore()
  }
})()

// ─── Teardown ──────────────────────────────────────────────────────────────

rmSync(VISION_DIR, { recursive: true, force: true })
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
