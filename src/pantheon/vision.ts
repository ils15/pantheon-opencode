import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import type { FilePart, Part, TextPart, UserMessage } from '@opencode-ai/sdk'

// ─── Constants ────────────────────────────────────────────────────────────

const CONFIG_FILENAME = 'opencode-vision.json'
const TEMP_DIR_NAME = 'pantheon-vision'

// Tool the model is instructed to call. Configurable via:
//   1. env PANTHEON_VISION_TOOL
//   2. config file imageAnalysisTool (project > user)
//   3. dynamic detection of an available MCP vision tool
//   4. this default
const DEFAULT_IMAGE_ANALYSIS_TOOL = 'mcp__bifrost__describe_image'

// Enabled for ALL models by default ("paste and ask" universal). The config
// file can restrict this with wildcard patterns.
const DEFAULT_MODEL_PATTERNS: readonly string[] = ['*']

// Only PNG/JPEG/WebP are intercepted (data: URLs need a known extension).
const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
}

const PROMPT_TEMPLATE_VARIABLES = [
  '{imageList}',
  '{imageCount}',
  '{toolName}',
  '{userText}',
] as const

// ─── Types ─────────────────────────────────────────────────────────────────

type VisionConfig = {
  models?: string[]
  imageAnalysisTool?: string
  promptTemplate?: string
}

export type ModelInfo = { providerID: string; modelID: string }

type SavedImage = {
  path: string
  partId: string
  temporary: boolean
}

// ─── Config loading (project > user) ──────────────────────────────────────

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
    return Object.keys(config).length > 0 ? config : null
  } catch {
    return null
  }
}

async function loadVisionConfig(directory: string): Promise<VisionConfig> {
  const project = await readConfigFile(join(directory, '.opencode', CONFIG_FILENAME))
  const user = await readConfigFile(userConfigPath())
  const merged: VisionConfig = {}
  if (project?.models) merged.models = project.models
  else if (user?.models) merged.models = user.models
  if (project?.imageAnalysisTool) merged.imageAnalysisTool = project.imageAnalysisTool
  else if (user?.imageAnalysisTool) merged.imageAnalysisTool = user.imageAnalysisTool
  if (project?.promptTemplate) merged.promptTemplate = project.promptTemplate
  else if (user?.promptTemplate) merged.promptTemplate = user.promptTemplate
  return merged
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
    SUPPORTED_MIME_TYPES.has(value.mime.toLowerCase())
  )
}

function isTextPart(part: Part): part is TextPart {
  return part.type === 'text'
}

// ─── Image target resolution ───────────────────────────────────────────────
// file:// → local path used directly; data: → decoded + saved to temp;
// http(s):// → URL passed through unchanged.

function getExtensionForMime(mime: string): string {
  return MIME_TO_EXTENSION[mime.toLowerCase()] ?? 'png'
}

