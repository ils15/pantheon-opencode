#!/usr/bin/env node
/**
 * The only authoritative list of versioned manifests and lockfiles.
 *
 * Keep this list deliberately boring: release/version scripts import it rather
 * than maintaining their own, subtly different lists.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export const MANIFEST_INVENTORY = Object.freeze([
  Object.freeze({
    id: 'root-manifest',
    role: 'manifest',
    file: 'package.json',
    kind: 'json',
    name: 'pantheon-opencode',
    valuePath: ['name'],
  }),
  Object.freeze({
    id: 'plugin-manifest',
    role: 'manifest',
    file: 'plugin.json',
    kind: 'json',
    name: 'pantheon',
    valuePath: ['name'],
  }),
  Object.freeze({
    id: 'python-manifest',
    role: 'manifest',
    file: 'pyproject.toml',
    kind: 'toml',
    name: 'pantheon',
    valuePath: ['project', 'name'],
  }),
  Object.freeze({
    id: 'tui-manifest',
    role: 'manifest',
    file: 'src/plugins/tui/package.json',
    kind: 'json',
    name: 'pantheon-tui',
    valuePath: ['name'],
  }),
  Object.freeze({
    id: 'root-lock',
    role: 'lock',
    file: 'package-lock.json',
    kind: 'json',
    name: 'pantheon-opencode',
    packageFile: 'package.json',
  }),
  Object.freeze({
    id: 'tui-lock',
    role: 'lock',
    file: 'src/plugins/tui/package-lock.json',
    kind: 'json',
    name: 'pantheon-tui',
    packageFile: 'src/plugins/tui/package.json',
  }),
])

export const VERSION_MANIFEST_INVENTORY = Object.freeze(
  MANIFEST_INVENTORY.filter(({ role }) => role === 'manifest'),
)

export const LOCK_INVENTORY = Object.freeze(
  MANIFEST_INVENTORY.filter(({ role }) => role === 'lock'),
)

function readToml(file, text) {
  const result = execFileSync(
    'python3',
    ['-c', 'import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'],
    { input: text, encoding: 'utf8' },
  )
  let parsed
  try {
    parsed = JSON.parse(result)
  } catch (error) {
    throw new Error(`invalid TOML in ${file}: parser returned invalid JSON (${error.message})`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`invalid TOML in ${file}`)
  return parsed
}

function readDocument(root, entry) {
  const path = join(root, entry.file)
  if (!existsSync(path)) throw new Error(`manifest inventory file is missing: ${entry.file}`)
  const text = readFileSync(path, 'utf8')
  if (entry.kind === 'toml') return { entry, path, text, data: readToml(entry.file, text) }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON in ${entry.file}: ${error.message}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`invalid JSON document in ${entry.file}`)
  }
  return { entry, path, text, data }
}

function valueAt(data, path) {
  return path.reduce((value, key) => value?.[key], data)
}

function assertSemver(version, label) {
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`${label} must be a valid semver`)
  }
}

function manifestVersion(document) {
  const { entry, data } = document
  const version =
    entry.role === 'manifest'
      ? (data.version ?? valueAt(data, ['project', 'version']))
      : data.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${entry.file} is missing version`)
  }
  assertSemver(version, `${entry.file} version`)
  return version
}

function manifestName(document) {
  const { entry, data } = document
  const name = entry.role === 'manifest' ? valueAt(data, entry.valuePath) : data.name
  if (name !== entry.name) {
    throw new Error(`${entry.file} name must be ${entry.name}`)
  }
  return name
}

function validateLock(document, manifestsByFile, allowVersionDivergence) {
  const { entry, data } = document
  if (!Number.isInteger(data.lockfileVersion) || data.lockfileVersion < 1) {
    throw new Error(`${entry.file} has an invalid lockfileVersion`)
  }
  if (data.name !== entry.name) throw new Error(`${entry.file} name must be ${entry.name}`)
  assertSemver(data.version, `${entry.file} version`)
  const manifest = manifestsByFile.get(entry.packageFile)
  if (!manifest) throw new Error(`${entry.file} has no inventory manifest partner`)
  const manifestVersionValue = manifestVersion(manifest)
  if (!allowVersionDivergence && data.version !== manifestVersionValue) {
    throw new Error(`${entry.file} version diverges from ${entry.packageFile}`)
  }
  const rootPackage = data.packages?.['']
  if (!rootPackage || typeof rootPackage !== 'object' || Array.isArray(rootPackage)) {
    throw new Error(`${entry.file} is missing packages[""]`)
  }
  if (rootPackage.name !== entry.name) {
    throw new Error(`${entry.file} packages[""] name must be ${entry.name}`)
  }
  assertSemver(rootPackage.version, `${entry.file} packages[""] version`)
  if (data.version !== rootPackage.version) {
    throw new Error(`${entry.file} top-level version diverges from packages[""]`)
  }
  if (!allowVersionDivergence && rootPackage.version !== manifestVersionValue) {
    throw new Error(`${entry.file} packages[""] version diverges from ${entry.packageFile}`)
  }
}

/** Read and validate every entry before a caller is allowed to write anything. */
export function validateInventory(root, { allowVersionDivergence = false } = {}) {
  const documents = MANIFEST_INVENTORY.map((entry) => readDocument(root, entry))
  const manifestsByFile = new Map(
    documents
      .filter(({ entry }) => entry.role === 'manifest')
      .map((document) => [document.entry.file, document]),
  )
  const versions = documents
    .filter(({ entry }) => entry.role === 'manifest')
    .map((document) => ({ file: document.entry.file, version: manifestVersion(document) }))
  documents.filter(({ entry }) => entry.role === 'manifest').forEach(manifestName)
  const sourceVersion = versions[0].version
  if (!allowVersionDivergence) {
    for (const item of versions) {
      if (item.version !== sourceVersion)
        throw new Error(`${item.file} version diverges from package.json`)
    }
  }
  documents
    .filter(({ entry }) => entry.role === 'lock')
    .forEach((document) => {
      manifestName({
        ...document,
        entry: { ...document.entry, role: 'manifest', valuePath: ['name'] },
      })
      validateLock(document, manifestsByFile, allowVersionDivergence)
    })
  return { documents, sourceVersion, versions }
}

