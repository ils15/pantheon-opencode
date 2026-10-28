import type { Context } from '@opencode/plugin/tui/context'
import { MODEL_USAGE_MESSAGE_LIMIT } from './model-usage-limits'
import { type OpenCodeGoRouteKind, QUOTA_PROVIDER_IDS, quotaRpc } from './quota-rpc'

export type QuotaDisplay = 'used' | 'remaining'
export type QuotaPreferences = { enabled: boolean; display: QuotaDisplay }
export const DEFAULT_QUOTA_PREFERENCES: QuotaPreferences = { enabled: true, display: 'remaining' }

export type QuotaMetric =
  | {
      kind: 'provider_quota'
      used: number
      remaining: number
      unit: string
      label?: string
      period?: string
      resetsAt?: number
    }
  | { kind: 'balance'; amount: number; currency: string; label?: string; status?: string }
  | { kind: 'estimate'; amount: number; unit: string; label?: string }
  | { kind: 'key_usage'; amount: number; currency: string; label?: string; period?: string }
  | { kind: 'session_usage'; amount: number; unit: string; label?: string }
  | {
      kind: 'provider_status'
      status: 'available' | 'unavailable' | 'active' | 'inactive'
      label: string
    }

export type QuotaProviderView = {
  id: string
  label: string
  quotaState: 'available' | 'unavailable'
  message?: string
  metrics: QuotaMetric[]
}

export type QuotaProviderDetail = {
  id: string
  label: string
  authentication: 'connected' | 'not_connected' | 'unavailable'
  state: 'available' | 'needs_setup' | 'unavailable'
  message?: string
  metrics: QuotaMetric[]
}

export type QuotaSnapshotStatus =
  | 'loading'
  | 'ready'
  | 'partial'
  | 'connected_unavailable'
  | 'needs_setup'
  | 'unavailable'
  | 'stale'
  | 'disabled'

export type QuotaSnapshot = {
  status: QuotaSnapshotStatus
  providers: QuotaProviderView[]
  details: QuotaProviderDetail[]
  updatedAt: number | null
  /** Short diagnostic of the latest transport/RPC failure; absent after a successful refresh. */
  error?: string | undefined
}

export const QUOTA_CLOCK_INTERVAL_MS = 60_000

export type QuotaClockOptions = {
  now?: () => number
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

export type QuotaClock = {
  subscribe: (listener: (now: number) => void) => () => void
}

/** Create a shared local clock for countdown displays; it never refreshes quota data. */
export function createQuotaClock(options: QuotaClockOptions = {}): QuotaClock {
  const now = options.now ?? Date.now
  const schedule = options.setInterval ?? globalThis.setInterval
  const cancel = options.clearInterval ?? globalThis.clearInterval
  const listeners = new Set<(now: number) => void>()
  let timer: ReturnType<typeof setInterval> | undefined

  const notify = (): void => {
    const currentTime = now()
    for (const listener of [...listeners]) listener(currentTime)
  }

  return {
    subscribe(listener): () => void {
      listeners.add(listener)
      if (timer === undefined) {
        timer = schedule(notify, QUOTA_CLOCK_INTERVAL_MS)
        timer.unref?.()
      }
      listener(now())

      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== undefined) {
          cancel(timer)
          timer = undefined
        }
      }
    },
  }
}

/** Module-local clock shared by all countdown consumers in the TUI bundle. */
export const quotaClock = createQuotaClock()

