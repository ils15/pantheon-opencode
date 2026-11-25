/**
 * Legacy Data Migration & Stale Artifact Purge Engine (`legacy-store-migration.mjs`).
 *
 * Plain ESM `.mjs` module (with `.d.mts` types) so it runs natively both inside
 * `node_modules/` during global `pantheon-opencode init` (where Node.js forbids
 * `.ts` type-stripping) and inside the bundled TypeScript plugin.
 *
 * @module pantheon/legacy-store-migration
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._:-]{1,128}$/

/**
 * Resolve the user's global OpenCode config directory safely.
 * Inside Node's test runner (`NODE_TEST_CONTEXT`), returns `undefined` unless
 * `PANTHEON_HOME` or `XDG_CONFIG_HOME` was explicitly redirected by the test.
 */
export function resolveSafeGlobalConfigDir(env = process.env) {
  if (env.PANTHEON_HOME?.trim()) {
    return resolve(env.PANTHEON_HOME.trim())
  }
  if (env.XDG_CONFIG_HOME?.trim()) {
    return join(resolve(env.XDG_CONFIG_HOME.trim()), 'opencode')
  }
  if (env.NODE_TEST_CONTEXT) {
    return undefined
  }
  const home = env.HOME?.trim()
  return home ? join(resolve(home), '.config', 'opencode') : undefined
}

function toSafeSegment(raw, fallback = 'default') {
  const str = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '_')
    .slice(0, 128)
  if (!str || str === '.' || str === '..' || !SAFE_SEGMENT_RE.test(str)) {
    return fallback
  }
  return str
}

function sameFileOrPath(a, b) {
  if (resolve(a) === resolve(b)) return true
  if (!existsSync(a) || !existsSync(b)) return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function removeFileAndSqliteSidecars(filePath, deleted, dryRun = false) {
  const dir = dirname(filePath)
  const base = filePath.slice(dir.length + 1)
  const candidates = [
    filePath,
    `${filePath}-wal`,
    `${filePath}-shm`,
    `${filePath}-journal`,
    join(dir, `.${base}.init.lock`),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      if (!dryRun) {
        rmSync(candidate, { recursive: true, force: true })
      }
      deleted.push(candidate)
    }
  }
}

function removeEmptyDirIfPossible(dirPath, deleted, dryRun = false) {
  if (!existsSync(dirPath)) return
  try {
    const entries = readdirSync(dirPath)
    if (entries.length === 0) {
      if (!dryRun) {
        rmSync(dirPath, { recursive: true, force: true })
      }
      deleted.push(dirPath)
    }
  } catch {
    /* ignore */
  }
}

const GLOBAL_CACHE_SYM = Symbol.for('pantheon.legacy.migratedWorkspaces.v1')
const g = globalThis
if (!(g[GLOBAL_CACHE_SYM] instanceof Set)) {
  g[GLOBAL_CACHE_SYM] = new Set()
}
const migratedWorkspaces = g[GLOBAL_CACHE_SYM]

export function resetLegacyMigrationCacheForTests() {
  migratedWorkspaces.clear()
}

function safeMtimeMs(filePath) {
  try {
    return existsSync(filePath) ? statSync(filePath).mtimeMs : 0
  } catch {
    return 0
  }
}

const PANTHEON_LEGACY_MCP_NAMES = new Set([
  'pantheon-resources',
  'pantheon-code-mode',
  'pantheon-memory',
  'pantheon-persistence',
  'pantheon-vision',
])

const LEGACY_PYTHON_MCP_SCRIPTS = new Set([
  'mcp_resources.py',
  'mcp_resources_server.py',
  'code_mode.py',
  'code_mode_server.py',
  'memory_mcp.py',
  'memory_mcp_server.py',
  'mcp_persistence.py',
  'mcp_persistence_server.py',
  'pantheon_vision.py',
  'pantheon_vision_server.py',
])

const LEGACY_PYTHON_RUNTIME_SCRIPTS = [
  ...LEGACY_PYTHON_MCP_SCRIPTS,
  '_pantheon_paths.py',
  'eval_store.py',
  'mcp_codemap_module.py',
  'themis_heuristic_scan.py',
  'scrub-secrets.py',
]

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsoncString(source, cursor) {
  const start = cursor
  cursor += 1
  let escaped = false
  while (cursor < source.length) {
    const ch = source[cursor]
    if (escaped) {
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else if (ch === '"') {
      const end = cursor + 1
      return { value: JSON.parse(source.slice(start, end)), start, end, cursor: end }
    }
    cursor += 1
  }
  throw new SyntaxError(`Unterminated string at offset ${start}`)
}

/** Parse JSON/JSONC into a span-tracked AST so surgical edits preserve comments. */
function parseJsoncAst(source, allowComments = true) {
  let cursor = 0
  function skipTrivia() {
    while (cursor < source.length) {
      if (/\s/.test(source[cursor])) {
        cursor += 1
        continue
      }
      if (allowComments && source.startsWith('//', cursor)) {
        const nl = source.indexOf('\n', cursor + 2)
        cursor = nl < 0 ? source.length : nl
        continue
      }
      if (allowComments && source.startsWith('/*', cursor)) {
        const close = source.indexOf('*/', cursor + 2)
        if (close < 0) throw new SyntaxError(`Unterminated comment at offset ${cursor}`)
        cursor = close + 2
        continue
      }
      break
    }
  }

  function parseValue() {
    skipTrivia()
    const start = cursor
    const ch = source[cursor]
    if (ch === '"') {
      const tok = parseJsoncString(source, cursor)
      cursor = tok.cursor
      return { type: 'scalar', value: tok.value, start, end: cursor }
    }
    if (ch === '{') {
      cursor += 1
      const value = {}
      const properties = []
      skipTrivia()
      if (source[cursor] === '}') {
        cursor += 1
        return { type: 'object', value, properties, start, end: cursor }
      }
      let prevProp = null
      while (cursor < source.length) {
        skipTrivia()
        if (source[cursor] !== '"') throw new SyntaxError(`Expected object key at ${cursor}`)
        const keyTok = parseJsoncString(source, cursor)
        cursor = keyTok.cursor
        skipTrivia()
        if (source[cursor] !== ':') throw new SyntaxError(`Expected ':' at ${cursor}`)
        cursor += 1
        const valNode = parseValue()
        Object.defineProperty(value, keyTok.value, {
          value: valNode.value,
          enumerable: true,
          configurable: true,
          writable: true,
        })
        const prop = {
          key: keyTok.value,
          keyStart: keyTok.start,
          keyEnd: keyTok.end,
          valueStart: valNode.start,
          valueEnd: valNode.end,
          value: valNode.value,
          valueNode: valNode,
          commaBefore: prevProp?.commaAfter ?? null,
          commaAfter: null,
        }
        properties.push(prop)
        skipTrivia()
        if (source[cursor] === ',') {
          prop.commaAfter = cursor
          cursor += 1
          skipTrivia()
          if (source[cursor] === '}') {
            if (!allowComments) throw new SyntaxError(`Trailing comma at ${prop.commaAfter}`)
            cursor += 1
            return { type: 'object', value, properties, start, end: cursor }
          }
          prevProp = prop
          continue
        }
        if (source[cursor] === '}') {
          cursor += 1
          return { type: 'object', value, properties, start, end: cursor }
        }
        throw new SyntaxError(`Expected ',' or '}' at ${cursor}`)
      }
      throw new SyntaxError(`Unterminated object at ${start}`)
    }
    if (ch === '[') {
      cursor += 1
      const value = []
      const items = []
      skipTrivia()
      if (source[cursor] === ']') {
        cursor += 1
        return { type: 'array', value, items, start, end: cursor }
      }
      let prevItem = null
      while (cursor < source.length) {
        const itemNode = parseValue()
        value.push(itemNode.value)
        const item = {
          ...itemNode,
          commaBefore: prevItem?.commaAfter ?? null,
          commaAfter: null,
        }
        items.push(item)
        skipTrivia()
        if (source[cursor] === ',') {
          item.commaAfter = cursor
          cursor += 1
          skipTrivia()
          if (source[cursor] === ']') {
            if (!allowComments) throw new SyntaxError(`Trailing comma at ${item.commaAfter}`)
            cursor += 1
            return { type: 'array', value, items, start, end: cursor }
          }
          prevItem = item
          continue
        }
        if (source[cursor] === ']') {
          cursor += 1
          return { type: 'array', value, items, start, end: cursor }
        }
        throw new SyntaxError(`Expected ',' or ']' at ${cursor}`)
      }
      throw new SyntaxError(`Unterminated array at ${start}`)
    }
    const lit = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(cursor),
    )
    if (!lit) throw new SyntaxError(`Expected JSON value at ${cursor}`)
    cursor += lit[0].length
    return { type: 'scalar', value: JSON.parse(lit[0]), start, end: cursor }
  }

  const root = parseValue()
  skipTrivia()
  if (cursor !== source.length) throw new SyntaxError(`Unexpected trailing content at ${cursor}`)
  if (root.type !== 'object') throw new SyntaxError('Config root must be a JSON object')
  return root
}

function spliceOutJsoncEntry(source, start, end, commaBefore, commaAfter) {
  let removeStart = start
  let removeEnd = end
  if (commaAfter !== null) {
    removeEnd = commaAfter + 1
  } else if (commaBefore !== null) {
    removeStart = commaBefore
  }
  while (removeStart > 0 && (source[removeStart - 1] === ' ' || source[removeStart - 1] === '\t')) {
    removeStart -= 1
  }
  if (commaAfter !== null) {
    while (removeEnd < source.length && (source[removeEnd] === ' ' || source[removeEnd] === '\t')) {
      removeEnd += 1
    }
    if (source[removeEnd] === '\r') removeEnd += 1
    if (source[removeEnd] === '\n') removeEnd += 1
  } else if (commaBefore !== null && source[removeStart - 1] === '\n') {
    removeStart -= 1
    if (source[removeStart - 1] === '\r') removeStart -= 1
  }
  return source.slice(0, removeStart) + source.slice(removeEnd)
}

