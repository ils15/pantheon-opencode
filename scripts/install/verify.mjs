import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'

/** Reject symlinked path components before a managed filesystem operation. */
export function assertNoSymlinkAncestors(filePath, { includeLeaf = true } = {}) {
  const absolute = resolve(filePath)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  const checked = parts.slice(0, includeLeaf ? parts.length : Math.max(0, parts.length - 1))
  let current = root
  for (const [index, part] of checked.entries()) {
    current = current ? `${current}${current.endsWith(sep) ? '' : sep}${part}` : part
    let info
    try {
      info = lstatSync(current)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return true
      throw error
    }
    if (info.isSymbolicLink()) throw new Error(`Path contains a symlink: ${current}`)
    if (index < checked.length - 1 && !info.isDirectory()) {
      throw new Error(`Path ancestor is not a directory: ${current}`)
    }
  }
  return true
}

/** Require a destination to remain lexically inside its selected target. */
export function assertPathWithin(rootPath, destinationPath) {
  const root = resolve(rootPath)
  const destination = resolve(destinationPath)
  const fromRoot = relative(root, destination)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Path escapes selected target: ${destinationPath}`)
  }
  return true
}

/** Validate lexical containment and reject links before deleting a path. */
export function assertSafeRemoval(rootPath, destinationPath) {
  assertPathWithin(rootPath, destinationPath)
  assertNoSymlinkAncestors(destinationPath)
  return true
}

/** Read back a regular-file write without ever including file contents in errors. */
export function verifyRegularFile(filePath, expected) {
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Managed-file write did not produce a regular file: ${filePath}`)
  }
  const actual = readFileSync(filePath)
  const expectedBuffer = Buffer.isBuffer(expected) ? expected : Buffer.from(expected)
  if (!actual.equals(expectedBuffer)) {
    throw new Error(`Managed-file read-back verification failed: ${filePath}`)
  }
  return true
}

/**
 * Atomically write a managed file using a private, exclusively-created temp.
 * Existing destinations are replaced only after path checks and a temp read-back.
 */
export function writeFileAtomically(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}`
  assertNoSymlinkAncestors(filePath)
  assertRegularFileOrMissing(filePath)
  assertNoSymlinkAncestors(temporary)

  let fd
  let createdTemporary = false
  try {
    fd = openSync(temporary, 'wx', 0o600)
    createdTemporary = true
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined

    verifyRegularFile(temporary, content)
    assertNoSymlinkAncestors(filePath)
    assertRegularFileOrMissing(filePath)
    renameSync(temporary, filePath)
    createdTemporary = false
    verifyRegularFile(filePath, content)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (createdTemporary) {
      try {
        assertNoSymlinkAncestors(temporary)
        unlinkSync(temporary)
      } catch {
        // Preserve the write error; do not follow or remove an unsafe path.
      }
    }
  }
}

function assertRegularFileOrMissing(filePath) {
  try {
    const info = lstatSync(filePath)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-regular file: ${filePath}`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/** Verify a managed path was removed, without following symlinks. */
export function verifyPathRemoved(filePath) {
  try {
    lstatSync(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return true
    throw error
  }
  throw new Error(`Managed-path removal verification failed: ${filePath}`)
}
