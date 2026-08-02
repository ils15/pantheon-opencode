// biome-ignore-all lint/suspicious/noExplicitAny: necessary for TuiPluginApi dynamic state access
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

/**
 * pantheon-tui — Pantheon TUI plugin for opencode.
 *
 * Single self-contained entry file: `tsdown && cp src/index.tsx dist/tui.tsx`
 * keeps the no-build load path working (dist/tui.tsx is raw source, transpiled
 * on the fly by opencode). All feature code lives in this one file.
 *
 * Slots:
 *   - sidebar_content        (order 900) — Pantheon sidebar (header/version/
 *     branch, Sessions, Commands, Agents, Config, Memory).
 *   - session_prompt_right   (order 60)  — live todo progress bar, next to the
 *     model name.
 *   - app_bottom             (order 60)  — AI subscription usage gauges
 *     (Anthropic/OpenAI quotas + provider status incidents).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VENDORED FEATURES (MIT) — incorporated with their license headers preserved:
 *
 *   • satas20/opencode-todo-progress (MIT)
 *       https://github.com/satas20/opencode-todo-progress
 *   • satas20/opencode-usage-bar (MIT)
 *       https://github.com/satas20/opencode-usage-bar
 *
 * Both were vendored and adapted to merge into this single file (imports
 * unified, config key name `usage-bar.toml` and poll/backoff behavior kept).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LIMITATION — native context/tokens statusline:
 *   The opencode session footer natively shows a context/tokens statusline
 *   next to the prompt. There is NO config option to hide it: the tui.json
 *   schema (opencode.ai/tui.json) only exposes `theme`, `keybinds`,
 *   `scroll_speed`, `scroll_acceleration`, `diff_style`, `mouse` and
 *   `attention`, and the SDK `Config` type has no statusline/tokens display
 *   flag (checked against @opencode-ai/sdk `Config` and the published
 *   schema). The Pantheon sidebar therefore no longer duplicates that footer
 *   (the old ContextBar was removed) and we deliberately do NOT hack the
 *   native footer. Track upstream: opencode statusline config.
 */

import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

/* ─── Constants ─────────────────────────────────────────── */

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

function fmtInt(n: number): string {
  return Intl.NumberFormat('en-US').format(Math.max(0, Math.round(n)))
}

/* ─── Version Detection ────────────────────────────────────
 * 100% dinâmico — zero fallback hardcoded.
 * Se falhar, retorna null e a View omite a versão.
 *
 * Try order:
 *   1. api.client.file.read package.json
 *   2. git describe --tags
 *   3. opencode --version
 *   4. null                                                      */

async function detectVersion(api: TuiPluginApi): Promise<string | null> {
  // Try 1: package.json do projeto (via worktree path)
  try {
    const wt = ((api.state as any).path?.worktree ?? '') as string
    const fp = wt ? `${wt}/package.json` : 'package.json'
    const result = await api.client.file.read({ path: fp })
    const content = String(result?.data?.content ?? '')
    const match = content.match(/"version":\s*"([^"]+)"/)
    if (match?.[1]) return match[1]
  } catch {
    /* fall through */
  }

  // Try 2: git describe --tags
  try {
    const proc = (api as any).client?.process
    if (typeof proc?.exec === 'function') {
      const r = await proc.exec({
        command: 'git',
        args: ['describe', '--tags', '--always'],
        timeoutMs: 3000,
      })
      const stdout = (r.stdout ?? r.output ?? '') as string
      const tag = stdout
        .trim()
        .replace(/^v/, '')
        .replace(/-\d+-g[0-9a-f]+$/, '')
      if (tag && tag !== '5.0.0') return tag
    }
  } catch {
    /* fall through */
  }

  // Try 3: opencode --version
  try {
    const proc = (api as any).client?.process
    if (typeof proc?.exec === 'function') {
      const r = await proc.exec({ command: 'opencode', args: ['--version'], timeoutMs: 3000 })
      const stdout = (r.stdout ?? r.output ?? '') as string
      const ver = stdout.trim().replace(/^v/, '')
      if (ver) return ver
    }
  } catch {
    /* fall through */
  }

  return null // sem fallback — versão não aparece
}

