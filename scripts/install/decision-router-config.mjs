import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { assertNoSymlinkAncestors, writeFileAtomically } from './verify.mjs'

/** Versioned, non-secret installer preference for the advisory decision router. */
export const DECISION_ROUTER_CONFIG_SCHEMA_VERSION = 1

/**
 * Legacy installer-state providers. This file is target metadata only: the
 * runtime reads the user-level configuration below, never install-state.
 */
export const DECISION_ROUTER_PROVIDERS = Object.freeze(['local', 'openai-decisions', 'jev', 'auto'])

export const DEFAULT_DECISION_ROUTER_CONFIG = Object.freeze({
  schema_version: DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
  provider: 'local',
  egress_consent: false,
})

/**
 * Canonical user-level provider/model matrix. The provider identifiers are the
 * same ones used by the runtime selector and by the private provider adapter;
 * `decision-provider-budget.ts` maps them onto the ledger's accounting names.
 */
export const DECISION_ROUTER_MODELS = Object.freeze({
  'openai-decisions': Object.freeze(['gpt-6-luna']),
  'typesafe-jev': Object.freeze(['jev-1.14.0']),
  'opencode-console-jev': Object.freeze(['jev-1.13']),
  'opencode-console-jev-free': Object.freeze(['jev-1.13-free']),
})

/** Single mapping from a user-level provider ID to the local budget provider. */
export const DECISION_PROVIDER_BUDGET_MAPPING = Object.freeze({
  'openai-decisions': 'openai-decisions',
  'typesafe-jev': 'typesafe-jev',
  'opencode-console-jev': 'opencode-console',
  'opencode-console-jev-free': 'jev-free',
})

/** Providers whose usage and price are documented well enough to reconcile. */
export const REMOTELY_ELIGIBLE_DECISION_PROVIDERS = Object.freeze([
  'openai-decisions',
  'typesafe-jev',
])

export const USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION = 2
export const DEFAULT_USER_DECISION_ROUTER_CONFIG = Object.freeze({
  schema_version: USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
  enabled: false,
  selection: Object.freeze({ mode: 'local' }),
  egress_consent: false,
  enabled_candidates: Object.freeze([]),
})

const LEGACY_PROVIDER_ALIASES = Object.freeze({ jev: 'typesafe-jev' })
const userCandidateProviders = new Set(Object.keys(DECISION_ROUTER_MODELS))
const remotelyEligibleProviders = new Set(REMOTELY_ELIGIBLE_DECISION_PROVIDERS)
const USER_CONFIG_KEYS = [
  'egress_consent',
  'enabled',
  'enabled_candidates',
  'schema_version',
  'selection',
]
const LEGACY_USER_CONFIG_KEYS = [
  'egress_consent',
  'enabled_candidates',
  'schema_version',
  'selection',
]

const providerSet = new Set(DECISION_ROUTER_PROVIDERS)
const externalProviderSet = new Set(['openai-decisions', 'jev', 'typesafe-jev'])

/** Canonicalize the legacy `jev` spelling once, at every user-config boundary. */
export function normalizeDecisionProviderId(provider) {
  if (typeof provider !== 'string') return provider
  return LEGACY_PROVIDER_ALIASES[provider] ?? provider
}

/**
 * Migrate/validate persisted preference data. Missing or invalid legacy data is
 * fail-closed: Local, no egress consent. Credentials are neither accepted nor
 * inspected here.
 * @param {unknown} value
 * @returns {{ schema_version: 1, provider: string, egress_consent: boolean }}
 */
export function migrateDecisionRouterConfig(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schema_version !== DECISION_ROUTER_CONFIG_SCHEMA_VERSION ||
    !providerSet.has(value.provider) ||
    typeof value.egress_consent !== 'boolean'
  ) {
    return { ...DEFAULT_DECISION_ROUTER_CONFIG }
  }

  return {
    schema_version: DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
    provider: value.provider,
    egress_consent: value.provider === 'local' ? false : value.egress_consent,
  }
}

/** Build the only preference shape the installer persists. */
export function createDecisionRouterConfig(provider, egressConsent = false) {
  return migrateDecisionRouterConfig({
    schema_version: DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
    provider,
    egress_consent: provider === 'local' ? false : egressConsent === true,
  })
}

/**
 * Resolve a preference without probing the environment or credentials.
 * Auto can choose only one separately authorized provider; zero or multiple
 * candidates, missing consent, or a missing explicit budget all stay Local.
 * @param {{ schema_version?: number, provider?: string, egress_consent?: boolean }} config
 * @param {{ authorizedProviders?: string[], budgetConfigured?: boolean }} [options]
 * @returns {'local'|'openai-decisions'|'jev'|'typesafe-jev'}
 */
