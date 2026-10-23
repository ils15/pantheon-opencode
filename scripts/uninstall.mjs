#!/usr/bin/env node

/** Remove only files and registrations owned by Pantheon for OpenCode. */
import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { isatty } from 'node:tty'
import { backupWarning, createBackupSet } from './install/backup.mjs'
import {
  CONTEXT_SIDEBAR_NEGATION,
  V2_CLI_CONFIG_FILENAME,
  withContextSidebarEnabled,
} from './install/opencode.mjs'
import { snapshot } from './install/plan.mjs'
import { writeConfigWithBackup } from './install/shared.mjs'
import {
  assertNoSymlinkAncestors,
  verifyPathRemoved,
  verifyRegularFile,
} from './install/verify.mjs'

const AGENT_NAMES = new Set([
  'zeus',
  'athena',
  'apollo',
  'hermes',
  'aphrodite',
  'demeter',
  'themis',
  'prometheus',
  'hephaestus',
  'nyx',
  'gaia',
  'iris',
  'mnemosyne',
  'talos',
])
const OWNERSHIP_MARKER =
  /(?:pantheon-opencode|pantheon[- ]agent system|managed[- ]by[: ]+pantheon|pantheon-(?:resources|memory|persistence|code-mode|tui|hooks))/i
const stats = { removed: 0, skipped: 0, errors: 0 }
let touchedPaths = new Set()
// Paths that survive the uninstall but were REWRITTEN (not removed), so the
// plan summary can label them UPDATE instead of REMOVE without guessing from
// the basename.
let rewrittenPaths = new Set()
let quietPreview = false

function showHelp() {
  console.log(`

Usage:
  node scripts/uninstall.mjs [--project|--global] [--target /path] [--dry-run] [--force] [--purge-data]

Target may be a project directory (containing .opencode), or a flat global
OpenCode directory (~/.config/opencode or ~/.opencode). Symlinks are rejected.
`)
}

function parseArgs(argv) {
  const args = {
    target: process.cwd(),
    dryRun: false,
    force: false,
    purgeData: false,
    help: false,
    scope: 'project',
  }
  let explicitTarget = false
  for (let index = 2; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--target') {
      args.target = argv[++index]
      explicitTarget = true
    } else if (option === '--project') {
      if (args.scope === 'global') throw new Error('--project and --global are mutually exclusive')
      args.scope = 'project'
    } else if (option === '--global') {
      if (args.scope === 'project' && argv.slice(2, index).includes('--project'))
        throw new Error('--project and --global are mutually exclusive')
      args.scope = 'global'
    } else if (option === '--dry-run') args.dryRun = true
    else if (option === '--force') args.force = true
    else if (option === '--purge-data') args.purgeData = true
    else if (option === '--help') args.help = true
    else if (option === '--platforms')
      throw new Error('--platforms was removed; this uninstaller supports OpenCode only')
    else throw new Error(`Unknown option: ${option}`)
  }
  if (args.scope === 'global' && !explicitTarget) {
    args.target = resolveGlobalTarget()
  }
  args.target = resolve(args.target)
  return args
}

/**
 * Resolve the isolated global OpenCode directory without consulting cwd.
 *
 * PANTHEON_HOME is intentionally a directory override (not a parent), which
 * makes sandboxed installs safe and keeps uninstall symmetric with the MCP
 * path resolver. XDG remains the normal user-wide fallback.
 *
 * @param {NodeJS.ProcessEnv} [env] environment to inspect
 * @param {string} [home] home directory fallback
 * @returns {string} absolute global configuration directory
 */
function resolveGlobalTarget(env = process.env, home = homedir()) {
  const pantheonHome = env.PANTHEON_HOME?.trim()
  if (pantheonHome) return resolve(pantheonHome)
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return resolve(join(xdg, 'opencode'))
}

