import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import type { FilePart, Part, TextPart, UserMessage } from '@opencode-ai/sdk'
import type { ResolvedPreset } from './presets.mjs'
import {
  CAPABILITY_TABLE,
  hasVision,
  resolveActivePreset,
  visionBrokenOnGateway,
} from './presets.mjs'
import { buildLocalVisionBlock } from './vision-local.ts'

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
// model DIRECTLY via an OpenAI-compatible endpoint and the image is replaced
// by the returned text description (no MCP tool). The MCP tool pattern
// (imageAnalysisTool) remains the fallback for missing keys / provider errors.
//
// Model + endpoint come from the host catalog (GET /config/providers) when no
// explicit model is configured (env > config > preset > discovery > DEFAULT);
// the Zen endpoints stay as the no-catalog fallback. anthropic/openai native
// vision works only when their catalog entries declare an OpenAI-compatible
// wire format (see NATIVE_VISION_NPM_ALLOWLIST) — otherwise they fall back to
// the MCP tool pattern.

const DEFAULT_VISION_MODEL = 'opencode-go/mimo-v2.5'
const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
const ZEN_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
const NATIVE_PROMPT =
  'Descreva fielmente esta imagem em detalhes (texto visível, cores, layout, objetos).'
/**
 * Base timeout for the native vision gateway call (small/unknown payloads).
 * 60s, not 20s: the vision model is a REASONING model (mimo-v2.6-flash) and a
 * measured round-trip for a ~380 KB image spends 1.0k–1.2k tokens on reasoning
 * alone, completing in 20–30s. A 20s base aborted legitimate completed
 * descriptions as `network`/timeout (observed at exactly 20000ms). The per-MB
 * term below still scales larger payloads; THIS base carries the reasoning
 * overhead that no payload term captures.
 */
const NATIVE_TIMEOUT_MS = 60_000
/** Extra timeout per whole MB of image payload (linear scaling from the base). */
const NATIVE_TIMEOUT_PER_MB_MS = 10_000
/** Hard ceiling for the native vision gateway call (showlotus reference: 300s). */
const NATIVE_TIMEOUT_MAX_MS = 300_000
const BYTES_PER_MB = 1024 * 1024
/**
 * Completion-token ceiling for the native vision call. The model spends this
 * budget on REASONING tokens FIRST: measured 1023 reasoning tokens against a
 * 1024 cap (content came back null with finish_reason "length"), while 2048
 * finished normally (`stop`) with a complete description. The former 500
 * truncated EVERY reasoning call. Exported so the V2 tool surface shares one
 * value instead of hard-coding its own copy.
 */
