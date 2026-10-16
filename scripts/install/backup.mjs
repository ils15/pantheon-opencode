/**
 * backup.mjs — Exact backup sets for the Pantheon installer (Beta 11 Setup,
 * phase 2).
 *
 * Before the installer modifies or creates a file, the CURRENT state of every
 * affected path is preserved byte-for-byte under
 * `<configDir>/.pantheon/backups/<UTC-timestamp>/`, mirroring the path relative
 * to `configDir`, and described by a `manifest.json`. Files that do not exist
 * yet are recorded as absent so a restore can reproduce the original state
 * exactly.
 *
 * SECURITY
 * --------
 * A backup is an exact copy, so it can contain API keys or tokens that were
 * already in the user's files. This module therefore:
 *   - never prints file contents, values or hashes (only paths / counts / modes);
 *   - writes the backup directory `0700` and every file `0600`.
 * Windows is best-effort: `chmodSync` is attempted and a failure never aborts.
 *
 * SCOPE
 * -----
 * IN scope (byte-for-byte, restorable): every regular file the install can
 * modify, rewrite, or remove INSIDE the config dir — including stale files that
 * a `--clean` run deletes.
 * OUT of scope (recorded in `manifest.notRevertible`, never restored): bulk
 * directories whose byte-for-byte copy is not feasible (`.venv`, the plugin
 * dir with its `node_modules`) and files OUTSIDE the config dir (the global
 * `tui.json` copies and the global `opencode-vision.json`). The manifest states
 * these explicitly rather than silently omitting them.
 *
 * The functions are `pure-ish`: they take explicit paths and an injectable
 * `clock`, return data (never logging), and are safe to unit-test without a
 * running installer.
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertNoSymlinkAncestors, verifyRegularFile, writeFileAtomically } from './verify.mjs'

/** Directory (relative to the config dir) that holds the backup sets. */
export const BACKUP_SUBDIR = join('.pantheon', 'backups')

/** Number of most-recent backup sets retained. */
export const DEFAULT_KEEP = 5

/** UTC timestamp directory name: `YYYY-MM-DDTHH-MM-SSZ` (filesystem-safe). */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/

/**
 * Format a Date as the backup-directory timestamp.
 * @param {Date} date
 * @returns {string}
 */
export function formatTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-')
}

/**
 * Whether a directory name is one of our timestamped backup sets. Used as the
 * guard so retention can never delete a directory we did not create.
 * @param {string} name
 * @returns {boolean}
 */
export function isBackupDirName(name) {
  return typeof name === 'string' && TIMESTAMP_RE.test(name)
}

/** Absolute path of the backups root for a config dir. */
export function backupRoot(configDir) {
  return join(configDir, BACKUP_SUBDIR)
}

/** Absolute path of a named backup set. */
export function backupSetPath(configDir, name) {
  return join(backupRoot(configDir), name)
}

/**
 * Whether `candidate` is a direct child of `root` (no traversal). Pure string
 * check — the retention path guard.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
export function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '') return false
  return (
    !rel.startsWith('..') && !rel.split(sep).includes('..') && !resolve(candidate).startsWith('..')
  )
}

/**
 * Guard for a deletable backup set: it must live directly under
 * `<configDir>/.pantheon/backups/` AND its name must match the timestamp
 * pattern. Nothing else may ever be removed by retention.
 * @param {string} configDir
 * @param {string} dir
 * @returns {boolean}
 */
export function isDeletableBackupDir(configDir, dir) {
  const root = backupRoot(configDir)
  if (!isWithin(root, dir)) return false
  const rel = relative(resolve(root), resolve(dir))
  return isBackupDirName(rel)
}

/** List backup sets, newest first. */
export function listBackupSets(configDir) {
  const root = backupRoot(configDir)
  if (!existsSync(root)) return []
  const sets = []
  for (const name of readdirSync(root)) {
    if (!isBackupDirName(name)) continue
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    sets.push({ name, dir })
  }
  sets.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return sets
}

