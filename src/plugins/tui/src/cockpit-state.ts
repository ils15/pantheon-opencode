/**
 * cockpit-state.ts — Pure selectors, Gantt renderers, Work Map topology, and
 * Gate Matrix aggregation for the TUI Mission Control Cockpit (`Overview`,
 * `Swarm`, `Flightdeck`).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { scanPantheonArtifacts } from './artifacts-state.ts'

export type CockpitTabId = 'overview' | 'swarm' | 'flightdeck'

export type BoardMessageTag =
  | 'claim'
  | 'handoff'
  | 'question'
  | 'rebuttal'
  | 'consensus'
  | 'deadlock'
  | 'done'
  | 'blocker'
  | 'alert'
  | 'note'

export type AttentionCategory = 'decision' | 'failure' | 'review' | 'stuck' | 'quota'

export interface CockpitEphemeralMeta {
  readonly role: string
  readonly baseAgent: string
  readonly sessionID?: string
  readonly worktreeDir?: string
  readonly status: 'running' | 'completed' | 'failed' | 'cleaned'
}

export interface CockpitBoardMessage {
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
  readonly ephemeral?: CockpitEphemeralMeta
}

export interface CockpitAttentionItem {
  readonly rank: 1 | 2 | 3 | 4 | 5
  readonly category: AttentionCategory
  readonly title: string
  readonly detail: string
  readonly agent: string
  readonly timestamp: number
  readonly seq?: number
  readonly stepKey?: string
  readonly threadId?: string
}

export interface CockpitWorkstreamEntry {
  readonly workstream: string
  readonly stepKey?: string
  readonly latestSeq: number
  readonly statusTag: BoardMessageTag | 'active'
  readonly ephemeral?: CockpitEphemeralMeta
  readonly messages: readonly CockpitBoardMessage[]
}

export interface CockpitThreadEntry {
  readonly threadId: string
  readonly channel: string
  readonly goal: string
  readonly latestSeq: number
  readonly statusTag: BoardMessageTag | 'active'
  readonly workstreams: readonly CockpitWorkstreamEntry[]
  readonly messages: readonly CockpitBoardMessage[]
}

export interface CockpitThreadGroup {
  readonly goal: string
  readonly latestSeq: number
  readonly statusTag: BoardMessageTag | 'active'
  readonly threads: readonly CockpitThreadEntry[]
}

export interface BoardInteractionEdge {
  readonly from: string
  readonly target: string
  readonly seq: number
  readonly tag?: BoardMessageTag
  readonly replyToSeq?: number
  readonly timestamp: number
  readonly channel?: string
  readonly threadId?: string
  readonly bodyPreview?: string
}

export interface BoardInteractionGraph {
  readonly edges: readonly BoardInteractionEdge[]
  readonly nodes: readonly string[]
  readonly maxSeq: number
  readonly edgeCountByPair: Readonly<Record<string, number>>
}

export interface CockpitChildEntry {
  readonly id: string
  readonly agent: string
  readonly kind: string
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown'
  readonly cost: number
  readonly startedAt: number
  readonly updatedAt: number
  readonly tokens: number
  readonly model?: string
}

export interface CockpitLogEntry {
  readonly kind: string
  readonly timestamp: number
  readonly agent: string
  readonly detail: string
  readonly severity: 'info' | 'ok' | 'warn' | 'error'
  readonly seq?: number
  readonly threadId?: string
  readonly stepKey?: string
  readonly attentionCategory?: AttentionCategory
}

export interface CockpitStepEntry {
  readonly stepKey: string
  readonly objective: string
  readonly agent: string
  readonly state: string
  readonly taskType?: string
  readonly mutatedCount: number
  readonly receiptId?: string
  readonly hasBaselineTree: boolean
  readonly dependsOn?: readonly string[]
  readonly blockedBy?: readonly string[]
  readonly updatedAt: string
}

export interface CockpitInput {
  readonly workspaceDir: string
  readonly sessionTitle?: string
  readonly modelName?: string
  readonly contextTokens?: number
  readonly contextWindow?: number
  readonly sessionCost?: number
  readonly cacheRate?: number
  readonly children: readonly CockpitChildEntry[]
  readonly events?: readonly CockpitLogEntry[]
  readonly boardMessages?: readonly CockpitBoardMessage[]
  readonly isPt?: boolean
}

export interface CockpitSnapshot {
  readonly sessionTitle: string
  readonly modelName: string
  readonly overview: {
    readonly contextTokens: number
    readonly contextWindow: number
    readonly contextPercent: number
    readonly contextGauge: string
    readonly sessionCost: number
    readonly cacheRate: number
    readonly subagentCount: number
    readonly runningCount: number
    readonly velocityBars: string
    readonly workMap: readonly string[]
    readonly surfaces: ReadonlyArray<{ readonly label: string; readonly status: string }>
  }
  readonly swarm: {
    readonly activeCount: number
    readonly completedCount: number
    readonly failedCount: number
    readonly totalCost: number
    readonly rows: ReadonlyArray<
      CockpitChildEntry & {
        readonly durationSec: number
        readonly ganttBar: string
      }
    >
  }
  readonly threads: {
    readonly totalMessages: number
    readonly headSeq: number
    readonly groups: readonly CockpitThreadGroup[]
  }
  readonly interactions: BoardInteractionGraph
  readonly attention: readonly CockpitAttentionItem[]
  readonly flightdeck: {
    readonly allowed: number
    readonly approved: number
    readonly waiting: number
    readonly blocked: number
    readonly gateGlyphs: string
    readonly gateSummary: string
    readonly steps: readonly CockpitStepEntry[]
    /** `step-ledger.json` exists but cannot be read/parsed (state unknown, not empty). */
    readonly stepsCorrupt: boolean
    readonly logs: readonly CockpitLogEntry[]
  }
}

export function formatGanttBar(
  startMs: number,
  endMs: number,
  minMs: number,
  maxMs: number,
  width = 24,
): string {
  const span = Math.max(1, maxMs - minMs)
  const s = Math.max(0, Math.min(width - 1, Math.floor(((startMs - minMs) / span) * width)))
  const e = Math.max(s + 1, Math.min(width, Math.ceil(((endMs - minMs) / span) * width)))
  const cells: string[] = []
  for (let i = 0; i < width; i += 1) {
    cells.push(i >= s && i < e ? '█' : '░')
  }
  return cells.join('')
}

