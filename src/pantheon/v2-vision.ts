/** Native OpenCode V2 image analysis using the live model catalog and Zen auth. */

import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveActivePreset } from './presets.mjs'
import { isValidSessionId } from './session-guard.ts'
import {
  describeImagesNative,
  NATIVE_MAX_TOKENS,
  type NativeVisionFailure,
  type NativeVisionTarget,
  nativeVisionFailureMessage,
  resolveNativeVisionTarget,
  saveDataUrlImageSync,
  truncateUserText,
} from './vision.ts'

// Default native vision model. Must be a PAID OpenCode Go (zen/go) model: the
// free-tier MiMo (`opencode/mimo-v2.6-flash-free`) is rejected by the direct
// gateway with HTTP 403 ("free tier can only be used from within OpenCode"),
// and zen/v1 paid models require account access this plugin cannot assume. The
// go endpoint accepts the request once the Zen session header is present.
// NOTE: intentionally diverges from V1's DEFAULT_VISION_MODEL
// (`opencode-go/mimo-v2.5`) — V2 tracks the newer Zen Go MiMo 2.6 Flash family.
const DEFAULT_MODEL = 'opencode-go/mimo-v2.6-flash'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_REDIRECTS = 3
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/**
 * Generic describe instruction — byte-identical to the pre-contextual fixed
 * IMAGE_PROMPT, so a turn without a user question behaves exactly as before.
 */
const IMAGE_PROMPT_GENERIC =
  'Descreva fielmente a imagem anexada. Inclua conteúdo, texto visível, layout e objetos; ' +
  'declare incerteza em vez de adivinhar e responda em português claro.'

/**
 * Describe-prompt template with the `{userText}` slot. Substitution is
 * single-pass (`buildV2ImagePrompt`): the question is inserted via a function
 * replacement and never re-scanned, so `{imageList}`-style literals inside the
 * user's text stay inert data. The question is capped by
 * `truncateUserText` (payload bound); empty/whitespace falls back to the
 * generic prompt above.
 */
const IMAGE_PROMPT_TEMPLATE = `${IMAGE_PROMPT_GENERIC}
Pergunta do usuário: {userText}`

/** Fill `{userText}` into the describe template (single pass, injection-safe). */
export function buildV2ImagePrompt(userText?: string): string {
  const question = truncateUserText(userText ?? '')
  if (!question) return IMAGE_PROMPT_GENERIC
  return IMAGE_PROMPT_TEMPLATE.replace('{userText}', () => question)
}

const IMAGE_URI_PATTERN = /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i

/**
 * Reference line for one attached image. A `data:` (inline/clipboard)
 * attachment has no path on disk — the bytes live only in the URI — so a path
 * based tool (`vision_describe`, the MCP) could never read it and the model
 * would fall back to guessing a path from the display name (observed as
 * `ENOENT: .../clipboard`). Materialize the bytes once to the shared
 * temp/LRU location and reference THAT path, so the native tool AND the MCP
 * receive a real file. The payload is never copied into the prompt text. Only
 * if materialization fails (no usable bytes) do we fall back to the previous
 * "URI omitted" form.
 */
function imageReference(uri: string, mime: string, name: string): string {
  if (!/^data:image\//i.test(uri)) {
    return `${JSON.stringify(name)} em ${JSON.stringify(uri)}`
  }
  const path = saveDataUrlImageSync(uri, mime)
  if (path) {
    return `${JSON.stringify(name)} em ${JSON.stringify(path)} (anexo inline materializado em arquivo temporário local; use este caminho — o payload não é repetido no texto)`
  }
  return `${JSON.stringify(name)} (conteúdo anexado; URI codificada omitida)`
}

/**
 * Add model-visible instructions for image files on a V2 prompt admission.
 * Inline image bytes are deliberately never copied into persisted prompt text;
 * a `data:` attachment is materialized to a temp file and referenced by path
 * instead (see `imageReference`).
 * `userText` (the admission's prompt text, when available) is trimmed, capped
 * by `truncateUserText` and appended as the user's question for this turn so
 * the main model calibrates the inspection AND forwards it as the vision
 * tool's `prompt`. NOTE: the description cache keys on the full prompt, so the
 * same image asked with a new question gets a fresh describe — same image +
 * same question within the TTL reuses the stored description.
 * `sessionID` (the V2 `prompt` hook event's live session id, when valid under
 * the host session guard) is relayed as an MCP `session_id` instruction: the
 * MCP runs in a separate process the host hands no session id to, and the Zen
 * gateway rejects a sessionless call with HTTP 400 `MissingSessionID` (mirrors
 * `generateInjectionPrompt` on the V1 path).
 * The question and the session id are never logged.
 */
