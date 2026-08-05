#!/usr/bin/env node
/**
 * prune.mjs — Pantheon legacy cleanup CLI (issue #22)
 *
 * Finds and (with explicit flags) removes legacy artifacts left by previous
 * Pantheon versions — old global installs, stale config backups, dead
 * legacy config directories — following the XDG Base Directory spec.
 *
 * SAFETY: prune NEVER touches the active config, the active venv, the package
 * repo, or the installed package. It only:
 *   - lists old global `pantheon` installs (suggests `npm uninstall -g pantheon`)
 *   - removes stale `opencode.json.bak*` backups (age > threshold) with --apply
 *   - lists legacy directories whose opencode.json references dead/relative
 *     paths (removal requires --apply --remove-dirs as explicit confirmation)
 *
 * Usage:
 *   node scripts/prune.mjs                        # dry-run (default): list only
 *   node scripts/prune.mjs --apply                # remove stale backups
 *   node scripts/prune.mjs --apply --remove-dirs  # also remove legacy dirs
 *   node scripts/prune.mjs --target <dir>         # override config dir (tests)
 *   node scripts/prune.mjs --age 30               # backup age threshold (days)
 *   node scripts/prune.mjs --help
 *
 * Exit codes:
 *   0 = nothing to clean (or everything cleaned)
 *   1 = findings remain (dry-run listed items, or items kept)
 *   2 = usage error
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DEFAULT_BACKUP_AGE_DAYS = 30

// ---------------------------------------------------------------------------
// XDG config resolution — parity with _pantheon_paths.py and bin/pantheon-init
//   PANTHEON_HOME → $XDG_CONFIG_HOME/opencode → ~/.config/opencode
// ---------------------------------------------------------------------------

export function resolveConfigDir(target) {
  if (target) return resolve(target)
  if (process.env.PANTHEON_HOME) return resolve(process.env.PANTHEON_HOME)
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'opencode')
}

// ---------------------------------------------------------------------------
// Finding model
// ---------------------------------------------------------------------------

/**
 * @typedef {{ type: string, target: string, detail: string, action: 'suggest'|'remove'|'list'|'keep' }} Finding
 */

/** @type {Finding[]} */
const findings = []

function add(type, target, detail, action) {
  findings.push({ type, target, detail, action })
}

// ---------------------------------------------------------------------------
// (a) Old global `pantheon` install (private package, never published)
//     → suggestion only: NEVER remove node_modules directly (npm-managed).
// ---------------------------------------------------------------------------

export function findLegacyGlobalInstalls() {
  const nodeModulesDirs = new Set()
  const knownLegacy = join(homedir(), '.npm-global', 'lib', 'node_modules')
  if (existsSync(knownLegacy)) nodeModulesDirs.add(knownLegacy)
  try {
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim()
    if (npmPrefix) nodeModulesDirs.add(join(npmPrefix, 'lib', 'node_modules'))
  } catch {
    // npm unavailable — fall back to the known legacy location only
  }

  for (const dir of nodeModulesDirs) {
    // `pantheon` (legacy name) — NOT `pantheon-opencode` (current package)
    const pkgDir = join(dir, 'pantheon')
    const pkgJsonPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
      if (pkg.name === 'pantheon' && pkg.private === true) {
        add(
          'global-install',
          pkgDir,
          `legacy private package pantheon@${pkg.version || '?'} — bin 'pantheon' conflicts with pantheon-opencode`,
          'suggest',
        )
      }
    } catch {
      // unreadable package.json — skip
    }
  }
}

// ---------------------------------------------------------------------------
// (b) Stale opencode.json.bak* backups (age > threshold) in the config dir
//     → removable with --apply. Fresh backups are listed as kept.
// ---------------------------------------------------------------------------

export function findStaleBackups(configDir, maxAgeDays = DEFAULT_BACKUP_AGE_DAYS) {
  if (!existsSync(configDir)) return
  const cutoffMs = Date.now() - maxAgeDays * 86_400_000
  for (const name of readdirSync(configDir)) {
    if (!name.startsWith('opencode.json.bak')) continue
    const full = join(configDir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    const ageDays = Math.floor((Date.now() - st.mtimeMs) / 86_400_000)
    if (st.mtimeMs < cutoffMs) {
      add('backup', full, `age ~${ageDays}d > ${maxAgeDays}d threshold`, 'remove')
    } else {
      add('backup-fresh', full, `age ~${ageDays}d ≤ ${maxAgeDays}d — kept`, 'keep')
    }
  }
}

// ---------------------------------------------------------------------------
// (c) Legacy directories with dead config (relative/nonexistent paths)
//     → listed only; removal needs --apply --remove-dirs (explicit confirm).
// ---------------------------------------------------------------------------

const LEGACY_DIR_NAMES = ['pantheon-legacy', 'legacy', 'old', 'backup', 'backups']

/** Collect opencode.json candidates inside a dir (depth ≤ 2). */
function collectConfigCandidates(dir) {
  const candidates = []
  const walk = (d, depth) => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name === 'opencode.json') candidates.push(full)
    }
  }
  walk(dir, 0)
  return candidates
}