export function formatGateMatrixGlyphs(
  allowed: number,
  approved: number,
  waiting: number,
  blocked: number,
): string {
  const cap = (n: number, ch: string) => ch.repeat(Math.min(12, Math.max(0, n)))
  const parts = [
    cap(allowed, '■'),
    cap(approved, '▣'),
    cap(waiting, '□'),
    cap(blocked, '✗'),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : '■'
}

export function renderWorkMapLines(counts: {
  readonly subagents: number
  readonly artifacts: number
  readonly stepsDone: number
  readonly stepsTotal: number
}): string[] {
  const subs = String(counts.subagents).padStart(2, ' ')
  const arts = String(counts.artifacts).padStart(2, ' ')
  const stps = `${counts.stepsDone}/${counts.stepsTotal}`
  return [
    `  [You] ────── [Zeus] ────── [Swarm (${subs})]`,
    `                 │                 │`,
    `  [Artifacts ${arts}] ─┼─ [Step Ledger ${stps}] ─ [Review & Gates]`,
    `                 │`,
    `  [FTS5 Memory] ─┴─ [AST + LSP Diagnostics]`,
  ]
}

function loadStepDependencyField(
  step: Record<string, unknown>,
  field: 'dependsOn' | 'blockedBy',
): { dependsOn?: string[] } | { blockedBy?: string[] } {
  const raw = step[field]
  if (!Array.isArray(raw)) return {}
  const keys = raw.filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (keys.length === 0) return {}
  return field === 'dependsOn' ? { dependsOn: keys } : { blockedBy: keys }
}

interface StepLedgerLoad {
  readonly entries: CockpitStepEntry[]
  /** True when the ledger file exists but its content cannot be read/parsed. */
  readonly corrupt: boolean
}

function loadStepEntries(workspaceDir: string): StepLedgerLoad {
  const ledgerPath = join(workspaceDir, '.pantheon', 'ledger', 'step-ledger.json')
  if (!existsSync(ledgerPath)) return { entries: [], corrupt: false }
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      steps?: Record<string, Record<string, unknown>>
    }
    const list = Object.values(parsed.steps ?? {})
    const entries = list
      .map((s) => ({
        stepKey: String(s.stepKey ?? ''),
        objective: String(s.objective ?? ''),
        agent: String(s.agent ?? 'specialist'),
        state: String(s.state ?? 'pending'),
        ...(typeof s.taskType === 'string' ? { taskType: s.taskType } : {}),
        mutatedCount: Array.isArray(s.mutatedFiles) ? s.mutatedFiles.length : 0,
        ...(typeof s.receiptId === 'string' ? { receiptId: s.receiptId } : {}),
        hasBaselineTree: typeof s.baselineTree === 'string' && s.baselineTree.length === 40,
        ...loadStepDependencyField(s, 'dependsOn'),
        ...loadStepDependencyField(s, 'blockedBy'),
        updatedAt: String(s.updatedAt ?? ''),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { entries, corrupt: false }
  } catch {
    // An unreadable ledger is NOT an empty ledger: surface it instead of
    // rendering "no steps", which hides a corrupt/partial write.
    return { entries: [], corrupt: true }
  }
}

function resolveSharedTelemetryRoot(workspaceDir: string): string {
  try {
    let cur = resolve(workspaceDir)
    for (let i = 0; i < 10; i += 1) {
      const gitEntry = join(cur, '.git')
      if (existsSync(gitEntry)) {
        const statText = readFileSync(gitEntry, 'utf8')
        const gitDirMatch = /^gitdir:\s*(.+)$/m.exec(statText)
        if (gitDirMatch?.[1]) {
          const gitDir = resolve(cur, gitDirMatch[1].trim())
          const commonPath = join(gitDir, 'commondir')
          if (existsSync(commonPath)) {
            const commonDir = resolve(gitDir, readFileSync(commonPath, 'utf8').trim())
            if (commonDir.endsWith(`${sep}.git`)) return dirname(commonDir)
          }
        }
        return cur
      }
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  } catch {
    /* ignore */
  }
  return workspaceDir
}

const VALID_BOARD_TAGS: ReadonlySet<BoardMessageTag> = new Set([
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

const VALID_ATTENTION_CATEGORIES: ReadonlySet<AttentionCategory> = new Set([
  'decision',
  'failure',
  'review',
  'stuck',
  'quota',
])

const ATTENTION_RANK: Record<AttentionCategory, 1 | 2 | 3 | 4 | 5> = {
  decision: 1,
  failure: 2,
  review: 3,
  stuck: 4,
  quota: 5,
}

function isQuotaText(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('429')
  )
}

function parseEphemeralMeta(raw: unknown): CockpitEphemeralMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.role !== 'string' || typeof obj.baseAgent !== 'string') return undefined
  const status =
    obj.status === 'running' ||
    obj.status === 'completed' ||
    obj.status === 'failed' ||
    obj.status === 'cleaned'
      ? obj.status
      : 'running'
  return {
    role: obj.role,
    baseAgent: obj.baseAgent,
    status,
    ...(typeof obj.sessionID === 'string' && obj.sessionID ? { sessionID: obj.sessionID } : {}),
    ...(typeof obj.worktreeDir === 'string' && obj.worktreeDir
      ? { worktreeDir: obj.worktreeDir }
      : {}),
  }
}

function loadPersistedBoardMessages(workspaceDir: string): CockpitBoardMessage[] {
  try {
    const root = resolveSharedTelemetryRoot(workspaceDir)
    const filePath = join(root, '.pantheon', 'board', 'messages.ndjson')
    if (!existsSync(filePath)) return []
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
    const out: CockpitBoardMessage[] = []
    for (const line of lines.slice(-200)) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (
          typeof parsed.seq !== 'number' ||
          !Number.isFinite(parsed.seq) ||
          typeof parsed.from !== 'string' ||
          typeof parsed.body !== 'string'
        ) {
          continue
        }
        const tag =
          typeof parsed.tag === 'string' && VALID_BOARD_TAGS.has(parsed.tag as BoardMessageTag)
            ? (parsed.tag as BoardMessageTag)
            : undefined
        const ephemeral = parseEphemeralMeta(parsed.ephemeral)
        out.push({
          seq: parsed.seq,
          timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
          channel:
            typeof parsed.channel === 'string' && parsed.channel.trim()
              ? parsed.channel.trim()
              : 'swarm',
          threadId:
            typeof parsed.threadId === 'string' && parsed.threadId.trim()
              ? parsed.threadId.trim()
              : 'general',
          from: parsed.from,
          mentions: Array.isArray(parsed.mentions)
            ? parsed.mentions.filter((m): m is string => typeof m === 'string')
            : [],
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
          ...(typeof parsed.replyToSeq === 'number' && Number.isFinite(parsed.replyToSeq)
            ? { replyToSeq: parsed.replyToSeq }
            : {}),
          ...(tag !== undefined ? { tag } : {}),
          ...(ephemeral !== undefined ? { ephemeral } : {}),
        })
      } catch {
        /* ignore malformed board message line */
      }
    }
    return out
  } catch {
    return []
  }
}

function loadPersistedCockpitEvents(workspaceDir: string): CockpitLogEntry[] {
  try {
    const root = resolveSharedTelemetryRoot(workspaceDir)
    const filePath = join(root, '.pantheon', 'telemetry', 'cockpit-events.ndjson')
    if (!existsSync(filePath)) return []
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
    const out: CockpitLogEntry[] = []
    for (const line of lines.slice(-80)) {
      try {
        const parsed = JSON.parse(line) as Partial<CockpitLogEntry>
        if (typeof parsed.kind === 'string' && typeof parsed.detail === 'string') {
          const attentionCategory =
            typeof parsed.attentionCategory === 'string' &&
            VALID_ATTENTION_CATEGORIES.has(parsed.attentionCategory)
              ? parsed.attentionCategory
              : undefined
          out.push({
            kind: parsed.kind,
            timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now(),
            agent: typeof parsed.agent === 'string' ? parsed.agent : 'pantheon',
            detail: parsed.detail,
            severity:
              parsed.severity === 'ok' || parsed.severity === 'warn' || parsed.severity === 'error'
                ? parsed.severity
                : 'info',
            ...(typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)
              ? { seq: parsed.seq }
              : {}),
            ...(typeof parsed.threadId === 'string' && parsed.threadId
              ? { threadId: parsed.threadId }
              : {}),
            ...(typeof parsed.stepKey === 'string' && parsed.stepKey
              ? { stepKey: parsed.stepKey }
              : {}),
            ...(attentionCategory !== undefined ? { attentionCategory } : {}),
          })
        }
      } catch {
        /* ignore malformed event line */
      }
    }
    return out
  } catch {
    return []
  }
}

