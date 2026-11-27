/**
 * Session-scoped File Lease Registry (`file-leases.ts`).
 *
 * Enforces `ownedFiles` and `forbiddenFiles` boundaries per `sessionID` across
 * mutating edit tools and shell write commands. Stored on `globalThis` so
 * dual-loaded plugin/module instances share the same lease table.
 *
 * @module pantheon/file-leases
 */

import path from 'node:path'

const LEASE_REGISTRY_KEY = '__pantheonFileLeases' as const
/**
 * Secondary slot for the registry.
 *
 * `__pantheonFileLeases` is also used by callers that expect a *hook object*
 * (`{ acquireFileLease, releaseFileLease }`) rather than the registry Map. When
 * such an object occupies the primary key, the registry lives here instead of
 * overwriting it — both shapes coexist, and neither silently disables the other.
 */
const LEASE_REGISTRY_FALLBACK_KEY = '__pantheonFileLeaseRegistry' as const
const WINDOWS_DRIVE_RE = /^([a-zA-Z]):\//

export interface FileLeaseInput {
  readonly role: string
  readonly ownedFiles?: readonly string[]
  readonly forbiddenFiles?: readonly string[]
  readonly rootDir: string
}

export interface FileLeaseRecord {
  readonly sessionID: string
  readonly role: string
  readonly rootDir: string
  readonly ownedFiles: readonly string[]
  readonly forbiddenFiles: readonly string[]
  readonly normalizedOwned: readonly string[]
  readonly normalizedForbidden: readonly string[]
}

export interface FileLeaseCheckResult {
  readonly allowed: boolean
  readonly reason?: string
  readonly owner?: string
  readonly targetPath?: string
  readonly allowedFiles?: readonly string[]
}

function getLeaseRegistry(): Map<string, FileLeaseRecord> {
  const host = globalThis as {
    [LEASE_REGISTRY_KEY]?: unknown
    [LEASE_REGISTRY_FALLBACK_KEY]?: unknown
  }
  const primary = host[LEASE_REGISTRY_KEY]
  if (primary instanceof Map) return primary as Map<string, FileLeaseRecord>
  const fallback = host[LEASE_REGISTRY_FALLBACK_KEY]
  if (fallback instanceof Map) return fallback as Map<string, FileLeaseRecord>
  const registry = new Map<string, FileLeaseRecord>()
  // Keep the historical slot when it is free (tests and older plugins read it
  // directly); otherwise hold the registry beside the hook object.
  if (primary === undefined) {
    host[LEASE_REGISTRY_KEY] = registry
  } else {
    host[LEASE_REGISTRY_FALLBACK_KEY] = registry
  }
  return registry
}

function isAbsoluteAnyPlatform(forwardPath: string): boolean {
  return (
    forwardPath.startsWith('/') ||
    WINDOWS_DRIVE_RE.test(forwardPath) ||
    forwardPath.startsWith('//')
  )
}

function stripTrailingSlash(forwardPath: string): string {
  if (forwardPath === '/' || /^[a-zA-Z]:\/$/.test(forwardPath)) {
    return forwardPath
  }
  return forwardPath.replace(/\/+$/, '')
}

function canonicalizeForwardPath(raw: string): string {
  const forward = raw.replace(/\\/g, '/')
  const normalized = path.posix.normalize(forward)
  const driveNormalized = normalized.replace(
    WINDOWS_DRIVE_RE,
    (_m, drive: string) => `${drive.toLowerCase()}:/`,
  )
  return stripTrailingSlash(driveNormalized)
}

/**
 * Normalize a file path against `rootDir`, handling both POSIX `/` and Windows `\`
 * separators as well as relative paths, `.` / `..` segments, and drive letters.
 */
export function normalizeLeasePath(rawPath: string, rootDir: string): string {
  const trimmed = rawPath.trim()
  const normRoot = canonicalizeForwardPath(rootDir.trim() || '.')
  const forwardRaw = trimmed.replace(/\\/g, '/')
  if (!forwardRaw) return normRoot
  if (isAbsoluteAnyPlatform(forwardRaw)) {
    return canonicalizeForwardPath(forwardRaw)
  }
  return canonicalizeForwardPath(`${normRoot}/${forwardRaw}`)
}

function toDisplayPath(normalizedTarget: string, normalizedRoot: string): string {
  if (normalizedTarget === normalizedRoot) return '.'
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
  if (normalizedTarget.startsWith(prefix)) {
    return normalizedTarget.slice(prefix.length)
  }
  return normalizedTarget
}

function matchesLeaseEntry(normalizedTarget: string, normalizedEntry: string): boolean {
  if (normalizedTarget === normalizedEntry) return true
  const prefix = normalizedEntry.endsWith('/') ? normalizedEntry : `${normalizedEntry}/`
  return normalizedTarget.startsWith(prefix)
}

