import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as clack from '@clack/prompts'
import { createBackupSet } from './install/backup.mjs'
import {
  MCP_ENTRYPOINT_RENAMES,
  migrateV1toV2,
  PANTHEON_MCP_ENTRYPOINTS,
  validateMcpV1toV2Source,
} from './install/config-migration.mjs'
import { resolveGlobalConfigDirectory } from './install/config-paths.mjs'
import { mcpServerPermissionActions } from './install/mcp-permissions.mjs'
import { PANTHEON_MCP_SERVERS, pluginReferenceIdentity } from './install/opencode.mjs'
import {
  opencodeWildcardMatch,
  opencodeWildcardPatternsOverlap,
} from './install/opencode-wildcard.mjs'
import { writeConfigWithBackup } from './install/shared.mjs'
import {
  assertNoSymlinkAncestors as assertManagedPathNoSymlinks,
  assertPathWithin,
} from './install/verify.mjs'

const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc']
const MCP_SERVER_NAME = /^[a-zA-Z0-9._-]+$/
const EFFECTS = new Set(['allow', 'ask', 'deny'])

export { resolveGlobalConfigDirectory }

function assertNoSymlinkAncestors(directory, filesystem) {
  const absolute = path.resolve(directory)
  const { root } = path.parse(absolute)
  let current = root
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let stat
    try {
      stat = filesystem.lstatSync(current)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw new Error(`Cannot safely inspect config directory ancestor ${current}.`)
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing config directory with symlinked ancestor ${current}.`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Refusing config directory with non-directory ancestor ${current}.`)
    }
  }
}

function readString(source, cursor) {
  const start = cursor
  cursor += 1
  let escaped = false
  while (cursor < source.length) {
    const char = source[cursor]
    if (escaped) {
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '"') {
      const end = cursor + 1
      return { value: JSON.parse(source.slice(start, end)), start, end, cursor: end }
    }
    cursor += 1
  }
  throw new SyntaxError(`Unterminated string at offset ${start}`)
}

/** Parse JSON/JSONC while retaining source spans so edits can preserve unrelated text. */
function parseConfig(source, jsonc) {
  let cursor = 0
  const comments = []

  function skipTrivia() {
    while (cursor < source.length) {
      if (/\s/.test(source[cursor])) {
        cursor += 1
        continue
      }
      if (source.startsWith('//', cursor)) {
        if (!jsonc) throw new SyntaxError(`Comments are not allowed at offset ${cursor}`)
        const start = cursor
        const newline = source.indexOf('\n', cursor + 2)
        cursor = newline < 0 ? source.length : newline
        comments.push({ start, end: cursor })
        continue
      }
      if (source.startsWith('/*', cursor)) {
        if (!jsonc) throw new SyntaxError(`Comments are not allowed at offset ${cursor}`)
        const start = cursor
        const close = source.indexOf('*/', cursor + 2)
        if (close < 0) throw new SyntaxError(`Unterminated comment at offset ${start}`)
        cursor = close + 2
        comments.push({ start, end: cursor })
        continue
      }
      break
    }
  }

  function parseValue() {
    skipTrivia()
    const start = cursor
    const char = source[cursor]

    if (char === '"') {
      const token = readString(source, cursor)
      cursor = token.cursor
      return { value: token.value, start, end: cursor, type: 'scalar' }
    }
    if (char === '{') {
      cursor += 1
      const value = {}
      const properties = []
      const keys = new Set()
      skipTrivia()
      if (source[cursor] === '}') {
        cursor += 1
        return { value, properties, start, end: cursor, closeStart: cursor - 1, type: 'object' }
      }
      let previousProperty = null
      while (cursor < source.length) {
        skipTrivia()
        if (source[cursor] !== '"') throw new SyntaxError(`Expected object key at offset ${cursor}`)
        const key = readString(source, cursor)
        cursor = key.cursor
        if (keys.has(key.value))
          throw new SyntaxError(`Duplicate object key ${JSON.stringify(key.value)}`)
        keys.add(key.value)
        skipTrivia()
        if (source[cursor] !== ':') throw new SyntaxError(`Expected ':' at offset ${cursor}`)
        cursor += 1
        const parsedValue = parseValue()
        Object.defineProperty(value, key.value, {
          value: parsedValue.value,
          enumerable: true,
          configurable: true,
          writable: true,
        })
        const property = {
          key: key.value,
          keyStart: key.start,
          keyEnd: key.end,
          valueStart: parsedValue.start,
          valueEnd: parsedValue.end,
          value: parsedValue.value,
          valueNode: parsedValue,
          commaBefore: previousProperty?.commaAfter ?? null,
          commaAfter: null,
        }
        properties.push(property)
        skipTrivia()
        if (source[cursor] === ',') {
          property.commaAfter = cursor
          cursor += 1
          skipTrivia()
          if (source[cursor] === '}') {
            if (!jsonc)
              throw new SyntaxError(
                `Trailing commas are not allowed at offset ${property.commaAfter}`,
              )
            cursor += 1
            return { value, properties, start, end: cursor, closeStart: cursor - 1, type: 'object' }
          }
          previousProperty = property
          continue
        }
        if (source[cursor] === '}') {
          cursor += 1
          return { value, properties, start, end: cursor, closeStart: cursor - 1, type: 'object' }
        }
        throw new SyntaxError(`Expected ',' or '}' at offset ${cursor}`)
      }
      throw new SyntaxError(`Unterminated object at offset ${start}`)
    }
    if (char === '[') {
      cursor += 1
      const value = []
      const items = []
      skipTrivia()
      if (source[cursor] === ']') {
        cursor += 1
        return { value, items, start, end: cursor, closeStart: cursor - 1, type: 'array' }
      }
      let previousItem = null
      while (cursor < source.length) {
        const itemNode = parseValue()
        value.push(itemNode.value)
        const item = {
          ...itemNode,
          commaBefore: previousItem?.commaAfter ?? null,
          commaAfter: null,
        }
        items.push(item)
        skipTrivia()
        if (source[cursor] === ',') {
          const comma = cursor
          item.commaAfter = comma
          cursor += 1
          skipTrivia()
          if (source[cursor] === ']') {
            if (!jsonc) throw new SyntaxError(`Trailing commas are not allowed at offset ${comma}`)
            cursor += 1
            return { value, items, start, end: cursor, closeStart: cursor - 1, type: 'array' }
          }
          previousItem = item
          continue
        }
        if (source[cursor] === ']') {
          cursor += 1
          return { value, items, start, end: cursor, closeStart: cursor - 1, type: 'array' }
        }
        throw new SyntaxError(`Expected ',' or ']' at offset ${cursor}`)
      }
      throw new SyntaxError(`Unterminated array at offset ${start}`)
    }

    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(cursor),
    )
    if (!literal) throw new SyntaxError(`Expected JSON value at offset ${cursor}`)
    cursor += literal[0].length
    return { value: JSON.parse(literal[0]), start, end: cursor, type: 'scalar' }
  }

  const ast = parseValue()
  skipTrivia()
  if (cursor !== source.length) throw new SyntaxError(`Unexpected content at offset ${cursor}`)
  if (ast.type !== 'object') throw new SyntaxError('The config root must be a JSON object')
  return { ...ast, comments }
}

