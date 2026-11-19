// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode exposes its TUI API at runtime.
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

/**
 * cockpit.tsx — High-Density TUI Mission Control Cockpit (Overview, Swarm,
 * Flightdeck) rendered natively on `@opentui/solid` via `ui.router.register`.
 */

import type { Context, WindowRoute } from '@opencode/plugin/tui/context'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  buildCockpitSnapshot,
  type CockpitChildEntry,
  type CockpitLogEntry,
  type CockpitTabId,
} from './cockpit-state.ts'
import { resolveLanguage } from './settings-i18n'
import { resolveAccentColor, tuiPrefs } from './tui-prefs'

const ROUTE_NAME = 'pantheon.cockpit'
const ROUTE_MODE = 'pantheon-cockpit'
const TABS: ReadonlyArray<{
  readonly id: CockpitTabId
  readonly label: string
  readonly key: string
}> = [
  { id: 'overview', label: '1 Overview', key: '1' },
  { id: 'swarm', label: '2 Swarm', key: '2' },
  { id: 'flightdeck', label: '3 Flightdeck', key: '3' },
]

let routerReady = false
let cockpitController:
  | {
      setTab: (id: CockpitTabId) => void
      nextTab: () => void
      prevTab: () => void
      moveRow: (delta: number) => void
      toggleDetail: () => void
      refresh: () => void
      close: () => void
    }
  | undefined
const [cockpitOpen, setCockpitOpen] = createSignal(false)

function collectLiveChildren(context: any, rootSessionID?: string): CockpitChildEntry[] {
  try {
    const rawList = context?.data?.session?.list?.()
    if (!Array.isArray(rawList)) return []
    return rawList
      .filter(
        (s: any) =>
          s && typeof s.id === 'string' && (!rootSessionID || s.parentID === rootSessionID),
      )
      .slice(0, 20)
      .map((s: any) => {
        const statusRaw = context?.data?.session?.status?.(s.id)
        const status: CockpitChildEntry['status'] =
          statusRaw === 'busy' || statusRaw === 'running'
            ? 'running'
            : statusRaw === 'error'
              ? 'failed'
              : statusRaw === 'interrupted'
                ? 'interrupted'
                : 'completed'
        const created = typeof s.time?.created === 'number' ? s.time.created : Date.now()
        const updated = typeof s.time?.updated === 'number' ? s.time.updated : created
        return {
          id: s.id,
          agent: String(s.agent ?? s.title ?? 'specialist').split(/\s+/)[0] ?? 'specialist',
          kind: String(s.kind ?? 'task'),
          status,
          cost: typeof s.cost === 'number' ? s.cost : 0,
          startedAt: created,
          updatedAt: updated,
          tokens:
            typeof s.tokens?.input === 'number' ? s.tokens.input + (s.tokens?.output ?? 0) : 0,
          model: typeof s.model === 'string' ? s.model : undefined,
        }
      })
  } catch {
    return []
  }
}

function collectHostLogs(): CockpitLogEntry[] {
  const g = globalThis as { __pantheonCockpitLogs?: CockpitLogEntry[] }
  if (!Array.isArray(g.__pantheonCockpitLogs)) return []
  return g.__pantheonCockpitLogs
}

