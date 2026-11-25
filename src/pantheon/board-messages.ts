/**
 * Persistent `#seq` Swarm & Council Board Store (`board-messages.ts`).
 *
 * Append-only NDJSON message log stored at
 * `<sharedRoot>/.pantheon/board/messages.ndjson` (resolved via
 * `resolveSharedPantheonRoot`) with serialized per-file async write queues
 * deduplicated on `globalThis` so concurrent writers and dual-loaded plugin
 * instances never interleave or collide on monotonic `#seq` numbers.
 *
 * Exposes `pantheon_board` (`post | read | status | channel`) for agents and
 * Council/Agora coordination.
 *
 * @module pantheon/board-messages
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { BackgroundJobBoard, BackgroundJobRecord } from './background-job-board.ts'
import { type BoardMessageTag, getSharedBus } from './bus.ts'
import { getSharedBoard } from './shared-board.ts'
import { resolveSharedPantheonRoot, resolveToolCwd } from './tool-context.ts'
import type { PantheonToolDef, PantheonToolResult } from './tools.ts'

export type { BoardMessageTag } from './bus.ts'

export interface EphemeralWorkerMetadata {
  readonly role: string
  readonly baseAgent: string
  readonly sessionID?: string
  readonly worktreeDir?: string
  readonly status: 'running' | 'completed' | 'failed' | 'cleaned'
}

export interface BoardMessage {
  readonly seq: number
  readonly timestamp: number
  readonly channel: string
  readonly threadId: string
  readonly goal?: string
  readonly workstream?: string
  readonly stepKey?: string
  readonly from: string
  readonly mentions: readonly string[]
  readonly replyToSeq?: number
  readonly tag?: BoardMessageTag
  readonly body: string
  readonly ephemeral?: EphemeralWorkerMetadata
}

export interface BoardChannelHeader {
  readonly channel: string
  readonly threadId: string
  readonly goal?: string
  readonly workstream?: string
  readonly updatedAt: number
}

export interface AppendBoardMessageInput {
  readonly channel?: string
  readonly threadId?: string
  readonly goal?: string
  readonly workstream?: string
  readonly stepKey?: string
  readonly from: string
  readonly to?: readonly string[]
  readonly replyToSeq?: number
  readonly tag?: BoardMessageTag
  readonly body: string
  readonly ephemeral?: EphemeralWorkerMetadata
  readonly timestamp?: number
}

export interface ReadBoardMessagesFilter {
  readonly since?: number
  readonly seqs?: readonly number[]
  readonly channel?: string
  readonly threadId?: string
  readonly stepKey?: string
  readonly mention?: string
  readonly limit?: number
}

export interface BoardMessagesReadResult {
  readonly head: number
  readonly messages: BoardMessage[]
}

export interface BoardStatusSummary {
  readonly head: number
  readonly channels: readonly string[]
  readonly threads: ReadonlyArray<{
    readonly channel: string
    readonly threadId: string
    readonly goal?: string
    readonly workstream?: string
    readonly headSeq: number
    readonly messageCount: number
    readonly lastTag?: BoardMessageTag
    readonly updatedAt: number
  }>
  readonly activeJobs: ReadonlyArray<
    Pick<
      BackgroundJobRecord,
      'taskID' | 'alias' | 'agent' | 'state' | 'updatedAt' | 'terminalUnreconciled'
    >
  >
  readonly recentAlerts: readonly BoardMessage[]
}

const VALID_TAGS: ReadonlySet<BoardMessageTag> = new Set([
  'claim',
  'handoff',
  'question',
  'rebuttal',
  'consensus',
  'deadlock',
  'done',
  'blocker',
  'alert',
  'note',
])

const QUEUE_KEY = '__pantheonBoardMessageQueues'
const SEQ_CACHE_KEY = '__pantheonBoardMessageSeqCache'
const DEFAULT_CHANNEL = 'swarm'
const DEFAULT_THREAD_ID = 'main'
const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100

function getWriteQueues(): Map<string, Promise<unknown>> {
  const host = globalThis as { [QUEUE_KEY]?: Map<string, Promise<unknown>> }
  if (host[QUEUE_KEY] instanceof Map) return host[QUEUE_KEY]
  const map = new Map<string, Promise<unknown>>()
  host[QUEUE_KEY] = map
  return map
}

function getSeqCache(): Map<string, number> {
  const host = globalThis as { [SEQ_CACHE_KEY]?: Map<string, number> }
  if (host[SEQ_CACHE_KEY] instanceof Map) return host[SEQ_CACHE_KEY]
  const map = new Map<string, number>()
  host[SEQ_CACHE_KEY] = map
  return map
}

function enqueueSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const queues = getWriteQueues()
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.then(task, task)
  queues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

function resolveBoardDir(workspaceDir: string, create = false): string {
  const sharedRoot = resolveSharedPantheonRoot(workspaceDir)
  const dir = join(sharedRoot, '.pantheon', 'board')
  if (create) {
    mkdirSync(dir, { recursive: true })
  }
  const canonicalParent = existsSync(dir)
    ? realpathSync(dir)
    : existsSync(sharedRoot)
      ? join(realpathSync(sharedRoot), '.pantheon', 'board')
      : resolve(dir)
  const expectedPrefix = resolve(sharedRoot)
  if (!canonicalParent.startsWith(expectedPrefix)) {
    throw new Error('Board storage path escapes shared pantheon root')
  }
  return canonicalParent
}

function resolveConfinedBoardFile(
  workspaceDir: string,
  fileName: string,
  createDir = false,
): string {
  const boardDir = resolveBoardDir(workspaceDir, createDir)
  const target = resolve(boardDir, fileName)
  const prefix = boardDir.endsWith(sep) ? boardDir : `${boardDir}${sep}`
  if (!target.startsWith(prefix)) {
    throw new Error(`Board path "${fileName}" escapes .pantheon/board boundary`)
  }
  return target
}

export function resolveBoardMessagesPath(workspaceDir: string, createDir = false): string {
  return resolveConfinedBoardFile(workspaceDir, 'messages.ndjson', createDir)
}

export function resolveBoardThreadsPath(workspaceDir: string, createDir = false): string {
  return resolveConfinedBoardFile(workspaceDir, 'threads.json', createDir)
}

function normalizeAgentToken(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase()
}

export function isBoardMessageTag(value: unknown): value is BoardMessageTag {
  return typeof value === 'string' && VALID_TAGS.has(value as BoardMessageTag)
}

/** Extract deduplicated lowercase `@mentions` from a board message body. */
export function extractBoardMentions(body: string): string[] {
  const seen = new Set<string>()
  const matches = body.matchAll(/(?:^|[\s(])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/g)
  for (const match of matches) {
    const token = match[1]?.toLowerCase()
    if (token) seen.add(token)
  }
  return Array.from(seen)
}

/** Extract leading `[tag]` (optionally preceded by `@mentions`) from body. */
export function extractLeadingBoardTag(body: string): BoardMessageTag | undefined {
  const match = /^\s*(?:@[a-zA-Z0-9][a-zA-Z0-9_-]*\s+)*\[([a-z]+)\]/i.exec(body)
  const candidate = match?.[1]?.toLowerCase()
  return isBoardMessageTag(candidate) ? candidate : undefined
}

function parseBoardMessageLine(line: string): BoardMessage | null {
  try {
    const parsed = JSON.parse(line) as Partial<BoardMessage>
    if (
      typeof parsed.seq !== 'number' ||
      !Number.isInteger(parsed.seq) ||
      parsed.seq < 1 ||
      typeof parsed.body !== 'string'
    ) {
      return null
    }
    const mentions = Array.isArray(parsed.mentions)
      ? parsed.mentions
          .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
          .map((m) => normalizeAgentToken(m))
      : []
    const eph = parsed.ephemeral
    const ephemeral: EphemeralWorkerMetadata | undefined =
      eph &&
      typeof eph === 'object' &&
      typeof eph.role === 'string' &&
      typeof eph.baseAgent === 'string'
        ? {
            role: eph.role,
            baseAgent: eph.baseAgent,
            status:
              eph.status === 'completed' || eph.status === 'failed' || eph.status === 'cleaned'
                ? eph.status
                : 'running',
            ...(typeof eph.sessionID === 'string' && eph.sessionID
              ? { sessionID: eph.sessionID }
              : {}),
            ...(typeof eph.worktreeDir === 'string' && eph.worktreeDir
              ? { worktreeDir: eph.worktreeDir }
              : {}),
          }
        : undefined
    return {
      seq: parsed.seq,
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now(),
      channel:
        typeof parsed.channel === 'string' && parsed.channel.trim()
          ? parsed.channel.trim()
          : DEFAULT_CHANNEL,
      threadId:
        typeof parsed.threadId === 'string' && parsed.threadId.trim()
          ? parsed.threadId.trim()
          : DEFAULT_THREAD_ID,
      from: typeof parsed.from === 'string' && parsed.from.trim() ? parsed.from.trim() : 'unknown',
      mentions,
      body: parsed.body,
      ...(typeof parsed.goal === 'string' && parsed.goal.trim()
        ? { goal: parsed.goal.trim() }
        : {}),
      ...(typeof parsed.workstream === 'string' && parsed.workstream.trim()
        ? { workstream: parsed.workstream.trim() }
        : {}),
      ...(typeof parsed.stepKey === 'string' && parsed.stepKey.trim()
        ? { stepKey: parsed.stepKey.trim() }
        : {}),
      ...(typeof parsed.replyToSeq === 'number' &&
      Number.isInteger(parsed.replyToSeq) &&
      parsed.replyToSeq >= 1
        ? { replyToSeq: parsed.replyToSeq }
        : {}),
      ...(isBoardMessageTag(parsed.tag) ? { tag: parsed.tag } : {}),
      ...(ephemeral !== undefined ? { ephemeral } : {}),
    }
  } catch {
    return null
  }
}

function readAllMessagesSync(filePath: string): BoardMessage[] {
  if (!existsSync(filePath)) return []
  try {
    const raw = readFileSync(filePath, 'utf8')
    const out: BoardMessage[] = []
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = parseBoardMessageLine(trimmed)
      if (parsed) out.push(parsed)
    }
    return out
  } catch {
    return []
  }
}

