/**
 * V2 decision contracts — the offline surface of `ask`, `rank` and `verify`.
 *
 * This module is pure and deterministic: no adapter, no provider, no network.
 * It validates the shape of a decision request and resolves an answer that a
 * caller already obtained. Nothing here observes host state or applies a
 * decision, so every result is replayable by the offline harness.
 *
 * Two rules are structural, not stylistic:
 *
 *   - `refusal` is a successful terminal answer. It is reported with
 *     `status: 'refusal'` and never as an error.
 *   - A missing or unusable answer is reported as `failed_to_respond` and is
 *     never promoted to a verdict. During mandatory verification it becomes
 *     `BLOCK` (see `resolveVerify` in `v2-decision-verify.ts`).
 *
 * `ask` questions are independent of each other: {@link evaluateAskAnswer}
 * receives exactly one question, so no earlier answer can supply context.
 *
 * `rank` and `verify` are re-exported from their own modules to keep each file
 * focused on one primitive.
 */

/** Maximum number of named labels in a `choice` question. */
export const ASK_CHOICE_MAX_LABELS = 255
/** Minimum number of ordinal levels in a `score` question. */
export const ASK_SCORE_MIN_LEVELS = 2
/** Maximum number of ordinal levels in a `score` question. */
export const ASK_SCORE_MAX_LEVELS = 10

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export interface NoulQuestion {
  readonly mode: 'noul'
  readonly id: string
  readonly text: string
}

export interface ChoiceQuestion {
  readonly mode: 'choice'
  readonly id: string
  readonly text: string
  readonly labels: readonly string[]
}

export interface ScoreQuestion {
  readonly mode: 'score'
  readonly id: string
  readonly text: string
  readonly levels: number
}

export interface RefusalQuestion {
  readonly mode: 'refusal'
  readonly id: string
  readonly text: string
}

/** Modes that carry a question payload; `refusal` is an answer, not a primitive. */
export type AskMode = NoulQuestion['mode'] | ChoiceQuestion['mode'] | ScoreQuestion['mode']
export type AskQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion | RefusalQuestion

export type AskValidationFailure =
  | 'INVALID_SHAPE'
  | 'UNKNOWN_MODE'
  | 'MISSING_ID'
  | 'MISSING_TEXT'
  | 'EMPTY_LABELS'
  | 'TOO_MANY_LABELS'
  | 'DUPLICATE_LABEL'
  | 'INVALID_LABEL'
  | 'INVALID_LEVELS'

export type AskValidation =
  | { readonly ok: true; readonly question: AskQuestion }
  | { readonly ok: false; readonly code: AskValidationFailure; readonly detail: string }

export interface NoulAnswer {
  readonly kind: 'noul'
  readonly value: 0 | 1
}

export interface ChoiceAnswer {
  readonly kind: 'choice'
  readonly index: number
}

export interface ScoreAnswer {
  readonly kind: 'score'
  readonly level: number
}

export interface RefusalAnswer {
  readonly kind: 'refusal'
}

export type AskAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer | RefusalAnswer

