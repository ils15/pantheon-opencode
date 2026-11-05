/**
 * Focused tests for the native Jev tool surface: route selection, request
 * preparation, response consumption, native usage settlement, and the gate
 * chain of `pantheon_jev_decide`. All checks are offline — the host's native
 * Decisions API is a typed stub, and `globalThis.fetch` is a throwing spy on
 * the success path to prove the route never touches a transport.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DECISION_ROUTER_MODELS,
  writeUserDecisionRouterConfig,
} from '../../scripts/install/decision-router-config.mjs'
import {
  createV2JevDecisionDefinition,
  nativeJevPermissionResource,
  runJevDecision,
  type V2JevDecisionRuntime,
} from '../../src/pantheon/jev-decision-tool.ts'
import {
  checkJevEnvelope,
  consumeJevDecisionResult,
  filterNativeCapValidCandidates,
  isJevDecisionPreset,
  isNativeJevProvider,
  JEV_PRESET_ENVELOPE_KEYS,
  NATIVE_JEV_HOST_PROVIDERS,
  prepareJevDecisionRequest,
  prepareJevPresetRequest,
  resolveNativeJevRoute,
} from '../../src/pantheon/jev-decisions.ts'
import {
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from '../../src/pantheon/local-decision-budget.ts'
import {
  getVerifiedUsageEvidenceDetails,
  verifyNativeUsageForReservation,
} from '../../src/pantheon/local-decision-usage-evidence.internal.ts'
import {
  PANTHEON_AGENT_IDS,
  PANTHEON_SKILL_CATALOG,
} from '../../src/pantheon/pantheon-decision-catalog.ts'
import { createV2ToolDefinitions } from '../../src/pantheon/v2-tools.ts'

const CURRENT_PERIOD = new Date().toISOString().slice(0, 7)
const CAPS = { monthlyCapMicros: 5_000_000, perDecisionCapMicros: 1_000_000 }
const PROVIDER = 'opencode-console-jev'
const MODEL = DECISION_ROUTER_MODELS[PROVIDER][0] as string
const CATALOG = [
  { providerID: 'opencode', id: 'jev-1.13', type: 'decision' },
  { providerID: 'opencode', id: 'claude-haiku', type: 'chat' },
]
const ADMISSION_OK = () => true
const ADMISSION_DENIED = () => false

const TOOL_INPUT = {
  schemaVersion: 1,
  state: 'delegate a backend refactor with a narrow review gate',
  questions: [
    {
      type: 'choice',
      name: 'specialist',
      instructions: 'Pick one specialist or none.',
      choices: [{ value: 'hermes' }, { value: 'themis' }, { value: 'none' }],
    },
  ],
}

const HOST_RESULT = {
  answers: [
    {
      type: 'choice',
      name: 'specialist',
      choice: 'hermes',
      probabilities: [
        { value: 'hermes', probability: 0.9 },
        { value: 'none', probability: 0.1 },
      ],
      confidence: 0.9,
    },
  ],
  cost: 0.000002,
  tokens: { input: 10, output: 5 },
}

interface TestEnvironment {
  root: string
  config: string
  state: string
}

function sandbox(): TestEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-jev-decisions-'))
  return { root, config: join(root, 'config'), state: join(root, 'state') }
}

async function withEnvironment(environment: TestEnvironment, run: () => Promise<void>) {
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const
  const previous = new Map<string, string | undefined>()
  for (const key of keys) previous.set(key, process.env[key])
  process.env.HOME = environment.root
  process.env.XDG_CONFIG_HOME = environment.config
  process.env.XDG_STATE_HOME = environment.state
  try {
    await run()
  } finally {
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(environment.root, { recursive: true, force: true })
  }
}

function writeEnabledConfig({ consent = true }: { consent?: boolean } = {}): void {
  writeUserDecisionRouterConfig({
    schema_version: 2,
    enabled: true,
    selection: { mode: 'explicit', provider: PROVIDER, model: MODEL },
    egress_consent: consent,
    enabled_candidates: [{ provider: PROVIDER, model: MODEL }],
  })
}

function confirmCaps(): void {
  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
  try {
    ledger.configureUserCaps(CAPS)
    ledger.configureProviderCaps('opencode-console', CAPS)
    ledger.configureModelCaps('opencode-console', MODEL, CAPS)
    assert.equal(ledger.confirmBudgetPeriod(null, CURRENT_PERIOD).status, 'confirmed')
  } finally {
    ledger.close()
  }
}

function stubRuntime(overrides: Partial<V2JevDecisionRuntime> = {}): {
  runtime: V2JevDecisionRuntime
  decideCalls: unknown[]
  permissionRequests: Record<string, unknown>[]
} {
  const decideCalls: unknown[] = []
  const permissionRequests: Record<string, unknown>[] = []
  const runtime: V2JevDecisionRuntime = {
    listModels: async () => CATALOG,
    decide: async (request) => {
      decideCalls.push(request)
      return HOST_RESULT
    },
    permissionAssert: async (request) => {
      permissionRequests.push(request)
      return undefined
    },
    ...overrides,
  }
  return { runtime, decideCalls, permissionRequests }
}

// ─── Route selection ────────────────────────────────────────────────────

function testProviderMapping(): void {
  assert.deepEqual(NATIVE_JEV_HOST_PROVIDERS, {
    'typesafe-jev': 'typesafe-ai',
    'opencode-console-jev': 'opencode',
    'openrouter-jev': 'openrouter',
    'vercel-gateway-jev': 'vercel-ai-gateway',
    'cloudflare-workers-jev': 'cloudflare-workers-ai',
  })
  assert.equal(isNativeJevProvider('opencode-console-jev'), true)
  assert.equal(isNativeJevProvider('openrouter-jev'), true)
  assert.equal(isNativeJevProvider('vercel-gateway-jev'), true)
  assert.equal(isNativeJevProvider('cloudflare-workers-jev'), true)
  assert.equal(isNativeJevProvider('openai-decisions'), false)
  assert.equal(isNativeJevProvider('local'), false)
}

function testFilterNativeCandidates(): void {
  const candidates = [
    { provider: 'opencode-console-jev', model: 'jev-1.13' },
    { provider: 'openai-decisions', model: 'gpt-6-luna' },
    { provider: 'typesafe-jev', model: 'jev-1.14.0' },
  ]
  const valid = filterNativeCapValidCandidates(candidates, ADMISSION_OK)
  assert.deepEqual(valid, [
    { provider: 'opencode-console-jev', model: 'jev-1.13' },
    { provider: 'typesafe-jev', model: 'jev-1.14.0' },
  ])
  assert.deepEqual(filterNativeCapValidCandidates(candidates, ADMISSION_DENIED), [])
}

async function testToolEnvelopeAppliesToPresets(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    const toolContext = { sessionID: 'ses_env', messageID: 'msg_env', agent: 'zeus' }
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ mode: 'delegation', state: 'x' }, 'PRESET_INVALID', 'SCHEMA_VERSION_INVALID'],
      [
        { schemaVersion: 99, mode: 'delegation', state: 'x' },
        'PRESET_INVALID',
        'SCHEMA_VERSION_INVALID',
      ],
      [
        { schemaVersion: 1, mode: 'delegation', state: 'x', bogus: true },
        'PRESET_INVALID',
        'UNKNOWN_INPUT_KEYS',
      ],
    ]
    for (const [input, reasonCode, detail] of cases) {
      const stub = stubRuntime()
      const output = JSON.parse(await runJevDecision(input, toolContext, stub.runtime)) as {
        reasonCode: string
        detail?: string
        advisory: boolean
        effect: string
      }
      assert.equal(output.reasonCode, reasonCode, JSON.stringify(input))
      assert.equal(output.detail, detail)
      assert.equal(output.advisory, false)
      assert.equal(output.effect, 'none')
      assert.equal(stub.decideCalls.length, 0, 'no host call for a rejected envelope')
    }
  })
}

function testRouteSelection(): void {
  const enabled = {
    schema_version: 2,
    enabled: true,
    selection: { mode: 'explicit', provider: PROVIDER, model: MODEL },
    egress_consent: true,
    enabled_candidates: [{ provider: PROVIDER, model: MODEL }],
  }
  const resolved = resolveNativeJevRoute(enabled, ADMISSION_OK)
  assert.ok(resolved.ok)
  assert.deepEqual(resolved.ok ? resolved.selection.route.model : null, {
    providerID: 'opencode',
    id: 'jev-1.13',
  })
  if (resolved.ok) {
    assert.equal(resolved.selection.accountingProvider, 'opencode-console')
    assert.equal(resolved.selection.model, 'jev-1.13')
  }

  assert.equal(resolveNativeJevRoute(enabled, ADMISSION_DENIED).ok, false)
  const disabled = { ...enabled, enabled: false }
  const disabledResult = resolveNativeJevRoute(disabled, ADMISSION_OK)
  assert.deepEqual(disabledResult, { ok: false, reasonCode: 'NO_ELIGIBLE_CANDIDATE' })
  const noConsent = { ...enabled, egress_consent: false }
  assert.deepEqual(resolveNativeJevRoute(noConsent, ADMISSION_OK), {
    ok: false,
    reasonCode: 'NO_ELIGIBLE_CANDIDATE',
  })

  const openAiOnly = {
    ...enabled,
    selection: { mode: 'explicit', provider: 'openai-decisions', model: 'gpt-6-luna' },
    enabled_candidates: [{ provider: 'openai-decisions', model: 'gpt-6-luna' }],
  }
  // Direct OpenAI has no native route, so the explicit selection cannot resolve.
  assert.deepEqual(resolveNativeJevRoute(openAiOnly, ADMISSION_OK), {
    ok: false,
    reasonCode: 'NO_ELIGIBLE_CANDIDATE',
  })

  // Auto with two cap-valid native candidates refuses to guess.
  const auto = {
    ...enabled,
    selection: { mode: 'auto' },
    enabled_candidates: [
      { provider: 'opencode-console-jev', model: 'jev-1.13' },
      { provider: 'typesafe-jev', model: 'jev-1.14.0' },
    ],
  }
  assert.deepEqual(resolveNativeJevRoute(auto, ADMISSION_OK), {
    ok: false,
    reasonCode: 'NO_ELIGIBLE_CANDIDATE',
  })
  // Auto with exactly one cap-valid candidate resolves it.
  const singleAuto = { ...auto, enabled_candidates: [{ provider: PROVIDER, model: MODEL }] }
  assert.ok(resolveNativeJevRoute(singleAuto, ADMISSION_OK).ok)

  // The route does NOT consult the host chat catalog at all: decision models
  // are not chat models and never appear in model.list() (field evidence
  // 2.2.5: 561 entries, 0 jev, while the decisions API answers the same ref
  // directly). Resolution is config + admission only — empty catalog resolves.
  assert.ok(resolveNativeJevRoute(enabled, ADMISSION_OK).ok)
}

// ─── Request preparation ────────────────────────────────────────────────

function testPreparation(): void {
  const route = {
    model: { providerID: 'opencode', id: 'jev-1.13' },
    kind: 'opencode-console-jev',
    billing: 'OpenCode Console',
  }
  const prepared = prepareJevDecisionRequest(route, TOOL_INPUT)
  assert.ok(prepared.ok)
  if (prepared.ok) {
    assert.deepEqual(prepared.request.model, route.model)
    assert.deepEqual(prepared.request.input, [{ type: 'text', text: TOOL_INPUT.state }])
    assert.equal(prepared.request.questions.length, 1)
    assert.deepEqual(prepared.request.questions[0], {
      type: 'choice',
      name: 'specialist',
      instructions: 'Pick one specialist or none.',
      choices: [{ value: 'hermes' }, { value: 'themis' }, { value: 'none' }],
    })
  }

  assert.equal(prepareJevDecisionRequest(route, { ...TOOL_INPUT, state: '   ' }).ok, false)
  assert.equal(
    prepareJevDecisionRequest(route, { ...TOOL_INPUT, state: 'x'.repeat(12_001) }).ok,
    false,
  )
  assert.equal(prepareJevDecisionRequest(route, { ...TOOL_INPUT, questions: [] }).ok, false)
  // The validation bucket carries the per-cause token so an LLM caller can
  // converge on the next attempt without reading the source.
  assert.deepEqual(prepareJevDecisionRequest(route, { ...TOOL_INPUT, questions: [] }), {
    ok: false,
    reasonCode: 'QUESTIONS_INVALID',
    detail: 'QUESTION_COUNT_INVALID',
  })
  assert.deepEqual(
    prepareJevDecisionRequest(route, {
      ...TOOL_INPUT,
      questions: [
        { type: 'predicate', name: 'q1', instructions: 'yes or no', choices: [{ value: 'a' }] },
      ],
    }),
    { ok: false, reasonCode: 'QUESTIONS_INVALID', detail: 'PREDICATE_HAS_CHOICES_OR_LEVELS' },
  )
  assert.equal(prepareJevDecisionRequest(route, { state: 'a' }).ok, false)
  assert.equal(
    prepareJevDecisionRequest(route, {
      state: 'a',
      questions: [{ type: 'choice', name: 'q', instructions: 'i', choices: [{ value: 'a' }] }],
    }).ok,
    false,
    'a choice question needs at least two options',
  )
  assert.equal(
    prepareJevDecisionRequest(route, {
      state: 'a',
      questions: [
        {
          type: 'choice',
          name: 'q',
          instructions: 'i',
          choices: [{ value: 'a' }, { value: 'a' }],
        },
      ],
    }).ok,
    false,
    'duplicate option values are invalid',
  )
  assert.equal(
    prepareJevDecisionRequest(route, {
      state: 'a',
      questions: [
        {
          type: 'score',
          name: 'q',
          instructions: 'i',
          levels: [{ label: 'low' }, { label: 'low' }],
        },
      ],
    }).ok,
    false,
    'duplicate score labels are invalid',
  )
  assert.equal(
    prepareJevDecisionRequest(route, {
      state: 'a',
      questions: [
        {
          type: 'predicate',
          name: 'q',
          instructions: 'i',
          choices: [{ value: 'a' }, { value: 'b' }],
        },
      ],
    }).ok,
    false,
    'predicate questions carry no options',
  )
  assert.equal(
    prepareJevDecisionRequest(route, {
      state: 'a',
      questions: [
        { type: 'choice', name: 'q', instructions: 'i', choices: [{ value: 'a' }, { value: 'b' }] },
        { type: 'predicate', name: 'q', instructions: 'i' },
      ],
    }).ok,
    false,
    'question names must be unique',
  )
}

// ─── Presets: skill stacking and delegation ─────────────────────────────

function testPresets(): void {
  assert.equal(isJevDecisionPreset('skills'), true)
  assert.equal(isJevDecisionPreset('delegation'), true)
  assert.equal(isJevDecisionPreset('council'), false)
  const route = {
    model: { providerID: 'opencode', id: 'jev-1.13' },
    kind: 'opencode-console-jev',
    billing: 'OpenCode Console',
  }

  // Skills preset: the FULL local catalog (field report beta.15 §skills — the
  // lexical prefilter dropped the exact skill the state described; the
  // catalog is 12 entries and the choice bound is 24, so recall wins) + host
  // skills + `none`.
  const stacked = prepareJevPresetRequest(route, 'skills', {
    state: 'implement a FastAPI backend endpoint with pytest',
  })
  assert.ok(stacked.ok)
  if (stacked.ok) {
    const question = stacked.request.questions[0]
    assert.equal(question.type, 'choice')
    assert.equal(question.name === 'stack' && 'choices' in question, true)
    const choices = (question as { choices: Array<{ value: string }> }).choices
    assert.ok(choices.length >= 12 && choices.length <= 24, `catalog+none: ${choices.length}`)
    assert.ok(choices.some((option) => option.value === 'none'))
    assert.ok(
      choices.some((option) => option.value === 'codemap'),
      'every local skill is offered — no lexical prefilter',
    )
    assert.equal(stacked.candidateSource, 'full-catalog')
  }

  // No local match: the whole skill catalog is offered instead, plus `none`.
  const fallback = prepareJevPresetRequest(route, 'skills', { state: 'qwertyuiop' })
  assert.ok(fallback.ok)
  if (fallback.ok) {
    const choices = (fallback.request.questions[0] as { choices: Array<{ value: string }> }).choices
    assert.equal(choices.length, PANTHEON_SKILL_CATALOG.length + 1)
  }

  // Delegation preset: every canonical specialist except Zeus, plus `none`.
  const delegated = prepareJevPresetRequest(route, 'delegation', {
    state: 'implement a backend endpoint',
  })
  assert.ok(delegated.ok)
  if (delegated.ok) {
    const question = delegated.request.questions[0] as {
      name: string
      choices: Array<{ value: string; description?: string }>
    }
    assert.equal(question.name, 'specialist')
    assert.equal(question.choices.length, PANTHEON_AGENT_IDS.size - 1 + 1)
    // Defect 1 (field report beta.11→12): descriptions ride with the values —
    // the model cannot pick a domain it cannot see.
    const hermes = question.choices.find((option) => option.value === 'hermes')
    assert.ok(hermes?.description?.includes('FastAPI'), 'hermes carries its catalog description')
    const none = question.choices.find((option) => option.value === 'none')
    assert.ok(none?.description, 'none is described, not a bare token')
    assert.equal(
      question.choices.some((option) => option.value === 'zeus'),
      false,
    )
    assert.ok(question.choices.some((option) => option.value === 'hermes'))
  }

  // Host-installed skills extend the pool after the catalog pool, deduped,
  // bounded, with descriptions carried through; malformed entries are skipped.
  const hostSkills = [
    { id: 'docker-build-strategies', description: 'Build optimized Docker images.' },
    { id: 'tdd-with-agents', description: 'duplicate of a catalog skill' },
    { id: 'x'.repeat(65) },
    null,
    'junk',
    42,
    { id: 'no-description' },
  ]
  const merged = prepareJevPresetRequest(
    route,
    'skills',
    {
      state: 'implement a FastAPI backend endpoint with pytest',
    },
    hostSkills,
  )
  assert.ok(merged.ok)
  if (merged.ok) {
    const choices = (
      merged.request.questions[0] as { choices: Array<{ value: string; description?: string }> }
    ).choices
    const docker = choices.find((option) => option.value === 'docker-build-strategies')
    assert.ok(docker, 'an installed host skill becomes decidable')
    assert.equal(docker?.description, 'Build optimized Docker images.')
    assert.equal(
      choices.filter((option) => option.value === 'tdd-with-agents').length,
      1,
      'installed skills dedupe against the catalog',
    )
    assert.equal(
      choices.some((option) => option.value === 'x'.repeat(65)),
      false,
      'over-long ids are skipped',
    )
    assert.ok(choices.some((option) => option.value === 'no-description'))
    assert.ok(choices.length <= 24)
  }

  // Full-catalog fallback still respects the bound with many host skills.
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `host-skill-${index}` }))
  const capped = prepareJevPresetRequest(route, 'skills', { state: 'qwertyuiop' }, many)
  assert.ok(capped.ok)
  if (capped.ok) {
    const choices = (capped.request.questions[0] as { choices: Array<{ value: string }> }).choices
    assert.equal(choices.length, 24, 'bound is catalog pool + host skills up to 23 + none')
    assert.ok(choices.some((option) => option.value === 'none'))
  }

  // A preset is exclusive with explicit questions; state bounds still apply.
  assert.equal(
    prepareJevPresetRequest(route, 'skills', { state: 'x', questions: [] }).ok,
    false,
    'mode and questions are mutually exclusive',
  )
  assert.equal(prepareJevPresetRequest(route, 'skills', { state: '' }).ok, false)

  // Defect 2: the candidate path is reported, never silent.
  const stackedSource = prepareJevPresetRequest(route, 'skills', { state: 'qwertyuiop' })
  assert.ok(stackedSource.ok)
  if (stackedSource.ok) assert.equal(stackedSource.candidateSource, 'full-catalog') // always now

  // Defect 3: the envelope applies to presets at the TOOL gate (the single
  // point before any builder) — schemaVersion required, no unknown keys.
  const missing = checkJevEnvelope({ mode: 'delegation', state: 'x' }, JEV_PRESET_ENVELOPE_KEYS)
  assert.ok(!missing.ok)
  if (!missing.ok) assert.equal(missing.detail, 'SCHEMA_VERSION_INVALID')
  const bogus = checkJevEnvelope(
    { schemaVersion: 1, mode: 'delegation', state: 'x', bogus: true },
    JEV_PRESET_ENVELOPE_KEYS,
  )
  assert.ok(!bogus.ok)
  if (!bogus.ok) assert.equal(bogus.detail, 'UNKNOWN_INPUT_KEYS')
  const wrongVersion = checkJevEnvelope(
    { schemaVersion: 99, mode: 'delegation', state: 'x' },
    JEV_PRESET_ENVELOPE_KEYS,
  )
  assert.ok(!wrongVersion.ok)
  if (!wrongVersion.ok) assert.equal(wrongVersion.detail, 'SCHEMA_VERSION_INVALID')
}

// ─── Response consumption ───────────────────────────────────────────────

function testConsumption(): void {
  const request = {
    model: { providerID: 'opencode', id: 'jev-1.13' },
    input: [{ type: 'text' as const, text: 'state' }],
    questions: [
      {
        type: 'choice' as const,
        name: 'specialist',
        instructions: 'Pick one.',
        choices: [{ value: 'hermes' }, { value: 'none' }],
      },
      { type: 'predicate' as const, name: 'urgent', instructions: 'Is it urgent?' },
    ],
  }

  const advice = consumeJevDecisionResult(HOST_RESULT, request)
  assert.equal(advice.effect, 'none')
  // HOST_RESULT answers only the choice question; the predicate stays missing.
  assert.deepEqual(advice.missing, ['urgent'])
  assert.equal(advice.costUsd, 0.000002)
  assert.deepEqual(advice.tokens, { input: 10, output: 5 })
  assert.deepEqual(advice.answers[0], {
    type: 'choice',
    name: 'specialist',
    choice: 'hermes',
    confidence: 0.9,
  })

  const withPredicate = consumeJevDecisionResult(
    {
      answers: [
        {
          type: 'choice',
          name: 'specialist',
          choice: 'none',
          probabilities: [{ value: 'none', probability: 0.6 }],
          confidence: 0.6,
        },
        { type: 'predicate', name: 'urgent', probability: 0.25 },
      ],
    },
    request,
  )
  assert.equal(withPredicate.missing.length, 0)
  assert.deepEqual(withPredicate.answers[1], {
    type: 'predicate',
    name: 'urgent',
    probability: 0.25,
  })

  // A choice outside the prepared options is dropped, not passed through.
  const injected = consumeJevDecisionResult(
    {
      answers: [
        {
          type: 'choice',
          name: 'specialist',
          choice: 'zeus',
          confidence: 0.99,
        },
      ],
    },
    request,
  )
  assert.deepEqual(injected.missing, ['specialist', 'urgent'])

  // Duplicated answers are untrustworthy and surface as errors.
  const duplicated = consumeJevDecisionResult(
    {
      answers: [
        { type: 'choice', name: 'specialist', choice: 'hermes', confidence: 0.9 },
        { type: 'choice', name: 'specialist', choice: 'none', confidence: 0.1 },
      ],
    },
    request,
  )
  assert.deepEqual(duplicated.answers[0], {
    type: 'error',
    name: 'specialist',
    reason: 'DUPLICATE_ANSWER',
  })

  const errored = consumeJevDecisionResult(
    { answers: [{ type: 'error', name: 'specialist', reason: 'model_unavailable' }] },
    request,
  )
  assert.deepEqual(errored.answers[0], {
    type: 'error',
    name: 'specialist',
    reason: 'model_unavailable',
  })
  assert.deepEqual(errored.missing, ['urgent'])

  const malformed = consumeJevDecisionResult('not-an-object', request)
  assert.equal(malformed.answers.length, 0)
  assert.deepEqual(malformed.missing, ['specialist', 'urgent'])
  assert.equal(malformed.effect, 'none')
}

// ─── Native usage settlement ────────────────────────────────────────────

function testNativeEvidence(): void {
  const binding = {
    reservationId: 'res-jev-1',
    provider: 'opencode-console',
    model: 'jev-1.13',
    period: CURRENT_PERIOD,
  }
  const evidence = verifyNativeUsageForReservation(binding, HOST_RESULT)
  assert.ok(evidence, 'a valid host result with cost mints evidence')
  const details = getVerifiedUsageEvidenceDetails(evidence)
  assert.ok(details)
  assert.equal(details?.actualCostMicros, 2)
  assert.equal(details?.pricingSnapshot, 'host-reported')
  assert.equal(details?.inputTokens, 10)

  const free = verifyNativeUsageForReservation(binding, { answers: [{}] })
  assert.ok(free, 'a result without cost is a real zero')
  assert.equal(getVerifiedUsageEvidenceDetails(free)?.actualCostMicros, 0)

  assert.equal(verifyNativeUsageForReservation(binding, { answers: [] }), null)
  assert.equal(verifyNativeUsageForReservation(binding, { answers: [{}], cost: -1 }), null)
  assert.equal(verifyNativeUsageForReservation(binding, { answers: [{}], cost: '2' }), null)
  assert.equal(
    verifyNativeUsageForReservation(
      { ...binding, provider: 'openai-decisions' },
      { answers: [{}] },
    ),
    null,
    'direct OpenAI has no native route to settle',
  )
  assert.equal(verifyNativeUsageForReservation({ ...binding, model: '' }, { answers: [{}] }), null)
}

function testLedgerSettlement(): void {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-jev-ledger-'))
  const dbPath = join(root, 'budget.db')
  try {
    const ledger = openLocalDecisionBudgetLedger({ dbPath })
    try {
      ledger.configureUserCaps(CAPS)
      ledger.configureProviderCaps('opencode-console', CAPS)
      ledger.configureModelCaps('opencode-console', MODEL, CAPS)
      assert.equal(ledger.confirmBudgetPeriod(null, CURRENT_PERIOD).status, 'confirmed')

      const reservation = ledger.reserve('opencode-console', MODEL)
      assert.ok(reservation.status === 'reserved')
      const evidence = verifyNativeUsageForReservation(
        {
          reservationId: reservation.reservationId,
          provider: 'opencode-console',
          model: MODEL,
          period: reservation.period,
        },
        HOST_RESULT,
      )
      assert.ok(evidence)
      const reconciled = ledger.reconcileVerified(reservation.reservationId, evidence)
      assert.ok(reconciled.status === 'reconciled' && !reconciled.frozen)
    } finally {
      ledger.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ─── Tool gate chain ────────────────────────────────────────────────────

async function testToolGateChain(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    const toolContext = { sessionID: 'ses_jev', messageID: 'msg_jev', agent: 'zeus' }

    // Without any configuration the tool is off.
    const off = stubRuntime()
    assert.equal(await runJevDecision(TOOL_INPUT, toolContext, off.runtime), refusalOf('DISABLED'))
    assert.equal(off.decideCalls.length, 0)

    // Non-Zeus callers are refused before anything else.
    const nonZeus = stubRuntime()
    assert.equal(
      await runJevDecision(TOOL_INPUT, { ...toolContext, agent: 'apollo' }, nonZeus.runtime),
      refusalOf('CALLER_NOT_ALLOWED'),
    )
    assert.equal(nonZeus.decideCalls.length, 0)

    // Consent missing is a refusal, never a host call (checked before the ledger).
    writeEnabledConfig({ consent: false })
    const noConsent = stubRuntime()
    assert.equal(
      await runJevDecision(TOOL_INPUT, toolContext, noConsent.runtime),
      refusalOf('CONSENT_MISSING'),
    )
    assert.equal(noConsent.decideCalls.length, 0)

    // Consent and budget caps are confirmed once for the period.
    writeEnabledConfig()
    confirmCaps()

    // A deny from the host kill-switch stops the call.
    const denied = stubRuntime({ permissionAssert: async () => 'deny' })
    assert.equal(
      await runJevDecision(TOOL_INPUT, toolContext, denied.runtime),
      refusalOf('PERMISSION_DENIED'),
    )
    assert.equal(denied.decideCalls.length, 0)

    // A throwing host assertion is a deny, not a crash.
    const throwing = stubRuntime({
      permissionAssert: async () => {
        throw new Error('Permission denied: decision.egress')
      },
    })
    assert.equal(
      await runJevDecision(TOOL_INPUT, toolContext, throwing.runtime),
      refusalOf('PERMISSION_DENIED'),
    )

    // A host without the permission API cannot authorize the call.
    const noPermission = stubRuntime({ permissionAssert: undefined })
    assert.equal(
      await runJevDecision(TOOL_INPUT, toolContext, noPermission.runtime),
      refusalOf('PERMISSION_UNAVAILABLE'),
    )

    // The success path: exactly one native call, prepared request, advice out.
    const ok = stubRuntime()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('the native route must never fetch')
    }) as typeof fetch
    try {
      const output = await runJevDecision(TOOL_INPUT, toolContext, ok.runtime)
      assert.equal(ok.decideCalls.length, 1)
      assert.deepEqual(ok.permissionRequests.length, 1)
      assert.deepEqual(ok.permissionRequests[0]?.resources, [
        nativeJevPermissionResource('opencode', 'jev-1.13'),
      ])
      assert.deepEqual(ok.permissionRequests[0]?.agent, 'zeus')
      const parsed = JSON.parse(output) as {
        advisory: boolean
        effect: string
        answers: Array<{ type: string; name: string; choice?: string }>
        usage: { costUsd: number | null }
        route: { providerID: string; id: string; billing: string }
      }
      assert.equal(parsed.advisory, true)
      assert.equal(parsed.effect, 'none')
      assert.deepEqual(parsed.route, {
        providerID: 'opencode',
        id: 'jev-1.13',
        billing: 'OpenCode Console',
      })
      assert.deepEqual(parsed.answers[0]?.choice, 'hermes')
      assert.equal(parsed.usage.costUsd, 0.000002)
    } finally {
      globalThis.fetch = originalFetch
    }

    // Preset mode: one prepared catalog question, refusal for unknown modes.
    // The host skill registry extends the pool; a hostile one degrades to
    // catalog-only.
    const preset = stubRuntime()
    preset.runtime.listSkills = async () => [
      { id: 'docker-build-strategies', description: 'Build optimized Docker images.' },
      'garbage',
      { id: '' },
    ]
    const presetOutput = await runJevDecision(
      { schemaVersion: 1, state: 'implement a FastAPI endpoint with pytest', mode: 'skills' },
      toolContext,
      preset.runtime,
    )
    assert.equal(preset.decideCalls.length, 1)
    const presetRequest = preset.decideCalls[0] as {
      questions: Array<{ name: string; choices?: Array<{ value: string }> }>
    }
    assert.equal(presetRequest.questions[0]?.name, 'stack')
    assert.ok(
      presetRequest.questions[0]?.choices?.some(
        (option) => option.value === 'docker-build-strategies',
      ),
      'installed host skills are offered to the decision model',
    )
    const hostileRegistry = stubRuntime({
      listSkills: async () => {
        throw new Error('registry unavailable')
      },
    })
    assert.equal(
      await runJevDecision(
        { schemaVersion: 1, state: 'implement a FastAPI endpoint with pytest', mode: 'skills' },
        toolContext,
        hostileRegistry.runtime,
      ).then((output) => (JSON.parse(output) as { effect: string }).effect),
      'none',
      'a throwing registry degrades to the catalog-only preset',
    )
    const presetParsed = JSON.parse(presetOutput) as { preset?: string; missing: string[] }
    assert.equal(presetParsed.preset, 'skills')
    assert.deepEqual(presetParsed.missing, ['stack'])

    const unknownMode = stubRuntime()
    assert.equal(
      await runJevDecision(
        { schemaVersion: 1, state: 'x', mode: 'council' },
        toolContext,
        unknownMode.runtime,
      ),
      refusalOf('PRESET_INVALID'),
    )
    assert.equal(unknownMode.decideCalls.length, 0)

    // A failed native call leaves the reservation pending (fail-closed) and
    // surfaces only the sanitized error class plus the provider facts that
    // change what the user does next (rate_limit + retry window). The
    // message text (URLs, subscription prose) never crosses.
    const rateLimited = stubRuntime({
      decide: async () => {
        const err = new Error(
          'Free usage limit reached. subscribe to OpenCode Go: https://opencode.ai/go',
        )
        Object.assign(err, { reason: 'rate_limit', status: 429, retryAfterMs: 48152000 })
        throw err
      },
    })
    assert.deepEqual(
      JSON.parse(await runJevDecision(TOOL_INPUT, toolContext, rateLimited.runtime)),
      {
        advisory: false,
        effect: 'none',
        reasonCode: 'DECISION_CALL_FAILED',
        detail: 'Error',
        providerReason: 'rate_limit',
        status: 429,
        retryAfterMs: 48152000,
      },
    )

    // A provider error without the provider facts stays at the class alone.
    const failing = stubRuntime({
      decide: async () => {
        throw new Error('host transport failed')
      },
    })
    assert.deepEqual(JSON.parse(await runJevDecision(TOOL_INPUT, toolContext, failing.runtime)), {
      advisory: false,
      effect: 'none',
      reasonCode: 'DECISION_CALL_FAILED',
      detail: 'Error',
    })
    const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
    try {
      // Two failed calls (the rate-limited probe above and this transport
      // failure) leave two fail-closed holds — intentional, never a leak.
      assert.equal(ledger.listUncertainReservations().length, 2)
    } finally {
      ledger.close()
    }

    // An unusable response cannot settle and refuses.
    const unusable = stubRuntime({ decide: async () => ({ answers: [] }) })
    assert.equal(
      await runJevDecision(TOOL_INPUT, toolContext, unusable.runtime),
      refusalOf('USAGE_UNRECONCILED'),
    )

    // Malformed tool input is refused at the preparer.
    const badInput = stubRuntime()
    assert.equal(
      await runJevDecision(
        { schemaVersion: 1, state: '', questions: [] },
        toolContext,
        badInput.runtime,
      ),
      refusalOf('STATE_INVALID'),
    )
  })
}

function refusalOf(reasonCode: string): string {
  return JSON.stringify({ advisory: false, effect: 'none', reasonCode })
}

// ─── Registration contract ──────────────────────────────────────────────

function testRegistrationContract(): void {
  const { runtime } = stubRuntime()
  const withJev = createV2ToolDefinitions(undefined, {}, runtime)
  assert.ok(withJev.some((def) => def.name === 'pantheon_jev_decide'))
  const jevDef = withJev.find((def) => def.name === 'pantheon_jev_decide')
  assert.ok(jevDef)
  assert.equal(typeof jevDef?.input, 'object')
  assert.deepEqual(Object.keys(jevDef?.output ?? {}), [])

  const withoutJev = createV2ToolDefinitions(undefined, {}, undefined)
  assert.equal(
    withoutJev.some((def) => def.name === 'pantheon_jev_decide'),
    false,
  )

  const definition = createV2JevDecisionDefinition(runtime)
  assert.equal(definition.name, 'pantheon_jev_decide')
  const schema = definition.input as {
    required?: string[]
    properties?: Record<string, { enum?: string[] }>
    anyOf?: Array<{ required?: string[] }>
  }
  // One schema, four disjoint payloads: the state branch (presets and explicit
  // questions), the review branch (J4 delegateId + metrics + criteria), and
  // the v3.1 rank (candidates) and verify (claims) branches.
  assert.deepEqual(schema.required, ['schemaVersion'])
  assert.deepEqual(schema.properties?.mode?.enum, [
    'skills',
    'delegation',
    'review',
    'rank',
    'verify',
  ])
  const branches = (schema.anyOf ?? []).map((branch) => branch.required ?? [])
  const reviewBranch = branches.find((required) => required.includes('delegateId'))
  const stateBranch = branches.find((required) => required.includes('state'))
  const rankBranch = branches.find((required) => required.includes('candidates'))
  const verifyBranch = branches.find((required) => required.includes('claims'))
  assert.ok(reviewBranch && stateBranch, 'both payload branches are declared')
  assert.ok(rankBranch && verifyBranch, 'the v3.1 rank and verify branches are declared')
  assert.deepEqual(rankBranch, ['candidates'])
  assert.deepEqual(verifyBranch, ['claims'])
  assert.deepEqual([...reviewBranch].sort(), [
    'criteria',
    'delegateId',
    'resultMetrics',
    'resultSummaryKind',
  ])
  assert.deepEqual(stateBranch, ['state'])
}

// ─── Source-level transport invariants ──────────────────────────────────

function testTransportInvariants(): void {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
  const core = read('../../src/pantheon/jev-decisions.ts')
  assert.doesNotMatch(core, /\bfetch\s*\(|process\.env|api\.typesafe\.ai|openrouter\.ai/)
  const tool = read('../../src/pantheon/jev-decision-tool.ts')
  assert.doesNotMatch(tool, /\bfetch\s*\(|process\.env|api\.typesafe\.ai|openrouter\.ai/)
}

/** Caller matrix: allowlist flag, preset restriction, real caller audit. */
async function testCallerMatrix(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig()
    confirmCaps()
    const toolContext = (agent: string) => ({
      sessionID: 'ses_caller',
      messageID: 'msg_caller',
      agent,
    })
    const QUESTIONS_INPUT = {
      schemaVersion: 1,
      state: 'pick between two bounded options for this task',
      questions: [
        {
          type: 'choice',
          name: 'pick',
          instructions: 'pick one',
          choices: [{ value: 'a' }, { value: 'b' }],
        },
      ],
    }
    const SKILLS_INPUT = { schemaVersion: 1, mode: 'skills', state: 'pick skills' }

    // Flag off (default — no allowlist on the runtime): a specialist is
    // refused, Zeus passes.
    const refused = JSON.parse(
      await runJevDecision(QUESTIONS_INPUT, toolContext('apollo'), stubRuntime().runtime),
    )
    assert.equal(refused.reasonCode, 'CALLER_NOT_ALLOWED')

    // Allowlist via the runtime (the plugin wiring parses the flag): an
    // allowlisted specialist passes the caller gate for explicit questions,
    // the permission assertion carries the REAL caller, and the success
    // output names the caller for audit.
    {
      const allowed = stubRuntime({ specialistCallers: ['apollo', 'themis'] })
      const output = await runJevDecision(QUESTIONS_INPUT, toolContext('apollo'), allowed.runtime)
      const parsed = JSON.parse(output) as { advisory: boolean; caller?: string }
      assert.equal(parsed.advisory, true)
      assert.equal(parsed.caller, 'apollo')
      assert.deepEqual(allowed.permissionRequests[0]?.agent, 'apollo')

      // Preset modes stay orchestrator-owned even for allowlisted callers.
      const presetAttempt = JSON.parse(
        await runJevDecision(SKILLS_INPUT, toolContext('apollo'), stubRuntime().runtime),
      )
      assert.equal(presetAttempt.reasonCode, 'CALLER_NOT_ALLOWED')

      // A non-allowlisted specialist is still refused.
      const off = JSON.parse(
        await runJevDecision(QUESTIONS_INPUT, toolContext('hermes'), stubRuntime().runtime),
      )
      assert.equal(off.reasonCode, 'CALLER_NOT_ALLOWED')

      // Duplicated/invalid allowlist entries are dropped, not fatal.
      const stillAllowed = stubRuntime({ specialistCallers: ['apollo', 'apollo', '!!', 'themis'] })
      const still = JSON.parse(
        await runJevDecision(QUESTIONS_INPUT, toolContext('apollo'), stillAllowed.runtime),
      )
      assert.equal(still.advisory, true)
    }
  })
}

/** Throwing catalog/decide refusals carry the sanitized error CLASS only. */
async function testRefusalDetailIsSanitized(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig()
    confirmCaps()
    const toolContext = { sessionID: 'ses_detail', messageID: 'msg_detail', agent: 'zeus' }

    // A throwing native Decisions call carries the sanitized error CLASS; the
    // message with provider detail stays out of the refusal.
    const brokenDecide = stubRuntime({
      decide: async () => {
        throw new RangeError('route unavailable: /v1/decisions typesafe-jev')
      },
    })
    assert.deepEqual(
      JSON.parse(await runJevDecision(TOOL_INPUT, toolContext, brokenDecide.runtime)),
      { advisory: false, effect: 'none', reasonCode: 'DECISION_CALL_FAILED', detail: 'RangeError' },
    )
  })
}

testProviderMapping()
testFilterNativeCandidates()
testRouteSelection()
testPreparation()
testPresets()
testConsumption()
testNativeEvidence()
testLedgerSettlement()
await testToolGateChain()
await testToolEnvelopeAppliesToPresets()
await testRefusalDetailIsSanitized()
await testCallerMatrix()

testRegistrationContract()
testTransportInvariants()

console.log('Native Jev decisions tool: all offline checks passed')