export function entryVersion(document) {
  return document.entry.role === 'manifest' ? manifestVersion(document) : document.data.version
}

function skipJsonWhitespace(text, offset) {
  let cursor = offset
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
  return cursor
}

function jsonStringEnd(text, start) {
  if (text[start] !== '"') throw new Error('JSON string expected')
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') {
      cursor += 1
      continue
    }
    if (text[cursor] === '"') return cursor
  }
  throw new Error('unterminated JSON string')
}

function jsonValueEnd(text, start, path, targetPath, ranges) {
  const cursor = skipJsonWhitespace(text, start)
  if (
    path.length === targetPath.length &&
    path.every((part, index) => part === targetPath[index])
  ) {
    const end = jsonStringEnd(text, cursor)
    ranges.push({ start: cursor + 1, end })
    return end + 1
  }

  if (text[cursor] === '"') return jsonStringEnd(text, cursor) + 1
  if (text[cursor] === '{') {
    let next = skipJsonWhitespace(text, cursor + 1)
    if (text[next] === '}') return next + 1
    while (next < text.length) {
      const keyEnd = jsonStringEnd(text, next)
      const key = JSON.parse(text.slice(next, keyEnd + 1))
      next = skipJsonWhitespace(text, keyEnd + 1)
      if (text[next] !== ':') throw new Error('JSON object colon expected')
      next = jsonValueEnd(text, next + 1, [...path, key], targetPath, ranges)
      next = skipJsonWhitespace(text, next)
      if (text[next] === '}') return next + 1
      if (text[next] !== ',') throw new Error('JSON object separator expected')
      next = skipJsonWhitespace(text, next + 1)
    }
  }
  if (text[cursor] === '[') {
    let next = skipJsonWhitespace(text, cursor + 1)
    let index = 0
    if (text[next] === ']') return next + 1
    while (next < text.length) {
      next = jsonValueEnd(text, next, [...path, String(index)], targetPath, ranges)
      index += 1
      next = skipJsonWhitespace(text, next)
      if (text[next] === ']') return next + 1
      if (text[next] !== ',') throw new Error('JSON array separator expected')
      next = skipJsonWhitespace(text, next + 1)
    }
  }

  let next = cursor
  while (next < text.length && !',]}'.includes(text[next])) next += 1
  return next
}

