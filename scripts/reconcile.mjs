#!/usr/bin/env node
/** Preview or remove only files proven stale by the install ownership inventory. */
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFileDriftPlan, classifyFileInventory } from './install/file-inventory.mjs'
import { readState } from './install/state.mjs'
import { assertNoSymlinkAncestors, verifyRegularFile } from './install/verify.mjs'

const VALID_COMPONENTS = [
  'agents',
  'skills',
  'instructions',
  'prompts',
  'commands',
  'plugins',
  'runtime',
]
const DEFAULT_COMPONENTS = [...VALID_COMPONENTS]

export function parseArgs(argv) {
  const args = {
    project: false,
    global: false,
    target: null,
    components: null,
    apply: false,
    dryRun: false,
    yes: false,
    savePlan: null,
    applyPlan: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--project') args.project = true
    else if (arg === '--global') args.global = true
    else if (arg === '--target') {
      const target = argv[++i]
      if (!target || target.startsWith('--')) throw new Error('--target requires a path')
      args.target = target
    } else if (arg === '--components') args.components = argv[++i] ?? null
    else if (arg === '--apply') args.apply = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--yes' || arg === '-y') args.yes = true
    else if (arg === '--save-plan') args.savePlan = argv[++i] ?? null
    else if (arg === '--apply-plan') args.applyPlan = argv[++i] ?? null
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown reconcile option: ${arg}`)
  }
  if (!args.applyPlan && !args.help) {
    if (args.project && (args.global || args.target !== null)) {
      throw new Error('--project cannot be combined with --global or --target')
    }
    if (!args.project && !args.global && args.target === null) {
      throw new Error('Choose a target scope: --project, --global, or --target PATH')
    }
  }
  if (args.components !== null) {
    args.components = args.components
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (
      args.components.length === 0 ||
      args.components.some((item) => !VALID_COMPONENTS.includes(item))
    ) {
      throw new Error(
        `--components must be a comma-separated list of: ${VALID_COMPONENTS.join(', ')}`,
      )
    }
    args.components = [...new Set(args.components)]
  }
  if (args.apply && args.applyPlan) throw new Error('Use either --apply or --apply-plan, not both')
  if (args.dryRun && (args.apply || args.applyPlan)) {
    throw new Error('--dry-run cannot be combined with an apply option')
  }
  if (args.savePlan && (args.apply || args.applyPlan))
    throw new Error('--save-plan is available only during preview')
  if (args.yes && !args.apply && !args.applyPlan)
    throw new Error('--yes requires --apply or --apply-plan')
  if (args.applyPlan && (args.project || args.global || args.target || args.components)) {
    throw new Error('--apply-plan uses the target and components embedded in the reviewed plan')
  }
  return args
}

function printHelp() {
  console.log(`
pantheon-opencode reconcile — review and remove exact stale installer-owned files

Usage:
  pantheon-opencode reconcile --project [--dry-run] [--components agents,skills] [--save-plan <file>]
  pantheon-opencode reconcile --global [--target PATH] [--dry-run] [--components agents,skills]
  pantheon-opencode reconcile --target PATH [--dry-run] [--components agents,skills]
  pantheon-opencode reconcile --project --apply [--yes]
  pantheon-opencode reconcile --apply-plan <file> --yes

Use --global for the global OpenCode config target, or --target PATH for an explicit
target. An explicit target is project-scoped unless combined with --global, which
selects the flat global layout for that path. Preview is read-only. Apply removes only unchanged, inventoried stale files;
legacy, modified, missing, symlinked, and ambiguous files are preserved.
`)
}

function resolveTarget(args) {
  if (args.target) return resolve(args.target)
  if (args.project) return resolve(process.cwd())
  return resolve(join(homedir(), '.config', 'opencode'))
}

function layoutFor({ global, version }) {
  return Object.fromEntries(
    VALID_COMPONENTS.map((component) => [
      component,
      global ? 'global' : version === 'v2' ? 'project-v2' : 'project-v1',
    ]),
  )
}

async function buildReview(target, components, global) {
  if (!existsSync(target)) throw new Error(`Target directory does not exist: ${target}`)
  const state = readState(target)
  if (!state)
    throw new Error('No readable installer state found; unowned legacy files will not be removed')
  const { installOpenCode } = await import('./install/opencode.mjs')
  const desired = await installOpenCode(target, true, false, components, {
    version: 'auto',
    global,
    quiet: true,
    quietPlan: true,
    planOnly: true,
    headless: true,
  })
  const desiredFiles = new Map(
    (desired?.files ?? [])
      .filter((file) => typeof file.outputFingerprint === 'string')
      .map((file) => [file.path, { sha256: file.outputFingerprint }]),
  )
  const selectedLayouts = layoutFor({ global, version: desired?.openCodeVersion })
  const report = classifyFileInventory(target, state, {
    desiredFiles,
    selectedComponents: components,
    selectedLayouts,
  })
  return {
    state,
    report,
    desiredFiles,
    selectedLayouts,
    components,
    plan: {
      schema_version: 1,
      command: 'reconcile',
      target: resolve(target),
      selected_components: components,
      selected_layouts: selectedLayouts,
      inventory_fingerprint: report.inventoryFingerprint,
      manual_review: report.manualReview,
      operations: report.operations,
    },
  }
}

function safePlanShape(plan) {
  return (
    plan &&
    plan.schema_version === 1 &&
    plan.command === 'reconcile' &&
    typeof plan.target === 'string' &&
    Array.isArray(plan.selected_components) &&
    plan.selected_components.every((component) => VALID_COMPONENTS.includes(component)) &&
    plan.selected_layouts &&
    typeof plan.selected_layouts === 'object' &&
    typeof plan.inventory_fingerprint === 'string' &&
    Array.isArray(plan.operations)
  )
}

function savePlan(filePath, plan) {
  const destination = resolve(filePath)
  assertNoSymlinkAncestors(destination)
  const descriptor = openSync(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  )
  const contents = `${JSON.stringify(plan, null, 2)}\n`
  try {
    writeFileSync(descriptor, contents, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  verifyRegularFile(destination, contents)
  return destination
}

async function authorize(plan, args) {
  const count = plan.operations.length
  console.log(`Reviewed ${count} exact stale-owned file(s) under ${plan.target}:`)
  for (const operation of plan.operations) console.log(`  remove ${operation.path}`)
  if (plan.operations.length === 0) return true
  if (args.yes) return true
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'Apply requested without authorization. Re-run with --apply --yes or --apply-plan FILE --yes.',
    )
    process.exitCode = 2
    return false
  }
  const readline = await import('node:readline/promises')
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question('Remove exactly these files? [y/N] ')
    return ['y', 'yes'].includes(answer.trim().toLowerCase())
  } finally {
    prompt.close()
  }
}

function printReport(report) {
  console.log('Installer file ownership report:')
  if (report.legacyAmbiguous) {
    console.log(
      '  manual-review Legacy files without inventory are unknown and will never be auto-deleted.',
    )
  }
  for (const entry of report.entries) {
    const suffix = entry.reason ? ` (${entry.reason})` : ''
    console.log(`  ${entry.classification.padEnd(14)} ${entry.path}${suffix}`)
  }
  console.log(
    `  ${report.operations.length} stale-owned regular file(s) eligible for reviewed removal.`,
  )
}

async function runApplyPlan(plan, args) {
  if (!safePlanShape(plan) || plan.manual_review === true) {
    throw new Error('Reviewed reconcile plan is invalid or marked for manual review')
  }
  const target = resolve(plan.target)
  const components = plan.selected_components
  const review = await buildReview(target, components, plan.selected_layouts?.agents === 'global')
  if (JSON.stringify(review.plan.operations) !== JSON.stringify(plan.operations)) {
    throw new Error('Reviewed reconcile operation set drifted; no files were removed')
  }
  const reviewed = {
    target,
    operations: plan.operations,
    inventoryFingerprint: plan.inventory_fingerprint,
    manualReview: plan.manual_review,
  }
  if (!(await authorize(reviewed, args))) return
  const result = applyFileDriftPlan(target, review.state, reviewed, {
    desiredFiles: review.desiredFiles,
    selectedComponents: components,
    selectedLayouts: review.selectedLayouts,
  })
  console.log(`Removed ${result.removed.length} file(s).`)
  if (result.backupDir) console.log(`Restorable backup: ${result.backupDir}`)
}

export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(`❌ ${error.message}`)
    process.exitCode = 1
    return
  }
  if (args.help) return printHelp()

  if (args.applyPlan) {
    try {
      const plan = JSON.parse(readFileSync(resolve(args.applyPlan), 'utf8'))
      await runApplyPlan(plan, args)
    } catch (error) {
      console.error(`❌ ${error.message}`)
      process.exitCode = 3
    }
    return
  }

  const target = resolveTarget(args)
  const components = args.components ?? DEFAULT_COMPONENTS
  try {
    const review = await buildReview(target, components, args.global)
    printReport(review.report)
    if (args.savePlan) {
      const savedPath = savePlan(args.savePlan, review.plan)
      console.log(`Reviewed plan saved: ${savedPath}`)
      return
    }
    if (!args.apply) {
      console.log('Preview only; no files were written or removed.')
      return
    }
    if (!(await authorize(review.plan, args))) return
    const result = applyFileDriftPlan(target, review.state, review.report, {
      desiredFiles: review.desiredFiles,
      selectedComponents: components,
      selectedLayouts: review.selectedLayouts,
    })
    console.log(`Removed ${result.removed.length} file(s).`)
    if (result.backupDir) console.log(`Restorable backup: ${result.backupDir}`)
  } catch (error) {
    console.error(`❌ ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
