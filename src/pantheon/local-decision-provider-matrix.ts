/**
 * Private provider matrix: fixed provider/model rows and their ledger
 * accounting mapping. No network I/O, no endpoints, no credentials — the
 * direct-fetch adapter fields were removed with the legacy fetch runner; the
 * only egress transport is the host's native Decisions layer, whose provider
 * and credentials the host owns. Pantheon uses this matrix for the config
 * candidate model IDs and ledger accounting names only.
 */
import {
  DECISION_PROVIDER_BUDGET_MAPPING,
  DECISION_ROUTER_MODELS,
} from '../../scripts/install/decision-router-config.mjs'
import type { BudgetProvider } from './local-decision-budget.ts'

export type DecisionProviderId =
  | 'openai-decisions'
  | 'typesafe-jev'
  | 'opencode-console-jev'
  | 'opencode-console-jev-free'

/**
 * Single provider matrix. Model and accounting IDs come from the canonical
 * config so the route resolver and the ledger can never drift silently.
 */
export const DECISION_PROVIDER_ADAPTERS: Readonly<
  Record<DecisionProviderId, { model: string; accountingProvider: BudgetProvider }>
> = Object.freeze(
  Object.fromEntries(
    (Object.keys(DECISION_ROUTER_MODELS) as DecisionProviderId[]).map((provider) => {
      const model = DECISION_ROUTER_MODELS[provider]?.[0]
      if (model === undefined) throw new Error(`Missing decision provider model: ${provider}`)
      return [
        provider,
        Object.freeze({
          model,
          accountingProvider: DECISION_PROVIDER_BUDGET_MAPPING[provider] as BudgetProvider,
        }),
      ]
    }),
  ) as Record<
    DecisionProviderId,
    { readonly model: string; readonly accountingProvider: BudgetProvider }
  >,
)