function replaceJsonStringValues(text, paths, version, file) {
  const ranges = []
  for (const path of paths) jsonValueEnd(text, 0, [], path, ranges)
  if (ranges.length !== paths.length)
    throw new Error(`${file} is missing writable version metadata`)

  let updated = text
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    updated = `${updated.slice(0, range.start)}${version}${updated.slice(range.end)}`
  }
  return updated
}

function replaceTomlProjectVersion(text, version, file) {
  const projectHeader = /^\[project\]\s*$/m.exec(text)
  if (!projectHeader) throw new Error(`${file} is missing [project] metadata`)
  const projectStart = projectHeader.index + projectHeader[0].length
  const nextTable = text.slice(projectStart).search(/^\s*\[/m)
  const projectEnd = nextTable === -1 ? text.length : projectStart + nextTable
  const project = text.slice(projectStart, projectEnd)
  const versionPattern = /^(\s*version\s*=\s*)(["'])([^"'\r\n]+)\2([^\r\n]*)$/m
  const match = versionPattern.exec(project)
  if (!match) throw new Error(`${file} is missing project version metadata`)
  const replacement = `${match[1]}${match[2]}${version}${match[2]}${match[4]}`
  return (
    text.slice(0, projectStart) +
    project.replace(versionPattern, replacement) +
    text.slice(projectEnd)
  )
}

function prepareDocumentVersion(document, version) {
  const { entry, text } = document
  if (entry.kind === 'toml') return replaceTomlProjectVersion(text, version, entry.file)
  const paths = entry.role === 'lock' ? [['version'], ['packages', '', 'version']] : [['version']]
  return replaceJsonStringValues(text, paths, version, entry.file)
}

/** Prepare all version metadata without changing any file. */
export function prepareInventoryVersion(inventory, version) {
  assertSemver(version, 'new version')
  if (!inventory || !Array.isArray(inventory.documents))
    throw new Error('validated inventory is required')
  return inventory.documents.map((document) => ({
    path: document.path,
    content: prepareDocumentVersion(document, version),
  }))
}

function temporaryPath(path, label) {
  return join(
    dirname(path),
    `.${basename(path)}.${label}.${process.pid}.${randomBytes(8).toString('hex')}`,
  )
}

function cleanup(paths) {
  for (const path of paths) {
    try {
      unlinkSync(path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

/** Commit prepared files as one rollback-safe temp+rename transaction. */
export function commitPreparedUpdates(updates) {
  const unique = new Set()
  const prepared = []
  try {
    for (const { path, content } of updates) {
      if (unique.has(path)) throw new Error(`duplicate prepared update: ${path}`)
      unique.add(path)
      if (typeof content !== 'string') throw new Error(`prepared content is not text: ${path}`)
      const temp = temporaryPath(path, 'tmp')
      try {
        const mode = statSync(path).mode & 0o777
        writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode })
        const fd = openSync(temp, 'r+')
        try {
          fchmodSync(fd, mode)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        prepared.push({
          path,
          temp,
          backup: temporaryPath(path, 'backup'),
          moved: false,
          installed: false,
        })
      } catch (error) {
        cleanup([temp])
        throw error
      }
    }
  } catch (error) {
    cleanup(prepared.map(({ temp }) => temp))
    throw error
  }

  try {
    for (const item of prepared) {
      renameSync(item.path, item.backup)
      item.moved = true
      renameSync(item.temp, item.path)
      item.installed = true
    }
  } catch (error) {
    for (const item of [...prepared].reverse()) {
      try {
        if (item.installed) unlinkSync(item.path)
        if (item.moved) renameSync(item.backup, item.path)
      } catch {
        // Preserve the original commit error; a failed rollback is still
        // surfaced by the post-write validation performed by the caller.
      }
    }
    cleanup(prepared.map(({ temp }) => temp))
    cleanup(prepared.map(({ backup }) => backup))
    throw error
  }

  cleanup(prepared.map(({ backup }) => backup))
}

/** Update only version metadata in the already validated inventory. */
export function writeInventoryVersion(inventory, version) {
  commitPreparedUpdates(prepareInventoryVersion(inventory, version))
}
