import { decideForTurn, type TurnDecision, type TurnDecisionInput } from './local-decision-turn.ts'
import { isPantheonAgentId, isPantheonSkillId } from './pantheon-decision-catalog.ts'

const MARKER_PREFIX = '<!-- pantheon-decision-router:v1'
const MARKER_PATTERN = /<!-- pantheon-decision-router:v1\b[^>]*-->/

export interface PromptApplicationResult {
  markerApplied: boolean
  skillsFiltered: boolean
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

/**
 * Best-effort rewrite of the host's pre-resolution skill list. If the host
 * list is absent/empty, has no stable identifiers, or the advisory selection is
 * empty or does not intersect the host list, everything is left untouched: an
 * empty advisory selection must never erase skills the host or user chose. This
 * is not measured as a token saving; it only narrows what the host may offer
 * for this turn.
 */
function filterSkills(prompt: Record<string, unknown>, skillIds: readonly string[]): boolean {
  const skills = prompt.skills
  if (!Array.isArray(skills) || skills.length === 0) return false
  if (skillIds.length === 0) return false
  const identifiers = skills.map(skillIdentifier)
  if (identifiers.some((identifier) => identifier === undefined)) return false
  const selected = new Set(skillIds)
  const filtered = skills.filter((_, index) => {
    const identifier = identifiers[index]
    return identifier !== undefined && selected.has(identifier)
  })
  if (filtered.length === 0) return false
  prompt.skills = filtered
  return true
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
 */
export function applyTurnDecisionToPrompt(
  prompt: unknown,
  decision: TurnDecision | null,
): PromptApplicationResult {
  const result: PromptApplicationResult = { markerApplied: false, skillsFiltered: false }
  if (
    prompt === null ||
    typeof prompt !== 'object' ||
    Array.isArray(prompt) ||
    decision === null ||
    !decision.active
  ) {
    return result
  }
  const target = prompt as Record<string, unknown>
  result.skillsFiltered = filterSkills(
    target,
    decision.skillIds.filter((id) => isPantheonSkillId(id)),
  )
  if (typeof target.text !== 'string' || target.text.includes(MARKER_PREFIX)) return result
  const marker = buildMarker(decision)
  if (marker === null) return result
  target.text = `${target.text}\n\n${marker}`
  result.markerApplied = true
  return result
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
  const none: PromptApplicationResult = { markerApplied: false, skillsFiltered: false }
  if (admission === null || typeof admission !== 'object' || Array.isArray(admission)) return none
  const event = admission as { sessionID?: unknown; messageID?: unknown; prompt?: unknown }
  const prompt = event.prompt
  if (prompt === null || typeof prompt !== 'object' || Array.isArray(prompt)) return none
  const promptText = (prompt as { text?: unknown }).text
  if (typeof promptText !== 'string' || promptText.trim().length === 0) return none
  const text =
    typeof requestText === 'string' && requestText.trim().length > 0 ? requestText : promptText
  if (hasDecisionRouterMarker(text)) return none
  try {
    const decision = await decideForTurn({
      request: text,
      sessionID: event.sessionID,
      messageID: event.messageID,
      permissionAssert,
    })
    return applyTurnDecisionToPrompt(prompt, decision)
  } catch {
    return none
  }
}
