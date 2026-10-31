import { decideForTurn, type TurnDecision, type TurnDecisionInput } from './local-decision-turn.ts'
import { isPantheonAgentId, isPantheonSkillId } from './pantheon-decision-catalog.ts'

const MARKER_PREFIX = '<!-- pantheon-decision-router:v1'
const MARKER_PATTERN = /<!-- pantheon-decision-router:v1\b[^>]*-->/

/** The host sends the *string* `"undefined"` for absent prompt fields (F-08). */
const MEASURED_SENTINELS: ReadonlySet<string> = new Set(['undefined', 'null'])

/** Where the observed skill list came from: the prompt array, the draft, or nowhere. */
export type SkillsSource = 'none' | 'prompt' | 'draft'

/**
 * Why the skill outcome is what it is. Tokens only — no content, no count of
 * user text. Every result carries one, so an empty selection is never silent.
 */
export type PromptApplicationReason =
  | 'invalid.payload'
  | 'request.empty'
  | 'marker.present'
  | 'decision.inactive'
  | 'selection.empty'
  | 'skills.source.prompt'
  | 'skills.source.draft'
  | 'skills.source.absent'
  | 'skills.source.empty'
  | 'skills.source.unstable'
  | 'skills.selection.disjoint'
  | 'skills.synthetic.narrowed'

export interface PromptApplicationResult {
  markerApplied: boolean
  skillsFiltered: boolean
  /** Observable source of the skill list; `none` in the measured host shape (F-08). */
  skillsSource: SkillsSource
  /** Always present: explains the skill outcome, including every empty selection. */
  reason: PromptApplicationReason
}

export interface SkillSourceResolution {
  readonly skillsSource: SkillsSource
  /** Stable identifiers found in the chosen source, deduplicated, in order. */
  readonly skillIds: readonly string[]
  readonly reason: PromptApplicationReason
}

interface SkillNarrowing {
  readonly skillsFiltered: boolean
  readonly skillsSource: SkillsSource
  readonly reason: PromptApplicationReason
}

/** True when the value is the measured placeholder string, not real data. */
function isMeasuredSentinel(value: unknown): boolean {
  return typeof value === 'string' && MEASURED_SENTINELS.has(value)
}

/** Normalize a measured prompt field: a sentinel string or null means "absent". */
export function normalizeMeasuredValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  return isMeasuredSentinel(value) ? undefined : value
}

function skillIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as { name?: unknown; id?: unknown; slug?: unknown }
  for (const candidate of [record.name, record.id, record.slug]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

function identifiers(list: readonly unknown[]): { ids: string[]; unstable: boolean } {
  const ids: string[] = []
  let unstable = false
  for (const item of list) {
    const identifier = skillIdentifier(item)
    if (identifier === undefined) unstable = true
    else if (!ids.includes(identifier)) ids.push(identifier)
  }
  return { ids, unstable }
}

/**
 * Resolve the observed skill list and say where it came from.
 *
 * The prompt list wins when it is a real array. Otherwise the per-turn draft
 * (`ctx.skill.list()`, F-06) is reported as `draft`. The measured host shape
 * carries the sentinel string `"undefined"` (F-08), which is treated as absent.
 */
export function resolveSkillSource(
  promptSkills: unknown,
  draftSkills?: unknown,
): SkillSourceResolution {
  const promptList = normalizeMeasuredValue(promptSkills)
  const draftList = normalizeMeasuredValue(draftSkills)

  if (Array.isArray(promptList) && promptList.length > 0) {
    const resolved = identifiers(promptList)
    return {
      skillsSource: 'prompt',
      skillIds: resolved.ids,
      reason: resolved.unstable ? 'skills.source.unstable' : 'skills.source.prompt',
    }
  }
  if (Array.isArray(draftList) && draftList.length > 0) {
    const resolved = identifiers(draftList)
    return {
      skillsSource: 'draft',
      skillIds: resolved.ids,
      reason: resolved.unstable ? 'skills.source.unstable' : 'skills.source.draft',
    }
  }
  return {
    skillsSource: 'none',
    skillIds: [],
    reason: Array.isArray(promptList) ? 'skills.source.empty' : 'skills.source.absent',
  }
}

/**
 * Best-effort narrowing of the host's pre-resolution skill list.
 *
 * Only a real prompt array can be narrowed, and an empty advisory selection
 * must never erase skills the host or user chose. The measured host shape is
 * the sentinel string (F-08), so this is unreachable on the default path: P2 is
 * an empirical no-op there (F-09). The array shape is synthetic — never
 * observed — and its outcome is not a measured effect (C6 open).
 */
function narrowSkills(
  prompt: Record<string, unknown>,
  selection: readonly string[],
  draftSkills?: unknown,
): SkillNarrowing {
  const resolution = resolveSkillSource(prompt.skills, draftSkills)
  if (selection.length === 0) {
    return {
      skillsFiltered: false,
      skillsSource: resolution.skillsSource,
      reason: 'selection.empty',
    }
  }
  if (resolution.skillsSource !== 'prompt') {
    return {
      skillsFiltered: false,
      skillsSource: resolution.skillsSource,
      reason: resolution.reason,
    }
  }
  if (resolution.skillIds.length === 0) {
    return { skillsFiltered: false, skillsSource: 'prompt', reason: 'skills.source.unstable' }
  }
  const selected = new Set(selection)
  const kept = (prompt.skills as readonly unknown[]).filter((item) => {
    const identifier = skillIdentifier(item)
    return identifier !== undefined && selected.has(identifier)
  })
  if (kept.length === 0) {
    return { skillsFiltered: false, skillsSource: 'prompt', reason: 'skills.selection.disjoint' }
  }
  prompt.skills = kept
  return { skillsFiltered: true, skillsSource: 'prompt', reason: 'skills.synthetic.narrowed' }
}

function buildMarker(decision: TurnDecision): string | null {
  const skillIds = decision.skillIds.filter((id) => isPantheonSkillId(id))
  const agent = decision.agent !== null && isPantheonAgentId(decision.agent) ? decision.agent : null
  if (skillIds.length === 0 && agent === null) return null
  const parts = [`source=${decision.source}`]
  if (skillIds.length > 0) parts.push(`skills=${skillIds.join(',')}`)
  if (agent !== null) parts.push(`agent=${agent}`)
  return `${MARKER_PREFIX} ${parts.join(' ')} -->`
}

/**
 * Apply an advisory decision to the host prompt payload in place. It never
 * dispatches, changes permissions, or removes a pre-existing host marker.
 * `skillsDraft` is the per-turn draft list; it is observed for `skillsSource`
 * and never applied to admission.
 */
export function applyTurnDecisionToPrompt(
  prompt: unknown,
  decision: TurnDecision | null,
  skillsDraft?: unknown,
): PromptApplicationResult {
  const invalid: PromptApplicationResult = {
    markerApplied: false,
    skillsFiltered: false,
    skillsSource: 'none',
    reason: 'invalid.payload',
  }
  if (prompt === null || typeof prompt !== 'object' || Array.isArray(prompt)) return invalid
  if (decision === null || !decision.active) return { ...invalid, reason: 'decision.inactive' }
  const target = prompt as Record<string, unknown>
  const narrowing = narrowSkills(
    target,
    decision.skillIds.filter((id) => isPantheonSkillId(id)),
    skillsDraft,
  )
  const result: PromptApplicationResult = {
    markerApplied: false,
    skillsFiltered: narrowing.skillsFiltered,
    skillsSource: narrowing.skillsSource,
    reason: narrowing.reason,
  }
  if (typeof target.text !== 'string' || target.text.includes(MARKER_PREFIX)) return result
  const marker = buildMarker(decision)
  if (marker === null) return result
  target.text = `${target.text}\n\n${marker}`
  return { ...result, markerApplied: true }
}

/** True when the prompt already carries a decision-router marker. */
export function hasDecisionRouterMarker(text: unknown): boolean {
  return typeof text === 'string' && MARKER_PATTERN.test(text)
}

/**
 * Compute and apply the advisory decision to a host admission payload. The
 * optional `requestText` lets the caller keep Pantheon's own visual context out
 * of the decision input; malformed payloads are a no-op.
 */
export async function applyDecisionRouterToPrompt(
  admission: unknown,
  permissionAssert?: TurnDecisionInput['permissionAssert'],
  requestText?: string,
): Promise<PromptApplicationResult> {
  const none = (reason: PromptApplicationReason): PromptApplicationResult => ({
    markerApplied: false,
    skillsFiltered: false,
    skillsSource: 'none',
    reason,
  })
  if (admission === null || typeof admission !== 'object' || Array.isArray(admission)) {
    return none('invalid.payload')
  }
  const event = admission as { sessionID?: unknown; messageID?: unknown; prompt?: unknown }
  const prompt = event.prompt
  if (prompt === null || typeof prompt !== 'object' || Array.isArray(prompt)) {
    return none('invalid.payload')
  }
  const promptText = (prompt as { text?: unknown }).text
  if (typeof promptText !== 'string' || promptText.trim().length === 0) {
    return none('request.empty')
  }
  const text =
    typeof requestText === 'string' && requestText.trim().length > 0 ? requestText : promptText
  if (hasDecisionRouterMarker(text)) return none('marker.present')
  try {
    const decision = await decideForTurn({
      request: text,
      sessionID: event.sessionID,
      messageID: event.messageID,
      permissionAssert,
    })
    return applyTurnDecisionToPrompt(prompt, decision)
  } catch {
    return none('invalid.payload')
  }
}