/** Format a provider-reported reset timestamp using the caller's local clock. */
export function formatQuotaCountdown(
  resetsAt: number | undefined,
  now: number,
): string | null | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || !Number.isFinite(now)) {
    return undefined
  }
  const remainingMs = resetsAt - now
  if (remainingMs <= 0) return null
  if (remainingMs < 60_000) return '<1m'

  const remainingMinutes = Math.ceil(remainingMs / 60_000)
  const days = Math.floor(remainingMinutes / (24 * 60))
  if (days > 0) {
    const hours = Math.floor((remainingMinutes % (24 * 60)) / 60)
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  const hours = Math.floor(remainingMinutes / 60)
  if (hours > 0) {
    const minutes = remainingMinutes % 60
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  return `${remainingMinutes}m`
}

export type QuotaSidebarEntry =
  | {
      kind: 'quota'
      key: string
      providerID: string
      providerLabel: string
      metric: Extract<QuotaMetric, { kind: 'provider_quota' }>
      progress: { usedPercent: number; remainingPercent: number }
    }
  | {
      kind: 'status'
      key: string
      providerID: string
      providerLabel: string
      message: string
    }

export type ModelContextSnapshot = { tokens: number; percent: number; limit: number }
export type RecentModelUsageRow = {
  providerID: string | null
  modelID: string | null
  label: string
  tokens: number | null
  cost: number | null
  context: ModelContextSnapshot | null
  active: boolean
}
export type CollectRecentModelUsageInput = {
  activeModel: unknown
  activeMessages: readonly unknown[]
  usageMessages: readonly unknown[]
  usageSessions?: readonly { messages: readonly unknown[]; revertMessageID?: string | null }[]
  models: readonly unknown[]
  revertMessageID?: string | null
}

const SETTINGS_KEY = 'pantheon.quota.preferences.v1'
const SNAPSHOT_KEY = 'pantheon.quota.live.v1'
const REFRESH_INTERVAL_MS = 60_000
const QUOTA_PROVIDER_ID_SET: ReadonlySet<string> = new Set(QUOTA_PROVIDER_IDS)

const INITIAL_SNAPSHOT: QuotaSnapshot = {
  status: 'loading',
  providers: [],
  details: [],
  updatedAt: null,
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function modelID(ref: unknown): string | null {
  const record = asRecord(ref)
  const id = typeof ref === 'string' ? ref : (record?.id ?? record?.modelID)
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

function messageModelRef(message: Record<string, unknown>): unknown {
  return message.model ?? message
}

function modelProvider(ref: unknown, models: readonly unknown[]): string | null {
  const direct = asRecord(ref)?.providerID
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  const id = modelID(ref)
  if (id === null) return null
  const segment = id.slice(id.lastIndexOf('/') + 1)
  const providers = new Set<string>()
  for (const candidate of models) {
    const item = asRecord(candidate)
    if (!item) continue
    if (item.id !== id && item.modelID !== id && item.id !== segment && item.modelID !== segment)
      continue
    if (typeof item.providerID === 'string' && item.providerID.trim() !== '') {
      providers.add(item.providerID.trim())
    }
  }
  const explicitProvider = id.includes('/') ? id.slice(0, id.indexOf('/')) : null
  if (explicitProvider && providers.has(explicitProvider)) return explicitProvider
  return providers.size === 1 ? ([...providers][0] ?? null) : null
}

function modelIdentity(
  ref: unknown,
  models: readonly unknown[],
): {
  key: string
  id: string
  providerID: string | null
  label: string
} | null {
  const id = modelID(ref)
  if (id === null) return null
  const providerID = modelProvider(ref, models)
  const segment = id.slice(id.lastIndexOf('/') + 1)
  return {
    key: `${providerID ?? ''}\u0000${id}`,
    id,
    providerID,
    label: segment || id,
  }
}

function tokenCount(message: Record<string, unknown>): number | null {
  const tokens = asRecord(message.tokens)
  if (!tokens) return null
  const cache = asRecord(tokens.cache)
  const values = [tokens.input, tokens.output, tokens.reasoning, cache?.read, cache?.write]
  const reported = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  )
  return reported.length === 0 ? null : reported.reduce((sum, value) => sum + value, 0)
}

function validCost(message: Record<string, unknown>): number | null {
  const cost = message.cost
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null
}

function contextLimit(ref: unknown, models: readonly unknown[]): number | null {
  const id = modelID(ref)
  if (id === null) return null
  const providerID = modelProvider(ref, models)
  if (providerID === null) return null
  const segment = id.slice(id.lastIndexOf('/') + 1)
  const matches = models.filter((value) => {
    const model = asRecord(value)
    if (!model) return false
    const idMatches =
      model.id === id || model.modelID === id || model.id === segment || model.modelID === segment
    return idMatches && model.providerID === providerID
  })
  const limits = new Set<number>()
  for (const candidate of matches) {
    const limit = asRecord(asRecord(candidate)?.limit)?.context
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) limits.add(limit)
  }
  return limits.size === 1 ? ([...limits][0] ?? null) : null
}

function liveTranscriptWindow(
  messages: readonly unknown[],
  revertMessageID: string | null | undefined,
): { start: number; end: number } {
  let end = messages.length
  if (revertMessageID) {
    const boundary = messages.findIndex((message) => asRecord(message)?.id === revertMessageID)
    if (boundary >= 0) end = boundary
  }
  let start = 0
  for (let index = end - 1; index >= 0; index -= 1) {
    if (asRecord(messages[index])?.type === 'compaction') {
      start = index + 1
      break
    }
  }
  return { start, end }
}

function latestContext(
  messages: readonly unknown[],
  modelRef: unknown,
  models: readonly unknown[],
  revertMessageID?: string | null,
): ModelContextSnapshot | null {
  const target = modelIdentity(modelRef, models)
  if (target === null || target.providerID === null) return null
  const limit = contextLimit(modelRef, models)
  if (limit === null || limit <= 0) return null
  const { start, end } = liveTranscriptWindow(messages, revertMessageID)
  for (let index = end - 1; index >= start; index -= 1) {
    const message = asRecord(messages[index])
    if (message?.type !== 'assistant') continue
    const identity = modelIdentity(messageModelRef(message), models)
    if (identity?.id !== target.id || identity.providerID !== target.providerID) continue
    const tokens = tokenCount(message)
    if (tokens === null || tokens <= 0) continue
    return { tokens, percent: Math.round((tokens / limit) * 100), limit }
  }
  return null
}

/** Snapshot for one exact model identity in the bounded active transcript. */
export function resolveModelContextSnapshot(
  messages: readonly unknown[],
  modelRef: unknown,
  models: readonly unknown[],
  revertMessageID?: string | null,
): ModelContextSnapshot | null {
  return latestContext(
    messages.slice(-MODEL_USAGE_MESSAGE_LIMIT),
    modelRef,
    models,
    revertMessageID,
  )
}

/** Select the pinned chat model before transcript or configured-agent fallbacks. */
export function resolveActiveModelRef(
  sessionModel: unknown,
  activeMessages: readonly unknown[],
  fallbackModel: unknown = null,
): unknown {
  if (modelID(sessionModel) !== null) return sessionModel

  const firstMessage = Math.max(0, activeMessages.length - MODEL_USAGE_MESSAGE_LIMIT)
  for (let index = activeMessages.length - 1; index >= firstMessage; index -= 1) {
    const message = asRecord(activeMessages[index])
    if (message?.type !== 'assistant') continue
    const ref = messageModelRef(message)
    if (modelID(ref) !== null) return ref
  }

  return modelID(fallbackModel) === null ? null : fallbackModel
}

/** Pin the active chat first, then rank two distinct models by summed reported
 * tokens from the already-cached, bounded session-family messages. */
export function collectRecentModelUsageRows(
  input: CollectRecentModelUsageInput,
): RecentModelUsageRow[] {
  const models = Array.isArray(input.models) ? input.models : []
  const activeMessages = input.activeMessages.slice(-MODEL_USAGE_MESSAGE_LIMIT)
  const contextSessions = input.usageSessions
    ? input.usageSessions.map((session) => ({
        ...session,
        messages: session.messages.slice(-MODEL_USAGE_MESSAGE_LIMIT),
      }))
    : [{ messages: input.usageMessages.slice(-MODEL_USAGE_MESSAGE_LIMIT), revertMessageID: null }]
  const usageMessages = contextSessions.flatMap((session) => session.messages)
  const active = modelIdentity(input.activeModel, models)
  const totals = new Map<
    string,
    {
      identity: NonNullable<ReturnType<typeof modelIdentity>>
      tokens: number | null
      cost: number | null
    }
  >()

  for (const value of usageMessages) {
    const message = asRecord(value)
    if (message?.type !== 'assistant') continue
    const identity = modelIdentity(messageModelRef(message), models)
    if (!identity) continue
    const current = totals.get(identity.key) ?? {
      identity,
      tokens: null,
      cost: null,
    }
    const tokens = tokenCount(message)
    const cost = validCost(message)
    if (tokens !== null) current.tokens = (current.tokens ?? 0) + tokens
    if (cost !== null) current.cost = (current.cost ?? 0) + cost
    totals.set(identity.key, current)
  }

  const latestContextMessages = new Map<
    string,
    { message: Record<string, unknown>; timestamp: number | null; index: number }
  >()
  let contextIndex = 0
  for (const session of contextSessions) {
    const messages = session.messages
    const { start, end } = liveTranscriptWindow(messages, session.revertMessageID)
    for (let index = start; index < end; index += 1) {
      const order = contextIndex
      contextIndex += 1
      const message = asRecord(messages[index])
      if (message?.type !== 'assistant' || (tokenCount(message) ?? 0) <= 0) continue
      const identity = modelIdentity(messageModelRef(message), models)
      if (!identity) continue
      const time = asRecord(message.time)
      const timestamp =
        typeof time?.created === 'number' && Number.isFinite(time.created) ? time.created : null
      const current = latestContextMessages.get(identity.key)
      if (
        current === undefined ||
        (timestamp !== null && current.timestamp !== null
          ? timestamp >= current.timestamp
          : order > current.index)
      ) {
        latestContextMessages.set(identity.key, { message, timestamp, index: order })
      }
    }
  }

  const activeUsage = active === null ? undefined : totals.get(active.key)
  const activeRow: RecentModelUsageRow = {
    providerID: active?.providerID ?? null,
    modelID: active?.id ?? null,
    label: active?.label ?? 'Modelo atual',
    tokens: activeUsage?.tokens ?? null,
    cost: activeUsage?.cost ?? null,
    context:
      active === null
        ? null
        : resolveModelContextSnapshot(
            activeMessages,
            input.activeModel,
            models,
            input.revertMessageID,
          ),
    active: true,
  }

  const ranked = [...totals.values()]
    .filter((entry) => entry.tokens !== null)
    .filter((entry) => {
      if (!active) return true
      return !(
        entry.identity.id === active.id &&
        (entry.identity.providerID === null ||
          active.providerID === null ||
          entry.identity.providerID === active.providerID)
      )
    })
    .sort(
      (left, right) =>
        (right.tokens ?? 0) - (left.tokens ?? 0) ||
        left.identity.label.localeCompare(right.identity.label) ||
        (left.identity.providerID ?? '').localeCompare(right.identity.providerID ?? ''),
    )
    .slice(0, 2)
    .map((entry): RecentModelUsageRow => {
      const latest = latestContextMessages.get(entry.identity.key)?.message
      const modelRef = latest === undefined ? undefined : messageModelRef(latest)
      const context = latest === undefined ? null : latestContext([latest], modelRef, models)
      return {
        providerID: entry.identity.providerID,
        modelID: entry.identity.id,
        label: entry.identity.label,
        tokens: entry.tokens,
        cost: entry.cost,
        context,
        active: false,
      }
    })

  return [activeRow, ...ranked]
}

export function normalizeQuotaPreferences(value: unknown): QuotaPreferences {
  const settings = asRecord(value)
  return {
    enabled:
      typeof settings?.enabled === 'boolean' ? settings.enabled : DEFAULT_QUOTA_PREFERENCES.enabled,
    display: settings?.display === 'used' ? 'used' : 'remaining',
  }
}

function providerLabel(id: string): string {
  return id
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ')
}

type ProviderStatusRecord = {
  provider: string
  label: string
  scope: 'account' | 'selected_key' | 'team' | 'session'
  authentication: 'connected' | 'not_connected' | 'unavailable'
  state: 'available' | 'needs_setup' | 'unavailable'
  reason: string
  route_kind?: OpenCodeGoRouteKind
  metrics: QuotaMetric[]
}

function providerStatus(value: unknown): ProviderStatusRecord | undefined {
  const item = asRecord(value)
  if (
    typeof item?.provider !== 'string' ||
    typeof item.label !== 'string' ||
    (item.scope !== 'account' &&
      item.scope !== 'selected_key' &&
      item.scope !== 'team' &&
      item.scope !== 'session') ||
    (item.authentication !== 'connected' &&
      item.authentication !== 'not_connected' &&
      item.authentication !== 'unavailable') ||
    (item.state !== 'available' && item.state !== 'needs_setup' && item.state !== 'unavailable') ||
    typeof item.reason !== 'string' ||
    (item.route_kind !== undefined &&
      item.route_kind !== 'api_key' &&
      item.route_kind !== 'console_oauth' &&
      item.route_kind !== 'none' &&
      item.route_kind !== 'unsupported') ||
    !Array.isArray(item.metrics)
  ) {
    return undefined
  }
  if (!QUOTA_PROVIDER_ID_SET.has(item.provider)) return undefined
  return {
    provider: item.provider,
    label: item.label,
    scope: item.scope,
    authentication: item.authentication,
    state: item.state,
    reason: item.reason,
    ...(item.route_kind === undefined ? {} : { route_kind: item.route_kind }),
    metrics: item.metrics as QuotaMetric[],
  }
}

function unavailableMessage(reason: string, provider?: string): string | undefined {
  if (provider === 'opencode-go' && reason === 'unauthorized') {
    return 'Pedido recusado; uso indisponível. Verifique o Console oficial.'
  }
  if (provider === 'opencode-go' && reason === 'not_subscribed') {
    return 'sem assinatura OpenCode Go nesta conta'
  }
  switch (reason) {
    case 'not_connected':
      return 'setup necessário'
    case 'unsupported':
      return 'fonte de credencial não suportada'
    case 'private_endpoint':
      return 'endpoint privado não validado'
    case 'eligibility_unverified':
      return 'elegibilidade da conta não comprovada'
    case 'runtime_accounting_unavailable':
      return 'dados de uso do runtime não disponíveis'
    case 'cli_identity_unavailable':
      return 'identidade do CLI não validada'
    case 'unsupported_credential_method':
      return 'método de autenticação não suportado'
    case 'rate_limited':
      return 'limite de consultas; aguarde'
    case 'unauthorized':
      return 'credencial rejeitada; reconecte o provedor'
    case 'forbidden':
      return 'acesso negado pelo provedor'
    case 'timeout':
      return 'tempo limite da consulta'
    case 'network_error':
      return 'falha de rede ao consultar'
    case 'invalid_response':
      return 'resposta inválida do provedor'
    case 'provider_error':
      return 'provedor temporariamente indisponível'
    default:
      return undefined
  }
}

function metricIsAvailable(metric: QuotaMetric): boolean {
  switch (metric.kind) {
    case 'provider_quota':
      return (
        Number.isFinite(metric.used) &&
        Number.isFinite(metric.remaining) &&
        metric.unit.trim().length > 0
      )
    case 'balance':
    case 'key_usage':
      return Number.isFinite(metric.amount) && metric.currency.trim().length > 0
    case 'estimate':
    case 'session_usage':
      return Number.isFinite(metric.amount) && metric.unit.trim().length > 0
    case 'provider_status':
      return metric.status !== 'unavailable'
  }
}

function providerHasAvailableMetrics(provider: ProviderStatusRecord): boolean {
  return provider.state === 'available' && provider.metrics.some(metricIsAvailable)
}

export function quotaSnapshotStatusLabel(
  status: QuotaSnapshotStatus,
  error?: string | undefined,
): string {
  switch (status) {
    case 'loading':
      return 'Buscando status…'
    case 'ready':
      return 'Quota disponível'
    case 'partial':
      return 'Quota parcialmente disponível'
    case 'connected_unavailable':
      return 'Credencial local · dados indisponíveis'
    case 'needs_setup':
      return 'Nenhum provedor elegível'
    case 'unavailable':
      return error !== undefined ? `Erro: ${error}` : 'Status indisponível'
    case 'stale':
      return 'Dados desatualizados'
    case 'disabled':
      return 'Desativado'
  }
}

/**
 * Short, UI-safe summary of a failed status request. OpenCode rejects plugin RPC calls
 * with a plain `{ type, message }` object (not an `Error`), so both shapes are handled;
 * `rpc.unavailable` means no server side registered the quota RPC in this run — the
 * historical "Status indisponível" blind spot.
 */
export function quotaRpcFaultMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error)
  const type =
    typeof error === 'object' && error !== null ? (error as { type?: unknown }).type : undefined
  const cleaned = message.trim().replace(/^Error:\s*/i, '')
  if (type === 'rpc.unavailable' || cleaned === 'rpc.unavailable') {
    return 'rpc de quota indisponível no servidor'
  }
  if (cleaned.length === 0) return 'erro desconhecido na consulta de quota'
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned
}

