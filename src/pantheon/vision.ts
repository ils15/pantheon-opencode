import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import type { FilePart, Part, TextPart, UserMessage } from '@opencode-ai/sdk'
import type { ResolvedPreset } from './presets.mjs'
import { hasVision, resolveActivePreset, visionBrokenOnGateway } from './presets.mjs'

// ─── Constants ────────────────────────────────────────────────────────────

const CONFIG_FILENAME = 'opencode-vision.json'
const TEMP_DIR_NAME = 'pantheon-vision'

/**
 * Temp images younger than this survive a `session.idle` fired between
 * auto-continue turns; abandoned files are swept by the next idle.
 */
export const TEMP_FILE_GRACE_MS = 120_000

/**
 * Global cap on temp images in `/tmp/pantheon-vision`. When the LRU registry
 * (see `enforceTempFileCap`) exceeds this, the least-recently-used files older
 * than TEMP_FILE_GRACE_MS are unlinked — never a young file that an active
 * turn may still reference.
 */
export const TEMP_MAX_FILES = 200

// Tool the model is instructed to call. Configurable via:
//   1. env PANTHEON_VISION_TOOL
//   2. config file imageAnalysisTool (project > user)
//   3. dynamic detection of an available MCP vision tool
//   4. the canonical Pantheon Vision MCP tool
//
// OpenCode 1.18.11 generates MCP tool IDs as sanitize(clientName) + '_' +
// sanitize(name): the `pantheon-vision` MCP (FastMCP name) yields
// `pantheon_vision_vision_describe` (underscores) — there is no `mcp__` prefix
// in that version. The legacy `mcp__pantheon-vision__vision_describe` form is
// still accepted when explicitly configured or detected.
const DEFAULT_IMAGE_ANALYSIS_TOOL = 'pantheon_vision_vision_describe'

/** True for IDs referencing the Pantheon Vision MCP — hyphen OR underscore server form. */
const isPantheonVisionServerTool = (id: string): boolean => /[pP]antheon[-_]vision/.test(id)

/** True for the describe/ocr/analyze tool suffix (sanitized MCP tool name). */
const isPantheonVisionActionTool = (id: string): boolean =>
  /vision_(describe|ocr|analyze)/i.test(id)

// Enabled for ALL models by default ("paste and ask" universal). The config
// file can restrict this with wildcard patterns.
const DEFAULT_MODEL_PATTERNS: readonly string[] = ['*']

// Only PNG/JPEG/WebP are intercepted (data: URLs need a known extension).
const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
])
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const PROMPT_TEMPLATE_VARIABLES = [
  '{imageList}',
  '{imageCount}',
  '{toolName}',
  '{userText}',
] as const

// ─── Native vision (provider-direct, OpenAI-compatible) ─────────────────────
// Preferred path: when an API key is available the plugin calls the multimodal
// model DIRECTLY via the opencode Zen OpenAI-compatible endpoint, so any user
// with a provider key gets vision WITHOUT an MCP tool. The MCP tool pattern
// (imageAnalysisTool) remains the fallback for missing keys / provider errors.
//
// MVP scope: only opencode-go / opencode providers (the user's stack).
// anthropic/openai native vision is phase 2 — those presets fall back to the
// MCP tool pattern.

const DEFAULT_VISION_MODEL = 'opencode-go/mimo-v2.5'
const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
const ZEN_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
const NATIVE_PROMPT =
  'Descreva fielmente esta imagem em detalhes (texto visível, cores, layout, objetos).'
const NATIVE_TIMEOUT_MS = 20_000
const NATIVE_MAX_TOKENS = 500
const MAX_NATIVE_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Descriptions produced by the native path are cached per session, keyed by
 * the user prompt + the content hashes of the attached images (see
 * `buildDescriptionCacheKey`). TTL bounds staleness: an identical re-ask
 * within the window reuses the stored text without another gateway call;
 * after expiry the multimodal model is called again.
 */
export const DESCRIPTION_CACHE_TTL_MS = 30 * 60 * 1000

// ─── Types ─────────────────────────────────────────────────────────────────

type VisionConfig = {
  models?: string[]
  imageAnalysisTool?: string
  promptTemplate?: string
  mode?: VisionMode
  visionModel?: string
}

export type ModelInfo = { providerID: string; modelID: string }

export type NativeVisionTarget = { modelID: string; baseURL: string; apiKey: string }

type NativeVisionEndpoint = { modelID: string; baseURL: string }

export type VisionMode = 'native' | 'tool' | 'auto'

/** Return whether OpenCode's current model is known to accept image input. */
export function modelAcceptsImages(model: ModelInfo | undefined): boolean {
  if (!model) return true
  try {
    const id = `${model.providerID}/${model.modelID}`
    // Provider/gateway-aware: a model can be vision-capable per models.dev
    // yet BROKEN on its runtime gateway (qwen3.7-plus on opencode-go returns
    // HTTP 500 on image turns). Such models are treated as text-only so the
    // image is intercepted and routed to the multimodal fallback instead of
    // being sent directly to the gateway.
    return hasVision(id) && !visionBrokenOnGateway(id, model.providerID)
  } catch {
    // Unknown providers/models should retain OpenCode's native behavior.
    return true
  }
}

type SavedImage = {
  path: string
  partId: string
  temporary: boolean
}

type NativeImagePayload = { url: string }

// ─── Config loading (project > user) ──────────────────────────────────────

// ─── OpenCode auth store (fallback credential source) ────────────────────
// `opencode auth login` stores provider tokens in <data dir>/auth.json.
// The vision plugin reads that store so connected users don't need to export
// any env var. Mirrors the usage-bar pattern (src/plugins/tui) but stays
// local to this module — no TUI imports.

function defaultAuthStorePath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'auth.json')
}

/**
 * Read a provider token from opencode's auth store (`opencode auth login`).
 * `statePath` is the opencode data dir (default ~/.local/share/opencode); the
 * auth.json inside it maps provider IDs to `{ access, expires, ... }`.
 * Returns the first non-expired `access` token across `providerIDs`, or null
 * when the file is missing/corrupted or no entry has a usable token — callers
 * fall back to the MCP tool pattern. The token is never logged.
 */
export async function readOpencodeAuthToken(
  providerIDs: readonly string[],
  statePath?: string,
): Promise<string | null> {
  const authPath = statePath ? join(statePath, 'auth.json') : defaultAuthStorePath()
  let raw: string
  try {
    raw = await readFile(authPath, 'utf8')
  } catch {
    return null // missing/unreadable → no crash
  }
  let auth: Record<string, { access?: unknown; expires?: unknown } | undefined>
  try {
    auth = JSON.parse(raw) as typeof auth
  } catch {
    return null // corrupted → no crash
  }
  for (const id of providerIDs) {
    const entry = auth[id]
    const access = typeof entry?.access === 'string' ? entry.access.trim() : ''
    if (access === '') continue
    const expires = entry?.expires
    if (typeof expires === 'number' && expires > 0 && Date.now() >= expires) continue
    return access
  }
  return null
}