export function buildV2VisionPromptContext(
  files: unknown,
  userText?: string,
  sessionID?: string,
): string | undefined {
  if (!Array.isArray(files)) return undefined
  const images = files.flatMap((value, index) => {
    const file = asRecord(value)
    if (!file) return []
    const uri = typeof file?.uri === 'string' ? file.uri.trim() : ''
    if (!uri) return []
    const mime = typeof file?.mime === 'string' ? file.mime.toLowerCase() : ''
    const image =
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) ||
      /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(uri) ||
      IMAGE_URI_PATTERN.test(uri)
    if (!image) return []
    const name =
      typeof file.filename === 'string'
        ? file.filename
        : typeof file.name === 'string'
          ? file.name
          : `imagem ${index + 1}`
    const reference = imageReference(uri, mime, name)
    return [reference]
  })
  if (images.length === 0) return undefined
  const lines = [
    '<!-- pantheon-v2-visual-context -->',
    '[Contexto visual do Pantheon]',
    `O usuário anexou imagem(ns):\n${images.map((image) => `- ${image}`).join('\n')}`,
    'Se a imagem orientar uma implementação, inspecione-a com vision_describe ou visão nativa antes de delegar. Inclua a referência e observações visuais relevantes no handoff para @aphrodite. Preserve alterações existentes fora do escopo: a imagem não autoriza apagar nem reverter trabalho; se a substituição for necessária e não estiver explícita, pergunte antes.',
  ]
  const question = truncateUserText(userText ?? '')
  if (question) {
    // JSON.stringify quotes/escapes the question so it cannot spoof the
    // surrounding instruction layout; the value is never re-expanded and
    // never logged.
    lines.push(
      `Pergunta do usuário neste turno: ${JSON.stringify(question)} — ao inspecionar com vision_describe, repasse essa pergunta no parâmetro \`prompt\` da ferramenta para uma análise direcionada.`,
    )
  }
  // MCP session relay (see the doc comment above): JSON.stringify quotes the
  // id so it cannot spoof the surrounding instruction layout; never logged.
  if (isValidSessionId(sessionID)) {
    lines.push(
      `Prefira a ferramenta nativa \`vision_describe\` (ela já repassa a sessão automaticamente). Se usar o MCP pantheon-vision (\`vision_describe\`/\`vision_ocr\`/\`vision_analyze\`), repasse session_id=${JSON.stringify(sessionID)} no parâmetro \`session_id\` — sem ele o gateway Zen rejeita a chamada com MissingSessionID.`,
    )
  }
  return lines.join('\n')
}

export interface V2VisionModel {
  id: string
  providerID: string
  enabled?: boolean
  status?: string
  input?: string[] | Record<string, boolean>
  capabilities?: {
    input?: string[] | Record<string, boolean>
  }
  /** Catalog cost (optional); `input: 0` marks a free-tier model. */
  cost?: { input?: unknown }
}

export interface V2VisionRuntime {
  model: { list: (input?: unknown) => Promise<unknown> }
}

export interface V2VisionToolContext {
  sessionID?: string
  directory?: string
  signal?: AbortSignal
}

export interface V2VisionToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  output: Record<string, unknown>
  execute: (
    input: Record<string, unknown>,
    context: unknown,
  ) => Promise<{ output: string; title?: string; metadata?: Record<string, unknown> }>
}

