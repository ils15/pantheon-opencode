/**
 * Session ID safety — reject session IDs that could escape a per-session
 * output directory.
 *
 * Shared helper for the file-backed stores that remain after the delegate
 * removal (goal-store and friends) — it no longer lives alongside the
 * deleted delegation module.
 *
 * `sessionID` is embedded in a path
 * `<dir>/<sessionID>/file.json` — `path.join` does NOT strip `..`, so a
 * traversing ID would write outside the sandbox. Call this BEFORE any path
 * construction.
 *
 * @module session-id
 */

/**
 * Reject session IDs that could escape the target directory.
 *
 * @throws {Error} When the ID contains `..`, `/`, or `\`.
 */
export function assertSafeParentSessionID(parentSessionID: string): void {
  if (
    parentSessionID.includes('..') ||
    parentSessionID.includes('/') ||
    parentSessionID.includes('\\')
  ) {
    throw new Error(`Invalid parentSessionID: ${parentSessionID}`)
  }
}