function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(xdg, 'opencode', CONFIG_FILENAME)
}

async function readConfigFile(configPath: string): Promise<VisionConfig | null> {
  if (!existsSync(configPath)) return null
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    const config: VisionConfig = {}
    if (Array.isArray(parsed.models)) {
      const models = parsed.models.filter((m): m is string => typeof m === 'string')
      if (models.length > 0) config.models = models
    }
    if (typeof parsed.imageAnalysisTool === 'string' && parsed.imageAnalysisTool.trim() !== '') {
      config.imageAnalysisTool = parsed.imageAnalysisTool
    }
    const template = parsed.promptTemplate
    if (
      typeof template === 'string' &&
      PROMPT_TEMPLATE_VARIABLES.some((variable) => template.includes(variable))
    ) {
      config.promptTemplate = template
    }
    if (parsed.mode === 'native' || parsed.mode === 'tool' || parsed.mode === 'auto') {
      config.mode = parsed.mode
    }
    if (typeof parsed.visionModel === 'string' && parsed.visionModel.trim() !== '') {
      config.visionModel = parsed.visionModel.trim()
    }
    return Object.keys(config).length > 0 ? config : null
  } catch {
    return null
  }
}

export async function loadVisionConfig(directory: string): Promise<VisionConfig> {
  const project = await readConfigFile(join(directory, '.opencode', CONFIG_FILENAME))
  const user = await readConfigFile(userConfigPath())
  const merged: VisionConfig = {}
  if (project?.models) merged.models = project.models
  else if (user?.models) merged.models = user.models
  if (project?.imageAnalysisTool) merged.imageAnalysisTool = project.imageAnalysisTool
  else if (user?.imageAnalysisTool) merged.imageAnalysisTool = user.imageAnalysisTool
  if (project?.promptTemplate) merged.promptTemplate = project.promptTemplate
  else if (user?.promptTemplate) merged.promptTemplate = user.promptTemplate
  if (project?.mode) merged.mode = project.mode
  else if (user?.mode) merged.mode = user.mode
  if (project?.visionModel) merged.visionModel = project.visionModel
  else if (user?.visionModel) merged.visionModel = user.visionModel
  return merged
}

// ─── Active-preset resolution (native vision model) ────────────────────────
// Same candidate order as the plugin config hook, so the native vision model
// matches the active preset (resolved.vision?.model) exactly.

export function activePresetCandidates(): string[] {
  const home = process.env.HOME ?? ''
  const xdg = process.env.XDG_CONFIG_HOME ?? `${home}/.config`
  return [
    `${process.cwd()}/.pantheon/active-preset.json`,
    `${xdg}/opencode/.pantheon/active-preset.json`,
    `${home}/.opencode/.pantheon/active-preset.json`,
  ]
}

/**
 * Resolve the vision mode: env PANTHEON_VISION_MODE, then the config file's
 * `mode` field, then default `auto`. `auto` = try native vision first (when a
 * key exists), fall back to the MCP tool pattern. `tool` forces the legacy
 * tool pattern. `native` tries native first and still falls back on failure
 * (never break a user turn).
 */
export function getVisionMode(
  env: Record<string, string | undefined> = process.env,
  configMode?: string,
): VisionMode {
  const envMode = env.PANTHEON_VISION_MODE?.trim().toLowerCase()
  if (envMode === 'native' || envMode === 'tool') return envMode
  const cfgMode = configMode?.trim().toLowerCase()
  if (cfgMode === 'native' || cfgMode === 'tool') return cfgMode
  return 'auto'
}

// ─── Wildcard model matching ───────────────────────────────────────────────
// Patterns: `*`, `prefix*`, `*suffix`, `*contains*`, `provider/*`, `*/model`.

export function matchesWildcardPattern(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase()
  const v = value.toLowerCase()
  if (p === '*') return true
  if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return v.includes(p.slice(1, -1))
  if (p.endsWith('*')) return v.startsWith(p.slice(0, -1))
  if (p.startsWith('*')) return v.endsWith(p.slice(1))
  return v === p
}

export function matchesModelPattern(pattern: string, model: ModelInfo): boolean {
  if (pattern === '*') return true
  const slash = pattern.indexOf('/')
  if (slash === -1) {
    return (
      matchesWildcardPattern(pattern, model.providerID) ||
      matchesWildcardPattern(pattern, model.modelID)
    )
  }
  const provider = pattern.slice(0, slash)
  const modelPattern = pattern.slice(slash + 1)
  return (
    matchesWildcardPattern(provider, model.providerID) &&
    matchesWildcardPattern(modelPattern, model.modelID)
  )
}

export function modelMatchesAnyPattern(
  model: ModelInfo | undefined,
  patterns: readonly string[],
): boolean {
  if (!model) return false
  return patterns.some((pattern) => matchesModelPattern(pattern, model))
}

// ─── Type guards ───────────────────────────────────────────────────────────

export function isImageFilePart(part: unknown): part is FilePart {
  if (!part || typeof part !== 'object') return false
  const value = part as { type?: unknown; mime?: unknown }
  return (
    value.type === 'file' &&
    typeof value.mime === 'string' &&
    value.mime.toLowerCase().startsWith('image/')
  )
}

function isSupportedImageFilePart(part: unknown): part is FilePart {
  if (!isImageFilePart(part)) return false
  return SUPPORTED_MIME_TYPES.has(part.mime.toLowerCase())
}

function isTextPart(part: Part): part is TextPart {
  return part.type === 'text'
}

function syntheticPartId(): string {
  return `prt${randomUUID()}`
}

// ─── Image target resolution ───────────────────────────────────────────────
// file:// → local path used directly; data: → decoded + saved to temp;
// http(s):// → URL passed through unchanged.

function getExtensionForMime(mime: string): string {
  return MIME_TO_EXTENSION[mime.toLowerCase()] ?? 'png'
}

// Same set as the paste-and-ask interception and the Pantheon Vision MCP.
const EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * Guess a MIME type from a file extension (.png/.jpg/.jpeg/.webp/.gif).
 * Returns null for unknown extensions — callers surface a friendly error.
 */
export function getMimeForPath(path: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(path)
  if (!match) return null
  const extension = (match[1] ?? '').toLowerCase()
  return EXTENSION_TO_MIME[extension] ?? null
}

// ─── Temp-image LRU (global disk cap) ─────────────────────────────────────
// Content-hash filenames mean identical re-pasted images share one file; the
// LRU registry keeps the total on disk bounded. Insertion order = recency:
// touching a path deletes + re-sets it so the oldest entries sit at the front.

/** LRU registry: temp image path → last touch time. Exposed for tests. */
export const tempFileLRU = new Map<string, number>()