/** Map the current typed RPC status into a provider-neutral, data-only UI model. */
export function quotaSnapshotFromStatus(response: unknown, now = Date.now()): QuotaSnapshot {
  const statusResponse = asRecord(response)
  const credentialResolutionFailed = statusResponse?.credential_resolution_failed === true
  const providersValue = statusResponse?.providers
  const providerList = Array.isArray(providersValue) ? providersValue : undefined
  const statuses = providerList
    ? providerList
        .map(providerStatus)
        .filter((item): item is ProviderStatusRecord => item !== undefined)
    : []
  const connected = statuses.filter((item) => item.authentication === 'connected')
  const availableConnected = connected.filter(providerHasAvailableMetrics)
  const status: QuotaSnapshotStatus = credentialResolutionFailed
    ? connected.length > 0
      ? availableConnected.length > 0
        ? 'partial'
        : 'connected_unavailable'
      : 'unavailable'
    : connected.length > 0
      ? availableConnected.length === connected.length
        ? 'ready'
        : availableConnected.length > 0
          ? 'partial'
          : 'connected_unavailable'
      : (statuses.length === 0 && providerList?.length !== 0) ||
          statuses.some((item) => item.authentication === 'unavailable')
        ? 'unavailable'
        : 'needs_setup'

  const details = statuses.map((item): QuotaProviderDetail => {
    const hasMetrics = item.authentication === 'connected' && providerHasAvailableMetrics(item)
    const message =
      unavailableMessage(item.reason, item.provider) ??
      (item.authentication === 'connected' && !hasMetrics
        ? 'dados de quota indisponíveis'
        : undefined)
    return {
      id: item.provider,
      label: item.label || providerLabel(item.provider),
      authentication: item.authentication,
      state:
        item.authentication === 'not_connected'
          ? 'needs_setup'
          : hasMetrics
            ? 'available'
            : 'unavailable',
      ...(message === undefined ? {} : { message }),
      metrics: item.metrics,
    }
  })

  return {
    status,
    providers: connected.map((item) => {
      const hasMetrics = providerHasAvailableMetrics(item)
      const message =
        unavailableMessage(item.reason, item.provider) ??
        (!hasMetrics ? 'dados de quota indisponíveis' : undefined)
      return {
        id: item.provider,
        label: item.label || providerLabel(item.provider),
        quotaState: hasMetrics ? 'available' : 'unavailable',
        ...(message === undefined ? {} : { message }),
        metrics: item.metrics,
      }
    }),
    details,
    // A flagged credential-resolution failure is the server's diagnosed cause of an
    // aggregated unavailable status; surface it instead of a blind "Status indisponível".
    ...(status === 'unavailable' && credentialResolutionFailed
      ? { error: 'resolução de credenciais falhou no servidor' }
      : {}),
    updatedAt: now,
  }
}

