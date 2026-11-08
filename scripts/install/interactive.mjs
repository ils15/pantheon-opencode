#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as clack from '@clack/prompts'
import {
  createDecisionRouterConfig,
  DECISION_ROUTER_PROVIDERS,
  DEFAULT_DECISION_ROUTER_CONFIG,
  migrateDecisionRouterConfig,
} from './decision-router-config.mjs'
import { PROMPT_CANCELED } from './prompt-result.mjs'
import { strings } from './strings.mjs'

export { PROMPT_CANCELED }

function isTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

/**
 * Print the ONE cancel line, naming where the user stopped.
 *
 * The point is a stable key from the string table (`cancelPoints`), so the same
 * identifier can be persisted in the run record without parsing prose.
 *
 * @param {typeof clack} prompts
 * @param {unknown} value a prompt result
 * @param {string} point stable cancel-point key
 * @returns {boolean} whether the prompt was canceled
 */
function cancelPrompt(prompts, value, point) {
  if (!prompts.isCancel(value)) return false
  const S = strings()
  prompts.cancel(S.canceledAt(S.cancelPoints[point] ?? point))
  return true
}

/**
 * Prompt for authorization to apply a reviewed installer plan.
 *
 * @param {string} planSummary Summary of the changes that require approval.
 * @param {{ default?: boolean, prompts?: typeof clack, isTTY?: boolean }} [options]
 * @returns {Promise<boolean | typeof PROMPT_CANCELED>} True if authorized, false if declined, or the cancellation sentinel.
 */
export async function promptReview(
  planSummary,
  { default: defaultValue = false, prompts = clack, isTTY = isTerminal() } = {},
) {
  if (!isTTY) return false
  const result = await prompts.confirm({ message: planSummary, initialValue: defaultValue })
  if (cancelPrompt(prompts, result, 'review')) return PROMPT_CANCELED
  return result === true
}

/**
 * Collect interactive setup choices before the installer begins any writes.
 *
 * @param {{ components?: string[], defaultComponents?: string[], noMcp?: boolean, prompts?: typeof clack, isTTY?: boolean, env?: Record<string, string | undefined>, getDecisionRouterConfig?: (target: string) => unknown }} [options]
 * @returns {Promise<{ components?: Set<string>, target?: string, decisionRouterConfig?: object, decisionModelActivation?: object | null, decisionModelDeferredSetup?: object | null, canceled?: boolean, cancelPoint?: string }>}
 *
 * `cancelPoint` names the setup choice where the user stopped (`components` or
 * `target`), so the caller can print one explainable line and persist the same
 * stable key in the run record.
 */