async function readHeadSeqFromDisk(filePath: string): Promise<number> {
  if (!existsSync(filePath)) return 0
  try {
    const raw = await readFile(filePath, 'utf8')
    let maxSeq = 0
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = parseBoardMessageLine(trimmed)
      if (parsed && parsed.seq > maxSeq) maxSeq = parsed.seq
    }
    return maxSeq
  } catch {
    return 0
  }
}

function threadHeaderKey(channel: string, threadId: string): string {
  return `${channel}::${threadId}`
}

function readThreadsStoreSync(filePath: string): Record<string, BoardChannelHeader> {
  if (!existsSync(filePath)) return {}
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw as Record<string, BoardChannelHeader>
  } catch {
    return {}
  }
}

/** Register or update metadata header (`goal`, `workstream`) for a channel/thread. */
export async function upsertBoardChannel(
  workspaceDir: string,
  input: {
    readonly channel?: string
    readonly threadId: string
    readonly goal?: string
    readonly workstream?: string
  },
): Promise<BoardChannelHeader> {
  const channel =
    typeof input.channel === 'string' && input.channel.trim()
      ? input.channel.trim()
      : DEFAULT_CHANNEL
  const threadId = input.threadId.trim() || DEFAULT_THREAD_ID
  const threadsPath = resolveBoardThreadsPath(workspaceDir, true)

  return enqueueSerialized(threadsPath, async () => {
    await mkdir(dirname(threadsPath), { recursive: true })
    const store = readThreadsStoreSync(threadsPath)
    const key = threadHeaderKey(channel, threadId)
    const existing = store[key]
    const goal =
      typeof input.goal === 'string' && input.goal.trim() ? input.goal.trim() : existing?.goal
    const workstream =
      typeof input.workstream === 'string' && input.workstream.trim()
        ? input.workstream.trim()
        : existing?.workstream
    const header: BoardChannelHeader = {
      channel,
      threadId,
      updatedAt: Date.now(),
      ...(goal !== undefined ? { goal } : {}),
      ...(workstream !== undefined ? { workstream } : {}),
    }
    store[key] = header
    writeFileSync(threadsPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    return header
  })
}

export function listBoardChannels(workspaceDir: string): BoardChannelHeader[] {
  const threadsPath = resolveBoardThreadsPath(workspaceDir, false)
  return Object.values(readThreadsStoreSync(threadsPath))
}

/** Append a `#seq`-indexed message to `.pantheon/board/messages.ndjson` and emit `board:message`. */
export async function appendBoardMessage(
  workspaceDir: string,
  input: AppendBoardMessageInput,
): Promise<BoardMessage> {
  const body = input.body.trim()
  if (!body) {
    throw new Error('Board message body must be non-empty')
  }
  const filePath = resolveBoardMessagesPath(workspaceDir, true)
  const threadsPath = resolveBoardThreadsPath(workspaceDir, false)
  const channel =
    typeof input.channel === 'string' && input.channel.trim()
      ? input.channel.trim()
      : DEFAULT_CHANNEL
  const threadId =
    typeof input.threadId === 'string' && input.threadId.trim()
      ? input.threadId.trim()
      : DEFAULT_THREAD_ID

  const message = await enqueueSerialized(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true })
    const seqCache = getSeqCache()
    const diskHead = await readHeadSeqFromDisk(filePath)
    const cachedHead = seqCache.get(filePath) ?? 0
    const nextSeq = Math.max(diskHead, cachedHead) + 1
    seqCache.set(filePath, nextSeq)

    const threadHeader = readThreadsStoreSync(threadsPath)[threadHeaderKey(channel, threadId)]
    const goal =
      typeof input.goal === 'string' && input.goal.trim() ? input.goal.trim() : threadHeader?.goal
    const workstream =
      typeof input.workstream === 'string' && input.workstream.trim()
        ? input.workstream.trim()
        : threadHeader?.workstream
    const stepKey =
      typeof input.stepKey === 'string' && input.stepKey.trim() ? input.stepKey.trim() : undefined

    const from = normalizeAgentToken(input.from) || 'unknown'
    const explicitMentions = Array.isArray(input.to)
      ? input.to
          .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
          .map((item) => normalizeAgentToken(item))
      : []
    const mentions = Array.from(
      new Set(explicitMentions.length > 0 ? explicitMentions : extractBoardMentions(body)),
    )
    const tag = isBoardMessageTag(input.tag) ? input.tag : extractLeadingBoardTag(body)
    const timestamp = typeof input.timestamp === 'number' ? input.timestamp : Date.now()

    const entry: BoardMessage = {
      seq: nextSeq,
      timestamp,
      channel,
      threadId,
      from,
      mentions,
      body,
      ...(goal !== undefined ? { goal } : {}),
      ...(workstream !== undefined ? { workstream } : {}),
      ...(stepKey !== undefined ? { stepKey } : {}),
      ...(typeof input.replyToSeq === 'number' &&
      Number.isInteger(input.replyToSeq) &&
      input.replyToSeq >= 1
        ? { replyToSeq: input.replyToSeq }
        : {}),
      ...(tag !== undefined ? { tag } : {}),
      ...(input.ephemeral !== undefined ? { ephemeral: input.ephemeral } : {}),
    }

    await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    return entry
  })

  const firstLine = message.body.split(/\r?\n/)[0] ?? message.body
  const summary = firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine
  getSharedBus().emit('board:message', {
    seq: message.seq,
    channel: message.channel,
    threadId: message.threadId,
    from: message.from,
    mentions: message.mentions,
    ...(message.replyToSeq !== undefined ? { replyToSeq: message.replyToSeq } : {}),
    ...(message.tag !== undefined ? { tag: message.tag } : {}),
    ...(message.stepKey !== undefined ? { stepKey: message.stepKey } : {}),
    summary,
    timestamp: message.timestamp,
  })

  return message
}

