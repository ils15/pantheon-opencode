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
 *     branch, Sessions, real-time Delegations panel).
 *   - app_bottom             (order 60)  — AI subscription usage gauges
 *     (Anthropic/OpenAI quotas, OpenCode Go/Zen dollar limits + provider
 *     status incidents).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VENDORED FEATURES (MIT) — incorporated with their license headers preserved:
 *
 *   • satas20/opencode-usage-bar (MIT)
 *       https://github.com/satas20/opencode-usage-bar
 *
 *   v1.2.0 added an OpenCode Go/Zen usage provider (`opencodego`) on top of
 *   the vendored base — dollar-denominated rolling limits ($12/5h, $30/7d,
 *   $60/month) via the same key used for inference. Still MIT-credited to
 *   satas20 for the original bar/config/poll code.
 *
 * satas20/opencode-todo-progress was vendored in v1.1.0 alongside the
 * usage-bar but has since been REMOVED as redundant — the native session
 * footer already surfaces todo/context state, so its todo bar slot was
 * dropped entirely. Only usage-bar code remains.
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
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'

/* ─── Constants ─────────────────────────────────────────── */

/** How often the sidebar re-reads .pantheon/active-preset.json so `set-tier`
 *  changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 30_000

/* ─── Helpers ───────────────────────────────────────────── */

/* ─── Active Preset Detection ──────────────────────────────
 * Inline replica of src/pantheon/presets.mjs resolveActivePreset() — the TUI
 * plugin is self-contained (dist/tui.tsx is a raw copy of this file with no
 * relative imports), so the resolution logic is mirrored here rather than
 * importing presets.mjs.
 *
 * Priority: env PANTHEON_MODEL_PRESET > first existing candidate file > none.
 * Custom/unknown preset names are shown as-is (a preset may be defined that
 * is not in the built-in list). "none" disables → default.                */

type PresetInfo = { name: string | null; source: 'env' | 'file' | null }

/** Read .pantheon/active-preset.json — mirrors the presets.mjs file leg:
 *  first existing candidate wins; malformed JSON or a `preset` that is
 *  missing, empty or "none" → null (no fall-through to lower candidates). */
async function readActivePresetFile(cwd: string): Promise<{ name: string; source: 'file' } | null> {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const candidates = [
    join(cwd, '.pantheon', 'active-preset.json'),
    join(xdgConfig, 'opencode', '.pantheon', 'active-preset.json'),
    join(homedir(), '.opencode', '.pantheon', 'active-preset.json'),
  ]
  for (const candidate of candidates) {
    let raw: string
    try {
      raw = await readFile(candidate, 'utf8')
    } catch {
      continue // candidate does not exist — try the next one
    }
    try {
      const parsed = JSON.parse(raw) as { preset?: unknown }
      const name = parsed && typeof parsed === 'object' ? parsed.preset : undefined
      if (typeof name !== 'string' || name.length === 0 || name === 'none') return null
      return { name, source: 'file' }
    } catch {
      return null // malformed file — treat as default (mirrors presets.mjs)
    }
  }
  return null
}

/** Env leg of resolution: PANTHEON_MODEL_PRESET set and !== 'none' wins. */
function presetFromEnv(env: Record<string, string | undefined>): PresetInfo {
  const name = env.PANTHEON_MODEL_PRESET
  if (name !== undefined && name !== '' && name !== 'none') {
    return { name, source: 'env' }
  }
  return { name: null, source: null }
}

