/** @jsxImportSource @opentui/solid */
// biome-ignore-all lint/a11y/noStaticElementInteractions: OpenTUI has no DOM roles; mouse controls have keyboard equivalents.

import type { Context, KeymapCommand, KeymapLayer, PanelInput } from '@opencode/plugin/tui/context'
import { icon } from '@profullstack/hqtui'
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from 'solid-js'
import {
  contextBar,
  contextUsageTone,
  formatContextWindow,
  formatTokenCount,
} from './context-gauge'
import { quotaGoCheckCommand } from './go-key-diagnostic-ui'
import { MODEL_USAGE_MESSAGE_LIMIT, MODEL_USAGE_SESSION_LIMIT } from './model-usage-limits'
import {
  collectRecentModelUsageRows,
  compactQuotaMetric,
  formatQuotaCountdown,
  type QuotaMetric,
  type QuotaProviderDetail,
  type QuotaRuntime,
  type QuotaSidebarEntry,
  type QuotaSnapshot,
  quotaClock,
  quotaProgress,
  quotaSidebarEntries,
  quotaSnapshotStatusLabel,
  type RecentModelUsageRow,
  resolveActiveModelRef,
} from './quota-v2-model'
import { cellWidth, SIDEBAR_CONTENT_WIDTH } from './sidebar-width'
import { ActiveContextEstimate, UsageHistorySection } from './usage-history-view'
import { activeModelIdentity, sessionSpendLabel } from './usage-view-model'

export const QUOTA_PANEL_NAME = 'pantheon.quota'
export const QUOTA_OPEN_COMMAND_ID = 'pantheon.quota.open'
export type QuotaIconMode = 'nerd' | 'unicode' | 'ascii'
export type QuotaIconName =
  | 'check'
  | 'close'
  | 'clock'
  | 'gauge'
  | 'plug'
  | 'refresh'
  | 'settings'
  | 'sliders'
  | 'warning'

export function quotaIcon(name: QuotaIconName, mode?: QuotaIconMode): string {
  return icon(name, mode ? { mode } : undefined)
}

function iconInSlot(name: QuotaIconName, width: number, mode?: QuotaIconMode): string {
  const glyph = quotaIcon(name, mode)
  return `${glyph}${' '.repeat(Math.max(0, width - cellWidth(glyph)))}`
}

export const QUOTA_ICON = quotaIcon('refresh')
const QUOTA_PANEL_TOAST = 'Abra uma sessão para ver os detalhes da quota.'

type QuotaSurfaceProps = { context: Context; runtime: QuotaRuntime }

const MODEL_USAGE_REFRESH_EVENTS = [
  'session.created',
  'session.renamed',
  'session.metadata.updated',
  'session.moved',
  'session.idle',
  'session.status',
  'session.deleted',
] as const satisfies readonly Parameters<Context['data']['on']>[0][]

function base(context: Context) {
  return context.theme.text?.base ?? (context.themeMode === 'dark' ? '#ffffff' : '#111111')
}

function muted(context: Context) {
  return context.theme.text?.muted ?? base(context)
}

export function quotaUsageTone(usedPercent: number): 'success' | 'warning' | 'error' {
  return usedPercent > 85 ? 'error' : usedPercent >= 60 ? 'warning' : 'success'
}

function quotaColor(context: Context, usedPercent: number | undefined): string {
  return usedPercent === undefined ? base(context) : tone(context, quotaUsageTone(usedPercent))
}

type QuotaTone = 'info' | 'success' | 'warning' | 'error'

function tone(context: Context, color: QuotaTone): string {
  return context.theme.text?.feedback?.[color]?.base ?? base(context)
}

export function snapshotSummary(snapshot: QuotaSnapshot, display: 'used' | 'remaining'): string {
  if (snapshot.status === 'loading') return 'carregando status'
  if (snapshot.status !== 'ready' && snapshot.status !== 'partial') {
    // Reuse the sidebar label map (fault-aware for `unavailable`) so the footer
    // never contradicts the sidebar; lowercase matches the footer style.
    return quotaSnapshotStatusLabel(snapshot.status, snapshot.error).toLowerCase()
  }
  const metrics = snapshot.providers.flatMap((provider) => provider.metrics)
  const metric = metrics.find((item) => item.kind !== 'provider_status') ?? metrics[0]
  if (metric) {
    const value = compactQuotaMetric(metric, display) ?? 'quota indisponível'
    return snapshot.status === 'partial' ? `quota parcialmente disponível · ${value}` : value
  }
  if (snapshot.status === 'partial') return 'quota parcialmente disponível'
  if (snapshot.providers[0]?.message) return snapshot.providers[0].message
  return 'quota indisponível'
}

type FinanceMetric = Extract<QuotaMetric, { kind: 'balance' | 'estimate' | 'key_usage' }>
type FinanceEntry = { providerID: string; metric: FinanceMetric }

export function sidebarFinanceEntries(snapshot: QuotaSnapshot): FinanceEntry[] {
  return snapshot.providers.flatMap((provider) =>
    provider.metrics.flatMap((metric) =>
      (metric.kind === 'balance' || metric.kind === 'estimate' || metric.kind === 'key_usage') &&
      metricRow(metric)
        ? [{ providerID: provider.id, metric }]
        : [],
    ),
  )
}

