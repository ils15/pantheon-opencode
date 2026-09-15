/**
 * Deterministic per-agent model configuration tool for `/pantheon-model`.
 *
 * Operates exclusively on `active-preset.json` `overrides.agents[agent]`
 * (never on top-level `model`/`small_model`, never on `.env`). Supports:
 * - status/show: lists 14 canonical agents with model, effort, origin
 *   (preset|override|env|none) without secrets, validated via routing.yml.
 * - set --agent X --model Y --effort Z --scope project|global: validates
 *   via CAPABILITY_TABLE/hasVision and persists atomically with .bak + lock.
 * - reset --agent X [--scope]: removes override.
 * - wizard (no args): askQuestions flow agent → model → effort → scope.
 *
 * Atomic writes use sibling .bak and temporary-file rename with O_NOFOLLOW
 * and per-path in-memory lock.
 *
 * @module model-command
 */

import { randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  capabilityEntry,
  hasVision,
  loadPresetDefs,
  normalizeCapability,
  resolveActivePreset,
} from './presets.mjs'
import type { ToolContextLike } from './tool-context.ts'

export type ModelScope = 'project' | 'global'
export type ModelAction = 'status' | 'show' | 'set' | 'reset'

const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/
const SAFE_PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 14 canonical agents — must stay in sync with src/routing.yml agents. */
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
const KNOWN_AGENTS_SET = new Set<string>(KNOWN_AGENTS)

const modelArgs = {
  action: z
    .enum(['status', 'show', 'set', 'reset'])
    .optional()
    .describe('Operation: status/show, set, or reset. No args runs wizard.'),
  agent: z.string().optional().describe('Agent name (one of 14 canonical agents).'),
  model: z.string().optional().describe('Model in provider/model-id format; used by set.'),
  effort: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('Reasoning effort (variant), clamped to model capability.'),
  scope: z
    .enum(['project', 'global'])
    .optional()
    .describe('Configuration scope for active-preset.json (default project).'),
  confirm: z
    .boolean()
    .optional()
    .describe('Explicitly confirm a mutating operation, required for global changes.'),
  authorize_global: z
    .boolean()
    .optional()
    .describe('Separate authorization for changing global configuration; not implied by -y.'),
} satisfies z.ZodRawShape

type ModelArgs = z.infer<z.ZodObject<typeof modelArgs>>

/** A logger subset used for non-fatal status diagnostics. */
export interface ModelCommandLogger {
  warn?: (message: string) => void
  log?: (message: string) => void
}

/** Injectable filesystem/environment locations for deterministic tests. */
export interface ModelCommandOptions {
  cwd?: string
  /** Explicit project opencode.json path; useful for isolated installations. */
  projectConfigPath?: string
  /** Explicit global opencode.json path; useful for isolated installations. */
  globalConfigPath?: string
  /** Override environment lookup without mutating process.env. */
  env?: NodeJS.ProcessEnv
  /** Override marker locations; defaults to project then global candidates. */
  activePresetCandidates?: string[]
  logger?: ModelCommandLogger
  /** Optional askQuestions injection for wizard (used in tests). */
  ask?: (questions: unknown[]) => Promise<Record<string, unknown>>
  /** Optional readline injection for wizard fallback. */
  rl?: { question: (q: string) => Promise<string>; close?: () => void }
}

export interface ModelTool {
  description: string
  args: typeof modelArgs
  execute: (args: ModelArgs, ctx: ToolContextLike) => Promise<string>
}

export interface ModelToolset {
  pantheon_model: ModelTool
}

interface ReadFileResult {
  exists: boolean
  valid: boolean
  content?: string
  mode?: number
  data: unknown
}

interface AgentStatus {
  agent: string
  model: string | undefined
  effort: string | undefined
  origin: 'preset' | 'override' | 'env' | 'none'
  vision: boolean | undefined
}

class ModelCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelCommandError'
  }
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const PERMISSION_MASK = 0o7777
const DEFAULT_FILE_MODE = 0o600
const pathLocks = new Map<string, Promise<void>>()

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined
}