export const NATIVE_MAX_TOKENS = 2048
const MAX_NATIVE_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Dynamic timeout for a native vision call, scaled by the payload size
 * (adapted from showlotus/opencode-image-vision's 120s→300s scheme to this
 * codebase's 60s base): base for small/unknown payloads, +10s per whole MB,
 * hard-capped at 300s. Large base64 uploads take measurably longer to
 * reach/read on the gateway side, and the previous fixed 20s budget dropped
 * legitimate large-image descriptions as timeouts.
 */
export function computeNativeTimeoutMs(totalBytes: number): number {
  const bytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0
  const mb = Math.floor(bytes / BYTES_PER_MB)
  return Math.min(NATIVE_TIMEOUT_MAX_MS, NATIVE_TIMEOUT_MS + mb * NATIVE_TIMEOUT_PER_MB_MS)
}

/**
 * Approximate decoded byte size of every payload in the call, summed.
 * Data URIs are measured by their base64 length (×3/4); remote http(s) URLs
 * contribute 0 — their size is unknown without a network round-trip, so they
 * get the base budget (fail-safe, not optimistic).
 */
function estimateNativePayloadsBytes(payloads: readonly NativeImagePayload[]): number {
  let total = 0
  for (const payload of payloads) {
    const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(payload.url)
    total += match ? Math.ceil(((match[1]?.length ?? 0) * 3) / 4) : 0
  }
  return total
}

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

export type NativeVisionTarget = {
  modelID: string
  baseURL: string
  apiKey: string
  /**
   * OpenCode session id, sent as the `x-opencode-session` header — and ONLY on
   * Zen endpoints (`https://opencode.ai/zen/...`). The Zen gateway rejects a
   * request without it (HTTP 400 `MissingSessionID`). Optional: callers attach
   * it at the request site (`{ ...target, sessionID }`); a target without it
   * never carries the header. Non-Zen providers must never receive it.
   */
  sessionID?: string
}

/**
 * Non-sensitive reason a native describe produced no text. Carries ONLY the
 * HTTP status and the model's `finish_reason` (never the key, payload, or
 * gateway body) so a caller can build an actionable error without leaking
 * anything.
 */
export type NativeVisionFailure = {
  reason: 'http' | 'network' | 'timeout' | 'empty' | 'cancelled'
  status?: number
  /**
   * OpenAI-compatible `finish_reason` (e.g. `length` when a reasoning model was
   * cut off by `max_tokens`) — surfaced so a "no text" failure becomes
   * actionable instead of opaque.
   */
  finishReason?: string
  /**
   * The budget that elapsed when OUR dynamic timer aborted the request. Set
   * only for `reason: 'timeout'`; a genuine transport drop stays `network`, so
   * a timed-out reasoning call no longer reads as a vague "network error".
   */
  timeoutMs?: number
}

type NativeVisionEndpoint = { modelID: string; baseURL: string }

// ─── Model catalog (host discovery, GET /config/providers) ──────────────────
// Defensive subset of the SDK `Model`/`Provider` shapes (see
// node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts). Parsed with optional
// chaining — a malformed catalog entry is skipped, never a crash.

export type VisionCatalogModel = {
  id?: unknown
  providerID?: unknown
  status?: unknown
  capabilities?: { input?: { image?: unknown } } | undefined
  api?: { url?: unknown; npm?: unknown } | undefined
  cost?: { input?: unknown } | undefined
}

export type VisionCatalogProvider = {
  id?: unknown
  models?: unknown
}

/** Body of GET /config/providers (defensive subset), or any garbage. */
export type VisionCatalog =
  | {
      providers?: unknown
      models?: unknown
    }
  | null
  | undefined

/**
 * npm provider packages whose wire format is OpenAI-compatible
 * (`POST {base}/chat/completions` with `image_url` content parts) — the only
 * shape `describeImagesNative` speaks. `@ai-sdk/openai-compatible` is what
 * opencode's Zen providers use; `@ai-sdk/openai` is the same wire format.
 * Packages like `@ai-sdk/anthropic` are NOT compatible and must never be
 * picked by discovery (Q2 conservative allowlist).
 */
const NATIVE_VISION_NPM_ALLOWLIST: ReadonlySet<string> = new Set([
  '@ai-sdk/openai-compatible',
  '@ai-sdk/openai',
])

/**
 * Legacy Zen auth-store provider IDs. Zen endpoints ONLY — a non-Zen provider
 * resolved through the npm allowlist must use its own auth-store entry, never
 * these. The historical Zen order is kept as a fallback for Zen models.
 */
const LEGACY_VISION_AUTH_PROVIDER_IDS: readonly string[] = ['opencode-go', 'opencode']

/**
 * Whether `providerID` is an OpenCode-hosted (Zen) provider. Only Zen providers
 * may use the shared credential sources — the `PANTHEON_OPENCODE_API_KEY` /
 * `OPENCODE_API_KEY` env keys and the legacy `opencode-go` / `opencode` auth
 * entries. A non-Zen provider (discovered or explicit) must resolve its OWN
 * auth-store entry, else the native path returns null and the image falls
 * through the tool→local chain.
 */
function isZenProvider(providerID: string): boolean {
  return providerID === 'opencode' || providerID.startsWith('opencode-go')
}

/** Provider prefix of a qualified `provider/model` id (the id itself if bare). */
function providerOf(modelID: string): string {
  const slash = modelID.indexOf('/')
  return slash === -1 ? modelID : modelID.slice(0, slash)
}

/**
 * Whether a resolved native target points at an OpenCode Zen endpoint. The
 * gateway host is the security boundary for the `x-opencode-session` header
 * (the header travels to `baseURL`, not to the model id): the session identity
 * must reach `https://opencode.ai/zen/...` and NOTHING else. A target qualifies
 * only when BOTH the model's provider is Zen AND the base URL is a Zen
 * endpoint — a mismatch degrades to "no header" (the gateway then answers with
 * its actionable HTTP 400, never a cross-provider leak).
 */
export function isZenNativeTarget(
  target: Pick<NativeVisionTarget, 'modelID' | 'baseURL'>,
): boolean {
  if (!isZenProvider(providerOf(target.modelID))) return false
  return /^https:\/\/opencode\.ai\/zen\//i.test(target.baseURL)
}

/**
 * Build an actionable, non-sensitive message for a failed native describe.
 * Maps the gateway status/`finish_reason` to the known Zen failures —
 * 400 `MissingSessionID` (session header absent), 403 (free-tier model usable
 * only from inside OpenCode, or the account has no paid access), 401
 * (credential/model) — separates OUR budget expiring (`timeout`) from a genuine
 * transport drop (`network`), and surfaces `finish_reason` when the model
 * returned no text (e.g. `length` = truncated by `max_tokens`). An EXTERNAL
 * cancellation (`cancelled`, e.g. a `ToolContext.signal` abort) gets a neutral
 * message with no "retry" guidance — the abort was deliberate, not transient.
 * Never includes the credential, image payload, or session id.
 */
export function nativeVisionFailureMessage(
  failure: NativeVisionFailure | undefined,
  modelID: string,
): string {
  if (failure?.reason === 'timeout') {
    const budget = failure.timeoutMs ? ` after ${Math.round(failure.timeoutMs / 1000)}s` : ''
    return `the multimodal model request timed out${budget}: the image-description budget elapsed before a response — retry, or raise the timeout budget`
  }
  if (failure?.reason === 'cancelled') {
    return 'the multimodal model request was cancelled before it completed'
  }
  if (failure?.reason === 'network') {
    return 'the multimodal model request failed (network error): the connection was dropped before the description completed — retry the describe'
  }
  const status = failure?.reason === 'http' ? failure.status : undefined
  if (status === 400) {
    return 'the Zen gateway rejected the request (HTTP 400 MissingSessionID): the x-opencode-session header is missing — the request must carry a real OpenCode session id'
  }
  if (status === 401) {
    return `the OpenCode Zen gateway rejected the credential (HTTP 401); verify the credential and that ${modelID} supports image input on its endpoint`
  }
  if (status === 403) {
    return `the OpenCode Zen gateway denied access (HTTP 403) to ${modelID}: the model may be free-tier (usable only from inside OpenCode) or this account has no paid access to it`
  }
  if (status !== undefined) {
    return `the Zen gateway rejected the request (HTTP ${status}) for ${modelID}`
  }
  if (failure?.reason === 'empty') {
    const finish = failure.finishReason
    if (finish === 'length') {
      return 'the model returned no text (finish_reason: length) — the response was truncated by max_tokens; raise max_tokens or choose a non-reasoning image model'
    }
    if (finish) {
      return `the model returned no text (finish_reason: ${finish})`
    }
    return 'the multimodal model returned no text'
  }
  return 'the multimodal model returned no text or the request failed'
}

/**
 * How long a fetched providers catalog stays cached, per client (process).
 * Short TTL: the catalog is one HTTP round-trip to the local opencode server
 * and must NOT be refetched on every user turn, yet must pick up model
 * changes within a session without a restart.
 */
export const PROVIDERS_CACHE_TTL_MS = 60_000

export type VisionMode = 'native' | 'tool' | 'auto'

/**
 * Check whether a provider is text-only by examining CAPABILITY_TABLE.
 * A provider is text-only if ALL provider-qualified entries (prefix starting
 * with `providerID/`) have `vision: false`. If no provider-qualified entries
 * exist, the provider is unknown → returns false (fail-open).
 */
export function providerIsTextOnly(providerID: string): boolean {
  const providerEntries = CAPABILITY_TABLE.filter((entry) =>
    entry.prefix.startsWith(`${providerID}/`),
  )
  if (providerEntries.length === 0) return false
  return providerEntries.every((entry) => !entry.vision)
}

/** Return whether OpenCode's current model is known to accept image input. */
export function modelAcceptsImages(model: ModelInfo | undefined, providerID?: string): boolean {
  if (!model) {
    // Fail-closed for known text-only providers
    if (providerID && providerIsTextOnly(providerID)) return false
    return true
  }
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

// ─── Catalog parsing & discovery ───────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

type CatalogEntry = {
  /** Qualified id: `providerID/modelID`. */
  modelID: string
  providerID: string
  image: boolean
  url: string | null
  npm: string | null
  costInput: number | null
  deprecated: boolean
}

/** Parse one catalog model defensively; null when the entry has no usable id. */
function parseCatalogEntry(raw: Record<string, unknown>, providerID: string): CatalogEntry | null {
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null
  if (!id) return null
  const entryProvider =
    typeof raw.providerID === 'string' && raw.providerID.trim() !== ''
      ? raw.providerID.trim()
      : providerID
  if (!entryProvider) return null
  const api = asRecord(raw.api)
  const url = typeof api?.url === 'string' && api.url.trim() !== '' ? api.url.trim() : null
  const npm = typeof api?.npm === 'string' && api.npm.trim() !== '' ? api.npm.trim() : null
  const input = asRecord(asRecord(raw.capabilities)?.input)
  const cost = asRecord(raw.cost)
  return {
    modelID: `${entryProvider}/${id}`,
    providerID: entryProvider,
    image: input?.image === true,
    url,
    npm,
    costInput: typeof cost?.input === 'number' && Number.isFinite(cost.input) ? cost.input : null,
    deprecated: raw.status === 'deprecated',
  }
}

/**
 * Flatten a catalog payload into entries. Accepts the canonical
 * `{ providers: [{ id, models: { [id]: Model } }] }` shape and, defensively,
 * a top-level `{ models: Model[] }` array.
 */
function catalogEntries(catalog: unknown): CatalogEntry[] {
  const root = asRecord(catalog)
  if (!root) return []
  const entries: CatalogEntry[] = []
  if (Array.isArray(root.providers)) {
    for (const provider of root.providers) {
      const p = asRecord(provider)
      if (!p) continue
      const pid = typeof p.id === 'string' ? p.id : ''
      const models = asRecord(p.models)
      if (!models) continue
      for (const model of Object.values(models)) {
        const m = asRecord(model)
        if (!m) continue
        const entry = parseCatalogEntry(m, pid)
        if (entry) entries.push(entry)
      }
    }
  }
  if (Array.isArray(root.models)) {
    for (const model of root.models) {
      const m = asRecord(model)
      if (!m) continue
      const entry = parseCatalogEntry(m, '')
      if (entry) entries.push(entry)
    }
  }
  return entries
}

/**
 * Whether the provider speaks an OpenAI-compatible wire format the native
 * vision call can use: the known Zen providers, or an npm package on the
 * conservative allowlist. Unknown/incompatible → false → callers fall back
 * to the MCP tool pattern (Q2).
 */
function providerSupportsNativeVision(providerID: string, npm: string | null): boolean {
  if (isZenProvider(providerID)) return true
  return npm !== null && NATIVE_VISION_NPM_ALLOWLIST.has(npm)
}

/**
 * Whether a catalog entry is FREE-TIER. Free-tier Zen models are rejected by
 * the direct gateway (HTTP 403 "free tier can only be used from within
 * OpenCode"), so they must never be picked on the native describe path. Two
 * conservative signals: an explicit `cost.input <= 0`, OR a `-free` id suffix.
 * `<= 0` (not `=== 0`) matches V2's `isFreeVisionModel` so a malformed negative
 * cost can never be treated as paid on one path and free on the other.
 */
function catalogEntryIsFree(entry: CatalogEntry): boolean {
  return (entry.costInput !== null && entry.costInput <= 0) || /-free$/i.test(entry.modelID)
}

/**
 * Pick the vision model from a host catalog: image-capable, wire-compatible,
 * not deprecated, and NOT free-tier (cheapest first, ties broken
 * lexicographically for determinism). Free-tier models are excluded because the
 * direct gateway cannot use them. Returns the qualified model ID and its
 * catalog base URL, or null when nothing qualifies (callers then use
 * DEFAULT_VISION_MODEL with the legacy Zen endpoint).
 */
export function discoverVisionModel(catalog: unknown): { modelID: string; baseURL: string } | null {
  const candidates = catalogEntries(catalog).filter(
    (entry) =>
      entry.image &&
      !entry.deprecated &&
      !catalogEntryIsFree(entry) &&
      providerSupportsNativeVision(entry.providerID, entry.npm) &&
      entry.url !== null &&
      /^https?:\/\//i.test(entry.url),
  )
  if (candidates.length === 0) return null
  candidates.sort((left, right) => {
    const price = (entry: CatalogEntry): number =>
      entry.costInput === null ? Number.POSITIVE_INFINITY : entry.costInput
    return price(left) - price(right) || left.modelID.localeCompare(right.modelID)
  })
  const pick = candidates[0]
  return pick?.url ? { modelID: pick.modelID, baseURL: pick.url } : null
}

/**
 * Catalog base URL for an EXPLICITLY configured model, honoring the same
 * compatibility gate. Returns null when the model is absent from the catalog
 * or its entry is unusable — the caller then applies the legacy Zen mapping
 * (the catalog never gates a Zen model that the old code already supported).
 */
function catalogEndpointFor(modelID: string, catalog: unknown): string | null {
  const slash = modelID.indexOf('/')
  if (slash < 1) return null
  for (const entry of catalogEntries(catalog)) {
    if (entry.modelID !== modelID) continue
    if (!providerSupportsNativeVision(entry.providerID, entry.npm)) return null
    return entry.url !== null && /^https?:\/\//i.test(entry.url) ? entry.url : null
  }
  return null
}

/**
 * Historical hardcoded Zen endpoint mapping (opencode-go* → zen/go/v1,
 * opencode → zen/v1, else null). Fallback only — used when there is no
 * catalog (or the model is not in it) so existing setups keep working.
 */
function legacyZenBaseURL(modelID: string): string | null {
  const providerID = modelID.slice(0, modelID.indexOf('/'))
  if (providerID.startsWith('opencode-go')) return ZEN_GO_BASE_URL
  if (providerID === 'opencode') return ZEN_BASE_URL
  return null
}

const providersCatalogCache = new WeakMap<object, { payload: unknown; at: number }>()

/**
 * Fetch (and TTL-cache per client) the host provider catalog via
 * `client.config.providers()` (GET /config/providers). Never throws: any
 * failure — client absent, HTTP error, malformed payload — yields null, and
 * the null itself is cached so a broken server is not hammered per request.
 * Discovery talks ONLY to the local opencode server — never via bifrost.
 */
export async function fetchProvidersCatalog(
  client: PluginInput['client'] | undefined | null,
): Promise<unknown> {
  if (!client || typeof client !== 'object') return null
  const cached = providersCatalogCache.get(client)
  const now = Date.now()
  if (cached && now - cached.at < PROVIDERS_CACHE_TTL_MS) return cached.payload
  let payload: unknown = null
  try {
    const providers = asRecord(client)?.config as
      | { providers?: (options?: unknown) => Promise<unknown> }
      | undefined
    if (typeof providers?.providers === 'function') {
      const response = await providers.providers()
      payload = asRecord(response)?.data ?? null
    }
  } catch {
    payload = null
  }
  providersCatalogCache.set(client, { payload, at: now })
  return payload
}

// ─── Config loading (project > user) ──────────────────────────────────────

// ─── OpenCode auth store (fallback credential source) ────────────────────
// `opencode auth login` stores provider tokens in <data dir>/auth.json on V1
// and in a `credential` table inside <data dir>/opencode.db on V2. The vision
// plugin reads BOTH stores so a connected user needs no exported env var, and
// so every vision path (plugin native, MCP, picker) resolves the same
// credential. Mirrors the usage-bar pattern (src/plugins/tui) but stays local
// to this module — no TUI imports.

function defaultAuthStateDir(): string {
  // Honor XDG_DATA_HOME so a relocated data root resolves the same auth store
  // (auth.json) and V2 credential db (opencode.db) as the plugin and the MCP.
  // Mirrors v2-vision.ts; OPENCODE_DB still names the exact db file.
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode')
}

/**
 * Path to the OpenCode V2 credential database. `OPENCODE_DB` names the exact
 * file when the host relocated it (e.g. a sandbox with its own db); otherwise
 * the default `<data dir>/opencode.db` sibling of `auth.json` is used.
 */
function v2CredentialDbPath(stateDir: string, env: Record<string, string | undefined>): string {
  const override = env.OPENCODE_DB?.trim()
  return override ? override : join(stateDir, 'opencode.db')
}

/**
 * Credential field names accepted in an OpenCode auth entry. V1 OAuth entries
 * carry `access`; V1/V2 API-key entries carry `key`/`apiKey`. Mirrors the
 * Pantheon Vision MCP's `_extract_key` so the native path sees the same
 * credential shapes as the tool path.
 */
const AUTH_TOKEN_FIELDS: readonly string[] = [
  'access',
  'key',
  'apiKey',
  'api_key',
  'token',
  'accessToken',
  'access_token',
]

/**
 * Extract a usable token from an OpenCode credential value (a raw string or a
 * JSON object), skipping an expired OAuth entry. Returns null when no field
 * carries a non-empty token. The token is never logged.
 */
function extractAuthToken(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const expires = record.expires
  if (typeof expires === 'number' && expires > 0 && Date.now() >= expires) return null
  for (const field of AUTH_TOKEN_FIELDS) {
    const candidate = record[field]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return null
}

/**
 * Extract a token from a V2 `credential.value` cell: the cell is JSON text
 * (e.g. `{"type":"key","key":"..."}` or an OAuth blob), so it is parsed first.
 * A non-JSON or unusable value yields null. The token is never logged.
 */
function extractCredentialCellToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    return extractAuthToken(JSON.parse(value))
  } catch {
    return null // not JSON → not a usable credential cell
  }
}

/**
 * Read a provider token from the OpenCode V2 SQLite credential store
 * (`<data dir>/opencode.db`, table `credential`). OpenCode V2 moved credentials
 * out of `auth.json`; a V2 host has no JSON file, so an auth.json-only read left
 * the native path unresolvable even though the MCP (which reads this table) and
 * the picker both worked.
 *
 * Best-effort and READ-ONLY (`mode=ro`): a missing `node:sqlite` builtin, a
 * missing/locked database, or a missing row yields null and the caller falls
 * back to the tool→local chain. Rows are tried in `providerIDs` order; the
 * stored value is never logged.
 */
async function readV2CredentialToken(
  providerIDs: readonly string[],
  stateDir: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const dbPath = v2CredentialDbPath(stateDir, env)
  if (!existsSync(dbPath)) return null
  let sqlite: typeof import('node:sqlite') | undefined
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return null // runtime without node:sqlite → no V2 store to read
  }
  const DatabaseSync = sqlite.DatabaseSync
  if (typeof DatabaseSync !== 'function') return null
  let db: import('node:sqlite').DatabaseSync | undefined
  try {
    db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true })
    const statement = db.prepare(
      'SELECT value FROM credential WHERE integration_id = ? AND active = 1 LIMIT 1',
    )
    for (const id of providerIDs) {
      const row = statement.get(id) as { value?: unknown } | undefined
      const token = extractCredentialCellToken(row?.value)
      if (token) return token
    }
    return null
  } catch {
    return null // missing table / locked / corrupt → no crash
  } finally {
    try {
      db?.close()
    } catch {
      // best-effort close
    }
  }
}

