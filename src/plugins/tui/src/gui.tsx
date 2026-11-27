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

import { execFile } from 'node:child_process'
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
import { dirname, join } from 'node:path'
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

const KNOWN_AGENTS = [
  'zeus',
  'athena',
  'apollo',
  'hermes',
  'aphrodite',
  'demeter',
  'themis',
  'iris',
] as const

import {
  COOLDOWN_MS_CYCLE,
  DEFAULT_DECISION_BUDGETS,
  DEFAULT_GOAL_LOOP_PREFS,
  type DecisionBudgets,
  formatUsd,
  type GoalLoopPrefs,
  MAX_CONTINUATIONS_CYCLE,
  MONTHLY_USD_CYCLE,
  PER_DECISION_USD_CYCLE,
  parseUsd,
} from './autonomy-state'
import {
  computeRadialHubLayout,
  computeTidyDagLayout,
  type TidyDagNodeStatus,
} from './cockpit-state'
import { queryUsageHistory } from './cost-data'
import {
  applyDecisionRow,
  credentialStatus,
  DECISION_KNOWN_PROVIDERS,
  DECISION_PROVIDER_CREDENTIALS,
  DECISION_SELECTION_CYCLE,
  DECISION_TARGET_CYCLE,
  type DecisionCandidate,
  readDecisionRouterConfig,
  setDecisionEnabled,
  writeDecisionRouterConfig,
} from './decision-router-state'
import {
  classifyDecisionConfigHealth,
  classifyInstallVersion,
  classifyOverridesHealth,
  isSupportedNodeFloor,
  MIN_SUPPORTED_NODE_VERSION,
} from './doctor-state'
import { J1_FLAG_ENV, J1_THRESHOLD_ENV, j1ModeFromEnv, j1ThresholdFromEnv } from './j1-gate-status'
import {
  cleanLegacyArtifacts,
  formatBytes,
  type LegacyAuditSummary,
  purgeAllPantheonData,
  scanLegacyArtifacts,
} from './legacy-audit'
import {
  buildAboutTab,
  type ChangelogHighlightItem,
  canWriteOverrides,
  type EffectiveOverrides,
  isBehaviorDisabled,
  mergedOverrides,
  type OverridesLoad,
  type OverridesScope,
  SETTINGS_BEHAVIORS,
  serializeOverrides,
  setOverrideState,
} from './pantheon-settings-state'
import {
  clearActivePreset,
  globalActivePresetPath,
  PRESET_NAMES,
  PRESET_NONE,
  readActivePresetMarker,
  readConfiguredVisionModel,
  VISION_MODEL_OPTIONS,
  writeActivePreset,
  writeConfiguredVisionModel,
} from './preset-state'
import { resolveLanguage } from './settings-i18n'
import {
  applyTuiRow,
  DEFAULT_TUI_PREFS,
  LANGUAGE_CYCLE,
  normalizeTuiPrefs,
  type TuiPrefs,
} from './tui-prefs'
import {
  isNewerUpdateAvailable,
  nextCheckState,
  type UpdateCheckState,
  withKnownLatest,
} from './update-notice'
import { registryUrlForChannel, type UpdateChannel, updateChannelFor } from './update-status'
import { extractHighlights, readChangelogForBundle } from './whats-new-highlights'

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
  replyToSeq?: number
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
  baseAgent?: string
  role?: string
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
  projectOverride: boolean
}

interface ModelSpendItem {
  providerID: string
  modelID: string
  tokens: number
  estimatedUsd?: number
  rows: number
}

interface AgentModelOverrideItem {
  agent: string
  model: string
  variant: string
}

interface CredentialStatusItem {
  provider: string
  status: string
  note: string
}

interface DoctorHealthSnapshot {
  installVersion: string
  installStatus: string
  nodeVersion: string
  nodeSupported: boolean
  overridesStatus: string
  overridesUnknownCount: number
  decisionStatus: string
}

interface GuiSnapshot {
  messages: BoardMsg[]
  events: CockpitEvent[]
  activeJobs: Array<{ id: string; agent: string; status: string; cost: number }>
  todayCostUSD: number
  monthCostUSD: number
  modelSpend: ModelSpendItem[]
  overridesCount: number
  corruptGlobalOverrides: boolean
  gateMode: string
  cockpitAutoOpen: boolean
  cockpitShowTodo: boolean
  artifactsCount: number
  activePreset: string
  presetProjectOverride: string | null
  visionModel: string
  agentModels: AgentModelOverrideItem[]
  decisionEnabled: boolean
  decisionMode: string
  decisionTarget: string
  decisionConsent: boolean
  decisionCorrupt: boolean
  decisionCandidates: DecisionCandidate[]
  credentials: CredentialStatusItem[]
  goalLoop: GoalLoopPrefs
  goalLoopRestartPending: boolean
  budgets: DecisionBudgets
  j1Mode: string
  j1Threshold: number
  j1DisabledByOverride: boolean
  tuiPrefs: TuiPrefs
  updateChannel: UpdateChannel
  lastUpdateCheckMs: number | null
  latestVersion: string | null
  legacyAudit: LegacyAuditSummary | null
  doctor: DoctorHealthSnapshot
  changelogHighlights: ChangelogHighlightItem[]
  aboutToolGroups: Array<{ name: string; value: string; note: string }>
  behaviorsGlobal: BehaviorSettingItem[]
  behaviorsProject: BehaviorSettingItem[]
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
    runAction: {
      input: Schema.String,
      output: Schema.String,
    },
  },
})

function readNdjsonLines<T>(filePath: string, limit = 80): T[] {
  if (!existsSync(filePath)) return []
  try {
    const raw = readFileSync(filePath, 'utf8')
    const lines = raw.trim().split(/\r?\n/).filter(Boolean)
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

const COST_CACHE_TTL_MS = 10_000
let guiCachedCosts: {
  todayCostUSD: number
  monthCostUSD: number
  modelSpend: ModelSpendItem[]
  fetchedAt: number
} | null = null

async function readOpenCodeCosts(): Promise<{
  todayCostUSD: number
  monthCostUSD: number
  modelSpend: ModelSpendItem[]
}> {
  const dbPaths = resolveOpenCodeDbPaths()
  if (dbPaths.length === 0) return { todayCostUSD: 0, monthCostUSD: 0, modelSpend: [] }

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

      let modelSpend: ModelSpendItem[] = []
      try {
        const usage = await queryUsageHistory(dbPath, '30d', { now })
        modelSpend = usage.models
          .map((m) => ({
            providerID: m.providerID,
            modelID: m.modelID,
            tokens: m.totals.total,
            ...(m.estimatedUsd !== undefined ? { estimatedUsd: m.estimatedUsd } : {}),
            rows: m.rows,
          }))
          .sort((a, b) => (b.estimatedUsd ?? 0) - (a.estimatedUsd ?? 0) || b.tokens - a.tokens)
          .slice(0, 8)
      } catch {
        modelSpend = []
      }

      return { todayCostUSD, monthCostUSD, modelSpend }
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
  return { todayCostUSD: 0, monthCostUSD: 0, modelSpend: [] }
}

function normalizeDirForCompare(dir: string): string {
  return dir.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
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

  const normalizedRoot = normalizeDirForCompare(rootDirectory)
  for (const dbPath of dbPaths) {
    const db = await openSqliteReadOnly(dbPath)
    if (!db) continue
    try {
      const existingTables = new Set(
        (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session')",
            )
            .all() as Array<{ name?: unknown }>
        ).map((r) => String(r.name)),
      )
      const collected: GuiSnapshot['activeJobs'] = []
      const seenIds = new Set<string>()
      const now = Date.now()

      for (const table of ['session_v2', 'session'] as const) {
        if (!existingTables.has(table)) continue
        const cols = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).map((c) =>
            String(c.name),
          ),
        )
        if (!cols.has('id') || !cols.has('parent_id')) continue

        const timeCol = cols.has('time_updated')
          ? 'time_updated'
          : cols.has('time_created')
            ? 'time_created'
            : null
        const selectCols = [
          'id',
          'parent_id',
          cols.has('agent') ? 'agent' : 'NULL AS agent',
          cols.has('title') ? 'title' : "'' AS title",
          cols.has('directory') ? 'directory' : "'' AS directory",
          timeCol ? `${timeCol} AS time_updated` : '0 AS time_updated',
          cols.has('time_archived') ? 'time_archived' : 'NULL AS time_archived',
        ].join(', ')
        const orderClause = timeCol ? `ORDER BY ${timeCol} DESC` : 'ORDER BY rowid DESC'

        const rows = db
          .prepare(
            `SELECT ${selectCols} FROM ${table}
             WHERE parent_id IS NOT NULL AND parent_id != ''
             ${orderClause} LIMIT 30`,
          )
          .all() as Array<{
          id?: unknown
          parent_id?: unknown
          agent?: unknown
          title?: unknown
          directory?: unknown
          time_updated?: unknown
          time_archived?: unknown
        }>

        const filtered =
          normalizedRoot && cols.has('directory')
            ? rows.filter((r) => {
                const dir =
                  typeof r.directory === 'string' ? normalizeDirForCompare(r.directory) : ''
                return !dir || dir === normalizedRoot
              })
            : rows

        for (const r of filtered) {
          if (typeof r.id !== 'string' || !r.id || seenIds.has(r.id)) continue
          seenIds.add(r.id)
          const updated = Number(r.time_updated ?? 0)
          const archived = r.time_archived !== null && r.time_archived !== undefined
          const isRecentActive = !archived && Number.isFinite(updated) && now - updated < 30_000
          const explicitAgent =
            typeof r.agent === 'string' && r.agent.trim() ? r.agent.trim().toLowerCase() : ''
          collected.push({
            id: r.id,
            agent: explicitAgent || extractAgentFromSessionTitle(r.title),
            status: isRecentActive ? 'running' : 'completed',
            cost: 0,
          })
        }
      }
      if (collected.length > 0) return collected
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

function atomicWriteFile(filePath: string, content: string, mode?: number): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, content, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8')
  renameSync(tmpPath, filePath)
}

function xdgConfigRoot(): string {
  return process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? homedir(), '.config')
}

function globalOverridesPath(): string {
  return join(xdgConfigRoot(), 'opencode', 'pantheon-overrides.json')
}

function projectOverridesPath(workspaceDir: string): string {
  return join(workspaceDir, '.pantheon', 'overrides.json')
}

function readOneOverrides(filePath: string): { value: EffectiveOverrides; corrupt: boolean } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { value: {}, corrupt: true }
    }
    return { value: parsed as EffectiveOverrides, corrupt: false }
  } catch (error) {
    return { value: {}, corrupt: (error as NodeJS.ErrnoException)?.code !== 'ENOENT' }
  }
}

function readOverridesLoad(workspaceDir: string): OverridesLoad {
  const globalRead = readOneOverrides(globalOverridesPath())
  const projectRead = readOneOverrides(projectOverridesPath(workspaceDir))
  return {
    global: globalRead.value,
    project: projectRead.value,
    corruptGlobal: globalRead.corrupt,
  }
}

function userOpenCodeConfigPath(): string {
  return join(xdgConfigRoot(), 'opencode', 'opencode.json')
}

function readGoalLoopPrefs(): GoalLoopPrefs {
  const fallback = { ...DEFAULT_GOAL_LOOP_PREFS }
  try {
    const parsed = JSON.parse(readFileSync(userOpenCodeConfigPath(), 'utf8')) as {
      options?: { goal_loop?: Partial<GoalLoopPrefs> }
    }
    const raw = parsed?.options?.goal_loop
    if (raw && typeof raw === 'object') {
      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
        cooldownMs:
          typeof raw.cooldownMs === 'number' && raw.cooldownMs >= 1000
            ? Math.floor(raw.cooldownMs)
            : fallback.cooldownMs,
        maxContinuations:
          typeof raw.maxContinuations === 'number' && raw.maxContinuations >= 1
            ? Math.min(200, Math.floor(raw.maxContinuations))
            : fallback.maxContinuations,
      }
    }
  } catch {
    /* fail-open */
  }
  return fallback
}

function writeUserOption(key: string, value: unknown): void {
  const filePath = userOpenCodeConfigPath()
  let doc: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) doc = parsed
  } catch {
    /* fresh object */
  }
  const options =
    typeof doc.options === 'object' && doc.options !== null && !Array.isArray(doc.options)
      ? { ...(doc.options as Record<string, unknown>) }
      : {}
  options[key] = value
  doc.options = options
  atomicWriteFile(filePath, `${JSON.stringify(doc, null, 2)}\n`)
}

function decisionRouterPath(): string {
  return join(xdgConfigRoot(), 'pantheon', 'decision-router.json')
}