function collectSessionTelemetry(
  context: any,
  sessionID?: string,
): {
  title?: string
  modelName?: string
  contextTokens: number
  contextWindow: number
  sessionCost?: number
} {
  const sInfo = sessionID ? context?.data?.session?.info?.(sessionID) : undefined
  const messages: any[] = sessionID ? (context?.data?.session?.messages?.(sessionID) ?? []) : []
  let contextTokens = typeof sInfo?.tokens?.input === 'number' ? sInfo.tokens.input : 0
  let modelName: string | undefined = typeof sInfo?.model === 'string' ? sInfo.model : undefined
  let totalCost = typeof sInfo?.cost === 'number' ? sInfo.cost : 0
  let sawMsgCost = false
  if (Array.isArray(messages) && messages.length > 0) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue
      if (typeof msg.cost === 'number' && Number.isFinite(msg.cost)) {
        totalCost += msg.cost
        sawMsgCost = true
      }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'assistant' || msg?.type === 'assistant') {
        const t = msg.tokens
        if (t && typeof t === 'object') {
          const total =
            (Number(t.input) || 0) +
            (Number(t.output) || 0) +
            (Number(t.reasoning) || 0) +
            (Number(t.cache?.read) || 0) +
            (Number(t.cache?.write) || 0)
          if (total > 0) {
            contextTokens = total
            if (!modelName && typeof msg.modelID === 'string') modelName = msg.modelID
            break
          }
        }
      }
    }
  }
  const modelsCatalog = context?.data?.provider?.models?.() ?? []
  let contextWindow = 1_000_000
  if (Array.isArray(modelsCatalog) && modelName) {
    const hit = modelsCatalog.find((m: any) => m?.id === modelName || m?.modelID === modelName)
    if (typeof hit?.limit?.context === 'number' && hit.limit.context > 0) {
      contextWindow = hit.limit.context
    }
  }
  return {
    title: typeof sInfo?.title === 'string' ? sInfo.title : undefined,
    modelName,
    contextTokens,
    contextWindow,
    sessionCost: sawMsgCost || typeof sInfo?.cost === 'number' ? totalCost : undefined,
  }
}