/**
 * Read a provider token from opencode's credential stores.
 *
 * `statePath` is the opencode data dir (default `$XDG_DATA_HOME/opencode`, else
 * `~/.local/share/opencode`). The
 * V1 `auth.json` inside it maps provider IDs to `{ access | key, expires }`;
 * the V2 `opencode.db` (or the file named by `OPENCODE_DB`) holds the same
 * secrets in a `credential` table. The V1 file is read first (it is absent on a
 * V2 host), then the V2 store.
 *
 * Returns the first non-expired token across `providerIDs`, or null when both
 * stores are missing/corrupted or no entry has a usable token — callers fall
 * back to the MCP tool pattern. The token is never logged.
 */
export async function readOpencodeAuthToken(
  providerIDs: readonly string[],
  statePath?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const stateDir = statePath ?? defaultAuthStateDir()
  const raw = await readFile(join(stateDir, 'auth.json'), 'utf8').catch(() => null)
  if (raw !== null) {
    let auth: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        auth = parsed as Record<string, unknown>
      }
    } catch {
      auth = null // corrupted → treat as absent, then try the V2 store
    }
    if (auth) {
      for (const id of providerIDs) {
        const token = extractAuthToken(auth[id])
        if (token) return token
      }
    }
  }
  return readV2CredentialToken(providerIDs, stateDir, env)
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

