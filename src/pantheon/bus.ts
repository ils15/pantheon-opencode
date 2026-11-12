/**
 * Pantheon Event Bus (pantheon-bus) — In-memory reactive event system.
 *
 * Eliminates disk I/O and polling loops for inter-agent communication,
 * background job tracking, and reactive verification.
 *
 * Process-global singleton anchored in globalThis.__pantheonSharedBus,
 * matching the dual-plugin deduplication architecture in shared-board.ts.
 *
 * Pure TypeScript — zero external dependencies.
 *
 * @module bus
 */

export interface JobEventPayload {
  readonly taskID: string
  readonly alias: string
  readonly agent: string
  readonly timestamp: number
  readonly parentSessionID?: string | undefined
  readonly state?: string | undefined
  readonly resultSummary?: string | null | undefined
}

export interface ThemisReflexEventPayload {
  readonly taskID: string
  readonly agent: string
  readonly file: string
  readonly error: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly timestamp: number
  readonly resolved?: boolean | undefined
}

export interface ExecutionReceiptPayload {
  readonly receiptId: string
  readonly taskID: string
  readonly agent: string
  readonly status: 'VERIFIED' | 'UNVERIFIED' | 'FAILED'
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly hash: string
    readonly sizeBytes: number
  }>
  readonly testSlice?:
    | { readonly command: string; readonly exitCode: number; readonly durationMs: number }
    | undefined
  readonly timestamp: number
  readonly signature: string
}

export interface PantheonEventMap {
  'job:created': JobEventPayload
  'job:updated': JobEventPayload
  'job:terminal': JobEventPayload
  'job:reconciled': { readonly taskID: string; readonly alias: string; readonly timestamp: number }
  'themis:reflex:discrepancy': ThemisReflexEventPayload
  'themis:reflex:resolved': ThemisReflexEventPayload
  'agent:execution:receipt': ExecutionReceiptPayload
}

export type PantheonEventName = keyof PantheonEventMap

// biome-ignore lint/suspicious/noExplicitAny: internal heterogeneous event listener storage
type AnyListener = (payload: any) => void | Promise<void>

export class PantheonBus {
  private readonly listeners: Map<string, Set<AnyListener>> = new Map()

  /**
   * Register a persistent listener for an event.
   * Returns an unsubscribe callback for easy cleanup.
   */
  on<E extends PantheonEventName>(
    event: E,
    listener: (payload: PantheonEventMap[E]) => void | Promise<void>,
  ): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set?.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  /**
   * Register a one-shot listener that unregisters itself after firing once.
   */
  once<E extends PantheonEventName>(
    event: E,
    listener: (payload: PantheonEventMap[E]) => void | Promise<void>,
  ): () => void {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe()
      return listener(payload)
    })
    return unsubscribe
  }

  /**
   * Synchronously emit an event to all registered listeners.
   * Listener rejections are logged safely without throwing.
   */
  emit<E extends PantheonEventName>(event: E, payload: PantheonEventMap[E]): void {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return
    for (const listener of Array.from(set)) {
      try {
        const result = listener(payload)
        if (result instanceof Promise) {
          result.catch(() => {})
        }
      } catch {
        // Safe swallow: an in-memory listener crash must not fail the emitter
      }
    }
  }

  /**
   * Wait asynchronously for a specific event matching a predicate, with an optional timeout.
   */
  waitFor<E extends PantheonEventName>(
    event: E,
    predicate: (payload: PantheonEventMap[E]) => boolean,
    timeoutMs = 30_000,
  ): Promise<PantheonEventMap[E]> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      let unsubscribe: (() => void) | null = null

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          unsubscribe?.()
          reject(new Error(`Timed out waiting for bus event "${event}" after ${timeoutMs}ms`))
        }, timeoutMs)
      }

      unsubscribe = this.on(event, (payload) => {
        try {
          if (predicate(payload)) {
            if (timer) clearTimeout(timer)
            unsubscribe?.()
            resolve(payload)
          }
        } catch (err) {
          if (timer) clearTimeout(timer)
          unsubscribe?.()
          reject(err)
        }
      })
    })
  }

  /** Number of active listeners for a specific event or in total. */
  listenerCount(event?: PantheonEventName): number {
    if (event) {
      return this.listeners.get(event)?.size ?? 0
    }
    let total = 0
    for (const set of this.listeners.values()) {
      total += set.size
    }
    return total
  }

  /** Clear all listeners (primarily for unit tests). */
  clear(): void {
    this.listeners.clear()
  }
}

const BUS_KEY = '__pantheonSharedBus'

/**
 * Access the process-global PantheonBus singleton.
 */
export function getSharedBus(): PantheonBus {
  const host = globalThis as { [BUS_KEY]?: PantheonBus }
  if (host[BUS_KEY] instanceof PantheonBus) return host[BUS_KEY]
  const bus = new PantheonBus()
  host[BUS_KEY] = bus
  return bus
}
