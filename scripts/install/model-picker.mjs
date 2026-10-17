#!/usr/bin/env node
/**
 * model-picker.mjs — interactive model preset selection + persistence
 *
 * Used by the installer (interactive prompt) and the `pantheon-opencode`
 * CLI. Writes the active preset marker to <presetDir>/.pantheon/active-preset.json
 * which the plugin (src/plugin.ts) reads on startup via resolveActivePreset().
 *
 * Installer choices use display labels separate from persisted preset IDs.
 * The wizard never reads or validates API keys; it names the required env var.
 *
 * "Inherit" is the default profile choice and does not write active-preset.json,
 * então os delegates herdam o modelo do chat pai (herança nativa, sem preset).
 */
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import * as clack from '@clack/prompts'
import { loadPresetDefs } from '../../src/pantheon/presets.mjs'
import { ACTIONS, fingerprintOutput, recordChange, snapshot } from './plan.mjs'
import { assertNoSymlinkAncestors, writeFileAtomically } from './verify.mjs'

/** Preset pricing table (2026 verified). */
export const PRESET_PRICE = {
  'go-free': {
    label: 'Gratuito',
    detail: 'Zen free – sem custo, quota limitada, só modelos -free',
  },
  'go-fast': {
    label: 'Baixo custo',
    detail: 'Go gateway – baixa latência, kimi-k2.7-code / glm-5.3-flash',
  },
  'go-premium': {
    label: 'Premium',
    detail: 'Go gateway – melhor qualidade, gpt-5.6-sol / qwen3.8-max / deepseek-v4-pro',
  },
  openai: {
    label: 'Pago (OpenAI)',
    detail: 'Direto OpenAI – https://api.openai.com/v1, gpt-5.6 family',
  },
  'go-hybrid': {
    label: 'OpenCode Go',
    detail: 'Premium para especialistas centrais; Go rápido para os demais agentes',
  },
  anthropic: {
    label: 'Anthropic',
    detail: 'Direto Anthropic – claude-sonnet-5-5',
  },
}

