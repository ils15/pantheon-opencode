/** Minimal, session-scoped bounded file reader for the OpenCode V2 surface. */

import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { V2ToolDef } from './v2-tools.ts'

export const BOUNDED_READ_TOOL = 'pantheon_bounded_read'
export const BOUNDED_READ_MAX_CALLS = 2
export const BOUNDED_READ_MAX_FILES = 2
export const BOUNDED_READ_MAX_LINES = 400
export const BOUNDED_READ_MAX_BYTES = 32 * 1024
const BYTES_PER_CALL = BOUNDED_READ_MAX_BYTES / BOUNDED_READ_MAX_CALLS
const ORIGIN_TTL_MS = 60_000
const MAX_SESSIONS = 256
const READ_CHUNK_BYTES = 1
const DENIED_COMPONENTS = new Set([
  '.aws',
  '.config',
  '.docker',
  '.gnupg',
  '.kube',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.ssh',
  '.git',
  'auth',
  'authentication',
  'database',
  'db',
  'global',
  'migration',
  'migrations',
  'schema',
  'schemas',
  'data',
  'dataset',
  'datasets',
  'authorized_keys',
  'credentials',
  'id_ed25519',
  'id_rsa',
  'known_hosts',
  'secrets',
])
const DENIED_EXTENSIONS = new Set([
  '.cer',
  '.crt',
  '.der',
  '.jks',
  '.key',
  '.p12',
  '.p7b',
  '.p7c',
  '.pem',
  '.pfx',
  '.pub',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.sql',
])
const DENIED_MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
  '.pdf',
  '.mp3',
  '.mp4',
  '.wav',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.a',
  '.class',
  '.dll',
  '.docx',
  '.dylib',
  '.exe',
  '.jar',
  '.odt',
  '.ods',
  '.otf',
  '.o',
  '.pptx',
  '.pyc',
  '.rar',
  '.so',
  '.ttf',
  '.wasm',
  '.woff',
  '.woff2',
  '.xlsx',
  '.xz',
])

export interface BoundedReadIdentity {
  sessionID: string
  messageID: string
  callID: string
  agent: string
  relativePath: string
}

interface StoredOrigin extends BoundedReadIdentity {
  capturedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function originKey(sessionID: string, messageID: string, callID: string): string {
  return JSON.stringify([sessionID, messageID, callID])
}

function budgetKey(sessionID: string, messageID: string): string {
  return JSON.stringify([sessionID, messageID])
}

/** One-shot proof that this exact V2 root tool invocation reached execute(). */
export class V2BoundedReadOriginRegistry {
  private readonly entries = new Map<string, StoredOrigin>()

  capture(rawEvent: unknown, now = Date.now()): BoundedReadIdentity | undefined {
    this.prune(now)
    if (!isRecord(rawEvent) || rawEvent.tool !== BOUNDED_READ_TOOL || !isRecord(rawEvent.input)) {
      return undefined
    }
    const identity = {
      sessionID: nonEmpty(rawEvent.sessionID),
      messageID: nonEmpty(rawEvent.messageID),
      callID: nonEmpty(rawEvent.id),
      agent: nonEmpty(rawEvent.agent),
      relativePath: validateRelativePath(rawEvent.input.path) ? rawEvent.input.path : undefined,
    }
    if (
      identity.sessionID === undefined ||
      identity.messageID === undefined ||
      identity.callID === undefined ||
      identity.agent !== 'zeus' ||
      identity.relativePath === undefined ||
      this.entries.size >= MAX_SESSIONS
    ) {
      return undefined
    }
    const origin: BoundedReadIdentity = {
      sessionID: identity.sessionID,
      messageID: identity.messageID,
      callID: identity.callID,
      agent: identity.agent,
      relativePath: identity.relativePath,
    }
    this.entries.set(originKey(origin.sessionID, origin.messageID, origin.callID), {
      ...origin,
      capturedAt: now,
    })
    return origin
  }

  consume(
    identity: Omit<BoundedReadIdentity, 'relativePath'> & { relativePath: unknown },
    now = Date.now(),
  ): BoundedReadIdentity | undefined {
    this.prune(now)
    const key = originKey(identity.sessionID, identity.messageID, identity.callID)
    const origin = this.entries.get(key)
    this.entries.delete(key)
    if (
      origin === undefined ||
      identity.agent !== origin.agent ||
      identity.relativePath !== origin.relativePath
    ) {
      return undefined
    }
    const { capturedAt: _capturedAt, ...result } = origin
    return result
  }