function buildOutcomeThreads(
  messages: readonly CockpitBoardMessage[],
  isPt: boolean,
): {
  readonly totalMessages: number
  readonly headSeq: number
  readonly groups: readonly CockpitThreadGroup[]
} {
  if (messages.length === 0) {
    return { totalMessages: 0, headSeq: 0, groups: [] }
  }

  const ordered = [...messages].sort((a, b) => a.seq - b.seq)
  const headSeq = ordered[ordered.length - 1]?.seq ?? 0

  const threadGoalMap = new Map<string, string>()
  const seqWorkstreamMap = new Map<number, string>()
  const defaultGoal = isPt ? 'Geral' : 'General'

  for (const m of ordered) {
    if (m.goal?.trim()) {
      threadGoalMap.set(m.threadId, m.goal.trim())
    }
    const inheritedWs = m.replyToSeq !== undefined ? seqWorkstreamMap.get(m.replyToSeq) : undefined
    const ws = m.workstream?.trim() || inheritedWs || m.stepKey?.trim() || 'default'
    seqWorkstreamMap.set(m.seq, ws)
  }

  const goalBuckets = new Map<
    string,
    Map<
      string,
      {
        channel: string
        goal: string
        messages: CockpitBoardMessage[]
        workstreams: Map<string, CockpitBoardMessage[]>
      }
    >
  >()

  for (const m of ordered) {
    const fallbackGoal = m.channel === 'council' ? (isPt ? 'Conselho' : 'Council') : defaultGoal
    const goal = threadGoalMap.get(m.threadId) ?? fallbackGoal
    const wsName = seqWorkstreamMap.get(m.seq) ?? 'default'

    let threadsMap = goalBuckets.get(goal)
    if (!threadsMap) {
      threadsMap = new Map()
      goalBuckets.set(goal, threadsMap)
    }

    let threadBucket = threadsMap.get(m.threadId)
    if (!threadBucket) {
      threadBucket = {
        channel: m.channel,
        goal,
        messages: [],
        workstreams: new Map(),
      }
      threadsMap.set(m.threadId, threadBucket)
    }
    threadBucket.messages.push(m)

    let wsList = threadBucket.workstreams.get(wsName)
    if (!wsList) {
      wsList = []
      threadBucket.workstreams.set(wsName, wsList)
    }
    wsList.push(m)
  }

  const groups: CockpitThreadGroup[] = []
  for (const [goal, threadsMap] of goalBuckets.entries()) {
    const threads: CockpitThreadEntry[] = []
    for (const [threadId, tBucket] of threadsMap.entries()) {
      const workstreams: CockpitWorkstreamEntry[] = []
      for (const [wsName, wsMsgs] of tBucket.workstreams.entries()) {
        const latestWsMsg = wsMsgs[wsMsgs.length - 1]
        let latestStepKey: string | undefined
        let latestEphemeral: CockpitEphemeralMeta | undefined
        for (const wm of wsMsgs) {
          if (wm.stepKey) latestStepKey = wm.stepKey
          if (wm.ephemeral) latestEphemeral = wm.ephemeral
        }
        workstreams.push({
          workstream: wsName,
          latestSeq: latestWsMsg?.seq ?? 0,
          statusTag: latestWsMsg?.tag ?? 'active',
          messages: wsMsgs,
          ...(latestStepKey !== undefined ? { stepKey: latestStepKey } : {}),
          ...(latestEphemeral !== undefined ? { ephemeral: latestEphemeral } : {}),
        })
      }
      workstreams.sort((a, b) => b.latestSeq - a.latestSeq)
      const latestThreadMsg = tBucket.messages[tBucket.messages.length - 1]
      threads.push({
        threadId,
        channel: tBucket.channel,
        goal: tBucket.goal,
        latestSeq: latestThreadMsg?.seq ?? 0,
        statusTag: latestThreadMsg?.tag ?? 'active',
        workstreams,
        messages: tBucket.messages,
      })
    }
    threads.sort((a, b) => b.latestSeq - a.latestSeq)
    const topThread = threads[0]
    groups.push({
      goal,
      latestSeq: topThread?.latestSeq ?? 0,
      statusTag: topThread?.statusTag ?? 'active',
      threads,
    })
  }

  groups.sort((a, b) => b.latestSeq - a.latestSeq)
  return {
    totalMessages: ordered.length,
    headSeq,
    groups,
  }
}

function isBoardMessageResolved(
  msg: CockpitBoardMessage,
  ordered: readonly CockpitBoardMessage[],
): boolean {
  const isResolutionTag = (tag?: BoardMessageTag) => tag === 'consensus' || tag === 'done'
  return ordered.some((other) => {
    if (other.seq <= msg.seq) return false
    if (other.replyToSeq === msg.seq && isResolutionTag(other.tag)) return true
    if (
      (msg.tag === 'deadlock' || msg.tag === 'question') &&
      other.threadId === msg.threadId &&
      other.tag === 'consensus'
    ) {
      return true
    }
    if (
      msg.tag === 'blocker' &&
      other.threadId === msg.threadId &&
      (other.tag === 'done' || other.tag === 'consensus') &&
      (!msg.stepKey || other.stepKey === msg.stepKey)
    ) {
      return true
    }
    return false
  })
}

function inferEventAttentionCategory(ev: CockpitLogEntry): AttentionCategory | undefined {
  if (ev.attentionCategory && VALID_ATTENTION_CATEGORIES.has(ev.attentionCategory)) {
    return ev.attentionCategory
  }
  if (ev.kind === 'review:verdict') {
    return ev.severity === 'ok' ? undefined : 'review'
  }
  if (ev.kind === 'swarm:stall:detected') {
    return isQuotaText(ev.detail) ? 'quota' : 'stuck'
  }
  if (ev.kind === 'themis:reflex:escalated') {
    return 'failure'
  }
  if (ev.kind === 'step:rollback') {
    return ev.severity === 'warn' || ev.severity === 'error' ? 'failure' : undefined
  }
  if (ev.kind === 'reproduction:gate') {
    return ev.severity === 'warn' || ev.severity === 'error' ? 'review' : undefined
  }
  if (ev.kind === 'ephemeral:worker') {
    return ev.severity === 'error' ? 'failure' : undefined
  }
  if (isQuotaText(`${ev.kind} ${ev.detail}`) && ev.severity !== 'ok') {
    return 'quota'
  }
  if (ev.kind === 'board:message') {
    const trimmed = ev.detail.trim().toLowerCase()
    if (trimmed.startsWith('[deadlock]') || trimmed.startsWith('[question]')) return 'decision'
    if (trimmed.startsWith('[blocker]')) return 'failure'
    if (trimmed.startsWith('[alert]')) return 'stuck'
    return ev.severity === 'error' ? 'failure' : undefined
  }
  if (ev.severity === 'error') {
    return 'failure'
  }
  return undefined
}

