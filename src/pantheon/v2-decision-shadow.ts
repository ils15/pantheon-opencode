/**
 * V2 shadow layer — an observable no-op.
 *
 * Shadow mode exists so a decision can be recorded without changing anything
 * the host does. This module makes that property structural:
 *
 *   - the decision function receives a deep copy, frozen, so it cannot mutate
 *     the admission payload even by accident;
 *   - an unclonable payload is never handed to the decision function at all;
 *   - every failure (throw, malformed result, throwing observer) is contained
 *     and reported in the record, never rethrown into admission;
 *   - `effect` is the literal `'none'` on every record, with no branch that can
 *     set anything else.
 *
 * The record is `{ point, decision, effect: 'none', reason }`. A sink observes
 * it; the sink cannot change the outcome because there is no outcome to change.
 */

import type { DecisionPointId } from './v2-decision-registry.ts'

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const UNCLONABLE = Symbol('unclonable-payload')

export interface ShadowRecord {
  readonly point: string
  readonly decision: string
  readonly effect: 'none'
  readonly reason: string
}

/** Observer of shadow records. Errors thrown here are swallowed. */
export type ShadowSink = (record: ShadowRecord) => void

export interface ShadowDecision {
  readonly decision: string
  readonly reason: string
}

export type ShadowDecisionFunction = (payload: unknown) => ShadowDecision

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

function isolate(payload: unknown): unknown | typeof UNCLONABLE {
  try {
    return structuredClone(payload)
  } catch {
    return UNCLONABLE
  }
}

function deepFreeze(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen)
  }
  Object.freeze(value)
}

function record(point: string, decision: string, reason: string): ShadowRecord {
  return Object.freeze({
    point: isToken(point) ? point : 'unknown-point',
    decision: isToken(decision) ? decision : 'unavailable',
    effect: 'none' as const,
    reason: isToken(reason) ? reason : 'invalid_record',
  })
}

/**
 * Evaluate a decision in shadow mode.
 *
 * @param point  Registry point id (validated; an invalid id is recorded as
 *               `unknown-point`).
 * @param payload Admission payload. Never mutated, never passed by reference.
 * @param decide Decision function evaluated against an isolated frozen copy.
 * @param sink   Optional observer; its failures never reach the caller.
 */
export function observeShadow(
  point: string | DecisionPointId,
  payload: unknown,
  decide: ShadowDecisionFunction,
  sink?: ShadowSink,
): ShadowRecord {
  const isolated = isolate(payload)
  if (isolated === UNCLONABLE) {
    return record(String(point), 'unavailable', 'payload_not_clonable')
  }
  deepFreeze(isolated)

  let decision: string
  let reason: string
  try {
    const result = decide(isolated)
    if (
      result !== null &&
      typeof result === 'object' &&
      isToken(result.decision) &&
      isToken(result.reason)
    ) {
      decision = result.decision
      reason = result.reason
    } else {
      decision = 'unavailable'
      reason = 'invalid_decision'
    }
  } catch {
    decision = 'unavailable'
    reason = 'decision_error'
  }

  const shadowRecord = record(String(point), decision, reason)
  if (sink) {
    try {
      sink(shadowRecord)
    } catch {
      // An observer failure must not become an admission failure.
    }
  }
  return shadowRecord
}
