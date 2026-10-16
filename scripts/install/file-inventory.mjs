/**
 * Conservative per-file installer ownership tracking and stale-file cleanup.
 * The inventory records paths and hashes only; legacy state never implies
 * ownership of files which predate the inventory.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { createBackupSet } from './backup.mjs'
import { writeState } from './state.mjs'
import { assertNoSymlinkAncestors, verifyPathRemoved } from './verify.mjs'

export const FILE_INVENTORY_VERSION = 1

/** Map installer-owned copy layouts to their logical component without names heuristics. */
export function componentForInstalledPath(target, filePath, { isGlobal, version = 'v1' } = {}) {
  let relPath
  try {
    relPath = relativeTargetPath(target, filePath)
  } catch {
    return null
  }
  const layout = isGlobal ? 'global' : version === 'v2' ? 'project-v2' : 'project-v1'
  const agentRoot = isGlobal || version === 'v2' ? 'agents' : '.opencode/agents'
  const skillRoot = isGlobal ? 'skills' : '.opencode/skills'
  const commandRoot = isGlobal || version === 'v2' ? 'commands' : '.opencode/commands'
  const pluginRoot = isGlobal ? 'plugins/pantheon-tui' : '.opencode/plugins/pantheon-tui'
  const runtimeRoot = isGlobal ? '' : '.opencode'
  const startsIn = (prefix) => relPath.startsWith(`${prefix}/`)

  if (startsIn(agentRoot) || relPath === 'routing.yml') return { component: 'agents', layout }
  if (startsIn(skillRoot)) return { component: 'skills', layout }
  // AGENTS.md contains user content outside its managed marker block; the whole
  // file is therefore not safe to claim or remove as a single owned path.
  if (startsIn('instructions')) return { component: 'instructions', layout }
  if (startsIn('prompts')) return { component: 'prompts', layout }
  if (startsIn(commandRoot)) return { component: 'commands', layout }
  if (startsIn(pluginRoot)) return { component: 'plugins', layout }
  const runtimePrefix = runtimeRoot ? `${runtimeRoot}/` : ''
  if (
    startsIn(`${runtimePrefix}scripts`) ||
    startsIn(`${runtimePrefix}code-mode`) ||
    relPath === `${runtimePrefix}tiers.json`
  ) {
    return { component: 'runtime', layout }
  }
  return null
}

/** A new install starts with an empty inventory; `target_root` is bound on write. */
export function createEmptyFileInventory({ legacyUnknown = false } = {}) {
  return {
    schema_version: FILE_INVENTORY_VERSION,
    target_root: null,
    legacy_unknown: legacyUnknown,
    entries: [],
  }
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function safeRelativePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    /^[a-z]:/i.test(value)
  )
    return false
  if (value.startsWith('/') || isAbsolute(value)) return false
  const parts = value.split('/')
  return (
    parts.every((part) => part && part !== '.' && part !== '..') &&
    posix.normalize(value) === value &&
    !value.includes('\0')
  )
}

function rootInfo(target) {
  const root = resolve(target)
  assertNoSymlinkAncestors(root)
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Installer inventory target must be a regular directory')
  }
  return root
}

function inventoryRootMatches(value, root) {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === root
}

function relativeTargetPath(target, value) {
  if (typeof value !== 'string' || value.split(/[\\/]/).includes('..')) {
    throw new Error('Installer inventory path contains traversal')
  }
  const root = resolve(target)
  const absolute = resolve(value)
  const rel = relative(root, absolute).split(sep).join('/')
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !safeRelativePath(rel)) {
    throw new Error('Installer inventory path is outside the selected target')
  }
  return rel
}

function inventoryFingerprint(inventory) {
  return createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
}

function inspectRegularFile(target, relPath) {
  if (!safeRelativePath(relPath)) return { kind: 'ambiguous', reason: 'invalid-path' }
  const filePath = join(target, ...relPath.split('/'))
  try {
    assertNoSymlinkAncestors(filePath)
    const before = lstatSync(filePath)
    if (before.isSymbolicLink()) return { kind: 'ambiguous', reason: 'symlink' }
    if (!before.isFile()) return { kind: 'ambiguous', reason: 'special-file' }

    let descriptor
    try {
      descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      if (error?.code === 'ELOOP') return { kind: 'ambiguous', reason: 'symlink' }
      throw error
    }
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile()) return { kind: 'ambiguous', reason: 'special-file' }
      const bytes = readFileSync(descriptor)
      const after = fstatSync(descriptor)
      if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size) {
        return { kind: 'ambiguous', reason: 'file-changed-during-read' }
      }
      return {
        kind: 'regular',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mode: after.mode & 0o777,
      }
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { kind: 'missing' }
    }
    return {
      kind: 'ambiguous',
      reason: error?.message?.includes('symlink') ? 'symlink' : 'unreadable',
    }
  }
}