/** Mark a temp file as recently used (recency = map insertion order). */
export function touchTempFile(path: string, now: number = Date.now()): void {
  tempFileLRU.delete(path)
  tempFileLRU.set(path, now)
}

/** Drop a temp file from the registry (after it has been unlinked). */
export function forgetTempFile(path: string): void {
  tempFileLRU.delete(path)
}

/**
 * Enforce the global temp-file cap: when the registry exceeds `maxFiles`,
 * unlink the least-recently-used files — but NEVER a file younger than
 * `graceMs`, because an active auto-continue turn may still reference it.
 * The temp directory itself is never removed (other sessions/processes may
 * share it). Returns how many files were evicted.
 */
export async function enforceTempFileCap(
  maxFiles: number = TEMP_MAX_FILES,
  graceMs: number = TEMP_FILE_GRACE_MS,
  now: number = Date.now(),
): Promise<number> {
  let evicted = 0
  for (const [path, touchedAt] of tempFileLRU) {
    if (tempFileLRU.size <= maxFiles) break
    if (now - touchedAt <= graceMs) continue
    tempFileLRU.delete(path)
    try {
      await unlink(path)
    } catch {
      // Best effort.
    }
    evicted += 1
  }
  return evicted
}

export async function saveDataUrlImage(dataUrl: string, mime: string): Promise<string | null> {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) return null
  const data = Buffer.from(match[2] ?? '', 'base64')
  if (data.length === 0) return null
  const dir = join(tmpdir(), TEMP_DIR_NAME)
  // Screenshots may hold sensitive content: force private modes even under a
  // permissive umask. mkdir/writeFile honor the umask, so chmod is applied
  // AFTER creation to guarantee 0700/0600 regardless of the environment.
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  // Content-hash filename: identical re-pasted images reuse the same file
  // (dedup — less disk, and it stabilizes the per-image description cache).
  const filePath = join(dir, `${hashContent(data)}.${getExtensionForMime(mime)}`)
  if (!existsSync(filePath)) await writeFile(filePath, data, { mode: 0o600 })
  await chmod(filePath, 0o600)
  touchTempFile(filePath)
  await enforceTempFileCap()
  return filePath
}

async function resolveImageTarget(filePart: FilePart): Promise<SavedImage | null> {
  const url = filePart.url
  if (!url) return null
  if (url.startsWith('file://')) {
    // fileURLToPath decodes percent-encoding (file:///tmp/my%20screen.png →
    // /tmp/my screen.png) and normalizes Windows drive-letter URLs
    // (file:///C:/... → C:\... on Windows). A raw slice('file://') would
    // keep the literal %20 in the path, so reading the file would fail.
    try {
      return { path: fileURLToPath(url), partId: filePart.id, temporary: false }
    } catch {
      return null // malformed file URL → unresolvable
    }
  }
  if (url.startsWith('data:')) {
    const path = await saveDataUrlImage(url, filePart.mime)
    if (!path) return null
    return { path, partId: filePart.id, temporary: true }
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { path: url, partId: filePart.id, temporary: false }
  }
  return null
}

// ─── Native vision (provider-direct) ───────────────────────────────────────

/** First non-empty (trimmed) value across the priority list, else `fallback`. */
function firstNonEmpty(fallback: string, ...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return fallback
}

/**
 * Resolve the native vision endpoint: model ID + Zen base URL (no key I/O).
 *
 * Model precedence: env PANTHEON_VISION_MODEL > config file `visionModel` >
 * active preset `vision.model` > DEFAULT_VISION_MODEL. Returns null when the
 * model's provider is not opencode-go/opencode (anthropic/openai are phase 2).
 */
function resolveNativeVisionEndpoint(
  preset: Pick<ResolvedPreset, 'vision'> | null | undefined,
  env: Record<string, string | undefined>,
  configVisionModel?: string,
): NativeVisionEndpoint | null {
  const resolved = preset ?? resolveActivePreset({ env, candidates: activePresetCandidates() })
  const modelID = firstNonEmpty(
    DEFAULT_VISION_MODEL,
    env.PANTHEON_VISION_MODEL,
    configVisionModel,
    resolved?.vision?.model,
  )
  const providerID = modelID.slice(0, modelID.indexOf('/'))
  let baseURL: string | null = null
  if (providerID.startsWith('opencode-go')) baseURL = ZEN_GO_BASE_URL
  else if (providerID === 'opencode') baseURL = ZEN_BASE_URL
  if (!baseURL) return null
  return { modelID, baseURL }
}

/**
 * Resolve the native vision target: model + Zen endpoint + API key.
 *
 * Key comes from env only (PANTHEON_OPENCODE_API_KEY then OPENCODE_API_KEY).
 * Returns null when the model's provider is not opencode-go/opencode or when
 * no env key is set — callers fall back to the MCP tool. For the auth-store
 * fallback (`opencode auth login`) use `resolveNativeVisionTarget`.
 */
export function resolveNativeVisionConfig(
  preset: Pick<ResolvedPreset, 'vision'> | null | undefined = undefined,
  env: Record<string, string | undefined> = process.env,
  configVisionModel?: string,
): NativeVisionTarget | null {
  const endpoint = resolveNativeVisionEndpoint(preset, env, configVisionModel)
  if (!endpoint) return null
  const apiKey = env.PANTHEON_OPENCODE_API_KEY ?? env.OPENCODE_API_KEY
  if (!apiKey || apiKey.trim() === '') return null
  return { ...endpoint, apiKey }
}

/**
 * Full native-vision target resolution for the chat hook (async): model +
 * endpoint via `resolveNativeVisionConfig`, then the API key from env
 * (PANTHEON_OPENCODE_API_KEY ?? OPENCODE_API_KEY) falling back to the opencode
 * auth store (`opencode auth login`) — 'opencode-go' entry first, then
 * 'opencode' — so connected users don't need to export anything. Returns null
 * when the provider isn't opencode-go/opencode or no usable key exists —
 * callers fall back to the MCP tool.
 */
export async function resolveNativeVisionTarget(
  input: {
    preset?: Pick<ResolvedPreset, 'vision'> | null
    env?: Record<string, string | undefined>
    config?: VisionConfig | null
    authStatePath?: string
  } = {},
): Promise<NativeVisionTarget | null> {
  const env = input.env ?? process.env
  const endpoint = resolveNativeVisionEndpoint(input.preset, env, input.config?.visionModel)
  if (!endpoint) return null
  const envKey = env.PANTHEON_OPENCODE_API_KEY ?? env.OPENCODE_API_KEY
  if (envKey && envKey.trim() !== '') return { ...endpoint, apiKey: envKey }
  const authToken = await readOpencodeAuthToken(['opencode-go', 'opencode'], input.authStatePath)
  if (!authToken) return null
  return { ...endpoint, apiKey: authToken }
}

