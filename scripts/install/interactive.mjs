#!/usr/bin/env node

import * as clack from '@clack/prompts'
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
 * @param {{ components?: string[], defaultComponents?: string[], noMcp?: boolean, prompts?: typeof clack, isTTY?: boolean }} [options]
 * @returns {Promise<{ components?: Set<string>, target?: string, confirmed?: boolean, canceled?: boolean, cancelPoint?: string }>}
 *
 * `cancelPoint` names the step the user stopped at (`components`, `target`,
 * `confirmation`), so the caller can print one explainable line and persist the
 * same stable key in the run record.
 */
export async function runInteractiveInstall({
  components = [],
  defaultComponents = [],
  noMcp = false,
  prompts = clack,
  isTTY = isTerminal(),
} = {}) {
  const isAllowed = (component) => !noMcp || component !== 'runtime'
  const defaults = (defaultComponents.length > 0 ? defaultComponents : components).filter(isAllowed)
  const defaultSet = new Set(defaults)

  // Preserve the prior no-TTY fallback (defaults, global target, and no apply
  // authorization) without asking a terminal prompt library to access stdin.
  if (!isTTY) return { components: defaultSet, target: 'global', confirmed: true }

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

  const confirmed = await prompts.confirm({
    message: `Install ${selectedComponents.size} component(s) in ${target === 'global' ? 'global config' : 'current project'}?`,
    initialValue: true,
  })
  if (cancelPrompt(prompts, confirmed, 'confirmation')) {
    return { canceled: true, cancelPoint: 'confirmation' }
  }

  return { components: selectedComponents, target, confirmed }
}
