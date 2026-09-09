/**
 * Pure provider stream usage tracker.
 *
 * The tracker stores only complete exact provider snapshots. It has no timers,
 * polling, persistence, TUI dependency, provider client, credential fallback,
 * token/cost estimation, or compaction/FSM integration.
 *
 * @module provider-stream-tracker
 */

import {
  type ProviderUsageEvent,
  type ProviderUsageSnapshot,
  USAGE_STATUS,
  type UsageStatus,
  validateProviderUsageEvent,
} from './provider-capabilities.ts'

export type TrackerUpdateReason = 'PUBLISHED' | 'DUPLICATE' | 'STALE' | 'OUT_OF_SCOPE' | 'INVALID'

export interface ProviderStreamTrackerOptions {
  /** Optional exact stream scope. Events from another stream are unsupported. */
  sessionId?: string
  providerId?: string
  modelId?: string
  /** Injectable sink called only after a complete snapshot is stored. */
  onSnapshot?: (snapshot: ProviderUsageSnapshot) => void
}

export interface ProviderStreamTrackerResult {
  status: UsageStatus
  published: boolean
  reason: TrackerUpdateReason
  snapshot?: ProviderUsageSnapshot
}

export interface ProviderStreamTracker {
  /** Ingest one raw event without coercion or heuristic recovery. */
  ingest(input: unknown): ProviderStreamTrackerResult
  /** Read one complete snapshot for an isolated session/provider/model stream. */
  getSnapshot(
    sessionId: string,
    providerId: string,
    modelId: string,
  ): ProviderUsageSnapshot | undefined
  /** Read all complete snapshots, each isolated by stream identity. */
  snapshots(): ProviderUsageSnapshot[]
  /** Remove all in-memory stream state. */
  clear(): void
}

interface StreamState {
  snapshot: ProviderUsageSnapshot
  eventIds: Set<string>
  partIds: Set<string>
  orderKind?: 'sequence' | 'observedAt'
  orderValue?: number
}

function streamKey(sessionId: string, providerId: string, modelId: string): string {
  return JSON.stringify([sessionId, providerId, modelId])
}

function copySnapshot(snapshot: ProviderUsageSnapshot): ProviderUsageSnapshot {
  const copy: ProviderUsageSnapshot = {
    eventId: snapshot.eventId,
    partId: snapshot.partId,
    sessionId: snapshot.sessionId,
    providerId: snapshot.providerId,
    modelId: snapshot.modelId,
    usage: { ...snapshot.usage },
    limit: { ...snapshot.limit },
  }
  if (snapshot.resetAt !== undefined) copy.resetAt = snapshot.resetAt
  if (snapshot.sequence !== undefined) copy.sequence = snapshot.sequence
  if (snapshot.observedAt !== undefined) copy.observedAt = snapshot.observedAt
  return copy
}

function result(
  status: UsageStatus,
  reason: TrackerUpdateReason,
  snapshot?: ProviderUsageSnapshot,
): ProviderStreamTrackerResult {
  return snapshot === undefined
    ? { status, published: false, reason }
    : { status, published: true, reason, snapshot: copySnapshot(snapshot) }
}

function isInScope(event: ProviderUsageEvent, options: ProviderStreamTrackerOptions): boolean {
  return (
    (options.sessionId === undefined || options.sessionId === event.sessionId) &&
    (options.providerId === undefined || options.providerId === event.providerId) &&
    (options.modelId === undefined || options.modelId === event.modelId)
  )
}

function isStale(event: ProviderUsageEvent, state: StreamState): boolean {
  if (event.sequence !== undefined) {
    if (state.orderKind === 'sequence' && state.orderValue !== undefined) {
      return event.sequence <= state.orderValue
    }
    return false
  }

  if (event.observedAt !== undefined) {
    if (state.orderKind === 'observedAt' && state.orderValue !== undefined) {
      return event.observedAt <= state.orderValue
    }
    return state.orderKind === 'sequence'
  }

  return state.orderKind !== undefined
}

function updateOrder(event: ProviderUsageEvent, state: StreamState): void {
  if (event.sequence !== undefined) {
    state.orderKind = 'sequence'
    state.orderValue = event.sequence
  } else if (event.observedAt !== undefined) {
    state.orderKind = 'observedAt'
    state.orderValue = event.observedAt
  }
}

/**
 * Create an in-memory tracker. With no scope options, multiple streams are
 * tracked independently by their session/provider/model identity.
 */
export function createProviderStreamTracker(
  options: ProviderStreamTrackerOptions = {},
): ProviderStreamTracker {
  const streams = new Map<string, StreamState>()

  return {
    ingest(input: unknown): ProviderStreamTrackerResult {
      const event = validateProviderUsageEvent(input)
      if (event === null) return result(USAGE_STATUS.UNSUPPORTED, 'INVALID')
      if (!isInScope(event, options)) return result(USAGE_STATUS.UNSUPPORTED, 'OUT_OF_SCOPE')

      const key = streamKey(event.sessionId, event.providerId, event.modelId)
      const state = streams.get(key)
      if (state?.eventIds.has(event.eventId) || state?.partIds.has(event.partId)) {
        return result(USAGE_STATUS.SUPPORTED, 'DUPLICATE')
      }

      if (state !== undefined && isStale(event, state)) {
        state.eventIds.add(event.eventId)
        state.partIds.add(event.partId)
        return result(USAGE_STATUS.SUPPORTED, 'STALE')
      }

      const nextState: StreamState = state ?? {
        snapshot: event,
        eventIds: new Set<string>(),
        partIds: new Set<string>(),
      }
      nextState.snapshot = event
      nextState.eventIds.add(event.eventId)
      nextState.partIds.add(event.partId)
      updateOrder(event, nextState)
      streams.set(key, nextState)

      const snapshot = copySnapshot(event)
      options.onSnapshot?.(snapshot)
      return result(USAGE_STATUS.SUPPORTED, 'PUBLISHED', snapshot)
    },

    getSnapshot(sessionId: string, providerId: string, modelId: string) {
      const state = streams.get(streamKey(sessionId, providerId, modelId))
      return state === undefined ? undefined : copySnapshot(state.snapshot)
    },

    snapshots() {
      return [...streams.values()].map((state) => copySnapshot(state.snapshot))
    },

    clear() {
      streams.clear()
    },
  }
}