/** Read `#seq` messages with optional filters (`since`, `seqs`, `channel`, `threadId`, `stepKey`, `mention`, `limit`). */
export function readBoardMessages(
  workspaceDir: string,
  filter: ReadBoardMessagesFilter = {},
): BoardMessagesReadResult {
  const filePath = resolveBoardMessagesPath(workspaceDir, false)
  const all = readAllMessagesSync(filePath)
  const head = all.reduce((max, m) => (m.seq > max ? m.seq : max), 0)

  const seqSet =
    Array.isArray(filter.seqs) && filter.seqs.length > 0
      ? new Set(filter.seqs.filter((n) => Number.isInteger(n) && n >= 1))
      : null
  const mentionTarget =
    typeof filter.mention === 'string' && filter.mention.trim()
      ? normalizeAgentToken(filter.mention)
      : undefined
  const channelFilter =
    typeof filter.channel === 'string' && filter.channel.trim() ? filter.channel.trim() : undefined
  const threadFilter =
    typeof filter.threadId === 'string' && filter.threadId.trim()
      ? filter.threadId.trim()
      : undefined
  const stepKeyFilter =
    typeof filter.stepKey === 'string' && filter.stepKey.trim() ? filter.stepKey.trim() : undefined

  const filtered = all.filter((msg) => {
    if (seqSet !== null && !seqSet.has(msg.seq)) return false
    if (seqSet === null && typeof filter.since === 'number' && msg.seq <= filter.since) return false
    if (channelFilter !== undefined && msg.channel !== channelFilter) return false
    if (threadFilter !== undefined && msg.threadId !== threadFilter) return false
    if (stepKeyFilter !== undefined && msg.stepKey !== stepKeyFilter) return false
    if (
      mentionTarget !== undefined &&
      !msg.mentions.includes(mentionTarget) &&
      !msg.mentions.includes('all')
    ) {
      return false
    }
    return true
  })

  const rawLimit = typeof filter.limit === 'number' ? filter.limit : DEFAULT_READ_LIMIT
  const limit = Math.max(1, Math.min(MAX_READ_LIMIT, Math.trunc(rawLimit)))
  const messages =
    seqSet !== null || typeof filter.since === 'number'
      ? filtered.slice(0, limit)
      : filtered.slice(-limit)

  return { head, messages }
}