export async function runInteractiveInstall({
  components = [],
  defaultComponents = [],
  noMcp = false,
  env = process.env,
  getDecisionRouterConfig = () => DEFAULT_DECISION_ROUTER_CONFIG,
  prompts = clack,
  isTTY = isTerminal(),
} = {}) {
  const isAllowed = (component) => !noMcp || component !== 'runtime'
  const defaults = (defaultComponents.length > 0 ? defaultComponents : components).filter(isAllowed)
  const defaultSet = new Set(defaults)

  // Preserve the same component and target defaults without asking a terminal
  // prompt library to access stdin. Apply authorization is handled once, after
  // the installer has built and displayed the complete plan. Re-read the
  // selected default target's preference so --interactive without a TTY does
  // not reset an existing provider choice or consent on update.
  if (!isTTY) {
    return {
      components: defaultSet,
      target: 'global',
      decisionRouterConfig: migrateDecisionRouterConfig(getDecisionRouterConfig('global')),
    }
  }

  prompts.intro?.('OpenCode Installer')

  const componentOptions = [
    { label: 'agents', value: 'agents', hint: 'Agent configurations and routing (14 agents)' },
    { label: 'skills', value: 'skills', hint: `Reusable skill workflows (${23} skills)` },
    { label: 'instructions', value: 'instructions', hint: 'AGENTS.md and instructional files' },
    { label: 'prompts', value: 'prompts', hint: 'Prompt templates for agents' },
    { label: 'commands', value: 'commands', hint: 'OpenCode command shortcuts' },
    { label: 'plugins', value: 'plugins', hint: 'TUI sidebar plugin' },
    { label: 'runtime', value: 'runtime', hint: 'Python venv + MCP server scripts' },
  ].filter((option) => isAllowed(option.value))
  const chosen = await prompts.multiselect({
    message: 'Select components to install:',
    options: componentOptions,
    initialValues: [...defaultSet],
    required: false,
  })
  if (cancelPrompt(prompts, chosen, 'components'))
    return { canceled: true, cancelPoint: 'components' }

  const selectedComponents = new Set(chosen.filter(isAllowed))
  if (selectedComponents.size === 0) {
    const S = strings()
    prompts.cancel?.(S.canceledAt(S.cancelPoints.components))
    return { canceled: true, cancelPoint: 'components' }
  }

  const target = await prompts.select({
    message: 'Install location:',
    options: [
      {
        label: 'Global directory',
        value: 'global',
        hint: '~/.config/opencode (shared across projects)',
      },
      { label: 'Current project', value: 'project', hint: './.opencode (scoped to this project)' },
    ],
  })
  if (cancelPrompt(prompts, target, 'target')) return { canceled: true, cancelPoint: 'target' }

  // The old four-option metadata prompt (Local/OpenAI/Jev/Auto) recorded an
  // installer preference that controlled nothing at runtime and confused
  // everyone. The interactive question is now the honest one: configure the
  // Jev decision model now (one write, explicit caps) or skip — the CLI
  // (`decision-router setup-model`) remains the later path either way. The
  // legacy installer-state record stays at its default (Local): metadata the
  // runtime never reads, while real consent lives in the user-level config
  // that setup-model writes.
  const jevActivation = await prompts.select({
    message:
      'Configure the Jev decision model now? (Console, OpenRouter, and TypeSafe activate here; Cloudflare is provisioned after install)',
    options: [
      {
        label: 'Skip (default)',
        value: 'skip',
        hint: 'Configure later: decision-router setup-model',
      },
      {
        label: 'OpenCode Console Jev (stock)',
        value: 'opencode-console-jev/jev-1.13',
        hint: consoleJevHint(env),
      },
      {
        label: 'OpenRouter-hosted Jev',
        value: 'openrouter-jev/typesafe/jev-1.13',
        hint: openrouterJevHint(),
      },
      {
        label: 'TypeSafe Jev (direct)',
        value: 'typesafe-jev/jev-1.14.0',
        hint: typesafeJevHint(env),
      },
      {
        label: 'Cloudflare Clef (provision after install)',
        value: 'cloudflare-workers-jev/clef',
        hint: cloudflareJevHint(env),
      },
    ],
    initialValue: 'skip',
  })
  if (cancelPrompt(prompts, jevActivation, 'decisionRouter')) {
    return { canceled: true, cancelPoint: 'decisionRouter' }
  }

  // Decision-layer options: the shadow gates and the specialist-caller
  // allowlist are first-class setup choices. The installer writes a flags
  // file the user sources (the host reads these at plugin registration from
  // its own environment — the installer never edits shell profiles silently).
  const jevFlags = await prompts.multiselect({
    message:
      'Decision layer extras (shadow gates are observe-only; specialist access is explicit):',
    options: [
      {
        label: 'J1 risk-score shadow gate',
        value: 'PANTHEON_J1_RISK_SCORE=on',
        hint: 'Records a Jev risk-score per exfil-capable tool call; observe-only',
      },
      {
        label: 'J3 escalation shadow classifier',
        value: 'PANTHEON_J3_ESCALATION=on',
        hint: 'Records cheap-vs-main per delegate dispatch; never applies overrides in shadow',
      },
      {
        label: 'Specialist callers: athena + themis (explicit questions)',
        value: 'PANTHEON_JEV_SPECIALIST_CALLERS=athena,themis',
        hint: 'Allowlisted specialists may ask bounded Jev questions mid-task; presets stay Zeus-only',
      },
    ],
    required: false,
    // Ship-enabled default (field beta.16→28: the owner's setup ships the
    // decision layer ON — J1/J3 in shadow are observe-only and safe; the
    // user can uncheck any of them before confirming).
    initialValues: [
      'PANTHEON_J1_RISK_SCORE=on',
      'PANTHEON_J3_ESCALATION=on',
      'PANTHEON_JEV_SPECIALIST_CALLERS=athena,themis',
    ],
  })
  if (cancelPrompt(prompts, jevFlags, 'decisionFlags')) {
    return { canceled: true, cancelPoint: 'decisionFlags' }
  }
  // Cloudflare needs an account-specific host provider entry. It remains an
  // explicit deferred choice; setup-model must receive --account-id before any
  // route is enabled.
  const KNOWN_JEV_TARGETS = new Set([
    'opencode-console-jev/jev-1.13',
    'openrouter-jev/typesafe/jev-1.13',
    'typesafe-jev/jev-1.14.0',
  ])
  const cloudflareDeferred = jevActivation === 'cloudflare-workers-jev/clef'
  const activationChoice =
    typeof jevActivation === 'string' && KNOWN_JEV_TARGETS.has(jevActivation)
      ? jevActivation
      : 'skip'
  let decisionModelActivation = null
  const decisionModelDeferredSetup = cloudflareDeferred
    ? { target: 'cloudflare-workers-jev/clef' }
    : null
  if (activationChoice !== 'skip') {
    // Caps prompts degrade to the recommended defaults when the prompt
    // implementation has no text input (stubbed tests, restricted TTYs).
    const askText = async (message, fallback) => {
      if (typeof prompts.text !== 'function') return fallback
      const answer = await prompts.text({ message, defaultValue: fallback, placeholder: fallback })
      if (cancelPrompt(prompts, answer, 'decisionRouter')) {
        return { canceled: true }
      }
      return String(answer || fallback)
    }
    const monthly = await askText('Monthly USD cap for decision calls (e.g. 5)', '5')
    if (monthly && typeof monthly === 'object') {
      return { canceled: true, cancelPoint: 'decisionRouter' }
    }
    const perDecision = await askText('Per-decision USD cap (e.g. 0.10)', '0.10')
    if (perDecision && typeof perDecision === 'object') {
      return { canceled: true, cancelPoint: 'decisionRouter' }
    }
    decisionModelActivation = {
      target: activationChoice,
      monthly: String(monthly || '5'),
      perDecision: String(perDecision || '0.10'),
    }
  }

  // Empty/absent caller allowlist is intentionally Zeus-only. Persist that
  // default too, so rerunning the wizard cannot leave a prior allowlist active.
  const selectedFlags = Array.isArray(jevFlags) ? jevFlags : []
  const hasCallerFlag = selectedFlags.some((flag) =>
    flag.startsWith('PANTHEON_JEV_SPECIALIST_CALLERS='),
  )
  const flagsDir = join(env.XDG_CONFIG_HOME || `${env.HOME}/.config`, 'pantheon')
  mkdirSync(flagsDir, { recursive: true, mode: 0o700 })
  const flagsPath = join(flagsDir, 'decision-flags.env')
  const lines = selectedFlags.map((flag) => `export ${flag}`)
  if (!hasCallerFlag) lines.push('export PANTHEON_JEV_SPECIALIST_CALLERS=')
  writeFileSync(
    flagsPath,
    `# Pantheon decision layer — source from your shell profile\n${lines.join('\n')}\n`,
  )

  return {
    components: selectedComponents,
    target,
    decisionRouterConfig: createDecisionRouterConfig(DECISION_ROUTER_PROVIDERS[0], false),
    decisionModelActivation,
    decisionModelDeferredSetup,
  }
}

/** Credential-state hints for the Jev wizard routes (set at prompt time). */
function consoleJevHint(env = process.env) {
  return env.OPENCODE_API_KEY
    ? 'Zen credits via OPENCODE_API_KEY — ✓ detected in this shell'
    : 'Zen credits via OPENCODE_API_KEY — export it first (opencode.ai/console)'
}

function openrouterJevHint() {
  return 'Uses the host OpenRouter credential (opencode auth list); billed per decision'
}

function typesafeJevHint(env = process.env) {
  return env.TYPESAFE_API_KEY
    ? '✓ TYPESAFE_API_KEY detected — the installer merges the provider entry'
    : 'export TYPESAFE_API_KEY first; the installer merges the provider entry'
}

function cloudflareJevHint(env = process.env) {
  const tokenHint = env.CLOUDFLARE_API_TOKEN
    ? 'CLOUDFLARE_API_TOKEN detected'
    : 'requires a Workers AI-scoped CLOUDFLARE_API_TOKEN'
  return `${tokenHint}; not activated by this wizard. After install run: npx pantheon-opencode decision-router setup-model cloudflare-workers-jev/clef --account-id=<32-hex-id> --monthly-usd 5 --per-decision-usd 0.10`
}
