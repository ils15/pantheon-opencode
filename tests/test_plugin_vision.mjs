/**
 * Vision module tests — the shared vision surface in `src/pantheon/vision.ts`:
 *  - image/intent detection and prompt-building helpers (pure units);
 *  - the NATIVE describe path (`describeImagesNative`) against a mocked Zen
 *    endpoint, including auth resolution (env key, auth.json store, the V2
 *    SQLite credential db) and failure classification;
 *  - temp-image persistence (permissions, dedup, atomic write, LRU, cleanup).
 *
 * The 2.0 cycle removed the V1 plugin (`src/plugin.ts`), so the end-to-end
 * `chat.message` hook blocks that drove the V1 plugin factory are gone; the V2
 * plugin's own vision surface is covered by tests/pantheon/plugin-v2-*.test.ts.
 *
 * Run: node tests/test_plugin_vision.mjs
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { mock } from 'node:test'

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
  buildOrientationHint,
  buildStructuredInjection,
  cleanupSessionTempImages,
  computeNativeTimeoutMs,
  DESCRIPTION_CACHE_TTL_MS,
  describeImagesNative,
  detectVisionIntent,
  enforceTempFileCap,
  escapeXml,
  generateInjectionPrompt,
  generateNativeInjection,
  getCachedDescription,
  getVisionMode,
  hashContent,
  isImageFilePart,
  isZenNativeTarget,
  matchesModelPattern,
  matchesWildcardPattern,
  modelAcceptsImages,
  modelMatchesAnyPattern,
  nativeVisionFailureMessage,
  PROVIDERS_CACHE_TTL_MS,
  parseStructuredVisionResponse,
  payloadOrientation,
  providerIsTextOnly,
  readExifOrientation,
  readOpencodeAuthToken,
  resolveNativeVisionConfig,
  resolveNativeVisionTarget,
  saveDataUrlImage,
  setCachedDescription,
  stripProviderPrefix,
  TEMP_FILE_GRACE_MS,
  TEMP_MAX_FILES,
  tempFileLRU,
  touchTempFile,
  writeTempImageSync,
} from '../src/pantheon/vision.ts'

const VISION_DIR = join(tmpdir(), 'pantheon-vision')
const previousXdg = process.env.XDG_CONFIG_HOME
const xdgDir = mkdtempSync(join(tmpdir(), 'pantheon-xdg-'))
process.env.XDG_CONFIG_HOME = xdgDir
// Hermetic: the default auth-store/data dir honors XDG_DATA_HOME. Clear it so
// the hermetic HOME below is the only data root the auth-store tests pick up.
const previousDataHome = process.env.XDG_DATA_HOME
delete process.env.XDG_DATA_HOME
// Hermetic HOME: isolate the opencode auth store default path
// (~/.local/share/opencode/auth.json) so auth-store tests never touch the
// developer's real `opencode auth login` credentials.
const previousHome = process.env.HOME
const homeDir = mkdtempSync(join(tmpdir(), 'pantheon-home-'))
process.env.HOME = homeDir
// Hermetic: keep the module-level credential resolution independent of the
// developer's shell (tests pass explicit env/key values).
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

// node:sqlite backs the OpenCode V2 credential store; the production read is
// best-effort, so these cases are skipped when the builtin is unavailable.
const require = createRequire(import.meta.url)
let sqliteAvailable = true
try {
  require('node:sqlite')
} catch {
  sqliteAvailable = false
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

// Template-injection safety (Fase 2, explicit): variable literals inside the
// user's text are DATA, never re-expanded — `{userText}` is substituted last
// and the replacement value is never re-scanned (single-pass expansion).
const injectionProbe = generateInjectionPrompt(
  [{ path: '/tmp/x.png' }],
  'veja {imageList} e {toolName} e {userText}',
  'pantheon_vision_vision_describe',
)
assert.ok(
  injectionProbe.includes('veja {imageList} e {toolName} e {userText}'),
  'variable literals in userText stay verbatim',
)
assert.equal(
  injectionProbe.split('/tmp/x.png').length - 1,
  1,
  '{imageList} in userText is not re-expanded (image path appears once)',
)
assert.equal(
  injectionProbe.split('pantheon_vision_vision_describe').length - 1,
  1,
  '{toolName} in userText is not re-expanded (tool name appears once)',
)

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

// ─── Zen-only session header (x-opencode-session) ──────────────────────────
// The Zen gateway rejects a sessionless request (HTTP 400 MissingSessionID),
// so a Zen target with a session id carries the header; a non-Zen provider
// NEVER does (no cross-provider session leak).

assert.equal(
  isZenNativeTarget({ modelID: 'opencode-go/mimo-v2.5', baseURL: 'https://opencode.ai/zen/go/v1' }),
  true,
  'opencode-go + zen/go is a Zen target',
)
assert.equal(
  isZenNativeTarget({ modelID: 'opencode/mimo-v2.5', baseURL: 'https://opencode.ai/zen/v1' }),
  true,
  'opencode + zen/v1 is a Zen target',
)
assert.equal(
  isZenNativeTarget({
    modelID: 'anthropic/claude-sonnet',
    baseURL: 'https://opencode.ai/zen/v1',
  }),
  false,
  'a non-Zen provider is never a Zen target even on a Zen URL',
)
assert.equal(
  isZenNativeTarget({ modelID: 'opencode-go/mimo-v2.5', baseURL: 'https://evil.test/v1' }),
  false,
  'a non-Zen URL is never a Zen target even for a Zen provider',
)

await (async () => {
  // Zen target WITH a session id → header present.
  const zenMock = installFetchMock(() => okJson('descrição zen'))
  try {
    const zenTarget = {
      modelID: 'opencode-go/mimo-v2.5',
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: 'k',
      sessionID: 'session-zen',
    }
    const text = await describeImagesNative([{ url: 'data:image/png;base64,ZmFrZQ==' }], zenTarget)
    assert.equal(text, 'descrição zen')
    assert.equal(
      zenMock.calls[0].options.headers['x-opencode-session'],
      'session-zen',
      'x-opencode-session present on a Zen request',
    )
  } finally {
    zenMock.restore()
  }

  // Zen target WITHOUT a session id → header absent (no fabricated id).
  const noSessionMock = installFetchMock(() => okJson('descrição sem sessão'))
  try {
    await describeImagesNative([{ url: 'data:image/png;base64,ZmFrZQ==' }], {
      modelID: 'opencode-go/mimo-v2.5',
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: 'k',
    })
    assert.equal(
      'x-opencode-session' in noSessionMock.calls[0].options.headers,
      false,
      'no header when no session id is available',
    )
  } finally {
    noSessionMock.restore()
  }

  // NON-Zen target WITH a session id → header absent (never leaks the session).
  const nonZenMock = installFetchMock(() => okJson('descrição local'))
  try {
    await describeImagesNative([{ url: 'data:image/png;base64,ZmFrZQ==' }], {
      modelID: 'anthropic/claude-sonnet',
      baseURL: 'https://api.anthropic.test/v1',
      apiKey: 'k',
      sessionID: 'session-secret',
    })
    assert.equal(
      'x-opencode-session' in nonZenMock.calls[0].options.headers,
      false,
      'x-opencode-session never sent to a non-Zen provider',
    )
  } finally {
    nonZenMock.restore()
  }
})()

// ─── Failure mapping (400 MissingSessionID / 403 / finish_reason) ──────────
assert.match(nativeVisionFailureMessage({ reason: 'http', status: 400 }, 'x/y'), /HTTP 400/)
assert.match(nativeVisionFailureMessage({ reason: 'http', status: 400 }, 'x/y'), /MissingSessionID/)
assert.match(nativeVisionFailureMessage({ reason: 'http', status: 403 }, 'x/y'), /HTTP 403/)
assert.match(nativeVisionFailureMessage({ reason: 'http', status: 403 }, 'x/y'), /free-tier/)
assert.match(nativeVisionFailureMessage({ reason: 'http', status: 401 }, 'x/y'), /HTTP 401/)
assert.match(
  nativeVisionFailureMessage({ reason: 'empty', finishReason: 'length' }, 'x/y'),
  /finish_reason: length/,
)
assert.match(
  nativeVisionFailureMessage({ reason: 'empty', finishReason: 'length' }, 'x/y'),
  /max_tokens/,
)
assert.match(nativeVisionFailureMessage({ reason: 'network' }, 'x/y'), /network/i)
assert.match(
  nativeVisionFailureMessage({ reason: 'timeout', timeoutMs: 60_000 }, 'x/y'),
  /timed out after 60s/,
)
assert.match(nativeVisionFailureMessage({ reason: 'timeout' }, 'x/y'), /timed out/i)
assert.match(nativeVisionFailureMessage({ reason: 'cancelled' }, 'x/y'), /cancel/i)
assert.doesNotMatch(
  nativeVisionFailureMessage({ reason: 'cancelled' }, 'x/y'),
  /retry|network/i,
  'an external cancellation must not read as a retryable network error',
)
assert.match(nativeVisionFailureMessage(undefined, 'x/y'), /no text or the request failed/i)

// generateInjectionPrompt relays the session id to the MCP tool call (the MCP
// is a separate process the host hands no session id to).
const sessionInjection = generateInjectionPrompt(
  [{ path: '/tmp/x.png' }],
  'o que é?',
  'pantheon_vision_vision_describe',
  undefined,
  'session-mcp',
)
assert.ok(
  sessionInjection.includes('session_id="session-mcp"'),
  'session id relayed to the MCP tool call',
)
assert.ok(
  !generateInjectionPrompt([{ path: '/tmp/x.png' }], '', 'vision-tool').includes('session_id='),
  'no session instruction when no session id is available',
)

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
    PANTHEON_MODEL_PRESET: 'go-free',
    PANTHEON_OPENCODE_API_KEY: 'test-key',
  })
  assert.equal(
    viaEnv.modelID,
    'opencode/mimo-v2.6-flash-free',
    'env preset go-free → mimo-v2.6-flash-free',
  )
  assert.equal(viaEnv.baseURL, 'https://opencode.ai/zen/v1', 'env preset uses zen v1')

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

// ─── readOpencodeAuthToken unit: precedence, expiry, missing/corrupted file.

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

// ─── V2 SQLite credential store: native path parity with the MCP ───────────
// OpenCode V2 moved credentials into a `credential` table (the file named by
// OPENCODE_DB when set, else <data dir>/opencode.db). The native path must
// read the same store as the MCP and the picker so a V2 host — with no
// auth.json — resolves every vision path without extra login.

/** Create a V2 `credential` table in `dir/opencode.db` with the given rows. */
function seedCredentialDb(dir, rows) {
  const { DatabaseSync } = require('node:sqlite')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'opencode.db'))
  try {
    db.exec('CREATE TABLE credential (integration_id TEXT, active INTEGER, value TEXT)')
    const insert = db.prepare(
      'INSERT INTO credential (integration_id, active, value) VALUES (?, ?, ?)',
    )
    for (const row of rows) insert.run(row.integrationID, row.active, row.value)
  } finally {
    db.close()
  }
}

