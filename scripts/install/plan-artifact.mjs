/** Versioned, content-free install-plan artifacts and path/snapshot validation. */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export const INSTALL_PLAN_SCHEMA_VERSION = 1
const ACTIONS = new Set(['create', 'update', 'remove', 'unchanged', 'conflict'])
const IGNORED_SOURCE_DIRS = new Set([
  '.git',
  '.pantheon',
  'node_modules',
  'tests',
  'logs',
  'bench',
  'benchmarks',
  'bench-run-A',
])

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

function isWithin(root, path) {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Reject symlinks in the target and every existing destination ancestor. */
export function assertSafeDestination(target, relativePath) {
  const root = resolve(target)
  const rootStat = lstatOrNull(root)
  if (rootStat?.isSymbolicLink()) throw new Error(`Target is a symlink: ${root}`)
  if (rootStat && !rootStat.isDirectory()) throw new Error(`Target is not a directory: ${root}`)
  if (
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Unsafe plan destination path: ${relativePath}`)
  }
  const destination = resolve(root, relativePath)
  if (!isWithin(root, destination))
    throw new Error(`Plan destination escapes target: ${relativePath}`)
  let current = root
  for (const segment of relativePath.split(/[\\/]/)) {
    current = join(current, segment)
    const info = lstatOrNull(current)
    if (info?.isSymbolicLink()) throw new Error(`Plan destination contains a symlink: ${current}`)
    if (info && current !== destination && !info.isDirectory()) {
      throw new Error(`Plan destination parent is not a directory: ${current}`)
    }
    if (current === destination && info && !info.isFile() && !info.isDirectory()) {
      throw new Error(`Unsupported plan destination type: ${current}`)
    }
  }
  return destination
}

function relativePlanPath(target, absolutePath) {
  const rel = relative(resolve(target), resolve(absolutePath))
  if (!isWithin(target, absolutePath) || !rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Install plan operation is outside its target: ${absolutePath}`)
  }
  return rel.split(sep).join('/')
}

function allowedExternalTuiPaths() {
  const home = homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return new Set([
    resolve(home, '.opencode', 'tui.json'),
    resolve(xdgConfig, 'opencode', 'tui.json'),
  ])
}

function assertSafeExternalDestination(path) {
  const absolute = resolve(path)
  if (!allowedExternalTuiPaths().has(absolute)) {
    throw new Error(`Install plan external operation is not an allowed TUI config: ${absolute}`)
  }
  assertNoSymlinkAncestors(absolute)
  const info = lstatOrNull(absolute)
  if (info && !info.isFile()) {
    throw new Error(`Install plan external destination is not a regular file: ${absolute}`)
  }
  return absolute
}

function operationLocation(target, absolutePath) {
  const absolute = resolve(absolutePath)
  if (isWithin(target, absolute)) return { path: relativePlanPath(target, absolute) }
  assertSafeExternalDestination(absolute)
  return { path: absolute, scope: 'user-config' }
}

function assertNoPlanPathCollision(path, { packageRoot, target, operations }) {
  const destination = resolve(path)
  if (destination === resolve(packageRoot)) {
    throw new Error(`Plan artifact destination collides with package source: ${destination}`)
  }
  if (destination === resolve(target)) {
    throw new Error(`Plan artifact destination collides with install target: ${destination}`)
  }
  for (const operation of operations) {
    const operationPath =
      operation.scope === 'user-config' ? resolve(operation.path) : resolve(target, operation.path)
    if (isWithin(operationPath, destination) || isWithin(destination, operationPath)) {
      throw new Error(`Plan artifact destination collides with planned operation: ${destination}`)
    }
  }
}

/** Hash package source identities without exposing paths' contents or hashes. */
export function sourceFingerprint(packageRoot, excludedPaths = []) {
  const root = resolve(packageRoot)
  const excluded = new Set(excludedPaths.filter(Boolean).map((path) => resolve(path)))
  const records = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (directory === root && IGNORED_SOURCE_DIRS.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (excluded.has(resolve(path))) continue
      const rel = relative(root, path).split(sep).join('/')
      const info = lstatSync(path)
      if (info.isSymbolicLink()) records.push(`L\0${rel}\0${readlinkSync(path)}`)
      else if (info.isDirectory()) walk(path)
      else if (info.isFile()) records.push(`F\0${rel}\0${hash(readFileSync(path))}`)
    }
  }
  walk(root)
  return hash(records.join('\n'))
}

