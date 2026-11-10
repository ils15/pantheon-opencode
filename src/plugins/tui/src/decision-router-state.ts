/**
 * decision-router-state.ts — the Decision Model section of the settings window.
 *
 * TUI-local replica of the user-level decision-router config
 * (scripts/install/decision-router-config.mjs — the bundle must stay
 * self-contained); tests/tui-decision-router-state.test.mjs pins the schema
 * version, the exact key set and the provider matrix against that source.
 *
 * The runtime re-reads this file on EVERY gated call (jev-decision-tool.ts),
 * so a write here applies live — no restart. The strict exact-key schema is
 * load-bearing: any unknown key fail-closes the runtime to disabled/local,
 * so the writer validates before persisting.
 *
 * Egress consent is CLI-owned: the window never writes `egress_consent`, and
 * refuses to enable the router while remote candidates exist without it.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SettingsRow, SettingsTab } from './pantheon-settings-state.ts'

export const DECISION_ENABLED_CYCLE: readonly string[] = Object.freeze(['enabled', 'disabled'])

export const DECISION_CONFIG_SCHEMA_VERSION = 2

/** Exact top-level key set — anything else fail-closes the runtime. */
export const DECISION_CONFIG_KEYS: readonly string[] = Object.freeze([
  'egress_consent',
  'enabled',
  'enabled_candidates',
  'schema_version',
  'selection',
])

export type DecisionSelectionMode = 'local' | 'auto' | 'explicit'

export interface DecisionSelection {
  mode: DecisionSelectionMode
  provider?: string
  model?: string
}

export interface DecisionCandidate {
  provider: string
  model: string
}

export interface DecisionRouterConfig {
  schema_version: number
  enabled: boolean
  selection: DecisionSelection
  egress_consent: boolean
  enabled_candidates: readonly DecisionCandidate[]
}

export const DEFAULT_DECISION_CONFIG: DecisionRouterConfig = Object.freeze({
  schema_version: DECISION_CONFIG_SCHEMA_VERSION,
  enabled: false,
  selection: Object.freeze({ mode: 'local' as const }),
  egress_consent: false,
  enabled_candidates: Object.freeze([]),
})

/** The runtime's provider→model matrix (drift-pinned against the installer source). */
export const DECISION_KNOWN_PROVIDERS: readonly string[] = Object.freeze([
  'openai-decisions',
  'typesafe-jev',
  'opencode-console-jev',
  'openrouter-jev',
  'vercel-gateway-jev',
  'cloudflare-workers-jev',
])

export const DECISION_CONSENT_CYCLE: readonly string[] = Object.freeze(['not granted', 'granted'])
/** provider → model, straight from the runtime matrix (drift-pinned in tests). */
export const DECISION_KNOWN_MODELS: Readonly<Record<string, string>> = Object.freeze({
  'openai-decisions': 'gpt-6-luna',
  'typesafe-jev': 'jev-1.14.0',
  'opencode-console-jev': 'jev-1.13',
  'openrouter-jev': 'typesafe/jev-1.13',
  'vercel-gateway-jev': 'typesafe-ai/jev',
  'cloudflare-workers-jev': 'clef',
})

/**
 * Credential surface per provider: the ENV VAR the host provider entry reads
 * (`{env:VAR}` indirection — the window NEVER holds key values) plus the setup
 * note. Drift-pinned against the installer/runtime sources in tests.
 */
export const DECISION_PROVIDER_CREDENTIALS: Readonly<
  Record<string, { env?: string; note: string }>
> = Object.freeze({
  'openai-decisions': {
    note: 'host-configured model — provision via `decision-router setup-model openai-decisions`',
  },
  'typesafe-jev': { env: 'TYPESAFE_API_KEY', note: 'export TYPESAFE_API_KEY=… then restart' },
  'opencode-console-jev': { note: 'rides your OpenCode login — no separate key' },
  'openrouter-jev': { env: 'OPENROUTER_API_KEY', note: 'export OPENROUTER_API_KEY=… then restart' },
  'vercel-gateway-jev': {
    env: 'AI_GATEWAY_API_KEY',
    note: 'export AI_GATEWAY_API_KEY=… then restart',
  },
  'cloudflare-workers-jev': {
    env: 'CLOUDFLARE_API_TOKEN',
    note: 'needs accountId (setup-model --account-id=…) + CLOUDFLARE_API_TOKEN',
  },
})

export const DECISION_TARGET_CYCLE: readonly string[] = Object.freeze(
  DECISION_KNOWN_PROVIDERS.map((provider) => `${provider}/${DECISION_KNOWN_MODELS[provider]}`),
)

