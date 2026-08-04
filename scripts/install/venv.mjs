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
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * @param {{ dryRun?: boolean, skipInstall?: boolean, force?: boolean }} [options]
 * @returns {{ venvPath: string, python: string }}
 */
export function setupVenv(target, { dryRun = false, skipInstall = false, force = false } = {}) {
  const venvPath = join(target, '.venv')
  const pythonBin = venvPythonPath(target)

  // Step 1: Force recreate venv if --force
  if (force && existsSync(venvPath)) {
    if (!dryRun) {
      console.log('  Removing existing .venv (--force)...')
      rmSync(venvPath, { recursive: true })
    }
    console.log('  ✅ .venv removed')
  }

  // Step 1b: Create venv if not exists
  if (!existsSync(pythonBin)) {
    if (!dryRun) {
      console.log('  Creating .venv...')
      const result = spawnSync('python3', ['-m', 'venv', venvPath], {
        stdio: 'inherit',
        timeout: 30_000,
      })
      if (result.status !== 0) {
        throw new Error('Failed to create virtual environment')
      }
    }
    console.log('  ✅ .venv created')
  } else {
    console.log('  ⏭️  .venv already exists')
  }

  // Step 2: Install MCP dependencies
  if (!skipInstall) {
    const pip = join(venvPath, 'bin', 'pip')
    const reqFile = join(ROOT, 'src', 'mcp', 'requirements-mcp.txt')

    if (!existsSync(reqFile)) {
      throw new Error(`Requirements file not found: ${reqFile}`)
    }

    console.log('  Installing MCP dependencies...')

    if (!dryRun) {
      // Upgrade pip first (avoids resolver warnings)
      // Ensure PIP_USER=0 to install into venv, not user site-packages
      const pipEnv = { ...process.env, PIP_USER: '0' }

      spawnSync(pip, ['install', '--upgrade', 'pip'], {
        stdio: 'ignore',
        timeout: 30_000,
        env: pipEnv,
      })

      // Install requirements — attempt 1: normal
      const r = spawnSync(pip, ['install', '-r', reqFile], {
        stdio: 'inherit',
        timeout: 120_000,
        env: pipEnv,
      })

      if (r.status !== 0) {
        // Attempt 2: --break-system-packages (PEP 668 / externally-managed)
        console.log('  ⚠️  First attempt failed, retrying with --break-system-packages...')
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
    }
    console.log('  ✅ MCP dependencies installed')
  } else {
    console.log('  ⏭️  Dependency install skipped (--skip-install)')
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

  try {
    const result = setupVenv(target, { dryRun, skipInstall, force })
    console.log(`  📍 Python: ${result.python}`)
  } catch (err) {
    console.error(`\n  ❌ ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}