/** Combine persisted board threads/messages with active `BackgroundJobBoard` status. */
export function getBoardStatus(
  workspaceDir: string,
  board: BackgroundJobBoard = getSharedBoard(),
): BoardStatusSummary {
  const filePath = resolveBoardMessagesPath(workspaceDir, false)
  const all = readAllMessagesSync(filePath)
  const head = all.reduce((max, m) => (m.seq > max ? m.seq : max), 0)
  const channelHeaders = listBoardChannels(workspaceDir)

  const threadMap = new Map<
    string,
    {
      channel: string
      threadId: string
      goal?: string
      workstream?: string
      headSeq: number
      messageCount: number
      lastTag?: BoardMessageTag
      updatedAt: number
    }
  >()

  for (const hdr of channelHeaders) {
    threadMap.set(threadHeaderKey(hdr.channel, hdr.threadId), {
      channel: hdr.channel,
      threadId: hdr.threadId,
      headSeq: 0,
      messageCount: 0,
      updatedAt: hdr.updatedAt,
      ...(hdr.goal !== undefined ? { goal: hdr.goal } : {}),
      ...(hdr.workstream !== undefined ? { workstream: hdr.workstream } : {}),
    })
  }

  for (const msg of all) {
    const key = threadHeaderKey(msg.channel, msg.threadId)
    const cur = threadMap.get(key)
    if (!cur) {
      threadMap.set(key, {
        channel: msg.channel,
        threadId: msg.threadId,
        headSeq: msg.seq,
        messageCount: 1,
        updatedAt: msg.timestamp,
        ...(msg.goal !== undefined ? { goal: msg.goal } : {}),
        ...(msg.workstream !== undefined ? { workstream: msg.workstream } : {}),
        ...(msg.tag !== undefined ? { lastTag: msg.tag } : {}),
      })
    } else {
      cur.headSeq = Math.max(cur.headSeq, msg.seq)
      cur.messageCount += 1
      cur.updatedAt = Math.max(cur.updatedAt, msg.timestamp)
      if (msg.goal !== undefined) cur.goal = msg.goal
      if (msg.workstream !== undefined) cur.workstream = msg.workstream
      if (msg.tag !== undefined) cur.lastTag = msg.tag
    }
  }

  const threads = Array.from(threadMap.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  const channels = Array.from(new Set(threads.map((t) => t.channel))).sort()
  const activeJobs = board.list().map((job) => ({
    taskID: job.taskID,
    alias: job.alias,
    agent: job.agent,
    state: job.state,
    updatedAt: job.updatedAt,
    terminalUnreconciled: job.terminalUnreconciled,
  }))
  const recentAlerts = all
    .filter((m) => m.tag === 'alert' || m.tag === 'blocker' || m.tag === 'deadlock')
    .slice(-10)

  return { head, channels, threads, activeJobs, recentAlerts }
}

function jsonResult(payload: unknown): PantheonToolResult {
  return { output: JSON.stringify(payload) }
}

/** Expose `pantheon_board` tool (`post | read | status | channel`) for V2 agents. */
export function createBoardTool(fallbackDir?: string): PantheonToolDef {
  return {
    name: 'pantheon_board',
    description:
      'Persistent #seq-indexed Swarm & Council Board (actions: post | read | status | channel). ' +
      'Supports @mentions, replyToSeq citations, semantic tags ([claim], [handoff], [question], ' +
      '[rebuttal], [consensus], [deadlock], [done], [blocker], [alert], [note]), and thread metadata.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['post', 'read', 'status', 'channel'],
          description: 'Board operation to execute',
        },
        body: { type: 'string', description: 'Message content for action=post' },
        channel: {
          type: 'string',
          description: 'Logical board channel (e.g. swarm, council). Default: swarm',
        },
        threadId: { type: 'string', description: 'Thread identifier within the channel' },
        goal: { type: 'string', description: 'Goal title for thread grouping' },
        workstream: { type: 'string', description: 'Workstream label for thread grouping' },
        stepKey: { type: 'string', description: 'Associated Step-Ledger stepKey' },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target agent @mentions (auto-extracted from body if omitted)',
        },
        replyToSeq: {
          type: 'integer',
          minimum: 1,
          description: 'Referenced #seq number for rebuttal or handoff replies',
        },
        tag: {
          type: 'string',
          enum: [
            'claim',
            'handoff',
            'question',
            'rebuttal',
            'consensus',
            'deadlock',
            'done',
            'blocker',
            'alert',
            'note',
          ],
          description: 'Semantic message tag (auto-extracted from leading [tag] if omitted)',
        },
        from: {
          type: 'string',
          description: 'Sender agent name (defaults to caller agent from tool context or unknown)',
        },
        since: {
          type: 'integer',
          minimum: 0,
          description: 'Return messages with seq > since (for action=read)',
        },
        seqs: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          description: 'Specific #seq IDs to fetch (for action=read)',
        },
        mention: {
          type: 'string',
          description: 'Filter messages mentioning this agent (for action=read)',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum messages to return (1..100, default 20)',
        },
      },
    },
    output: {},
    execute: async (input, context) => {
      try {
        const action = typeof input.action === 'string' ? input.action : 'read'
        const cwd = resolveToolCwd(context, fallbackDir)
        const ctxAgent =
          typeof (context as { agent?: unknown } | null | undefined)?.agent === 'string'
            ? (context as { agent: string }).agent.trim() || 'unknown'
            : 'unknown'

        if (action === 'post') {
          const body = typeof input.body === 'string' ? input.body.trim() : ''
          if (!body) return jsonResult({ ok: false, error: 'body is required for action=post' })
          const from =
            typeof input.from === 'string' && input.from.trim() ? input.from.trim() : ctxAgent
          const to = Array.isArray(input.to)
            ? input.to.filter((x): x is string => typeof x === 'string')
            : undefined
          const message = await appendBoardMessage(cwd, {
            from,
            body,
            ...(typeof input.channel === 'string' ? { channel: input.channel } : {}),
            ...(typeof input.threadId === 'string' ? { threadId: input.threadId } : {}),
            ...(typeof input.goal === 'string' ? { goal: input.goal } : {}),
            ...(typeof input.workstream === 'string' ? { workstream: input.workstream } : {}),
            ...(typeof input.stepKey === 'string' ? { stepKey: input.stepKey } : {}),
            ...(to !== undefined ? { to } : {}),
            ...(typeof input.replyToSeq === 'number' && Number.isInteger(input.replyToSeq)
              ? { replyToSeq: input.replyToSeq }
              : {}),
            ...(isBoardMessageTag(input.tag) ? { tag: input.tag } : {}),
          })
          return jsonResult({ ok: true, message })
        }

        if (action === 'read') {
          const seqs = Array.isArray(input.seqs)
            ? input.seqs.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
            : undefined
          const result = readBoardMessages(cwd, {
            ...(typeof input.since === 'number' && Number.isInteger(input.since)
              ? { since: input.since }
              : {}),
            ...(seqs !== undefined ? { seqs } : {}),
            ...(typeof input.channel === 'string' ? { channel: input.channel } : {}),
            ...(typeof input.threadId === 'string' ? { threadId: input.threadId } : {}),
            ...(typeof input.stepKey === 'string' ? { stepKey: input.stepKey } : {}),
            ...(typeof input.mention === 'string' ? { mention: input.mention } : {}),
            ...(typeof input.limit === 'number' && Number.isInteger(input.limit)
              ? { limit: input.limit }
              : {}),
          })
          return jsonResult({ ok: true, ...result })
        }

        if (action === 'status') {
          const summary = getBoardStatus(cwd)
          return jsonResult({ ok: true, ...summary })
        }

        if (action === 'channel') {
          if (typeof input.threadId === 'string' && input.threadId.trim()) {
            const header = await upsertBoardChannel(cwd, {
              ...(typeof input.channel === 'string' ? { channel: input.channel } : {}),
              threadId: input.threadId.trim(),
              ...(typeof input.goal === 'string' ? { goal: input.goal } : {}),
              ...(typeof input.workstream === 'string' ? { workstream: input.workstream } : {}),
            })
            return jsonResult({ ok: true, header, channels: listBoardChannels(cwd) })
          }
          return jsonResult({ ok: true, channels: listBoardChannels(cwd) })
        }

        return jsonResult({ ok: false, error: `Unsupported action: ${action}` })
      } catch (err: unknown) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