type ImageAttachment = { uri: string; name: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function modelList(value: unknown): V2VisionModel[] {
  const root = asRecord(value)
  const candidates = Array.isArray(value) ? value : (root?.data ?? root?.models)
  if (!Array.isArray(candidates)) return []
  return candidates.filter((item): item is V2VisionModel => {
    const model = asRecord(item)
    return typeof model?.id === 'string' && typeof model.providerID === 'string'
  })
}

function acceptsImages(model: V2VisionModel): boolean {
  const input = model.capabilities?.input ?? model.input
  if (Array.isArray(input)) return input.some((modality) => modality.toLowerCase() === 'image')
  return input?.image === true
}

function supportsZenVision(model: V2VisionModel): boolean {
  return model.providerID === 'opencode' || model.providerID.startsWith('opencode-go')
}

/**
 * Whether a catalog model is FREE-TIER. Free-tier Zen models are rejected by
 * the direct gateway with HTTP 403 ("free tier can only be used from within
 * OpenCode"), so they must never be picked on the native describe path. Two
 * conservative signals: the `-free` id suffix (the reliable marker) OR an
 * explicit `cost.input` of 0.
 */
function isFreeVisionModel(model: V2VisionModel): boolean {
  if (/-free$/i.test(model.id)) return true
  const input = model.cost?.input
  return typeof input === 'number' && input <= 0
}

function modelKey(model: Pick<V2VisionModel, 'providerID' | 'id'>): string {
  return `${model.providerID}/${model.id}`
}

function exactModelMatch(models: V2VisionModel[], requested: string): V2VisionModel | undefined {
  const slash = requested.indexOf('/')
  if (slash < 1) return models.find((model) => model.id === requested)
  const providerID = requested.slice(0, slash)
  const id = requested.slice(slash + 1)
  return models.find((model) => model.providerID === providerID && model.id === id)
}

/**
 * Select a native transport model. An explicit pin must be eligible for the
 * native Zen image path or selection fails; it is never silently substituted.
 * Free-tier exclusion (`-free` suffix / cost ≤ 0) applies only to automatic
 * discovery, preserving the user's choice when a free model is explicitly
 * pinned (the gateway can then return its actionable 403).
 */
export function selectV2VisionModel(
  available: unknown,
  preferred?: string,
): V2VisionModel | undefined {
  const capable = modelList(available).filter(
    (model) =>
      model.enabled !== false &&
      model.status !== 'deprecated' &&
      supportsZenVision(model) &&
      acceptsImages(model),
  )
  const pinned = preferred?.trim()
  if (pinned) {
    return exactModelMatch(capable, pinned)
  }
  const candidates = capable.filter((model) => !isFreeVisionModel(model))
  const defaultModel = exactModelMatch(candidates, DEFAULT_MODEL)
  if (defaultModel) return defaultModel
  return candidates.sort((left, right) => {
    const priority = (model: V2VisionModel): number => {
      const key = modelKey(model).toLowerCase()
      if (key === DEFAULT_MODEL) return 0
      // Prefer the Go endpoint (paid, session-header gated) over zen/v1.
      return model.providerID.startsWith('opencode-go')
        ? 1
        : model.providerID === 'opencode'
          ? 2
          : 3
    }
    return priority(left) - priority(right) || modelKey(left).localeCompare(modelKey(right))
  })[0]
}

function activePresetCandidates(directory: string): string[] {
  const home = process.env.HOME || homedir()
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return [
    join(directory, '.pantheon', 'active-preset.json'),
    join(xdg, 'opencode', '.pantheon', 'active-preset.json'),
    join(home, '.opencode', '.pantheon', 'active-preset.json'),
  ]
}

async function configuredVisionModel(directory: string): Promise<string | undefined> {
  const home = process.env.HOME || homedir()
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config')
  const paths = [
    join(directory, '.opencode', 'opencode-vision.json'),
    join(xdg, 'opencode', 'opencode-vision.json'),
  ]
  for (const path of paths) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      if (typeof parsed.visionModel === 'string' && parsed.visionModel.trim()) {
        return parsed.visionModel.trim()
      }
    } catch {
      // A missing or malformed optional preference must not disable Vision.
    }
  }
  return undefined
}

async function preferredVisionModel(directory: string): Promise<string | undefined> {
  const envModel = process.env.PANTHEON_VISION_MODEL?.trim()
  if (envModel) return envModel
  const configModel = await configuredVisionModel(directory)
  if (configModel) return configModel
  try {
    return resolveActivePreset({
      env: process.env,
      candidates: activePresetCandidates(directory),
      logger: { warn: () => undefined },
    })?.vision?.model
  } catch {
    return undefined
  }
}

function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes
      .subarray(0, 6)
      .toString('ascii')
      .match(/^GIF8[79]a$/)
  )
    return 'image/gif'
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

function toImageAttachment(bytes: Buffer, name: string): ImageAttachment {
  if (bytes.length === 0) throw new Error('image is empty')
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error('image exceeds OpenCode’s 20 MiB attachment limit')
  const mime = imageMime(bytes)
  if (!mime || !IMAGE_TYPES.has(mime)) {
    throw new Error('unsupported image; use PNG, JPEG, WebP, or GIF')
  }
  return { uri: `data:${mime};base64,${bytes.toString('base64')}`, name }
}