function lstat(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function isSymlink(path) {
  return lstat(path)?.isSymbolicLink() === true
}

function isInside(path, root) {
  const child = relative(resolve(root), resolve(path))
  return child === '' || (!child.startsWith('..') && !child.includes(`${pathSeparator()}..`))
}

function pathSeparator() {
  return '/'
}

function isPantheonContent(path) {
  const info = lstat(path)
  if (!info?.isFile() || info.isSymbolicLink()) return false
  try {
    return OWNERSHIP_MARKER.test(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

function isPantheonRouting(path) {
  const info = lstat(path)
  if (!info?.isFile() || info.isSymbolicLink()) return false
  try {
    // routing.yml is also a legitimate user configuration. Unlike generated
    // agents, its contents can mention Pantheon without being Pantheon-owned,
    // so only an explicit ownership marker permits removal.
    return /(?:^|\n)\s*(?:#|<!--)\s*(?:managed-by:\s*)?pantheon-opencode\b/i.test(
      readFileSync(path, 'utf8'),
    )
  } catch {
    return false
  }
}

function assertReviewedPath(path, reviewedPaths) {
  if (reviewedPaths && !reviewedPaths.has(path)) {
    throw new Error(`Uninstall operation set drifted; refusing unreviewed path: ${path}`)
  }
}

function removePath(path, dryRun, root, label = path, reviewedPaths = null) {
  if (!isInside(path, root)) {
    stats.skipped += 1
    return false
  }
  assertNoSymlinkAncestors(path, { includeLeaf: false })
  if (isSymlink(path)) {
    stats.skipped += 1
    return false
  }
  const info = lstat(path)
  if (!info) {
    stats.skipped += 1
    return false
  }
  assertReviewedPath(path, reviewedPaths)
  touchedPaths.add(path)
  if (dryRun) {
    if (!quietPreview) console.log(`  ~ Would remove ${label}`)
  } else {
    try {
      assertNoSymlinkAncestors(path, { includeLeaf: false })
      rmSync(path, { recursive: info.isDirectory(), force: false })
      verifyPathRemoved(path)
    } catch (error) {
      console.error(`  ⚠️ Failed to remove ${path}: ${error.message}`)
      stats.errors += 1
      return false
    }
  }
  stats.removed += 1
  return true
}

function removeMatchingEntries(directory, predicate, dryRun, root, reviewedPaths = null) {
  assertNoSymlinkAncestors(directory, { includeLeaf: false })
  const info = lstat(directory)
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    stats.skipped += 1
    return
  }
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const child = lstat(path)
    if (!child || child.isSymbolicLink()) {
      stats.skipped += 1
      continue
    }
    if (predicate(path, entry)) removePath(path, dryRun, root, path, reviewedPaths)
    else if (child.isDirectory())
      removeMatchingEntries(path, predicate, dryRun, root, reviewedPaths)
  }
  const remaining = lstat(directory)
  const scheduledRemaining = readdirSync(directory).filter(
    (entry) => !touchedPaths.has(join(directory, entry)),
  )
  if (
    remaining?.isDirectory() &&
    (dryRun ? scheduledRemaining.length === 0 : readdirSync(directory).length === 0)
  )
    removePath(directory, dryRun, root, directory, reviewedPaths)
}

function readJson(path) {
  const info = lstat(path)
  if (!info || info.isSymbolicLink() || !info.isFile()) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function ownedReference(value) {
  return typeof value === 'string' && /pantheon(?:[-/]|$)/i.test(value)
}

function ownedPluginEntry(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return ['managed-by', 'managedBy', 'owner'].some(
      (key) => typeof value[key] === 'string' && /^pantheon(?:-|$)/i.test(value[key]),
    )
  }
  if (typeof value !== 'string') return false
  const normalized = value.replaceAll('\\', '/')
  return (
    /(?:^|\/)src\/plugin\.ts$/i.test(normalized) ||
    /(?:^|\/)src\/plugins\/pantheon-hooks\.ts$/i.test(normalized) ||
    /^(?:plugins\/)?pantheon-(?:hooks|plugin|tui)$/i.test(normalized) ||
    /^pantheon-opencode$/i.test(normalized)
  )
}

function ownedMcpEntry(name, value) {
  if (typeof name === 'string' && /^pantheon(?:-|$)/i.test(name)) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return ['managed-by', 'managedBy', 'owner'].some(
    (key) => typeof value[key] === 'string' && /^pantheon(?:-|$)/i.test(value[key]),
  )
}

function cleanOpenCodeConfig(target, dryRun, ownedRoot = target, reviewedPaths = null) {
  const configPath = join(target, 'opencode.json')
  const config = readJson(configPath)
  if (!config) {
    stats.skipped += 1
    return
  }
  let changed = false
  const removedAgents = new Set()
  if (config.agent && typeof config.agent === 'object' && !Array.isArray(config.agent)) {
    for (const [name, value] of Object.entries(config.agent)) {
      const source = value && typeof value === 'object' ? value.source : undefined
      const sourcePath = typeof source === 'string' ? resolve(target, source) : ''
      if (
        typeof source === 'string' &&
        isInside(sourcePath, ownedRoot) &&
        isPantheonContent(sourcePath)
      ) {
        delete config.agent[name]
        removedAgents.add(name)
        changed = true
      }
    }
    if (!Object.keys(config.agent).length) {
      delete config.agent
      changed = true
    }
  }
  if (Array.isArray(config.instructions)) {
    const instructions = config.instructions.filter((entry) => {
      if (typeof entry !== 'string') return true
      const path = resolve(target, entry)
      return !(isInside(path, ownedRoot) && isPantheonContent(path))
    })
    changed ||= instructions.length !== config.instructions.length
    if (instructions.length) config.instructions = instructions
    else delete config.instructions
  }
  for (const key of ['mcp', 'plugin', 'plugins']) {
    if (Array.isArray(config[key])) {
      const kept = config[key].filter((entry) =>
        key === 'mcp'
          ? !ownedMcpEntry(typeof entry === 'string' ? entry : '', entry)
          : !ownedPluginEntry(entry),
      )
      changed ||= kept.length !== config[key].length
      config[key] = kept
    } else if (config[key] && typeof config[key] === 'object') {
      for (const [name, value] of Object.entries(config[key])) {
        if (
          key === 'mcp'
            ? ownedMcpEntry(name, value)
            : ownedPluginEntry(name) || ownedPluginEntry(value)
        ) {
          delete config[key][name]
          changed = true
        }
      }
      if (!Object.keys(config[key]).length) {
        delete config[key]
        changed = true
      }
    }
  }
  if (removedAgents.has(config.default_agent)) {
    delete config.default_agent
    changed = true
  }
  if (!changed) {
    stats.skipped += 1
    return
  }
  assertReviewedPath(configPath, reviewedPaths)
  touchedPaths.add(configPath)
  rewrittenPaths.add(configPath)
  const content = `${JSON.stringify(config, null, 2)}\n`
  if (dryRun) {
    if (!quietPreview) console.log('  ~ Would update opencode.json (remove Pantheon-owned entries)')
  } else {
    assertNoSymlinkAncestors(configPath)
    writeFileSync(configPath, content, 'utf8')
    verifyRegularFile(configPath, content)
  }
  stats.removed += 1
}

function configDirFor(target) {
  const name = basename(target)
  const looksFlat = lstat(join(target, 'agents'))?.isDirectory() === true
  return name === '.opencode' || name === 'opencode' || looksFlat
    ? target
    : join(target, '.opencode')
}

function verifiedInstallState(root) {
  const statePath = join(root, '.pantheon', 'install-state.json')
  assertNoSymlinkAncestors(statePath)
  const info = lstat(statePath)
  if (!info) return null
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('Refusing to purge install state that is not a regular file')
  }
  let state
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    throw new Error('Refusing to purge unverified install state')
  }
  if (
    state?.schema_version !== 2 ||
    typeof state.pantheon_version !== 'string' ||
    !state.components ||
    typeof state.components !== 'object' ||
    Array.isArray(state.components)
  )
    throw new Error('Refusing to purge unverified install state')
  return statePath
}

