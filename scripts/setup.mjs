#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import * as clack from '@clack/prompts'
import { parseOpenCodeVersion, resolveOpenCodeVersion } from './install/opencode-version.mjs'
import { planArtifactDigest } from './install/plan-artifact.mjs'
import {
  applyConfigChanges,
  prepareV2Config,
  resolveGlobalConfigDirectory,
  verifyConfigPreconditions,
} from './setup-v2-config.mjs'

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

function passthroughArgs(args) {
  const omitWithValue = new Set(['--save-plan', '--apply-plan', '--version', '--opencode-version'])
  const result = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (omitWithValue.has(arg)) {
      index += 1
      continue
    }
    if (
      ['--yes', '-y', '--dry-run', '--json', '--headless', '--interactive'].includes(arg) ||
      arg.startsWith('--save-plan=') ||
      arg.startsWith('--apply-plan=') ||
      arg.startsWith('--version=') ||
      arg.startsWith('--opencode-version=')
    ) {
      continue
    }
    result.push(arg)
  }
  return result
}

function summarizeInitPreview(stdout) {
  let plan
  try {
    plan = JSON.parse(stdout)
  } catch {
    return null
  }
  if (plan?.status !== 'planned' || !plan.totals || typeof plan.totals !== 'object') return null
  const actions = ['create', 'update', 'remove', 'unchanged', 'conflict']
  const totals = Object.fromEntries(
    actions.map((action) => [
      action,
      Number.isSafeInteger(plan.totals[action]) ? plan.totals[action] : 0,
    ]),
  )
  const reportedOperationCount = Object.values(totals).reduce((sum, count) => sum + count, 0)
  const files = plan.files ?? (reportedOperationCount === 0 ? [] : null)
  if (
    !Array.isArray(files) ||
    files.length !== reportedOperationCount ||
    files.some(
      (file) => !['create', 'update', 'remove', 'unchanged', 'conflict'].includes(file?.action),
    )
  ) {
    return null
  }
  if (
    !plan.setup_plan ||
    !Array.isArray(plan.setup_plan.operations) ||
    !/^[a-f0-9]{64}$/.test(plan.setup_plan_digest ?? '') ||
    planArtifactDigest(plan.setup_plan) !== plan.setup_plan_digest ||
    plan.setup_plan.operations.length !== files.length ||
    plan.setup_plan.operations.some(
      (operation, index) => operation.action !== files[index].action,
    ) ||
    !Array.isArray(plan.mcp_servers)
  ) {
    return null
  }
  const operations = files.flatMap((file) => {
    const action = file.action
    if (!['create', 'update', 'remove', 'conflict'].includes(action)) return []
    return [{ action, path: safeOperationPath(file.path) ?? '[redacted path]' }]
  })
  return {
    totals,
    operations,
    setupPlan: plan.setup_plan,
    setupPlanDigest: plan.setup_plan_digest,
    mcpServers: plan.mcp_servers,
  }
}

function planComparisonView(plan) {
  return {
    package: plan.package,
    target: plan.target,
    options: plan.options,
    operations: plan.operations,
  }
}

function plansMatchAfterConfigApply(reviewed, current, prepared) {
  if (!reviewed || !current) return false
  const expected = structuredClone(reviewed)
  const approvedConfig = prepared.changes?.find(
    (change) =>
      path.resolve(change.path) === path.resolve(path.join(prepared.configDir, 'opencode.json')),
  )
  if (approvedConfig) {
    const priorOperation = expected.operations.find(
      (operation) => path.resolve(operation.path) === path.resolve(approvedConfig.path),
    )
    const currentOperation = current.operations.find(
      (operation) => path.resolve(operation.path) === path.resolve(approvedConfig.path),
    )
    if (priorOperation || currentOperation) {
      if (!priorOperation || !currentOperation) return false
      priorOperation.before = currentOperation.before
    }
  }
  return isDeepStrictEqual(planComparisonView(expected), planComparisonView(current))
}

function safeOperationPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return null
  }
  const parts = value.split('/')
  if (
    parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    return null
  }
  return parts.join('/')
}

