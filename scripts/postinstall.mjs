#!/usr/bin/env node
/**
 * postinstall.mjs — Pantheon OpenCode npm lifecycle hook
 *
 * Runs cleanly on `opencode plugin add pantheon-opencode` / `npm install`:
 *   1. Validates Node.js >= 26.3.0.
 *   2. Automatically migrates legacy stores and cleans obsolete Python MCPs,
 *      copied TUI/agent/command/skill artifacts, and `.venv` under the user's
 *      OpenCode config directory (safe, zero file copying, zero `npm ci`).
 */
import {
  ensureLegacyStoresMigratedOnce,
  resolveSafeGlobalConfigDir,
  resolveSafeNpmCacheHome,
} from '../src/pantheon/legacy-store-migration.mjs'
import { isSupportedNodeVersion, unsupportedNodeVersionMessage } from './node-engine-policy.mjs'

try {
  if (!isSupportedNodeVersion(process.versions.node)) {
    console.warn(
      `⚠️ Pantheon postinstall skipped because this runtime is unsupported.\n${unsupportedNodeVersionMessage(process.versions.node)}\n   Switch to Node.js >= 26.3.0 before using Pantheon.`,
    )
  } else {
    let cleanedCount = 0
    try {
      const globalConfigDir = resolveSafeGlobalConfigDir()
      if (globalConfigDir) {
        const npmHome = resolveSafeNpmCacheHome()
        const report = ensureLegacyStoresMigratedOnce(globalConfigDir, {
          isGlobalConfig: true,
          cleanCopiedInstallArtifacts: true,
          ...(npmHome ? { homeDir: npmHome } : {}),
        })
        cleanedCount = report?.staleFilesDeleted?.length ?? 0
      }
    } catch {
      /* fail-open: never fail package installation over best-effort cleanup */
    }

    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  Pantheon OpenCode — native plugin ready ✅')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('')
    console.log('  Use inside OpenCode 2.x (zero extra install steps needed):')
    console.log('    opencode plugin add pantheon-opencode')
    if (cleanedCount > 0) {
      console.log(`  Auto-cleaned ${cleanedCount} legacy CLI/Python/TUI artifact(s) safely.`)
    }
    console.log('  Manage maintenance & legacy data purge inside OpenCode:')
    console.log('    /pantheon-settings  (Updates -> Legacy, Drift & Cleanup)')
    console.log('')
  }
} catch (err) {
  console.error(`❌ Post-install check failed: ${err.message}`)
  process.exit(1)
}
