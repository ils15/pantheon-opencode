/**
 * plan.mjs — Per-file change planning for the Pantheon installer.
 *
 * Beta 11, Setup phase 1: `pantheon-opencode init ... --dry-run` must print the
 * REAL per-file change set (create / update / remove / unchanged) that the SAME
 * code path would produce, and write nothing.
 *
 * The plan is built by a change recorder threaded through the writer helpers as
 * an OPTIONAL argument whose default is a module-level no-op singleton, so any
 * caller (or writer) that is not instrumented keeps byte-identical behavior.
 *
 * NET-OUTCOME semantics: several writers can touch the same path in one pass
 * (the TUI `unregister`→`register` toggle; the code-mode `syncDir` payload and
 * its generated `manifest.json`). The LAST writer decides the net disk result,
 * so a later no-write (skipped/unchanged) leaves the path UNCHANGED even when an
 * earlier writer computed a would-be update. A no-write never promotes a path to
 * a scored change.
 *
 * "Scored" vs "unscored": writers that increment the install summary
 * (`stats.created`) alongside a genuine change are SCORED. Artifacts that are
 * not part of that summary (the synthetic `.venv` entry, the state-only
 * `.pantheon/install-state.json` write, the backup-set manifest, and the TUI
 * stale-ref cleanup) are recorded UNSCORED so they still appear in the printed
 * plan but never affect the consistency guard.
 *
 * Security: the recorder, the summary and the formatter deal in paths, actions
 * and byte sizes ONLY. File contents and hashes stay internal — hashes are kept
 * so a later phase can detect drift between a preview and an apply, and are
 * never printed.
 */

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  assertNoSymlinkAncestors,
  assertPathWithin,
  assertSafeRemoval,
  verifyPathRemoved,
} from './verify.mjs'

/** The action vocabulary shared by the recorder, the summary and the formatter. */
export const ACTIONS = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  REMOVE: 'remove',
  UNCHANGED: 'unchanged',
  CONFLICT: 'conflict',
})

const ACTION_VALUES = new Set(Object.values(ACTIONS))

/** Whether an action represents a real change to the target (not a no-write). */
function isChange(action) {
  return action === ACTIONS.CREATE || action === ACTIONS.UPDATE || action === ACTIONS.REMOVE
}

// Display order for the formatted plan.
const DISPLAY_ORDER = Object.freeze([
  ACTIONS.CREATE,
  ACTIONS.UPDATE,
  ACTIONS.REMOVE,
  ACTIONS.CONFLICT,
  ACTIONS.UNCHANGED,
])

/**
 * The module-level no-op recorder. Instrumented writers whose caller did not
 * pass a recorder fall back to this, so their behavior is byte-identical to an
 * uninstrumented run (no allocation, no side effects).
 */
export function noopRecorder() {}

/** The default recorder instance — the no-op singleton. */
export const NOOP_RECORDER = noopRecorder

/**
 * Whether a recorder will actually collect anything. Writers in hot loops use
 * this to skip `Buffer.byteLength(content)` on the common (uninstrumented) path.
 *
 * @param {unknown} recorder
 * @returns {boolean}
 */
export function isRecording(recorder) {
  return typeof recorder === 'function' && recorder !== NOOP_RECORDER
}

/** Normalize an arbitrary change into the `{ path, action, bytes, scored }` shape. */
function normalizeChange(change) {
  const action = change && ACTION_VALUES.has(change.action) ? change.action : ACTIONS.UNCHANGED
  return {
    path: String(change?.path ?? ''),
    action,
    bytes: Number.isFinite(change?.bytes) ? change.bytes : 0,
    outputFingerprint:
      typeof change?.outputFingerprint === 'string' ? change.outputFingerprint : null,
    // Scored by default: most writers feed the install summary. Synthetic and
    // state-only entries opt out explicitly with `scored: false`.
    scored: !(change && change.scored === false),
  }
}

/**
 * Create a recorder that collects changes in memory. `recorder` is the function
 * to thread into the writer helpers; `entries` holds the raw recorded changes.
 *
 * @returns {{ recorder: (change: object) => void, entries: object[] }}
 */