/* ──────────────────────────────────────────────────────────
 * VENDORED: opencode-todo-progress (MIT) — satas20
 * https://github.com/satas20/opencode-todo-progress
 * ────────────────────────────────────────────────────────── */

/**
 * todo-progress — persistent todo progress bar for the opencode TUI.
 *
 * Renders a compact `▓▓▓▓▓▓▓▓░░ 3/10 · current task` bar on the right side
 * of the session prompt's agent/model row, next to the model name. Updates
 * live via the `todo.updated` SSE event (already wired into the TUI state
 * store). Hides entirely when the active session has no todos.
 *
 * Loaded via tui.json, e.g.:
 *   { "plugin": ["opencode-todo-progress"] }        // published npm package
 *   { "plugin": ["/abs/path/to/src/index.tsx"] }    // local file (no build)
 */

const TODO_BAR_WIDTH = 10
const TASK_MAX = 30

function truncate(text: string, max: number) {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text
}

function setupTodoProgress(api: TuiPluginApi) {
  api.slots.register({
    order: 60,
    slots: {
      // `session_prompt_right` renders on the right of the agent/model row,
      // opposite the model name. It receives the active session id directly.
      session_prompt_right(_ctx, props) {
        const theme = () => api.theme.current

        const todos = createMemo(() =>
          api.state.session.todo(props.session_id).filter((t) => t.status !== 'cancelled'),
        )

        const total = createMemo(() => todos().length)
        const done = createMemo(() => todos().filter((t) => t.status === 'completed').length)
        const current = createMemo(() => todos().find((t) => t.status === 'in_progress')?.content)

        const filled = createMemo(() => {
          if (total() === 0) return 0
          const ratio = done() / total()
          if (ratio <= 0) return 0
          if (ratio >= 1) return TODO_BAR_WIDTH
          return Math.min(TODO_BAR_WIDTH - 1, Math.max(1, Math.round(ratio * TODO_BAR_WIDTH)))
        })

        return (
          <Show when={total() > 0 && done() < total()}>
            <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
              <box flexDirection="row">
                <text fg={theme().warning}>{'▓'.repeat(filled())}</text>
                <text fg={theme().textMuted}>{'░'.repeat(TODO_BAR_WIDTH - filled())}</text>
              </box>
              <text fg={theme().text}>
                {done()}/{total()}
              </text>
              {current() ? (
                <text fg={theme().textMuted}>{`· ${truncate(current() ?? '', TASK_MAX)}`}</text>
              ) : null}
            </box>
          </Show>
        )
      },
    },
  })
}

/* ──────────────────────────────────────────────────────────
 * VENDORED: opencode-usage-bar (MIT) — satas20
 * https://github.com/satas20/opencode-usage-bar
 * ────────────────────────────────────────────────────────── */

/**
 * usage-bar — AI subscription usage gauge for the opencode TUI.
 *
 * Renders a compact usage strip in the `app_bottom` slot — a full-width row
 * just below the session footer:
 *
 *   ▓▓▓▓░░ 65% · 0h 11m                                  (one window)
 *   cld ▓▓▓▓░ 65% · 0h 11m  7d ▓░░░░ 19% · 1d 11h   oai ▓░░░░ 12% · 3h 4m
 *   ! cld ▓▓▓▓░ 65% · 0h 11m                             (anthropic incident)
 *
 * Providers:
 *   anthropic — Claude Pro/Max via the OAuth token in ~/.claude/.credentials.json
 *   openai    — ChatGPT Plus/Pro via the Codex CLI login in ~/.codex/auth.json
 *
 * When a provider's public status page reports an incident, a colored `!`
 * marker appears next to its prefix (red = major/critical, amber = minor,
 * cyan = maintenance). The usage bar itself is unaffected. Disable with
 * `show_status = false` under `[ui]`.
 *
 * Configured via ~/.config/opencode/usage-bar.toml (auto-created with
 * commented defaults on first run; read once at startup). Tokens/keys are
 * only ever sent to their own provider's API host.
 *
 * Loaded via tui.json, e.g.:
 *   { "plugin": ["@satas/opencode-usage-bar"] }      // published npm package
 *   { "plugin": ["/abs/path/to/src/index.tsx"] }     // local file (no build)
 */

