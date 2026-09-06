#!/usr/bin/env node
/**
 * pantheon-init.mjs — Pantheon OpenCode CLI entry point
 *
 * Usage: npx pantheon-opencode init [options]
 *
 * Thin CLI wrapper that parses arguments and delegates to
 * installOpenCode() from scripts/install/opencode.mjs.
 *
 * Dual-version install (Phase 3): the generated config is V1-shaped and valid
 * under BOTH OpenCode V1 (`opencode` 1.18.x) and V2 (`opencode2`
 * v0.0.0-next-17444). V2 reads the same config locations and normalizes V1
 * fields in memory — no native V2 conversion. `--version v2` labels the
 * install for the operator; state isolation is a runtime concern
 * (OPENCODE_DB ~/.local/share/opencode/opencode-v2.db, service port 49375).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const REQUIRED_NODE_MAJOR = 18
if (parseInt(process.versions.node.split('.')[0], 10) < REQUIRED_NODE_MAJOR) {
  console.error(`❌ Node.js >= ${REQUIRED_NODE_MAJOR} required (current: ${process.versions.node})`)
  process.exit(1)
}

function readVersion() {
  try {
    const pkgPath = path.join(ROOT, 'package.json')
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '?'
  } catch {
    return '?'
  }
}

function printUsage() {
  console.log('Pantheon OpenCode — Multi-agent orchestration platform')
  console.log('')
  console.log('Usage:')
  console.log('  npx pantheon-opencode init              # Install globally')
  console.log('  npx pantheon-opencode init --project    # Install in project')
  console.log('  npx pantheon-opencode init --dry-run    # Preview only')
  console.log('  npx pantheon-opencode init --no-mcp       # Skip MCP + venv')
  console.log('  npx pantheon-opencode init --force        # Overwrite + recreate venv')
  console.log('  npx pantheon-opencode init --doctor       # Run health check after install')
  console.log('  npx pantheon-opencode init --interactive  # Force interactive TUI mode')
  console.log('  npx pantheon-opencode init --headless     # Force non-interactive mode')
  console.log('  npx pantheon-opencode init -y             # Skip confirmations, use defaults')
  console.log('  npx pantheon-opencode init --opencode-version v1|v2|auto')
  console.log('  npx pantheon-opencode init --preset <name> # Install and activate model preset')
  console.log('  npx pantheon-opencode set-tier <name>      # Set active model preset (global)')
  console.log(
    '  npx pantheon-opencode set-tier <name> --project  # Set active model preset (project)',
  )
  console.log('  npx pantheon-opencode prune               # List legacy artifacts (dry-run)')
  console.log('  npx pantheon-opencode prune --apply       # Remove stale backups')
  console.log('  npx pantheon-opencode doctor [--profile]  # Run health check')
  console.log('  npx pantheon-opencode uninstall --project   # Remove project artifacts safely')
  console.log('  npx pantheon-opencode uninstall --global    # Remove global artifacts safely')
  console.log('  npx pantheon-opencode --version, -v       # Print version and exit')
  console.log('  npx pantheon-opencode --help              # Show this help')
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  // --version / -v: print the package version and exit. Must run before any
  // install/help dispatch so it never touches the filesystem beyond reading
  // package.json.
  if (command === '--version' || command === '-v') {
    console.log(readVersion())
    process.exit(0)
  }

  // prune handles its own --help (delegated to scripts/prune.mjs), so its
  // dispatch must run BEFORE the generic --help check.
  if (command === 'prune') {
    const { spawnSync } = await import('node:child_process')
    const pruneScript = path.join(ROOT, 'scripts', 'prune.mjs')
    const result = spawnSync(process.execPath, [pruneScript, ...args.slice(1)], {
      stdio: 'inherit',
      cwd: process.cwd(),
    })
    process.exit(result.status ?? 1)
  }

  if (command === 'uninstall') {
    const { spawnSync } = await import('node:child_process')
    const uninstallScript = path.join(ROOT, 'scripts', 'uninstall.mjs')
    const result = spawnSync(process.execPath, [uninstallScript, ...args.slice(1)], {
      stdio: 'inherit',
      cwd: process.cwd(),
    })
    process.exit(result.status ?? 1)
  }

  // doctor delegates to scripts/doctor.mjs (same spawnSync pattern as prune).
  // Forwarding the FULL args (profile, target, --fix, ...) keeps the packaged
  // CLI a thin wrapper; the doctor banner reports the resolved profile.
  if (command === 'doctor') {
    const { spawnSync } = await import('node:child_process')
    const doctorScript = path.join(ROOT, 'scripts', 'doctor.mjs')
    const result = spawnSync(process.execPath, [doctorScript, ...args.slice(1)], {
      stdio: 'inherit',
      cwd: ROOT,
    })
    process.exit(result.status ?? 1)
  }

  if (args.includes('--help')) {
    printUsage()
    process.exit(0)
  }

  if (command === 'set-tier') {
    const isProject = args.includes('--project')
    const isDryRun = args.includes('--dry-run')
    const name = args[1]

    const { loadPresetDefs } = await import('../src/pantheon/presets.mjs')
    const { writeActivePreset } = await import('../scripts/install/model-picker.mjs')
    const presets = loadPresetDefs()
    const presetList = `none, ${Object.keys(presets).join(', ')}`

    if (!name) {
      console.error('❌ set-tier requires a preset name')
      console.error(`   Available: ${presetList}`)
      process.exit(1)
    }
    if (name !== 'none' && !presets[name]) {
      console.error(`❌ Unknown preset "${name}"`)
      console.error(`   Available: ${presetList}`)
      process.exit(1)
    }

    // Fail-fast: every provider's API key env var must be set before writing
    if (name !== 'none') {
      for (const [pid, provider] of Object.entries(presets[name].providers || {})) {
        if (!process.env[provider.apiKeyEnv]) {
          console.error(`❌ Missing required API key configuration for provider "${pid}"`)
          console.error('   Set the provider API key environment variable and retry.')
          process.exit(1)
        }
      }
    }

    const presetDir = isProject
      ? process.cwd()
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode')
    const filePath = path.join(presetDir, '.pantheon', 'active-preset.json')
    const bakPath = path.join(presetDir, '.pantheon', 'active-preset.json.bak')

    let prevName = '(none)'
    if (fs.existsSync(filePath)) {
      try {
        prevName = JSON.parse(fs.readFileSync(filePath, 'utf8')).preset || '(unknown)'
      } catch {
        prevName = '(unknown)'
      }
    }

    if (name === 'none') {
      if (isDryRun) {
        console.log('[dry-run] Would clear model preset')
      } else {
        if (fs.existsSync(filePath)) {
          fs.mkdirSync(path.dirname(bakPath), { recursive: true })
          fs.copyFileSync(filePath, bakPath)
          fs.rmSync(filePath, { force: true })
        }
        console.log('Model preset cleared. Using opencode defaults.')
        console.log(`   Backup: ${bakPath}`)
      }
      return
    }

    const result = writeActivePreset(presetDir, name, { dryRun: isDryRun, source: 'cli' })

    console.log(`Model preset set: ${prevName} → ${name}`)
    for (const [agent, spec] of Object.entries(presets[name].agents || {})) {
      console.log(`   ${agent}: ${spec.model} [${spec.reasoning_effort}]`)
    }
    const providerNames = Object.keys(presets[name].providers || {})
    console.log(`   Providers: ${providerNames.join(', ') || 'none'}`)
    if (result.backupPath) console.log(`   Backup: ${result.backupPath}`)
    return
  }

  if (command === 'init' || !command) {
    const isProject = args.includes('--project')
    const isDryRun = args.includes('--dry-run')
    const skipMCP = args.includes('--no-mcp')
    const forceReinstall = args.includes('--force')
    const runDoctor = args.includes('--doctor')
    const forceInteractive = args.includes('--interactive')
    const forceHeadless = args.includes('--headless')
    const autoYes = args.includes('--yes') || args.includes('-y')
    const presetIndex = args.indexOf('--preset')
    const presetOpt = presetIndex >= 0 ? (args[presetIndex + 1] ?? null) : null
    // Explicit top-level model overrides for the generated config.
    const modelIndex = args.indexOf('--model')
    const modelOpt = modelIndex >= 0 ? (args[modelIndex + 1] ?? null) : null
    const smallModelIndex = args.indexOf('--small-model')
    const smallModelOpt = smallModelIndex >= 0 ? (args[smallModelIndex + 1] ?? null) : null
    // --version v1|v2 labels the install target (informational; the config is
    // shared and V1-shaped under both versions). Invalid values fail fast.
    const versionIndex = args.indexOf('--version')
    const legacyVersionIndex = args.indexOf('--opencode-version')
    const inlineVersion = args.find((arg) => arg.startsWith('--opencode-version='))
    const versionOpt =
      versionIndex >= 0
        ? (args[versionIndex + 1] ?? null)
        : legacyVersionIndex >= 0
          ? (args[legacyVersionIndex + 1] ?? null)
          : (inlineVersion?.split('=', 2)[1] ?? null)
    if (versionOpt !== null && versionOpt !== 'v1' && versionOpt !== 'v2') {
      console.error(`❌ Invalid --version "${versionOpt}" — expected v1 or v2`)
      process.exit(1)
    }

    const components = ['agents', 'skills', 'instructions', 'commands', 'plugins']
    if (!skipMCP) components.push('runtime')

    // Version info
    const version = readVersion()

    console.log('')
    if (!forceInteractive || isDryRun) {
      console.log(`Pantheon OpenCode v${version} — ${isDryRun ? 'DRY RUN' : 'Installing...'}`)
      console.log('')
    }

    try {
      const { installOpenCode } = await import('../scripts/install/opencode.mjs')
      const target = isProject ? process.cwd() : undefined
      await installOpenCode(target, isDryRun, forceReinstall, components, {
        interactive: forceInteractive,
        headless: forceHeadless,
        yes: autoYes,
        model: modelOpt,
        smallModel: smallModelOpt,
        preset: presetOpt,
        version: versionOpt ?? 'v1',
      })
    } catch (err) {
      console.error(
        `❌ Installation failed: ${err.message}\n   Run with --no-mcp to skip Python dependencies:\n     npx pantheon-opencode init --no-mcp\n   Or retry with --force to recreate the venv:\n     npx pantheon-opencode init --force`,
      )
      process.exit(1)
    }

    if (runDoctor && !isDryRun) {
      console.log('')
      console.log('  Running health check...')
      try {
        const { spawnSync } = await import('node:child_process')
        const doctorScript = path.join(ROOT, 'scripts', 'doctor.mjs')
        spawnSync(process.execPath, [doctorScript], { stdio: 'inherit', cwd: ROOT })
      } catch {
        console.log('  ⚠️  Could not run doctor.mjs')
      }
    }

    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  ✅ Pantheon OpenCode v${version} installed!`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('')
    console.log('  Next steps:')
    console.log('  1. Verify installation:')
    console.log('     npx pantheon-opencode doctor')
    console.log('  2. Launch OpenCode')
    console.log('  3. Invoke agents with @agent-name in chat')
    console.log('  4. For project-local install:')
    console.log('     npx pantheon-opencode init --project')
    console.log('')

    return
  }

  printUsage()
  process.exit(1)
}

main().catch((err) => {
  console.error('Error:', err.stack)
  process.exit(1)
})