/** Resolve the active preset for the sidebar: env > file > default. */
async function resolvePresetForTui(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<PresetInfo> {
  const envPreset = presetFromEnv(env)
  if (envPreset.source === 'env') return envPreset
  return (await readActivePresetFile(cwd)) ?? { name: null, source: null }
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
  // Try 0: package.json do PACOTE PANTHEON instalado. O TUI é carregado de
  // <pacote>/src/plugins/tui/dist/tui.tsx (fix #32 garante esse path) →
  // 4 níveis acima (dist → tui → plugins → src → raiz) está o package.json
  // do pacote. Funciona em QUALQUER cwd (ex: sandbox sem package.json/git) e
  // também em dev (source no repo). Se falhar, cai para os tries abaixo.
  try {
    const pkgUrl = new URL('../../../../package.json', import.meta.url)
    const pkgContent = await readFile(fileURLToPath(pkgUrl), 'utf8')
    const match = pkgContent.match(/"version":\s*"([^"]+)"/)
    if (match?.[1]) return match[1]
  } catch {
    /* fall through */
  }

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
      if (tag) return tag
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
 *   opencodego— OpenCode Go/Zen dollar limits ($12/5h, $30/7d, $60/mo) via
 *               PANTHEON_OPENCODE_API_KEY (fallback OPENCODE_API_KEY). No
 *               status page — the provider hides silently when unconfigured
 *               or when the (not yet public) usage endpoint is unavailable.
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
type WindowCategory = '5h' | '7d' | '1m' | 'model'

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

type ProviderId = 'anthropic' | 'openai' | 'opencodego'

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

/** OpenCode Go/Zen — dollar-denominated rolling usage limits ($12 / 5h,
 *  $30 / 7d, $60 / subscription month). Token is the same key used for
 *  inference: PANTHEON_OPENCODE_API_KEY, falling back to OPENCODE_API_KEY.
 *  It is only ever sent in the Authorization header to opencode.ai — never
 *  logged or written to disk. The usage endpoint (opencode.ai/zen/go/v1/
 *  usage) is not yet part of the public docs, so any non-ok response
 *  (404/401/403/500) hides the provider silently instead of erroring out. */
const opencodeGoProvider: Provider = {
  id: 'opencodego',
  short: 'go',
  // No statusUrl — opencode.ai has no verified public status page to poll.
  async fetchUsage(_cfg) {
    const token = process.env.PANTHEON_OPENCODE_API_KEY ?? process.env.OPENCODE_API_KEY
    if (!token) return null

    const data = (await fetchJson('https://opencode.ai/zen/go/v1/usage', {
      authorization: `Bearer ${token}`,
    })) as {
      rolling5h?: GoUsageWindow
      weekly?: GoUsageWindow
      monthly?: GoUsageWindow
    } | null
    if (!data) return null

    const windows: UsageWindow[] = []
    // Mirror the defensive parsing used by the other providers: a window
    // missing its percent or reset time is skipped rather than rendered.
    const push = (w: GoUsageWindow | undefined, category: '5h' | '7d' | '1m') => {
      if (!w) return
      if (typeof w.usagePercent !== 'number' || !Number.isFinite(w.usagePercent)) return
      if (typeof w.resetInSec !== 'number' || !Number.isFinite(w.resetInSec)) return
      windows.push({
        category,
        label: category,
        percent: Math.round(w.usagePercent),
        resetsAt: Date.now() + w.resetInSec * 1000,
      })
    }
    push(data.rolling5h, '5h')
    push(data.weekly, '7d')
    push(data.monthly, '1m')
    return windows.length > 0 ? windows : null
  },
}

type GoUsageWindow = {
  usageDollars?: number
  limitDollars?: number
  usagePercent?: number
  resetInSec?: number
}

const providers: Provider[] = [anthropicProvider, openaiProvider, opencodeGoProvider]

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

[opencodego]
enabled = true        # OpenCode Go/Zen dollar usage via PANTHEON_OPENCODE_API_KEY
show_5h = true        # rolling 5-hour window ($12)
show_7d = true        # rolling 7-day window ($30)
show_1m = false       # subscription-month window ($60) — opt-in
# Falls back to OPENCODE_API_KEY when PANTHEON_OPENCODE_API_KEY is unset.
`

function defaultConfig(): UsageBarConfig {
  const show = (over: Partial<Record<WindowCategory, boolean>> = {}) => ({
    '5h': true,
    '7d': false,
    '1m': false,
    model: false,
    ...over,
  })
  return {
    showBars: true,
    showStatus: true,
    providers: {
      anthropic: { enabled: true, show: show() },
      openai: { enabled: false, show: show() },
      // 5h+7d on by default; monthly window opt-in; model never for Go.
      opencodego: { enabled: true, show: show({ '7d': true }) },
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

  for (const id of ['anthropic', 'openai', 'opencodego'] as ProviderId[]) {
    const t = asTable(root[id])
    const p = cfg.providers[id]
    p.enabled = bool(t['enabled'], p.enabled)
    p.show['5h'] = bool(t['show_5h'], p.show['5h'])
    p.show['7d'] = bool(t['show_7d'], p.show['7d'])
    p.show['1m'] = bool(t['show_1m'], p.show['1m'])
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

/* ─── Delegations (real-time panel) ────────────────────────
 * CHILDREN + MD (delegations-sidebar pattern, feat/compaction-134):
 *
 *   1. PRIMARY — SDK child sessions via `api.client.session.children`:
 *      every pantheon_delegate creates a child session with
 *      parentID = caller (src/pantheon/delegation.ts session.create), so
 *      the children of the current session ARE the delegation list — the
 *      same mechanism the opencode-delegations-sidebar reference uses
 *      (`client.session.children` + `session.parentID === current`).
 *      Live status comes from `api.state.session.status(childID)`
 *      (busy/retry → running; idle → terminal). This does NOT depend on
 *      tool-part events, which runtime 1.18.13 may not deliver for
 *      pantheon_delegate (the "(0) even while delegating" symptom).
 *
 *   2. ENRICHMENT — markdown reports the job board persists under
 *      `.pantheon/delegations/<sessionID>/<alias>.md` (written by
 *      src/pantheon/delegation-finalize.ts at terminal state). Each child
 *      is matched to its report by the `Task ID` header (== child session
 *      id == board task id), which supplies the alias (apo-N), agent,
 *      description and terminal duration/timedOut. No report → the child
 *      itself still renders (title as description, derived state).
 *
 *   3. REFRESH — session.created/updated/deleted/status events and
 *      message.part.updated/removed (via liveStore.version bumps) re-fetch
 *      children; a 1s safety poll (oh-my-opencode-slim pattern) re-fetches
 *      children + re-reads the md so the panel updates EVEN without events.
 *
 *   4. DIAGNOSTICS — every re-fetch logs "panel: children=N md=N events=N"
 *      to `.pantheon/logs/hooks.log` (silence-by-default, createPantheonLogger
 *      policy) so the (0) symptom is diagnosable from disk. A children fetch
 *      failure logs "panel: error <msg>" (previously silenced), and a missing
 *      current session (null/placeholder sessionID) logs "panel: children=0
 *      ... (no sessionID — fetch skipped)" instead of erroring.
 *
 *   5. SESSIONID GUARD (placeholder regression) — the runtime may hand the
 *      sidebar the UNSUBSTITUTED template literal "{sessionID}" as its
 *      session_id (no focused session). Forwarding it to session.children
 *      made opencode's server reject every poll (~1 err/s: "Expected a string
 *      starting with \"ses\", got \"%7BsessionID%7D\"") and fail-open the
 *      panel into "(0)". resolveCurrentSessionID (slot prop → api.state →
 *      route.current) never yields a placeholder; a null resolution SKIPS the
 *      children fetch entirely — empty panel, zero errors.
 *
 * The live tool-part lifecycle helpers below remain (tested, exported) but
 * are no longer the source of truth: they feed a version signal that merely
 * re-triggers the children fetch. Everything is fail-open: a missing
 * children API or directory yields [], and any unreadable input is skipped —
 * never crash. */

export type DelegationEntry = {
  /** Job alias, e.g. "apo-1" (from the H1 title, falling back to filename). */
  alias: string
  /** Parent session the job was launched from (dir name under .pantheon/delegations). */
  sessionID: string
  /** Child session id (= board task id, from the `Task ID` header). The
   *  children channel always sets it from the child session itself; the md
   *  channel parses it so child↔md matching works by taskID. */
  taskID?: string
  /** Agent name, e.g. "apollo". */
  agent: string
  state: 'running' | 'completed' | 'error' | 'cancelled'
  /** Epoch ms of the `Started` header. */
  startedAt: number
  /** Epoch ms of the `Finalized` header — null while still running. */
  updatedAt: number | null
  timedOut: boolean
  description: string
  /** True while the panel is waiting for pantheon_delegation_read. */
  read?: boolean
  /** Internal provenance used to keep a finalized md report authoritative. */
  source?: 'child' | 'live' | 'md'
}

/** True for `\s` characters (space, tab, newline, CR) — plain char checks so
 *  the parser stays regex-free (CodeQL flagged the old `\s*`/`\s+` + `(.+)`
 *  patterns as polynomial ReDoS: 12x HIGH). */
function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/** Em/en dash + hyphen — the separators accepted after the H1 title. */
const TITLE_SEPARATORS = '—–-'

/** Parse one delegation report md header into a structured entry.
 *  Returns null (skip) when the file is not a recognizable report:
 *  missing agent/state/startedAt, an unknown state, or an unparsable
 *  Started timestamp. The alias falls back to the file name when the H1
 *  title is missing. Pure — no I/O.
 *
 *  Linear, single-pass over `raw.split('\n')` with plain string operations
 *  (startsWith/indexOf/slice) — zero regex, so worst case is O(bytes) even
 *  on adversarial whitespace-heavy input (ReDoS regression, CodeQL 12x HIGH). */
export function parseDelegationMarkdown(
  raw: string,
  fileAlias?: string,
  sessionID = '',
): DelegationEntry | null {
  let title: string | undefined
  let agent: string | undefined
  let description = ''
  let state: string | undefined
  let timedOut = false
  let started: string | undefined
  let finalized: string | undefined
  let taskID: string | undefined

  for (const rawLine of raw.split('\n')) {
    // H1 title: `# Delegation Report — <alias>` (empty alias → fallback later).
    if (rawLine[0] === '#' && isWs(rawLine[1])) {
      let i = 2
      while (i < rawLine.length && isWs(rawLine[i])) i++
      if (rawLine.startsWith('Delegation Report', i)) {
        i += 'Delegation Report'.length
        while (i < rawLine.length && isWs(rawLine[i])) i++
        if (i < rawLine.length && TITLE_SEPARATORS.includes(rawLine[i])) {
          const rest = rawLine.slice(i + 1).trim()
          if (rest !== '' && title === undefined) title = rest
        }
      }
      continue
    }
    // Field bullets: `- **Name**: value` — unknown names are ignored.
    if (rawLine[0] !== '-') continue
    let i = 1
    while (i < rawLine.length && isWs(rawLine[i])) i++
    if (!rawLine.startsWith('**', i)) continue
    const nameStart = i + 2
    const valueEnd = rawLine.indexOf('**:', nameStart)
    if (valueEnd < 0) continue
    const name = rawLine.slice(nameStart, valueEnd)
    const value = rawLine.slice(valueEnd + 3).trim()
    switch (name) {
      case 'Task ID':
        // `- **Task ID**: \`ses_x\`` — strip the surrounding backticks.
        if (value !== '' && taskID === undefined) taskID = stripTaskIdTicks(value)
        break
      case 'Agent':
        // Empty value counts as missing (old regex `(.+)` required 1+ chars).
        if (value !== '' && agent === undefined) agent = value
        break
      case 'Description':
        description = value
        break
      case 'State':
        if (value !== '' && state === undefined) state = value
        break
      case 'Timed out':
        // Old `(true|false)` prefix match, case-sensitive — kept verbatim.
        timedOut = value.startsWith('true')
        break
      case 'Started':
        if (value !== '' && started === undefined) started = value
        break
      case 'Finalized':
        finalized = value
        break
      default:
        break // unknown field (e.g. Task ID) → ignore the line
    }
  }

  const startedAt = started !== undefined ? Date.parse(started) : NaN
  if (agent === undefined || state === undefined || Number.isNaN(startedAt)) return null
  const normalized = state.toLowerCase()
  if (
    normalized !== 'running' &&
    normalized !== 'completed' &&
    normalized !== 'error' &&
    normalized !== 'cancelled'
  ) {
    return null
  }
  const finalizedAt = finalized !== undefined ? Date.parse(finalized) : NaN

  return {
    alias: title ?? (fileAlias !== undefined ? stripMdSuffix(fileAlias) : 'unknown'),
    sessionID,
    ...(taskID !== undefined ? { taskID } : {}),
    agent,
    state: normalized,
    startedAt,
    updatedAt: Number.isNaN(finalizedAt) ? null : finalizedAt,
    timedOut,
    description,
    source: 'md',
  }
}