function findObjectProp(astNode, key) {
  return astNode?.type === 'object' ? astNode.properties.find((p) => p.key === key) : undefined
}

function isPantheonMcpServer(name, entry) {
  if (typeof name === 'string' && PANTHEON_LEGACY_MCP_NAMES.has(name)) return true
  if (!isPlainObject(entry)) return false
  return ['managed-by', 'managedBy', 'owner'].some(
    (key) => typeof entry[key] === 'string' && /^pantheon(?:-|$)/i.test(entry[key]),
  )
}

function classifyPantheonMcpEntry(name, entry, configDir, options = {}) {
  if (!isPantheonMcpServer(name, entry) || !isPlainObject(entry)) {
    return { remove: false, isPython: false, isWorkingPython: false }
  }
  const cmdList = Array.isArray(entry.command)
    ? entry.command.filter((x) => typeof x === 'string')
    : typeof entry.command === 'string'
      ? [entry.command]
      : []
  const argList = Array.isArray(entry.args) ? entry.args.filter((x) => typeof x === 'string') : []
  const parts = [...cmdList, ...argList]
  const isPythonScript = parts.some((p) =>
    LEGACY_PYTHON_MCP_SCRIPTS.has(basename(p.replaceAll('\\', '/'))),
  )
  const isPythonBin =
    parts.length > 0 && /(?:^|[\\/])python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(parts[0])
  const isVenvPath = parts.some((p) => /(?:^|[\\/])\.venv(?:[\\/]|$)/.test(p))
  const isPython = isPythonScript || isPythonBin || isVenvPath

  const cwd =
    typeof entry.cwd === 'string' && entry.cwd.trim() !== ''
      ? resolve(configDir, entry.cwd)
      : configDir
  const exe = parts[0]
  const hasMissingExe =
    typeof exe === 'string' &&
    (exe.includes('/') || exe.includes('\\')) &&
    !existsSync(isAbsolute(exe) ? exe : resolve(cwd, exe))
  const hasMissingScript = parts.slice(1).some((p) => {
    if (!/\.(?:py|mjs|js|ts)$/i.test(p) || p.startsWith('-')) return false
    return !existsSync(isAbsolute(p) ? p : resolve(cwd, p))
  })
  const isLocal = entry.type === 'local' || entry.type === 'stdio' || entry.type === undefined
  const isBrokenLocal = isLocal && (hasMissingExe || hasMissingScript)

  if (options.preserveWorkingPythonMcp && isPython && !isBrokenLocal) {
    return { remove: false, isPython: true, isWorkingPython: true }
  }
  return { remove: isPython || isBrokenLocal, isPython, isWorkingPython: false }
}

function getPluginRefString(entry) {
  if (typeof entry === 'string') return entry
  if (isPlainObject(entry) && typeof entry.package === 'string') return entry.package
  return null
}

function isPantheonPluginRef(ref) {
  if (typeof ref !== 'string') return false
  const norm = ref.replaceAll('\\', '/')
  return (
    /^pantheon-opencode(?:\/.*)?$/i.test(norm) ||
    /^pantheon-tui$/i.test(norm) ||
    /^plugins\/pantheon-tui$/i.test(norm) ||
    /pantheon-hooks(?:\.(?:ts|js|mjs))?$/i.test(norm) ||
    /(?:^|\/)src\/plugin\.ts$/i.test(norm) ||
    /(?:^|\/)pantheon-opencode\/src\/plugin$/i.test(norm) ||
    /(?:^|\/)plugins\/pantheon-tui$/i.test(norm)
  )
}

function isNpmNativePantheonPluginRef(ref) {
  if (typeof ref !== 'string') return false
  const norm = ref.trim().replaceAll('\\', '/')
  return norm === 'pantheon-opencode' || norm === 'pantheon-opencode/plugin'
}

function shouldRemoveLegacyPluginEntry(entry, configDir, { singularKey, hasNpmNativePlugin }) {
  const ref = getPluginRefString(entry)
  if (!ref || !isPantheonPluginRef(ref)) return false
  if (singularKey) return true
  const norm = ref.replaceAll('\\', '/')
  if (/pantheon-hooks(?:\.(?:ts|js|mjs))?$/i.test(norm)) return true
  if (/(?:^|\/)src\/plugin\.ts$/i.test(norm)) return true

  const isCopiedTui =
    /^pantheon-tui$/i.test(norm) ||
    /^plugins\/pantheon-tui$/i.test(norm) ||
    /(?:^|\/)plugins\/pantheon-tui$/i.test(norm)
  if (isCopiedTui && hasNpmNativePlugin) return true

  const isPackageSubpath =
    norm === 'pantheon-opencode' ||
    norm === 'pantheon-opencode/plugin' ||
    norm === 'pantheon-opencode/tui'
  if (!isPackageSubpath) {
    const isPathLike = norm.startsWith('/') || norm.startsWith('.') || norm.includes('/')
    if (isPathLike) {
      const targetPath = isAbsolute(ref) ? ref : resolve(configDir, ref)
      if (!existsSync(targetPath)) return true
      if (hasNpmNativePlugin && (norm.includes('/_npx/') || norm.endsWith('/src/plugin'))) {
        return true
      }
    }
  }
  return false
}

function isRepoSourceRoot(dirPath) {
  return (
    existsSync(join(dirPath, 'package.json')) &&
    ((existsSync(join(dirPath, 'src', 'mcp', 'code_mode.py')) &&
      existsSync(join(dirPath, 'src', 'plugin.ts'))) ||
      (existsSync(join(dirPath, 'src', 'plugin.ts')) &&
        existsSync(join(dirPath, 'src', 'agents', 'roster.json'))))
  )
}

function collectConfigDirsForRoot(root, isGlobalConfig = false) {
  const dirs = []
  const seen = new Set()
  const add = (dir, isConfigScope) => {
    const resolved = resolve(dir)
    if (seen.has(resolved) || !existsSync(resolved)) return
    seen.add(resolved)
    dirs.push({ dir: resolved, isConfigScope })
  }
  const base = basename(resolve(root))
  const rootIsFlatConfig = isGlobalConfig || base === 'opencode' || base === '.opencode'
  add(root, rootIsFlatConfig && !isRepoSourceRoot(root))
  add(join(root, '.opencode'), !isRepoSourceRoot(join(root, '.opencode')))
  return dirs
}

function writeFileAtomicallyWithBackup(filePath, content, backupScopeRoot) {
  const st = lstatSync(filePath)
  if (st.isSymbolicLink() || !st.isFile()) return false
  const original = readFileSync(filePath, 'utf8')
  if (original === content) return false

  try {
    const backupRoot = join(backupScopeRoot, '.pantheon', 'backups')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(backupRoot, `legacy-migration-${stamp}`)
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    chmodSync(backupDir, 0o700)
    const backupFile = join(backupDir, basename(filePath))
    writeFileSync(backupFile, original, { encoding: 'utf8', mode: 0o600 })
    chmodSync(backupFile, 0o600)
  } catch {
    /* backup is best-effort */
  }

  const tmpPath = `${filePath}.tmp-${process.pid}`
  writeFileSync(tmpPath, content, { encoding: 'utf8', mode: st.mode & 0o777 })
  renameSync(tmpPath, filePath)
  return true
}