/** A fresh temp dir registered for teardown. */
function makeAuthDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

if (!sqliteAvailable) {
  console.log('⏭️  node:sqlite unavailable — V2 credential-store cases skipped')
} else {
  // V2 host: no auth.json, key only in opencode.db → native path resolves it.
  const v2Dir = makeAuthDir('pantheon-v2auth-')
  seedCredentialDb(v2Dir, [
    {
      integrationID: 'opencode-go',
      active: 1,
      value: JSON.stringify({ type: 'key', key: 'v2-db-go-key' }),
    },
  ])
  assert.equal(
    await readOpencodeAuthToken(['opencode-go'], v2Dir),
    'v2-db-go-key',
    'auth.json absent → V2 credential db supplies the token',
  )
  assert.equal(
    await readOpencodeAuthToken(['opencode', 'opencode-go'], v2Dir),
    'v2-db-go-key',
    'db rows tried in providerIDs order (missing opencode → opencode-go used)',
  )

  // OPENCODE_DB names the db when the host relocated it (e.g. a sandbox).
  const relocatedDb = join(makeAuthDir('pantheon-v2auth-'), 'opencode-v2.db')
  const relocatedDir = makeAuthDir('pantheon-v2auth-empty-')
  {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(relocatedDb)
    try {
      db.exec('CREATE TABLE credential (integration_id TEXT, active INTEGER, value TEXT)')
      db.prepare('INSERT INTO credential (integration_id, active, value) VALUES (?, ?, ?)').run(
        'opencode',
        1,
        JSON.stringify({ type: 'key', key: 'relocated-db-key' }),
      )
    } finally {
      db.close()
    }
  }
  assert.equal(
    await readOpencodeAuthToken(['opencode'], relocatedDir, { OPENCODE_DB: relocatedDb }),
    'relocated-db-key',
    'OPENCODE_DB overrides the default XDG db path',
  )

  // Inactive rows are never used; a corrupt db degrades silently.
  const inactiveDir = makeAuthDir('pantheon-v2auth-')
  seedCredentialDb(inactiveDir, [
    {
      integrationID: 'opencode-go',
      active: 0,
      value: JSON.stringify({ type: 'key', key: 'stale' }),
    },
  ])
  assert.equal(
    await readOpencodeAuthToken(['opencode-go'], inactiveDir),
    null,
    'inactive credential row ignored',
  )
  const corruptDir = makeAuthDir('pantheon-v2auth-')
  writeFileSync(join(corruptDir, 'opencode.db'), 'not a sqlite database')
  assert.equal(
    await readOpencodeAuthToken(['opencode-go'], corruptDir),
    null,
    'corrupt credential db → null (no crash)',
  )

  // Gating is preserved on the db path: a legacy Zen db token never leaks to a
  // non-Zen provider, and a Zen endpoint resolves the same db credential.
  const gateDir = makeAuthDir('pantheon-v2auth-')
  seedCredentialDb(gateDir, [
    {
      integrationID: 'opencode-go',
      active: 1,
      value: JSON.stringify({ type: 'key', key: 'ZEN-DB-SECRET' }),
    },
  ])
  const thirdPartyCatalog = {
    providers: [
      catalogProvider('gateway-x', [
        catalogModel({ id: 'vision-x', providerID: 'gateway-x', costInput: 2 }),
      ]),
    ],
  }
  const leaked = await resolveNativeVisionTarget({
    env: {},
    authStatePath: gateDir,
    catalog: thirdPartyCatalog,
  })
  assert.equal(leaked, null, 'non-Zen discovery + only Zen V2 db token → null (no leak)')

  const zen = await resolveNativeVisionTarget({
    preset: { vision: { model: 'opencode-go/mimo-v2.5' } },
    env: {},
    authStatePath: gateDir,
  })
  assert.equal(zen?.apiKey, 'ZEN-DB-SECRET', 'Zen endpoint resolves the V2 db credential')

  // XDG_DATA_HOME relocates the default data dir: with no explicit statePath,
  // readOpencodeAuthToken must read the db under $XDG_DATA_HOME/opencode
  // (mirrors v2-vision.ts), while OPENCODE_DB still wins when set.
  const xdgDataDir = makeAuthDir('pantheon-xdgdata-')
  seedCredentialDb(join(xdgDataDir, 'opencode'), [
    {
      integrationID: 'opencode-go',
      active: 1,
      value: JSON.stringify({ type: 'key', key: 'xdg-data-db-key' }),
    },
  ])
  await withEnv('OPENCODE_DB', undefined, async () => {
    await withEnv('XDG_DATA_HOME', xdgDataDir, async () => {
      assert.equal(
        await readOpencodeAuthToken(['opencode-go']),
        'xdg-data-db-key',
        'XDG_DATA_HOME relocates the default credential db path',
      )
    })
  })
}

