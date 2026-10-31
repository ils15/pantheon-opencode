/**
 * decision-layer-preview.mjs — a COMPUTED diff of the decision-layer target
 * artifacts (PLAN §7 Fase 7 gate, PM-13, D7).
 *
 * Why this module exists at all: the installer's "Change plan" is **not** a
 * preview. PROBE-B measured a second idempotent apply that announced
 * `112 create` and created nothing, because the announcement is derived from
 * what a writer was asked to do, not from what the target bytes are. Shipping a
 * second announcement of the same kind would repeat the defect with a new
 * label. So this module never reads a change plan and never reprints one:
 *
 *   - it takes a content snapshot of each target artifact exactly as PROBE-B §4.2
 *     did (`lstat` + SHA-256 + size + mode);
 *   - it builds the candidate bytes with the SAME serializer the writer uses
 *     (`serializeUserDecisionRouterConfig`), so the compared bytes are the bytes
 *     that would land on disk;
 *   - the action is decided by comparing hashes, nothing else:
 *     `missing → create`, `same hash → unchanged`, `different hash → update`.
 *
 * Consequence, and the property a test pins: apply-then-preview reports
 * `0 create · 0 update`, while the measured installer re-announced 112 creates
 * on an apply that created nothing.
 *
 * Writes only happen in {@link applyDecisionLayerPlan}, after re-reading the
 * current hash and refusing the whole plan if any artifact moved in between.
 *
 * Secret safety: the plan and its rendered form contain paths, actions, byte
 * sizes, field NAMES, and the values of a fixed allowlist of activation flags
 * (schema version, enabled, consent, selection mode/provider/model, candidate
 * count). No free-form content, no file contents, no hashes are printed.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  migrateUserDecisionRouterConfig,
  projectDecisionRouterInstallState,
  readUserDecisionRouterConfig,
  resolveUserDecisionRouterConfigPath,
  serializeUserDecisionRouterConfig,
  updateUserDecisionRouterConfig,
  writeUserDecisionRouterConfig,
} from './decision-router-config.mjs'
import { snapshot } from './plan.mjs'
import { assertNoSymlinkAncestors, writeFileAtomically } from './verify.mjs'

export const DECISION_LAYER_ACTIONS = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  UNCHANGED: 'unchanged',
})

export const DECISION_LAYER_ROLES = Object.freeze({
  USER_CONFIG: 'user-config',
  INSTALL_STATE: 'install-state',
})

/**
 * Backups are credential-bearing. The installer's own log says a backup set
 * contains API keys/tokens, and PROBE-B measured one backup directory
 * accumulated per application. The decision-layer setup path creates none and
 * says so; it never adds a silent backup copy.
 */
export const DECISION_LAYER_BACKUP_NOTICE =
  'Backup notice: installer backup sets accumulate once per application and contain ' +
  'credential-bearing files (API keys/tokens) by the installer log itself. This command ' +
  'creates no backup and no copy; nothing extra is written or retained.'

/** Fields whose VALUES may be printed. They are activation flags, never secrets. */
const VISIBLE_FIELDS = Object.freeze([
  'schema_version',
  'enabled',
  'egress_consent',
  'selection.mode',
  'selection.provider',
  'selection.model',
])

function readRawJson(filePath) {
  try {
    assertNoSymlinkAncestors(filePath)
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function visibleValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return Array.isArray(value) ? value.length : typeof value
}

function fieldValue(record, field) {
  if (record === null || typeof record !== 'object') return undefined
  let current = record
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

/** Field-level diff for the allowlisted activation flags only. */
function diffConfigFields(rawConfig, candidateConfig) {
  const changes = []
  for (const field of VISIBLE_FIELDS) {
    const before = fieldValue(rawConfig, field)
    const after = fieldValue(candidateConfig, field)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ field, before: visibleValue(before), after: visibleValue(after) })
    }
  }
  if (rawConfig === null) return changes
  const rawKeys = Object.keys(rawConfig).sort()
  const candidateKeys = Object.keys(candidateConfig).sort()
  for (const key of rawKeys) {
    if (!candidateKeys.includes(key))
      changes.push({ field: key, before: 'present', after: 'removed' })
  }
  for (const key of candidateKeys) {
    if (!rawKeys.includes(key)) changes.push({ field: key, before: 'absent', after: 'present' })
  }
  if (
    Array.isArray(rawConfig?.enabled_candidates) &&
    rawConfig.enabled_candidates.length !== candidateConfig.enabled_candidates.length
  ) {
    changes.push({
      field: 'enabled_candidates.length',
      before: rawConfig.enabled_candidates.length,
      after: candidateConfig.enabled_candidates.length,
    })
  }
  return changes
}

