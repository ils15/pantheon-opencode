const DEFAULT_INSTALL_COMPONENTS = ['agents', 'skills', 'instructions', 'commands', 'plugins']
const KNOWN_COMPONENTS = ['agents', 'skills', 'instructions', 'commands', 'plugins', 'runtime']

/**
 * Resolve CLI component flags without widening an explicit component selection.
 *
 * @param {string[]} args CLI arguments
 * @param {{ reviewedComponents?: string[] | null }} [options]
 * @returns {{ components: string[], requestedComponentsForPrompt: string[] | null }}
 */
export function resolveComponentSelection(args, { reviewedComponents = null } = {}) {
  const noMcp = args.includes('--no-mcp')
  if (reviewedComponents !== null) {
    return {
      components: [...reviewedComponents],
      requestedComponentsForPrompt: null,
      noMcp,
    }
  }

  const componentsIndex = args.indexOf('--components')
  const inlineComponents = args.find((arg) => arg.startsWith('--components='))
  const componentsOpt =
    componentsIndex >= 0
      ? (args[componentsIndex + 1] ?? null)
      : (inlineComponents?.split('=', 2)[1] ?? null)

  let explicitComponents = null
  if (componentsOpt !== null) {
    explicitComponents = componentsOpt
      .split(',')
      .map((component) => component.trim())
      .filter(Boolean)
    const unknown = explicitComponents.filter((component) => !KNOWN_COMPONENTS.includes(component))
    if (explicitComponents.length === 0 || unknown.length > 0) {
      throw new Error(
        `Invalid --components "${componentsOpt}" — expected comma-separated names from: ${KNOWN_COMPONENTS.join(', ')}`,
      )
    }
  }

  const components = explicitComponents ? [...explicitComponents] : [...DEFAULT_INSTALL_COMPONENTS]
  if (noMcp) {
    return {
      components: components.filter((component) => component !== 'runtime'),
      requestedComponentsForPrompt: explicitComponents
        ? explicitComponents.filter((component) => component !== 'runtime')
        : null,
      noMcp,
    }
  }

  // Runtime is a default only for an unscoped install. Explicit --components
  // remains the user's exact scope; runtime can still be requested by name.
  if (explicitComponents === null && !components.includes('runtime')) components.push('runtime')
  return {
    components,
    requestedComponentsForPrompt: explicitComponents ? [...explicitComponents] : null,
    noMcp,
  }
}