/** Create a versioned plan containing paths and fingerprints, never contents. */
export function createPlanArtifact({
  target,
  packageRoot,
  packageVersion,
  plannedAt,
  artifactPath = null,
  options,
  files,
  snapshots,
}) {
  const resolvedTarget = resolve(target)
  const snapshotByPath = new Map(snapshots.map((item) => [resolve(item.path), item]))
  const operations = files.map((file) => {
    const location = operationLocation(resolvedTarget, file.path)
    const path = location.path
    if (location.scope) assertSafeExternalDestination(path)
    else assertSafeDestination(resolvedTarget, path)
    const before = snapshotByPath.get(resolve(file.path))
    if (!before) throw new Error(`Missing destination snapshot for planned path: ${path}`)
    return {
      ...location,
      action: file.action,
      bytes: file.bytes,
      outputFingerprint: file.outputFingerprint ?? null,
      before: {
        exists: before.exists,
        sha256: before.sha256,
        size: before.size,
        mode: before.mode,
      },
    }
  })
  if (artifactPath) {
    assertNoPlanPathCollision(artifactPath, {
      packageRoot,
      target: resolvedTarget,
      operations,
    })
  }
  const targetInfo = lstatOrNull(resolvedTarget)
  const targetRealpath = targetInfo?.isDirectory() ? realpathSync(resolvedTarget) : null
  return {
    schema_version: INSTALL_PLAN_SCHEMA_VERSION,
    planned_at: plannedAt,
    artifact_path: artifactPath ? resolve(artifactPath) : null,
    package: {
      root: resolve(packageRoot),
      realpath: realpathSync(packageRoot),
      version: packageVersion,
      source_fingerprint: sourceFingerprint(packageRoot, [artifactPath]),
    },
    target: { path: resolvedTarget, realpath: targetRealpath },
    options: structuredClone(options),
    operations,
  }
}

/** Validate the closed artifact shape and every destination path. */
export function validatePlanArtifact(artifact) {
  if (
    !artifact ||
    typeof artifact !== 'object' ||
    artifact.schema_version !== INSTALL_PLAN_SCHEMA_VERSION
  ) {
    throw new Error('Unsupported or invalid install-plan artifact version')
  }
  if (
    !artifact.package ||
    typeof artifact.package.root !== 'string' ||
    typeof artifact.package.realpath !== 'string' ||
    typeof artifact.package.version !== 'string' ||
    !/^[a-f0-9]{64}$/.test(artifact.package.source_fingerprint)
  )
    throw new Error('Invalid install-plan package identity')
  if (
    typeof artifact.planned_at !== 'string' ||
    !Number.isFinite(Date.parse(artifact.planned_at))
  ) {
    throw new Error('Invalid install-plan timestamp')
  }
  if (
    artifact.artifact_path !== null &&
    (typeof artifact.artifact_path !== 'string' || !isAbsolute(artifact.artifact_path))
  ) {
    throw new Error('Invalid install-plan artifact identity')
  }
  if (
    !artifact.target ||
    typeof artifact.target.path !== 'string' ||
    !isAbsolute(artifact.target.path)
  ) {
    throw new Error('Invalid install-plan target identity')
  }
  if (artifact.target.realpath !== null && typeof artifact.target.realpath !== 'string') {
    throw new Error('Invalid install-plan target realpath')
  }
  if (
    !artifact.options ||
    typeof artifact.options !== 'object' ||
    Array.isArray(artifact.options)
  ) {
    throw new Error('Invalid install-plan options')
  }
  if (!Array.isArray(artifact.operations)) throw new Error('Invalid install-plan operations')
  const seen = new Set()
  for (const operation of artifact.operations) {
    if (
      !operation ||
      typeof operation.path !== 'string' ||
      !operation.path ||
      (operation.scope === undefined &&
        (operation.path.split('/').some((part) => part === '..' || part === '') ||
          isAbsolute(operation.path))) ||
      (operation.scope !== undefined &&
        (operation.scope !== 'user-config' ||
          !isAbsolute(operation.path) ||
          !allowedExternalTuiPaths().has(resolve(operation.path)))) ||
      !ACTIONS.has(operation.action) ||
      !Number.isSafeInteger(operation.bytes) ||
      operation.bytes < 0 ||
      (operation.outputFingerprint !== null && !/^[a-f0-9]{64}$/.test(operation.outputFingerprint))
    )
      throw new Error('Invalid install-plan operation path or metadata')
    if (operation.scope === 'user-config') assertSafeExternalDestination(operation.path)
    if (seen.has(operation.path)) throw new Error(`Duplicate install-plan path: ${operation.path}`)
    seen.add(operation.path)
    const before = operation.before
    if (
      !before ||
      typeof before.exists !== 'boolean' ||
      (before.sha256 !== null && !/^[a-f0-9]{64}$/.test(before.sha256)) ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      (before.mode !== null && !Number.isSafeInteger(before.mode))
    )
      throw new Error(`Invalid destination snapshot for ${operation.path}`)
  }
  return artifact
}