/** Strip a trailing `.md` (any case) — linear replacement for /\.md$/i. */
function stripMdSuffix(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, name.length - 3) : name
}

/** Strip surrounding backticks from a `Task ID` value: "`ses_x`" → "ses_x". */
function stripTaskIdTicks(value: string): string {
  const start = value[0] === '`' ? 1 : 0
  const end =
    value.length > start && value[value.length - 1] === '`' ? value.length - 1 : value.length
  return value.slice(start, end)
}

/** Read every delegation report under `<dir>/<sessionID>/<alias>.md`.
 *  Fail-open: a missing/unreadable directory yields [], and each unreadable
 *  or malformed file is skipped individually. Entries are sorted running
 *  first, then terminal by `updatedAt` (most recent first) so the panel can
 *  render them in order directly. */
export async function readDelegationEntries(dir: string): Promise<DelegationEntry[]> {
  let sessionDirs: Dirent[]
  try {
    sessionDirs = await readdir(dir, { withFileTypes: true })
  } catch {
    return [] // directory absent/unreadable — nothing to show
  }

  const entries: DelegationEntry[] = []
  for (const session of sessionDirs) {
    if (!session.isDirectory()) continue
    let files: Dirent[]
    try {
      files = await readdir(join(dir, session.name), { withFileTypes: true })
    } catch {
      continue // unreadable session dir — skip
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue
      try {
        const raw = await readFile(join(dir, session.name, file.name), 'utf8')
        const entry = parseDelegationMarkdown(raw, file.name, session.name)
        if (entry !== null) entries.push(entry)
      } catch {
        // unreadable/malformed file — skip, never crash
      }
    }
  }

  entries.sort(compareDelegationEntries)
  return entries
}

/** Resolve the directory where the job board writes delegation md reports.
 *  The board writes `.pantheon/delegations` RELATIVE to the server cwd,
 *  which the TUI exposes as `TuiState.path.directory`. `project` does NOT
 *  exist on `TuiState.path` (the old `state?.project ?? state?.worktree`
 *  resolution was always undefined for the first term) and `worktree` is
 *  `/` when there is no git (e.g. the sandbox test project) — a root of
 *  `''` or `'/'` must fall back to `process.cwd()`. */
export function resolveDelegationsDir(
  state: { directory?: string; worktree?: string } | undefined,
  cwd = process.cwd(),
): string {
  const root = state?.directory ?? state?.worktree ?? ''
  if (root === '' || root === '/') return join(cwd, '.pantheon', 'delegations')
  return join(root, '.pantheon', 'delegations')
}

/** Sort delegations: running first, then terminal by recency (updatedAt,
 *  falling back to startedAt, descending). Shared by the md reader and
 *  mergeDelegationSources. */
export function compareDelegationEntries(a: DelegationEntry, b: DelegationEntry): number {
  const aRun = a.state === 'running' ? 1 : 0
  const bRun = b.state === 'running' ? 1 : 0
  if (aRun !== bRun) return bRun - aRun
  return (b.updatedAt ?? b.startedAt) - (a.updatedAt ?? a.startedAt)
}

/** Compact elapsed-time label: "5m 12s", "1h 30m", "2d 4h" — ticks every
 *  second for running jobs. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Elapsed label for one entry: running → ticks `now - startedAt`, terminal
 *  → fixed `updatedAt - startedAt` (em dash when no finalized timestamp). */
export function delegationElapsed(entry: DelegationEntry, now: number): string {
  if (entry.state === 'running') return fmtElapsed(now - entry.startedAt)
  return entry.updatedAt !== null ? fmtElapsed(entry.updatedAt - entry.startedAt) : '\u2014'
}

/** The activity labels shown by the animated row. Keeping this pure makes the
 * state machine testable without booting OpenCode's renderer. */
export type DelegationActivity =
  | 'delegating'
  | 'working'
  | 'reading'
  | 'completed'
  | 'error'
  | 'cancelled'

export function delegationActivity(entry: DelegationEntry): DelegationActivity {
  if (entry.state === 'completed') return 'completed'
  if (entry.state === 'error') return 'error'
  if (entry.state === 'cancelled') return 'cancelled'
  if (entry.read) return 'reading'
  if (entry.alias.startsWith('live-') && entry.taskID === undefined) return 'delegating'
  return 'working'
}

export function delegationActivityLabel(entry: DelegationEntry): string {
  switch (delegationActivity(entry)) {
    case 'delegating':
      return 'DELEGATING'
    case 'working':
      return 'WORKING'
    case 'reading':
      return 'READING RESULT'
    case 'completed':
      return entry.timedOut ? 'DONE (TIMED OUT)' : 'DONE'
    case 'error':
      return 'ERROR'
    default:
      return 'CANCELLED'
  }
}

const DELEGATION_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Return a deterministic spinner frame. The View ticks this every 140ms. */
export function delegationSpinnerFrame(now: number): string {
  const index = Math.floor(Math.max(0, now) / 140) % DELEGATION_SPINNER_FRAMES.length
  return DELEGATION_SPINNER_FRAMES[index] ?? DELEGATION_SPINNER_FRAMES[0]
}

/** Merge the immediate tool-event channel into the child-session channel.
 *
 * Children remain the durable source, while live entries make a delegation
 * visible before the child API/report catches up. A finalized md entry wins
 * over a stale live entry; a child-only row is upgraded with live agent,
 * alias, phase and timestamps. */
export function mergeChildDelegationSources(
  children: readonly DelegationEntry[],
  live: readonly LiveDelegationEntry[],
): DelegationEntry[] {
  const result = [...children]
  const byTask = new Map<string, number>()
  const bySessionAlias = new Map<string, number>()
  const key = (sessionID: string, alias: string): string => `${sessionID}\u0000${alias}`

  result.forEach((entry, index) => {
    if (entry.taskID !== undefined) byTask.set(entry.taskID, index)
    bySessionAlias.set(key(entry.sessionID, entry.alias), index)
  })

  for (const liveEntry of live) {
    const incoming = toDelegationEntry(liveEntry)
    const index =
      (incoming.taskID !== undefined ? byTask.get(incoming.taskID) : undefined) ??
      (incoming.alias !== ''
        ? bySessionAlias.get(key(incoming.sessionID, incoming.alias))
        : undefined)

    if (index === undefined) {
      result.push(incoming)
      const newIndex = result.length - 1
      if (incoming.taskID !== undefined) byTask.set(incoming.taskID, newIndex)
      bySessionAlias.set(key(incoming.sessionID, incoming.alias), newIndex)
      continue
    }

    const existing = result[index]
    if (existing === undefined) continue
    const finalized = existing.source === 'md' && existing.state !== 'running'
    if (finalized) continue
    result[index] = {
      ...existing,
      alias: liveEntry.alias !== null ? incoming.alias : existing.alias,
      sessionID: existing.sessionID || incoming.sessionID,
      taskID: existing.taskID ?? incoming.taskID,
      agent: incoming.agent !== 'agent' ? incoming.agent : existing.agent,
      description: incoming.description !== '' ? incoming.description : existing.description,
      state: incoming.state,
      startedAt: Math.min(existing.startedAt, incoming.startedAt),
      updatedAt: incoming.updatedAt,
      read: incoming.read,
      source: 'live',
    }
  }

  result.sort(compareDelegationEntries)
  return result
}

