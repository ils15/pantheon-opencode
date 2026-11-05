#!/usr/bin/env node
/**
 * jev-live-probe.mjs — operator-run live measurement for the Jev decision
 * route (config-only route check + live scorecard).
 *
 * The ping resolves the configured route without contacting a provider. The
 * scorecard talks to the HOST's decisions API through `opencode api` (the same
 * route the plugin uses), so no credentials cross this script and each live
 * call is billed to the user's configured route. Operator-run by design: the
 * J2 scorecard is the consented live-model measurement; the offline harness
 * measures plumbing only.
 *
 * Usage:
 *   node scripts/jev-live-probe.mjs --ping               # config-only route resolution; no provider call
 *   node scripts/jev-live-probe.mjs --scorecard          # N scenarios, dated scorecard
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  DECISION_ROUTER_MODELS,
  readUserDecisionRouterConfig,
} from './install/decision-router-config.mjs'

const HOST_TIMEOUT_MS = 30_000

/** Config provider IDs translated to the host's native Decisions provider IDs. */
export const HOST_PROVIDERS = Object.freeze({
  'typesafe-jev': 'typesafe-ai',
  'opencode-console-jev': 'opencode',
  'openrouter-jev': 'openrouter',
  'vercel-gateway-jev': 'vercel-ai-gateway',
  'cloudflare-workers-jev': 'cloudflare-workers-ai',
})

/** Live scenarios: state → the skill a correct picker would choose. */
const SCENARIOS = [
  { state: 'Investigate why the payment webhook drops events under load', expect: 'apollo' },
  { state: 'Plan the database migration for the new billing table', expect: 'athena' },
  { state: 'Review the auth flow for security gaps before the release', expect: 'themis' },
  { state: 'Implement the retry queue endpoint for the notifications service', expect: 'hermes' },
  { state: 'Set up the CI pipeline for the new monorepo layout', expect: 'prometheus' },
  { state: 'Audit the permissions matrix across all specialists', expect: 'themis' },
  { state: 'Design the caching layer for the read-heavy dashboard', expect: 'athena' },
  { state: 'none — greet the user and ask what they want', expect: 'none' },
  // Zero-dispatch agents' domains (roster-reform evidence batch)
  { state: 'Write the SQL indexes and stored procedures for the orders schema', expect: 'demeter' },
  { state: 'Process the satellite imagery tiles and classify land use', expect: 'gaia' },
  {
    state: 'Integrate the new LLM provider SDK and wire the prompt templates',
    expect: 'hephaestus',
  },
  { state: 'Migrate the open issues to the new milestone labels via the API', expect: 'iris' },
  { state: 'Decide which stale session summaries are worth keeping', expect: 'mnemosyne' },
  { state: 'Fuzz the input parser with malformed payloads to find crashes', expect: 'nyx' },
  { state: 'Fix the typo that makes the CLI parse --verbose as the output path', expect: 'talos' },
  { state: 'Polish the onboarding screen layout and micro-interactions', expect: 'aphrodite' },
]

function callDecisions(modelRef, state) {
  const payload = JSON.stringify({
    model: modelRef,
    input: [{ type: 'text', text: state }],
    questions: [
      {
        type: 'choice',
        name: 'pick',
        instructions:
          'Pick the single best specialist for this task, or none. Required skills beat preferred ones; judge from the state alone.',
        choices: [
          { value: 'apollo', description: 'read-only investigation and research' },
          { value: 'athena', description: 'planning and architecture' },
          { value: 'themis', description: 'security, review and compliance gates' },
          { value: 'hermes', description: 'backend implementation' },
          { value: 'prometheus', description: 'infrastructure, CI and pipelines' },
          { value: 'hephaestus', description: 'AI tooling and model integration' },
          { value: 'demeter', description: 'databases and data layer' },
          { value: 'gaia', description: 'remote sensing and geospatial' },
          { value: 'iris', description: 'GitHub operations and automation' },
          { value: 'aphrodite', description: 'UI and frontend craft' },
          { value: 'mnemosyne', description: 'memory curation and recall' },
          { value: 'nyx', description: 'chaos and adversarial testing' },
          { value: 'talos', description: 'hotfix express lane - small direct fixes, no ceremony' },
          { value: 'none', description: 'no specialist fits' },
        ],
      },
    ],
  })
  const result = spawnSync(
    'opencode',
    ['api', 'POST', '/api/experimental/generate/decisions', '-d', payload],
    {
      encoding: 'utf8',
      timeout: HOST_TIMEOUT_MS,
    },
  )
  if (result.status !== 0) {
    return { ok: false, raw: (result.stderr || result.stdout || '').slice(0, 300) }
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) }
  } catch {
    return { ok: false, raw: result.stdout.slice(0, 300) }
  }
}

