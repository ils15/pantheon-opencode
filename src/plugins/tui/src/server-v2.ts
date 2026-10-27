import { Plugin } from '@opencode/plugin'
import type { Context } from '@opencode/plugin/promise/plugin'
import type { RpcCallContext, RpcRegistration } from '@opencode/plugin/promise/rpc'
import { createGoKeyDiagnostic } from './go-key-diagnostic'
import {
  isOpenAICodexOAuthMethod,
  isOpenCodeConsoleOAuthMethod,
  QUOTA_PROVIDER_CATALOG,
  type QuotaAdapterContext,
  type QuotaMetric,
  runQuotaAdapter,
} from './quota-adapters'
import { queryAlibabaTokenPlanUsage } from './quota-cli'
import {
  type OpenCodeGoRouteKind,
  QUOTA_PROVIDER_IDS,
  type QuotaProviderId,
  quotaRpc,
} from './quota-rpc'

const CREDENTIAL_CACHE_TTL_MS = 30_000
const ADAPTER_CACHE_TTL_MS = 20_000

type ResolvedCredential = {
  readonly method?: 'oauth' | 'key' | 'unsupported'
  readonly routeKind?: OpenCodeGoRouteKind
  /** Only adapters receive this secret; blocked sources retain only method status. */
  readonly secret?: string
  /** OpenCode Go's fixed API-key fallback after its Console OAuth request fails. */
  readonly fallbackSecret?: string
  /** A tiny, non-secret projection of OAuth metadata required by fixed adapters. */
  readonly adapterContext?: QuotaAdapterContext
}
type CachedCredential = {
  readonly result: ResolvedCredential
  readonly expiresAt: number
  readonly expiryTimer: ReturnType<typeof setTimeout>
}
type ProviderStatus = {
  provider: QuotaProviderId
  label: string
  scope: 'account' | 'selected_key' | 'team' | 'session'
  authentication: 'connected' | 'not_connected' | 'unavailable'
  state: 'available' | 'needs_setup' | 'unavailable'
  reason:
    | 'none'
    | 'not_connected'
    | 'unsupported'
    | 'private_endpoint'
    | 'eligibility_unverified'
    | 'runtime_accounting_unavailable'
    | 'cli_identity_unavailable'
    | 'unsupported_credential_method'
    | 'provider_error'
    | 'not_subscribed'
    | 'rate_limited'
    | 'unauthorized'
    | 'forbidden'
    | 'timeout'
    | 'network_error'
    | 'invalid_response'
  retry_after_ms?: number
  route_kind?: OpenCodeGoRouteKind
  metrics: QuotaMetric[]
}

const PROVIDER_IDS = QUOTA_PROVIDER_IDS

function safeMetadataValue(
  metadata: Record<string, unknown> | undefined,
  names: readonly string[],
): string | undefined {
  if (!metadata) return undefined
  for (const name of names) {
    const value = metadata[name]
    if (typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value)) {
      return value
    }
  }
  return undefined
}

