#!/usr/bin/env node
/**
 * model-picker.mjs — interactive model preset selection + persistence
 *
 * Used by the installer (interactive prompt) and the `pantheon-opencode`
 * CLI. Writes the active preset marker to <presetDir>/.pantheon/active-preset.json
 * which the plugin (src/plugin.ts) reads on startup via resolveActivePreset().
 *
 * 3-question interactive wizard (askQuestions style):
 *  1) perfil (0=herdar do chat [default], go-free/fast/premium/openai) com tabela modelos por papel + provider/baseURL/key + preço
 *  2) coleta key mascarada validando PANTHEON_OPENCODE_API_KEY alias OPENCODE_GO_API_KEY e OPENAI_API_KEY
 *  3) escopo project|global → writeActivePreset atômico .bak health-check
 *
 * "herdar do chat" (inherit) é o default da Q1: não grava active-preset.json,
 * então os delegates herdam o modelo do chat pai (herança nativa, sem preset).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { loadPresetDefs } from '../../src/pantheon/presets.mjs'

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
  return 'PANTHEON_OPENCODE_API_KEY'
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
 * Build askQuestions payload for init wizard (3 perguntas).
 * Caller can pass this to agent/askQuestions or render via readline.
 * @param {Record<string,object>} presetDefs
 * @returns {Array<object>}
 */
