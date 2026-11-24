/**
 * legacy-audit.ts — Self-contained Legacy & Drift Auditor for the TUI Settings panel.
 *
 * Scans global (~/.config/opencode) and workspace (<project>) scopes for:
 *   - Dead V1 hooks/files (pantheon-hooks.*, tiers.json, fastembed_cache, .migration-checkpoint)
 *   - Unmigrated legacy stores (memory.db, persistence/{global,project}.db, goals.json)
 *   - Redundant copied canonical Pantheon assets shadowed by native plugin transforms
 *   - Drifted copied TUI plugins (plugins/pantheon-tui version != running plugin version)
 *   - Old configuration backup sidecars (opencode.json.bak*, active-preset.json.bak*)
 *
 * Always migrates unmigrated legacy context/memory/goals BEFORE deleting obsolete stores,
 * and NEVER touches user-created custom agents or custom user skills.
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

export type LegacyScope = 'global' | 'project'
export type LegacyCategory =
  | 'legacyStore'
  | 'hooks'
  | 'v1Obsolete'
  | 'backup'
  | 'redundantAsset'
  | 'drift'

export interface LegacyAuditItem {
  readonly path: string
  readonly scope: LegacyScope
  readonly category: LegacyCategory
  readonly reason: string
  readonly bytes: number
}

export interface LegacyAuditSummary {
  readonly total: number
  readonly totalBytes: number
  readonly unmigratedStores: number
  readonly byScope: Record<LegacyScope, number>
  readonly byCategory: Record<string, number>
}

export interface LegacyAuditScan {
  readonly items: LegacyAuditItem[]
  readonly summary: LegacyAuditSummary
}

export interface LegacyCleanResult {
  readonly removed: string[]
  readonly reclaimedBytes: number
  readonly migratedRecords: number
  readonly errors: Array<{ readonly path: string; readonly reason: string }>
}

export interface LegacyAuditOptions {
  readonly workspaceDir?: string
  readonly globalConfigDir?: string
  readonly cacheDir?: string
  readonly runningVersion?: string
  readonly activeBundlePath?: string
  readonly includeRedundantCopiedAssets?: boolean
  readonly env?: Record<string, string | undefined>
}

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._:-]{1,128}$/

const CANONICAL_AGENT_MD_FILES: readonly string[] = Object.freeze([
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

const CANONICAL_COMMAND_MD_FILES: readonly string[] = Object.freeze([
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

const CANONICAL_SKILL_IDS: readonly string[] = Object.freeze([
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

const LEGACY_INSTRUCTION_FILES: readonly string[] = Object.freeze([
  'zeus-execution-rules.instructions.md',
  'zeus-orchestration.instructions.md',
  'zeus-workflow.instructions.md',
])

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

const LEGACY_PYTHON_RUNTIME_SCRIPTS: readonly string[] = Object.freeze([
  ...LEGACY_PYTHON_MCP_SCRIPTS,
  '_pantheon_paths.py',
  'eval_store.py',
  'mcp_codemap_module.py',
  'themis_heuristic_scan.py',
  'scrub-secrets.py',
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stripJsonCommentsAndTrailingCommas(raw: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1
      if (i < raw.length) out += '\n'
      continue
    }
    if (ch === '/' && raw[i + 1] === '*') {
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

function isPantheonMcpServer(name: string, entry: unknown): boolean {
  if (PANTHEON_LEGACY_MCP_NAMES.has(name)) return true
  if (!isPlainRecord(entry)) return false
  return ['managed-by', 'managedBy', 'owner'].some(
    (k) => typeof entry[k] === 'string' && /^pantheon(?:-|$)/i.test(String(entry[k])),
  )
}

function isLegacyOrBrokenPantheonMcp(
  name: string,
  entry: unknown,
  configDir: string,
): { remove: boolean; isPython: boolean } {
  if (!isPantheonMcpServer(name, entry) || !isPlainRecord(entry)) {
    return { remove: false, isPython: false }
  }
  const cmdList = Array.isArray(entry.command)
    ? entry.command.filter((x): x is string => typeof x === 'string')
    : typeof entry.command === 'string'
      ? [entry.command]
      : []
  const argList = Array.isArray(entry.args)
    ? entry.args.filter((x): x is string => typeof x === 'string')
    : []
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
  return { remove: isPython || isBrokenLocal, isPython }
}

function getAuditPluginRef(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (isPlainRecord(entry) && typeof entry.package === 'string') return entry.package
  return null
}

function isAuditPantheonPluginRef(ref: string | null): boolean {
  if (!ref) return false
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

function isAuditLegacyPluginEntry(
  entry: unknown,
  configDir: string,
  singularKey: boolean,
  hasNpmNativePlugin: boolean,
): boolean {
  const ref = getAuditPluginRef(entry)
  if (!ref || !isAuditPantheonPluginRef(ref)) return false
  if (singularKey) return true
  const norm = ref.replaceAll('\\', '/')
  if (/pantheon-hooks(?:\.(?:ts|js|mjs))?$/i.test(norm)) return true
  if (/(?:^|\/)src\/plugin\.ts$/i.test(norm)) return true
  if (
    hasNpmNativePlugin &&
    (/^pantheon-tui$/i.test(norm) ||
      /^plugins\/pantheon-tui$/i.test(norm) ||
      /(?:^|\/)plugins\/pantheon-tui$/i.test(norm))
  ) {
    return true
  }
  const isPackageSubpath =
    norm === 'pantheon-opencode' ||
    norm === 'pantheon-opencode/plugin' ||
    norm === 'pantheon-opencode/tui'
  if (!isPackageSubpath && (norm.startsWith('/') || norm.startsWith('.') || norm.includes('/'))) {
    const targetPath = isAbsolute(ref) ? ref : resolve(configDir, ref)
    if (!existsSync(targetPath)) return true
  }
  return false
}

function inspectAuditConfigFile(filePath: string, configDir: string) {
  if (!existsSync(filePath)) return null
  try {
    const st = lstatSync(filePath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(
      filePath.endsWith('.jsonc') ? stripJsonCommentsAndTrailingCommas(raw) : raw,
    ) as unknown
    if (!isPlainRecord(parsed)) return null

    const legacyMcps: Array<{ layout: 'v1' | 'v2'; name: string }> = []
    if (basename(filePath) !== 'tui.json' && isPlainRecord(parsed.mcp)) {
      const servers = isPlainRecord(parsed.mcp.servers) ? parsed.mcp.servers : null
      if (servers) {
        for (const [name, entry] of Object.entries(servers)) {
          if (isLegacyOrBrokenPantheonMcp(name, entry, configDir).remove) {
            legacyMcps.push({ layout: 'v2', name })
          }
        }
      }
      for (const [name, entry] of Object.entries(parsed.mcp)) {
        if (servers && name === 'servers') continue
        if (isLegacyOrBrokenPantheonMcp(name, entry, configDir).remove) {
          legacyMcps.push({ layout: 'v1', name })
        }
      }
    }

    const plural = Array.isArray(parsed.plugins) ? parsed.plugins : []
    const hasNpmNativePlugin = plural.some((e) => {
      const ref = getAuditPluginRef(e)?.trim()
      return ref === 'pantheon-opencode' || ref === 'pantheon-opencode/plugin'
    })
    const legacyPlugins: Array<{ key: 'plugin' | 'plugins'; index: number }> = []
    if (Array.isArray(parsed.plugin)) {
      parsed.plugin.forEach((entry, index) => {
        if (isAuditLegacyPluginEntry(entry, configDir, true, hasNpmNativePlugin)) {
          legacyPlugins.push({ key: 'plugin', index })
        }
      })
    }
    if (Array.isArray(parsed.plugins)) {
      parsed.plugins.forEach((entry, index) => {
        if (isAuditLegacyPluginEntry(entry, configDir, false, hasNpmNativePlugin)) {
          legacyPlugins.push({ key: 'plugins', index })
        }
      })
    }
    return { filePath, raw, parsed, legacyMcps, legacyPlugins }
  } catch {
    return null
  }
}

function cleanAuditConfigFile(filePath: string, configDir: string, backupScopeRoot: string): void {
  const inspected = inspectAuditConfigFile(filePath, configDir)
  if (!inspected || (inspected.legacyMcps.length === 0 && inspected.legacyPlugins.length === 0)) {
    return
  }
  const cfg = structuredClone(inspected.parsed) as Record<string, unknown>
  if (isPlainRecord(cfg.mcp)) {
    const mcpObj = cfg.mcp as Record<string, unknown>
    for (const item of inspected.legacyMcps) {
      if (item.layout === 'v2' && isPlainRecord(mcpObj.servers)) {
        delete (mcpObj.servers as Record<string, unknown>)[item.name]
      } else if (item.layout === 'v1') {
        delete mcpObj[item.name]
      }
    }
    if (isPlainRecord(mcpObj.servers) && Object.keys(mcpObj.servers).length === 0) {
      delete mcpObj.servers
    }
    if (Object.keys(mcpObj).length === 0) delete cfg.mcp
  }
  for (const key of ['plugin', 'plugins'] as const) {
    if (!Array.isArray(cfg[key])) continue
    const drop = new Set(inspected.legacyPlugins.filter((p) => p.key === key).map((p) => p.index))
    if (drop.size === 0) continue
    cfg[key] = (cfg[key] as unknown[]).filter((_, i) => !drop.has(i))
    if (
      (cfg[key] as unknown[]).length === 0 &&
      (key === 'plugin' || basename(filePath) === 'tui.json' || basename(filePath) === 'cli.json')
    ) {
      delete cfg[key]
    }
  }
  const next = `${JSON.stringify(cfg, null, 2)}\n`
  if (next === inspected.raw) return
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const bdir = join(backupScopeRoot, '.pantheon', 'backups', `legacy-migration-${stamp}`)
    mkdirSync(bdir, { recursive: true, mode: 0o700 })
    chmodSync(bdir, 0o700)
    const bfile = join(bdir, basename(filePath))
    writeFileSync(bfile, inspected.raw, { encoding: 'utf8', mode: 0o600 })
    chmodSync(bfile, 0o600)
  } catch {
    /* best effort */
  }
  if (
    (basename(filePath) === 'tui.json' || basename(filePath) === 'cli.json') &&
    Object.keys(cfg).length === 0
  ) {
    rmSync(filePath, { force: true })
    return
  }
  const st = lstatSync(filePath)
  const tmpPath = `${filePath}.tmp-${process.pid}`
  writeFileSync(tmpPath, next, { encoding: 'utf8', mode: st.mode & 0o777 })
  renameSync(tmpPath, filePath)
}