function numeric(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}

function amount(value: number, unit: string): string | undefined {
  const formatted = numeric(value)
  const safeUnit = unit.trim()
  return formatted && safeUnit ? `${formatted} ${safeUnit}` : undefined
}

/** Return complementary whole percentages only when both quota values define a real range. */
export function quotaProgress(
  metric: Extract<QuotaMetric, { kind: 'provider_quota' }>,
): { usedPercent: number; remainingPercent: number } | undefined {
  if (
    !Number.isFinite(metric.used) ||
    !Number.isFinite(metric.remaining) ||
    metric.used < 0 ||
    metric.remaining < 0
  ) {
    return undefined
  }
  const total = metric.used + metric.remaining
  if (!Number.isFinite(total) || total <= 0) return undefined
  const usedPercent = Math.round((metric.used / total) * 100)
  return { usedPercent, remainingPercent: 100 - usedPercent }
}

/** Connected-provider rows for the compact sidebar; only reported quota windows are shown. */
export function quotaSidebarEntries(snapshot: QuotaSnapshot): QuotaSidebarEntry[] {
  const entries: QuotaSidebarEntry[] = []
  for (const provider of snapshot.providers) {
    let quotaCount = 0
    let hasQuotaMetric = false
    provider.metrics.forEach((metric, index) => {
      if (metric.kind !== 'provider_quota') return
      hasQuotaMetric = true
      if (metric.unit.trim() === '') return
      const progress = quotaProgress(metric)
      if (!progress) return
      quotaCount += 1
      entries.push({
        kind: 'quota',
        key: `${provider.id}:quota:${index}`,
        providerID: provider.id,
        providerLabel: provider.label,
        metric,
        progress,
      })
    })
    if (quotaCount === 0 && (provider.quotaState === 'unavailable' || hasQuotaMetric)) {
      entries.push({
        kind: 'status',
        key: `${provider.id}:status`,
        providerID: provider.id,
        providerLabel: provider.label,
        message: provider.message ?? 'dados de quota indisponíveis',
      })
    }
  }
  return entries
}