/** Inspect both global config filenames independently; neither file is canonicalized. */
export function inspectConfigFiles(configDir, filesystem = fs) {
  const directoryError = () =>
    CONFIG_NAMES.map((name) => ({
      name,
      path: path.join(configDir, name),
      exists: true,
      format: name.endsWith('.jsonc') ? 'jsonc' : 'json',
      directoryError: true,
      parseError: 'Config directory cannot be safely inspected.',
    }))
  try {
    assertNoSymlinkAncestors(configDir, filesystem)
  } catch (error) {
    return directoryError(error)
  }
  return CONFIG_NAMES.map((name) => {
    const filePath = path.join(configDir, name)
    try {
      assertNoSymlinkAncestors(configDir, filesystem)
    } catch {
      return {
        name,
        path: filePath,
        exists: true,
        format: name.endsWith('.jsonc') ? 'jsonc' : 'json',
        directoryError: true,
        parseError: 'Config directory cannot be safely inspected.',
      }
    }
    if (!filesystem.existsSync(filePath)) {
      return {
        name,
        path: filePath,
        exists: false,
        format: name.endsWith('.jsonc') ? 'jsonc' : 'json',
      }
    }
    const stat = filesystem.lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        name,
        path: filePath,
        exists: true,
        format: name.endsWith('.jsonc') ? 'jsonc' : 'json',
        parseError: 'Only regular config files are supported.',
      }
    }
    try {
      assertNoSymlinkAncestors(configDir, filesystem)
      const readStat = filesystem.lstatSync(filePath)
      if (readStat.isSymbolicLink() || !readStat.isFile() || !sameIdentity(readStat, stat)) {
        return {
          name,
          path: filePath,
          exists: true,
          format: name.endsWith('.jsonc') ? 'jsonc' : 'json',
          parseError: 'Config file changed during inspection.',
        }
      }
    } catch {
      return {
        name,
        path: filePath,
        exists: true,
        format: name.endsWith('.jsonc') ? 'jsonc' : 'json',
        directoryError: true,
        parseError: 'Config directory cannot be safely inspected.',
      }
    }
    const content = filesystem.readFileSync(filePath, 'utf8')
    try {
      assertNoSymlinkAncestors(configDir, filesystem)
    } catch {
      return {
        name,
        path: filePath,
        exists: true,
        format: name.endsWith('.jsonc') ? 'jsonc' : 'json',
        directoryError: true,
        parseError: 'Config directory cannot be safely inspected.',
      }
    }
    const format = name.endsWith('.jsonc') ? 'jsonc' : 'json'
    try {
      const ast = parseConfig(content, format === 'jsonc')
      return {
        name,
        path: filePath,
        exists: true,
        format,
        mode: stat.mode,
        identity: { dev: stat.dev, ino: stat.ino },
        content,
        config: ast.value,
        ast,
      }
    } catch {
      return {
        name,
        path: filePath,
        exists: true,
        format,
        mode: stat.mode,
        content,
        parseError: 'Invalid config syntax.',
      }
    }
  })
}

function makeConfigPreconditions(files, plannedContents = new Map()) {
  return files.map((file) => {
    const planned = plannedContents.get(file.path)
    const changed = planned !== undefined
    return {
      path: file.path,
      originalExists: file.exists,
      originalContent: file.exists ? file.content : null,
      originalIdentity: file.identity ?? null,
      originalMode: file.mode ?? null,
      expectedExists: changed || file.exists,
      expectedContent: changed ? planned.contents : file.exists ? file.content : null,
      expectedIdentity: changed ? null : (file.identity ?? null),
      expectedMode: changed ? (file.mode ?? 0o100600) : (file.mode ?? null),
    }
  })
}

/** Check reviewed JSON/JSONC input bytes and file identities without logging them. */
export function verifyConfigPreconditions(
  preconditions,
  { configDir, stage = 'original', filesystem = fs } = {},
) {
  if (!Array.isArray(preconditions) || !['original', 'expected'].includes(stage)) return false
  const root = path.resolve(configDir ?? '')
  if (!configDir || !path.isAbsolute(root)) return false
  try {
    for (const item of preconditions) {
      const filePath = path.resolve(item.path)
      if (path.dirname(filePath) !== root || !CONFIG_NAMES.includes(path.basename(filePath))) {
        return false
      }
      assertPathWithin(root, filePath)
      assertManagedPathNoSymlinks(filePath)
      let stat = null
      try {
        stat = filesystem.lstatSync(filePath)
      } catch (error) {
        if (error?.code !== 'ENOENT') return false
      }
      const exists = stage === 'original' ? item.originalExists : item.expectedExists
      const content = stage === 'original' ? item.originalContent : item.expectedContent
      const mode = stage === 'original' ? item.originalMode : item.expectedMode
      const identity = stage === 'original' ? item.originalIdentity : item.expectedIdentity
      if (!exists) {
        if (stat !== null) return false
        continue
      }
      if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.mode !== mode) return false
      if (identity && !sameIdentity(stat, identity)) return false
      if (filesystem.readFileSync(filePath, 'utf8') !== content) return false
    }
    return true
  } catch {
    return false
  }
}

function policySources(files) {
  const mcpServers = [
    ...new Set([
      ...PANTHEON_MCP_SERVERS,
      ...files
        .filter((file) => file.exists && !file.parseError)
        .flatMap((file) => configuredMcpServers(file.config).map(([name]) => name)),
    ]),
  ]
  return files.flatMap((file) => {
    if (!file.exists || file.parseError) return []
    const properties = new Map(file.ast.properties.map((property) => [property.key, property]))
    return ['permission', 'permissions']
      .filter((key) => properties.has(key))
      .map((key) => ({
        id: `${file.name}#${key}`,
        file,
        mcpServers,
        key,
        value: properties.get(key).value,
        property: properties.get(key),
      }))
  })
}

function configuredMcpServers(config) {
  if (!isRecord(config?.mcp)) return []
  const mcp = config.mcp
  const legacyToggle =
    isRecord(mcp.servers) &&
    Object.keys(mcp.servers).length === 1 &&
    typeof mcp.servers.enabled === 'boolean'
  const nested =
    !legacyToggle && isRecord(mcp.servers) && Object.values(mcp.servers).every(isRecord)
  const entries = nested
    ? [
        ...Object.entries(mcp.servers),
        ...Object.entries(mcp).filter(([name]) => name !== 'servers'),
      ]
    : Object.entries(mcp).filter(([name]) => !(legacyToggle && name === 'servers'))
  const seen = new Set()
  return entries.filter(([name, value]) => {
    if (!isRecord(value)) return false
    if (seen.has(name)) {
      throw new Error('Conflicting flat and nested MCP server entries cannot be inspected safely.')
    }
    seen.add(name)
    return true
  })
}

function isGeneratedMcpEntry(name, entry) {
  const current = PANTHEON_MCP_ENTRYPOINTS[name]
  if (!current || !isRecord(entry)) return false
  const stale = Object.entries(MCP_ENTRYPOINT_RENAMES).find(([, next]) => next === current)?.[0]
  const command = entry.command
  const keys = Object.keys(entry).sort()
  const installerShape =
    keys.join(',') === 'command,cwd,type' ||
    (keys.join(',') === 'command,cwd,enabled,type' && entry.enabled === true)
  return (
    installerShape &&
    entry.type === 'local' &&
    typeof entry.cwd === 'string' &&
    path.isAbsolute(entry.cwd) &&
    Array.isArray(command) &&
    command.length === 2 &&
    typeof command[0] === 'string' &&
    path.isAbsolute(command[0]) &&
    (command[0] === path.join(entry.cwd, '.venv', 'bin', 'python3') ||
      command[0] === path.win32.join(entry.cwd, '.venv', 'Scripts', 'python.exe')) &&
    (command[1] === `scripts/${current}` || command[1] === `scripts/${stale}`)
  )
}

