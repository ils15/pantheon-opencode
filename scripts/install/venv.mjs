#!/usr/bin/env node

/**
 * venv.mjs — Virtual environment setup + dependency install
 *
 * Usage:
 *   node scripts/install/venv.mjs --target ~/.config/opencode
 *   node scripts/install/venv.mjs --target ~/.config/opencode --dry-run
 *   node scripts/install/venv.mjs --target ~/.config/opencode --skip-install
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configure, info, step, success, warning } from './cli-ui.mjs'
import { ACTIONS, recordChange, recordRemovalTree, removeReviewedTree } from './plan.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

/**
 * Resolve the python executable of the venv that setupVenv creates for a
 * target. Single source of truth for the venv layout: the venv always lives
 * at <target>/.venv — even for PROJECT installs, where the runtime payload
 * goes to <target>/.opencode. MCP commands and health checks MUST derive
 * their python from here (never from a runtime sub-directory), or a project
 * install would point at <target>/.opencode/.venv/bin/python3, which
 * setupVenv never creates (P1-3).
 *
 * @param {string} target - target installation directory
 * @returns {string} absolute path to the venv python executable
 */
export function venvPythonPath(target) {
  const venvPath = join(target, '.venv')
  return process.platform === 'win32'
    ? join(venvPath, 'Scripts', 'python.exe')
    : join(venvPath, 'bin', 'python3')
}

/**
 * Set up a Python virtual environment and install MCP dependencies.
 *
 * @param {string} target - Target installation directory (e.g. ~/.config/opencode)
 * @param {{ dryRun?: boolean, skipInstall?: boolean, force?: boolean, recorder?: (change: object) => void, reviewedRemovals?: Set<string>|null, reviewedSnapshots?: Map<string, object>|null }} [options]
 * @returns {{ venvPath: string, python: string }}
 */
export function setupVenv(
  target,
  {
    dryRun = false,
    skipInstall = false,
    force = false,
    recorder = null,
    reviewedRemovals = null,
    reviewedSnapshots = null,
  } = {},
) {
  const venvPath = join(target, '.venv')
  const pythonBin = venvPythonPath(target)

  // Step 1: Force recreate venv if --force
  if (force && existsSync(venvPath)) {
    if (dryRun) {
      recordRemovalTree(venvPath, recorder)
      info('.venv would be removed (--force)')
    } else {
      const removeStep = step('Removing existing .venv (--force)')
      removeReviewedTree(venvPath, reviewedRemovals, reviewedSnapshots)
      removeStep(true)
      success('.venv removed')
    }
  }

  // Step 1b: Create venv if not exists
  const venvExists = existsSync(pythonBin)
  if (!venvExists) {
    if (dryRun) {
      // Never claim a directory was created by a run that writes nothing.
      info('.venv would be created')
    } else {
      const createStep = step('Creating .venv')
      const result = spawnSync('python3', ['-m', 'venv', venvPath], {
        stdio: 'inherit',
        timeout: 30_000,
      })
      if (result.status !== 0) {
        createStep(false)
        throw new Error('Failed to create virtual environment')
      }
      createStep(true)
      success('.venv created')
    }
    // A single synthetic entry for the venv directory — never enumerate its
    // thousands of files. Unscored: the install summary does not count it.
    recordChange({ path: venvPath, action: ACTIONS.CREATE, bytes: 0, scored: false }, recorder)
  } else {
    info('.venv already exists')
    recordChange({ path: venvPath, action: ACTIONS.UNCHANGED, bytes: 0, scored: false }, recorder)
  }

  // Step 2: Install MCP dependencies
  if (!skipInstall) {
    const pip = join(venvPath, 'bin', 'pip')
    const reqFile = join(ROOT, 'src', 'mcp', 'requirements-mcp.txt')

    if (!existsSync(reqFile)) {
      throw new Error(`Requirements file not found: ${reqFile}`)
    }

    if (!dryRun) {
      const depsStep = step('Installing MCP dependencies')
      try {
        // Upgrade pip first (avoids resolver warnings)
        // Ensure PIP_USER=0 to install into venv, not user site-packages
        const pipEnv = { ...process.env, PIP_USER: '0' }

        // stdio is 'ignore' (pip is noisy here), so the step marker is the ONLY
        // evidence this ran — report both start and outcome instead of a silent
        // 30s pause.
        const pipUpgradeStep = step('Upgrading pip')
        const pipUpgrade = spawnSync(pip, ['install', '--upgrade', 'pip'], {
          stdio: 'ignore',
          timeout: 30_000,
          env: pipEnv,
        })
        const upgraded = pipUpgrade.status === 0
        pipUpgradeStep(upgraded)
        if (!upgraded) warning('pip upgrade failed — continuing with the bundled version')

        // Install requirements — attempt 1: normal
        const r = spawnSync(pip, ['install', '-r', reqFile], {
          stdio: 'inherit',
          timeout: 120_000,
          env: pipEnv,
        })

        if (r.status !== 0) {
          // Attempt 2: --break-system-packages (PEP 668 / externally-managed)
          warning('First attempt failed, retrying with --break-system-packages...')
          const r2 = spawnSync(pip, ['install', '-r', reqFile, '--break-system-packages'], {
            stdio: 'inherit',
            timeout: 120_000,
            env: pipEnv,
          })
          if (r2.status !== 0) {
            throw new Error(
              'Failed to install MCP dependencies. ' +
                'Try: PIP_USER=0 ' +
                pip +
                ' install -r ' +
                reqFile +
                ' --break-system-packages',
            )
          }
        }
        depsStep(true)
        success('MCP dependencies installed')
      } catch (err) {
        depsStep(false)
        throw err
      }
    } else {
      // A dry run installs nothing: say so rather than reporting success.
      info('MCP dependencies would be installed')
    }
  } else {
    info('Dependency install skipped (--skip-install)')
  }

  return { venvPath, python: pythonBin }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2)
  const targetIdx = args.indexOf('--target')
  const target = targetIdx !== -1 ? args[targetIdx + 1] : process.cwd()
  const dryRun = args.includes('--dry-run')
  const skipInstall = args.includes('--skip-install')
  const force = args.includes('--force')
  configure({ dryRun })

  try {
    const result = setupVenv(target, { dryRun, skipInstall, force })
    info(`Python: ${result.python}`)
  } catch (err) {
    console.error(`\n  [ERROR] ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}