  forget(rawEvent: unknown): void {
    if (!isRecord(rawEvent)) return
    const sessionID = nonEmpty(rawEvent.sessionID)
    const messageID = nonEmpty(rawEvent.messageID)
    const callID = nonEmpty(rawEvent.id)
    if (sessionID && messageID && callID) {
      this.entries.delete(originKey(sessionID, messageID, callID))
    }
  }

  clearSession(sessionID: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionID === sessionID) this.entries.delete(key)
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.capturedAt > ORIGIN_TTL_MS) this.entries.delete(key)
    }
  }
}

interface Budget {
  sessionID: string
  messageID: string
  root: string
  files: Set<string>
  calls: number
  lines: number
  bytes: number
  sealed: boolean
}

export interface BoundedReadHostSession {
  id?: unknown
  parentID?: unknown
  projectID?: unknown
}

export interface BoundedReadDependencies {
  /** Project identity is taken from ctx.location once during plugin setup. */
  rootDirectory: string
  projectID: string
  getSession: (sessionID: string) => Promise<unknown>
  assertPermission: (request: Record<string, unknown>) => Promise<unknown>
  scanContent: (input: {
    content: string
    agent: string
    sessionID: string
    messageID: string
    callID: string
  }) => Promise<'allow' | 'deny' | 'unavailable'>
}

interface ReadArgs {
  path: string
  offset: number
  limit: number
}

function validateRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) return false
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes(':') ||
    value.includes('*') ||
    value.includes('?') ||
    value.includes('[') ||
    value.includes(']') ||
    value.includes('{') ||
    value.includes('}') ||
    value.includes('%') ||
    value.startsWith('~')
  ) {
    return false
  }
  const components = value.split('/')
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    return false
  }
  return components.every((component) =>
    [...component].every((character) => {
      const code = character.charCodeAt(0)
      return code > 0x1f && code !== 0x7f
    }),
  )
}

function parseArgs(input: Record<string, unknown>): ReadArgs | undefined {
  if (Object.keys(input).some((key) => !['path', 'offset', 'limit'].includes(key))) return undefined
  const filePath = input.path
  const offset = input.offset
  const limit = input.limit
  if (
    !validateRelativePath(filePath) ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 1 ||
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > BOUNDED_READ_MAX_LINES
  ) {
    return undefined
  }
  return { path: filePath, offset: offset as number, limit: limit as number }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function sensitivePath(relativePath: string): boolean {
  const components = relativePath.split('/').map((component) => component.toLowerCase())
  const leaf = components.at(-1) ?? ''
  const extension = path.extname(leaf)
  return (
    components.some(
      (component) =>
        DENIED_COMPONENTS.has(component) ||
        component.startsWith('.env') ||
        /(^|[._-])(auth|authentication|data|dataset|datasets|database|db|schema|schemas|global|migration|migrations)([._-]|$)/.test(
          component,
        ),
    ) ||
    /(^|[._-])(secret|token|credential|credentials|password|private)([._-]|$)/.test(leaf) ||
    DENIED_EXTENSIONS.has(extension) ||
    DENIED_MEDIA_EXTENSIONS.has(extension)
  )
}

function errorResult(code: string): { output: string } {
  return { output: code }
}

function hasParent(session: BoundedReadHostSession): boolean {
  return Object.hasOwn(session, 'parentID')
}

async function readLineWindow(
  filePath: string,
  offset: number,
  limit: number,
  byteCap: number,
): Promise<{ content: string; linesRead: number; bytes: number }> {
  const before = await lstat(filePath)
  if (before.isSymbolicLink()) throw new Error('PATH_DENIED')
  if (!before.isFile() || before.nlink > 1) throw new Error('PATH_DENIED')

  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await file.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink > 1
    ) {
      throw new Error('CHANGED')
    }

    const chunks: Buffer[] = []
    const inspectedChunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let position = 0
    let currentLine = 1
    let linesRead = 0
    let selectedBytes = 0
    let inspectedBytes = 0
    let currentLineHasBytes = false
    let intervalComplete = false
    while (inspectedBytes < byteCap) {
      const size = Math.min(buffer.length, byteCap - inspectedBytes)
      const read = await file.read(buffer, 0, size, position)
      if (read.bytesRead === 0) break
      position += read.bytesRead
      inspectedBytes += read.bytesRead
      inspectedChunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)))
      let consumed = 0
      let selectedStart = -1
      for (; consumed < read.bytesRead; consumed++) {
        const byte = buffer.readUInt8(consumed)
        if (
          byte === 0 ||
          (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ||
          byte === 0x7f
        ) {
          throw new Error('PATH_DENIED')
        }
        const selected = currentLine >= offset && currentLine < offset + limit
        if (selected) {
          if (selectedStart === -1) selectedStart = consumed
          currentLineHasBytes = true
        }
        if (byte === 0x0a) {
          if (selected) linesRead += 1
          currentLine += 1
          currentLineHasBytes = false
          if (currentLine >= offset + limit) {
            intervalComplete = true
            consumed += 1
            break
          }
        } else if (!selected && currentLine >= offset && currentLine < offset + limit) {
          currentLineHasBytes = true
        }
      }
      if (selectedStart !== -1) {
        const selectedEnd = consumed
        const selectedChunk = Buffer.from(buffer.subarray(selectedStart, selectedEnd))
        selectedBytes += selectedChunk.length
        if (selectedBytes > byteCap) throw new Error('BUDGET_EXCEEDED')
        chunks.push(selectedChunk)
      }
      if (intervalComplete) break
      if (read.bytesRead < size) break
    }

    if (
      !intervalComplete &&
      currentLineHasBytes &&
      currentLine >= offset &&
      currentLine < offset + limit
    ) {
      linesRead += 1
    }
    if (!intervalComplete && inspectedBytes === byteCap && currentLine < offset + limit) {
      throw new Error('BUDGET_EXCEEDED')
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(inspectedChunks, inspectedBytes),
      )
    } catch {
      throw new Error('PATH_DENIED')
    }
    const bytes = Buffer.concat(chunks, selectedBytes)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('PATH_DENIED')
    }
    return { content, linesRead, bytes: selectedBytes }
  } finally {
    await file?.close().catch(() => undefined)
  }
}