function inspectInstallerEntries(config) {
  const plugins = new Set()
  if (Array.isArray(config.plugins)) {
    for (const entry of config.plugins) {
      if (pluginReferenceIdentity(entry) === 'src/plugin-v2') plugins.add('V2 plugin')
    }
  }

  const mcp = []
  if (isRecord(config.mcp)) {
    for (const [name, entry] of configuredMcpServers(config)) {
      if (isGeneratedMcpEntry(name, entry)) mcp.push(name)
    }
  }

  return { plugins: [...plugins].sort(), mcp }
}

function flatThirdPartyMcpEntryCount(file) {
  if (file.name !== 'opencode.jsonc' || !isRecord(file.config?.mcp)) return 0
  const mcp = file.config.mcp
  const { hasV2ServersMap, legacyServersToggle } = validateMcpV1toV2Source(mcp)
  const flatEntries = Object.entries(mcp).flatMap(([name, entry]) => {
    if (hasV2ServersMap && name === 'servers') return []
    if (legacyServersToggle && name === 'servers') return []
    return [[name, entry]]
  })
  return flatEntries.filter(([name, entry]) => isRecord(entry) && !isGeneratedMcpEntry(name, entry))
    .length
}

function removeObjectPropertyEdit(file, objectNode, key) {
  const property = findProperty(objectNode, key)
  if (!property) throw new Error('A verified entry could not be located for removal.')
  let start = property.keyStart
  let end = property.valueEnd
  if (property.commaAfter !== null) end = property.commaAfter + 1
  else if (property.commaBefore !== null) start = property.commaBefore
  if (commentsWithin(file.ast, start, end)) {
    throw new Error('A comment is attached to the verified entry.')
  }
  return { start, end, text: '' }
}

function removeArrayPrefixEdit(file, arrayNode, count) {
  if (count === 0) return null
  if (commentsWithin(file.ast, arrayNode.start, arrayNode.end)) {
    throw new Error('Comments prevent safe removal of a verified plugin entry.')
  }
  const last = arrayNode.items[count - 1]
  return {
    start: arrayNode.items[0].start,
    end: last.commaAfter === null ? last.end : last.commaAfter + 1,
    text: '',
  }
}

function removeArrayItemsEdits(file, arrayNode, indexes) {
  if (indexes.length === 0) return []
  if (commentsWithin(file.ast, arrayNode.start, arrayNode.end)) {
    throw new Error('Comments prevent safe removal of a verified plugin entry.')
  }
  const sorted = [...new Set(indexes)].sort((a, b) => a - b)
  const groups = []
  for (const index of sorted) {
    const last = groups.at(-1)
    if (last && last[1] === index - 1) last[1] = index
    else groups.push([index, index])
  }
  return groups.map(([firstIndex, lastIndex]) => {
    const first = arrayNode.items[firstIndex]
    const last = arrayNode.items[lastIndex]
    let start
    let end
    if (firstIndex === 0 && lastIndex === arrayNode.items.length - 1) {
      start = first.start
      end = last.commaAfter === null ? last.end : last.commaAfter + 1
    } else if (lastIndex < arrayNode.items.length - 1) {
      start = first.start
      end = last.commaAfter + 1
    } else {
      start = first.commaBefore
      end = last.end
    }
    return { start, end, text: '' }
  })
}

function managedEntryMovePlan(files) {
  const source = files.find((file) => file.name === 'opencode.jsonc' && file.exists)
  const target = files.find((file) => file.name === 'opencode.json')
  if (!source || source.parseError || !target || target.parseError) {
    return {
      source,
      target,
      moves: [],
      edits: [],
      removedMcpEntries: [],
      unsafeCount: 0,
      unsafePluginCount: 0,
      unsafeMcpNames: [],
      removedDuplicatePluginCount: 0,
    }
  }

  const moves = []
  const edits = []
  const removedMcpEntries = []
  let unsafeCount = 0
  let unsafePluginCount = 0
  const unsafeMcpNames = []
  let removedDuplicatePluginCount = 0
  const sourcePluginsProperty = findProperty(source.ast, 'plugins')
  const sourcePlugins = sourcePluginsProperty?.valueNode
  if (sourcePlugins?.type === 'array') {
    const pluginItems = sourcePlugins.items.filter(
      (item) => pluginReferenceIdentity(item.value) === 'src/plugin-v2',
    )
    if (pluginItems.length > 0) {
      const targetPlugins = target.config?.plugins
      const targetHasSelector =
        Array.isArray(targetPlugins) &&
        targetPlugins.some((plugin) => typeof plugin === 'string' && plugin.startsWith('-'))
      const sourceHasSelector = sourcePlugins.value.some(
        (plugin) => typeof plugin === 'string' && plugin.startsWith('-'),
      )
      const prefixCount = pluginItems.length
      const prefixSafe = pluginItems.every((item, index) => sourcePlugins.items[index] === item)
      const targetManagedPlugins = Array.isArray(targetPlugins)
        ? targetPlugins.filter((plugin) => pluginReferenceIdentity(plugin) === 'src/plugin-v2')
        : []
      if (targetManagedPlugins.length > 0) {
        const exactDuplicate =
          targetManagedPlugins.length === 1 &&
          pluginItems.every((item) => isDeepStrictEqual(item.value, targetManagedPlugins[0]))
        if (exactDuplicate && !targetHasSelector && !sourceHasSelector) {
          try {
            const indexes = pluginItems.map((item) => sourcePlugins.items.indexOf(item))
            edits.push(...removeArrayItemsEdits(source, sourcePlugins, indexes))
            removedDuplicatePluginCount += pluginItems.length
          } catch {
            unsafeCount += pluginItems.length
            unsafePluginCount += pluginItems.length
          }
        } else {
          unsafeCount += pluginItems.length
          unsafePluginCount += pluginItems.length
        }
      } else {
        const exactSourceDuplicates = pluginItems.every((item) =>
          isDeepStrictEqual(item.value, pluginItems[0].value),
        )
        const targetSafe =
          targetPlugins === undefined ||
          (Array.isArray(targetPlugins) &&
            !targetPlugins.some((plugin) => pluginReferenceIdentity(plugin) === 'src/plugin-v2'))
        const canMove =
          prefixSafe &&
          exactSourceDuplicates &&
          targetSafe &&
          !targetHasSelector &&
          !sourceHasSelector &&
          !commentsWithin(source.ast, sourcePlugins.start, sourcePlugins.end)
        if (canMove) {
          moves.push({ kind: 'plugin', value: pluginItems[0].value })
          removedDuplicatePluginCount += pluginItems.length - 1
          const edit = removeArrayPrefixEdit(source, sourcePlugins, prefixCount)
          if (edit) edits.push(edit)
        } else {
          unsafeCount += pluginItems.length
          unsafePluginCount += pluginItems.length
        }
      }
    }
  }

  const sourceMcpProperty = findProperty(source.ast, 'mcp')
  const sourceMcpNode = sourceMcpProperty?.valueNode
  if (sourceMcpNode?.type === 'object') {
    const nestedProperty = findProperty(sourceMcpNode, 'servers')
    const nested = validateMcpV1toV2Source(source.config.mcp).hasV2ServersMap
    const sourceMap = nested ? nestedProperty.valueNode : sourceMcpNode
    for (const [name, entry] of configuredMcpServers(source.config)) {
      if (!isGeneratedMcpEntry(name, entry)) continue
      const targetMcp = target.config?.mcp
      const targetNested = isRecord(targetMcp) && validateMcpV1toV2Source(targetMcp).hasV2ServersMap
      const targetMap = targetNested ? targetMcp.servers : isRecord(targetMcp) ? targetMcp : {}
      if (
        (targetMcp !== undefined && !isRecord(targetMcp)) ||
        (isRecord(targetMcp) && targetMcp.servers !== undefined && !isRecord(targetMcp.servers))
      ) {
        unsafeCount += 1
        unsafeMcpNames.push(name)
        continue
      }
      const prior = targetMap[name]
      if (prior !== undefined && !isDeepStrictEqual(prior, entry)) {
        unsafeCount += 1
        unsafeMcpNames.push(name)
        continue
      }
      try {
        if (commentsWithin(source.ast, sourceMap.start, sourceMap.end)) {
          throw new Error('Comments make the managed server map unsafe to edit.')
        }
        edits.push(removeObjectPropertyEdit(source, sourceMap, name))
        removedMcpEntries.push({ name, value: entry, nested })
        if (prior === undefined) moves.push({ kind: 'mcp', name, value: entry, nested })
      } catch {
        unsafeCount += 1
        unsafeMcpNames.push(name)
      }
    }
  }
  return {
    source,
    target,
    moves,
    edits,
    removedMcpEntries,
    unsafeCount,
    unsafePluginCount,
    unsafeMcpNames: [...new Set(unsafeMcpNames)],
    removedDuplicatePluginCount,
  }
}