/* ─── Live tool-call lifecycle (agent-sidebar pattern) ─────
 * Source of truth for jobs born while opencode is open. The TUI event bus
 * (api.event.on) delivers `message.part.updated` for every part change;
 * we only care about tool parts whose `tool` is pantheon_delegate (job
 * launch) or pantheon_delegation_read (blocking until terminal → closes
 * the entry). Shape-adapted from the SDK v2 ToolPart but duck-typed so the
 * pure helpers are testable without the SDK. */

/** Duck-typed subset of a tool part (SDK v2 `ToolPart` / `ToolState`). */
export type DelegationToolPart = {
  id?: string
  callID?: string
  sessionID?: string
  type?: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    time?: { start?: number; end?: number }
  }
}

/** One live delegation tracked in-memory, keyed by the delegate callID. */
export type LiveDelegationEntry = {
  /** Tool call id of the pantheon_delegate part (stable across events). */
  callID: string
  /** Part id (for message.part.removed cleanup). */
  partID: string
  /** Parent session the delegation was launched from. */
  sessionID: string
  tool: 'pantheon_delegate' | 'pantheon_delegation_read'
  /** Agent name (from the delegate input args). */
  agent: string
  description: string
  /** Known after the delegate tool completes (parsed from its output). */
  alias: string | null
  /** Child session id (parsed from the delegate output). */
  taskID: string | null
  state: 'running' | 'completed' | 'error' | 'cancelled'
  startedAt: number
  updatedAt: number | null
  /** True once a pantheon_delegation_read for this job has been observed. */
  read: boolean
}

/** Result of parsing one tool part into lifecycle-relevant fields. */
export type ParsedDelegationToolPart = {
  callID: string
  partID: string
  sessionID: string
  tool: 'pantheon_delegate' | 'pantheon_delegation_read'
  /** null for read parts (no agent arg — the id targets an existing job). */
  agent: string | null
  description: string
  status: 'pending' | 'running' | 'completed' | 'error'
  alias: string | null
  taskID: string | null
  startedAt: number
  endAt: number | null
}

/** Alias in the delegate output: "Delegated to apollo: [apo-1] (task …)". */
const DELEGATE_ALIAS_PATTERN = /\[([a-z]{2,8}-\d+)\]/i
/** Child task id in the delegate output: "(task ses_child_9)". */
const DELEGATE_TASKID_PATTERN = /\(task\s+([a-z0-9_]+)\)/i
/** Plain alias, as passed to pantheon_delegation_read input.id: "apo-1". */
const READ_ALIAS_PATTERN = /^[a-z]{2,8}-\d+$/i

/** Extract the tool name + args from a `message.part.updated` part and
 *  reduce it to what the panel needs. Returns null for anything that is
 *  not a pantheon delegation tool part (or is missing its callID). */
export function parseDelegationToolPart(
  part: DelegationToolPart,
  now = Date.now(),
): ParsedDelegationToolPart | null {
  if (part.type !== 'tool') return null
  if (part.tool !== 'pantheon_delegate' && part.tool !== 'pantheon_delegation_read') return null
  const callID = part.callID
  if (callID === undefined || callID === '') return null
  const sessionID = part.sessionID ?? ''
  const state = part.state ?? {}
  const status = state.status ?? 'pending'
  if (status !== 'pending' && status !== 'running' && status !== 'completed' && status !== 'error')
    return null
  const input = state.input ?? {}
  const startedAt = state.time?.start ?? now
  const endAt = state.time?.end ?? null

  if (part.tool === 'pantheon_delegation_read') {
    const target = typeof input.id === 'string' ? input.id : null
    let alias: string | null = null
    let taskID: string | null = null
    if (target !== null) {
      if (READ_ALIAS_PATTERN.test(target)) alias = target
      else if (target.startsWith('ses_')) taskID = target // raw child session id
    }
    return {
      callID,
      partID: part.id ?? '',
      sessionID,
      tool: 'pantheon_delegation_read',
      agent: null,
      description: '',
      status,
      alias,
      taskID,
      startedAt,
      endAt,
    }
  }

  const agent = typeof input.agent === 'string' ? input.agent : 'agent'
  const description = typeof input.description === 'string' ? input.description : ''
  // The alias/taskID only exist once the delegate tool COMPLETES (they are
  // returned in its output); a running/pending part has neither.
  let alias: string | null = null
  let taskID: string | null = null
  if (status === 'completed') {
    const output = state.output ?? ''
    alias = DELEGATE_ALIAS_PATTERN.exec(output)?.[1] ?? null
    taskID = DELEGATE_TASKID_PATTERN.exec(output)?.[1] ?? null
  }
  return {
    callID,
    partID: part.id ?? '',
    sessionID,
    tool: 'pantheon_delegate',
    agent,
    description,
    status,
    alias,
    taskID,
    startedAt,
    endAt,
  }
}

/** Find a live entry by alias or taskID (read parts resolve by id). */
function findLiveByTarget(
  map: Map<string, LiveDelegationEntry>,
  alias: string | null,
  taskID: string | null,
): LiveDelegationEntry | undefined {
  if (alias === null && taskID === null) return undefined
  for (const entry of map.values()) {
    if (alias !== null && entry.alias === alias) return entry
    if (taskID !== null && entry.taskID === taskID) return entry
  }
  return undefined
}

/** Apply one tool part to the live map. Returns true when the map changed.
 *  Pure w.r.t. I/O — only mutates `map`. */
export function reduceDelegationToolPart(
  map: Map<string, LiveDelegationEntry>,
  part: DelegationToolPart,
  now = Date.now(),
): boolean {
  const parsed = parseDelegationToolPart(part, now)
  if (parsed === null) return false

  // Read tool: never creates a row — it resolves a delegation by id. It
  // marks the target `read` and (because it blocks until terminal) closes
  // the entry on completed/error with its end timestamp.
  if (parsed.tool === 'pantheon_delegation_read') {
    const target = findLiveByTarget(map, parsed.alias, parsed.taskID)
    if (target === undefined) return false
    let changed = false
    if (!target.read) {
      target.read = true
      changed = true
    }
    if (parsed.status === 'completed' && target.state === 'running') {
      target.state = 'completed'
      target.updatedAt = parsed.endAt ?? now
      changed = true
    } else if (parsed.status === 'error' && target.state === 'running') {
      target.state = 'error'
      target.updatedAt = parsed.endAt ?? now
      changed = true
    }
    return changed
  }

  // Delegate tool: pending/running → job launched (running). A COMPLETED
  // delegate tool only means the job was registered — it stays running and
  // we pick up alias + taskID from the output.
  const existing = map.get(parsed.callID)
  if (parsed.status === 'error') {
    if (existing !== undefined && existing.state === 'error' && existing.updatedAt === parsed.endAt)
      return false
    map.set(parsed.callID, {
      callID: parsed.callID,
      partID: parsed.partID,
      sessionID: parsed.sessionID,
      tool: 'pantheon_delegate',
      agent: parsed.agent ?? 'agent',
      description: parsed.description,
      alias: existing?.alias ?? null,
      taskID: existing?.taskID ?? null,
      state: 'error',
      startedAt: existing?.startedAt ?? parsed.startedAt,
      updatedAt: parsed.endAt ?? now,
      read: existing?.read ?? false,
    })
    return true
  }
  if (existing === undefined) {
    map.set(parsed.callID, {
      callID: parsed.callID,
      partID: parsed.partID,
      sessionID: parsed.sessionID,
      tool: 'pantheon_delegate',
      agent: parsed.agent ?? 'agent',
      description: parsed.description,
      alias: parsed.alias,
      taskID: parsed.taskID,
      state: 'running',
      startedAt: parsed.startedAt,
      updatedAt: null,
      read: false,
    })
    return true
  }
  // Existing entry: absorb newly-discovered alias/taskID/agent/description.
  let changed = false
  if (parsed.alias !== null && existing.alias !== parsed.alias) {
    existing.alias = parsed.alias
    changed = true
  }
  if (parsed.taskID !== null && existing.taskID !== parsed.taskID) {
    existing.taskID = parsed.taskID
    changed = true
  }
  if (parsed.agent !== null && existing.agent !== parsed.agent) {
    existing.agent = parsed.agent
    changed = true
  }
  if (parsed.description !== '' && existing.description !== parsed.description) {
    existing.description = parsed.description
    changed = true
  }
  if (existing.partID === '' && parsed.partID !== '') {
    existing.partID = parsed.partID
    changed = true
  }
  return changed
}