/** Installer-facing labels and their stable internal preset identifiers. */
export const INSTALLER_PRESET_CHOICES = [
  { label: 'Inherit', value: 'inherit' },
  { label: 'OpenCode Go', value: 'go-hybrid' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
]

/** Static, safe env-var names for installer guidance; never derive these from credentials or preset metadata. */
const PRESET_KEY_ENV_GUIDANCE = Object.freeze({
  'go-free': 'PANTHEON_OPENCODE_API_KEY',
  'go-fast': 'PANTHEON_OPENCODE_API_KEY',
  'go-premium': 'PANTHEON_OPENCODE_API_KEY',
  'go-hybrid': 'PANTHEON_OPENCODE_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
})

/**
 * Build safe installer guidance using only the static preset-to-env-name map.
 * @param {string} name
 * @param {string} [label]
 * @returns {string}
 */
export function presetKeyEnvGuidance(name, label = name) {
  if (!Object.hasOwn(PRESET_KEY_ENV_GUIDANCE, name)) {
    return 'Configure the required API key in your environment; the installer does not read or validate API keys.'
  }
  return `${label} expects ${PRESET_KEY_ENV_GUIDANCE[name]}. Configure it in your environment; the installer does not read or validate API keys.`
}

/**
 * Return primary API key env var for a preset.
 * @param {string} name
 * @param {object} def
 * @returns {string}
 */
export function requiredKeyEnvForPreset(name, def) {
  if (name === 'openai') return 'OPENAI_API_KEY'
  // all Go presets use PANTHEON_OPENCODE_API_KEY (alias OPENCODE_GO_API_KEY)
  const providerEnvs = Object.values(def?.providers ?? {})
    .map((p) => p.apiKeyEnv)
    .filter(Boolean)
  if (providerEnvs.includes('PANTHEON_OPENCODE_API_KEY')) return 'PANTHEON_OPENCODE_API_KEY'
  if (providerEnvs.includes('OPENAI_API_KEY')) return 'OPENAI_API_KEY'
  if (providerEnvs.includes('ANTHROPIC_API_KEY')) return 'ANTHROPIC_API_KEY'
  return providerEnvs[0] ?? 'PANTHEON_OPENCODE_API_KEY'
}

/**
 * Check if required key is configured in env, handling alias OPENCODE_GO_API_KEY.
 * @param {Record<string,string|undefined>} env
 * @param {string} presetName
 * @param {object} presetDef
 * @returns {boolean}
 */
export function isKeyConfiguredForPreset(env, presetName, presetDef) {
  const primary = requiredKeyEnvForPreset(presetName, presetDef)
  if (primary === 'PANTHEON_OPENCODE_API_KEY') {
    const v1 = env.PANTHEON_OPENCODE_API_KEY
    if (typeof v1 === 'string' && v1.trim() !== '') return true
    const v2 = env.OPENCODE_GO_API_KEY
    if (typeof v2 === 'string' && v2.trim() !== '') return true
    return false
  }
  const v = env[primary]
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * Mask a key for logging (keep first 4 and last 2, rest *).
 * @param {string} key
 * @returns {string}
 */
export function maskKey(key) {
  if (!key || key.length <= 8) return '***'
  return `${key.slice(0, 4)}${'*'.repeat(Math.max(3, key.length - 6))}${key.slice(-2)}`
}

/**
 * Build table row for preset: provider/baseURL/key + preço + modelos por papel.
 * @param {string} name
 * @param {object} def
 * @returns {string}
 */
export function buildPresetTableRow(name, def) {
  const price = PRESET_PRICE[name] ?? { label: '—', detail: '' }
  const providers = Object.entries(def.providers ?? {})
    .map(([id, p]) => `${id} ${p.baseURL ?? ''} key:${p.apiKeyEnv ?? 'none'}`)
    .join(' | ')
  const agents = def.agents ?? {}
  // group by model for brevity
  const modelGroups = {}
  for (const [agent, spec] of Object.entries(agents)) {
    const key = `${spec.model} [${spec.reasoning_effort ?? ''}]`
    if (!modelGroups[key]) modelGroups[key] = []
    modelGroups[key].push(agent)
  }
  const agentSummary = Object.entries(modelGroups)
    .map(([model, list]) => `${list.join(',')}:${model}`)
    .join(' | ')
  return `${name} — ${price.label} (${price.detail}) | ${providers} | ${agentSummary}`
}

/**
 * Build the two-question askQuestions payload for model profile and save scope.
 * Values are stable internal identifiers; labels are presentation-only.
 * @param {Record<string,object>} presetDefs
 * @returns {Array<object>}
 */
export function buildInitQuestions(presetDefs) {
  const presetOptions = INSTALLER_PRESET_CHOICES.filter(
    ({ value }) => value === 'inherit' || presetDefs[value],
  ).map(({ label, value }) => ({
    label,
    value,
    description:
      value === 'inherit'
        ? 'Use the model selected in the current chat; do not save an active preset.'
        : (presetDefs[value].description ?? buildPresetTableRow(value, presetDefs[value])),
  }))
  return [
    {
      header: 'Model profile',
      question: 'Choose the default model profile for Pantheon agents.',
      options: presetOptions,
      multiSelect: false,
    },
    {
      header: 'Install scope',
      question: 'Where should the active preset be saved?',
      options: [
        {
          label: 'Project',
          value: 'project',
          description: './.pantheon/active-preset.json',
        },
        {
          label: 'Global',
          value: 'global',
          description: '~/.config/opencode/.pantheon/active-preset.json',
        },
      ],
      multiSelect: false,
    },
  ]
}

/**
 * Build the active-preset.json payload (version 1).
 *
 * @param {string} presetName
 * @param {string} [source] 'cli' | 'interactive'
 * @returns {{version: number, preset: string, source: string, updated_at: string}}
 */
export function buildActivePresetFile(
  presetName,
  source = 'cli',
  updatedAt = new Date().toISOString(),
) {
  return {
    version: 1,
    preset: presetName,
    source,
    updated_at: updatedAt,
  }
}

/**
 * Persist the active preset marker, backing up any previous file to .bak.
 * Atomic via tmp+rename, health-check after write.
 *
 * @param {string} presetDir install target (project root or global opencode dir)
 * @param {string} presetName
 * @param {{dryRun?: boolean, source?: string, logger?: object}} [opts]
 * @returns {{written: boolean, path: string, backupPath: string|null}}
 */
export function writeActivePreset(
  presetDir,
  presetName,
  { dryRun = false, source = 'cli', logger = console, updatedAt, recorder = null } = {},
) {
  const dir = join(presetDir, '.pantheon')
  const filePath = join(dir, 'active-preset.json')
  const backupPath = join(dir, 'active-preset.json.bak')

  const content = `${JSON.stringify(buildActivePresetFile(presetName, source, updatedAt), null, 2)}\n`
  assertNoSymlinkAncestors(filePath)
  assertNoSymlinkAncestors(backupPath)
  assertNoSymlinkAncestors(`${filePath}.tmp-${process.pid}`)
  assertNoSymlinkAncestors(`${backupPath}.tmp-${process.pid}`)
  let current = null
  try {
    const info = lstatSync(filePath)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Refusing to write through non-regular file: ${filePath}`)
    }
    current = readFileSync(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (current !== null) {
    const backupSnapshot = snapshot(backupPath)
    recordChange(
      {
        path: backupPath,
        action: !backupSnapshot.exists
          ? ACTIONS.CREATE
          : backupSnapshot.sha256 === fingerprintOutput(current)
            ? ACTIONS.UNCHANGED
            : ACTIONS.UPDATE,
        bytes: current.length,
        outputFingerprint: fingerprintOutput(current),
        scored: false,
      },
      recorder,
    )
    if (!dryRun && backupSnapshot.sha256 !== fingerprintOutput(current)) {
      writeFileAtomically(backupPath, current)
    }
  }
  const before = snapshot(filePath)
  recordChange(
    {
      path: filePath,
      action: !before.exists
        ? ACTIONS.CREATE
        : current?.toString('utf8') === content
          ? ACTIONS.UNCHANGED
          : ACTIONS.UPDATE,
      bytes: Buffer.byteLength(content, 'utf8'),
      outputFingerprint: fingerprintOutput(content),
    },
    recorder,
  )
  if (dryRun) {
    logger.log?.(`[dry-run] Would write model preset "${presetName}" to ${filePath}`)
    return { written: false, path: filePath, backupPath: null }
  }

  mkdirSync(dir, { recursive: true })
  assertNoSymlinkAncestors(filePath)
  assertNoSymlinkAncestors(backupPath)
  writeFileAtomically(filePath, content)
  // health-check: verify file is readable and valid JSON with preset
  try {
    const content = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(content)
    if (!parsed || parsed.preset !== presetName) throw new Error('mismatch')
  } catch (err) {
    logger.warn?.(`health-check: active-preset.json verification failed: ${err.message}`)
  }
  return { written: true, path: filePath, backupPath: current !== null ? backupPath : null }
}

/**
 * Interactive model preset picker. Asks the user to choose a preset; persists
 * the choice unless dryRun. `rl` may be injected for tests; otherwise a
 * readline/promises interface on stdin/stdout is created and closed.
 *
 * @param {{presetDir?: string, presets?: object, dryRun?: boolean, logger?: object, rl?: object}} [opts]
 * @returns {Promise<string|null>} chosen preset name or null (skipped/unknown)
 */
export async function runModelPicker({
  presetDir,
  presets,
  dryRun = false,
  logger = console,
  rl,
} = {}) {
  const defs = presets ?? loadPresetDefs()
  const names = Object.keys(defs)
  if (names.length === 0) {
    logger.warn?.('Model presets: no presets defined in routing.yml')
    return null
  }

  const list = names
    .map(
      (n, i) =>
        `  ${i + 1}) ${n} — ${defs[n].description ?? ''} | ${buildPresetTableRow(n, defs[n])}`,
    )
    .join('\n')
  const rli = rl ?? createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rli.question(
      `\nModel presets (number or name; blank to skip):\n${list}\n> `,
    )
    const trimmed = (answer ?? '').trim()
    if (trimmed === '' || trimmed.toLowerCase() === 'none') {
      logger.log?.('Skipping model preset selection.')
      return null
    }
    let name = null
    if (names.includes(trimmed)) {
      name = trimmed
    } else {
      const idx = Number(trimmed)
      if (Number.isInteger(idx) && idx >= 1 && idx <= names.length) {
        name = names[idx - 1]
      }
    }
    if (!name) {
      logger.warn?.(`Unknown preset "${trimmed}" — skipping model preset selection.`)
      return null
    }
    if (!dryRun) {
      writeActivePreset(presetDir, name, { dryRun: false, source: 'interactive', logger })
    } else {
      logger.log?.(`[dry-run] Would set model preset "${name}"`)
    }
    return name
  } finally {
    if (!rl) rli.close()
  }
}

/**
 * Collect the V1 model profile and save scope, without reading API keys.
 *
 * @param {{presetDir?: string, target?: string, presets?: object, env?: Record<string,string|undefined>, dryRun?: boolean, logger?: object, ask?: Function, prompts?: object}} [opts]
 * @returns {Promise<{preset:string, scope:string}|null>}
 */
export async function runInitWizard({
  presetDir,
  target,
  presets,
  env = process.env,
  dryRun = false,
  logger = console,
  ask,
  prompts = clack,
} = {}) {
  const defs = presets ?? loadPresetDefs()
  const questions = buildInitQuestions(defs)
  if (questions[0].options.length === 1) {
    logger.warn?.('Model presets: no selectable presets defined in routing.yml')
    return null
  }

  let answers
  if (typeof ask === 'function') {
    try {
      answers = await ask(questions)
    } catch (err) {
      logger.warn?.(`Init wizard canceled: ${err.message}`)
      return null
    }
  } else {
    const select = prompts.select
    const isCancel = prompts.isCancel ?? clack.isCancel
    const preset = await select({
      message: questions[0].question,
      options: questions[0].options.map(({ label, value, description }) => ({
        label,
        value,
        hint: description,
      })),
      initialValue: 'inherit',
    })
    if (isCancel(preset)) {
      prompts.cancel?.('Model selection canceled.')
      return null
    }
    if (preset === 'inherit') {
      answers = { preset, scope: 'project' }
    } else {
      const scope = await select({
        message: questions[1].question,
        options: questions[1].options.map(({ label, value, description }) => ({
          label,
          value,
          hint: description,
        })),
        initialValue: 'project',
      })
      if (isCancel(scope)) {
        prompts.cancel?.('Model selection canceled.')
        return null
      }
      answers = { preset, scope }
    }
  }

  const unwrap = (value) => {
    if (value && typeof value === 'object') {
      return unwrap(value.value ?? value.answer ?? value.label)
    }
    return value
  }
  let presetAnswer
  let scopeAnswer
  const values = answers?.answers ?? answers
  if (Array.isArray(values)) {
    presetAnswer = unwrap(values[0])
    scopeAnswer = unwrap(values[1])
  } else if (values && typeof values === 'object') {
    presetAnswer = unwrap(values.preset ?? values['0'] ?? values.q1)
    scopeAnswer = unwrap(values.scope ?? values['1'] ?? values.q2)
  }

  const rawPreset = String(presetAnswer ?? 'inherit').trim()
  const choice = INSTALLER_PRESET_CHOICES.find(
    ({ label, value }) =>
      rawPreset.toLowerCase() === value.toLowerCase() ||
      rawPreset.toLowerCase() === label.toLowerCase(),
  )
  if (!choice) {
    logger.warn?.(`Unknown model profile "${rawPreset}" — wizard canceled.`)
    return null
  }
  if (choice.value === 'inherit') {
    logger.log?.('Using the current chat model; no active preset was saved.')
    return { preset: 'inherit', scope: 'project' }
  }
  if (!defs[choice.value]) {
    logger.warn?.(`Model profile "${choice.label}" is not defined — wizard canceled.`)
    return null
  }

  const scopeChoice = String(unwrap(scopeAnswer) ?? 'project')
    .trim()
    .toLowerCase()
  const finalScope = scopeChoice === 'global' ? 'global' : 'project'
  logger.log?.(presetKeyEnvGuidance(choice.value, choice.label))

  const projectDir = presetDir ?? target ?? process.cwd()
  const globalDir = (() => {
    const home = env.HOME?.trim() || homedir()
    const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
    return join(xdg, 'opencode')
  })()
  const dir = finalScope === 'global' ? globalDir : projectDir
  if (dryRun) {
    logger.log?.(`[dry-run] Would write preset "${choice.value}" scope ${finalScope}`)
    return { preset: choice.value, scope: finalScope }
  }

  const result = writeActivePreset(dir, choice.value, {
    source: 'interactive',
    logger,
  })
  logger.log?.(`Preset ${choice.value} saved in ${finalScope} (${result.path})`)
  try {
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'))
    if (parsed.preset !== choice.value) throw new Error('preset mismatch')
    logger.log?.('health-check: active-preset.json OK')
  } catch (err) {
    logger.warn?.(`health-check failed: ${err.message}`)
  }
  return { preset: choice.value, scope: finalScope }
}
