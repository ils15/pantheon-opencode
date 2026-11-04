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
  inspectTypesafeHostProvider,
  provisionCloudflareHostProvider,
  provisionTypesafeHostProvider,
  readUserDecisionRouterConfig,
  resolveUserDecisionRouterConfigPath,
  updateUserDecisionRouterConfig,
  writeUserDecisionRouterConfig,
} from './install/decision-router-config.mjs'
import { readState } from './install/state.mjs'

const BUDGET_PROVIDERS = DECISION_PROVIDER_BUDGET_MAPPING

const USAGE =
  'Usage: decision-router help|status|setup|preview|select|enable|disable|consent|caps|period|holds|setup-model|doctor'

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
    'Guided (each does the whole chain in one command):',
    '  setup-model <provider>/<model> --monthly-usd N --per-decision-usd N [--no-consent]',
    '                                           select + enable + consent + caps + period in one write,',
    '                                           then print the verification summary',
    '  doctor                                    read-only diagnosis of the native decision route with',
    '                                           the exact command to run for each failing gate',
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

  if (command === 'setup-model') {
    const [target, ...flagArgs] = rest
    const selection = parseSelectionTarget(target)
    if (selection.mode !== 'explicit') {
      throw new DecisionRouterUsageError(
        'setup-model requires an explicit provider/model pair, not local or auto',
      )
    }
    const noConsent = flagArgs.includes('--no-consent')
    const capArgs = flagArgs.filter(
      (arg) => arg !== '--no-consent' && !arg.startsWith('--account-id='),
    )
    // Exactly the two caps flags with values; parseCaps validates them and
    // leaves `rest` empty because setup-model has no positional caps targets.
    if (capArgs.length !== 4) throw new DecisionRouterUsageError(USAGE)
    const caps = parseCaps(capArgs)
    if (caps.rest.length > 0) throw new DecisionRouterUsageError(USAGE)
    const { provider, model } = selection
    const candidate = { provider, model }

    // One update names selection, enablement, candidates and (unless refused)
    // consent together: selecting a different target revokes consent unless
    // the same update names it, so this single write is the consent act.
    saveConfig(env, {
      enabled: true,
      selection,
      enabled_candidates: [candidate],
      ...(noConsent ? {} : { egress_consent: true }),
    })
    stdout(`Selected and enabled ${provider}/${model}.`)
    stdout(
      noConsent ? 'Egress consent NOT recorded (--no-consent).' : 'Egress consent recorded: yes.',
    )

    // The Cloudflare route needs a custom entry with the accountId (the
    // host's embedded cloudflare-workers-ai module reads the token from
    // CLOUDFLARE_API_TOKEN and the account from the entry options).
    if (provider === 'cloudflare-workers-jev') {
      const accountId = flagArgs.find((arg) => arg.startsWith('--account-id='))
      const provision = provisionCloudflareHostProvider({
        accountId: accountId?.split('=')[1],
        env,
      })
      if (provision.ok) {
        stdout(
          `Cloudflare provider entry merged into ${provision.path} (accountId + models.clef, type "decision"). ` +
            'The token comes from CLOUDFLARE_API_TOKEN (Workers AI-scoped token) in the host environment.',
        )
      } else {
        stdout(
          `⚠ Cloudflare provider entry NOT merged: ${provision.reason}` +
            ' — pass --account-id=<32-hex Cloudflare account id>.',
        )
      }
    }

    // The TypeSafe route needs a host-side provider entry the decisions API
    // can resolve; the Console routes are host-native and need none. The
    // merge is additive and idempotent; a failure is a printed warning (the
    // decision config stays valid — the call fails at the host until the
    // entry exists).
    if (provider === 'typesafe-jev') {
      const provision = provisionTypesafeHostProvider({ env })
      if (provision.ok) {
        stdout(
          `TypeSafe provider entry merged into ${provision.path} (adapter + baseURL + apiKey via {env:TYPESAFE_API_KEY}, type "decision"). ` +
            'Activate: export TYPESAFE_API_KEY=<your TypeSafe key> and restart OpenCode. /connect does not carry custom providers.',
        )
      } else {
        stdout(`⚠ TypeSafe provider entry NOT merged: ${provision.reason}`)
      }
    }

    const ledger = openLedger(env)
    try {
      ledger.configureUserCaps({
        monthlyCapMicros: caps.monthly,
        perDecisionCapMicros: caps.perDecision,
      })
      ledger.configureProviderCaps(DECISION_PROVIDER_BUDGET_MAPPING[provider], {
        monthlyCapMicros: caps.monthly,
        perDecisionCapMicros: caps.perDecision,
      })
      ledger.configureModelCaps(DECISION_PROVIDER_BUDGET_MAPPING[provider], model, {
        monthlyCapMicros: caps.monthly,
        perDecisionCapMicros: caps.perDecision,
      })
      stdout(
        `Caps set (user/provider/model): $${(caps.monthly / 1_000_000).toFixed(2)}/month, $${(caps.perDecision / 1_000_000).toFixed(2)}/decision.`,
      )
      const wallPeriod = utcPeriodOf(Date.now())
      const active = ledger.getActiveBudgetPeriod()
      if (active === wallPeriod) {
        stdout(`Budget period already active: ${wallPeriod}.`)
      } else {
        const result = ledger.confirmBudgetPeriod(active, wallPeriod)
        if (result.status === 'confirmed') {
          stdout(`Budget period confirmed: ${result.activePeriod}. Automatic rollover is disabled.`)
        } else {
          stdout(
            `Budget period NOT confirmed (${result.reason}); run: decision-router period confirm --current ${active ?? 'none'} --next ${wallPeriod}`,
          )
        }
      }
    } finally {
      ledger.close()
    }

    stdout('')
    stdout('Native route checklist:')
    // Decision models are not chat models: they never appear in the host
    // model catalog (field evidence 2.2.5: 561 entries, 0 jev, while the
    // decisions API answers the same ref directly). No catalog step here.
    stdout('  1. Restart OpenCode so the plugin registers pantheon_jev_decide.')
    stdout('  2. Ask the Zeus agent to call pantheon_jev_decide (mode: "delegation" or "skills").')
    stdout('Read-only verification: decision-router status / doctor / holds.')
    return
  }

  if (command === 'doctor' && rest.length === 0) {
    // Read-only diagnosis. The host-catalog probe runs `opencode models` with a
    // timeout; a missing/unavailable binary is a warning, not a failure.
    const config = readUserDecisionRouterConfig({ env })
    const dbPath = resolveLocalDecisionBudgetDbPath(env)
    const inspection = inspectDecisionBudget(dbPath)
    const wallPeriod = utcPeriodOf(Date.now())
    const egress = describeEgress(config, inspection, wallPeriod)
    const rows = []
    const fail = (name, detail, fix) => rows.push({ name, state: 'FAIL', detail, fix })
    const warn = (name, detail, fix) => rows.push({ name, state: 'WARN', detail, fix })
    const pass = (name, detail) => rows.push({ name, state: 'PASS', detail })

    if (!existsSync(resolveUserDecisionRouterConfigPath(env))) {
      fail(
        'config',
        'no user-level config yet',
        'decision-router setup-model <provider>/<model> --monthly-usd N --per-decision-usd N',
      )
    } else if (!config.enabled) {
      fail('config', 'turn selection is disabled', 'decision-router enable')
    } else {
      pass('config', 'enabled')
    }
    if (config.enabled && !config.egress_consent) {
      fail(
        'consent',
        'egress consent missing',
        'decision-router consent yes (or rerun setup-model without --no-consent)',
      )
    } else if (config.enabled) {
      pass('consent', 'recorded')
    }

    const selection = config.selection
    if (config.enabled && selection.mode === 'local') {
      fail('selection', 'selection is local', 'decision-router select <provider>/<model>')
    } else if (config.enabled && selection.mode === 'auto') {
      if (egress.mode === 'opt-in')
        pass('selection', `auto resolved ${egress.provider}/${egress.candidate.model}`)
      else
        fail(
          'selection',
          `auto did not resolve (${egress.reason})`,
          'enable exactly one cap-valid candidate, or select explicitly',
        )
    } else if (config.enabled && selection.mode === 'explicit') {
      const enabled = config.enabled_candidates.some(
        (candidate) =>
          candidate.provider === selection.provider && candidate.model === selection.model,
      )
      if (!enabled) {
        fail(
          'selection',
          `${selection.provider}/${selection.model} selected but not enabled`,
          `decision-router enable ${selection.provider} ${selection.model}`,
        )
      } else {
        pass('selection', `${selection.provider}/${selection.model}`)
      }
    }

    if (config.enabled && egress.mode !== 'opt-in' && config.egress_consent) {
      fail(
        'budget',
        `no cap- and period-eligible candidate (${egress.reason})`,
        'decision-router caps user|provider|model ... and decision-router period confirm',
      )
    } else if (config.enabled && egress.mode === 'opt-in') {
      pass('budget', `admission open for ${egress.provider}/${egress.candidate.model}`)
    }
    if (inspection.ledger.present && inspection.ledger.readable && inspection.ledger.holds > 0) {
      warn(
        'holds',
        `${inspection.ledger.holds} unresolved hold(s) hold budget until reconciled`,
        'decision-router holds',
      )
    }

    const target =
      config.enabled && selection.mode === 'explicit'
        ? selection
        : egress.mode === 'opt-in'
          ? { provider: egress.provider, model: egress.candidate.model }
          : null
    if (target !== null) {
      // Route-aware checks, not a catalog probe: decision models are not chat
      // models and never appear in `opencode models` (field evidence 2.2.5:
      // 561 entries, 0 jev, while the decisions API answers the same ref).
      if (target.provider === 'openrouter-jev' || target.provider === 'vercel-gateway-jev') {
        const envName =
          target.provider === 'openrouter-jev' ? 'OPENROUTER_API_KEY' : 'AI_GATEWAY_API_KEY'
        pass(
          'native-route',
          `host-native ${target.provider === 'openrouter-jev' ? 'openrouter' : 'vercel-ai-gateway'} route; credential ${envName} via /connect or the environment`,
        )
      } else if (target.provider === 'cloudflare-workers-jev') {
        warn(
          'native-route',
          'host module exists but the provider needs a custom entry with your Cloudflare accountId (models.dev does not carry it)',
          'add providers["cloudflare-workers-ai"] with accountId + CLOUDFLARE_API_TOKEN (scoped Workers AI token); model clef',
        )
      } else if (target.provider === 'typesafe-jev') {
        const hostProvider = inspectTypesafeHostProvider({ env })
        if (!hostProvider.present) {
          fail(
            'native-route',
            `opencode.json has no providers.typesafe-ai entry (${hostProvider.path})`,
            'decision-router setup-model typesafe-jev/jev-1.14.0 merges the full provider entry (adapter, baseURL, apiKey ref)',
          )
        } else if (!hostProvider.hasCredential) {
          warn(
            'native-route',
            'provider entry has no apiKey',
            'set the TypeSafe key: export TYPESAFE_API_KEY=... and re-run setup-model (writes {env:TYPESAFE_API_KEY}), or add options.apiKey to the entry',
          )
        } else {
          pass(
            'native-route',
            `typesafe-ai provider entry present (${hostProvider.path}); credential ${
              hostProvider.viaEnvRef
                ? `via env reference (${hostProvider.apiKeyRef}) — resolved by the host at call time`
                : 'inline in the entry'
            }`,
          )
        }
      } else {
        pass(
          'native-route',
          'host-native opencode route; decision models are not listed in the chat catalog by design',
        )
      }
    }

    for (const row of rows) {
      const mark = row.state === 'PASS' ? '✔' : row.state === 'WARN' ? '▲' : '✖'
      stdout(`${mark} ${row.name}: ${row.detail}`)
      if (row.fix) stdout(`    fix → ${row.fix}`)
    }
    stdout('Read-only: doctor never creates, migrates or writes anything.')
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
