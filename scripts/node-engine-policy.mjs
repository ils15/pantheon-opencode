import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MIN_SUPPORTED_NODE_VERSION = '26.3.0'
export const REQUIRED_NODE_ENGINE_RANGE = `>=${MIN_SUPPORTED_NODE_VERSION}`

/** Return actionable, user-managed upgrade guidance for an unsupported runtime. */
export function unsupportedNodeVersionMessage(version) {
  return [
    `❌ Pantheon requires Node.js >= ${MIN_SUPPORTED_NODE_VERSION} (current: ${version})`,
    '   Install and switch with a user-managed Node version manager:',
    `     nvm install ${MIN_SUPPORTED_NODE_VERSION} && nvm use ${MIN_SUPPORTED_NODE_VERSION}`,
    `     fnm install ${MIN_SUPPORTED_NODE_VERSION} && fnm use ${MIN_SUPPORTED_NODE_VERSION}`,
    `     volta install node@${MIN_SUPPORTED_NODE_VERSION}`,
  ].join('\n')
}

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+([\w.-]+))?$/.exec(String(version))
  if (!match) return null
  return { parts: match.slice(1, 4).map(Number), prerelease: match[4] !== undefined }
}

/** Return whether a runtime version meets Pantheon's supported Node floor. */
export function isSupportedNodeVersion(version) {
  const parsed = parseNodeVersion(version)
  const minimum = parseNodeVersion(MIN_SUPPORTED_NODE_VERSION)
  if (!parsed || !minimum || parsed.prerelease) return false
  for (let index = 0; index < minimum.parts.length; index += 1) {
    if (parsed.parts[index] !== minimum.parts[index]) {
      return parsed.parts[index] > minimum.parts[index]
    }
  }
  return true
}

function readJson(root, file, errors) {
  try {
    const document = JSON.parse(readFileSync(join(root, file), 'utf8'))
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error('expected a JSON object')
    }
    return document
  } catch (error) {
    errors.push(`${file}: ${error.message}`)
    return null
  }
}

function checkEngineRange(value, label, errors) {
  if (value !== REQUIRED_NODE_ENGINE_RANGE) {
    errors.push(`${label} must declare engines.node as "${REQUIRED_NODE_ENGINE_RANGE}"`)
  }
}

/** Validate Node support claims in package manifests and their npm locks. */
export function validateNodeEnginePolicy(root) {
  const errors = []
  const rootPackage = readJson(root, 'package.json', errors)
  const tuiPackage = readJson(root, 'src/plugins/tui/package.json', errors)
  const rootLock = readJson(root, 'package-lock.json', errors)
  const tuiLock = readJson(root, 'src/plugins/tui/package-lock.json', errors)

  if (rootPackage) checkEngineRange(rootPackage.engines?.node, 'package.json', errors)
  if (tuiPackage) checkEngineRange(tuiPackage.engines?.node, 'src/plugins/tui/package.json', errors)

  const rootLockPackage = rootLock?.packages?.['']
  if (!rootLockPackage) errors.push('package-lock.json is missing packages[""]')
  else checkEngineRange(rootLockPackage.engines?.node, 'package-lock.json packages[""]', errors)

  const workspacePackage = rootLock?.packages?.['src/plugins/tui']
  if (!workspacePackage) errors.push('package-lock.json is missing the TUI workspace package')
  else checkEngineRange(workspacePackage.engines?.node, 'package-lock.json TUI workspace', errors)

  const tuiLockPackage = tuiLock?.packages?.['']
  if (!tuiLockPackage) errors.push('src/plugins/tui/package-lock.json is missing packages[""]')
  else
    checkEngineRange(
      tuiLockPackage.engines?.node,
      'src/plugins/tui/package-lock.json packages[""]',
      errors,
    )

  return errors
}