function answerChoice(data) {
  const answers = data?.data?.answers ?? data?.answers
  if (!Array.isArray(answers)) return null
  const pick = answers.find((a) => a.name === 'pick')
  return pick?.choice ?? null
}

/** Resolve the configured explicit route without probing the provider. */
export function resolveConfiguredRoute(config) {
  if (!config?.enabled || config.selection?.mode !== 'explicit') {
    throw new Error('the router must be enabled with an explicit selection')
  }
  const { provider, model } = config.selection
  const hostProvider = HOST_PROVIDERS[provider]
  if (
    !Object.hasOwn(HOST_PROVIDERS, provider) ||
    !DECISION_ROUTER_MODELS[provider]?.includes(model)
  ) {
    throw new Error(`unknown or unsupported selection: ${provider}/${model}`)
  }
  return { providerID: hostProvider, id: model }
}

/** Report the configured route only; deliberately makes no Decisions call. */
export function pingConfiguredRoute(config, { stdout = console.log } = {}) {
  const modelRef = resolveConfiguredRoute(config)
  stdout(`✅ configured route: ${modelRef.providerID}/${modelRef.id} (no live provider call)`)
  return modelRef
}

function main(args = process.argv.slice(2)) {
  if (args.includes('--ping')) {
    try {
      pingConfiguredRoute(readUserDecisionRouterConfig())
      process.exit(0)
    } catch (error) {
      console.error(
        `❌ route unresolved: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  }

  if (args.includes('--scorecard')) {
    // Route from the user's decision-router config (explicit selection only).
    let cfg
    let modelRef
    try {
      cfg = readUserDecisionRouterConfig()
      modelRef = resolveConfiguredRoute(cfg)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }

    const rows = []
    let totalCost = 0
    for (const scenario of SCENARIOS) {
      const r = callDecisions(modelRef, scenario.state)
      if (!r.ok) {
        rows.push({ state: scenario.state, expect: scenario.expect, got: `ERROR: ${r.raw}` })
        continue
      }
      const cost = r.data?.cost ?? 0
      totalCost += Number(cost) || 0
      rows.push({ state: scenario.state, expect: scenario.expect, got: answerChoice(r.data), cost })
    }

    const date = new Date().toISOString().slice(0, 10)
    const out = [
      `# Live J2 scorecard — ${date}`,
      '',
      `Route: \`${modelRef.providerID}/${modelRef.id}\`. Operator-run via \`opencode api\``,
      '(consented route, billed to the user). 12 scenarios; agreement between the',
      'live model and the expected pick is the metric — this measures the MODEL,',
      'unlike the offline harness that measures the plumbing.',
      '',
      '| state (truncated) | expect | live | cost |',
      '| --- | --- | --- | --- |',
      ...rows.map(
        (r) =>
          `| ${r.state.slice(0, 48)}${r.state.length > 48 ? '…' : ''} | ${r.expect} | ${r.got ?? '—'} | ${r.cost ?? '—'} |`,
      ),
      '',
      `Total cost: $${totalCost.toFixed(6)}. Honest caveat: one run is a smoke`,
      'measurement, not a calibration — a claim about model quality needs',
      'repeated runs and a bigger scenario set.',
      '',
    ].join('\n')
    const outPath = `bench/results/j2-live-scorecard-${date}.md`
    writeFileSync(outPath, out)
    console.log(`✅ live scorecard written: ${outPath} (total $${totalCost.toFixed(6)})`)
    process.exit(0)
  }

  console.error('usage: node scripts/jev-live-probe.mjs --ping | --scorecard')
  process.exit(1)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) main()