const POLL_MS = 120_000
const FETCH_TIMEOUT_MS = 10_000
const CONFIG_FILE = 'usage-bar.toml'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which quota window a value belongs to; toggled per provider in config. */
type WindowCategory = '5h' | '7d' | 'model'

/** Provider health from the vendor's public status page (Statuspage schema). */
type StatusIndicator = 'none' | 'minor' | 'major' | 'critical' | 'maintenance'

type UsageWindow = {
  category: WindowCategory
  /** short display label, e.g. "5h", "7d", "Fable" */
  label: string
  /** 0–100 percent of the window used */
  percent: number
  /** epoch ms when the window resets */
  resetsAt: number
}

type ProviderId = 'anthropic' | 'openai'

type ProviderConfig = {
  enabled: boolean
  show: Record<WindowCategory, boolean>
  /** anthropic: path to .credentials.json */
  credentialsPath?: string
  /** openai: path to Codex auth.json */
  codexAuthPath?: string
}

type UsageBarConfig = {
  showBars: boolean
  showStatus: boolean
  barWidth?: number
  providers: Record<ProviderId, ProviderConfig>
}

type Provider = {
  id: ProviderId
  /** short prefix shown when multiple providers are visible */
  short: string
  /** vendor status page JSON endpoint (Statuspage `status.json`); optional */
  statusUrl?: string
  fetchUsage(cfg: ProviderConfig): Promise<UsageWindow[] | null>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandTilde(p: string) {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

function fmtDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  return `${hours}h ${minutes}m`
}

/** Decode a JWT's `exp` claim (unix seconds) without verifying. 0 on failure. */
function jwtExp(token: string): number {
  try {
    const payload = token.split('.')[1]
    if (!payload) return 0
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number
    }
    return typeof claims.exp === 'number' ? claims.exp : 0
  } catch {
    return 0
  }
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Fetch a vendor's overall status from its public Statuspage JSON endpoint.
 *  Returns the `indicator` ("none" when healthy), or `null` when the fetch
 *  itself failed — so a network blip never clears a known incident. */
async function fetchStatus(url: string): Promise<StatusIndicator | null> {
  const data = (await fetchJson(url, {})) as {
    status?: { indicator?: string }
  } | null
  if (!data?.status) return null
  const indicator = data.status.indicator
  return indicator === 'minor' ||
    indicator === 'major' ||
    indicator === 'critical' ||
    indicator === 'maintenance'
    ? indicator
    : 'none'
}

// ---------------------------------------------------------------------------
// opencode auth store (fallback credential source)
// ---------------------------------------------------------------------------

type OpencodeAuthEntry = {
  type?: string
  access?: string
  expires?: number // epoch ms; 0 = no expiry
  accountId?: string
}

/** Set from `api.state.path.state` at startup; default matches opencode's
 *  XDG data dir. */
let opencodeAuthFile = join(homedir(), '.local', 'share', 'opencode', 'auth.json')

/** Read a provider's entry from opencode's own auth store
 *  (`opencode auth login`). Returns null when missing/unreadable. */
async function opencodeAuth(...ids: string[]): Promise<OpencodeAuthEntry | null> {
  try {
    const auth = JSON.parse(await readFile(opencodeAuthFile, 'utf8')) as Record<
      string,
      OpencodeAuthEntry
    >
    for (const id of ids) {
      const entry = auth[id]
      if (entry) return entry
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Claude Pro/Max — Anthropic's OAuth usage endpoint (same one Claude Code's
 *  `/usage` uses). Token from ~/.claude/.credentials.json, falling back to
 *  opencode's own auth store; sent only to api.anthropic.com. */
const anthropicProvider: Provider = {
  id: 'anthropic',
  short: 'cld',
  statusUrl: 'https://status.anthropic.com/api/v2/status.json',
  async fetchUsage(cfg) {
    let token: string | undefined
    try {
      const path = expandTilde(
        cfg.credentialsPath ?? join(homedir(), '.claude', '.credentials.json'),
      )
      const creds = JSON.parse(await readFile(path, 'utf8')) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number }
      }
      const oauth = creds.claudeAiOauth
      if (oauth?.accessToken && !(oauth.expiresAt && Date.now() >= oauth.expiresAt))
        token = oauth.accessToken
    } catch {
      // fall through to opencode auth
    }
    if (!token) {
      const entry = await opencodeAuth('anthropic')
      if (entry?.access && !(entry.expires && Date.now() >= entry.expires)) token = entry.access
    }
    if (!token) return null

    const data = (await fetchJson('https://api.anthropic.com/api/oauth/usage', {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    })) as {
      limits?: Array<{
        kind?: string
        percent?: number
        resets_at?: string
        scope?: { model?: { display_name?: string | null } | null } | null
      }>
    } | null
    if (!data || !Array.isArray(data.limits)) return null

    const windows: UsageWindow[] = []
    for (const limit of data.limits) {
      if (!limit || typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) continue
      if (!limit.kind || !limit.resets_at) continue
      const resetsAt = Date.parse(limit.resets_at)
      if (Number.isNaN(resetsAt)) continue
      const category: WindowCategory =
        limit.kind === 'session' ? '5h' : limit.kind === 'weekly_all' ? '7d' : 'model'
      const label = category === 'model' ? (limit.scope?.model?.display_name ?? 'model') : category
      windows.push({ category, label, percent: limit.percent, resetsAt })
    }
    // Session window first, then the rest in API order.
    windows.sort((a, b) => Number(b.category === '5h') - Number(a.category === '5h'))
    return windows.length > 0 ? windows : null
  },
}

/** ChatGPT Plus/Pro (Codex) — reads the Codex CLI login and asks the wham
 *  usage endpoint. Read-only: never refreshes/rewrites auth.json; when the
 *  token is expired we simply hide (Codex CLI refreshes the file itself). */
const openaiProvider: Provider = {
  id: 'openai',
  short: 'oai',
  statusUrl: 'https://status.openai.com/api/v2/status.json',
  async fetchUsage(cfg) {
    let accessToken: string | undefined
    let accountId: string | undefined
    try {
      const path = expandTilde(cfg.codexAuthPath ?? join(homedir(), '.codex', 'auth.json'))
      const auth = JSON.parse(await readFile(path, 'utf8')) as {
        tokens?: { access_token?: string; id_token?: string; account_id?: string }
      }
      const tokens = auth.tokens
      // Check the expiry of the token we actually send (the access token);
      // the id_token expires much earlier and would cause false negatives.
      const exp = tokens?.access_token ? jwtExp(tokens.access_token) : 0
      if (tokens?.access_token && !(exp > 0 && exp * 1000 <= Date.now() + 60_000)) {
        accessToken = tokens.access_token
        accountId = tokens.account_id
      }
    } catch {
      // fall through to opencode auth
    }
    if (!accessToken) {
      const entry = await opencodeAuth('openai')
      if (entry?.access && !(entry.expires && Date.now() >= entry.expires)) {
        accessToken = entry.access
        accountId = entry.accountId
      }
    }
    if (!accessToken) return null

    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'codex-cli',
    }
    if (accountId) headers['chatgpt-account-id'] = accountId

    const data = (await fetchJson('https://chatgpt.com/backend-api/wham/usage', headers)) as {
      rate_limit?: {
        primary_window?: WhamWindow | null
        secondary_window?: WhamWindow | null
      }
    } | null
    if (!data?.rate_limit) return null

    // Classify by window duration when present (some accounts return the
    // weekly window as primary_window), falling back to position.
    const windows: UsageWindow[] = []
    const primary = parseWhamWindow(data.rate_limit.primary_window, '5h')
    if (primary) windows.push(primary)
    const secondary = parseWhamWindow(data.rate_limit.secondary_window, '7d')
    if (secondary) windows.push(secondary)
    windows.sort((a, b) => Number(b.category === '5h') - Number(a.category === '5h'))
    return windows.length > 0 ? windows : null
  },
}

