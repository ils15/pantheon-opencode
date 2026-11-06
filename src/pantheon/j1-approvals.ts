/**
 * j1-approvals.ts — the human-approval registry for the J1 enforce gate.
 *
 * Field-driven design (the owner's call, beta.20→21): a high-risk call must
 * not be a dead deny — it demands EXPLICIT human approval, then executes.
 * The channel is the agent's own `question` tool: the deny message names a
 * marker `j1-approval-<hash12>`; when the host's after-hook reports the user
 * answered affirmatively to THAT marker, the exact call (session + tool +
 * input hash) is minted approved for a bounded TTL, and the retry passes.
 *
 * Safety properties:
 *   - approval is HASH-PINNED to the exact refused call — approving one call
 *     never approves a different one, however similar;
 *   - TTL-bounded (default 15 minutes) and session-scoped;
 *   - fail-closed preserved: no approval → the retry denies exactly as
 *     before; the agent cannot mint approvals (only the observed user answer
 *     can, and only for a pending marker of its own session);
 *   - bounded memory: per-session maps with oldest-eviction at the cap.
 *
 * Pure and synchronous: the registry lives in-process (a restart forgets
 * approvals, which is the conservative direction).
 */

import { createHash } from 'node:crypto'

/** Marker prefix the deny message instructs the agent to name its question with. */
export const J1_APPROVAL_MARKER_PREFIX = 'j1-approval-'

/** Approvals expire after this many milliseconds (bounded trust window). */
export const J1_APPROVAL_TTL_MS = 15 * 60 * 1000

/** Per-session approval cap; oldest evicted beyond it. */
const MAX_APPROVALS_PER_SESSION = 64

/** Affirmative answer tokens the user may give (case-insensitive, exact-word). */
const AFFIRMATIVE = new Set(['approve', 'approved', 'yes', 'y', 'sim', 'aprovar', 'aprovado'])

/** The marker name for one approval request: `j1-approval-<first 12 hash chars>`. */
export function j1ApprovalMarker(inputHash: string): string {
  return `${J1_APPROVAL_MARKER_PREFIX}${inputHash.slice(0, 12)}`
}

/** Extract the hash12 from a marker name; null when the name is not one. */
export function hashFromMarker(name: string): string | null {
  if (!name.startsWith(J1_APPROVAL_MARKER_PREFIX)) return null
  const tail = name.slice(J1_APPROVAL_MARKER_PREFIX.length)
  return /^[0-9a-f]{12}$/.test(tail) ? tail : null
}

/**
 * Whether a serialized `question` tool RESULT reads as the user approving the
 * marker. Defensive by design: the result shape is host-defined; we match the
 * marker and an affirmative token anywhere in a bounded serialization.
 */
export function isAffirmativeAnswer(marker: string, serializedResult: string): boolean {
  if (!serializedResult.includes(marker)) return false
  const bounded = serializedResult.slice(0, 2000).toLowerCase()
  for (const token of AFFIRMATIVE) {
    if (new RegExp(`\\b${token}\\b`).test(bounded)) return true
  }
  return false
}

interface ApprovalStore {
  /** hash12 -> approvedAt (ms) */
  approved: Map<string, number>
}

const store = new Map<string, ApprovalStore>()

function pruneSession(session: ApprovalStore, now: number): void {
  for (const [hash, at] of session.approved) {
    if (now - at > J1_APPROVAL_TTL_MS) session.approved.delete(hash)
  }
  while (session.approved.size > MAX_APPROVALS_PER_SESSION) {
    const oldest = [...session.approved.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest === undefined) break
    session.approved.delete(oldest[0])
  }
}

/** Mint one approval (the after-hook, on an observed affirmative user answer). */
export function mintApproval(sessionID: string, inputHash: string, now = Date.now()): void {
  if (sessionID === '' || inputHash === '') return
  const session = store.get(sessionID) ?? { approved: new Map() }
  session.approved.set(inputHash.slice(0, 12), now)
  pruneSession(session, now)
  store.set(sessionID, session)
}

/** Whether the exact call (session + input hash) carries a live approval. */
export function hasApproval(sessionID: string, inputHash: string, now = Date.now()): boolean {
  const session = store.get(sessionID)
  if (session === undefined) return false
  const at = session.approved.get(inputHash.slice(0, 12))
  if (at === undefined) return false
  if (now - at > J1_APPROVAL_TTL_MS) {
    session.approved.delete(inputHash.slice(0, 12))
    return false
  }
  return true
}

/** Drop everything (tests). */
export function resetApprovals(): void {
  store.clear()
}

/** Stable content hash for a tool input (same digest as the risk gate uses). */
export function approvalInputHash(input: unknown): string {
  let serialized: string
  if (typeof input === 'string') {
    serialized = input
  } else {
    try {
      const json = JSON.stringify(input)
      serialized = json === undefined ? String(input) : json
    } catch {
      serialized = 'unserializable-tool-input'
    }
  }
  return createHash('sha256').update(serialized, 'utf8').digest('hex')
}
