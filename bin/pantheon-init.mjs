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
 * under BOTH OpenCode V1 (`opencode` 1.18.x) and V2 (`opencode2`, OpenCode 2.x —
 * `opencode2 --version` prints "opencode v2.0.22"; an early 2.x prerelease
 * printed "0.0.0-next-17444", which is history and not a host observation).
 * V2 reads the same config locations and normalizes V1
 * fields in memory — no native V2 conversion. `--version v2` labels the
 * install for the operator; state isolation is a runtime concern
 * (OPENCODE_DB ~/.local/share/opencode/opencode-v2.db, service port 49375).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configure as configureUi, tag } from '../scripts/install/cli-ui.mjs'
import { resolveComponentSelection } from '../scripts/install/component-selection.mjs'
import { resolveInstallExitCode } from '../scripts/install/exit-codes.mjs'
import {
  createPlanArtifact,
  loadPlanArtifact,
  savePlanArtifact,
} from '../scripts/install/plan-artifact.mjs'
import { PROMPT_CANCELED } from '../scripts/install/prompt-result.mjs'
import {
  isSupportedNodeVersion,
  unsupportedNodeVersionMessage,
} from '../scripts/node-engine-policy.mjs'
import { runUpdate } from '../scripts/update.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

if (!isSupportedNodeVersion(process.versions.node)) {
  console.error(unsupportedNodeVersionMessage(process.versions.node))
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
  console.log('  npx pantheon-opencode init --dry-run --save-plan <file> # Save reviewed plan')
  console.log('  npx pantheon-opencode init --apply-plan <file> [--yes] # Apply reviewed plan')
  console.log('  npx pantheon-opencode init --dry-run --json # Versioned JSON preview')
  console.log('  npx pantheon-opencode init --verbose      # Step-by-step install detail')
  console.log('  npx pantheon-opencode init --no-mcp       # Skip MCP + venv')
  console.log('  npx pantheon-opencode init --force        # Overwrite + recreate venv')
  console.log('  npx pantheon-opencode init --doctor       # Run health check after install')
  console.log('  npx pantheon-opencode init --interactive  # Force interactive TUI mode')
  console.log('  npx pantheon-opencode init --headless     # Force non-interactive mode')
  console.log('  npx pantheon-opencode init -y             # Skip confirmations, use defaults')
  console.log('  npx pantheon-opencode init --components agents,skills,instructions')
  console.log('  npx pantheon-opencode init --opencode-version v1|v2|auto')
  console.log('  npx pantheon-opencode init --preset <name> # Install and activate model preset')
  console.log(
    '  npx pantheon-opencode init --merge-dev-config <path> # Merge a dev config (off by default)',
  )
  console.log('  npx pantheon-opencode set-tier <name>      # Set active model preset (global)')
  console.log(
    '  npx pantheon-opencode update [--stable]    # Update package + re-run init (default: beta channel)',
  )
  console.log(
    '  npx pantheon-opencode set-tier <name> --project  # Set active model preset (project)',
  )
  console.log('  npx pantheon-opencode prune               # List legacy artifacts (dry-run)')
  console.log('  npx pantheon-opencode prune --apply       # Remove stale backups')
  console.log('  npx pantheon-opencode doctor [--profile]  # Run health check')
  console.log(
    '  npx pantheon-opencode restore [--project] [--yes]  # Restore an exact installer backup',
  )
  console.log('  npx pantheon-opencode uninstall --project   # Remove project artifacts safely')
  console.log('  npx pantheon-opencode uninstall --global    # Remove global artifacts safely')
  console.log('  npx pantheon-opencode reconcile --project    # Review stale owned installer files')
  console.log('  npx pantheon-opencode --version, -v       # Print version and exit')
  console.log('  npx pantheon-opencode --help              # Show this help')
  console.log('')
  console.log('Apply authorization:')
  console.log('  A non-interactive run without --yes prints the plan and applies NOTHING.')
  console.log('  Re-run with --yes to apply; an interactive TTY run prompts (default: no).')
  console.log('')
  console.log('Exit codes:')
  console.log('  0   success, or plan/no-apply (declined)')
  console.log('  1   failure')
  console.log('  2   apply was requested without authorization (non-interactive, no --yes)')
  console.log('  3   drift detected (a planned file changed after the plan)')
  console.log('  130 canceled')
}