type WhamWindow = {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
  reset_after_seconds?: number
}

function parseWhamWindow(
  w: WhamWindow | null | undefined,
  fallback: WindowCategory,
): UsageWindow | null {
  if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null
  let resetsAt: number | undefined
  if (typeof w.reset_at === 'number') resetsAt = w.reset_at * 1000
  else if (typeof w.reset_after_seconds === 'number')
    resetsAt = Date.now() + w.reset_after_seconds * 1000
  if (!resetsAt || !Number.isFinite(resetsAt)) return null
  const category: WindowCategory =
    typeof w.limit_window_seconds === 'number' && w.limit_window_seconds > 0
      ? w.limit_window_seconds <= 21_600 // ≤ 6h → session window
        ? '5h'
        : '7d'
      : fallback
  return { category, label: category, percent: w.used_percent, resetsAt }
}

const providers: Provider[] = [anthropicProvider, openaiProvider]

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_TOML = `# opencode-usage-bar configuration
# Read once at startup — restart opencode after editing.

[ui]
show_bars = true      # render ▓▓░░ mini-bars (false = text only)
show_status = true    # show a ! marker next to a provider during incidents
# bar_width = 6       # override bar width (default: 6 for a single window, 5 otherwise)

[anthropic]
enabled = true        # Claude Pro/Max via ~/.claude/.credentials.json
show_5h = true        # rolling 5-hour session window
show_7d = false       # weekly cap across all models
show_model = false    # per-model weekly windows (e.g. Fable)
# credentials_path = "~/.claude/.credentials.json"

[openai]
enabled = false       # ChatGPT Plus/Pro via the Codex CLI login
show_5h = true
show_7d = false
# codex_auth_path = "~/.codex/auth.json"
`

