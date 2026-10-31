#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
// Prebuilt bundles: Node refuses to strip TypeScript types under node_modules,
// so the published CLI cannot import the TypeScript sources directly. Regenerate
// with `npm run build:decision-router`; `--check` guards against drift.
import {
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from './decision-router-budget.mjs'
import {
  evaluateCapGate,
  evaluatePeriodGate,
  inspectDecisionBudget,
  listDecisionHoldsReadOnly,
  utcPeriodOf,
} from './decision-router-v2-budget.mjs'
import {
  resolveV2DecisionEgress,
  V2_DECISION_EGRESS_DEFAULT,
  V2_DECISION_EGRESS_TRANSPORT,
} from './decision-router-v2-egress.mjs'
import {
  applyDecisionLayerPlan,
  buildDecisionLayerPlan,
  formatDecisionLayerPlan,
  resolveInstallStatePath,
  toDecisionLayerPlanJson,
} from './install/decision-layer-preview.mjs'
import {
  DECISION_PROVIDER_BUDGET_MAPPING,
  DECISION_ROUTER_MODELS,
  diffDecisionRouterSurfaces,
  readUserDecisionRouterConfig,
  resolveUserDecisionRouterConfigPath,
  updateUserDecisionRouterConfig,
  writeUserDecisionRouterConfig,
} from './install/decision-router-config.mjs'
import { readState } from './install/state.mjs'

const BUDGET_PROVIDERS = DECISION_PROVIDER_BUDGET_MAPPING

const USAGE =
  'Usage: decision-router help|status|setup|preview|select|enable|disable|consent|caps|period|holds'

/**
 * Malformed command line (wrong flags, unknown provider, invalid value).
 * Callers report it as a short message; a stack implies a bug, not bad input.
 */
export class DecisionRouterUsageError extends TypeError {
  name = 'DecisionRouterUsageError'
}

/** Read-only command help. Touches no file, ledger or environment path. */
export function decisionRouterHelp() {
  return [
    USAGE,
    '',
    'Read-only (never create, migrate or write anything):',
    '  help                                      this text',
    '  status [--target <dir>]                   configuration, egress posture and budget facts',
    '  setup [options]                           computed artifact diff; writes only with --apply',
    '  preview                                   alias of `setup` (never writes)',
    '  holds                                     unresolved reservations, read-only',
    '',
    'Explicit actions (each one changes exactly one thing):',
    '  select local|auto|<provider>/<model>       record a selection; enables nothing',
    '  enable | disable                          turn selection on or off',
    '  enable <provider> <model>                 toggle one candidate',
    '  consent yes|no                            record egress consent',
    '  caps user|provider <p>|model <p> <m> --monthly-usd N --per-decision-usd N',
    '  period confirm --current none|YYYY-MM --next YYYY-MM',
    '',
    'setup options:',
    '  --apply              write the previewed artifacts (otherwise nothing is written)',
    '  --json               machine-readable plan',
    '  --target <dir>       also reconcile <dir>/.pantheon/install-state.json when present',
    '  --selection <value>  same values as `select`',
    '  --accept-migration   allow a schema migration that would enable turn selection',
    '',
    `Egress default: ${V2_DECISION_EGRESS_DEFAULT}. Enablement, consent, one cap- and period-eligible`,
    'candidate and the host permission gate are all required; any missing item means zero requests.',
    `Provider endpoints are retained ${V2_DECISION_EGRESS_TRANSPORT.wireStatus} (UNWIRED) here; this`,
    'interface adds no transport and never claims the transport was removed.',
  ].join('\n')
}

/** Run an explicit, non-secret administrative command for the user-level router config. */
export async function runDecisionRouterCommand(
  args,
  { env = process.env, stdout = console.log } = {},
) {
  const [command, ...rest] = args

  if (command === 'help' || command === '--help' || command === '-h') {
    if (rest.length > 0) throw new DecisionRouterUsageError(USAGE)
    stdout(decisionRouterHelp())
    return
  }

  if (command === 'status') {
    const options = parseNamedFlags(rest, ['--target'])
    const config = readUserDecisionRouterConfig({ env })
    const dbPath = resolveLocalDecisionBudgetDbPath(env)
    const inspection = inspectDecisionBudget(dbPath)
    const wallPeriod = utcPeriodOf(Date.now())
    const egress = describeEgress(config, inspection, wallPeriod)

    stdout(`Config: ${resolveUserDecisionRouterConfigPath(env)}`)
    stdout(
      `Config file: ${existsSync(resolveUserDecisionRouterConfigPath(env)) ? 'present' : 'absent'}`,
    )
    stdout(`Enabled: ${config.enabled ? 'yes' : 'no'}`)
    stdout(`Selection: ${formatSelection(config.selection)}`)
    stdout(`Egress consent: ${config.egress_consent ? 'yes' : 'no'}`)
    stdout(
      `Enabled candidates: ${config.enabled_candidates.length ? config.enabled_candidates.map(formatCandidate).join(', ') : 'none'}`,
    )
    stdout(describeEgressLine(egress))
    stdout(`Ledger: ${formatLedger(inspection, dbPath)}`)
    stdout(`Budget period: ${formatPeriod(inspection)}`)
    stdout(`Caps: ${formatCaps(inspection)}`)
    if (options['--target'] !== undefined) {
      stdout(`Install-state: ${formatInstallState(config, options['--target'])}`)
    }
    stdout('Mode: read-only — status and help never create, migrate or write anything.')
    return
  }

  if (command === 'setup' || command === 'preview') {
    const options = parseSetupOptions(rest, command === 'preview')
    const plan = buildDecisionLayerPlan({
      env,
      ...(options['--target'] === undefined ? {} : { target: options['--target'] }),
      ...(options['--selection'] === undefined
        ? {}
        : { selection: parseSelectionTarget(options['--selection']) }),
      acceptMigration: options['--accept-migration'] === true,
    })
    if (options['--json'] === true) {
      stdout(JSON.stringify(toDecisionLayerPlanJson(plan), null, 2))
    } else {
      stdout(
        formatDecisionLayerPlan(plan, {
          scope: options['--target'] ?? 'user',
          applyPending: options['--apply'] === true,
        }),
      )
    }
    if (options['--apply'] === true) {
      const result = applyDecisionLayerPlan(plan, { env })
      stdout(
        `Applied: ${result.written.length} written, ${result.skipped.length} unchanged. ` +
          'No backup copy was created.',
      )
    }
    return
  }

  if (command === 'select') {
    const target = rest[0]
    if (rest.length !== 1 || typeof target !== 'string')
      throw new DecisionRouterUsageError('Usage: decision-router select local|auto|provider/model')
    const selection = parseSelectionTarget(target)
    const before = readUserDecisionRouterConfig({ env })
    saveConfig(env, { selection })
    const after = readUserDecisionRouterConfig({ env })
    const revoked = before.egress_consent && !after.egress_consent
    stdout(
      `Selection saved: ${formatSelection(selection)}. ${
        revoked
          ? 'Egress consent was revoked because the target changed; nothing was enabled.'
          : 'Enablement, consent, caps and period are unchanged.'
      }`,
    )
    return
  }

  if (command === 'enable' || command === 'disable') {
    const [provider, model, ...extra] = rest
    if (extra.length) {
      throw new DecisionRouterUsageError(`Usage: decision-router ${command} [<provider> <model>]`)
    }
    if (provider === undefined && model === undefined) {
      saveConfig(env, { enabled: command === 'enable' })
      stdout(
        `Turn selection ${command === 'enable' ? 'enabled' : 'disabled'}. Provider consent and candidate enablement are unchanged.`,
      )
      return
    }
    if (provider === undefined || !isKnownCandidate(provider, model)) {
      throw new DecisionRouterUsageError(`Usage: decision-router ${command} <provider> <model>`)
    }
    const config = readUserDecisionRouterConfig({ env })
    const key = candidateKey(provider, model)
    const candidates = config.enabled_candidates.filter(
      (candidate) => candidateKey(candidate.provider, candidate.model) !== key,
    )
    if (command === 'enable') candidates.push({ provider, model })
    saveConfig(env, { enabled_candidates: candidates })
    stdout(`${command === 'enable' ? 'Enabled' : 'Disabled'} ${provider}/${model}.`)
    return
  }

  if (command === 'consent') {
    const value = rest[0]
    if (rest.length !== 1 || (value !== 'yes' && value !== 'no')) {
      throw new DecisionRouterUsageError('Usage: decision-router consent yes|no')
    }
    saveConfig(env, { egress_consent: value === 'yes' })
    stdout(`Egress consent saved: ${value}.`)
    return
  }

  if (command === 'caps') {
    const [scope, ...scopeArgs] = rest
    const { monthly, perDecision, rest: targetArgs } = parseCaps(scopeArgs)
    const ledger = openLedger(env)
    try {
      if (scope === 'user' && targetArgs.length === 0) {
        ledger.configureUserCaps({ monthlyCapMicros: monthly, perDecisionCapMicros: perDecision })
      } else if (scope === 'provider' && targetArgs.length === 1) {
        const budgetProvider = Object.hasOwn(BUDGET_PROVIDERS, targetArgs[0])
          ? BUDGET_PROVIDERS[targetArgs[0]]
          : undefined
        if (!budgetProvider) throw new DecisionRouterUsageError('Unsupported budget provider')
        ledger.configureProviderCaps(budgetProvider, {
          monthlyCapMicros: monthly,
          perDecisionCapMicros: perDecision,
        })
      } else if (scope === 'model' && targetArgs.length === 2) {
        const [provider, model] = targetArgs
        if (!isKnownCandidate(provider, model))
          throw new DecisionRouterUsageError('Unsupported provider/model pair')
        ledger.configureModelCaps(BUDGET_PROVIDERS[provider], model, {
          monthlyCapMicros: monthly,
          perDecisionCapMicros: perDecision,
        })
      } else {
        throw new DecisionRouterUsageError(
          'Usage: decision-router caps user|provider <provider>|model <provider> <model> --monthly-usd N --per-decision-usd N',
        )
      }
    } finally {
      ledger.close()
    }
    stdout(
      `Configured ${scope} admission caps. Caps limit local admission; they are not invoice guarantees.`,
    )
    return
  }

  if (command === 'holds' && rest.length === 0) {
    // Read-only: a listing must never create, migrate or reserve anything (D8).
    const holds = listDecisionHoldsReadOnly(resolveLocalDecisionBudgetDbPath(env))
    if (holds === null || holds.length === 0) {
      stdout('No unresolved provider holds.')
      return
    }
    for (const hold of holds) {
      stdout(
        `Hold ${hold.reservationId}: status=${hold.state} provider=${hold.provider} model=${hold.model} period=${hold.period} reserved_micros=${hold.reservedMicros}`,
      )
    }
    stdout(
      'This listing is read-only: it does not reserve, reconcile, release or prune, it never ' +
        'creates or migrates the ledger, and unresolved holds are never auto-released. ' +
        'Reconcile or resolve them explicitly before pruning their period.',
    )
    return
  }

  if (command === 'period') {
    const [action, ...periodArgs] = rest
    if (action !== 'confirm')
      throw new DecisionRouterUsageError(
        'Usage: decision-router period confirm --current none|YYYY-MM --next YYYY-MM',
      )
    const options = parseNamedOptions(periodArgs, ['--current', '--next'])
    const expected = options['--current'] === 'none' ? null : options['--current']
    const target = options['--next']
    if ((expected !== null && !isMonth(expected)) || !isMonth(target)) {
      throw new DecisionRouterUsageError(
        'Budget periods must use YYYY-MM; initial current period is `none`',
      )
    }
    const ledger = openLedger(env)
    try {
      const result = ledger.confirmBudgetPeriod(expected, target)
      if (result.status !== 'confirmed')
        throw new Error(`Budget period confirmation denied: ${result.reason}`)
      stdout(`Explicit period confirmed: ${result.activePeriod}. Automatic rollover is disabled.`)
    } finally {
      ledger.close()
    }
    return
  }

  throw new DecisionRouterUsageError(USAGE)
}

/** Cap- and period-eligible candidates, read-only, from the separated surfaces. */
function capEligibleCandidates(config, inspection, wallPeriod) {
  if (inspection.caps === null) return []
  const period = evaluatePeriodGate({
    activePeriod: inspection.period.activePeriod,
    wallPeriod,
  })
  return config.enabled_candidates.filter(({ provider, model }) => {
    const accounting = DECISION_PROVIDER_BUDGET_MAPPING[provider]
    if (!accounting) return false
    const cap = evaluateCapGate({
      user: inspection.caps.user ?? undefined,
      provider: inspection.caps.providers[accounting],
      model: inspection.caps.models[`${accounting}/${model}`],
    })
    return cap.ok && period.ok
  })
}

function describeEgress(config, inspection, wallPeriod) {
  return resolveV2DecisionEgress(config, capEligibleCandidates(config, inspection, wallPeriod))
}

function describeEgressLine(egress) {
  if (egress.mode === 'opt-in') {
    return `Egress: opt-in (${egress.reason}) — ${egress.provider}/${egress.candidate.model}`
  }
  return `Egress: ${egress.mode} (${egress.reason}) — zero requests`
}

function formatLedger(inspection, dbPath) {
  const { ledger } = inspection
  if (!ledger.present) return `${dbPath} (absent; not created by this command)`
  if (!ledger.readable) return `${dbPath} (unreadable: ${ledger.reason})`
  return `${dbPath} (schema v${ledger.schemaVersion}, ${ledger.holds} unresolved hold(s), ${ledger.reservations} reservation(s))`
}

function formatPeriod(inspection) {
  const { ledger, period } = inspection
  if (!ledger.present) return 'unconfirmed (no ledger)'
  if (!ledger.readable) return `unknown (${ledger.reason})`
  return period.activePeriod ?? 'unconfirmed'
}

function formatCaps(inspection) {
  if (inspection.caps === null) return 'none (no ledger)'
  const providers = Object.keys(inspection.caps.providers).length
  const models = Object.keys(inspection.caps.models).length
  return `${inspection.caps.user === null ? 'user none' : 'user set'}, ${providers} provider, ${models} model`
}

function formatInstallState(config, target) {
  const statePath = resolveInstallStatePath(target)
  if (!existsSync(statePath)) return `no install-state at ${statePath} (nothing to reconcile)`
  const state = readState(target)
  if (state === null) {
    return `unreadable install-state at ${statePath} (left untouched; repair or reinstall first)`
  }
  const diff = diffDecisionRouterSurfaces(config, state.decision_router)
  if (diff.differences.length === 0) return `consistent with ${statePath}`
  const fields = diff.differences
    .map(
      (entry) =>
        `${entry.field}: install-state ${String(entry.installState)} -> user-config ${String(entry.userConfig)}`,
    )
    .join(', ')
  return `divergent from ${statePath} (${fields}); run \`decision-router setup --target ${target} --apply\``
}

function parseSelectionTarget(target) {
  if (target === 'local' || target === 'auto') return { mode: target }
  const [provider, model, ...extra] = String(target).split('/')
  if (extra.length || !isKnownCandidate(provider, model)) {
    throw new DecisionRouterUsageError('Selection must name one supported provider/model pair')
  }
  return { mode: 'explicit', provider, model }
}

function parseNamedFlags(args, expected) {
  const result = Object.create(null)
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!expected.includes(flag) || Object.hasOwn(result, flag)) {
      throw new DecisionRouterUsageError(USAGE)
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new DecisionRouterUsageError(USAGE)
    result[flag] = value
    index += 1
  }
  return result
}

