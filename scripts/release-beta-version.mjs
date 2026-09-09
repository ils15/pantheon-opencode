#!/usr/bin/env node
/** Compute and apply a fail-closed beta version for a release PR. */

import {
  MANIFEST_INVENTORY,
  SEMVER_PATTERN,
  validateInventory,
  writeInventoryVersion,
} from './manifest-inventory.mjs'

// Kept as a public compatibility API. The shared inventory is authoritative.
export const MANIFESTS = Object.freeze(
  MANIFEST_INVENTORY.filter(({ role }) => role === 'manifest').map(({ file, kind }) => ({
    file,
    kind,
  })),
)

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BASELINE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const FULL_SHA = /^[0-9a-f]{40}$/i
const BETA_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*\.[0-9a-f]{7}$/

function parseBaseline(version) {
  const value = String(version).trim()
  const match = BASELINE.exec(value)
  if (!match) throw new Error(`npm latest is not a valid semver baseline: "${version}"`)
  const components = match.slice(1, 4).map(Number)
  if (components.some((component) => !Number.isSafeInteger(component))) {
    throw new Error(`npm latest has an unsafe semver component: "${version}"`)
  }
  return { stable: components.join('.'), prerelease: match[4] ?? null }
}

export function nextStableVersion(latest, intent = 'patch') {
  const match = STABLE.exec(String(latest).trim())
  if (!match) throw new Error(`npm latest is not a stable semver: "${latest}"`)
  if (!['patch', 'minor', 'major'].includes(intent)) {
    throw new Error(`release intent must be patch, minor, or major: "${intent}"`)
  }
  const [major, minor, patch] = match.slice(1).map(Number)
  if (intent === 'major') return `${major + 1}.0.0`
  if (intent === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function betaVersion(latest, intent = 'patch', pr, sha) {
  if (!/^[1-9]\d*$/.test(String(pr)) || !Number.isSafeInteger(Number(pr))) {
    throw new Error(`invalid PR number: "${pr}"`)
  }
  const normalizedSha = String(sha).trim().toLowerCase()
  if (!FULL_SHA.test(normalizedSha)) throw new Error(`invalid full commit SHA: "${sha}"`)

  const baseline = parseBaseline(latest)
  const baseVersion = baseline.prerelease
    ? intent === 'patch'
      ? baseline.stable
      : nextStableVersion(baseline.stable, intent)
    : nextStableVersion(baseline.stable, intent)
  return `${baseVersion}-beta.${pr}.${normalizedSha.slice(0, 7)}`
}

function validateReleaseVersion(version) {
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`invalid release semver: "${version}"`)
  }
  if (!BETA_RELEASE.test(version)) {
    throw new Error(`recovery version must be a lowercase seven-character beta SHA: "${version}"`)
  }
}

/** Preflight all six entries, then update metadata only. */
export function applyBetaVersion(root, version) {
  validateReleaseVersion(version)
  const inventory = validateInventory(root, { allowVersionDivergence: true })
  writeInventoryVersion(inventory, version)
  const after = validateInventory(root)
  if (after.sourceVersion !== version) throw new Error('beta version post-write validation failed')
}

function parseArgs(args) {
  return new Map(
    args.map((arg) => {
      const [key, ...value] = arg.split('=')
      return [key.replace(/^--/, ''), value.join('=')]
    }),
  )
}

const args = parseArgs(process.argv.slice(2))
if (args.has('latest') || args.has('version')) {
  try {
    const version = args.has('version')
      ? args.get('version')
      : betaVersion(
          args.get('latest'),
          args.get('intent') || 'patch',
          args.get('pr'),
          args.get('sha'),
        )
    if (args.has('apply')) applyBetaVersion(process.cwd(), version)
    else if (args.has('apply-version')) applyBetaVersion(process.cwd(), args.get('apply-version'))
    console.log(version)
  } catch (error) {
    console.error(`release-beta-version: ${error.message}`)
    process.exit(1)
  }
} else if (process.argv[1]?.endsWith('release-beta-version.mjs')) {
  console.error('release-beta-version: --latest or --version is required')
  process.exit(1)
}
