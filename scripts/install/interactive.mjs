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
 * Historical note (beta.5): `runInteractiveInstall` — the component/target/
 * decision-model wizard — was removed. `init` is now defaults + the plan
 * preview + ONE authorization (`promptReview`); everything the wizard used to
 * ask lives in `/pantheon-settings` (gates, decision router, preset) or in
 * explicit flags (`--components`, `--project`, `--decision-model`).
 */