/** Render each measurement with its source/category label; no category is inferred. */
export function formatQuotaMetric(metric: QuotaMetric, display: QuotaDisplay): string | undefined {
  switch (metric.kind) {
    case 'provider_quota': {
      const used = amount(metric.used, metric.unit)
      const remaining = amount(metric.remaining, metric.unit)
      if (!used || !remaining) return undefined
      const label = metric.label ?? 'Quota do provedor'
      const period = metric.period ? ` · ${metric.period}` : ''
      return display === 'remaining'
        ? `${label} · restante ${remaining} · usado ${used}${period}`
        : `${label} · usado ${used} · restante ${remaining}${period}`
    }
    case 'balance': {
      const balance = amount(metric.amount, metric.currency)
      if (!balance) return undefined
      const status = metric.status?.trim()
      return `${metric.label ?? 'Saldo'} · ${balance}${status ? ` · ${status}` : ''}`
    }
    case 'estimate': {
      const estimate = amount(metric.amount, metric.unit)
      return estimate ? `${metric.label ?? 'Estimativa'} · ${estimate}` : undefined
    }
    case 'key_usage': {
      const usage = amount(metric.amount, metric.currency)
      const period = metric.period ? ` · ${metric.period}` : ''
      return usage ? `${metric.label ?? 'Uso da chave'} · ${usage}${period}` : undefined
    }
    case 'provider_status':
      return `${metric.label} · ${metric.status}`
    case 'session_usage': {
      const usage = amount(metric.amount, metric.unit)
      return usage ? `${metric.label ?? 'Uso da sessão'} · ${usage}` : undefined
    }
  }
}