async function authorizeReviewedPlan(plan) {
  const operations = plan.operations.filter((operation) => operation.action !== 'unchanged')
  console.log(`Reviewed plan: ${plan.target.path} (${operations.length} change(s))`)
  for (const operation of operations) {
    console.log(`  ${operation.action.padEnd(9)} ${operation.path}`)
  }
  const { promptReview } = await import('../scripts/install/interactive.mjs')
  return promptReview('Apply this reviewed plan?', { default: false })
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

  if (command === 'reconcile') {
    const { spawnSync } = await import('node:child_process')
    const reconcileScript = path.join(ROOT, 'scripts', 'reconcile.mjs')
    const result = spawnSync(process.execPath, [reconcileScript, ...args.slice(1)], {
      stdio: 'inherit',
      cwd: process.cwd(),
    })
    process.exit(result.status ?? 1)
  }

  // restore delegates to scripts/restore.mjs (same spawnSync pattern as prune).
  if (command === 'restore') {
    const { spawnSync } = await import('node:child_process')
    const restoreScript = path.join(ROOT, 'scripts', 'restore.mjs')
    const result = spawnSync(process.execPath, [restoreScript, ...args.slice(1)], {
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

  // beta.5: one-command update — check npm dist-tag, install, re-init.
  // Default channel is `beta` (the prerelease line); `--stable` uses `latest`.
  if (command === 'update') {
    const status = runUpdate(args, {
      root: ROOT,
      currentVersion: readVersion(),
      runningScript: process.argv[1],
    })
    if (status !== 0) process.exit(status)
    return
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
        configureUi({ dryRun: true })
        console.log(tag('Would clear model preset'))
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
    const applyPlanIndex = args.indexOf('--apply-plan')
    const inlineApplyPlan = args.find((arg) => arg.startsWith('--apply-plan='))
    const applyPlanPath =
      applyPlanIndex >= 0
        ? (args[applyPlanIndex + 1] ?? null)
        : (inlineApplyPlan?.split('=', 2)[1] ?? null)
    if (applyPlanIndex >= 0 && !applyPlanPath) {
      console.error('❌ --apply-plan requires a plan file path')
      process.exit(1)
    }
    let reviewedPlan = null
    if (applyPlanPath !== null) {
      const allowed = new Set(['init', '--apply-plan', applyPlanPath, '--yes', '-y', '--headless'])
      const normalized = args.map((value) =>
        value.startsWith('--apply-plan=') ? '--apply-plan' : value,
      )
      if (normalized.some((value) => !allowed.has(value))) {
        console.error('❌ --apply-plan accepts only the plan path and fresh authorization flags')
        process.exit(1)
      }
      reviewedPlan = loadPlanArtifact(applyPlanPath)
      if (
        reviewedPlan.artifact_path &&
        path.resolve(applyPlanPath) !== reviewedPlan.artifact_path
      ) {
        console.error('❌ The reviewed plan artifact was moved; use its original path')
        process.exit(1)
      }
      const options = reviewedPlan.options
      if (
        !Array.isArray(options.components) ||
        options.components.some(
          (component) =>
            !['agents', 'skills', 'instructions', 'commands', 'plugins', 'runtime'].includes(
              component,
            ),
        ) ||
        options.clean !== false ||
        !['v1', 'v2', 'auto'].includes(options.version) ||
        typeof options.isProject !== 'boolean'
      ) {
        console.error('❌ Install-plan options are invalid or unsupported')
        process.exit(1)
      }
    }
    const isProject = reviewedPlan ? reviewedPlan.options.isProject : args.includes('--project')
    const isDryRun = reviewedPlan ? false : args.includes('--dry-run')
    // --clean is an alias of --force (both wipe component dirs + recreate venv).
    const forceReinstall = reviewedPlan
      ? reviewedPlan.options.clean
      : args.includes('--force') || args.includes('--clean')
    const runDoctor = !reviewedPlan && args.includes('--doctor')
    const forceInteractive = !reviewedPlan && args.includes('--interactive')
    const forceHeadless = args.includes('--headless')
    let autoYes = args.includes('--yes') || args.includes('-y')
    const isJson = args.includes('--json')
    const savePlanIndex = args.indexOf('--save-plan')
    const inlineSavePlan = args.find((arg) => arg.startsWith('--save-plan='))
    const savePlanPath =
      savePlanIndex >= 0
        ? (args[savePlanIndex + 1] ?? null)
        : (inlineSavePlan?.split('=', 2)[1] ?? null)
    if (savePlanIndex >= 0 && !savePlanPath) {
      console.error('❌ --save-plan requires a plan file path')
      process.exit(1)
    }
    if (savePlanPath !== null && (!isDryRun || reviewedPlan)) {
      console.error('❌ --save-plan is available only with init --dry-run')
      process.exit(1)
    }
    if (savePlanPath !== null && forceReinstall) {
      console.error('❌ Saving a reviewed plan with --force/--clean is not supported safely')
      process.exit(1)
    }
    if (isJson && (!isDryRun || reviewedPlan)) {
      console.error('❌ --json is supported only with init --dry-run')
      process.exit(1)
    }
    if (isJson && forceReinstall) {
      console.error('❌ --force/--clean cleanup is not supported with --json')
      process.exit(1)
    }

    // beta.5: warn on unrecognized flags instead of silently ignoring them.
    const VALUE_FLAGS = new Set([
      '--preset',
      '--model',
      '--small-model',
      '--version',
      '--opencode-version',
      '--components',
      '--merge-dev-config',
      '--apply-plan',
      '--save-plan',
    ])
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]
      if (!arg.startsWith('--') || arg === '--help') continue
      if (VALUE_FLAGS.has(arg)) {
        i++ // skip the flag's value
        continue
      }
      const bare = arg.split('=', 1)[0]
      if (
        !VALUE_FLAGS.has(bare) &&
        ![
          '--project',
          '--dry-run',
          '--no-mcp',
          '--force',
          '--clean',
          '--doctor',
          '--interactive',
          '--headless',
          '--yes',
          '-y',
          '--json',
          '--verbose',
        ].includes(bare)
      ) {
        console.error(`⚠️  Unknown option ignored: ${arg}`)
      }
    }

    const presetIndex = args.indexOf('--preset')
    const inlinePreset = args.find((arg) => arg.startsWith('--preset='))
    const hasPresetOption = presetIndex >= 0 || inlinePreset !== undefined
    const parsedPreset =
      presetIndex >= 0
        ? (args[presetIndex + 1] ?? null)
        : (inlinePreset?.slice('--preset='.length) ?? null)
    if (
      hasPresetOption &&
      (typeof parsedPreset !== 'string' ||
        parsedPreset.trim() === '' ||
        parsedPreset.startsWith('--'))
    ) {
      console.error('❌ --preset requires a non-empty value')
      process.exit(1)
    }
    const presetOpt = reviewedPlan ? (reviewedPlan.options.preset ?? null) : parsedPreset
    // Explicit top-level model overrides for the generated config.
    const modelIndex = args.indexOf('--model')
    const modelOpt = reviewedPlan
      ? (reviewedPlan.options.model ?? null)
      : modelIndex >= 0
        ? (args[modelIndex + 1] ?? null)
        : null
    const smallModelIndex = args.indexOf('--small-model')
    const smallModelOpt = reviewedPlan
      ? (reviewedPlan.options.smallModel ?? null)
      : smallModelIndex >= 0
        ? (args[smallModelIndex + 1] ?? null)
        : null
    // --version v1|v2|auto labels the install target. `auto` resolves the
    // generation from the opencode binary at install time (see
    // scripts/install/opencode-version.mjs). Invalid values fail fast.
    const versionIndex = args.indexOf('--version')
    const legacyVersionIndex = args.indexOf('--opencode-version')
    const inlineVersion = args.find((arg) => arg.startsWith('--opencode-version='))
    const versionOpt = reviewedPlan
      ? reviewedPlan.options.version
      : versionIndex >= 0
        ? (args[versionIndex + 1] ?? null)
        : legacyVersionIndex >= 0
          ? (args[legacyVersionIndex + 1] ?? null)
          : (inlineVersion?.split('=', 2)[1] ?? null)
    if (
      versionOpt !== null &&
      versionOpt !== 'v1' &&
      versionOpt !== 'v2' &&
      versionOpt !== 'auto'
    ) {
      console.error(`❌ Invalid --version "${versionOpt}" — expected v1, v2 or auto`)
      process.exit(1)
    }

    // Resolve the user's explicit selection separately from the defaults. An
    // unscoped install gets runtime by default; explicit --components does not.
    let componentSelection
    try {
      componentSelection = resolveComponentSelection(args, {
        reviewedComponents: reviewedPlan?.options.components ?? null,
      })
    } catch (err) {
      console.error(`❌ ${err.message}`)
      process.exit(1)
    }
    const { components, requestedComponentsForPrompt, noMcp: skipMCP } = componentSelection

    // --merge-dev-config <path> opts IN to merging a contributor's personal
    // OpenCode config into the generated one. Only third-party plugin/provider/
    // compaction entries are merged; Pantheon-owned entries are always stripped.
    // Absent this flag no repository-root config is read (product defaults come
    // from the installer code, never from a dev checkout).
    const mergeDevConfigIndex = args.indexOf('--merge-dev-config')
    const inlineMergeDevConfig = args.find((arg) => arg.startsWith('--merge-dev-config='))
    const mergeDevConfigOpt = reviewedPlan
      ? (reviewedPlan.options.mergeDevConfig ?? null)
      : mergeDevConfigIndex >= 0
        ? (args[mergeDevConfigIndex + 1] ?? null)
        : (inlineMergeDevConfig?.split('=', 2)[1] ?? null)
    if (mergeDevConfigIndex >= 0 && mergeDevConfigOpt === null) {
      console.error('❌ --merge-dev-config requires a file path')
      process.exit(1)
    }

    if (reviewedPlan && !autoYes) {
      if (!forceHeadless && process.stdin.isTTY && process.stdout.isTTY) {
        const authorization = await authorizeReviewedPlan(reviewedPlan)
        if (authorization === PROMPT_CANCELED) {
          console.log('❌ Install canceled; no files were written.')
          process.exitCode = 130
          return
        }
        if (!authorization) {
          console.log('❌ Install declined; no files were written.')
          return
        }
      } else {
        console.error('❌ Applying a reviewed plan requires --yes or an interactive TTY prompt.')
        process.exit(2)
      }
      autoYes = true
    }

    // Version info
    const version = readVersion()
    const { strings } = await import('../scripts/install/strings.mjs')
    const S = strings()

    const planTimestamp = reviewedPlan?.planned_at ?? new Date().toISOString()
    const stdoutWrite = process.stdout.write
    if (isJson) process.stdout.write = () => true
    if (!isJson) {
      console.log('')
      if (!forceInteractive || isDryRun) {
        console.log(`Pantheon OpenCode v${version} — ${isDryRun ? S.dryRun : S.installing}`)
        console.log('')
      }
    }

    let result
    let installError = null
    try {
      const { installOpenCode } = await import('../scripts/install/opencode.mjs')
      const target = reviewedPlan ? reviewedPlan.target.path : isProject ? process.cwd() : undefined
      result = await installOpenCode(target, isDryRun, forceReinstall, components, {
        interactive: forceInteractive,
        headless: reviewedPlan ? true : forceHeadless,
        yes: autoYes,
        model: modelOpt,
        smallModel: smallModelOpt,
        preset: presetOpt,
        version: versionOpt ?? 'auto',
        mergeDevConfig: mergeDevConfigOpt,
        expectedPlan: reviewedPlan,
        requestedComponents: requestedComponentsForPrompt,
        noMcp: skipMCP,
        planTimestamp,
        quiet: isJson,
        verbose: args.includes('--verbose') && !isJson,
      })
    } catch (err) {
      installError = err
    } finally {
      if (isJson) process.stdout.write = stdoutWrite
    }
    if (installError) {
      if (isJson) {
        process.stdout.write(
          `${JSON.stringify({
            schema_version: 1,
            command: 'init',
            mode: 'dry-run',
            status: 'error',
            error: installError.message,
          })}\n`,
        )
        console.error(`❌ Init dry-run failed: ${installError.message}`)
      } else if (installError?.message === 'Canceled') {
        console.error(S.canceled)
        process.exit(130)
      } else {
        console.error(
          `${S.installFailed(installError.message)}\n${S.failHintNoMcp}\n${S.failHintForce}`,
        )
      }
      process.exitCode = 1
      return
    }

    if (savePlanPath !== null && result?.reason === 'plan') {
      try {
        const artifact = createPlanArtifact({
          target: result.target,
          packageRoot: ROOT,
          packageVersion: version,
          plannedAt: planTimestamp,
          artifactPath: savePlanPath,
          options: {
            clean: forceReinstall,
            components,
            version: result.openCodeVersion,
            isProject,
            model: modelOpt,
            smallModel: smallModelOpt,
            preset: presetOpt,
            mergeDevConfig: mergeDevConfigOpt,
          },
          files: result.files,
          snapshots: result.snapshots,
        })
        savePlanArtifact(savePlanPath, artifact)
      } catch (error) {
        if (!isJson) throw error
        process.stdout.write(
          `${JSON.stringify({
            schema_version: 1,
            command: 'init',
            mode: 'dry-run',
            status: 'error',
            error: error.message,
          })}\n`,
        )
        console.error(`❌ Could not save reviewed install plan: ${error.message}`)
        process.exitCode = 1
        return
      }
      if (!isJson) console.log(`Reviewed plan saved to ${path.resolve(savePlanPath)} (mode 0600).`)
    }

    if (isJson) {
      const files = result.files ?? []
      const totals = { create: 0, update: 0, remove: 0, unchanged: 0, conflict: 0 }
      for (const file of files) {
        if (Object.hasOwn(totals, file.action)) totals[file.action] += 1
      }
      const mcpServers = result.mcpServers ?? []
      process.stdout.write(
        `${JSON.stringify({
          schema_version: 1,
          command: 'init',
          mode: 'dry-run',
          status: 'planned',
          target: result.target,
          open_code_version: result.openCodeVersion,
          advisories: result.versionAssumed
            ? [
                'The OpenCode host generation could not be detected; this plan assumes V1 ' +
                  'and may diverge from the apply. Pass --opencode-version v1|v2 to pin it.',
              ]
            : [],
          totals,
          mcp_servers: mcpServers,
          mcp_server_count: mcpServers.length,
          files: files.map(({ path: filePath, action, bytes }) => ({
            path: path.relative(result.target, filePath) || '.',
            action,
            bytes,
          })),
          saved_plan: savePlanPath ? path.resolve(savePlanPath) : null,
        })}\n`,
      )
      return
    }

    // Beta 11 Setup phases 3-4: a run that did NOT apply (declined /
    // unauthorized / drift) must never print a success banner. Exit codes:
    //   0 ok / no-apply · 2 apply-requested-without-authorization · 3 drift
    //   130 canceled · 1 failure (thrown above).
    if (result?.applied === false) {
      if (!isDryRun) {
        if (result.reason === 'canceled') console.error(S.canceled)
        process.exit(resolveInstallExitCode(result, isDryRun))
      }
      // Dry-run preview: report honestly instead of the "installed!" banner.
      console.log('')
      console.log(`  ${S.dryRunNothingWritten}`)
      return
    }

    if (runDoctor && !isDryRun) {
      console.log('')
      console.log(`  ${S.runningHealthCheck}`)
      const doctorStartedAt = Date.now()
      const { spawnSync } = await import('node:child_process')
      const doctorScript = path.join(ROOT, 'scripts', 'doctor.mjs')
      const doctor = spawnSync(process.execPath, [doctorScript], { stdio: 'inherit', cwd: ROOT })
      const doctorSeconds = ((Date.now() - doctorStartedAt) / 1000).toFixed(1)
      // Never leave "Running health check..." as the last word: report the
      // outcome and duration, and propagate the child's exit code so CI sees
      // the failure instead of a silent zero.
      if (doctor.error) {
        console.error(`  ⚠️  Could not run doctor.mjs: ${doctor.error.message}`)
        process.exitCode = 1
      } else if (doctor.status === 0) {
        console.log(`  ${S.healthCheckFinished(doctorSeconds, 0)}`)
      } else {
        const status = doctor.status ?? 1
        console.error(`  ${S.healthCheckExit(doctorSeconds, status)}`)
        process.exitCode = status
      }
    }

    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  ${S.installedTitle(version)}`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('')
    console.log(`  ${S.nextSteps}`)
    console.log(`  ${S.nextVerify}`)
    console.log(`  ${S.nextLaunch}`)
    console.log(`  ${S.nextAgents}`)
    console.log(`  ${S.nextProject}`)
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