/**
 * Acquire or replace a file lease for `sessionID`.
 */
export function acquireFileLease(sessionID: string, lease: FileLeaseInput): FileLeaseRecord {
  const rootDir = canonicalizeForwardPath(lease.rootDir.trim() || '.')
  const ownedFiles = [...(lease.ownedFiles ?? [])]
  const forbiddenFiles = [...(lease.forbiddenFiles ?? [])]
  const record: FileLeaseRecord = {
    sessionID,
    role: lease.role,
    rootDir,
    ownedFiles,
    forbiddenFiles,
    normalizedOwned: ownedFiles.map((entry) => normalizeLeasePath(entry, rootDir)),
    normalizedForbidden: forbiddenFiles.map((entry) => normalizeLeasePath(entry, rootDir)),
  }
  getLeaseRegistry().set(sessionID, record)
  return record
}

/**
 * Release the active file lease for `sessionID`. Returns `true` if one existed.
 */
export function releaseFileLease(sessionID: string): boolean {
  return getLeaseRegistry().delete(sessionID)
}

/**
 * Return the active file lease for `sessionID`, if any.
 */
export function getFileLease(sessionID: string): FileLeaseRecord | undefined {
  return getLeaseRegistry().get(sessionID)
}

/**
 * List every active file lease, optionally narrowed to one checkout.
 *
 * This is the production accessor the merge gate needs: the registry is only
 * reachable through function calls (the `globalThis` slot is an implementation
 * detail), and "who else owns these files?" must be answerable without a
 * session id. `rootDir` is canonicalized exactly like lease acquisition, so a
 * trailing slash or a Windows path still matches.
 */
export function listActiveLeases(options?: { readonly rootDir?: string }): FileLeaseRecord[] {
  const leases = Array.from(getLeaseRegistry().values())
  const filterRoot = options?.rootDir?.trim()
  if (!filterRoot) return leases
  const normalizedRoot = canonicalizeForwardPath(filterRoot)
  return leases.filter((lease) => lease.rootDir === normalizedRoot)
}

/**
 * True when `targetPath` falls inside a path the lease claims — owned *or*
 * forbidden. Both directions matter to a merge gate: an owned path means the
 * lease holder is editing it, and a forbidden path means the holder declared it
 * sensitive; a branch that rewrites either one is a conflict a human must see.
 */
export function leaseClaimsPath(lease: FileLeaseRecord, targetPath: string): boolean {
  const trimmed = targetPath.trim()
  if (!trimmed) return false
  const normalizedTarget = normalizeLeasePath(trimmed, lease.rootDir)
  return [...lease.normalizedOwned, ...lease.normalizedForbidden].some((entry) =>
    matchesLeaseEntry(normalizedTarget, entry),
  )
}

/**
 * Check whether `targetPath` is permitted under `sessionID`'s active file lease.
 * Sessions without an active lease are unrestricted.
 */
export function checkFileLease(sessionID: string, targetPath: string): FileLeaseCheckResult {
  if (!sessionID) return { allowed: true }
  const lease = getLeaseRegistry().get(sessionID)
  if (!lease) return { allowed: true }

  const trimmed = targetPath.trim()
  if (!trimmed) return { allowed: true }

  const normalizedTarget = normalizeLeasePath(trimmed, lease.rootDir)
  const displayTarget = toDisplayPath(normalizedTarget, lease.rootDir)

  for (const forbidden of lease.normalizedForbidden) {
    if (matchesLeaseEntry(normalizedTarget, forbidden)) {
      const allowedNote =
        lease.ownedFiles.length > 0
          ? ` Allowed files: ${lease.ownedFiles.join(', ')}`
          : ' Allowed files: (none — path is forbidden)'
      return {
        allowed: false,
        owner: lease.role,
        targetPath: displayTarget,
        allowedFiles: lease.ownedFiles,
        reason: `File lease violation (owner: ${lease.role}): "${displayTarget}" is in forbiddenFiles.${allowedNote}`,
      }
    }
  }

  if (lease.normalizedOwned.length > 0) {
    const isOwned = lease.normalizedOwned.some((owned) =>
      matchesLeaseEntry(normalizedTarget, owned),
    )
    if (!isOwned) {
      return {
        allowed: false,
        owner: lease.role,
        targetPath: displayTarget,
        allowedFiles: lease.ownedFiles,
        reason: `File lease violation (owner: ${lease.role}): "${displayTarget}" is outside ownedFiles. Allowed files: ${lease.ownedFiles.join(', ')}`,
      }
    }
  }

  return { allowed: true }
}