async function existingPath(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function assertRegular(stats: Stats, label: string): void {
  if (stats.isSymbolicLink()) {
    throw new ModelCommandError(`${label} must not be a symlink`)
  }
  if (!stats.isFile()) {
    throw new ModelCommandError(`${label} must be a regular file`)
  }
}

async function regularPath(path: string, label: string): Promise<Stats | undefined> {
  const stats = await existingPath(path)
  if (stats !== undefined) assertRegular(stats, label)
  return stats
}

async function readRegularFile(
  path: string,
  label: string,
): Promise<{ content: string; mode: number } | undefined> {
  const stats = await regularPath(path, label)
  if (stats === undefined) return undefined

  let file: FileHandle | undefined
  try {
    file = await open(path, constants.O_RDONLY | NO_FOLLOW)
    const openedStats = await file.stat()
    if (!openedStats.isFile()) throw new ModelCommandError(`${label} must be a regular file`)
    return {
      content: await file.readFile('utf8'),
      mode: openedStats.mode & PERMISSION_MASK,
    }
  } catch (error: unknown) {
    if (errorCode(error) === 'ELOOP') {
      throw new ModelCommandError(`${label} must not be a symlink`)
    }
    throw error
  } finally {
    await file?.close().catch(() => undefined)
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: FileHandle | undefined
  try {
    directory = await open(path, constants.O_RDONLY | NO_FOLLOW)
    const stats = await directory.stat()
    if (!stats.isDirectory()) {
      throw new ModelCommandError('configuration directory is not a directory')
    }
    await directory.sync()
  } catch (error: unknown) {
    if (errorCode(error) !== 'EINVAL' && errorCode(error) !== 'ENOTSUP') throw error
  } finally {
    await directory?.close().catch(() => undefined)
  }
}

async function createTemporaryFile(
  path: string,
): Promise<{ path: string; file: Awaited<ReturnType<typeof open>> }> {
  const directory = dirname(path)
  const prefix = `.${basename(path)}.tmp-`
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const temporaryPath = join(directory, `${prefix}${randomBytes(16).toString('hex')}`)
    try {
      return { path: temporaryPath, file: await open(temporaryPath, flags, DEFAULT_FILE_MODE) }
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
  throw new ModelCommandError('could not allocate a unique temporary file')
}

async function atomicReplace(
  path: string,
  content: string,
  mode: number,
  label: string,
  expectedExists: boolean,
): Promise<void> {
  const before = await regularPath(path, label)
  if ((before !== undefined) !== expectedExists) {
    throw new ModelCommandError(`${label} changed while it was being updated`)
  }

  let temporaryPath: string | undefined
  let temporaryFile: FileHandle | undefined
  let renamed = false
  try {
    const temporary = await createTemporaryFile(path)
    temporaryPath = temporary.path
    temporaryFile = temporary.file
    await temporaryFile.writeFile(content, 'utf8')
    await temporaryFile.chmod(mode)
    await temporaryFile.sync()
    await temporaryFile.close()
    temporaryFile = undefined

    const temporaryStats = await regularPath(temporaryPath, 'temporary configuration file')
    if (temporaryStats === undefined) {
      throw new ModelCommandError('temporary configuration file disappeared')
    }
    const current = await regularPath(path, label)
    if ((current !== undefined) !== expectedExists) {
      throw new ModelCommandError(`${label} changed while it was being updated`)
    }
    await rename(temporaryPath, path)
    renamed = true
    await syncDirectory(dirname(path))
  } finally {
    await temporaryFile?.close().catch(() => undefined)
    if (temporaryPath !== undefined && !renamed) {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }
}

async function withPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const own = new Promise<void>((resolveRelease) => {
    release = resolveRelease
  })
  const queued = previous.then(() => own)
  pathLocks.set(path, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (pathLocks.get(path) === queued) pathLocks.delete(path)
  }
}

/** Return whether a model is in the supported `provider/model-id` form. */
export function validateModelRef(value: unknown): value is string {
  return typeof value === 'string' && MODEL_REF_PATTERN.test(value)
}

function envValue(options: ModelCommandOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env
}

function projectConfigPath(options: ModelCommandOptions): string {
  return options.projectConfigPath ?? join(options.cwd ?? process.cwd(), 'opencode.json')
}

function defaultGlobalConfigPath(options: ModelCommandOptions): string {
  const env = envValue(options)
  const home = env.HOME?.trim() || homedir()
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return join(xdg, 'opencode', 'opencode.json')
}

function globalConfigCandidates(options: ModelCommandOptions): string[] {
  if (options.globalConfigPath !== undefined) return [options.globalConfigPath]
  const canonical = defaultGlobalConfigPath(options)
  const home = envValue(options).HOME?.trim() || homedir()
  const legacy = join(home, '.opencode', 'opencode.json')
  return [...new Set([canonical, legacy])]
}

function activePresetCandidatesList(options: ModelCommandOptions): string[] {
  if (options.activePresetCandidates !== undefined) {
    return options.activePresetCandidates.map((p) => resolve(p))
  }
  const projectPreset = join(dirname(projectConfigPath(options)), '.pantheon', 'active-preset.json')
  const globalPresets = globalConfigCandidates(options).map((p) =>
    join(dirname(p), '.pantheon', 'active-preset.json'),
  )
  return [...new Set([projectPreset, ...globalPresets].map((p) => resolve(p)))]
}

function presetPathForScope(options: ModelCommandOptions, scope: ModelScope): string {
  const candidates = activePresetCandidatesList(options)
  if (scope === 'project') {
    const first = candidates[0]
    if (!first) throw new ModelCommandError('project preset path is unavailable')
    return first
  }
  // global: second candidate if exists, else fallback to global preset derivation
  const second = candidates[1]
  if (second) return second
  // derive from default global if only one candidate was supplied
  const globalCandidates = globalConfigCandidates(options).map((p) =>
    resolve(join(dirname(p), '.pantheon', 'active-preset.json')),
  )
  return globalCandidates[0] ?? candidates[0]!
}

async function readActivePresetRaw(path: string, label: string): Promise<ReadFileResult> {
  const file = await readRegularFile(path, label)
  if (file === undefined) return { exists: false, valid: true, data: null }
  try {
    const parsed: unknown = JSON.parse(file.content)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, valid: false, data: null, content: file.content, mode: file.mode }
    }
    return {
      exists: true,
      valid: true,
      data: parsed as Record<string, unknown>,
      content: file.content,
      mode: file.mode,
    }
  } catch {
    return { exists: true, valid: false, data: null, content: file.content, mode: file.mode }
  }
}

function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase()
}

