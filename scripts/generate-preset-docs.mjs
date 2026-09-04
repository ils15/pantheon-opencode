#!/usr/bin/env node
/**
 * generate-preset-docs.mjs — Generate markdown tables from src/routing.yml
 *
 * Reads routing.yml + presets.mjs + model-picker.mjs and prints:
 *  1) Presets summary table (perfil | provider/baseURL | key env | pricing 2026 | vision | papéis)
 *  2) 14 agents × 4 presets matrix (model + effort + vision)
 *  3) Capability table (model prefix → maxEffort, vision)
 *
 * No secrets are hardcoded — only env var NAMES and baseURLs from routing.yml
 * are emitted. Pricing labels come from model-picker PRESET_PRICE.
 *
 * Usage:
 *   node scripts/generate-preset-docs.mjs         # print all
 *   node scripts/generate-preset-docs.mjs --summary  # only summary
 *   node scripts/generate-preset-docs.mjs --matrix   # only matrix
 *   node scripts/generate-preset-docs.mjs --json     # JSON for tooling
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { CAPABILITY_TABLE, hasVision, normalizeCapability } from '../src/pantheon/presets.mjs'
import { PRESET_PRICE } from './install/model-picker.mjs'

const routingPath = fileURLToPath(new URL('../src/routing.yml', import.meta.url))
const raw = readFileSync(routingPath, 'utf8')
const routing = yaml.load(raw)
const presets = routing?.presets ?? {}

const KNOWN_AGENTS_ORDER = [
  'zeus',
  'athena',
  'themis',
  'hermes',
  'aphrodite',
  'demeter',
  'prometheus',
  'hephaestus',
  'apollo',
  'nyx',
  'gaia',
  'iris',
  'mnemosyne',
  'talos',
]

function agentSort(a, b) {
  const ia = KNOWN_AGENTS_ORDER.indexOf(a)
  const ib = KNOWN_AGENTS_ORDER.indexOf(b)
  if (ia === -1 && ib === -1) return a.localeCompare(b)
  if (ia === -1) return 1
  if (ib === -1) return -1
  return ia - ib
}

function safeEnvLabel(_apiKeyEnv) {
  return '`[redacted]`'
}

function providerLabel(def) {
  const entries = Object.entries(def.providers ?? {})
  if (entries.length === 0) return '—'
  return entries
    .map(([id, p]) => `\`${id}\` \`${p.baseURL ?? ''}\` (env: ${safeEnvLabel(p.apiKeyEnv)})`)
    .join('<br>')
}

function pricingLabel(name) {
  const p = PRESET_PRICE[name]
  if (!p) return '—'
  return `${p.label} — ${p.detail}`
}

function visionLabel(def) {
  if (!def.vision) return '—'
  const m = def.vision.model
  let visionFlag = '—'
  try {
    visionFlag = hasVision(m) ? '👁️ vision' : 'text-only'
  } catch {
    visionFlag = 'unknown'
  }
  return `\`${m}\` [${def.vision.reasoning_effort ?? ''}] ${visionFlag}`
}

function capabilityBadge(model) {
  try {
    const v = hasVision(model)
    const cap = normalizeCapability(model, 'high')
    // cap.variant is clamped effort for 'high'
    // also get maxEffort via capabilityEntry
    const entry = CAPABILITY_TABLE.find(
      (e) =>
        model.startsWith(e.prefix) ||
        model.slice(model.lastIndexOf('/') + 1).startsWith(e.prefix) ||
        model.slice(model.lastIndexOf('/') + 1) === e.prefix,
    )
    // But use direct lookup via prefix matching like capabilityEntry does
    return { vision: v, maxEffort: entry?.maxEffort ?? 'unknown', clamped: cap.variant }
  } catch {
    return { vision: undefined, maxEffort: 'unknown', clamped: undefined }
  }
}

function buildSummaryTable() {
  const lines = []
  lines.push(
    '| Preset | Provider / BaseURL | Key env (nome) | Pricing 2026 | Vision (fallback) | Papéis / Modelos |',
  )
  lines.push('|---|---|---|---|---|---|')
  for (const name of Object.keys(presets)) {
    const def = presets[name]
    const prov = providerLabel(def)
    // env names redacted to avoid exposing credential-related metadata
    const envs =
      Object.values(def.providers ?? {})
        .map((p) => safeEnvLabel(p.apiKeyEnv))
        .join(', ') || '—'
    // Actually use providerLabel already includes env, but separate column for key env
    const pricing = pricingLabel(name)
    const vision = visionLabel(def)
    // Papéis grouped: planners/high, implementers/medium, scouts/low
    const agents = def.agents ?? {}
    const groups = {}
    for (const [agent, spec] of Object.entries(agents)) {
      const key = `\`${spec.model}\` [${spec.reasoning_effort ?? ''}]`
      if (!groups[key]) groups[key] = []
      groups[key].push(agent)
    }
    const papelSummary = Object.entries(groups)
      .map(([model, list]) => `${list.join(',')}: ${model}`)
      .join('<br>')
    lines.push(`| \`${name}\` | ${prov} | ${envs} | ${pricing} | ${vision} | ${papelSummary} |`)
  }
  return lines.join('\n')
}

function buildMatrixTable() {
  const presetNames = Object.keys(presets)
  const lines = []
  // header
  lines.push(
    `| Agente | ${presetNames.map((n) => `\`${n}\``).join(' | ')} | Capability (vision / maxEffort) |`,
  )
  lines.push(`|---|${presetNames.map(() => '---').join('|')}|---|`)
  // collect all agents
  const allAgents = new Set()
  for (const def of Object.values(presets))
    for (const a of Object.keys(def.agents ?? {})) allAgents.add(a)
  const sorted = [...allAgents].sort(agentSort)
  for (const agent of sorted) {
    const cells = presetNames.map((presetName) => {
      const spec = presets[presetName]?.agents?.[agent]
      if (!spec) return '—'
      const badge = capabilityBadge(spec.model)
      const visionIcon = badge.vision ? '👁️' : '—'
      // don't expose raw key, just model and effort
      return `\`${spec.model}\`<br>[${spec.reasoning_effort}] ${visionIcon}`
    })
    // capability column: pick first preset's model for reference, but show per-agent vision across presets is same family
    const sampleModel = presets[presetNames[0]]?.agents?.[agent]?.model ?? ''
    let capStr = '—'
    if (sampleModel) {
      try {
        const v = hasVision(sampleModel)
        capStr = v ? 'vision' : 'text-only'
      } catch {
        capStr = 'unknown'
      }
    }
    // Show effort clamp per preset? Instead show generic
    lines.push(`| \`${agent}\` | ${cells.join(' | ')} | ${capStr} |`)
  }
  return lines.join('\n')
}

function buildDetailedMatrixWithEffort() {
  const presetNames = Object.keys(presets)
  const lines = []
  lines.push(`| Agente | ${presetNames.map((n) => `\`${n}\``).join(' | ')} |`)
  lines.push(`|---|${presetNames.map(() => '---').join('|')}|`)
  const allAgents = new Set()
  for (const def of Object.values(presets))
    for (const a of Object.keys(def.agents ?? {})) allAgents.add(a)
  const sorted = [...allAgents].sort(agentSort)
  for (const agent of sorted) {
    const cells = presetNames.map((presetName) => {
      const spec = presets[presetName]?.agents?.[agent]
      if (!spec) return '—'
      let vision = '—'
      try {
        vision = hasVision(spec.model) ? '👁️' : '·'
      } catch {
        vision = '?'
      }
      return `\`${spec.model}\` [${spec.reasoning_effort}] ${vision}`
    })
    lines.push(`| \`${agent}\` | ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}

function buildProviderTable() {
  const lines = []
  lines.push('| Preset | Provider | BaseURL | Key env |')
  lines.push('|---|---|---|---|')
  for (const [name, def] of Object.entries(presets)) {
    for (const [pid, prov] of Object.entries(def.providers ?? {})) {
      const keyEnvStatus = prov.apiKeyEnv ? 'configured' : 'none'
      lines.push(`| \`${name}\` | \`${pid}\` | \`${prov.baseURL ?? ''}\` | \`${keyEnvStatus}\` |`)
    }
  }
  return lines.join('\n')
}

function buildPricingTable() {
  const lines = []
  lines.push('| Preset | Pricing 2026 | Detalhe | Gateway / Custo |')
  lines.push('|---|---|---|---|')
  for (const name of Object.keys(presets)) {
    const p = PRESET_PRICE[name] ?? { label: '—', detail: '—' }
    const def = presets[name]
    const prov = Object.keys(def.providers ?? {}).join(', ')
    const costHint =
      name === 'go-free'
        ? '$0 (free-tier Zen, quota limitada)'
        : name === 'go-fast'
          ? 'Baixo custo (Go gateway, baixa latência)'
          : name === 'go-premium'
            ? 'Premium (Go gateway, melhor qualidade)'
            : 'Pago por uso (OpenAI direto)'
    lines.push(`| \`${name}\` | ${p.label} | ${p.detail} | ${prov} — ${costHint} |`)
  }
  return lines.join('\n')
}

function buildCapabilityTable() {
  const lines = []
  lines.push('| Prefix | Max Effort | Vision | Strip Effort |')
  lines.push('|---|---|---|---|')
  for (const e of CAPABILITY_TABLE) {
    lines.push(
      `| \`${e.prefix}\` | ${e.maxEffort ?? '—'} | ${e.vision ? '👁️' : '—'} | ${e.stripEffort ? 'yes' : 'no'} |`,
    )
  }
  return lines.join('\n')
}

const args = process.argv.slice(2)
if (args.includes('--json')) {
  const out = { presets, PRESET_PRICE, CAPABILITY_TABLE }
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}
if (args.includes('--summary')) {
  console.log(buildSummaryTable())
  process.exit(0)
}
if (args.includes('--matrix')) {
  console.log(buildMatrixTable())
  process.exit(0)
}
if (args.includes('--provider')) {
  console.log(buildProviderTable())
  process.exit(0)
}
if (args.includes('--pricing')) {
  console.log(buildPricingTable())
  process.exit(0)
}
if (args.includes('--capability')) {
  console.log(buildCapabilityTable())
  process.exit(0)
}

// default: print all
console.log(
  '<!-- Generated from src/routing.yml + src/pantheon/presets.mjs + scripts/install/model-picker.mjs — do not edit manually. Run: node scripts/generate-preset-docs.mjs -->',
)
console.log('')
console.log('### Presets — resumo (provider / baseURL / key / pricing / vision)')
console.log('')
console.log(buildSummaryTable())
console.log('')
console.log('### Provider / BaseURL / Key env')
console.log('')
console.log(buildProviderTable())
console.log('')
console.log('### Pricing 2026')
console.log('')
console.log(buildPricingTable())
console.log('')
console.log('### 14 agentes × 4 presets — modelo + effort + vision')
console.log('')
console.log(buildDetailedMatrixWithEffort())
console.log('')
console.log('### Capability table (prefix → maxEffort, vision)')
console.log('')
console.log(buildCapabilityTable())