function defaultConfig(): UsageBarConfig {
  const show = (over: Partial<Record<WindowCategory, boolean>> = {}) => ({
    '5h': true,
    '7d': false,
    model: false,
    ...over,
  })
  return {
    showBars: true,
    showStatus: true,
    providers: {
      anthropic: { enabled: true, show: show() },
      openai: { enabled: false, show: show() },
    },
  }
}

type TomlTable = Record<string, unknown>

function asTable(v: unknown): TomlTable {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as TomlTable) : {}
}

function bool(v: unknown, fallback: boolean) {
  return typeof v === 'boolean' ? v : fallback
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function parseConfig(raw: string): UsageBarConfig {
  const toml = (globalThis as Record<string, any>).Bun?.TOML
  if (!toml?.parse) return defaultConfig()
  const root = asTable(toml.parse(raw))
  const cfg = defaultConfig()

  const ui = asTable(root['ui'])
  cfg.showBars = bool(ui['show_bars'], cfg.showBars)
  cfg.showStatus = bool(ui['show_status'], cfg.showStatus)
  const rawWidth = ui['bar_width']
  if (typeof rawWidth === 'number' && Number.isFinite(rawWidth) && rawWidth >= 1)
    cfg.barWidth = Math.min(40, Math.floor(rawWidth))

  for (const id of ['anthropic', 'openai'] as ProviderId[]) {
    const t = asTable(root[id])
    const p = cfg.providers[id]
    p.enabled = bool(t['enabled'], p.enabled)
    p.show['5h'] = bool(t['show_5h'], p.show['5h'])
    p.show['7d'] = bool(t['show_7d'], p.show['7d'])
    p.show.model = bool(t['show_model'], p.show.model)
    // Assign only when present — keeps `exactOptionalPropertyTypes` happy.
    const credentialsPath = str(t['credentials_path'])
    if (credentialsPath !== undefined) p.credentialsPath = credentialsPath
    const codexAuthPath = str(t['codex_auth_path'])
    if (codexAuthPath !== undefined) p.codexAuthPath = codexAuthPath
  }
  return cfg
}

/** Load `<config dir>/usage-bar.toml`, creating it with commented defaults on
 *  first run. Any failure falls back to defaults without touching an existing
 *  file. */
async function loadConfig(configPath: string | undefined): Promise<UsageBarConfig> {
  const dir =
    configPath && !configPath.endsWith('.json')
      ? configPath
      : configPath
        ? dirname(configPath)
        : join(homedir(), '.config', 'opencode')
  const file = join(dir, CONFIG_FILE)

  try {
    const raw = await readFile(file, 'utf8')
    try {
      return parseConfig(raw)
    } catch {
      return defaultConfig() // malformed TOML — keep the file, use defaults
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(file, DEFAULT_TOML, { flag: 'wx' })
      } catch {
        // ignore — config stays default in memory
      }
    }
    return defaultConfig()
  }
}