function artifactDiff({ role, path, current, candidateBytes, changedFields }) {
  const candidateSnapshot = {
    sha256: snapshotBytesHash(candidateBytes),
    size: Buffer.byteLength(candidateBytes),
  }
  let action
  if (!current.exists) action = DECISION_LAYER_ACTIONS.CREATE
  else if (current.sha256 === candidateSnapshot.sha256) action = DECISION_LAYER_ACTIONS.UNCHANGED
  else action = DECISION_LAYER_ACTIONS.UPDATE
  return {
    role,
    path,
    action,
    bytes: candidateSnapshot.size,
    currentBytes: current.size,
    // Internal comparison state: never rendered, never printed.
    currentExists: current.exists,
    currentHash: current.sha256,
    candidateBytes,
    expectedHash: candidateSnapshot.sha256,
    changedFields: action === DECISION_LAYER_ACTIONS.UNCHANGED ? [] : changedFields,
  }
}

function snapshotBytesHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Resolve the install-state document for an explicit target, if it exists. */
export function resolveInstallStatePath(target) {
  return join(resolve(target), '.pantheon', 'install-state.json')
}

/**
 * Build the plan. No writes, no directory creation, no timestamp reads.
 *
 * @param {{ env?: Record<string, string|undefined>, target?: string,
 *   selection?: { mode: 'local' } | { mode: 'auto' } |
 *   { mode: 'explicit', provider: string, model: string },
 *   acceptMigration?: boolean }} [options]
 */
export function buildDecisionLayerPlan(options = {}) {
  const { env = process.env, target, selection, acceptMigration = false } = options
  const configPath = resolveUserDecisionRouterConfigPath(env)
  const currentConfig = readUserDecisionRouterConfig({ env })
  const candidateConfig =
    selection === undefined
      ? currentConfig
      : updateUserDecisionRouterConfig(currentConfig, { selection })
  const candidateBytes = serializeUserDecisionRouterConfig(candidateConfig)
  const rawConfig = readRawJson(configPath)

  const artifacts = [
    artifactDiff({
      role: DECISION_LAYER_ROLES.USER_CONFIG,
      path: configPath,
      current: snapshot(configPath),
      candidateBytes,
      changedFields: diffConfigFields(rawConfig, candidateConfig),
    }),
  ]

  const warnings = [DECISION_LAYER_BACKUP_NOTICE]
  const blocked = []

  // A legacy file being normalized to the canonical schema must never turn the
  // turn router on as a side effect of a preview/apply. The file can be
  // rewritten, but enabling requires its own explicit flag and its own review.
  const migrationEnablesTurnRouter =
    rawConfig !== null &&
    rawConfig.schema_version !== migrateUserDecisionRouterConfig(candidateConfig).schema_version &&
    rawConfig.enabled !== true &&
    migrateUserDecisionRouterConfig(candidateConfig).enabled === true
  if (migrationEnablesTurnRouter && !acceptMigration) {
    blocked.push({
      role: DECISION_LAYER_ROLES.USER_CONFIG,
      path: configPath,
      reason: 'MIGRATION_WOULD_ENABLE_TURN_ROUTER',
      detail:
        'Writing the canonical schema would set enabled: true from a legacy file. ' +
        'Re-run with --accept-migration to accept that activation explicitly.',
    })
  }

  if (target !== undefined) {
    const statePath = resolveInstallStatePath(target)
    if (existsSync(statePath)) {
      const rawState = readRawJson(statePath)
      if (rawState && rawState.decision_router !== undefined) {
        const projection = projectDecisionRouterInstallState(candidateConfig)
        const candidateState = { ...rawState, decision_router: projection }
        const stateBytes = `${JSON.stringify(candidateState, null, 2)}\n`
        const current = diffInstallStateRecord(rawState.decision_router, projection)
        artifacts.push(
          artifactDiff({
            role: DECISION_LAYER_ROLES.INSTALL_STATE,
            path: statePath,
            current: snapshot(statePath),
            candidateBytes: stateBytes,
            changedFields: current,
          }),
        )
      }
    } else {
      warnings.push(
        `No install-state at ${statePath}: nothing to reconcile. The decision-layer setup ` +
          'never fabricates install state for an unmanaged target.',
      )
    }
  }

  const totals = {
    create: artifacts.filter((a) => a.action === DECISION_LAYER_ACTIONS.CREATE).length,
    update: artifacts.filter((a) => a.action === DECISION_LAYER_ACTIONS.UPDATE).length,
    unchanged: artifacts.filter((a) => a.action === DECISION_LAYER_ACTIONS.UNCHANGED).length,
  }
  return { artifacts, totals, warnings, blocked, wrote: false }
}

