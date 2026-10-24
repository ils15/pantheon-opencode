import { Plugin } from '@opencode/plugin'
import { Rpc } from '@opencode/plugin/promise/index'
import type { Context } from '@opencode/plugin/promise/plugin'
import type { RpcRegistration } from '@opencode/plugin/promise/rpc'

const CREDENTIAL_CACHE_TTL_MS = 30_000

/** Closed integration allowlist. Add integrations only alongside a reviewed adapter. */
const QUOTA_INTEGRATIONS = {
  anthropic: 'anthropic',
  openai: 'openai',
} as const

type QuotaProvider = keyof typeof QUOTA_INTEGRATIONS
type InMemoryCredential = {
  readonly type: 'oauth' | 'key'
  /** Only OAuth access tokens or API keys are retained; refresh tokens, metadata,
   * configuration, labels, and raw resolved payloads are deliberately discarded. */
  readonly secret: string
}

type CachedCredential = {
  readonly credential: InMemoryCredential
  readonly expiresAt: number
  readonly expiryTimer: ReturnType<typeof setTimeout>
}

const PROVIDER_IDS = Object.keys(QUOTA_INTEGRATIONS) as QuotaProvider[]

const statusSchema = {
  type: 'object',
  properties: {
    provider: { type: 'string', enum: PROVIDER_IDS },
    authentication: { type: 'string', enum: ['connected', 'not_connected', 'unavailable'] },
    quota: { type: 'string', enum: ['not_implemented'] },
  },
  required: ['provider', 'authentication', 'quota'],
  additionalProperties: false,
} as const

const quotaRpc = Rpc.define({
  id: 'pantheon.quota',
  methods: {
    status: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: {
          providers: { type: 'array', items: statusSchema },
        },
        required: ['providers'],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

type CredentialResolver = ReturnType<typeof createCredentialResolver>

/**
 * Resolve only an active, allowlisted credential connection. Cache only the
 * minimal token material in memory for at most 30 seconds. Credential and
 * integration events clear the cache; plugin teardown drops all references.
 */
function createCredentialResolver(context: Context) {
  const cache = new Map<QuotaProvider, CachedCredential>()
  const pending = new Map<QuotaProvider, Promise<InMemoryCredential | undefined>>()
  let generation = 0
  let disposed = false

  function clearCache(): void {
    for (const cached of cache.values()) clearTimeout(cached.expiryTimer)
    cache.clear()
  }

  async function load(provider: QuotaProvider): Promise<InMemoryCredential | undefined> {
    const integrationID = QUOTA_INTEGRATIONS[provider]

    try {
      const listed = await context.integration.list()
      const integration = listed.data.find((candidate) => candidate.id === integrationID)
      if (!integration) return undefined

      const active = await context.integration.connection.active(integrationID)
      if (active?.type !== 'credential' || active.status?.status === 'needs_auth') {
        return undefined
      }
      if (active.method !== 'oauth' && active.method !== 'key') return undefined

      const isListedActiveConnection = integration.connections.some(
        (connection) =>
          connection.type === 'credential' &&
          connection.id === active.id &&
          connection.method === active.method,
      )
      if (!isListedActiveConnection) return undefined

      const resolved = await context.integration.connection.resolve(active)
      if (!resolved) return undefined
      if (active.method === 'oauth' && resolved.type === 'oauth' && resolved.access.length > 0) {
        return { type: 'oauth', secret: resolved.access }
      }
      if (active.method === 'key' && resolved.type === 'key' && resolved.key.length > 0) {
        return { type: 'key', secret: resolved.key }
      }
      return undefined
    } catch {
      // Do not preserve or forward the host error: it may contain provider data.
      throw new Error('Credential resolution failed')
    }
  }

  return {
    async resolve(provider: QuotaProvider): Promise<InMemoryCredential | undefined> {
      if (disposed) return undefined

      const now = Date.now()
      const cached = cache.get(provider)
      if (cached && cached.expiresAt > now) return cached.credential
      if (cached) {
        clearTimeout(cached.expiryTimer)
        cache.delete(provider)
      }

      const existing = pending.get(provider)
      if (existing) return existing

      const startedAtGeneration = generation
      let resolution: Promise<InMemoryCredential | undefined>
      resolution = load(provider)
        .then((credential) => {
          if (disposed || generation !== startedAtGeneration) return undefined
          if (credential) {
            const expiresAt = Date.now() + CREDENTIAL_CACHE_TTL_MS
            const expiryTimer = setTimeout(() => {
              if (cache.get(provider)?.expiryTimer === expiryTimer) cache.delete(provider)
            }, CREDENTIAL_CACHE_TTL_MS)
            expiryTimer.unref()
            cache.set(provider, {
              credential,
              expiresAt,
              expiryTimer,
            })
          }
          return credential
        })
        .finally(() => {
          if (pending.get(provider) === resolution) pending.delete(provider)
        })
      pending.set(provider, resolution)
      return resolution
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

async function getProviderStatus(resolver: CredentialResolver): Promise<{
  providers: Array<{
    provider: QuotaProvider
    authentication: 'connected' | 'not_connected' | 'unavailable'
    quota: 'not_implemented'
  }>
}> {
  const providers = await Promise.all(
    PROVIDER_IDS.map(async (provider) => {
      try {
        const credential = await resolver.resolve(provider)
        return {
          provider,
          authentication: credential ? ('connected' as const) : ('not_connected' as const),
          quota: 'not_implemented' as const,
        }
      } catch {
        return {
          provider,
          authentication: 'unavailable' as const,
          quota: 'not_implemented' as const,
        }
      }
    }),
  )
  return { providers }
}

export default Plugin.define({
  id: 'pantheon.tui.server',
  async setup(context: Context) {
    const resolver = createCredentialResolver(context)
    const eventController = new AbortController()
    const eventTask = (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: eventController.signal })) {
          if (isCredentialInvalidationEvent(event.type)) resolver.invalidate()
        }
      } catch {
        if (!eventController.signal.aborted) resolver.invalidate()
      }
    })()

    let registration: RpcRegistration<typeof quotaRpc>
    try {
      registration = await context.rpc.register(quotaRpc, {
        status: async () => getProviderStatus(resolver),
      })
    } catch (error) {
      eventController.abort()
      resolver.dispose()
      await eventTask
      throw error
    }

    return async () => {
      eventController.abort()
      resolver.dispose()
      await eventTask
      await registration.dispose()
    }
  },
})