export function CockpitView(props: {
  readonly context: any
  readonly workspaceDir: string
  readonly sessionID?: string
  readonly onClose: () => void
}) {
  const isPt = () => resolveLanguage(tuiPrefs().layout?.language) === 'pt-BR'
  const [tab, setTab] = createSignal<CockpitTabId>('overview')
  const [selectedRow, setSelectedRow] = createSignal(0)
  const [showDetail, setShowDetail] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  const activeSid = () =>
    props.sessionID ??
    (props.context?.ui?.router?.current?.()?.type === 'session'
      ? props.context.ui.router.current().sessionID
      : undefined)

  const snapshot = () => {
    tick()
    const sid = activeSid()
    const telemetry = collectSessionTelemetry(props.context, sid)
    return buildCockpitSnapshot({
      workspaceDir: props.workspaceDir,
      sessionTitle: telemetry.title,
      modelName: telemetry.modelName,
      contextTokens: telemetry.contextTokens,
      contextWindow: telemetry.contextWindow,
      sessionCost: telemetry.sessionCost,
      children: collectLiveChildren(props.context, sid),
      events: collectHostLogs(),
      isPt: isPt(),
    })
  }

  const fg = () => props.context?.theme?.text?.base
  const muted = () => props.context?.theme?.text?.muted ?? fg()
  const accent = () => resolveAccentColor(tuiPrefs().theme?.accent, props.context?.theme)
  const success = () => props.context?.theme?.text?.feedback?.success?.base ?? accent()
  const errFg = () => props.context?.theme?.text?.feedback?.error?.base ?? accent()

  onMount(() => {
    setCockpitOpen(true)
    let popMode: (() => void) | undefined
    try {
      popMode = props.context?.keymap?.mode?.push?.(ROUTE_MODE)
    } catch {
      /* ignore */
    }
    const timer = setInterval(() => setTick((t) => t + 1), 1500)
    cockpitController = {
      setTab: (id) => {
        setTab(id)
        setSelectedRow(0)
      },
      nextTab: () => {
        const idx = TABS.findIndex((t) => t.id === tab())
        const next = TABS[(idx + 1) % TABS.length]
        if (next) setTab(next.id)
      },
      prevTab: () => {
        const idx = TABS.findIndex((t) => t.id === tab())
        const prev = TABS[(idx - 1 + TABS.length) % TABS.length]
        if (prev) setTab(prev.id)
      },
      moveRow: (delta) => {
        const snap = snapshot()
        const max =
          tab() === 'swarm'
            ? snap.swarm.rows.length
            : tab() === 'flightdeck'
              ? Math.max(snap.flightdeck.steps.length, snap.flightdeck.logs.length)
              : 0
        if (max <= 0) return
        setSelectedRow((cur) => Math.max(0, Math.min(max - 1, cur + delta)))
      },
      toggleDetail: () => setShowDetail((v) => !v),
      refresh: () => setTick((t) => t + 1),
      close: props.onClose,
    }
    onCleanup(() => {
      clearInterval(timer)
      cockpitController = undefined
      setCockpitOpen(false)
      try {
        popMode?.()
      } catch {
        /* ignore */
      }
    })
  })

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      {/* Header Bar */}
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          <text fg={accent()} attributes={1}>
            {'◈ PANTHEON COCKPIT '}
          </text>
          <text fg={fg()}>{`· ${snapshot().sessionTitle} (${snapshot().modelName})`}</text>
        </box>
        <box onMouseDown={props.onClose}>
          <text fg={muted()}>{'[ Esc / Q ]'}</text>
        </box>
      </box>

      {/* Tab Row */}
      <box flexDirection="row" marginTop={1} gap={2}>
        <For each={TABS}>
          {(t) => {
            const active = () => tab() === t.id
            return (
              <box onMouseDown={() => setTab(t.id)}>
                <text
                  fg={active() ? accent() : muted()}
                  attributes={active() ? 1 : 0}
                >{`[${t.label}]`}</text>
              </box>
            )
          }}
        </For>
      </box>

      <text fg={muted()}>{'─'.repeat(72)}</text>

      {/* Page 1: Overview */}
      <Show when={tab() === 'overview'}>
        <box flexDirection="column" marginTop={1}>
          <text fg={accent()} attributes={1}>
            {'Token Meter & Context'}
          </text>
          <text fg={fg()}>
            {`Velocity: ${snapshot().overview.velocityBars}   Context: ${snapshot().overview.contextGauge}   Spend: $${snapshot().overview.sessionCost.toFixed(4)}`}
          </text>

          <box marginTop={1} flexDirection="column">
            <text fg={accent()} attributes={1}>
              {'Runtime Surfaces & Health'}
            </text>
            <For each={snapshot().overview.surfaces}>
              {(item) => <text fg={fg()}>{`  ● ${item.label.padEnd(28)} ${item.status}`}</text>}
            </For>
          </box>

          <box marginTop={1} flexDirection="column">
            <text fg={accent()} attributes={1}>
              {'Work Map (Topology)'}
            </text>
            <For each={snapshot().overview.workMap}>
              {(line) => <text fg={muted()}>{line}</text>}
            </For>
          </box>
        </box>
      </Show>

      {/* Page 2: Swarm */}
      <Show when={tab() === 'swarm'}>
        <box flexDirection="column" marginTop={1}>
          <text fg={fg()} attributes={1}>
            {`● ${snapshot().swarm.activeCount} active  ✓ ${snapshot().swarm.completedCount} done  ✗ ${snapshot().swarm.failedCount} failed  · $${snapshot().swarm.totalCost.toFixed(4)}`}
          </text>
          <box marginTop={1} flexDirection="column">
            <Show
              when={snapshot().swarm.rows.length > 0}
              fallback={
                <text fg={muted()}>
                  {isPt()
                    ? 'Nenhum subagente registrado nesta sessão ainda.'
                    : 'No subagent delegations recorded in this session yet.'}
                </text>
              }
            >
              <For each={snapshot().swarm.rows.slice(0, 12)}>
                {(row, idx) => {
                  const sel = () => idx() === selectedRow()
                  const marker =
                    row.status === 'running' ? '●' : row.status === 'failed' ? '✗' : '✓'
                  return (
                    <box
                      flexDirection="column"
                      onMouseDown={() => {
                        setSelectedRow(idx())
                        setShowDetail((v) => !v)
                      }}
                    >
                      <text fg={sel() ? accent() : fg()}>
                        {`${sel() ? '▸' : ' '} ${marker} @${row.agent.padEnd(11)} ${row.ganttBar}  ${String(row.durationSec).padStart(5)}s  $${row.cost.toFixed(3)}`}
                      </text>
                      <Show when={sel() && showDetail()}>
                        <text fg={muted()}>
                          {`    id=${row.id} kind=${row.kind} tokens=${row.tokens} model=${row.model ?? 'inherited'}`}
                        </text>
                      </Show>
                    </box>
                  )
                }}
              </For>
            </Show>
          </box>
        </box>
      </Show>

      {/* Page 3: Flightdeck */}
      <Show when={tab() === 'flightdeck'}>
        <box flexDirection="column" marginTop={1}>
          <text fg={accent()} attributes={1}>
            {'GATE (Safety, Guardrails & Step-Ledger)'}
          </text>
          <text fg={fg()}>{`  ${snapshot().flightdeck.gateGlyphs}`}</text>
          <text fg={muted()}>{`  ${snapshot().flightdeck.gateSummary}`}</text>

          <box marginTop={1} flexDirection="column">
            <text fg={accent()} attributes={1}>
              {'Step-Ledger & Active Tasks'}
            </text>
            <Show
              when={snapshot().flightdeck.steps.length > 0}
              fallback={<text fg={muted()}>{'  (no active step-ledger entries)'}</text>}
            >
              <For each={snapshot().flightdeck.steps.slice(0, 6)}>
                {(st) => (
                  <text
                    fg={st.state === 'blocked' || st.state === 'rolled_back' ? errFg() : success()}
                  >
                    {`  ▸ ${st.stepKey.padEnd(20)} [${st.state.padEnd(11)}] @${st.agent}  ${st.objective.slice(0, 36)}`}
                  </text>
                )}
              </For>
            </Show>
          </box>

          <box marginTop={1} flexDirection="column">
            <text fg={accent()} attributes={1}>
              {'Semantic Event Stream'}
            </text>
            <Show
              when={snapshot().flightdeck.logs.length > 0}
              fallback={<text fg={muted()}>{'  (no bus telemetry events captured yet)'}</text>}
            >
              <For each={snapshot().flightdeck.logs.slice(0, 8)}>
                {(ev) => (
                  <text fg={ev.severity === 'error' ? errFg() : muted()}>
                    {`  [${ev.kind}] @${ev.agent}: ${ev.detail.slice(0, 56)}`}
                  </text>
                )}
              </For>
            </Show>
          </box>
        </box>
      </Show>

      <text fg={muted()} marginTop={1}>
        {'─'.repeat(72)}
      </text>
      <text fg={muted()}>
        {'1-3 tabs · Tab/Shift+Tab switch · ↑↓ select · Enter detail · r refresh · Esc/q close'}
      </text>
    </box>
  )
}