/**
 * Decode a base64 image data URI to its bytes. The regex accepts OPTIONAL
 * parameters between the mime type and the `;base64` marker (e.g.
 * `data:image/png;charset=utf-8;base64,…`), so a URI a browser or clipboard
 * decorates with parameters still decodes. The declared mime and its parameters
 * are ignored: callers pass the authoritative mime separately (an explicit
 * filename/mime wins over the data URI's own declaration). Never throws;
 * returns null for malformed input or an empty payload.
 */
function decodeDataUrlImage(dataUrl: string): Buffer | null {
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.+)$/s.exec(dataUrl)
  if (!match) return null
  const data = Buffer.from(match[2] ?? '', 'base64')
  if (data.length === 0) return null
  return data
}

/**
 * Atomically write `data` to `filePath` via a sibling temp file + rename.
 *
 * The temp file lives in the SAME directory, so `rename` is an atomic
 * same-filesystem replace that overwrites any existing destination. A crash
 * mid-write can therefore leave at most a stray `<name>.tmp-<pid>` file —
 * never a truncated destination that a later content-hash dedup would trust.
 * Private mode 0600 is forced AFTER creation to beat a permissive umask.
 */
function writeFileAtomicSync(filePath: string, data: Buffer): void {
  const tempPath = `${filePath}.tmp-${process.pid}`
  try {
    writeFileSync(tempPath, data, { mode: 0o600 })
    chmodSync(tempPath, 0o600)
    renameSync(tempPath, filePath)
  } catch (err) {
    try {
      unlinkSync(tempPath)
    } catch {
      // The temp file may not exist yet (the write failed first) — best effort.
    }
    throw err
  }
}

/** Whether `filePath` already holds exactly `data` (dedup fast path). */
function fileHasContent(filePath: string, data: Buffer): boolean {
  try {
    return readFileSync(filePath).equals(data)
  } catch {
    return false
  }
}

/**
 * Write decoded image bytes to the shared temp dir under a content-hash
 * filename (dedup: identical re-pasted images reuse one file), with private
 * modes forced AFTER creation. The write is ATOMIC (sibling temp + rename) so
 * an interrupted process can never leave a truncated file that a later dedup
 * would reuse as valid. Registers the path as most-recently-used in the LRU
 * registry. Screenshots may hold sensitive content, so modes are 0700/0600
 * regardless of a permissive umask; the bytes are never logged.
 */