function parseSetupOptions(args, forbidApply) {
  const result = Object.create(null)
  let index = 0
  while (index < args.length) {
    const flag = args[index]
    if (flag === '--apply') {
      if (forbidApply) {
        throw new DecisionRouterUsageError('preview never writes; use `setup --apply`')
      }
      if (result['--apply'] === true) throw new DecisionRouterUsageError(USAGE)
      result['--apply'] = true
      index += 1
      continue
    }
    if (flag === '--json' || flag === '--accept-migration') {
      if (result[flag] === true) throw new DecisionRouterUsageError(USAGE)
      result[flag] = true
      index += 1
      continue
    }
    if (flag === '--target' || flag === '--selection') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--') || Object.hasOwn(result, flag)) {
        throw new DecisionRouterUsageError(USAGE)
      }
      result[flag] = value
      index += 2
      continue
    }
    throw new DecisionRouterUsageError(USAGE)
  }
  return result
}

function saveConfig(env, update) {
  const current = readUserDecisionRouterConfig({ env })
  const next = updateUserDecisionRouterConfig(current, update)
  writeUserDecisionRouterConfig(next, { env })
}

function openLedger(env) {
  return openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath(env) })
}

function parseCaps(args) {
  const firstFlag = args.findIndex((arg) => arg.startsWith('--'))
  const targetArgs = firstFlag === -1 ? args : args.slice(0, firstFlag)
  const optionArgs = firstFlag === -1 ? [] : args.slice(firstFlag)
  const missing = ['--monthly-usd', '--per-decision-usd'].filter(
    (flag) => !optionArgs.includes(flag),
  )
  if (missing.length > 0) {
    throw new DecisionRouterUsageError('Both --monthly-usd and --per-decision-usd are required')
  }
  const flags = parseNamedOptions(optionArgs, ['--monthly-usd', '--per-decision-usd'])
  return {
    monthly: parseUsdMicros(flags['--monthly-usd']),
    perDecision: parseUsdMicros(flags['--per-decision-usd']),
    rest: targetArgs,
  }
}