function assertNoSymlinkAncestors(path) {
  const absolute = resolve(path)
  const parts = absolute.split(sep).filter(Boolean)
  let current = absolute.startsWith(sep) ? sep : ''
  for (const part of parts) {
    current = current ? join(current, part) : part
    const info = lstatOrNull(current)
    if (info?.isSymbolicLink()) throw new Error(`Plan artifact path contains a symlink: ${current}`)
  }
}

function openPinnedDirectory(path, { create = false } = {}) {
  let descriptorRoot
  if (process.platform === 'linux') descriptorRoot = '/proc/self/fd'
  else if (['darwin', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform))
    descriptorRoot = '/dev/fd'
  else {
    throw new Error(`Cannot safely save a plan artifact on ${process.platform}`)
  }

  const absolute = resolve(path)
  const root = parse(absolute).root
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  let directoryFd = openSync(root, directoryFlags)
  try {
    const descriptorDirectory = join(descriptorRoot, String(directoryFd))
    const probeFd = openSync(descriptorDirectory, constants.O_RDONLY | constants.O_DIRECTORY)
    closeSync(probeFd)

    for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
      const childPath = join(join(descriptorRoot, String(directoryFd)), segment)
      let info = lstatOrNull(childPath)
      if (info?.isSymbolicLink()) {
        throw new Error(`Plan artifact path contains a symlink: ${join(path, segment)}`)
      }
      if (!info && create) {
        try {
          mkdirSync(childPath, { mode: 0o700 })
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
        info = lstatOrNull(childPath)
      }
      if (info && !info.isDirectory()) {
        throw new Error(`Plan artifact parent is not a directory: ${path}`)
      }
      if (!info) throw new Error(`Plan artifact parent does not exist: ${path}`)

      const childFd = openSync(childPath, directoryFlags)
      if (!fstatSync(childFd).isDirectory()) {
        closeSync(childFd)
        throw new Error(`Plan artifact parent is not a directory: ${path}`)
      }
      closeSync(directoryFd)
      directoryFd = childFd
    }

    return {
      fd: directoryFd,
      path: join(descriptorRoot, String(directoryFd)),
    }
  } catch (error) {
    try {
      closeSync(directoryFd)
    } catch {}
    throw error
  }
}

function assertPinnedDirectoryMatches(fd, path) {
  assertNoSymlinkAncestors(path)
  const pathInfo = lstatOrNull(path)
  const fdInfo = fstatSync(fd)
  if (!pathInfo?.isDirectory() || pathInfo.dev !== fdInfo.dev || pathInfo.ino !== fdInfo.ino) {
    throw new Error(`Plan artifact parent changed during write: ${path}`)
  }
}