function diffInstallStateRecord(installStateRecord, projection) {
  const changes = []
  for (const field of ['provider', 'egress_consent']) {
    const before = installStateRecord?.[field]
    const after = projection[field]
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({
        field: `decision_router.${field}`,
        before: visibleValue(before),
        after: visibleValue(after),
      })
    }
  }
  return changes
}

/** Secret-safe rendering. Paths, actions, sizes, field names and flag values only. */
export function formatDecisionLayerPlan(plan, { scope = 'user', applyPending = false } = {}) {
  const lines = [`Decision-layer preview — ${scope} (computed artifact diff, not a change plan)`]
  for (const artifact of plan.artifacts) {
    lines.push(`  ${artifact.action.padEnd(9)} ${artifact.path}  (${artifact.bytes} B)`)
    for (const change of artifact.changedFields) {
      const before = change.before === null ? 'absent' : String(change.before)
      const after = change.after === null ? 'absent' : String(change.after)
      lines.push(`      ${change.field}: ${before} -> ${after}`)
    }
  }
  lines.push(
    `  ${plan.totals.create} create · ${plan.totals.update} update · ${plan.totals.unchanged} unchanged`,
  )
  for (const warning of plan.warnings) lines.push(`  ${warning}`)
  for (const entry of plan.blocked) {
    lines.push(`  BLOCKED ${entry.path}: ${entry.reason} — ${entry.detail}`)
  }
  lines.push(
    applyPending
      ? '  Writing the artifacts above (explicit --apply). No backup copy is created.'
      : '  No files were written.',
  )
  return lines.join('\n')
}

/** Machine-readable form. Same facts as the text renderer, no contents. */
export function toDecisionLayerPlanJson(plan) {
  return {
    kind: 'decision-layer-preview',
    preview: true,
    wrote: false,
    totals: plan.totals,
    artifacts: plan.artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      action: artifact.action,
      bytes: artifact.bytes,
      changed_fields: artifact.changedFields.map((change) => ({
        field: change.field,
        before: change.before,
        after: change.after,
      })),
    })),
    blocked: plan.blocked.map((entry) => ({
      role: entry.role,
      path: entry.path,
      reason: entry.reason,
    })),
    warnings: plan.warnings,
  }
}

/**
 * Write exactly the artifacts the plan described.
 *
 * Every artifact is re-snapshotted first: if any hash or existence differs from
 * the reviewed plan, the whole apply is refused before the first write, so a
 * preview that raced an edit can never be applied. Unchanged artifacts are not
 * written at all (no mtime churn, no backup copy).
 *
 * @returns {{ written: string[], skipped: string[] }}
 */
export function applyDecisionLayerPlan(plan, { env = process.env } = {}) {
  if (plan.blocked.length > 0) {
    throw new Error(
      `Refusing to apply a blocked plan: ${plan.blocked.map((entry) => entry.reason).join(', ')}`,
    )
  }
  for (const artifact of plan.artifacts) {
    const live = snapshot(artifact.path)
    if (live.exists !== artifact.currentExists) {
      throw new Error(`Artifact changed since the preview: ${artifact.path}. Re-run the preview.`)
    }
    if (live.sha256 !== artifact.currentHash) {
      throw new Error(`Artifact changed since the preview: ${artifact.path}. Re-run the preview.`)
    }
  }
  const written = []
  const skipped = []
  for (const artifact of plan.artifacts) {
    if (artifact.action === DECISION_LAYER_ACTIONS.UNCHANGED) {
      skipped.push(artifact.path)
      continue
    }
    if (artifact.role === DECISION_LAYER_ROLES.USER_CONFIG) {
      // Reuse the writer: path validation, ownership checks, 0700 directory and
      // 0600 file mode are already centralized there, and it serializes with the
      // same function this module diffed.
      if (resolveUserDecisionRouterConfigPath(env) !== artifact.path) {
        throw new Error('Decision-layer plan targets a different config path than the environment')
      }
      writeUserDecisionRouterConfig(JSON.parse(artifact.candidateBytes), { env })
    } else {
      assertNoSymlinkAncestors(artifact.path)
      writeFileAtomically(artifact.path, artifact.candidateBytes)
    }
    written.push(artifact.path)
  }
  return { written, skipped }
}
