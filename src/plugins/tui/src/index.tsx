// biome-ignore-all lint/suspicious/noExplicitAny: necessary for TuiPluginApi dynamic state access
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createMemo, createResource, createSignal, For, Show } from 'solid-js'

/* ─── Constants ─────────────────────────────────────────── */

const BAR_WIDTH = 20

const COMMANDS = [
  { name: '/pantheon', desc: 'Council synthesis' },
  { name: '/pantheon-status', desc: 'System status' },
  { name: '/pantheon-audit', desc: 'Full audit' },
  { name: '/pantheon-bg', desc: 'List background tasks' },
  { name: '/pantheon-cancel', desc: 'Cancel task' },
  { name: '/pantheon-deepwork', desc: 'Deep work mode' },
  { name: '/pantheon-focus', desc: 'Focus on scope' },
  { name: '/pantheon-remember', desc: 'Memory store/recall' },
  { name: '/pantheon-search', desc: 'Memory search' },
  { name: '/pantheon-consolidate', desc: 'Merge memories' },
  { name: '/pantheon-forget', desc: 'Compress memories' },
] as const

const AGENTS = [
  { name: 'zeus', tier: 'default' as const, role: 'Orchestrator' },
  { name: 'athena', tier: 'premium' as const, role: 'Strategic planner' },
  { name: 'apollo', tier: 'fast' as const, role: 'Codebase discovery' },
  { name: 'hermes', tier: 'default' as const, role: 'Backend' },
  { name: 'aphrodite', tier: 'default' as const, role: 'Frontend' },
  { name: 'demeter', tier: 'default' as const, role: 'Database' },
  { name: 'themis', tier: 'premium' as const, role: 'Quality & security' },
  { name: 'prometheus', tier: 'default' as const, role: 'Infrastructure' },
  { name: 'hephaestus', tier: 'default' as const, role: 'AI pipelines' },
  { name: 'nyx', tier: 'fast' as const, role: 'Observability' },
  { name: 'gaia', tier: 'fast' as const, role: 'Remote sensing' },
  { name: 'iris', tier: 'fast' as const, role: 'GitHub operations' },
  { name: 'mnemosyne', tier: 'fast' as const, role: 'Memory bank' },
  { name: 'talos', tier: 'fast' as const, role: 'Hotfixes' },
] as const

/* ─── Helpers ───────────────────────────────────────────── */

function safeNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function fmtInt(n: number): string {
  return Intl.NumberFormat('en-US').format(Math.max(0, Math.round(n)))
}

function fmtCost(v: number): string {
  if (v <= 0) return ''
  if (v < 0.01) return '<$0.01'
  return `$${v.toFixed(2)}`
}

function msgTokens(msg: any): number {
  const t = msg?.tokens ?? msg?.info?.tokens ?? {}
  return safeNum(t.input) + safeNum(t.output) + safeNum(t.reasoning)
    + safeNum(t?.cache?.read) + safeNum(t?.cache?.write)
}

function msgCost(src: any): number {
  for (const c of [src?.cost, src?.info?.cost, src?.usage?.cost]) {
    if (typeof c === 'number' && c > 0) return c
  }
  return 0
}

function buildBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((clamped / 100) * BAR_WIDTH)))
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

/* ─── Version Detection ────────────────────────────────────
 * 100% dinâmico — zero fallback hardcoded.
 * Se falhar, retorna null e a View omite a versão.            */

async function detectVersion(api: TuiPluginApi): Promise<string | null> {
  // Try 1: package.json do projeto (via worktree path)
  try {
    const wt = ((api.state as any).path?.worktree ?? '') as string
    const fp = wt ? `${wt}/package.json` : 'package.json'
    const result = await api.client.file.read({ query: { path: fp } })
    const match = String(result?.content ?? '').match(/"version":\s*"([^"]+)"/)
    if (match?.[1]) return match[1]
  } catch { /* fall through */ }

  // Try 2: git describe --tags
  try {
    const proc = (api as any).client?.process
    if (typeof proc?.exec === 'function') {
      const r = await proc.exec({ command: 'git', args: ['describe', '--tags', '--always'], timeoutMs: 3000 })
      const stdout = (r.stdout ?? r.output ?? '') as string
      const tag = stdout.trim().replace(/^v/, '').replace(/-\d+-g[0-9a-f]+$/, '')
      if (tag && tag !== '5.0.0') return tag
    }
  } catch { /* fall through */ }

  return null // sem fallback — versão não aparece
}

/* ─── Context Bar ──────────────────────────────────────────
 * Inspired by streetturtle/opencode-better-sidebar (context-progress)
 * Shows: progress bar, token usage / limit, session cost       */