/**
 * Resolve a single image source into an OpenAI-compatible image_url payload:
 * - http(s) URL → passed through unchanged
 * - data: URI → validated + size-capped, used as-is
 * - local path → bytes read, converted to a data URI with the given MIME
 * Returns null when the source is invalid or exceeds MAX_NATIVE_IMAGE_BYTES —
 * callers fall back to the MCP tool pattern (or surface a friendly error).
 */
export async function resolveImageSourcePayload(
  source: string,
  mime: string,
): Promise<NativeImagePayload | null> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return { url: source }
  }
  if (source.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(source)
    if (!match) return null
    const approxBytes = Math.ceil(((match[2]?.length ?? 0) * 3) / 4)
    if (approxBytes > MAX_NATIVE_IMAGE_BYTES) return null
    return { url: source }
  }
  // Local path (from a file:// FilePart or a standalone tool path).
  try {
    const data = await readFile(source)
    if (data.length === 0 || data.length > MAX_NATIVE_IMAGE_BYTES) return null
    return { url: `data:${mime.toLowerCase()};base64,${data.toString('base64')}` }
  } catch {
    return null
  }
}

/**
 * Build OpenAI-compatible image_url payloads for the native vision call.
 * - data: URI → used as-is (validated + size-capped).
 * - file:// path → read bytes, converted to a data URI.
 * - http(s) URL → passed through unchanged.
 * Returns null when any image is invalid or exceeds MAX_NATIVE_IMAGE_BYTES —
 * the caller falls back to the MCP tool pattern.
 */
async function buildNativeImagePayloads(
  resolved: ReadonlyArray<{ filePart: FilePart; target: SavedImage }>,
): Promise<NativeImagePayload[] | null> {
  const payloads: NativeImagePayload[] = []
  for (const { filePart, target } of resolved) {
    const payload = await resolveImageSourcePayload(target.path, filePart.mime)
    if (!payload) return null
    payloads.push(payload)
  }
  return payloads
}

/**
 * Strip the provider prefix from a model ID before sending it to the Zen
 * gateway. The endpoint URL already encodes the provider (see
 * `resolveNativeVisionEndpoint`), and a qualified model ID such as
 * `opencode-go/mimo-v2.5` is rejected by the gateway with a 401
 * ("Model ... is not supported"). Models without a `/` are returned unchanged.
 */
export function stripProviderPrefix(modelID: string): string {
  const slash = modelID.lastIndexOf('/')
  return slash === -1 ? modelID : modelID.slice(slash + 1)
}

/**
 * Call the multimodal model directly (OpenAI-compatible /chat/completions on
 * the opencode Zen endpoint). Returns the raw description text, or null on any
 * failure (HTTP error, network error, timeout, empty content) — the caller
 * falls back to the MCP tool pattern. The image never reaches the main
 * provider: it is sent only here and replaced by the returned text.
 *
 * `prompt` overrides the default describe prompt (e.g. OCR extraction);
 * `maxTokens` caps the completion (OCR needs more headroom); `signal` links
 * an external abort (e.g. the plugin-tool ToolContext.abort) to the request.
 */
export async function describeImagesNative(
  payloads: readonly NativeImagePayload[],
  target: NativeVisionTarget,
  prompt: string = NATIVE_PROMPT,
  maxTokens: number = NATIVE_MAX_TOKENS,
  signal?: AbortSignal,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NATIVE_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    const response = await fetch(`${target.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({
        model: stripProviderPrefix(target.modelID),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...payloads.map((payload) => ({
                type: 'image_url',
                image_url: { url: payload.url },
              })),
            ],
          },
        ],
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    })
    if (!response.ok) return null
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') return null
    return content.trim()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }
}

// ─── Session description cache ─────────────────────────────────────────────
// The native path stores the gateway's text answer per session, keyed by the
// user prompt + the sorted content hashes of every image payload. An identical
// re-ask within the TTL reuses the stored text and never contacts the gateway.
// Only textual descriptions are cached — never image bytes — and a cached
// description is injected as text (it is never re-sent as an image payload).

export type DescriptionCacheEntry = { text: string; storedAt: number }

/** sha256 hex of arbitrary content (prompt, data-URI, mime+bytes). */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Composite cache key: hash of the user prompt + the sorted content hashes of
 * every image payload. The prompt is part of the key so a NEW question about
 * the same image never reuses a stale description; sorting makes the key
 * order-insensitive (the same image set in any order maps to one key). For
 * data-URI/local payloads the URL encodes both mime and bytes, so hashing it
 * covers "mime+bytes"; remote URLs hash the URL itself.
 */
export function buildDescriptionCacheKey(
  prompt: string,
  payloads: readonly { url: string }[],
): string {
  const promptHash = hashContent(prompt)
  const imageHashes = payloads.map((payload) => hashContent(payload.url)).sort()
  return [promptHash, ...imageHashes].join(':')
}

/**
 * Look up a cached description. Returns null on miss or when the entry is
 * older than `ttlMs` — callers then hit the gateway and store the result.
 */
export function getCachedDescription(
  cache: ReadonlyMap<string, DescriptionCacheEntry>,
  key: string,
  now: number = Date.now(),
  ttlMs: number = DESCRIPTION_CACHE_TTL_MS,
): string | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (now - entry.storedAt >= ttlMs) return null
  return entry.text
}

/** Store a description with the current timestamp (overwrites on re-ask). */
export function setCachedDescription(
  cache: Map<string, DescriptionCacheEntry>,
  key: string,
  text: string,
  now: number = Date.now(),
): void {
  cache.set(key, { text, storedAt: now })
}

// ─── Prompt generation ─────────────────────────────────────────────────────

export function generateInjectionPrompt(
  images: Array<{ path: string }>,
  userText: string,
  toolName: string,
  template?: string,
): string {
  if (!Array.isArray(images)) {
    throw new TypeError('Vision image resolution must return an array')
  }
  const imageList = images.map((image, index) => `- Image ${index + 1}: ${image.path}`).join('\n')
  if (template && PROMPT_TEMPLATE_VARIABLES.some((variable) => template.includes(variable))) {
    return template
      .replaceAll('{imageList}', imageList)
      .replaceAll('{imageCount}', String(images.length))
      .replaceAll('{toolName}', toolName)
      .replaceAll('{userText}', userText)
  }
  const plural = images.length > 1
  const heading = plural
    ? `The user has shared ${images.length} images. The images are available at:`
    : 'The user has shared an image. The image is available at:'
  const analyze = plural ? 'each image' : 'this image'
  return [
    heading,
    imageList,
    '',
    `Use the \`${toolName}\` tool to analyze ${analyze}.`,
    '',
    `User's request: ${userText || '(analyze the image)'}`,
  ].join('\n')
}

/**
 * Injection text for the native-vision path: the description returned by the
 * multimodal model, without any tool instruction — the main model already has
 * the visual content in text form.
 */
export function generateNativeInjection(
  description: string,
  userText: string,
  modelID: string,
): string {
  return [
    `The user shared an image. Vision description (native, ${modelID}):`,
    description,
    '',
    `User's request: ${userText || '(analyze the image)'}`,
  ].join('\n')
}

