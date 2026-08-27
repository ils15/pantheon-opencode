/**
 * Deterministic model configuration tool for `/pantheon-model`.
 *
 * Only the top-level `model` and `small_model` keys are managed. Configuration
 * is read and written locally, without resolving presets or touching provider,
 * credential, or agent configuration. Writes use a sibling backup and an
 * atomic temporary-file rename.
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

import type { ToolContextLike } from './delegation.ts'

export type ModelScope = 'project' | 'global'
export type ModelAction = 'status' | 'show' | 'set' | 'reset'

const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/

const modelArgs = {
  action: z
    .enum(['status', 'show', 'set', 'reset'])
    .optional()
    .describe('Operation: status/show, set, or reset (default status).'),
  model: z
    .string()
    .optional()
    .describe('Top-level model in provider/model-id format; only used by set.'),
  small_model: z
    .string()
    .optional()
    .describe('Top-level small_model in provider/model-id format; only used by set.'),
  scope: z
    .enum(['project', 'global'])
    .optional()
    .describe('Configuration scope (default project, the safe non-global choice).'),
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
}

export interface ModelTool {
  description: string
  args: typeof modelArgs
  execute: (args: ModelArgs, ctx: ToolContextLike) => Promise<string>
}

export interface ModelToolset {
  pantheon_model: ModelTool
}

interface ConfigRecord {
  [key: string]: unknown
}

interface ReadConfigResult {
  exists: boolean
  valid: boolean
  config: ConfigRecord | null
  content?: string
  mode?: number
}

interface ModelValue {
  value: string | undefined
  source: ModelScope | 'none'
}

interface ResolvedStatus {
  model: ModelValue
  smallModel: ModelValue
  preset: { name: string; source: string } | null
  warnings: string[]
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
const SAFE_PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
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
    // Some supported filesystems do not allow fsync on directory handles. The
    // file itself is still fsynced before rename, so keep the operation useful.
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

async function configPathForScope(
  options: ModelCommandOptions,
  scope: ModelScope,
): Promise<string> {
  if (scope === 'project') return resolve(projectConfigPath(options))
  const candidates = globalConfigCandidates(options)
  for (const candidate of candidates) {
    const path = resolve(candidate)
    if ((await regularPath(path, 'global configuration file')) !== undefined) return path
  }
  const fallback = candidates[0]
  if (fallback === undefined) throw new ModelCommandError('global config path is unavailable')
  return resolve(fallback)
}

async function readConfig(path: string): Promise<ReadConfigResult> {
  const file = await readRegularFile(path, 'configuration file')
  if (file === undefined) return { exists: false, valid: true, config: {} }
  try {
    const parsed: unknown = JSON.parse(file.content)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, valid: false, config: null }
    }
    return {
      exists: true,
      valid: true,
      config: parsed as ConfigRecord,
      content: file.content,
      mode: file.mode,
    }
  } catch {
    return { exists: true, valid: false, config: null, content: file.content, mode: file.mode }
  }
}

function configuredModel(
  config: ConfigRecord | null,
  key: 'model' | 'small_model',
): string | undefined {
  const value = config?.[key]
  return typeof value === 'string' && validateModelRef(value) ? value : undefined
}

async function readPreset(
  options: ModelCommandOptions,
): Promise<{ name: string; source: string } | null> {
  const envPreset = envValue(options).PANTHEON_MODEL_PRESET?.trim()
  if (envPreset !== undefined && envPreset !== '') {
    return { name: SAFE_PRESET_NAME.test(envPreset) ? envPreset : 'configured', source: 'env' }
  }

  const candidates = options.activePresetCandidates ?? [
    join(dirname(projectConfigPath(options)), '.pantheon', 'active-preset.json'),
    ...globalConfigCandidates(options).map((path) =>
      join(dirname(path), '.pantheon', 'active-preset.json'),
    ),
  ]
  for (const [index, path] of candidates.entries()) {
    let file: { content: string; mode: number } | undefined
    try {
      file = await readRegularFile(path, 'active preset marker')
      if (file === undefined) continue
      const parsed: unknown = JSON.parse(file.content)
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as { preset?: unknown }).preset === 'string' &&
        (parsed as { preset: string }).preset.trim() !== ''
      ) {
        const preset = (parsed as { preset: string }).preset.trim()
        return {
          name: SAFE_PRESET_NAME.test(preset) ? preset : 'configured',
          source: index === 0 ? 'project' : 'global',
        }
      }
    } catch {
      // An invalid marker is equivalent to no active preset for this status.
    }
  }
  return null
}

async function resolveStatus(options: ModelCommandOptions): Promise<ResolvedStatus> {
  const project = await readConfig(resolve(projectConfigPath(options)))
  let globalPath: string | undefined
  for (const candidate of globalConfigCandidates(options)) {
    const path = resolve(candidate)
    if ((await regularPath(path, 'global configuration file')) !== undefined) {
      globalPath = path
      break
    }
  }
  const global =
    globalPath === undefined
      ? { exists: false, valid: true, config: {} }
      : await readConfig(globalPath)
  const warnings: string[] = []
  if (!project.valid) warnings.push('project config has invalid JSON')
  if (!global.valid) warnings.push('global config has invalid JSON')

  const projectModel = configuredModel(project.config, 'model')
  const globalModel = configuredModel(global.config, 'model')
  const projectSmallModel = configuredModel(project.config, 'small_model')
  const globalSmallModel = configuredModel(global.config, 'small_model')
  if (project.config?.model !== undefined && projectModel === undefined) {
    warnings.push('project model is invalid and was ignored')
  }
  if (project.config?.small_model !== undefined && projectSmallModel === undefined) {
    warnings.push('project small_model is invalid and was ignored')
  }
  if (global.config?.model !== undefined && globalModel === undefined) {
    warnings.push('global model is invalid and was ignored')
  }
  if (global.config?.small_model !== undefined && globalSmallModel === undefined) {
    warnings.push('global small_model is invalid and was ignored')
  }

  return {
    model: projectModel
      ? { value: projectModel, source: 'project' }
      : globalModel
        ? { value: globalModel, source: 'global' }
        : { value: undefined, source: 'none' },
    smallModel: projectSmallModel
      ? { value: projectSmallModel, source: 'project' }
      : globalSmallModel
        ? { value: globalSmallModel, source: 'global' }
        : { value: undefined, source: 'none' },
    preset: await readPreset(options),
    warnings,
  }
}

async function writeConfigAtomically(
  path: string,
  config: ConfigRecord,
  current: ReadConfigResult,
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
    `${JSON.stringify(config, null, 2)}\n`,
    originalMode,
    'configuration file',
    current.exists,
  )
}

function changedConfig(
  current: ConfigRecord,
  args: ModelArgs,
  action: 'set' | 'reset',
): { config: ConfigRecord; changed: boolean; fields: string[] } {
  const next: ConfigRecord = { ...current }
  const fields: string[] = []
  if (action === 'set') {
    if (args.model !== undefined) {
      next.model = args.model
      fields.push('model')
    }
    if (args.small_model !== undefined) {
      next.small_model = args.small_model
      fields.push('small_model')
    }
  } else {
    for (const field of ['model', 'small_model'] as const) {
      if (Object.hasOwn(next, field)) {
        delete next[field]
        fields.push(field)
      }
    }
  }
  return { config: next, changed: fields.length > 0, fields }
}

function validateSetArgs(args: ModelArgs): void {
  if (args.model === undefined && args.small_model === undefined) {
    throw new ModelCommandError('set requires --model and/or --small-model')
  }
  if (args.model !== undefined && !validateModelRef(args.model)) {
    throw new ModelCommandError('model must use provider/model-id format')
  }
  if (args.small_model !== undefined && !validateModelRef(args.small_model)) {
    throw new ModelCommandError('small_model must use provider/model-id format')
  }
}

function validateMutationAuthorization(args: ModelArgs, scope: ModelScope): void {
  if (scope !== 'global') return
  if (args.confirm !== true || args.authorize_global !== true) {
    throw new ModelCommandError(
      'global set/reset requires explicit confirmation and separate global authorization; -y is not sufficient',
    )
  }
}

async function updateConfig(
  options: ModelCommandOptions,
  args: ModelArgs,
  action: 'set' | 'reset',
  scope: ModelScope,
): Promise<string> {
  validateMutationAuthorization(args, scope)
  if (action === 'set') validateSetArgs(args)
  const path = await configPathForScope(options, scope)
  return withPathLock(path, async () => {
    const current = await readConfig(path)
    if (!current.valid || current.config === null) {
      throw new ModelCommandError(`${scope} config contains invalid JSON; file preserved`)
    }
    const result = changedConfig(current.config, args, action)
    if (!result.changed) {
      return `No managed model fields changed in ${scope} configuration. Restart OpenCode if another process changed it.`
    }
    try {
      await writeConfigAtomically(path, result.config, current)
    } catch (error: unknown) {
      if (error instanceof ModelCommandError) throw error
      throw new ModelCommandError(`${scope} configuration update failed; file preserved`)
    }
    const operation = action === 'set' ? 'updated' : 'reset'
    return `Model configuration ${operation} (${scope}): ${result.fields.join(', ')}. Restart OpenCode for the change to take effect.`
  })
}

async function renderStatus(options: ModelCommandOptions): Promise<string> {
  const status = await resolveStatus(options)
  const lines = [
    'Pantheon model configuration (restart OpenCode after changes):',
    `model: ${status.model.value ?? 'not configured'}`,
    `model origin: ${status.model.source}`,
    `small_model: ${status.smallModel.value ?? 'not configured'}`,
    `small_model origin: ${status.smallModel.source}`,
    `active preset: ${status.preset?.name ?? 'none'}${status.preset ? ` (${status.preset.source})` : ''}`,
  ]
  for (const warning of status.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}

/** Create the deterministic `pantheon_model` tool used by `/pantheon-model`. */
export function createModelCommand(options: ModelCommandOptions = {}): ModelToolset {
  return {
    pantheon_model: {
      description:
        'Show, set, or reset only top-level model and small_model in project or global opencode.json. Changes require an OpenCode restart.',
      args: modelArgs,
      execute: async (args, _ctx) => {
        try {
          const action: ModelAction = args.action ?? 'status'
          if (action === 'status' || action === 'show') return await renderStatus(options)
          const scope = args.scope ?? 'project'
          return await updateConfig(options, args, action, scope)
        } catch (error: unknown) {
          if (error instanceof ModelCommandError) return `pantheon_model failed: ${error.message}`
          options.logger?.warn?.('pantheon_model operation failed')
          return 'pantheon_model failed: operation could not be completed; file preserved when possible'
        }
      },
    },
  }
}