function runUninstallPass(target, dryRun, { purgeData = false, reviewedPaths = null } = {}) {
  const root = resolve(target)
  assertNoSymlinkAncestors(root)
  const rootInfo = lstat(root)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Target must be a directory and not a symlink: ${root}`)
  }
  const statePath = purgeData ? verifiedInstallState(root) : null
  const configDir = configDirFor(root)
  const configInfo = lstat(configDir)
  if (configInfo?.isSymbolicLink()) {
    stats.skipped += 1
    return
  }
  const ownedRoot = root
  cleanOpenCodeConfig(root, dryRun, ownedRoot, reviewedPaths)
  removeMatchingEntries(
    join(configDir, 'agents'),
    (_path, name) => AGENT_NAMES.has(name.replace(/\.md$/, '')) && isPantheonContent(_path),
    dryRun,
    ownedRoot,
    reviewedPaths,
  )
  for (const directory of ['skills', 'commands', 'plugins'])
    removeMatchingEntries(
      join(configDir, directory),
      isPantheonContent,
      dryRun,
      ownedRoot,
      reviewedPaths,
    )
  for (const file of ['package.json', 'tsconfig.json', 'routing.yml']) {
    const path = join(configDir, file)
    if (file === 'routing.yml' ? isPantheonRouting(path) : isPantheonContent(path))
      removePath(path, dryRun, ownedRoot, path, reviewedPaths)
  }
  const tui = join(configDir, 'tui.json')
  cleanTuiConfig(tui, dryRun, ownedRoot, reviewedPaths)
  cleanV2CliConfig(configDir, dryRun, ownedRoot, reviewedPaths)
  const agentsMd = join(root, 'AGENTS.md')
  if (isPantheonContent(agentsMd)) removePath(agentsMd, dryRun, ownedRoot, agentsMd, reviewedPaths)
  const scheduledConfigEntries = configInfo?.isDirectory()
    ? readdirSync(configDir).filter((entry) => !touchedPaths.has(join(configDir, entry)))
    : []
  // A flat global target is also the backup store's config root. Keep it so
  // backups remain discoverable/restorable after uninstall; only nested
  // project `.opencode` directories are eligible for removal here.
  if (
    configInfo?.isDirectory() &&
    resolve(configDir) !== root &&
    (dryRun ? scheduledConfigEntries.length === 0 : readdirSync(configDir).length === 0)
  )
    removePath(configDir, dryRun, ownedRoot, configDir, reviewedPaths)
  if (statePath) {
    assertReviewedPath(statePath, reviewedPaths)
    touchedPaths.add(statePath)
    if (dryRun) {
      if (!quietPreview) console.log(`  ~ Would purge verified install state ${statePath}`)
    } else {
      removePath(statePath, false, ownedRoot, statePath, reviewedPaths)
    }
  }
  return [...touchedPaths]
}

function cleanTuiConfig(path, dryRun, root, reviewedPaths = null) {
  const config = readJson(path)
  if (!config || !Array.isArray(config.plugin)) {
    stats.skipped += 1
    return
  }
  const plugin = config.plugin.filter(
    (entry) => !(ownedReference(entry) && isInside(resolve(dirname(path), entry), root)),
  )
  if (plugin.length === config.plugin.length) {
    stats.skipped += 1
    return
  }
  config.plugin = plugin
  assertReviewedPath(path, reviewedPaths)
  touchedPaths.add(path)
  rewrittenPaths.add(path)
  const content = `${JSON.stringify(config, null, 2)}\n`
  if (dryRun) {
    if (!quietPreview)
      console.log('  ~ Would update tui.json (remove Pantheon-owned plugin references)')
  } else {
    assertNoSymlinkAncestors(path)
    writeFileSync(path, content, 'utf8')
    verifyRegularFile(path, content)
  }
  stats.removed += 1
}

/**
 * Undo the V2 client-config directive that cancels the builtin Context block.
 *
 * `init` (V2, global, `plugins` component) appends
 * {@link CONTEXT_SIDEBAR_NEGATION} to `<configDir>/cli.json` so Pantheon's TUI
 * plugin can draw the Context block itself. Leaving that negation behind while
 * removing the TUI plugin does not just leave a stale entry: it DISABLES the
 * host's native block with no replacement installed, and `cli.json` is not a
 * file the remaining cleanup would ever revisit. So uninstall must undo exactly
 * the same edit install made.
 *
 * Mirrors {@link applyContextSidebarNegation} on the write path: only the exact
 * directive is dropped (`withContextSidebarEnabled`), every other entry — plain
 * strings and `{ package, options }` objects — and every other key keeps its
 * order, and the write goes through `writeConfigWithBackup` with the raw text
 * as `expectedContent`, so a concurrent edit is never clobbered.
 *
 * Removal policy:
 *   - only the negation present → nothing to do, skipped;
 *   - after the removal `plugins` is empty AND it was the only key → the file
 *     carries nothing but our directive, so the whole file goes;
 *   - otherwise the file stays (it is the user's config, possibly with other
 *     plugins and keys).
 *
 * Unparseable JSON — or a `plugins` value that is not an array — is never
 * touched: warn and continue.
 *
 * @param {string} configDir - config dir that holds cli.json
 * @param {boolean} dryRun - report the action without writing
 * @param {string} root - target root every removal must stay inside
 * @param {Set<string>|null} [reviewedPaths] - paths reviewed in the plan
 */
function cleanV2CliConfig(configDir, dryRun, root, reviewedPaths = null) {
  const path = join(configDir, V2_CLI_CONFIG_FILENAME)
  const info = lstat(path)
  if (!info?.isFile() || info.isSymbolicLink()) {
    stats.skipped += 1
    return
  }
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    stats.skipped += 1
    return
  }
  let config
  try {
    config = JSON.parse(raw)
  } catch {
    if (!quietPreview) console.warn(`  ⚠️ Left ${path} untouched: it is not valid JSON.`)
    stats.skipped += 1
    return
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    stats.skipped += 1
    return
  }
  if (!Array.isArray(config.plugins)) {
    stats.skipped += 1
    return
  }

  const next = withContextSidebarEnabled(config.plugins)
  if (!next.changed) {
    stats.skipped += 1
    return
  }
  assertReviewedPath(path, reviewedPaths)

  // `{ plugins: [] }` and nothing else is the stub this installer created; an
  // empty leftover would be orphaned by the rest of the uninstall.
  if (next.plugins.length === 0 && Object.keys(config).length === 1) {
    removePath(path, dryRun, root, path, reviewedPaths)
    return
  }

  config.plugins = next.plugins
  const content = `${JSON.stringify(config, null, 2)}\n`
  touchedPaths.add(path)
  rewrittenPaths.add(path)
  if (dryRun) {
    if (!quietPreview)
      console.log(`  ~ Would update ${V2_CLI_CONFIG_FILENAME} (remove ${CONTEXT_SIDEBAR_NEGATION})`)
    stats.removed += 1
    return
  }
  const status = writeConfigWithBackup(path, content, dryRun, { expectedContent: raw })
  if (status === 'conflict') {
    // Edited under us between the read and the swap: keep the newer bytes.
    console.warn(`  ⚠️ Left ${path} untouched: it changed during the uninstall.`)
    stats.skipped += 1
    return
  }
  stats.removed += 1
}

function resetRunState() {
  stats.removed = 0
  stats.skipped = 0
  stats.errors = 0
  touchedPaths = new Set()
  rewrittenPaths = new Set()
}

function collectUninstallPlan(target, options = {}) {
  resetRunState()
  const previousQuiet = quietPreview
  quietPreview = true
  try {
    const paths = runUninstallPass(target, true, options) ?? []
    return {
      paths,
      snapshots: paths.map((path) => ({ path, ...snapshot(path) })),
    }
  } finally {
    quietPreview = previousQuiet
  }
}

function uninstallOpenCode(target, dryRun, options = {}) {
  resetRunState()
  if (dryRun) {
    const paths = runUninstallPass(target, true, options) ?? []
    return { paths, snapshots: paths.map((path) => ({ path, ...snapshot(path) })) }
  }

  const reviewed = options.reviewedPlan ?? collectUninstallPlan(target, options)
  const root = resolve(target)
  const reviewedPaths = new Set(reviewed.paths)
  if (reviewedPaths.size !== reviewed.paths.length) {
    throw new Error('Uninstall reviewed plan contains duplicate paths')
  }
  const reviewedSnapshotPaths = new Set(reviewed.snapshots.map((item) => item.path))
  if (
    reviewedSnapshotPaths.size !== reviewed.snapshots.length ||
    reviewedSnapshotPaths.size !== reviewedPaths.size ||
    [...reviewedPaths].some((path) => !reviewedSnapshotPaths.has(path))
  ) {
    throw new Error('Uninstall reviewed plan operation set is invalid')
  }
  const currentPlan = collectUninstallPlan(target, options)
  const currentPaths = [...currentPlan.paths].sort()
  const expectedPaths = [...reviewedPaths].sort()
  if (JSON.stringify(currentPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('Uninstall operation set drifted before backup')
  }
  for (const expected of reviewed.snapshots) {
    if (!isInside(expected.path, root))
      throw new Error(`Uninstall path escaped target: ${expected.path}`)
    const current = { path: expected.path, ...snapshot(expected.path) }
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`Uninstall target drifted before backup: ${expected.path}`)
    }
  }

  const backupEntries = reviewed.paths.filter((path) => {
    const info = lstat(path)
    return info?.isFile() && !info.isSymbolicLink()
  })
  let backupDir = null
  if (backupEntries.length > 0) {
    const backup = createBackupSet({
      configDir: root,
      entries: backupEntries.map((path) => relative(root, path)),
      packageVersion: 'uninstall',
      keep: 0,
    })
    backupDir = backup.dir
    console.warn(backupWarning(backup.dir))
  }

  const applyPlan = collectUninstallPlan(target, options)
  if (JSON.stringify([...applyPlan.paths].sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error('Uninstall operation set drifted after backup')
  }
  for (const expected of reviewed.snapshots) {
    const current = { path: expected.path, ...snapshot(expected.path) }
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`Uninstall target drifted after backup: ${expected.path}`)
    }
  }

  resetRunState()
  const paths = runUninstallPass(target, false, { ...options, reviewedPaths }) ?? []
  return { paths, backupDir }
}

function dirname(path) {
  return path.slice(0, path.lastIndexOf('/'))
}

async function confirmPrompt(message) {
  if (!isatty(process.stdin.fd) || !isatty(process.stdout.fd)) return false
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((answer) =>
    readline.question(message, (value) => {
      readline.close()
      answer(['y', 'yes'].includes(value.trim().toLowerCase()))
    }),
  )
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) return showHelp()
  const info = lstat(args.target)
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new Error(`Target directory does not exist or is a symlink: ${args.target}`)
  const reviewedPlan = collectUninstallPlan(args.target, { purgeData: args.purgeData })
  const hasChanges = reviewedPlan.paths.length > 0
  console.log(`${args.dryRun ? '🔍 Dry-run' : '🗑️ Uninstall'}: OpenCode/Pantheon only`)
  for (const path of reviewedPlan.paths) {
    const purge =
      args.purgeData && path === join(resolve(args.target), '.pantheon', 'install-state.json')
    const update = rewrittenPaths.has(path) && !purge
    console.log(`  ${purge ? 'PURGE DATA' : update ? 'UPDATE' : 'REMOVE'} ${path}`)
  }
  if (args.dryRun) {
    console.log(
      `✅ ${stats.removed} would change, ${stats.skipped} skipped, ${stats.errors} errors`,
    )
    return
  }
  if (hasChanges && !args.force) {
    if (!isatty(process.stdin.fd) || !isatty(process.stdout.fd)) {
      console.error('❌ Non-interactive uninstall requires explicit --force authorization.')
      process.exitCode = 2
      return
    }
    if (!(await confirmPrompt(`⚠️ Apply this uninstall plan for ${args.target}? [y/N] `))) {
      console.log('❌ Uninstall cancelled; no files were changed.')
      return
    }
  }
  uninstallOpenCode(args.target, false, { purgeData: args.purgeData, reviewedPlan })
  console.log(`✅ ${stats.removed} removed, ${stats.skipped} skipped, ${stats.errors} errors`)
  if (stats.errors) process.exitCode = 1
}

export {
  cleanOpenCodeConfig,
  isPantheonContent,
  main,
  parseArgs,
  resolveGlobalTarget,
  uninstallOpenCode,
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname))
  main().catch((error) => {
    console.error(`❌ Uninstall failed: ${error.message}`)
    process.exit(1)
  })