/**
 * Add verified installer writes without discarding entries for unselected
 * components. Existing legacy files are not claimed merely because their
 * bytes happen to equal the current package payload.
 */
export function updateFileInventory(
  state,
  target,
  { selectedComponents = [], verifiedFiles = [] } = {},
) {
  const root = resolve(target)
  let inventory = state.file_inventory
  if (inventory == null) inventory = createEmptyFileInventory({ legacyUnknown: true })
  if (
    !inventory ||
    inventory.schema_version !== FILE_INVENTORY_VERSION ||
    !Array.isArray(inventory.entries) ||
    typeof inventory.legacy_unknown !== 'boolean' ||
    (inventory.target_root == null && inventory.entries.length > 0)
  ) {
    throw new Error('Installer file inventory is invalid; refusing to replace ownership data')
  }
  if (inventory.target_root != null && !inventoryRootMatches(inventory.target_root, root)) {
    // A copied/moved state file must not confer ownership in a new root.
    state.file_inventory = inventory
    return false
  }
  inventory.target_root = root
  const selected = new Set(selectedComponents)
  const entriesByPath = new Map()
  const ambiguousEntries = []
  for (const entry of inventory.entries) {
    if (!entry || !safeRelativePath(entry.path) || !validHash(entry.sha256)) {
      ambiguousEntries.push(entry)
      continue
    }
    if (entriesByPath.has(entry.path)) {
      ambiguousEntries.push(entry)
      continue
    }
    entriesByPath.set(entry.path, entry)
  }

  for (const file of verifiedFiles) {
    if (!file || !['create', 'update', 'unchanged'].includes(file.action)) continue
    if (
      !['agents', 'skills', 'instructions', 'prompts', 'commands', 'plugins', 'runtime'].includes(
        file.component,
      )
    )
      continue
    if (!selected.has(file.component)) continue
    const relPath = relativeTargetPath(root, file.path)
    const existing = entriesByPath.get(relPath)
    if (existing && existing.component !== file.component) continue
    if (file.action === 'unchanged' && !existing) continue
    if (!validHash(file.sha256)) continue
    const live = inspectRegularFile(root, relPath)
    if (live.kind !== 'regular' || live.sha256 !== file.sha256) continue
    const entry = {
      path: relPath,
      component: file.component,
      layout: String(file.layout),
      sha256: live.sha256,
      mode: live.mode,
    }
    entriesByPath.set(relPath, entry)
  }

  // The selected set is intentionally not used to filter existing entries:
  // a narrow install must never erase ownership records for other components.
  inventory.entries = [...entriesByPath.values(), ...ambiguousEntries].sort((a, b) =>
    String(a?.path ?? '').localeCompare(String(b?.path ?? '')),
  )
  state.file_inventory = inventory
  return true
}

function normalizeDesiredFiles(target, desiredFiles) {
  const result = new Map()
  const source =
    desiredFiles instanceof Map ? desiredFiles.entries() : Object.entries(desiredFiles ?? {})
  for (const [path, value] of source) {
    if (typeof path !== 'string') continue
    let relPath
    try {
      relPath = path.startsWith('/') ? relativeTargetPath(target, path) : path
    } catch {
      continue
    }
    if (!safeRelativePath(relPath)) continue
    const sha256 = value?.sha256 ?? value?.outputFingerprint
    if (validHash(sha256)) result.set(relPath, { ...value, sha256 })
  }
  return result
}