export function createRecorder() {
  const entries = []
  const recorder = (change) => {
    entries.push(normalizeChange(change))
  }
  return { recorder, entries }
}

/**
 * Record a single change. Writers call this instead of touching fs bookkeeping.
 * With no explicit recorder the module-level no-op singleton is used.
 *
 * @param {{ path: string, action: string, bytes?: number, scored?: boolean }} change
 * @param {(change: object) => void} [recorder]
 */
export function recordChange(change, recorder = NOOP_RECORDER) {
  if (!isRecording(recorder)) return
  recorder(normalizeChange(change))
}

/** Return the non-displayed SHA-256 fingerprint used by reviewed plan artifacts. */
export function fingerprintOutput(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** Sort helper: display order first, then path for determinism. */
function compareFiles(a, b) {
  const order = DISPLAY_ORDER.indexOf(a.action) - DISPLAY_ORDER.indexOf(b.action)
  if (order !== 0) return order
  return a.path.localeCompare(b.path)
}

function zeroTotals() {
  return { create: 0, update: 0, remove: 0, unchanged: 0, conflict: 0 }
}

/** Tally a change into one of the five action buckets. */
function tally(totals, action) {
  if (Object.hasOwn(totals, action)) totals[action] += 1
}

/**
 * Collapse recorded changes into the final change set: one entry per path,
 * reflecting the NET disk outcome, plus totals.
 *
 * The last record for a path decides the action, so a later no-write wins over
 * an earlier would-be write. A path is scored only if at least one of its
 * CHANGE records was scored AND the net action is still a change — a no-write
 * can never turn a path into a scored change.
 *
 * @param {object[]} entries
 * @returns {{
 *   files: object[],
 *   totals: { create: number, update: number, remove: number, unchanged: number, conflict: number },
 *   scored: { create: number, update: number, remove: number, unchanged: number, conflict: number },
 * }}
 */
export function summarizeChanges(entries = []) {
  const byPath = new Map()
  for (const entry of entries ?? []) {
    const change = normalizeChange(entry)
    let record = byPath.get(change.path)
    if (!record) {
      record = {
        path: change.path,
        action: change.action,
        bytes: change.bytes,
        outputFingerprint: change.outputFingerprint,
        scored: false,
      }
      byPath.set(change.path, record)
    }
    // The LAST writer decides the net on-disk outcome. A later no-write
    // (skipped/unchanged) leaves the path unchanged even if an earlier writer
    // computed a would-be update (e.g. unregister→register toggling).
    record.action = change.action
    record.bytes = change.bytes
    record.outputFingerprint = change.outputFingerprint
    // Only a genuine change can score a path; a no-write never does.
    if (isChange(change.action) && change.scored) record.scored = true
  }

  const files = [...byPath.values()].sort(compareFiles)
  for (const file of files) {
    if (!isChange(file.action)) file.scored = false
  }

  const totals = zeroTotals()
  const scored = zeroTotals()
  for (const file of files) {
    tally(totals, file.action)
    if (file.scored) tally(scored, file.action)
  }
  return { files, totals, scored }
}

/** Human-readable byte size. The caller never sees raw bytes or hashes. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** Path shown in the plan: relative to the target when it lives inside it. */
export function displayPath(target, filePath) {
  if (!target) return filePath
  const rel = relative(target, filePath)
  if (rel === '') return '.'
  return rel.startsWith('..') || isAbsolute(rel) ? filePath : rel
}

/**
 * Render the secret-safe plan: paths + action + byte size ONLY. No contents,
 * no hashes.
 *
 * Two non-file facts are printed when the caller supplies them, because a
 * per-file plan alone does not answer "what will be configured?":
 *   * `mcpServers` — the MCP servers this pass seeds into opencode.json, in
 *     write order, with their count. Derived from the write path, never a
 *     separate hand-maintained list.
 *   * `versionAssumed` — the host generation could not be probed, so the plan
 *     assumes V1 and may diverge from an apply on a 2.x host.
 *
 * @param {string} target - install target (used to relativize paths)
 * @param {{ files: object[], totals: object, mcpServers?: string[], versionAssumed?: boolean }} plan
 * @param {{ perFile?: boolean }} [options] - `perFile: false` renders the
 *   summary (totals + MCP servers + "No files were written.") without the
 *   per-file list. That is the DEFAULT dry-run surface; the per-file list is
 *   opt-in via --verbose/--json.
 * @returns {string}
 */
export function formatChangePlan(target, plan, { perFile = true } = {}) {
  const { files, totals } = plan
  const lines = []
  lines.push(`Change plan — ${target}`)
  if (perFile) {
    for (const file of files) {
      const isWrite = file.action === ACTIONS.CREATE || file.action === ACTIONS.UPDATE
      const size = isWrite ? `  (${formatBytes(file.bytes)})` : ''
      lines.push(`  ${file.action.padEnd(9)} ${displayPath(target, file.path)}${size}`)
    }
    lines.push(`  ${'─'.repeat(28)}`)
  }
  lines.push(
    `  ${totals.create} create · ${totals.update} update · ${totals.remove} remove · ` +
      `${totals.conflict} conflict`,
  )
  if (Array.isArray(plan.mcpServers)) {
    const names = plan.mcpServers
    const servers =
      names.length === 0 ? 'none (already configured or runtime skipped)' : names.join(', ')
    lines.push(`  MCP servers (${names.length}): ${servers}`)
  }
  if (plan.versionAssumed) {
    lines.push(
      '  OpenCode host generation unknown — this plan assumes V1 and may diverge from the ' +
        'apply. Pass --opencode-version v1|v2 to pin it.',
    )
  }
  lines.push('  No files were written.')
  return lines.join('\n')
}

/**
 * Snapshot a path for later drift comparison. Hashes stay internal.
 *
 * @param {string} filePath
 * @returns {{ exists: boolean, sha256: string|null, size: number, mode: number|null }}
 */
export function snapshot(filePath) {
  let stat
  try {
    stat = lstatSync(filePath)
  } catch {
    return { exists: false, sha256: null, size: 0, mode: null }
  }
  if (stat.isDirectory()) {
    // Directory snapshots include the direct child inventory. Descendant
    // directories/files are snapshotted separately by collectRemovalTree().
    const entries = readdirSync(filePath, { withFileTypes: true })
      .map((entry) => [
        entry.name,
        entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other',
      ])
      .sort(([left], [right]) => left.localeCompare(right))
    return {
      exists: true,
      sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      size: stat.size,
      mode: stat.mode,
    }
  }
  if (!stat.isFile()) {
    return { exists: true, sha256: null, size: stat.size, mode: stat.mode }
  }
  let buffer
  try {
    buffer = readFileSync(filePath)
  } catch {
    return { exists: true, sha256: null, size: stat.size, mode: stat.mode }
  }
  return {
    exists: true,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
    mode: stat.mode,
  }
}

/**
 * Enumerate a path and its complete subtree as removal operations with
 * pre-apply snapshots. Symlinks are treated as leaf entries and never followed.
 *
 * @param {string} rootPath
 * @returns {{path: string, snapshot: object}[]}
 */
export function collectRemovalTree(rootPath) {
  const entries = []
  const visit = (filePath, allowMissing = false) => {
    let stat
    try {
      stat = lstatSync(filePath)
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return
      throw error
    }
    entries.push({ path: filePath, snapshot: snapshot(filePath) })
    if (stat.isDirectory()) {
      for (const name of readdirSync(filePath).sort()) visit(`${filePath}${sep}${name}`)
    }
  }
  visit(rootPath, true)
  return entries
}

/** Record every path that a recursive removal will delete. */
export function recordRemovalTree(rootPath, recorder, { scored = false } = {}) {
  const entries = collectRemovalTree(rootPath)
  for (const entry of entries) {
    recordChange({ path: entry.path, action: ACTIONS.REMOVE, bytes: 0, scored }, recorder)
  }
  return entries
}

/**
 * Fail closed unless the exact reviewed subtree and its snapshots still match.
 *
 * @param {string} rootPath
 * @param {Set<string>|null} reviewedRemovals
 * @param {Map<string, object>|null} reviewedSnapshots
 */
export function validateRemovalTree(rootPath, reviewedRemovals, reviewedSnapshots) {
  if (!reviewedRemovals || !reviewedSnapshots) {
    throw new Error(`Refusing destructive removal without a reviewed snapshot: ${rootPath}`)
  }
  const root = resolve(rootPath)
  const isWithinRoot = (filePath) => {
    const rel = relative(root, resolve(filePath))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }
  const expected = new Set(
    [...reviewedRemovals].filter(isWithinRoot).map((filePath) => resolve(filePath)),
  )
  const current = collectRemovalTree(rootPath)
  const actual = new Set(current.map((entry) => resolve(entry.path)))
  if (actual.size !== expected.size || [...actual].some((filePath) => !expected.has(filePath))) {
    throw new Error(`Removal set changed after review: ${rootPath}`)
  }
  for (const entry of current) {
    const filePath = resolve(entry.path)
    const before = reviewedSnapshots.get(filePath)
    const now = entry.snapshot
    if (
      !before ||
      before.exists !== now.exists ||
      before.sha256 !== now.sha256 ||
      before.size !== now.size ||
      before.mode !== now.mode
    ) {
      throw new Error(`Removal target drifted after review: ${entry.path}`)
    }
  }
  return true
}

/**
 * Remove only the reviewed entries, without recursive deletion that could
 * consume a path added after preflight. Directory removal uses rmdir, which
 * fails closed if any unreviewed entry appears during cleanup.
 */
export function removeReviewedTree(rootPath, reviewedRemovals, reviewedSnapshots) {
  validateRemovalTree(rootPath, reviewedRemovals, reviewedSnapshots)
  const entries = collectRemovalTree(rootPath)
  for (const entry of entries.reverse()) {
    const info = lstatSync(entry.path)
    if (info.isDirectory()) {
      assertSafeRemoval(rootPath, entry.path)
      try {
        rmdirSync(entry.path)
      } catch (error) {
        if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
          throw new Error(`Removal set changed after review: ${entry.path}`, { cause: error })
        }
        throw error
      }
    } else {
      // Unlinking a reviewed symlink leaf is safe and preserves historical
      // cleanup behavior; reject linked ancestors so the parent is never
      // redirected outside the reviewed root.
      assertPathWithin(rootPath, entry.path)
      assertNoSymlinkAncestors(entry.path, { includeLeaf: false })
      const before = reviewedSnapshots?.get(resolve(entry.path))
      const now = snapshot(entry.path)
      if (
        !before ||
        before.exists !== now.exists ||
        before.sha256 !== now.sha256 ||
        before.size !== now.size ||
        before.mode !== now.mode
      ) {
        throw new Error(`Removal target drifted after review: ${entry.path}`)
      }
      unlinkSync(entry.path)
    }
    verifyPathRemoved(entry.path)
  }
  return true
}

