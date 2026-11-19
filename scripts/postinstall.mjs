#!/usr/bin/env node
/**
 * postinstall.mjs — Pantheon npm post-install hook
 *
 * Runs after `npm install` completes. Validates environment and prints
 * setup instructions. Does NOT install Pantheon platform components.
 */
import { isSupportedNodeVersion, unsupportedNodeVersionMessage } from './node-engine-policy.mjs'

try {
  // npm may warn about `engines.node`, but must still finish installing so the
  // bin can print the actionable hard-gate message. No Node-dependent setup is
  // attempted from an incompatible lifecycle runtime.
  if (!isSupportedNodeVersion(process.versions.node)) {
    console.warn(
      `⚠️ Pantheon postinstall skipped because this runtime is unsupported.\n${unsupportedNodeVersionMessage(process.versions.node)}\n   Switch to Node.js >= 26.4.0 before running Pantheon setup.`,
    )
  } else {
    // Validate js-yaml is available
    try {
      await import('js-yaml')
    } catch {
      console.warn('⚠️  js-yaml not found — run `npm install` to install dependencies')
    }

    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  Pantheon OpenCode — npm dependencies installed ✅')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('')
    console.log('  Next steps (OpenCode 2.x):')
    console.log('  1. Register the native plugin (works in any folder, no init needed):')
    console.log('     opencode plugin add pantheon-opencode')
    console.log('  2. Check health, updates & clean stale caches inside OpenCode:')
    console.log('     /pantheon-settings  (or: npx pantheon-opencode doctor)')
    console.log('  3. Optional CLI setup (project AGENTS.md / legacy Python MCP):')
    console.log('     npx pantheon-opencode init --project --no-mcp')
    console.log('')
  }
} catch (err) {
  console.error(`❌ Post-install check failed: ${err.message}`)
  process.exit(1)
}
