/**
 * component.mjs — Component resolution utilities for the OpenCode installer
 */

/** Available component identifiers */
export const COMPONENT_NAMES = [
  'agents',
  'skills',
  'instructions',
  'prompts',
  'commands',
  'plugins',
  'runtime',
]

/**
 * Parse --components flag into a Set.
 * @param {string|string[]} spec - Comma-separated string or array of component names
 * @returns {Set<string>}
 */
export function resolveComponents(spec) {
  if (Array.isArray(spec)) return new Set(spec)
  return new Set(spec.split(',').map((s) => s.trim()))
}