function parseDataUri(value: string): ImageAttachment {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value)
  if (!match?.[1] || match[2] === undefined) throw new Error('invalid base64 image data URI')
  if (match[2].length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3)) {
    throw new Error('image exceeds OpenCode’s 20 MiB attachment limit')
  }
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.toString('base64') !== match[2]) throw new Error('invalid base64 image data URI')
  return toImageAttachment(bytes, `image.${match[1].slice('image/'.length).replace('jpeg', 'jpg')}`)
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) !== 6) return false
  const normalized = address.toLowerCase()
  if (normalized.includes('.')) return false // IPv4-mapped and transition addresses are rejected.
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff && !normalized.startsWith('2001:db8:')
}

export function createPinnedLookup(record: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [record])
    else callback(null, record.address, record.family)
  }
}

async function pinnedPublicAddress(hostname: string): Promise<{ address: string; family: number }> {
  const bareHost =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const records = await dnsLookup(bareHost, { all: true, verbatim: true })
  if (records.length === 0 || records.some((record) => !isPublicAddress(record.address))) {
    throw new Error('remote image host must resolve only to public IP addresses')
  }
  const record = records[0]
  if (!record) throw new Error('remote image host did not resolve')
  return record
}

async function readRemoteImage(
  url: URL,
  signal: AbortSignal | undefined,
  redirects = 0,
  secureOrigin = url.protocol === 'https:',
): Promise<{ bytes: Buffer; name: string }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('only public HTTP(S) image URLs without credentials are supported')
  }
  if (secureOrigin && url.protocol !== 'https:')
    throw new Error('HTTPS image redirects cannot downgrade to HTTP')
  const pinned = await pinnedPublicAddress(url.hostname)
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
  const response = await new Promise<{ status: number; location?: string; bytes: Buffer }>(
    (resolveResponse, reject) => {
      const request = requestFn(
        url,
        {
          method: 'GET',
          headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
          lookup: createPinnedLookup(pinned),
          ...(signal ? { signal } : {}),
        },
        (incoming) => {
          const status = incoming.statusCode ?? 0
          const location = incoming.headers.location
          if (status >= 300 && status < 400 && location) {
            incoming.resume()
            resolveResponse({ status, location, bytes: Buffer.alloc(0) })
            return
          }
          const contentLength = Number(incoming.headers['content-length'] ?? 0)
          if (contentLength > MAX_IMAGE_BYTES) {
            incoming.destroy(new Error('image exceeds OpenCode’s 20 MiB attachment limit'))
            reject(new Error('image exceeds OpenCode’s 20 MiB attachment limit'))
            return
          }
          const chunks: Buffer[] = []
          let total = 0
          incoming.on('data', (chunk: Buffer | string) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            total += data.length
            if (total > MAX_IMAGE_BYTES) {
              incoming.destroy(new Error('image exceeds OpenCode’s 20 MiB attachment limit'))
              reject(new Error('image exceeds OpenCode’s 20 MiB attachment limit'))
              return
            }
            chunks.push(data)
          })
          incoming.on('error', reject)
          incoming.on('end', () => resolveResponse({ status, bytes: Buffer.concat(chunks) }))
        },
      )
      request.setTimeout(15_000, () => request.destroy(new Error('image download timed out')))
      request.on('error', reject)
      request.end()
    },
  )
  if (response.location) {
    if (redirects >= MAX_REDIRECTS) throw new Error('remote image redirected too many times')
    return readRemoteImage(new URL(response.location, url), signal, redirects + 1, secureOrigin)
  }
  if (response.status !== 200) throw new Error(`image download returned HTTP ${response.status}`)
  const name = decodeURIComponent(url.pathname.split('/').at(-1) || 'image')
  return { bytes: response.bytes, name: name || 'image' }
}

async function imageAttachment(
  value: string,
  directory: string,
  signal?: AbortSignal,
): Promise<ImageAttachment> {
  const source = value.trim()
  if (!source) throw new Error('path must identify an image file, HTTP(S) URL, or base64 image URI')
  if (source.startsWith('data:')) return parseDataUri(source)
  let url: URL | undefined
  try {
    url = new URL(source)
  } catch {
    // A non-URL string is a local path.
  }
  if (url?.protocol === 'http:' || url?.protocol === 'https:') {
    const remote = await readRemoteImage(url, signal)
    return toImageAttachment(remote.bytes, remote.name)
  }
  let localPath: string
  if (url?.protocol === 'file:') {
    localPath = fileURLToPath(url)
  } else if (url) {
    throw new Error('only file, HTTP, HTTPS, and base64 image sources are supported')
  } else {
    const expanded = source.startsWith('~/') ? join(homedir(), source.slice(2)) : source
    localPath = resolve(directory, expanded)
  }
  let bytes: Buffer
  try {
    bytes = await readFile(localPath, signal ? { signal } : undefined)
  } catch (error) {
    // A clipboard/inline attachment has no path on disk: the model may pass the
    // display name as if it were a file (observed: `ENOENT .../clipboard`).
    // Surface an actionable message instead of the raw ENOENT.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(
        `image file not found: ${localPath}; pass an existing file path, file URL, public HTTP(S) URL, or base64 image data URI`,
      )
    }
    throw error
  }
  return toImageAttachment(bytes, localPath.split(/[\\/]/).at(-1) || 'image')
}