export function resolveAuditCacheDir(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.NODE_TEST_CONTEXT) return undefined
  if (env.XDG_CACHE_HOME?.trim()) return join(resolve(env.XDG_CACHE_HOME.trim()), 'opencode', 'npm')
  const home = env.HOME?.trim()
  return home ? join(resolve(home), '.cache', 'opencode', 'npm') : undefined
}

function readCachedPackageVersion(candidateDir: string): string | null {
  for (const manifest of [
    join(candidateDir, 'node_modules', 'pantheon-opencode', 'package.json'),
    join(candidateDir, 'package.json'),
  ]) {
    try {
      if (!existsSync(manifest)) continue
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.trim() !== '') {
        return parsed.version.trim()
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

function isUnderPath(parentDir: string, targetPath: string): boolean {
  try {
    const parentReal = realpathSync(parentDir)
    const targetReal = realpathSync(targetPath)
    return targetReal === parentReal || targetReal.startsWith(`${parentReal}/`)
  } catch {
    return false
  }
}

function collectCacheAudit(cacheNpmDir: string, options: LegacyAuditOptions): LegacyAuditItem[] {
  const items: LegacyAuditItem[] = []
  if (!existsSync(cacheNpmDir) || cacheNpmDir === '/') return items

  const activeBundlePath = options.activeBundlePath ?? ''
  const runningVersion = options.runningVersion ? String(options.runningVersion).trim() : ''
  const runningIsStable = runningVersion !== '' && !/-(?:beta|rc)\./i.test(runningVersion)
  const seen = new Set<string>()

  const pushCacheItem = (targetPath: string, reason: string) => {
    const resolved = resolve(targetPath)
    if (seen.has(resolved) || !existsSync(resolved)) return
    if (activeBundlePath && isUnderPath(resolved, activeBundlePath)) return
    seen.add(resolved)
    items.push({
      path: resolved,
      scope: 'global',
      category: 'drift',
      reason,
      bytes: measurePathBytes(resolved),
    })
  }

  let channelEntries: Array<{ name: string; isDirectory: () => boolean }> = []
  try {
    channelEntries = readdirSync(cacheNpmDir, { withFileTypes: true })
  } catch {
    return items
  }

  for (const entry of channelEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name !== 'pantheon-opencode' && !entry.name.startsWith('pantheon-opencode@')) {
      continue
    }
    const channelDir = join(cacheNpmDir, entry.name)

    // Flag coexisting @beta channel cache once user runs a stable install.
    if (runningIsStable && entry.name === 'pantheon-opencode@beta') {
      pushCacheItem(channelDir, 'Stale @beta plugin cache coexisting with stable install')
      continue
    }

    // Keep only the active (or newest) timestamp/version revision inside a channel directory.
    try {
      const revisions = readdirSync(channelDir, { withFileTypes: true })
        .filter(
          (sub) => sub.isDirectory() && sub.name !== 'node_modules' && !sub.name.startsWith('.'),
        )
        .map((sub) => {
          const full = join(channelDir, sub.name)
          let mtime = 0
          try {
            mtime = statSync(full).mtimeMs
          } catch {}
          return {
            path: full,
            mtime,
            active: Boolean(activeBundlePath && isUnderPath(full, activeBundlePath)),
          }
        })
      if (revisions.length > 1) {
        revisions.sort((a, b) => Number(b.active) - Number(a.active) || b.mtime - a.mtime)
        for (const stale of revisions.slice(1)) {
          const ver = readCachedPackageVersion(stale.path)
          pushCacheItem(
            stale.path,
            ver
              ? `Stale cached Pantheon plugin revision (v${ver})`
              : 'Stale cached Pantheon plugin revision',
          )
        }
      }
    } catch {
      /* ignore unreadable cache dir */
    }
  }

  return items
}

export function resolveAuditGlobalDir(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.PANTHEON_HOME?.trim()) return resolve(env.PANTHEON_HOME.trim())
  if (env.XDG_CONFIG_HOME?.trim()) return join(resolve(env.XDG_CONFIG_HOME.trim()), 'opencode')
  if (env.NODE_TEST_CONTEXT) return undefined
  const home = env.HOME?.trim()
  return home ? join(resolve(home), '.config', 'opencode') : undefined
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function toSafeSegment(raw: unknown, fallback = 'default'): string {
  const str = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '_')
    .slice(0, 128)
  if (!str || str === '.' || str === '..' || !SAFE_SEGMENT_RE.test(str)) return fallback
  return str
}

function measurePathBytes(targetPath: string, depth = 0): number {
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

function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true
  if (!existsSync(a) || !existsSync(b)) return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function isConfinedWithin(rootDir: string, targetPath: string): boolean {
  try {
    const realRoot = realpathSync(rootDir)
    const parentReal = realpathSync(dirname(targetPath))
    return parentReal === realRoot || parentReal.startsWith(`${realRoot}/`)
  } catch {
    return false
  }
}

function countTableRows(db: DatabaseSync, tableName: string): number {
  try {
    const row = db
      .prepare(`SELECT count(*) AS cnt FROM "${tableName.replace(/"/g, '""')}"`)
      .get() as { cnt?: number } | undefined
    return Number(row?.cnt ?? 0)
  } catch {
    return 0
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(name) as { name?: string } | undefined
    return Boolean(row?.name)
  } catch {
    return false
  }
}

function collectScopeAudit(
  scope: LegacyScope,
  baseRoot: string,
  configRoot: string,
  options: LegacyAuditOptions,
): { items: LegacyAuditItem[]; unmigratedStores: number } {
  const items: LegacyAuditItem[] = []
  const seen = new Set<string>()
  let unmigratedStores = 0

  const addItem = (filePath: string, category: LegacyCategory, reason: string) => {
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

  // 1. Dead V1 hooks, obsolete config files, legacy Python MCPs & runtime
  for (const hookName of ['pantheon-hooks.ts', 'pantheon-hooks.js', 'pantheon-hooks.mjs']) {
    addItem(join(configRoot, 'plugins', hookName), 'hooks', 'Obsolete OpenCode V1 hook plugin')
  }
  addItem(join(configRoot, 'tiers.json'), 'v1Obsolete', 'Obsolete V1 model tiers registry')
  addItem(join(baseRoot, 'tiers.json'), 'v1Obsolete', 'Obsolete V1 model tiers registry')

  const configCandidates = new Set<string>()
  for (const dir of [baseRoot, configRoot]) {
    for (const fileName of ['opencode.json', 'opencode.jsonc', 'tui.json']) {
      configCandidates.add(resolve(join(dir, fileName)))
    }
  }
  let removedPythonMcpInConfig = false
  for (const cfgPath of configCandidates) {
    const inspected = inspectAuditConfigFile(cfgPath, dirname(cfgPath))
    if (!inspected) continue
    for (const mcp of inspected.legacyMcps) {
      removedPythonMcpInConfig = true
      items.push({
        path: `${cfgPath}#legacy-mcp:${mcp.name}`,
        scope,
        category: 'v1Obsolete',
        reason: `Legacy or broken MCP entry (${mcp.name}) in ${basename(cfgPath)}`,
        bytes: 0,
      })
    }
    if (inspected.legacyPlugins.length > 0) {
      items.push({
        path: `${cfgPath}#legacy-plugin`,
        scope,
        category: 'hooks',
        reason: `Legacy or broken Pantheon plugin entry in ${basename(cfgPath)}`,
        bytes: 0,
      })
    }
  }

  const isRepoCheckout =
    existsSync(join(configRoot, 'src', 'mcp', 'code_mode.py')) &&
    existsSync(join(configRoot, 'package.json'))
  if (!isRepoCheckout && existsSync(configRoot)) {
    const scriptsDir = join(configRoot, 'scripts')
    const hasPyScripts =
      existsSync(scriptsDir) &&
      LEGACY_PYTHON_RUNTIME_SCRIPTS.some((name) => existsSync(join(scriptsDir, name)))
    if (existsSync(scriptsDir)) {
      for (const name of LEGACY_PYTHON_RUNTIME_SCRIPTS) {
        addItem(
          join(scriptsDir, name),
          'v1Obsolete',
          'Obsolete legacy Python MCP script (replaced by native tools / Node MCP)',
        )
      }
    }
    const reqVision = join(configRoot, 'requirements-vision.txt')
    addItem(reqVision, 'v1Obsolete', 'Obsolete Python vision requirements file')
    const configVenv = join(configRoot, '.venv')
    if (
      existsSync(configVenv) &&
      (hasPyScripts || existsSync(reqVision) || removedPythonMcpInConfig)
    ) {
      addItem(configVenv, 'v1Obsolete', 'Obsolete Python virtual environment for legacy MCPs')
    }
  }

  const pantheonDir = join(baseRoot, '.pantheon')
  addItem(join(pantheonDir, 'fastembed_cache'), 'v1Obsolete', 'Unused legacy fastembed cache')
  addItem(join(pantheonDir, '.fastembed'), 'v1Obsolete', 'Unused legacy fastembed cache')
  addItem(join(baseRoot, 'fastembed_cache'), 'v1Obsolete', 'Unused legacy fastembed cache')
  addItem(
    join(pantheonDir, '.migration-checkpoint'),
    'v1Obsolete',
    'Stale migration checkpoint file',
  )

  for (const bakDir of [configRoot, pantheonDir]) {
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

  // 2. Unmigrated legacy stores
  const legacyFlatMemDb = join(pantheonDir, 'memory.db')
  if (existsSync(legacyFlatMemDb)) {
    unmigratedStores += 1
    addItem(legacyFlatMemDb, 'legacyStore', 'Unmigrated flat .pantheon/memory.db')
  }

  const canonicalMemDb = join(pantheonDir, 'memory', 'memory.db')
  if (existsSync(canonicalMemDb)) {
    try {
      const db = new DatabaseSync(canonicalMemDb, { readOnly: true })
      const legacyVecTables = [
        'memories_vec',
        'vec_memories',
        'memory_embeddings',
        'memory_vectors',
      ]
      const hasLegacyVec = legacyVecTables.some((t) => tableExists(db, t))
      db.close()
      if (hasLegacyVec) {
        unmigratedStores += 1
        items.push({
          path: `${canonicalMemDb}#legacy-vec`,
          scope,
          category: 'legacyStore',
          reason: 'Legacy vector tables pending cleanup in memory.db',
          bytes: 0,
        })
      }
    } catch {
      /* ignore */
    }
  }

  for (const dbName of ['global.db', 'project.db']) {
    const persDbPath = join(pantheonDir, 'persistence', dbName)
    if (existsSync(persDbPath)) {
      unmigratedStores += 1
      addItem(persDbPath, 'legacyStore', `Unmigrated persistence/${dbName}`)
    }
  }

  const legacyGoalsJson = join(pantheonDir, 'goals.json')
  if (existsSync(legacyGoalsJson)) {
    unmigratedStores += 1
    addItem(legacyGoalsJson, 'legacyStore', 'Unmigrated legacy goals.json')
  }

  // 3. Redundant copied Pantheon assets shadowed by native plugin transforms
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
        'Legacy singular agent copy shadowed by native plugin transform',
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
        'Legacy instruction file superseded by AGENTS.global.md',
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

    const routingPath = join(configRoot, 'routing.yml')
    if (existsSync(routingPath)) {
      try {
        if (/pantheon|zeus:|athena:|apollo:/i.test(readFileSync(routingPath, 'utf8'))) {
          addItem(routingPath, 'redundantAsset', 'Copied routing.yml superseded by bundled roster')
        }
      } catch {
        /* ignore */
      }
    }
    const isRepoRoot =
      existsSync(join(baseRoot, 'package.json')) &&
      existsSync(join(baseRoot, 'src', 'plugin.ts')) &&
      existsSync(join(baseRoot, 'src', 'agents', 'roster.json'))
    const statePaths = [join(configRoot, '.pantheon', 'install-state.json')]
    if (!isRepoRoot) statePaths.push(join(pantheonDir, 'install-state.json'))
    for (const statePath of statePaths) {
      addItem(statePath, 'redundantAsset', 'Legacy CLI installer manifest')
    }
    const codeModeDirs = [join(configRoot, '.pantheon', 'code-mode')]
    if (!isRepoRoot && join(pantheonDir, 'code-mode') !== codeModeDirs[0]) {
      codeModeDirs.push(join(pantheonDir, 'code-mode'))
    }
    for (const cmDir of codeModeDirs) {
      if (!existsSync(cmDir)) continue
      try {
        for (const entry of readdirSync(cmDir)) {
          if (entry.endsWith('.py') || entry.endsWith('.sh') || entry === 'manifest.json') {
            addItem(
              join(cmDir, entry),
              'v1Obsolete',
              'Obsolete Python code-mode script (replaced by native tools)',
            )
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  return { items, unmigratedStores }
}

function ensureCanonicalMemoryDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(namespace, key)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      key, value, namespace,
      content='memories',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, key, value, namespace) VALUES (new.id, new.key, new.value, new.namespace);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, key, value, namespace) VALUES('delete', old.id, old.key, old.value, old.namespace);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, key, value, namespace) VALUES('delete', old.id, old.key, old.value, old.namespace);
      INSERT INTO memories_fts(rowid, key, value, namespace) VALUES (new.id, new.key, new.value, new.namespace);
    END;
  `)
  return db
}

function migrateScopeBeforeDelete(baseRoot: string): number {
  const pantheonDir = join(baseRoot, '.pantheon')
  if (!existsSync(pantheonDir)) return 0
  let migrated = 0
  const nowIso = new Date().toISOString()

  // 1. Migrate flat .pantheon/memory.db -> .pantheon/memory/memory.db + drop legacy vector tables
  const flatMemDbPath = join(pantheonDir, 'memory.db')
  const canonicalMemPath = join(pantheonDir, 'memory', 'memory.db')
  if (existsSync(flatMemDbPath)) {
    try {
      const src = new DatabaseSync(flatMemDbPath, { readOnly: true })
      const dst = ensureCanonicalMemoryDb(canonicalMemPath)
      if (tableExists(src, 'memories')) {
        const rows = src
          .prepare('SELECT namespace, key, value, created_at FROM memories')
          .all() as Array<{
          namespace?: string
          key?: string
          value?: string
          created_at?: string
        }>
        const insert = dst.prepare(
          'INSERT OR IGNORE INTO memories (namespace, key, value, importance, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        dst.exec('BEGIN IMMEDIATE')
        try {
          for (const r of rows) {
            insert.run(
              String(r.namespace ?? 'default'),
              String(r.key ?? ''),
              String(r.value ?? ''),
              0.5,
              String(r.created_at ?? nowIso),
            )
            migrated += 1
          }
          dst.exec('COMMIT')
        } catch (txErr) {
          try {
            dst.exec('ROLLBACK')
          } catch {
            /* ignore */
          }
          throw txErr
        }
      }
      src.close()
      dst.close()
    } catch {
      /* fail-open */
    }
  }

  if (existsSync(canonicalMemPath)) {
    try {
      const db = ensureCanonicalMemoryDb(canonicalMemPath)
      for (const trig of ['memories_vec_ai', 'memories_vec_ad', 'memories_vec_au']) {
        db.exec(`DROP TRIGGER IF EXISTS ${trig}`)
      }
      for (const tbl of ['memories_vec', 'vec_memories', 'memory_embeddings', 'memory_vectors']) {
        if (tableExists(db, tbl)) {
          db.exec(`DROP TABLE IF EXISTS ${tbl}`)
          migrated += 1
        }
      }
      db.close()
    } catch {
      /* fail-open */
    }
  }

  // 2. Migrate persistence/{global,project}.db -> persistence/<ns>/<key>.json
  const persDir = join(pantheonDir, 'persistence')
  for (const dbName of ['global.db', 'project.db']) {
    const dbPath = join(persDir, dbName)
    if (!existsSync(dbPath)) continue
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      for (const tbl of ['kv', 'kv_store', 'context', 'checkpoints', 'sessions']) {
        if (!tableExists(db, tbl) || countTableRows(db, tbl) === 0) continue
        const cols = db.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>
        const colNames = new Set(cols.map((c) => c.name))
        const keyCol = colNames.has('key')
          ? 'key'
          : colNames.has('id')
            ? 'id'
            : colNames.has('session_id')
              ? 'session_id'
              : null
        const valCol = colNames.has('value')
          ? 'value'
          : colNames.has('data')
            ? 'data'
            : colNames.has('content')
              ? 'content'
              : null
        if (!keyCol || !valCol) continue
        const nsSelect = colNames.has('namespace')
          ? 'namespace'
          : `'${tbl === 'checkpoints' || tbl === 'sessions' ? 'checkpoints' : 'default'}' AS namespace`
        const rows = db
          .prepare(`SELECT ${nsSelect}, ${keyCol} AS k, ${valCol} AS v FROM ${tbl}`)
          .all() as Array<{
          namespace?: string
          k?: string
          v?: unknown
        }>
        for (const r of rows) {
          const ns = toSafeSegment(r.namespace, 'default')
          const key = toSafeSegment(r.k, '')
          if (!key) continue
          const targetDir = join(persDir, ns)
          const targetFile = join(targetDir, `${key}.json`)
          if (!existsSync(targetFile)) {
            mkdirSync(targetDir, { recursive: true })
            writeFileSync(
              targetFile,
              JSON.stringify(
                { key, namespace: ns, value: String(r.v ?? ''), updated_at: nowIso },
                null,
                2,
              ),
              'utf8',
            )
            migrated += 1
          }
        }
      }
      db.close()
    } catch {
      /* fail-open */
    }
  }

  // 3. Migrate legacy goals.json -> .pantheon/goals/<id>.json
  const legacyGoalsPath = join(pantheonDir, 'goals.json')
  if (existsSync(legacyGoalsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(legacyGoalsPath, 'utf8')) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { goals?: unknown }).goals)
          ? ((parsed as { goals: unknown[] }).goals ?? [])
          : []
      const goalsDir = join(pantheonDir, 'goals')
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        const safeId = toSafeSegment(rec.id ?? rec.goal_id, '')
        if (!safeId) continue
        const target = join(goalsDir, `${safeId}.json`)
        if (!existsSync(target)) {
          mkdirSync(goalsDir, { recursive: true })
          writeFileSync(
            target,
            JSON.stringify(
              {
                id: safeId,
                title: String(rec.title ?? rec.description ?? ''),
                criteria: Array.isArray(rec.criteria) ? rec.criteria.map(String) : [],
                status: String(rec.status ?? 'active'),
                created_at: typeof rec.created_at === 'string' ? rec.created_at : nowIso,
                updated_at: typeof rec.updated_at === 'string' ? rec.updated_at : nowIso,
              },
              null,
              2,
            ),
            'utf8',
          )
          migrated += 1
        }
      }
    } catch {
      /* fail-open */
    }
  }

  return migrated
}

export function scanLegacyArtifacts(options: LegacyAuditOptions = {}): LegacyAuditScan {
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir = options.globalConfigDir
    ? resolve(options.globalConfigDir)
    : resolveAuditGlobalDir(options.env)
  const cacheNpmDir = options.cacheDir
    ? resolve(options.cacheDir)
    : resolveAuditCacheDir(options.env)

  const items: LegacyAuditItem[] = []
  let unmigratedStores = 0

  if (globalConfigDir && existsSync(globalConfigDir) && globalConfigDir !== '/') {
    const res = collectScopeAudit('global', globalConfigDir, globalConfigDir, options)
    items.push(...res.items)
    unmigratedStores += res.unmigratedStores
  }

  if (cacheNpmDir && existsSync(cacheNpmDir) && cacheNpmDir !== '/') {
    items.push(...collectCacheAudit(cacheNpmDir, options))
  }

  if (
    workspaceDir &&
    existsSync(workspaceDir) &&
    workspaceDir !== '/' &&
    (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))
  ) {
    const res = collectScopeAudit('project', workspaceDir, join(workspaceDir, '.opencode'), options)
    items.push(...res.items)
    unmigratedStores += res.unmigratedStores
  }

  const byScope: Record<LegacyScope, number> = { global: 0, project: 0 }
  const byCategory: Record<string, number> = {}
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

export function cleanLegacyArtifacts(
  options: LegacyAuditOptions & { readonly scope?: 'all' | LegacyScope } = {},
): LegacyCleanResult {
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir = options.globalConfigDir
    ? resolve(options.globalConfigDir)
    : resolveAuditGlobalDir(options.env)
  const cacheNpmDir = options.cacheDir
    ? resolve(options.cacheDir)
    : resolveAuditCacheDir(options.env)
  const scopeFilter = options.scope && options.scope !== 'all' ? options.scope : null

  const scan = scanLegacyArtifacts(options)
  let migratedRecords = 0

  if (
    scopeFilter !== 'project' &&
    globalConfigDir &&
    existsSync(globalConfigDir) &&
    globalConfigDir !== '/'
  ) {
    migratedRecords += migrateScopeBeforeDelete(globalConfigDir)
  }
  if (
    scopeFilter !== 'global' &&
    workspaceDir &&
    existsSync(workspaceDir) &&
    workspaceDir !== '/' &&
    (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))
  ) {
    migratedRecords += migrateScopeBeforeDelete(workspaceDir)
  }

  const removed: string[] = []
  const errors: Array<{ readonly path: string; readonly reason: string }> = []
  let reclaimedBytes = 0
  const cleanedConfigs = new Set<string>()

  for (const item of scan.items) {
    if (scopeFilter && item.scope !== scopeFilter) continue
    if (item.path.endsWith('#legacy-vec')) {
      removed.push(item.path)
      continue
    }
    if (item.path.includes('#legacy-mcp:') || item.path.endsWith('#legacy-plugin')) {
      const cfgPath = item.path.split('#')[0]
      const scopeRoot = item.scope === 'global' ? globalConfigDir : workspaceDir
      if (!scopeRoot || !isConfinedWithin(scopeRoot, cfgPath)) {
        errors.push({ path: item.path, reason: 'Path escapes target scope root' })
        continue
      }
      try {
        if (!cleanedConfigs.has(cfgPath)) {
          cleanedConfigs.add(cfgPath)
          cleanAuditConfigFile(cfgPath, dirname(cfgPath), scopeRoot)
        }
        removed.push(item.path)
      } catch (err) {
        errors.push({
          path: item.path,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
      continue
    }
    const scopeRoot = item.scope === 'global' ? globalConfigDir : workspaceDir
    const confineRoot =
      item.scope === 'global' && cacheNpmDir && isConfinedWithin(cacheNpmDir, item.path)
        ? cacheNpmDir
        : scopeRoot
    if (!confineRoot || !isConfinedWithin(confineRoot, item.path)) {
      errors.push({ path: item.path, reason: 'Path escapes target scope root' })
      continue
    }
    try {
      if (existsSync(item.path)) {
        rmSync(item.path, { recursive: true, force: true })
        removed.push(item.path)
        reclaimedBytes += item.bytes
      }
      if (item.path.endsWith('.db')) {
        for (const suffix of ['-wal', '-shm', '-journal']) {
          const sidecar = `${item.path}${suffix}`
          if (existsSync(sidecar) && isConfinedWithin(confineRoot, sidecar)) {
            const sidecarBytes = measurePathBytes(sidecar)
            rmSync(sidecar, { force: true })
            removed.push(sidecar)
            reclaimedBytes += sidecarBytes
          }
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
    removed,
    reclaimedBytes,
    migratedRecords,
    errors,
  }
}

export function purgeAllPantheonData(
  options: LegacyAuditOptions & {
    readonly scope?: 'all' | LegacyScope
    readonly dryRun?: boolean
  } = {},
): LegacyCleanResult {
  const dryRun = options.dryRun === true
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir = options.globalConfigDir
    ? resolve(options.globalConfigDir)
    : resolveAuditGlobalDir(options.env)
  const scopeFilter = options.scope && options.scope !== 'all' ? options.scope : null

  const scan = scanLegacyArtifacts({ ...options, includeRedundantCopiedAssets: true })
  const removed: string[] = []
  const errors: Array<{ readonly path: string; readonly reason: string }> = []
  let reclaimedBytes = 0

  if (!dryRun) {
    const cleanRes = cleanLegacyArtifacts({ ...options, includeRedundantCopiedAssets: true })
    removed.push(...cleanRes.removed)
    reclaimedBytes += cleanRes.reclaimedBytes
    errors.push(...cleanRes.errors)
  }

  const purgeRoot = (rootDir: string, configRoot: string) => {
    if (!rootDir || rootDir === '/' || !existsSync(rootDir)) return
    const isRepo =
      existsSync(join(rootDir, 'src', 'mcp', 'code_mode.py')) &&
      existsSync(join(rootDir, 'package.json'))
    if (isRepo) return
    for (const store of [join(rootDir, '.pantheon'), join(configRoot, '.pantheon')]) {
      if (!existsSync(store) || !isConfinedWithin(rootDir, store)) continue
      const bytes = measurePathBytes(store)
      try {
        if (!dryRun) rmSync(store, { recursive: true, force: true })
        removed.push(store)
        reclaimedBytes += bytes
      } catch (err) {
        errors.push({ path: store, reason: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  if (scopeFilter !== 'project' && globalConfigDir) {
    purgeRoot(globalConfigDir, globalConfigDir)
  }
  if (
    scopeFilter !== 'global' &&
    workspaceDir &&
    (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))
  ) {
    purgeRoot(workspaceDir, join(workspaceDir, '.opencode'))
  }
  if (dryRun) {
    for (const item of scan.items) removed.push(item.path)
    reclaimedBytes += scan.summary.totalBytes
  }

  return {
    removed: [...new Set(removed)],
    reclaimedBytes,
    migratedRecords: 0,
    errors,
  }
}