function readDecisionBudgets(): DecisionBudgets {
  const fallback = { ...DEFAULT_DECISION_BUDGETS }
  try {
    const parsed = JSON.parse(readFileSync(decisionRouterPath(), 'utf8')) as {
      budget?: Partial<DecisionBudgets>
    }
    const raw = parsed?.budget
    if (raw && typeof raw === 'object') {
      return {
        monthlyUsd:
          typeof raw.monthlyUsd === 'number' && raw.monthlyUsd > 0
            ? raw.monthlyUsd
            : fallback.monthlyUsd,
        perDecisionUsd:
          typeof raw.perDecisionUsd === 'number' && raw.perDecisionUsd > 0
            ? raw.perDecisionUsd
            : fallback.perDecisionUsd,
      }
    }
  } catch {
    /* fail-open */
  }
  return fallback
}

function writeDecisionBudget(budgets: DecisionBudgets): void {
  const filePath = decisionRouterPath()
  let doc: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) doc = parsed
  } catch {
    throw new Error('decision-router.json unreadable — repair via `decision-router setup-model`')
  }
  doc.budget = { ...budgets }
  atomicWriteFile(filePath, `${JSON.stringify(doc, null, 2)}\n`, 0o600)
}

function readAuthProviders(): Set<string> {
  const names = new Set<string>()
  try {
    const xdgData =
      process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? homedir(), '.local', 'share')
    const parsed = JSON.parse(
      readFileSync(join(xdgData, 'opencode', 'auth.json'), 'utf8'),
    ) as Record<string, unknown>
    for (const key of Object.keys(parsed)) names.add(key)
  } catch {
    /* ignore */
  }
  return names
}

function readConfigProviders(): Set<string> {
  const names = new Set<string>()
  try {
    const parsed = JSON.parse(readFileSync(userOpenCodeConfigPath(), 'utf8')) as {
      providers?: Record<string, unknown>
    }
    for (const key of Object.keys(parsed?.providers ?? {})) names.add(key)
  } catch {
    /* ignore */
  }
  return names
}

function guiTuiPrefsPath(): string {
  return join(xdgConfigRoot(), 'opencode', '.pantheon', 'tui-prefs.json')
}

function readTuiPrefsFromDisk(): TuiPrefs {
  try {
    const parsed = JSON.parse(readFileSync(guiTuiPrefsPath(), 'utf8')) as unknown
    return normalizeTuiPrefs(parsed)
  } catch {
    return DEFAULT_TUI_PREFS
  }
}

function writeTuiPrefsToDisk(prefs: TuiPrefs): void {
  atomicWriteFile(guiTuiPrefsPath(), `${JSON.stringify(prefs, null, 2)}\n`)
}

function readAgentModelsFromDisk(workspaceDir: string): AgentModelOverrideItem[] {
  const candidates = [
    join(workspaceDir, '.pantheon', 'active-preset.json'),
    globalActivePresetPath(),
  ]
  const agentsMap: Record<
    string,
    { model?: unknown; variant?: unknown; reasoning_effort?: unknown }
  > = {}
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as {
        overrides?: {
          agents?: Record<
            string,
            { model?: unknown; variant?: unknown; reasoning_effort?: unknown }
          >
        }
      }
      const agents = raw?.overrides?.agents
      if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
        for (const [k, v] of Object.entries(agents)) {
          if (!agentsMap[k] && v && typeof v === 'object') agentsMap[k] = v
        }
      }
    } catch {
      /* ignore */
    }
  }
  return KNOWN_AGENTS.map((agent) => {
    const entry = agentsMap[agent]
    const model = typeof entry?.model === 'string' ? entry.model : ''
    const rawVariant =
      typeof entry?.variant === 'string'
        ? entry.variant
        : typeof entry?.reasoning_effort === 'string'
          ? entry.reasoning_effort
          : 'default'
    return { agent, model, variant: rawVariant }
  })
}

function writeAgentModelToDisk(
  workspaceDir: string,
  agent: string,
  model: string,
  variant: string,
): void {
  if (!KNOWN_AGENTS.includes(agent as (typeof KNOWN_AGENTS)[number])) {
    throw new Error(`Unknown canonical agent "${agent}"`)
  }
  const targetPath = join(workspaceDir, '.pantheon', 'active-preset.json')
  let doc: Record<string, unknown> = { version: 1, preset: PRESET_NONE, source: 'gui-settings' }
  if (existsSync(targetPath)) {
    try {
      const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>
      }
    } catch {
      /* keep default */
    }
  }
  const overrides =
    doc.overrides && typeof doc.overrides === 'object' && !Array.isArray(doc.overrides)
      ? { ...(doc.overrides as Record<string, unknown>) }
      : {}
  const agents =
    overrides.agents && typeof overrides.agents === 'object' && !Array.isArray(overrides.agents)
      ? { ...(overrides.agents as Record<string, unknown>) }
      : {}

  const trimmedModel = model.trim()
  if (!trimmedModel) {
    delete agents[agent]
  } else {
    const entry: Record<string, unknown> = { model: trimmedModel }
    if (variant === 'low' || variant === 'medium' || variant === 'high') {
      entry.variant = variant
    }
    agents[agent] = entry
  }
  overrides.agents = agents
  doc.overrides = overrides
  doc.updated_at = new Date().toISOString()
  atomicWriteFile(targetPath, `${JSON.stringify(doc, null, 2)}\n`)
}

function updateCheckStatePath(): string {
  const stateDir =
    process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? homedir(), '.local', 'state')
  return join(stateDir, 'pantheon', 'update-check.json')
}

function readUpdateCheckState(): UpdateCheckState {
  try {
    return JSON.parse(readFileSync(updateCheckStatePath(), 'utf8')) as UpdateCheckState
  } catch {
    return {}
  }
}

function persistUpdateCheckState(previous: UpdateCheckState, latest: string | null): void {
  try {
    const next = withKnownLatest(
      nextCheckState(previous, latest ? { version: latest, message: '' } : null, Date.now()),
      latest,
    )
    atomicWriteFile(updateCheckStatePath(), `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    /* non-fatal */
  }
}

let guiGoalLoopRestartPending = false
let guiSelectedUpdateChannel: UpdateChannel | null = null
let guiCachedLegacyAudit: LegacyAuditSummary | null = null
let guiCachedChangelog: ChangelogHighlightItem[] | null = null

async function readSnapshotFromDisk(directory: string): Promise<GuiSnapshot> {
  const root = directory.trim() || process.cwd()
  const runningVersion = resolveRunningVersion()
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

  const load = readOverridesLoad(root)
  const merged = mergedOverrides(load)
  const overridesCount = Object.keys(merged).length
  const behaviorsGlobal: BehaviorSettingItem[] = SETTINGS_BEHAVIORS.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    kind: b.kind,
    enabled: !isBehaviorDisabled(load.global, b.id),
    projectOverride: load.project[b.id] !== undefined,
  }))
  const behaviorsProject: BehaviorSettingItem[] = SETTINGS_BEHAVIORS.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    kind: b.kind,
    enabled: !isBehaviorDisabled(merged, b.id),
    projectOverride: load.project[b.id] !== undefined,
  }))

  let gateMode = 'shadow'
  let cockpitAutoOpen = false
  let cockpitShowTodo = true
  const settingsPath = join(root, '.pantheon', 'cockpit-settings.json')
  if (existsSync(settingsPath)) {
    try {
      const cfg = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
      if (typeof cfg.gateMode === 'string' && cfg.gateMode) gateMode = cfg.gateMode
      if (typeof cfg.autoOpen === 'boolean') cockpitAutoOpen = cfg.autoOpen
      if (typeof cfg.showTodo === 'boolean') cockpitShowTodo = cfg.showTodo
    } catch {
      /* ignore */
    }
  }

  const globalPreset = readActivePresetMarker(globalActivePresetPath())
  const projectPreset = readActivePresetMarker(join(root, '.pantheon', 'active-preset.json'))
  const activePreset = globalPreset?.name ?? PRESET_NONE
  const presetProjectOverride = projectPreset?.name ?? null
  const visionModel = readConfiguredVisionModel(root)
  const agentModels = readAgentModelsFromDisk(root)

  const decisionRead = readDecisionRouterConfig()
  const dec = decisionRead.config
  const decisionTarget = dec.selection.provider
    ? `${dec.selection.provider}/${dec.selection.model ?? ''}`
    : (DECISION_TARGET_CYCLE[0] ?? 'openai-decisions/gpt-6-luna')
  const authProviders = readAuthProviders()
  const configProviders = readConfigProviders()
  const credentials: CredentialStatusItem[] = DECISION_KNOWN_PROVIDERS.map((provider) => {
    const status = credentialStatus(provider, process.env, authProviders, configProviders)
    const cred = DECISION_PROVIDER_CREDENTIALS[provider] ?? { note: '' }
    return {
      provider,
      status: status === 'missing' ? 'MISSING' : status,
      note: cred.note,
    }
  })

  const goalLoop = readGoalLoopPrefs()
  const budgets = readDecisionBudgets()
  const j1Mode = j1ModeFromEnv(process.env)
  const j1Threshold = j1ThresholdFromEnv(process.env)
  const j1DisabledByOverride = isBehaviorDisabled(merged, 'gate-j1-risk-gate')
  const tuiPrefs = readTuiPrefsFromDisk()

  const updateState = readUpdateCheckState()
  const updateChannel = guiSelectedUpdateChannel ?? updateChannelFor(runningVersion)

  if (guiCachedLegacyAudit === null) {
    try {
      guiCachedLegacyAudit = scanLegacyArtifacts({
        workspaceDir: root,
        runningVersion,
      }).summary
    } catch {
      guiCachedLegacyAudit = null
    }
  }

  if (guiCachedChangelog === null) {
    try {
      const md = await readChangelogForBundle(
        typeof import.meta !== 'undefined' && import.meta.url ? import.meta.url : root,
      )
      if (md) {
        const hl = extractHighlights(md, runningVersion)
        if (hl.found) {
          const items: ChangelogHighlightItem[] = []
          for (const group of hl.groups) {
            for (const item of group.items) {
              const colon = item.indexOf(': ')
              const emdash = item.indexOf('—')
              const sep = colon !== -1 ? colon : emdash
              const title = sep !== -1 ? item.slice(0, sep).trim() : item.slice(0, 26)
              const detail = sep !== -1 ? item.slice(sep + (colon !== -1 ? 2 : 1)).trim() : item
              items.push({ title, detail, group: group.heading ?? undefined })
            }
          }
          guiCachedChangelog = items
        } else {
          guiCachedChangelog = []
        }
      } else {
        guiCachedChangelog = []
      }
    } catch {
      guiCachedChangelog = []
    }
  }

  const installHealth = classifyInstallVersion(runningVersion)
  const overridesHealth = classifyOverridesHealth(load)
  const decisionHealth = classifyDecisionConfigHealth()
  const doctor: DoctorHealthSnapshot = {
    installVersion: installHealth.installed ?? 'unknown',
    installStatus: installHealth.status,
    nodeVersion: process.versions.node,
    nodeSupported: isSupportedNodeFloor(process.versions.node),
    overridesStatus: overridesHealth.status,
    overridesUnknownCount: overridesHealth.unknownIds.length,
    decisionStatus: decisionHealth.status,
  }

  const aboutTab = buildAboutTab(runningVersion, {
    nodeVersion: process.versions.node,
    platform: process.platform,
    preset: projectPreset?.name ?? globalPreset?.name ?? null,
    decisionEnabled: dec.enabled,
    j1Mode,
  })
  const toolsGroup = aboutTab.groups.find((g) => g.title?.includes('Native Tools'))
  const aboutToolGroups = (toolsGroup?.rows ?? []).map((r) => ({
    name: r.name,
    value: r.value,
    note: r.note ?? '',
  }))

  let artifactsCount = 0
  const plansDir = join(root, '.pantheon', 'plans')
  if (existsSync(plansDir)) {
    try {
      artifactsCount = readdirSync(plansDir).filter((f) => f.endsWith('.md')).length
    } catch {
      /* ignore */
    }
  }

  let costs = guiCachedCosts
  const nowMs = Date.now()
  if (!costs || nowMs - costs.fetchedAt >= COST_CACHE_TTL_MS) {
    try {
      const fresh = await readOpenCodeCosts()
      costs = { ...fresh, fetchedAt: nowMs }
      guiCachedCosts = costs
    } catch {
      costs = costs ?? { todayCostUSD: 0, monthCostUSD: 0, modelSpend: [], fetchedAt: nowMs }
    }
  }
  const { todayCostUSD, monthCostUSD, modelSpend } = costs

  return {
    messages,
    events,
    activeJobs,
    todayCostUSD,
    monthCostUSD,
    modelSpend,
    overridesCount,
    corruptGlobalOverrides: load.corruptGlobal,
    gateMode,
    cockpitAutoOpen,
    cockpitShowTodo,
    artifactsCount,
    activePreset,
    presetProjectOverride,
    visionModel,
    agentModels,
    decisionEnabled: dec.enabled,
    decisionMode: dec.selection.mode,
    decisionTarget,
    decisionConsent: dec.egress_consent,
    decisionCorrupt: decisionRead.corrupt,
    decisionCandidates: [...dec.enabled_candidates],
    credentials,
    goalLoop,
    goalLoopRestartPending: guiGoalLoopRestartPending,
    budgets,
    j1Mode,
    j1Threshold,
    j1DisabledByOverride,
    tuiPrefs,
    updateChannel,
    lastUpdateCheckMs: updateState.lastCheckMs ?? null,
    latestVersion: updateState.lastNotifiedVersion ?? null,
    legacyAudit: guiCachedLegacyAudit,
    doctor,
    changelogHighlights: guiCachedChangelog ?? [],
    aboutToolGroups,
    behaviorsGlobal,
    behaviorsProject,
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
      cockpitAutoOpen?: boolean
      cockpitShowTodo?: boolean
      preset?: string
      visionModel?: string
      agentModel?: { agent: string; model: string; variant: string }
      overrideToggle?: { id: string; scope: OverridesScope; enabled: boolean }
      decisionEnabled?: boolean
      decisionMode?: string
      decisionTarget?: string
      decisionConsent?: boolean
      goalLoop?: Partial<GoalLoopPrefs>
      budgetMonthly?: string
      budgetPerDecision?: string
      tuiPref?: { id: string; value: string }
      updateChannel?: UpdateChannel
    }
    const root = payload.directory?.trim() || process.cwd()
    const pantheonDir = join(root, '.pantheon')
    mkdirSync(pantheonDir, { recursive: true })

    if (
      typeof payload.gateMode === 'string' ||
      typeof payload.cockpitAutoOpen === 'boolean' ||
      typeof payload.cockpitShowTodo === 'boolean'
    ) {
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
      if (typeof payload.gateMode === 'string') current.gateMode = payload.gateMode
      if (typeof payload.cockpitAutoOpen === 'boolean') current.autoOpen = payload.cockpitAutoOpen
      if (typeof payload.cockpitShowTodo === 'boolean') current.showTodo = payload.cockpitShowTodo
      atomicWriteFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`)
    }

    if (typeof payload.preset === 'string') {
      const globalPath = globalActivePresetPath()
      if (payload.preset === PRESET_NONE) {
        clearActivePreset(globalPath)
      } else {
        writeActivePreset(globalPath, payload.preset)
      }
    }

    if (typeof payload.visionModel === 'string') {
      writeConfiguredVisionModel(payload.visionModel, root)
    }

    if (payload.agentModel) {
      writeAgentModelToDisk(
        root,
        payload.agentModel.agent,
        payload.agentModel.model,
        payload.agentModel.variant,
      )
    }

    if (payload.overrideToggle) {
      const { id, scope, enabled } = payload.overrideToggle
      const load = readOverridesLoad(root)
      const target = enabled ? 'enabled' : 'disabled'
      if (scope === 'project') {
        const nextProject = setOverrideState(load.project, id, target, 'toggled in Pantheon GUI')
        atomicWriteFile(projectOverridesPath(root), serializeOverrides(nextProject))
      } else {
        if (!canWriteOverrides(load)) {
          return JSON.stringify({
            ok: false,
            error: 'Global overrides file unreadable — repair with `doctor --fix`',
          })
        }
        const nextGlobal = setOverrideState(load.global, id, target, 'toggled in Pantheon GUI')
        atomicWriteFile(globalOverridesPath(), serializeOverrides(nextGlobal))
      }
    }

    if (
      typeof payload.decisionEnabled === 'boolean' ||
      typeof payload.decisionMode === 'string' ||
      typeof payload.decisionTarget === 'string' ||
      typeof payload.decisionConsent === 'boolean'
    ) {
      const read = readDecisionRouterConfig()
      if (read.corrupt) {
        return JSON.stringify({
          ok: false,
          error: 'Decision router config is corrupt; refusing to overwrite',
        })
      }
      let nextCfg = read.config
      if (typeof payload.decisionConsent === 'boolean') {
        nextCfg = applyDecisionRow(
          nextCfg,
          'decision.consent',
          payload.decisionConsent ? 'granted' : 'not granted',
        )
      }
      if (typeof payload.decisionMode === 'string') {
        nextCfg = applyDecisionRow(nextCfg, 'decision.selection.mode', payload.decisionMode)
      }
      if (typeof payload.decisionTarget === 'string') {
        nextCfg = applyDecisionRow(nextCfg, 'decision.selection.target', payload.decisionTarget)
      }
      if (typeof payload.decisionEnabled === 'boolean') {
        const guarded = setDecisionEnabled(nextCfg, payload.decisionEnabled)
        if (!guarded.ok) {
          return JSON.stringify({ ok: false, error: guarded.reason })
        }
        nextCfg = guarded.config
      }
      writeDecisionRouterConfig(nextCfg)
    }

    if (payload.goalLoop) {
      const current = readGoalLoopPrefs()
      const next: GoalLoopPrefs = {
        enabled:
          typeof payload.goalLoop.enabled === 'boolean'
            ? payload.goalLoop.enabled
            : current.enabled,
        maxContinuations:
          typeof payload.goalLoop.maxContinuations === 'number' &&
          payload.goalLoop.maxContinuations >= 1 &&
          payload.goalLoop.maxContinuations <= 200
            ? Math.floor(payload.goalLoop.maxContinuations)
            : current.maxContinuations,
        cooldownMs:
          typeof payload.goalLoop.cooldownMs === 'number' && payload.goalLoop.cooldownMs >= 1000
            ? Math.floor(payload.goalLoop.cooldownMs)
            : current.cooldownMs,
      }
      writeUserOption('goal_loop', next)
      guiGoalLoopRestartPending = true
    }

    if (
      typeof payload.budgetMonthly === 'string' ||
      typeof payload.budgetPerDecision === 'string'
    ) {
      const current = readDecisionBudgets()
      const monthly =
        typeof payload.budgetMonthly === 'string'
          ? parseUsd(payload.budgetMonthly)
          : current.monthlyUsd
      const perDecision =
        typeof payload.budgetPerDecision === 'string'
          ? parseUsd(payload.budgetPerDecision)
          : current.perDecisionUsd
      if (monthly === null || perDecision === null) {
        return JSON.stringify({ ok: false, error: 'Invalid USD budget value' })
      }
      writeDecisionBudget({ monthlyUsd: monthly, perDecisionUsd: perDecision })
    }

    if (payload.tuiPref) {
      const current = readTuiPrefsFromDisk()
      const copy: TuiPrefs = JSON.parse(JSON.stringify(current)) as TuiPrefs
      applyTuiRow(copy, payload.tuiPref.id, payload.tuiPref.value)
      writeTuiPrefsToDisk(copy)
    }

    if (payload.updateChannel === 'stable' || payload.updateChannel === 'beta') {
      guiSelectedUpdateChannel = payload.updateChannel
    }

    return JSON.stringify({ ok: true })
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to save Pantheon settings',
    })
  }
}