/** Review and apply the opt-in V2 migration before allowing init to write. */
export async function runSetup({
  args = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  runInit = async (initArgs, initEnv = env, approvedPlan = null) =>
    spawnSync(process.execPath, [INIT_CLI, ...initArgs], {
      cwd,
      env: initEnv,
      ...(approvedPlan === null
        ? { stdio: 'inherit' }
        : { input: JSON.stringify(approvedPlan), stdio: ['pipe', 'inherit', 'inherit'] }),
    }),
  prepare = prepareV2Config,
  resolveVersion = resolveOpenCodeVersion,
  applyConfig = applyConfigChanges,
  confirmInit = async () =>
    clack.confirm({
      message:
        'Authorize the reviewed config changes and installer plan? This will write config and managed files.',
      initialValue: false,
    }),
  previewInit = async (initArgs, initEnv = env, configPreview = null) =>
    spawnSync(process.execPath, [INIT_CLI, ...initArgs], {
      cwd,
      env: initEnv,
      encoding: 'utf8',
      input: configPreview === null ? undefined : configPreview,
      stdio: configPreview === null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    }),
  output = console,
} = {}) {
  if (args.includes('--help')) {
    const helpResult = await runInit(['init', ...args], env)
    return helpResult?.status ?? helpResult?.code ?? 0
  }

  let detectionFallback = false
  const warnings = []
  let generation
  try {
    const requested = parseOpenCodeVersion(args) ?? 'auto'
    generation = resolveVersion(requested, {
      env,
      warn: () =>
        warnings.push('OpenCode version detection was inconclusive; pass --version v1 or v2.'),
      onFallback: () => {
        detectionFallback = true
      },
    })
  } catch (error) {
    writeOutput(
      output,
      `${error instanceof Error ? error.message : 'OpenCode generation selection is invalid; pass --version v1, v2, or auto.'}\n`,
    )
    return 1
  }
  for (const warning of warnings) writeOutput(output, `${warning}\n`)

  const migrationEnabled =
    generation === 'v2' &&
    !detectionFallback &&
    !args.includes('--project') &&
    !args.includes('--help')
  const dryRun = args.includes('--dry-run')
  let initEnv = env
  let prepared = { status: 'unchanged', changes: [] }
  if (migrationEnabled) {
    let configDir
    try {
      configDir = resolveGlobalConfigDirectory(env, home)
    } catch (error) {
      writeOutput(
        output,
        `${error instanceof Error ? error.message : 'OpenCode config path is invalid.'}\n`,
      )
      return 1
    }
    const headless = isHeadless(args, env, interactive) || dryRun
    try {
      prepared = await prepare({
        configDir,
        interactive: !headless,
        dryRun,
        output,
      })
    } catch {
      writeOutput(output, 'V2 config preparation stopped safely; init was not started.\n')
      return 1
    }

    if (!dryRun && !headless && !['planned', 'unchanged'].includes(prepared?.status)) {
      if (['canceled', 'skipped'].includes(prepared?.status)) {
        writeOutput(output, 'V2 config review was not completed; init was not started.\n')
        return 0
      }
      writeOutput(output, 'V2 config preflight is blocked; init was not started.\n')
      return 1
    }
    if (['blocked', 'failed'].includes(prepared?.status)) {
      writeOutput(output, 'V2 config preflight is blocked; init was not started.\n')
      return 1
    }
    initEnv = { ...env, PANTHEON_SETUP_TARGET: configDir }
  }

  const pinnedArgs = [...passthroughArgs(args), `--version=${generation}`]
  const previewArgs = [
    'init',
    '--dry-run',
    '--json',
    '--headless',
    '--setup-plan-json',
    ...pinnedArgs,
  ]
  const configPreview = prepared.status === 'planned' ? (prepared.configPreview ?? null) : null
  if (configPreview !== null) previewArgs.push('--setup-config-preview-stdin')
  const preview = await previewInit(previewArgs, initEnv, configPreview)
  if (preview?.error || preview?.status !== 0) {
    if (dryRun || isHeadless(args, env, interactive)) {
      writeOutput(
        output,
        'Preview only; the installer plan needs interactive resolution. Rerun `npm run setup` in an interactive terminal. No files were changed.\n',
      )
      return 0
    }
    writeOutput(output, 'Installer preflight failed safely; no files were changed.\n')
    return 1
  }
  const initPlan = summarizeInitPreview(preview.stdout ?? '')
  if (!initPlan) {
    writeOutput(output, 'Installer preflight did not return a valid plan; no files were changed.\n')
    return 1
  }
  if (prepared.unsafeMcpNames?.some((name) => initPlan.mcpServers.includes(name))) {
    writeOutput(
      output,
      'An unsafe Pantheon MCP entry would be duplicated by init; abort setup and reconcile the JSONC entry first. No files were changed.\n',
    )
    return 1
  }
  const { totals, operations } = initPlan
  writeOutput(
    output,
    `Init plan: ${totals.create} create, ${totals.update} update, ${totals.remove} remove, ${totals.unchanged} unchanged operation(s).\n`,
  )
  for (const operation of operations) {
    writeOutput(output, `Init operation: ${operation.action} ${operation.path}.\n`)
  }
  if (prepared.status === 'planned') {
    writeOutput(output, `Config migration plan: ${prepared.changes.length} file(s) to update.\n`)
  }

  if (dryRun || isHeadless(args, env, interactive)) {
    writeOutput(
      output,
      'Preview only; no config, backup, init, or run-record files were written. Rerun `npm run setup` in an interactive terminal to authorize setup.\n',
    )
    return 0
  }

  let accepted
  try {
    accepted = await confirmInit()
  } catch {
    writeOutput(output, 'Setup authorization failed; no files were changed.\n')
    return 1
  }
  if (clack.isCancel?.(accepted) || accepted !== true) {
    writeOutput(output, 'Setup was not authorized; no files were changed.\n')
    return 0
  }

  let migrationBackup = null
  const configPreconditions = prepared.configPreconditions ?? []
  if (
    configPreconditions.length > 0 &&
    !verifyConfigPreconditions(configPreconditions, {
      configDir: prepared.configDir,
      stage: 'original',
    })
  ) {
    writeOutput(
      output,
      'Reviewed config inputs changed after preflight; setup stopped before writes.\n',
    )
    return 1
  }

  if (prepared.status === 'planned') {
    try {
      migrationBackup = await applyConfig(prepared.changes, { configDir: prepared.configDir })
    } catch {
      writeOutput(
        output,
        'Config migration apply failed. If any file changed, use `pantheon-opencode restore` to review the setup backup. Init was not started.\n',
      )
      return 1
    }
  }

  if (
    configPreconditions.length > 0 &&
    !verifyConfigPreconditions(configPreconditions, {
      configDir: prepared.configDir,
      stage: 'expected',
    })
  ) {
    writeOutput(
      output,
      `Config inputs drifted after the reviewed migration; init was not started.${migrationBackup?.dir ? ` Review the backup at ${migrationBackup.dir}; run pantheon-opencode restore to recover.` : ''}\n`,
    )
    return 1
  }

  const postMigrationArgs = previewArgs.filter((arg) => arg !== '--setup-config-preview-stdin')
  const postMigrationPreview = await previewInit(postMigrationArgs, initEnv)
  const postMigrationPlan =
    postMigrationPreview?.status === 0 && !postMigrationPreview.error
      ? summarizeInitPreview(postMigrationPreview.stdout ?? '')
      : null
  if (
    !postMigrationPlan ||
    !plansMatchAfterConfigApply(initPlan.setupPlan, postMigrationPlan.setupPlan, prepared)
  ) {
    writeOutput(
      output,
      `Installer inputs or plan drifted after review; init was not started.${migrationBackup?.dir ? ` Review the backup at ${migrationBackup.dir}; run pantheon-opencode restore to recover.` : ''}\n`,
    )
    return 1
  }

  const initResult = await runInit(
    ['init', '--yes', '--headless', '--setup-approved-plan-stdin', ...pinnedArgs],
    initEnv,
    {
      schema_version: 1,
      plan: postMigrationPlan.setupPlan,
      digest: postMigrationPlan.setupPlanDigest,
      configPreconditions,
    },
  )
  if (initResult?.error) {
    writeOutput(output, 'Setup init failed; see the installer output for details.\n')
    return initResult.status ?? 1
  }
  if (initResult?.status !== undefined && initResult.status !== 0) return initResult.status ?? 1
  if (initResult?.status === undefined && initResult?.code !== 0) return initResult?.code ?? 1
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSetup()
}