// ─── Intent-calibrated native prompts + structured responses ───────────────
// The native vision path calibrates its prompt to the user's actual request
// (compare / ocr / reconstruct / bugs / describe) and asks the multimodal
// model for a structured, parseable answer: one `<item id="N"><description>…`
// block per image plus an optional `<context>` block for cross-image analysis.
// The parser maps each item back to its image in the text injected into the
// main model; any parse failure falls back to treating the whole gateway
// answer as a single description — the turn never breaks.

export type VisionIntent = 'compare' | 'ocr' | 'reconstruct' | 'bugs' | 'describe'

const INTENT_PATTERNS: Record<Exclude<VisionIntent, 'describe'>, RegExp> = {
  compare:
    /\b(compare|comparar|comparação|diferença|diferenças|difference|differences|qual é melhor|qual e melhor|which is better|versus|vs)\b/i,
  ocr: /\b(texto|ler|read|ocr|extrair|extraia|extract|transcrever|transcreva|transcribe)\b/i,
  reconstruct:
    /\b(código|codigo|code|implementar|implemente|reconstruir|reconstrua|html|css|component|ui|tela|screen)\b/i,
  bugs: /\b(bug|erro|problema|issue|debug|não funciona|nao funciona|not working)\b/i,
}

/**
 * Classify the user's request into a vision intent, in priority order:
 * `compare` (requires 2+ images) → `ocr` → `reconstruct` → `bugs` → `describe`.
 * Term matching is case-insensitive, word-boundary based, PT + EN.
 */
export function detectVisionIntent(userText: string, imageCount: number): VisionIntent {
  if (imageCount >= 2 && INTENT_PATTERNS.compare.test(userText)) return 'compare'
  if (INTENT_PATTERNS.ocr.test(userText)) return 'ocr'
  if (INTENT_PATTERNS.reconstruct.test(userText)) return 'reconstruct'
  if (INTENT_PATTERNS.bugs.test(userText)) return 'bugs'
  return 'describe'
}