/** Remove a live entry by part id (message.part.removed) or call id.
 *  Returns true when something was removed. */
export function removeDelegationEntry(
  map: Map<string, LiveDelegationEntry>,
  partIDOrCallID: string,
): boolean {
  if (map.delete(partIDOrCallID)) return true
  for (const [key, entry] of map) {
    if (entry.partID === partIDOrCallID) {
      map.delete(key)
      return true
    }
  }
  return false
}

/** Collect pantheon delegation tool parts from a session's messages.
 *  Messages may carry their parts inline (duck-typed `msg.parts`); when
 *  they don't, the optional `getParts(messageID)` callback is used (the TUI
 *  SDK exposes `api.state.part(messageID)`). Pure w.r.t. I/O — used by the
 *  mount re-scan to re-seed the live map after compaction/attach. */
export function collectDelegationToolParts(
  messages: readonly { id?: string; parts?: unknown[] }[] | undefined,
  getParts?: (messageID: string) => readonly unknown[] | undefined,
): DelegationToolPart[] {
  const out: DelegationToolPart[] = []
  for (const msg of messages ?? []) {
    let parts: readonly unknown[] | undefined
    if (Array.isArray(msg?.parts)) {
      parts = msg.parts
    } else if (msg?.id !== undefined && typeof getParts === 'function') {
      parts = getParts(msg.id)
    }
    if (!parts) continue
    for (const raw of parts) {
      const part = raw as DelegationToolPart
      if (
        part?.type === 'tool' &&
        (part.tool === 'pantheon_delegate' || part.tool === 'pantheon_delegation_read')
      ) {
        out.push(part)
      }
    }
  }
  return out
}

/** Apply a batch of tool parts (in message order) to the live map. Used on
 *  mount to re-seed entries that `message.part.removed` (compaction) wiped,
 *  from the session's existing tool parts. Returns how many parts changed
 *  the map (0 on the second identical seed — idempotent, no extra bumps). */
export function seedLiveDelegationMap(
  map: Map<string, LiveDelegationEntry>,
  parts: readonly DelegationToolPart[],
  now = Date.now(),
): number {
  let changed = 0
  for (const part of parts) {
    if (reduceDelegationToolPart(map, part, now)) changed++
  }
  return changed
}

/** Convert a live entry into the shared display shape. Alias falls back to
 *  a `live-<callID>` prefix while the delegate tool has not completed yet. */
export function toDelegationEntry(live: LiveDelegationEntry): DelegationEntry {
  return {
    alias: live.alias ?? `live-${live.callID.slice(0, 8)}`,
    sessionID: live.sessionID,
    ...(live.taskID !== null ? { taskID: live.taskID } : {}),
    agent: live.agent,
    state: live.state,
    startedAt: live.startedAt,
    updatedAt: live.updatedAt,
    timedOut: false,
    description: live.description,
    read: live.read,
    source: 'live',
  }
}

/** Combine the live channel with the md (historical) channel into one
 *  display list. Dedupes by (sessionID, alias) — aliases are per-parent-
 *  session, so the same alias in different sessions stays separate. A
 *  terminal md entry is authoritative over a live running entry for the
 *  same job (it carries Finalized/timedOut/cancelled from finalize). */
export function mergeDelegationSources(
  live: readonly LiveDelegationEntry[],
  md: readonly DelegationEntry[],
): DelegationEntry[] {
  const keyOf = (sessionID: string, alias: string): string => `${sessionID}\u0000${alias}`
  const byKey = new Map<string, DelegationEntry>()
  for (const m of md) {
    const key = keyOf(m.sessionID, m.alias)
    const existing = byKey.get(key)
    if (existing === undefined || (existing.state === 'running' && m.state !== 'running'))
      byKey.set(key, m)
  }
  const aliasless: DelegationEntry[] = []
  for (const l of live) {
    const e = toDelegationEntry(l)
    if (l.alias === null) {
      aliasless.push(e)
      continue
    }
    const key = keyOf(l.sessionID, l.alias)
    const mdEntry = byKey.get(key)
    if (mdEntry !== undefined && mdEntry.state !== 'running') continue // md terminal wins
    byKey.set(key, e)
  }
  const all = [...aliasless, ...byKey.values()]
  all.sort(compareDelegationEntries)
  return all
}

/* ─── Children channel (primary source, delegations-sidebar pattern) ────
 * `api.client.session.children` returns the child sessions of the current
 * session — every pantheon_delegate spawns one (parentID = caller). The
 * pure helpers here turn those children + the md reports into the display
 * list, and navigate to a child session on click. */

/* ─── Current-session resolution + path guard (placeholder regression) ──
 * The sidebar forwarded `props.session_id` verbatim into
 * `session.children({ path: { id } })`. When the TUI runtime renders the
 * sidebar without a focused session it leaves the route template
 * UNSUBSTITUTED — the literal "{sessionID}" string — which opencode's server
 * rejected every poll (SchemaError: Expected a string starting with "ses",
 * got "%7BsessionID%7D"), ~1 error/s from the 1s safety poll, and the failed
 * call fail-opened into "Delegations (0)".
 *
 * Contract: resolution NEVER yields a placeholder — an invalid/absent id is
 * null, and a null resolution means the children fetch is SKIPPED (empty
 * panel, ZERO errors). Sources, in order:
 *   1. the sidebar_content slot prop (`session_id`);
 *   2. `api.state.sessionID` (duck-typed: the typed TuiState has no such
 *      field, but the runtime state is a superset — the delegations-sidebar
 *      reference reads the current session from api.state);
 *   3. `api.route.current.params.sessionID` (typed: TuiRouteCurrent's
 *      `{ name: 'session', params: { sessionID } }` variant).
 * Each source passes the same server-aligned validity check (non-empty
 * string starting with "ses"), so a placeholder or garbage at any position
 * falls through to the next source instead of hitting the wire. */

/** Server-aligned session id validity: opencode rejects anything not starting
 *  with "ses" (SchemaError). This deliberately mirrors that exact contract —
 *  nothing stricter, nothing looser — so a template placeholder ("{sessionID}"),
 *  an empty/undefined value, or a foreign id (e.g. "wrk_") can never reach a
 *  path and error-spam the log. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('ses')
}

/** Sources the sidebar can resolve the CURRENT session id from. Duck-typed
 *  subsets of TuiPluginApi / TuiState / TuiRouteCurrent so the helper stays
 *  pure and testable without the TUI runtime. */
