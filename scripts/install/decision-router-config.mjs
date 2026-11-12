import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { assertNoSymlinkAncestors, writeFileAtomically } from './verify.mjs'

/** Versioned, non-secret installer preference for the advisory decision router. */
export const DECISION_ROUTER_CONFIG_SCHEMA_VERSION = 1

/**
 * Legacy installer-state providers, in prompt order. This file is target
 * metadata only: the runtime reads the user-level configuration below, never
 * install-state. The order is positional (the interactive prompt indexes it), so
 * ids are appended only through {@link ACCEPTED_INSTALL_STATE_PROVIDERS}.
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
  // Host-embedded decision modules confirmed in the 2.2.5 binary; the model
  // ids are the provider-side decision models (see
  // docs/reference/native-decisions.md for credential acquisition).
  'openrouter-jev': Object.freeze(['typesafe/jev-1.13']),
  'vercel-gateway-jev': Object.freeze(['typesafe-ai/jev']),
  'cloudflare-workers-jev': Object.freeze(['clef']),
})

/** Single mapping from a user-level provider ID to the local budget provider. */
export const DECISION_PROVIDER_BUDGET_MAPPING = Object.freeze({
  'openai-decisions': 'openai-decisions',
  'typesafe-jev': 'typesafe-jev',
  'opencode-console-jev': 'opencode-console',
  'openrouter-jev': 'openrouter',
  'vercel-gateway-jev': 'vercel-ai-gateway',
  'cloudflare-workers-jev': 'cloudflare-workers-ai',
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

/**
 * Accepted install-state provider ids. `typesafe-jev` is the canonical form of
 * the legacy `jev` alias and is written by `projectDecisionRouterInstallState`;
 * accepting it is what lets a projected record survive a read/write round trip
 * instead of resetting to Local (D7). The prompt list above is unchanged, so no
 * new install-time option appears.
 */
const ACCEPTED_INSTALL_STATE_PROVIDERS = new Set([...DECISION_ROUTER_PROVIDERS, 'typesafe-jev'])

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
    !ACCEPTED_INSTALL_STATE_PROVIDERS.has(value.provider) ||
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
 * (The legacy `resolveDecisionRouterProvider` auto resolver was removed with
 * the direct-fetch provider path; runtime selection uses
 * `resolveUserDecisionRouterCandidate` / `explainUserDecisionRouterAutoSelection`
 * and the native route resolver.)
 */

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
  // Selecting a different provider/model target is not consent for it (D9):
  // `select` records a preference and can only ever leave egress OFF. A
  // previously recorded consent is revoked when the target moves, unless the
  // caller passes `egress_consent` in the same explicit update (an admin
  // surface that names both fields at once).
  if (
    Object.hasOwn(update, 'selection') &&
    !Object.hasOwn(update, 'egress_consent') &&
    !sameSelection(normalizeSelection(update.selection), current.selection)
  ) {
    next.egress_consent = false
  }
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

function eligibleAutoCandidates(preference, capValidCandidates) {
  const validKeys = new Set(
    capValidCandidates
      .filter(isKnownCandidate)
      .map(({ provider, model }) => candidateKey(normalizeDecisionProviderId(provider), model)),
  )
  return preference.enabled_candidates.filter(
    (candidate) =>
      remotelyEligibleProviders.has(candidate.provider) &&
      validKeys.has(candidateKey(candidate.provider, candidate.model)),
  )
}

/**
 * Explain an Auto selection with an explicit cardinality branch (D5).
 *
 * The defect this closes: 0 and 2+ eligible candidates both collapsed into a
 * single `null`, so a caller could not tell "nothing is enabled" from "several
 * are enabled and I refuse to guess". The three outcomes below are distinct
 * values with distinct reason codes, and every refusal names the state that
 * caused it.
 *
 * @param {unknown} config
 * @param {ReadonlyArray<{ provider: string, model: string }>} [capValidCandidates]
 * @returns {{ outcome: 'ineligible', reason: 'DISABLED'|'CONSENT_MISSING'|'NOT_AUTO' }
 *   | { outcome: 'none', reason: 'NO_ELIGIBLE_CANDIDATE', count: 0 }
 *   | { outcome: 'single', reason: 'SINGLE_ELIGIBLE_CANDIDATE', count: 1,
 *       candidate: { provider: string, model: string } }
 *   | { outcome: 'ambiguous', reason: 'MULTIPLE_ELIGIBLE_CANDIDATES', count: number }}
 */
export function explainUserDecisionRouterAutoSelection(config, capValidCandidates = []) {
  const preference = migrateUserDecisionRouterConfig(config)
  // Preconditions are reported as ineligible, never as a cardinality outcome:
  // a disabled router with two candidates is disabled, not ambiguous.
  if (!preference.enabled) return { outcome: 'ineligible', reason: 'DISABLED' }
  if (!preference.egress_consent) return { outcome: 'ineligible', reason: 'CONSENT_MISSING' }
  if (preference.selection.mode !== 'auto') return { outcome: 'ineligible', reason: 'NOT_AUTO' }

  const eligible = eligibleAutoCandidates(preference, capValidCandidates)
  if (eligible.length === 0) {
    return { outcome: 'none', reason: 'NO_ELIGIBLE_CANDIDATE', count: 0 }
  }
  if (eligible.length > 1) {
    return {
      outcome: 'ambiguous',
      reason: 'MULTIPLE_ELIGIBLE_CANDIDATES',
      count: eligible.length,
    }
  }
  return {
    outcome: 'single',
    reason: 'SINGLE_ELIGIBLE_CANDIDATE',
    count: 1,
    candidate: eligible[0],
  }
}

/** Auto resolves only one enabled, cap-valid direct provider/model tuple. */
export function resolveUserDecisionRouterCandidate(config, capValidCandidates = []) {
  const preference = migrateUserDecisionRouterConfig(config)
  if (!preference.enabled || !preference.egress_consent) return null
  if (preference.selection.mode === 'local') return null
  if (preference.selection.mode === 'explicit') {
    const selected = preference.selection
    const enabled = eligibleAutoCandidates(preference, capValidCandidates)
    return (
      enabled.find(
        (candidate) =>
          candidateKey(candidate.provider, candidate.model) ===
          candidateKey(selected.provider, selected.model),
      ) ?? null
    )
  }
  const explained = explainUserDecisionRouterAutoSelection(preference, capValidCandidates)
  return explained.outcome === 'single' ? explained.candidate : null
}

/** Read only a private user-level JSON file. Invalid contents fail closed. */
export function readUserDecisionRouterConfig({ env = process.env } = {}) {
  const filePath = resolveUserDecisionRouterConfigPath(env)
  try {
    assertNoSymlinkAncestors(filePath)
    assertTrustedDirectoryChain(dirname(filePath), { env })
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
  assertTrustedDirectoryChain(directory, { env })
  assertPrivateDirectory(directory)
  try {
    const existing = lstatSync(filePath)
    assertPrivatePath(existing, true)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  writeFileAtomically(filePath, serializeUserDecisionRouterConfig(normalized))
  chmodSync(filePath, 0o600)
  return filePath
}

/**
 * The only serializer for the user-level config.
 *
 * A preview is honest only when the bytes it compares are the bytes the writer
 * would produce, so the preview and the writer share this function. It is
 * deliberately free of clock and environment reads.
 *
 * @param {unknown} config
 * @returns {string}
 */
export function serializeUserDecisionRouterConfig(config) {
  return `${JSON.stringify(migrateUserDecisionRouterConfig(config), null, 2)}\n`
}

/**
 * Project the user-level configuration onto the only install-state record that
 * may exist (D7).
 *
 * Install-state records a target preference; the runtime reads the user-level
 * file. Deriving the record from that file is what keeps the two surfaces from
 * disagreeing: there is no second place where a provider or a consent decision
 * can be typed in. The projection carries the user's own consent boolean, so it
 * can never assert consent the runtime configuration does not have.
 *
 * @param {unknown} userConfig
 * @returns {{ schema_version: 1, provider: string, egress_consent: boolean }}
 */
export function projectDecisionRouterInstallState(userConfig) {
  const preference = migrateUserDecisionRouterConfig(userConfig)
  const provider =
    preference.selection.mode === 'explicit'
      ? normalizeDecisionProviderId(preference.selection.provider)
      : preference.selection.mode
  return migrateDecisionRouterConfig({
    schema_version: DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
    provider,
    egress_consent: preference.egress_consent,
  })
}

/**
 * Field-level divergence between install-state and the user-level config (D7).
 * Returns field NAMES and both states, never free-form content; callers print a
 * reconciliation instruction instead of rewriting the record silently.
 *
 * @param {unknown} userConfig
 * @param {unknown} installStateRecord
 * @returns {{ expected: object, actual: object, differences: Array<{ field: string, installState: unknown, userConfig: unknown }> }}
 */
export function diffDecisionRouterSurfaces(userConfig, installStateRecord) {
  const expected = projectDecisionRouterInstallState(userConfig)
  const actual = migrateDecisionRouterConfig(installStateRecord)
  const differences = []
  if (actual.provider !== expected.provider) {
    differences.push({
      field: 'provider',
      installState: actual.provider,
      userConfig: expected.provider,
    })
  }
  if (actual.egress_consent !== expected.egress_consent) {
    differences.push({
      field: 'egress_consent',
      installState: actual.egress_consent,
      userConfig: expected.egress_consent,
    })
  }
  return { expected, actual, differences }
}

function sameSelection(left, right) {
  if (left === null || right === null) return left === right
  if (left.mode !== right.mode) return false
  if (left.mode !== 'explicit') return true
  return left.provider === right.provider && left.model === right.model
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

function isPermittedGroupWritable(_current, env = process.env) {
  if (env.PANTHEON_ALLOW_GROUP_WRITABLE === '1' || env.PANTHEON_ALLOW_GROUP_WRITABLE === 'true') {
    return true
  }
  if (
    env.JUPYTERHUB_USER ||
    env.JUPYTER_IMAGE ||
    env.JUPYTER_SERVER_ROOT ||
    env.KUBERNETES_SERVICE_HOST ||
    env.container ||
    existsSync('/.dockerenv')
  ) {
    return true
  }
  return false
}

function assertTrustedDirectoryChain(directory, { env = process.env } = {}) {
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
    const mode = stat.mode & 0o7777
    const isSticky = (mode & 0o1000) !== 0
    const isSystemOrUser = stat.uid === uid || stat.uid === 0 || (isSticky && stat.uid === 65534)
    if (!isSystemOrUser) {
      throw new Error('Decision-router configuration path has an untrusted owner')
    }
    const worldWritable = (mode & 0o002) !== 0
    const groupWritable = (mode & 0o020) !== 0
    if (worldWritable && !isSticky) {
      throw new Error('Decision-router configuration path is writable by other users')
    }
    if (groupWritable && !isSticky && !isPermittedGroupWritable(current, env)) {
      throw new Error(
        `Decision-router configuration path "${current}" is group-writable (mode ${(mode & 0o777).toString(8)}). In containers or JupyterHub, set PANTHEON_ALLOW_GROUP_WRITABLE=1 to permit group-writable ancestors, or run: chmod +t "${current}"`,
      )
    }
  }
}

/** Host config file the TypeSafe provisioner merges into. */
function resolveHostOpenCodeConfigPath(env) {
  const xdg = env.XDG_CONFIG_HOME
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir()
  const root = xdg && isAbsolute(xdg) ? xdg : join(home, '.config')
  return resolve(root, 'opencode', 'opencode.json')
}

/**
 * Additively merge the TypeSafe decision provider entry into the user's host
 * `opencode.json` (`providers.typesafe-ai.models["jev-1.14.0"]`, type
 * "decision"). Existing provider entries and an existing model entry are
 * preserved. Read-only on the decision-router config; the merge is the one
 * write.
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function provisionTypesafeHostProvider({ env = process.env } = {}) {
  const configPath = resolveHostOpenCodeConfigPath(env)
  if (!existsSync(configPath)) return { ok: false, reason: 'opencode.json not found' }
  let data
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'opencode.json is not a JSON object' }
    }
    data = parsed
  } catch {
    return { ok: false, reason: 'opencode.json is not plain JSON (comments?)' }
  }
  data.providers ??= {}
  data.providers['typesafe-ai'] ??= {}
  // A complete custom provider entry: without the npm adapter and the
  // transport options (baseURL + apiKey) the host cannot resolve the
  // provider at all (field evidence: a models-only entry 404s on the
  // decisions API; models.dev does not carry typesafe-ai, so /connect and
  // `opencode auth login` cannot supply it either). The credential rides
  // the `{env:...}` reference — the key itself stays out of the config
  // file; an entry the user already completed is preserved as-is.
  const entry = data.providers['typesafe-ai']
  entry.npm ??= '@ai-sdk/openai-compatible'
  entry.name ??= 'TypeSafe AI'
  entry.options ??= {}
  entry.options.baseURL ??= 'https://api.typesafe.ai/v1'
  entry.options.apiKey ??= '{env:TYPESAFE_API_KEY}'
  entry.models ??= {}
  if (entry.models['jev-1.14.0'] === undefined) {
    entry.models['jev-1.14.0'] = {
      name: 'Jev (TypeSafe direct)',
      modelID: 'jev-latest',
      type: 'decision',
    }
  }
  try {
    writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`)
    return { ok: true, path: configPath }
  } catch (error) {
    return { ok: false, reason: String(error instanceof Error ? error.message : error) }
  }
}

/**
 * Additively merge the Cloudflare Workers AI decision provider entry into the
 * user's host `opencode.json`. The host's embedded `cloudflare-workers-ai`
 * decisions module needs the accountId in the entry options and reads the
 * token from `CLOUDFLARE_API_TOKEN` (a Workers AI-scoped token — not the
 * global Cloudflare key). Existing entries are preserved.
 * @param {{ accountId: string, env?: Record<string, string | undefined> }} options
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function provisionCloudflareHostProvider({ accountId, env = process.env } = {}) {
  const trimmed = String(accountId ?? '').trim()
  if (!/^[a-f0-9]{32}$/i.test(trimmed)) {
    return { ok: false, reason: 'accountId must be the 32-hex Cloudflare account id' }
  }
  const configPath = resolveHostOpenCodeConfigPath(env)
  if (!existsSync(configPath)) return { ok: false, reason: 'opencode.json not found' }
  let data
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'opencode.json is not a JSON object' }
    }
    data = parsed
  } catch {
    return { ok: false, reason: 'opencode.json is not plain JSON (comments?)' }
  }
  data.providers ??= {}
  data.providers['cloudflare-workers-ai'] ??= {}
  data.providers['cloudflare-workers-ai'].options ??= {}
  const provider = data.providers['cloudflare-workers-ai']
  const existingAccountId = provider.options.accountId
  if (existingAccountId != null && String(existingAccountId).trim() !== '') {
    if (String(existingAccountId).trim().toLowerCase() !== trimmed.toLowerCase()) {
      return { ok: false, reason: 'existing accountId conflicts with --account-id' }
    }
  } else {
    provider.options.accountId = trimmed
  }
  provider.models ??= {}
  if (provider.models.clef === undefined) {
    provider.models.clef = {
      name: 'Clef (Cloudflare Workers AI)',
      type: 'decision',
    }
  }
  try {
    writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`)
    return { ok: true, path: configPath }
  } catch (error) {
    return { ok: false, reason: String(error instanceof Error ? error.message : error) }
  }
}

/**
 * Read-only check that the TypeSafe provider entry exists in the host config.
 * Never writes; an unreadable config reports present:false with the path for
 * the doctor's fix hint.
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {{ present: boolean, path: string }}
 */
export function inspectTypesafeHostProvider({ env = process.env } = {}) {
  const configPath = resolveHostOpenCodeConfigPath(env)
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    const entry = parsed?.providers?.['typesafe-ai']
    const model = entry?.models?.['jev-1.14.0']
    const present = model !== undefined && model !== null
    const apiKey = entry?.options?.apiKey
    // Credential states: inline key, `{env:...}` reference, or missing. The
    // referenced env var is resolved by the HOST at call time — the doctor
    // cannot see the host's environment, so a reference counts as present
    // with a note instead of a verdict.
    const hasCredential = typeof apiKey === 'string' && apiKey.length > 0
    const viaEnvRef = hasCredential && apiKey.startsWith('{env:')
    return {
      present,
      hasCredential,
      viaEnvRef,
      apiKeyRef: hasCredential ? apiKey : null,
      path: configPath,
    }
  } catch {
    return {
      present: false,
      hasCredential: false,
      viaEnvRef: false,
      apiKeyRef: null,
      path: configPath,
    }
  }
}