/** Classify owned paths; only stale-owned regular files become removal candidates. */
export function classifyFileInventory(
  target,
  state,
  {
    desiredFiles = new Map(),
    desiredUnavailable = false,
    selectedComponents = [],
    selectedLayouts = {},
  } = {},
) {
  const root = rootInfo(target)
  const inventory = state?.file_inventory
  if (
    !inventory ||
    inventory.schema_version !== FILE_INVENTORY_VERSION ||
    !Array.isArray(inventory.entries) ||
    typeof inventory.legacy_unknown !== 'boolean'
  ) {
    return {
      target: root,
      manualReview: true,
      inventoryFingerprint: null,
      entries: [
        {
          path: '(legacy installation)',
          classification: 'ambiguous',
          reason: 'inventory-unavailable',
        },
      ],
      operations: [],
    }
  }

  const rootMismatch = !inventoryRootMatches(inventory.target_root, root)
  const selected = new Set(selectedComponents)
  const layoutFor = (component) =>
    selectedLayouts instanceof Map ? selectedLayouts.get(component) : selectedLayouts?.[component]
  const desired = normalizeDesiredFiles(root, desiredFiles)
  const seen = new Set()
  const entries = []
  const operations = []
  let invalid = false
  for (const owned of inventory.entries) {
    const path = typeof owned?.path === 'string' ? owned.path : '(invalid inventory path)'
    if (
      !owned ||
      !safeRelativePath(owned.path) ||
      typeof owned.component !== 'string' ||
      typeof owned.layout !== 'string' ||
      !validHash(owned.sha256) ||
      !Number.isInteger(owned.mode) ||
      owned.mode < 0 ||
      owned.mode > 0o777 ||
      seen.has(owned.path)
    ) {
      invalid = true
      entries.push({ path, classification: 'ambiguous', reason: 'invalid-or-duplicate-entry' })
      continue
    }
    seen.add(owned.path)
    if (rootMismatch) {
      entries.push({
        path,
        component: owned.component,
        classification: 'ambiguous',
        reason: 'target-root-mismatch',
      })
      continue
    }
    if (!selected.has(owned.component)) {
      entries.push({ path, component: owned.component, classification: 'unselected' })
      continue
    }
    const selectedLayout = layoutFor(owned.component)
    if (selectedLayout && selectedLayout !== owned.layout) {
      entries.push({
        path,
        component: owned.component,
        classification: 'ambiguous',
        reason: 'layout-mismatch',
      })
      invalid = true
      continue
    }
    const live = inspectRegularFile(root, owned.path)
    if (live.kind === 'missing') {
      entries.push({ path: owned.path, component: owned.component, classification: 'missing' })
      continue
    }
    if (live.kind !== 'regular') {
      entries.push({
        path: owned.path,
        component: owned.component,
        classification: 'ambiguous',
        reason: live.reason,
      })
      continue
    }
    if (live.sha256 !== owned.sha256) {
      entries.push({ path: owned.path, component: owned.component, classification: 'modified' })
      continue
    }
    const current = desired.get(owned.path)
    if (!current && desiredUnavailable) {
      entries.push({
        path: owned.path,
        component: owned.component,
        classification: 'recorded-current',
      })
      continue
    }
    if (current) {
      entries.push({
        path: owned.path,
        component: owned.component,
        classification: current.sha256 === live.sha256 ? 'current' : 'update-drift',
      })
      continue
    }
    // Desired payload may be unavailable (e.g. optional runtime output); only
    // a path omitted from the current selected install plan is stale-owned.
    entries.push({ path: owned.path, component: owned.component, classification: 'stale-owned' })
    operations.push({
      path: owned.path,
      sha256: owned.sha256,
      mode: owned.mode,
      component: owned.component,
    })
  }
  operations.sort((a, b) => a.path.localeCompare(b.path))
  return {
    target: root,
    manualReview:
      rootMismatch ||
      invalid ||
      (inventory.legacy_unknown === true && inventory.entries.length === 0),
    legacyAmbiguous: inventory.legacy_unknown === true,
    inventoryFingerprint: inventoryFingerprint(inventory),
    entries,
    operations: rootMismatch || invalid ? [] : operations,
  }
}

