#!/usr/bin/env node

/** Remove only files and registrations owned by Pantheon for OpenCode. */
import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { isatty } from 'node:tty'

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

function showHelp() {
  console.log(`

Usage:
  node scripts/uninstall.mjs [--project|--global] [--target /path] [--dry-run] [--force]

Target may be a project directory (containing .opencode), or a flat global
OpenCode directory (~/.config/opencode or ~/.opencode). Symlinks are rejected.
`)
}

function parseArgs(argv) {
  const args = { target: process.cwd(), dryRun: false, force: false, help: false, scope: 'project' }
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

function removePath(path, dryRun, root, label = path) {
  if (!isInside(path, root) || isSymlink(path)) {
    stats.skipped += 1
    return false
  }
  const info = lstat(path)
  if (!info) {
    stats.skipped += 1
    return false
  }
  if (dryRun) console.log(`  ~ Would remove ${label}`)
  else {
    try {
      rmSync(path, { recursive: info.isDirectory(), force: false })
    } catch (error) {
      console.error(`  ⚠️ Failed to remove ${path}: ${error.message}`)
      stats.errors += 1
      return false
    }
  }
  stats.removed += 1
  return true
}

function removeMatchingEntries(directory, predicate, dryRun, root) {
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
    if (predicate(path, entry)) removePath(path, dryRun, root, path)
    else if (child.isDirectory()) removeMatchingEntries(path, predicate, dryRun, root)
  }
  const remaining = lstat(directory)
  if (remaining?.isDirectory() && readdirSync(directory).length === 0)
    removePath(directory, dryRun, root, directory)
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

function cleanOpenCodeConfig(target, dryRun, ownedRoot = target) {
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
  if (dryRun) console.log('  ~ Would update opencode.json (remove Pantheon-owned entries)')
  else writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  stats.removed += 1
}

function configDirFor(target) {
  const name = basename(target)
  const looksFlat = lstat(join(target, 'agents'))?.isDirectory() === true
  return name === '.opencode' || name === 'opencode' || looksFlat
    ? target
    : join(target, '.opencode')
}

function uninstallOpenCode(target, dryRun) {
  const root = resolve(target)
  if (isSymlink(root)) throw new Error(`Target must not be a symlink: ${root}`)
  const configDir = configDirFor(root)
  const configInfo = lstat(configDir)
  if (configInfo?.isSymbolicLink()) {
    stats.skipped += 1
    return
  }
  const ownedRoot = root
  cleanOpenCodeConfig(root, dryRun, ownedRoot)
  removeMatchingEntries(
    join(configDir, 'agents'),
    (_path, name) => AGENT_NAMES.has(name.replace(/\.md$/, '')) && isPantheonContent(_path),
    dryRun,
    ownedRoot,
  )
  for (const directory of ['skills', 'commands', 'plugins'])
    removeMatchingEntries(join(configDir, directory), isPantheonContent, dryRun, ownedRoot)
  for (const file of ['package.json', 'tsconfig.json', 'routing.yml']) {
    const path = join(configDir, file)
    if (file === 'routing.yml' ? isPantheonRouting(path) : isPantheonContent(path))
      removePath(path, dryRun, ownedRoot, path)
  }
  const tui = join(configDir, 'tui.json')
  cleanTuiConfig(tui, dryRun, ownedRoot)
  const agentsMd = join(root, 'AGENTS.md')
  if (isPantheonContent(agentsMd)) removePath(agentsMd, dryRun, ownedRoot, agentsMd)
  if (configInfo?.isDirectory() && readdirSync(configDir).length === 0)
    removePath(configDir, dryRun, ownedRoot, configDir)
}

function cleanTuiConfig(path, dryRun, root) {
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
  if (dryRun) console.log('  ~ Would update tui.json (remove Pantheon-owned plugin references)')
  else writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  stats.removed += 1
}

function dirname(path) {
  return path.slice(0, path.lastIndexOf('/'))
}

async function confirmPrompt(message) {
  if (!isatty(process.stdin.fd)) return true
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
  if (
    !args.dryRun &&
    !args.force &&
    !(await confirmPrompt(`⚠️ Remove Pantheon OpenCode artifacts from ${args.target}? [y/N] `))
  )
    return console.log('❌ Uninstall cancelled.')
  console.log(`${args.dryRun ? '🔍 Dry-run' : '🗑️ Uninstall'}: OpenCode/Pantheon only`)
  uninstallOpenCode(args.target, args.dryRun)
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
