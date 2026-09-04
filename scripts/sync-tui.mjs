#!/usr/bin/env node
/**
 * sync-tui.mjs — Postinstall hook: sync TUI plugin to user's OpenCode config
 *
 * Runs automatically after `npm install pantheon-opencode@latest`. Detects the
 * user's OpenCode config directory and, if the TUI plugin was previously
 * installed (via `npx pantheon-opencode init`), copies fresh files from the
 * installed package and refreshes dependencies.
 *
 * If the user hasn't initialized yet → do nothing (silent exit).
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Write content to filePath only if it differs from what's on disk.
 * @returns {boolean} true if file was written (changed), false if skipped
 */
function writeIfChanged(filePath, content) {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null
  if (existing === content) return false
  writeFileSync(filePath, content, 'utf8')
  return true
}

/**
 * Read the `version` field from a package.json, or null on failure.
 */
function readVersion(pkgPath) {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || null
  } catch {
    return null
  }
}

/**
 * Resolve the user's OpenCode config directory.
 * Priority: $XDG_CONFIG_HOME/opencode → ~/.opencode → null (not initialized)
 */
function resolveConfigDir() {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const xdgDir = join(xdgConfig, 'opencode')
  if (existsSync(xdgDir)) return xdgDir

  const homeDir = join(homedir(), '.opencode')
  if (existsSync(homeDir)) return homeDir

  return null
}

/**
 * Copy plugin runtime files (dist/*, package.json, package-lock.json,
 * src/index.tsx) from srcDir
 * to dstDir. Skips files that are byte-identical.
 * @returns {{ created: number, skipped: number }}
 */
function copyPluginFiles(srcDir, dstDir) {
  const result = { created: 0, skipped: 0 }

  mkdirSync(dstDir, { recursive: true })
  mkdirSync(join(dstDir, 'dist'), { recursive: true })

  // src/index.tsx → index.tsx
  const srcIdx = join(srcDir, 'src', 'index.tsx')
  if (existsSync(srcIdx)) {
    const content = readFileSync(srcIdx, 'utf8')
    if (writeIfChanged(join(dstDir, 'index.tsx'), content)) result.created++
    else result.skipped++
  }

  // dist/*
  const distSrc = join(srcDir, 'dist')
  if (existsSync(distSrc)) {
    for (const f of readdirSync(distSrc)) {
      const content = readFileSync(join(distSrc, f), 'utf8')
      if (writeIfChanged(join(dstDir, 'dist', f), content)) result.created++
      else result.skipped++
    }
  }

  // package.json
  const pkgSrc = join(srcDir, 'package.json')
  if (existsSync(pkgSrc)) {
    const content = readFileSync(pkgSrc, 'utf8')
    if (writeIfChanged(join(dstDir, 'package.json'), content)) result.created++
    else result.skipped++
  }

  // Keep the copied plugin installable with deterministic npm ci.
  const lockSrc = join(srcDir, 'package-lock.json')
  if (existsSync(lockSrc)) {
    const content = readFileSync(lockSrc, 'utf8')
    if (writeIfChanged(join(dstDir, 'package-lock.json'), content)) result.created++
    else result.skipped++
  }

  return result
}

// ── Main ───────────────────────────────────────────────────────────────

try {
  const configDir = resolveConfigDir()
  if (!configDir) {
    // User hasn't run init yet — silent exit, no error
    process.exit(0)
  }

  const tuiCopyDir = join(configDir, 'plugins', 'pantheon-tui')
  if (!existsSync(tuiCopyDir)) {
    // TUI plugin not installed — silent exit
    process.exit(0)
  }

  // Source: TUI plugin inside the installed package
  const tuiSrcDir = join(ROOT, 'src', 'plugins', 'tui')
  if (!existsSync(tuiSrcDir)) {
    // Source not found (shouldn't happen in a proper install)
    process.exit(0)
  }

  // Compare versions before copy
  const installedVersion = readVersion(join(tuiCopyDir, 'package.json'))
  const sourceVersion = readVersion(join(tuiSrcDir, 'package.json'))

  // Copy fresh files
  const { created } = copyPluginFiles(tuiSrcDir, tuiCopyDir)

  // Refresh dependencies in the copy. npm install is only allowed when the
  // operator explicitly opts into the non-deterministic legacy fallback.
  try {
    execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: tuiCopyDir, stdio: 'pipe' })
  } catch (err) {
    if (process.env.PANTHEON_ALLOW_NPM_INSTALL_FALLBACK === '1') {
      console.warn(`⚠️  npm ci failed; explicit fallback enabled: ${err.message}`)
      try {
        execSync('npm install --omit=dev --no-audit --no-fund --package-lock=false', {
          cwd: tuiCopyDir,
          stdio: 'pipe',
        })
      } catch (fallbackError) {
        console.warn(`⚠️  TUI dependency refresh skipped: ${fallbackError.message}`)
      }
    } else {
      console.warn(
        `⚠️  TUI dependency refresh skipped after npm ci failure. Set ` +
          `PANTHEON_ALLOW_NPM_INSTALL_FALLBACK=1 to explicitly allow npm install: ${err.message}`,
      )
    }
  }

  // Log result
  if (installedVersion && sourceVersion && installedVersion === sourceVersion && created === 0) {
    console.log(`  TUI plugin already up to date (v${sourceVersion})`)
  } else {
    console.log(
      `  TUI plugin updated to v${sourceVersion || 'latest'}${installedVersion ? ` (was v${installedVersion})` : ''}`,
    )
  }
} catch (err) {
  // Postinstall scripts must never break npm install
  console.warn(`⚠️  TUI sync skipped: ${err.message}`)
  process.exit(0)
}