function buildRankedAttentionQueue(params: {
  readonly messages: readonly CockpitBoardMessage[]
  readonly events: readonly CockpitLogEntry[]
  readonly steps: readonly CockpitStepEntry[]
  readonly children: readonly CockpitChildEntry[]
  readonly isPt: boolean
}): readonly CockpitAttentionItem[] {
  const { messages, events, steps, children, isPt } = params
  const items: CockpitAttentionItem[] = []
  const seenKeys = new Set<string>()

  const pushItem = (
    category: AttentionCategory,
    title: string,
    detail: string,
    agent: string,
    timestamp: number,
    refs: { seq?: number; stepKey?: string; threadId?: string },
  ) => {
    const dedupKey =
      refs.seq !== undefined
        ? `seq:${refs.seq}:${category}`
        : refs.stepKey !== undefined
          ? `step:${refs.stepKey}:${category}:${detail}`
          : `ev:${category}:${agent}:${timestamp}:${detail}`
    if (seenKeys.has(dedupKey)) return
    seenKeys.add(dedupKey)
    items.push({
      rank: ATTENTION_RANK[category],
      category,
      title,
      detail,
      agent,
      timestamp,
      ...(refs.seq !== undefined ? { seq: refs.seq } : {}),
      ...(refs.stepKey !== undefined ? { stepKey: refs.stepKey } : {}),
      ...(refs.threadId !== undefined ? { threadId: refs.threadId } : {}),
    })
  }

  const resolvedSeqs = new Set<number>()
  const orderedMsgs = [...messages].sort((a, b) => a.seq - b.seq)
  for (const m of orderedMsgs) {
    if (isBoardMessageResolved(m, orderedMsgs)) {
      resolvedSeqs.add(m.seq)
      continue
    }
    if (m.tag === 'deadlock') {
      pushItem(
        'decision',
        isPt ? 'Impasse no conselho' : 'Council deadlock',
        m.body,
        m.from,
        m.timestamp,
        {
          seq: m.seq,
          threadId: m.threadId,
          ...(m.stepKey !== undefined ? { stepKey: m.stepKey } : {}),
        },
      )
    } else if (m.tag === 'question') {
      pushItem(
        'decision',
        isPt ? 'Decisão pendente' : 'Decision needed',
        m.body,
        m.from,
        m.timestamp,
        {
          seq: m.seq,
          threadId: m.threadId,
          ...(m.stepKey !== undefined ? { stepKey: m.stepKey } : {}),
        },
      )
    } else if (m.tag === 'blocker') {
      pushItem(
        'failure',
        isPt ? 'Bloqueio reportado' : 'Blocker reported',
        m.body,
        m.from,
        m.timestamp,
        {
          seq: m.seq,
          threadId: m.threadId,
          ...(m.stepKey !== undefined ? { stepKey: m.stepKey } : {}),
        },
      )
    } else if (m.tag === 'alert') {
      const cat: AttentionCategory = isQuotaText(m.body) ? 'quota' : 'stuck'
      pushItem(
        cat,
        cat === 'quota'
          ? isPt
            ? 'Alerta de cota'
            : 'Quota warning'
          : isPt
            ? 'Alerta do watchdog'
            : 'Watchdog alert',
        m.body,
        m.from,
        m.timestamp,
        {
          seq: m.seq,
          threadId: m.threadId,
          ...(m.stepKey !== undefined ? { stepKey: m.stepKey } : {}),
        },
      )
    } else if (m.ephemeral?.status === 'failed') {
      pushItem(
        'failure',
        isPt ? 'Worker efêmero falhou' : 'Ephemeral worker failed',
        `${m.ephemeral.role}: ${m.body}`,
        m.from,
        m.timestamp,
        {
          seq: m.seq,
          threadId: m.threadId,
          ...(m.stepKey !== undefined ? { stepKey: m.stepKey } : {}),
        },
      )
    }
  }

  for (const ev of events) {
    if (ev.seq !== undefined && resolvedSeqs.has(ev.seq)) continue
    const category = inferEventAttentionCategory(ev)
    if (!category) continue
    pushItem(category, ev.kind, ev.detail, ev.agent, ev.timestamp, {
      ...(ev.seq !== undefined ? { seq: ev.seq } : {}),
      ...(ev.stepKey !== undefined ? { stepKey: ev.stepKey } : {}),
      ...(ev.threadId !== undefined ? { threadId: ev.threadId } : {}),
    })
  }

  for (const st of steps) {
    if (st.state === 'blocked' || st.state === 'rolled_back') {
      const hasStepFailure = items.some((i) => i.category === 'failure' && i.stepKey === st.stepKey)
      if (!hasStepFailure) {
        const parsedTs = Date.parse(st.updatedAt)
        pushItem(
          'failure',
          isPt ? `Passo ${st.state}` : `Step ${st.state}`,
          st.objective || st.stepKey,
          st.agent,
          Number.isFinite(parsedTs) ? parsedTs : 0,
          { stepKey: st.stepKey },
        )
      }
    }
  }

  for (const ch of children) {
    if (ch.status === 'failed' || ch.status === 'interrupted') {
      pushItem(
        'failure',
        isPt ? `Subagente ${ch.status}` : `Subagent ${ch.status}`,
        `${ch.kind} (${ch.id})`,
        ch.agent,
        ch.updatedAt,
        {},
      )
    }
  }

  return items
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp
      return (b.seq ?? 0) - (a.seq ?? 0)
    })
    .slice(0, 20)
}

function normalizeAgentHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '')
}

function extractBodyMentions(body: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const re = /(?:^|[\s(])@([A-Za-z0-9][A-Za-z0-9_-]*)/g
  for (const match of body.matchAll(re)) {
    const handle = match[1]
    if (handle && !seen.has(handle)) {
      seen.add(handle)
      found.push(handle)
    }
  }
  return found
}

/**
 * Extract directed `@mention` interaction edges (`from -> target`, `seq`, `tag`,
 * `replyToSeq`, `timestamp`) from Agora Board messages, optionally capped at
 * `maxSeqCap` for `#seq` causal replay.
 */
export function buildBoardInteractionGraph(
  messages: readonly CockpitBoardMessage[],
  maxSeqCap?: number,
): BoardInteractionGraph {
  const sorted = [...messages]
    .filter((m) => maxSeqCap === undefined || m.seq <= maxSeqCap)
    .sort((a, b) => a.seq - b.seq)

  const edges: BoardInteractionEdge[] = []
  const nodes: string[] = []
  const seenNodes = new Set<string>()
  const edgeCountByPair: Record<string, number> = {}

  const addNode = (name: string) => {
    if (!name || seenNodes.has(name)) return
    seenNodes.add(name)
    nodes.push(name)
  }

  for (const msg of sorted) {
    const from = normalizeAgentHandle(msg.from) || 'unknown'
    addNode(from)

    const rawTargets =
      msg.mentions.length > 0
        ? msg.mentions.map(normalizeAgentHandle)
        : extractBodyMentions(msg.body)
    const dedupTargets: string[] = []
    const seenTargets = new Set<string>()
    for (const target of rawTargets) {
      if (!target || seenTargets.has(target)) continue
      seenTargets.add(target)
      dedupTargets.push(target)
    }

    const preview = msg.body.trim().replace(/\s+/g, ' ').slice(0, 72)
    for (const target of dedupTargets) {
      addNode(target)
      const pairKey = `${from}->${target}`
      edgeCountByPair[pairKey] = (edgeCountByPair[pairKey] ?? 0) + 1
      edges.push({
        from,
        target,
        seq: msg.seq,
        tag: msg.tag,
        replyToSeq: msg.replyToSeq,
        timestamp: msg.timestamp,
        channel: msg.channel,
        threadId: msg.threadId,
        bodyPreview: preview || undefined,
      })
    }
  }

  const maxSeq = sorted.length > 0 ? (sorted[sorted.length - 1]?.seq ?? 0) : 0
  return {
    edges,
    nodes,
    maxSeq,
    edgeCountByPair,
  }
}

function sanitizeMermaidParticipant(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '') || 'specialist'
}