/**
 * Choose the next free backup-set name for `configDir`. Second-granularity names
 * collide when two sets are created in the same second (apply immediately
 * followed by a pre-restore snapshot); the seconds are bumped until the name is
 * free so a new set never overwrites an existing one. Shared by the apply path
 * and the dry-run preview so both agree.
 *
 * @param {string} configDir
 * @param {Date} [base]
 * @returns {string}
 */
export function nextBackupName(configDir, base = new Date()) {
  let name = formatTimestamp(base)
  let bump = 0
  while (existsSync(backupSetPath(configDir, name))) {
    bump += 1
    name = formatTimestamp(new Date(base.getTime() + bump * 1000))
  }
  return name
}

/** sha256 hex of a buffer. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function chmodBestEffort(path, mode) {
  try {
    chmodSync(path, mode)
  } catch {
    // Windows / exotic filesystems: best-effort only.
  }
}

/**
 * Create a directory ONLY when it is absent, and never chmod a directory that
 * already exists. Chmodding a pre-existing directory is an irreversible side
 * effect on the user's tree (F1): restoring into a project would otherwise
 * rewrite the project root to 0700. Bulk-directory modes are out of scope for
 * the exact backup (see `notRevertible`).
 */
function ensureDir(path, mode) {
  assertNoSymlinkAncestors(path)
  let info = null
  try {
    info = lstatSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
  }
  if (info) {
    if (!info.isDirectory()) throw new Error(`Backup path is not a directory: ${path}`)
    return
  }
  mkdirSync(path, { recursive: true, mode })
  assertNoSymlinkAncestors(path)
  info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Backup path is not a regular directory: ${path}`)
  }
  chmodBestEffort(path, mode)
}

function assertBackupEntry(configDir, relativePath) {
  const rel = String(relativePath)
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part === '..' || part === '')) {
    throw new Error(`Unsafe backup entry path: ${rel}`)
  }
  const source = resolve(configDir, rel)
  const fromRoot = relative(resolve(configDir), source)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Backup entry escapes config directory: ${rel}`)
  }
  return { rel, source }
}

/**
 * Create an exact backup set for `entries` (paths relative to `configDir`).
 *
 * A path that exists as a regular file is copied byte-for-byte with mode 0600
 * and hashed; anything else (absent, directory, symlink) is recorded as absent.
 * The whole set is written before this function returns, so a caller can run it
 * BEFORE the first modifying write.
 *
 * @param {object} opts
 * @param {string} opts.configDir
 * @param {string[]} opts.entries - relative paths (deduped, order preserved)
 * @param {string[]} [opts.notRevertible] - paths the run may delete but cannot
 *   capture byte-for-byte (bulk dirs like `.venv`/plugin `node_modules`, or
 *   out-of-target global files). Recorded in the manifest so the guarantee is
 *   honest, never restored.
 * @param {string} [opts.packageVersion]
 * @param {() => Date} [opts.clock]
 * @param {number} [opts.keep=DEFAULT_KEEP] - retained sets (0 = no pruning)
 * @returns {{ dir: string, name: string, manifest: object }}
 */
