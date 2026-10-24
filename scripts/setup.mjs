#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveOpenCodeVersion } from './install/opencode-version.mjs'
import { prepareV2Config, resolveGlobalConfigDirectory } from './setup-v2-config.mjs'

const INIT_CLI = fileURLToPath(new URL('../bin/pantheon-init.mjs', import.meta.url))

function writeOutput(output, text) {
  if (typeof output.write === 'function') output.write(text)
  else output.log?.(text.trimEnd())
}

function isHeadless(args, env, interactive) {
  return (
    !interactive ||
    args.includes('--headless') ||
    env.CI === 'true' ||
    env.CI === '1' ||
    env.GITHUB_ACTIONS === 'true'
  )
}

/** Run the existing init flow, then optionally start the independent V2 config review. */
export async function runSetup({
  args = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  runInit = async (initArgs) =>
    spawnSync(process.execPath, [INIT_CLI, ...initArgs], {
      cwd,
      env,
      stdio: 'inherit',
    }),
  prepare = prepareV2Config,
  output = console,
} = {}) {
  const initResult = await runInit(['init', '--yes', ...args])
  if (initResult?.error) {
    writeOutput(output, `Setup init failed: ${initResult.error.message}\n`)
    return initResult.status ?? 1
  }
  if (initResult?.status !== undefined && initResult.status !== 0) return initResult.status ?? 1
  if (initResult?.status === undefined && initResult?.code !== 0) return initResult?.code ?? 1

  let detectionFallback = false
  const warnings = []
  let generation
  try {
    generation = resolveOpenCodeVersion('auto', {
      env,
      warn: (message) => warnings.push(message),
      onFallback: () => {
        detectionFallback = true
      },
    })
  } catch (error) {
    warnings.push(`OpenCode generation detection failed: ${error.message}`)
  }
  for (const warning of warnings) writeOutput(output, `${warning}\n`)
  if (generation !== 'v2' || detectionFallback) return 0

  // The preparation stage is global. A project-scoped init remains the existing
  // project behavior and must not redirect this optional stage to the global host.
  if (args.includes('--project')) return 0

  const headless = isHeadless(args, env, interactive)
  if (headless) {
    writeOutput(
      output,
      'OpenCode V2 config preparation is preview-only in headless mode; --yes does not authorize config writes.\n',
    )
  }
  try {
    await prepare({
      configDir: resolveGlobalConfigDirectory(env, home),
      interactive: !headless,
      output,
    })
  } catch (error) {
    // The new review stage is optional; it must not undo a successful init.
    writeOutput(output, `V2 config preparation stopped without affecting init: ${error.message}\n`)
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSetup()
}