export function decisionRouterConfigPath(env: Record<string, string | undefined> = process.env) {
  const xdg = env.XDG_CONFIG_HOME
  const home = env.HOME ?? ''
  const root = xdg ?? join(home, '.config')
  return join(root, 'pantheon', 'decision-router.json')
}

export interface DecisionConfigRead {
  config: DecisionRouterConfig
  /** The file exists but is not a valid v2 config — the runtime fail-closes. */
  corrupt: boolean
}

/** Fail-open read: a missing file is the default; an invalid one is reported, not guessed. */
export function readDecisionRouterConfig(
  env: Record<string, string | undefined> = process.env,
): DecisionConfigRead {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(decisionRouterConfigPath(env), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { config: cloneDefault(), corrupt: false }
    }
    return { config: cloneDefault(), corrupt: true }
  }
  if (isValidDecisionConfig(raw)) return { config: raw, corrupt: false }
  return { config: cloneDefault(), corrupt: true }
}

function cloneDefault(): DecisionRouterConfig {
  return {
    schema_version: DEFAULT_DECISION_CONFIG.schema_version,
    enabled: DEFAULT_DECISION_CONFIG.enabled,
    selection: { ...DEFAULT_DECISION_CONFIG.selection },
    egress_consent: DEFAULT_DECISION_CONFIG.egress_consent,
    enabled_candidates: [...DEFAULT_DECISION_CONFIG.enabled_candidates],
  }
}

/** The exact-key, exact-shape validation the runtime applies (fail-closed otherwise). */
export function isValidDecisionConfig(value: unknown): value is DecisionRouterConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== DECISION_CONFIG_KEYS.length) return false
  for (const key of DECISION_CONFIG_KEYS) {
    if (!keys.includes(key)) return false
  }
  if (record.schema_version !== DECISION_CONFIG_SCHEMA_VERSION) return false
  if (typeof record.enabled !== 'boolean') return false
  if (typeof record.egress_consent !== 'boolean') return false
  if (!isValidSelection(record.selection)) return false
  if (!Array.isArray(record.enabled_candidates)) return false
  for (const candidate of record.enabled_candidates) {
    if (typeof candidate !== 'object' || candidate === null) return false
    const entry = candidate as Record<string, unknown>
    if (typeof entry.provider !== 'string' || typeof entry.model !== 'string') return false
    if (Object.keys(entry).length !== 2) return false
  }
  return true
}

function isValidSelection(value: unknown): value is DecisionSelection {
  if (typeof value !== 'object' || value === null) return false
  const selection = value as Record<string, unknown>
  if (selection.mode !== 'local' && selection.mode !== 'auto' && selection.mode !== 'explicit') {
    return false
  }
  const keys = Object.keys(selection).sort()
  for (const key of keys) {
    if (key !== 'mode' && key !== 'provider' && key !== 'model') return false
  }
  if (selection.provider !== undefined && typeof selection.provider !== 'string') return false
  if (selection.model !== undefined && typeof selection.model !== 'string') return false
  return true
}