export function createBackupSet({
  configDir,
  entries,
  notRevertible = [],
  packageVersion = 'unknown',
  clock = () => new Date(),
  keep = DEFAULT_KEEP,
} = {}) {
  assertNoSymlinkAncestors(configDir)
  const base = clock()
  const name = nextBackupName(configDir, base)
  const dir = backupSetPath(configDir, name)
  ensureDir(backupRoot(configDir), 0o700)
  ensureDir(dir, 0o700)

  const seen = new Set()
  const manifestEntries = []
  for (const relativePath of entries ?? []) {
    const { rel, source } = assertBackupEntry(configDir, relativePath)
    if (rel === '' || seen.has(rel)) continue
    seen.add(rel)
    assertNoSymlinkAncestors(source, { includeLeaf: false })
    let stat = null
    try {
      stat = lstatSync(source)
    } catch {
      stat = null
    }
    if (stat?.isFile()) {
      const buffer = readFileSync(source)
      const dest = join(dir, rel)
      ensureDir(dirname(dest), 0o700)
      assertNoSymlinkAncestors(dest)
      writeFileSync(dest, buffer, { mode: 0o600, flag: 'wx' })
      chmodBestEffort(dest, 0o600)
      verifyRegularFile(dest, buffer)
      manifestEntries.push({
        relativePath: rel,
        existed: true,
        sha256: sha256(buffer),
        bytes: buffer.length,
        mode: stat.mode & 0o777,
      })
    } else {
      manifestEntries.push({
        relativePath: rel,
        existed: false,
        sha256: null,
        bytes: 0,
        mode: null,
      })
    }
  }

  const manifest = {
    createdAt: base.toISOString(),
    packageVersion,
    configDir,
    notRevertible: [...new Set((notRevertible ?? []).map(String))],
    entries: manifestEntries,
  }
  const manifestPath = join(dir, 'manifest.json')
  assertNoSymlinkAncestors(manifestPath)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  chmodBestEffort(manifestPath, 0o600)
  verifyRegularFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const pruned = keep > 0 ? pruneBackups(configDir, keep) : { removed: [], failures: [] }
  return { dir, name, manifest, pruned }
}