export function createV2VisionTool(runtime: V2VisionRuntime): V2VisionToolDefinition {
  return {
    name: 'vision_describe',
    description:
      'Analyze an image with an OpenCode Zen multimodal model confirmed by the current V2 model catalog. ' +
      'Prefers the OpenCode Go MiMo 2.6 Flash model and falls back to another live image-capable Zen model. ' +
      'Free-tier models are excluded (the direct gateway rejects them). ' +
      'Accepts a local path, file URL, public HTTP(S) URL, or base64 image data URI.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description:
            'Local image path, file URL, public HTTP(S) image URL, or base64 image data URI.',
        },
        prompt: { type: 'string', description: 'Optional image-analysis instruction.' },
      },
    },
    output: {},
    execute: async (input, rawContext) => {
      let stage = 'validate OpenCode session'
      try {
        const call = (asRecord(rawContext) ?? {}) as V2VisionToolContext
        if (!isValidSessionId(call.sessionID)) {
          throw new Error(
            'a valid OpenCode session id is required; retry this tool from an active OpenCode session',
          )
        }
        const pathValue = typeof input.path === 'string' ? input.path : ''
        const directory = call.directory || process.cwd()
        stage = 'load image'
        const image = await imageAttachment(pathValue, directory, call.signal)
        stage = 'read model catalog'
        const preferred = await preferredVisionModel(directory)
        const catalog = await runtime.model.list()
        const model = selectV2VisionModel(catalog, preferred)
        if (!model) {
          if (preferred?.trim()) {
            throw new Error(
              `explicitly configured Vision model "${preferred}" is unavailable or ineligible for the native OpenCode Zen image path; update or remove the explicit model pin (PANTHEON_VISION_MODEL, visionModel config, or active preset), or choose an enabled image-capable OpenCode Zen model`,
            )
          }
          throw new Error(
            'no available OpenCode Zen multimodal model accepts image input; connect OpenCode Zen and enable an image-capable model',
          )
        }
        stage = 'resolve OpenCode Zen authentication'
        const modelID = modelKey(model)
        const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
        const target = await resolveNativeVisionTarget({
          preset: { vision: { model: modelID } },
          env: { ...process.env, PANTHEON_VISION_MODEL: modelID },
          authStatePath: join(dataHome, 'opencode'),
        })
        if (!target) {
          throw new Error(
            'OpenCode Zen authentication is missing; run `opencode auth login` ' +
              '(checked the auth store and the V2 credential database)',
          )
        }
        stage = 'send image to the selected multimodal model'
        // Attach the live session id: the Zen gateway rejects a sessionless
        // request (HTTP 400 MissingSessionID). describeImagesNative sends the
        // header ONLY for Zen targets, never to a non-Zen provider.
        const requestTarget: NativeVisionTarget = {
          ...target,
          sessionID: call.sessionID,
        }
        let failure: NativeVisionFailure | undefined
        const output = await describeImagesNative(
          [{ url: image.uri }],
          requestTarget,
          typeof input.prompt === 'string' && input.prompt.trim()
            ? input.prompt.trim()
            : buildV2ImagePrompt(),
          NATIVE_MAX_TOKENS,
          call.signal,
          (details) => {
            failure = details
          },
        )
        if (!output?.trim()) {
          // Surface the gateway status / finish_reason (never the key or
          // payload) so a 400/401/403 or a max_tokens truncation is actionable.
          throw new Error(nativeVisionFailureMessage(failure, modelKey(model)))
        }
        return {
          output: output.trim(),
          title: `Vision · ${modelKey(model)}`,
          metadata: { model: modelKey(model), attachment: 'image' },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'request failed'
        return {
          output: `Error: Pantheon Vision could not analyze the image during ${stage}: ${message}`,
        }
      }
    },
  }
}
