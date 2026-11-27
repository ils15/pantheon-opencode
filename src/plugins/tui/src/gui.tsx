// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode Desktop GUI SDK exposes reactive host types at runtime.
/** @jsxImportSource solid-js */

/**
 * gui.tsx — Native OpenCode Desktop GUI plugin (`./gui-experimental`).
 *
 * Provides:
 * - Side Panel (`Pantheon Cockpit`) with Olympus Topology (DAG + Timeline/Gantt
 *   + replay scrubber), interactive Agora Board (`#seq` stream + post), Ephemeral
 *   & Bots (`state.json` + `board-signals/*.signal.json`), and Settings/Cost.
 * - `ComposerPill` (`pantheon.status`) showing live bots & quick actions.
 * - Interactive `SettingsPage` (`Pantheon`) in Desktop Settings reading/writing
 *   overrides via Electron `main(ctx)` IPC + host `tui-prefs` storage.
 * - Slash commands `/pantheon-cockpit` and `/pantheon-settings`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  Command,
  ComposerPill,
  Ipc,
  Panel,
  type PanelTab,
  Plugin,
  SettingsPage,
  type SetupContext,
} from '@opencode/plugin/gui'
import { Schema } from 'effect'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import {
  readDecisionRouterConfig,
  setDecisionEnabled,
  writeDecisionRouterConfig,
} from './decision-router-state'
import {
  type EffectiveOverrides,
  isBehaviorDisabled,
  SETTINGS_BEHAVIORS,
  toggledOverrides,
} from './pantheon-settings-state'
import {
  clearActivePreset,
  globalActivePresetPath,
  PRESET_NAMES,
  PRESET_NONE,
  readActivePresetMarker,
  writeActivePreset,
} from './preset-state'

declare const __PANTHEON_VERSION__: string | undefined

function resolveRunningVersion(): string {
  if (typeof __PANTHEON_VERSION__ !== 'undefined' && __PANTHEON_VERSION__ !== '') {
    return __PANTHEON_VERSION__
  }
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

interface BoardMsg {
  seq: number
  timestamp: number
  channel?: string
  from: string
  mentions: string[]
  tag?: string
  body: string
  ephemeral?: {
    role: string
    status: string
    worktreeDir?: string
  }
}

interface CockpitEvent {
  kind?: string
  type?: string
  timestamp: number
  agent?: string
  status?: string
  detail?: string
  severity?: string
  threadId?: string
  stepKey?: string
}

interface BehaviorSettingItem {
  id: string
  title: string
  description: string
  kind: 'install' | 'runtime'
  enabled: boolean
}

interface GuiSnapshot {
  messages: BoardMsg[]
  events: CockpitEvent[]
  activeJobs: Array<{ id: string; agent: string; status: string; cost: number }>
  todayCostUSD: number
  monthCostUSD: number
  overridesCount: number
  gateMode: string
  artifactsCount: number
  activePreset: string
  presetProjectOverride: string | null
  decisionEnabled: boolean
  decisionMode: string
  behaviors: BehaviorSettingItem[]
}

const PantheonBridge = Ipc.define({
  id: 'pantheon-opencode.bridge',
  methods: {
    snapshot: {
      input: Schema.String,
      output: Schema.String,
    },
    postBoardMessage: {
      input: Schema.String,
      output: Schema.String,
    },
    saveSettings: {
      input: Schema.String,
      output: Schema.String,
    },
  },
})

function readNdjsonLines<T>(filePath: string, limit = 80): T[] {
  if (!existsSync(filePath)) return []
  try {
    const raw = readFileSync(filePath, 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const slice = lines.slice(-limit)
    const parsed: T[] = []
    for (const line of slice) {
      try {
        parsed.push(JSON.parse(line) as T)
      } catch {
        /* skip malformed line */
      }
    }
    return parsed
  } catch {
    return []
  }
}

interface SqliteDbLike {
  prepare(sql: string): {
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  close(): void
}

function resolveOpenCodeDbPaths(): string[] {
  const candidates = [
    process.env.PANTHEON_COST_DB,
    process.env.OPENCODE_DB,
    process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db') : '',
    process.env.APPDATA ? join(process.env.APPDATA, 'opencode', 'opencode.db') : '',
    join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
  ]
  const seen = new Set<string>()
  const existing: string[] = []
  for (const raw of candidates) {
    const candidate = raw?.trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    if (existsSync(candidate)) existing.push(candidate)
  }
  return existing
}

async function openSqliteReadOnly(dbPath: string): Promise<SqliteDbLike | null> {
  try {
    const sqlite = (await import('node:sqlite')) as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDbLike
    }
    return new sqlite.DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
}

async function readOpenCodeCosts(): Promise<{ todayCostUSD: number; monthCostUSD: number }> {
  const dbPaths = resolveOpenCodeDbPaths()
  if (dbPaths.length === 0) return { todayCostUSD: 0, monthCostUSD: 0 }

  const now = Date.now()
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const dayMs = startOfDay.getTime()
  const monthMs = now - 30 * 24 * 60 * 60 * 1000

  for (const dbPath of dbPaths) {
    const db = await openSqliteReadOnly(dbPath)
    if (!db) continue
    try {
      const tables = new Set(
        (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message')",
            )
            .all() as Array<{ name?: unknown }>
        ).map((r) => String(r.name)),
      )
      if (tables.size === 0) continue

      let todayCostUSD = 0
      let monthCostUSD = 0
      for (const table of ['message', 'session_message'] as const) {
        if (!tables.has(table)) continue
        const row = db
          .prepare(
            `SELECT
              COALESCE(SUM(CASE WHEN time_created >= ? THEN CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.cost'), 0) ELSE 0 END ELSE 0 END), 0) AS today_cost,
              COALESCE(SUM(CASE WHEN time_created >= ? THEN CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.cost'), 0) ELSE 0 END ELSE 0 END), 0) AS month_cost
            FROM ${table}`,
          )
          .get(dayMs, monthMs) as { today_cost?: number; month_cost?: number } | undefined
        todayCostUSD += Number(row?.today_cost ?? 0) || 0
        monthCostUSD += Number(row?.month_cost ?? 0) || 0
      }
      return { todayCostUSD, monthCostUSD }
    } catch {
      /* try next candidate db */
    } finally {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }
  return { todayCostUSD: 0, monthCostUSD: 0 }
}

function extractAgentFromSessionTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) return 'subagent'
  const mentionMatch = title.match(/@([a-zA-Z0-9_-]+)/)
  if (mentionMatch?.[1]) return mentionMatch[1].toLowerCase()
  const prefixMatch = title.match(/^([a-zA-Z0-9_-]+)\s*:/)
  if (prefixMatch?.[1]) return prefixMatch[1].toLowerCase()
  const known = ['apollo', 'hermes', 'themis', 'athena', 'zeus', 'artemis', 'hephaestus', 'atlas']
  const lower = title.toLowerCase()
  const hit = known.find((name) => lower.includes(name))
  return hit ?? 'subagent'
}