/** Build the exact backup outputs without writing files. */
export function previewBackupSet({
  configDir,
  entries,
  notRevertible = [],
  packageVersion = 'unknown',
  clock = () => new Date(),
} = {}) {
  const base = clock()
  const name = nextBackupName(configDir, base)
  const dir = backupSetPath(configDir, name)
  const seen = new Set()
  const manifestEntries = []
  const files = []
  for (const relativePath of entries ?? []) {
    const rel = String(relativePath)
    if (rel === '' || seen.has(rel)) continue
    seen.add(rel)
    const source = join(configDir, rel)
    let stat = null
    try {
      stat = lstatSync(source)
    } catch {}
    if (stat?.isFile()) {
      const buffer = readFileSync(source)
      files.push({
        path: join(dir, rel),
        bytes: buffer.length,
        outputFingerprint: sha256(buffer),
      })
      manifestEntries.push({
        relativePath: rel,
        existed: true,
        sha256: sha256(buffer),
        bytes: buffer.length,
        mode: stat.mode & 0o777,
      })
    } else {
      manifestEntries.push({
        relativePath: rel,
        existed: false,
        sha256: null,
        bytes: 0,
        mode: null,
      })
    }
  }
  const manifest = {
    createdAt: base.toISOString(),
    packageVersion,
    configDir,
    notRevertible: [...new Set((notRevertible ?? []).map(String))],
    entries: manifestEntries,
  }
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`
  return {
    dir,
    files,
    manifestPath: join(dir, 'manifest.json'),
    manifestBytes: Buffer.byteLength(manifestContent, 'utf8'),
    manifestFingerprint: sha256(Buffer.from(manifestContent)),
  }
}

/**
 * A manifest entry path must be a plain relative path inside the config dir —
 * no absolute path and no `..` segment (the backup mirrors the config dir).
 * Rejected at read time so a crafted manifest can never steer verify or restore
 * outside the tree.
 * @param {unknown} rel
 * @returns {boolean}
 */
function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel === '') return false
  if (isAbsolute(rel)) return false
  return !rel.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')
}

function assertRestoreRoot(configDir) {
  const root = resolve(configDir)
  assertNoSymlinkAncestors(root)
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Restore config root is not a regular directory')
  }
  return { root, canonicalRoot: realpathSync(root) }
}

function assertRestoreTarget(root, canonicalRoot, relativePath) {
  if (!isSafeRelativePath(relativePath)) throw new Error('Unsafe restore target path')
  const target = resolve(root, relativePath)
  const lexical = relative(root, target)
  if (!lexical || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error('Restore target escapes config directory')
  }

  assertNoSymlinkAncestors(target)

  let existing = target
  let canonicalExisting
  while (true) {
    try {
      canonicalExisting = realpathSync(existing)
      break
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }
  const canonicalTarget = resolve(canonicalExisting, relative(existing, target))
  const canonicalRelative = relative(canonicalRoot, canonicalTarget)
  if (
    canonicalRelative === '..' ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative)
  ) {
    throw new Error('Restore target escapes config directory')
  }
  return target
}

/**
 * Read and validate the manifest of a backup set.
 *
 * VALIDATION SCOPE (documented, not implied): this rejects a malformed manifest
 * and any entry whose `relativePath` is absolute or contains `..` (fail closed).
 * It does NOT make the manifest self-verifying — a DROPPED entry or a flipped
 * `existed` flag cannot be detected from the manifest alone. Tampering with the
 * CONTENT of a listed file (newline/truncation/hash change) IS detected by
 * {@link verifyBackupSet}, because each listed file is re-hashed.
 *
 * @param {string} dir
 * @returns {{ ok: true, manifest: object } | { ok: false, reason: string }}
 */
export function readManifest(dir) {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return { ok: false, reason: 'missing-manifest' }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!manifest || !Array.isArray(manifest.entries)) {
      return { ok: false, reason: 'invalid-manifest' }
    }
    if (manifest.entries.some((e) => !e || !isSafeRelativePath(e.relativePath))) {
      return { ok: false, reason: 'unsafe-path' }
    }
    return { ok: true, manifest }
  } catch {
    return { ok: false, reason: 'invalid-manifest' }
  }
}

/**
 * Verify every backed-up file still matches its manifest hash. Any missing file
 * or hash mismatch is reported (no silent partial restore).
 * @param {string} dir
 * @returns {{ ok: boolean, reason?: string, mismatches: string[] }}
 */
export function verifyBackupSet(dir) {
  const read = readManifest(dir)
  if (!read.ok) return { ok: false, reason: read.reason, mismatches: [] }
  const mismatches = []
  for (const entry of read.manifest.entries) {
    if (!entry.existed) continue
    const file = join(dir, entry.relativePath)
    if (!existsSync(file)) {
      mismatches.push(entry.relativePath)
      continue
    }
    if (sha256(readFileSync(file)) !== entry.sha256) mismatches.push(entry.relativePath)
  }
  return { ok: mismatches.length === 0, mismatches }
}

/** Order for writes: `opencode.json` strictly last. */
function restoreOrder(a, b) {
  const last = (rel) => (rel === 'opencode.json' ? 1 : 0)
  if (last(a.relativePath) !== last(b.relativePath))
    return last(a.relativePath) - last(b.relativePath)
  return a.relativePath.localeCompare(b.relativePath)
}

/**
 * Compute the restore plan by PATH ONLY (no contents exposed). Absent-in-backup
 * entries that now exist become `remove`; a present target is hashed internally
 * to classify it as `unchanged` or `update`. Hashes are never returned or
 * printed at this layer — only `{ relativePath, action }`.
 *
 * @param {string} dir - backup set directory
 * @param {string} configDir
 * @returns {{ entries: Array<{relativePath: string, action: string}>, manifest: object } | { error: string }}
 */
export function planRestore(dir, configDir) {
  let root
  let canonicalRoot
  try {
    ;({ root, canonicalRoot } = assertRestoreRoot(configDir))
  } catch {
    return { error: 'unsafe-target-root' }
  }
  const read = readManifest(dir)
  if (!read.ok) return { error: read.reason }
  const verify = verifyBackupSet(dir)
  if (!verify.ok) return { error: verify.reason ?? 'integrity', mismatches: verify.mismatches }

  try {
    for (const entry of read.manifest.entries) {
      assertRestoreTarget(root, canonicalRoot, entry.relativePath)
    }
  } catch {
    return { error: 'unsafe-target-path' }
  }

  const entries = []
  for (const entry of [...read.manifest.entries].sort(restoreOrder)) {
    const target = assertRestoreTarget(root, canonicalRoot, entry.relativePath)
    if (entry.existed) {
      let action = 'create'
      try {
        const st = lstatSync(target)
        if (st.isFile()) {
          assertRestoreTarget(root, canonicalRoot, entry.relativePath)
          const current = readFileSync(target)
          action = sha256(current) === entry.sha256 ? 'unchanged' : 'update'
        } else {
          action = 'update'
        }
      } catch {
        action = 'create'
      }
      entries.push({ relativePath: entry.relativePath, action })
    } else {
      assertRestoreTarget(root, canonicalRoot, entry.relativePath)
      const exists = existsSync(target)
      entries.push({ relativePath: entry.relativePath, action: exists ? 'remove' : 'unchanged' })
    }
  }
  return { entries, manifest: read.manifest }
}

/**
 * Restore a verified backup set into `configDir`. Refuses (throws) if the
 * manifest is missing/invalid or any backed-up file is tampered.
 *
 * @param {string} dir
 * @param {string} configDir
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ entries: Array<{relativePath: string, action: string}> }}
 */
export function restoreBackupSet(dir, configDir, { dryRun = false } = {}) {
  const plan = planRestore(dir, configDir)
  if (plan.error) {
    const detail = plan.mismatches?.length ? ` (${plan.mismatches.length} mismatch(es))` : ''
    throw new Error(`Backup is not restorable: ${plan.error}${detail}`)
  }
  const { root, canonicalRoot } = assertRestoreRoot(configDir)
  for (const item of plan.entries) {
    assertRestoreTarget(root, canonicalRoot, item.relativePath)
  }
  if (dryRun) return { entries: plan.entries }

  for (const item of plan.entries) {
    const backUpFile = join(dir, item.relativePath)
    const target = assertRestoreTarget(root, canonicalRoot, item.relativePath)
    if (item.action === 'unchanged') continue

    let linkStat = null
    try {
      linkStat = lstatSync(target)
    } catch {
      linkStat = null
    }
    if (linkStat?.isSymbolicLink())
      throw new Error(`Refusing to restore through symlink: ${item.relativePath}`)

    if (item.action === 'remove') {
      if (linkStat?.isFile()) {
        assertRestoreTarget(root, canonicalRoot, item.relativePath)
        const current = lstatSync(target)
        if (current.isSymbolicLink()) {
          throw new Error(`Refusing to restore through symlink: ${item.relativePath}`)
        }
        if (current.isFile()) rmSync(target, { force: true })
      }
      continue
    }

    const buffer = readFileSync(backUpFile)
    ensureDir(dirname(target), 0o700)
    assertRestoreTarget(root, canonicalRoot, item.relativePath)
    writeFileAtomically(target, buffer)
    const recorded = plan.manifest.entries.find((e) => e.relativePath === item.relativePath)
    if (recorded && recorded.mode !== null) {
      assertRestoreTarget(root, canonicalRoot, item.relativePath)
      chmodBestEffort(target, recorded.mode)
    }
  }
  return { entries: plan.entries }
}

/**
 * Delete all but the `keep` most-recent backup sets under the config dir.
 * Only directories that pass {@link isDeletableBackupDir} are ever removed;
 * deletion failures are reported, never thrown.
 *
 * @param {string} configDir
 * @param {number} [keep=DEFAULT_KEEP]
 * @returns {{ removed: string[], failures: string[] }}
 */
export function pruneBackups(configDir, keep = DEFAULT_KEEP) {
  const removed = []
  const failures = []
  const sets = listBackupSets(configDir)
  for (const set of sets.slice(keep)) {
    if (!isDeletableBackupDir(configDir, set.dir)) continue
    try {
      rmSync(set.dir, { recursive: true, force: true })
      removed.push(set.name)
    } catch {
      failures.push(set.name)
    }
  }
  return { removed, failures }
}

/**
 * The one-time, exact, secret-safe warning printed before the installer applies.
 * @param {string} backupPath
 * @returns {string}
 */
export function backupWarning(backupPath) {
  return (
    `Backup created at ${backupPath} (mode 0600). It is an exact copy of your ` +
    `current files and therefore also contains any API keys or tokens already ` +
    `present in them. It is never printed. Restore with: pantheon-opencode restore`
  )
}