function addManagedEntriesToJson(config, moves, disabledMcpServers = []) {
  for (const move of moves) {
    if (move.kind === 'plugin') {
      if (config.plugins === undefined) config.plugins = []
      if (!Array.isArray(config.plugins)) throw new Error('Target plugin list is unsupported.')
      config.plugins.push(move.value)
      continue
    }
    if (config.mcp === undefined) config.mcp = {}
    if (!isRecord(config.mcp)) throw new Error('Target MCP map is unsupported.')
    let targetShape = validateMcpV1toV2Source(config.mcp)
    if (move.nested && !targetShape.hasV2ServersMap && Object.hasOwn(config.mcp, 'servers')) {
      config.mcp = migrateV1toV2({ mcp: config.mcp }).mcp
      targetShape = validateMcpV1toV2Source(config.mcp)
    }
    const nested = move.nested || targetShape.hasV2ServersMap
    if (nested) {
      if (config.mcp.servers === undefined) config.mcp.servers = {}
      if (!isRecord(config.mcp.servers)) throw new Error('Target MCP server map is unsupported.')
      config.mcp.servers[move.name] = move.value
    } else {
      config.mcp[move.name] = move.value
    }
  }
  for (const name of disabledMcpServers) {
    if (!isRecord(config.mcp)) throw new Error('Target MCP map is unsupported.')
    const nestedMap = isRecord(config.mcp.servers) && Object.hasOwn(config.mcp.servers, name)
    const flatMap = Object.hasOwn(config.mcp, name)
    const serverMap = nestedMap ? config.mcp.servers : flatMap ? config.mcp : null
    if (!serverMap) throw new Error('Target MCP server is unavailable to disable.')
    if (!isRecord(serverMap[name])) throw new Error('Target MCP server is unavailable to disable.')
    serverMap[name] = { ...serverMap[name], disabled: true }
  }
  return config
}

