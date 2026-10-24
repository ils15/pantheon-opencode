/**
 * Symlink resolution for the Zeus read guard.
 *
 * `zeusReadGuard` is a pure, synchronous predicate shared by V1 and V2, so it
 * cannot touch the filesystem itself. It therefore used to match only the
 * STRING path: `docs/link → ../src` reached `src/` after resolution but passed
 * the guard, while `pantheon_bounded_read` refused the same path via `lstat` +
 * `realpath`. This module closes that gap at the CALL SITES: they resolve the
 * raw path once, then hand the result to the guard.
 *
 * Resolution rules:
 *  - relative paths resolve against the project root, absolute paths stand;
 *  - a path that does not exist resolves its deepest EXISTING ancestor and
 *    re-appends the remaining segments — a deleted path can still be a bypass;
 *  - a resolved path inside the project root is expressed RELATIVE to it (so a
 *    project living under a directory named `src` is not a false positive),
 *    and a resolved path outside the root stays absolute (the guard already
 *    suffix-matches absolute paths, which is what catches `../src`);
 *  - any resolution failure (symlink loop, permissions, …) is reported as
 *    `failed`: a read guard fails CLOSED, and the guard denies.
 */

import { realpathSync } from 'node:fs'
import path from 'node:path'

/** One path form prepared for the guard. */
export interface GuardPathResolution {
  /** Path as supplied, with separators normalized. */
  raw: string
  /**
   * Symlink-resolved path: relative to the project root when it lands inside
   * it, absolute otherwise. Absent when resolution failed.
   */
  resolved?: string
  /** `true` when the path could not be resolved — the guard must DENY. */
  failed: boolean
}

/** Errors that mean "this component does not exist", not "resolution failed". */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return ''
  return String((error as { code: unknown }).code)
}

function isMissing(error: unknown): boolean {
  return MISSING_CODES.has(errorCode(error))
}

/** `true` when `target` is `root` or lives under it (both absolute). */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

/**
 * `realpath` of `absolute`, or of its deepest existing ancestor with the
 * non-existent remainder appended.
 *
 * @returns the resolved absolute path, or `undefined` when resolution failed
 * for a reason other than a missing component.
 */
function resolveExistingPrefix(absolute: string): string | undefined {
  let cursor = absolute
  const remainder: string[] = []
  for (;;) {
    try {
      const resolved = realpathSync(cursor)
      return remainder.length === 0 ? resolved : path.join(resolved, ...remainder)
    } catch (error) {
      if (!isMissing(error)) return undefined
      const parent = path.dirname(cursor)
      // Reached the filesystem root without resolving: unreachable on a sane
      // system, but a failure must stay a failure (fail closed).
      if (parent === cursor) return undefined
      remainder.unshift(path.basename(cursor))
      cursor = parent
    }
  }
}

/** Normalize a resolved absolute path into the form the guard matches. */
function toGuardForm(resolvedAbsolute: string, rootReal: string): string {
  const relative = isWithin(rootReal, resolvedAbsolute)
    ? path.relative(rootReal, resolvedAbsolute)
    : resolvedAbsolute
  return relative.split(path.sep).join('/')
}

function resolveAgainst(rawPath: string, rootReal: string): GuardPathResolution {
  const raw = rawPath.replace(/\\/g, '/')
  const absolute = path.resolve(rootReal, raw)
  const resolvedAbsolute = resolveExistingPrefix(absolute)
  if (resolvedAbsolute === undefined) return { raw, failed: true }
  return { raw, resolved: toGuardForm(resolvedAbsolute, rootReal), failed: false }
}

/**
 * Resolve one raw tool path for the Zeus read guard.
 *
 * Use {@link createGuardPathResolver} at a call site that checks many paths:
 * it resolves the project root once instead of once per path.
 */
export function resolveGuardPathForCheck(
  rawPath: string,
  projectRoot: string,
): GuardPathResolution {
  return resolveAgainst(
    rawPath,
    resolveExistingPrefix(path.resolve(projectRoot)) ?? path.resolve(projectRoot),
  )
}

/**
 * Build the per-call-site resolver. The project root is resolved once, so a
 * symlinked root (`/tmp` → `/private/tmp`) compares against real paths.
 */
export function createGuardPathResolver(
  projectRoot: string,
): (rawPath: string) => GuardPathResolution {
  const rootAbsolute = path.resolve(projectRoot)
  const rootReal = resolveExistingPrefix(rootAbsolute) ?? rootAbsolute
  return (rawPath) => resolveAgainst(rawPath, rootReal)
}
