/** OpenCode major-version selection shared by the CLI and installer. */

const VALID_VERSIONS = new Set(['v1', 'v2', 'auto'])

/** @param {string[]} args @returns {'v1'|'v2'|'auto'|null} */
export function parseOpenCodeVersion(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith('--opencode-version=')) return normalize(arg.split('=', 2)[1])
    if (arg === '--opencode-version') return normalize(args[index + 1])
    // --version v1|v2 was supported by 1.4.x. Bare --version remains the
    // package version command and is deliberately not interpreted here.
    if (arg.startsWith('--version=')) return normalize(arg.split('=', 2)[1])
    if (arg === '--version' && args[index + 1]?.startsWith('v')) {
      // Preserve bare --version/package-version compatibility, while making
      // unsupported OpenCode selectors (for example v3) fail loudly.
      return normalize(args[index + 1])
    }
  }
  return null
}

function normalize(value) {
  if (!VALID_VERSIONS.has(value)) {
    throw new Error(`Invalid OpenCode version "${value}" — expected v1, v2, or auto`)
  }
  return value
}

/**
 * Resolve auto conservatively: only an explicit hint selects V2.
 * @param {'v1'|'v2'|'auto'|null|undefined} requested
 * @param {{env?: Record<string, string|undefined>, binary?: string}} [options]
 * @returns {'v1'|'v2'}
 */
export function resolveOpenCodeVersion(requested = 'v1', options = {}) {
  if (!VALID_VERSIONS.has(requested)) {
    throw new Error(`Invalid OpenCode version "${requested}" — expected v1, v2, or auto`)
  }
  if (requested === 'v1' || requested === 'v2') return requested
  const env = options.env ?? process.env
  if (env.OPENCODE_VERSION === 'v1' || env.OPENCODE_VERSION === 'v2') {
    return env.OPENCODE_VERSION
  }
  const binary = options.binary ?? env.OPENCODE_BIN ?? ''
  return /(?:^|[\\/])opencode2(?:\.exe)?$/i.test(binary) ? 'v2' : 'v1'
}
