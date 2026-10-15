/** Canonical agent IDs shared by model routing and V2 override validation. */
export const KNOWN_AGENTS = [
  'zeus',
  'athena',
  'apollo',
  'hermes',
  'aphrodite',
  'demeter',
  'themis',
  'prometheus',
  'hephaestus',
  'nyx',
  'gaia',
  'iris',
  'mnemosyne',
  'talos',
] as const

export type KnownAgent = (typeof KNOWN_AGENTS)[number]