async function runActionOnDisk(payloadRaw: string): Promise<string> {
  try {
    const payload = JSON.parse(payloadRaw) as {
      directory?: string
      action?: string
      channel?: UpdateChannel
    }
    const root = payload.directory?.trim() || process.cwd()
    const runningVersion = resolveRunningVersion()
    const channel = payload.channel ?? guiSelectedUpdateChannel ?? updateChannelFor(runningVersion)

    if (payload.action === 'update-check') {
      const prev = readUpdateCheckState()
      let latest: string | null = null
      try {
        const res = await fetch(registryUrlForChannel(channel), {
          signal: AbortSignal.timeout(5000),
        })
        const json = (await res.json()) as { version?: unknown }
        latest = typeof json?.version === 'string' && json.version ? json.version : null
      } catch {
        latest = null
      }
      persistUpdateCheckState(prev, latest)
      const isNewer = latest ? isNewerUpdateAvailable(runningVersion, latest) : false
      return JSON.stringify({
        ok: true,
        message: latest
          ? isNewer
            ? `Update available: v${latest} (channel: ${channel})`
            : `Up to date on v${runningVersion} (latest: v${latest})`
          : 'Could not reach npm registry (offline or timeout)',
      })
    }

    if (payload.action === 'update-run') {
      const pkgSpec = channel === 'beta' ? 'pantheon-opencode@beta' : 'pantheon-opencode'
      const runCmd = (cmd: string, args: string[]) =>
        new Promise<Error | null>((resolve) => {
          execFile(cmd, args, { cwd: root, timeout: 60_000 }, (err) => resolve(err ?? null))
        })
      let err = await runCmd('opencode', ['plugin', 'update', pkgSpec])
      if (err) err = await runCmd('opencode', ['plugin', 'add', pkgSpec])
      if (err) err = await runCmd('npm', ['install', '-g', pkgSpec])
      if (err) {
        return JSON.stringify({
          ok: false,
          error: `Run in terminal: opencode plugin update ${pkgSpec}`,
        })
      }
      return JSON.stringify({
        ok: true,
        message: `Updated ${pkgSpec} — restart OpenCode to reload`,
      })
    }

    if (payload.action === 'legacy-scan') {
      const scan = scanLegacyArtifacts({ workspaceDir: root, runningVersion })
      guiCachedLegacyAudit = scan.summary
      return JSON.stringify({
        ok: true,
        message:
          scan.summary.total === 0
            ? 'No legacy or obsolete files detected'
            : `Found ${scan.summary.total} item(s) (${formatBytes(scan.summary.totalBytes)})`,
      })
    }

    if (payload.action === 'legacy-clean') {
      const res = cleanLegacyArtifacts({ workspaceDir: root, runningVersion })
      guiCachedLegacyAudit = scanLegacyArtifacts({ workspaceDir: root, runningVersion }).summary
      return JSON.stringify({
        ok: true,
        message: `Removed ${res.removed.length} item(s) (${formatBytes(res.reclaimedBytes)}), ${res.migratedRecords} record(s) migrated`,
      })
    }

    if (payload.action === 'legacy-purge') {
      const res = purgeAllPantheonData({ workspaceDir: root, runningVersion })
      guiCachedLegacyAudit = scanLegacyArtifacts({ workspaceDir: root, runningVersion }).summary
      return JSON.stringify({
        ok: true,
        message: `Purged ${res.removed.length} item(s) (${formatBytes(res.reclaimedBytes)})`,
      })
    }

    return JSON.stringify({ ok: false, error: `Unknown action "${payload.action ?? ''}"` })
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : 'Action failed',
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
  modelSpend: [],
  overridesCount: 0,
  corruptGlobalOverrides: false,
  gateMode: 'shadow',
  cockpitAutoOpen: false,
  cockpitShowTodo: true,
  artifactsCount: 0,
  activePreset: PRESET_NONE,
  presetProjectOverride: null,
  visionModel: 'auto',
  agentModels: KNOWN_AGENTS.map((agent) => ({ agent, model: '', variant: 'default' })),
  decisionEnabled: false,
  decisionMode: 'local',
  decisionTarget: DECISION_TARGET_CYCLE[0] ?? 'openai-decisions/gpt-6-luna',
  decisionConsent: false,
  decisionCorrupt: false,
  decisionCandidates: [],
  credentials: DECISION_KNOWN_PROVIDERS.map((provider) => ({
    provider,
    status: 'MISSING',
    note: DECISION_PROVIDER_CREDENTIALS[provider]?.note ?? '',
  })),
  goalLoop: { ...DEFAULT_GOAL_LOOP_PREFS },
  goalLoopRestartPending: false,
  budgets: { ...DEFAULT_DECISION_BUDGETS },
  j1Mode: 'shadow',
  j1Threshold: 0.8,
  j1DisabledByOverride: false,
  tuiPrefs: DEFAULT_TUI_PREFS,
  updateChannel: 'stable',
  lastUpdateCheckMs: null,
  latestVersion: null,
  legacyAudit: null,
  doctor: {
    installVersion: 'unknown',
    installStatus: 'unknown',
    nodeVersion: '26.x',
    nodeSupported: true,
    overridesStatus: 'clean',
    overridesUnknownCount: 0,
    decisionStatus: 'absent',
  },
  changelogHighlights: [],
  aboutToolGroups: [],
  behaviorsGlobal: SETTINGS_BEHAVIORS.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    kind: b.kind,
    enabled: true,
    projectOverride: false,
  })),
  behaviorsProject: SETTINGS_BEHAVIORS.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    kind: b.kind,
    enabled: true,
    projectOverride: false,
  })),
})

const [activeDirectory, setActiveDirectory] = createSignal('')
const [uiError, setUiError] = createSignal<string | null>(null)
const [uiNotice, setUiNotice] = createSignal<string | null>(null)

function guiLang(): 'pt-BR' | 'en' {
  return resolveLanguage(sharedSnapshot().tuiPrefs.layout?.language)
}

function tr(en: string, pt: string): string {
  return guiLang() === 'pt-BR' ? pt : en
}

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