// ─── Test N10 (unit part): config file mode/visionModel precedence ─────────
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

// ─── Melhoria 1: session description cache (pure units) ────────────────────
// The native path caches the gateway's text answer per session, keyed by the
// user prompt + the sorted content hashes of every image.

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

// ─── Temp images: permissions, dedup, atomic write, LRU, grace ─────────────

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
  assert.equal(statSync(path).mode & 0o777, 0o600, 'existing temp file stays 0600 after re-save')
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

// Atomic write (temp + rename) + dedup + failure safety.
// A content-hash name used to be written directly, so a crash mid-write could
// leave a TRUNCATED file that a later dedup reused as valid. The write is now a
// sibling `.tmp-<pid>` write + atomic rename in the SAME dir: a failure can
// leave at most a stray temp file, never a partial destination.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
  const data = Buffer.from('atomic-bytes')
  const path = writeTempImageSync(data, 'image/png')
  const expected = join(VISION_DIR, `${hashContent(data)}.png`)
  assert.equal(path, expected, 'destination is the content-hash path')
  assert.equal(readFileSync(path).equals(data), true, 'destination holds the exact bytes')
  assert.equal(statSync(path).mode & 0o777, 0o600, 'atomic destination stays 0600')
  assert.equal(statSync(VISION_DIR).mode & 0o777, 0o700, 'temp dir stays 0700')
  assert.equal(
    readdirSync(VISION_DIR).some((name) => name.includes('.tmp-')),
    false,
    'no temp file survives a successful rename',
  )
  // Dedup: identical bytes reuse the same file WITHOUT rewriting it (mtime
  // unchanged), so a file another session may be reading is never disturbed.
  const before = statSync(path).mtimeMs
  const again = writeTempImageSync(data, 'image/png')
  assert.equal(again, path, 'dedup reuses the same path')
  assert.equal(statSync(path).mtimeMs, before, 'dedup skips the rewrite (mtime unchanged)')
  // Simulated write failure: a DIRECTORY occupies the sibling temp path, so the
  // write fails before any rename. The destination must be ABSENT — never a
  // truncated/partial file a later dedup would trust.
  const failData = Buffer.from('atomic-fail-bytes')
  const failPath = join(VISION_DIR, `${hashContent(failData)}.png`)
  const failTemp = `${failPath}.tmp-${process.pid}`
  mkdirSync(failTemp, { recursive: true })
  assert.throws(
    () => writeTempImageSync(failData, 'image/png'),
    'a failed write surfaces the error',
  )
  assert.equal(existsSync(failPath), false, 'failed write leaves NO destination (not partial)')
  rmSync(failTemp, { recursive: true, force: true })
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
})()

