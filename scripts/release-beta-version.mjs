#!/usr/bin/env node
/**
 * release-beta-version.mjs — beta version helpers.
 *
 * The beta version is committed in the manifests (package.json) and never
 * computed at release time. `nextBetaVersion` advances the committed version:
 *
 *   X.Y.Z-beta.N  ->  X.Y.Z-beta.(N+1)     (stay on the current beta line)
 *   X.Y.Z         ->  X.Y.(Z+1)-beta.1     (start a fresh beta line)
 *
 * `applyBetaVersion` writes an already-decided beta version into every
 * manifest and is retained for recovery tooling. The legacy PR+SHA scheme
 * (`X.Y.Z-beta.<pr>.<sha7>`) is accepted by validation for backward
 * compatibility only; it is no longer generated.
 */

import {
  SEMVER_PATTERN,
  validateInventory,
  writeInventoryVersion,
} from './manifest-inventory.mjs'

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// Current committed sequential beta line.
const BETA_LINE = /^(\d+\.\d+\.\d+)-beta\.(\d+)$/
// Legacy PR+SHA beta scheme, accepted for recovery only.
const LEGACY_BETA =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*\.[0-9a-f]{7}$/
const BETA_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/

export function nextStableVersion(latest, intent = 'patch') {
  const match = STABLE.exec(String(latest).trim())
  if (!match) throw new Error(`latest is not a stable semver: "${latest}"`)
  if (!['patch', 'minor', 'major'].includes(intent)) {
    throw new Error(`release intent must be patch, minor, or major: "${intent}"`)
  }
  const [major, minor, patch] = match.slice(1).map(Number)
  if (intent === 'major') return `${major + 1}.0.0`
  if (intent === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/**
 * Next beta version derived from the committed manifest version.
 *
 * @param {string} current committed version (e.g. "1.5.0-beta.2")
 * @returns {string} the next sequential beta (e.g. "1.5.0-beta.3")
 */
export function nextBetaVersion(current) {
  const value = String(current).trim()
  const line = BETA_LINE.exec(value)
  if (line) return `${line[1]}-beta.${Number(line[2]) + 1}`

  const stable = STABLE.exec(value)
  if (stable) return `${nextStableVersion(value, 'patch')}-beta.1`

  // Any other prerelease (e.g. 1.5.0-rc.1): beta the next patch of its base.
  const base = /^(\d+\.\d+\.\d+)-[0-9A-Za-z.-]+$/.exec(value)
  if (!base) throw new Error(`cannot derive a beta version from: "${current}"`)
  return `${nextStableVersion(base[1], 'patch')}-beta.1`
}

function validateReleaseVersion(version) {
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`invalid release semver: "${version}"`)
  }
  if (!BETA_RELEASE.test(version) && !LEGACY_BETA.test(version)) {
    throw new Error(
      `release version must be <base>-beta.<N> or legacy <base>-beta.<pr>.<7-char-sha>: "${version}"`,
    )
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
