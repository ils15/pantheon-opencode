/**
 * Session Guard — shared server-side validation for session IDs.
 *
 * Opencode session IDs always start with "ses". The TUI previously forwarded
 * the literal template placeholder "{sessionID}" (URL-encoded as "%7BsessionID%7D")
 * into `session.children`, causing ~1.5 errors/s from the 1s safety poll.
 * This module is the single chokepoint: every `client.session.*({path:{id}})`;
 * call site MUST go through `safeSessionPath`/`buildChildrenPath`, which
 * reject placeholders before they reach the server (fail-open: warn + return,
 * never throw, never send the placeholder).
 *
 * Mirrors the TUI's `src/plugins/tui/src/index.tsx` contract verbatim so both
 * sides agree on what "valid" means. The TUI file remains self-contained
 * (dist/tui.tsx is a raw copy, no relative imports), so its local copy is kept
 * in sync — this module is the shared source for `src/pantheon/*` and
 * `src/plugin.ts`.
 *
 * @module session-guard
 */

/**
 * Server-aligned session id validity: opencode rejects anything not starting
 * with "ses" (SchemaError). Mirrors that exact contract — nothing stricter,
 * nothing looser — so "{sessionID}", "%7BsessionID%7D", "", "wrk_…" never
 * reach a path.
 */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('ses')
}

/**
 * The single choke point for every `session.*({path:{id}})` call.
 * Returns `{path:{id}}` ONLY for a server-valid id; otherwise null so the
 * caller skips the call entirely (fail-open).
 */
export function safeSessionPath(id: unknown): { path: { id: string } } | null {
  if (!isValidSessionId(id)) return null
  return { path: { id } }
}

/**
 * Build the `session.children` path ONLY from a validated session id.
 * Delegates to {@link safeSessionPath} — the single choke point. Returns
 * null for null/invalid ids so the caller skips the fetch.
 */
export function buildChildrenPath(id: string | null | undefined): { path: { id: string } } | null {
  return safeSessionPath(id)
}