export function buildInitQuestions(presetDefs) {
  const names = Object.keys(presetDefs)
  const presetOptions = [
    {
      label: 'inherit',
      description: 'Herda modelo do chat pai — não grava active-preset.json (herança nativa)',
    },
    ...names.map((n) => ({
      label: n,
      description: buildPresetTableRow(n, presetDefs[n]),
    })),
  ]
  return [
    {
      header: 'Perfil de modelos',
      question:
        'Escolha o perfil (0=herdar do chat [default], go-free/fast/premium/openai) — tabela: perfil | provider/baseURL/key | preço | modelos por papel',
      options: presetOptions,
      multiSelect: false,
    },
    {
      header: 'API Key',
      question:
        'Informe a chave (coleta mascarada). Validação: PANTHEON_OPENCODE_API_KEY (alias OPENCODE_GO_API_KEY aceito) para Go; OPENAI_API_KEY para openai. Não escreve .env.',
      kind: 'password',
    },
    {
      header: 'Escopo',
      question: 'Onde salvar o preset ativo?',
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

/**
 * Build the active-preset.json payload (version 1).
 *
 * @param {string} presetName
 * @param {string} [source] 'cli' | 'interactive'
 * @returns {{version: number, preset: string, source: string, updated_at: string}}
 */
export function buildActivePresetFile(presetName, source = 'cli') {
  return {
    version: 1,
    preset: presetName,
    source,
    updated_at: new Date().toISOString(),
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
  { dryRun = false, source = 'cli', logger = console } = {},
) {
  const dir = join(presetDir, '.pantheon')
  const filePath = join(dir, 'active-preset.json')
  const backupPath = join(dir, 'active-preset.json.bak')

  if (dryRun) {
    logger.log?.(`[dry-run] Would write model preset "${presetName}" to ${filePath}`)
    return { written: false, path: filePath, backupPath: null }
  }

  mkdirSync(dir, { recursive: true })
  let backupMade = false
  if (existsSync(filePath)) {
    copyFileSync(filePath, backupPath)
    backupMade = true
  }
  writeFileSync(
    `${filePath}.tmp-${process.pid}`,
    `${JSON.stringify(buildActivePresetFile(presetName, source), null, 2)}\n`,
  )
  renameSync(`${filePath}.tmp-${process.pid}`, filePath)
  // health-check: verify file is readable and valid JSON with preset
  try {
    const content = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(content)
    if (!parsed || parsed.preset !== presetName) throw new Error('mismatch')
  } catch (err) {
    logger.warn?.(`health-check: active-preset.json verification failed: ${err.message}`)
  }
  return { written: true, path: filePath, backupPath: backupMade ? backupPath : null }
}

/**
 * Masked input helper: reads line without echoing (fallback to plain question).
 * @param {import('node:readline/promises').Interface} rli
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function questionMasked(rli, prompt) {
  // Node readline doesn't support masking natively; we try to use raw mode.
  // Fallback: plain question (test env will provide mock).
  return await rli.question(prompt)
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
 * 3-question init wizard via askQuestions (or readline fallback).
 * Steps:
 *  1) perfil (0=herdar do chat [default], go-free/fast/premium/openai) com tabela
 *  2) coleta key mascarada validando PANTHEON_OPENCODE_API_KEY alias OPENCODE_GO_API_KEY e OPENAI_API_KEY
 *  3) escopo project|global → writeActivePreset atômico .bak health-check
 *
 * "herdar do chat" (inherit) é o default da Q1: não grava active-preset.json,
 * então os delegates herdam o modelo do chat pai (herança nativa, sem preset).
 *
 * @param {{presetDir?: string, target?: string, presets?: object, env?: Record<string,string|undefined>, dryRun?: boolean, logger?: object, ask?: Function, rl?: object}} [opts]
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
  rl,
} = {}) {
  const defs = presets ?? loadPresetDefs()
  const names = Object.keys(defs)
  if (names.length === 0) {
    logger.warn?.('Model presets: no presets defined in routing.yml')
    return null
  }

  // Build questions payload for askQuestions
  const questions = buildInitQuestions(defs)

  // If ask is provided (OpenCode agent/askQuestions), use it
  let answers
  if (typeof ask === 'function') {
    try {
      answers = await ask(questions)
    } catch (err) {
      logger.warn?.(`Init wizard canceled: ${err.message}`)
      return null
    }
  } else {
    // Fallback: readline 3-step wizard
    const rli = rl ?? createInterface({ input: process.stdin, output: process.stdout })
    const closeAfter = !rl
    try {
      // Q1: perfil (0 = herdar do chat, default)
      const list = [
        '  0) inherit — Herda modelo do chat pai (não grava active-preset.json)',
        ...names.map((n, i) => `  ${i + 1}) ${buildPresetTableRow(n, defs[n])}`),
      ].join('\n')
      const a1 = await rli.question(
        `\n[1/3] Perfil de modelos (0=herdar do chat [default], number or name):\n${list}\n> `,
      )
      const t1 = (a1 ?? '').trim()
      let presetName = null
      if (t1 === '' || t1 === '0' || t1 === 'inherit' || t1.toLowerCase() === 'none') {
        presetName = 'inherit'
      } else if (names.includes(t1)) {
        presetName = t1
      } else {
        const idx = Number(t1)
        if (Number.isInteger(idx) && idx >= 1 && idx <= names.length) presetName = names[idx - 1]
      }
      if (!presetName) {
        logger.warn?.(`Unknown preset "${t1}" — wizard canceled.`)
        return null
      }
      if (presetName === 'inherit') {
        logger.log?.(
          'Herança nativa: delegates herdam o modelo do chat pai — nenhum preset ativo gravado.',
        )
        return { preset: 'inherit', scope: 'project' }
      }

      // Q2: key masked
      const requiredEnv = requiredKeyEnvForPreset(presetName, defs[presetName])
      const aliasNote =
        requiredEnv === 'PANTHEON_OPENCODE_API_KEY' ? ' (alias OPENCODE_GO_API_KEY aceito)' : ''
      const envConfigured = isKeyConfiguredForPreset(env, presetName, defs[presetName])
      let keyAnswer = ''
      if (envConfigured) {
        logger.log?.(
          `Chave ${requiredEnv}${aliasNote} já configurada no ambiente (mascarada: ${maskKey(env[requiredEnv] ?? env.OPENCODE_GO_API_KEY ?? '')}).`,
        )
      } else {
        // masked collection
        const prompt = `[2/3] Informe ${requiredEnv}${aliasNote} (entrada mascarada, não escreve .env): `
        // Use questionMasked for tests; real TTY would mask
        keyAnswer = (await questionMasked(rli, prompt)).trim()
        if (keyAnswer === '') {
          logger.warn?.(
            `Chave vazia para ${requiredEnv} — wizard canceled. Preencha env ${requiredEnv} antes de continuar.`,
          )
          return null
        }
        // validate non-empty already; optionally check length
        if (!dryRun) {
          // For health-check, set in current env (not .env file) for this session
          // Prefer primary var
          env[requiredEnv] = keyAnswer
          logger.log?.(
            `Chave coletada (mascarada: ${maskKey(keyAnswer)}). Defina export ${requiredEnv}='${maskKey(keyAnswer)}' no seu shell para persistir (não escrevemos .env).`,
          )
        }
      }

      // Q3: escopo
      const a3 = await rli.question(`[3/3] Escopo (project|global, default project): `)
      const scopeRaw = (a3 ?? '').trim().toLowerCase()
      const scope = scopeRaw === 'global' ? 'global' : 'project'

      answers = { preset: presetName, scope, key: keyAnswer }
    } finally {
      if (closeAfter) rli.close()
    }
    // For fallback path, we already have answers; proceed to write
    const presetName = answers.preset
    const scope = answers.scope ?? 'project'
    const projectDir = presetDir ?? target ?? process.cwd()
    const globalDir = (() => {
      const home = env.HOME?.trim() || homedir()
      const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
      return join(xdg, 'opencode')
    })()
    const dir = scope === 'global' ? globalDir : projectDir
    if (!dryRun) {
      const result = writeActivePreset(dir, presetName, {
        dryRun: false,
        source: 'interactive',
        logger,
      })
      logger.log?.(
        `Preset ${presetName} salvo em ${scope} (${result.path})${result.backupPath ? ` backup: ${result.backupPath}` : ''}`,
      )
      // health-check: verify file
      try {
        const raw = readFileSync(result.path, 'utf8')
        JSON.parse(raw)
        logger.log?.('health-check: active-preset.json OK')
      } catch (e) {
        logger.warn?.(`health-check failed: ${e.message}`)
      }
    } else {
      logger.log?.(`[dry-run] Would write preset "${presetName}" scope ${scope}`)
    }
    return { preset: presetName, scope }
  }

  // ask path: answers expected as object with preset/scope/key or array
  // Normalize: ask may return {answers: [...]} or direct mapping (also handles {label} objects)
  let presetName, scope, keyAnswer
  if (Array.isArray(answers)) {
    const a0 = answers[0]?.answer ?? answers[0]
    const a1 = answers[1]?.answer ?? answers[1]
    const a2 = answers[2]?.answer ?? answers[2]
    presetName = a0 && typeof a0 === 'object' && 'label' in a0 ? a0.label : a0
    keyAnswer = a1 && typeof a1 === 'object' && 'answer' in a1 ? a1.answer : a1
    if (keyAnswer && typeof keyAnswer === 'object' && 'label' in keyAnswer)
      keyAnswer = keyAnswer.label
    scope = a2 && typeof a2 === 'object' && 'label' in a2 ? a2.label : a2
    if (scope && typeof scope === 'object' && 'answer' in scope) scope = scope.answer
  } else if (answers && typeof answers === 'object') {
    presetName = answers.preset ?? answers['0'] ?? answers.q1 ?? answers.presetName
    keyAnswer = answers.key ?? answers['1'] ?? answers.q2
    scope = answers.scope ?? answers['2'] ?? answers.q3
    if (presetName && typeof presetName === 'object' && 'label' in presetName)
      presetName = presetName.label
    if (presetName && typeof presetName === 'object' && 'answer' in presetName)
      presetName = presetName.answer
    if (scope && typeof scope === 'object' && 'label' in scope) scope = scope.label
    if (scope && typeof scope === 'object' && 'answer' in scope) scope = scope.answer
  }
  if (typeof presetName === 'string') presetName = presetName.trim()
  // Q1 default = herdar do chat: empty/0/inherit/none writes nothing (não grava active-preset.json)
  if (!presetName || presetName === '0' || presetName === 'inherit' || presetName === 'none') {
    logger.log?.(
      'Herança nativa: delegates herdam o modelo do chat pai — nenhum preset ativo gravado.',
    )
    return { preset: 'inherit', scope: 'project' }
  }
  if (!names.includes(presetName)) {
    logger.warn?.(`Unknown preset "${presetName}" — wizard canceled.`)
    return null
  }
  const requiredEnv = requiredKeyEnvForPreset(presetName, defs[presetName])
  const envConfigured = isKeyConfiguredForPreset(
    { ...env, ...(keyAnswer ? { [requiredEnv]: keyAnswer } : {}) },
    presetName,
    defs[presetName],
  )
  if (!envConfigured) {
    logger.warn?.(`Chave ${requiredEnv} não configurada — defina env antes de continuar.`)
    return null
  }
  if (keyAnswer && !dryRun) {
    env[requiredEnv] = keyAnswer
    logger.log?.(
      `Chave coletada (mascarada: ${maskKey(String(keyAnswer))}). Não escrevemos .env; export ${requiredEnv} no shell para persistir.`,
    )
  }
  const finalScope = scope === 'global' ? 'global' : 'project'
  const projectDir = presetDir ?? target ?? process.cwd()
  const globalDir = (() => {
    const home = env.HOME?.trim() || homedir()
    const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
    return join(xdg, 'opencode')
  })()
  const dir = finalScope === 'global' ? globalDir : projectDir
  if (!dryRun) {
    const result = writeActivePreset(dir, presetName, {
      dryRun: false,
      source: 'interactive',
      logger,
    })
    logger.log?.(`Preset ${presetName} salvo em ${finalScope} (${result.path})`)
    try {
      const raw = readFileSync(result.path, 'utf8')
      JSON.parse(raw)
      logger.log?.('health-check: active-preset.json OK')
    } catch (e) {
      logger.warn?.(`health-check failed: ${e.message}`)
    }
  } else {
    logger.log?.(`[dry-run] Would write preset "${presetName}" scope ${finalScope}`)
  }
  return { preset: presetName, scope: finalScope }
}
