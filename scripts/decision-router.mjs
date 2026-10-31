#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
// Prebuilt bundle: Node refuses to strip TypeScript types under node_modules,
// so the published CLI cannot import the ledger source directly. Regenerate
// with `npm run build:decision-router`; `--check` guards against drift.
import {
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from './decision-router-budget.mjs'
import {
  DECISION_PROVIDER_BUDGET_MAPPING,
  DECISION_ROUTER_MODELS,
  readUserDecisionRouterConfig,
  resolveUserDecisionRouterConfigPath,
  updateUserDecisionRouterConfig,
  writeUserDecisionRouterConfig,
} from './install/decision-router-config.mjs'

const BUDGET_PROVIDERS = DECISION_PROVIDER_BUDGET_MAPPING

/**
 * Malformed command line (wrong flags, unknown provider, invalid value).
 * Callers report it as a short message; a stack implies a bug, not bad input.
 */
export class DecisionRouterUsageError extends TypeError {
  name = 'DecisionRouterUsageError'
}

/** Run an explicit, non-secret administrative command for the user-level router config. */
export async function runDecisionRouterCommand(
  args,
  { env = process.env, stdout = console.log } = {},
) {
  const [command, ...rest] = args
  if (command === 'status' && rest.length === 0) {
    const config = readUserDecisionRouterConfig({ env })
    const ledger = openLedger(env)
    try {
      stdout(`Config: ${resolveUserDecisionRouterConfigPath(env)}`)
      stdout(`Enabled: ${config.enabled ? 'yes' : 'no'}`)
      stdout(`Selection: ${formatSelection(config.selection)}`)
      stdout(`Egress consent: ${config.egress_consent ? 'yes' : 'no'}`)
      stdout(
        `Enabled candidates: ${config.enabled_candidates.length ? config.enabled_candidates.map(formatCandidate).join(', ') : 'none'}`,
      )
      stdout(`Active budget period: ${ledger.getActiveBudgetPeriod() ?? 'unconfirmed'}`)
    } finally {
      ledger.close()
    }
    return
  }

  if (command === 'select') {
    const target = rest[0]
    if (rest.length !== 1 || typeof target !== 'string')
      throw new DecisionRouterUsageError('Usage: decision-router select local|auto|provider/model')
    let selection
    if (target === 'local' || target === 'auto') {
      selection = { mode: target }
    } else {
      const [provider, model, ...extra] = target.split('/')
      if (extra.length || !isKnownCandidate(provider, model)) {
        throw new DecisionRouterUsageError('Selection must name one supported provider/model pair')
      }
      selection = { mode: 'explicit', provider, model }
    }
    saveConfig(env, { selection })
    stdout(`Selection saved: ${formatSelection(selection)}. Consent and enablement are unchanged.`)
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
    if (!existsSync(resolveLocalDecisionBudgetDbPath(env))) {
      stdout('No unresolved provider holds.')
      return
    }
    const ledger = openLedger(env)
    try {
      const holds = ledger.listUncertainReservations()
      if (holds.length === 0) {
        stdout('No unresolved provider holds.')
        return
      }
      for (const hold of holds) {
        stdout(
          `Hold ${hold.reservationId}: status=${hold.state} provider=${hold.provider} model=${hold.model} period=${hold.period} reserved_micros=${hold.reservedMicros}`,
        )
      }
      stdout(
        'This listing does not reserve, reconcile, release, or prune holds. ' +
          'Opening an existing ledger may apply a forward-only schema migration. ' +
          'Unresolved holds are never auto-released; reconcile or resolve them ' +
          'explicitly before pruning their period.',
      )
    } finally {
      ledger.close()
    }
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

  throw new DecisionRouterUsageError(
    'Usage: decision-router status|select|enable|disable|consent|caps|period|holds',
  )
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
