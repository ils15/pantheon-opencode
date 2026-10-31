#!/usr/bin/env node

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
 * @param {{ components?: string[], defaultComponents?: string[], noMcp?: boolean, prompts?: typeof clack, isTTY?: boolean, getDecisionRouterConfig?: (target: string) => unknown }} [options]
 * @returns {Promise<{ components?: Set<string>, target?: string, decisionRouterConfig?: object, canceled?: boolean, cancelPoint?: string }>}
 *
 * `cancelPoint` names the setup choice where the user stopped (`components` or
 * `target`), so the caller can print one explainable line and persist the same
 * stable key in the run record.
 */
export async function runInteractiveInstall({
  components = [],
  defaultComponents = [],
  noMcp = false,
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
    { label: 'skills', value: 'skills', hint: `Reusable skill workflows (${20} skills)` },
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

  const previousConfig = migrateDecisionRouterConfig(getDecisionRouterConfig(target))
  const provider = await prompts.select({
    message:
      'Decision-router installer preference (default: Local). This records target-specific metadata only; runtime provider/model settings, egress consent, caps, and period confirmation are managed separately with `npx pantheon-opencode decision-router ...`. Installation makes no provider requests.',
    options: [
      {
        label: 'Local',
        value: DECISION_ROUTER_PROVIDERS[0],
        hint: 'Local recommendation logic; no task data is sent to a provider',
      },
      {
        label: 'OpenAI Decisions',
        value: DECISION_ROUTER_PROVIDERS[1],
        hint: 'GPT-6 Luna installer metadata only; set runtime config separately',
      },
      {
        label: 'Jev',
        value: DECISION_ROUTER_PROVIDERS[2],
        hint: 'TypeSafe Jev installer metadata only; set runtime config separately',
      },
      {
        label: 'Auto',
        value: DECISION_ROUTER_PROVIDERS[3],
        hint: 'Installer metadata only; runtime Auto requires one cap-valid enabled candidate',
      },
    ],
    initialValue: previousConfig.provider,
  })
  if (cancelPrompt(prompts, provider, 'decisionRouter')) {
    return { canceled: true, cancelPoint: 'decisionRouter' }
  }

  let egressConsent = false
  if (provider !== 'local') {
    const providerLabel =
      provider === 'openai-decisions'
        ? 'OpenAI Decisions'
        : provider === 'jev'
          ? 'Jev'
          : 'the Auto-selected provider'
    const consent = await prompts.confirm({
      message:
        `Save a legacy installer consent preference for potential future ${providerLabel} use? ` +
        'This is not runtime consent and does not authorize provider transmission. Configure actual user-level consent and caps with `npx pantheon-opencode decision-router ...`. Installation makes no provider requests.',
      initialValue: previousConfig.provider === provider && previousConfig.egress_consent,
    })
    if (cancelPrompt(prompts, consent, 'egressConsent')) {
      return { canceled: true, cancelPoint: 'egressConsent' }
    }
    egressConsent = consent === true
  }

  return {
    components: selectedComponents,
    target,
    decisionRouterConfig: createDecisionRouterConfig(provider, egressConsent),
  }
}