function projectAdapterContext(
  provider: QuotaProviderId,
  metadata: unknown,
  methodID: unknown,
): QuotaAdapterContext | undefined {
  if (provider === 'openai') {
    if (isOpenAICodexOAuthMethod(methodID)) return { methodID }
    return undefined
  }
  if (provider === 'opencode-go') {
    if (!isOpenCodeConsoleOAuthMethod(methodID)) return undefined
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return { methodID }
    }
    const record = metadata as Record<string, unknown>
    if (record.orgID === undefined || record.orgID === null) return { methodID }
    if (typeof record.orgID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.orgID)) {
      return undefined
    }
    return { methodID, orgId: record.orgID }
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return undefined
  const record = metadata as Record<string, unknown>
  const projectId = safeMetadataValue(record, ['projectID', 'projectId', 'quotaProjectId'])
  const accountId = safeMetadataValue(record, ['accountID', 'accountId'])
  const orgId = safeMetadataValue(record, ['orgID', 'orgId'])
  if (!projectId && !accountId && !orgId) return undefined
  return {
    ...(projectId ? { projectId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(orgId ? { orgId } : {}),
  }
}

/**
 * Accept only the official OpenCode Console default and its retired alias.
 * The selected Console token is never sent to a credential-supplied host.
 */
function isApprovedOpenCodeConsoleServer(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return true
  const record = metadata as Record<string, unknown>
  if (!Object.hasOwn(record, 'server')) return true
  const server = record.server
  if (typeof server !== 'string' || server.length === 0 || server.length > 2_048) return false
  if (server.trim() !== server) return false

  let url: URL
  try {
    url = new URL(server)
  } catch {
    return false
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return false
  }

  const path = url.pathname.replace(/\/$/, '')
  if (url.hostname === 'opencode.ai') return path === '/console'
  return url.hostname === 'console.opencode.ai' && (path === '' || path === '/console')
}

function routeKindField(
  provider: QuotaProviderId,
  credential?: ResolvedCredential,
  effectiveRouteKind?: OpenCodeGoRouteKind,
): { route_kind?: OpenCodeGoRouteKind } {
  return provider === 'opencode-go'
    ? { route_kind: effectiveRouteKind ?? credential?.routeKind ?? 'none' }
    : {}
}

/**
 * Resolve only listed, selected credential connections in the closed provider
 * catalog. Only the minimum access-token/key field is retained in memory.
 */
function createCredentialResolver(context: Context) {
  const cache = new Map<QuotaProviderId, CachedCredential>()
  const pending = new Map<QuotaProviderId, Promise<ResolvedCredential>>()
  let integrations: Map<string, Set<string>> | undefined
  let integrationListPending: Promise<Map<string, Set<string>>> | undefined
  let generation = 0
  let disposed = false

  function clearCache(): void {
    for (const cached of cache.values()) clearTimeout(cached.expiryTimer)
    cache.clear()
    integrations = undefined
    integrationListPending = undefined
  }

  async function listCredentialConnections(): Promise<Map<string, Set<string>>> {
    if (integrations) return integrations
    if (integrationListPending) return integrationListPending
    const startedAtGeneration = generation
    let request: Promise<Map<string, Set<string>>>
    request = context.integration
      .list()
      .then((value) => {
        const connectionsByIntegration = new Map<string, Set<string>>()
        for (const integration of value.data) {
          const connections = new Set<string>()
          if (Array.isArray(integration.connections)) {
            for (const connection of integration.connections) {
              if (connection.type === 'credential') {
                connections.add(`${connection.id}\0${connection.method}`)
              }
            }
          }
          connectionsByIntegration.set(integration.id, connections)
        }
        if (!disposed && generation === startedAtGeneration) integrations = connectionsByIntegration
        return connectionsByIntegration
      })
      .finally(() => {
        if (integrationListPending === request) integrationListPending = undefined
      })
    integrationListPending = request
    return request
  }

  async function load(provider: QuotaProviderId, goKeyOnly = false): Promise<ResolvedCredential> {
    const definition = QUOTA_PROVIDER_CATALOG[provider]
    // Quota visibility is tied to a selected OpenCode credential connection;
    // local CLI identity is outside that credential context.
    if (definition.source === 'local-cli') return {}
    try {
      const listedConnections = await listCredentialConnections()
      if (provider === 'opencode-go') {
        const activeListed = async (integrationID: string) => {
          const connections = listedConnections.get(integrationID)
          if (!connections || connections.size === 0) return undefined
          const active = await context.integration.connection.active(integrationID)
          if (active?.type !== 'credential' || !connections.has(`${active.id}\0${active.method}`)) {
            return undefined
          }
          return active
        }

        let consoleCredential: ResolvedCredential | undefined
        let unsupportedConsoleLogin = false
        if (!goKeyOnly) {
          let activeConsole: Awaited<ReturnType<typeof activeListed>>
          try {
            activeConsole = await activeListed('opencode')
          } catch {
            // A Console lookup failure must not prevent using a selected Go API key.
          }
          if (activeConsole?.method === 'oauth' && activeConsole.status?.status !== 'needs_auth') {
            try {
              const resolved = await context.integration.connection.resolve(activeConsole)
              if (
                resolved?.type === 'oauth' &&
                resolved.access.trim().length > 0 &&
                isOpenCodeConsoleOAuthMethod(resolved.methodID) &&
                isApprovedOpenCodeConsoleServer(resolved.metadata)
              ) {
                const adapterContext = projectAdapterContext(
                  provider,
                  resolved.metadata,
                  resolved.methodID,
                )
                if (adapterContext) {
                  consoleCredential = {
                    method: 'oauth',
                    secret: resolved.access.trim(),
                    routeKind: 'console_oauth',
                    adapterContext,
                  }
                } else {
                  unsupportedConsoleLogin = true
                }
              } else if (resolved?.type === 'oauth') {
                unsupportedConsoleLogin = true
              }
            } catch {
              // A failed Console sign-in is allowed to fall through to a listed API key.
            }
          } else if (activeConsole?.method === 'oauth') {
            unsupportedConsoleLogin = activeConsole.status?.status !== 'needs_auth'
          }
        }

        let activePrimary: Awaited<ReturnType<typeof activeListed>>
        try {
          activePrimary = await activeListed('opencode-go')
        } catch {
          // An API-key lookup failure must not discard an already resolved Console login.
        }
        const unsupportedPrimaryLogin =
          activePrimary !== undefined && activePrimary.method !== 'key'
        let apiKey: string | undefined
        for (const integrationID of ['opencode-go', 'opencode']) {
          let active: Awaited<ReturnType<typeof activeListed>>
          try {
            active =
              integrationID === 'opencode-go' ? activePrimary : await activeListed(integrationID)
          } catch {
            // A failed key lookup does not invalidate another selected credential.
            continue
          }
          if (!active) continue
          if (goKeyOnly && active.method !== 'key') return {}
          if (active.method !== 'key' || active.status?.status === 'needs_auth') continue
          try {
            const resolved = await context.integration.connection.resolve(active)
            if (resolved?.type === 'key' && resolved.key.trim().length > 0) {
              apiKey = resolved.key.trim()
              break
            }
          } catch {
            // Try the next explicitly selected OpenCode API-key integration.
          }
        }

        if (consoleCredential) {
          return {
            ...consoleCredential,
            ...(apiKey ? { fallbackSecret: apiKey } : {}),
          }
        }
        if (apiKey) return { method: 'key', secret: apiKey, routeKind: 'api_key' }
        if (unsupportedConsoleLogin || unsupportedPrimaryLogin) {
          return { method: 'unsupported', routeKind: 'unsupported' }
        }
        return {}
      }

      const integrationIDs = [
        definition.integrationID,
        ...(definition.fallbackIntegrationIDs ?? []),
      ]
      for (const integrationID of integrationIDs) {
        const integrationConnections = listedConnections.get(integrationID)
        if (!integrationConnections || integrationConnections.size === 0) continue

        const active = await context.integration.connection.active(integrationID)
        if (active?.type !== 'credential') continue
        const isListedActiveConnection = integrationConnections.has(
          `${active.id}\0${active.method}`,
        )
        if (!isListedActiveConnection) continue
        // The manual diagnostic must not even resolve an OAuth connection.
        if (goKeyOnly && active.method !== 'key') return {}
        if (active.status?.status === 'needs_auth') continue

        if (active.method !== 'oauth' && active.method !== 'key') {
          continue
        }
        if (!definition.methods.includes(active.method)) continue

        const resolved = await context.integration.connection.resolve(active)
        if (
          active.method === 'oauth' &&
          resolved?.type === 'oauth' &&
          resolved.access.trim().length > 0
        ) {
          const accessToken = resolved.access
          if (!accessToken) return {}
          if (provider === 'opencode-zen' && !isApprovedOpenCodeConsoleServer(resolved.metadata)) {
            return { method: 'unsupported' }
          }
          const adapterContext = projectAdapterContext(
            provider,
            resolved.metadata,
            resolved.methodID,
          )
          return {
            method: 'oauth',
            ...(definition.adapter ? { secret: accessToken } : {}),
            ...(adapterContext ? { adapterContext } : {}),
          }
        }
        if (active.method === 'key' && resolved?.type === 'key') {
          if (resolved.key.trim().length === 0) return {}
          if (!definition.adapter) return { method: 'key' }
          if (resolved.key.length > 0) return { method: 'key', secret: resolved.key }
        }
        return {}
      }
      return {}
    } catch (error) {
      // Host errors may contain identifiers or provider data; never forward them.
      // The sanitized error alone hides the cause, so keep the original in the server log.
      console.warn('[pantheon-tui quota] credential resolution failed:', error)
      throw new Error('Credential resolution failed')
    }
  }

  return {
    async resolveActiveGoKey(): Promise<string | undefined> {
      if (disposed) return undefined
      // Fresh resolution avoids a stale selected key and never falls back to Console OAuth.
      const startedAtGeneration = generation
      const credential = await load('opencode-go', true)
      if (disposed || generation !== startedAtGeneration) return undefined
      return credential.method === 'key' && credential.routeKind === 'api_key'
        ? credential.secret
        : undefined
    },
    async resolve(provider: QuotaProviderId): Promise<ResolvedCredential> {
      if (disposed) return {}
      const now = Date.now()
      const cached = cache.get(provider)
      if (cached && cached.expiresAt > now) return cached.result
      if (cached) {
        clearTimeout(cached.expiryTimer)
        cache.delete(provider)
      }
      const existing = pending.get(provider)
      if (existing) return existing

      const startedAtGeneration = generation
      let resolution: Promise<ResolvedCredential>
      resolution = load(provider)
        .then((result) => {
          if (disposed || generation !== startedAtGeneration) return {}
          const expiresAt = Date.now() + CREDENTIAL_CACHE_TTL_MS
          const expiryTimer = setTimeout(() => {
            if (cache.get(provider)?.expiryTimer === expiryTimer) cache.delete(provider)
          }, CREDENTIAL_CACHE_TTL_MS)
          expiryTimer.unref()
          cache.set(provider, { result, expiresAt, expiryTimer })
          return result
        })
        .finally(() => {
          if (pending.get(provider) === resolution) pending.delete(provider)
        })
      pending.set(provider, resolution)
      return resolution
    },
    currentGeneration(): number {
      return generation
    },
    isCurrent(version: number): boolean {
      return !disposed && generation === version
    },
    invalidate(): void {
      generation += 1
      clearCache()
      pending.clear()
    },
    dispose(): void {
      disposed = true
      generation += 1
      clearCache()
      pending.clear()
    },
  }
}

function isCredentialInvalidationEvent(type: string): boolean {
  return (
    type === 'credential.updated' ||
    type === 'credential.switched' ||
    type === 'integration.updated'
  )
}

function createAdapterExecutor(
  shutdownSignal: AbortSignal,
  queryCli: typeof queryAlibabaTokenPlanUsage,
) {
  const MAX_CONCURRENCY = 3
  type AdapterOutcome = Awaited<ReturnType<typeof runQuotaAdapter>>
  type PendingAdapter = {
    controller: AbortController
    callers: Set<symbol>
    settled: boolean
    promise: Promise<AdapterOutcome>
  }
  const cache = new Map<QuotaProviderId, { expiresAt: number; result: AdapterOutcome }>()
  const pending = new Map<QuotaProviderId, PendingAdapter>()
  const cooldown = new Map<QuotaProviderId, number>()
  let activeRequests = 0
  let generation = 0
  const waiters: Array<{
    signal: AbortSignal
    resolve: (release: (() => void) | undefined) => void
    onAbort: () => void
  }> = []
  let invalidationController = new AbortController()

  function releaseRequest(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      while (waiters.length > 0) {
        const waiter = waiters.shift()
        if (!waiter) break
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        if (waiter.signal.aborted) {
          waiter.resolve(undefined)
          continue
        }
        waiter.resolve(releaseRequest())
        return
      }
      activeRequests -= 1
    }
  }

  function acquireRequest(signal: AbortSignal): Promise<(() => void) | undefined> {
    if (signal.aborted) return Promise.resolve(undefined)
    if (activeRequests < MAX_CONCURRENCY) {
      activeRequests += 1
      return Promise.resolve(releaseRequest())
    }
    return new Promise((resolve) => {
      const waiter = {
        signal,
        resolve,
        onAbort: () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          resolve(undefined)
        },
      }
      waiters.push(waiter)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  function subscribe(entry: PendingAdapter, requestSignal: AbortSignal): Promise<AdapterOutcome> {
    requestSignal.throwIfAborted()
    const caller = Symbol()
    entry.callers.add(caller)
    return new Promise((resolve, reject) => {
      let detached = false
      const detach = () => {
        if (detached) return
        detached = true
        requestSignal.removeEventListener('abort', onAbort)
        entry.callers.delete(caller)
        if (!entry.settled && entry.callers.size === 0) entry.controller.abort()
      }
      const onAbort = () => {
        detach()
        reject(requestSignal.reason)
      }
      requestSignal.addEventListener('abort', onAbort, { once: true })
      if (requestSignal.aborted) {
        onAbort()
        return
      }
      entry.promise.then(
        (result) => {
          detach()
          resolve(result)
        },
        (error: unknown) => {
          detach()
          reject(error)
        },
      )
    })
  }

  return {
    async run(
      provider: QuotaProviderId,
      secret: string | undefined,
      requestSignal: AbortSignal,
      adapterContext?: QuotaAdapterContext,
      fallbackSecret?: string,
    ) {
      requestSignal.throwIfAborted()
      const now = Date.now()
      const until = cooldown.get(provider)
      if (until !== undefined && until > now) {
        return { reason: 'rate_limited' as const, retryAfterMs: until - now }
      }
      const cached = cache.get(provider)
      if (cached && cached.expiresAt > now) return cached.result
      const existing = pending.get(provider)
      if (existing && !existing.controller.signal.aborted) return subscribe(existing, requestSignal)
      if (existing) pending.delete(provider)

      const startedAtGeneration = generation
      const controller = new AbortController()
      const signal = AbortSignal.any([
        shutdownSignal,
        invalidationController.signal,
        controller.signal,
      ])
      const entry: PendingAdapter = {
        controller,
        callers: new Set(),
        settled: false,
        promise: Promise.resolve({ reason: 'provider_error' }),
      }
      pending.set(provider, entry)
      entry.promise = acquireRequest(signal)
        .then(async (release) => {
          if (!release) return { reason: 'provider_error' as const }
          try {
            return await runQuotaAdapter(
              provider,
              secret,
              signal,
              queryCli,
              adapterContext,
              fallbackSecret,
            )
          } finally {
            release()
          }
        })
        .then((result) => {
          if (generation === startedAtGeneration && !signal.aborted && 'state' in result) {
            cache.set(provider, {
              expiresAt: Date.now() + ADAPTER_CACHE_TTL_MS,
              result,
            })
          } else if (
            generation === startedAtGeneration &&
            'reason' in result &&
            result.reason === 'rate_limited' &&
            result.retryAfterMs !== undefined
          ) {
            cooldown.set(provider, Date.now() + result.retryAfterMs)
          }
          return result
        })
        .finally(() => {
          entry.settled = true
          if (pending.get(provider) === entry) pending.delete(provider)
        })
      return subscribe(entry, requestSignal)
    },
    invalidate(): void {
      generation += 1
      invalidationController.abort()
      invalidationController = new AbortController()
      cache.clear()
      pending.clear()
      cooldown.clear()
    },
  }
}

async function getProviderStatus(
  resolver: ReturnType<typeof createCredentialResolver>,
  adapters: ReturnType<typeof createAdapterExecutor>,
  requestSignal: AbortSignal,
): Promise<{ providers: ProviderStatus[]; credential_resolution_failed?: true }> {
  requestSignal.throwIfAborted()
  let credentialResolutionFailed = false
  const results = await Promise.all(
    PROVIDER_IDS.map(async (provider): Promise<ProviderStatus | undefined> => {
      const definition = QUOTA_PROVIDER_CATALOG[provider]
      try {
        requestSignal.throwIfAborted()
        const credentialGeneration = resolver.currentGeneration()
        let credential: ResolvedCredential
        try {
          credential = await resolver.resolve(provider)
        } catch {
          requestSignal.throwIfAborted()
          credentialResolutionFailed = true
          return undefined
        }
        requestSignal.throwIfAborted()
        if (!credential.method) return undefined
        if (!resolver.isCurrent(credentialGeneration)) {
          return {
            provider,
            label: definition.label,
            scope: definition.scope,
            authentication: 'unavailable',
            state: 'unavailable',
            reason: 'provider_error',
            ...routeKindField(provider, credential),
            metrics: [],
          }
        }
        if (
          credential.method === 'unsupported' ||
          !definition.methods.includes(credential.method)
        ) {
          return {
            provider,
            label: definition.label,
            scope: definition.scope,
            authentication: 'connected',
            state: 'unavailable',
            reason: 'unsupported_credential_method',
            ...routeKindField(provider, credential),
            metrics: [],
          }
        }
        if (!definition.adapter) {
          return {
            provider,
            label: definition.label,
            scope: definition.scope,
            authentication: 'connected',
            state: 'unavailable',
            reason: definition.blockedReason ?? 'unsupported',
            ...routeKindField(provider, credential),
            metrics: [],
          }
        }
        if (!credential.secret) {
          return {
            provider,
            label: definition.label,
            scope: definition.scope,
            authentication: 'unavailable',
            state: 'unavailable',
            reason: 'provider_error',
            ...routeKindField(provider, credential),
            metrics: [],
          }
        }
        const result = await adapters.run(
          provider,
          credential.secret,
          requestSignal,
          credential.adapterContext,
          credential.fallbackSecret,
        )
        requestSignal.throwIfAborted()
        if (!resolver.isCurrent(credentialGeneration)) {
          return {
            provider,
            label: definition.label,
            scope: definition.scope,
            authentication: 'unavailable',
            state: 'unavailable',
            reason: 'provider_error',
            ...routeKindField(provider, credential),
            metrics: [],
          }
        }
        if ('state' in result) {
          return {
            provider,
            label: definition.label,
            scope: definition.scope,
            authentication: 'connected',
            state: 'available',
            reason: 'none',
            ...routeKindField(provider, credential, result.routeKind),
            metrics: result.metrics,
          }
        }
        return {
          provider,
          label: definition.label,
          scope: definition.scope,
          authentication: 'connected',
          state: 'unavailable',
          reason: result.reason,
          ...routeKindField(provider, credential, result.routeKind),
          ...(result.retryAfterMs === undefined
            ? {}
            : { retry_after_ms: Math.ceil(result.retryAfterMs) }),
          metrics: [],
        }
      } catch {
        requestSignal.throwIfAborted()
        return {
          provider,
          label: definition.label,
          scope: definition.scope,
          authentication: 'unavailable',
          state: 'unavailable',
          reason: 'provider_error',
          ...routeKindField(provider),
          metrics: [],
        }
      }
    }),
  )
  const providers = results.filter((provider): provider is ProviderStatus => provider !== undefined)
  return {
    providers,
    ...(credentialResolutionFailed ? { credential_resolution_failed: true as const } : {}),
  }
}

export function createQuotaPlugin(
  queryCli: typeof queryAlibabaTokenPlanUsage = queryAlibabaTokenPlanUsage,
) {
  const goKeyDiagnostic = createGoKeyDiagnostic()
  return Plugin.define({
    id: 'pantheon.tui.server',
    async setup(context: Context) {
      const resolver = createCredentialResolver(context)
      const shutdownController = new AbortController()
      const adapters = createAdapterExecutor(shutdownController.signal, queryCli)
      const eventController = new AbortController()
      let registration: RpcRegistration<typeof quotaRpc> | undefined
      const eventTask = (async () => {
        try {
          for await (const event of context.event.subscribe({ signal: eventController.signal })) {
            if (isCredentialInvalidationEvent(event.type)) {
              resolver.invalidate()
              adapters.invalidate()
              if (registration) {
                try {
                  await registration.events.emit('credentials_changed', {})
                } catch {
                  console.warn(
                    'Quota credential-change notification failed; periodic refresh remains active',
                  )
                }
              }
            }
          }
        } catch {
          if (!eventController.signal.aborted) {
            resolver.invalidate()
            adapters.invalidate()
          }
        }
      })()

      try {
        registration = await context.rpc.register(quotaRpc, {
          go_key_diagnostic: async (_input, callContext) =>
            goKeyDiagnostic(
              () => resolver.resolveActiveGoKey(),
              AbortSignal.any([callContext.signal, shutdownController.signal]),
            ),
          status: async (_input, callContext: RpcCallContext<typeof quotaRpc.methods.status>) =>
            getProviderStatus(resolver, adapters, callContext.signal),
        })
      } catch (error) {
        console.warn('[pantheon-tui quota] quota RPC registration failed:', error)
        eventController.abort()
        shutdownController.abort()
        resolver.dispose()
        adapters.invalidate()
        await eventTask
        throw error
      }

      return async () => {
        eventController.abort()
        shutdownController.abort()
        resolver.dispose()
        adapters.invalidate()
        await eventTask
        await registration?.dispose()
      }
    },
  })
}

export default createQuotaPlugin()