/** Compact one-value summary for the footer; quota display follows the setting. */
export function compactQuotaMetric(metric: QuotaMetric, display: QuotaDisplay): string | undefined {
  switch (metric.kind) {
    case 'provider_quota': {
      const value = display === 'remaining' ? metric.remaining : metric.used
      const formatted = amount(value, metric.unit)
      return formatted
        ? `${metric.label ?? (display === 'remaining' ? 'restante' : 'usado')} ${formatted}`
        : undefined
    }
    case 'balance': {
      const formatted = amount(metric.amount, metric.currency)
      return formatted ? `${metric.label ?? 'saldo'} ${formatted}` : undefined
    }
    case 'estimate': {
      const formatted = amount(metric.amount, metric.unit)
      return formatted ? `${metric.label ?? 'estimativa'} ${formatted}` : undefined
    }
    case 'key_usage': {
      const formatted = amount(metric.amount, metric.currency)
      return formatted ? `${metric.label ?? 'uso da chave'} ${formatted}` : undefined
    }
    case 'provider_status':
      return `${metric.label} ${metric.status}`
    case 'session_usage': {
      const formatted = amount(metric.amount, metric.unit)
      return formatted ? `${metric.label ?? 'sessão'} ${formatted}` : undefined
    }
  }
}

export type QuotaRuntime = {
  preferences: () => QuotaPreferences
  snapshot: () => QuotaSnapshot
  toggleEnabled: () => Promise<void>
  toggleDisplay: () => Promise<void>
  refresh: () => Promise<void>
  dispose: () => void
}

