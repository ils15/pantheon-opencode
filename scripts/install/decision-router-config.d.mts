export type UserDecisionRouterProvider =
  | 'openai-decisions'
  | 'typesafe-jev'
  | 'opencode-console-jev'
  | 'opencode-console-jev-free'

export type UserDecisionRouterCandidate = {
  provider: UserDecisionRouterProvider
  model: string
}

export type UserDecisionRouterSelection =
  | { mode: 'local' }
  | { mode: 'auto' }
  | { mode: 'explicit'; provider: UserDecisionRouterProvider; model: string }

export type UserDecisionRouterConfig = {
  schema_version: 2
  enabled: boolean
  selection: UserDecisionRouterSelection
  egress_consent: boolean
  enabled_candidates: UserDecisionRouterCandidate[]
}

export const DECISION_ROUTER_MODELS: Readonly<Record<string, readonly string[]>>
export const DECISION_PROVIDER_BUDGET_MAPPING: Readonly<Record<string, string>>
export const REMOTELY_ELIGIBLE_DECISION_PROVIDERS: readonly string[]
export const DEFAULT_USER_DECISION_ROUTER_CONFIG: UserDecisionRouterConfig

export function migrateUserDecisionRouterConfig(value: unknown): UserDecisionRouterConfig
export function updateUserDecisionRouterConfig(
  config: unknown,
  update: unknown,
): UserDecisionRouterConfig
export function isUserDecisionRouterEnabled(config: unknown): boolean
export function normalizeDecisionProviderId(provider: string): string
export function resolveUserDecisionRouterCandidate(
  config: unknown,
  capValidCandidates?: readonly UserDecisionRouterCandidate[],
): UserDecisionRouterCandidate | null
export function readUserDecisionRouterConfig(options?: {
  env?: Readonly<Record<string, string | undefined>>
}): UserDecisionRouterConfig
export function writeUserDecisionRouterConfig(
  config: unknown,
  options?: { env?: Readonly<Record<string, string | undefined>> },
): string