/**
 * Compare the preview's SCORED change count against this call's install
 * summary delta. Returns a descriptor on mismatch, or `null` when they agree.
 *
 * Only the CHANGED count is gated (`create + update + remove` vs
 * `stats.created`). `stats.skipped` deliberately mixes genuine file-unchanged
 * outcomes with logical no-op skips that never touch a file (e.g. the V2 TUI
 * registration skip), so it cannot be reconciled against `plan.scored.unchanged`
 * without making the guard cry wolf. The meaningful invariant is: every change
 * the summary counted must have been recorded — a preview that silently missed
 * a writer is exactly a `stats.created` with no recorded change.
 *
 * Both sides must be scoped to a SINGLE `installOpenCode` call.
 *
 * @param {{ scored: object }} plan
 * @param {{ created: number, skipped: number }} stats - per-call delta
 * @returns {{ changed: number, unchanged: number, recordedChanged: number, recordedUnchanged: number }|null}
 */
export function planStatsMismatch(plan, stats) {
  const changed = plan.scored.create + plan.scored.update + plan.scored.remove
  if (changed !== stats.created) {
    return {
      changed,
      unchanged: plan.scored.unchanged,
      recordedChanged: stats.created,
      recordedUnchanged: stats.skipped,
    }
  }
  return null
}