/** True when an opencode.json references relative or non-existent paths. */
export function configHasDeadPaths(configPath) {
  let cfg
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return true // unparseable config in a legacy dir counts as dead
  }

  const check = (value, where) => {
    if (typeof value !== 'string' || value === '') return
    if (value.startsWith('file://')) return
    if (!value.startsWith('/')) return true // relative path in a config
    if (!existsSync(value)) return true // absolute but missing
    return false
  }

  // agent sources
  for (const agent of Object.values(cfg.agent || {})) {
    if (agent && typeof agent === 'object' && check(agent.source, 'agent.source')) return true
  }
  // instructions
  for (const instr of cfg.instructions || []) {
    if (check(instr, 'instructions')) return true
  }
  // mcp cwd + command[0] (when not a bare command name like python3)
  for (const [key, mcp] of Object.entries(cfg.mcp || {})) {
    if (!mcp || typeof mcp !== 'object') continue
    if (mcp.cwd && check(mcp.cwd, `mcp.${key}.cwd`)) return true
    const cmd = Array.isArray(mcp.command) ? mcp.command[0] : undefined
    if (cmd && typeof cmd === 'string' && cmd.includes('/') && check(cmd, `mcp.${key}.command`)) {
      return true
    }
  }
  return false
}

export function findLegacyDirs(configDir) {
  if (!existsSync(configDir)) return
  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LEGACY_DIR_NAMES.includes(entry.name)) continue
    const dir = join(configDir, entry.name)
    const deadConfigs = collectConfigCandidates(dir).filter(configHasDeadPaths)
    if (deadConfigs.length > 0) {
      add(
        'legacy-dir',
        dir,
        `dead config(s): ${deadConfigs.map((c) => c.replace(dir + '/', '')).join(', ')}`,
        'list',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Extra: legacy `~/.opencode` install dir (pre-XDG location)
//     → listed only, manual review.
// ---------------------------------------------------------------------------

export function findLegacyInstallDir(configDir) {
  const legacyDir = join(homedir(), '.opencode')
  if (legacyDir === configDir) return
  if (!existsSync(join(legacyDir, 'opencode.json'))) return
  add(
    'legacy-install',
    legacyDir,
    'pre-XDG install location — review manually; not removed automatically',
    'list',
  )
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function format(f) {
  const icon =
    f.action === 'remove' ? '🗑️' : f.action === 'suggest' ? '💡' : f.action === 'keep' ? '✅' : '🔎'
  return `${icon} [${f.type}] ${f.target} — ${f.detail}`
}

export function runPrune({ configDir, maxAgeDays, apply, removeDirs }) {
  findLegacyGlobalInstalls()
  findStaleBackups(configDir, maxAgeDays)
  findLegacyDirs(configDir)
  findLegacyInstallDir(configDir)

  console.log(`Pantheon prune — config dir: ${configDir}`)
  console.log(`  mode: ${apply ? 'APPLY' : 'DRY-RUN'}${removeDirs ? ' + REMOVE-DIRS' : ''}`)
  console.log('')

  if (findings.length === 0) {
    console.log('  ✅ Nothing to clean.')
    return { removed: 0, remain: 0 }
  }

  let removed = 0
  let remain = 0
  for (const f of findings) {
    console.log(`  ${format(f)}`)
    if (f.action === 'remove' && apply) {
      try {
        rmSync(f.target, { force: true })
        console.log(`     → removed`)
        removed++
        continue
      } catch (err) {
        console.log(`     → ⚠️ failed: ${err.message}`)
        remain++
        continue
      }
    }
    if (f.action === 'remove' && !apply) {
      // dry-run: count as "would remove"
      removed++
      continue
    }
    if (f.action === 'list' && apply && removeDirs) {
      try {
        rmSync(f.target, { recursive: true, force: true })
        console.log(`     → removed (--remove-dirs)`)
        removed++
        continue
      } catch (err) {
        console.log(`     → ⚠️ failed: ${err.message}`)
        remain++
        continue
      }
    }
    if (f.action === 'list' && apply && !removeDirs) {
      console.log('     → kept: directory removal requires --apply --remove-dirs')
      remain++
    } else if (f.action === 'suggest') {
      console.log('     → action: npm uninstall -g pantheon (not run automatically)')
      remain++
    } else if (f.action === 'keep' || f.action === 'list') {
      remain++
    }
  }

  console.log('')
  const hint = apply ? '' : ' — run with --apply to remove stale backups'
  console.log(
    `  ${apply ? 'Removed' : 'Would remove'}: ${removed} item(s); remaining: ${remain}${hint}`,
  )
  return { removed, remain }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Pantheon prune — legacy cleanup (issue #22)

Usage:
  node scripts/prune.mjs [options]

Options:
  --apply            Remove stale backups (default: dry-run, list only)
  --remove-dirs      With --apply, also remove legacy directories
                     (explicit confirmation; default: list only)
  --target <dir>     Override the config directory (XDG-aware by default)
  --age <days>       Backup age threshold in days (default: ${DEFAULT_BACKUP_AGE_DAYS})
  --help             Show this help

Safety:
  Never removes: active opencode.json, active .venv, package repo, or the
  installed pantheon-opencode package. Old global 'pantheon' installs are
  only suggested for manual 'npm uninstall -g pantheon'.

Exit codes: 0 = clean, 1 = findings remain, 2 = usage error`)
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  const apply = args.includes('--apply') || args.includes('-y')
  const removeDirs = args.includes('--remove-dirs')
  const targetIdx = args.indexOf('--target')
  const target = targetIdx >= 0 ? args[targetIdx + 1] : undefined
  const ageIdx = args.indexOf('--age')
  const age = ageIdx >= 0 ? Number(args[ageIdx + 1]) : DEFAULT_BACKUP_AGE_DAYS
  if (!Number.isFinite(age) || age < 0) {
    console.error('❌ --age must be a non-negative number of days')
    process.exit(2)
  }

  const configDir = resolveConfigDir(target)
  const result = runPrune({ configDir, maxAgeDays: age, apply, removeDirs })

  // 0 = clean/cleaned; 1 = findings remain; 2 = usage error (handled above)
  process.exit(result.remain > 0 ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