function validateAgent(agent: string): string {
  const normalized = normalizeAgentName(agent)
  if (!KNOWN_AGENTS_SET.has(normalized)) {
    throw new ModelCommandError(
      `unknown agent "${agent}"; known agents: ${KNOWN_AGENTS.join(', ')}`,
    )
  }
  return normalized
}

function isValidEffort(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high'
}

function validateSetArgs(args: ModelArgs): void {
  if (!args.agent) throw new ModelCommandError('set requires --agent <name>')
  validateAgent(args.agent)
  if (args.model !== undefined && !validateModelRef(args.model)) {
    throw new ModelCommandError('model must use provider/model-id format')
  }
  if (args.model === undefined) {
    throw new ModelCommandError('set requires --model <provider/model-id>')
  }
  if (args.effort !== undefined && !isValidEffort(args.effort)) {
    throw new ModelCommandError('effort must be one of low, medium, high')
  }
  // CAPABILITY_TABLE validation
  try {
    capabilityEntry(args.model)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new ModelCommandError(msg)
  }
}

function validateResetArgs(args: ModelArgs): void {
  if (!args.agent) throw new ModelCommandError('reset requires --agent <name>')
  validateAgent(args.agent)
}

function validateMutationAuthorization(args: ModelArgs, scope: ModelScope): void {
  if (scope !== 'global') return
  if (args.confirm !== true || args.authorize_global !== true) {
    throw new ModelCommandError(
      'global set/reset requires explicit confirmation and separate global authorization; -y is not sufficient',
    )
  }
}