/** Stable serializer: exact keys in sorted order, 2-space, trailing newline. */
export function serializeDecisionConfig(config: DecisionRouterConfig): string {
  const ordered = {
    egress_consent: config.egress_consent,
    enabled: config.enabled,
    enabled_candidates: config.enabled_candidates.map((candidate) => ({
      model: candidate.model,
      provider: candidate.provider,
    })),
    schema_version: config.schema_version,
    selection: {
      mode: config.selection.mode,
      ...(config.selection.model !== undefined ? { model: config.selection.model } : {}),
      ...(config.selection.provider !== undefined ? { provider: config.selection.provider } : {}),
    },
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/**
 * Enable/disable the router in a config copy. The guard mirrors the runtime's
 * fail-close: with remote candidates and no egress consent, an enabled flag
 * would be a lie — enabling requires consent, or a local-only selection.
 * Never touches `egress_consent` (CLI-owned).
 */
export function setDecisionEnabled(
  config: DecisionRouterConfig,
  enabled: boolean,
): { ok: true; config: DecisionRouterConfig } | { ok: false; reason: string } {
  if (enabled) {
    const localOnly = config.selection.mode === 'local' || config.enabled_candidates.length === 0
    if (!localOnly && !config.egress_consent) {
      return {
        ok: false,
        reason:
          'remote candidates need egress consent — toggle Egress consent in this tab, then enable',
      }
    }
  }
  return { ok: true, config: { ...config, enabled } }
}

/** Atomic-ish write mirroring the canonical writer's privacy posture (0600). */
export function writeDecisionRouterConfig(
  config: DecisionRouterConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isValidDecisionConfig(config)) {
    throw new TypeError('Refusing to persist an invalid decision-router configuration')
  }
  const path = decisionRouterConfigPath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.tui.tmp`
  writeFileSync(temp, serializeDecisionConfig(config), { mode: 0o600 })
  renameSync(temp, path)
  chmodSync(path, 0o600)
}

export const DECISION_SELECTION_CYCLE: readonly string[] = Object.freeze([
  'local',
  'auto',
  'explicit',
])

/** Stage a selection/consent row into a config copy; unknown rows are no-ops. */
export function applyDecisionRow(
  config: DecisionRouterConfig,
  id: string,
  value: string,
): DecisionRouterConfig {
  const next: DecisionRouterConfig = {
    ...config,
    selection: { ...config.selection },
    enabled_candidates: [...config.enabled_candidates],
  }
  switch (id) {
    case 'decision.selection.mode': {
      const mode = value as DecisionSelectionMode
      if (mode !== 'local' && mode !== 'auto' && mode !== 'explicit') return config
      next.selection.mode = mode
      if (mode === 'local') next.enabled_candidates = []
      return next
    }
    case 'decision.selection.target': {
      const separator = value.indexOf('/')
      if (separator <= 0) return config
      const provider = value.slice(0, separator)
      const model = value.slice(separator + 1)
      if (!DECISION_KNOWN_PROVIDERS.includes(provider)) return config
      if (DECISION_KNOWN_MODELS[provider] !== model) return config
      next.selection = { mode: 'explicit', provider, model }
      next.enabled_candidates = [{ provider, model }]
      return next
    }
    case 'decision.consent': {
      next.egress_consent = value === 'granted'
      return next
    }
    default:
      return config
  }
}

export function buildDecisionTab(
  read: DecisionConfigRead,
  env: Record<string, string | undefined> = process.env,
): SettingsTab {
  const { config, corrupt } = read
  const rows: SettingsRow[] = [
    {
      id: 'decision.enabled',
      name: 'Router',
      value: config.enabled ? 'enabled' : 'disabled',
      // Corrupt config → read-only; the notice (glue) carries the remedy.
      ...(corrupt ? {} : { cycle: DECISION_ENABLED_CYCLE }),
      note: corrupt
        ? 'config unreadable/invalid — runtime fail-closes; repair via `decision-router setup-model`'
        : 'applies live — the runtime re-reads this on every gated call',
    },
    {
      id: 'decision.selection.mode',
      name: 'Selection mode',
      value: config.selection.mode,
      ...(corrupt ? {} : { cycle: DECISION_SELECTION_CYCLE }),
      note: 'local routes on-device; auto/explicit pick a remote decision model',
    },
  ]
  if (config.selection.mode === 'explicit' || config.selection.provider !== undefined) {
    rows.push({
      id: 'decision.selection.target',
      name: 'Explicit target',
      value: config.selection.provider
        ? `${config.selection.provider}/${config.selection.model ?? ''}`
        : 'none',
      ...(corrupt || config.selection.mode !== 'explicit' ? {} : { cycle: DECISION_TARGET_CYCLE }),
      note: 'provider/model — sets the candidate list',
    })
  }
  if (config.enabled_candidates.length > 0) {
    rows.push({
      id: 'decision.candidates',
      name: 'Candidates',
      value: String(config.enabled_candidates.length),
      note: config.egress_consent
        ? config.enabled_candidates
            .map((candidate) => `${candidate.provider}/${candidate.model}`)
            .join(', ')
        : 'egress consent NOT granted — remote routes fail closed',
    })
  }
  rows.push({
    id: 'decision.consent',
    name: 'Egress consent',
    value: config.egress_consent ? 'granted' : 'not granted',
    ...(corrupt ? {} : { cycle: DECISION_CONSENT_CYCLE }),
    note: 'granted = remote decision routes may call their gateway (budget-capped)',
  })
  return {
    id: 'decision',
    title: 'Decision',
    groups: [
      { title: 'Decision router', rows },
      {
        title: 'Credentials (status only — values never enter the window)',
        rows: DECISION_KNOWN_PROVIDERS.map((provider) => {
          const credential = DECISION_PROVIDER_CREDENTIALS[provider] ?? { note: '' }
          const isSet = credential.env === undefined ? true : Boolean(env[credential.env])
          return {
            id: `decision.key.${provider}`,
            name: provider,
            value: credential.env === undefined ? 'n/a' : isSet ? 'set' : 'MISSING',
            note: credential.note,
          }
        }),
      },
    ],
  }
}