function renderMythEmblem(agentId: string, x: number, y: number, color: string) {
  const id = agentId.toLowerCase()
  return (
    <g transform={`translate(${x}, ${y})`} fill="none" stroke={color} stroke-width="1.3">
      {id === 'zeus' ? (
        <path d="M7 1L2 7h4l-1 4 5-6H6l1-4z" fill={color} stroke="none" />
      ) : id === 'athena' ? (
        <path d="M6 1L2 2.8v3c0 2.6 1.7 4.5 4 5.2 2.3-.7 4-2.6 4-5.2v-3L6 1z" />
      ) : id === 'hermes' ? (
        <path d="M1.5 7.5C3.5 4.5 6.5 3 10.5 2c-1 2.8-3 4.6-6 5.5l-3 0zm2.5 2c2-.8 4-1.8 5.5-3-.8 1.8-2.4 2.8-4.5 3.5L4 9.5z" />
      ) : id === 'apollo' ? (
        <g>
          <circle cx="6" cy="6" r="2.2" />
          <path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11M2.5 2.5l1 1M8.5 8.5l1 1M9.5 2.5l-1 1M3.5 8.5l-1 1" />
        </g>
      ) : id === 'themis' ? (
        <path d="M6 1.5v9M2 3.5h8M3 3.5L1.5 7h3L3 3.5zm6 0L7.5 7h3L9 3.5zM4 10.5h4" />
      ) : id === 'aphrodite' ? (
        <path d="M6 1l1.4 3.6L11 6 7.4 7.4 6 11 4.6 7.4 1 6l3.6-1.4L6 1z" />
      ) : id === 'demeter' ? (
        <path d="M10 2C5 2 2 5 2 10c5 0 8-3 8-8zM2 10l4.5-4.5" />
      ) : id === 'iris' ? (
        <path d="M1.5 8.5a4.5 4.5 0 0 1 9 0M3.5 8.5a2.5 2.5 0 0 1 5 0" />
      ) : (
        <path d="M6 1.5v9M1.5 6h9M2.8 2.8l6.4 6.4M9.2 2.8L2.8 9.2" />
      )}
    </g>
  )
}

const OLYMPUS_ROSTER_INFO = [
  {
    id: 'zeus',
    en: 'Coordinator · orchestrates slices, gates & synthesis',
    pt: 'Coordenador · orquestra fatias, portões e síntese',
  },
  {
    id: 'athena',
    en: 'Planner · architecture, Deepwork blueprints & risk',
    pt: 'Planejadora · arquitetura, blueprints Deepwork e risco',
  },
  {
    id: 'hermes',
    en: 'Backend Specialist · APIs, services, CLI & tests',
    pt: 'Especialista Backend · APIs, serviços, CLI e testes',
  },
  {
    id: 'apollo',
    en: 'Researcher · read-only codebase & web discovery',
    pt: 'Pesquisador · descoberta read-only de código e web',
  },
  {
    id: 'themis',
    en: 'Verifier · IntentGate, 3-layer review & branch diff',
    pt: 'Verificadora · IntentGate, revisão 3 camadas e diff',
  },
  {
    id: 'aphrodite',
    en: 'Frontend Specialist · UI/UX, Solid/React & styles',
    pt: 'Especialista Frontend · UI/UX, Solid/React e estilos',
  },
  {
    id: 'demeter',
    en: 'Data Specialist · schemas, migrations & SQLite/SQL',
    pt: 'Especialista Dados · schemas, migrações e SQLite/SQL',
  },
  {
    id: 'iris',
    en: 'Custodian · git custody, memory-bank & releases',
    pt: 'Guardiã · custódia git, memory-bank e releases',
  },
  {
    id: 'ephemeral',
    en: 'Ephemeral Workers · isolated worktree slice executors',
    pt: 'Workers Efêmeros · executores isolados em worktrees',
  },
] as const

