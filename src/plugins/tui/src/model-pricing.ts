/**
 * Model pricing — money for `pantheon_cost`.
 *
 * Prices come from the public catalog the OpenCode ecosystem already uses,
 * `https://models.dev/api.json` (USD per 1M tokens). The rule that shapes this
 * module is that a tool call must NEVER block on the network:
 *
 *   - every call reads a normalized on-disk cache synchronously;
 *   - an explicit `refreshPricing` is the only AWAITED fetch (bounded timeout);
 *   - a missing or stale cache is refreshed in the BACKGROUND, with a short
 *     timeout, so the next call benefits without this one waiting;
 *   - every network/parse failure degrades to "pricing unavailable" and the
 *     token report keeps working.
 *
 * An unknown model is never priced at zero. `0` is a real catalog price (a free
 * model), and conflating it with "no price" would report free usage for every
 * model the catalog has never heard of — which is precisely the number a tier
 * decision would be made on.
 *
 * Cache location follows the repository's existing config-dir convention
 * (`PANTHEON_HOME` → `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode`), so no
 * new root is invented: `<configDir>/cache/models-dev.json`.
 *
 * @module model-pricing
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The catalog URL every OpenCode-adjacent tool prices against. */
const MODELS_DEV_URL = 'https://models.dev/api.json'

/** Cache payload version; a mismatch is treated as "no cache". */
const PRICING_CACHE_VERSION = 1

/** Cached prices are considered fresh for one day. */
const PRICING_TTL_MS = 24 * 60 * 60 * 1000

/** Upper bound for any catalog fetch, so no request can outlive a tool call. */
const PRICING_TIMEOUT_MS = 3000

/** One model's list price, in USD per 1M tokens. */
export interface ModelPrice {
  inputPerMTok: number
  outputPerMTok: number
  /**
   * Absent when the catalog publishes no cache-read price. Kept distinct from
   * `0` so cache tokens can never be priced as free by accident.
   */
  cacheReadPerMTok?: number
  cacheWritePerMTok?: number
}

/** Token counts a cost is computed from. */
export interface TokenAmounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Why a row could not be priced. */
export type UnpricedReason =
  | 'no-pricing'
  | 'unknown-model'
  | 'ambiguous-model'
  | 'missing-cache-price'

/** Resolved prices, ready for lookup. */
export interface PricingSnapshot {
  /** `${providerId}/${modelId}`, lowercased. */
  index: ReadonlyMap<string, ModelPrice>
  /** Model id → every provider's price for it, for provider-less lookups. */
  modelIndex: ReadonlyMap<string, readonly ModelPrice[]>
  /** True when the cache is older than the TTL. */
  stale: boolean
  /** True when a background refresh is in flight. */
  refreshing: boolean
  /** Epoch ms of the cached catalog. */
  fetchedAt?: number
  /** Set when pricing cannot be used at all, or when a refresh failed. */
  unavailableReason?: string
  /**
   * Set when a refresh was REFUSED rather than attempted (offline mode).
   * Distinguished from a failed fetch so the report can say "no request was
   * made" instead of implying the network was tried.
   */
  refused?: boolean
  /** True when offline mode was in effect for this snapshot. */
  offline?: boolean
}

/** Minimal fetch boundary, so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** Injectable knobs (tests, air-gapped hosts, unusual installs). */
export interface PricingOptions {
  /** Cache file. Default: `<configDir>/cache/models-dev.json`. */
  cachePath?: string
  /** Fetch boundary. Default: global `fetch`. */
  fetchImpl?: FetchLike
  /** Clock. Default: `Date.now`. */
  now?: () => number
  /** Freshness window. Default: {@link PRICING_TTL_MS}. */
  ttlMs?: number
  /** Environment used for cache-path resolution. Default: `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Disable every network attempt (tests / air-gapped hosts). */
  offline?: boolean
}

interface CachedCatalog {
  version: number
  fetchedAt: number
  providers: Record<string, Record<string, ModelPrice>>
}

type ProviderPrices = Record<string, Record<string, ModelPrice>>

/** Resolve the OpenCode config dir, mirroring `_pantheon_paths.py`. */
function resolvePricingCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PANTHEON_HOME?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const xdg = env.XDG_CONFIG_HOME?.trim()
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config')
  return join(base, 'opencode')
}

/** Cache file for the normalized catalog. */
function resolvePricingCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePricingCacheDir(env), 'cache', 'models-dev.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Reject nonsense prices rather than reporting a $2B session. */
const MAX_SANE_PER_MTOK = 100_000

function nonNegativePrice(value: unknown): number | undefined {
  const parsed = finiteNumber(value)
  if (parsed === undefined || parsed < 0 || parsed > MAX_SANE_PER_MTOK) return undefined
  return parsed
}

