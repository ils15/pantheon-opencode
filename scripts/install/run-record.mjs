/**
 * run-record.mjs — the one-line record of what the LAST `init` run did.
 *
 * WHY A SEPARATE FILE, AND NOT `install-state.json`: that manifest is written
 * only by an APPLY, so it answers "what is installed" and cannot answer "what
 * did the previous run decide". A canceled or declined run previously left no
 * trace at all: the user saw a line scroll past, and a re-run could not tell
 * whether the last attempt was interrupted, refused at the review prompt, or
 * never authorized. This record is written on every non-preview termination,
 * including the ones that apply nothing, so the answer survives the terminal.
 *
 * It is deliberately NOT an install artifact:
 *   - it is never registered in the file inventory, so it is not "owned" and
 *     uninstall/reconcile do not treat it as installed content;
 *   - it never replaces, mirrors or edits `install-state.json`;
 *   - a failure to write it never changes the exit code (see the caller): an
 *     explanation is worth having, not worth failing a run for.
 *
 * No secrets and no config contents are recorded — status, reason, cancel
 * point, mode, version, timestamp and target only.
 *
 * @module run-record
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from './verify.mjs'

/** Directory inside the install target that holds Pantheon bookkeeping. */
export const RUN_RECORD_DIR = '.pantheon'

/** File name of the last-run record. */
export const RUN_RECORD_FILENAME = 'last-run.json'

/**
 * Absolute path of the record for an install target.
 *
 * @param {string} target
 * @returns {string}
 */
export function runRecordPath(target) {
  return join(target, RUN_RECORD_DIR, RUN_RECORD_FILENAME)
}

/**
 * Build the record. Pure, so the shape is testable without touching disk.
 *
 * @param {{
 *   status: string,
 *   reason?: string|null,
 *   cancelPoint?: string|null,
 *   mode: 'apply'|'dry-run',
 *   applied: boolean,
 *   pantheonVersion?: string|null,
 *   at?: string,
 * }} input
 * @returns {object}
 */
export function buildRunRecord({
  status,
  reason = null,
  cancelPoint = null,
  mode,
  applied,
  pantheonVersion = null,
  at = new Date().toISOString(),
}) {
  const where = cancelPoint === null ? '' : ` at ${cancelPoint}`
  return {
    schema_version: 1,
    command: 'init',
    status,
    reason,
    cancel_point: cancelPoint,
    mode,
    applied,
    pantheon_version: pantheonVersion,
    at,
    summary: `init ${status}${where} — ${applied ? 'changes were applied' : 'nothing was applied'} (${at})`,
  }
}

/**
 * Persist the record. Never throws: a bookkeeping failure is reported to the
 * caller, which prints it as a warning instead of hiding it.
 *
 * @param {string} target
 * @param {object} record
 * @returns {{written: boolean, path: string, error: string|null}}
 */
export function writeRunRecord(target, record) {
  const path = runRecordPath(target)
  try {
    mkdirSync(join(target, RUN_RECORD_DIR), { recursive: true })
    writeFileAtomically(path, `${JSON.stringify(record, null, 2)}\n`)
    return { written: true, path, error: null }
  } catch (err) {
    return { written: false, path, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Read the previous run's record, or null when there is none / it is unreadable.
 *
 * @param {string} target
 * @returns {object|null}
 */
export function readRunRecord(target) {
  try {
    const parsed = JSON.parse(readFileSync(runRecordPath(target), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
