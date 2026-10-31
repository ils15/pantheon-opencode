/**
 * Private provider matrix: fixed provider/model/endpoint/credential rows and
 * their ledger accounting mapping. No network I/O and no caller-supplied
 * transport, config, env, or ledger.
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

export type DecisionProtocol = 'openai' | 'systemone'

export const PROVIDER_MAX_RESPONSE_BYTES = 64 * 1024
export const PROVIDER_REQUEST_TIMEOUT_MS = 5_000

export interface DecisionProviderAdapter {
  model: string
  endpoint: string
  credentialEnv: string
  accountingProvider: BudgetProvider
  egressEligible: boolean
  protocol: DecisionProtocol
}

const ADAPTER_DEFINITIONS: Readonly<
  Record<
    DecisionProviderId,
    {
      endpoint: string
      credentialEnv: string
      egressEligible: boolean
      protocol: DecisionProtocol
    }
  >
> = Object.freeze({
  'openai-decisions': {
    endpoint: 'https://api.openai.com/v1/decisions',
    credentialEnv: 'OPENAI_API_KEY',
    egressEligible: true,
    protocol: 'openai',
  },
  'typesafe-jev': {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    credentialEnv: 'TYPESAFE_API_KEY',
    egressEligible: true,
    protocol: 'systemone',
  },
  'opencode-console-jev': {
    endpoint: 'https://opencode.ai/inference/systemone/v1/systemone',
    credentialEnv: 'OPENCODE_API_KEY',
    egressEligible: false,
    protocol: 'systemone',
  },
  'opencode-console-jev-free': {
    endpoint: 'https://opencode.ai/inference/systemone/v1/systemone',
    credentialEnv: 'OPENCODE_API_KEY',
    egressEligible: false,
    protocol: 'systemone',
  },
})

/**
 * Single provider matrix. Model and accounting IDs come from the canonical
 * config so the adapter and the ledger can never drift silently.
 */
export const DECISION_PROVIDER_ADAPTERS: Readonly<
  Record<DecisionProviderId, DecisionProviderAdapter>
> = Object.freeze(
  Object.fromEntries(
    (Object.keys(ADAPTER_DEFINITIONS) as DecisionProviderId[]).map((provider) => {
      const definition = ADAPTER_DEFINITIONS[provider]
      const models = DECISION_ROUTER_MODELS[provider]
      const model = models?.[0]
      if (model === undefined) throw new Error(`Missing decision provider model: ${provider}`)
      return [
        provider,
        Object.freeze({
          ...definition,
          model,
          accountingProvider: DECISION_PROVIDER_BUDGET_MAPPING[provider] as BudgetProvider,
        }),
      ]
    }),
  ) as Record<DecisionProviderId, DecisionProviderAdapter>,
)