export function writeTempImageSync(data: Buffer, mime: string): string {
  const dir = join(tmpdir(), TEMP_DIR_NAME)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const filePath = join(dir, `${hashContent(data)}.${getExtensionForMime(mime)}`)
  // Dedup: a content-hash name whose bytes already match is the object every
  // other session expects — skip the rewrite. Different bytes under the same
  // name (or an unreadable/truncated leftover) are healed by the atomic write.
  if (!fileHasContent(filePath, data)) writeFileAtomicSync(filePath, data)
  chmodSync(filePath, 0o600)
  touchTempFile(filePath)
  return filePath
}

/** Async temp materialization used by the V1 chat hook (awaits the LRU cap). */
export async function saveDataUrlImage(dataUrl: string, mime: string): Promise<string | null> {
  const data = decodeDataUrlImage(dataUrl)
  if (!data) return null
  const filePath = writeTempImageSync(data, mime)
  await enforceTempFileCap()
  return filePath
}

/**
 * Synchronous sibling of `saveDataUrlImage` for callers that run inside a
 * synchronous host hook — namely the V2 `prompt` admission, which must hand a
 * path-based vision tool/MCP a real reference for an inline (clipboard)
 * attachment whose bytes exist only in memory as a data URI. Bytes go to the
 * SAME temp dir + LRU registry, so V1 and V2 attachment cleanup share one
 * mechanism. The global cap is enforced best-effort (a sync caller cannot await
 * it): the eviction runs off the returned tick and never rejects.
 */