function PantheonCockpitView(props: { ctx: SetupContext<any>; directory: () => string }) {
  const [subTab, setSubTab] = createSignal<GuiSubTab>('topology')
  const [topoView, setTopoView] = createSignal<'dag' | 'gantt' | 'interactions'>('dag')
  const [dagStyle, setDagStyle] = createSignal<'radial' | 'tree'>('radial')
  const [dagZoom, setDagZoom] = createSignal(1)
  const [panX, setPanX] = createSignal(0)
  const [panY, setPanY] = createSignal(0)
  const [isPanning, setIsPanning] = createSignal(false)
  const [bottomHeight, setBottomHeight] = createSignal(190)
  const [bottomTab, setBottomTab] = createSignal<'inspector' | 'members'>('inspector')
  const [selectedAgent, setSelectedAgent] = createSignal('zeus')
  const [scrubberSeq, setScrubberSeq] = createSignal<number | null>(null)
  const [draftMsg, setDraftMsg] = createSignal('')
  const [draftChannel, setDraftChannel] = createSignal('default')

  let panStartX = 0
  let panStartY = 0
  let panOriginX = 0
  let panOriginY = 0

  const startBottomResize = (e: MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = bottomHeight()
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(420, Math.max(110, startHeight - (ev.clientY - startY)))
      setBottomHeight(next)
    }
    const onUp = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
  }

  const effectiveDirectory = () => resolveActiveDirectory(props.ctx, props.directory)
  let refreshSeq = 0

  const refresh = async () => {
    const seq = ++refreshSeq
    try {
      const dir = effectiveDirectory()
      if (dir) setActiveDirectory(dir)
      const raw = await props.ctx.main(PantheonBridge).snapshot(dir)
      if (seq !== refreshSeq) return
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
    const onFocus = () => void refresh()
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refresh()
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    onCleanup(() => {
      clearInterval(timer)
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus)
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    })
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

  const interactionEdges = createMemo(() => {
    const edges: Array<{
      from: string
      target: string
      seq: number
      tag?: string
      replyToSeq?: number
      timestamp: number
      bodyPreview: string
    }> = []
    for (const m of visibleMessages()) {
      const from = m.from.trim().replace(/^@+/, '') || 'unknown'
      const rawTargets =
        m.mentions.length > 0
          ? m.mentions.map((t) => t.trim().replace(/^@+/, ''))
          : Array.from(m.body.matchAll(/(?:^|[\s(])@([A-Za-z0-9][A-Za-z0-9_-]*)/g), (x) => x[1])
      const seen = new Set<string>()
      const preview = m.body.trim().replace(/\s+/g, ' ').slice(0, 72)
      for (const target of rawTargets) {
        if (!target || seen.has(target)) continue
        seen.add(target)
        edges.push({
          from,
          target,
          seq: m.seq,
          tag: m.tag,
          replyToSeq: m.replyToSeq,
          timestamp: m.timestamp,
          bodyPreview: preview,
        })
      }
    }
    return edges
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

  const treeDagLayout = createMemo(() =>
    computeTidyDagLayout({
      events: sharedSnapshot().events,
      messages: visibleMessages(),
      activeJobs: sharedSnapshot().activeJobs,
    }),
  )

  const radialDagLayout = createMemo(() => computeRadialHubLayout(treeDagLayout()))
  const activeDagLayout = createMemo(() =>
    dagStyle() === 'radial' ? radialDagLayout() : treeDagLayout(),
  )

  const selectedNodeInfo = createMemo(() => {
    const id = selectedAgent()
    const node = activeDagLayout().nodes.find((n) => n.id === id) ?? activeDagLayout().nodes[0]
    const nodeId = node?.id ?? id
    const childCount = activeDagLayout().nodes.filter((n) => n.parentId === nodeId).length
    const msgs = visibleMessages()
      .filter((m) => {
        const from = m.from.trim().replace(/^@+/, '')
        const mentions = m.mentions.map((x) => x.trim().replace(/^@+/, ''))
        return from === nodeId || mentions.includes(nodeId)
      })
      .slice(-5)
      .reverse()
    const events = sharedSnapshot()
      .events.filter((ev) => {
        const a = ev.agent?.trim().replace(/^@+/, '')
        const b = ev.baseAgent?.trim().replace(/^@+/, '')
        const r = ev.role?.trim().replace(/^@+/, '')
        return a === nodeId || b === nodeId || r === nodeId
      })
      .slice(-5)
      .reverse()
    const mentionCount = interactionEdges().filter(
      (e) => e.from === nodeId || e.target === nodeId,
    ).length
    return {
      id: nodeId,
      label: node?.label ?? nodeId,
      status: node?.status ?? ('idle' as TidyDagNodeStatus),
      childCount,
      mentionCount,
      msgs,
      events,
    }
  })

  const dagSummaryCounts = createMemo(() => {
    const nodes = activeDagLayout().nodes
    return {
      total: nodes.length,
      active: nodes.filter((n) => n.status === 'running').length,
      done: nodes.filter((n) => n.status === 'done').length,
      blocked: nodes.filter((n) => n.status === 'blocked').length,
    }
  })

  const dagStatusColor = (status: TidyDagNodeStatus): string => {
    switch (status) {
      case 'root':
        return '#fba970'
      case 'running':
        return '#38bdf8'
      case 'done':
        return '#22c55e'
      case 'blocked':
        return '#ef4444'
      default:
        return '#64748b'
    }
  }

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
            {`${sharedSnapshot().activeJobs.filter((j) => j.status === 'running').length} ${tr('active', 'ativos')} · $${totalCost().toFixed(2)}`}
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
            {tr('Refresh', 'Atualizar')}
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
            ['topology', tr('Topology & Timeline', 'Topologia & Linha do Tempo')],
            ['board', `${tr('Agora Board', 'Board Agora')} (${sharedSnapshot().messages.length})`],
            [
              'ephemeral',
              `${tr('Ephemeral & Bots', 'Efêmeros & Bots')} (${sharedSnapshot().activeJobs.length})`,
            ],
            ['settings', tr('Settings & Cost', 'Configurações & Custo')],
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
        <div
          style={{
            flex: 1,
            'min-height': 0,
            display: 'flex',
            'flex-direction': 'column',
            gap: '10px',
          }}
        >
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
                  ? `#${maxSeq()} · ${tr('Live', 'Ao vivo')}`
                  : `#${scrubberSeq()} / ${maxSeq()} · ${tr('Replay', 'Replay')}`}
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
                {tr('DAG Pillars', 'Pilares DAG')}
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
                {tr('Timeline', 'Linha do Tempo')}
              </button>
              <button
                type="button"
                onClick={() => setTopoView('interactions')}
                style={{
                  padding: '2px 8px',
                  'border-radius': '4px',
                  border: '1px solid var(--border-weak-base, #3f3f46)',
                  background: topoView() === 'interactions' ? '#fba970' : 'transparent',
                  color: topoView() === 'interactions' ? '#111' : 'inherit',
                  cursor: 'pointer',
                }}
              >
                {tr('Interactions', 'Interações')}
              </button>
            </div>
          </div>

          <Show when={topoView() === 'gantt'}>
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
          </Show>

          <Show when={topoView() === 'interactions'}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <div
                style={{
                  display: 'flex',
                  'justify-content': 'space-between',
                  'align-items': 'center',
                  opacity: 0.8,
                  'font-size': '11px',
                }}
              >
                <span>
                  {`${interactionEdges().length} ${tr('@mention edges', 'arestas @mention')} · ${visibleMessages().length}/${sharedSnapshot().messages.length} ${tr('msgs up to', 'msgs até')} #${scrubberSeq() ?? maxSeq()}`}
                </span>
                <Show when={scrubberSeq() !== null}>
                  <button
                    type="button"
                    onClick={() => setScrubberSeq(null)}
                    style={{
                      padding: '1px 6px',
                      'border-radius': '4px',
                      border: '1px solid var(--border-weak-base, #3f3f46)',
                      background: 'transparent',
                      color: '#fba970',
                      cursor: 'pointer',
                      'font-size': '11px',
                    }}
                  >
                    {tr('Live', 'Ao vivo')}
                  </button>
                </Show>
              </div>
              <For
                each={interactionEdges()}
                fallback={
                  <div style={{ opacity: 0.6 }}>
                    {tr(
                      'No @mention interactions up to this #seq.',
                      'Nenhuma interação @mention até este #seq.',
                    )}
                  </div>
                }
              >
                {(edge) => {
                  const tagColor =
                    edge.tag === 'done'
                      ? '#34d399'
                      : edge.tag === 'blocker' || edge.tag === 'deadlock'
                        ? '#f87171'
                        : edge.tag === 'claim' || edge.tag === 'handoff'
                          ? '#fba970'
                          : '#38bdf8'
                  return (
                    <div
                      style={{
                        display: 'flex',
                        'flex-direction': 'column',
                        gap: '3px',
                        padding: '6px 8px',
                        'border-radius': '6px',
                        border: '1px solid var(--border-weak-base, #2e2e32)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          'justify-content': 'space-between',
                          'align-items': 'center',
                          gap: '8px',
                        }}
                      >
                        <span style={{ 'font-family': 'monospace' }}>
                          {`#${edge.seq} ${edge.from} → @${edge.target}`}
                          {edge.replyToSeq !== undefined ? ` (re:#${edge.replyToSeq})` : ''}
                        </span>
                        <Show when={edge.tag}>
                          <span
                            style={{
                              padding: '1px 6px',
                              'border-radius': '999px',
                              border: `1px solid ${tagColor}`,
                              color: tagColor,
                              'font-size': '10px',
                              'font-family': 'monospace',
                            }}
                          >
                            {`[${edge.tag}]`}
                          </span>
                        </Show>
                      </div>
                      <Show when={edge.bodyPreview.length > 0}>
                        <div style={{ opacity: 0.7, 'font-size': '11px' }}>{edge.bodyPreview}</div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>

          <Show when={topoView() === 'dag'}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: interactive pan/wheel-zoom graph canvas */}
            <div
              onWheel={(e) => {
                e.preventDefault()
                const delta = e.deltaY < 0 ? 0.1 : -0.1
                setDagZoom((z) => Math.min(2.2, Math.max(0.4, Number((z + delta).toFixed(2)))))
              }}
              onMouseDown={(e) => {
                const target = e.target as Element | null
                if (target?.closest('g[role="button"], button')) return
                setIsPanning(true)
                panStartX = e.clientX
                panStartY = e.clientY
                panOriginX = panX()
                panOriginY = panY()
              }}
              onMouseMove={(e) => {
                if (!isPanning()) return
                setPanX(panOriginX + (e.clientX - panStartX))
                setPanY(panOriginY + (e.clientY - panStartY))
              }}
              onMouseUp={() => setIsPanning(false)}
              onMouseLeave={() => setIsPanning(false)}
              style={{
                position: 'relative',
                flex: 1,
                'min-height': '180px',
                overflow: 'hidden',
                cursor: isPanning() ? 'grabbing' : 'grab',
                'user-select': 'none',
                border: '1px solid var(--border-weak-base, #2e2e32)',
                'border-radius': '8px',
                'background-color': 'rgba(15, 17, 23, 0.55)',
                'background-image': 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)',
                'background-size': '18px 18px',
                padding: '8px',
              }}
            >
              {/* Floating style + zoom controls */}
              <div
                style={{
                  position: 'absolute',
                  top: '8px',
                  right: '8px',
                  'z-index': 2,
                  display: 'flex',
                  gap: '4px',
                  padding: '4px',
                  'border-radius': '6px',
                  background: 'rgba(17, 20, 28, 0.88)',
                  border: '1px solid var(--border-weak-base, #3f3f46)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setDagStyle('radial')}
                  style={{
                    padding: '2px 7px',
                    'border-radius': '4px',
                    border: '1px solid var(--border-weak-base, #3f3f46)',
                    background: dagStyle() === 'radial' ? '#fba970' : 'transparent',
                    color: dagStyle() === 'radial' ? '#111' : 'inherit',
                    'font-size': '11px',
                    cursor: 'pointer',
                  }}
                >
                  {tr('Hub Radial', 'Hub Radial')}
                </button>
                <button
                  type="button"
                  onClick={() => setDagStyle('tree')}
                  style={{
                    padding: '2px 7px',
                    'border-radius': '4px',
                    border: '1px solid var(--border-weak-base, #3f3f46)',
                    background: dagStyle() === 'tree' ? '#fba970' : 'transparent',
                    color: dagStyle() === 'tree' ? '#111' : 'inherit',
                    'font-size': '11px',
                    cursor: 'pointer',
                  }}
                >
                  {tr('Tree DAG', 'Árvore DAG')}
                </button>
                <button
                  type="button"
                  onClick={() => setDagZoom((z) => Math.max(0.4, Number((z - 0.15).toFixed(2))))}
                  style={{
                    padding: '2px 6px',
                    'border-radius': '4px',
                    border: '1px solid var(--border-weak-base, #3f3f46)',
                    background: 'transparent',
                    color: 'inherit',
                    'font-size': '11px',
                    cursor: 'pointer',
                  }}
                >
                  -
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDagZoom(1)
                    setPanX(0)
                    setPanY(0)
                  }}
                  style={{
                    padding: '2px 6px',
                    'border-radius': '4px',
                    border: '1px solid var(--border-weak-base, #3f3f46)',
                    background: 'transparent',
                    color: 'inherit',
                    'font-size': '11px',
                    'font-family': 'monospace',
                    cursor: 'pointer',
                  }}
                >
                  {`${Math.round(dagZoom() * 100)}%`}
                </button>
                <button
                  type="button"
                  onClick={() => setDagZoom((z) => Math.min(2.2, Number((z + 0.15).toFixed(2))))}
                  style={{
                    padding: '2px 6px',
                    'border-radius': '4px',
                    border: '1px solid var(--border-weak-base, #3f3f46)',
                    background: 'transparent',
                    color: 'inherit',
                    'font-size': '11px',
                    cursor: 'pointer',
                  }}
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDagZoom(0.85)
                    setPanX(0)
                    setPanY(0)
                  }}
                  style={{
                    padding: '2px 6px',
                    'border-radius': '4px',
                    border: '1px solid var(--border-weak-base, #3f3f46)',
                    background: 'transparent',
                    color: 'inherit',
                    'font-size': '11px',
                    cursor: 'pointer',
                  }}
                >
                  {tr('Fit', 'Ajustar')}
                </button>
              </div>

              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  transform: `translate(${panX()}px, ${panY()}px) scale(${dagZoom()})`,
                  'transform-origin': 'center center',
                  transition: isPanning() ? 'none' : 'transform 80ms ease-out',
                }}
              >
                <svg
                  width={activeDagLayout().width}
                  height={activeDagLayout().height}
                  viewBox={`0 0 ${activeDagLayout().width} ${activeDagLayout().height}`}
                  style={{ display: 'block', overflow: 'visible' }}
                >
                  <title>{tr('Olympus Topology DAG', 'Topologia Olympus (DAG)')}</title>
                  <style>{`
                    @keyframes pantheonDashFlow {
                      to { stroke-dashoffset: -20; }
                    }
                    @keyframes pantheonPulse {
                      0%, 100% { opacity: 0.22; }
                      50% { opacity: 0.78; }
                    }
                  `}</style>
                  {/* Parent-child tree/radial edges */}
                  <For each={activeDagLayout().edges}>
                    {(edge) => {
                      const stroke = dagStatusColor(edge.status)
                      const isActive = edge.status === 'running'
                      const pathD =
                        dagStyle() === 'radial'
                          ? (() => {
                              const mx = (edge.x1 + edge.x2) / 2
                              const my = (edge.y1 + edge.y2) / 2
                              const dx = edge.x2 - edge.x1
                              const dy = edge.y2 - edge.y1
                              const cx = mx - dy * 0.08
                              const cy = my + dx * 0.08
                              return `M ${edge.x1} ${edge.y1} Q ${cx} ${cy}, ${edge.x2} ${edge.y2}`
                            })()
                          : (() => {
                              const midY = (edge.y1 + edge.y2) / 2
                              return `M ${edge.x1} ${edge.y1} C ${edge.x1} ${midY}, ${edge.x2} ${midY}, ${edge.x2} ${edge.y2}`
                            })()
                      return (
                        <path
                          d={pathD}
                          fill="none"
                          stroke={stroke}
                          stroke-width={isActive ? '2' : '1.6'}
                          stroke-dasharray={isActive ? '6 4' : undefined}
                          opacity="0.88"
                          style={
                            isActive
                              ? { animation: 'pantheonDashFlow 1s linear infinite' }
                              : undefined
                          }
                        />
                      )
                    }}
                  </For>

                  {/* Subtle dashed @mention cross-edges in radial mode */}
                  <Show when={dagStyle() === 'radial'}>
                    <For each={interactionEdges().slice(-24)}>
                      {(edge) => {
                        const fromNode = activeDagLayout().nodes.find((n) => n.id === edge.from)
                        const toNode = activeDagLayout().nodes.find((n) => n.id === edge.target)
                        if (!fromNode || !toNode || fromNode.id === toNode.id) return null
                        if (toNode.parentId === fromNode.id || fromNode.parentId === toNode.id) {
                          return null
                        }
                        const x1 = fromNode.x + fromNode.width / 2
                        const y1 = fromNode.y + fromNode.height / 2
                        const x2 = toNode.x + toNode.width / 2
                        const y2 = toNode.y + toNode.height / 2
                        return (
                          <path
                            d={`M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 - 22}, ${x2} ${y2}`}
                            fill="none"
                            stroke="#94a3b8"
                            stroke-width="1"
                            stroke-dasharray="4 4"
                            opacity="0.45"
                          />
                        )
                      }}
                    </For>
                  </Show>

                  {/* Richer clickable node cards with mythological emblems */}
                  <For each={activeDagLayout().nodes}>
                    {(node) => {
                      const stroke = dagStatusColor(node.status)
                      const isSelected = () => selectedAgent() === node.id
                      const isActive = node.status === 'running'
                      const label =
                        node.id === 'zeus'
                          ? tr('zeus (root)', 'zeus (raiz)')
                          : node.label.length > 14
                            ? `${node.label.slice(0, 13)}…`
                            : node.label
                      return (
                        // biome-ignore lint/a11y/useSemanticElements: SVG <g> represents interactive graph node
                        <g
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedAgent(node.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') setSelectedAgent(node.id)
                          }}
                          style={{ cursor: 'pointer' }}
                        >
                          <Show when={isActive}>
                            <rect
                              x={node.x - 4}
                              y={node.y - 4}
                              width={node.width + 8}
                              height={node.height + 8}
                              rx="11"
                              fill="none"
                              stroke={stroke}
                              stroke-width="1.5"
                              style={{ animation: 'pantheonPulse 1.8s ease-in-out infinite' }}
                            />
                          </Show>
                          <rect
                            x={node.x}
                            y={node.y}
                            width={node.width}
                            height={node.height}
                            rx="8"
                            fill="#131722"
                            stroke={stroke}
                            stroke-width={isSelected() ? '2.5' : node.id === 'zeus' ? '2' : '1.4'}
                          />
                          {renderMythEmblem(node.id, node.x + 8, node.y + 9, stroke)}
                          <text
                            x={node.x + 25}
                            y={node.y + 19}
                            fill="currentColor"
                            font-size={node.id === 'zeus' ? '12' : '11'}
                            font-weight={node.id === 'zeus' || isSelected() ? '600' : '500'}
                          >
                            {label}
                          </text>
                          <circle cx={node.x + 14} cy={node.y + 31} r="3" fill={stroke} />
                          <text
                            x={node.x + 22}
                            y={node.y + 34}
                            fill="#94a3b8"
                            font-size="9.5"
                            font-family="monospace"
                          >
                            {`${node.status} · L${node.depth}`}
                          </text>
                        </g>
                      )
                    }}
                  </For>
                </svg>
              </div>
            </div>

            {/* Resizable 6px split-pane handle */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: draggable split-pane divider */}
            <div
              onMouseDown={startBottomResize}
              title={tr('Drag to resize panel', 'Arraste para redimensionar')}
              style={{
                height: '6px',
                cursor: 'row-resize',
                background: 'rgba(148, 163, 184, 0.16)',
                'border-radius': '3px',
                width: '100%',
                'flex-shrink': 0,
              }}
            />

            {/* Bottom Panel: Inspector | Members & Structure */}
            <div
              style={{
                height: `${bottomHeight()}px`,
                'min-height': '110px',
                'border-radius': '8px',
                border: '1px solid var(--border-weak-base, #2e2e32)',
                background: 'rgba(19, 23, 34, 0.72)',
                padding: '8px 10px',
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
                overflow: 'hidden',
                'flex-shrink': 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  'justify-content': 'space-between',
                  'align-items': 'center',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                  <button
                    type="button"
                    onClick={() => setBottomTab('inspector')}
                    style={{
                      padding: '2px 8px',
                      'border-radius': '4px',
                      border: '1px solid var(--border-weak-base, #3f3f46)',
                      background: bottomTab() === 'inspector' ? '#fba970' : 'transparent',
                      color: bottomTab() === 'inspector' ? '#111' : 'inherit',
                      'font-size': '11px',
                      'font-weight': bottomTab() === 'inspector' ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    {tr('Inspector', 'Inspetor')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBottomTab('members')}
                    style={{
                      padding: '2px 8px',
                      'border-radius': '4px',
                      border: '1px solid var(--border-weak-base, #3f3f46)',
                      background: bottomTab() === 'members' ? '#fba970' : 'transparent',
                      color: bottomTab() === 'members' ? '#111' : 'inherit',
                      'font-size': '11px',
                      'font-weight': bottomTab() === 'members' ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    {tr('Members & Structure', 'Membros & Estrutura')}
                  </button>
                  <Show when={bottomTab() === 'inspector'}>
                    <span style={{ 'font-weight': 600, 'font-family': 'monospace' }}>
                      {`@${selectedNodeInfo().id}`}
                    </span>
                    <span
                      style={{
                        padding: '1px 7px',
                        'border-radius': '999px',
                        border: `1px solid ${dagStatusColor(selectedNodeInfo().status)}`,
                        color: dagStatusColor(selectedNodeInfo().status),
                        'font-size': '10px',
                        'font-family': 'monospace',
                      }}
                    >
                      {selectedNodeInfo().status}
                    </span>
                  </Show>
                </div>
                <span style={{ opacity: 0.75, 'font-size': '11px', 'font-family': 'monospace' }}>
                  {`${tr('children', 'filhos')}: ${selectedNodeInfo().childCount} · @mentions: ${selectedNodeInfo().mentionCount}`}
                </span>
              </div>

              <Show when={bottomTab() === 'inspector'}>
                <div
                  style={{
                    flex: 1,
                    'min-height': 0,
                    overflow: 'auto',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '3px',
                    'font-size': '11px',
                  }}
                >
                  <For each={selectedNodeInfo().msgs}>
                    {(m) => (
                      <div style={{ display: 'flex', gap: '6px', opacity: 0.9 }}>
                        <span style={{ 'font-family': 'monospace', color: '#fba970' }}>
                          {`#${m.seq}`}
                        </span>
                        <Show when={m.tag}>
                          <span style={{ 'font-family': 'monospace', opacity: 0.75 }}>
                            {`[${m.tag}]`}
                          </span>
                        </Show>
                        <span style={{ opacity: 0.85 }}>
                          {m.body.trim().replace(/\s+/g, ' ').slice(0, 96)}
                        </span>
                      </div>
                    )}
                  </For>
                  <For each={selectedNodeInfo().events}>
                    {(ev) => (
                      <div style={{ display: 'flex', gap: '6px', opacity: 0.75 }}>
                        <span style={{ 'font-family': 'monospace', color: '#38bdf8' }}>
                          {ev.kind ?? ev.type ?? 'event'}
                        </span>
                        <span>{ev.stepKey ?? ev.role ?? ev.status ?? ''}</span>
                      </div>
                    )}
                  </For>
                  <Show
                    when={
                      selectedNodeInfo().msgs.length === 0 && selectedNodeInfo().events.length === 0
                    }
                  >
                    <span style={{ opacity: 0.6 }}>
                      {tr(
                        'No board messages or telemetry events recorded for this node yet.',
                        'Nenhuma mensagem ou evento de telemetria registrado para este nó ainda.',
                      )}
                    </span>
                  </Show>
                </div>
              </Show>

              <Show when={bottomTab() === 'members'}>
                <div
                  style={{
                    flex: 1,
                    'min-height': 0,
                    overflow: 'auto',
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '4px',
                    'font-size': '11px',
                  }}
                >
                  <div
                    style={{
                      opacity: 0.8,
                      'font-family': 'monospace',
                      'font-size': '10.5px',
                      'padding-bottom': '2px',
                    }}
                  >
                    {tr(
                      'Hierarchy: Zeus (Coordinator) → Athena (Plan) / Specialists → Ephemeral Workers → Themis (Verifier)',
                      'Hierarquia: Zeus (Coordenador) → Athena (Plano) / Especialistas → Workers Efêmeros → Themis (Verificadora)',
                    )}
                  </div>
                  <For each={OLYMPUS_ROSTER_INFO}>
                    {(member) => {
                      const liveNode = () => activeDagLayout().nodes.find((n) => n.id === member.id)
                      const status = () => liveNode()?.status ?? 'idle'
                      const color = () => dagStatusColor(status())
                      return (
                        <button
                          type="button"
                          onClick={() => setSelectedAgent(member.id)}
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            'justify-content': 'space-between',
                            gap: '8px',
                            padding: '3px 6px',
                            'border-radius': '4px',
                            border:
                              selectedAgent() === member.id
                                ? '1px solid #fba970'
                                : '1px solid transparent',
                            background: 'rgba(255, 255, 255, 0.03)',
                            color: 'inherit',
                            cursor: 'pointer',
                            'text-align': 'left',
                          }}
                        >
                          <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                            <svg width="14" height="14" viewBox="0 0 12 12">
                              <title>{member.id}</title>
                              {renderMythEmblem(member.id, 0, 0, color())}
                            </svg>
                            <span style={{ 'font-family': 'monospace', 'font-weight': 600 }}>
                              {`@${member.id}`}
                            </span>
                            <span style={{ opacity: 0.78 }}>{tr(member.en, member.pt)}</span>
                          </div>
                          <span
                            style={{
                              'font-family': 'monospace',
                              'font-size': '10px',
                              color: color(),
                            }}
                          >
                            {status()}
                          </span>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </Show>

              <div
                style={{
                  display: 'flex',
                  'justify-content': 'space-between',
                  'border-top': '1px solid var(--border-weak-base, #2e2e32)',
                  'padding-top': '4px',
                  'font-size': '10.5px',
                  'font-family': 'monospace',
                  opacity: 0.8,
                }}
              >
                <span>{`Agents: ${dagSummaryCounts().total}`}</span>
                <span>{`Active: ${dagSummaryCounts().active}`}</span>
                <span>{`Done: ${dagSummaryCounts().done}`}</span>
                <span>{`Blocked: ${dagSummaryCounts().blocked}`}</span>
                <span>{`Board: #${maxSeq()}`}</span>
                <span>{`Cost: $${totalCost().toFixed(2)}`}</span>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      {/* Tab 2: Interactive Agora Board */}
      <Show when={subTab() === 'board'}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              placeholder={tr('Channel', 'Canal')}
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
              placeholder={tr(
                'Post message to Agora Board (@agent)...',
                'Enviar mensagem ao Board Agora (@agente)...',
              )}
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
              {tr('Send', 'Enviar')}
            </button>
          </div>
          <For
            each={[...visibleMessages()].reverse().slice(0, 20)}
            fallback={
              <div style={{ opacity: 0.6 }}>
                {tr(
                  'No board messages recorded yet.',
                  'Nenhuma mensagem registrada no board ainda.',
                )}
              </div>
            }
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
                <div style={{ opacity: 0.6 }}>
                  {tr(
                    'No active background jobs or subagent runs.',
                    'Nenhum job em segundo plano ou subagente ativo.',
                  )}
                </div>
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

type SettingsSectionTab =
  | 'overview'
  | 'gates'
  | 'preset'
  | 'decision'
  | 'autonomy'
  | 'updates'
  | 'doctor'

const cardStyle = {
  display: 'flex',
  'flex-direction': 'column' as const,
  gap: '8px',
  padding: '10px',
  'border-radius': '6px',
  border: '1px solid var(--border-weak-base, #2e2e32)',
}

const rowStyle = {
  display: 'flex',
  'justify-content': 'space-between' as const,
  'align-items': 'center' as const,
  gap: '8px',
}

function pillButtonStyle(active: boolean) {
  return {
    padding: '2px 8px',
    'border-radius': '4px',
    border: '1px solid var(--border-weak-base, #3f3f46)',
    background: active ? '#fba970' : 'transparent',
    color: active ? '#111' : 'inherit',
    'font-family': 'monospace',
    'font-size': '11px',
    'font-weight': active ? 600 : 400,
    cursor: 'pointer',
  }
}

function PantheonSettingsControls(props: {
  ctx: SetupContext<any>
  directory: () => string
  onSaved: () => Promise<void>
}) {
  const [section, setSection] = createSignal<SettingsSectionTab>('overview')
  const [gateScope, setGateScope] = createSignal<OverridesScope>('project')
  const [editingAgent, setEditingAgent] = createSignal<string | null>(null)
  const [agentModelInput, setAgentModelInput] = createSignal('')
  const [agentVariantInput, setAgentVariantInput] = createSignal('default')
  const [busyAction, setBusyAction] = createSignal<string | null>(null)
  const [confirmPurge, setConfirmPurge] = createSignal(false)

  const savePatch = async (patch: Record<string, unknown>, notice?: string) => {
    try {
      const raw = await props.ctx.main(PantheonBridge).saveSettings(
        JSON.stringify({
          directory: props.directory(),
          ...patch,
        }),
      )
      const res = JSON.parse(raw) as { ok?: boolean; error?: string }
      if (res.ok === false) {
        setUiError(res.error ?? tr('Failed to save settings', 'Falha ao salvar configurações'))
        return
      }
      setUiError(null)
      if (patch.tuiPref && typeof patch.tuiPref === 'object') {
        const { id, value } = patch.tuiPref as { id: string; value: string }
        setSharedSnapshot((prev) => {
          const copy = JSON.parse(JSON.stringify(prev)) as GuiSnapshot
          applyTuiRow(copy.tuiPrefs, id, value)
          return copy
        })
      }
      if (notice) setUiNotice(notice)
      await props.onSaved()
    } catch (err) {
      setUiError(
        err instanceof Error
          ? err.message
          : tr('Settings IPC unavailable', 'IPC de configurações indisponível'),
      )
    }
  }

  const triggerAction = async (action: string) => {
    if (busyAction()) return
    if (action === 'legacy-purge' && !confirmPurge()) {
      setConfirmPurge(true)
      setUiNotice(
        tr(
          'Armed: click "Confirm Purge" again to erase local .pantheon stores',
          'Armado: clique em "Confirmar Limpeza Total" novamente para apagar os dados locais de .pantheon',
        ),
      )
      return
    }
    setConfirmPurge(false)
    setBusyAction(action)
    try {
      const raw = await props.ctx.main(PantheonBridge).runAction(
        JSON.stringify({
          directory: props.directory(),
          action,
          channel: sharedSnapshot().updateChannel,
        }),
      )
      const res = JSON.parse(raw) as { ok?: boolean; error?: string; message?: string }
      if (res.ok === false) {
        setUiError(res.error ?? tr('Action failed', 'Falha na ação'))
      } else {
        setUiError(null)
        if (res.message) setUiNotice(res.message)
      }
      await props.onSaved()
    } catch (err) {
      setUiError(
        err instanceof Error
          ? err.message
          : tr('Action IPC unavailable', 'IPC de ação indisponível'),
      )
    } finally {
      setBusyAction(null)
    }
  }

  const scopedBehaviors = () =>
    gateScope() === 'project' ? sharedSnapshot().behaviorsProject : sharedSnapshot().behaviorsGlobal

  const tui = () => sharedSnapshot().tuiPrefs

  const renderTuiCycle = (
    id: string,
    label: string,
    current: string,
    options: readonly string[],
  ) => (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
      <div style={rowStyle}>
        <span style={{ 'font-size': '12px' }}>{label}</span>
        <span style={{ opacity: 0.7, 'font-family': 'monospace', 'font-size': '11px' }}>
          {current}
        </span>
      </div>
      <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '4px' }}>
        {options.map((opt) => (
          <button
            type="button"
            onClick={() => void savePatch({ tuiPref: { id, value: opt } })}
            style={pillButtonStyle(current === opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
      {/* Notice Banner */}
      <Show when={uiNotice() !== null}>
        <div
          style={{
            display: 'flex',
            'justify-content': 'space-between',
            'align-items': 'center',
            padding: '6px 8px',
            'border-radius': '4px',
            border: '1px solid #fba970',
            color: '#fdba74',
            'font-size': '11px',
          }}
        >
          <span>{uiNotice()}</span>
          <button
            type="button"
            onClick={() => setUiNotice(null)}
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

      {/* Section Pill Navigation */}
      <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '4px' }}>
        {(
          [
            ['overview', tr('Overview & Cost', 'Visão Geral & Custo')],
            ['gates', tr('Gates', 'Portões (Gates)')],
            ['preset', tr('Presets & Models', 'Presets & Modelos')],
            ['decision', tr('Decision (Jev)', 'Decisão (Jev)')],
            ['autonomy', tr('Autonomy & J1', 'Autonomia & J1')],
            ['updates', tr('Updates & Cleanup', 'Atualizações & Limpeza')],
            ['doctor', tr('Doctor & About', 'Doctor & Sobre')],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            onClick={() => {
              setConfirmPurge(false)
              setSection(id)
            }}
            style={pillButtonStyle(section() === id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 1. Overview & Cost */}
      <Show when={section() === 'overview'}>
        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>
            {tr('OpenCode Spend (Today / 30d)', 'Gastos OpenCode (Hoje / 30d)')}
          </div>
          <div style={rowStyle}>
            <span>{tr('Total Cost', 'Custo Total')}</span>
            <span style={{ 'font-family': 'monospace', 'font-weight': 600 }}>
              {`$${sharedSnapshot().todayCostUSD.toFixed(2)} / $${sharedSnapshot().monthCostUSD.toFixed(2)}`}
            </span>
          </div>
          <Show when={sharedSnapshot().modelSpend.length > 0}>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '4px',
                'border-top': '1px solid var(--border-weak-base, #2e2e32)',
                'padding-top': '6px',
              }}
            >
              <span style={{ opacity: 0.75, 'font-size': '11px' }}>
                {tr('30d Model Breakdown', 'Detalhamento por Modelo (30d)')}
              </span>
              <For each={sharedSnapshot().modelSpend}>
                {(m) => (
                  <div style={{ ...rowStyle, 'font-size': '11px', 'font-family': 'monospace' }}>
                    <span style={{ opacity: 0.9 }}>{`${m.providerID}/${m.modelID}`}</span>
                    <span style={{ opacity: 0.75 }}>
                      {`${(m.tokens / 1000).toFixed(1)}k tok · ${m.estimatedUsd !== undefined ? `$${m.estimatedUsd.toFixed(2)}` : tr('unpriced', 'sem preço')}`}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div style={cardStyle}>
          <div style={rowStyle}>
            <span>{tr('Auto-Permissions Gate', 'Portão Auto-Permissões')}</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {(['shadow', 'enforce', 'off'] as const).map((mode) => (
                <button
                  type="button"
                  onClick={() => void savePatch({ gateMode: mode })}
                  style={pillButtonStyle(sharedSnapshot().gateMode === mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <div style={rowStyle}>
            <span>{tr('Cockpit Auto-Open', 'Abrir Cockpit Automaticamente')}</span>
            <button
              type="button"
              onClick={() => void savePatch({ cockpitAutoOpen: !sharedSnapshot().cockpitAutoOpen })}
              style={{
                ...pillButtonStyle(false),
                color: sharedSnapshot().cockpitAutoOpen ? '#4ade80' : '#f87171',
              }}
            >
              {sharedSnapshot().cockpitAutoOpen
                ? tr('enabled', 'ativado')
                : tr('disabled', 'desativado')}
            </button>
          </div>
          <div style={rowStyle}>
            <span>{tr('Show Todo Block in Cockpit', 'Mostrar Bloco Todo no Cockpit')}</span>
            <button
              type="button"
              onClick={() => void savePatch({ cockpitShowTodo: !sharedSnapshot().cockpitShowTodo })}
              style={{
                ...pillButtonStyle(false),
                color: sharedSnapshot().cockpitShowTodo ? '#4ade80' : '#f87171',
              }}
            >
              {sharedSnapshot().cockpitShowTodo
                ? tr('enabled', 'ativado')
                : tr('disabled', 'desativado')}
            </button>
          </div>
          {renderTuiCycle(
            'tui.layout.language',
            tr('Language / Idioma', 'Idioma / Language'),
            tui().layout.language ?? 'auto',
            LANGUAGE_CYCLE,
          )}
        </div>

        <div style={{ opacity: 0.75, 'font-size': '11px' }}>
          {`Preset: ${sharedSnapshot().presetProjectOverride ?? sharedSnapshot().activePreset} · ${tr('Decision', 'Decisão')}: ${sharedSnapshot().decisionEnabled ? sharedSnapshot().decisionMode : tr('off', 'desligado')} · ${tr('Overrides', 'Substituições')}: ${sharedSnapshot().overridesCount} · ${tr('Plans', 'Planos')}: ${sharedSnapshot().artifactsCount} · Jobs: ${sharedSnapshot().activeJobs.length}`}
        </div>
      </Show>

      {/* 2. Gates & Behavior Overrides */}
      <Show when={section() === 'gates'}>
        <div style={cardStyle}>
          <div style={rowStyle}>
            <span style={{ 'font-weight': 600 }}>
              {tr('Overrides Scope', 'Escopo de Substituições')}
            </span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {(['project', 'global'] as const).map((sc) => (
                <button
                  type="button"
                  onClick={() => setGateScope(sc)}
                  style={pillButtonStyle(gateScope() === sc)}
                >
                  {sc === 'project'
                    ? tr('project (.pantheon)', 'projeto (.pantheon)')
                    : tr('global (~/.config)', 'global (~/.config)')}
                </button>
              ))}
            </div>
          </div>
          <Show when={gateScope() === 'global' && sharedSnapshot().corruptGlobalOverrides}>
            <span style={{ color: '#fca5a5', 'font-size': '11px' }}>
              {tr(
                'Global overrides file is unreadable — repair with `doctor --fix` before editing.',
                'Arquivo global de substituições ilegível — repare com `doctor --fix` antes de editar.',
              )}
            </span>
          </Show>
        </div>

        {(['install', 'runtime'] as const).map((kind) => (
          <div style={cardStyle}>
            <div style={{ 'font-weight': 600 }}>
              {kind === 'install'
                ? tr('Install Skills', 'Skills Instaladas')
                : tr('Runtime Gates', 'Portões de Execução')}
            </div>
            <For each={scopedBehaviors().filter((b) => b.kind === kind)}>
              {(beh) => {
                const blockedByProject = () => gateScope() === 'global' && beh.projectOverride
                return (
                  <div style={rowStyle}>
                    <div style={{ display: 'flex', 'flex-direction': 'column' }}>
                      <span>
                        {beh.title}
                        <Show when={beh.projectOverride}>
                          <span style={{ opacity: 0.65, 'font-size': '10px' }}>
                            {tr(' (project)', ' (projeto)')}
                          </span>
                        </Show>
                      </span>
                      <span style={{ opacity: 0.65, 'font-size': '10px' }}>{beh.description}</span>
                    </div>
                    <button
                      type="button"
                      disabled={blockedByProject()}
                      onClick={() =>
                        void savePatch({
                          overrideToggle: {
                            id: beh.id,
                            scope: gateScope(),
                            enabled: !beh.enabled,
                          },
                        })
                      }
                      style={{
                        ...pillButtonStyle(false),
                        opacity: blockedByProject() ? 0.45 : 1,
                        cursor: blockedByProject() ? 'not-allowed' : 'pointer',
                        color: beh.enabled ? '#4ade80' : '#f87171',
                      }}
                    >
                      {beh.enabled ? tr('enabled', 'ativado') : tr('disabled', 'desativado')}
                    </button>
                  </div>
                )
              }}
            </For>
          </div>
        ))}
      </Show>

      {/* 3. Presets & Per-Agent Models */}
      <Show when={section() === 'preset'}>
        <div style={cardStyle}>
          <div style={rowStyle}>
            <span style={{ 'font-weight': 600 }}>
              {tr('Model Preset (Global)', 'Preset de Modelo (Global)')}
            </span>
            <span style={{ opacity: 0.7, 'font-family': 'monospace', 'font-size': '11px' }}>
              {sharedSnapshot().presetProjectOverride
                ? `${tr('project wins', 'projeto prevalece')}: ${sharedSnapshot().presetProjectOverride}`
                : sharedSnapshot().activePreset}
            </span>
          </div>
          <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '4px' }}>
            {[PRESET_NONE, ...PRESET_NAMES].map((preset) => (
              <button
                type="button"
                onClick={() =>
                  void savePatch(
                    { preset },
                    tr(`Global preset set to ${preset}`, `Preset global definido para ${preset}`),
                  )
                }
                style={pillButtonStyle(sharedSnapshot().activePreset === preset)}
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={rowStyle}>
            <span style={{ 'font-weight': 600 }}>
              {tr('Vision Model (vision_describe)', 'Modelo de Visão (vision_describe)')}
            </span>
            <span style={{ opacity: 0.7, 'font-family': 'monospace', 'font-size': '11px' }}>
              {sharedSnapshot().visionModel}
            </span>
          </div>
          <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '4px' }}>
            {VISION_MODEL_OPTIONS.map((vm) => (
              <button
                type="button"
                onClick={() =>
                  void savePatch(
                    { visionModel: vm },
                    tr(`Vision model set to ${vm}`, `Modelo de visão definido para ${vm}`),
                  )
                }
                style={pillButtonStyle(sharedSnapshot().visionModel === vm)}
              >
                {vm}
              </button>
            ))}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>
            {tr(
              'Per-Agent Model Overrides (.pantheon/active-preset.json)',
              'Modelos por Agente (.pantheon/active-preset.json)',
            )}
          </div>
          <For each={sharedSnapshot().agentModels}>
            {(item) => (
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                <div style={rowStyle}>
                  <span style={{ 'font-family': 'monospace', 'font-weight': 600 }}>
                    {item.agent}
                  </span>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                    <span style={{ opacity: 0.8, 'font-family': 'monospace', 'font-size': '11px' }}>
                      {item.model
                        ? `${item.model} (${item.variant})`
                        : tr('preset default', 'padrão do preset')}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (editingAgent() === item.agent) {
                          setEditingAgent(null)
                        } else {
                          setEditingAgent(item.agent)
                          setAgentModelInput(item.model)
                          setAgentVariantInput(item.variant || 'default')
                        }
                      }}
                      style={pillButtonStyle(editingAgent() === item.agent)}
                    >
                      {editingAgent() === item.agent
                        ? tr('Cancel', 'Cancelar')
                        : tr('Edit', 'Editar')}
                    </button>
                  </div>
                </div>
                <Show when={editingAgent() === item.agent}>
                  <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
                    <input
                      type="text"
                      placeholder={tr(
                        'provider/model-id (empty = clear)',
                        'provedor/id-modelo (vazio = limpar)',
                      )}
                      value={agentModelInput()}
                      onInput={(e) => setAgentModelInput(e.currentTarget.value)}
                      style={{
                        flex: 1,
                        padding: '3px 6px',
                        'border-radius': '4px',
                        border: '1px solid var(--border-weak-base, #3f3f46)',
                        background: 'transparent',
                        color: 'inherit',
                        'font-family': 'monospace',
                        'font-size': '11px',
                      }}
                    />
                    <select
                      value={agentVariantInput()}
                      onChange={(e) => setAgentVariantInput(e.currentTarget.value)}
                      style={{
                        padding: '3px 6px',
                        'border-radius': '4px',
                        border: '1px solid var(--border-weak-base, #3f3f46)',
                        background: '#18181b',
                        color: 'inherit',
                        'font-size': '11px',
                      }}
                    >
                      <option value="default">default</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        const agent = item.agent
                        const model = agentModelInput()
                        const variant = agentVariantInput()
                        setEditingAgent(null)
                        void savePatch(
                          { agentModel: { agent, model, variant } },
                          tr(`Updated ${agent} model override`, `Modelo de ${agent} atualizado`),
                        )
                      }}
                      style={pillButtonStyle(true)}
                    >
                      {tr('Save', 'Salvar')}
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* 4. Decision Router (Jev) */}
      <Show when={section() === 'decision'}>
        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>
            {tr('Decision Assistant (Jev)', 'Assistente de Decisão (Jev)')}
          </div>
          <Show when={sharedSnapshot().decisionCorrupt}>
            <span style={{ color: '#fca5a5', 'font-size': '11px' }}>
              {tr(
                'decision-router.json is corrupt — repair via `decision-router setup-model`.',
                'decision-router.json está corrompido — repare via `decision-router setup-model`.',
              )}
            </span>
          </Show>
          <div style={rowStyle}>
            <span>{tr('Jev Assistant', 'Assistente Jev')}</span>
            <button
              type="button"
              onClick={() => void savePatch({ decisionEnabled: !sharedSnapshot().decisionEnabled })}
              style={{
                ...pillButtonStyle(sharedSnapshot().decisionEnabled),
                color: sharedSnapshot().decisionEnabled ? '#111' : 'inherit',
              }}
            >
              {sharedSnapshot().decisionEnabled
                ? tr('enabled', 'ativado')
                : tr('disabled', 'desativado')}
            </button>
          </div>
          <div style={rowStyle}>
            <span>{tr('Operation Mode', 'Modo de Operação')}</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {DECISION_SELECTION_CYCLE.map((mode) => (
                <button
                  type="button"
                  onClick={() => void savePatch({ decisionMode: mode })}
                  style={pillButtonStyle(sharedSnapshot().decisionMode === mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
            <div style={rowStyle}>
              <span>{tr('Decision Model Target', 'Modelo de Decisão Alvo')}</span>
              <span style={{ opacity: 0.7, 'font-family': 'monospace', 'font-size': '11px' }}>
                {sharedSnapshot().decisionMode === 'local'
                  ? tr('local (on-device)', 'local (no dispositivo)')
                  : sharedSnapshot().decisionTarget}
              </span>
            </div>
            <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '4px' }}>
              {DECISION_TARGET_CYCLE.map((target) => (
                <button
                  type="button"
                  onClick={() => void savePatch({ decisionTarget: target })}
                  style={pillButtonStyle(sharedSnapshot().decisionTarget === target)}
                >
                  {target}
                </button>
              ))}
            </div>
          </div>
          <div style={rowStyle}>
            <span>{tr('Cloud API Egress Consent', 'Consentimento de API na Nuvem (Egress)')}</span>
            <button
              type="button"
              onClick={() => void savePatch({ decisionConsent: !sharedSnapshot().decisionConsent })}
              style={{
                ...pillButtonStyle(false),
                color: sharedSnapshot().decisionConsent ? '#4ade80' : '#f87171',
              }}
            >
              {sharedSnapshot().decisionConsent
                ? tr('granted', 'permitido')
                : tr('not granted', 'não permitido')}
            </button>
          </div>
          <Show when={sharedSnapshot().decisionCandidates.length > 0}>
            <div style={{ opacity: 0.75, 'font-size': '11px', 'font-family': 'monospace' }}>
              {`${tr('Candidates', 'Candidatos')}: ${sharedSnapshot()
                .decisionCandidates.map((c) => `${c.provider}/${c.model}`)
                .join(', ')}`}
            </div>
          </Show>
        </div>

        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>
            {tr('Provider Credentials (Status Only)', 'Credenciais de Provedores (Apenas Status)')}
          </div>
          <For each={sharedSnapshot().credentials}>
            {(cred) => (
              <div style={rowStyle}>
                <div style={{ display: 'flex', 'flex-direction': 'column' }}>
                  <span style={{ 'font-family': 'monospace', 'font-size': '11px' }}>
                    {cred.provider}
                  </span>
                  <span style={{ opacity: 0.65, 'font-size': '10px' }}>{cred.note}</span>
                </div>
                <span
                  style={{
                    'font-family': 'monospace',
                    'font-size': '11px',
                    color: cred.status === 'MISSING' ? '#f87171' : '#4ade80',
                  }}
                >
                  {cred.status}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* 5. Autonomy & J1 Safety */}
      <Show when={section() === 'autonomy'}>
        <div style={cardStyle}>
          <div style={rowStyle}>
            <span style={{ 'font-weight': 600 }}>
              {tr('Auto-Continue Loop (goal_loop)', 'Loop de Continuação Automática (goal_loop)')}
            </span>
            <Show when={sharedSnapshot().goalLoopRestartPending}>
              <span style={{ color: '#f59e0b', 'font-size': '11px' }}>
                {tr('Restart OpenCode to apply', 'Reinicie o OpenCode para aplicar')}
              </span>
            </Show>
          </div>
          <div style={rowStyle}>
            <span>{tr('Enabled', 'Ativado')}</span>
            <button
              type="button"
              onClick={() =>
                void savePatch({ goalLoop: { enabled: !sharedSnapshot().goalLoop.enabled } })
              }
              style={{
                ...pillButtonStyle(false),
                color: sharedSnapshot().goalLoop.enabled ? '#4ade80' : '#f87171',
              }}
            >
              {sharedSnapshot().goalLoop.enabled
                ? tr('enabled', 'ativado')
                : tr('disabled', 'desativado')}
            </button>
          </div>
          <div style={rowStyle}>
            <span>{tr('Max Continuations', 'Limite de Continuações')}</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {MAX_CONTINUATIONS_CYCLE.map((val) => (
                <button
                  type="button"
                  onClick={() => void savePatch({ goalLoop: { maxContinuations: Number(val) } })}
                  style={pillButtonStyle(
                    String(sharedSnapshot().goalLoop.maxContinuations) === val,
                  )}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>
          <div style={rowStyle}>
            <span>{tr('Cooldown (ms)', 'Intervalo (ms)')}</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {COOLDOWN_MS_CYCLE.map((val) => (
                <button
                  type="button"
                  onClick={() => void savePatch({ goalLoop: { cooldownMs: Number(val) } })}
                  style={pillButtonStyle(String(sharedSnapshot().goalLoop.cooldownMs) === val)}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>
            {tr('Decision Budgets (Jev)', 'Orçamentos de Decisão (Jev)')}
          </div>
          <div style={rowStyle}>
            <span>{tr('Monthly Cap (USD)', 'Teto Mensal (USD)')}</span>
            <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '4px' }}>
              {MONTHLY_USD_CYCLE.map((val) => (
                <button
                  type="button"
                  onClick={() => void savePatch({ budgetMonthly: val })}
                  style={pillButtonStyle(formatUsd(sharedSnapshot().budgets.monthlyUsd) === val)}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>
          <div style={rowStyle}>
            <span>{tr('Per-Decision Cap', 'Teto por Decisão')}</span>
            <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '4px' }}>
              {PER_DECISION_USD_CYCLE.map((val) => (
                <button
                  type="button"
                  onClick={() => void savePatch({ budgetPerDecision: val })}
                  style={pillButtonStyle(
                    formatUsd(sharedSnapshot().budgets.perDecisionUsd) === val,
                  )}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>
            {tr('J1 Safety Risk Gate (Startup Env)', 'Portão de Risco J1 (Startup Env)')}
          </div>
          <div style={rowStyle}>
            <span>{tr('Operation Mode', 'Modo de Operação')}</span>
            <span style={{ 'font-family': 'monospace' }}>{sharedSnapshot().j1Mode}</span>
          </div>
          <div style={rowStyle}>
            <span>{tr('Enforce Threshold', 'Limite de Bloqueio')}</span>
            <span style={{ 'font-family': 'monospace' }}>{sharedSnapshot().j1Threshold}</span>
          </div>
          <div style={rowStyle}>
            <span>{tr('Gate Status', 'Status do Portão')}</span>
            <span style={{ 'font-family': 'monospace' }}>
              {sharedSnapshot().j1DisabledByOverride
                ? tr('disabled via overrides', 'desativado via substituições')
                : sharedSnapshot().j1Mode === 'off'
                  ? tr('off (env unset)', 'desligado (env não definida)')
                  : tr('active', 'ativo')}
            </span>
          </div>
          <span style={{ opacity: 0.65, 'font-size': '10px' }}>
            {`${J1_FLAG_ENV} / ${J1_THRESHOLD_ENV} · ${tr('read once at startup', 'lido uma vez na inicialização')}`}
          </span>
        </div>
      </Show>

      {/* 6. Updates & Legacy Cleanup */}
      <Show when={section() === 'updates'}>
        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>{tr('Plugin Updates', 'Atualizações do Plugin')}</div>
          <div style={rowStyle}>
            <span>{tr('Channel', 'Canal')}</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {(['stable', 'beta'] as const).map((ch) => (
                <button
                  type="button"
                  onClick={() => void savePatch({ updateChannel: ch })}
                  style={pillButtonStyle(sharedSnapshot().updateChannel === ch)}
                >
                  {ch}
                </button>
              ))}
            </div>
          </div>
          <div style={rowStyle}>
            <span>{tr('Latest Registry Version', 'Última Versão no Registro')}</span>
            <span style={{ 'font-family': 'monospace' }}>
              {sharedSnapshot().latestVersion
                ? `v${sharedSnapshot().latestVersion}`
                : tr('not checked', 'não verificado')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
            <button
              type="button"
              disabled={busyAction() !== null}
              onClick={() => void triggerAction('update-check')}
              style={pillButtonStyle(false)}
            >
              {busyAction() === 'update-check'
                ? tr('Checking…', 'Verificando…')
                : tr('Check Now', 'Verificar Agora')}
            </button>
            <button
              type="button"
              disabled={busyAction() !== null}
              onClick={() => void triggerAction('update-run')}
              style={pillButtonStyle(true)}
            >
              {busyAction() === 'update-run'
                ? tr('Updating…', 'Atualizando…')
                : tr('Update / Refresh Plugin', 'Atualizar / Recarregar Plugin')}
            </button>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>
            {tr('Legacy, Drift & Cleanup', 'Legado, Drift & Limpeza')}
          </div>
          <div style={rowStyle}>
            <span>{tr('Audit Status', 'Status da Auditoria')}</span>
            <span style={{ 'font-family': 'monospace' }}>
              {sharedSnapshot().legacyAudit
                ? sharedSnapshot().legacyAudit?.total === 0
                  ? tr('clean (0 obsolete)', 'limpo (0 obsoletos)')
                  : `${sharedSnapshot().legacyAudit?.total ?? 0} ${tr('item(s)', 'item(ns)')} (${formatBytes(sharedSnapshot().legacyAudit?.totalBytes ?? 0)})`
                : tr('not scanned', 'não verificado')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
            <button
              type="button"
              disabled={busyAction() !== null}
              onClick={() => void triggerAction('legacy-scan')}
              style={pillButtonStyle(false)}
            >
              {busyAction() === 'legacy-scan'
                ? tr('Scanning…', 'Verificando…')
                : tr('Scan Legacy & Drift', 'Verificar Legado & Drift')}
            </button>
            <button
              type="button"
              disabled={busyAction() !== null}
              onClick={() => void triggerAction('legacy-clean')}
              style={pillButtonStyle(false)}
            >
              {busyAction() === 'legacy-clean'
                ? tr('Cleaning…', 'Limpando…')
                : tr('Migrate & Clean Obsolete', 'Migrar & Limpar Obsoletos')}
            </button>
            <button
              type="button"
              disabled={busyAction() !== null}
              onClick={() => void triggerAction('legacy-purge')}
              style={{
                ...pillButtonStyle(confirmPurge()),
                border: '1px solid #ef4444',
                color: confirmPurge() ? '#111' : '#fca5a5',
                background: confirmPurge() ? '#ef4444' : 'transparent',
              }}
            >
              {busyAction() === 'legacy-purge'
                ? tr('Purging…', 'Apagando…')
                : confirmPurge()
                  ? tr('Confirm Purge (.pantheon)', 'Confirmar Limpeza Total (.pantheon)')
                  : tr('Purge Pantheon Data', 'Apagar Dados do Pantheon')}
            </button>
          </div>
        </div>
      </Show>

      {/* 8. Doctor, Changelog & About */}
      <Show when={section() === 'doctor'}>
        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>
            {tr('Doctor Health (File-Derived)', 'Saúde Doctor (Baseado em Arquivos)')}
          </div>
          <div style={rowStyle}>
            <span>{tr('Install Version', 'Versão Instalada')}</span>
            <span style={{ 'font-family': 'monospace' }}>
              {`${sharedSnapshot().doctor.installVersion} (${sharedSnapshot().doctor.installStatus})`}
            </span>
          </div>
          <div style={rowStyle}>
            <span>{`${tr('Node Runtime', 'Runtime Node')} (>= ${MIN_SUPPORTED_NODE_VERSION})`}</span>
            <span
              style={{
                'font-family': 'monospace',
                color: sharedSnapshot().doctor.nodeSupported ? '#4ade80' : '#f87171',
              }}
            >
              {`v${sharedSnapshot().doctor.nodeVersion}`}
            </span>
          </div>
          <div style={rowStyle}>
            <span>{tr('Overrides Health', 'Saúde das Substituições')}</span>
            <span style={{ 'font-family': 'monospace' }}>
              {sharedSnapshot().doctor.overridesStatus}
            </span>
          </div>
          <div style={rowStyle}>
            <span>{tr('Decision Config', 'Configuração de Decisão')}</span>
            <span style={{ 'font-family': 'monospace' }}>
              {sharedSnapshot().doctor.decisionStatus}
            </span>
          </div>
        </div>

        <Show when={sharedSnapshot().changelogHighlights.length > 0}>
          <div style={cardStyle}>
            <div style={{ 'font-weight': 600 }}>
              {`${tr("What's New in v", 'Novidades na v')}${resolveRunningVersion()}`}
            </div>
            <For each={sharedSnapshot().changelogHighlights.slice(0, 8)}>
              {(hl) => (
                <div style={{ 'font-size': '11px' }}>
                  <strong>{hl.title}</strong>
                  <span style={{ opacity: 0.75 }}>{`: ${hl.detail}`}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div style={cardStyle}>
          <div style={{ 'font-weight': 600 }}>
            {tr('Native Tools (30)', 'Ferramentas Nativas (30)')}
          </div>
          <For each={sharedSnapshot().aboutToolGroups}>
            {(grp) => (
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                <div style={rowStyle}>
                  <span style={{ 'font-size': '11px', 'font-weight': 600 }}>{grp.name}</span>
                  <span style={{ 'font-family': 'monospace', 'font-size': '10px', opacity: 0.8 }}>
                    {grp.value}
                  </span>
                </div>
                <span style={{ opacity: 0.65, 'font-size': '10px', 'font-family': 'monospace' }}>
                  {grp.note}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
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
          {tr('Refresh', 'Atualizar')}
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
        {tr(
          'Olympus Topology, interactive Agora Board, and Ephemeral Worker telemetry are active in the Pantheon side panel.',
          'Topologia Olympus, Board Agora interativo e telemetria de Workers Efêmeros estão ativos no painel lateral do Pantheon.',
        )}
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
      runAction: async (payload) => await runActionOnDisk(payload),
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
                {tr('Close', 'Fechar')}
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
          label:
            running > 0
              ? `Pantheon · ${running} ${tr('active', 'ativos')}`
              : `Pantheon · ${tr('ready', 'pronto')}`,
          tone: running > 0 ? 'success' : undefined,
          rows: [
            {
              id: 'open-cockpit',
              label: tr('Open Pantheon Cockpit', 'Abrir Cockpit Pantheon'),
              detail: `${sharedSnapshot().messages.length} msgs`,
              run: openCockpit,
            },
            {
              id: 'open-settings',
              label: tr('Open Pantheon Settings', 'Abrir Configurações Pantheon'),
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