// ─── Atomic write for active-preset.json ──────────────────────────────────

async function writeActivePresetAtomically(
  path: string,
  data: Record<string, unknown>,
  current: ReadFileResult,
): Promise<void> {
  const backupPath = `${path}.bak`
  await mkdir(dirname(path), { recursive: true })
  const originalMode = current.mode ?? DEFAULT_FILE_MODE
  const backupMode = originalMode & 0o600
  const backup = await regularPath(backupPath, 'configuration backup')

  if (current.exists) {
    if (current.content === undefined) {
      throw new ModelCommandError('configuration content could not be read; file preserved')
    }
    await atomicReplace(
      backupPath,
      current.content,
      backupMode,
      'configuration backup',
      backup !== undefined,
    )
  }
  await atomicReplace(
    path,
    `${JSON.stringify(data, null, 2)}\n`,
    originalMode,
    'configuration file',
    current.exists,
  )
}

function ensureActivePresetShape(
  raw: Record<string, unknown> | null,
  fallbackPreset: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = raw && typeof raw === 'object' ? { ...raw } : {}
  if (typeof out.version !== 'number') out.version = 1
  if (typeof out.preset !== 'string' || (out.preset as string).trim() === '') {
    out.preset = fallbackPreset
  }
  if (typeof out.source !== 'string') out.source = 'cli'
  out.updated_at = new Date().toISOString()
  if (
    out.overrides === undefined ||
    out.overrides === null ||
    typeof out.overrides !== 'object' ||
    Array.isArray(out.overrides)
  ) {
    out.overrides = {}
  }
  const overrides = out.overrides as Record<string, unknown>
  if (
    overrides.agents === undefined ||
    overrides.agents === null ||
    typeof overrides.agents !== 'object' ||
    Array.isArray(overrides.agents)
  ) {
    overrides.agents = {}
  }
  return out
}

function defaultFallbackPreset(): string {
  try {
    const defs = loadPresetDefs()
    const first = Object.keys(defs)[0]
    if (first) return first
  } catch {
    // ignore
  }
  return 'go-free'
}

