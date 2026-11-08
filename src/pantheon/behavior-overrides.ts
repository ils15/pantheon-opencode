/**
 * Named-behavior overrides — the user's local layer over the plugin.
 *
 * The registry lives in `src/routing.yml` (`behaviors:`); the override FILES
 * live outside the installer's ownership:
 *   - project:  `<project>/.pantheon/overrides.json`
 *   - global:   `<config-dir>/pantheon-overrides.json`
 * Project entries win per id. The files are never inventoried, so
 * reconcile/uninstall/upgrade never touch them.
 *
 * Pure module: parse, merge, validate. No fs, no plugin imports.
 */

export const OVERRIDE_CONTENT_MAX = 8000
export const OVERRIDE_REASON_MAX = 200

export interface BehaviorSpec {
  id: string
  kind: 'install' | 'runtime'
  owner: string
}

export interface OverrideEntry {
  action: 'disable' | 'replace'
  content?: string
  reason?: string
}

export type EffectiveOverrides = Record<string, OverrideEntry>

export interface ParseResult {
  entries: EffectiveOverrides
  errors: string[]
}

function validateEntry(id: string, value: unknown, label: string, errors: string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label}: "${id}" must be an object`)
    return
  }
  const entry = value as Record<string, unknown>
  for (const key of Object.keys(entry)) {
    if (key !== 'action' && key !== 'content' && key !== 'reason') {
      errors.push(`${label}: "${id}" has unknown key "${key}"`)
    }
  }
  if (entry.action !== 'disable' && entry.action !== 'replace') {
    errors.push(`${label}: "${id}".action must be "disable" or "replace"`)
    return
  }
  if (entry.action === 'replace') {
    const content = entry.content
    if (typeof content !== 'string' || content.length === 0) {
      errors.push(`${label}: "${id}".content is required for action "replace"`)
    } else if (content.length > OVERRIDE_CONTENT_MAX) {
      errors.push(
        `${label}: "${id}".content is ${content.length} chars — over the ${OVERRIDE_CONTENT_MAX}-char cap`,
      )
    }
  }
  if (entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.length > OVERRIDE_REASON_MAX)) {
    errors.push(`${label}: "${id}".reason must be a string of at most ${OVERRIDE_REASON_MAX} chars`)
  }
}

/** Parse one overrides file. Invalid entries are reported, valid ones kept. */
export function parseOverridesFile(raw: string, label = 'overrides'): ParseResult {
  const errors: string[] = []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return { entries: {}, errors: [`${label}: invalid JSON (${(error as Error).message})`] }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { entries: {}, errors: [`${label}: top level must be an object`] }
  }
  const entries: EffectiveOverrides = {}
  for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
    const before = errors.length
    validateEntry(id, value, label, errors)
    if (errors.length === before && value && typeof value === 'object') {
      entries[id] = value as unknown as OverrideEntry
    }
  }
  return { entries, errors }
}

/** Merge global under project: per id, the project entry wins whole. */
export function mergeOverrides(globalRaw?: string, projectRaw?: string): ParseResult {
  const errors: string[] = []
  const effective: EffectiveOverrides = {}
  if (globalRaw !== undefined) {
    const g = parseOverridesFile(globalRaw, 'global overrides')
    errors.push(...g.errors)
    Object.assign(effective, g.entries)
  }
  if (projectRaw !== undefined) {
    const p = parseOverridesFile(projectRaw, 'project overrides')
    errors.push(...p.errors)
    Object.assign(effective, p.entries)
  }
  return { entries: effective, errors }
}

/** Ids present in the overrides but absent from the registry — doctor warns. */
export function unknownBehaviorIds(effective: EffectiveOverrides, registry: readonly BehaviorSpec[]): string[] {
  const known = new Set(registry.map((b) => b.id))
  return Object.keys(effective)
    .filter((id) => !known.has(id))
    .sort()
}

/** install behavior decision: 'skip' (disable) | content (replace) | undefined (canonical). */
export function installDecision(
  effective: EffectiveOverrides,
  registry: readonly BehaviorSpec[],
  id: string,
): 'skip' | { content: string } | undefined {
  const spec = registry.find((b) => b.id === id)
  if (spec === undefined || spec.kind !== 'install') return undefined
  const entry = effective[id]
  if (entry === undefined) return undefined
  if (entry.action === 'disable') return 'skip'
  return { content: entry.content ?? '' }
}

/** runtime behavior: true when a REGISTERED runtime behavior is disabled by override. */
export function isRuntimeDisabled(
  effective: EffectiveOverrides,
  registry: readonly BehaviorSpec[],
  id: string,
): boolean {
  const spec = registry.find((b) => b.id === id)
  if (spec === undefined || spec.kind !== 'runtime') return false
  return effective[id]?.action === 'disable'
}
