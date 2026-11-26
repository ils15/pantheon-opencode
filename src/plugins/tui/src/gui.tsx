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
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  type: string
  timestamp: number
  agent?: string
  status?: string
  detail?: string
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

function readOpenCodeCosts(): { todayCostUSD: number; monthCostUSD: number } {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const dbPath = join(xdgData, 'opencode', 'opencode.db')
  if (!existsSync(dbPath)) return { todayCostUSD: 0, monthCostUSD: 0 }

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const now = Date.now()
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      const dayMs = startOfDay.getTime()
      const monthMs = now - 30 * 24 * 60 * 60 * 1000

      const row = db
        .prepare(
          `SELECT
            COALESCE(SUM(CASE WHEN time_created >= ? THEN COALESCE(json_extract(data, '$.cost'), 0) ELSE 0 END), 0) AS today_cost,
            COALESCE(SUM(CASE WHEN time_created >= ? THEN COALESCE(json_extract(data, '$.cost'), 0) ELSE 0 END), 0) AS month_cost
          FROM message`,
        )
        .get(dayMs, monthMs) as { today_cost?: number; month_cost?: number } | undefined

      return {
        todayCostUSD: Number(row?.today_cost ?? 0) || 0,
        monthCostUSD: Number(row?.month_cost ?? 0) || 0,
      }
    } finally {
      db.close()
    }
  } catch {
    return { todayCostUSD: 0, monthCostUSD: 0 }
  }
}