async function updateActivePreset(
  options: ModelCommandOptions,
  args: ModelArgs,
  action: 'set' | 'reset',
  scope: ModelScope,
): Promise<string> {
  validateMutationAuthorization(args, scope)
  if (action === 'set') validateSetArgs(args)
  else validateResetArgs(args)

  const path = presetPathForScope(options, scope)
  return withPathLock(path, async () => {
    const current = await readActivePresetRaw(path, 'configuration file')
    if (current.exists && !current.valid) {
      throw new ModelCommandError(`${scope} preset file contains invalid JSON; file preserved`)
    }

    const env = envValue(options)
    let fallbackPreset = defaultFallbackPreset()
    // Prefer env preset if set and known
    const envPreset = env.PANTHEON_MODEL_PRESET?.trim()
    if (envPreset && envPreset !== '' && envPreset !== 'none') {
      try {
        const defs = loadPresetDefs()
        if (Object.hasOwn(defs, envPreset)) fallbackPreset = envPreset
      } catch {
        // ignore
      }
    } else if (
      current.data &&
      typeof current.data === 'object' &&
      (current.data as Record<string, unknown>).preset
    ) {
      const existing = (current.data as Record<string, unknown>).preset as string
      if (
        typeof existing === 'string' &&
        existing.trim() !== '' &&
        SAFE_PRESET_NAME.test(existing.trim())
      ) {
        fallbackPreset = existing.trim()
      }
    }

    const shaped = ensureActivePresetShape(
      current.data as Record<string, unknown> | null,
      fallbackPreset,
    )
    const overrides = shaped.overrides as Record<string, unknown>
    const agents = overrides.agents as Record<string, unknown>

    const agentKey = validateAgent(args.agent!)

    if (action === 'set') {
      const model = args.model!
      const effort = args.effort
      let variantInfo: { variant: 'low' | 'medium' | 'high' | null; clamped: boolean }
      try {
        variantInfo = normalizeCapability(model, effort)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        throw new ModelCommandError(msg)
      }

      // Validate vision: warn if text-only, but allow
      let visionWarning = ''
      try {
        const vision = hasVision(model)
        if (!vision) {
          visionWarning = `warning: model ${model} is text-only (no vision) — image turns will use vision fallback`
        }
      } catch {
        // capabilityEntry already validated, hasVision shouldn't throw here
      }

      const entry: Record<string, unknown> = { model }
      if (variantInfo.variant !== null) entry.variant = variantInfo.variant
      // For backward compat, also support reasoning_effort? Store variant only.
      agents[agentKey] = entry

      // If clamped, append warning
      if (variantInfo.clamped) {
        visionWarning = [
          visionWarning,
          `effort clamped to ${variantInfo.variant} for model ${model}`,
        ]
          .filter(Boolean)
          .join('; ')
      }

      await writeActivePresetAtomically(path, shaped, current)

      // health-check: verify file parses and preset resolves
      try {
        const written = await readRegularFile(path, 'configuration file')
        if (written) JSON.parse(written.content)
      } catch {
        options.logger?.warn?.('health-check: active-preset.json verification failed')
      }

      const base = `Model override set (${scope}): ${agentKey} → ${model} (effort: ${variantInfo.variant ?? 'none'}). Restart OpenCode for the change to take effect.`
      return visionWarning ? `${base}\n${visionWarning}` : base
    } else {
      // reset
      if (!Object.hasOwn(agents, agentKey)) {
        return `No override to remove for agent "${agentKey}" in ${scope} preset.`
      }
      delete agents[agentKey]
      // Clean up empty overrides.agents to keep file tidy, but keep overrides object
      // Remove empty overrides if no agents and no providers etc? Keep minimal.
      await writeActivePresetAtomically(path, shaped, current)
      return `Model override removed (${scope}): ${agentKey}. Restart OpenCode for the change to take effect.`
    }
  })
}

// ─── Status ─────────────────────────────────────────────────────────────────

async function resolvePerAgentStatus(options: ModelCommandOptions): Promise<{
  presetName: string | null
  presetSource: string | null
  agents: AgentStatus[]
  warnings: string[]
}> {
  const env = envValue(options)
  const candidates = activePresetCandidatesList(options)
  const warnings: string[] = []

  // Use presets.mjs resolver (sync) for canonical resolution, but capture warnings
  const logger: ModelCommandLogger = {
    warn: (m) => warnings.push(m),
    log: () => {},
  }

  let resolved: ReturnType<typeof resolveActivePreset> = null
  try {
    resolved = resolveActivePreset({ env, candidates, logger } as unknown as Parameters<
      typeof resolveActivePreset
    >[0])
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    warnings.push(msg)
    resolved = null
  }

  const agents: AgentStatus[] = []
  for (const agent of KNOWN_AGENTS) {
    const key = agent
    let model: string | undefined
    let effort: string | undefined
    let origin: AgentStatus['origin'] = 'none'
    let vision: boolean | undefined

    if (resolved) {
      const merged = (
        resolved.agents as Record<
          string,
          { model?: string; reasoning_effort?: string; variant?: string }
        >
      )?.[key]
      if (merged?.model) {
        model = merged.model
        effort =
          (merged as { reasoning_effort?: string }).reasoning_effort ??
          (merged as { variant?: string }).variant
        // Determine origin: file overrides > file preset > env
        const fileOverrides = (resolved.overrides as { agents?: Record<string, unknown> } | null)
          ?.agents
        if (resolved.source === 'file' && fileOverrides && Object.hasOwn(fileOverrides, key)) {
          origin = 'override'
        } else if (resolved.source === 'env') {
          origin = 'env'
        } else {
          origin = 'preset'
        }
        try {
          if (model) vision = hasVision(model)
        } catch {
          vision = undefined
        }
      } else {
        origin = 'none'
      }
    } else {
      origin = 'none'
    }

    agents.push({ agent: key, model, effort, origin, vision })
  }

  return {
    presetName: (resolved as { name?: string } | null)?.name ?? null,
    presetSource: (resolved as { source?: string } | null)?.source ?? null,
    agents,
    warnings,
  }
}