async function saveDataUrlImage(dataUrl: string, mime: string): Promise<string | null> {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) return null
  const data = Buffer.from(match[2] ?? '', 'base64')
  if (data.length === 0) return null
  const dir = join(tmpdir(), TEMP_DIR_NAME)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${randomUUID()}.${getExtensionForMime(mime)}`)
  await writeFile(filePath, data)
  return filePath
}

async function resolveImageTarget(filePart: FilePart): Promise<SavedImage | null> {
  const url = filePart.url
  if (!url) return null
  if (url.startsWith('file://')) {
    return { path: url.slice('file://'.length), partId: filePart.id, temporary: false }
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

// ─── Prompt generation ─────────────────────────────────────────────────────

export function generateInjectionPrompt(
  images: Array<{ path: string }>,
  userText: string,
  toolName: string,
  template?: string,
): string {
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

// ─── Tool name resolution ──────────────────────────────────────────────────
// env PANTHEON_VISION_TOOL > config imageAnalysisTool > dynamic detection
// (find a registered MCP tool named like a vision tool) > default.

async function resolveImageAnalysisTool(
  client: PluginInput['client'],
  directory: string,
  configPromise: Promise<VisionConfig>,
): Promise<string> {
  const envTool = process.env.PANTHEON_VISION_TOOL?.trim()
  if (envTool) return envTool
  const config = await configPromise
  if (config.imageAnalysisTool) return config.imageAnalysisTool
  try {
    const response = await client.tool?.ids?.({ query: { directory } })
    const ids = response?.data
    if (Array.isArray(ids)) {
      const match =
        ids.find((id) => id.includes('describe_image')) ?? ids.find((id) => /vision/i.test(id))
      if (match) return match
    }
  } catch {
    // Dynamic detection is best-effort; fall back to the default tool.
  }
  return DEFAULT_IMAGE_ANALYSIS_TOOL
}

// ─── Temp image lifecycle ──────────────────────────────────────────────────

async function cleanupSessionTempImages(
  sessionTempFiles: Map<string, Set<string>>,
  sessionID: string,
): Promise<void> {
  const paths = sessionTempFiles.get(sessionID)
  sessionTempFiles.delete(sessionID)
  if (paths) {
    for (const path of paths) {
      try {
        await unlink(path)
      } catch {
        // Best effort.
      }
    }
  }
  if (sessionTempFiles.size === 0) {
    try {
      await rm(join(tmpdir(), TEMP_DIR_NAME), { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
}

// ─── Handler factory ───────────────────────────────────────────────────────

export function createVisionHandler(input: PluginInput) {
  const { client, directory } = input
  const sessionTempFiles = new Map<string, Set<string>>()
  let configPromise: Promise<VisionConfig> | null = null
  let toolNamePromise: Promise<string> | null = null

  const getConfig = (): Promise<VisionConfig> => {
    configPromise ??= loadVisionConfig(directory)
    return configPromise
  }

  const getToolName = (): Promise<string> => {
    toolNamePromise ??= resolveImageAnalysisTool(client, directory, getConfig())
    return toolNamePromise
  }

  const chatMessage: NonNullable<Hooks['chat.message']> = async (hookInput, output) => {
    try {
      const message: UserMessage | undefined = output?.message
      if (!message || message.role !== 'user') return
      const model = hookInput?.model ?? message.model
      const config = await getConfig()
      const patterns =
        config.models && config.models.length > 0 ? config.models : DEFAULT_MODEL_PATTERNS
      if (!modelMatchesAnyPattern(model, patterns)) return

      const parts: Part[] = Array.isArray(output.parts) ? output.parts : []
      const images = parts.filter(isImageFilePart)
      if (images.length === 0) return

      const toolName = await getToolName()
      const userText = parts
        .filter(isTextPart)
        .map((part) => part.text)
        .join('\n')
        .trim()

      const saved: SavedImage[] = []
      for (const image of images) {
        const target = await resolveImageTarget(image)
        if (target) saved.push(target)
      }
      if (saved.length === 0) return

      const tempPaths = saved.filter((item) => item.temporary).map((item) => item.path)
      if (tempPaths.length > 0) {
        const existing = sessionTempFiles.get(hookInput.sessionID) ?? new Set<string>()
        for (const path of tempPaths) existing.add(path)
        sessionTempFiles.set(hookInput.sessionID, existing)
      }

      const injection = generateInjectionPrompt(saved, userText, toolName, config.promptTemplate)
      const injectionPart: TextPart = {
        id: `vision-${randomUUID()}`,
        sessionID: message.sessionID,
        messageID: message.id,
        type: 'text',
        text: injection,
        synthetic: true,
      }
      const kept = parts.filter((part) => !isImageFilePart(part))
      // Mutate in place: drop image parts, lead with the tool instruction.
      output.parts.splice(0, output.parts.length, injectionPart, ...kept)
    } catch {
      // Vision interception is best-effort; never fail a user turn.
    }
  }

  const event: NonNullable<Hooks['event']> = async ({ event: ev }) => {
    if (ev.type === 'session.idle') {
      const sessionID = ev.properties?.sessionID
      if (sessionID) await cleanupSessionTempImages(sessionTempFiles, sessionID)
    } else if (ev.type === 'server.instance.disposed') {
      const sessions = [...sessionTempFiles.keys()]
      for (const sessionID of sessions) {
        await cleanupSessionTempImages(sessionTempFiles, sessionID)
      }
    }
  }

  return { chatMessage, event }
}