function readSnapshotFromDisk(directory: string): GuiSnapshot {
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
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        jobs?: Record<string, { id?: string; agent?: string; status?: string; cost?: number }>
      }
      if (state.jobs && typeof state.jobs === 'object') {
        for (const [id, job] of Object.entries(state.jobs)) {
          seenJobIds.add(id)
          activeJobs.push({
            id,
            agent: job.agent ?? 'specialist',
            status: job.status ?? 'unknown',
            cost: typeof job.cost === 'number' ? job.cost : 0,
          })
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

  let overridesCount = 0
  let gateMode = 'shadow'
  const overridesPath = join(root, '.pantheon', 'overrides.json')
  if (existsSync(overridesPath)) {
    try {
      const ov = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<string, any>
      overridesCount = Object.keys(ov).length
      if (typeof ov.gateMode === 'string') gateMode = ov.gateMode
    } catch {
      /* ignore */
    }
  }

  let artifactsCount = 0
  const plansDir = join(root, '.pantheon', 'plans')
  if (existsSync(plansDir)) {
    try {
      artifactsCount = readdirSync(plansDir).filter((f) => f.endsWith('.md')).length
    } catch {
      /* ignore */
    }
  }

  const { todayCostUSD, monthCostUSD } = readOpenCodeCosts()

  return {
    messages,
    events,
    activeJobs,
    todayCostUSD,
    monthCostUSD,
    overridesCount,
    gateMode,
    artifactsCount,
  }
}

function appendBoardMessageToDisk(payloadRaw: string): string {
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
}

function saveSettingsToDisk(payloadRaw: string): string {
  const payload = JSON.parse(payloadRaw) as {
    directory?: string
    gateMode?: string
  }
  const root = payload.directory?.trim() || process.cwd()
  const pantheonDir = join(root, '.pantheon')
  mkdirSync(pantheonDir, { recursive: true })
  const overridesPath = join(pantheonDir, 'overrides.json')
  let current: Record<string, unknown> = {}
  if (existsSync(overridesPath)) {
    try {
      current = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<string, unknown>
    } catch {
      current = {}
    }
  }
  if (typeof payload.gateMode === 'string') {
    current.gateMode = payload.gateMode
  }
  writeFileSync(overridesPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  return JSON.stringify({ ok: true })
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
})

function PantheonCockpitView(props: { ctx: SetupContext; directory: () => string }) {
  const [subTab, setSubTab] = createSignal<GuiSubTab>('topology')
  const [topoView, setTopoView] = createSignal<'dag' | 'gantt'>('dag')
  const [scrubberSeq, setScrubberSeq] = createSignal<number | null>(null)
  const [draftMsg, setDraftMsg] = createSignal('')
  const [draftChannel, setDraftChannel] = createSignal('default')

  const refresh = async () => {
    try {
      const raw = await props.ctx.main(PantheonBridge).snapshot(props.directory())
      setSharedSnapshot(JSON.parse(raw) as GuiSnapshot)
    } catch {
      /* fail-open when main process bridge is unavailable (e.g. Web) */
    }
  }

  const sendBoardMsg = async () => {
    const body = draftMsg().trim()
    if (!body) return
    try {
      await props.ctx.main(PantheonBridge).postBoardMessage(
        JSON.stringify({
          directory: props.directory(),
          channel: draftChannel(),
          body,
        }),
      )
      setDraftMsg('')
      await refresh()
    } catch {
      /* fail-open */
    }
  }

  const cycleGateMode = async () => {
    const order = ['shadow', 'enforce', 'off']
    const next = order[(order.indexOf(sharedSnapshot().gateMode) + 1) % order.length] ?? 'shadow'
    try {
      await props.ctx.main(PantheonBridge).saveSettings(
        JSON.stringify({
          directory: props.directory(),
          gateMode: next,
        }),
      )
      await refresh()
    } catch {
      /* fail-open */
    }
  }

  createEffect(() => {
    void props.directory()
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

  const uniqueAgents = createMemo(() => {
    const set = new Set<string>(['zeus'])
    for (const m of visibleMessages()) {
      if (m.from) set.add(m.from)
    }
    for (const j of sharedSnapshot().activeJobs) {
      if (j.agent) set.add(j.agent)
    }
    return [...set].slice(0, 6)
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
          <span style={{ opacity: 0.7 }}>v2.3.3</span>
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
            fallback={<div style={{ opacity: 0.6 }}>No active background jobs.</div>}
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
        </div>
      </Show>

      {/* Tab 4: Settings & Cost */}
      <Show when={subTab() === 'settings'}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
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
              padding: '8px',
              'border-radius': '6px',
              border: '1px solid var(--border-weak-base, #2e2e32)',
            }}
          >
            <span>Auto-Permissions Gate</span>
            <button
              type="button"
              onClick={() => void cycleGateMode()}
              style={{
                padding: '2px 10px',
                'border-radius': '4px',
                border: '1px solid var(--border-weak-base, #3f3f46)',
                background: 'transparent',
                color: '#fba970',
                'font-family': 'monospace',
                cursor: 'pointer',
              }}
            >
              {sharedSnapshot().gateMode}
            </button>
          </div>
          <div style={{ opacity: 0.75 }}>
            {`Overrides: ${sharedSnapshot().overridesCount} · Plans: ${sharedSnapshot().artifactsCount}`}
          </div>
        </div>
      </Show>
    </div>
  )
}

export default Plugin.define({
  main(ctx) {
    ctx.provide(PantheonBridge, {
      snapshot: (directory) => JSON.stringify(readSnapshotFromDisk(directory)),
      postBoardMessage: (payload) => appendBoardMessageToDisk(payload),
      saveSettings: (payload) => saveSettingsToDisk(payload),
    })
  },
  setup(ctx) {
    const cockpitTab: PanelTab = {
      id: 'pantheon-cockpit',
      title: 'Pantheon',
      icon: 'pantheon',
      pinned: true,
    }

    ctx.add(Panel, () => ({
      id: 'cockpit',
      region: 'side',
      wide: true,
      list: () => [cockpitTab],
      render: (props) => (
        <PantheonCockpitView
          ctx={ctx}
          directory={() => props.session()?.location?.directory ?? ''}
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
              run: () => {
                const screen = ctx.screen.current()
                if (screen) screen.panel.open({ tab: 'pantheon-cockpit' })
              },
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
      render: () => (
        <div style={{ padding: '16px', display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
          <h2 style={{ 'font-size': '16px', 'font-weight': 600 }}>Pantheon v2.3.3</h2>
          <p style={{ 'font-size': '13px', opacity: 0.8 }}>
            {`Spend today: $${sharedSnapshot().todayCostUSD.toFixed(2)} · 30d: $${sharedSnapshot().monthCostUSD.toFixed(2)} · Gate: ${sharedSnapshot().gateMode}`}
          </p>
          <p style={{ 'font-size': '13px', opacity: 0.8 }}>
            Olympus Topology, interactive Agora Board, and Ephemeral Worker telemetry are active in
            the Pantheon side panel.
          </p>
        </div>
      ),
    }))

    ctx.add(Command, () => ({
      id: 'cockpit',
      title: 'Open Pantheon Cockpit',
      description: 'Open Olympus Topology, Agora Board, and Ephemeral Workers',
      slash: { name: 'pantheon-cockpit' },
      run: () => {
        const screen = ctx.screen.current()
        if (screen) screen.panel.open({ tab: 'pantheon-cockpit' })
      },
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