/** One storage-backed source of truth for all quota TUI surfaces. */
export function createQuotaRuntime(
  context: Pick<Context, 'client' | 'data' | 'location' | 'storage'>,
): QuotaRuntime {
  const [settings, persistSettings] = context.storage.store<QuotaPreferences>(SETTINGS_KEY, {
    initial: { ...DEFAULT_QUOTA_PREFERENCES },
  })
  const [snapshot, setSnapshot] = context.storage.memory<QuotaSnapshot>(SNAPSHOT_KEY, {
    initial: { ...INITIAL_SNAPSHOT, providers: [] },
  })
  const client = context.client.rpc(quotaRpc)
  let unsubscribeCredentialChanges: (() => void) | undefined
  let requestController: AbortController | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let requestVersion = 0
  let disposed = false

  const preferences = (): QuotaPreferences =>
    normalizeQuotaPreferences({ enabled: settings.enabled, display: settings.display })
  const currentSnapshot = (): QuotaSnapshot => ({
    status: snapshot.status,
    providers: snapshot.providers,
    details: snapshot.details ?? [],
    updatedAt: snapshot.updatedAt,
    error: snapshot.error,
  })
  const updateSnapshot = (next: QuotaSnapshot): void => {
    setSnapshot((draft) => {
      draft.status = next.status
      draft.providers = next.providers
      draft.details = next.details
      draft.updatedAt = next.updatedAt
      draft.error = next.error
    })
  }

  const cancelScheduledRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = undefined
  }

  const scheduleRefresh = (): void => {
    cancelScheduledRefresh()
    if (disposed || !preferences().enabled) return
    refreshTimer = setTimeout(() => {
      void refresh()
    }, REFRESH_INTERVAL_MS)
    refreshTimer.unref?.()
  }

  const refresh = async (): Promise<void> => {
    if (disposed) return
    if (!preferences().enabled) {
      updateSnapshot({ status: 'disabled', providers: [], details: [], updatedAt: null })
      return
    }

    requestController?.abort()
    const controller = new AbortController()
    requestController = controller
    const version = ++requestVersion
    const previous = currentSnapshot()
    updateSnapshot({
      ...previous,
      status: previous.updatedAt === null ? 'loading' : 'stale',
    })

    try {
      const response = await client.status(
        {},
        {
          signal: controller.signal,
          location: context.location ?? context.data.location.default(),
        },
      )
      if (!disposed && version === requestVersion) {
        updateSnapshot(quotaSnapshotFromStatus(response))
      }
    } catch (error) {
      if (!disposed && version === requestVersion && !controller.signal.aborted) {
        // A failed refresh keeps the last valid snapshot (providers, details, updatedAt)
        // instead of wiping it, and records the real cause so the UI never shows a blind
        // "Status indisponível". Without prior data the status stays unavailable.
        const fault = quotaRpcFaultMessage(error)
        console.warn(`[pantheon-tui quota] status request failed: ${fault}`)
        updateSnapshot({
          ...previous,
          status: previous.updatedAt === null ? 'unavailable' : 'stale',
          error: fault,
        })
      }
    } finally {
      if (requestController === controller) {
        requestController = undefined
        scheduleRefresh()
      }
    }
  }

  const runtime: QuotaRuntime = {
    preferences,
    snapshot: currentSnapshot,
    async toggleEnabled(): Promise<void> {
      const enabled = !preferences().enabled
      if (!enabled) {
        requestVersion += 1
        requestController?.abort()
        requestController = undefined
        cancelScheduledRefresh()
      }
      await persistSettings((draft) => {
        draft.enabled = enabled
      })
      if (enabled) {
        updateSnapshot({ status: 'loading', providers: [], details: [], updatedAt: null })
        await refresh()
      } else {
        updateSnapshot({ status: 'disabled', providers: [], details: [], updatedAt: null })
      }
    },
    async toggleDisplay(): Promise<void> {
      const display = preferences().display === 'remaining' ? 'used' : 'remaining'
      await persistSettings((draft) => {
        draft.display = display
      })
    },
    refresh,
    dispose(): void {
      disposed = true
      requestVersion += 1
      requestController?.abort()
      requestController = undefined
      cancelScheduledRefresh()
      unsubscribeCredentialChanges?.()
    },
  }

  unsubscribeCredentialChanges = client.events?.on('credentials_changed', () => {
    updateSnapshot({ status: 'loading', providers: [], details: [], updatedAt: null })
    void refresh()
  })

  if (preferences().enabled) {
    // `memory()` survives plugin hot reloads. Do not expose quota rows written by
    // older versions until the current RPC confirms the eligible provider set.
    updateSnapshot({ status: 'loading', providers: [], details: [], updatedAt: null })
    void refresh()
  } else {
    updateSnapshot({ status: 'disabled', providers: [], details: [], updatedAt: null })
  }

  return runtime
}
