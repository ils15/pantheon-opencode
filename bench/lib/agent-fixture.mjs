/** Stable, content-only identity for agent markdown loaded by a paired bench. */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const AGENT_FILE_RE = /^([a-z][a-z0-9-]*)(?:\.agent)?\.md$/

/**
 * Read identity for the requested agents without including prompt contents in
 * the result. Symlinked fixture directories or files are rejected so the
 * report identifies the exact canonical files used by the run.
 */
export function agentFixtureIdentity(directory, requiredAgents) {
  const path = resolve(directory)
  const rootStat = lstatSync(path)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new TypeError(`agent fixture must be a real directory: ${path}`)
  }

  const discovered = new Map()
  for (const file of readdirSync(path).sort()) {
    const match = AGENT_FILE_RE.exec(file)
    if (!match) continue
    const filePath = resolve(path, file)
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new TypeError(`agent fixture must contain regular files only: ${filePath}`)
    }
    if (discovered.has(match[1])) {
      throw new TypeError(`agent fixture contains duplicate definition for ${match[1]}: ${path}`)
    }
    const content = readFileSync(filePath)
    discovered.set(match[1], {
      name: match[1],
      path: filePath,
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
  }

  const files = [...new Set(requiredAgents)].sort().map((name) => {
    const file = discovered.get(name)
    if (!file) throw new TypeError(`agent fixture does not define ${name}: ${path}`)
    return { name: file.name, path: file.path, bytes: file.bytes, sha256: file.sha256 }
  })
  const digest = createHash('sha256')
  for (const file of files) {
    const content = readFileSync(file.path)
    digest.update(relative(path, file.path)).update('\0').update(content).update('\0')
  }
  return { path, files, sha256: digest.digest('hex') }
}

/** Content identity for the complete skill fixture symlinked into a paired run. */
export function contentDirectoryIdentity(directory) {
  const path = resolve(directory)
  const rootStat = lstatSync(path)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new TypeError(`content fixture must be a real directory: ${path}`)
  }

  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const filePath = resolve(current, entry.name)
      const stat = lstatSync(filePath)
      if (stat.isSymbolicLink()) {
        throw new TypeError(`content fixture must not contain symlinks: ${filePath}`)
      }
      if (stat.isDirectory()) {
        visit(filePath)
        continue
      }
      if (!stat.isFile())
        throw new TypeError(`content fixture contains a non-file entry: ${filePath}`)
      const content = readFileSync(filePath)
      files.push({
        path: relative(path, filePath),
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      })
    }
  }
  visit(path)
  if (files.length === 0) throw new TypeError(`content fixture is empty: ${path}`)

  const digest = createHash('sha256')
  for (const file of files) {
    digest
      .update(file.path)
      .update('\0')
      .update(String(file.bytes))
      .update('\0')
      .update(file.sha256)
      .update('\0')
  }
  return { path, files, sha256: digest.digest('hex') }
}