export type TuiSessionSources = {
  /** sidebar_content slot prop (`session_id`). */
  sessionID?: string | null
  api?: {
    /** Runtime state superset — may expose the current session id. */
    state?: { sessionID?: unknown }
    /** Typed route: { name: 'session', params: { sessionID } } when in one. */
    route?: { current?: { name?: string; params?: Record<string, unknown> } }
  } | null
}

/** Resolve the current session id for the sidebar. Order: slot prop →
 *  api.state.sessionID (runtime superset) → api.route.current.params.sessionID
 *  (typed route). Every source is validated; invalid/absent → next source.
 *  NEVER returns a placeholder or non-ses id. Null → callers MUST skip the
 *  fetch (empty panel, zero errors). Pure — no I/O, no runtime required. */
export function resolveCurrentSessionID(sources: TuiSessionSources): string | null {
  const candidates: unknown[] = [
    sources?.sessionID,
    sources?.api?.state?.sessionID,
    sources?.api?.route?.current?.params?.sessionID,
  ]
  for (const candidate of candidates) {
    if (isValidSessionId(candidate)) return candidate
  }
  return null
}

/** Build the `session.children` path ONLY from a validated session id.
 *  Returns null for null/invalid ids so the caller skips the fetch instead of
 *  sending an unsubstituted placeholder (the "%7BsessionID%7D" regression). */
export function buildChildrenPath(id: string | null | undefined): { path: { id: string } } | null {
  if (!isValidSessionId(id)) return null
  return { path: { id } }
}

/** Duck-typed subset of a child Session (+ its live status type). */
export type ChildDelegationLike = {
  /** Child session id (= board task id). */
  id: string
  /** Session title — the delegate's description or prompt prefix. */
  title?: string
  /** Status type from api.state.session.status: 'busy' | 'retry' | 'idle',
   *  or undefined when the status API is unavailable. */
  status?: string
  time?: {
    created?: number
    updated?: number
  }
}

/** Map a child status type to a display state. busy/retry → running
 *  (the child is actively working), idle → completed, unknown → running
 *  (fail-open: a freshly-seen child is assumed active; the 1s poll + md
 *  correct it as soon as terminal data exists). */
export function childStatusToState(status: string | undefined): 'running' | 'completed' {
  if (status === 'idle') return 'completed'
  return 'running' // busy, retry, or unknown
}