export function buildCockpitSnapshot(input: CockpitInput): CockpitSnapshot {
  const isPt = Boolean(input.isPt)
  const ctxTokens = Math.max(0, input.contextTokens ?? 0)
  const ctxWindow = Math.max(1, input.contextWindow ?? 200_000)
  const ctxPct = Math.min(100, Math.round((ctxTokens / ctxWindow) * 100))
  const filled = Math.min(20, Math.round((ctxPct / 100) * 20))
  const gauge = `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${ctxPct}%`

  const artifacts = input.workspaceDir ? scanPantheonArtifacts(input.workspaceDir) : []
  const stepLedger = input.workspaceDir
    ? loadStepEntries(input.workspaceDir)
    : { entries: [], corrupt: false }
  const steps = stepLedger.entries
  const stepsDone = steps.filter((s) => s.state === 'done').length

  const runningCount = input.children.filter((c) => c.status === 'running').length
  const completedCount = input.children.filter((c) => c.status === 'completed').length
  const failedCount = input.children.filter(
    (c) => c.status === 'failed' || c.status === 'interrupted',
  ).length
  const childCost = input.children.reduce((acc, c) => acc + c.cost, 0)

  const minMs = input.children.reduce((m, c) => Math.min(m, c.startedAt), Infinity)
  const maxMs = input.children.reduce((m, c) => Math.max(m, c.updatedAt), 0)
  const safeMin = Number.isFinite(minMs) ? minMs : 0
  const safeMax = maxMs > safeMin ? maxMs : safeMin + 1000

  const swarmRows = input.children.map((c) => ({
    ...c,
    durationSec: Math.max(0, Math.round((c.updatedAt - c.startedAt) / 100) / 10),
    ganttBar: formatGanttBar(c.startedAt, Math.max(c.startedAt + 1, c.updatedAt), safeMin, safeMax),
  }))

  const persistedEvents = input.workspaceDir ? loadPersistedCockpitEvents(input.workspaceDir) : []
  const mergedEvents = [...(input.events ?? []), ...persistedEvents]
  const dedup = new Map<string, CockpitLogEntry>()
  for (const ev of mergedEvents) {
    dedup.set(`${ev.kind}:${ev.timestamp}:${ev.agent}:${ev.seq ?? ''}:${ev.detail}`, ev)
  }
  const events = Array.from(dedup.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 40)

  const persistedBoard = input.workspaceDir ? loadPersistedBoardMessages(input.workspaceDir) : []
  const boardDedup = new Map<number, CockpitBoardMessage>()
  for (const m of [...persistedBoard, ...(input.boardMessages ?? [])]) {
    boardDedup.set(m.seq, m)
  }
  const boardMessages = Array.from(boardDedup.values()).sort((a, b) => a.seq - b.seq)
  const threads = buildOutcomeThreads(boardMessages, isPt)
  const interactions = buildBoardInteractionGraph(boardMessages)
  const attention = buildRankedAttentionQueue({
    messages: boardMessages,
    events,
    steps,
    children: input.children,
    isPt,
  })

  const allowed = stepsDone + events.filter((e) => e.severity === 'ok').length + completedCount
  const approved = steps.filter((s) => Boolean(s.receiptId)).length
  const waiting =
    steps.filter((s) => s.state === 'in_progress' || s.state === 'pending').length + runningCount
  const blocked =
    steps.filter((s) => s.state === 'blocked' || s.state === 'rolled_back').length +
    events.filter((e) => e.severity === 'error').length +
    failedCount

  const velocityBlocks =
    input.children.length > 0
      ? input.children
          .slice(0, 14)
          .map((c) =>
            c.tokens > 20_000 ? '█' : c.tokens > 10_000 ? '▆' : c.tokens > 3_000 ? '▄' : '▂',
          )
          .join('')
      : '▁▃▅▆▄▂'

  return {
    sessionTitle: input.sessionTitle?.trim() || (isPt ? 'Sessão ativa' : 'Active Session'),
    modelName: input.modelName?.trim() || 'auto',
    overview: {
      contextTokens: ctxTokens,
      contextWindow: ctxWindow,
      contextPercent: ctxPct,
      contextGauge: gauge,
      sessionCost: input.sessionCost ?? childCost,
      cacheRate: input.cacheRate ?? 0,
      subagentCount: input.children.length,
      runningCount,
      velocityBars: velocityBlocks,
      workMap: renderWorkMapLines({
        subagents: input.children.length,
        artifacts: artifacts.length,
        stepsDone,
        stepsTotal: steps.length,
      }),
      surfaces: [
        { label: 'Native Tools (30)', status: 'active' },
        { label: 'FTS5 Memory + Worktree', status: 'ready' },
        {
          label: 'Step-Ledger & Checkpoints',
          status: stepLedger.corrupt
            ? 'unreadable — ledger corrupt'
            : `${stepsDone}/${steps.length} done`,
        },
        { label: 'LSP + Per-Edit Guardrails', status: 'active' },
        { label: 'Artifacts & Mermaid', status: `${artifacts.length} file(s)` },
      ],
    },
    swarm: {
      activeCount: runningCount,
      completedCount,
      failedCount,
      totalCost: childCost,
      rows: swarmRows,
    },
    threads,
    interactions,
    attention,
    flightdeck: {
      allowed,
      approved,
      waiting,
      blocked,
      gateGlyphs: formatGateMatrixGlyphs(allowed, approved, waiting, blocked),
      gateSummary: `${allowed} allowed · ${approved} receipts · ${waiting} active · ${blocked} blocked`,
      steps,
      stepsCorrupt: stepLedger.corrupt,
      logs: events,
    },
  }
}

export interface CockpitReplayExport {
  readonly filename: string
  readonly relPath: string
  readonly markdown: string
}

/**
 * Render a deterministic Markdown + Mermaid Flightdeck replay trace ready for
 * archival under `.pantheon/reports/` and inspection via `/pantheon-artifacts`.
 */
