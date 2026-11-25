/** Canonical agent IDs shared by model routing and V2 override validation. */
export const KNOWN_AGENTS = [
  'zeus',
  'athena',
  'apollo',
  'hermes',
  'aphrodite',
  'demeter',
  'themis',
  'iris',
] as const

export type KnownAgent = (typeof KNOWN_AGENTS)[number]

export interface RetiredAgentAlias {
  readonly role: string
  readonly baseAgent: KnownAgent
  readonly readOnly: boolean
}

/**
 * Retired v2.2 fixed agents mapped to their v2.3 ephemeral operation worker
 * archetype and canonical base agent.
 */
export const RETIRED_AGENT_ALIASES: Readonly<Record<string, RetiredAgentAlias>> = Object.freeze({
  talos: { role: 'hotfix', baseAgent: 'hermes', readOnly: false },
  prometheus: { role: 'infra-ci', baseAgent: 'hermes', readOnly: false },
  hephaestus: { role: 'ai-pipeline', baseAgent: 'hermes', readOnly: false },
  nyx: { role: 'observability', baseAgent: 'hermes', readOnly: false },
  gaia: { role: 'geospatial', baseAgent: 'apollo', readOnly: true },
  mnemosyne: { role: 'memory-adr', baseAgent: 'iris', readOnly: false },
})