export function saveDataUrlImageSync(dataUrl: string, mime: string): string | null {
  const data = decodeDataUrlImage(dataUrl)
  if (!data) return null
  const filePath = writeTempImageSync(data, mime)
  void enforceTempFileCap().catch(() => undefined)
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
 * Resolve the native vision endpoint: model ID + base URL (no key I/O).
 *
 * Model precedence: env PANTHEON_VISION_MODEL > config file `visionModel` >
 * active preset `vision.model` > catalog discovery > DEFAULT_VISION_MODEL.
 * When an explicit model is set, its base URL comes from the catalog entry
 * (`api.url`) when present, else the legacy Zen mapping. Discovery (no
 * explicit model) only picks wire-compatible image-capable models and uses
 * their `api.url`; with no qualifying entry it falls back to
 * DEFAULT_VISION_MODEL + Zen. Returns null when the model's provider has no
 * usable endpoint (unknown providers without a catalog — anthropic/openai
 * stay phase 2).
 */
function resolveNativeVisionEndpoint(
  preset: Pick<ResolvedPreset, 'vision'> | null | undefined,
  env: Record<string, string | undefined>,
  configVisionModel?: string,
  catalog?: unknown,
): NativeVisionEndpoint | null {
  const resolved = preset ?? resolveActivePreset({ env, candidates: activePresetCandidates() })
  // Explicit model wins over discovery; empty string = nothing configured.
  const explicitModel = firstNonEmpty(
    '',
    env.PANTHEON_VISION_MODEL,
    configVisionModel,
    resolved?.vision?.model,
  )
  if (explicitModel) {
    const baseURL = catalogEndpointFor(explicitModel, catalog) ?? legacyZenBaseURL(explicitModel)
    if (!baseURL) return null
    return { modelID: explicitModel, baseURL }
  }
  const discovered = discoverVisionModel(catalog)
  if (discovered) return discovered
  const modelID = DEFAULT_VISION_MODEL
  const baseURL = legacyZenBaseURL(modelID)
  if (!baseURL) return null
  return { modelID, baseURL }
}

/**
 * Resolve the native vision target: model + endpoint + API key.
 *
 * The key comes from the shared Zen env keys only (`PANTHEON_OPENCODE_API_KEY`
 * then `OPENCODE_API_KEY`), and only when the resolved endpoint is Zen. `catalog`
 * (optional, shape of GET /config/providers) enables discovery when no explicit
 * model is configured (env > config > preset > discovery > DEFAULT). Returns
 * null when the model has no usable endpoint, is non-Zen, or no env key is set —
 * callers fall back to the MCP tool. For the auth-store fallback (`opencode auth
 * login`) use `resolveNativeVisionTarget`.
 */
export function resolveNativeVisionConfig(
  preset: Pick<ResolvedPreset, 'vision'> | null | undefined = undefined,
  env: Record<string, string | undefined> = process.env,
  configVisionModel?: string,
  catalog?: unknown,
): NativeVisionTarget | null {
  const endpoint = resolveNativeVisionEndpoint(preset, env, configVisionModel, catalog)
  if (!endpoint) return null
  // Non-Zen endpoints never receive the shared Zen env keys (cross-provider
  // credential leak); they must resolve their own auth store via the async path.
  const providerID = endpoint.modelID.slice(0, endpoint.modelID.indexOf('/'))
  if (!isZenProvider(providerID)) return null
  const apiKey = env.PANTHEON_OPENCODE_API_KEY ?? env.OPENCODE_API_KEY
  if (!apiKey || apiKey.trim() === '') return null
  return { ...endpoint, apiKey }
}

/**
 * Full native-vision resolution for the chat hook (async): model + endpoint
 * via `resolveNativeVisionConfig` (env > config > preset > catalog discovery
 * > DEFAULT), then the API key.
 *
 * Credential precedence:
 * - Zen endpoints (`opencode` / `opencode-go*`): the env keys
 *   (`PANTHEON_OPENCODE_API_KEY` ?? `OPENCODE_API_KEY`) first, then the auth
 *   store (`auth.json` on V1, the V2 `opencode.db` credential table) — the
 *   resolved provider entry first, then the legacy Zen entries (`opencode-go`,
 *   then `opencode`) — so connected users don't need to export anything.
 * - Non-Zen endpoints (discovered or explicit via the npm allowlist): ONLY the
 *   resolved provider's own auth-store entry. The shared env keys and the legacy
 *   Zen entries are never attached to a non-Zen base URL; absent an own
 *   credential this returns null and the caller falls back to the tool→local
 *   chain (no cross-provider credential leak).
 *
 * `catalog` enables host-catalog discovery; without it the behavior is exactly
 * the pre-discovery one. Returns null when the model has no usable endpoint or
 * no usable key exists — callers fall back to the MCP tool.
 */
export async function resolveNativeVisionTarget(
  input: {
    preset?: Pick<ResolvedPreset, 'vision'> | null
    env?: Record<string, string | undefined>
    config?: VisionConfig | null
    authStatePath?: string
    catalog?: unknown
  } = {},
): Promise<NativeVisionTarget | null> {
  const env = input.env ?? process.env
  const endpoint = resolveNativeVisionEndpoint(
    input.preset,
    env,
    input.config?.visionModel,
    input.catalog,
  )
  if (!endpoint) return null
  const resolvedProvider = endpoint.modelID.slice(0, endpoint.modelID.indexOf('/'))
  const zen = isZenProvider(resolvedProvider)
  if (zen) {
    const envKey = env.PANTHEON_OPENCODE_API_KEY ?? env.OPENCODE_API_KEY
    if (envKey && envKey.trim() !== '') return { ...endpoint, apiKey: envKey }
  }
  // Own provider entry always; the legacy Zen entries ONLY for a Zen endpoint.
  const authProviderIDs = [
    ...new Set(zen ? [resolvedProvider, ...LEGACY_VISION_AUTH_PROVIDER_IDS] : [resolvedProvider]),
  ].filter((id) => Boolean(id))
  const authToken = await readOpencodeAuthToken(authProviderIDs, input.authStatePath, env)
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
 *
 * When `target.sessionID` is set AND the target is Zen (`isZenNativeTarget`),
 * the request carries the `x-opencode-session` header — the Zen gateway rejects
 * a sessionless request with HTTP 400 `MissingSessionID`. The header is NEVER
 * sent to a non-Zen provider (no cross-provider session leak).
 *
 * The abort budget is DYNAMIC (see `computeNativeTimeoutMs`): it scales with
 * the total decoded size of `payloads` so large images are not dropped as
 * timeouts by the fixed base budget.
 */
export async function describeImagesNative(
  payloads: readonly NativeImagePayload[],
  target: NativeVisionTarget,
  prompt: string = NATIVE_PROMPT,
  maxTokens: number = NATIVE_MAX_TOKENS,
  signal?: AbortSignal,
  onFailure?: (failure: NativeVisionFailure) => void,
): Promise<string | null> {
  const report = (failure: NativeVisionFailure): void => {
    try {
      onFailure?.(failure)
    } catch {
      // A diagnostic sink must never break the describe result.
    }
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${target.apiKey}`,
  }
  // Zen-only session header: the gateway requires it for `opencode-go*` and
  // `opencode` models, and a non-Zen host must never see the session identity.
  if (target.sessionID && isZenNativeTarget(target)) {
    headers['x-opencode-session'] = target.sessionID
  }
  const controller = new AbortController()
  const budgetMs = computeNativeTimeoutMs(estimateNativePayloadsBytes(payloads))
  // Track WHICH abort fired: our budget expiring (a timeout the caller can act
  // on), an EXTERNAL cancellation (a deliberate `ToolContext.signal` abort), or
  // a genuine transport drop. Collapsing all three into `network` is what made
  // a timed-out reasoning call read as the vague "network error" the agent then
  // paraphrased — and is what made an external cancellation advertise a bogus
  // "retry". External cancellation wins: it is deliberate, never transient.
  let timedOut = false
  let cancelled = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, budgetMs)
  const onExternalAbort = () => {
    cancelled = true
    controller.abort()
  }
  if (signal) {
    if (signal.aborted) {
      cancelled = true
      controller.abort()
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }
  try {
    const response = await fetch(`${target.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
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
    if (!response.ok) {
      report({ reason: 'http', status: response.status })
      return null
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    }
    const choice = data.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string' || content.trim() === '') {
      // Surface finish_reason (e.g. `length`) so a reasoning model cut off by
      // max_tokens yields an actionable message instead of a bare "no text".
      report({
        reason: 'empty',
        ...(typeof choice?.finish_reason === 'string'
          ? { finishReason: choice.finish_reason }
          : {}),
      })
      return null
    }
    return content.trim()
  } catch {
    // Our dynamic budget elapsed → `timeout` (with the budget for the message);
    // an external abort → `cancelled` (deliberate, no "retry" guidance);
    // anything else (connection reset, TLS, JSON parse) → `network`.
    report(
      cancelled
        ? { reason: 'cancelled' }
        : timedOut
          ? { reason: 'timeout', timeoutMs: budgetMs }
          : { reason: 'network' },
    )
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
 * the same image never reuses a stale description — same image + new question
 * means a NEW gateway describe call (by design, aligned with the council's
 * describe-once-per-turn flow); only an identical re-ask within the TTL hits
 * the cache. Sorting makes the key order-insensitive (the same image set in
 * any order maps to one key). For data-URI/local payloads the URL encodes both
 * mime and bytes, so hashing it covers "mime+bytes"; remote URLs hash the URL
 * itself.
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
  sessionID?: string,
): string {
  if (!Array.isArray(images)) {
    throw new TypeError('Vision image resolution must return an array')
  }
  const imageList = images.map((image, index) => `- Image ${index + 1}: ${image.path}`).join('\n')
  // The MCP runs in a SEPARATE process the host does not hand a session id to,
  // and the Zen gateway (zen/go, zen/v1) rejects a sessionless request with
  // HTTP 400 `MissingSessionID`. The plugin relays the live session id through
  // the tool call so the MCP can send the `x-opencode-session` header. The id
  // is JSON-quoted so it cannot spoof the surrounding instruction layout.
  const sessionLine = sessionID
    ? `When you call the tool, pass session_id=${JSON.stringify(sessionID)} so the Zen gateway accepts the request.`
    : undefined
  if (template && PROMPT_TEMPLATE_VARIABLES.some((variable) => template.includes(variable))) {
    const rendered = template
      .replaceAll('{imageList}', imageList)
      .replaceAll('{imageCount}', String(images.length))
      .replaceAll('{toolName}', toolName)
      .replaceAll('{userText}', userText)
    return sessionLine ? `${rendered}\n${sessionLine}` : rendered
  }
  const plural = images.length > 1
  const heading = plural
    ? `The user has shared ${images.length} images. The images are available at:`
    : 'The user has shared an image. The image is available at:'
  const analyze = plural ? 'each image' : 'this image'
  const lines = [heading, imageList, '', `Use the \`${toolName}\` tool to analyze ${analyze}.`, '']
  if (sessionLine) lines.push(sessionLine, '')
  lines.push(`User's request: ${userText || '(analyze the image)'}`)
  return lines.join('\n')
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

/**
 * Payload bound for the user's question interpolated into vision prompts:
 * prompts longer than this are clipped (with an ellipsis marker) so a long
 * turn never bloats the gateway request. Exported because the V2 path
 * (v2-vision.ts) applies the same cap to its own describe prompt.
 */
export const MAX_PROMPT_USER_TEXT_CHARS = 2000

/**
 * Trim and cap the user's question at `maxChars` characters TOTAL, appending a
 * single "…" when clipped (the marker counts against the cap, so the result is
 * never longer than `maxChars`). The cap applies to the raw text BEFORE XML
 * escaping (escaping happens at the interpolation site). Empty/whitespace
 * input yields '' so callers keep their generic-prompt placeholder.
 * Never logged — the question is prompt content, not telemetry.
 */
export function truncateUserText(
  text: string,
  maxChars: number = MAX_PROMPT_USER_TEXT_CHARS,
): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const marker = '…'
  return `${trimmed.slice(0, Math.max(0, maxChars - marker.length))}${marker}`
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

// ─── EXIF orientation detection (zero-dep, JPEG only) ──────────────────────
// DETECTION, not correction: no pixel data is ever rewritten (no sharp/jimp —
// YAGNI). When a payload's EXIF orientation tag ≠ 1, the native prompt carries
// a textual hint instructing the vision model to describe the image in its
// correct viewing orientation. The parser reads only the first kilobytes of
// the JPEG (APP1 EXIF lives at the very start) and is fail-safe: ANY malformed
// input yields null, never a throw.

/** EXIF orientation tag id (IFD0). */
const EXIF_ORIENTATION_TAG = 0x0112
/**
 * Base64 chars decoded for the EXIF scan (≈75 KB of binary — far more than
 * any APP1 segment needs; keeps `payloadOrientation` O(1) even for 25 MB URIs).
 */
const EXIF_SCAN_BASE64_CHARS = 100_000

/** How to mentally correct each non-1 EXIF orientation to view the image upright. */
const ORIENTATION_TRANSFORM_HINTS: Record<number, string> = {
  2: 'stored mirrored horizontally — apply a horizontal mirror to view it upright',
  3: 'stored upside down — apply a 180-degree rotation to view it upright',
  4: 'stored mirrored vertically — apply a vertical mirror to view it upright',
  5: 'stored mirrored and rotated — apply a horizontal mirror then a 90-degree clockwise rotation to view it upright',
  6: 'stored rotated — apply a 90-degree clockwise rotation to view it upright',
  7: 'stored mirrored and rotated — apply a horizontal mirror then a 90-degree counter-clockwise rotation to view it upright',
  8: 'stored rotated — apply a 90-degree counter-clockwise rotation to view it upright',
}

/**
 * Read the EXIF orientation (tag 0x0112) from raw JPEG bytes. Walks the
 * segment chain (SOI → APP0/APP1/…) for the first APP1 segment starting with
 * "Exif\0\0", then parses the TIFF byte-order header, the IFD0 entry count and
 * the 12-byte entries until the orientation tag is found. Supports both TIFF
 * byte orders ("II" little-endian and "MM" big-endian). Returns 1–8, or null
 * for anything else — non-JPEG, no EXIF, no orientation tag, or ANY malformed
 * input. Never throws (fail-safe by construction: every read is bounds-checked).
 */
export function readExifOrientation(bytes: Uint8Array): number | null {
  try {
    // JPEG must start with the SOI marker; anything else is not ours to parse.
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null // marker sync lost → malformed
      const marker = bytes[offset + 1] ?? 0
      // Standalone markers carry no length field (SOI repeat, RSTn, TEM).
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      if (marker === 0xda) return null // start of scan — no EXIF ahead
      const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)
      if (length < 2) return null // segment length must cover its own 2 bytes
      const segmentStart = offset + 4
      if (marker === 0xe1 && segmentStart + 6 <= bytes.length) {
        const isExifHeader =
          bytes[segmentStart] === 0x45 && // "E"
          bytes[segmentStart + 1] === 0x78 && // "x"
          bytes[segmentStart + 2] === 0x69 && // "i"
          bytes[segmentStart + 3] === 0x66 && // "f"
          bytes[segmentStart + 4] === 0x00 &&
          bytes[segmentStart + 5] === 0x00
        if (isExifHeader) {
          return readTiffOrientation(bytes, segmentStart + 6)
        }
        // Non-EXIF APP1 (e.g. XMP) → skip and keep walking.
      }
      offset += 2 + length
    }
    return null
  } catch {
    return null // belt-and-suspenders: never let detection fail a turn
  }
}

/** Parse the TIFF block (byte-order header + IFD0) for the orientation tag. */
function readTiffOrientation(bytes: Uint8Array, tiffStart: number): number | null {
  if (tiffStart + 8 > bytes.length) return null
  const bom = bytes[tiffStart]
  const little = bom === 0x49 // "I" → little-endian; "M" (0x4d) → big-endian
  if (!little && bom !== 0x4d) return null
  const u16 = (pos: number): number =>
    little
      ? (bytes[pos] ?? 0) | ((bytes[pos + 1] ?? 0) << 8)
      : ((bytes[pos] ?? 0) << 8) | (bytes[pos + 1] ?? 0)
  const u32 = (pos: number): number =>
    little
      ? ((bytes[pos] ?? 0) |
          ((bytes[pos + 1] ?? 0) << 8) |
          ((bytes[pos + 2] ?? 0) << 16) |
          ((bytes[pos + 3] ?? 0) << 24)) >>>
        0
      : (((bytes[pos] ?? 0) << 24) |
          ((bytes[pos + 1] ?? 0) << 16) |
          ((bytes[pos + 2] ?? 0) << 8) |
          (bytes[pos + 3] ?? 0)) >>>
        0
  if (u16(tiffStart + 2) !== 42) return null // TIFF magic
  const ifdStart = tiffStart + u32(tiffStart + 4)
  if (ifdStart + 2 > bytes.length) return null
  const entryCount = u16(ifdStart)
  for (let i = 0; i < entryCount; i++) {
    const entry = ifdStart + 2 + i * 12
    if (entry + 12 > bytes.length) return null
    if (u16(entry) === EXIF_ORIENTATION_TAG) {
      // Type SHORT (3), count 1 → the value sits inline in the first 2 bytes
      // of the entry's value/offset field, encoded in the TIFF byte order.
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : null
    }
  }
  return null
}

/**
 * Best-effort EXIF orientation for one native payload. Only local JPEG data
 * URIs are inspected (remote http(s) URLs would need a network round-trip —
 * out of scope for zero-dep detection; non-JPEG payloads short-circuit before
 * any parsing). Returns 1–8 or null; never throws.
 */
export function payloadOrientation(payload: { url: string }): number | null {
  if (payload.url.startsWith('http://') || payload.url.startsWith('https://')) return null
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(payload.url)
  if (!match || (match[1]?.toLowerCase() ?? '') !== 'image/jpeg') return null
  try {
    const prefix = Buffer.from((match[2] ?? '').slice(0, EXIF_SCAN_BASE64_CHARS), 'base64')
    return readExifOrientation(prefix)
  } catch {
    return null
  }
}

/**
 * Build the textual orientation hint appended to the native prompt. One line
 * per image whose detected orientation ≠ 1 (the transform the vision model
 * must apply mentally to see the image upright); empty string when every
 * image is upright or unknown — the prompt then stays byte-identical to the
 * no-EXIF behavior. The hint is pure static text (no user content), so it can
 * never re-expand template variables nor break the prompt's XML structure.
 */
export function buildOrientationHint(orientations: ReadonlyArray<number | null>): string {
  const notes: string[] = []
  orientations.forEach((orientation, index) => {
    const transform = orientation === null ? undefined : ORIENTATION_TRANSFORM_HINTS[orientation]
    if (transform)
      notes.push(`- image ${index + 1}: EXIF orientation ${orientation} — ${transform}.`)
  })
  return notes.join('\n')
}

/**
 * Build the calibrated prompt for the native vision gateway call. The model is
 * instructed to reply with N `<item id="N"><description>…</description></item>`
 * blocks (N = imageCount) and, for `compare`, one extra `<context>` block.
 * The user's text is trimmed, capped at `MAX_PROMPT_USER_TEXT_CHARS`
 * (see `truncateUserText`) and XML-escaped when interpolated so it can neither
 * break the format instructions nor bloat the payload. `intent` is
 * auto-detected from `userText` + `imageCount` when omitted.
 *
 * `orientationHint` (see `buildOrientationHint`) appends an EXIF orientation
 * block when any image is stored rotated/mirrored — DETECTION, not correction:
 * the vision model is instructed to describe each image in its corrected
 * viewing orientation; no pixels are rewritten. An empty hint leaves the
 * prompt byte-identical to the previous behavior.
 *
 * Cache interplay: the returned prompt IS the description-cache key's prompt
 * component (`buildDescriptionCacheKey`), so the SAME image asked a NEW
 * question produces a different key and a fresh gateway describe — by design,
 * aligned with the council's describe-once-per-turn flow; only an identical
 * re-ask (same question, same images) within the TTL reuses the stored text.
 * The orientation hint travels INSIDE the returned prompt, so two calls for
 * the same image whose detected orientations differ necessarily get different
 * cache keys — a stale hint can never be served (and vice versa).
 */
export function buildNativeVisionPrompt(
  userText: string,
  imageCount: number,
  intent: VisionIntent = detectVisionIntent(userText, imageCount),
  orientationHint: string = '',
): string {
  const count = Math.max(1, imageCount)
  const request =
    escapeXml(truncateUserText(userText)) ||
    '(sem pedido explícito — descreva as imagens com precisão)'
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
    ...(orientationHint.trim()
      ? [
          '',
          'IMAGE ORIENTATION (EXIF) — storage metadata, not content:',
          ...orientationHint.trim().split('\n'),
          'Describe each image as it appears AFTER applying the correction above;',
          'the rotation/mirroring is not a defect and must not be reported as one.',
        ]
      : []),
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
      // AI-SDK provider-bound parts use `{ type: 'image', ... }` rather than
      // the `image_url`/`file` shapes; without this branch such a part reached
      // the provider untouched, which is the failure this sanitizer exists to
      // prevent.
      const isImagePart = raw.type === 'image'
      const isImageFile =
        raw.type === 'file' &&
        typeof raw.mime === 'string' &&
        raw.mime.toLowerCase().startsWith('image/')
      if (isImageUrl || isImagePart || isImageFile) {
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

  /**
   * Host provider catalog for native-vision model discovery (TTL-cached per
   * client inside `fetchProvidersCatalog`): one round-trip per TTL window,
   * never per request. Null on any failure → legacy behavior.
   */
  const getProvidersCatalog = (): Promise<unknown> => fetchProvidersCatalog(client)

  /** Lazily create (and return) the per-session description cache. */
  const ensureSessionCache = (sessionID: string): Map<string, DescriptionCacheEntry> => {
    let cache = sessionDescriptionCache.get(sessionID)
    if (!cache) {
      cache = new Map()
      sessionDescriptionCache.set(sessionID, cache)
    }
    return cache
  }

  /**
   * Last rung of the fallback chain: deterministic local extraction (metadata
   * + best-effort colors/OCR) for when BOTH the native model and the MCP tool
   * are unavailable. Reuses `resolveImageSourcePayload` so data URIs and local
   * paths share the native pipeline's byte/size handling. The block is cached
   * per session (keyed by content hashes) because it is deterministic for the
   * same file. Returns null when no image could be read — callers then emit an
   * explicit unavailable message. Never logs payload content. The user's
   * question is trimmed, capped at `MAX_PROMPT_USER_TEXT_CHARS` and XML-escaped
   * (same `truncateUserText` + `escapeXml` as the native prompt) so it can
   * neither bloat the block nor be interpreted as markup.
   */
  const buildLocalInjection = async (
    sessionID: string,
    images: ReadonlyArray<{ filePart: FilePart; target: SavedImage }>,
    userText: string,
  ): Promise<string | null> => {
    const urls: string[] = []
    for (const { filePart, target } of images) {
      const payload = await resolveImageSourcePayload(target.path, filePart.mime)
      if (payload) urls.push(payload.url)
    }
    if (urls.length === 0) return null
    const cache = ensureSessionCache(sessionID)
    const cacheKey = `local:${urls
      .map((url) => hashContent(url))
      .sort()
      .join(':')}`
    let block = getCachedDescription(cache, cacheKey)
    if (block === null) {
      block = await buildLocalVisionBlock(urls)
      if (block === null) return null
      setCachedDescription(cache, cacheKey, block)
    }
    return [
      'Visão nativa e tool MCP de visão indisponíveis; foi usada extração local determinística (metadados + best-effort), sem conteúdo inventado:',
      block,
      '',
      `User's request: ${escapeXml(truncateUserText(userText)) || '(analyze the image)'}`,
    ].join('\n')
  }

  const chatMessage: NonNullable<Hooks['chat.message']> = async (hookInput, output) => {
    try {
      const message: UserMessage | undefined = output?.message
      if (message?.role !== 'user') return
      const model = hookInput?.model ?? message.model
      if (modelAcceptsImages(model, model?.providerID)) {
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
          const target = await resolveNativeVisionTarget({
            config,
            catalog: await getProvidersCatalog(),
          })
          if (target) {
            const payloads = await buildNativeImagePayloads(resolved)
            if (payloads) {
              const sessionCache = ensureSessionCache(hookInput.sessionID)
              const intent = detectVisionIntent(userText, payloads.length)
              // EXIF orientation detection (zero-dep, JPEG only): a non-1 tag
              // adds a textual hint to the prompt so the vision model describes
              // the corrected view. The hint lives INSIDE the prompt, so the
              // cache key below varies with it — no stale-orientation hits.
              const orientationHint = buildOrientationHint(
                payloads.map((payload) => payloadOrientation(payload)),
              )
              const prompt = buildNativeVisionPrompt(
                userText,
                payloads.length,
                intent,
                orientationHint,
              )
              const cacheKey = buildDescriptionCacheKey(prompt, payloads)
              let rawText = getCachedDescription(sessionCache, cacheKey)
              if (rawText === null) {
                // Attach the live session id so the Zen gateway accepts the
                // request (Zen-only; see describeImagesNative).
                const requestTarget: NativeVisionTarget = {
                  ...target,
                  ...(hookInput.sessionID ? { sessionID: hookInput.sessionID } : {}),
                }
                rawText = await describeImagesNative(payloads, requestTarget, prompt)
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
        // Chain: native → tool → local. The MCP tool instruction is used when
        // a tool is configured/detected; otherwise fall to deterministic local
        // extraction (metadata + best-effort colors/OCR) instead of a bare
        // unavailable message. A null tool name (env/config absent AND no MCP
        // evidence) is the only path that reaches local extraction, so the
        // env > config > preset > discovery > DEFAULT precedence is untouched.
        injection = toolName
          ? generateInjectionPrompt(
              saved,
              userText,
              toolName,
              config.promptTemplate,
              hookInput.sessionID,
            )
          : await buildLocalInjection(hookInput.sessionID, resolved, userText)
        if (injection === null) {
          injection =
            'Vision fallback unavailable: pantheon-vision MCP is unavailable and local image extraction also failed. The image was removed safely; please configure the MCP server and retry.'
        }
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