export function formatCockpitReplayArtifact(
  snapshot: CockpitSnapshot,
  now: Date = new Date(),
): CockpitReplayExport {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `cockpit-replay-${stamp}.md`
  const relPath = `.pantheon/reports/${filename}`
  const seqLines: string[] = [
    '```mermaid',
    'sequenceDiagram',
    '  participant You',
    '  participant Zeus',
  ]
  const seenAgents = new Set<string>(['You', 'Zeus'])
  const ensureParticipant = (raw: string): string => {
    const clean = sanitizeMermaidParticipant(raw)
    if (!seenAgents.has(clean)) {
      seenAgents.add(clean)
      seqLines.push(`  participant ${clean}`)
    }
    return clean
  }

  const interactionEdges = snapshot.interactions?.edges ?? []
  for (const edge of interactionEdges.slice(0, 24)) {
    const cleanFrom = ensureParticipant(edge.from)
    const cleanTarget = ensureParticipant(edge.target)
    const tagPart = edge.tag ? ` [${edge.tag}]` : ''
    const replyPart = edge.replyToSeq !== undefined ? ` (re:#${edge.replyToSeq})` : ''
    seqLines.push(`  ${cleanFrom}->>${cleanTarget}: #${edge.seq}${tagPart}${replyPart}`)
  }

  for (const row of snapshot.swarm.rows.slice(0, 12)) {
    const cleanAgent = ensureParticipant(row.agent)
    seqLines.push(
      `  Zeus->>${cleanAgent}: ${row.kind} ($${row.cost.toFixed(3)}, ${row.durationSec}s)`,
    )
    seqLines.push(`  ${cleanAgent}-->>Zeus: ${row.status}`)
  }
  if (interactionEdges.length === 0 && snapshot.swarm.rows.length === 0) {
    seqLines.push('  You->>Zeus: active session telemetry snapshot')
    seqLines.push('  Zeus-->>You: Flightdeck gate check')
  }
  seqLines.push('```')

  const ganttRows =
    snapshot.swarm.rows.length > 0
      ? snapshot.swarm.rows
          .map(
            (r) =>
              `| \`@${r.agent}\` | ${r.status} | \`${r.ganttBar}\` | ${r.durationSec}s | $${r.cost.toFixed(4)} |`,
          )
          .join('\n')
      : '| _none_ | — | `░░░░░░░░░░░░` | 0s | $0.0000 |'

  const stepLines = snapshot.flightdeck.stepsCorrupt
    ? '- **⚠ `step-ledger.json` is unreadable (corrupt)** — step state is unknown, not empty. Inspect `.pantheon/ledger/` (`*.corrupt.<ts>` quarantine or a manual repair).'
    : snapshot.flightdeck.steps.length > 0
      ? snapshot.flightdeck.steps
          .map((s) => `- **${s.stepKey}** (\`${s.state}\`, \`@${s.agent}\`) — ${s.objective}`)
          .join('\n')
      : '- No step-ledger entries recorded.'

  const eventLines =
    snapshot.flightdeck.logs.length > 0
      ? snapshot.flightdeck.logs
          .map((e) => `- \`[${e.kind}]\` **@${e.agent}**: ${e.detail}`)
          .join('\n')
      : '- No semantic bus events recorded.'

  const attentionLines =
    snapshot.attention.length > 0
      ? snapshot.attention
          .map((a) => {
            const refs = [
              a.seq !== undefined ? `#${a.seq}` : undefined,
              a.stepKey ? `\`${a.stepKey}\`` : undefined,
            ]
              .filter(Boolean)
              .join(' · ')
            return `- **[${a.category.toUpperCase()}]**${refs ? ` (${refs})` : ''} **@${a.agent}**: ${a.detail}`
          })
          .join('\n')
      : '- No pending attention items.'

  const threadLines =
    snapshot.threads.groups.length > 0
      ? snapshot.threads.groups
          .flatMap((g) => [
            `- **${g.goal}** (#${g.latestSeq}, \`${g.statusTag}\`)`,
            ...g.threads.map(
              (t) =>
                `  - \`${t.channel}/${t.threadId}\` (#${t.latestSeq}, \`${t.statusTag}\`, ${t.workstreams.length} workstreams)`,
            ),
          ])
          .join('\n')
      : '- No board threads recorded.'

  const interactionLines =
    interactionEdges.length > 0
      ? interactionEdges
          .map((edge) => {
            const tagPart = edge.tag ? ` \`[${edge.tag}]\`` : ''
            const replyPart = edge.replyToSeq !== undefined ? ` (re: #${edge.replyToSeq})` : ''
            const preview = edge.bodyPreview ? ` — ${edge.bodyPreview}` : ''
            return `- #${edge.seq} **@${edge.from} → @${edge.target}**${tagPart}${replyPart}${preview}`
          })
          .join('\n')
      : '- No @mention interaction edges recorded.'

  const markdown = [
    `# Pantheon Cockpit Flightdeck Replay`,
    '',
    `- **Session:** ${snapshot.sessionTitle}`,
    `- **Model:** ${snapshot.modelName}`,
    `- **Captured At:** ${now.toISOString()}`,
    `- **Spend / Context:** $${snapshot.overview.sessionCost.toFixed(4)} · ${snapshot.overview.contextTokens} tokens (${snapshot.overview.contextPercent}%)`,
    `- **Gate Matrix:** ${snapshot.flightdeck.gateSummary}`,
    '',
    '## Execution Replay Diagram',
    '',
    ...seqLines,
    '',
    '## @mention Interaction Graph (#seq Causal Replay)',
    '',
    interactionLines,
    '',
    '## Ranked Attention Queue',
    '',
    attentionLines,
    '',
    '## Outcome Threads',
    '',
    threadLines,
    '',
    '## Swarm Concurrency Timeline',
    '',
    '| Agent | Status | Gantt Window | Duration | Cost |',
    '|---|---|---|---|---|',
    ganttRows,
    '',
    '## Step-Ledger Checkpoints',
    '',
    stepLines,
    '',
    '## Semantic Event Stream',
    '',
    eventLines,
    '',
  ].join('\n')

  return { filename, relPath, markdown }
}

/** Confined export helper writing a Cockpit replay trace under `<workspaceDir>/.pantheon/reports/`. */
export function writeCockpitReplayArtifact(
  workspaceDir: string,
  snapshot: CockpitSnapshot,
  now: Date = new Date(),
): string {
  const reportsDir = join(workspaceDir, '.pantheon', 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const canonicalReports = realpathSync(reportsDir)
  const artifact = formatCockpitReplayArtifact(snapshot, now)
  const target = resolve(canonicalReports, artifact.filename)
  const prefix = canonicalReports.endsWith(sep) ? canonicalReports : `${canonicalReports}${sep}`
  if (!target.startsWith(prefix)) {
    throw new Error('Cockpit replay target escaped .pantheon/reports')
  }
  writeFileSync(target, artifact.markdown, 'utf8')
  return artifact.relPath
}

export type TidyDagNodeStatus = 'root' | 'running' | 'done' | 'blocked' | 'idle'

export interface TidyDagInputEvent {
  kind?: string
  type?: string
  agent?: string
  parentAgent?: string
  baseAgent?: string
  role?: string
  stepKey?: string
  status?: string
}

export interface TidyDagInputMessage {
  seq: number
  from: string
  mentions?: string[]
  replyToSeq?: number
  tag?: string
}

export interface TidyDagInputJob {
  agent: string
  status?: string
}

export interface TidyDagNode {
  id: string
  label: string
  parentId: string | null
  depth: number
  status: TidyDagNodeStatus
  x: number
  y: number
  width: number
  height: number
  children?: TidyDagNode[]
}

export interface TidyDagEdge {
  fromId: string
  toId: string
  x1: number
  y1: number
  x2: number
  y2: number
  status: TidyDagNodeStatus
}

export interface TidyDagLayout {
  nodes: TidyDagNode[]
  edges: TidyDagEdge[]
  width: number
  height: number
}

const TIDY_DAG_IGNORED_AGENTS = new Set(['user', 'pantheon', 'ledger', 'all', 'unknown'])

function normalizeDagAgentId(raw: string | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/^@+/, '')
  if (!cleaned || TIDY_DAG_IGNORED_AGENTS.has(cleaned.toLowerCase())) return null
  return cleaned
}

function statusFromString(raw: string | undefined): TidyDagNodeStatus | undefined {
  if (!raw) return undefined
  const s = raw.trim().toLowerCase()
  if (s === 'running' || s === 'active' || s === 'working' || s === 'in_progress') return 'running'
  if (s === 'done' || s === 'completed' || s === 'approve' || s === 'approved') return 'done'
  if (s === 'blocked' || s === 'failed' || s === 'error' || s === 'block' || s === 'stuck')
    return 'blocked'
  return undefined
}