/** Compact readable alias for a child with no md report yet: short id. */
function childAlias(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}\u2026` : id
}

/** Turn child sessions (PRIMARY) enriched with md reports into the display
 *  list. One entry per child id (duplicates across re-fetches collapse).
 *  The md report is matched by `Task ID` (== child.id) and supplies alias,
 *  agent, description, terminal state and duration. A child without a
 *  report still renders: description from its title, agent falls back to
 *  'agent', state derived from its status, startedAt from time.created.
 *  Terminal md state wins over the derived state; a running md defers to
 *  the child's live status. Sorted running-first (compareDelegationEntries).
 *  Pure — no I/O. */
export function childrenToDelegationEntries(
  children: readonly ChildDelegationLike[] | undefined,
  md: readonly DelegationEntry[],
  now = Date.now(),
): DelegationEntry[] {
  const byTaskID = new Map<string, DelegationEntry>()
  for (const m of md) {
    if (m.taskID !== undefined && !byTaskID.has(m.taskID)) byTaskID.set(m.taskID, m)
  }
  const out: DelegationEntry[] = []
  const seen = new Set<string>()
  for (const child of children ?? []) {
    if (child.id === '' || seen.has(child.id)) continue
    seen.add(child.id)
    const mdEntry = byTaskID.get(child.id)
    const state =
      mdEntry !== undefined && mdEntry.state !== 'running'
        ? mdEntry.state
        : childStatusToState(child.status)
    out.push({
      alias: mdEntry?.alias ?? childAlias(child.id),
      sessionID: mdEntry?.sessionID ?? '',
      taskID: child.id,
      agent: mdEntry?.agent ?? 'agent',
      state,
      startedAt: mdEntry?.startedAt ?? child.time?.created ?? now,
      updatedAt: mdEntry?.updatedAt ?? (state === 'running' ? null : (child.time?.updated ?? null)),
      timedOut: mdEntry?.timedOut ?? false,
      description:
        mdEntry !== undefined && mdEntry.description !== ''
          ? mdEntry.description
          : (child.title ?? ''),
      source: mdEntry !== undefined ? 'md' : 'child',
    })
  }
  out.sort(compareDelegationEntries)
  return out
}

/** Navigate the TUI to a child session (click/Enter on a delegation row).
 *  Returns false when the route API is unavailable or the target id is
 *  missing — the row stays inert instead of crashing. */
export function navigateToDelegationSession(
  route: { navigate?: (name: string, params?: Record<string, unknown>) => void } | undefined,
  taskID: string | undefined,
): boolean {
  if (typeof route?.navigate !== 'function' || taskID === undefined || taskID === '') return false
  route.navigate('session', { sessionID: taskID })
  return true
}

/* ─── Silence-by-default panel logger ──────────────────────
 * Mirrors src/pantheon/logger.ts createPantheonLogger (the TUI plugin is
 * self-contained — dist/tui.tsx is a raw copy with no relative imports):
 * every line is ALWAYS appended to `<logDir>/.pantheon/logs/hooks.log` and
 * echoed to the console ONLY when PANTHEON_HOOKS_LOG is truthy (opencode
 * renders plugin console output directly into the TUI — the pollution bug).
 * Best-effort and fire-and-forget: a logging failure must never break the
 * panel. */
type TuiLogger = { info: (message: string, ...args: unknown[]) => void }

function createTuiLogger(logDir: string | undefined, module = 'pantheon-tui'): TuiLogger {
  const echo = (process.env.PANTHEON_HOOKS_LOG ?? '').trim() !== ''
  const logPath = join(logDir ?? process.cwd(), '.pantheon', 'logs', 'hooks.log')
  const formatArg = (arg: unknown): string => {
    if (arg instanceof Error) return arg.stack ?? arg.message
    if (typeof arg === 'string') return arg
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }
  const write = (message: string, args: unknown[]) => {
    const lines = [message, ...args.map(formatArg)]
      .join(' ')
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p !== '')
    if (lines.length === 0) return
    void (async () => {
      try {
        await mkdir(dirname(logPath), { recursive: true })
        const stamp = new Date().toISOString()
        await appendFile(
          logPath,
          `${lines.map((l) => `[${stamp}] [${module}] ${l}`).join('\n')}\n`,
          'utf8',
        )
      } catch {
        /* best-effort file log — never break the panel over logging */
      }
    })()
    if (echo) {
      for (const line of lines) console.log(`[${module}] ${line}`)
    }
  }
  return { info: (message, ...args) => write(message, args) }
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

/* ─── Delegation Row (single job from the children/md channels) ─ */

function DelegationRow(props: {
  api: TuiPluginApi
  job: DelegationEntry
  now: number
  animationNow: number
}) {
  const theme = () => props.api.theme.current

  const color = createMemo(() => {
    const t = theme()
    switch (props.job.state) {
      case 'running':
        return t.warning
      case 'completed':
        return t.success
      case 'error':
        return t.error
      default:
        return t.textMuted // cancelled
    }
  })

  const marker = createMemo(() => {
    if (props.job.state === 'running') return `${delegationSpinnerFrame(props.animationNow)} `
    switch (props.job.state) {
      case 'completed':
        return '\u2713 '
      case 'error':
        return '\u2715 '
      default:
        return '\u25cb '
    }
  })

  const primary = createMemo(() => {
    const { alias, agent } = props.job
    return `${marker()}[${alias}] ${agent} \u2014 ${delegationActivityLabel(props.job)}`
  })

  const detail = createMemo(() => {
    const elapsed = delegationElapsed(props.job, props.now)
    const description = props.job.description !== '' ? ` \u2014 ${props.job.description}` : ''
    const line = `${elapsed}${description}`
    return line.length > 180 ? `${line.slice(0, 177)}\u2026` : line
  })

  // Click a row → navigate to the child session (route API guarded in the
  // helper). Enter-key binding is left out (per-row keymap wiring is not
  // worth the complexity in this sidebar); mouse is enabled in tui.json.
  const open = () => {
    navigateToDelegationSession(props.api.route, props.job.taskID)
  }

  return (
    <box onMouseDown={open}>
      <text fg={color()}>{primary()}</text>
      <text fg={theme().textMuted}>{detail()}</text>
    </box>
  )
}

/* ─── Main Sidebar View ──────────────────────────────────── */

/** Plugin-level live delegation store shared with the event subscriptions
 *  in `tui()`: the map of live entries + a version signal bumped on every
 *  mutation. The View subscribes to the version (in an effect) to refresh the
 *  durable child list and also reads the map as an optimistic live source. */
export type LiveDelegationStore = {
  map: Map<string, LiveDelegationEntry>
  /** Reactive version getter — View reads it inside an effect to re-fetch. */
  version: () => number
  /** Bump the version after a live mutation. */
  bump: () => void
}

function View(props: {
  api: TuiPluginApi
  sessionID: string | undefined
  version: string | null
  liveStore: LiveDelegationStore
}) {
  const [showSessions, setShowSessions] = createSignal(false)
  // Show live work immediately; the header remains clickable to collapse it.
  const [showDelegations, setShowDelegations] = createSignal(true)

  const theme = () => props.api.theme.current

  const branch = createMemo(() =>
    props.api.state.vcs?.branch ? `\u2387 ${props.api.state.vcs.branch}` : null,
  )

  // ── Active preset indicator ──
  // Seeded synchronously from env (never blocks first paint), then re-checked
  // against .pantheon/active-preset.json on mount and every 30s so `set-tier`
  // changes made while opencode is open become visible.
  const [preset, setPreset] = createSignal<PresetInfo>(presetFromEnv(process.env))

  onMount(() => {
    const cwd = ((props.api.state as any).path?.worktree ?? '') || process.cwd()
    let cancelled = false
    const refresh = async () => {
      try {
        const info = await resolvePresetForTui(process.env, cwd)
        if (!cancelled) setPreset(info)
      } catch {
        // transient read error — keep the last known value
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), PRESET_REFRESH_MS)
    onCleanup(() => {
      cancelled = true
      clearInterval(timer)
    })
  })

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
      .filter(
        (s: any) =>
          !s.parentID &&
          s.id !== resolveCurrentSessionID({ sessionID: props.sessionID, api: props.api }),
      )
      .sort((a: any, b: any) => {
        const ta = a.time?.updated ?? a.updated ?? 0
        const tb = b.time?.updated ?? b.updated ?? 0
        return tb - ta
      })
      .slice(0, 8)
  })

  // ── Delegations: session.children (PRIMARY) + md reports (enrichment) ──
  // The panel's source of truth is the SDK child-session API
  // (`api.client.session.children`) — every pantheon_delegate spawns a child
  // session with parentID = this session, so children ARE the delegation
  // list (delegations-sidebar pattern). The md channel
  // (.pantheon/delegations) enriches each child with alias/agent/description
  // and terminal duration via the `Task ID` match. Live tool-call events are
  // merged optimistically so the row appears before those channels catch up.
  const delegationsDir = createMemo(() => resolveDelegationsDir((props.api.state as any).path))
  // Silence-by-default panel logger → <project>/.pantheon/logs/hooks.log.
  const panelLog = createTuiLogger(dirname(delegationsDir()))
  // The rendered list is childDelegations (children enriched with md);
  // there is no separate md-only signal — the md channel only feeds
  // childrenToDelegationEntries below.
  const [childDelegations, setChildDelegations] = createSignal<DelegationEntry[]>([])
  // 1s ticker drives the running-jobs elapsed counter AND the safety poll
  // (oh-my-opencode-slim pattern): re-fetch children + re-read the md every
  // second so the panel updates even when NO event ever fires.
  const [now, setNow] = createSignal(Date.now())
  // Separate fast ticker for the spinner. The elapsed label intentionally
  // remains on the 1s ticker to avoid unnecessary work.
  const [animationNow, setAnimationNow] = createSignal(Date.now())
  // Cumulative count of event-triggered refreshes — logged with every fetch
  // ("panel: children=N md=N events=N") so the (0) symptom is diagnosable:
  // children>0 means the source works; events=0 means the event bus isn't
  // delivering, and the 1s poll is what keeps the panel honest.
  let eventRefreshCount = 0
  // In-flight guard: overlap between the poll, events and the version effect
  // collapses into one fetch — no duplicate work, no duplicate entries.
  let delegationsInflight: Promise<void> | null = null
  const refreshDelegations = () => {
    if (delegationsInflight !== null) return delegationsInflight
    delegationsInflight = (async () => {
      try {
        const state = props.api.state as any
        // 0. current session — resolve + GUARD (placeholder regression). The
        // runtime may render the sidebar with an unsubstituted "{sessionID}"
        // slot prop; forwarding it to session.children made the server reject
        // every poll (~1 err/s: "Expected a string starting with \"ses\", got
        // \"%7BsessionID%7D\"") and fail-open the panel into "(0)". A null
        // resolution SKIPS the fetch entirely: empty panel, zero errors.
        const sessionID = resolveCurrentSessionID({ sessionID: props.sessionID, api: props.api })
        if (sessionID === null) {
          setChildDelegations([])
          panelLog.info(
            `panel: children=0 md=0 events=${eventRefreshCount} (no sessionID — fetch skipped)`,
          )
          return
        }
        // 1. children — PRIMARY source (SDK: api.client.session.children).
        let children: ChildDelegationLike[] = []
        try {
          // buildChildrenPath re-validates: with sessionID !== null it is
          // never null, so no placeholder can reach the wire.
          const result = await (props.api.client as any)?.session?.children?.(
            buildChildrenPath(sessionID),
          )
          const data = (result?.data ?? result) as unknown
          children = Array.isArray(data) ? (data as ChildDelegationLike[]) : []
        } catch (err) {
          children = [] // children API unavailable — the panel shows md only
          panelLog.info('panel: error children fetch', err)
        }
        // 2. md reports — enrichment (alias/agent/description/duration).
        let md: DelegationEntry[] = []
        try {
          md = await readDelegationEntries(delegationsDir())
        } catch {
          md = [] // fail-open: never crash the sidebar on a read error
        }
        // 3. live status per child (sync API) + merge children with md.
        const resolveStatus = (childID: string): string | undefined => {
          try {
            return state?.session?.status?.(childID)?.type as string | undefined
          } catch {
            return undefined // status API unavailable — child state fallback
          }
        }
        const withStatus = children.map((c) => ({ ...c, status: resolveStatus(c.id) }))
        const childEntries = childrenToDelegationEntries(withStatus, md, now())
        // The event channel is optimistic: it renders a job even while the
        // child session/report is still being created. Filter by parent so a
        // different focused session never leaks rows into this sidebar.
        const liveEntries = [...props.liveStore.map.values()].filter(
          (entry) => entry.sessionID === sessionID,
        )
        setChildDelegations(mergeChildDelegationSources(childEntries, liveEntries))
        // 4. diagnostic line — every re-fetch (silence-by-default, hooks.log).
        panelLog.info(
          `panel: children=${children.length} md=${md.length} events=${eventRefreshCount}`,
        )
      } finally {
        delegationsInflight = null
      }
    })()
    return delegationsInflight
  }
  // Running jobs first, then the 8 most recent terminal reports. The header
  // count uses this same "running + recentes".
  const visibleDelegations = createMemo(() => {
    const all = childDelegations()
    const running = all.filter((d) => d.state === 'running')
    const terminal = all.filter((d) => d.state !== 'running').slice(0, 8)
    return [...running, ...terminal]
  })

  // ── Event subscriptions for live session/delegation updates ──
  onMount(() => {
    const cleanup: (() => void)[] = []

    // Session events — triggers the sessions resource refetch.
    try {
      cleanup.push(props.api.event.on('session.status', refetchSessions))
      cleanup.push(props.api.event.on('session.created', refetchSessions))
      cleanup.push(props.api.event.on('session.updated', refetchSessions))
      cleanup.push(props.api.event.on('session.deleted', refetchSessions))
    } catch {
      /* events API not available in this runtime */
    }

    // Delegation panel: children are born/die with session lifecycle events
    // (a delegate spawns a child → session.created fires) — re-fetch on all
    // of them. `session.status` re-syncs busy→idle state transitions.
    try {
      const eventRefresh = () => {
        eventRefreshCount += 1
        void refreshDelegations()
      }
      cleanup.push(props.api.event.on('session.created', eventRefresh))
      cleanup.push(props.api.event.on('session.updated', eventRefresh))
      cleanup.push(props.api.event.on('session.deleted', eventRefresh))
      cleanup.push(props.api.event.on('session.status', eventRefresh))
    } catch {
      /* events API not available — the 1s poll still covers it */
    }

    // message.part.updated/removed → liveStore.version() bumps (tui()):
    // subscribe here so the panel ALSO re-fetches children when tool-part
    // events DO arrive and the updated live row is rendered immediately.
    createEffect(() => {
      props.liveStore.version() // subscribe to live mutations
      eventRefreshCount += 1
      void refreshDelegations()
    })

    // Safety poll (OMO-slim pattern): 1s re-fetch children + md + tick the
    // elapsed counter. Guarantees the panel updates even with zero events.
    const poll = setInterval(() => {
      setNow(Date.now())
      void refreshDelegations()
    }, 1_000)
    cleanup.push(() => clearInterval(poll))
    const animation = setInterval(() => setAnimationNow(Date.now()), 140)
    cleanup.push(() => clearInterval(animation))

    // Compaction recovery: `message.part.removed` clears live entries while
    // compacting, so after a compaction/attach the live map would start
    // empty even though the session still holds the delegation tool parts.
    // Re-seed the live map from the session's existing parts (in message
    // order) right after the subscriptions are registered — the version
    // bump re-triggers the children fetch. Fail-open: if the SDK access is
    // unavailable we skip — the children API + the 1s poll keep the panel
    // working.
    try {
      const sdk = (props.api.state as any)?.session
      const mountSessionID = resolveCurrentSessionID({ sessionID: props.sessionID, api: props.api })
      if (mountSessionID !== null && typeof sdk?.messages === 'function') {
        const messages: readonly { id?: string; parts?: unknown[] }[] =
          sdk.messages(mountSessionID) ?? []
        const state = props.api.state as any
        const getParts =
          typeof state?.part === 'function'
            ? (messageID: string) => state.part(messageID)
            : undefined
        const parts = collectDelegationToolParts(messages, getParts)
        if (parts.length > 0 && seedLiveDelegationMap(props.liveStore.map, parts) > 0) {
          props.liveStore.bump()
        }
      }
    } catch {
      /* re-scan unavailable — children API + 1s poll still cover it */
    }

    onCleanup(() =>
      cleanup.forEach((fn) => {
        fn()
      }),
    )
  })

  const HR = () => <text fg={theme().textMuted}>{'\u2500'.repeat(28)}</text>

  return (
    <box flexDirection="column" width="100%">
      {/* ── Header ── */}
      <text fg={theme().accent} attributes={1}>
        {`Pantheon${props.version ? ` v${props.version}` : ''}`}
      </text>
      <Show when={branch()}>{(b) => <text fg={theme().textMuted}>{b()}</text>}</Show>

      {/* ── Active preset indicator ── */}
      <Show
        when={preset().name}
        fallback={
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>Preset: default</text>
          </box>
        }
      >
        {(name) => (
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>{'\u26a1 Preset:'}</text>
            <text fg={theme().accent}>{name()}</text>
            <text fg={theme().textMuted}>{`(${preset().source ?? ''})`}</text>
          </box>
        )}
      </Show>

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

      {/* ── Delegations (session.children primary + .pantheon/delegations md enrichment) ── */}
      <box onMouseDown={() => setShowDelegations((x) => !x)}>
        <text fg={theme().text} attributes={1}>
          {`${showDelegations() ? '\u25bc' : '\u25b6'} Delegations`}
        </text>
        <text fg={theme().textMuted}>{` (${String(visibleDelegations().length)})`}</text>
      </box>
      <Show when={showDelegations()}>
        <Show
          when={visibleDelegations().length > 0}
          fallback={
            <box marginLeft={1}>
              <text fg={theme().textMuted}>No delegations</text>
            </box>
          }
        >
          <box marginLeft={1} flexDirection="column">
            <For each={visibleDelegations()}>
              {(job) => (
                <DelegationRow
                  api={props.api}
                  job={job}
                  now={now()}
                  animationNow={animationNow()}
                />
              )}
            </For>
          </box>
        </Show>
      </Show>
    </box>
  )
}

/* ─── Plugin Registration ────────────────────────────────── */

const tui: TuiPlugin = async (api, _options, _meta) => {
  const version = await detectVersion(api)

  // Vendored feature (MIT): AI subscription usage gauges.
  void setupUsageBar(api) // async init — never blocks sidebar registration

  // ── Live delegation store (legacy tool-part tracker, kept as a REFRESH
  // TRIGGER) ──
  // The Delegations panel's PRIMARY source is `api.client.session.children`
  // (delegations-sidebar pattern) — `message.part.updated` may not fire for
  // pantheon_delegate on runtime 1.18.13 (the "(0)" symptom). The tool-part
  // lifecycle below still tracks pantheon_delegate / pantheon_delegation_read
  // parts and bumps a version signal the View subscribes to: when part
  // events DO arrive, the panel re-fetches children. Fail-open: if the
  // events API is unavailable nothing subscribes and the 1s safety poll
  // keeps the panel working (never crash).
  const [liveVersion, setLiveVersion] = createSignal(0)
  const liveStore: LiveDelegationStore = {
    map: new Map<string, LiveDelegationEntry>(),
    version: liveVersion,
    bump: () => setLiveVersion((v) => v + 1),
  }
  const unsubLive: (() => void)[] = []

  try {
    unsubLive.push(
      api.event.on('message.part.updated', (event: any) => {
        // SDK v2 shape: properties.part (v1 drift: properties.info.part).
        const props = (event?.properties ?? {}) as { part?: unknown; info?: { part?: unknown } }
        const part = (props.part ?? props.info?.part) as DelegationToolPart | undefined
        if (part === undefined) return
        if (reduceDelegationToolPart(liveStore.map, part)) liveStore.bump()
      }),
    )
  } catch {
    /* events API unavailable — children API + 1s poll cover the panel */
  }
  try {
    unsubLive.push(
      api.event.on('message.part.removed', (event: any) => {
        // SDK v2 shape: properties.partID (v1 drift: properties.part.id).
        const props = (event?.properties ?? {}) as { partID?: string; part?: { id?: string } }
        const partID = props.partID ?? props.part?.id
        if (partID !== undefined && removeDelegationEntry(liveStore.map, partID)) liveStore.bump()
      }),
    )
  } catch {
    /* events API unavailable — children API + 1s poll cover the panel */
  }
  api.lifecycle.onDispose(() => {
    for (const unsub of unsubLive) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    liveStore.map.clear()
  })

  api.slots.register({
    order: 900,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <View api={api} sessionID={props.session_id} version={version} liveStore={liveStore} />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: 'pantheon.tui',
  tui,
}

export default plugin