// data URI parameters: `data:<mime>;param=value;base64,…` decodes (a browser or
// clipboard may decorate the mime with parameters); malformed URIs → null.
await (async () => {
  rmSync(VISION_DIR, { recursive: true, force: true })
  tempFileLRU.clear()
  const plain = await saveDataUrlImage('data:image/png;base64,ZmFrZQ==', 'image/png')
  const withParams = await saveDataUrlImage(
    'data:image/png;charset=utf-8;base64,ZmFrZQ==',
    'image/png',
  )
  assert.ok(plain && withParams, 'both URIs decode')
  assert.equal(withParams, plain, 'URI parameters decode to the same bytes/path')
  assert.equal(
    await saveDataUrlImage('data:image/png;base64=', 'image/png'),
    null,
    'empty payload → null',
  )
  assert.equal(
    await saveDataUrlImage('data:image/png;base64', 'image/png'),
    null,
    'missing comma → null (malformed)',
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

  // ── Fase 2: pergunta contextualizada com bounds de payload ────────────────
  // userText é truncado no teto de 2000 chars INCLUINDO o marcador "…"; o
  // excedente não entra no prompt enviado ao gateway.
  const longTail = 'CAUDA-LONGA-INVISIVEL-9f3a'
  const truncated = buildNativeVisionPrompt(`${'a'.repeat(5000)} ${longTail}`, 1)
  assert.ok(
    truncated.includes(`${'a'.repeat(1999)}…`),
    'user text truncado no teto de 2000 chars (1999 + "…" = 2000)',
  )
  assert.ok(
    !truncated.includes(`${'a'.repeat(2000)}…`),
    'o marcador "…" conta no teto: nunca 2001 chars',
  )
  assert.ok(!truncated.includes(longTail), 'excedente do user text não vaza no prompt')
  assert.ok(
    !buildNativeVisionPrompt('b'.repeat(1999), 1).includes('…'),
    'texto dentro do teto não ganha marcador de truncamento',
  )

  // userText vazio/whitespace → prompt genérico de hoje (sem pedido explícito),
  // semanticamente idêntico ao comportamento pré-Fase 2.
  const emptyPrompt = buildNativeVisionPrompt('', 1)
  assert.ok(
    emptyPrompt.includes(
      "User's request: (sem pedido explícito — descreva as imagens com precisão)",
    ),
    'vazio → linha de pedido com placeholder',
  )
  assert.equal(
    buildNativeVisionPrompt('   \n\t  ', 1),
    emptyPrompt,
    'whitespace-only é tratado exatamente como vazio',
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

// ─── Test: providerIsTextOnly + modelAcceptsImages fail-closed for text-only providers ──

await (async () => {
  // providerIsTextOnly: deepseek has provider-qualified entries all vision:false
  assert.equal(providerIsTextOnly('deepseek'), true, 'deepseek is text-only')

  // providerIsTextOnly: anthropic has provider-qualified entries with vision:true
  assert.equal(providerIsTextOnly('anthropic'), false, 'anthropic is not text-only')

  // providerIsTextOnly: unknown provider → not text-only (fail-open)
  assert.equal(providerIsTextOnly('unknown-provider'), false, 'unknown provider is not text-only')

  // modelAcceptsImages: undefined model + known text-only provider → reject
  assert.equal(
    modelAcceptsImages(undefined, 'deepseek'),
    false,
    'undefined model + deepseek provider → rejected (fail-closed)',
  )

  // modelAcceptsImages: undefined model + unknown provider → accept (fail-open)
  assert.equal(
    modelAcceptsImages(undefined, 'unknown-provider'),
    true,
    'undefined model + unknown provider → accepted (fail-open)',
  )

  // modelAcceptsImages: undefined model + no provider → accept (backward compat)
  assert.equal(
    modelAcceptsImages(undefined),
    true,
    'undefined model + no provider → accepted (backward compat)',
  )
})()

// ─── Fase 1: descoberta de modelo pelo catálogo do host ────────────────────
// Quando NENHUM modelo explícito está configurado (env PANTHEON_VISION_MODEL >
// config visionModel > preset vision.model), o resolvedor descobre um modelo
// image-capable via GET /config/providers (client.config.providers). Gate de
// compatibilidade: só modelos com wire-format OpenAI (api.npm na allowlist) ou
// providers Zen; o resultado é cacheado por processo/cliente com TTL curto
// (sem refetch por request). Catálogo ausente/vazio/erro → comportamento atual
// (DEFAULT_VISION_MODEL + endpoints Zen) — o catálogo nunca bloqueia.

/** Model fixture shaped like the SDK `Model` (defensive subset). */
function catalogModel({
  id,
  providerID = 'opencode-go',
  npm = '@ai-sdk/openai-compatible',
  url = `https://catalog.test/${providerID}/v1`,
  image = true,
  costInput = 0.5,
  status = 'active',
}) {
  return {
    id,
    providerID,
    status,
    api: { url, npm },
    capabilities: { input: { text: true, image } },
    cost: { input: costInput, output: 1 },
  }
}

/** Provider fixture shaped like the SDK `Provider` (models as record). */
function catalogProvider(id, models) {
  return { id, models: Object.fromEntries(models.map((m) => [m.id, m])) }
}

const CATALOG_AUTH = { PANTHEON_OPENCODE_API_KEY: 'catalog-key' }

// TTL do cache do catálogo: curto (minutos), nunca "vida do processo".
assert.equal(typeof PROVIDERS_CACHE_TTL_MS, 'number', 'providers cache TTL exported')
assert.ok(
  PROVIDERS_CACHE_TTL_MS > 0 && PROVIDERS_CACHE_TTL_MS <= 5 * 60_000,
  'providers cache TTL is short (minutes)',
)

// ── Unidade: descoberta escolhe image-capable PAGO, mais barato, URL do catálogo ──
await (async () => {
  const catalog = {
    providers: [
      catalogProvider('opencode-go', [
        catalogModel({ id: 'paid-vision', costInput: 2 }),
        catalogModel({ id: 'free-vision', costInput: 0, url: 'https://free.test/v1' }),
        catalogModel({ id: 'text-only', image: false }),
      ]),
    ],
  }
  const target = await resolveNativeVisionTarget({
    env: CATALOG_AUTH,
    authStatePath: authStoreDir,
    catalog,
  })
  assert.equal(
    target?.modelID,
    'opencode-go/paid-vision',
    'discovery skips the free-tier image model and picks the paid one',
  )
  assert.equal(
    target?.baseURL,
    'https://catalog.test/opencode-go/v1',
    'baseURL from catalog api.url',
  )
  assert.equal(target?.apiKey, 'catalog-key', 'env key still used')
})()

// determinismo: empate de custo → ordem lexicográfica por providerID/id
await (async () => {
  const catalog = {
    providers: [
      catalogProvider('opencode-go', [
        catalogModel({ id: 'b-vision', costInput: 1 }),
        catalogModel({ id: 'a-vision', costInput: 1 }),
      ]),
    ],
  }
  const target = await resolveNativeVisionTarget({
    env: CATALOG_AUTH,
    authStatePath: authStoreDir,
    catalog,
  })
  assert.equal(target?.modelID, 'opencode-go/a-vision', 'cost tie → lexicographic order')
})()

// ── Unidade: config explícita vence a descoberta (env > config > preset) ────
await (async () => {
  const catalog = {
    providers: [
      catalogProvider('opencode-go', [
        catalogModel({ id: 'env-model', url: 'https://env.test/v1' }),
        catalogModel({ id: 'discovered', costInput: 0, url: 'https://discovered.test/v1' }),
      ]),
    ],
  }
  const base = { authStatePath: authStoreDir, catalog }

  const viaEnv = await resolveNativeVisionTarget({
    ...base,
    env: { ...CATALOG_AUTH, PANTHEON_VISION_MODEL: 'opencode-go/env-model' },
  })
  assert.equal(viaEnv?.modelID, 'opencode-go/env-model', 'env beats discovery')
  assert.equal(viaEnv?.baseURL, 'https://env.test/v1', 'env model URL from catalog')

  const viaConfig = await resolveNativeVisionTarget({
    ...base,
    env: CATALOG_AUTH,
    config: { visionModel: 'opencode-go/env-model' },
  })
  assert.equal(viaConfig?.modelID, 'opencode-go/env-model', 'config beats discovery')
  assert.equal(viaConfig?.baseURL, 'https://env.test/v1', 'config model URL from catalog')

  const viaPreset = await resolveNativeVisionTarget({
    ...base,
    env: CATALOG_AUTH,
    preset: { vision: { model: 'opencode-go/env-model' } },
  })
  assert.equal(viaPreset?.modelID, 'opencode-go/env-model', 'preset beats discovery')
  assert.equal(viaPreset?.baseURL, 'https://env.test/v1', 'preset model URL from catalog')
})()

// ── Unidade: gate de compatibilidade (npm OpenAI-compatible) ────────────────
await (async () => {
  const base = { env: CATALOG_AUTH, authStatePath: authStoreDir }

  // descoberta ignora modelo image-capable com npm incompatível, mesmo free
  // (o gate npm vale para providers desconhecidos; providers Zen são
  // OpenAI-compatíveis por definição e permanecem na allowlist — Q2)
  const mixed = {
    providers: [
      catalogProvider('opencode-go', [catalogModel({ id: 'paid-compat', costInput: 3 })]),
      catalogProvider('weird-x', [
        catalogModel({
          id: 'free-incompat',
          providerID: 'weird-x',
          costInput: 0,
          npm: '@ai-sdk/anthropic',
        }),
      ]),
    ],
  }
  const gated = await resolveNativeVisionTarget({ ...base, catalog: mixed })
  assert.equal(
    gated?.modelID,
    'opencode-go/paid-compat',
    'npm gate: incompatible free model skipped',
  )

  // só incompatíveis → descoberta vazia → DEFAULT + Zen fallback (nunca o incompatível)
  const onlyIncompat = {
    providers: [
      catalogProvider('custom-x', [
        catalogModel({ id: 'img', providerID: 'custom-x', npm: '@ai-sdk/anthropic', costInput: 0 }),
      ]),
    ],
  }
  const fallback = await resolveNativeVisionTarget({ ...base, catalog: onlyIncompat })
  assert.equal(
    fallback?.modelID,
    'opencode-go/mimo-v2.5',
    'no compatible discovery → DEFAULT (last fallback)',
  )
  assert.equal(fallback?.baseURL, 'https://opencode.ai/zen/go/v1', 'DEFAULT → Zen fallback URL')

  // explícito incompatível → null → fallback tool
  const explicitIncompat = {
    providers: [
      catalogProvider('anthropic', [
        catalogModel({ id: 'claude-vision', providerID: 'anthropic', npm: '@ai-sdk/anthropic' }),
      ]),
    ],
  }
  const rejected = await resolveNativeVisionTarget({
    ...base,
    env: { ...CATALOG_AUTH, PANTHEON_VISION_MODEL: 'anthropic/claude-vision' },
    catalog: explicitIncompat,
  })
  assert.equal(rejected, null, 'explicit incompatible model → null (tool fallback)')

  // provedor não-Zen com npm compatível → descobrível (fase 2 via catálogo),
  // mas NUNCA herda a credencial Zen (env nem auth store legacy).
  const thirdParty = {
    providers: [
      catalogProvider('gateway-x', [
        catalogModel({ id: 'vision-x', providerID: 'gateway-x', costInput: 2 }),
      ]),
    ],
  }

  // (1) só a env Zen setada → null (sem vazamento cross-provider)
  const leakedEnv = await resolveNativeVisionTarget({ ...base, catalog: thirdParty })
  assert.equal(
    leakedEnv,
    null,
    'non-Zen discovery + only Zen env key → null (no cross-provider leak)',
  )

  // (2) só o token legacy Zen no auth store (sem env) → null
  writeAuthStore({ 'opencode-go': { access: 'ZEN-SECRET-TOKEN', expires: 0 } })
  const leakedStore = await resolveNativeVisionTarget({
    ...base,
    env: {},
    catalog: thirdParty,
  })
  assert.equal(leakedStore, null, 'non-Zen discovery + only legacy Zen auth-store token → null')

  // (4) com credencial PRÓPRIA no auth store → usa ela, ignorando env/legacy Zen
  writeAuthStore({
    'opencode-go': { access: 'ZEN-SECRET-TOKEN', expires: 0 },
    'gateway-x': { access: 'gateway-own-token', expires: 0 },
  })
  const opened = await resolveNativeVisionTarget({ ...base, catalog: thirdParty })
  assert.equal(
    opened?.modelID,
    'gateway-x/vision-x',
    'non-Zen provider discoverable via npm allowlist',
  )
  assert.equal(opened?.baseURL, 'https://catalog.test/gateway-x/v1', 'third-party catalog URL')
  assert.equal(
    opened?.apiKey,
    'gateway-own-token',
    'non-Zen uses ONLY its own auth-store credential (Zen env/legacy ignored)',
  )
  clearAuthStore()
})()

// ── Unidade: catálogo ausente/vazio/corrompido → comportamento atual ────────
await (async () => {
  const base = { env: CATALOG_AUTH, authStatePath: authStoreDir }
  const cases = [
    undefined,
    null,
    {},
    { providers: [] },
    { providers: [null] },
    { providers: 'nope' },
    { models: [null] },
  ]
  for (const catalog of cases) {
    const t = await resolveNativeVisionTarget({ ...base, catalog })
    assert.equal(
      t?.modelID,
      'opencode-go/mimo-v2.5',
      `no usable catalog (${JSON.stringify(catalog)}) → DEFAULT model`,
    )
    assert.equal(t?.baseURL, 'https://opencode.ai/zen/go/v1', '…and Zen fallback endpoint')
  }
})()

// ── Unidade: auth store — providerID resolvido antes dos legacy ─────────────
await (async () => {
  writeAuthStore({
    'opencode-go': { access: 'legacy-go-token', expires: 0 },
    opencode: { access: 'resolved-zen-token', expires: 0 },
  })
  const resolvedFirst = await resolveNativeVisionTarget({
    preset: { vision: { model: 'opencode/mimo-x' } },
    env: {},
    authStatePath: authStoreDir,
  })
  assert.equal(
    resolvedFirst?.apiKey,
    'resolved-zen-token',
    'resolved providerID entry tried BEFORE legacy list',
  )

  // legacy ainda alcançável quando o provider resolvido não tem entrada
  writeAuthStore({ opencode: { access: 'zen-only-token', expires: 0 } })
  const legacy = await resolveNativeVisionTarget({
    preset: { vision: { model: 'opencode-go/mimo-y' } },
    env: {},
    authStatePath: authStoreDir,
  })
  assert.equal(legacy?.apiKey, 'zen-only-token', 'legacy entries remain a fallback')
  clearAuthStore()
})()

// ─── Fase 3: robustez barata — timeout dinâmico + EXIF orientation ─────────

// ─── F3-T1: computeNativeTimeoutMs — função pura de timeout ────────────────
// Base = NATIVE_TIMEOUT_MS atual (60s); escala por MB de payload; teto 300s
// (referência showlotus/opencode-image-vision: 120s→300s, adaptado à base).
{
  const base = 60_000 // NATIVE_TIMEOUT_MS (margem para reasoning do mimo)
  const perMb = 10_000
  assert.equal(computeNativeTimeoutMs(0), base, '0 bytes → base')
  assert.equal(computeNativeTimeoutMs(1), base, 'payload mínimo → base')
  assert.equal(computeNativeTimeoutMs(1024 * 1024 - 1), base, 'sub-1MB → base')
  assert.equal(
    computeNativeTimeoutMs(5 * 1024 * 1024),
    base + 5 * perMb,
    '5MB → cresce proporcional',
  )
  assert.equal(
    computeNativeTimeoutMs(10 * 1024 * 1024),
    base + 10 * perMb,
    '10MB → cresce proporcional',
  )
  assert.equal(computeNativeTimeoutMs(1024 ** 3), 300_000, '1GB → teto exato 300s')
  assert.equal(
    computeNativeTimeoutMs(Number.MAX_SAFE_INTEGER),
    300_000,
    'valor enorme → teto exato 300s (nunca passa)',
  )
  assert.ok(
    computeNativeTimeoutMs(25 * 1024 * 1024) <= 300_000,
    'maior imagem válida (25MB) nunca excede o teto',
  )
  assert.equal(computeNativeTimeoutMs(-5), base, 'negativo → base (fail-safe)')
}

// ─── F3-T2: fetch respeita o timeout dinâmico (AbortSignal escalado) ───────
// Mock timers (node:test) observam QUANDO o AbortSignal dispara, sem esperar
// tempo real. A assinatura é preservada: o fetch continua recebendo um signal.
await (async () => {
  const target = {
    modelID: 'opencode-go/mimo-v2.5',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKey: 'k',
  }
  // data URI com ~mb megabytes decodificados (4/3 de overhead base64).
  const payloadOfMb = (mb) => ({
    url: `data:image/jpeg;base64,${'A'.repeat(Math.ceil((mb * 1024 * 1024 * 4) / 3))}`,
  })
  const fetchMock = installFetchMock(
    (call) =>
      new Promise((_resolve, reject) => {
        call.options.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  )
  try {
    // payload pequeno → aborta exatamente no timeout base (60s)
    mock.timers.enable({ apis: ['setTimeout'] })
    let aborted = false
    let p = describeImagesNative([{ url: 'data:image/png;base64,ZmFrZQ==' }], target)
    fetchMock.calls[0].options.signal.addEventListener('abort', () => {
      aborted = true
    })
    mock.timers.tick(59_999)
    assert.equal(aborted, false, 'payload pequeno não aborta antes do timeout base')
    mock.timers.tick(1)
    assert.equal(aborted, true, 'payload pequeno aborta exatamente no timeout base (60s)')
    assert.equal(await p, null, 'request abortado → null')
    mock.timers.reset()

    // 10MB → timeout dinâmico > base (60s + 10×10s = 160s)
    mock.timers.enable({ apis: ['setTimeout'] })
    aborted = false
    p = describeImagesNative([payloadOfMb(10)], target)
    fetchMock.calls[1].options.signal.addEventListener('abort', () => {
      aborted = true
    })
    mock.timers.tick(60_000)
    assert.equal(aborted, false, 'payload 10MB sobrevive ao timeout base')
    mock.timers.tick(100_000)
    assert.equal(aborted, true, 'payload 10MB aborta no timeout dinâmico (160s)')
    assert.equal(await p, null)
    mock.timers.reset()

    // dois payloads de 10MB → soma (20MB) → 60s + 200s = 260s
    mock.timers.enable({ apis: ['setTimeout'] })
    aborted = false
    p = describeImagesNative([payloadOfMb(10), payloadOfMb(10)], target)
    fetchMock.calls[2].options.signal.addEventListener('abort', () => {
      aborted = true
    })
    mock.timers.tick(200_000)
    assert.equal(aborted, false, 'timeout considera a SOMA dos payloads')
    mock.timers.tick(60_000)
    assert.equal(aborted, true, 'payloads somados abortam em 260s')
    assert.equal(await p, null)
    mock.timers.reset()

    // 29MB → teto exato de 300s (nunca passa)
    mock.timers.enable({ apis: ['setTimeout'] })
    aborted = false
    p = describeImagesNative([payloadOfMb(29)], target)
    fetchMock.calls[3].options.signal.addEventListener('abort', () => {
      aborted = true
    })
    mock.timers.tick(299_999)
    assert.equal(aborted, false, 'payload enorme não aborta antes do teto')
    mock.timers.tick(1)
    assert.equal(aborted, true, 'payload enorme aborta exatamente no teto de 300s')
    assert.equal(await p, null)
    mock.timers.reset()
  } finally {
    mock.timers.reset()
    fetchMock.restore()
  }
})()

// ─── F3-T2b: describeImagesNative failure classification (onFailure) ──────
// The native describe must not collapse three DIFFERENT causes into one
// misleading message: OUR budget expiring (timeout), a genuine transport drop
// (network), and an EXTERNAL cancellation (cancelled — e.g. ToolContext.signal,
// which must NEVER advertise a "retry").
await (async () => {
  const target = {
    modelID: 'opencode-go/mimo-v2.5',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKey: 'k',
  }
  const payload = [{ url: 'data:image/png;base64,ZmFrZQ==' }]

  // (1) Our dynamic budget elapses → 'timeout' (+ the elapsed budget).
  {
    const fetchMock = installFetchMock(
      (call) =>
        new Promise((_resolve, reject) => {
          call.options.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    try {
      mock.timers.enable({ apis: ['setTimeout'] })
      let failure
      const p = describeImagesNative(payload, target, undefined, undefined, undefined, (f) => {
        failure = f
      })
      mock.timers.tick(60_000)
      assert.equal(await p, null, 'timed-out request → null')
      assert.equal(failure?.reason, 'timeout', 'own budget → reason timeout')
      assert.equal(failure?.timeoutMs, 60_000, 'timeout carries the elapsed budget')
      assert.match(
        nativeVisionFailureMessage(failure, target.modelID),
        /timed out/i,
        'timeout message names the timeout',
      )
    } finally {
      mock.timers.reset()
      fetchMock.restore()
    }
  }

  // (2) Genuine transport drop → 'network'.
  {
    const fetchMock = installFetchMock(() => Promise.reject(new Error('ECONNRESET')))
    try {
      let failure
      const result = await describeImagesNative(
        payload,
        target,
        undefined,
        undefined,
        undefined,
        (f) => {
          failure = f
        },
      )
      assert.equal(result, null, 'network failure → null')
      assert.equal(failure?.reason, 'network', 'transport drop → reason network')
      assert.match(
        nativeVisionFailureMessage(failure, target.modelID),
        /network/i,
        'network message names the network error',
      )
    } finally {
      fetchMock.restore()
    }
  }

  // (3) External cancellation → 'cancelled' with a neutral, retry-free message.
  {
    const fetchMock = installFetchMock(
      (call) =>
        new Promise((_resolve, reject) => {
          call.options.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    try {
      const controller = new AbortController()
      let failure
      const p = describeImagesNative(
        payload,
        target,
        undefined,
        undefined,
        controller.signal,
        (f) => {
          failure = f
        },
      )
      controller.abort()
      assert.equal(await p, null, 'external abort → null')
      assert.equal(failure?.reason, 'cancelled', 'external abort → reason cancelled')
      const message = nativeVisionFailureMessage(failure, target.modelID)
      assert.match(message, /cancel/i, 'cancelled message names the cancellation')
      assert.doesNotMatch(message, /retry/i, 'cancelled message never says retry')
      assert.doesNotMatch(message, /network/i, 'cancelled is not misreported as a network drop')
    } finally {
      fetchMock.restore()
    }
  }
})()

// ─── F3-Fixtures: JPEG sintético com APP1 EXIF (zero-dep, bytes no teste) ──

/**
 * Constrói um JPEG mínimo sintético: SOI + [APP0 JFIF] + APP1/Exif (IFD0 com
 * os tags informados) + EOI. `entries` são entradas IFD cruas (12 bytes cada).
 */
function buildExifJpeg({ byteOrder = 'II', jfifFirst = true, entries } = {}) {
  const little = byteOrder === 'II'
  const u16 = (v) => (little ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff])
  const u16be = (v) => [(v >> 8) & 0xff, v & 0xff] // comprimento de segmento JPEG é SEMPRE big-endian
  const u32 = (v) =>
    little
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
      : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  // IFD0
  const ifd = [...u16(entries.length), ...entries.flat()]
  // TIFF header: byte-order + magic 42 + offset do IFD0 (8)
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...ifd]
  // APP1 payload: "Exif\0\0" + TIFF
  const exifPayload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]
  const bytes = [0xff, 0xd8] // SOI
  if (jfifFirst) {
    // APP0 JFIF: len 16, "JFIF\0", v1.1, unidades 0, densidade 1×1, thumb 0
    bytes.push(
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x01,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
    )
  }
  bytes.push(0xff, 0xe1, ...u16be(exifPayload.length + 2), ...exifPayload)
  bytes.push(0xff, 0xd9) // EOI
  return Uint8Array.from(bytes)
}

/** Entrada IFD do tag Orientation (0x0112, SHORT, count 1, valor inline). */
function orientationEntry(orientation, byteOrder = 'II') {
  const little = byteOrder === 'II'
  const u16 = (v) => (little ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff])
  const u32 = (v) =>
    little
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
      : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  const value = little
    ? [orientation & 0xff, 0x00, 0x00, 0x00]
    : [0x00, orientation & 0xff, 0x00, 0x00]
  return [...u16(0x0112), ...u16(3), ...u32(1), ...value]
}

/** Entrada IFD Make (0x010F, ASCII, count 2, valor inline "X\0") — enche o IFD. */
function makeEntry(byteOrder = 'II') {
  const little = byteOrder === 'II'
  const u16 = (v) => (little ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff])
  const u32 = (v) =>
    little
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
      : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  return [...u16(0x010f), ...u16(2), ...u32(2), 0x58, 0x00, 0x00, 0x00]
}

const jpegDataUri = (bytes) => `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`

// ─── F3-T3: readExifOrientation — detector APP1 mínimo ─────────────────────

assert.equal(
  readExifOrientation(buildExifJpeg({ entries: [orientationEntry(6)] })),
  6,
  'JPEG com APP1 EXIF (II) → orientation 6',
)
assert.equal(
  readExifOrientation(buildExifJpeg({ byteOrder: 'MM', entries: [orientationEntry(3, 'MM')] })),
  3,
  'byte-order big-endian (MM) → orientation 3',
)
assert.equal(
  readExifOrientation(buildExifJpeg({ entries: [makeEntry(), orientationEntry(8)] })),
  8,
  'IFD com múltiplos tags → acha 0x0112',
)
assert.equal(
  readExifOrientation(buildExifJpeg({ jfifFirst: false, entries: [orientationEntry(6)] })),
  6,
  'APP1 como primeiro segmento → orientation 6',
)
assert.equal(
  readExifOrientation(buildExifJpeg({ entries: [orientationEntry(1)] })),
  1,
  'orientation 1 é um valor válido',
)

// JPEG sem EXIF → null
assert.equal(
  readExifOrientation(
    Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]),
  ),
  null,
  'JPEG sem APP1 EXIF → null',
)
// APP1 sem header "Exif\0\0" (ex.: XMP) → null
assert.equal(
  readExifOrientation(
    Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x14, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x78, 0x6d,
      0x70, 0x2e, 0x6f, 0x72, 0x67, 0x00, 0x00, 0xff, 0xd9,
    ]),
  ),
  null,
  'APP1 não-EXIF (XMP) → null',
)
// Payload não-JPEG (PNG) → null, sem tentativa de parse
assert.equal(
  readExifOrientation(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
  ),
  null,
  'PNG → null',
)
// Bytes malformados/truncados → null, NUNCA throw (fail-safe)
for (const [label, bad] of Object.entries({
  vazio: Uint8Array.from([]),
  'só SOI': Uint8Array.from([0xff, 0xd8]),
  'SOI + marcador solto': Uint8Array.from([0xff, 0xd8, 0xff]),
  'não-JPEG': Uint8Array.from([0x00, 0x01, 0x02, 0x03]),
  'só EOI': Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
  'APP1 truncado': Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x50, 0x45, 0x78]),
  'TIFF truncado': Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0c, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49,
  ]),
  'TIFF magic inválido': Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x00, 0x2b,
    0x08, 0x00,
  ]),
})) {
  assert.equal(readExifOrientation(bad), null, `malformado (${label}) → null, sem throw`)
}