function mergeDagStatus(
  prev: TidyDagNodeStatus | undefined,
  next: TidyDagNodeStatus | undefined,
): TidyDagNodeStatus {
  if (!next) return prev ?? 'idle'
  if (prev === 'root') return 'root'
  if (next === 'blocked' || prev === 'blocked') return 'blocked'
  if (next === 'running' || prev === 'running') return 'running'
  if (next === 'done' || prev === 'done') return 'done'
  return next
}

/**
 * Computes a non-overlapping multi-level tidy tree layout rooted at `zeus`.
 * Uses bottom-up subtree width measurement (Reingold-Tilford style) with cycle protection.
 */
export function computeTidyDagLayout(input: {
  events?: readonly TidyDagInputEvent[]
  messages?: readonly TidyDagInputMessage[]
  activeJobs?: readonly TidyDagInputJob[]
  nodeWidth?: number
  nodeHeight?: number
  siblingSpacing?: number
  levelSpacing?: number
}): TidyDagLayout {
  const nodeWidth = input.nodeWidth ?? 132
  const nodeHeight = input.nodeHeight ?? 44
  const siblingSpacing = input.siblingSpacing ?? 16
  const levelSpacing = input.levelSpacing ?? 48
  const padX = 16
  const padY = 12

  const parentOf = new Map<string, string>()
  const statusOf = new Map<string, TidyDagNodeStatus>([['zeus', 'root']])

  const wouldCreateCycle = (childId: string, candidateParentId: string): boolean => {
    let cur: string | undefined = candidateParentId
    const visited = new Set<string>([childId])
    while (cur) {
      if (visited.has(cur)) return true
      visited.add(cur)
      cur = parentOf.get(cur)
    }
    return false
  }

  const linkNode = (
    parentRaw: string | undefined,
    childRaw: string | undefined,
    status?: TidyDagNodeStatus,
  ) => {
    const child = normalizeDagAgentId(childRaw)
    if (!child) return
    if (status) statusOf.set(child, mergeDagStatus(statusOf.get(child), status))
    if (child === 'zeus') return

    const parent = normalizeDagAgentId(parentRaw) ?? 'zeus'
    if (parent === child) return

    const existing = parentOf.get(child)
    if (!existing || (existing === 'zeus' && parent !== 'zeus')) {
      if (!wouldCreateCycle(child, parent)) {
        parentOf.set(child, parent)
      } else if (!existing) {
        parentOf.set(child, 'zeus')
      }
    }
    if (!statusOf.has(child)) statusOf.set(child, 'idle')
  }

  for (const ev of input.events ?? []) {
    const kind = (ev.kind ?? ev.type ?? '').trim()
    const st =
      statusFromString(ev.status) ??
      (kind === 'subagent:start' ? 'running' : kind === 'subagent:stop' ? 'done' : undefined)
    if (kind === 'ephemeral:worker') {
      const child = ev.role || ev.stepKey || ev.agent
      const parent = ev.baseAgent || ev.parentAgent || 'zeus'
      linkNode(parent, child, st)
    } else if (ev.parentAgent && ev.agent) {
      linkNode(ev.parentAgent, ev.agent, st)
    } else if (ev.agent) {
      linkNode('zeus', ev.agent, st)
    }
  }

  const seqSender = new Map<number, string>()
  for (const m of input.messages ?? []) {
    const sender = normalizeDagAgentId(m.from)
    if (sender) seqSender.set(m.seq, sender)
  }

  for (const m of input.messages ?? []) {
    const from = normalizeDagAgentId(m.from)
    const tagStatus = statusFromString(m.tag)
    if (from) {
      if (m.replyToSeq !== undefined) {
        const origSender = seqSender.get(m.replyToSeq)
        if (origSender && origSender !== from) {
          linkNode(origSender, from, tagStatus)
        } else {
          linkNode('zeus', from, tagStatus)
        }
      } else {
        linkNode('zeus', from, tagStatus)
      }
    }
    for (const target of m.mentions ?? []) {
      linkNode(from ?? 'zeus', target, tagStatus)
    }
  }

  for (const job of input.activeJobs ?? []) {
    linkNode('zeus', job.agent, statusFromString(job.status))
  }

  // Ensure every referenced parent is attached to the root tree.
  for (const p of [...parentOf.values()]) {
    if (p !== 'zeus' && !parentOf.has(p)) {
      if (!wouldCreateCycle(p, 'zeus')) {
        parentOf.set(p, 'zeus')
      }
      if (!statusOf.has(p)) statusOf.set(p, 'idle')
    }
  }

  const childrenMap = new Map<string, string[]>()
  for (const [child, parent] of parentOf.entries()) {
    const list = childrenMap.get(parent)
    if (list) list.push(child)
    else childrenMap.set(parent, [child])
  }

  interface Measured {
    id: string
    children: Measured[]
    subtreeWidth: number
    childrenWidth: number
  }

  const measureVisited = new Set<string>()
  const measure = (id: string): Measured => {
    measureVisited.add(id)
    const rawChildren = childrenMap.get(id) ?? []
    const measuredChildren: Measured[] = []
    for (const childId of rawChildren) {
      if (!measureVisited.has(childId)) {
        measuredChildren.push(measure(childId))
      }
    }
    const childrenWidth =
      measuredChildren.reduce((sum, c) => sum + c.subtreeWidth, 0) +
      Math.max(0, measuredChildren.length - 1) * siblingSpacing
    return {
      id,
      children: measuredChildren,
      subtreeWidth: Math.max(nodeWidth, childrenWidth),
      childrenWidth,
    }
  }

  const rootMeasured = measure('zeus')
  const nodes: TidyDagNode[] = []
  const nodeById = new Map<string, TidyDagNode>()
  let maxDepth = 0

  const assign = (m: Measured, leftX: number, depth: number, parentId: string | null) => {
    if (depth > maxDepth) maxDepth = depth
    const y = padY + depth * (nodeHeight + levelSpacing)
    let x = leftX + (m.subtreeWidth - nodeWidth) / 2

    if (m.children.length > 0) {
      let cursorX = leftX + (m.subtreeWidth - m.childrenWidth) / 2
      for (const child of m.children) {
        assign(child, cursorX, depth + 1, m.id)
        cursorX += child.subtreeWidth + siblingSpacing
      }
      const firstChildId = m.children[0]?.id
      const lastChildId = m.children[m.children.length - 1]?.id
      const firstChild = firstChildId ? nodeById.get(firstChildId) : undefined
      const lastChild = lastChildId ? nodeById.get(lastChildId) : undefined
      if (firstChild && lastChild) {
        const midCenter = (firstChild.x + nodeWidth / 2 + (lastChild.x + nodeWidth / 2)) / 2
        x = midCenter - nodeWidth / 2
      }
    }

    const node: TidyDagNode = {
      id: m.id,
      label: m.id === 'zeus' ? 'zeus (root)' : m.id,
      parentId,
      depth,
      status: statusOf.get(m.id) ?? 'idle',
      x,
      y,
      width: nodeWidth,
      height: nodeHeight,
    }
    nodes.push(node)
    nodeById.set(m.id, node)
  }

  assign(rootMeasured, padX, 0, null)

  const edges: TidyDagEdge[] = []
  for (const node of nodes) {
    if (!node.parentId) continue
    const parent = nodeById.get(node.parentId)
    if (!parent) continue
    edges.push({
      fromId: parent.id,
      toId: node.id,
      x1: parent.x + nodeWidth / 2,
      y1: parent.y + nodeHeight,
      x2: node.x + nodeWidth / 2,
      y2: node.y,
      status: node.status,
    })
  }

  const width = Math.max(320, Math.ceil(rootMeasured.subtreeWidth + padX * 2))
  const height = Math.max(
    160,
    Math.ceil((maxDepth + 1) * nodeHeight + maxDepth * levelSpacing + padY * 2),
  )

  return { nodes, edges, width, height }
}

