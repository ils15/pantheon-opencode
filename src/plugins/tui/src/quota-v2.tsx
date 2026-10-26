/** @jsxImportSource @opentui/solid */

import type { Context, KeymapCommand, KeymapLayer, PanelInput } from '@opencode/plugin/tui/context'
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from 'solid-js'
import {
  contextBar,
  contextUsageTone,
  formatContextWindow,
  formatSpent,
  formatTokenCount,
} from './context-gauge'
import { quotaGoCheckCommand } from './go-key-diagnostic-ui'
import { MODEL_USAGE_MESSAGE_LIMIT, MODEL_USAGE_SESSION_LIMIT } from './model-usage-limits'
import {
  collectRecentModelUsageRows,
  compactQuotaMetric,
  type QuotaMetric,
  type QuotaProviderDetail,
  type QuotaRuntime,
  type QuotaSidebarEntry,
  type QuotaSnapshot,
  quotaProgress,
  quotaSidebarEntries,
  quotaSnapshotStatusLabel,
  type RecentModelUsageRow,
  resolveActiveModelRef,
} from './quota-v2-model'

export const QUOTA_PANEL_NAME = 'pantheon.quota'
export const QUOTA_OPEN_COMMAND_ID = 'pantheon.quota.open'
export const QUOTA_ICON = '\u25A5'
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

type QuotaTone = 'info' | 'success' | 'warning' | 'error'

function tone(context: Context, color: QuotaTone): string {
  return context.theme.text?.feedback?.[color]?.base ?? base(context)
}

function snapshotSummary(snapshot: QuotaSnapshot, display: 'used' | 'remaining'): string {
  if (snapshot.status === 'loading') return 'carregando status'
  if (snapshot.status === 'needs_setup') return 'nenhum provedor elegível'
  if (snapshot.status === 'unavailable') return 'status indisponível'
  if (snapshot.status === 'connected_unavailable') return 'credencial local · dados indisponíveis'
  if (snapshot.status === 'stale') return 'dados desatualizados'
  if (snapshot.status === 'disabled') return 'desativado'
  const metrics = snapshot.providers.flatMap((provider) => provider.metrics)
  const metric = metrics.find((item) => item.kind !== 'provider_status') ?? metrics[0]
  if (metric) {
    const value = compactQuotaMetric(metric, display) ?? 'quota indisponível'
    return snapshot.status === 'partial' ? `parcial · ${value}` : value
  }
  if (snapshot.status === 'partial') return 'dados parciais'
  if (snapshot.providers[0]?.message) return snapshot.providers[0].message
  return 'quota indisponível'
}

const SIDEBAR_QUOTA_BAR_CELLS = 4

function quotaSidebarSummary(
  snapshot: QuotaSnapshot,
  display: 'used' | 'remaining',
  entries: readonly QuotaSidebarEntry[],
): string {
  const windows = entries.filter((entry) => entry.kind === 'quota').length
  if (windows === 0) return snapshotSummary(snapshot, display)
  const status =
    snapshot.status === 'ready'
      ? 'quota disponível'
      : snapshot.status === 'partial'
        ? 'parcial'
        : snapshotSummary(snapshot, display)
  return `${status} · ${windows} ${windows === 1 ? 'janela' : 'janelas'}`
}

function sidebarFinanceSummary(
  snapshot: QuotaSnapshot,
  display: 'used' | 'remaining',
): string | undefined {
  const metric = snapshot.providers
    .flatMap((provider) => provider.metrics)
    .find(
      (item) => item.kind === 'balance' || item.kind === 'estimate' || item.kind === 'key_usage',
    )
  return metric ? compactQuotaMetric(metric, display) : undefined
}

function QuotaSidebarEntryRow(props: {
  entry: QuotaSidebarEntry
  display: 'used' | 'remaining'
  context: Context
}): JSX.Element {
  if (props.entry.kind === 'status') {
    return (
      <text fg={tone(props.context, 'warning')}>
        {clipped(`${props.entry.providerLabel} · ${props.entry.message}`, 32)}
      </text>
    )
  }

  const progress = props.entry.progress
  const bar = contextBar(progress.usedPercent, SIDEBAR_QUOTA_BAR_CELLS)
  if (!bar) return <text fg={muted(props.context)}>{props.entry.providerLabel}</text>
  const title = props.entry.metric.period?.trim() || props.entry.metric.label?.trim() || 'quota'
  const value =
    props.display === 'remaining'
      ? `${progress.remainingPercent}% rest.`
      : `${progress.usedPercent}% uso`
  const gaugeTone = quotaWindowTone(props.context, progress)

  return (
    <box flexDirection="column">
      <text fg={muted(props.context)}>
        {clipped(`${props.entry.providerLabel} · ${title}`, 32)}
      </text>
      <box flexDirection="row" alignItems="center" gap={1}>
        <text fg={gaugeTone}>{bar.filled}</text>
        <text fg={muted(props.context)}>{bar.empty}</text>
        <text fg={gaugeTone}>{value}</text>
      </box>
    </box>
  )
}