function inspectConfigFileLegacyItems(filePath, configDir, options = {}) {
  if (!existsSync(filePath)) return null
  let st
  try {
    st = lstatSync(filePath)
  } catch {
    return null
  }
  if (st.isSymbolicLink() || !st.isFile()) return null
  const isJsonc = filePath.endsWith('.jsonc')
  let raw
  let parsed
  try {
    raw = readFileSync(filePath, 'utf8')
    parsed = isJsonc ? parseJsoncAst(raw, true).value : JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null

  const isTuiConfig = basename(filePath) === 'tui.json' || basename(filePath) === 'cli.json'
  const legacyMcps = []
  let hasWorkingPythonMcp = false

  if (!isTuiConfig && isPlainObject(parsed.mcp)) {
    const servers = isPlainObject(parsed.mcp.servers) ? parsed.mcp.servers : null
    if (servers) {
      for (const [name, entry] of Object.entries(servers)) {
        const res = classifyPantheonMcpEntry(name, entry, configDir, options)
        if (res.remove) legacyMcps.push({ layout: 'v2', name, isPython: res.isPython })
        else if (res.isWorkingPython) hasWorkingPythonMcp = true
      }
    }
    for (const [name, entry] of Object.entries(parsed.mcp)) {
      if (servers && name === 'servers') continue
      const res = classifyPantheonMcpEntry(name, entry, configDir, options)
      if (res.remove) legacyMcps.push({ layout: 'v1', name, isPython: res.isPython })
      else if (res.isWorkingPython) hasWorkingPythonMcp = true
    }
  }

  const pluralPlugins = Array.isArray(parsed.plugins) ? parsed.plugins : []
  const hasNpmNativePlugin =
    options.forceNativePluginActive === true ||
    pluralPlugins.some((entry) => isNpmNativePantheonPluginRef(getPluginRefString(entry)))

  const isLegacyTuiEntry = (entry) => {
    const ref = getPluginRefString(entry)
    if (!ref) return false
    const cleanRef = ref.startsWith('!') ? ref.slice(1) : ref
    return (
      isPantheonPluginRef(cleanRef) &&
      (hasNpmNativePlugin || ref.startsWith('!') || !existsSync(resolve(configDir, cleanRef)))
    )
  }

  const legacyPlugins = []
  if (Array.isArray(parsed.plugin)) {
    parsed.plugin.forEach((entry, index) => {
      if (
        isTuiConfig
          ? isLegacyTuiEntry(entry)
          : shouldRemoveLegacyPluginEntry(entry, configDir, {
              singularKey: true,
              hasNpmNativePlugin,
            })
      ) {
        legacyPlugins.push({ key: 'plugin', index, ref: getPluginRefString(entry) })
      }
    })
  }
  if (Array.isArray(parsed.plugins)) {
    parsed.plugins.forEach((entry, index) => {
      if (
        isTuiConfig
          ? isLegacyTuiEntry(entry)
          : shouldRemoveLegacyPluginEntry(entry, configDir, {
              singularKey: false,
              hasNpmNativePlugin,
            })
      ) {
        legacyPlugins.push({ key: 'plugins', index, ref: getPluginRefString(entry) })
      }
    })
  }

  return {
    filePath,
    raw,
    isJsonc,
    parsed,
    legacyMcps,
    legacyPlugins,
    hasNpmNativePlugin,
    hasWorkingPythonMcp,
  }
}

function cleanConfigFileInPlace(inspection, backupScopeRoot, dryRun = false) {
  if (!inspection) return false
  const { filePath, raw, isJsonc, legacyMcps, legacyPlugins } = inspection
  if (legacyMcps.length === 0 && legacyPlugins.length === 0) return false
  if (dryRun) return true

  let nextContent
  if (!isJsonc) {
    const cfg = JSON.parse(raw)
    for (const item of legacyMcps) {
      if (item.layout === 'v2' && isPlainObject(cfg.mcp?.servers)) {
        delete cfg.mcp.servers[item.name]
      } else if (item.layout === 'v1' && isPlainObject(cfg.mcp)) {
        delete cfg.mcp[item.name]
      }
    }
    if (isPlainObject(cfg.mcp?.servers) && Object.keys(cfg.mcp.servers).length === 0) {
      delete cfg.mcp.servers
    }
    if (isPlainObject(cfg.mcp) && Object.keys(cfg.mcp).length === 0) {
      delete cfg.mcp
    }

    for (const key of ['plugin', 'plugins']) {
      if (!Array.isArray(cfg[key])) continue
      const dropIndexes = new Set(legacyPlugins.filter((p) => p.key === key).map((p) => p.index))
      if (dropIndexes.size === 0) continue
      cfg[key] = cfg[key].filter((_, idx) => !dropIndexes.has(idx))
      if (
        cfg[key].length === 0 &&
        (key === 'plugin' || basename(filePath) === 'tui.json' || basename(filePath) === 'cli.json')
      ) {
        delete cfg[key]
      }
    }
    if (
      (basename(filePath) === 'tui.json' || basename(filePath) === 'cli.json') &&
      Object.keys(cfg).length === 0
    ) {
      writeFileAtomicallyWithBackup(filePath, `${JSON.stringify(cfg, null, 2)}\n`, backupScopeRoot)
      rmSync(filePath, { force: true })
      return true
    }
    nextContent = `${JSON.stringify(cfg, null, 2)}\n`
  } else {
    let text = raw
    // Remove MCP server properties one by one (re-parsing preserves offsets/comments).
    for (const item of legacyMcps) {
      const ast = parseJsoncAst(text, true)
      const mcpProp = findObjectProp(ast, 'mcp')
      if (!mcpProp) continue
      const targetMap =
        item.layout === 'v2'
          ? findObjectProp(mcpProp.valueNode, 'servers')?.valueNode
          : mcpProp.valueNode
      const prop = findObjectProp(targetMap, item.name)
      if (prop) {
        text = spliceOutJsoncEntry(
          text,
          prop.keyStart,
          prop.valueEnd,
          prop.commaBefore,
          prop.commaAfter,
        )
      }
    }
    // Clean empty mcp.servers / mcp objects if empty.
    {
      const ast = parseJsoncAst(text, true)
      const mcpProp = findObjectProp(ast, 'mcp')
      const serversProp = mcpProp ? findObjectProp(mcpProp.valueNode, 'servers') : undefined
      if (
        serversProp?.valueNode?.type === 'object' &&
        serversProp.valueNode.properties.length === 0
      ) {
        text = spliceOutJsoncEntry(
          text,
          serversProp.keyStart,
          serversProp.valueEnd,
          serversProp.commaBefore,
          serversProp.commaAfter,
        )
      }
      const ast2 = parseJsoncAst(text, true)
      const mcpProp2 = findObjectProp(ast2, 'mcp')
      if (mcpProp2?.valueNode?.type === 'object' && mcpProp2.valueNode.properties.length === 0) {
        text = spliceOutJsoncEntry(
          text,
          mcpProp2.keyStart,
          mcpProp2.valueEnd,
          mcpProp2.commaBefore,
          mcpProp2.commaAfter,
        )
      }
    }
    // Remove legacy plugin entries in descending index order.
    const sortedPlugins = [...legacyPlugins].sort((a, b) => b.index - a.index)
    for (const item of sortedPlugins) {
      const ast = parseJsoncAst(text, true)
      const prop = findObjectProp(ast, item.key)
      const arr = prop?.valueNode
      if (arr?.type !== 'array' || !arr.items[item.index]) continue
      const elem = arr.items[item.index]
      text = spliceOutJsoncEntry(text, elem.start, elem.end, elem.commaBefore, elem.commaAfter)
    }
    // Drop emptied singular `plugin` key, or empty `plugins` on tui.json/cli.json.
    for (const pluginKey of ['plugin', 'plugins']) {
      if (
        pluginKey === 'plugins' &&
        basename(filePath) !== 'tui.json' &&
        basename(filePath) !== 'cli.json'
      ) {
        continue
      }
      const ast = parseJsoncAst(text, true)
      const pluginProp = findObjectProp(ast, pluginKey)
      if (pluginProp?.valueNode?.type === 'array' && pluginProp.valueNode.items.length === 0) {
        text = spliceOutJsoncEntry(
          text,
          pluginProp.keyStart,
          pluginProp.valueEnd,
          pluginProp.commaBefore,
          pluginProp.commaAfter,
        )
      }
    }
    if (basename(filePath) === 'tui.json' || basename(filePath) === 'cli.json') {
      const remaining = parseJsoncAst(text, true).value
      if (isPlainObject(remaining) && Object.keys(remaining).length === 0) {
        writeFileAtomicallyWithBackup(filePath, raw, backupScopeRoot)
        rmSync(filePath, { force: true })
        return true
      }
    }
    nextContent = text
  }

  return writeFileAtomicallyWithBackup(filePath, nextContent, backupScopeRoot)
}

function inspectAndCleanLegacyConfigs(root, options = {}) {
  const dryRun = options.dryRun === true
  const isGlobalConfig = options.isGlobalConfig === true
  const configDirs = collectConfigDirsForRoot(root, isGlobalConfig)
  const inspectedFiles = []
  let hasWorkingPythonMcp = false
  let hasNpmNativePlugin = options.cleanCopiedInstallArtifacts === true
  const cleanedConfigTags = []

  // First pass over opencode.json/jsonc to detect if native npm plugin is active
  const primaryNames = ['opencode.json', 'opencode.jsonc']
  const tuiNames = ['tui.json', 'cli.json']
  const seenFiles = new Set()

  const processFile = (filePath, dir, isConfigScope) => {
    const resolved = resolve(filePath)
    if (seenFiles.has(resolved)) return
    seenFiles.add(resolved)
    const preserveWorkingPythonMcp =
      options.preserveWorkingPythonMcp ??
      (hasNpmNativePlugin || options.cleanCopiedInstallArtifacts === true
        ? false
        : process.env.PANTHEON_USE_PYTHON_MCP === '1')
    const info = inspectConfigFileLegacyItems(resolved, dir, {
      preserveWorkingPythonMcp,
      forceNativePluginActive: hasNpmNativePlugin,
    })
    if (!info) return
    inspectedFiles.push({ ...info, configDir: dir, isConfigScope })
    if (info.hasWorkingPythonMcp) hasWorkingPythonMcp = true
    if (info.hasNpmNativePlugin) hasNpmNativePlugin = true
    if (info.legacyMcps.length > 0 || info.legacyPlugins.length > 0) {
      const changed = cleanConfigFileInPlace(info, root, dryRun)
      if (changed) {
        for (const mcp of info.legacyMcps) {
          cleanedConfigTags.push(`${resolved}#legacy-mcp:${mcp.name}`)
        }
        if (info.legacyPlugins.length > 0) {
          cleanedConfigTags.push(`${resolved}#legacy-plugin`)
        }
      }
    }
  }

  for (const { dir, isConfigScope } of configDirs) {
    for (const fileName of primaryNames) {
      processFile(join(dir, fileName), dir, isConfigScope)
    }
  }
  for (const { dir, isConfigScope } of configDirs) {
    for (const fileName of tuiNames) {
      processFile(join(dir, fileName), dir, isConfigScope)
    }
  }

  return {
    configDirs,
    inspectedFiles,
    hasWorkingPythonMcp,
    hasNpmNativePlugin,
    cleanedConfigTags,
  }
}

function hasPendingLegacyFiles(rootDir, isGlobalConfig = false) {
  const checks = [
    join(rootDir, '.pantheon', 'memory.db'),
    join(rootDir, 'memory', 'memory.db'),
    join(rootDir, '.pantheon', 'persistence', 'global.db'),
    join(rootDir, '.pantheon', 'persistence', 'project.db'),
    join(rootDir, 'persistence', 'global.db'),
    join(rootDir, 'persistence', 'project.db'),
    join(rootDir, '.pantheon', 'goals.json'),
    join(rootDir, '.pantheon', 'persistence', 'goals'),
    join(rootDir, 'plugins', 'pantheon-hooks.ts'),
    join(rootDir, 'plugins', 'pantheon-hooks.js'),
    join(rootDir, '.opencode', 'plugins', 'pantheon-hooks.ts'),
    join(rootDir, '.opencode', 'plugins', 'pantheon-hooks.js'),
    join(rootDir, 'tiers.json'),
    join(rootDir, '.opencode', 'tiers.json'),
    join(rootDir, '.pantheon', 'fastembed_cache'),
    join(rootDir, '.pantheon', '.fastembed'),
    join(rootDir, 'fastembed_cache'),
  ]
  if (checks.some((p) => existsSync(p))) return true

  const preserveWorkingPythonMcp = process.env.PANTHEON_USE_PYTHON_MCP === '1'
  for (const { dir, isConfigScope } of collectConfigDirsForRoot(rootDir, isGlobalConfig)) {
    for (const fileName of ['opencode.json', 'opencode.jsonc', 'tui.json', 'cli.json']) {
      const info = inspectConfigFileLegacyItems(join(dir, fileName), dir, {
        preserveWorkingPythonMcp,
      })
      if (info && (info.legacyMcps.length > 0 || info.legacyPlugins.length > 0)) return true
    }
    if (isConfigScope) {
      if (existsSync(join(dir, 'plugins', 'pantheon-tui'))) return true
      if (existsSync(join(dir, 'commands', 'pantheon.md'))) return true
      if (existsSync(join(dir, 'routing.yml'))) return true
      if (existsSync(join(dir, '.pantheon', 'install-state.json'))) return true
      if (!preserveWorkingPythonMcp) {
        for (const py of LEGACY_PYTHON_RUNTIME_SCRIPTS) {
          if (existsSync(join(dir, 'scripts', py))) return true
        }
      }
    }
  }
  if (existsSync(join(rootDir, '.pantheon', 'install-state.json'))) return true
  return false
}

function canSkipMigrationViaStamp(workspaceDir, globalConfigDir) {
  const stampPath = join(workspaceDir, '.pantheon', '.migration-v2.json')
  if (!existsSync(stampPath)) return false
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
    if (stamp?.version !== 2) return false
    if (hasPendingLegacyFiles(workspaceDir, false)) return false
    if (globalConfigDir && existsSync(globalConfigDir)) {
      if (hasPendingLegacyFiles(globalConfigDir, true)) return false
      const globalMemDb = join(globalConfigDir, '.pantheon', 'memory', 'memory.db')
      if (safeMtimeMs(globalMemDb) !== Number(stamp.globalMtimeMs ?? -1)) return false
    }
    return true
  } catch {
    return false
  }
}