function plainReturnRoute(cur: any): WindowRoute | undefined {
  if (!cur || typeof cur.type !== 'string') return undefined
  if (cur.type === 'session' && typeof cur.sessionID === 'string') {
    return { type: 'session', sessionID: cur.sessionID }
  }
  if (cur.type === 'home') return { type: 'home' }
  return undefined
}

export function setupPantheonCockpit(context: Context, resolveCwd: () => string): void {
  const ui = (context as any)?.ui
  if (typeof ui?.router?.register === 'function') {
    try {
      ui.router.register({
        name: ROUTE_NAME,
        render: ({ data }: { data?: { returnRoute?: WindowRoute } }) => {
          const ret = data?.returnRoute
          const onClose = () => {
            if (ret) ui.router.navigate(ret)
            else ui.router.navigate({ type: 'home' })
          }
          return (
            <CockpitView
              context={context}
              workspaceDir={resolveCwd()}
              sessionID={ret && ret.type === 'session' ? ret.sessionID : undefined}
              onClose={onClose}
            />
          )
        },
      })
      routerReady = true
    } catch {
      routerReady = false
    }
  }

  const routeGated = () => {
    try {
      const r = ui?.router?.current?.()
      return r?.type === 'plugin' && r.name === ROUTE_NAME
    } catch {
      return false
    }
  }

  const commands = [
    {
      id: 'pantheon.cockpit.tab1',
      title: 'Overview tab',
      bind: '1',
      run: () => {
        cockpitController?.setTab('overview')
        return undefined
      },
    },
    {
      id: 'pantheon.cockpit.tab2',
      title: 'Swarm tab',
      bind: '2',
      run: () => {
        cockpitController?.setTab('swarm')
        return undefined
      },
    },
    {
      id: 'pantheon.cockpit.tab3',
      title: 'Flightdeck tab',
      bind: '3',
      run: () => {
        cockpitController?.setTab('flightdeck')
        return undefined
      },
    },
    {
      id: 'pantheon.cockpit.next',
      title: 'Next Cockpit tab',
      bind: 'tab',
      run: () => {
        cockpitController?.nextTab()
        return undefined
      },
    },
    {
      id: 'pantheon.cockpit.prev',
      title: 'Previous Cockpit tab',
      bind: 'shift+tab',
      run: () => {
        cockpitController?.prevTab()
        return undefined
      },
    },
    {
      id: 'pantheon.cockpit.up',
      title: 'Previous row',
      bind: 'up,k',
      run: () => {
        cockpitController?.moveRow(-1)
        return undefined
      },
    },
    {
      id: 'pantheon.cockpit.down',
      title: 'Next row',
      bind: 'down,j',
      run: () => {
        cockpitController?.moveRow(1)
        return undefined
      },
    },
    {
      id: 'pantheon.cockpit.detail',
      title: 'Toggle row detail',
      bind: 'enter',
      run: () => {
        cockpitController?.toggleDetail()
        return undefined
      },
    },
    {
      id: 'pantheon.cockpit.refresh',
      title: 'Refresh Cockpit',
      bind: 'r',
      run: () => {
        cockpitController?.refresh()
        return undefined
      },
    },
    {
      id: 'pantheon.cockpit.close',
      title: 'Close Cockpit',
      bind: 'escape,q',
      run: () => {
        cockpitController?.close()
        return undefined
      },
    },
  ]

  try {
    ;(context as any).keymap?.layer?.(() => ({
      mode: ROUTE_MODE,
      priority: 1,
      enabled: () => routeGated() || cockpitOpen(),
      commands,
    }))
    ;(context as any).keymap?.layer?.(() => ({
      mode: 'global' as const,
      priority: 1,
      enabled: () => cockpitOpen(),
      commands,
    }))
  } catch {
    /* keymap unavailable */
  }
}

export function openPantheonCockpit(context: Context, workspaceDir: string): void {
  const ui = (context as any)?.ui
  if (routerReady && typeof ui?.router?.navigate === 'function') {
    let returnRoute: WindowRoute | undefined
    try {
      const cur = ui.router.current()
      if (!(cur?.type === 'plugin' && cur.name === ROUTE_NAME)) {
        returnRoute = plainReturnRoute(cur)
      }
    } catch {
      returnRoute = undefined
    }
    ui.router.navigate({
      type: 'plugin',
      name: ROUTE_NAME,
      ...(returnRoute ? { data: { returnRoute } } : {}),
    })
    return
  }

  try {
    const curSid =
      ui?.router?.current?.()?.type === 'session' ? ui.router.current().sessionID : undefined
    ui?.dialog?.show?.(
      () => (
        <CockpitView
          context={context}
          workspaceDir={workspaceDir}
          sessionID={curSid}
          onClose={() => ui?.dialog?.clear?.()}
        />
      ),
      () => {},
    )
    ui?.dialog?.set?.({ size: 'large', centered: true })
  } catch {
    /* ignore */
  }
}