export function QuotaSidebarSummary(props: QuotaSurfaceProps): JSX.Element {
  const entries = createMemo(() => quotaSidebarEntries(props.runtime.snapshot()))
  const quotaWindowCount = () => entries().filter((entry) => entry.kind === 'quota').length
  return (
    <Show when={props.runtime.preferences().enabled}>
      <box flexDirection="column" marginTop={1}>
        <text fg={base(props.context)}>{`${QUOTA_ICON} Pantheon quota`}</text>
        <text fg={muted(props.context)}>
          {quotaSidebarSummary(
            props.runtime.snapshot(),
            props.runtime.preferences().display,
            entries(),
          )}
        </text>
        <Show
          when={
            quotaWindowCount() > 0 &&
            sidebarFinanceSummary(props.runtime.snapshot(), props.runtime.preferences().display)
          }
        >
          {(summary) => <text fg={muted(props.context)}>{clipped(summary(), 32)}</text>}
        </Show>
        <For each={entries()}>
          {(entry) => (
            <QuotaSidebarEntryRow
              entry={entry}
              display={props.runtime.preferences().display}
              context={props.context}
            />
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

function quotaWindowTone(context: Context, progress: { usedPercent: number }): string {
  if (progress.usedPercent > 85) return tone(context, 'error')
  if (progress.usedPercent >= 60) return tone(context, 'warning')
  return tone(context, 'success')
}

function QuotaWindow(props: {
  metric: QuotaWindowMetric
  display: 'used' | 'remaining'
  width: number
  context: Context
}) {
  const values = () => {
    const used = quotaAmount(props.metric.used, props.metric.unit)
    const remaining = quotaAmount(props.metric.remaining, props.metric.unit)
    return used && remaining
      ? { used, remaining, progress: quotaProgress(props.metric) }
      : undefined
  }
  const title = () => props.metric.period?.trim() || props.metric.label?.trim() || 'Quota'
  const meterWidth = () => Math.max(4, Math.min(14, Math.floor((props.width - 34) / 3)))
  const primaryValue = () => {
    const value = values()
    if (!value) return undefined
    return props.display === 'remaining' ? `Restante ${value.remaining}` : `Usado ${value.used}`
  }
  const secondaryValue = () => {
    const value = values()
    if (!value) return undefined
    return props.display === 'remaining' ? `Usado ${value.used}` : `Restante ${value.remaining}`
  }

  return (
    <Show when={values()}>
      {(value) => (
        <box flexDirection="column" paddingLeft={1}>
          <box
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            gap={1}
            width="100%"
          >
            <text fg={muted(props.context)}>
              {clipped(title(), Math.max(7, props.width * 0.28))}
            </text>
            <Show when={value().progress}>
              {(progress) => (
                <>
                  <box flexDirection="row" flexShrink={0}>
                    <text fg={quotaWindowTone(props.context, progress())}>
                      {'█'.repeat(Math.round((progress().usedPercent / 100) * meterWidth()))}
                    </text>
                    <text fg={muted(props.context)}>
                      {'░'.repeat(
                        meterWidth() - Math.round((progress().usedPercent / 100) * meterWidth()),
                      )}
                    </text>
                  </box>
                  <text fg={quotaWindowTone(props.context, progress())}>
                    {`${progress().remainingPercent}% restante`}
                  </text>
                </>
              )}
            </Show>
          </box>
          <box flexDirection="row" justifyContent="space-between" gap={1}>
            <text
              fg={props.display === 'remaining' ? base(props.context) : muted(props.context)}
              attributes={props.display === 'remaining' ? 1 : 0}
            >
              {clipped(primaryValue() ?? '', props.width * 0.48)}
            </text>
            <text
              fg={props.display === 'used' ? base(props.context) : muted(props.context)}
              attributes={props.display === 'used' ? 1 : 0}
            >
              {clipped(secondaryValue() ?? '', props.width * 0.48)}
            </text>
          </box>
        </box>
      )}
    </Show>
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

function QuotaMetricLine(props: {
  metric: Exclude<QuotaMetric, { kind: 'provider_quota' }>
  width: number
  context: Context
}) {
  const row = () => metricRow(props.metric)
  return (
    <Show when={row()}>
      {(value) => (
        <box flexDirection="row" justifyContent="space-between" gap={1} paddingLeft={1}>
          <text fg={muted(props.context)}>{clipped(value().label, props.width * 0.48)}</text>
          <text fg={base(props.context)}>{clipped(value().value, props.width * 0.48)}</text>
        </box>
      )}
    </Show>
  )
}

function providerState(provider: QuotaProviderDetail): { label: string; tone: QuotaTone } {
  if (provider.authentication === 'not_connected')
    return { label: '○ Precisa configurar', tone: 'warning' }
  if (provider.authentication === 'unavailable') return { label: '× Indisponível', tone: 'error' }
  return provider.state === 'available'
    ? { label: '✓ Credencial local · há dados', tone: 'success' }
    : { label: '! Credencial local · sem dados', tone: 'warning' }
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

function ModelUsageDetails(props: { context: Context; sessionID: string; width: number }) {
  const [revision, setRevision] = createSignal(0)
  const rows = createMemo(() => {
    revision()
    return recentModelUsage(props.context, props.sessionID)
  })

  onMount(() => {
    const unsubscribe: Array<() => void> = []
    for (const event of MODEL_USAGE_REFRESH_EVENTS) {
      try {
        unsubscribe.push(props.context.data.on(event, () => setRevision((value) => value + 1)))
      } catch {
        /* Cached values stay renderable if a host event is unavailable. */
      }
    }
    onCleanup(() => {
      for (const dispose of unsubscribe) dispose()
    })
  })

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
              <text fg={tone(props.context, 'info')} attributes={1}>
                MODELO ATUAL
              </text>
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
              <Show when={row.cost !== null}>
                <text fg={muted(props.context)}>
                  {clipped(
                    `Custo reportado · mensagens recentes · ${formatSpent(row.cost) ?? '—'}`,
                    props.width - 2,
                  )}
                </text>
              </Show>
              <Show when={row.tokens !== null && row.context === null}>
                <text fg={muted(props.context)}>Contexto indisponível</text>
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
      <Show
        when={props.width >= 58}
        fallback={
          <box flexDirection="column">
            <text fg={tone(props.context, 'info')} attributes={1}>
              {clipped(props.provider.label, props.width)}
            </text>
            <text fg={tone(props.context, state().tone)}>
              {clipped(state().label, props.width)}
            </text>
          </box>
        }
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={tone(props.context, 'info')} attributes={1}>
            {clipped(props.provider.label, props.width * 0.62)}
          </text>
          <text fg={tone(props.context, state().tone)}>{state().label}</text>
        </box>
      </Show>
      <Show when={quotaMetrics().length > 0}>
        <text fg={muted(props.context)}>JANELAS DE QUOTA</text>
        <For each={quotaMetrics()}>
          {(metric) => (
            <QuotaWindow
              metric={metric}
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
): KeymapLayer {
  const focused = () => panel.focused === true
  return {
    mode: 'global',
    enabled: focused,
    commands: QUOTA_PANEL_COMMANDS.map((command) => ({
      id: command.id,
      title: command.title,
      bind: command.bind,
      run: () => (focused() ? runQuotaPanelCommand(command.action, panel, runtime) : false),
    })),
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

function QuotaPanel(props: QuotaSurfaceProps & { panel: PanelInput }) {
  props.context.keymap.layer(() => quotaPanelKeymapLayer(props.panel, props.runtime))
  const preferences = () => props.runtime.preferences()
  const snapshot = () => props.runtime.snapshot()
  const snapshotTone = (): QuotaTone => {
    switch (snapshot().status) {
      case 'ready':
        return 'success'
      case 'partial':
      case 'connected_unavailable':
      case 'needs_setup':
      case 'stale':
        return 'warning'
      case 'unavailable':
        return 'error'
      case 'loading':
      case 'disabled':
        return 'info'
    }
  }

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1}>
      <Show
        when={props.panel.width >= 54}
        fallback={
          <box flexDirection="column">
            <text fg={tone(props.context, 'info')} attributes={1}>
              {`${QUOTA_ICON} Pantheon / Quota`}
            </text>
            <text fg={tone(props.context, snapshotTone())}>
              {quotaSnapshotStatusLabel(snapshot().status)}
            </text>
          </box>
        }
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={tone(props.context, 'info')} attributes={1}>
            {`${QUOTA_ICON} Pantheon / Quota`}
          </text>
          <text fg={tone(props.context, snapshotTone())}>
            {quotaSnapshotStatusLabel(snapshot().status)}
          </text>
        </box>
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
          <ModelUsageDetails
            context={props.context}
            sessionID={props.panel.sessionID}
            width={props.panel.width - 6}
          />
        </box>
      </scrollbox>
      <text fg={muted(props.context)}>
        {`Quota ${preferences().enabled ? 'ativada' : 'desativada'} · exibição: ${preferences().display === 'remaining' ? 'restante' : 'usado'}`}
      </text>
      <text
        fg={muted(props.context)}
      >{`E ${preferences().enabled ? 'desativar' : 'ativar'} · M alternar usado/restante`}</text>
      <text fg={muted(props.context)}>↑/↓ rolar · R atualizar</text>
      <text fg={muted(props.context)}>Esc/Q fechar</text>
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
