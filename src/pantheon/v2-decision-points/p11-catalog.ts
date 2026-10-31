/**
 * P11 (catalog) shadow adapter — `ask.choice` over the `tool.transform` draft.
 *
 * The host catalog context was ABSENT at every measured point (F-05) and is not
 * part of this design. The only measured catalog surface is the draft handed to
 * `ctx.tool.transform`: `{ list, get, namespace, add, update, remove }`, with
 * entries carrying `{ name, options, description, input, output, execute, id }`
 * (F-07). The draft is dynamic during a run — 20 host tools, 26 with the plugin
 * and 46 after MCP servers register (PROBE-E §6) — so it is read per invocation
 * and never cached.
 *
 * The adapter only reads: `list()` is called, the six measured members are
 * checked for their measured kind (functions) and nothing is added, updated or
 * removed. A draft that is absent, unreadable or shaped differently from the
 * measured one fails closed with an explicit reason; it never throws into
 * admission.
 *
 * The choice is a real validated question over the draft ids, but shadow has no
 * responder: with no answer the record says `catalog.no.answer` instead of
 * inventing a selection. An answer supplied by a caller is resolved through the
 * shared contract, and even then the draft is not mutated.
 */

import { type ChoiceQuestion, evaluateAskAnswer, validateAsk } from '../v2-decision-contracts.ts'
import {
  observeShadow,
  type ShadowDecision,
  type ShadowRecord,
  type ShadowSink,
} from '../v2-decision-shadow.ts'

export type CatalogSource = 'draft' | 'none'

export interface CatalogPointResult {
  readonly record: ShadowRecord
  /** `draft` when the measured draft shape was present, `none` otherwise. */
  readonly catalogSource: CatalogSource
  /** Draft ids in observed order, de-duplicated; empty on any failure. */
  readonly toolIds: readonly string[]
  /** The validated `choice` question, or `null` when no question could be built. */
  readonly question: ChoiceQuestion | null
  /** Label of the resolved choice, or `null` when none was made. */
  readonly selectedToolId: string | null
  /** Token explaining the decision; always present. */
  readonly reason: string
}

/** Members of the measured `tool.transform` draft (F-07). */
const DRAFT_MEMBERS = ['list', 'get', 'namespace', 'add', 'update', 'remove'] as const
const MAX_LABEL_LENGTH = 120

interface DraftRead {
  readonly ok: boolean
  readonly source: CatalogSource
  readonly ids: readonly string[]
  readonly reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** A label can be rendered in a `choice` line: single line, present, bounded. */
function isLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_LABEL_LENGTH &&
    !hasControlCharacter(value)
  )
}

function fail(source: CatalogSource, reason: string): DraftRead {
  return { ok: false, source, ids: [], reason }
}

/**
 * Read the draft without trusting it.
 *
 * `list` is the only function invoked. A shape that differs from the measured
 * one — including a missing member or a non-function member — is refused before
 * any call, because a draft that cannot be recognised cannot be observed
 * safely.
 */
function readDraft(draft: unknown): DraftRead {
  if (draft === undefined || draft === null) return fail('none', 'draft.absent')
  if (!isRecord(draft)) return fail('none', 'draft.shape.unsupported')
  for (const member of DRAFT_MEMBERS) {
    if (typeof draft[member] !== 'function') return fail('none', 'draft.shape.unsupported')
  }

  const list = draft.list as () => unknown
  let listed: unknown
  try {
    listed = list.call(draft)
  } catch {
    return fail('draft', 'draft.list.error')
  }
  if (!Array.isArray(listed)) return fail('draft', 'draft.list.invalid')

  const ids: string[] = []
  for (const entry of listed) {
    if (!isRecord(entry)) continue
    // `name` is what `remove` takes; `id` is the fallback measured on the entry.
    const identifier = isLabel(entry.name) ? entry.name : isLabel(entry.id) ? entry.id : undefined
    if (identifier !== undefined && !ids.includes(identifier)) ids.push(identifier)
  }
  if (ids.length === 0) return fail('draft', 'draft.entry.unstable')
  return { ok: true, source: 'draft', ids: Object.freeze(ids), reason: 'draft.listed' }
}

/** Contract failure codes are uppercase; record tokens are lower-case dotted. */
function tokenOf(code: string): string {
  return code.toLowerCase().split('_').join('.')
}

interface CatalogDecision {
  readonly decision: ShadowDecision
  readonly question: ChoiceQuestion | null
  readonly selectedToolId: string | null
}

function buildDecision(ids: readonly string[], answer?: unknown): CatalogDecision {
  const validated = validateAsk({
    mode: 'choice',
    id: 'p11.catalog',
    text: 'Select one tool from the measured tool.transform draft.',
    labels: ids,
  })
  if (!validated.ok) {
    return {
      decision: { decision: 'refusal', reason: `catalog.question.${tokenOf(validated.code)}` },
      question: null,
      selectedToolId: null,
    }
  }
  const question = validated.question as ChoiceQuestion
  if (answer === undefined) {
    // Shadow has no responder. Recording the question is the observation; a
    // selection would be a claim the adapter cannot support.
    return {
      decision: { decision: 'unavailable', reason: 'catalog.no.answer' },
      question,
      selectedToolId: null,
    }
  }
  const resolution = evaluateAskAnswer(question, answer)
  if (resolution.status === 'choice') {
    return {
      decision: { decision: 'choice', reason: 'catalog.choice.resolved' },
      question,
      selectedToolId: resolution.label,
    }
  }
  if (resolution.status === 'refusal') {
    return {
      decision: { decision: 'refusal', reason: 'catalog.choice.refused' },
      question,
      selectedToolId: null,
    }
  }
  return {
    decision: { decision: 'refusal', reason: 'catalog.choice.failed' },
    question,
    selectedToolId: null,
  }
}

/**
 * Observe P11 in shadow.
 *
 * @param draft  Host `ctx.tool.transform` draft. Read only; never mutated.
 * @param sink   Optional shadow-record observer.
 * @param answer Optional `ask` answer the caller already obtained.
 */
export function evaluateCatalogPoint(
  draft: unknown,
  sink?: ShadowSink,
  answer?: unknown,
): CatalogPointResult {
  let read: DraftRead
  try {
    read = readDraft(draft)
  } catch {
    read = fail('none', 'draft.read.error')
  }

  let question: ChoiceQuestion | null = null
  let selectedToolId: string | null = null
  const record = observeShadow(
    'P11',
    { catalogSource: read.source, toolIds: read.ok ? read.ids : [] },
    () => {
      if (!read.ok) return { decision: 'refusal', reason: read.reason }
      const decided = buildDecision(read.ids, answer)
      question = decided.question
      selectedToolId = decided.selectedToolId
      return decided.decision
    },
    sink,
  )

  const failed = record.decision === 'unavailable' && record.reason !== 'catalog.no.answer'
  return {
    record,
    catalogSource: failed ? 'none' : read.source,
    toolIds: failed || !read.ok ? [] : read.ids,
    question: failed ? null : question,
    selectedToolId: failed ? null : selectedToolId,
    reason: record.reason,
  }
}