/** Validate one already-normalized price from the cache file. */
function buildPrice(
  input: number | undefined,
  output: number | undefined,
  cacheRead: number | undefined,
  cacheWrite: number | undefined,
): ModelPrice | undefined {
  if (input === undefined || output === undefined) return undefined
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    ...(cacheRead === undefined ? {} : { cacheReadPerMTok: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWritePerMTok: cacheWrite }),
  }
}

function parseNormalizedPrice(value: unknown): ModelPrice | undefined {
  if (!isRecord(value)) return undefined
  return buildPrice(
    nonNegativePrice(value.inputPerMTok),
    nonNegativePrice(value.outputPerMTok),
    nonNegativePrice(value.cacheReadPerMTok),
    nonNegativePrice(value.cacheWritePerMTok),
  )
}

/**
 * Validate the normalized `provider → model → price` shape.
 *
 * The cache stores the RESULT of {@link parseCatalogPayload}, not the raw
 * models.dev payload, so it must not be re-parsed as one: a normalized entry has
 * no `models` key, and treating it as a payload would silently read a valid
 * cache as empty.
 */
function parseNormalizedProviders(value: unknown): ProviderPrices | undefined {
  if (!isRecord(value)) return undefined
  const providers: ProviderPrices = {}
  for (const [providerId, models] of Object.entries(value)) {
    if (!isRecord(models)) continue
    const priced: Record<string, ModelPrice> = {}
    for (const [modelId, price] of Object.entries(models)) {
      const parsed = parseNormalizedPrice(price)
      if (parsed !== undefined) priced[modelId.toLowerCase()] = parsed
    }
    if (Object.keys(priced).length > 0) providers[providerId.toLowerCase()] = priced
  }
  return Object.keys(providers).length === 0 ? undefined : providers
}

/** Parse one catalog model entry. Missing input/output cost ⇒ unpriced. */
function parseModelPrice(model: unknown): ModelPrice | undefined {
  if (!isRecord(model)) return undefined
  const cost = model.cost
  if (!isRecord(cost)) return undefined
  return buildPrice(
    nonNegativePrice(cost.input),
    nonNegativePrice(cost.output),
    nonNegativePrice(cost.cache_read),
    nonNegativePrice(cost.cache_write),
  )
}

/**
 * Normalize a models.dev payload into `provider → model → price`.
 *
 * Provider and model ids are lowercased because the ledger stores whatever the
 * host wrote (`opencode-go`) and the catalog keys are not case-normalized.
 */
export function parseCatalogPayload(payload: unknown): ProviderPrices | undefined {
  if (!isRecord(payload)) return undefined
  const providers: ProviderPrices = {}
  for (const [providerId, provider] of Object.entries(payload)) {
    if (!isRecord(provider)) continue
    const models = provider.models
    if (!isRecord(models)) continue
    const priced: Record<string, ModelPrice> = {}
    for (const [modelId, model] of Object.entries(models)) {
      const price = parseModelPrice(model)
      if (price !== undefined) priced[modelId.toLowerCase()] = price
    }
    if (Object.keys(priced).length > 0) providers[providerId.toLowerCase()] = priced
  }
  return Object.keys(providers).length === 0 ? undefined : providers
}

function priceKey(price: ModelPrice): string {
  return [
    price.inputPerMTok,
    price.outputPerMTok,
    price.cacheReadPerMTok ?? '-',
    price.cacheWritePerMTok ?? '-',
  ].join('/')
}

function indexCatalog(providers: ProviderPrices): {
  index: Map<string, ModelPrice>
  modelIndex: Map<string, readonly ModelPrice[]>
} {
  const index = new Map<string, ModelPrice>()
  const modelIndex = new Map<string, ModelPrice[]>()
  const seen = new Map<string, Set<string>>()
  for (const [providerId, models] of Object.entries(providers)) {
    for (const [modelId, price] of Object.entries(models)) {
      index.set(`${providerId}/${modelId}`, price)
      const bucket = modelIndex.get(modelId) ?? []
      const keys = seen.get(modelId) ?? new Set<string>()
      const key = priceKey(price)
      if (!keys.has(key)) {
        keys.add(key)
        bucket.push(price)
        seen.set(modelId, keys)
        modelIndex.set(modelId, bucket)
      }
    }
  }
  return { index, modelIndex }
}

function snapshotFromCatalog(
  catalog: CachedCatalog,
  now: number,
  ttlMs: number,
  refreshing: boolean,
): PricingSnapshot {
  const { index, modelIndex } = indexCatalog(catalog.providers)
  return {
    index,
    modelIndex,
    fetchedAt: catalog.fetchedAt,
    stale: Math.max(0, now - catalog.fetchedAt) > ttlMs,
    refreshing,
  }
}

