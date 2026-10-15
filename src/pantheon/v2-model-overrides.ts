import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_AGENTS } from './model-agents.ts'
import { capabilityEntry, normalizeCapability } from './presets.mjs'

export interface V2ModelOverride {
  model: string
  variant?: 'low' | 'medium' | 'high'
}

export interface V2ModelConfiguration {
  overrides: Record<string, V2ModelOverride>
  legacyPresetMarker: { source: 'env' | 'file' } | null
  warnings: string[]
}

export interface V2AgentDraftLike {
  list(): readonly { id: string }[]
  update(id: string, update: (agent: { id: string; model?: unknown }) => void): void
}

interface AgentModelLike {
  id: string
  model?: unknown
}

const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/
const VARIANTS = new Set(['low', 'medium', 'high'])
const KNOWN_AGENTS_SET = new Set<string>(KNOWN_AGENTS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVariant(value: unknown): value is NonNullable<V2ModelOverride['variant']> {
  return typeof value === 'string' && VARIANTS.has(value)
}

function isSupportedModelChoice(model: unknown, variant: unknown): model is string {
  if (typeof model !== 'string' || !MODEL_REF_PATTERN.test(model)) return false
  if (variant !== undefined && !isVariant(variant)) return false
  try {
    capabilityEntry(model)
    if (variant === undefined) return true
    const normalized = normalizeCapability(model, variant)
    return !normalized.clamped && normalized.variant === variant
  } catch {
    return false
  }
}

interface PresetFileSystem {
  openSync(path: string, flags: number): number
  fstatSync(fileDescriptor: number): { isFile(): boolean }
  readFileSync(fileDescriptor: number, encoding: 'utf8'): string
  closeSync(fileDescriptor: number): void
}

class SecurePresetReadUnavailableError extends Error {
  constructor() {
    super('Secure preset-file opening is unavailable')
  }
}

class NonRegularPresetFileError extends Error {
  constructor() {
    super('Preset file is not a regular file')
  }
}

/** Open and read a regular preset file without following links or blocking on special files. */
export function readV2PresetFile(
  candidate: string,
  fileSystem: PresetFileSystem = { openSync, fstatSync, readFileSync, closeSync },
): string {
  const noFollowFlag = constants.O_NOFOLLOW
  const nonBlockFlag = constants.O_NONBLOCK
  if (
    noFollowFlag === undefined ||
    noFollowFlag === 0 ||
    nonBlockFlag === undefined ||
    nonBlockFlag === 0
  ) {
    throw new SecurePresetReadUnavailableError()
  }

  let fileDescriptor: number | undefined
  try {
    fileDescriptor = fileSystem.openSync(
      candidate,
      constants.O_RDONLY | noFollowFlag | nonBlockFlag,
    )
    if (!fileSystem.fstatSync(fileDescriptor).isFile()) {
      throw new NonRegularPresetFileError()
    }
    return fileSystem.readFileSync(fileDescriptor, 'utf8')
  } finally {
    if (fileDescriptor !== undefined) fileSystem.closeSync(fileDescriptor)
  }
}

function parseOverrides(
  value: Record<string, unknown>,
  warnings: string[],
): Record<string, V2ModelOverride> {
  const parsed: Record<string, V2ModelOverride> = {}
  for (const [agent, raw] of Object.entries(value)) {
    if (!KNOWN_AGENTS_SET.has(agent)) {
      warnings.push(
        'Override entry ignored for an unsupported agent; use one of the canonical Pantheon agent IDs.',
      )
      continue
    }
    const entry = isRecord(raw) ? raw : undefined
    const hasVariant = entry !== undefined && Object.hasOwn(entry, 'variant')
    const variant = hasVariant ? entry?.variant : entry?.reasoning_effort
    const model = entry?.model
    if (!entry || (hasVariant && !isVariant(variant)) || !isSupportedModelChoice(model, variant)) {
      warnings.push(
        'Override entry ignored because its model or variant is unsupported; choose a supported model and reasoning variant.',
      )
      continue
    }
    const override: V2ModelOverride = { model }
    if (isVariant(variant)) override.variant = variant
    parsed[agent] = override
  }
  return parsed
}

function defaultCandidates(): string[] {
  return [join(process.cwd(), '.pantheon', 'active-preset.json')]
}

/** Read explicit per-agent project overrides only; global files are ignored in V2. */
export function readV2ModelConfiguration(
  options: { candidates?: string[]; env?: NodeJS.ProcessEnv } = {},
): V2ModelConfiguration {
  const env = options.env ?? process.env
  const envName = env.PANTHEON_MODEL_PRESET?.trim()
  let fileMarkerPresent = false
  const configurations: Array<Record<string, V2ModelOverride>> = []
  const warnings: string[] = []
  let readFailure = false

  // `model-command` passes project before global candidates. Keep this reader
  // project-only even if a caller supplies the legacy candidate list.
  const candidates = options.candidates ?? defaultCandidates()
  for (const candidate of candidates.slice(0, 1)) {
    let rawContent: string
    try {
      rawContent = readV2PresetFile(candidate)
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      if (error instanceof SecurePresetReadUnavailableError) {
        warnings.push(
          'V2 project model configuration cannot be read securely on this platform; manual overrides were not applied.',
        )
        readFailure = true
        break
      }
      if (
        error instanceof NonRegularPresetFileError ||
        (error instanceof Error && 'code' in error && error.code === 'ELOOP')
      ) {
        warnings.push(
          'V2 project model configuration is not a regular file or is a symlink; check active-preset.json. Manual overrides were not applied.',
        )
        readFailure = true
        break
      }
      warnings.push(
        'V2 project model configuration could not be read; check active-preset.json file access. Manual overrides were not applied.',
      )
      readFailure = true
      break
    }

    let raw: unknown
    try {
      raw = JSON.parse(rawContent)
    } catch {
      warnings.push(
        'V2 project model configuration contains invalid JSON; correct active-preset.json. Manual overrides were not applied.',
      )
      readFailure = true
      break
    }
    if (!isRecord(raw)) {
      warnings.push(
        'V2 project model configuration has an invalid shape; correct active-preset.json. Manual overrides were not applied.',
      )
      readFailure = true
      break
    }

    if (Object.hasOwn(raw, 'preset')) fileMarkerPresent = true
    let parsedOverrides: Record<string, V2ModelOverride> = {}
    if (Object.hasOwn(raw, 'overrides')) {
      if (!isRecord(raw.overrides)) {
        warnings.push(
          'V2 project model configuration has an invalid `overrides` object; expected an object in active-preset.json. The project file contributed no manual overrides.',
        )
      } else if (Object.hasOwn(raw.overrides, 'agents')) {
        if (!isRecord(raw.overrides.agents)) {
          warnings.push(
            'V2 project model configuration has invalid `overrides.agents`; expected an object in active-preset.json. The project file contributed no manual overrides.',
          )
        } else {
          parsedOverrides = parseOverrides(raw.overrides.agents, warnings)
        }
      }
    }
    configurations.push(parsedOverrides)
  }

  const envMarkerPresent = typeof envName === 'string' && envName.length > 0
  const markerSource: 'env' | 'file' | null = envMarkerPresent
    ? 'env'
    : fileMarkerPresent
      ? 'file'
      : null

  // A project-file read/parse failure fails closed. Malformed entries warn but
  // leave other valid project entries available.
  const overrides: Record<string, V2ModelOverride> = {}
  if (!readFailure) {
    Object.assign(overrides, configurations[0] ?? {})
  }
  return {
    overrides,
    legacyPresetMarker: markerSource === null ? null : { source: markerSource },
    warnings,
  }
}

/** Apply one explicit model override while leaving all other agent settings intact. */
export function applyV2ModelOverride(
  agent: AgentModelLike,
  override: V2ModelOverride | undefined,
): void {
  if (
    !KNOWN_AGENTS_SET.has(agent.id) ||
    !override ||
    !isSupportedModelChoice(override.model, override.variant)
  ) {
    return
  }
  const separator = override.model.indexOf('/')
  const previous = isRecord(agent.model) ? agent.model : {}
  const model: Record<string, unknown> = {
    ...previous,
    providerID: override.model.slice(0, separator),
    id: override.model.slice(separator + 1),
  }
  if (override.variant !== undefined) {
    model.variant = override.variant
  } else {
    delete model.variant
  }
  agent.model = model
}

/** Apply explicit overrides to matching agents and leave unmatched host defaults untouched. */
export function applyV2ModelOverrides(
  draft: V2AgentDraftLike,
  overrides: Record<string, V2ModelOverride>,
): void {
  for (const agent of draft.list()) {
    if (!KNOWN_AGENTS_SET.has(agent.id)) continue
    const override = overrides[agent.id]
    if (!override) continue
    draft.update(agent.id, (current) => applyV2ModelOverride(current, override))
  }
}