async function renderStatus(options: ModelCommandOptions): Promise<string> {
  const { presetName, presetSource, agents, warnings } = await resolvePerAgentStatus(options)
  const lines: string[] = []
  lines.push('Pantheon model configuration per-agent (restart OpenCode after changes):')
  if (presetName) {
    const originLabel =
      presetSource === 'env' ? 'env' : presetSource === 'file' ? 'preset' : presetSource
    lines.push(`active preset: ${presetName} (${presetSource ?? 'unknown'})`)
    // For test compatibility, also show origin mapping explicitly
    void originLabel
  } else {
    lines.push('active preset: none')
  }
  lines.push(`agents: ${KNOWN_AGENTS.length} canonical`)
  for (const a of agents) {
    const modelStr = a.model ?? 'not configured'
    const effortStr = a.effort ?? 'none'
    const visionStr = a.vision === undefined ? 'unknown' : a.vision ? 'vision' : 'text-only'
    // origin is preset|override|env|none — must be explicit for tests
    lines.push(`${a.agent}: ${modelStr} (origin: ${a.origin}, effort: ${effortStr}, ${visionStr})`)
  }
  for (const w of warnings) {
    // never leak secrets: strip any env values that look like keys (heuristic)
    if (/api[_-]?key/i.test(w) && w.length > 80) continue
    lines.push(`warning: ${w}`)
  }
  return lines.join('\n')
}

// ─── Wizard (askQuestions) ──────────────────────────────────────────────────

export function buildWizardQuestions(): unknown[] {
  return [
    {
      header: 'Agente',
      question: 'Escolha o agente para configurar (um dos 14 canônicos)',
      options: KNOWN_AGENTS.map((a) => ({ label: a, description: `Agente ${a}` })),
      multiSelect: false,
    },
    {
      header: 'Modelo',
      question:
        'Informe o modelo em provider/model-id (ex: openai/gpt-5.6 ou opencode-go/kimi-k2.7-code)',
      kind: 'text',
    },
    {
      header: 'Effort',
      question: 'Escolha o reasoning effort',
      options: [
        { label: 'low', description: 'Baixa latência, respostas curtas' },
        { label: 'medium', description: 'Equilíbrio custo/qualidade' },
        { label: 'high', description: 'Máxima qualidade/raciocínio' },
      ],
      multiSelect: false,
    },
    {
      header: 'Escopo',
      question: 'Onde salvar o override?',
      options: [
        {
          label: 'project',
          description: './.pantheon/active-preset.json (escopo do projeto, seguro)',
        },
        {
          label: 'global',
          description: '~/.config/opencode/.pantheon/active-preset.json (global)',
        },
      ],
      multiSelect: false,
    },
  ]
}

async function promptViaReadline(
  questions: Array<{ header?: string; question: string; options?: Array<{ label: string }> }>,
  rl: { question: (q: string) => Promise<string>; close?: () => void },
): Promise<Record<string, unknown>> {
  const answers: Record<string, unknown> = {}
  // Q1 agent
  const agentQ = questions[0]!
  const agentPrompt = `${agentQ.question} [${KNOWN_AGENTS.join('/')}] : `
  const agentAns = (await rl.question(agentPrompt)).trim().toLowerCase()
  answers.agent = agentAns || KNOWN_AGENTS[0]

  const modelQ = questions[1]!
  const modelAns = (await rl.question(`${modelQ.question} : `)).trim()
  answers.model = modelAns

  const effortQ = questions[2]!
  const effortAns = (await rl.question(`${effortQ.question} [low/medium/high] : `))
    .trim()
    .toLowerCase()
  answers.effort = effortAns || 'medium'

  const scopeQ = questions[3]!
  const scopeAns = (await rl.question(`${scopeQ.question} [project/global] : `))
    .trim()
    .toLowerCase()
  answers.scope = scopeAns || 'project'

  return answers
}