/** Build one registered tool and its in-memory, session-lifecycle state. */
export function createV2BoundedReadTool(dependencies: BoundedReadDependencies): {
  definition: V2ToolDef
  origins: V2BoundedReadOriginRegistry
  clearSession: (sessionID: string) => void
} {
  const origins = new V2BoundedReadOriginRegistry()
  const budgets = new Map<string, Budget>()

  const reserve = (
    sessionID: string,
    messageID: string,
    root: string,
    args: ReadArgs,
  ): string | undefined => {
    const key = budgetKey(sessionID, messageID)
    let budget = budgets.get(key)
    if (budget === undefined) {
      if (budgets.size >= MAX_SESSIONS) return 'UNAVAILABLE'
      budget = {
        sessionID,
        messageID,
        root,
        files: new Set(),
        calls: 0,
        lines: 0,
        bytes: 0,
        sealed: false,
      }
      budgets.set(key, budget)
    }
    if (budget.root !== root || budget.sealed) return 'SCOPE_DENIED'
    if (budget.files.has(args.path)) return 'SCOPE_DENIED'
    if (
      budget.calls + 1 > BOUNDED_READ_MAX_CALLS ||
      budget.files.size + 1 > BOUNDED_READ_MAX_FILES ||
      budget.lines + args.limit > BOUNDED_READ_MAX_LINES ||
      budget.bytes + BYTES_PER_CALL > BOUNDED_READ_MAX_BYTES
    ) {
      budget.sealed = true
      return 'BUDGET_EXCEEDED'
    }
    budget.calls += 1
    budget.files.add(args.path)
    budget.lines += args.limit
    budget.bytes += BYTES_PER_CALL
    return undefined
  }

  const definition: V2ToolDef = {
    name: BOUNDED_READ_TOOL,
    description:
      'Read a small line range from one exact text file inside the current project. Root Zeus only; two files and 400 lines total per assistant message. Denies recognized sensitive scopes and known binary/media formats; returns only bounded valid UTF-8 text after secret scanning. No directories or fallback reading.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'offset', 'limit'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description:
            'Exact relative file path inside the current project; no globs or traversal.',
        },
        offset: {
          type: 'integer',
          minimum: 1,
          description: 'First line to return, starting at 1.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: BOUNDED_READ_MAX_LINES,
          description: 'Number of lines requested; at most 400 lines total across this turn.',
        },
      },
    },
    output: {},
    async execute(rawInput: Record<string, unknown>, rawContext: unknown) {
      const args = parseArgs(rawInput)
      if (args === undefined) return errorResult('ARGUMENT_INVALID')
      if (!isRecord(rawContext)) return errorResult('BOUND_READ_UNAUTHORIZED')
      const sessionID = nonEmpty(rawContext.sessionID)
      const messageID = nonEmpty(rawContext.messageID)
      const callID = nonEmpty(rawContext.id)
      const agent = nonEmpty(rawContext.agent)
      if (!sessionID || !messageID || !callID || agent !== 'zeus') {
        return errorResult('BOUND_READ_UNAUTHORIZED')
      }
      const origin = origins.consume({
        sessionID,
        messageID,
        callID,
        agent,
        relativePath: args.path,
      })
      if (origin === undefined) return errorResult('BOUND_READ_UNAUTHORIZED')

      let sessionValue: unknown
      try {
        sessionValue = await dependencies.getSession(sessionID)
      } catch {
        return errorResult('BOUND_READ_UNAUTHORIZED')
      }
      if (!isRecord(sessionValue)) return errorResult('BOUND_READ_UNAUTHORIZED')
      const session = sessionValue as BoundedReadHostSession
      if (
        session.id !== sessionID ||
        hasParent(session) ||
        session.projectID !== dependencies.projectID
      ) {
        return errorResult('BOUND_READ_UNAUTHORIZED')
      }

      // The caller supplies the realpath captured before registration. This is
      // pure lexical work, so quota reservation still precedes filesystem I/O.
      const root = path.resolve(dependencies.rootDirectory)
      const target = path.resolve(root, ...args.path.split('/'))
      if (!isWithin(root, target) || sensitivePath(args.path)) return errorResult('PATH_DENIED')
      const reservationError = reserve(sessionID, messageID, root, args)
      if (reservationError !== undefined) return errorResult(reservationError)

      try {
        await dependencies.assertPermission({
          sessionID,
          agent,
          action: 'read',
          resources: [target],
          save: [],
          source: { type: 'tool', messageID, id: callID },
        })
      } catch {
        return errorResult('TOOL_DENIED')
      }

      const rootInfo = await lstat(root).catch(() => undefined)
      if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return errorResult('PATH_DENIED')
      const components = args.path.split('/')
      let cursor = root
      for (const [index, component] of components.entries()) {
        cursor = path.join(cursor, component)
        const info = await lstat(cursor).catch(() => undefined)
        if (info === undefined || info.isSymbolicLink()) return errorResult('PATH_DENIED')
        if (index < components.length - 1 && !info.isDirectory()) return errorResult('PATH_DENIED')
        if (index === components.length - 1 && !info.isFile()) return errorResult('PATH_DENIED')
      }
      const targetReal = await realpath(target).catch(() => undefined)
      if (targetReal === undefined || !isWithin(root, targetReal)) return errorResult('PATH_DENIED')

      try {
        const result = await readLineWindow(targetReal, args.offset, args.limit, BYTES_PER_CALL)
        const scanDecision = await dependencies.scanContent({
          content: result.content,
          agent,
          sessionID,
          messageID,
          callID,
        })
        if (scanDecision !== 'allow') {
          return errorResult(scanDecision === 'deny' ? 'SCOPE_DENIED' : 'UNAVAILABLE')
        }
        return {
          output: JSON.stringify({
            path: args.path,
            offset: args.offset,
            linesRead: result.linesRead,
            bytes: result.bytes,
            status: result.linesRead === 0 ? 'empty' : 'ok',
            content: result.content,
          }),
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        return errorResult(
          ['CHANGED', 'BUDGET_EXCEEDED', 'PATH_DENIED'].includes(code) ? code : 'UNAVAILABLE',
        )
      }
    },
  }

  return {
    definition,
    origins,
    clearSession(sessionID) {
      for (const [key, budget] of budgets) {
        if (budget.sessionID === sessionID) budgets.delete(key)
      }
      origins.clearSession(sessionID)
    },
  }
}