/** Atomically write a plan file with restrictive permissions. */
export function savePlanArtifact(path, artifact) {
  validatePlanArtifact(artifact)
  const destination = resolve(path)
  assertNoPlanPathCollision(destination, {
    packageRoot: artifact.package.root,
    target: artifact.target.path,
    operations: artifact.operations,
  })
  assertNoSymlinkAncestors(destination)
  const parent = dirname(destination)
  const pinnedParent = openPinnedDirectory(parent, { create: true })
  const destinationName = basename(destination)
  const pinnedDestination = join(pinnedParent.path, destinationName)
  const temporary = join(
    pinnedParent.path,
    `${destinationName}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`,
  )
  const payload = `${JSON.stringify(artifact, null, 2)}\n`
  let descriptor = null
  let temporaryCreated = false
  let destinationCreated = false
  let temporaryInfo = null
  try {
    assertPinnedDirectoryMatches(pinnedParent.fd, parent)
    const existing = lstatOrNull(pinnedDestination)
    if (existing?.isSymbolicLink()) {
      throw new Error(`Plan artifact destination is a symlink: ${destination}`)
    }
    if (existing && !existing.isFile()) {
      throw new Error(`Plan artifact destination is not a regular file: ${destination}`)
    }
    if (existing) throw new Error(`Plan artifact destination already exists: ${destination}`)

    descriptor = openSync(temporary, 'wx', 0o600)
    temporaryCreated = true
    writeFileSync(descriptor, payload)
    fchmodSync(descriptor, 0o600)
    temporaryInfo = fstatSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    assertPinnedDirectoryMatches(pinnedParent.fd, parent)
    // Hard-link creation is atomic and fails with EEXIST instead of replacing
    // a destination that appeared after the anchored validation.
    linkSync(temporary, pinnedDestination)
    destinationCreated = true
    assertPinnedDirectoryMatches(pinnedParent.fd, parent)
    unlinkSync(temporary)
    temporaryCreated = false
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {}
    }
    if (destinationCreated) {
      try {
        const destinationInfo = lstatOrNull(pinnedDestination)
        if (
          destinationInfo?.isFile() &&
          destinationInfo.dev === temporaryInfo?.dev &&
          destinationInfo.ino === temporaryInfo?.ino
        ) {
          unlinkSync(pinnedDestination)
        }
      } catch {}
    }
    try {
      if (temporaryCreated) unlinkSync(temporary)
    } catch {}
    throw error
  } finally {
    closeSync(pinnedParent.fd)
  }
}

/** Read and validate a plan artifact without following a symlink. */
export function loadPlanArtifact(path) {
  const absolute = resolve(path)
  assertNoSymlinkAncestors(absolute)
  const info = lstatOrNull(absolute)
  if (info?.isSymbolicLink()) throw new Error(`Plan artifact is a symlink: ${absolute}`)
  if (!info?.isFile()) throw new Error(`Plan artifact is not a regular file: ${absolute}`)
  if (info.size > 10 * 1024 * 1024)
    throw new Error('Install-plan artifact exceeds the 10 MiB limit')
  let artifact
  try {
    artifact = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch {
    throw new Error('Install-plan artifact is not valid JSON')
  }
  return validatePlanArtifact(artifact)
}

/** Compare current inputs and destinations against a saved reviewed plan. */
export function findPlanDrift(artifact, { target, packageRoot, packageVersion, files, snapshots }) {
  validatePlanArtifact(artifact)
  const root = resolve(target)
  const reasons = []
  const targetRealpath = lstatOrNull(root)?.isDirectory() ? realpathSync(root) : null
  if (root !== artifact.target.path || targetRealpath !== artifact.target.realpath)
    reasons.push('target')
  if (
    resolve(packageRoot) !== artifact.package.root ||
    realpathSync(packageRoot) !== artifact.package.realpath ||
    packageVersion !== artifact.package.version ||
    sourceFingerprint(packageRoot, [artifact.artifact_path]) !== artifact.package.source_fingerprint
  )
    reasons.push('source')

  const currentSnapshots = new Map(snapshots.map((item) => [resolve(item.path), item]))
  for (const operation of artifact.operations) {
    const absolute =
      operation.scope === 'user-config'
        ? assertSafeExternalDestination(operation.path)
        : assertSafeDestination(root, operation.path)
    const current = currentSnapshots.get(absolute)
    if (
      !current ||
      JSON.stringify(current) !== JSON.stringify({ path: absolute, ...operation.before })
    ) {
      reasons.push(operation.path)
    }
  }
  const generated = files.map((file) => ({
    ...operationLocation(root, file.path),
    action: file.action,
    bytes: file.bytes,
    outputFingerprint: file.outputFingerprint ?? null,
  }))
  const reviewed = artifact.operations.map(({ path, scope, action, bytes, outputFingerprint }) => ({
    ...(scope === undefined ? { path } : { path, scope }),
    action,
    bytes,
    outputFingerprint,
  }))
  if (JSON.stringify(generated) !== JSON.stringify(reviewed)) reasons.push('operations')
  return [...new Set(reasons)]
}