export interface RadialHubLayoutOptions {
  width?: number
  height?: number
  innerRadius?: number
  ringStep?: number
  nodeWidth?: number
  nodeHeight?: number
}

interface RadialTreeNode {
  id: string
  label: string
  parentId: string | null
  depth: number
  status: TidyDagNodeStatus
  children: RadialTreeNode[]
  leafCount: number
}

function toRadialTree(input: TidyDagNode | TidyDagLayout): RadialTreeNode {
  if ('nodes' in input) {
    const map = new Map<string, RadialTreeNode>()
    for (const n of input.nodes) {
      map.set(n.id, {
        id: n.id,
        label: n.label,
        parentId: n.parentId,
        depth: n.depth,
        status: n.status,
        children: [],
        leafCount: 1,
      })
    }
    let root: RadialTreeNode | undefined
    for (const n of input.nodes) {
      const node = map.get(n.id)
      if (!node) continue
      if (n.parentId && map.has(n.parentId)) {
        map.get(n.parentId)?.children.push(node)
      } else if (n.id === 'zeus' || !root) {
        root = node
      }
    }
    const resolvedRoot: RadialTreeNode = root ?? {
      id: 'zeus',
      label: 'zeus (root)',
      parentId: null,
      depth: 0,
      status: 'root',
      children: [],
      leafCount: 1,
    }
    const computeLeaves = (node: RadialTreeNode, depth: number): number => {
      node.depth = depth
      if (node.children.length === 0) {
        node.leafCount = 1
        return 1
      }
      let sum = 0
      for (const c of node.children) sum += computeLeaves(c, depth + 1)
      node.leafCount = Math.max(1, sum)
      return node.leafCount
    }
    computeLeaves(resolvedRoot, 0)
    return resolvedRoot
  }

  const cloneNode = (n: TidyDagNode, depth: number): RadialTreeNode => {
    const children = (n.children ?? []).map((c) => cloneNode(c, depth + 1))
    const leafCount = children.length === 0 ? 1 : children.reduce((sum, c) => sum + c.leafCount, 0)
    return {
      id: n.id,
      label: n.label,
      parentId: n.parentId,
      depth,
      status: n.status,
      children,
      leafCount: Math.max(1, leafCount),
    }
  }
  return cloneNode(input, 0)
}

/**
 * Computes a coordinator-centered radial hub layout where `zeus` sits at the center
 * and Level-1+ subtrees fan out in proportional angular sectors without overlapping.
 */
export function computeRadialHubLayout(
  rootOrLayout: TidyDagNode | TidyDagLayout,
  options?: RadialHubLayoutOptions,
): TidyDagLayout {
  const nodeWidth = options?.nodeWidth ?? 132
  const nodeHeight = options?.nodeHeight ?? 44
  const innerRadius = options?.innerRadius ?? 170
  const ringStep = options?.ringStep ?? 145
  const padX = 24
  const padY = 24

  const tree = toRadialTree(rootOrLayout)
  const totalLeaves = Math.max(1, tree.leafCount)
  const minCircumference = totalLeaves * (nodeWidth + 24)
  const minRadiusForRing = minCircumference / (2 * Math.PI)

  const placed: Array<{ node: TidyDagNode; angle: number; radius: number }> = []
  const nodeById = new Map<string, TidyDagNode>()

  const placeNode = (
    item: RadialTreeNode,
    startAngle: number,
    endAngle: number,
    cx: number,
    cy: number,
  ) => {
    const midAngle = (startAngle + endAngle) / 2
    const radius =
      item.depth === 0
        ? 0
        : Math.max(
            innerRadius + (item.depth - 1) * ringStep,
            minRadiusForRing * (item.depth * 0.65),
          )
    const x = cx + Math.cos(midAngle) * radius - nodeWidth / 2
    const y = cy + Math.sin(midAngle) * radius - nodeHeight / 2

    const dagNode: TidyDagNode = {
      id: item.id,
      label: item.label,
      parentId: item.parentId,
      depth: item.depth,
      status: item.status,
      x,
      y,
      width: nodeWidth,
      height: nodeHeight,
    }
    placed.push({ node: dagNode, angle: midAngle, radius })
    nodeById.set(dagNode.id, dagNode)

    if (item.children.length === 0) return
    const span = endAngle - startAngle
    let cursor = startAngle
    for (const child of item.children) {
      const childSpan = span * (child.leafCount / item.leafCount)
      placeNode(child, cursor, cursor + childSpan, cx, cy)
      cursor += childSpan
    }
  }

  placeNode(tree, -Math.PI / 2, (3 * Math.PI) / 2, 0, 0)

  // Deterministic overlap resolution: push outer/later nodes radially outward if bounding boxes touch.
  const margin = 12
  for (let pass = 0; pass < 4; pass++) {
    let moved = false
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]
        const b = placed[j]
        if (!a || !b) continue
        const overlapX =
          a.node.x < b.node.x + b.node.width + margin && a.node.x + a.node.width + margin > b.node.x
        const overlapY =
          a.node.y < b.node.y + b.node.height + margin &&
          a.node.y + a.node.height + margin > b.node.y
        if (overlapX && overlapY) {
          const target = b.node.depth >= a.node.depth ? b : a
          target.radius += nodeHeight + margin
          target.node.x = Math.cos(target.angle) * target.radius - nodeWidth / 2
          target.node.y = Math.sin(target.angle) * target.radius - nodeHeight / 2
          moved = true
        }
      }
    }
    if (!moved) break
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { node } of placed) {
    if (node.x < minX) minX = node.x
    if (node.y < minY) minY = node.y
    if (node.x + node.width > maxX) maxX = node.x + node.width
    if (node.y + node.height > maxY) maxY = node.y + node.height
  }

  const contentW = Math.max(nodeWidth, maxX - minX)
  const contentH = Math.max(nodeHeight, maxY - minY)
  const width = Math.max(options?.width ?? 760, Math.ceil(contentW + padX * 2))
  const height = Math.max(options?.height ?? 520, Math.ceil(contentH + padY * 2))
  const shiftX = (width - contentW) / 2 - minX
  const shiftY = (height - contentH) / 2 - minY

  const nodes: TidyDagNode[] = placed.map(({ node }) => {
    node.x = Math.round(node.x + shiftX)
    node.y = Math.round(node.y + shiftY)
    return node
  })

  const edges: TidyDagEdge[] = []
  for (const node of nodes) {
    if (!node.parentId) continue
    const parent = nodeById.get(node.parentId)
    if (!parent) continue
    edges.push({
      fromId: parent.id,
      toId: node.id,
      x1: parent.x + nodeWidth / 2,
      y1: parent.y + nodeHeight / 2,
      x2: node.x + nodeWidth / 2,
      y2: node.y + nodeHeight / 2,
      status: node.status,
    })
  }

  return { nodes, edges, width, height }
}