async function readOpenCodeChildSessions(
  rootDirectory: string,
): Promise<GuiSnapshot['activeJobs']> {
  const dbPaths = resolveOpenCodeDbPaths()
  if (dbPaths.length === 0) return []

  const normalizedRoot = rootDirectory.trim().toLowerCase()
  for (const dbPath of dbPaths) {
    const db = await openSqliteReadOnly(dbPath)
    if (!db) continue
    try {
      const hasSession = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'")
        .get() as { name?: unknown } | undefined
      if (!hasSession?.name) continue

      const cols = new Set(
        (db.prepare('PRAGMA table_info(session)').all() as Array<{ name?: unknown }>).map((c) =>
          String(c.name),
        ),
      )
      if (!cols.has('id') || !cols.has('parent_id')) continue

      const selectCols = [
        'id',
        'parent_id',
        cols.has('title') ? 'title' : "'' AS title",
        cols.has('directory') ? 'directory' : "'' AS directory",
        cols.has('time_updated') ? 'time_updated' : '0 AS time_updated',
        cols.has('time_archived') ? 'time_archived' : 'NULL AS time_archived',
      ].join(', ')

      const rows = db
        .prepare(
          `SELECT ${selectCols} FROM session
           WHERE parent_id IS NOT NULL AND parent_id != ''
           ORDER BY time_updated DESC LIMIT 30`,
        )
        .all() as Array<{
        id?: unknown
        parent_id?: unknown
        title?: unknown
        directory?: unknown
        time_updated?: unknown
        time_archived?: unknown
      }>

      const now = Date.now()
      const filtered =
        normalizedRoot && cols.has('directory')
          ? rows.filter((r) => {
              const dir = typeof r.directory === 'string' ? r.directory.trim().toLowerCase() : ''
              return !dir || dir === normalizedRoot
            })
          : rows

      return filtered
        .filter((r) => typeof r.id === 'string' && r.id.length > 0)
        .map((r) => {
          const updated = Number(r.time_updated ?? 0)
          const archived = r.time_archived !== null && r.time_archived !== undefined
          const isRecentActive = !archived && Number.isFinite(updated) && now - updated < 30_000
          return {
            id: String(r.id),
            agent: extractAgentFromSessionTitle(r.title),
            status: isRecentActive ? 'running' : 'completed',
            cost: 0,
          }
        })
    } catch {
      /* try next candidate db */
    } finally {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }
  return []
}

async function readSnapshotFromDisk(directory: string): Promise<GuiSnapshot> {
  const root = directory.trim() || process.cwd()
  const messages = readNdjsonLines<BoardMsg>(
    join(root, '.pantheon', 'board', 'messages.ndjson'),
    80,
  )
  const events = readNdjsonLines<CockpitEvent>(
    join(root, '.pantheon', 'telemetry', 'cockpit-events.ndjson'),
    100,
  )

  const activeJobs: GuiSnapshot['activeJobs'] = []
  const seenJobIds = new Set<string>()
  const statePath = join(root, '.pantheon', 'board', 'state.json')
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
      if (Array.isArray(state)) {
        for (const job of state) {
          if (!job || typeof job !== 'object') continue
          const rec = job as {
            taskID?: unknown
            id?: unknown
            agent?: unknown
            state?: unknown
            status?: unknown
            cost?: unknown
          }
          const id =
            typeof rec.taskID === 'string' ? rec.taskID : typeof rec.id === 'string' ? rec.id : ''
          if (!id || seenJobIds.has(id)) continue
          seenJobIds.add(id)
          activeJobs.push({
            id,
            agent: typeof rec.agent === 'string' && rec.agent ? rec.agent : 'specialist',
            status:
              typeof rec.state === 'string'
                ? rec.state
                : typeof rec.status === 'string'
                  ? rec.status
                  : 'unknown',
            cost: typeof rec.cost === 'number' ? rec.cost : 0,
          })
        }
      } else if (state && typeof state === 'object') {
        const legacy = (
          state as {
            jobs?: Record<string, { id?: string; agent?: string; status?: string; cost?: number }>
          }
        ).jobs
        if (legacy && typeof legacy === 'object') {
          for (const [id, job] of Object.entries(legacy)) {
            if (seenJobIds.has(id)) continue
            seenJobIds.add(id)
            activeJobs.push({
              id,
              agent: job.agent ?? 'specialist',
              status: job.status ?? 'unknown',
              cost: typeof job.cost === 'number' ? job.cost : 0,
            })
          }
        }
      }
    } catch {
      /* ignore corrupt state.json */
    }
  }

  const signalsDir = join(root, '.pantheon', 'deepwork', 'board-signals')
  if (existsSync(signalsDir)) {
    try {
      for (const file of readdirSync(signalsDir)) {
        if (!file.endsWith('.signal.json')) continue
        try {
          const sig = JSON.parse(readFileSync(join(signalsDir, file), 'utf8')) as {
            jobId?: string
            agent?: string
            status?: string
            cost?: number
          }
          const id = sig.jobId ?? file.replace('.signal.json', '')
          if (seenJobIds.has(id)) continue
          seenJobIds.add(id)
          activeJobs.push({
            id,
            agent: sig.agent ?? 'specialist',
            status: sig.status ?? 'completed',
            cost: typeof sig.cost === 'number' ? sig.cost : 0,
          })
        } catch {
          /* ignore malformed signal */
        }
      }
    } catch {
      /* ignore */
    }
  }

  const childSessions = await readOpenCodeChildSessions(root)
  for (const child of childSessions) {
    if (seenJobIds.has(child.id)) continue
    seenJobIds.add(child.id)
    activeJobs.push(child)
  }

  // Track subagent:start / subagent:stop & ephemeral:worker telemetry events
  // when no explicit job record exists for that call/worker.
  const eventJobIndex = new Map<string, number>()
  for (const ev of events) {
    const kind = ev.kind ?? ev.type ?? ''
    if (kind !== 'subagent:start' && kind !== 'subagent:stop' && kind !== 'ephemeral:worker') {
      continue
    }
    const agent = typeof ev.agent === 'string' && ev.agent ? ev.agent : 'subagent'
    const key = ev.stepKey || ev.threadId || `${agent}:${ev.timestamp}`
    if (seenJobIds.has(key)) continue
    const status =
      kind === 'subagent:start' ? 'running' : ev.severity === 'error' ? 'error' : 'completed'
    const existingIdx = eventJobIndex.get(key)
    if (existingIdx !== undefined) {
      const existing = activeJobs[existingIdx]
      if (existing) existing.status = status
    } else {
      eventJobIndex.set(key, activeJobs.length)
      activeJobs.push({ id: key, agent, status, cost: 0 })
    }
  }

  let overridesCount = 0
  let effectiveOverrides: EffectiveOverrides = {}
  const overridesPath = join(root, '.pantheon', 'overrides.json')
  if (existsSync(overridesPath)) {
    try {
      const ov = JSON.parse(readFileSync(overridesPath, 'utf8')) as unknown
      if (ov && typeof ov === 'object' && !Array.isArray(ov)) {
        effectiveOverrides = ov as EffectiveOverrides
        overridesCount = Object.keys(ov).length
      }
    } catch {
      /* ignore */
    }
  }
  const behaviors: BehaviorSettingItem[] = SETTINGS_BEHAVIORS.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    kind: b.kind,
    enabled: !isBehaviorDisabled(effectiveOverrides, b.id),
  }))

  let gateMode = 'shadow'
  const settingsPath = join(root, '.pantheon', 'cockpit-settings.json')
  if (existsSync(settingsPath)) {
    try {
      const cfg = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
      if (typeof cfg.gateMode === 'string' && cfg.gateMode) {
        gateMode = cfg.gateMode
      }
    } catch {
      /* ignore */
    }
  }

  const globalPreset = readActivePresetMarker(globalActivePresetPath())
  const projectPreset = readActivePresetMarker(join(root, '.pantheon', 'active-preset.json'))
  const activePreset = projectPreset?.name ?? globalPreset?.name ?? PRESET_NONE
  const presetProjectOverride = projectPreset?.name ?? null

  const decisionRead = readDecisionRouterConfig()
  const decisionEnabled = decisionRead.config.enabled
  const decisionMode = decisionRead.config.selection.mode

  let artifactsCount = 0
  const plansDir = join(root, '.pantheon', 'plans')
  if (existsSync(plansDir)) {
    try {
      artifactsCount = readdirSync(plansDir).filter((f) => f.endsWith('.md')).length
    } catch {
      /* ignore */
    }
  }

  const { todayCostUSD, monthCostUSD } = await readOpenCodeCosts()

  return {
    messages,
    events,
    activeJobs,
    todayCostUSD,
    monthCostUSD,
    overridesCount,
    gateMode,
    artifactsCount,
    activePreset,
    presetProjectOverride,
    decisionEnabled,
    decisionMode,
    behaviors,
  }
}

