// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode Desktop GUI SDK exposes reactive host types at runtime.
/** @jsxImportSource solid-js */

/**
 * gui.tsx — Native OpenCode Desktop GUI plugin (`./gui-experimental`).
 *
 * Provides:
 * - Side Panel (`Pantheon Cockpit`) with Olympus Topology (DAG + Timeline/Gantt
 *   + replay scrubber), Agora Board (`#seq` stream), Ephemeral & Bots, Settings.
 * - Native `SettingsPage` (`Pantheon`) in Desktop Settings.
 * - Slash commands `/pantheon-cockpit` and `/pantheon-settings`.
 * - Electron `main(ctx)` IPC bridge reading `.pantheon/` state files safely.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Command,
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
  overridesCount: number
}

const PantheonBridge = Ipc.define({
  id: 'pantheon-opencode.bridge',
  methods: {
    snapshot: {
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
  const statePath = join(root, '.pantheon', 'board', 'state.json')
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        jobs?: Record<string, { id?: string; agent?: string; status?: string; cost?: number }>
      }
      if (state.jobs && typeof state.jobs === 'object') {
        for (const [id, job] of Object.entries(state.jobs)) {
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

  let overridesCount = 0
  const overridesPath = join(root, '.pantheon', 'overrides.json')
  if (existsSync(overridesPath)) {
    try {
      const ov = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<string, unknown>
      overridesCount = Object.keys(ov).length
    } catch {
      /* ignore */
    }
  }

  return { messages, events, activeJobs, overridesCount }
}

type GuiSubTab = 'topology' | 'board' | 'ephemeral' | 'settings'

function PantheonCockpitView(props: { ctx: SetupContext; directory: () => string }) {
  const [subTab, setSubTab] = createSignal<GuiSubTab>('topology')
  const [topoView, setTopoView] = createSignal<'dag' | 'gantt'>('dag')
  const [snapshot, setSnapshot] = createSignal<GuiSnapshot>({
    messages: [],
    events: [],
    activeJobs: [],
    overridesCount: 0,
  })
  const [scrubberSeq, setScrubberSeq] = createSignal<number | null>(null)

  const refresh = async () => {
    try {
      const raw = await props.ctx.main(PantheonBridge).snapshot(props.directory())
      const parsed = JSON.parse(raw) as GuiSnapshot
      setSnapshot(parsed)
    } catch {
      /* fail-open when main process bridge is unavailable (e.g. Web) */
    }
  }

  createEffect(() => {
    void props.directory()
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    onCleanup(() => clearInterval(timer))
  })

  const maxSeq = createMemo(() => {
    const msgs = snapshot().messages
    return msgs.length > 0 ? (msgs[msgs.length - 1]?.seq ?? 0) : 0
  })

  const visibleMessages = createMemo(() => {
    const cap = scrubberSeq()
    const msgs = snapshot().messages
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
    for (const j of snapshot().activeJobs) {
      if (j.agent) set.add(j.agent)
    }
    return [...set].slice(0, 6)
  })

  const totalCost = createMemo(() =>
    snapshot().activeJobs.reduce((sum, j) => sum + (Number.isFinite(j.cost) ? j.cost : 0), 0),
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
            {`${snapshot().activeJobs.filter((j) => j.status === 'running').length} active · $${totalCost().toFixed(2)}`}
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
            ['board', `Agora Board (${snapshot().messages.length})`],
            ['ephemeral', `Ephemeral & Bots (${snapshot().activeJobs.length})`],
            ['settings', 'Settings'],
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
            style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}
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

      {/* Tab 2: Agora Board */}
      <Show when={subTab() === 'board'}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
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
            each={snapshot().activeJobs}
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

      {/* Tab 4: Settings summary */}
      <Show when={subTab() === 'settings'}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <div>{`Project overrides: ${snapshot().overridesCount}`}</div>
          <div style={{ opacity: 0.75 }}>
            Open Desktop Settings → Pantheon for full configuration, or use /pantheon-settings in
            TUI.
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
            Olympus Topology, Agora Board, and Ephemeral Worker telemetry are active in the Pantheon
            side panel.
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