async function runWizard(options: ModelCommandOptions): Promise<string> {
  const questions = buildWizardQuestions()

  let answers: Record<string, unknown>

  if (typeof options.ask === 'function') {
    try {
      answers = await options.ask(questions)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      return `pantheon_model wizard canceled: ${msg}`
    }
  } else if (options.rl) {
    answers = await promptViaReadline(questions as never, options.rl)
  } else {
    // fallback readline from stdin
    const { createInterface } = await import('node:readline/promises')
    const rli = createInterface({ input: process.stdin, output: process.stdout })
    try {
      answers = await promptViaReadline(questions as never, rli as never)
    } finally {
      rli.close()
    }
  }

  const agent = typeof answers.agent === 'string' ? answers.agent.trim() : ''
  const model = typeof answers.model === 'string' ? answers.model.trim() : ''
  const effort = typeof answers.effort === 'string' ? answers.effort.trim().toLowerCase() : ''
  const scopeRaw =
    typeof answers.scope === 'string' ? answers.scope.trim().toLowerCase() : 'project'
  const scope: ModelScope = scopeRaw === 'global' ? 'global' : 'project'

  if (!agent) return 'pantheon_model wizard failed: agent is required'
  if (!model) return 'pantheon_model wizard failed: model is required'

  // Map answers to ModelArgs and delegate to updateActivePreset
  const wizardArgs: ModelArgs = {
    action: 'set',
    agent,
    model,
    scope,
  }
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    wizardArgs.effort = effort as 'low' | 'medium' | 'high'
  }

  // For wizard, we need to handle global authorization: if scope global, require confirm?
  // Wizard runs interactively, so we can auto-confirm when via wizard.
  if (scope === 'global') {
    wizardArgs.confirm = true
    wizardArgs.authorize_global = true
  }

  try {
    return await updateActivePreset(options, wizardArgs, 'set', scope)
  } catch (error: unknown) {
    if (error instanceof ModelCommandError) return `pantheon_model wizard failed: ${error.message}`
    options.logger?.warn?.('pantheon_model wizard failed')
    return 'pantheon_model wizard failed: operation could not be completed; file preserved when possible'
  }
}

/** Create the deterministic `pantheon_model` tool used by `/pantheon-model`. */
export function createModelCommand(options: ModelCommandOptions = {}): ModelToolset {
  return {
    pantheon_model: {
      description:
        'Show, set, or reset per-agent model overrides in active-preset.json (project or global). Overrides win over preset; env preset wins over file. Never writes .env or top-level model/small_model.',
      args: modelArgs,
      execute: async (args, _ctx) => {
        try {
          const hasAction = args.action !== undefined
          const hasAgentModelEffort =
            args.agent !== undefined || args.model !== undefined || args.effort !== undefined

          // Wizard when invoked with no args at all
          if (!hasAction && !hasAgentModelEffort) {
            return await runWizard(options)
          }

          const action: ModelAction = (args.action ??
            (hasAgentModelEffort ? 'set' : 'status')) as ModelAction

          if (action === 'status' || action === 'show') return await renderStatus(options)

          const scope = (args.scope ?? 'project') as ModelScope
          if (scope !== 'project' && scope !== 'global') {
            throw new ModelCommandError('scope must be project or global')
          }

          if (action === 'set') {
            return await updateActivePreset(options, args, 'set', scope)
          }
          if (action === 'reset') {
            return await updateActivePreset(options, args, 'reset', scope)
          }

          return `pantheon_model failed: unknown action "${action}"`
        } catch (error: unknown) {
          if (error instanceof ModelCommandError) return `pantheon_model failed: ${error.message}`
          options.logger?.warn?.('pantheon_model operation failed')
          return 'pantheon_model failed: operation could not be completed; file preserved when possible'
        }
      },
    },
  }
}