function appendBoardMessageToDisk(payloadRaw: string): string {
  try {
    const payload = JSON.parse(payloadRaw) as {
      directory?: string
      body?: string
      channel?: string
    }
    const root = payload.directory?.trim() || process.cwd()
    const body = String(payload.body ?? '').trim()
    if (!body) return JSON.stringify({ ok: false, error: 'Empty message' })

    const boardDir = join(root, '.pantheon', 'board')
    mkdirSync(boardDir, { recursive: true })
    const msgPath = join(boardDir, 'messages.ndjson')
    const existing = readNdjsonLines<BoardMsg>(msgPath, 500)
    const nextSeq = existing.length > 0 ? (existing[existing.length - 1]?.seq ?? 0) + 1 : 1
    const mentions = [...body.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((m) => `@${m[1]}`)

    const record: BoardMsg = {
      seq: nextSeq,
      timestamp: Date.now(),
      channel: payload.channel?.trim() || 'default',
      from: 'user',
      mentions,
      tag: 'note',
      body,
    }
    appendFileSync(msgPath, `${JSON.stringify(record)}\n`, 'utf8')
    return JSON.stringify({ ok: true, seq: nextSeq })
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to post board message',
    })
  }
}

function saveSettingsToDisk(payloadRaw: string): string {
  try {
    const payload = JSON.parse(payloadRaw) as {
      directory?: string
      gateMode?: string
      preset?: string
      toggleBehaviorId?: string
      decisionEnabled?: boolean
    }
    const root = payload.directory?.trim() || process.cwd()
    const pantheonDir = join(root, '.pantheon')
    mkdirSync(pantheonDir, { recursive: true })

    if (typeof payload.gateMode === 'string') {
      const settingsPath = join(pantheonDir, 'cockpit-settings.json')
      let current: Record<string, unknown> = {}
      if (existsSync(settingsPath)) {
        try {
          const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            current = parsed as Record<string, unknown>
          }
        } catch {
          current = {}
        }
      }
      current.gateMode = payload.gateMode
      const tmpPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmpPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, settingsPath)
    }

    if (typeof payload.preset === 'string') {
      const globalPath = globalActivePresetPath()
      if (payload.preset === PRESET_NONE) {
        clearActivePreset(globalPath)
      } else {
        writeActivePreset(globalPath, payload.preset)
      }
    }

    if (typeof payload.toggleBehaviorId === 'string' && payload.toggleBehaviorId) {
      const overridesPath = join(pantheonDir, 'overrides.json')
      let current: EffectiveOverrides = {}
      if (existsSync(overridesPath)) {
        const parsed = JSON.parse(readFileSync(overridesPath, 'utf8')) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return JSON.stringify({
            ok: false,
            error: 'overrides.json is not a valid object; refusing to overwrite',
          })
        }
        current = parsed as EffectiveOverrides
      }
      const next = toggledOverrides(current, payload.toggleBehaviorId, 'toggled in Pantheon GUI')
      const tmpPath = `${overridesPath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, overridesPath)
    }

    if (typeof payload.decisionEnabled === 'boolean') {
      const read = readDecisionRouterConfig()
      if (read.corrupt) {
        return JSON.stringify({
          ok: false,
          error: 'Decision router config is corrupt; refusing to overwrite',
        })
      }
      const next = setDecisionEnabled(read.config, payload.decisionEnabled)
      if (!next.ok) {
        return JSON.stringify({ ok: false, error: next.reason })
      }
      writeDecisionRouterConfig(next.config)
    }

    return JSON.stringify({ ok: true })
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to save cockpit settings',
    })
  }
}

type GuiSubTab = 'topology' | 'board' | 'ephemeral' | 'settings'

const [sharedSnapshot, setSharedSnapshot] = createSignal<GuiSnapshot>({
  messages: [],
  events: [],
  activeJobs: [],
  todayCostUSD: 0,
  monthCostUSD: 0,
  overridesCount: 0,
  gateMode: 'shadow',
  artifactsCount: 0,
  activePreset: PRESET_NONE,
  presetProjectOverride: null,
  decisionEnabled: false,
  decisionMode: 'local',
  behaviors: SETTINGS_BEHAVIORS.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    kind: b.kind,
    enabled: true,
  })),
})

const [activeDirectory, setActiveDirectory] = createSignal('')
const [uiError, setUiError] = createSignal<string | null>(null)

function resolveActiveDirectory(ctx: SetupContext<any>, explicit?: () => string): string {
  const direct = explicit?.().trim()
  if (direct) return direct
  const session = ctx.sessions.current() as
    | { directory?: string; location?: { directory?: string } }
    | undefined
  const sessionDir = session?.directory?.trim() || session?.location?.directory?.trim() || ''
  if (sessionDir) return sessionDir
  return activeDirectory().trim()
}

function PantheonCockpitView(props: { ctx: SetupContext<any>; directory: () => string }) {
  const [subTab, setSubTab] = createSignal<GuiSubTab>('topology')
  const [topoView, setTopoView] = createSignal<'dag' | 'gantt'>('dag')
  const [scrubberSeq, setScrubberSeq] = createSignal<number | null>(null)
  const [draftMsg, setDraftMsg] = createSignal('')
  const [draftChannel, setDraftChannel] = createSignal('default')

  const effectiveDirectory = () => resolveActiveDirectory(props.ctx, props.directory)

  const refresh = async () => {
    try {
      const dir = effectiveDirectory()
      if (dir) setActiveDirectory(dir)
      const raw = await props.ctx.main(PantheonBridge).snapshot(dir)
      setSharedSnapshot(JSON.parse(raw) as GuiSnapshot)
    } catch {
      /* fail-open when main process bridge is unavailable (e.g. Web) */
    }
  }

  const sendBoardMsg = async () => {
    const body = draftMsg().trim()
    if (!body) return
    try {
      const raw = await props.ctx.main(PantheonBridge).postBoardMessage(
        JSON.stringify({
          directory: effectiveDirectory(),
          channel: draftChannel(),
          body,
        }),
      )
      const res = JSON.parse(raw) as { ok?: boolean; error?: string }
      if (res.ok === false) {
        setUiError(res.error ?? 'Failed to post board message')
        return
      }
      setUiError(null)
      setDraftMsg('')
      await refresh()
    } catch (err) {
      setUiError(err instanceof Error ? err.message : 'Board IPC unavailable')
    }
  }

  createEffect(() => {
    const dir = effectiveDirectory()
    if (dir) setActiveDirectory(dir)
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    onCleanup(() => clearInterval(timer))
  })

  const maxSeq = createMemo(() => {
    const msgs = sharedSnapshot().messages
    return msgs.length > 0 ? (msgs[msgs.length - 1]?.seq ?? 0) : 0
  })

  const visibleMessages = createMemo(() => {
    const cap = scrubberSeq()
    const msgs = sharedSnapshot().messages
    return cap === null ? msgs : msgs.filter((m) => m.seq <= cap)
  })

  const ephemeralWorkers = createMemo(() =>
    visibleMessages().filter((m) => m.ephemeral !== undefined),
  )

  const subagentEvents = createMemo(() =>
    sharedSnapshot().events.filter((ev) => {
      const kind = ev.kind ?? ev.type ?? ''
      return (
        kind === 'subagent:start' ||
        kind === 'subagent:stop' ||
        kind === 'ephemeral:worker' ||
        kind === 'review:verdict' ||
        kind === 'agent:execution:receipt'
      )
    }),
  )

  const uniqueAgents = createMemo(() => {
    const set = new Set<string>(['zeus'])
    for (const m of visibleMessages()) {
      if (m.from && m.from !== 'user') set.add(m.from)
    }
    for (const j of sharedSnapshot().activeJobs) {
      if (j.agent) set.add(j.agent)
    }
    for (const ev of sharedSnapshot().events) {
      const agent = ev.agent?.trim()
      if (agent && agent !== 'pantheon' && agent !== 'ledger' && agent !== 'user') {
        set.add(agent)
      }
    }
    return [...set].slice(0, 10)
  })

  const totalCost = createMemo(() =>
    sharedSnapshot().activeJobs.reduce((sum, j) => sum + (Number.isFinite(j.cost) ? j.cost : 0), 0),
  )

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '10px',
        padding: '12px',
        'font-size': '12px',
        height: '100%',
        overflow: 'auto',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          'border-bottom': '1px solid var(--border-weak-base, #2e2e32)',
          'padding-bottom': '8px',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <span style={{ 'font-weight': 600 }}>Pantheon Cockpit</span>
          <span style={{ opacity: 0.7 }}>{`v${resolveRunningVersion()}`}</span>
        </div>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <span style={{ opacity: 0.8 }}>
            {`${sharedSnapshot().activeJobs.filter((j) => j.status === 'running').length} active · $${totalCost().toFixed(2)}`}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            style={{
              padding: '2px 8px',
              'border-radius': '4px',
              border: '1px solid var(--border-weak-base, #3f3f46)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Error banner */}
      <Show when={uiError() !== null}>
        <div
          style={{
            display: 'flex',
            'justify-content': 'space-between',
            'align-items': 'center',
            padding: '6px 8px',
            'border-radius': '4px',
            border: '1px solid #ef4444',
            color: '#fca5a5',
          }}
        >
          <span>{uiError()}</span>
          <button
            type="button"
            onClick={() => setUiError(null)}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      </Show>

      {/* Sub-tabs */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          'border-bottom': '1px solid var(--border-weak-base, #2e2e32)',
        }}
      >
        {(
          [
            ['topology', 'Topology & Timeline'],
            ['board', `Agora Board (${sharedSnapshot().messages.length})`],
            ['ephemeral', `Ephemeral & Bots (${sharedSnapshot().activeJobs.length})`],
            ['settings', 'Settings & Cost'],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            onClick={() => setSubTab(id)}
            style={{
              padding: '4px 2px 8px',
              border: 'none',
              'border-bottom': subTab() === id ? '2px solid #fba970' : '2px solid transparent',
              background: 'transparent',
              color: 'inherit',
              opacity: subTab() === id ? 1 : 0.65,
              'font-weight': subTab() === id ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab 1: Olympus Topology (DAG + Timeline) */}
      <Show when={subTab() === 'topology'}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
          <div
            style={{
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'center',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <input
                type="range"
                min={0}
                max={Math.max(1, maxSeq())}
                value={scrubberSeq() ?? maxSeq()}
                onInput={(e) => {
                  const val = Number(e.currentTarget.value)
                  setScrubberSeq(val >= maxSeq() ? null : val)
                }}
              />
              <span style={{ opacity: 0.75 }}>
                {scrubberSeq() === null
                  ? `#${maxSeq()} · Live`
                  : `#${scrubberSeq()} / ${maxSeq()} · Replay`}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                onClick={() => setTopoView('dag')}
                style={{
                  padding: '2px 8px',
                  'border-radius': '4px',
                  border: '1px solid var(--border-weak-base, #3f3f46)',
                  background: topoView() === 'dag' ? '#fba970' : 'transparent',
                  color: topoView() === 'dag' ? '#111' : 'inherit',
                  cursor: 'pointer',
                }}
              >
                DAG Pillars
              </button>
              <button
                type="button"
                onClick={() => setTopoView('gantt')}
                style={{
                  padding: '2px 8px',
                  'border-radius': '4px',
                  border: '1px solid var(--border-weak-base, #3f3f46)',
                  background: topoView() === 'gantt' ? '#fba970' : 'transparent',
                  color: topoView() === 'gantt' ? '#111' : 'inherit',
                  cursor: 'pointer',
                }}
              >
                Timeline
              </button>
            </div>
          </div>

          <Show
            when={topoView() === 'dag'}
            fallback={
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                <For each={uniqueAgents()}>
                  {(agent, idx) => (
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                      <span style={{ width: '96px', 'font-family': 'monospace' }}>{agent}</span>
                      <div
                        style={{
                          flex: 1,
                          height: '10px',
                          background: 'rgba(128,128,128,0.18)',
                          'border-radius': '4px',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.max(20, 95 - idx() * 15)}%`,
                            background: agent === 'zeus' ? '#fba970' : '#38bdf8',
                          }}
                        />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            }
          >
            <svg viewBox="0 0 640 200" style={{ width: '100%', height: '200px' }}>
              <title>Olympus Topology DAG</title>
              <rect
                x="245"
                y="10"
                width="150"
                height="36"
                rx="6"
                fill="none"
                stroke="#fba970"
                stroke-width="2"
              />
              <text
                x="320"
                y="32"
                text-anchor="middle"
                fill="currentColor"
                font-size="12"
                font-weight="600"
              >
                zeus (root)
              </text>
              <For each={uniqueAgents().filter((a) => a !== 'zeus')}>
                {(agent, idx) => {
                  const count = Math.max(1, uniqueAgents().length - 1)
                  const x = 20 + (idx() * 600) / count
                  const cx = x + 55
                  return (
                    <g>
                      <path
                        d={`M 320 46 C 320 78, ${cx} 72, ${cx} 104`}
                        fill="none"
                        stroke="#38bdf8"
                        stroke-width="1.5"
                      />
                      <rect
                        x={x}
                        y="104"
                        width="110"
                        height="40"
                        rx="6"
                        fill="none"
                        stroke="#38bdf8"
                        stroke-width="1.4"
                      />
                      <text x={cx} y="128" text-anchor="middle" fill="currentColor" font-size="11">
                        {agent}
                      </text>
                    </g>
                  )
                }}
              </For>
            </svg>
          </Show>
        </div>
      </Show>

      {/* Tab 2: Interactive Agora Board */}
      <Show when={subTab() === 'board'}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              placeholder="Channel"
              value={draftChannel()}
              onInput={(e) => setDraftChannel(e.currentTarget.value)}
              style={{
                width: '90px',
                padding: '4px 6px',
                'border-radius': '4px',
                border: '1px solid var(--border-weak-base, #3f3f46)',
                background: 'transparent',
                color: 'inherit',
              }}
            />
            <input
              type="text"
              placeholder="Post message to Agora Board (@agent)..."
              value={draftMsg()}
              onInput={(e) => setDraftMsg(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void sendBoardMsg()
              }}
              style={{
                flex: 1,
                padding: '4px 8px',
                'border-radius': '4px',
                border: '1px solid var(--border-weak-base, #3f3f46)',
                background: 'transparent',
                color: 'inherit',
              }}
            />
            <button
              type="button"
              onClick={() => void sendBoardMsg()}
              style={{
                padding: '4px 10px',
                'border-radius': '4px',
                border: 'none',
                background: '#fba970',
                color: '#111',
                'font-weight': 600,
                cursor: 'pointer',
              }}
            >
              Send
            </button>
          </div>
          <For
            each={[...visibleMessages()].reverse().slice(0, 20)}
            fallback={<div style={{ opacity: 0.6 }}>No board messages recorded yet.</div>}
          >
            {(msg) => (
              <div
                style={{
                  padding: '8px',
                  'border-radius': '6px',
                  border: '1px solid var(--border-weak-base, #2e2e32)',
                }}
              >
                <div style={{ display: 'flex', 'justify-content': 'space-between', opacity: 0.75 }}>
                  <span>{`#${msg.seq} ${msg.from}${msg.mentions.length ? ` → ${msg.mentions.join(', ')}` : ''}`}</span>
                  <span>{msg.tag ?? ''}</span>
                </div>
                <div style={{ 'margin-top': '4px' }}>{msg.body}</div>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Tab 3: Ephemeral & Bots */}
      <Show when={subTab() === 'ephemeral'}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <For
            each={sharedSnapshot().activeJobs}
            fallback={
              <Show when={subagentEvents().length === 0}>
                <div style={{ opacity: 0.6 }}>No active background jobs or subagent runs.</div>
              </Show>
            }
          >
            {(job) => (
              <div
                style={{
                  display: 'flex',
                  'justify-content': 'space-between',
                  padding: '8px',
                  'border-radius': '6px',
                  border: '1px solid var(--border-weak-base, #2e2e32)',
                }}
              >
                <span>{`${job.agent} (${job.id.slice(0, 8)})`}</span>
                <span>{`${job.status} · $${job.cost.toFixed(3)}`}</span>
              </div>
            )}
          </For>
          <For each={ephemeralWorkers().slice(-6)}>
            {(msg) => (
              <div style={{ opacity: 0.8 }}>
                {`◈ ${msg.ephemeral?.role ?? msg.from} [${msg.ephemeral?.status ?? 'active'}]`}
              </div>
            )}
          </For>
          <For each={[...subagentEvents()].reverse().slice(0, 10)}>
            {(ev) => (
              <div
                style={{
                  display: 'flex',
                  'justify-content': 'space-between',
                  padding: '6px 8px',
                  'border-radius': '6px',
                  border: '1px solid var(--border-weak-base, #2e2e32)',
                  opacity: 0.85,
                }}
              >
                <span>{`${ev.agent ?? 'subagent'} · ${ev.kind ?? ev.type ?? 'event'}`}</span>
                <span style={{ opacity: 0.75 }}>{ev.detail ?? ''}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Tab 4: Settings & Cost */}
      <Show when={subTab() === 'settings'}>
        <PantheonSettingsControls
          ctx={props.ctx}
          directory={effectiveDirectory}
          onSaved={refresh}
        />
      </Show>
    </div>
  )
}

function PantheonSettingsControls(props: {
  ctx: SetupContext<any>
  directory: () => string
  onSaved: () => Promise<void>
}) {
  const savePatch = async (patch: {
    gateMode?: string
    preset?: string
    toggleBehaviorId?: string
    decisionEnabled?: boolean
  }) => {
    try {
      const raw = await props.ctx.main(PantheonBridge).saveSettings(
        JSON.stringify({
          directory: props.directory(),
          ...patch,
        }),
      )
      const res = JSON.parse(raw) as { ok?: boolean; error?: string }
      if (res.ok === false) {
        setUiError(res.error ?? 'Failed to save settings')
        return
      }
      setUiError(null)
      await props.onSaved()
    } catch (err) {
      setUiError(err instanceof Error ? err.message : 'Settings IPC unavailable')
    }
  }

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          padding: '8px',
          'border-radius': '6px',
          border: '1px solid var(--border-weak-base, #2e2e32)',
        }}
      >
        <span>OpenCode Spend (Today / 30d)</span>
        <span style={{ 'font-family': 'monospace' }}>
          {`$${sharedSnapshot().todayCostUSD.toFixed(2)} / $${sharedSnapshot().monthCostUSD.toFixed(2)}`}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          gap: '8px',
          padding: '8px',
          'border-radius': '6px',
          border: '1px solid var(--border-weak-base, #2e2e32)',
        }}
      >
        <span>Auto-Permissions Gate</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['shadow', 'enforce', 'off'] as const).map((mode) => (
            <button
              type="button"
              onClick={() => void savePatch({ gateMode: mode })}
              style={{
                padding: '2px 8px',
                'border-radius': '4px',
                border: '1px solid var(--border-weak-base, #3f3f46)',
                background: sharedSnapshot().gateMode === mode ? '#fba970' : 'transparent',
                color: sharedSnapshot().gateMode === mode ? '#111' : 'inherit',
                'font-family': 'monospace',
                'font-weight': sharedSnapshot().gateMode === mode ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '6px',
          padding: '8px',
          'border-radius': '6px',
          border: '1px solid var(--border-weak-base, #2e2e32)',
        }}
      >
        <div
          style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}
        >
          <span>Model Preset (Global)</span>
          <span style={{ opacity: 0.7, 'font-family': 'monospace' }}>
            {sharedSnapshot().presetProjectOverride
              ? `project: ${sharedSnapshot().presetProjectOverride}`
              : sharedSnapshot().activePreset}
          </span>
        </div>
        <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '4px' }}>
          {[PRESET_NONE, ...PRESET_NAMES].map((preset) => (
            <button
              type="button"
              onClick={() => void savePatch({ preset })}
              style={{
                padding: '2px 8px',
                'border-radius': '4px',
                border: '1px solid var(--border-weak-base, #3f3f46)',
                background: sharedSnapshot().activePreset === preset ? '#fba970' : 'transparent',
                color: sharedSnapshot().activePreset === preset ? '#111' : 'inherit',
                'font-family': 'monospace',
                'font-weight': sharedSnapshot().activePreset === preset ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          padding: '8px',
          'border-radius': '6px',
          border: '1px solid var(--border-weak-base, #2e2e32)',
        }}
      >
        <span>{`Decision Router (${sharedSnapshot().decisionMode})`}</span>
        <button
          type="button"
          onClick={() => void savePatch({ decisionEnabled: !sharedSnapshot().decisionEnabled })}
          style={{
            padding: '2px 10px',
            'border-radius': '4px',
            border: '1px solid var(--border-weak-base, #3f3f46)',
            background: sharedSnapshot().decisionEnabled ? '#fba970' : 'transparent',
            color: sharedSnapshot().decisionEnabled ? '#111' : 'inherit',
            'font-family': 'monospace',
            cursor: 'pointer',
          }}
        >
          {sharedSnapshot().decisionEnabled ? 'enabled' : 'disabled'}
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '6px',
          padding: '8px',
          'border-radius': '6px',
          border: '1px solid var(--border-weak-base, #2e2e32)',
        }}
      >
        <div style={{ 'font-weight': 600 }}>Behavior Overrides</div>
        <For each={sharedSnapshot().behaviors}>
          {(beh) => (
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                gap: '8px',
              }}
            >
              <span style={{ opacity: 0.85 }}>{`${beh.title} (${beh.kind})`}</span>
              <button
                type="button"
                onClick={() => void savePatch({ toggleBehaviorId: beh.id })}
                style={{
                  padding: '2px 8px',
                  'border-radius': '4px',
                  border: '1px solid var(--border-weak-base, #3f3f46)',
                  background: 'transparent',
                  color: beh.enabled ? '#4ade80' : '#f87171',
                  'font-family': 'monospace',
                  cursor: 'pointer',
                }}
              >
                {beh.enabled ? 'on' : 'off'}
              </button>
            </div>
          )}
        </For>
      </div>

      <div style={{ opacity: 0.75, 'font-size': '11px' }}>
        {`Overrides: ${sharedSnapshot().overridesCount} · Plans: ${sharedSnapshot().artifactsCount} · Active jobs: ${sharedSnapshot().activeJobs.length}`}
      </div>
    </div>
  )
}