export function ensureLegacyStoresMigratedOnce(workspaceDir, options = {}) {
  if (!workspaceDir || typeof workspaceDir !== 'string') return null
  const key = resolve(workspaceDir)
  if (key === '/' || !existsSync(key)) return null
  const resolvedGlobal =
    options.globalConfigDir !== undefined
      ? options.globalConfigDir
        ? resolve(options.globalConfigDir)
        : undefined
      : resolveSafeGlobalConfigDir(options.env ?? process.env)
  const globalKey = resolvedGlobal ? resolve(resolvedGlobal) : ''
  const cacheKey = `${key}::${globalKey}`
  if (migratedWorkspaces.has(cacheKey)) return null
  migratedWorkspaces.add(cacheKey)
  if (!options.dryRun && canSkipMigrationViaStamp(key, globalKey || undefined)) {
    return null
  }
  return migrateLegacyStoresAndPurgeStale(key, {
    ...options,
    ...(resolvedGlobal ? { globalConfigDir: resolvedGlobal } : {}),
  })
}

export function migrateLegacyStoresAndPurgeStale(workspaceDir, options = {}) {
  const root = resolve(workspaceDir)
  const dryRun = options.dryRun === true
  const skipMemoryMigration = options.skipMemoryMigration === true
  const nowIso = new Date().toISOString()

  let memoriesMigrated = 0
  let memoriesExpiredPurged = 0
  let vectorTablesDropped = 0
  let contextsMigrated = 0
  let goalsMigrated = 0
  const staleFilesDeleted = []

  if (root === '/' || !existsSync(root)) {
    return {
      memoriesMigrated,
      memoriesExpiredPurged,
      vectorTablesDropped,
      contextsMigrated,
      goalsMigrated,
      staleFilesDeleted,
    }
  }

  // Migrate and clean up global OpenCode config dir first (preserving its canonical .pantheon stores)
  let globalCanonicalMemDb = null
  if (options.globalConfigDir) {
    const globalRoot = resolve(options.globalConfigDir)
    if (globalRoot !== '/' && globalRoot !== root && existsSync(globalRoot)) {
      const globalReport = migrateLegacyStoresAndPurgeStale(globalRoot, {
        dryRun,
        isGlobalConfig: true,
        preserveWorkingPythonMcp: options.preserveWorkingPythonMcp,
        cleanCopiedInstallArtifacts: options.cleanCopiedInstallArtifacts,
      })
      memoriesMigrated += globalReport.memoriesMigrated
      memoriesExpiredPurged += globalReport.memoriesExpiredPurged
      vectorTablesDropped += globalReport.vectorTablesDropped
      contextsMigrated += globalReport.contextsMigrated
      goalsMigrated += globalReport.goalsMigrated
      staleFilesDeleted.push(...globalReport.staleFilesDeleted)
      globalCanonicalMemDb = join(globalRoot, '.pantheon', 'memory', 'memory.db')
    }
  }

  // Clean legacy Python/broken Pantheon MCPs and legacy plugins from opencode.json / opencode.jsonc / tui.json
  // BEFORE removing obsolete Python scripts or .venv so the host never spawns missing files.
  const configCleanup = inspectAndCleanLegacyConfigs(root, {
    dryRun,
    isGlobalConfig: options.isGlobalConfig === true,
    preserveWorkingPythonMcp: options.preserveWorkingPythonMcp,
    cleanCopiedInstallArtifacts: options.cleanCopiedInstallArtifacts,
  })
  for (const tag of configCleanup.cleanedConfigTags) {
    staleFilesDeleted.push(tag)
  }

  const pantheonDir = join(root, '.pantheon')
  const canonicalMemoryDir = join(pantheonDir, 'memory')
  const canonicalMemoryDbPath = join(canonicalMemoryDir, 'memory.db')
  const canonicalPersistenceDir = join(pantheonDir, 'persistence')
  const canonicalGoalsDir = join(pantheonDir, 'goals')

  // ── 1. Collect legacy memory SQLite DB candidates ────────────────────────
  const legacyMemoryCandidates = [
    { path: join(pantheonDir, 'memory.db'), deleteAfter: true },
    { path: join(root, 'memory', 'memory.db'), deleteAfter: true },
  ]
  if (globalCanonicalMemDb) {
    // Non-destructively inherit global canonical memories into the workspace store
    legacyMemoryCandidates.push({ path: globalCanonicalMemDb, deleteAfter: false })
  }

  const existingLegacyMemDbs = legacyMemoryCandidates.filter(
    (c) => existsSync(c.path) && !sameFileOrPath(c.path, canonicalMemoryDbPath),
  )

  if (
    !skipMemoryMigration &&
    (existingLegacyMemDbs.length > 0 || existsSync(canonicalMemoryDbPath))
  ) {
    if (!dryRun) {
      mkdirSync(canonicalMemoryDir, { recursive: true })
    }
    let targetDb = null
    let hadFtsBefore = false
    let droppedVecThisDb = 0
    try {
      if (!dryRun) {
        targetDb = new DatabaseSync(canonicalMemoryDbPath)
        targetDb.exec(`
          PRAGMA busy_timeout = 3000;
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            metadata TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            UNIQUE(namespace, key)
          );
          CREATE INDEX IF NOT EXISTS idx_memories_ns_key ON memories(namespace, key);
        `)
        try {
          hadFtsBefore = Boolean(
            targetDb
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts' LIMIT 1",
              )
              .get(),
          )
        } catch {
          hadFtsBefore = false
        }
      }

      for (const candidate of existingLegacyMemDbs) {
        let srcDb = null
        try {
          srcDb = new DatabaseSync(candidate.path, { readOnly: true })
          try {
            srcDb.exec('PRAGMA busy_timeout = 3000;')
          } catch {
            /* readOnly may ignore */
          }
          const hasTable = srcDb
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories' LIMIT 1",
            )
            .get()
          if (hasTable) {
            const cols = srcDb.prepare('PRAGMA table_info(memories)').all()
            const colNames = new Set(cols.map((c) => String(c.name ?? '')))
            const hasExpires = colNames.has('expires_at')
            const hasMeta = colNames.has('metadata')
            const hasCreated = colNames.has('created_at')

            const selectSql = `
              SELECT
                namespace,
                key,
                value,
                ${hasMeta ? 'metadata' : 'NULL AS metadata'},
                ${hasCreated ? 'created_at' : `'${nowIso}' AS created_at`},
                ${hasExpires ? 'expires_at' : 'NULL AS expires_at'}
              FROM memories
              WHERE key IS NOT NULL AND trim(key) != ''
            `
            const rows = srcDb.prepare(selectSql).all()

            if (!dryRun && targetDb && rows.length > 0) {
              const insertStmt = targetDb.prepare(
                `INSERT OR IGNORE INTO memories (namespace, key, value, metadata, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              targetDb.exec('BEGIN IMMEDIATE')
              try {
                for (const row of rows) {
                  const exp = typeof row.expires_at === 'string' ? row.expires_at : null
                  if (exp && exp <= nowIso) {
                    memoriesExpiredPurged += 1
                    continue
                  }
                  const ns = String(row.namespace ?? 'default').trim() || 'default'
                  const key = String(row.key ?? '').trim()
                  const val = String(row.value ?? '')
                  if (!key || !val) continue
                  const res = insertStmt.run(
                    ns,
                    key,
                    val,
                    typeof row.metadata === 'string' ? row.metadata : null,
                    typeof row.created_at === 'string' ? row.created_at : nowIso,
                    exp,
                  )
                  if (res.changes > 0) memoriesMigrated += 1
                }
                targetDb.exec('COMMIT')
              } catch (txErr) {
                try {
                  targetDb.exec('ROLLBACK')
                } catch {
                  /* ignore */
                }
                throw txErr
              }
            } else {
              for (const row of rows) {
                const exp = typeof row.expires_at === 'string' ? row.expires_at : null
                if (exp && exp <= nowIso) {
                  memoriesExpiredPurged += 1
                  continue
                }
                const key = String(row.key ?? '').trim()
                const val = String(row.value ?? '')
                if (!key || !val) continue
                memoriesMigrated += 1
              }
            }
          }
        } catch {
          /* corrupted legacy db — will still be cleaned up below */
        } finally {
          try {
            srcDb?.close()
          } catch {
            /* ignore */
          }
        }

        if (candidate.deleteAfter) {
          removeFileAndSqliteSidecars(candidate.path, staleFilesDeleted, dryRun)
          removeEmptyDirIfPossible(dirname(candidate.path), staleFilesDeleted, dryRun)
        }
      }

      // Clean up canonical memory.db: purge expired rows, drop legacy vector tables, rebuild FTS5 if needed
      if (!dryRun && targetDb) {
        try {
          const del = targetDb
            .prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?')
            .run(nowIso)
          memoriesExpiredPurged += Number(del.changes ?? 0)
        } catch {
          /* ignore */
        }

        const legacyVectorObjects = [
          { type: 'trigger', name: 'memories_vec_ai' },
          { type: 'trigger', name: 'memories_vec_ad' },
          { type: 'trigger', name: 'memories_vec_au' },
          { type: 'table', name: 'memories_vec' },
          { type: 'table', name: 'vec_memories' },
          { type: 'table', name: 'memory_embeddings' },
          { type: 'table', name: 'memory_vectors' },
        ]
        for (const obj of legacyVectorObjects) {
          try {
            const exists = targetDb
              .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1')
              .get(obj.type, obj.name)
            if (exists) {
              targetDb.exec(
                `DROP ${obj.type === 'trigger' ? 'TRIGGER' : 'TABLE'} IF EXISTS ${obj.name}`,
              )
              vectorTablesDropped += 1
              droppedVecThisDb += 1
            }
          } catch {
            /* virtual table extension may not be loaded; ignore */
          }
        }

        try {
          targetDb.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
              namespace,
              key,
              value,
              content='memories',
              content_rowid='id',
              tokenize='porter unicode61'
            );
            CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
              INSERT INTO memories_fts(rowid, namespace, key, value)
              VALUES (new.id, new.namespace, new.key, new.value);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
              INSERT INTO memories_fts(memories_fts, rowid, namespace, key, value)
              VALUES ('delete', old.id, old.namespace, old.key, old.value);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
              INSERT INTO memories_fts(memories_fts, rowid, namespace, key, value)
              VALUES ('delete', old.id, old.namespace, old.key, old.value);
              INSERT INTO memories_fts(rowid, namespace, key, value)
              VALUES (new.id, new.namespace, new.key, new.value);
            END;
          `)
          if (!hadFtsBefore || droppedVecThisDb > 0) {
            targetDb.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');")
          }
        } catch {
          /* FTS5 optional */
        }
      }
    } finally {
      try {
        targetDb?.close()
      } catch {
        /* ignore */
      }
    }
  }

  // ── 2. Migrate legacy Persistence SQLite DBs (global.db & project.db) ────
  const legacyPersistenceDbs = [
    join(pantheonDir, 'persistence', 'project.db'),
    join(pantheonDir, 'persistence', 'global.db'),
    join(root, 'persistence', 'project.db'),
    join(root, 'persistence', 'global.db'),
  ]
  if (options.globalConfigDir) {
    const globalRoot = resolve(options.globalConfigDir)
    if (globalRoot !== root) {
      legacyPersistenceDbs.push(
        join(globalRoot, 'persistence', 'global.db'),
        join(globalRoot, 'persistence', 'project.db'),
        join(globalRoot, '.pantheon', 'persistence', 'global.db'),
        join(globalRoot, '.pantheon', 'persistence', 'project.db'),
      )
    }
  }

  const seenPersistenceDbs = new Set()
  for (const dbPath of legacyPersistenceDbs) {
    if (!existsSync(dbPath)) continue
    const real = (() => {
      try {
        return realpathSync(dbPath)
      } catch {
        return resolve(dbPath)
      }
    })()
    if (seenPersistenceDbs.has(real)) continue
    seenPersistenceDbs.add(real)

    let pDb = null
    try {
      pDb = new DatabaseSync(dbPath, { readOnly: true })

      // 2a. Migrate kv_store rows (context_save / persistence checkpoints)
      const hasKvStore = pDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store' LIMIT 1")
        .get()
      if (hasKvStore) {
        const cols = pDb.prepare('PRAGMA table_info(kv_store)').all()
        const colNames = new Set(cols.map((c) => String(c.name ?? '')))
        const hasDeleted = colNames.has('deleted_at')
        const hasExpires = colNames.has('expires_at')
        const hasUpdated = colNames.has('updated_at')
        const hasCreated = colNames.has('created_at')
        const hasRevision = colNames.has('revision')

        const rows = pDb
          .prepare(
            `SELECT
               namespace,
               key,
               value,
               ${hasExpires ? 'expires_at' : 'NULL AS expires_at'},
               ${hasDeleted ? 'deleted_at' : 'NULL AS deleted_at'},
               ${hasCreated ? 'created_at' : `'${nowIso}' AS created_at`},
               ${hasUpdated ? 'updated_at' : `'${nowIso}' AS updated_at`},
               ${hasRevision ? 'revision' : 'NULL AS revision'}
             FROM kv_store`,
          )
          .all()

        for (const row of rows) {
          if (row.deleted_at != null) continue
          const exp = typeof row.expires_at === 'string' ? row.expires_at : null
          if (exp && exp <= nowIso) continue

          const rawNs = String(row.namespace ?? 'checkpoints').trim() || 'checkpoints'
          const safeNs = toSafeSegment(rawNs, 'checkpoints')
          const safeKey = toSafeSegment(row.key, '')
          if (!safeKey) continue

          const valueStr = String(row.value ?? '')
          const record = {
            session_id: safeKey,
            key: safeKey,
            namespace: safeNs,
            content: valueStr,
            value: valueStr,
            created_at: typeof row.created_at === 'string' ? row.created_at : nowIso,
            updated_at: typeof row.updated_at === 'string' ? row.updated_at : nowIso,
            ...(exp ? { expires_at: exp } : {}),
            ...(typeof row.revision === 'number' ? { revision: row.revision } : {}),
          }

          const targetNamespaces = safeNs === 'context' ? ['context', 'checkpoints'] : [safeNs]
          let wroteAny = false
          for (const targetNs of targetNamespaces) {
            const nsDir = join(canonicalPersistenceDir, targetNs)
            const outFile = join(nsDir, `${safeKey}.json`)
            if (!existsSync(outFile)) {
              if (!dryRun) {
                mkdirSync(nsDir, { recursive: true })
                writeFileSync(
                  outFile,
                  JSON.stringify({ ...record, namespace: targetNs }, null, 2),
                  'utf8',
                )
              }
              wroteAny = true
            }
          }
          if (wroteAny) contextsMigrated += 1
        }
      }

      // 2b. Migrate pantheon_goals rows from project.db
      const hasGoals = pDb
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pantheon_goals' LIMIT 1",
        )
        .get()
      if (hasGoals) {
        const goalRows = pDb.prepare('SELECT * FROM pantheon_goals').all()
        for (const row of goalRows) {
          const rawId = String(row.goal_id ?? row.id ?? '').trim()
          const safeId = toSafeSegment(rawId, '')
          if (!safeId) continue
          const outFile = join(canonicalGoalsDir, `${safeId}.json`)
          if (!existsSync(outFile)) {
            let criteria = []
            if (typeof row.criteria_json === 'string') {
              try {
                const parsed = JSON.parse(row.criteria_json)
                if (Array.isArray(parsed)) criteria = parsed.map(String)
              } catch {
                /* ignore */
              }
            }
            let notes
            if (typeof row.notes_json === 'string') {
              try {
                notes = JSON.parse(row.notes_json)
              } catch {
                notes = row.notes_json
              }
            }
            const goalRecord = {
              id: safeId,
              ...(typeof row.session_id === 'string' ? { session_id: row.session_id } : {}),
              title: String(row.title ?? ''),
              criteria,
              status: String(row.status ?? 'active'),
              ...(notes !== undefined ? { notes } : {}),
              created_at: typeof row.created_at === 'string' ? row.created_at : nowIso,
              updated_at: typeof row.updated_at === 'string' ? row.updated_at : nowIso,
              ...(typeof row.completed_at === 'string' ? { completed_at: row.completed_at } : {}),
            }
            if (!dryRun) {
              mkdirSync(canonicalGoalsDir, { recursive: true })
              writeFileSync(outFile, JSON.stringify(goalRecord, null, 2), 'utf8')
            }
            goalsMigrated += 1
          }
        }
      }
    } catch {
      /* unreadable legacy SQLite persistence db — remove below */
    } finally {
      try {
        pDb?.close()
      } catch {
        /* ignore */
      }
    }

    removeFileAndSqliteSidecars(dbPath, staleFilesDeleted, dryRun)
    const parentDir = dirname(dbPath)
    if (parentDir !== canonicalPersistenceDir) {
      removeEmptyDirIfPossible(parentDir, staleFilesDeleted, dryRun)
    }
  }

  // ── 3. Migrate legacy flat checkpoint/context directories & goals.json ───
  for (const legacyCheckpointDir of [
    join(pantheonDir, 'checkpoints'),
    join(pantheonDir, 'context'),
  ]) {
    if (!existsSync(legacyCheckpointDir)) continue
    try {
      for (const entry of readdirSync(legacyCheckpointDir)) {
        const fullPath = join(legacyCheckpointDir, entry)
        if (!entry.endsWith('.json') || !statSync(fullPath).isFile()) continue
        const rawKey = entry.slice(0, -5)
        const safeKey = toSafeSegment(rawKey, '')
        if (!safeKey) continue
        const targetDir = join(canonicalPersistenceDir, 'checkpoints')
        const targetFile = join(targetDir, `${safeKey}.json`)
        if (!existsSync(targetFile)) {
          try {
            const parsed = JSON.parse(readFileSync(fullPath, 'utf8'))
            const normalized = {
              session_id: safeKey,
              namespace: 'checkpoints',
              content:
                typeof parsed.content === 'string'
                  ? parsed.content
                  : JSON.stringify(parsed.content ?? parsed),
              updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : nowIso,
            }
            if (!dryRun) {
              mkdirSync(targetDir, { recursive: true })
              writeFileSync(targetFile, JSON.stringify(normalized, null, 2), 'utf8')
            }
            contextsMigrated += 1
          } catch {
            /* corrupted checkpoint file */
          }
        }
        if (!dryRun) rmSync(fullPath, { force: true })
        staleFilesDeleted.push(fullPath)
      }
      removeEmptyDirIfPossible(legacyCheckpointDir, staleFilesDeleted, dryRun)
    } catch {
      /* ignore */
    }
  }

  // Migrate .pantheon/persistence/goals/*.json -> .pantheon/goals/*.json
  const legacyPersistenceGoalsDir = join(canonicalPersistenceDir, 'goals')
  if (existsSync(legacyPersistenceGoalsDir)) {
    try {
      for (const entry of readdirSync(legacyPersistenceGoalsDir)) {
        const fullPath = join(legacyPersistenceGoalsDir, entry)
        if (!entry.endsWith('.json') || !statSync(fullPath).isFile()) continue
        const safeId = toSafeSegment(entry.slice(0, -5), '')
        if (safeId) {
          const targetFile = join(canonicalGoalsDir, `${safeId}.json`)
          if (!existsSync(targetFile)) {
            if (!dryRun) {
              mkdirSync(canonicalGoalsDir, { recursive: true })
              writeFileSync(targetFile, readFileSync(fullPath, 'utf8'), 'utf8')
            }
            goalsMigrated += 1
          }
        }
        if (!dryRun) rmSync(fullPath, { force: true })
        staleFilesDeleted.push(fullPath)
      }
      removeEmptyDirIfPossible(legacyPersistenceGoalsDir, staleFilesDeleted, dryRun)
    } catch {
      /* ignore */
    }
  }

  // Migrate legacy .pantheon/goals.json file -> .pantheon/goals/<id>.json
  const legacyGoalsJsonPath = join(pantheonDir, 'goals.json')
  if (existsSync(legacyGoalsJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(legacyGoalsJsonPath, 'utf8'))
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray(parsed.goals)
          ? (parsed.goals ?? [])
          : []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const safeId = toSafeSegment(item.id ?? item.goal_id, '')
        if (!safeId) continue
        const targetFile = join(canonicalGoalsDir, `${safeId}.json`)
        if (!existsSync(targetFile)) {
          if (!dryRun) {
            mkdirSync(canonicalGoalsDir, { recursive: true })
            writeFileSync(
              targetFile,
              JSON.stringify(
                {
                  id: safeId,
                  title: String(item.title ?? item.description ?? ''),
                  criteria: Array.isArray(item.criteria) ? item.criteria.map(String) : [],
                  status: String(item.status ?? 'active'),
                  created_at: typeof item.created_at === 'string' ? item.created_at : nowIso,
                  updated_at: typeof item.updated_at === 'string' ? item.updated_at : nowIso,
                },
                null,
                2,
              ),
              'utf8',
            )
          }
          goalsMigrated += 1
        }
      }
    } catch {
      /* ignore corrupted goals.json */
    }
    if (!dryRun) rmSync(legacyGoalsJsonPath, { force: true })
    staleFilesDeleted.push(legacyGoalsJsonPath)
  }

  // ── 4. Purge expired persistence JSON files & stale artifacts ────────────
  if (existsSync(canonicalPersistenceDir)) {
    try {
      for (const nsEntry of readdirSync(canonicalPersistenceDir, { withFileTypes: true })) {
        if (!nsEntry.isDirectory()) continue
        const nsDir = join(canonicalPersistenceDir, nsEntry.name)
        for (const fileEntry of readdirSync(nsDir)) {
          if (!fileEntry.endsWith('.json')) continue
          const filePath = join(nsDir, fileEntry)
          try {
            const data = JSON.parse(readFileSync(filePath, 'utf8'))
            if (typeof data.expires_at === 'string' && data.expires_at <= nowIso) {
              if (!dryRun) rmSync(filePath, { force: true })
              staleFilesDeleted.push(filePath)
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  const obsoleteTargets = [
    join(canonicalMemoryDir, '.memory.db.init.lock'),
    join(pantheonDir, '.memory.db.init.lock'),
    join(canonicalPersistenceDir, '.global.db.init.lock'),
    join(canonicalPersistenceDir, '.project.db.init.lock'),
    join(pantheonDir, 'fastembed_cache'),
    join(pantheonDir, '.fastembed'),
    join(root, 'fastembed_cache'),
    join(root, 'plugins', 'pantheon-hooks.ts'),
    join(root, 'plugins', 'pantheon-hooks.js'),
    join(root, 'plugins', 'pantheon-hooks.mjs'),
    join(root, '.opencode', 'plugins', 'pantheon-hooks.ts'),
    join(root, '.opencode', 'plugins', 'pantheon-hooks.js'),
    join(root, '.opencode', 'plugins', 'pantheon-hooks.mjs'),
    join(root, 'tiers.json'),
    join(root, '.opencode', 'tiers.json'),
  ]
  for (const target of obsoleteTargets) {
    if (existsSync(target)) {
      if (!dryRun) rmSync(target, { recursive: true, force: true })
      staleFilesDeleted.push(target)
    }
  }

  // Purge obsolete Python MCP scripts, requirements-vision.txt, and OpenCode config .venv
  // when no active Python MCP configuration requires them, plus copied pantheon-tui when
  // the native npm plugin (pantheon-opencode) is active.
  if (!configCleanup.hasWorkingPythonMcp) {
    for (const { dir, isConfigScope } of configCleanup.configDirs) {
      if (!isConfigScope) continue
      const scriptsDir = join(dir, 'scripts')
      const hadPantheonPy =
        existsSync(scriptsDir) &&
        LEGACY_PYTHON_RUNTIME_SCRIPTS.some((name) => existsSync(join(scriptsDir, name)))
      const hadRequirementsVision = existsSync(join(dir, 'requirements-vision.txt'))
      const hadRemovedPythonMcps = configCleanup.cleanedConfigTags.some((tag) =>
        tag.includes('#legacy-mcp:'),
      )

      if (existsSync(scriptsDir)) {
        for (const name of LEGACY_PYTHON_RUNTIME_SCRIPTS) {
          const pyPath = join(scriptsDir, name)
          if (existsSync(pyPath)) {
            if (!dryRun) rmSync(pyPath, { force: true })
            staleFilesDeleted.push(pyPath)
          }
        }
        const pycacheDir = join(scriptsDir, '__pycache__')
        if (existsSync(pycacheDir) && hadPantheonPy) {
          if (!dryRun) rmSync(pycacheDir, { recursive: true, force: true })
          staleFilesDeleted.push(pycacheDir)
        }
        removeEmptyDirIfPossible(scriptsDir, staleFilesDeleted, dryRun)
      }

      const reqVisionPath = join(dir, 'requirements-vision.txt')
      if (existsSync(reqVisionPath)) {
        if (!dryRun) rmSync(reqVisionPath, { force: true })
        staleFilesDeleted.push(reqVisionPath)
      }

      const configVenvPath = join(dir, '.venv')
      if (
        existsSync(configVenvPath) &&
        (hadPantheonPy || hadRequirementsVision || hadRemovedPythonMcps)
      ) {
        if (!dryRun) rmSync(configVenvPath, { recursive: true, force: true })
        staleFilesDeleted.push(configVenvPath)
      }
    }
  }

  if (configCleanup.hasNpmNativePlugin || options.cleanCopiedInstallArtifacts === true) {
    for (const { dir, isConfigScope } of configCleanup.configDirs) {
      if (!isConfigScope) continue

      const copiedTui = join(dir, 'plugins', 'pantheon-tui')
      if (existsSync(copiedTui) && !lstatSync(copiedTui).isSymbolicLink()) {
        if (!dryRun) rmSync(copiedTui, { recursive: true, force: true })
        staleFilesDeleted.push(copiedTui)
      }

      const isPantheonMarkdown = (filePath) => {
        try {
          if (lstatSync(filePath).isSymbolicLink()) return false
          const content = readFileSync(filePath, 'utf8')
          return /(?:pantheon|mcp_tools|tier\s*:|orchestrat|description\s*:)/i.test(content)
        } catch {
          return false
        }
      }

      for (const agentFile of CANONICAL_AGENT_MD_FILES) {
        for (const sub of ['agents', 'agent', 'prompts']) {
          const candidate = join(dir, sub, agentFile)
          if (existsSync(candidate) && isPantheonMarkdown(candidate)) {
            if (!dryRun) rmSync(candidate, { force: true })
            staleFilesDeleted.push(candidate)
          }
        }
      }

      for (const cmdFile of CANONICAL_COMMAND_MD_FILES) {
        for (const sub of ['commands', 'command']) {
          const candidate = join(dir, sub, cmdFile)
          if (existsSync(candidate) && isPantheonMarkdown(candidate)) {
            if (!dryRun) rmSync(candidate, { force: true })
            staleFilesDeleted.push(candidate)
          }
        }
      }

      for (const instr of LEGACY_INSTRUCTION_FILES) {
        const candidate = join(dir, 'instructions', instr)
        if (existsSync(candidate)) {
          if (!dryRun) rmSync(candidate, { force: true })
          staleFilesDeleted.push(candidate)
        }
      }

      for (const skillId of CANONICAL_SKILL_IDS) {
        const skillDir = join(dir, 'skills', skillId)
        if (
          existsSync(skillDir) &&
          !lstatSync(skillDir).isSymbolicLink() &&
          existsSync(join(skillDir, 'SKILL.md'))
        ) {
          if (!dryRun) rmSync(skillDir, { recursive: true, force: true })
          staleFilesDeleted.push(skillDir)
        }
      }

      const routingCandidate = join(dir, 'routing.yml')
      if (existsSync(routingCandidate)) {
        try {
          const routingContent = readFileSync(routingCandidate, 'utf8')
          if (/pantheon|zeus:|athena:|apollo:/i.test(routingContent)) {
            if (!dryRun) rmSync(routingCandidate, { force: true })
            staleFilesDeleted.push(routingCandidate)
          }
        } catch {
          /* ignore */
        }
      }

      const rootIsRepoSource = isRepoSourceRoot(root)
      if (!configCleanup.hasWorkingPythonMcp) {
        const codeModeDirs = [join(dir, '.pantheon', 'code-mode')]
        if (!rootIsRepoSource && join(root, '.pantheon', 'code-mode') !== codeModeDirs[0]) {
          codeModeDirs.push(join(root, '.pantheon', 'code-mode'))
        }
        for (const cmDir of codeModeDirs) {
          if (!existsSync(cmDir) || lstatSync(cmDir).isSymbolicLink()) continue
          try {
            for (const entry of readdirSync(cmDir)) {
              if (entry.endsWith('.py') || entry.endsWith('.sh') || entry === 'manifest.json') {
                const target = join(cmDir, entry)
                if (!dryRun) rmSync(target, { force: true })
                staleFilesDeleted.push(target)
              }
            }
            removeEmptyDirIfPossible(cmDir, staleFilesDeleted, dryRun)
          } catch {
            /* ignore */
          }
        }
      }

      const installStatePaths = [join(dir, '.pantheon', 'install-state.json')]
      if (!rootIsRepoSource) {
        installStatePaths.push(join(root, '.pantheon', 'install-state.json'))
      }
      for (const statePath of installStatePaths) {
        if (existsSync(statePath)) {
          if (!dryRun) rmSync(statePath, { force: true })
          staleFilesDeleted.push(statePath)
        }
      }

      for (const emptySub of [
        'agents',
        'agent',
        'commands',
        'command',
        'prompts',
        'skills',
        'instructions',
        'plugins',
      ]) {
        removeEmptyDirIfPossible(join(dir, emptySub), staleFilesDeleted, dryRun)
      }
    }
  }

  // Purge stale opencode.json.bak* sidecars older than 30 days in config roots
  const backupCutoffMs = Date.now() - 30 * 86_400_000
  for (const cfgDir of [root, join(root, '.opencode')]) {
    if (!existsSync(cfgDir)) continue
    try {
      for (const name of readdirSync(cfgDir)) {
        if (!name.startsWith('opencode.json.bak')) continue
        const full = join(cfgDir, name)
        try {
          const st = statSync(full)
          if (st.mtimeMs < backupCutoffMs) {
            if (!dryRun) rmSync(full, { recursive: true, force: true })
            staleFilesDeleted.push(full)
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Purge abandoned migration checkpoints older than 24 hours
  const migrationCp = join(pantheonDir, '.migration-checkpoint')
  if (existsSync(migrationCp)) {
    try {
      const st = statSync(migrationCp)
      if (st.mtimeMs < Date.now() - 86_400_000) {
        if (!dryRun) rmSync(migrationCp, { force: true })
        staleFilesDeleted.push(migrationCp)
      }
    } catch {
      /* ignore */
    }
  }

  if (!dryRun && existsSync(pantheonDir)) {
    try {
      const globalMtimeMs = globalCanonicalMemDb ? safeMtimeMs(globalCanonicalMemDb) : 0
      writeFileSync(
        join(pantheonDir, '.migration-v2.json'),
        `${JSON.stringify({ version: 2, globalMtimeMs, migratedAt: nowIso }, null, 2)}\n`,
        'utf8',
      )
    } catch {
      /* fail-open */
    }
  }

  return {
    memoriesMigrated,
    memoriesExpiredPurged,
    vectorTablesDropped,
    contextsMigrated,
    goalsMigrated,
    staleFilesDeleted,
  }
}

const CANONICAL_AGENT_MD_FILES = Object.freeze([
  'aphrodite.md',
  'apollo.md',
  'artemis.md',
  'athena.md',
  'demeter.md',
  'gaia.md',
  'hephaestus.md',
  'hermes.md',
  'iris.md',
  'mnemosyne.md',
  'nyx.md',
  'prometheus.md',
  'talos.md',
  'themis.md',
  'zeus.md',
])

const CANONICAL_COMMAND_MD_FILES = Object.freeze([
  'pantheon.md',
  'pantheon-audit.md',
  'pantheon-consolidate.md',
  'pantheon-deepwork.md',
  'pantheon-focus.md',
  'pantheon-forge.md',
  'pantheon-model.md',
  'pantheon-optimize.md',
  'pantheon-settings.md',
  'pantheon-vision.md',
])

const CANONICAL_SKILL_IDS = Object.freeze([
  'agent-coordination',
  'agent-forge',
  'artifact-management',
  'auto-continue',
  'clonedeps',
  'code-review-checklist',
  'codemap',
  'context-compression',
  'fast-path-execution',
  'git-workflow-and-versioning',
  'incremental-implementation',
  'instruction-forge',
  'loop-engineering',
  'memory-bank',
  'prompt-refinery',
  'reflect',
  'security-hardening',
  'session-goal',
  'simplify',
  'spec-driven-development',
  'tdd-with-agents',
  'test-slicing',
  'verification-planning',
  'visual-review-pipeline',
  'worktrees',
])

const LEGACY_INSTRUCTION_FILES = Object.freeze([
  'zeus-execution-rules.instructions.md',
  'zeus-orchestration.instructions.md',
  'zeus-workflow.instructions.md',
])

function measurePathBytes(targetPath, depth = 0) {
  if (depth > 8) return 0
  try {
    const st = statSync(targetPath)
    if (st.isFile()) return st.size
    if (!st.isDirectory()) return 0
    let total = 0
    for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
      total += measurePathBytes(join(targetPath, entry.name), depth + 1)
    }
    return total
  } catch {
    return 0
  }
}

function isConfinedWithin(rootDir, targetPath) {
  try {
    const realRoot = realpathSync(rootDir)
    const parentReal = realpathSync(dirname(targetPath))
    return parentReal === realRoot || parentReal.startsWith(`${realRoot}/`)
  } catch {
    return false
  }
}

export function cleanLegacyOpenCodeConfigs(root, options = {}) {
  return inspectAndCleanLegacyConfigs(resolve(root), options)
}

function collectScopeArtifacts(scope, baseRoot, configRoot, options = {}) {
  const items = []
  const seen = new Set()
  const addItem = (filePath, category, reason) => {
    const resolved = resolve(filePath)
    if (seen.has(resolved) || !existsSync(resolved)) return
    seen.add(resolved)
    items.push({
      path: resolved,
      scope,
      category,
      reason,
      bytes: measurePathBytes(resolved),
    })
  }
  const addVirtualItem = (tagPath, category, reason) => {
    if (seen.has(tagPath)) return
    seen.add(tagPath)
    items.push({
      path: tagPath,
      scope,
      category,
      reason,
      bytes: 0,
    })
  }

  // 1. Dead V1 hooks & backup sidecars (most specific categories first)
  for (const hookName of ['pantheon-hooks.ts', 'pantheon-hooks.js', 'pantheon-hooks.mjs']) {
    addItem(join(configRoot, 'plugins', hookName), 'hooks', 'Obsolete OpenCode V1 hook plugin')
  }
  addItem(join(configRoot, 'tiers.json'), 'v1Obsolete', 'Obsolete V1 model tiers registry')
  addItem(join(baseRoot, 'tiers.json'), 'v1Obsolete', 'Obsolete V1 model tiers registry')

  for (const bakDir of [configRoot, join(baseRoot, '.pantheon')]) {
    if (!existsSync(bakDir)) continue
    try {
      for (const name of readdirSync(bakDir)) {
        if (name.startsWith('opencode.json.bak') || name.startsWith('active-preset.json.bak')) {
          addItem(join(bakDir, name), 'backup', 'Old configuration backup sidecar')
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Dry-run migration findings (unmigrated DBs, legacy MCPs/plugins, Python runtime, stale caches/locks)
  const dryMigration = migrateLegacyStoresAndPurgeStale(baseRoot, {
    dryRun: true,
    isGlobalConfig: scope === 'global',
  })
  for (const stale of dryMigration.staleFilesDeleted) {
    if (stale.includes('#legacy-mcp:')) {
      const serverName = stale.split('#legacy-mcp:')[1] || 'pantheon'
      addVirtualItem(stale, 'v1Obsolete', `Legacy or broken MCP entry (${serverName})`)
    } else if (stale.endsWith('#legacy-plugin')) {
      addVirtualItem(stale, 'hooks', 'Legacy or broken Pantheon plugin entry in config')
    } else if (
      stale.endsWith('.venv') ||
      stale.endsWith('requirements-vision.txt') ||
      stale.endsWith('.py') ||
      stale.endsWith('__pycache__')
    ) {
      addItem(stale, 'v1Obsolete', 'Obsolete legacy Python MCP runtime artifact')
    } else {
      addItem(stale, 'legacyStore', 'Obsolete or migrated legacy store artifact')
    }
  }

  // 3. Redundant copied Pantheon assets that native plugin transforms provide in-memory
  if (options.includeRedundantCopiedAssets !== false) {
    for (const agentFile of CANONICAL_AGENT_MD_FILES) {
      addItem(
        join(configRoot, 'agents', agentFile),
        'redundantAsset',
        'Canonical Pantheon agent copy shadowed by native plugin transform',
      )
      addItem(
        join(configRoot, 'agent', agentFile),
        'redundantAsset',
        'Legacy singular agent directory copy shadowed by native plugin transform',
      )
      addItem(
        join(configRoot, 'prompts', agentFile),
        'redundantAsset',
        'Legacy prompt template copy provided in package',
      )
    }

    for (const cmdFile of CANONICAL_COMMAND_MD_FILES) {
      addItem(
        join(configRoot, 'commands', cmdFile),
        'redundantAsset',
        'Canonical Pantheon command copy shadowed by native plugin transform',
      )
      addItem(
        join(configRoot, 'command', cmdFile),
        'redundantAsset',
        'Legacy singular command directory copy',
      )
    }

    for (const instr of LEGACY_INSTRUCTION_FILES) {
      addItem(
        join(configRoot, 'instructions', instr),
        'redundantAsset',
        'Legacy instruction file superseded by AGENTS.global.md reference transform',
      )
    }

    for (const skillId of CANONICAL_SKILL_IDS) {
      addItem(
        join(configRoot, 'skills', skillId),
        'redundantAsset',
        'Bundled Pantheon skill directory provided natively by plugin',
      )
    }

    const tuiCopyDir = join(configRoot, 'plugins', 'pantheon-tui')
    if (existsSync(tuiCopyDir)) {
      let copiedVersion = ''
      try {
        copiedVersion = String(
          JSON.parse(readFileSync(join(tuiCopyDir, 'package.json'), 'utf8')).version ?? '',
        )
      } catch {
        copiedVersion = ''
      }
      const runningVersion = options.runningVersion ? String(options.runningVersion) : ''
      const drifted = Boolean(runningVersion && copiedVersion && copiedVersion !== runningVersion)
      addItem(
        tuiCopyDir,
        drifted ? 'drift' : 'redundantAsset',
        drifted
          ? `Copied TUI plugin v${copiedVersion} drifts from v${runningVersion}`
          : 'Copied TUI directory superseded by npm package export',
      )
    }
  }

  return { items, dryMigration }
}

export function scanLegacyArtifacts(options = {}) {
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir = options.globalConfigDir
    ? resolve(options.globalConfigDir)
    : resolveSafeGlobalConfigDir()

  const items = []
  let unmigratedStores = 0

  if (globalConfigDir && existsSync(globalConfigDir) && globalConfigDir !== '/') {
    const res = collectScopeArtifacts('global', globalConfigDir, globalConfigDir, options)
    items.push(...res.items)
    unmigratedStores +=
      res.dryMigration.memoriesMigrated +
      res.dryMigration.contextsMigrated +
      res.dryMigration.goalsMigrated +
      res.dryMigration.vectorTablesDropped
  }

  if (
    workspaceDir &&
    existsSync(workspaceDir) &&
    workspaceDir !== '/' &&
    (!globalConfigDir || !sameFileOrPath(workspaceDir, globalConfigDir))
  ) {
    const res = collectScopeArtifacts(
      'project',
      workspaceDir,
      join(workspaceDir, '.opencode'),
      options,
    )
    items.push(...res.items)
    unmigratedStores +=
      res.dryMigration.memoriesMigrated +
      res.dryMigration.contextsMigrated +
      res.dryMigration.goalsMigrated +
      res.dryMigration.vectorTablesDropped
  }

  const byScope = { global: 0, project: 0 }
  const byCategory = {}
  let totalBytes = 0
  for (const item of items) {
    byScope[item.scope] = (byScope[item.scope] ?? 0) + 1
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1
    totalBytes += item.bytes
  }

  return {
    items,
    summary: {
      total: items.length,
      totalBytes,
      unmigratedStores,
      byScope,
      byCategory,
    },
  }
}

export function cleanLegacyArtifacts(options = {}) {
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir = options.globalConfigDir
    ? resolve(options.globalConfigDir)
    : resolveSafeGlobalConfigDir()

  const preScan = scanLegacyArtifacts(options)
  const categoryFilter = Array.isArray(options.categories) ? new Set(options.categories) : null
  const scopeFilter = options.scope && options.scope !== 'all' ? options.scope : null
  const bytesByPath = new Map(preScan.items.map((item) => [item.path, item.bytes]))

  // Always run data migration BEFORE removing any legacy/obsolete files.
  let migrated = null
  if (
    scopeFilter !== 'global' &&
    workspaceDir &&
    existsSync(workspaceDir) &&
    workspaceDir !== '/'
  ) {
    migrated = migrateLegacyStoresAndPurgeStale(
      workspaceDir,
      scopeFilter !== 'project' && globalConfigDir ? { globalConfigDir } : {},
    )
  } else if (
    scopeFilter !== 'project' &&
    globalConfigDir &&
    existsSync(globalConfigDir) &&
    globalConfigDir !== '/'
  ) {
    migrated = migrateLegacyStoresAndPurgeStale(globalConfigDir, { isGlobalConfig: true })
  }

  const removedSet = new Set()
  const errors = []
  let reclaimedBytes = 0

  for (const purgedPath of migrated?.staleFilesDeleted ?? []) {
    if (purgedPath.includes('#legacy-')) {
      removedSet.add(purgedPath)
      continue
    }
    const resolved = resolve(purgedPath)
    if (!existsSync(resolved) && !removedSet.has(resolved)) {
      removedSet.add(resolved)
      reclaimedBytes += bytesByPath.get(resolved) ?? 0
    }
  }

  for (const item of preScan.items) {
    if (categoryFilter && !categoryFilter.has(item.category)) continue
    if (scopeFilter && item.scope !== scopeFilter) continue
    if (item.path.includes('#legacy-')) {
      removedSet.add(item.path)
      continue
    }
    const scopeRoot = item.scope === 'global' ? globalConfigDir : workspaceDir
    if (!scopeRoot || !isConfinedWithin(scopeRoot, item.path)) {
      errors.push({ path: item.path, reason: 'Path escapes target scope root' })
      continue
    }
    try {
      if (existsSync(item.path)) {
        rmSync(item.path, { recursive: true, force: true })
        if (!removedSet.has(item.path)) {
          removedSet.add(item.path)
          reclaimedBytes += item.bytes
        }
      }
    } catch (err) {
      errors.push({
        path: item.path,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    removed: [...removedSet],
    reclaimedBytes,
    errors,
    migrated,
  }
}

/**
 * Safely purge all Pantheon-managed stores, copied files, and config entries
 * across global and/or workspace scopes (replaces legacy `uninstall --purge-data`).
 */
export function purgeAllPantheonData(options = {}) {
  const dryRun = options.dryRun === true
  const scope = options.scope ?? 'all'
  const includeDecisionRouter = options.includeDecisionRouter === true
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir =
    options.globalConfigDir !== undefined
      ? options.globalConfigDir
        ? resolve(options.globalConfigDir)
        : undefined
      : resolveSafeGlobalConfigDir(options.env ?? process.env)

  const removed = []
  const errors = []
  let reclaimedBytes = 0

  const purgeConfigRoot = (rootDir, isGlobal) => {
    if (!rootDir || rootDir === '/' || !existsSync(rootDir) || isRepoSourceRoot(rootDir)) return
    const cfgCleanup = inspectAndCleanLegacyConfigs(rootDir, {
      dryRun,
      isGlobalConfig: isGlobal,
      preserveWorkingPythonMcp: false,
      cleanCopiedInstallArtifacts: true,
    })
    for (const tag of cfgCleanup.cleanedConfigTags) removed.push(tag)

    const legRes = migrateLegacyStoresAndPurgeStale(rootDir, {
      dryRun,
      isGlobalConfig: isGlobal,
      preserveWorkingPythonMcp: false,
      cleanCopiedInstallArtifacts: true,
      skipMemoryMigration: true,
    })
    for (const item of legRes.staleFilesDeleted) removed.push(item)

    const pantheonStore = join(rootDir, '.pantheon')
    if (existsSync(pantheonStore) && isConfinedWithin(rootDir, pantheonStore)) {
      const bytes = measurePathBytes(pantheonStore)
      try {
        if (!dryRun) rmSync(pantheonStore, { recursive: true, force: true })
        removed.push(pantheonStore)
        reclaimedBytes += bytes
      } catch (err) {
        errors.push({
          path: pantheonStore,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (!isGlobal) {
      const opencodeDir = join(rootDir, '.opencode')
      if (existsSync(opencodeDir)) {
        const nestedStore = join(opencodeDir, '.pantheon')
        if (existsSync(nestedStore) && isConfinedWithin(rootDir, nestedStore)) {
          const bytes = measurePathBytes(nestedStore)
          try {
            if (!dryRun) rmSync(nestedStore, { recursive: true, force: true })
            removed.push(nestedStore)
            reclaimedBytes += bytes
          } catch (err) {
            errors.push({
              path: nestedStore,
              reason: err instanceof Error ? err.message : String(err),
            })
          }
        }
        try {
          if (readdirSync(opencodeDir).length === 0) {
            if (!dryRun) rmSync(opencodeDir, { recursive: true, force: true })
            removed.push(opencodeDir)
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (scope !== 'project' && globalConfigDir) {
    purgeConfigRoot(globalConfigDir, true)
  }
  if (
    scope !== 'global' &&
    workspaceDir &&
    (!globalConfigDir || !sameFileOrPath(workspaceDir, globalConfigDir))
  ) {
    purgeConfigRoot(workspaceDir, false)
  }

  if (includeDecisionRouter) {
    const xdg =
      options.env?.XDG_CONFIG_HOME?.trim() ||
      process.env.XDG_CONFIG_HOME?.trim() ||
      join(options.env?.HOME ?? process.env.HOME ?? homedir(), '.config')
    const decisionDir = join(resolve(xdg), 'pantheon')
    if (existsSync(decisionDir) && !lstatSync(decisionDir).isSymbolicLink()) {
      const bytes = measurePathBytes(decisionDir)
      try {
        if (!dryRun) rmSync(decisionDir, { recursive: true, force: true })
        removed.push(decisionDir)
        reclaimedBytes += bytes
      } catch (err) {
        errors.push({ path: decisionDir, reason: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return { removed: [...new Set(removed)], reclaimedBytes, errors }
}
