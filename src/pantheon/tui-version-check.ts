/**
 * tui-version-check.ts — Runtime staleness check for the TUI plugin copy
 *
 * Compares the version in the user's copied TUI plugin package.json against
 * the version of the installed pantheon-opencode package. If mismatched,
 * logs a one-time warning. Does NOT auto-sync (safety first).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..', '..')

/**
 * Detect the user's OpenCode config directory (same logic as sync-tui.mjs).
 * Priority: $XDG_CONFIG_HOME/opencode → ~/.opencode → null
 */
function resolveConfigDir(): string | null {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const xdgDir = join(xdgConfig, 'opencode')
  if (existsSync(xdgDir)) return xdgDir

  const homeDir = join(homedir(), '.opencode')
  if (existsSync(homeDir)) return homeDir

  return null
}

/**
 * Read the `version` field from a package.json, or null on failure.
 */
function readVersion(pkgPath: string): string | null {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || null
  } catch {
    return null
  }
}

/**
 * Run the TUI version staleness check. Call once at plugin init.
 *
 * @param logger - Logging function (defaults to console.warn)
 */
export function checkTuiVersionStaleness(
  logger: (msg: string) => void = console.warn,
): void {
  try {
    const configDir = resolveConfigDir()
    if (!configDir) return // Not initialized — nothing to check

    const tuiCopyDir = join(configDir, 'plugins', 'pantheon-tui')
    if (!existsSync(tuiCopyDir)) return // TUI not installed

    const copyVersion = readVersion(join(tuiCopyDir, 'package.json'))
    if (!copyVersion) return // Can't read version — skip

    // Read the installed package version from the repo root's package.json
    const currentVersion = readVersion(join(ROOT, 'package.json'))
    if (!currentVersion) return // Can't determine current version — skip

    if (copyVersion !== currentVersion) {
      logger(
        `⚠️  TUI plugin v${copyVersion} is outdated. Current: v${currentVersion}. Run: npx pantheon-opencode init`,
      )
    }
  } catch {
    // Fail-open — version check must never block plugin initialization
  }
}