function PantheonSettingsView(props: { ctx: SetupContext<any> }) {
  const effectiveDirectory = () => resolveActiveDirectory(props.ctx)

  const refresh = async () => {
    try {
      const dir = effectiveDirectory()
      if (dir) setActiveDirectory(dir)
      const raw = await props.ctx.main(PantheonBridge).snapshot(dir)
      setSharedSnapshot(JSON.parse(raw) as GuiSnapshot)
    } catch (err) {
      setUiError(err instanceof Error ? err.message : 'Settings IPC unavailable')
    }
  }

  createEffect(() => {
    void effectiveDirectory()
    void refresh()
  })

  return (
    <div style={{ padding: '16px', display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
        <h2
          style={{ 'font-size': '16px', 'font-weight': 600 }}
        >{`Pantheon v${resolveRunningVersion()}`}</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          style={{
            padding: '2px 8px',
            'border-radius': '4px',
            border: '1px solid var(--border-weak-base, #3f3f46)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>
      <Show when={uiError() !== null}>
        <div
          style={{
            padding: '6px 8px',
            'border-radius': '4px',
            border: '1px solid #ef4444',
            color: '#fca5a5',
            'font-size': '12px',
          }}
        >
          {uiError()}
        </div>
      </Show>
      <PantheonSettingsControls ctx={props.ctx} directory={effectiveDirectory} onSaved={refresh} />
      <p style={{ 'font-size': '12px', opacity: 0.7 }}>
        Olympus Topology, interactive Agora Board, and Ephemeral Worker telemetry are active in the
        Pantheon side panel.
      </p>
    </div>
  )
}

export default Plugin.define({
  main(ctx) {
    ctx.provide(PantheonBridge, {
      snapshot: async (directory) => JSON.stringify(await readSnapshotFromDisk(directory)),
      postBoardMessage: (payload) => appendBoardMessageToDisk(payload),
      saveSettings: (payload) => saveSettingsToDisk(payload),
    })
  },
  setup(ctx) {
    const cockpitTab: PanelTab = {
      id: 'pantheon-cockpit',
      title: 'Pantheon',
      pinned: true,
    }

    const openCockpit = () => {
      const session = ctx.sessions.current()
      if (session) {
        ctx.layout.open(`${ctx.id}:pantheon-cockpit`, session, { tab: 'open' })
      } else {
        ctx.dialogs.open((dialog) => (
          <div style={{ padding: '12px' }}>
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'margin-bottom': '8px',
              }}
            >
              <strong>Pantheon Cockpit</strong>
              <button type="button" onClick={() => dialog.close()}>
                Close
              </button>
            </div>
            <PantheonCockpitView ctx={ctx} directory={() => resolveActiveDirectory(ctx)} />
          </div>
        ))
      }
    }

    ctx.add(Panel, () => ({
      id: 'cockpit',
      region: 'side' as const,
      wide: true,
      list: () => [cockpitTab],
      render: (props) => (
        <PantheonCockpitView
          ctx={ctx}
          directory={() => props.session?.directory ?? props.session?.location?.directory ?? ''}
        />
      ),
    }))

    ctx.add(ComposerPill, () => ({
      id: 'pantheon.status',
      show: () => {
        const running = sharedSnapshot().activeJobs.filter((j) => j.status === 'running').length
        return {
          label: running > 0 ? `Pantheon · ${running} active` : 'Pantheon · ready',
          tone: running > 0 ? 'success' : undefined,
          rows: [
            {
              id: 'open-cockpit',
              label: 'Open Pantheon Cockpit',
              detail: `${sharedSnapshot().messages.length} msgs`,
              run: openCockpit,
            },
            {
              id: 'open-settings',
              label: 'Open Pantheon Settings',
              detail: sharedSnapshot().gateMode,
              run: () => ctx.layout.settings('pantheon'),
            },
          ],
        }
      },
    }))

    ctx.add(SettingsPage, () => ({
      id: 'pantheon',
      title: 'Pantheon',
      entries: [
        {
          id: 'pantheon.overview',
          title: 'Pantheon Orchestration',
          description: 'Multi-agent Olympus Topology, Ephemeral Workers, and Cockpit Settings',
          keywords: 'pantheon cockpit swarm ephemeral todo',
        },
      ],
      render: () => <PantheonSettingsView ctx={ctx} />,
    }))

    ctx.add(Command, () => ({
      id: 'cockpit',
      title: 'Open Pantheon Cockpit',
      description: 'Open Olympus Topology, Agora Board, and Ephemeral Workers',
      slash: { name: 'pantheon-cockpit' },
      run: openCockpit,
    }))

    ctx.add(Command, () => ({
      id: 'settings',
      title: 'Open Pantheon Settings',
      description: 'Open Pantheon Desktop Settings page',
      slash: { name: 'pantheon-settings' },
      run: () => {
        ctx.layout.settings('pantheon')
      },
    }))
  },
})