function ContextBar(props: { api: TuiPluginApi; sessionID: string }) {
  const messages = createMemo((): any[] => {
    try { return (props.api.state.session as any).messages(props.sessionID) ?? [] }
    catch { return [] }
  })

  const usage = createMemo(() => {
    const msgs = messages()
    const lastAssistant = [...msgs].reverse().find((m: any) => {
      const role = m?.role ?? m?.info?.role
      return role === 'assistant' && safeNum(m?.tokens?.output) > 0
    })
    if (!lastAssistant) return null

    const tokens = msgTokens(lastAssistant)
    const pid = lastAssistant?.providerID ?? lastAssistant?.info?.providerID
    const mid = lastAssistant?.modelID ?? lastAssistant?.info?.modelID
    const provider = pid
      ? ((props.api.state as any).provider ?? []).find((p: any) => p.id === pid)
      : null
    const ctxLimit = safeNum(provider?.models?.[mid ?? '']?.limit?.context)
    const limit = ctxLimit > 0 ? ctxLimit : 200000
    return { tokens, limit, percent: ctxLimit > 0 ? Math.round((tokens / ctxLimit) * 100) : 0 }
  })

  const totalCost = createMemo(() => {
    const state = ((props.api.state as any).session)?.get?.(props.sessionID)
    const fromState = msgCost(state)
    if (fromState > 0) return fromState
    return messages().reduce((sum: number, m: any) => sum + msgCost(m), 0)
  })

  const theme = () => props.api.theme.current

  return (
    <Show when={usage()}>
      {(u) => {
        const pct = u().percent
        const c = theme()
        const barColor = pct >= 90 ? c.error : pct >= 70 ? c.warning : c.accent
        const costStr = fmtCost(totalCost())
        return (
          <box flexDirection="column">
            <box flexDirection="row" gap={1}>
              <text fg={c.text} attributes={{ bold: true }}>Context</text>
              <text fg={barColor}>{buildBar(pct)}</text>
              <text fg={barColor}>{`${pct}%`}</text>
            </box>
            <text fg={c.textMuted}>
              {`${fmtInt(u().tokens)} / ${fmtInt(u().limit)} tok${costStr ? `  ${costStr}` : ''}`}
            </text>
          </box>
        )
      }}
    </Show>
  )
}

/* ─── Sessions List (loaded on expand) ───────────────────── */

async function fetchRecentSessions(api: TuiPluginApi, sessionID: string): Promise<any[] | null> {
  try {
    const proc = (api as any).client?.process
    if (typeof proc?.exec !== 'function') return null
    const result = await proc.exec({
      command: 'opencode',
      args: ['session', 'list', '--format', 'json', '--max-count', '20'],
      timeoutMs: 5000,
    })
    const stdout = (result.stdout ?? result.output ?? '') as string
    const sessions = JSON.parse(stdout)
    if (!Array.isArray(sessions)) return null
    return sessions
      .filter((s: any) => s.id !== sessionID)
      .sort((a: any, b: any) => (b.updated ?? 0) - (a.updated ?? 0))
      .slice(0, 8)
  } catch { return null }
}

/* ─── Main Sidebar View ──────────────────────────────────── */