function QuotaSidebarEntryRow(props: {
  entry: QuotaSidebarEntry
  display: 'used' | 'remaining'
  context: Context
  now: number
}): JSX.Element {
  return (
    <Show
      when={props.entry.kind === 'quota'}
      fallback={
        <For
          each={
            props.entry.kind === 'status'
              ? quotaTextLines(props.entry.message, SIDEBAR_CONTENT_WIDTH, 2)
              : []
          }
        >
          {(line) => <text fg={muted(props.context)}>{line}</text>}
        </For>
      }
    >
      <For
        each={
          props.entry.kind === 'quota'
            ? quotaWindowLines(
                props.entry.metric,
                props.display,
                SIDEBAR_CONTENT_WIDTH,
                props.now,
                true,
              )
            : []
        }
      >
        {(line) => (
          <text
            fg={quotaColor(
              props.context,
              props.entry.kind === 'quota' ? props.entry.progress.usedPercent : undefined,
            )}
          >
            {line}
          </text>
        )}
      </For>
    </Show>
  )
}

export function QuotaSidebarSummary(props: QuotaSurfaceProps): JSX.Element {
  const entries = createMemo(() => quotaSidebarEntries(props.runtime.snapshot()))
  const finance = createMemo(() => sidebarFinanceEntries(props.runtime.snapshot()))
  const [now, setNow] = createSignal(Date.now())
  onMount(() => onCleanup(quotaClock.subscribe(setNow)))
  return (
    <Show when={props.runtime.preferences().enabled}>
      <box flexDirection="column" marginTop={1}>
        <text fg={base(props.context)}>{`${QUOTA_ICON} Pantheon quota`}</text>
        <Show when={props.runtime.snapshot().status !== 'ready' || entries().length === 0}>
          <text fg={muted(props.context)}>
            {quotaSnapshotStatusLabel(
              props.runtime.snapshot().status,
              props.runtime.snapshot().error,
            )}
          </text>
        </Show>
        <For each={props.runtime.snapshot().providers}>
          {(provider) => (
            <box flexDirection="column">
              <Show
                when={
                  entries().some((entry) => entry.providerID === provider.id) ||
                  finance().some((entry) => entry.providerID === provider.id) ||
                  provider.metrics.some((metric) => metric.kind === 'provider_status')
                }
              >
                <For each={quotaTextLines(provider.label, SIDEBAR_CONTENT_WIDTH, 0)}>
                  {(line) => <text fg={muted(props.context)}>{line}</text>}
                </For>
              </Show>
              <For each={entries().filter((entry) => entry.providerID === provider.id)}>
                {(entry) => (
                  <QuotaSidebarEntryRow
                    entry={entry}
                    display={props.runtime.preferences().display}
                    context={props.context}
                    now={now()}
                  />
                )}
              </For>
              <For each={provider.metrics.filter((metric) => metric.kind === 'provider_status')}>
                {(metric) => (
                  <For each={quotaMetricLines(metric, SIDEBAR_CONTENT_WIDTH)}>
                    {(line) => <text fg={muted(props.context)}>{line}</text>}
                  </For>
                )}
              </For>
              <For each={finance().filter((entry) => entry.providerID === provider.id)}>
                {(entry) => (
                  <For each={financeMetricLines(entry.metric, SIDEBAR_CONTENT_WIDTH)}>
                    {(line) => <text fg={base(props.context)}>{line}</text>}
                  </For>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

function QuotaFooterSummary(props: QuotaSurfaceProps) {
  const preferences = () => props.runtime.preferences()
  return (
    <Show when={preferences().enabled}>
      <text fg={muted(props.context)}>
        {`Quota · ${snapshotSummary(props.runtime.snapshot(), preferences().display)}`}
      </text>
    </Show>
  )
}

function clipped(value: string, width: number): string {
  const max = Math.max(5, Math.floor(width) - 2)
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

type QuotaWindowMetric = Extract<QuotaMetric, { kind: 'provider_quota' }>

function quotaAmount(value: number, unit: string): string | undefined {
  const safeUnit = unit.trim()
  if (!Number.isFinite(value) || !safeUnit) return undefined
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} ${safeUnit}`
}

function quotaResetDate(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || !Number.isFinite(now))
    return undefined
  const date = new Date(resetsAt)
  if (!Number.isFinite(date.getTime()) || resetsAt <= now) return undefined
  return `Resets on ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Wrap on grapheme boundaries, measuring terminal cells rather than code units. */
export function quotaTextLines(text: string, width: number, indent: number): string[] {
  const max = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  if (max < 1) return []
  const padding = ' '.repeat(Math.min(Math.max(0, indent), Math.max(0, max - 2)))
  const lines: string[] = []
  let line = padding
  const segmenter = new Intl.Segmenter()
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue
    if (line.trim() && cellWidth(line) + 1 + cellWidth(word) > max) {
      lines.push(line.trimEnd())
      line = padding
    }
    if (line.trim()) line += ' '
    for (const { segment } of segmenter.segment(word)) {
      const glyphWidth = cellWidth(segment)
      if (glyphWidth > max) continue
      if (cellWidth(line) + glyphWidth > max) {
        if (line.trim()) lines.push(line.trimEnd())
        line = glyphWidth + cellWidth(padding) <= max ? padding : ''
      }
      line += segment
    }
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines
}

/** Layout uses only a provider-reported reset; a local clock never refreshes data. */
export function quotaWindowLines(
  metric: QuotaWindowMetric,
  display: 'used' | 'remaining',
  width: number,
  now: number,
  sidebarPercent = false,
): string[] {
  const title = metric.period?.trim() || metric.label?.trim() || 'Quota'
  const progress = quotaProgress(metric)
  const amount =
    sidebarPercent && progress
      ? `${display === 'remaining' ? progress.remainingPercent : progress.usedPercent}%`
      : quotaAmount(display === 'remaining' ? metric.remaining : metric.used, metric.unit)
  if (!amount) return []
  const value = `${amount} ${display === 'remaining' ? 'rest.' : 'uso'}`
  const countdown = formatQuotaCountdown(metric.resetsAt, now)
  const reset =
    countdown === null ? '(aguardando atualização)' : countdown ? `(${countdown})` : undefined
  const resetDate =
    countdown !== undefined && countdown !== null ? quotaResetDate(metric.resetsAt, now) : undefined
  const resetDateLines = resetDate ? quotaTextLines(resetDate, width, 4) : []
  const padded = `  ${title.padEnd(8)} ${value}`
  const compact = `  ${title} ${value}`
  const prefix = cellWidth(padded) <= width ? padded : compact
  const suffix = reset ? ` ${reset}` : ''
  const secondaryAmount = sidebarPercent
    ? undefined
    : quotaAmount(display === 'remaining' ? metric.used : metric.remaining, metric.unit)
  const secondary = secondaryAmount
    ? quotaTextLines(
        `${display === 'remaining' ? 'Usado' : 'Restante'} ${secondaryAmount}`,
        width,
        4,
      )
    : []
  if (!sidebarPercent && progress) {
    secondary.push(...quotaTextLines(`${progress.remainingPercent}% restante`, width, 4))
  }
  if (cellWidth(prefix + suffix) <= width)
    return [`${prefix}${suffix}`, ...resetDateLines, ...secondary]
  if (cellWidth(prefix) <= width)
    return reset
      ? [prefix, ...quotaTextLines(reset, width, 4), ...resetDateLines, ...secondary]
      : [prefix, ...resetDateLines, ...secondary]
  return [
    ...quotaTextLines(title, width, 2),
    ...quotaTextLines(value, width, 4),
    ...(reset ? quotaTextLines(reset, width, 4) : []),
    ...resetDateLines,
    ...secondary,
  ]
}

function QuotaWindow(props: {
  metric: QuotaWindowMetric
  display: 'used' | 'remaining'
  width: number
  context: Context
  now: number
}): JSX.Element {
  return (
    <box flexDirection="column">
      <For each={quotaWindowLines(props.metric, props.display, props.width, props.now)}>
        {(line) => (
          <text fg={quotaColor(props.context, quotaProgress(props.metric)?.usedPercent)}>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

type QuotaMetricRow = { label: string; value: string }

function metricRow(
  metric: Exclude<QuotaMetric, { kind: 'provider_quota' }>,
): QuotaMetricRow | undefined {
  const label = (fallback: string): string => metric.label?.trim() || fallback
  switch (metric.kind) {
    case 'balance': {
      const value = quotaAmount(metric.amount, metric.currency)
      return value
        ? {
            label: label('Saldo'),
            value: `${value}${metric.status?.trim() ? ` · ${metric.status.trim()}` : ''}`,
          }
        : undefined
    }
    case 'estimate': {
      const value = quotaAmount(metric.amount, metric.unit)
      return value ? { label: label('Estimativa'), value } : undefined
    }
    case 'key_usage': {
      const value = quotaAmount(metric.amount, metric.currency)
      if (!value) return undefined
      const source = label('Uso da chave selecionada')
      const scopedLabel = /selected\s+key|chave selecionada/i.test(source)
        ? source
        : `Chave selecionada · ${source}`
      return {
        label: scopedLabel,
        value: `${value}${metric.period?.trim() ? ` · ${metric.period.trim()}` : ''}`,
      }
    }
    case 'session_usage': {
      const value = quotaAmount(metric.amount, metric.unit)
      return value ? { label: label('Uso da sessão'), value } : undefined
    }
    case 'provider_status':
      return { label: metric.label, value: metric.status }
  }
}

export function financeMetricLines(metric: FinanceMetric, width: number): string[] {
  return quotaMetricLines(metric, width)
}

export function quotaMetricLines(
  metric: Exclude<QuotaMetric, { kind: 'provider_quota' }>,
  width: number,
): string[] {
  const row = metricRow(metric)
  if (!row) return []
  const left = `  ${row.label}`
  const spaces = width - cellWidth(left) - cellWidth(row.value)
  if (spaces >= 2) return [`${left}${' '.repeat(spaces)}${row.value}`]
  return [...quotaTextLines(row.label, width, 2), ...quotaTextLines(row.value, width, 4)]
}

function QuotaMetricLine(props: {
  metric: Exclude<QuotaMetric, { kind: 'provider_quota' }>
  width: number
  context: Context
}) {
  const row = () => metricRow(props.metric)
  return (
    <Show when={row()}>
      <box flexDirection="column">
        <For each={quotaMetricLines(props.metric, props.width)}>
          {(line) => <text fg={base(props.context)}>{line}</text>}
        </For>
      </box>
    </Show>
  )
}

export function providerState(
  provider: QuotaProviderDetail,
  mode?: QuotaIconMode,
): { label: string; tone: QuotaTone } {
  if (provider.authentication === 'not_connected')
    return { label: `${iconInSlot('settings', 2, mode)} Precisa configurar`, tone: 'warning' }
  if (provider.authentication === 'unavailable')
    return { label: `${iconInSlot('close', 2, mode)} Indisponível`, tone: 'error' }
  return provider.state === 'available'
    ? {
        label: `${iconInSlot('check', 2, mode)} Credencial local · há dados`,
        tone: 'success',
      }
    : {
        label: `${iconInSlot('warning', 2, mode)} Credencial local · sem dados`,
        tone: 'warning',
      }
}

function recentModelUsage(context: Context, sessionID: string): RecentModelUsageRow[] {
  if (!sessionID.startsWith('ses')) {
    return collectRecentModelUsageRows({
      activeModel: null,
      activeMessages: [],
      usageMessages: [],
      models: [],
    })
  }

  let session: ReturnType<Context['data']['session']['get']>
  let activeMessages: unknown[] = []
  try {
    session = context.data.session.get(sessionID)
  } catch {
    session = undefined
  }
  const messagesBySession = new Map<string, unknown[]>()
  try {
    const messages = context.data.session.message.list(sessionID)
    if (Array.isArray(messages)) {
      activeMessages = messages.slice(-MODEL_USAGE_MESSAGE_LIMIT)
      messagesBySession.set(sessionID, activeMessages)
    }
  } catch {
    /* Cached session metadata can still identify the active model. */
  }

  const sessionIDs = [sessionID]
  try {
    const family = context.data.session.family(sessionID)
    if (Array.isArray(family)) {
      for (const id of family) {
        if (typeof id !== 'string' || !id.startsWith('ses') || sessionIDs.includes(id)) continue
        sessionIDs.push(id)
        if (sessionIDs.length >= MODEL_USAGE_SESSION_LIMIT) break
      }
    }
  } catch {
    /* The active session still supplies its cached messages when family is absent. */
  }

  const usageMessages: unknown[] = []
  const usageSessions: Array<{ messages: readonly unknown[]; revertMessageID: string | null }> = []
  for (const id of sessionIDs) {
    let messages = messagesBySession.get(id) ?? []
    if (!messagesBySession.has(id)) {
      try {
        const result = context.data.session.message.list(id)
        if (Array.isArray(result)) messages = result.slice(-MODEL_USAGE_MESSAGE_LIMIT)
      } catch {
        /* One unreadable child must not hide usage from the rest of the family. */
      }
    }
    messagesBySession.set(id, messages)
    usageMessages.push(...messages)
    let familySession = session
    if (id !== sessionID) {
      try {
        familySession = context.data.session.get(id)
      } catch {
        familySession = undefined
      }
    }
    const revert = familySession?.revert
    const revertMessageID =
      typeof revert === 'object' && revert !== null && typeof revert.messageID === 'string'
        ? revert.messageID
        : null
    usageSessions.push({ messages, revertMessageID })
  }

  let models: unknown[] = []
  let fallbackModel: unknown = null
  try {
    const location = context.location ?? context.data.location.default()
    const result = context.data.location.model.list(location)
    if (Array.isArray(result)) models = result
    const agentID = session?.agent
    if (typeof agentID === 'string' && agentID !== '') {
      const agents = context.data.location.agent?.list?.(location)
      if (Array.isArray(agents)) {
        fallbackModel = agents.find((agent) => agent?.id === agentID)?.model ?? null
      }
    }
  } catch {
    /* Unknown model limits suppress only the context bars. */
  }

  const activeModel = resolveActiveModelRef(session?.model, activeMessages, fallbackModel)
  const revert = session?.revert
  const revertMessageID =
    typeof revert === 'object' && revert !== null && typeof revert.messageID === 'string'
      ? revert.messageID
      : null

  return collectRecentModelUsageRows({
    activeModel,
    activeMessages,
    usageMessages,
    usageSessions,
    models,
    revertMessageID,
  })
}

export function activeQuotaModelLabel(row: RecentModelUsageRow | undefined): string {
  return row ? `Modelo ativo · ${activeModelIdentity(row)}` : 'Modelo ativo indisponível'
}

export function quotaPanelStatusMessage(
  snapshot: Pick<QuotaSnapshot, 'status' | 'error'>,
): string | undefined {
  if (snapshot.status === 'partial') return 'Dados parciais'
  if (snapshot.status === 'ready') return undefined
  return quotaSnapshotStatusLabel(snapshot.status, snapshot.error)
}

function useRecentModelUsage(context: Context, sessionID: string): () => RecentModelUsageRow[] {
  const [revision, setRevision] = createSignal(0)
  const rows = createMemo(() => {
    revision()
    return recentModelUsage(context, sessionID)
  })
  onMount(() => {
    const unsubscribe: Array<() => void> = []
    for (const event of MODEL_USAGE_REFRESH_EVENTS) {
      try {
        unsubscribe.push(context.data.on(event, () => setRevision((value) => value + 1)))
      } catch {
        /* Cached values stay renderable if a host event is unavailable. */
      }
    }
    onCleanup(() => {
      for (const dispose of unsubscribe) dispose()
    })
  })
  return rows
}

function ActiveModelHeader(props: {
  context: Context
  sessionID: string
  width: number
  snapshot: QuotaSnapshot
}): JSX.Element {
  const rows = useRecentModelUsage(props.context, props.sessionID)
  const activeModel = createMemo(() => rows().find((row) => row.active))
  const status = () => props.snapshot.status
  const message = () => quotaPanelStatusMessage(props.snapshot)
  const modelLine = () => activeQuotaModelLabel(activeModel())
  return (
    <box flexDirection="column">
      <For each={quotaTextLines(modelLine(), props.width, 0)}>
        {(line) => <text fg={base(props.context)}>{line}</text>}
      </For>
      <Show when={message()}>
        {(label) => (
          <For each={quotaTextLines(label(), props.width, 0)}>
            {(line) => (
              <text
                fg={
                  status() === 'partial'
                    ? tone(props.context, 'warning')
                    : tone(props.context, status() === 'unavailable' ? 'error' : 'info')
                }
              >
                {line}
              </text>
            )}
          </For>
        )}
      </Show>
    </box>
  )
}

function ModelUsageDetails(props: { context: Context; sessionID: string; width: number }) {
  const rows = useRecentModelUsage(props.context, props.sessionID)

  const contextTone = (percent: number) => tone(props.context, contextUsageTone(percent))
  const contextCells = () => Math.max(4, Math.min(12, Math.floor((props.width - 30) / 2)))
  const modelLabel = (row: RecentModelUsageRow) =>
    `${row.providerID ? `${row.providerID}/` : ''}${row.label}`

  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={tone(props.context, 'info')} attributes={1}>
        Modelos em uso
      </text>
      <text fg={muted(props.context)}>Mensagens recentes da sessão ativa e delegações.</text>
      <For each={rows()}>
        {(row, index) => (
          <>
            <Show when={row.active}>
              <For
                each={quotaTextLines(`MODELO ATUAL · ${activeModelIdentity(row)}`, props.width, 0)}
              >
                {(line) => (
                  <text fg={tone(props.context, 'info')} attributes={1}>
                    {line}
                  </text>
                )}
              </For>
            </Show>
            <Show when={!row.active && index() === 1}>
              <text fg={muted(props.context)} attributes={1}>
                MAIS USADOS RECENTEMENTE
              </text>
            </Show>
            <box flexDirection="column" paddingTop={1} paddingLeft={1}>
              <text fg={base(props.context)} attributes={1}>
                {clipped(modelLabel(row), props.width - 2)}
              </text>
              <Show
                when={row.tokens !== null}
                fallback={<text fg={muted(props.context)}>dados indisponíveis</text>}
              >
                <box flexDirection="row" justifyContent="space-between" gap={1}>
                  <text fg={muted(props.context)}>Tokens nas mensagens recentes</text>
                  <text fg={base(props.context)}>{`${formatTokenCount(row.tokens) ?? '—'}`}</text>
                </box>
              </Show>
              <Show when={row.context}>
                {(usage) => {
                  const bar = () => contextBar(usage().percent, contextCells())
                  return (
                    <box flexDirection="column" paddingTop={1}>
                      <box flexDirection="row" justifyContent="space-between" gap={1}>
                        <text fg={muted(props.context)}>Último contexto reportado</text>
                        <text fg={contextTone(usage().percent)}>
                          {`${formatTokenCount(usage().tokens) ?? '—'} tokens`}
                        </text>
                      </box>
                      <box flexDirection="row" gap={1}>
                        <Show when={bar()}>
                          {(cells) => (
                            <>
                              <text fg={contextTone(usage().percent)}>{cells().filled}</text>
                              <text fg={muted(props.context)}>{cells().empty}</text>
                            </>
                          )}
                        </Show>
                        <text fg={contextTone(usage().percent)}>
                          {`${usage().percent}% de ${formatContextWindow(usage().limit) ?? '—'}`}
                        </text>
                      </box>
                    </box>
                  )
                }}
              </Show>
              <Show when={row.tokens !== null && row.context === null}>
                <text fg={muted(props.context)}>Contexto indisponível</text>
              </Show>
              <Show when={row.active}>
                <ActiveContextEstimate
                  context={props.context}
                  providerID={row.providerID}
                  modelID={row.modelID}
                  contextTokens={row.context?.tokens ?? null}
                  width={props.width - 2}
                />
              </Show>
              <Show when={row.cost === null ? null : sessionSpendLabel(row.cost)}>
                {(label) => (
                  <For each={quotaTextLines(label(), props.width - 2, 0)}>
                    {(line) => <text fg={muted(props.context)}>{line}</text>}
                  </For>
                )}
              </Show>
            </box>
          </>
        )}
      </For>
    </box>
  )
}

function QuotaProviderDetails(props: {
  provider: QuotaProviderDetail
  display: 'used' | 'remaining'
  width: number
  context: Context
}) {
  const [now, setNow] = createSignal(Date.now())
  onMount(() => onCleanup(quotaClock.subscribe(setNow)))
  const state = () => providerState(props.provider)
  const quotaMetrics = () =>
    props.provider.metrics.filter(
      (metric): metric is QuotaWindowMetric => metric.kind === 'provider_quota',
    )
  const financeMetrics = () =>
    props.provider.metrics.filter(
      (metric) =>
        metric.kind === 'balance' || metric.kind === 'estimate' || metric.kind === 'key_usage',
    )
  const otherMetrics = () =>
    props.provider.metrics.filter(
      (metric) => metric.kind === 'provider_status' || metric.kind === 'session_usage',
    )
  const safeError = () => {
    const message = props.provider.message
    return message &&
      message !== 'status indisponível' &&
      message !== 'dados de quota indisponíveis' &&
      message !== 'setup necessário'
      ? message
      : undefined
  }

  return (
    <box flexDirection="column" paddingBottom={1}>
      <For each={quotaTextLines(props.provider.label, props.width, 0)}>
        {(line) => (
          <text fg={tone(props.context, 'info')} attributes={1}>
            {line}
          </text>
        )}
      </For>
      <For each={quotaTextLines(state().label, props.width, 0)}>
        {(line) => <text fg={tone(props.context, state().tone)}>{line}</text>}
      </For>
      <Show when={quotaMetrics().length > 0}>
        <For each={quotaMetrics()}>
          {(metric) => (
            <QuotaWindow
              metric={metric}
              now={now()}
              display={props.display}
              width={props.width}
              context={props.context}
            />
          )}
        </For>
      </Show>
      <Show when={financeMetrics().length > 0}>
        <text fg={muted(props.context)}>GASTOS &amp; SALDO</text>
        <For each={financeMetrics()}>
          {(metric) => (
            <QuotaMetricLine metric={metric} width={props.width} context={props.context} />
          )}
        </For>
      </Show>
      <Show when={otherMetrics().length > 0}>
        <text fg={muted(props.context)}>OUTRAS MÉTRICAS</text>
        <For each={otherMetrics()}>
          {(metric) => (
            <QuotaMetricLine metric={metric} width={props.width} context={props.context} />
          )}
        </For>
      </Show>
      <Show when={safeError()}>
        {(message) => (
          <text fg={tone(props.context, 'warning')}>
            {clipped(`! ${message()}`, props.width - 2)}
          </text>
        )}
      </Show>
      <text fg={muted(props.context)}>
        {'─'.repeat(Math.max(8, Math.min(32, props.width - 4)))}
      </text>
    </box>
  )
}

export type QuotaPanelAction = 'toggle-enabled' | 'toggle-display' | 'refresh' | 'close'

export const QUOTA_TABS = ['usage', 'limits', 'plugin', 'settings'] as const
export type QuotaTab = (typeof QUOTA_TABS)[number]
export const DEFAULT_QUOTA_TAB: QuotaTab = 'limits'

export function moveQuotaTab(current: QuotaTab, direction: -1 | 1): QuotaTab {
  const currentIndex = QUOTA_TABS.indexOf(current)
  const nextIndex = (currentIndex + direction + QUOTA_TABS.length) % QUOTA_TABS.length
  return QUOTA_TABS[nextIndex] ?? DEFAULT_QUOTA_TAB
}

export const QUOTA_PANEL_COMMANDS: readonly {
  action: QuotaPanelAction
  id: string
  title: string
  bind: string
}[] = [
  {
    action: 'toggle-enabled',
    id: 'pantheon.quota.toggle-enabled',
    title: 'Quota: ativar/desativar',
    bind: 'e',
  },
  {
    action: 'toggle-display',
    id: 'pantheon.quota.toggle-display',
    title: 'Quota: alternar usado/restante',
    bind: 'm',
  },
  { action: 'refresh', id: 'pantheon.quota.refresh', title: 'Quota: atualizar', bind: 'r' },
  { action: 'close', id: 'pantheon.quota.close', title: 'Quota: fechar', bind: 'escape,q' },
]

export function runQuotaPanelCommand(
  action: QuotaPanelAction,
  panel: Pick<PanelInput, 'focused' | 'close'>,
  runtime: QuotaRuntime,
): false | Promise<void> | undefined {
  if (panel.focused !== true) return false
  switch (action) {
    case 'toggle-enabled':
      return runtime.toggleEnabled()
    case 'toggle-display':
      return runtime.toggleDisplay()
    case 'refresh':
      return runtime.refresh()
    case 'close':
      panel.close()
      return undefined
  }
}

export function quotaPanelKeymapLayer(
  panel: Pick<PanelInput, 'focused' | 'close'>,
  runtime: QuotaRuntime,
  onTabChange?: (direction: -1 | 1) => void,
): KeymapLayer {
  const focused = () => panel.focused === true
  return {
    mode: 'global',
    enabled: focused,
    commands: [
      ...QUOTA_PANEL_COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
        bind: command.bind,
        run: () => (focused() ? runQuotaPanelCommand(command.action, panel, runtime) : false),
      })),
      {
        id: 'pantheon.quota.next-tab',
        title: 'Quota: próxima aba',
        bind: 'tab',
        run: () => {
          if (!focused()) return false
          onTabChange?.(1)
          return undefined
        },
      },
      {
        id: 'pantheon.quota.previous-tab',
        title: 'Quota: aba anterior',
        bind: 'shift+tab',
        run: () => {
          if (!focused()) return false
          onTabChange?.(-1)
          return undefined
        },
      },
    ],
  }
}

export function quotaOpenCommand(context: Pick<Context, 'ui'>): KeymapCommand {
  return {
    id: QUOTA_OPEN_COMMAND_ID,
    title: 'Pantheon: Quota',
    description: 'Painel de quota',
    group: 'Pantheon',
    palette: true,
    slash: { name: 'quota', aliases: ['pantheon-quota'] },
    run: () => {
      openQuotaPanel(context)
    },
  }
}

export function openQuotaPanel(context: Pick<Context, 'ui'>): boolean {
  let opened = false
  try {
    opened = context.ui.panel.open(QUOTA_PANEL_NAME)
  } catch {
    opened = false
  }
  if (opened) return true
  try {
    context.ui.toast.show({ message: QUOTA_PANEL_TOAST, variant: 'warning' })
  } catch {
    /* The details panel remains a no-op if the host also lacks toast support. */
  }
  return false
}

const QUOTA_TAB_LABELS: Record<QuotaTab, string> = {
  usage: 'Usage',
  limits: 'Limits',
  plugin: 'Plugin',
  settings: 'Settings',
}

const QUOTA_TAB_ICONS: Record<QuotaTab, QuotaIconName> = {
  usage: 'clock',
  limits: 'gauge',
  plugin: 'plug',
  settings: 'settings',
}

export function quotaTabLabel(tab: QuotaTab, mode?: QuotaIconMode): string {
  return `${iconInSlot(QUOTA_TAB_ICONS[tab], 3, mode)} ${QUOTA_TAB_LABELS[tab]}`
}

function QuotaTabNavigation(props: {
  context: Context
  selected: QuotaTab
  width: number
  onSelect: (tab: QuotaTab) => void
}): JSX.Element {
  return (
    <box flexDirection={props.width < 54 ? 'column' : 'row'} gap={1}>
      <For each={QUOTA_TABS}>
        {(tab) => (
          <box onMouseDown={() => props.onSelect(tab)}>
            <text
              fg={props.selected === tab ? tone(props.context, 'info') : muted(props.context)}
              attributes={props.selected === tab ? 1 : 0}
            >
              {`${props.selected === tab ? '› ' : '  '}${quotaTabLabel(tab)}`}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

function QuotaCloseButton(props: { context: Context; close: () => void }): JSX.Element {
  return (
    <box onMouseDown={props.close}>
      <text fg={tone(props.context, 'info')}>{`${quotaIcon('close')} Fechar`}</text>
    </box>
  )
}

function QuotaPluginDetails(props: { context: Context; snapshot: QuotaSnapshot }): JSX.Element {
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={tone(props.context, 'info')} attributes={1}>
        Plugin
      </text>
      <text fg={base(props.context)}>{`Pantheon TUI v${__PANTHEON_VERSION__}`}</text>
      <text fg={muted(props.context)}>
        Status de conexão consultado pelo OpenCode; segredos não são exibidos.
      </text>
      <text fg={muted(props.context)}>
        {`Status da quota: ${quotaSnapshotStatusLabel(props.snapshot.status, props.snapshot.error)}`}
      </text>
      <Show when={props.snapshot.details.length > 0}>
        <text fg={muted(props.context)}>PROVEDORES DETECTADOS</text>
        <For each={props.snapshot.details}>
          {(provider) => {
            const state = providerState(provider)
            return (
              <text fg={tone(props.context, state.tone)}>
                {`${provider.label} · ${state.label}`}
              </text>
            )
          }}
        </For>
      </Show>
      <Show when={props.snapshot.details.length === 0}>
        <text fg={muted(props.context)}>Nenhum provedor elegível foi confirmado nesta sessão.</text>
      </Show>
      <text fg={muted(props.context)}>
        Configure a conexão e credenciais pelo fluxo oficial do OpenCode; o painel não altera
        configurações.
      </text>
    </box>
  )
}

function QuotaSettings(props: { context: Context; runtime: QuotaRuntime }): JSX.Element {
  const preferences = () => props.runtime.preferences()
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={tone(props.context, 'info')} attributes={1}>
        Settings
      </text>
      <box onMouseDown={() => void props.runtime.toggleEnabled()}>
        <text fg={base(props.context)}>
          {`${quotaIcon(preferences().enabled ? 'check' : 'close')} [E] Quota ${preferences().enabled ? 'ativada' : 'desativada'} · clique para alternar`}
        </text>
      </box>
      <box onMouseDown={() => void props.runtime.toggleDisplay()}>
        <text fg={base(props.context)}>
          {`${quotaIcon('sliders')} [M] Exibir ${preferences().display === 'remaining' ? 'restante' : 'usado'} · clique para alternar`}
        </text>
      </box>
      <text fg={muted(props.context)}>Tab/Shift+Tab navega pelas abas; Esc fecha o painel.</text>
    </box>
  )
}

export function QuotaPanel(props: QuotaSurfaceProps & { panel: PanelInput }): JSX.Element {
  const [selectedTab, setSelectedTab] = createSignal<QuotaTab>(DEFAULT_QUOTA_TAB)
  props.context.keymap.layer(() =>
    quotaPanelKeymapLayer(props.panel, props.runtime, (direction) =>
      setSelectedTab((tab) => moveQuotaTab(tab, direction)),
    ),
  )
  const preferences = () => props.runtime.preferences()
  const snapshot = () => props.runtime.snapshot()

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1}>
      <Show
        when={props.panel.width >= 54}
        fallback={
          <box flexDirection="row" justifyContent="space-between" gap={1}>
            <text
              fg={tone(props.context, 'info')}
              attributes={1}
            >{`${QUOTA_ICON} Pantheon / Quota`}</text>
            <QuotaCloseButton context={props.context} close={props.panel.close} />
          </box>
        }
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={tone(props.context, 'info')} attributes={1}>
            {`${QUOTA_ICON} Pantheon / Quota`}
          </text>
          <QuotaCloseButton context={props.context} close={props.panel.close} />
        </box>
      </Show>
      <ActiveModelHeader
        context={props.context}
        sessionID={props.panel.sessionID}
        width={props.panel.width - 4}
        snapshot={snapshot()}
      />
      <QuotaTabNavigation
        context={props.context}
        selected={selectedTab()}
        width={props.panel.width}
        onSelect={setSelectedTab}
      />
      <Show when={snapshot().error !== undefined && snapshot().status !== 'ready'}>
        <text fg={muted(props.context)}>{`Último erro: ${snapshot().error}`}</text>
      </Show>
      <Show when={snapshot().status === 'needs_setup' && snapshot().details.length === 0}>
        <text fg={muted(props.context)}>
          Nenhum provedor elegível: verifique conexão ativa e credencial local compatível.
        </text>
      </Show>
      <Show when={snapshot().status === 'unavailable'}>
        <text fg={muted(props.context)}>Não foi possível verificar o status da quota.</text>
      </Show>
      <Show when={snapshot().status === 'stale'}>
        <text fg={muted(props.context)}>
          A última resposta continua visível; atualize para tentar novamente.
        </text>
      </Show>
      <scrollbox
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={3}
        width="100%"
        scrollY
        focused={props.panel.focused}
        focusable
        border
        borderColor={muted(props.context)}
        focusedBorderColor={tone(props.context, 'info')}
      >
        <box flexDirection="column" paddingX={1} paddingY={1}>
          <Show when={selectedTab() === 'usage'}>
            <UsageHistorySection
              context={props.context}
              panel={props.panel}
              width={props.panel.width - 6}
            />
            <ModelUsageDetails
              context={props.context}
              sessionID={props.panel.sessionID}
              width={props.panel.width - 6}
            />
          </Show>
          <Show when={selectedTab() === 'limits'}>
            <Show when={snapshot().details.length > 0}>
              <For each={snapshot().details}>
                {(provider) => (
                  <QuotaProviderDetails
                    provider={provider}
                    display={preferences().display}
                    width={props.panel.width - 4}
                    context={props.context}
                  />
                )}
              </For>
            </Show>
            <Show when={snapshot().details.length === 0}>
              <text fg={muted(props.context)}>
                {quotaSnapshotStatusLabel(snapshot().status, snapshot().error)}
              </text>
            </Show>
          </Show>
          <Show when={selectedTab() === 'plugin'}>
            <QuotaPluginDetails context={props.context} snapshot={snapshot()} />
          </Show>
          <Show when={selectedTab() === 'settings'}>
            <QuotaSettings context={props.context} runtime={props.runtime} />
          </Show>
        </box>
      </scrollbox>
      <box flexDirection="column" flexShrink={0}>
        <text fg={muted(props.context)}>
          {`Quota ${preferences().enabled ? 'ativada' : 'desativada'} · exibição: ${preferences().display === 'remaining' ? 'restante' : 'usado'}`}
        </text>
        <text
          fg={muted(props.context)}
        >{`E ${preferences().enabled ? 'desativar' : 'ativar'} · M alternar usado/restante`}</text>
        <text fg={muted(props.context)}>{`↑/↓ rolar · ${quotaIcon('refresh')} R atualizar`}</text>
        <text fg={muted(props.context)}>Tab/Shift+Tab abas · Esc/Q fechar</text>
      </box>
    </box>
  )
}

function QuotaCommandLayer(props: QuotaSurfaceProps) {
  const goCheck = quotaGoCheckCommand(props.context)
  props.context.keymap.layer(() => ({
    mode: 'global',
    commands: [quotaOpenCommand(props.context), goCheck],
  }))
  return null
}

/** Register footer/panel controls and own teardown of the shared sidebar runtime. */
export function registerQuotaTui(context: Context, runtime: QuotaRuntime): () => void {
  const unregister: Array<() => void> = []
  try {
    unregister.push(
      context.ui.slot({
        append: 'prompt.footer',
        render: () => <QuotaFooterSummary context={context} runtime={runtime} />,
      }),
    )
    unregister.push(
      context.ui.slot({
        append: 'session.panel',
        render: (panel: PanelInput) =>
          panel.name === QUOTA_PANEL_NAME ? (
            <QuotaPanel context={context} runtime={runtime} panel={panel} />
          ) : null,
      }),
    )
    unregister.push(
      context.ui.slot({
        append: 'app',
        render: () => <QuotaCommandLayer context={context} runtime={runtime} />,
      }),
    )
  } catch (error) {
    runtime.dispose()
    unregister.reverse().forEach((dispose) => {
      dispose()
    })
    throw error
  }

  return () => {
    runtime.dispose()
    unregister.reverse().forEach((dispose) => {
      dispose()
    })
  }
}
