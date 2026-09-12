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
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// ── npm env hygiene ────────────────────────────────────────────────────

/**
 * npm lifecycle env vars that put a nested `npm ci` into global context and
 * make it abort with ECIGLOBAL ("`npm ci` does not work for global packages").
 * When the package itself is installed with `npm install -g`, npm injects these
 * into the postinstall environment; the TUI dependency sync is a local
 * operation and must never inherit them.
 */
const GLOBAL_NPM_ENV_KEYS = new Set([
  'npm_config_global',
  'npm_config_globalconfig',
  'npm_config_prefix',
  'npm_config_location',
])

/**
 * Return a copy of `env` with global-context npm config vars removed.
 * Matching is case-insensitive so Windows-style uppercase keys are handled.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizeNpmEnv(env = process.env) {
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (GLOBAL_NPM_ENV_KEYS.has(key.toLowerCase())) delete clean[key]
  }
  return clean
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  try {
    const configDir = resolveConfigDir()
    if (!configDir) {
      // User hasn't run init yet — silent exit, no error
      process.exit(0)
    }

    const tuiCopyDir = join(configDir, 'plugins', 'pantheon-tui')
    if (!existsSync(tuiCopyDir)) {
      // beta.5: no TUI install (plugins component omitted) — skip the TUI
      // sync but STILL refresh the copy-only artifacts below.
      const { syncCopyArtifacts } = await import('./sync-artifacts.mjs')
      const synced = syncCopyArtifacts(configDir)
      if (synced.errors.length > 0) {
        for (const e of synced.errors) console.error(`  ⚠️  artifact sync: ${e}`)
      }
      console.log(`  Artifacts synced: ${synced.created} updated, ${synced.skipped} already current`)
      return
    }

    // Source: TUI plugin inside the installed package
    const tuiSrcDir = join(ROOT, 'src', 'plugins', 'tui')
    if (!existsSync(tuiSrcDir)) {
      throw new Error(`TUI plugin source not found: ${tuiSrcDir}`)
    }

    // Compare versions before copy
    const installedVersion = readVersion(join(tuiCopyDir, 'package.json'))
    const sourceVersion = readVersion(join(tuiSrcDir, 'package.json'))

    // Copy fresh files
    const { created } = copyPluginFiles(tuiSrcDir, tuiCopyDir)

    // Lockfile installation is the only accepted dependency path. Strip
    // global-context npm vars so a global postinstall can't trigger ECIGLOBAL.
    execSync('npm ci --omit=dev --no-audit --no-fund', {
      cwd: tuiCopyDir,
      stdio: 'pipe',
      env: sanitizeNpmEnv(),
    })

    // Log result
    if (installedVersion && sourceVersion && installedVersion === sourceVersion && created === 0) {
      console.log(`  TUI plugin already up to date (v${sourceVersion})`)
    } else {
      console.log(
        `  TUI plugin updated to v${sourceVersion || 'latest'}${installedVersion ? ` (was v${installedVersion})` : ''}`,
      )
    }

    // ── beta.5 freshness guarantee: refresh ALL copy-only artifacts ──
    // Agents, skills, AGENTS.md, commands, MCP scripts, code-mode payload.
    // The plugin references in opencode.json already point INTO this package,
    // so only the copies would go stale after a package update.
    const { syncCopyArtifacts } = await import('./sync-artifacts.mjs')
    const { readState, writeState } = await import('./install/state.mjs')
    const pkgVersion = readVersion(join(ROOT, 'package.json')) ?? 'unknown'
    const synced = syncCopyArtifacts(configDir)
    if (synced.errors.length > 0) {
      for (const e of synced.errors) console.error(`  ⚠️  artifact sync: ${e}`)
    }
    console.log(
      `  Artifacts synced: ${synced.created} updated, ${synced.skipped} already current`,
    )

    // Version marker so doctor can detect a stale installation and point the
    // user at `pantheon-opencode update` for the full refresh (config merge,
    // venv, MCP entries).
    try {
      const previous = readState(configDir)
      writeState(configDir, {
        pantheon_version: pkgVersion,
        previous_version: previous?.pantheon_version ?? null,
      })
      if (previous?.pantheon_version && previous.pantheon_version !== pkgVersion) {
        console.log(
          `  ⚠️  Installation moved ${previous.pantheon_version} → ${pkgVersion}. ` +
            'Run `npx pantheon-opencode init` to refresh config/venv/MCP entries.',
        )
      }
    } catch {
      // Marker is best-effort — never fail the postinstall over it.
    }
  } catch (err) {
    console.error(`❌ TUI sync failed: ${err.message}`)
    process.exitCode = 1
  }
}

// Only run when invoked directly (`node scripts/sync-tui.mjs`). Importing this
// module for unit tests must not trigger the side-effecting postinstall sync.
const isDirectRun =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  main().catch((err) => {
    console.error(`❌ TUI sync failed: ${err.message}`)
    process.exitCode = 1
  })
}