function unavailableSnapshot(reason: string): PricingSnapshot {
  return {
    index: new Map(),
    modelIndex: new Map(),
    stale: false,
    refreshing: false,
    unavailableReason: reason,
  }
}

function parseCachedCatalog(raw: unknown): CachedCatalog | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.version !== PRICING_CACHE_VERSION) return undefined
  const fetchedAt = finiteNumber(raw.fetchedAt)
  if (fetchedAt === undefined) return undefined
  const providers = parseNormalizedProviders(raw.providers)
  if (providers === undefined) return undefined
  return { version: PRICING_CACHE_VERSION, fetchedAt, providers }
}

/** Read the normalized cache. Any problem reads as "no cache", never as zero. */
function readPricingCache(cachePath: string): CachedCatalog | undefined {
  try {
    if (!existsSync(cachePath)) return undefined
    return parseCachedCatalog(JSON.parse(readFileSync(cachePath, 'utf8')))
  } catch {
    return undefined
  }
}

/** Write atomically; a cache that cannot be written must not break a report. */
function writePricingCache(cachePath: string, catalog: CachedCatalog): boolean {
  const temp = `${cachePath}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(temp, `${JSON.stringify(catalog)}\n`, 'utf8')
    renameSync(temp, cachePath)
    return true
  } catch {
    return false
  }
}

const inFlight = new Map<string, Promise<PricingSnapshot>>()

/**
 * Offline is a HOST-wide guarantee, not a hint.
 *
 * Both switches are honoured on every path that could open a socket, so the
 * env var cannot be defeated by a caller that passes `refreshPricing` (or by a
 * future code path that forgets to check). The reason names both switches,
 * because a user reading the report needs to know which one to change.
 */
const OFFLINE_REFUSAL =
  'refreshPricing cannot run: PANTHEON_COST_OFFLINE=1 (or the offline option) forbids every network request'

function isPricingOffline(options?: PricingOptions): boolean {
  const env = options?.env ?? process.env
  return options?.offline === true || env.PANTHEON_COST_OFFLINE === '1'
}

/**
 * Fetch the catalog once per cache path at a time, bounded by a timeout.
 *
 * Failures are values, not throws: the caller reports "pricing unavailable" and
 * keeps the token ledger it already read.
 */
function refreshPricingCatalog(options?: PricingOptions): Promise<PricingSnapshot> {
  // The gate sits on the fetch itself, so no caller — background, forced, or a
  // future one — can open a socket while offline.
  if (isPricingOffline(options)) {
    return Promise.resolve({
      ...unavailableSnapshot(OFFLINE_REFUSAL),
      refused: true,
      offline: true,
    })
  }
  const env = options?.env ?? process.env
  const cachePath = options?.cachePath ?? resolvePricingCachePath(env)
  const existing = inFlight.get(cachePath)
  if (existing !== undefined) return existing

  const now = (options?.now ?? Date.now)()
  const ttlMs = options?.ttlMs ?? PRICING_TTL_MS
  const doFetch: FetchLike =
    options?.fetchImpl ??
    ((url, init) =>
      fetch(url, {
        ...(init.signal === undefined ? {} : { signal: init.signal }),
        ...(init.headers === undefined ? {} : { headers: init.headers }),
      }))

  const task = (async (): Promise<PricingSnapshot> => {
    try {
      const response = await doFetch(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(PRICING_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        return unavailableSnapshot(`models.dev returned HTTP ${response.status}`)
      }
      const providers = parseCatalogPayload(await response.json())
      if (providers === undefined) {
        return unavailableSnapshot('models.dev payload carried no usable prices')
      }
      const catalog: CachedCatalog = { version: PRICING_CACHE_VERSION, fetchedAt: now, providers }
      const cached = writePricingCache(cachePath, catalog)
      const snapshot = snapshotFromCatalog(catalog, now, ttlMs, false)
      return cached ? snapshot : { ...snapshot, unavailableReason: 'price cache is not writable' }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return unavailableSnapshot(`models.dev fetch failed: ${detail}`)
    } finally {
      inFlight.delete(cachePath)
    }
  })()

  inFlight.set(cachePath, task)
  return task
}

/**
 * Load prices without blocking on the network.
 *
 * A stale cache is served immediately and refreshed in the background; with no
 * cache there is nothing to serve, so the snapshot is explicitly unavailable
 * and `pending` carries the opportunistic refresh for callers that want it.
 */
export function loadPricing(options?: PricingOptions): {
  snapshot: PricingSnapshot
  pending?: Promise<void>
} {
  const env = options?.env ?? process.env
  const cachePath = options?.cachePath ?? resolvePricingCachePath(env)
  const now = (options?.now ?? Date.now)()
  const ttlMs = options?.ttlMs ?? PRICING_TTL_MS
  const catalog = readPricingCache(cachePath)
  const offline = isPricingOffline(options)

  if (catalog === undefined) {
    if (offline) {
      return {
        snapshot: {
          ...unavailableSnapshot(
            'no price cache, and pricing is offline (PANTHEON_COST_OFFLINE=1 or the offline option)',
          ),
          offline: true,
        },
      }
    }
    const pending = refreshPricingCatalog(options)
    return {
      snapshot: unavailableSnapshot(
        'no cached models.dev catalog yet; fetching one in the background',
      ),
      pending: pending.then(() => undefined),
    }
  }

  const snapshot = snapshotFromCatalog(catalog, now, ttlMs, false)
  if (!snapshot.stale || offline) {
    return { snapshot: offline ? { ...snapshot, offline: true } : snapshot }
  }
  // Stale prices are better than none: serve them and refresh behind the call.
  const pending = refreshPricingCatalog(options)
  return {
    snapshot: { ...snapshot, refreshing: true },
    pending: pending.then(() => undefined),
  }
}

/**
 * Await a refresh — only for an explicit `refreshPricing: true`.
 *
 * On failure the previously cached prices are still returned (marked stale), so
 * a failed refresh does not erase the only prices the host has.
 */
export async function forceRefreshPricing(options?: PricingOptions): Promise<PricingSnapshot> {
  const refreshed = await refreshPricingCatalog(options)
  if (refreshed.unavailableReason === undefined) return refreshed
  const env = options?.env ?? process.env
  const cachePath = options?.cachePath ?? resolvePricingCachePath(env)
  const catalog = readPricingCache(cachePath)
  if (catalog === undefined) return refreshed
  const now = (options?.now ?? Date.now)()
  const cached = snapshotFromCatalog(catalog, now, options?.ttlMs ?? PRICING_TTL_MS, false)
  return {
    ...cached,
    unavailableReason: refreshed.unavailableReason,
    ...(refreshed.refused === true ? { refused: true } : {}),
    ...(refreshed.offline === true ? { offline: true } : {}),
  }
}

/** Result of a price lookup. */
export type PriceLookup = { ok: true; price: ModelPrice } | { ok: false; reason: UnpricedReason }

/**
 * Resolve a price for one ledger model.
 *
 * Exact `provider/model` wins. A model that exists under exactly one provider
 * price is accepted when the ledger's provider id is unknown to the catalog
 * (real hosts name their own gateways, e.g. `opencode-go` serving a model the
 * catalog lists under `opencode`). Two DIFFERENT prices for the same model id
 * are ambiguous and stay unpriced rather than guessing a provider.
 */
export function lookupModelPrice(
  snapshot: PricingSnapshot,
  providerId: string | undefined,
  modelId: string | undefined,
): PriceLookup {
  if (snapshot.index.size === 0) return { ok: false, reason: 'no-pricing' }
  const model = (modelId ?? '').trim().toLowerCase()
  if (model === '') return { ok: false, reason: 'unknown-model' }
  const provider = (providerId ?? '').trim().toLowerCase()
  if (provider !== '') {
    const exact = snapshot.index.get(`${provider}/${model}`)
    if (exact !== undefined) return { ok: true, price: exact }
  }
  const candidates = snapshot.modelIndex.get(model) ?? []
  const only = candidates.length === 1 ? candidates[0] : undefined
  if (only !== undefined) return { ok: true, price: only }
  if (candidates.length === 0) return { ok: false, reason: 'unknown-model' }
  return { ok: false, reason: 'ambiguous-model' }
}

/** Result of the cost math. */
export type CostResult = { ok: true; usd: number } | { ok: false; reason: 'missing-cache-price' }

/**
 * Cost of one model's token counts.
 *
 * Cache tokens are billed at their own rate; when the catalog has no cache rate
 * the row is unpriced instead of being charged at the input rate or at zero.
 */
export function computeModelCost(price: ModelPrice, tokens: TokenAmounts): CostResult {
  let usd = (tokens.input * price.inputPerMTok + tokens.output * price.outputPerMTok) / 1_000_000
  if (tokens.cacheRead > 0) {
    const rate = price.cacheReadPerMTok
    if (rate === undefined) return { ok: false, reason: 'missing-cache-price' }
    usd += (tokens.cacheRead * rate) / 1_000_000
  }
  if (tokens.cacheWrite > 0) {
    const rate = price.cacheWritePerMTok
    if (rate === undefined) return { ok: false, reason: 'missing-cache-price' }
    usd += (tokens.cacheWrite * rate) / 1_000_000
  }
  return { ok: true, usd }
}