function View(props: { api: TuiPluginApi; sessionID: string; version: string | null }) {
  const [showCommands, setShowCommands] = createSignal(false)
  const [showAgents, setShowAgents] = createSignal(false)
  const [showConfig, setShowConfig] = createSignal(false)
  const [showSessions, setShowSessions] = createSignal(false)

  const theme = () => props.api.theme.current

  const branch = createMemo(() =>
    props.api.state.vcs?.branch ? `\u2387 ${props.api.state.vcs.branch}` : null,
  )

  const totalSessions = createMemo(() => {
    try { return props.api.state.session.count() } catch { return 0 }
  })

  const memoryCount = createMemo(() => {
    const mem = (props.api.state as any).memory
    return safeNum(mem?.entries) || safeNum(mem?.count)
  })

  const configSummary = createMemo(() => {
    const cfg = (props.api.state as any).config
    if (!cfg) return null
    return {
      mcpCount: cfg.mcp ? Object.keys(cfg.mcp).length : 0,
      pluginCount: Array.isArray(cfg.plugin) ? cfg.plugin.length : 0,
      autoCompaction: cfg.compaction?.auto === true,
    }
  })

  // Load session list only when expanded
  const [sessions] = createResource(
    () => showSessions(),
    () => fetchRecentSessions(props.api, props.sessionID),
  )

  const HR = () => <text fg={theme().textMuted}>{'\u2500'.repeat(28)}</text>

  return (
    <box flexDirection="column" width="100%">
      {/* ── Header ── */}
      <text fg={theme().accent} attributes={{ bold: true }}>
        {`Pantheon${props.version ? ` v${props.version}` : ''}`}
      </text>
      <Show when={branch()}>
        {(b) => <text fg={theme().textMuted}>{b()}</text>}
      </Show>

      <HR />

      {/* ── Context Bar (always visible) ── */}
      <ContextBar api={props.api} sessionID={props.sessionID} />

      <HR />

      {/* ── Sessions ── */}
      <box onMouseDown={() => setShowSessions((x) => !x)}>
        <text fg={theme().text} attributes={{ bold: true }}>
          {`${showSessions() ? '\u25bc' : '\u25b6'} Sessions`}
        </text>
        <text fg={theme().textMuted}>{` (${String(totalSessions())})`}</text>
      </box>
      <Show when={showSessions() && sessions()}>
        {(s) => (
          <Show when={s().length > 0} fallback={<box marginLeft={1}><text fg={theme().textMuted}>No recent sessions</text></box>}>
            <box marginLeft={1} flexDirection="column">
              <For each={s()}>
                {(ses: any) => (
                  <text fg={theme().textMuted}>
                    {`${ses.id.slice(0, 8)}... ${ses.title?.slice(0, 28) ?? '(untitled)'}`}
                  </text>
                )}
              </For>
            </box>
          </Show>
        )}
      </Show>

      {/* ── Commands ── */}
      <box onMouseDown={() => setShowCommands((x) => !x)}>
        <text fg={theme().text} attributes={{ bold: true }}>
          {`${showCommands() ? '\u25bc' : '\u25b6'} Commands`}
        </text>
        <text fg={theme().textMuted}>{` (${String(COMMANDS.length)})`}</text>
      </box>
      <Show when={showCommands()}>
        <box marginLeft={1} flexDirection="column">
          <For each={COMMANDS}>
            {(cmd) => (
              <box onMouseDown={(e) => {
                e.stopPropagation()
                try {
                  const cmdApi = (props.api as any).command
                  const cmdName = cmd.name.replace('/', '')
                  if (cmdApi?.trigger?.(cmdName)) return
                } catch { /* fall through to toast */ }
                props.api.ui?.toast?.({ title: 'Command', message: `Type ${cmd.name} in chat` })
              }}>
                <text fg={cmd.name === '/pantheon' ? theme().accent : theme().textMuted}>
                  {cmd.name}
                </text>
                <text fg={theme().textMuted}>{` \u2014 ${cmd.desc}`}</text>
              </box>
            )}
          </For>
        </box>
      </Show>

      {/* ── Agents ── */}
      <box onMouseDown={() => setShowAgents((x) => !x)}>
        <text fg={theme().text} attributes={{ bold: true }}>
          {`${showAgents() ? '\u25bc' : '\u25b6'} Agents`}
        </text>
        <text fg={theme().textMuted}>{` (${String(AGENTS.length)})`}</text>
      </box>
      <Show when={showAgents()}>
        <box marginLeft={1} flexDirection="column">
          <For each={AGENTS}>
            {(agent) => (
              <box>
                <text fg={agent.tier === 'premium' ? theme().accent : theme().textMuted}>
                  {`${agent.tier === 'premium' ? '\u2726 ' : '\u00b7 '}${agent.name}`}
                </text>
                <text fg={theme().textMuted}>{` \u2014 ${agent.role}`}</text>
              </box>
            )}
          </For>
        </box>
      </Show>

      {/* ── Config ── */}
      <box onMouseDown={() => setShowConfig((x) => !x)}>
        <text fg={theme().text} attributes={{ bold: true }}>
          {`${showConfig() ? '\u25bc' : '\u25b6'} Config`}
        </text>
      </box>
      <Show when={showConfig()}>
        <Show when={configSummary()} fallback={<box marginLeft={1}><text fg={theme().textMuted}>No config data</text></box>}>
          {(cfg) => (
            <box marginLeft={1} flexDirection="column">
              <text fg={theme().textMuted}>{`MCP: ${String(cfg().mcpCount)}  Plugins: ${String(cfg().pluginCount)}`}</text>
              <text fg={theme().textMuted}>{`Auto-compaction: ${cfg().autoCompaction ? 'ON' : 'OFF'}`}</text>
            </box>
          )}
        </Show>
      </Show>

      {/* ── Memory (always visible summary) ── */}
      <box marginTop={1}>
        <text fg={theme().textMuted}>
          {`Memory: ${memoryCount() > 0 ? `${fmtInt(memoryCount())} entries` : '0 entries'}`}
        </text>
      </box>
    </box>
  )
}

/* ─── Plugin Registration ────────────────────────────────── */

const tui: TuiPlugin = async (api, _options, _meta) => {
  const version = await detectVersion(api)

  api.slots.register({
    order: 900,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} sessionID={props.session_id} version={version} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: 'pantheon.tui',
  tui,
}

export default plugin