function parseNamedOptions(args, expected) {
  if (args.length !== expected.length * 2)
    throw new DecisionRouterUsageError('Missing or extra command options')
  const result = Object.create(null)
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!expected.includes(key) || Object.hasOwn(result, key) || !value || value.startsWith('--')) {
      throw new DecisionRouterUsageError('Invalid or duplicate command option')
    }
    result[key] = value
  }
  if (expected.some((key) => !Object.hasOwn(result, key)))
    throw new DecisionRouterUsageError('Missing command option')
  return result
}

function parseUsdMicros(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new DecisionRouterUsageError(
      'USD cap must be a non-negative decimal with at most six fractional digits',
    )
  }
  const [whole, fraction = ''] = value.split('.')
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
  if (!Number.isSafeInteger(micros))
    throw new DecisionRouterUsageError('USD cap exceeds the supported range')
  return micros
}

function isKnownCandidate(provider, model) {
  return (
    typeof provider === 'string' &&
    typeof model === 'string' &&
    DECISION_ROUTER_MODELS[provider]?.includes(model)
  )
}

function isMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

function candidateKey(provider, model) {
  return `${provider}/${model}`
}

function formatSelection(selection) {
  if (selection.mode === 'explicit') return `${selection.provider}/${selection.model}`
  return selection.mode
}

function formatCandidate(candidate) {
  return `${candidate.provider}/${candidate.model}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDecisionRouterCommand(process.argv.slice(2)).catch((error) => {
    console.error(
      `Error: ${error instanceof Error ? error.message : 'Decision-router command failed'}`,
    )
    process.exitCode = 1
  })
}