/** Vendored usage-bar plugin init: reads config, seeds the kv cache, starts
 *  the poll loop and registers the `app_bottom` slot. Skips everything (and
 *  registers nothing) when no provider is enabled — mirrors the standalone
 *  plugin's early return. */
async function setupUsageBar(api: TuiPluginApi) {
  const config = await loadConfig(api.state.path?.config)
  if (api.state.path?.state) opencodeAuthFile = join(api.state.path.state, 'auth.json')

  const enabled = providers.filter((p) => config.providers[p.id].enabled)
  if (enabled.length === 0) return // nothing to poll or render

  const seed: Record<string, UsageWindow[]> = {}
  for (const p of enabled) {
    const cached = api.kv.get<UsageWindow[] | undefined>(`usage-bar.${p.id}.windows`, undefined)
    if (cached) seed[p.id] = cached
  }
  const [byProvider, setByProvider] = createSignal<Record<string, UsageWindow[]>>(seed)
  // Status is deliberately not cached across restarts: incidents are
  // short-lived, and the first poll lands seconds after startup anyway.
  const [byStatus, setByStatus] = createSignal<Record<string, StatusIndicator>>({})
  const [now, setNow] = createSignal(Date.now())

  setInterval(() => setNow(Date.now()), 1_000)

  for (const p of enabled) {
    const cfg = config.providers[p.id]
    const poll = async () => {
      // Fetch usage and status concurrently; status pages are CDN-backed and
      // never throttle, so we poll them on the same cadence as usage.
      const statusP = config.showStatus && p.statusUrl ? fetchStatus(p.statusUrl) : null
      const [all, status] = await Promise.all([p.fetchUsage(cfg), statusP])
      if (all) {
        const windows = all.filter((w) => cfg.show[w.category] && w.resetsAt > Date.now())
        setByProvider((prev) => ({ ...prev, [p.id]: windows }))
        api.kv.set(`usage-bar.${p.id}.windows`, windows)
      }
      // `null` means the status fetch failed — keep the last known indicator.
      if (status !== null) setByStatus((prev) => ({ ...prev, [p.id]: status }))
      // Back off when the usage fetch failed (e.g. 429 — these endpoints throttle).
      setTimeout(poll, all ? POLL_MS : POLL_MS * 3)
    }
    void poll()
  }

  api.slots.register({
    order: 60,
    slots: {
      // `app_bottom` renders as a full-width row below the session footer.
      app_bottom() {
        const theme = () => api.theme.current

        type Group = { short: string; status: StatusIndicator; windows: UsageWindow[] }
        const groups = createMemo<Group[]>(() => {
          const map = byProvider()
          const statusMap = byStatus()
          const out: Group[] = []
          for (const p of enabled) {
            // Drop windows that have reset since the last poll.
            const windows = (map[p.id] ?? []).filter((w) => w.resetsAt > now())
            if (windows.length > 0)
              out.push({ short: p.short, status: statusMap[p.id] ?? 'none', windows })
          }
          return out
        })
        const totalWindows = createMemo(() =>
          groups().reduce((sum, g) => sum + g.windows.length, 0),
        )
        const barWidth = createMemo(() => config.barWidth ?? (totalWindows() === 1 ? 6 : 5))
        const multiProvider = createMemo(() => groups().length >= 2)

        const pctOf = (w: UsageWindow) => Math.min(100, Math.max(0, Math.round(w.percent)))
        const filledOf = (w: UsageWindow) =>
          Math.min(barWidth(), Math.max(0, Math.round((pctOf(w) / 100) * barWidth())))
        const colorOf = (w: UsageWindow) => {
          const t = theme()
          const pct = pctOf(w)
          if (pct > 85) return t.error
          if (pct >= 50) return t.warning
          return t.success
        }
        // Status marker color: red for severe incidents, amber for minor,
        // cyan for scheduled maintenance.
        const statusColor = (s: StatusIndicator) => {
          const t = theme()
          if (s === 'critical' || s === 'major') return t.error
          if (s === 'minor') return t.warning
          return t.info
        }

        return (
          <Show when={groups().length > 0}>
            <box flexDirection="row" gap={3} alignItems="center" width="100%" paddingLeft={1}>
              <For each={groups()}>
                {(g) => (
                  <box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
                    <Show when={config.showStatus && g.status !== 'none'}>
                      <text fg={statusColor(g.status)}>!</text>
                    </Show>
                    <Show when={multiProvider()}>
                      <text fg={theme().textMuted}>{g.short}</text>
                    </Show>
                    <For each={g.windows}>
                      {(w) => (
                        <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                          <Show when={g.windows.length >= 2}>
                            <text fg={theme().textMuted}>{w.label}</text>
                          </Show>
                          <Show when={config.showBars}>
                            <box flexDirection="row">
                              <text fg={colorOf(w)}>{'▓'.repeat(filledOf(w))}</text>
                              <text fg={theme().textMuted}>
                                {'░'.repeat(barWidth() - filledOf(w))}
                              </text>
                            </box>
                          </Show>
                          <text fg={theme().text}>{pctOf(w)}%</text>
                          <text
                            fg={theme().textMuted}
                          >{`· ${fmtDuration(w.resetsAt - now())}`}</text>
                        </box>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </box>
          </Show>
        )
      },
    },
  })
}

/* ─── Session Row (single session with live status indicator) ─ */

function SessionRow(props: { api: TuiPluginApi; session: any }) {
  const theme = () => props.api.theme.current

  const status = createMemo(() => {
    try {
      const s = (props.api.state as any).session?.status?.(props.session.id)
      if (s?.type) return s.type as string
    } catch {
      /* ignore */
    }
    return null
  })

  const statusIcon = createMemo(() => {
    switch (status()) {
      case 'busy':
        return '\u25cf ' // ● — running
      case 'retry':
        return '\u26a0 ' // ⚠ — needs attention
      default:
        return '' // idle/unknown — no icon
    }
  })

  return (
    <text fg={theme().textMuted}>
      {`${statusIcon()}${props.session?.id?.slice(0, 8) ?? '????'}... ${props.session?.title?.slice(0, 26) ?? '(untitled)'}`}
    </text>
  )
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

  // ── Sessions: fetch via api.client.session.list (not proc.exec) ──
  const [sessionList, { refetch: refetchSessions }] = createResource(async () => {
    try {
      const result = await (props.api.client as any)?.session?.list?.({ limit: 100 })
      return result ?? { data: [] }
    } catch {
      return { data: [] }
    }
  })

  // Total top-level sessions (excludes subagent sessions)
  const totalSessions = createMemo(() => {
    const result = sessionList()
    if (!result) return 0
    const data: any[] = (result as any).data ?? result
    if (!Array.isArray(data)) return 0
    return data.filter((s: any) => !s.parentID).length
  })

  // Recent top-level sessions, sorted by time.updated descending
  const recentSessions = createMemo(() => {
    const result = sessionList()
    if (!result) return []
    const data: any[] = (result as any).data ?? result
    if (!Array.isArray(data)) return []
    return data
      .filter((s: any) => !s.parentID && s.id !== props.sessionID)
      .sort((a: any, b: any) => {
        const ta = a.time?.updated ?? a.updated ?? 0
        const tb = b.time?.updated ?? b.updated ?? 0
        return tb - ta
      })
      .slice(0, 8)
  })

  // ── Memory: starts at null (= "N/A"), tracks via events ──
  const [memoryCount, setMemoryCount] = createSignal<number | null>(null)

  // ── Event subscriptions for live session/memory updates ──
  onMount(() => {
    const cleanup: (() => void)[] = []

    // Session events — triggers resource refetch
    try {
      cleanup.push(props.api.event.on('session.status', refetchSessions))
      cleanup.push(props.api.event.on('session.created', refetchSessions))
      cleanup.push(props.api.event.on('session.updated', refetchSessions))
      cleanup.push(props.api.event.on('session.deleted', refetchSessions))
    } catch {
      /* events API not available in this runtime */
    }

    // Memory events — tracks running counter (no api.state.memory)
    try {
      const ev = props.api.event as any
      if (typeof ev?.on === 'function') {
        cleanup.push(ev.on('memory.created', () => setMemoryCount((c) => (c !== null ? c + 1 : 1))))
        cleanup.push(
          ev.on('memory.deleted', () =>
            setMemoryCount((c) => (c !== null ? Math.max(0, c - 1) : 0)),
          ),
        )
      }
    } catch {
      /* memory events not available */
    }

    onCleanup(() =>
      cleanup.forEach((fn) => {
        fn()
      }),
    )
  })

  // ── Config summary ──
  const configSummary = createMemo(() => {
    const cfg = (props.api.state as any).config
    if (!cfg) return null
    return {
      mcpCount: cfg.mcp ? Object.keys(cfg.mcp).length : 0,
      pluginCount: Array.isArray(cfg.plugin) ? cfg.plugin.length : 0,
      autoCompaction: cfg.compaction?.auto === true,
    }
  })

  const HR = () => <text fg={theme().textMuted}>{'\u2500'.repeat(28)}</text>

  return (
    <box flexDirection="column" width="100%">
      {/* ── Header ── */}
      <text fg={theme().accent} attributes={1}>
        {`Pantheon${props.version ? ` v${props.version}` : ''}`}
      </text>
      <Show when={branch()}>{(b) => <text fg={theme().textMuted}>{b()}</text>}</Show>

      <HR />

      {/* ── Sessions ── */}
      <box onMouseDown={() => setShowSessions((x) => !x)}>
        <text fg={theme().text} attributes={1}>
          {`${showSessions() ? '\u25bc' : '\u25b6'} Sessions`}
        </text>
        <text fg={theme().textMuted}>{` (${String(totalSessions())})`}</text>
      </box>
      <Show when={showSessions()}>
        <Show
          when={recentSessions().length > 0}
          fallback={
            <box marginLeft={1}>
              <text fg={theme().textMuted}>No recent sessions</text>
            </box>
          }
        >
          <box marginLeft={1} flexDirection="column">
            <For each={recentSessions()}>
              {(ses: any) => <SessionRow api={props.api} session={ses} />}
            </For>
          </box>
        </Show>
      </Show>

      {/* ── Commands ── */}
      <box onMouseDown={() => setShowCommands((x) => !x)}>
        <text fg={theme().text} attributes={1}>
          {`${showCommands() ? '\u25bc' : '\u25b6'} Commands`}
        </text>
        <text fg={theme().textMuted}>{` (${String(COMMANDS.length)})`}</text>
      </box>
      <Show when={showCommands()}>
        <box marginLeft={1} flexDirection="column">
          <For each={COMMANDS}>
            {(cmd) => (
              <box
                onMouseDown={(e) => {
                  e.stopPropagation()
                  try {
                    const cmdApi = (props.api as any).command
                    const cmdName = cmd.name.replace('/', '')
                    if (cmdApi?.trigger?.(cmdName)) return
                  } catch {
                    /* fall through to toast */
                  }
                  props.api.ui?.toast?.({ title: 'Command', message: `Type ${cmd.name} in chat` })
                }}
              >
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
        <text fg={theme().text} attributes={1}>
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
        <text fg={theme().text} attributes={1}>
          {`${showConfig() ? '\u25bc' : '\u25b6'} Config`}
        </text>
      </box>
      <Show when={showConfig()}>
        <Show
          when={configSummary()}
          fallback={
            <box marginLeft={1}>
              <text fg={theme().textMuted}>No config data</text>
            </box>
          }
        >
          {(cfg) => (
            <box marginLeft={1} flexDirection="column">
              <text
                fg={theme().textMuted}
              >{`MCP: ${String(cfg().mcpCount)}  Plugins: ${String(cfg().pluginCount)}`}</text>
              <text
                fg={theme().textMuted}
              >{`Auto-compaction: ${cfg().autoCompaction ? 'ON' : 'OFF'}`}</text>
            </box>
          )}
        </Show>
      </Show>

      {/* ── Memory (always visible summary) ── */}
      <box marginTop={1}>
        <text fg={theme().textMuted}>
          {memoryCount() !== null ? `Memory: ${fmtInt(memoryCount()!)} entries` : 'Memory: N/A'}
        </text>
      </box>
    </box>
  )
}

/* ─── Plugin Registration ────────────────────────────────── */

const tui: TuiPlugin = async (api, _options, _meta) => {
  const version = await detectVersion(api)

  // Vendored features (MIT): todo progress bar + usage gauges.
  setupTodoProgress(api)
  void setupUsageBar(api) // async init — never blocks sidebar registration

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