export type AskResolution =
  | { readonly status: 'noul'; readonly questionId: string; readonly value: 0 | 1 }
  | {
      readonly status: 'choice'
      readonly questionId: string
      readonly index: number
      readonly label: string
    }
  | { readonly status: 'score'; readonly questionId: string; readonly level: number }
  | {
      readonly status: 'refusal'
      readonly questionId: string
      readonly reasonCode: 'REFUSAL_MODE' | 'ANSWERED_REFUSAL'
    }
  | {
      readonly status: 'failed'
      readonly questionId: string
      readonly reasonCode: 'FAILED_TO_RESPOND' | 'INVALID_ANSWER' | 'OUT_OF_RANGE'
    }
  | {
      readonly status: 'invalid_question'
      readonly questionId: string
      readonly reasonCode: AskValidationFailure
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isSingleLineLabel(value: unknown): value is string {
  return isNonEmptyString(value) && !hasControlCharacter(value)
}

function questionIdOf(candidate: unknown): string {
  if (isRecord(candidate) && typeof candidate.id === 'string') return candidate.id
  return ''
}

/**
 * Validate one `ask` question.
 *
 * `choice` accepts 1–255 unique single-line labels; `score` accepts 2–10
 * ordinal levels; `noul` is binary by construction; `refusal` carries no
 * payload. A question is never re-interpreted: the mode must match the shape.
 */
export function validateAsk(candidate: unknown): AskValidation {
  if (!isRecord(candidate)) {
    return { ok: false, code: 'INVALID_SHAPE', detail: 'question must be an object' }
  }
  const mode = candidate.mode
  if (mode !== 'noul' && mode !== 'choice' && mode !== 'score' && mode !== 'refusal') {
    return { ok: false, code: 'UNKNOWN_MODE', detail: 'unrecognized ask mode' }
  }
  if (!isToken(candidate.id)) {
    return { ok: false, code: 'MISSING_ID', detail: 'id must be a short token' }
  }
  if (!isNonEmptyString(candidate.text)) {
    return { ok: false, code: 'MISSING_TEXT', detail: 'text must be non-empty' }
  }
  const id = candidate.id
  const text = candidate.text

  if (mode === 'noul') return { ok: true, question: { mode, id, text } }
  if (mode === 'refusal') return { ok: true, question: { mode, id, text } }

  if (mode === 'score') {
    const levels = candidate.levels
    if (
      !Number.isInteger(levels) ||
      (levels as number) < ASK_SCORE_MIN_LEVELS ||
      (levels as number) > ASK_SCORE_MAX_LEVELS
    ) {
      return {
        ok: false,
        code: 'INVALID_LEVELS',
        detail: `levels must be an integer in ${ASK_SCORE_MIN_LEVELS}..${ASK_SCORE_MAX_LEVELS}`,
      }
    }
    return { ok: true, question: { mode, id, text, levels: levels as number } }
  }

  const labels = candidate.labels
  if (!Array.isArray(labels) || labels.length === 0) {
    return { ok: false, code: 'EMPTY_LABELS', detail: 'choice needs at least one label' }
  }
  if (labels.length > ASK_CHOICE_MAX_LABELS) {
    return {
      ok: false,
      code: 'TOO_MANY_LABELS',
      detail: `choice accepts at most ${ASK_CHOICE_MAX_LABELS} labels`,
    }
  }
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const label of labels) {
    if (!isSingleLineLabel(label)) {
      return { ok: false, code: 'INVALID_LABEL', detail: 'labels must be single-line non-empty' }
    }
    const trimmed = label.trim()
    if (seen.has(trimmed)) {
      return { ok: false, code: 'DUPLICATE_LABEL', detail: 'labels must be unique' }
    }
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return { ok: true, question: { mode, id, text, labels: normalized } }
}

/** Escape a label so it cannot break the rendered `index. "label"` line. */
export function escapeAskLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Render validated choice labels as 1-based numbered lines. */
export function renderChoiceLabels(question: ChoiceQuestion): readonly string[] {
  return question.labels.map((label, index) => `${index + 1}. "${escapeAskLabel(label)}"`)
}

/**
 * Resolve one answer against exactly one question.
 *
 * A refusal answer is success for every mode. Anything unrecognized is
 * `failed`, never coerced into the nearest valid value.
 */
export function evaluateAskAnswer(question: unknown, answer: unknown): AskResolution {
  const validation = validateAsk(question)
  if (!validation.ok) {
    return {
      status: 'invalid_question',
      questionId: questionIdOf(question),
      reasonCode: validation.code,
    }
  }
  const spec = validation.question
  if (answer === undefined || answer === null) {
    return { status: 'failed', questionId: spec.id, reasonCode: 'FAILED_TO_RESPOND' }
  }
  if (!isRecord(answer) || typeof answer.kind !== 'string') {
    return { status: 'failed', questionId: spec.id, reasonCode: 'INVALID_ANSWER' }
  }

  if (answer.kind === 'refusal') {
    return {
      status: 'refusal',
      questionId: spec.id,
      reasonCode: spec.mode === 'refusal' ? 'REFUSAL_MODE' : 'ANSWERED_REFUSAL',
    }
  }
  if (spec.mode === 'refusal') {
    return { status: 'failed', questionId: spec.id, reasonCode: 'INVALID_ANSWER' }
  }

  if (spec.mode === 'noul') {
    if (answer.kind !== 'noul' || (answer.value !== 0 && answer.value !== 1)) {
      return { status: 'failed', questionId: spec.id, reasonCode: 'INVALID_ANSWER' }
    }
    return { status: 'noul', questionId: spec.id, value: answer.value }
  }

  if (spec.mode === 'choice') {
    if (answer.kind !== 'choice' || !Number.isInteger(answer.index)) {
      return { status: 'failed', questionId: spec.id, reasonCode: 'INVALID_ANSWER' }
    }
    const index = answer.index as number
    if (index < 1 || index > spec.labels.length) {
      return { status: 'failed', questionId: spec.id, reasonCode: 'OUT_OF_RANGE' }
    }
    const label = spec.labels[index - 1]
    if (label === undefined) {
      return { status: 'failed', questionId: spec.id, reasonCode: 'OUT_OF_RANGE' }
    }
    return { status: 'choice', questionId: spec.id, index, label }
  }

  if (answer.kind !== 'score' || !Number.isInteger(answer.level)) {
    return { status: 'failed', questionId: spec.id, reasonCode: 'INVALID_ANSWER' }
  }
  const level = answer.level as number
  if (level < 1 || level > spec.levels) {
    return { status: 'failed', questionId: spec.id, reasonCode: 'OUT_OF_RANGE' }
  }
  return { status: 'score', questionId: spec.id, level }
}

export * from './v2-decision-rank.ts'
export * from './v2-decision-verify.ts'