/** Escape `&`, `<`, `>` as XML entities (& first) — for template interpolation. */
export function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Reverse of `escapeXml` — applied to parsed `<description>`/`<context>` bodies. */
function unescapeXml(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

const INTENT_TASK_INSTRUCTIONS: Record<VisionIntent, string> = {
  describe:
    'Descreva cada imagem fielmente e em detalhes: texto visível verbatim, cores, layout, objetos.',
  compare:
    'Descreva cada imagem no seu próprio bloco <item>; depois coloque uma comparação direta e exaustiva no <context> (diferenças por região/elemento), terminando com um veredito claro.',
  ocr: 'Transcreva literalmente todo o texto visível em cada imagem, preservando ordem e estrutura. A transcrição vai dentro do <description> da imagem correspondente.',
  reconstruct:
    'Descreva cada imagem com detalhe de reconstrução para reprodução em código: layout completo (regiões, alinhamento, espaçamento), todo texto visível verbatim, paleta de cores exata em hex, fontes/tamanhos/pesos por elemento, estrutura de componentes e estados.',
  bugs: 'Descreva o sintoma visual observado em cada imagem: o que está errado, onde, esperado vs real, com referências de região precisas e contexto suficiente para localizar e reproduzir.',
}

const INTENT_CONTEXT_INSTRUCTIONS: Record<VisionIntent, string> = {
  compare:
    'Depois dos itens, adicione UM bloco <context> com a análise cruzada das imagens (comparação, veredito).',
  describe: '',
  ocr: '',
  reconstruct: '',
  bugs: '',
}

/**
 * Build the calibrated prompt for the native vision gateway call. The model is
 * instructed to reply with N `<item id="N"><description>…</description></item>`
 * blocks (N = imageCount) and, for `compare`, one extra `<context>` block.
 * The user's text is XML-escaped when interpolated so it cannot break the
 * format instructions. `intent` is auto-detected from `userText` +
 * `imageCount` when omitted.
 */
export function buildNativeVisionPrompt(
  userText: string,
  imageCount: number,
  intent: VisionIntent = detectVisionIntent(userText, imageCount),
): string {
  const count = Math.max(1, imageCount)
  const request =
    escapeXml(userText.trim()) || '(sem pedido explícito — descreva as imagens com precisão)'
  const contextInstruction = INTENT_CONTEXT_INSTRUCTIONS[intent]
  const contextLine = contextInstruction ? ` ${contextInstruction}` : ''
  return [
    'You are a multimodal analysis specialist embedded inside a coding assistant. The coding',
    'assistant CANNOT perceive the images in this turn — your output is its ONLY view of them.',
    'It will act on exactly what you write.',
    '',
    "READ THE USER REQUEST FIRST: infer the user's goal and calibrate the depth of each",
    'description to it.',
    '',
    INTENT_TASK_INSTRUCTIONS[intent],
    '',
    'OUTPUT FORMAT — binding, no exceptions:',
    `Responda com UM bloco <item id="N"> para cada uma das ${count} imagens anexadas`,
    `(N = 1..${count}), em ordem. Cada bloco contém um <description>.${contextLine}`,
    '',
    '<item id="1">',
    '<description>...apenas fatos sobre a imagem 1...</description>',
    '</item>',
    '<item id="2">',
    '<description>...apenas fatos sobre a imagem 2...</description>',
    '</item>',
    '',
    'RULES',
    '- O primeiro caractere da sua resposta deve ser "<". Sem preâmbulo, sem "Aqui está",',
    '  sem observações finais, sem wrap em blocos de código.',
    '- ESCAPING — obrigatório: dentro dos corpos de <description> e <context>, escape TODO',
    '  "&", "<" e ">" literais como "&amp;", "&lt;", "&gt;". Isso vale para qualquer texto',
    '  tag-like reproduzido verbatim (HTML, XML, erros com colchetes angulares). NÃO escape',
    '  as tags estruturais <item>, <description>, <context>.',
    '- Nunca invente detalhes que não consegue perceber. Se um texto estiver ilegível,',
    '  escreva "ilegível". Coloque análises cruzadas (comparação, veredito) no <context>,',
    '  nunca dentro de um <description>.',
    '',
    `User's request: ${request}`,
  ].join('\n')
}

export type StructuredVisionItem = { id: number; description: string }
export type StructuredVisionResponse = { items: StructuredVisionItem[]; context: string | null }

const ITEM_BLOCK_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
const OPEN_TAG_RE = /<item\b[^>]*>/i
const DESCRIPTION_BODY_RE = /<description>([\s\S]*?)<\/description>/i
const CONTEXT_BODY_RE = /<context>([\s\S]*?)<\/context>/i
const ITEM_ID_ATTR_RE = /id\s*=\s*["']?(\d+)["']?/i
const BARE_DESCRIPTION_RE = /<description>([\s\S]*?)<\/description>/gi

/**
 * Parse the gateway's structured answer into per-image `<item>` descriptions
 * plus an optional `<context>` block. Resistant to formatting variations
 * (whitespace, quotes, tag case, missing id → sequential ids, markdown fences
 * around the XML). XML entities in the bodies are unescaped for the main
 * model. Returns null when no `<item>`/`<description>` block is found —
 * callers then treat the whole answer as a single description (the
 * pre-structured behavior, no extra gateway call).
 */
export function parseStructuredVisionResponse(text: string): StructuredVisionResponse | null {
  const items: StructuredVisionItem[] = []
  let match = ITEM_BLOCK_RE.exec(text)
  while (match !== null) {
    const desc = DESCRIPTION_BODY_RE.exec(match[1] ?? '')
    if (desc) {
      const openTag = OPEN_TAG_RE.exec(match[0] ?? '')?.[0] ?? ''
      const rawId = ITEM_ID_ATTR_RE.exec(openTag)?.[1]
      const description = unescapeXml((desc[1] ?? '').trim())
      items.push({
        id: rawId !== undefined ? Number(rawId) : items.length + 1,
        description,
      })
    }
    match = ITEM_BLOCK_RE.exec(text)
  }
  if (items.length === 0) {
    let bareMatch = BARE_DESCRIPTION_RE.exec(text)
    while (bareMatch !== null) {
      items.push({
        id: items.length + 1,
        description: unescapeXml((bareMatch[1] ?? '').trim()),
      })
      bareMatch = BARE_DESCRIPTION_RE.exec(text)
    }
  }
  const contextMatch = CONTEXT_BODY_RE.exec(text)
  const context = contextMatch ? unescapeXml((contextMatch[1] ?? '').trim()) : null
  return items.length > 0 ? { items, context } : null
}

/**
 * Build the text injected into the main model from a parsed structured
 * response: each `<item id>` is mapped to its image (by id, falling back to
 * position when an id is missing), followed by the optional cross-image
 * `<context>` block. The fallback single-description path stays in
 * `generateNativeInjection`.
 */
export function buildStructuredInjection(
  items: readonly StructuredVisionItem[],
  context: string | null,
  userText: string,
  modelID: string,
  imageCount: number,
): string {
  const count = Math.max(1, imageCount)
  const byId = new Map(items.map((item) => [item.id, item.description]))
  const header =
    count > 1
      ? `The user shared ${count} images. Vision descriptions (native, ${modelID}):`
      : `The user shared an image. Vision description (native, ${modelID}):`
  const lines = [header]
  for (let i = 1; i <= count; i += 1) {
    const description = byId.get(i) ?? items[i - 1]?.description
    lines.push(`- Image ${i}: ${description ?? '(no description provided)'}`)
  }
  if (context) {
    lines.push('', 'Cross-image context:', context)
  }
  lines.push('', `User's request: ${userText || '(analyze the image)'}`)
  return lines.join('\n')
}

// ─── Tool name resolution ──────────────────────────────────────────────────
// env PANTHEON_VISION_TOOL > config imageAnalysisTool > dynamic detection
// (prefer the canonical Pantheon MCP) > canonical Pantheon MCP default —
// but ONLY when real evidence says the MCP is available (P2-3).

/**
 * Real evidence that the pantheon-vision MCP is available at runtime:
 *  - its tools appear in client.tool.ids() (direct), OR
 *  - client.mcp.status() lists it with status 'connected' (registration).
 * With --no-mcp / an uninstalled MCP there is NO such evidence, and
 * defaulting to the canonical tool would make the model call a tool that
 * does not exist — callers must return null instead ('Vision fallback
 * unavailable').
 */
async function hasPantheonVisionMcp(
  client: PluginInput['client'],
  directory: string,
): Promise<boolean> {
  try {
    const idsResponse = await client.tool?.ids?.({ query: { directory } })
    const ids = idsResponse?.data
    if (Array.isArray(ids) && ids.some((id) => isPantheonVisionServerTool(id))) return true
  } catch {
    // Fall through to the MCP status map.
  }
  try {
    const mcpResponse = await client.mcp?.status?.({ query: { directory } })
    const statuses = mcpResponse?.data
    if (statuses && typeof statuses === 'object') {
      for (const [name, status] of Object.entries(statuses)) {
        if (!/[pP]antheon[-_]vision/.test(name)) continue
        if ((status as { status?: string } | undefined)?.status === 'connected') return true
      }
    }
  } catch {
    // Fall through — no evidence.
  }
  return false
}

async function resolveImageAnalysisTool(
  client: PluginInput['client'],
  directory: string,
  configPromise: Promise<VisionConfig>,
): Promise<string | null> {
  const envTool = process.env.PANTHEON_VISION_TOOL?.trim()
  if (envTool) return envTool
  const config = await configPromise
  if (config.imageAnalysisTool) return config.imageAnalysisTool
  try {
    const response = await client.tool?.ids?.({ query: { directory } })
    const ids = response?.data
    if (Array.isArray(ids)) {
      // Exact canonical ID first (fast path), then the underscore form and the
      // legacy mcp__ hyphen form (both match the pantheon[-_]vision + action
      // regexes), then the loose describe fallback for older ID shapes.
      const match =
        ids.find((id) => id === DEFAULT_IMAGE_ANALYSIS_TOOL) ??
        ids.find((id) => isPantheonVisionServerTool(id) && isPantheonVisionActionTool(id)) ??
        ids.find((id) => isPantheonVisionServerTool(id) && /describe/i.test(id))
      if (match) return match
    }
  } catch {
    // Detection failed (network/MCP error). Returning null keeps the explicit
    // 'Vision fallback unavailable' safe-failure message in the turn instead
    // of guessing at a tool we could not verify — the turn never breaks
    // (interception is best-effort). Returning DEFAULT here too would hide
    // real detection failures behind a tool name the model might not have.
    return null
  }
  // OpenCode 1.18.11 keeps MCP tools in the MCP service, NOT in
  // client.tool.ids() — an empty/absent list is the NORMAL runtime state, so
  // fall back to the canonical default ONLY when there is independent
  // evidence the pantheon-vision MCP is installed and connected. Without it
  // (--no-mcp, uninstalled, disabled) instructing the canonical tool would
  // fail the turn with a phantom tool — return null instead.
  const available = await hasPantheonVisionMcp(client, directory)
  return available ? DEFAULT_IMAGE_ANALYSIS_TOOL : null
}

// ─── Temp image lifecycle ──────────────────────────────────────────────────

/**
 * Age-guarded, REFCOUNTED cleanup of a session's temp images.
 *
 * A `session.idle` can fire between auto-continue turns — not just at real
 * session end — so a temp file referenced by the next turn (seconds old) must
 * survive. Only paths older than `graceMs` are unlinked; younger paths stay
 * registered and are swept by the next idle. `server.instance.disposed` and
 * `session.deleted` pass `graceMs = 0` to unlink everything while the session
 * is gone / process is dying.
 *
 * Content-hash filenames dedup identical images ACROSS sessions: two sessions
 * can reference the SAME path. `tempFileRefs` (path → set of sessions) makes
 * the unlink decision reference-aware — the file is only unlinked when the
 * LAST referencing session releases it; otherwise the other session's MCP
 * tool call would hit file-not-found (P2-4). When `tempFileRefs` is omitted
 * (legacy callers) the unconditional behavior is kept.
 *
 * The temp directory itself is never removed: it may hold files from other
 * sessions or processes. The session's description cache is always dropped
 * (cache is per-session state).
 */
export async function cleanupSessionTempImages(
  sessionTempFiles: Map<string, Map<string, number>>,
  sessionVisionText: Map<string, Map<string, string>>,
  nativeVisionSessions: Set<string>,
  sessionID: string,
  graceMs: number = TEMP_FILE_GRACE_MS,
  sessionDescriptionCache?: Map<string, Map<string, DescriptionCacheEntry>>,
  tempFileRefs?: Map<string, Set<string>>,
): Promise<void> {
  const files = sessionTempFiles.get(sessionID)
  if (files) {
    const now = Date.now()
    for (const [path, createdAt] of files) {
      // graceMs === 0 means "unlink everything now" (session gone / process
      // dying); a positive grace skips files younger than the threshold so the
      // next auto-continue turn can still read them.
      if (graceMs > 0 && now - createdAt <= graceMs) continue
      const refs = tempFileRefs?.get(path)
      if (refs && tempFileRefs) {
        refs.delete(sessionID)
        // Another session still references this content-hash path: keep the
        // file on disk and drop this session's tracking of it.
        if (refs.size > 0) {
          files.delete(path)
          continue
        }
        tempFileRefs.delete(path)
      }
      try {
        await unlink(path)
      } catch {
        // Best effort.
      }
      forgetTempFile(path)
      files.delete(path)
    }
    if (files.size === 0) sessionTempFiles.delete(sessionID)
  }
  sessionVisionText.delete(sessionID)
  nativeVisionSessions.delete(sessionID)
  sessionDescriptionCache?.delete(sessionID)
}

type VisionHistoryMessage = {
  info?: { sessionID?: string; id?: string }
  sessionID?: string
  id?: string
  parts?: unknown
  content?: unknown
  [key: string]: unknown
}

function syntheticHistoryPart(message: VisionHistoryMessage, text: string): TextPart {
  return {
    id: syntheticPartId(),
    sessionID: message.info?.sessionID ?? '',
    messageID: message.info?.id ?? '',
    type: 'text',
    text,
    synthetic: true,
  }
}

/**
 * Remove image-bearing parts before a provider serializer can turn them into
 * image_url content. This hook is deliberately synchronous in spirit: it only
 * reuses text cached by chat.message and never calls a vision tool/model.
 */
export function sanitizeVisionHistory(
  output: { messages?: unknown },
  sessionVisionText: ReadonlyMap<string, ReadonlyMap<string, string>>,
  nativeVisionSessions: ReadonlySet<string> = new Set(),
): void {
  if (!Array.isArray(output.messages)) return

  for (const message of output.messages) {
    if (!message || typeof message !== 'object') continue
    const historyMessage = message as VisionHistoryMessage
    const sessionID = historyMessage.info?.sessionID ?? historyMessage.sessionID ?? ''
    if (nativeVisionSessions.has(sessionID)) continue
    const descriptions = sessionVisionText.get(sessionID)
    const sanitize = (value: unknown, inParts: boolean): unknown => {
      if (Array.isArray(value)) return value.map((item) => sanitize(item, inParts))
      if (!value || typeof value !== 'object') return value

      const raw = value as { type?: unknown; id?: unknown; mime?: unknown }
      const isImageUrl = raw.type === 'image_url'
      const isImageFile =
        raw.type === 'file' &&
        typeof raw.mime === 'string' &&
        raw.mime.toLowerCase().startsWith('image/')
      if (isImageUrl || isImageFile) {
        const partID = typeof raw.id === 'string' ? raw.id : ''
        const text =
          descriptions?.get(partID) ??
          'Imagem removida do histórico antes do envio ao provedor textual.'
        return inParts ? syntheticHistoryPart(historyMessage, text) : { type: 'text', text }
      }

      const copy: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        copy[key] = sanitize(child, key === 'parts')
      }
      return copy
    }

    const sanitized = sanitize(historyMessage, false) as VisionHistoryMessage
    for (const [key, value] of Object.entries(sanitized)) {
      historyMessage[key] = value
    }
  }
}

// ─── Handler factory ───────────────────────────────────────────────────────

export function createVisionHandler(input: PluginInput) {
  const { client, directory } = input
  const sessionTempFiles = new Map<string, Map<string, number>>()
  // Content-hash dedup makes identical images share one path ACROSS sessions;
  // this map (path → sessions holding it) makes cleanup reference-aware so a
  // file is only unlinked when the LAST session releases it (P2-4).
  const tempFileRefs = new Map<string, Set<string>>()
  const sessionVisionText = new Map<string, Map<string, string>>()
  const nativeVisionSessions = new Set<string>()
  const sessionDescriptionCache = new Map<string, Map<string, DescriptionCacheEntry>>()
  let configPromise: Promise<VisionConfig> | null = null
  let toolNamePromise: Promise<string | null> | null = null

  const getConfig = (): Promise<VisionConfig> => {
    configPromise ??= loadVisionConfig(directory)
    return configPromise
  }

  const getToolName = (): Promise<string | null> => {
    toolNamePromise ??= resolveImageAnalysisTool(client, directory, getConfig())
    return toolNamePromise
  }

  const chatMessage: NonNullable<Hooks['chat.message']> = async (hookInput, output) => {
    try {
      const message: UserMessage | undefined = output?.message
      if (!message || message.role !== 'user') return
      const model = hookInput?.model ?? message.model
      if (modelAcceptsImages(model)) {
        nativeVisionSessions.add(hookInput.sessionID)
        return
      }
      nativeVisionSessions.delete(hookInput.sessionID)
      const config = await getConfig()
      const patterns =
        config.models && config.models.length > 0 ? config.models : DEFAULT_MODEL_PATTERNS
      if (!modelMatchesAnyPattern(model, patterns)) {
        // Pattern configuration may disable enrichment, but it must never
        // disable the text-only provider safety boundary.
        const currentTurn = { messages: [{ ...message, parts: output.parts }] }
        sanitizeVisionHistory(currentTurn, sessionVisionText)
        const sanitized = currentTurn.messages as VisionHistoryMessage[]
        output.parts.splice(0, output.parts.length, ...((sanitized[0]?.parts as Part[]) ?? []))
        return
      }

      const parts: Part[] = Array.isArray(output.parts) ? output.parts : []
      const images = parts.filter(isImageFilePart)
      if (images.length === 0) {
        // Some runtimes hand the current turn to plugins already serialized as
        // provider content. Do not let that shape bypass the final sanitizer.
        const currentTurn = { messages: [{ ...message, parts: output.parts }] }
        sanitizeVisionHistory(currentTurn, sessionVisionText)
        const sanitized = currentTurn.messages as VisionHistoryMessage[]
        output.parts.splice(0, output.parts.length, ...((sanitized[0]?.parts as Part[]) ?? []))
        return
      }

      const userText = parts
        .filter(isTextPart)
        .map((part) => part.text)
        .join('\n')
        .trim()

      const resolved: Array<{ filePart: FilePart; target: SavedImage }> = []
      for (const image of images.filter(isSupportedImageFilePart)) {
        const target = await resolveImageTarget(image)
        if (target) resolved.push({ filePart: image, target })
      }
      const saved = resolved.map((item) => item.target)

      const tempPaths = saved.filter((item) => item.temporary).map((item) => item.path)
      if (tempPaths.length > 0) {
        const createdAt = Date.now()
        const existing = sessionTempFiles.get(hookInput.sessionID) ?? new Map<string, number>()
        for (const path of tempPaths) {
          existing.set(path, createdAt)
          // Track the session as a holder of this (content-hash) path so
          // cleanup only unlinks when the LAST holder releases it.
          let refs = tempFileRefs.get(path)
          if (!refs) {
            refs = new Set()
            tempFileRefs.set(path, refs)
          }
          refs.add(hookInput.sessionID)
        }
        sessionTempFiles.set(hookInput.sessionID, existing)
      }

      // Native-first: call the multimodal model directly when a key exists
      // (mode auto/native). Any failure — no key, unsupported provider,
      // oversized/invalid image, HTTP/network error — falls back to the tool.
      // The prompt is calibrated to the user's intent (compare/ocr/
      // reconstruct/bugs/describe) and asks for a structured answer
      // (<item>/<context>), which is parsed and mapped back to each image.
      // Descriptions are cached per session: the key is the calibrated prompt
      // + the content hashes of the images, so an identical re-ask within the
      // TTL reuses the stored (possibly structured) text without another
      // gateway call, while a new question about the same image misses and is
      // answered freshly.
      let injection: string | null = null
      if (getVisionMode(process.env, config.mode) !== 'tool') {
        try {
          const target = await resolveNativeVisionTarget({ config })
          if (target) {
            const payloads = await buildNativeImagePayloads(resolved)
            if (payloads) {
              let sessionCache = sessionDescriptionCache.get(hookInput.sessionID)
              if (!sessionCache) {
                sessionCache = new Map()
                sessionDescriptionCache.set(hookInput.sessionID, sessionCache)
              }
              const intent = detectVisionIntent(userText, payloads.length)
              const prompt = buildNativeVisionPrompt(userText, payloads.length, intent)
              const cacheKey = buildDescriptionCacheKey(prompt, payloads)
              let rawText = getCachedDescription(sessionCache, cacheKey)
              if (rawText === null) {
                rawText = await describeImagesNative(payloads, target, prompt)
                if (rawText !== null) setCachedDescription(sessionCache, cacheKey, rawText)
              }
              if (rawText !== null) {
                const structured = parseStructuredVisionResponse(rawText)
                injection = structured
                  ? buildStructuredInjection(
                      structured.items,
                      structured.context,
                      userText,
                      target.modelID,
                      payloads.length,
                    )
                  : generateNativeInjection(rawText, userText, target.modelID)
              }
            }
          }
        } catch {
          // Native vision is best-effort; fall back to the tool pattern.
        }
      }

      if (injection === null && saved.length > 0) {
        const toolName = await getToolName()
        injection = toolName
          ? generateInjectionPrompt(saved, userText, toolName, config.promptTemplate)
          : 'Vision fallback unavailable: pantheon-vision MCP is unavailable. The image was removed safely; please configure the MCP server and retry.'
      }
      if (injection === null) {
        injection = 'A imagem compartilhada foi removida antes do envio ao provedor textual.'
      }

      const descriptions = sessionVisionText.get(hookInput.sessionID) ?? new Map<string, string>()
      for (const image of images) descriptions.set(image.id, injection)
      sessionVisionText.set(hookInput.sessionID, descriptions)

      const injectionPart: TextPart = {
        id: syntheticPartId(),
        sessionID: message.sessionID,
        messageID: message.id,
        type: 'text',
        text: injection,
        synthetic: true,
      }
      const kept = parts.filter((part) => !isImageFilePart(part))
      // Mutate in place: drop image parts, lead with the vision text
      // (native description or tool instruction).
      output.parts.splice(0, output.parts.length, injectionPart, ...kept)
      sanitizeVisionHistory({ messages: [{ ...message, parts: output.parts }] }, sessionVisionText)
    } catch {
      // Vision interception is best-effort; never fail a user turn.
    }
  }

  const event: NonNullable<Hooks['event']> = async ({ event: ev }) => {
    if (ev.type === 'session.idle') {
      // An idle can fire between auto-continue turns: temp files younger than
      // the grace period survive, but the per-session description cache is
      // dropped (it is pure optimization, safe to reset on every idle).
      const sessionID = ev.properties?.sessionID
      if (sessionID)
        await cleanupSessionTempImages(
          sessionTempFiles,
          sessionVisionText,
          nativeVisionSessions,
          sessionID,
          TEMP_FILE_GRACE_MS,
          sessionDescriptionCache,
          tempFileRefs,
        )
    } else if (ev.type === 'session.deleted') {
      // The session is gone for good: no active turn can reference its temp
      // images, so unlink them all immediately and drop its cached state.
      // Shared paths survive while another session still references them.
      const sessionID = ev.properties.info.id
      await cleanupSessionTempImages(
        sessionTempFiles,
        sessionVisionText,
        nativeVisionSessions,
        sessionID,
        0,
        sessionDescriptionCache,
        tempFileRefs,
      )
    } else if (ev.type === 'server.instance.disposed') {
      const sessions = [...sessionTempFiles.keys()]
      for (const sessionID of sessions) {
        await cleanupSessionTempImages(
          sessionTempFiles,
          sessionVisionText,
          nativeVisionSessions,
          sessionID,
          0, // The process is dying: unlink everything immediately.
          sessionDescriptionCache,
          tempFileRefs,
        )
      }
      sessionVisionText.clear()
      sessionDescriptionCache.clear()
    }
  }

  const messagesTransform: NonNullable<Hooks['experimental.chat.messages.transform']> = async (
    _hookInput,
    output,
  ) => {
    try {
      sanitizeVisionHistory(output, sessionVisionText, nativeVisionSessions)
    } catch {
      // History sanitization is best effort; never break runtimes that expose
      // the experimental hook with a partial output shape.
    }
  }

  return { chatMessage, messagesTransform, event }
}
