import { createHash } from 'node:crypto'
import type { PluginInput } from '@opencode-ai/plugin'
import type { FilePart, Part, TextPart } from '@opencode-ai/sdk'

type TransformMessage = {
  info: { role?: string; sessionID?: string }
  parts: Part[]
}

type ImageHit = {
  part: FilePart
  message: TransformMessage
  partIndex: number
  imageIndex: number
}

type CachedImageAnalysis = {
  descriptions: Map<number, string>
  context: string
  expiresAt: number
}

type OfficialClient = PluginInput['client']
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000
const IMAGE_CACHE_MAX_ENTRIES = 128

export function isImageFilePart(part: unknown): part is FilePart {
  if (!part || typeof part !== 'object') return false
  const value = part as { type?: unknown; mime?: unknown; url?: unknown }
  return (
    value.type === 'file' &&
    typeof value.mime === 'string' &&
    value.mime.startsWith('image/') &&
    typeof value.url === 'string'
  )
}
function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}
export function parseImageResponse(text: string): {
  descriptions: Map<number, string>
  context: string
} {
  const descriptions = new Map<number, string>()
  const contextMatch = /<context\b[^>]*>([\s\S]*?)<\/context>/i.exec(text)
  const context = contextMatch ? unescapeXml(contextMatch[1]?.trim() ?? '') : ''
  const itemRegex = /<item\b[^>]*?\bid\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/item>/gi
  let itemMatch: RegExpExecArray | null
  while (true) {
    itemMatch = itemRegex.exec(text)
    if (itemMatch === null) break
    const id = Number(itemMatch[1])
    const inner = itemMatch[2] ?? ''
    const descriptionMatch = /<description\b[^>]*>([\s\S]*?)<\/description>/i.exec(inner)
    const body = descriptionMatch?.[1] ?? inner
    const description = unescapeXml(body.trim())
    if (Number.isSafeInteger(id) && id > 0 && description.length > 0) {
      descriptions.set(id, description)
    }
  }

  if (descriptions.size === 0) {
    const standalone = /<description\b[^>]*>([\s\S]*?)<\/description>/i.exec(text)
    if (standalone?.[1]?.trim()) descriptions.set(1, unescapeXml(standalone[1].trim()))
  }
  return { descriptions, context }
}
export function imageCacheKey(
  sessionID: string,
  prompt: string,
  model: string,
  images: ReadonlyArray<Pick<FilePart, 'mime' | 'url'>>,
): string {
  const promptHash = createHash('sha256').update(prompt).digest('hex')
  const imageHashes = images.map((image) =>
    createHash('sha256').update(image.mime).update('\0').update(image.url).digest('hex'),
  )
  return createHash('sha256')
    .update(sessionID)
    .update('\0')
    .update(model)
    .update('\0')
    .update(promptHash)
    .update('\0')
    .update(imageHashes.join('\0'))
    .digest('hex')
}
export function replaceImagePartInPlace(parts: Part[], index: number, text: string): void {
  const original = parts[index]
  if (!isImageFilePart(original)) return
  const replacement: TextPart = {
    id: original.id,
    sessionID: original.sessionID,
    messageID: original.messageID,
    type: 'text',
    text,
    synthetic: true,
  }
  parts[index] = replacement
}

function latestUserText(messages: TransformMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.info.role !== 'user') continue
    return message.parts
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

function collectImageHits(messages: TransformMessage[]): ImageHit[] {
  const hits: ImageHit[] = []
  let imageIndex = 0
  for (const message of messages) {
    if (message.info.role !== 'user') continue
    message.parts.forEach((part, partIndex) => {
      if (!isImageFilePart(part)) return
      hits.push({ part, message, partIndex, imageIndex })
      imageIndex += 1
    })
  }
  return hits
}

function getCachedImageAnalysis(
  cache: Map<string, CachedImageAnalysis>,
  key: string,
): CachedImageAnalysis | undefined {
  const cached = cache.get(key)
  if (!cached) return undefined
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return cached
}

function setCachedImageAnalysis(
  cache: Map<string, CachedImageAnalysis>,
  key: string,
  analysis: Omit<CachedImageAnalysis, 'expiresAt'>,
): void {
  cache.delete(key)
  while (cache.size >= IMAGE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, { ...analysis, expiresAt: Date.now() + IMAGE_CACHE_TTL_MS })
}

function splitModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function analysisPrompt(userPrompt: string, images: ImageHit[]): string {
  const items = images
    .map(
      (hit, index) =>
        `${index + 1}: ${hit.part.mime}${hit.part.filename ? ` (${hit.part.filename})` : ''}`,
    )
    .join('\n')
  return [
    'Describe the attached images faithfully for a text-only assistant.',
    'Return one item per image using exactly <item id="N"><description>description</description></item>.',
    'You may add one optional <context>...</context> with task-relevant comparison or context.',
    'Do not invent details. Do not include markdown outside those tags.',
    `Images in order:\n${items}`,
    `User request:\n${userPrompt || '(no additional request)'}`,
  ].join('\n\n')
}

function responseText(parts: Part[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

async function describeImages(
  client: OfficialClient,
  directory: string,
  parentSessionID: string,
  visionModel: string,
  userPrompt: string,
  images: ImageHit[],
  auxiliarySessions: Set<string>,
): Promise<{ descriptions: Map<number, string>; context: string } | undefined> {
  const model = splitModel(visionModel)
  if (!model) return undefined

  let auxiliarySessionID: string | undefined
  try {
    const created = await client.session.create({
      body: { parentID: parentSessionID, title: 'Pantheon image analysis' },
      query: { directory },
    })
    auxiliarySessionID = created.data?.id
    if (!auxiliarySessionID) return undefined
    auxiliarySessions.add(auxiliarySessionID)

    const parts = [
      { type: 'text' as const, text: analysisPrompt(userPrompt, images) },
      ...images.map((hit) => ({
        type: 'file' as const,
        mime: hit.part.mime,
        url: hit.part.url,
        ...(hit.part.filename ? { filename: hit.part.filename } : {}),
      })),
    ]
    const result = await client.session.prompt({
      path: { id: auxiliarySessionID },
      query: { directory },
      body: { model, parts },
    })
    const text = result.data ? responseText(result.data.parts) : ''
    if (!text) return undefined
    const parsed = parseImageResponse(text)
    if (parsed.descriptions.size === 0 && images.length === 1) {
      const fallback = text.replace(/<context\b[^>]*>[\s\S]*?<\/context>/gi, '').trim()
      if (fallback) parsed.descriptions.set(1, fallback)
    }
    return parsed.descriptions.size > 0 ? parsed : undefined
  } catch {
    return undefined
  } finally {
    if (auxiliarySessionID) {
      auxiliarySessions.delete(auxiliarySessionID)
      try {
        await client.session.delete({ path: { id: auxiliarySessionID }, query: { directory } })
      } catch {
        // Auxiliary cleanup is best effort; the main turn must never fail here.
      }
    }
  }
}

export function createImageTransform(
  client: OfficialClient,
  directory: string,
  resolveVisionModel: () => string,
): (messages: TransformMessage[]) => Promise<void> {
  const auxiliarySessions = new Set<string>()
  const cache = new Map<string, CachedImageAnalysis>()

  return async (messages: TransformMessage[]): Promise<void> => {
    try {
      const sessionID = messages.find((message) => message.info.sessionID)?.info.sessionID
      if (!sessionID || auxiliarySessions.has(sessionID)) return
      const hits = collectImageHits(messages)
      if (hits.length === 0) return

      const visionModel = resolveVisionModel()
      const userPrompt = latestUserText(messages)
      const key = imageCacheKey(
        sessionID,
        userPrompt,
        visionModel,
        hits.map((hit) => hit.part),
      )
      const cached = getCachedImageAnalysis(cache, key)
      const analysis =
        cached ??
        (await describeImages(
          client,
          directory,
          sessionID,
          visionModel,
          userPrompt,
          hits,
          auxiliarySessions,
        ))
      if (!analysis) return
      if (!cached) setCachedImageAnalysis(cache, key, analysis)

      let contextAttached = false
      for (const hit of hits) {
        const description = analysis.descriptions.get(hit.imageIndex + 1)
        if (!description) continue
        const context =
          analysis.context && !contextAttached ? `\n\nContext: ${analysis.context}` : ''
        if (context) contextAttached = true
        replaceImagePartInPlace(hit.message.parts, hit.partIndex, `${description}${context}`)
      }
    } catch {
      // Image enrichment is optional. Any failure leaves original FileParts intact.
    }
  }
}