// ─── F3-T4: payloadOrientation — orientação por payload (fail-safe) ────────

assert.equal(
  payloadOrientation({ url: jpegDataUri(buildExifJpeg({ entries: [orientationEntry(6)] })) }),
  6,
  'data URI JPEG com EXIF → 6',
)
assert.equal(
  payloadOrientation({ url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' }),
  null,
  'data URI PNG → null (sem parse)',
)
assert.equal(payloadOrientation({ url: 'https://example.com/foto.jpg' }), null, 'URL remota → null')

// ─── F3-T5: buildOrientationHint — hint textual por imagem ─────────────────

assert.equal(buildOrientationHint([null]), '', 'sem orientação → hint vazio')
assert.equal(buildOrientationHint([1]), '', 'orientation 1 → hint vazio')
assert.equal(buildOrientationHint([1, null]), '', 'só valores neutros → hint vazio')
const hint6 = buildOrientationHint([6])
assert.ok(hint6.includes('image 1'), 'hint menciona a imagem 1')
assert.ok(hint6.includes('90-degree clockwise'), 'hint descreve a correção de orientation 6')
const hintMixed = buildOrientationHint([1, 8, null, 3])
assert.ok(hintMixed.includes('image 2'), 'hint menciona só a imagem rotacionada (2)')
assert.ok(hintMixed.includes('counter-clockwise'), 'orientation 8 → rotação anti-horária')
assert.ok(!hintMixed.includes('image 1:'), 'image 1 (orientation 1) fora do hint')
assert.ok(!hintMixed.includes('image 3:'), 'image 3 (sem EXIF) fora do hint')
assert.ok(hintMixed.includes('image 4:'), 'image 4 (orientation 3) no hint')

// ─── F3-T6: prompt com/sem hint + participação na chave de cache ───────────

const f3BasePrompt = buildNativeVisionPrompt('o que é?', 1)
assert.equal(
  f3BasePrompt.includes('IMAGE ORIENTATION'),
  false,
  'sem hint → prompt idêntico ao atual (sem bloco de orientação)',
)
assert.equal(
  buildNativeVisionPrompt('o que é?', 1, 'describe', ''),
  f3BasePrompt,
  'hint vazio → saída byte-idêntica à sem argumento',
)
const f3HintedPrompt = buildNativeVisionPrompt('o que é?', 1, 'describe', buildOrientationHint([6]))
assert.ok(f3HintedPrompt.includes('IMAGE ORIENTATION'), 'orientation ≠ 1 → prompt contém o hint')
assert.ok(f3HintedPrompt.includes('90-degree clockwise'), 'hint no prompt descreve a correção')
assert.ok(f3HintedPrompt.includes('o que é?'), 'userText preservado com hint presente')
assert.ok(
  f3HintedPrompt.includes('{userText}') === false,
  'hint não re-expande template variables (escape da F2 intacto)',
)
// O hint DEVE entrar na chave do cache: mesmo payload + prompts diferentes →
// chaves diferentes (evita hit stale se a detecção variar entre chamadas).
const f3Payload = { url: 'data:image/png;base64,ZmFrZQ==' }
assert.notEqual(
  buildDescriptionCacheKey(f3HintedPrompt, [f3Payload]),
  buildDescriptionCacheKey(f3BasePrompt, [f3Payload]),
  'hint de orientação participa da chave do cache (via prompt)',
)

// ─── Teardown ──────────────────────────────────────────────────────────────

rmSync(VISION_DIR, { recursive: true, force: true })
tempFileLRU.clear()
for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
rmSync(homeDir, { recursive: true, force: true })
if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
else process.env.XDG_CONFIG_HOME = previousXdg
if (previousHome === undefined) delete process.env.HOME
else process.env.HOME = previousHome
if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
else process.env.XDG_DATA_HOME = previousDataHome
if (previousOpenCodeKey === undefined) delete process.env.PANTHEON_OPENCODE_API_KEY
else process.env.PANTHEON_OPENCODE_API_KEY = previousOpenCodeKey
if (previousOaiKey === undefined) delete process.env.OPENCODE_API_KEY
else process.env.OPENCODE_API_KEY = previousOaiKey
if (previousMode === undefined) delete process.env.PANTHEON_VISION_MODE
else process.env.PANTHEON_VISION_MODE = previousMode
if (previousVisionModel === undefined) delete process.env.PANTHEON_VISION_MODEL
else process.env.PANTHEON_VISION_MODEL = previousVisionModel

console.log('✅ vision module tests passed')