export function resolveDecisionRouterProvider(
  config,
  { authorizedProviders = [], budgetConfigured = false } = {},
) {
  const preference = migrateDecisionRouterConfig(config)
  if (!preference.egress_consent || budgetConfigured !== true) return 'local'
  if (preference.provider === 'local') return 'local'

  if (preference.provider === 'auto') {
    const candidates = [
      ...new Set(authorizedProviders.filter((provider) => externalProviderSet.has(provider))),
    ]
    return candidates.length === 1 ? candidates[0] : 'local'
  }

  return externalProviderSet.has(preference.provider) ? preference.provider : 'local'
}

/**
 * Resolve Pantheon's private non-secret user configuration path.
 * @param {Readonly<Record<string, string | undefined>>} [env]
 */
export function resolveUserDecisionRouterConfigPath(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir()
  const root = xdg && isAbsolute(xdg) ? xdg : join(home, '.config')
  return resolve(root, 'pantheon', 'decision-router.json')
}

/** Migrate invalid or missing user data to a local-only, no-consent config. */
export function migrateUserDecisionRouterConfig(value) {
  if (!isPlainObject(value)) return cloneDefaultUserConfig()
  if (value.schema_version === 1) return migrateLegacyUserConfig(value)
  if (value.schema_version !== USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION) {
    return cloneDefaultUserConfig()
  }
  if (
    !hasExactKeys(value, USER_CONFIG_KEYS) ||
    typeof value.egress_consent !== 'boolean' ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.enabled_candidates)
  ) {
    return cloneDefaultUserConfig()
  }
  const selection = normalizeSelection(value.selection)
  const candidates = normalizeEnabledCandidates(value.enabled_candidates)
  if (selection === null || candidates === null) return cloneDefaultUserConfig()
  return {
    schema_version: USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
    enabled: value.enabled,
    selection,
    egress_consent: selection.mode === 'local' ? false : value.egress_consent,
    enabled_candidates: candidates,
  }
}

/**
 * Schema v1 predated the explicit `enabled` switch. Preserve intent only when
 * the user had selected a provider, consented, and enabled at least one
 * candidate; every other legacy shape migrates to disabled.
 */
function migrateLegacyUserConfig(value) {
  if (
    !hasExactKeys(value, LEGACY_USER_CONFIG_KEYS) ||
    typeof value.egress_consent !== 'boolean' ||
    !Array.isArray(value.enabled_candidates)
  ) {
    return cloneDefaultUserConfig()
  }
  const selection = normalizeSelection(value.selection)
  const candidates = normalizeEnabledCandidates(value.enabled_candidates)
  if (selection === null || candidates === null) return cloneDefaultUserConfig()
  const egressConsent = selection.mode === 'local' ? false : value.egress_consent
  return {
    schema_version: USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
    enabled: selection.mode !== 'local' && egressConsent && candidates.length > 0,
    selection,
    egress_consent: egressConsent,
    enabled_candidates: candidates,
  }
}

/** Return a validated immutable update, without implying consent or enablement. */
export function updateUserDecisionRouterConfig(config, update) {
  const current = migrateUserDecisionRouterConfig(config)
  if (!isPlainObject(update)) throw new TypeError('Invalid decision-router update')
  if (
    Object.keys(update).some(
      (key) => !['enabled', 'selection', 'egress_consent', 'enabled_candidates'].includes(key),
    )
  ) {
    throw new TypeError('Unsupported decision-router configuration field')
  }
  if (Object.hasOwn(update, 'selection') && normalizeSelection(update.selection) === null) {
    throw new TypeError('Invalid decision-router selection')
  }
  if (Object.hasOwn(update, 'enabled') && typeof update.enabled !== 'boolean') {
    throw new TypeError('Enabled must be explicitly true or false')
  }
  if (Object.hasOwn(update, 'egress_consent') && typeof update.egress_consent !== 'boolean') {
    throw new TypeError('Egress consent must be explicitly true or false')
  }
  if (
    Object.hasOwn(update, 'enabled_candidates') &&
    normalizeEnabledCandidates(update.enabled_candidates) === null
  ) {
    throw new TypeError('Invalid enabled provider/model candidates')
  }
  const next = { ...current, ...update }
  const normalized = migrateUserDecisionRouterConfig(next)
  if (normalized.selection.mode === 'local' && update.egress_consent === true) {
    throw new TypeError('Local selection cannot enable egress consent')
  }
  return normalized
}

/** True only when the user explicitly enabled turn selection. */
export function isUserDecisionRouterEnabled(config) {
  return migrateUserDecisionRouterConfig(config).enabled
}

/** Auto resolves only one enabled, cap-valid direct provider/model tuple. */
export function resolveUserDecisionRouterCandidate(config, capValidCandidates = []) {
  const preference = migrateUserDecisionRouterConfig(config)
  if (!preference.enabled || !preference.egress_consent) return null
  const validKeys = new Set(
    capValidCandidates
      .filter(isKnownCandidate)
      .map(({ provider, model }) => candidateKey(normalizeDecisionProviderId(provider), model)),
  )
  const enabled = preference.enabled_candidates.filter(
    (candidate) =>
      remotelyEligibleProviders.has(candidate.provider) &&
      validKeys.has(candidateKey(candidate.provider, candidate.model)),
  )
  if (preference.selection.mode === 'local') return null
  if (preference.selection.mode === 'explicit') {
    const selected = preference.selection
    return (
      enabled.find(
        (candidate) =>
          candidateKey(candidate.provider, candidate.model) ===
          candidateKey(selected.provider, selected.model),
      ) ?? null
    )
  }
  return enabled.length === 1 ? enabled[0] : null
}