function operationSet(operations) {
  return [...operations]
    .map(({ path, sha256, mode, component }) => ({ path, sha256, mode, component }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function readValidatedStateForApply(root) {
  const stateFile = join(root, '.pantheon', 'install-state.json')
  assertNoSymlinkAncestors(stateFile)

  const pathInfo = lstatSync(stateFile)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw new Error('Installer ownership state must be a regular file; aborting before removal')
  }

  let descriptor
  try {
    descriptor = openSync(stateFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile()) {
      throw new Error('Installer ownership state must be a regular file; aborting before removal')
    }
    const contents = readFileSync(descriptor, 'utf8')
    const after = fstatSync(descriptor)
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size) {
      throw new Error('Installer ownership state changed while being read; aborting before removal')
    }

    let state
    try {
      state = JSON.parse(contents)
    } catch {
      throw new Error('Installer ownership state is unreadable; aborting before removal')
    }
    const inventory = state?.file_inventory
    if (
      !state ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      state.schema_version !== 2 ||
      !inventory ||
      typeof inventory !== 'object' ||
      Array.isArray(inventory) ||
      inventory.schema_version !== FILE_INVENTORY_VERSION ||
      !inventoryRootMatches(inventory.target_root, root) ||
      !Array.isArray(inventory.entries) ||
      typeof inventory.legacy_unknown !== 'boolean'
    ) {
      throw new Error('Installer ownership state or inventory is invalid for this target')
    }
    return state
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/**
 * Apply only the exact reviewed stale-file set. Hashes and operation set are
 * checked before backup and again after backup; deletion is unlink-only.
 */
export function applyFileDriftPlan(
  target,
  state,
  reviewedPlan,
  {
    desiredFiles = new Map(),
    selectedComponents = [],
    selectedLayouts = {},
    clock = () => new Date(),
  } = {},
) {
  const root = rootInfo(target)
  if (!reviewedPlan || reviewedPlan.target !== root || reviewedPlan.manualReview) {
    throw new Error('Refusing apply: inventory is ambiguous or reviewed target differs')
  }
  const fresh = classifyFileInventory(root, state, {
    desiredFiles,
    selectedComponents,
    selectedLayouts,
  })
  if (
    fresh.manualReview ||
    fresh.inventoryFingerprint !== reviewedPlan.inventoryFingerprint ||
    JSON.stringify(operationSet(fresh.operations)) !==
      JSON.stringify(operationSet(reviewedPlan.operations))
  ) {
    throw new Error('Reviewed installer drift plan changed; no files were removed')
  }
  if (fresh.operations.length === 0) return { removed: [], backupDir: null }

  const validateOperations = () => {
    const persistedState = readValidatedStateForApply(root)
    const now = classifyFileInventory(root, persistedState, {
      desiredFiles,
      selectedComponents,
      selectedLayouts,
    })
    if (
      now.manualReview ||
      now.inventoryFingerprint !== reviewedPlan.inventoryFingerprint ||
      JSON.stringify(operationSet(now.operations)) !==
        JSON.stringify(operationSet(reviewedPlan.operations))
    ) {
      throw new Error('Reviewed installer drift operation set changed; aborting before removal')
    }
    for (const operation of reviewedPlan.operations) {
      const live = inspectRegularFile(root, operation.path)
      if (
        live.kind !== 'regular' ||
        live.sha256 !== operation.sha256 ||
        live.mode !== operation.mode
      ) {
        throw new Error(
          `Reviewed installer drift target changed; aborting before removal: ${operation.path}`,
        )
      }
    }
    return persistedState
  }

  const stateBeforeBackup = validateOperations()
  const backup = createBackupSet({
    configDir: root,
    entries: reviewedPlan.operations.map((operation) => operation.path),
    packageVersion: stateBeforeBackup.pantheon_version ?? 'unknown',
    clock,
    keep: 0,
  })
  const persistedState = validateOperations()

  for (const operation of reviewedPlan.operations) {
    const filePath = join(root, ...operation.path.split('/'))
    assertNoSymlinkAncestors(filePath)
    const live = inspectRegularFile(root, operation.path)
    if (
      live.kind !== 'regular' ||
      live.sha256 !== operation.sha256 ||
      live.mode !== operation.mode
    ) {
      throw new Error(`Reviewed installer drift target changed during apply: ${operation.path}`)
    }
    unlinkSync(filePath)
    verifyPathRemoved(filePath)
  }

  const removedPaths = new Set(reviewedPlan.operations.map((operation) => operation.path))
  persistedState.file_inventory.entries = persistedState.file_inventory.entries.filter(
    (entry) => !removedPaths.has(entry.path),
  )
  writeState(root, persistedState)
  return { removed: [...removedPaths].sort(), backupDir: backup.dir }
}