function getMcpAskEntries(source) {
  const policy = source.value
  if (source.key === 'permission' && isRecord(policy) && isRecord(policy.mcp)) {
    return Object.entries(policy.mcp)
      .filter(([, effect]) => effect === 'ask')
      .map(([server], index) => ({
        id: `${source.id}#mcp:${server}`,
        label: `legacy MCP rule ${index + 1} in ${source.file.name}`,
        server,
        kind: 'legacy',
      }))
  }
  if (source.key === 'permissions' && Array.isArray(policy)) {
    return policy
      .map((rule, index) => ({ rule, index }))
      .filter(
        ({ rule }) =>
          isRecord(rule) &&
          rule.effect === 'ask' &&
          typeof rule.resource === 'string' &&
          typeof rule.action === 'string' &&
          opencodeWildcardMatch('*', rule.resource) &&
          (source.mcpServers ?? []).some((server) => {
            return mcpServerPermissionActions(server).some((action) =>
              opencodeWildcardPatternsOverlap(rule.action, action),
            )
          }),
      )
      .map(({ rule, index }) => {
        const matchingServers = (source.mcpServers ?? []).filter((server) => {
          return mcpServerPermissionActions(server).some((action) =>
            opencodeWildcardPatternsOverlap(rule.action, action),
          )
        })
        return {
          id: `${source.id}#mcp:${rule.action}:${rule.resource}:${index}`,
          label: `V2 MCP rule ${index + 1} in ${source.file.name}`,
          action: rule.action,
          resource: rule.resource,
          server: matchingServers.length === 1 ? matchingServers[0] : null,
          scope: rule.action.endsWith('_*') ? 'server' : 'tool',
          index,
          kind: 'v2',
        }
      })
  }
  return []
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateLegacyPolicy(value) {
  if (!isRecord(value)) throw new Error('Legacy permission policy is malformed.')
  for (const [action, rule] of Object.entries(value)) {
    if (action === 'mcp') {
      if (!isRecord(rule)) throw new Error('Legacy MCP permission policy is malformed.')
      for (const [server, effect] of Object.entries(rule)) {
        if (!MCP_SERVER_NAME.test(server) || !EFFECTS.has(effect)) {
          throw new Error('Legacy MCP permission policy contains an unsupported value.')
        }
      }
      continue
    }
    if (typeof rule === 'string') {
      if (!EFFECTS.has(rule))
        throw new Error('Legacy permission policy contains an unsupported effect.')
      continue
    }
    if (!isRecord(rule)) throw new Error('Legacy permission policy contains an unsupported value.')
    for (const effect of Object.values(rule)) {
      if (!EFFECTS.has(effect))
        throw new Error('Legacy permission policy contains an unsupported effect.')
    }
  }
}

function validateV2Policy(value) {
  if (!Array.isArray(value)) throw new Error('V2 permissions policy is malformed.')
  for (const rule of value) {
    if (
      !isRecord(rule) ||
      typeof rule.action !== 'string' ||
      typeof rule.resource !== 'string' ||
      !EFFECTS.has(rule.effect)
    ) {
      throw new Error('V2 permissions policy contains a malformed rule.')
    }
  }
}

function applyAskChoices(source, choices) {
  const resolved = structuredClone(source.value)
  for (const ask of getMcpAskEntries(source)) {
    const choice = choices[ask.id]
    if (!['allow', 'deny', 'accessible', 'disable'].includes(choice)) {
      throw new Error('Every ineffective MCP ask rule needs an explicit policy choice.')
    }
    if (ask.kind === 'legacy') {
      if (choice === 'allow' || choice === 'deny') resolved.mcp[ask.server] = choice
      else delete resolved.mcp[ask.server]
    } else if (choice === 'allow' || choice === 'deny') {
      resolved[ask.index].effect = choice
    } else {
      resolved[ask.index] = null
    }
  }
  return Array.isArray(resolved) ? resolved.filter((rule) => rule !== null) : resolved
}

function makeV2Policy(source, askChoices) {
  if (source.key === 'permission') {
    validateLegacyPolicy(source.value)
    const permission = applyAskChoices(source, askChoices)
    const converted = migrateV1toV2({ permission }, { mcpServerNames: source.mcpServers ?? [] })
    const policy = converted.permissions ?? []
    validateV2Policy(policy)
    return policy
  }
  validateV2Policy(source.value)
  return applyAskChoices(source, askChoices)
}

function hasCrossLayerPermissionConflict(files, sources, selectedSources, askChoices) {
  const policies = []
  for (const source of sources) {
    const selected = selectedSources.get(source.file.path)
    if (selected && selected.id !== source.id) continue
    const policy =
      selected || source.key === 'permission' ? makeV2Policy(source, askChoices) : source.value
    policies.push({ source, policy })
  }

  const ordered = []
  for (const file of files) {
    for (const { source, policy } of policies) {
      if (source.file.path !== file.path) continue
      for (const rule of policy) {
        if (isRecord(rule)) ordered.push({ source, rule })
      }
    }
  }

  for (let earlierIndex = 0; earlierIndex < ordered.length; earlierIndex += 1) {
    const earlier = ordered[earlierIndex]
    for (let laterIndex = earlierIndex + 1; laterIndex < ordered.length; laterIndex += 1) {
      const later = ordered[laterIndex]
      if (
        later.rule.effect === earlier.rule.effect ||
        !opencodeWildcardPatternsOverlap(earlier.rule.action, later.rule.action) ||
        !opencodeWildcardPatternsOverlap(earlier.rule.resource, later.rule.resource)
      ) {
        continue
      }
      const crossSource =
        earlier.source.file.path !== later.source.file.path ||
        earlier.source.key !== later.source.key
      if (crossSource) return true
    }
  }
  return false
}

function hasNativeCrossLayerPermissionConflict(files, sources) {
  const nativeSources = sources.filter((source) => source.key === 'permissions')
  const policies = nativeSources.map((source) => ({ source, policy: source.value }))
  return nativePoliciesConflict(files, policies)
}

function nativePoliciesConflict(files, policies) {
  const ordered = []
  for (const file of files) {
    for (const { source, policy } of policies) {
      if (source.file.path !== file.path) continue
      if (!Array.isArray(policy)) return true
      for (const rule of policy) {
        if (
          isRecord(rule) &&
          typeof rule.action === 'string' &&
          typeof rule.resource === 'string' &&
          EFFECTS.has(rule.effect)
        ) {
          ordered.push({ source, rule })
        }
      }
    }
  }
  for (let i = 0; i < ordered.length; i += 1) {
    const earlier = ordered[i]
    for (let j = i + 1; j < ordered.length; j += 1) {
      const later = ordered[j]
      if (
        later.source.file.path !== earlier.source.file.path &&
        later.rule.effect !== earlier.rule.effect &&
        opencodeWildcardPatternsOverlap(earlier.rule.action, later.rule.action) &&
        opencodeWildcardPatternsOverlap(earlier.rule.resource, later.rule.resource)
      ) {
        return true
      }
    }
  }
  return false
}

function commentsWithin(ast, start, end) {
  return ast.comments.some((comment) => comment.start >= start && comment.end <= end)
}

function findProperty(node, key) {
  return node?.type === 'object' ? node.properties.find((property) => property.key === key) : null
}

function setObjectFieldEdit(file, objectNode, key, value) {
  if (objectNode?.type !== 'object') {
    throw new Error('A selected MCP server entry cannot be safely edited.')
  }
  const property = findProperty(objectNode, key)
  if (property) {
    if (commentsWithin(file.ast, property.valueStart, property.valueEnd)) {
      throw new Error(
        'The selected MCP server field contains a comment; it cannot be safely edited.',
      )
    }
    return { start: property.valueStart, end: property.valueEnd, text: JSON.stringify(value) }
  }
  if (commentsWithin(file.ast, objectNode.start, objectNode.closeStart)) {
    throw new Error('The selected MCP server entry has comments; it cannot be safely edited.')
  }
  const last = objectNode.properties.at(-1)
  const hasTrailingComma = last?.commaAfter !== null && last?.commaAfter !== undefined
  const multiline = file.content.slice(objectNode.start, objectNode.closeStart).includes('\n')
  const parentIndent = indentAt(file.content, objectNode.start)
  const childIndent = last ? indentAt(file.content, last.keyStart) : `${parentIndent}  `
  const prefix = last && !hasTrailingComma ? ',' : ''
  const text = multiline
    ? `${prefix}\n${childIndent}${JSON.stringify(key)}: ${JSON.stringify(value)}\n${parentIndent}`
    : `${prefix}${last ? ' ' : ''}${JSON.stringify(key)}: ${JSON.stringify(value)} `
  return { start: objectNode.closeStart, end: objectNode.closeStart, text }
}

function effectiveMcpServer(files, name) {
  let effective = null
  for (const file of files) {
    if (!file.exists || file.parseError) continue
    const mcpNode = findProperty(file.ast, 'mcp')?.valueNode
    if (mcpNode?.type !== 'object') continue
    const serversProperty = findProperty(mcpNode, 'servers')
    const nested = validateMcpV1toV2Source(file.config.mcp).hasV2ServersMap
    const serverMapNode = nested ? serversProperty.valueNode : mcpNode
    const serverProperty = findProperty(serverMapNode, name)
    if (serverProperty?.valueNode?.type === 'object') {
      effective = { file, server: serverProperty.valueNode, nested }
    }
  }
  return effective
}

function indentAt(source, offset) {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  return /^[\t ]*/.exec(source.slice(lineStart, offset))[0]
}

function formatValue(value, indent) {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n')
}

function applyTextEdits(source, edits) {
  let result = source
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`
  }
  return result
}

function editConfig(file, policy, extraEdits = []) {
  const { ast, content } = file
  const properties = new Map(ast.properties.map((property) => [property.key, property]))
  const legacy = properties.get('permission')
  const native = properties.get('permissions')
  const edits = [...extraEdits]

  if (legacy && commentsWithin(ast, legacy.valueStart, legacy.valueEnd)) {
    throw new Error(
      `${file.name} has comments inside the legacy permission value; it is preview-only to preserve comments.`,
    )
  }
  if (native && commentsWithin(ast, native.valueStart, native.valueEnd)) {
    throw new Error(
      `${file.name} has comments inside the permissions value; it is preview-only to preserve comments.`,
    )
  }

  if (native) {
    const indent = indentAt(content, native.keyStart)
    edits.push({
      start: native.valueStart,
      end: native.valueEnd,
      text: formatValue(policy, indent),
    })
    if (legacy) {
      if (commentsWithin(ast, legacy.keyStart, legacy.valueEnd)) {
        throw new Error(
          `${file.name} has comments attached to both permission keys; it is preview-only.`,
        )
      }
      if (legacy.commaAfter !== null) {
        if (commentsWithin(ast, legacy.keyStart, legacy.commaAfter + 1)) {
          throw new Error(
            `${file.name} has comments next to the legacy permission key; it is preview-only.`,
          )
        }
        edits.push({ start: legacy.keyStart, end: legacy.commaAfter + 1, text: '' })
      } else if (legacy.commaBefore !== null) {
        if (commentsWithin(ast, legacy.commaBefore, legacy.valueEnd)) {
          throw new Error(
            `${file.name} has comments next to the legacy permission key; it is preview-only.`,
          )
        }
        edits.push({ start: legacy.commaBefore, end: legacy.valueEnd, text: '' })
      } else {
        edits.push({ start: legacy.keyStart, end: legacy.valueEnd, text: '' })
      }
    }
  } else if (legacy) {
    const indent = indentAt(content, legacy.keyStart)
    edits.push({ start: legacy.keyStart, end: legacy.keyEnd, text: '"permissions"' })
    edits.push({
      start: legacy.valueStart,
      end: legacy.valueEnd,
      text: formatValue(policy, indent),
    })
  } else {
    const last = ast.properties.at(-1)
    const indent = last ? indentAt(content, last.keyStart) : '  '
    const beforeClose = content.slice(last?.valueEnd ?? ast.start + 1, ast.closeStart)
    if (commentsWithin(ast, last?.valueEnd ?? ast.start + 1, ast.closeStart)) {
      throw new Error(`${file.name} has trailing comments at the root; it is preview-only.`)
    }
    const hasTrailingComma = last?.commaAfter !== null && last?.commaAfter !== undefined
    const prefix = last ? (hasTrailingComma ? '' : ',') : ''
    const linePrefix = beforeClose.includes('\n') || content.includes('\n') ? '\n' : ' '
    const suffix = linePrefix
    const insertion = `${prefix}${linePrefix}${indent}"permissions": ${formatValue(policy, indent)}${suffix}`
    edits.push({ start: ast.closeStart, end: ast.closeStart, text: insertion })
  }

  const updated = applyTextEdits(content, edits)
  parseConfig(updated, file.format === 'jsonc')
  return updated
}

function emit(output, text = '') {
  if (typeof output === 'function') output(text)
  else if (typeof output.write === 'function') output.write(`${text}\n`)
  else output.log?.(text)
}

function printPolicyPreview(file, policy, output) {
  emit(output, `Proposed policy: ${file.name}: ${policy.length} ordered V2 rule(s).`)
  for (const [index, rule] of policy.entries()) {
    if (!isRecord(rule)) continue
    emit(
      output,
      `Policy rule ${index + 1}: action=${reviewPolicyValue(rule.action, 'action')}; ` +
        `resource=${reviewPolicyValue(rule.resource, 'resource')}; effect=${EFFECTS.has(rule.effect) ? rule.effect : '[redacted]'}.`,
    )
  }
}

const SENSITIVE_POLICY_VALUE =
  /(?:^|[^a-z0-9])(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|akia|secret|token|password|credential)/i

function reviewPolicyValue(value, kind) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 96 ||
    /[\r\n\0]/.test(value) ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    SENSITIVE_POLICY_VALUE.test(value)
  ) {
    return '[redacted]'
  }
  const allowed =
    kind === 'action' ? /^[A-Za-z][A-Za-z0-9._-]*(?:_[A-Za-z0-9.*-]+)?$/ : /^[A-Za-z0-9_*?. /-]+$/
  if (!allowed.test(value) || value.split('/').includes('..')) return '[redacted]'
  return value
}

function printInspection(files, sources, output) {
  emit(output, 'V2 config preflight (read-only; no files have been changed):')
  emit(
    output,
    'OpenCode V2 loads opencode.json then opencode.jsonc. MCP servers merge by name, later server objects replace earlier ones, and permission arrays append in file order.',
  )
  for (const file of files) {
    if (!file.exists) {
      emit(output, `- ${file.name}: not present`)
      continue
    }
    if (file.directoryError) {
      emit(output, `- ${file.name}: blocked (unsafe path or file type).`)
      continue
    }
    if (file.parseError) {
      emit(output, `- ${file.name}: cannot safely parse; no changes proposed.`)
      continue
    }
    const relevant = ['permission', 'permissions']
      .filter((key) => Object.hasOwn(file.config, key))
      .map((key) => `${key} policy present`)
    const managed = inspectInstallerEntries(file.config)
    if (managed.plugins.length > 0)
      relevant.push(`Pantheon V2 plugin entry: ${managed.plugins.length}`)
    if (managed.mcp.length > 0)
      relevant.push(`verified Pantheon MCP entries: ${managed.mcp.length}`)
    emit(
      output,
      `- ${file.name}: ${relevant.length ? relevant.join('; ') : 'no permission policy keys'}`,
    )
  }
  for (const file of files) {
    const localSources = sources.filter((source) => source.file.path === file.path)
    if (localSources.length > 1) {
      emit(
        output,
        `Conflict in ${file.name}: both legacy and V2 permission policies are present; choose the policy source for this file.`,
      )
    }
  }
  for (const source of sources) {
    for (const [index] of getMcpAskEntries(source).entries()) {
      emit(
        output,
        `Ineffective MCP ask detected: rule ${index + 1} in ${source.file.name}; an explicit outcome is required.`,
      )
    }
  }
}

function terminalPrompts() {
  return clack
}

/** Collect source-aware V2 config choices and return a write-free operation plan. */
export async function prepareV2Config({
  configDir,
  interactive = false,
  prompts = terminalPrompts(),
  output = console,
  filesystem = fs,
  dryRun = false,
} = {}) {
  const files = inspectConfigFiles(configDir, filesystem)
  const directoryFailure = files.find((file) => file.directoryError)
  const parseFailure = files.find((file) => file.exists && file.parseError)
  if (directoryFailure || parseFailure) {
    printInspection(files, policySources(files), output)
    if (directoryFailure)
      return { status: 'blocked', reason: directoryFailure.parseError, changes: [] }
    return {
      status: 'blocked',
      reason: `${parseFailure.name} is not valid ${parseFailure.format.toUpperCase()}.`,
      changes: [],
    }
  }

  const malformedMcpFile = files.find((file) => {
    if (!file.exists || file.config?.mcp === undefined) return false
    try {
      validateMcpV1toV2Source(file.config.mcp)
      return false
    } catch {
      return true
    }
  })
  if (malformedMcpFile) {
    const reason =
      `${malformedMcpFile.name} contains a malformed or ambiguous MCP configuration; ` +
      'setup stopped before writes.'
    printInspection(files, [], output)
    emit(output, reason)
    return { status: 'blocked', reason, changes: [], configDir }
  }

  const flatJsoncMcpEntries = files.reduce(
    (total, file) => total + flatThirdPartyMcpEntryCount(file),
    0,
  )
  if (flatJsoncMcpEntries > 0) {
    const reason =
      `opencode.jsonc contains ${flatJsoncMcpEntries} flat third-party MCP server ` +
      `${flatJsoncMcpEntries === 1 ? 'entry' : 'entries'} at redacted path mcp.<redacted>. ` +
      'Convert them manually to mcp.servers or remove them before retrying V2 setup.'
    printInspection(files, policySources(files), output)
    emit(output, reason)
    return { status: 'blocked', reason, changes: [], configDir }
  }

  const sources = policySources(files)
  const entryPlan = managedEntryMovePlan(files)
  printInspection(files, sources, output)

  if (hasNativeCrossLayerPermissionConflict(files, sources)) {
    const reason =
      'Overlapping permission layers have conflicting effects; resolve the layers before setup.'
    emit(output, reason)
    return { status: 'blocked', reason, changes: [], configDir }
  }

  if (entryPlan.unsafePluginCount > 0) {
    const reason =
      'A verified Pantheon plugin entry cannot be migrated or deduplicated safely in the V2 init preview; setup stopped before writes.'
    emit(output, reason)
    return { status: 'blocked', reason, changes: [], configDir }
  }
  const sourcesFor = (file) => sources.filter((source) => source.file.path === file.path)
  const askEntries = sources.flatMap((source) => getMcpAskEntries(source))
  const needsLegacyConversion = sources.some((source) => source.key === 'permission')

  if (
    entryPlan.unsafeCount === 0 &&
    entryPlan.moves.length === 0 &&
    entryPlan.edits.length === 0 &&
    (sources.length === 0 || (!needsLegacyConversion && askEntries.length === 0))
  ) {
    emit(output, 'No permission-policy migration is required.')
    return {
      status: 'unchanged',
      changes: [],
      configDir,
      unsafeMcpNames: entryPlan.unsafeMcpNames,
      configPreconditions: makeConfigPreconditions(files),
    }
  }

  if (!interactive || dryRun) {
    emit(
      output,
      'Preview only. Rerun `npm run setup` in an interactive terminal to review and authorize setup.',
    )
    if (entryPlan.moves.length > 0) {
      emit(
        output,
        `Managed-entry migration: ${entryPlan.moves.length} verified JSONC entry/entries can be moved without reordering.`,
      )
    }
    if (entryPlan.removedDuplicatePluginCount > 0) {
      emit(
        output,
        `Managed-entry migration: ${entryPlan.removedDuplicatePluginCount} exact duplicate Pantheon plugin entry/entries can be removed from JSONC.`,
      )
    }
    if (entryPlan.unsafeCount > 0) {
      emit(
        output,
        `${entryPlan.unsafeCount} verified JSONC entry/entries need an explicit keep-in-place or abort choice.`,
      )
    }
    return { status: 'preview', changes: [], configDir }
  }

  if (entryPlan.unsafeCount > 0) {
    const selected = await prompts.select({
      message:
        'Some verified Pantheon entries cannot be moved without risking order, selector, or same-name override changes. Continue leaving them in JSONC, or abort setup?',
      options: [
        { value: 'abort', label: 'Abort setup' },
        { value: 'keep', label: 'Continue, leaving those entries unchanged' },
      ],
    })
    if (prompts.isCancel?.(selected) || selected === 'abort') {
      prompts.cancel?.('Setup stopped because a JSONC entry could not be migrated safely.')
      return { status: 'skipped', changes: [], configDir }
    }
    if (selected !== 'keep') {
      return { status: 'blocked', reason: 'Unsafe managed-entry choice.', changes: [], configDir }
    }
    emit(output, `User choice: leave ${entryPlan.unsafeCount} verified entry/entries in JSONC.`)
  }

  const askChoices = Object.create(null)
  const disableCandidates = new Map()
  const disableCandidateNames = new Map()
  for (const ask of sources.flatMap((source) => getMcpAskEntries(source))) {
    const server = ask.server ? effectiveMcpServer(files, ask.server) : null
    const supportsDisable = server?.nested === true
    const scope = ask.scope === 'tool' ? 'this MCP rule' : 'every tool for this MCP server'
    const options = [
      { value: 'deny', label: `Deny ${scope}` },
      ...(supportsDisable ? [{ value: 'disable', label: 'Disable this MCP server' }] : []),
      { value: 'accessible', label: 'Leave accessible without a prompt (no rule)' },
      { value: 'allow', label: `Allow ${scope}` },
    ]
    const selected = await prompts.select({
      message: `MCP policy ${ask.label} is ineffective in V2. Choose an explicit outcome:`,
      options,
    })
    if (prompts.isCancel?.(selected) || !options.some(({ value }) => value === selected)) {
      prompts.cancel?.('MCP policy choice missing; no files were changed.')
      return { status: 'canceled', changes: [], configDir }
    }
    if (selected === 'disable' && ask.server && server) {
      disableCandidates.set(ask.id, server)
      disableCandidateNames.set(ask.id, ask.server)
    }
    askChoices[ask.id] = selected
  }

  const requiredPaths = new Set(
    sources
      .filter((source) => source.key === 'permission' || getMcpAskEntries(source).length > 0)
      .map((source) => source.file.path),
  )
  if (entryPlan.moves.length > 0) {
    if (entryPlan.source) requiredPaths.add(entryPlan.source.path)
    if (entryPlan.target) requiredPaths.add(entryPlan.target.path)
  }
  if (entryPlan.edits.length > 0 && entryPlan.source) requiredPaths.add(entryPlan.source.path)
  for (const server of disableCandidates.values()) requiredPaths.add(server.file.path)
  if (
    [...disableCandidates].some(([askId, server]) => {
      const name = disableCandidateNames.get(askId)
      return (
        server.file.path === entryPlan.source?.path &&
        entryPlan.removedMcpEntries.some((entry) => entry.name === name)
      )
    }) &&
    entryPlan.target
  ) {
    requiredPaths.add(entryPlan.target.path)
  }
  const targetOptions = files
    .filter((file) => requiredPaths.has(file.path))
    .map((file) => ({
      value: file.path,
      label: file.name,
      hint: 'Select explicitly to allow this file to be changed.',
    }))
  if (targetOptions.length === 0) {
    return {
      status: 'unchanged',
      changes: [],
      configDir,
      unsafeMcpNames: entryPlan.unsafeMcpNames,
      configPreconditions: makeConfigPreconditions(files),
    }
  }
  const targetAnswer = await prompts.multiselect({
    message: 'Which existing config file(s) may be changed?',
    options: targetOptions,
    initialValues: [],
    required: false,
  })
  if (
    prompts.isCancel?.(targetAnswer) ||
    !Array.isArray(targetAnswer) ||
    targetAnswer.length === 0
  ) {
    prompts.cancel?.('Config preparation canceled; files were not changed.')
    return { status: 'canceled', changes: [], configDir }
  }
  const targets = files.filter((file) => targetAnswer.includes(file.path))
  if ([...requiredPaths].some((filePath) => !targetAnswer.includes(filePath))) {
    const reason = 'Every file with legacy or ineffective MCP ask rules must be reviewed.'
    emit(output, reason)
    return { status: 'blocked', reason, changes: [], configDir }
  }

  const selectedSources = new Map()
  try {
    for (const target of targets) {
      const localSources = sourcesFor(target)
      if (localSources.length === 0) continue
      let selectedSource = localSources[0]
      if (localSources.length > 1) {
        const selected = await prompts.select({
          message: `Which policy in ${target.name} should remain? Choosing one removes the other policy key.`,
          options: localSources.map((source) => ({
            value: source.id,
            label: source.key,
            hint: 'Policy values are not displayed.',
          })),
        })
        if (prompts.isCancel?.(selected) || !selected) {
          prompts.cancel?.('Policy source not selected; files were not changed.')
          return { status: 'canceled', changes: [], configDir }
        }
        selectedSource = localSources.find((source) => source.id === selected)
        if (!selectedSource) {
          return {
            status: 'blocked',
            reason: 'The selected policy source is invalid.',
            changes: [],
            configDir,
          }
        }
      }

      selectedSources.set(target.path, selectedSource)
    }
  } catch {
    emit(output, 'Preview blocked: selected policy data could not be safely converted.')
    return {
      status: 'blocked',
      reason: 'Selected policy data is unsupported.',
      changes: [],
      configDir,
    }
  }

  for (const source of selectedSources.values()) {
    for (const ask of getMcpAskEntries(source)) {
      const outcome = askChoices[ask.id]
      if (!outcome) continue
      const actions = ask.action
        ? [ask.action]
        : ask.server
          ? mcpServerPermissionActions(ask.server)
          : ['[redacted]']
      emit(
        output,
        `MCP policy outcome: ${source.file.name} ${source.key} rule → ${outcome}; ` +
          `action=${actions.map((action) => reviewPolicyValue(action, 'action')).join(' + ')}; ` +
          `resource=${reviewPolicyValue(ask.resource ?? '*', 'resource')}.`,
      )
    }
  }

  // Ask outcomes only affect the source the user selected to retain. In
  // particular, a `disable` answer attached to a discarded same-file policy
  // must not mutate the MCP server independently of that source.
  const disabledServers = new Map()
  for (const source of selectedSources.values()) {
    for (const ask of getMcpAskEntries(source)) {
      if (askChoices[ask.id] !== 'disable' || !ask.server) continue
      const server = effectiveMcpServer(files, ask.server)
      if (server) disabledServers.set(ask.server, server)
    }
  }
  const relocatedDisabledServers = new Set()
  for (const [name, server] of disabledServers) {
    if (
      server.file.path === entryPlan.source?.path &&
      entryPlan.removedMcpEntries.some((entry) => entry.name === name)
    ) {
      relocatedDisabledServers.add(name)
    }
  }
  for (const [name, server] of disabledServers) {
    const destination = relocatedDisabledServers.has(name) ? entryPlan.target : server.file
    emit(
      output,
      `Config operation: ${destination.name} mcp.servers[${reviewPolicyValue(name, 'action')}].disabled = true.`,
    )
  }
  try {
    if (hasCrossLayerPermissionConflict(files, sources, selectedSources, askChoices)) {
      const reason =
        'Overlapping permission sources change effective policy across config layers; resolve the layers explicitly before setup.'
      emit(output, reason)
      return { status: 'blocked', reason, changes: [], configDir }
    }
  } catch {
    return {
      status: 'blocked',
      reason: 'Permission policy conflict could not be safely evaluated.',
      changes: [],
      configDir,
    }
  }

  const extraEdits = new Map()
  if (entryPlan.source && entryPlan.edits.length > 0) {
    extraEdits.set(entryPlan.source.path, [...entryPlan.edits])
  }
  try {
    for (const [name, server] of disabledServers) {
      if (relocatedDisabledServers.has(name)) continue
      if (!server?.nested) throw new Error('MCP disable schema unavailable')
      const edits = extraEdits.get(server.file.path) ?? []
      edits.push(setObjectFieldEdit(server.file, server.server, 'disabled', true))
      extraEdits.set(server.file.path, edits)
    }
  } catch {
    return {
      status: 'blocked',
      reason: 'An MCP server could not be safely disabled.',
      changes: [],
      configDir,
    }
  }

  const plannedContents = new Map()
  try {
    for (const file of files) {
      if (!file.exists || file.parseError) continue
      const edits = extraEdits.get(file.path) ?? []
      const selectedSource = selectedSources.get(file.path)
      let contents = file.content
      let policy = null
      if (selectedSource) {
        policy = makeV2Policy(selectedSource, askChoices)
        contents = editConfig(file, policy, edits)
      } else if (edits.length > 0) {
        contents = applyTextEdits(file.content, edits)
        parseConfig(contents, file.format === 'jsonc')
      }
      if (contents !== file.content) plannedContents.set(file.path, { file, contents, policy })
      if (policy) printPolicyPreview(file, policy, output)
    }
    if (entryPlan.moves.length > 0 || relocatedDisabledServers.size > 0) {
      const target = entryPlan.target
      const previous =
        plannedContents.get(target.path)?.contents ?? (target.exists ? target.content : '{}\n')
      const config = target.exists ? parseConfig(previous, false).value : {}
      addManagedEntriesToJson(config, entryPlan.moves, relocatedDisabledServers)
      plannedContents.set(target.path, {
        file: target,
        contents: `${JSON.stringify(config, null, 2)}\n`,
        policy: selectedSources.has(target.path)
          ? makeV2Policy(selectedSources.get(target.path), askChoices)
          : null,
      })
    }
  } catch {
    emit(output, 'Preview blocked: the requested edits cannot preserve the existing config safely.')
    return {
      status: 'blocked',
      reason: 'The requested edits are not safe to apply.',
      changes: [],
      configDir,
    }
  }

  const changes = [...plannedContents.values()].map(({ file, contents, policy }) => ({
    path: file.path,
    original: file.exists ? file.content : null,
    contents,
    policy,
    identity: file.identity ?? null,
    fileName: file.name,
  }))

  if (changes.length === 0) {
    emit(
      output,
      'The selected files already match the selected V2 policy; no config changes are needed.',
    )
    return {
      status: 'unchanged',
      changes: [],
      configDir,
      unsafeMcpNames: entryPlan.unsafeMcpNames,
      configPreconditions: makeConfigPreconditions(files, plannedContents),
    }
  }
  emit(output, `Config plan: ${changes.length} file(s) will be updated after setup authorization.`)
  for (const change of changes) {
    if (!CONFIG_NAMES.includes(change.fileName)) continue
    const file = files.find((candidate) => candidate.path === change.path)
    const policyKeys = ['permission', 'permissions'].filter((key) =>
      file?.ast?.properties.some((property) => property.key === key),
    )
    if (policyKeys.length > 0) {
      emit(
        output,
        `Config operation: ${change.fileName} ${policyKeys.join(' + ')} → permissions (${change.policy?.length ?? 0} rule(s)).`,
      )
    }
  }
  if (entryPlan.moves.length > 0) {
    emit(
      output,
      `Managed-entry migration: ${entryPlan.moves.length} verified entry/entries will move into opencode.json.`,
    )
  }
  if (entryPlan.removedDuplicatePluginCount > 0) {
    emit(
      output,
      `Managed-entry migration: ${entryPlan.removedDuplicatePluginCount} exact duplicate Pantheon plugin entry/entries will be removed from JSONC.`,
    )
  }
  emit(
    output,
    'If interrupted between files, use `pantheon-opencode restore` to review and restore the setup backup set.',
  )
  const jsonFile = files.find((file) => file.name === 'opencode.json')
  const jsonChange = jsonFile ? plannedContents.get(jsonFile.path) : null
  const configPreview = jsonChange?.contents ?? (jsonFile?.exists ? jsonFile.content : '{}\n')
  return {
    status: 'planned',
    changes,
    configDir,
    configPreview,
    unsafeMcpNames: entryPlan.unsafeMcpNames,
    configPreconditions: makeConfigPreconditions(files, plannedContents),
  }
}

/** Apply a reviewed plan with the installer's existing backup and atomic writer. */
export function applyConfigChanges(
  changes,
  {
    configDir = changes[0] ? path.dirname(changes[0].path) : process.cwd(),
    filesystem = fs,
    backupSet = createBackupSet,
    writeConfig = writeConfigWithBackup,
  } = {},
) {
  if (changes.length === 0) return { dir: null, name: null }
  const root = path.resolve(configDir)
  const relativePaths = []
  for (const change of changes) {
    assertPathWithin(root, change.path)
    if (
      path.dirname(path.resolve(change.path)) !== root ||
      !CONFIG_NAMES.includes(path.basename(change.path))
    ) {
      throw new Error('The reviewed plan contains an unsupported config target.')
    }
    assertManagedPathNoSymlinks(change.path)
    let stat = null
    try {
      stat = filesystem.lstatSync(change.path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('A reviewed config target cannot be inspected.')
    }
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
      throw new Error('A reviewed config target is not a regular file.')
    }
    const current = stat ? filesystem.readFileSync(change.path, 'utf8') : null
    if (
      current !== change.original ||
      (stat && change.identity && !sameIdentity(stat, change.identity))
    ) {
      throw new Error('A config changed after review; no stale content was written.')
    }
    relativePaths.push(path.basename(change.path))
  }

  const backup = backupSet({ configDir: root, entries: relativePaths, keep: 0 })
  for (const change of changes) {
    const status = writeConfig(change.path, change.contents, false, {
      expectedContent: change.original,
    })
    if (status === 'conflict') {
      throw new Error('A config changed during apply; restore from the setup backup if needed.')
    }
  }
  return backup
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino
}