/** Read only a private user-level JSON file. Invalid contents fail closed. */
export function readUserDecisionRouterConfig({ env = process.env } = {}) {
  const filePath = resolveUserDecisionRouterConfigPath(env)
  try {
    assertNoSymlinkAncestors(filePath)
    assertTrustedDirectoryChain(dirname(filePath))
    const stat = lstatSync(filePath)
    assertPrivatePath(stat, true)
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return migrateUserDecisionRouterConfig(parsed)
  } catch (error) {
    if (error?.code === 'ENOENT') return cloneDefaultUserConfig()
    throw error
  }
}

/** Persist only non-secret preference data in a user-owned 0600 file. */
export function writeUserDecisionRouterConfig(config, { env = process.env } = {}) {
  const normalized = migrateUserDecisionRouterConfig(config)
  if (JSON.stringify(normalized) !== JSON.stringify(config)) {
    throw new TypeError('Refusing to persist invalid decision-router configuration')
  }
  const filePath = resolveUserDecisionRouterConfigPath(env)
  const directory = dirname(filePath)
  assertNoSymlinkAncestors(directory, { includeLeaf: false })
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertNoSymlinkAncestors(directory)
  assertTrustedDirectoryChain(directory)
  assertPrivateDirectory(directory)
  try {
    const existing = lstatSync(filePath)
    assertPrivatePath(existing, true)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  writeFileAtomically(filePath, `${JSON.stringify(normalized, null, 2)}\n`)
  chmodSync(filePath, 0o600)
  return filePath
}

function normalizeSelection(value) {
  if (!isPlainObject(value) || typeof value.mode !== 'string') return null
  if (value.mode === 'local' || value.mode === 'auto') {
    return Object.keys(value).length === 1 ? { mode: value.mode } : null
  }
  if (
    value.mode !== 'explicit' ||
    Object.keys(value).length !== 3 ||
    !isKnownCandidate({ provider: value.provider, model: value.model })
  ) {
    return null
  }
  return {
    mode: 'explicit',
    provider: normalizeDecisionProviderId(value.provider),
    model: value.model,
  }
}

function normalizeEnabledCandidates(value) {
  const seen = new Set()
  const result = []
  for (const item of value) {
    if (!isKnownCandidate(item) || Object.keys(item).length !== 2) return null
    const provider = normalizeDecisionProviderId(item.provider)
    const key = candidateKey(provider, item.model)
    if (seen.has(key)) return null
    seen.add(key)
    result.push({ provider, model: item.model })
  }
  return result
}

function isKnownCandidate(value) {
  if (
    !isPlainObject(value) ||
    typeof value.provider !== 'string' ||
    typeof value.model !== 'string'
  ) {
    return false
  }
  const provider = normalizeDecisionProviderId(value.provider)
  return (
    userCandidateProviders.has(provider) && DECISION_ROUTER_MODELS[provider].includes(value.model)
  )
}

function candidateKey(provider, model) {
  return `${provider}/${model}`
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function cloneDefaultUserConfig() {
  return {
    schema_version: DEFAULT_USER_DECISION_ROUTER_CONFIG.schema_version,
    enabled: false,
    selection: { mode: 'local' },
    egress_consent: false,
    enabled_candidates: [],
  }
}

function assertPrivatePath(stat, isFile) {
  if (stat.isSymbolicLink() || (isFile ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error('Decision-router configuration path is not a regular private path')
  }
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) {
    throw new Error('Decision-router configuration must be owned by the current user')
  }
  if ((stat.mode & 0o077) !== 0)
    throw new Error('Decision-router configuration permissions must be private')
}

function assertPrivateDirectory(directory) {
  const stat = lstatSync(directory)
  assertPrivatePath(stat, false)
}

function assertTrustedDirectoryChain(directory) {
  const absolute = resolve(directory)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  const uid = process.getuid?.()
  if (uid === undefined)
    throw new Error('Decision-router configuration requires user ownership checks')
  for (const part of parts) {
    current = join(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Decision-router configuration path contains a non-directory component')
    }
    if (stat.uid !== uid && stat.uid !== 0) {
      throw new Error('Decision-router configuration path has an untrusted owner')
    }
    const mode = stat.mode & 0o7777
    const rootStickyDirectory = stat.uid === 0 && (mode & 0o1000) !== 0
    if ((mode & 0o022) !== 0 && !rootStickyDirectory) {
      throw new Error('Decision-router configuration path is writable by other users')
    }
  }
}
