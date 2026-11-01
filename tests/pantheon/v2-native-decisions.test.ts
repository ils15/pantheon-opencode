import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import type { SessionPrompt } from '@opencode/plugin/promise/session'
import { applyDecisionRouterToPrompt } from '../../src/pantheon/local-decision-prompt.ts'
import {
  consumeNativeDecisionAdvice,
  evaluateNativeDecisionConsent,
  NATIVE_STOCK_DECISION_ROUTES,
  type NativeDecisionCorrelationEvidence,
  type NativeDecisionRequest,
  type NativeDecisionResponse,
  type OpenCodeV225DecisionApi,
  prepareNativeDecisionRequest,
  resolveNativeDecisionRoute,
  validateNativeDecisionCorrelation,
} from '../../src/pantheon/v2-native-decisions.ts'

const modelCatalog = [
  { providerID: 'opencode', id: 'jev-1.13', type: 'decision' },
  { providerID: 'openrouter', id: 'typesafe/jev-1.13', type: 'decision' },
  { providerID: 'typesafe-ai', id: 'jev-latest', type: 'decision' },
  { providerID: 'anthropic', id: 'claude-sonnet', type: 'chat' },
] as unknown as Parameters<typeof resolveNativeDecisionRoute>[2]

const packageManifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { devDependencies?: Record<string, string> }
assert.equal(packageManifest.devDependencies?.['@opencode/plugin'], '2.2.5')

const event = {
  sessionID: 'ses_current',
  messageID: 'msg_current',
  prompt: { text: 'Implement a Python API endpoint.', files: [] },
  metadata: { ignored: 'not part of native input' },
  delivery: 'steer',
} as unknown as SessionPrompt

const clearCorrelation: NativeDecisionCorrelationEvidence = {
  sessionID: event.sessionID,
  messageID: event.messageID,
  currentMessageID: event.messageID,
  delivery: 'steer',
  pendingMessageIDs: [event.messageID],
  activeMessageID: null,
  continuation: false,
}

function stockRoute() {
  const resolution = resolveNativeDecisionRoute(
    { providerID: 'opencode', id: 'jev-1.13' },
    undefined,
    modelCatalog,
  )
  assert.equal(resolution.ok, true)
  if (!resolution.ok) throw new Error('expected stock route')
  return resolution.route
}

assert.deepEqual(
  NATIVE_STOCK_DECISION_ROUTES.map(({ providerID, id }) => ({ providerID, id })),
  [
    { providerID: 'opencode', id: 'jev-1.13' },
    { providerID: 'openrouter', id: 'typesafe/jev-1.13' },
  ],
)

function testRouteResolution(): void {
  const openrouter = resolveNativeDecisionRoute(
    { providerID: 'openrouter', id: 'typesafe/jev-1.13' },
    undefined,
    modelCatalog,
  )
  assert.equal(openrouter.ok, true)
  if (openrouter.ok) {
    assert.equal(openrouter.route.kind, 'openrouter-jev')
    assert.equal(openrouter.route.billing, 'OpenRouter')
  }

  const auto = resolveNativeDecisionRoute(
    'auto',
    { providerID: 'opencode', id: 'jev-1.13' },
    modelCatalog,
  )
  assert.equal(auto.ok, true)
  if (auto.ok) assert.deepEqual(auto.route.model, { providerID: 'opencode', id: 'jev-1.13' })

  assert.deepEqual(
    resolveNativeDecisionRoute(
      'auto',
      { providerID: 'anthropic', id: 'claude-sonnet' },
      modelCatalog,
    ),
    { ok: false, reasonCode: 'MODEL_NOT_DECISION' },
  )
  assert.deepEqual(resolveNativeDecisionRoute('auto', undefined, modelCatalog), {
    ok: false,
    reasonCode: 'AUTO_MODEL_UNAVAILABLE',
  })
  assert.deepEqual(
    resolveNativeDecisionRoute('auto', { providerID: 'openai', id: 'gpt-decisions' }, [
      ...modelCatalog,
      { providerID: 'openai', id: 'gpt-decisions', type: 'decision' },
    ] as unknown as Parameters<typeof resolveNativeDecisionRoute>[2]),
    { ok: false, reasonCode: 'DIRECT_OPENAI_UNSUPPORTED' },
  )
  const typeSafe = resolveNativeDecisionRoute(
    { providerID: 'typesafe-ai', id: 'jev-latest' },
    undefined,
    modelCatalog,
  )
  assert.equal(typeSafe.ok, true)
  if (typeSafe.ok) assert.equal(typeSafe.route.kind, 'custom-decision')
  assert.deepEqual(
    resolveNativeDecisionRoute('auto', { providerID: 'opencode', id: 'jev-1.13' }, [
      ...modelCatalog,
      { providerID: 'opencode', id: 'jev-1.13', type: 'decision' },
    ] as unknown as Parameters<typeof resolveNativeDecisionRoute>[2]),
    { ok: false, reasonCode: 'AMBIGUOUS_MODEL' },
  )
}

function testConsent(): void {
  const route = stockRoute()
  assert.deepEqual(evaluateNativeDecisionConsent(route), {
    allowed: false,
    reasonCode: 'CONSENT_MISSING',
  })
  assert.deepEqual(
    evaluateNativeDecisionConsent(route, [
      { providerID: 'openrouter', modelID: 'jev-1.13', enabled: true },
    ]),
    { allowed: false, reasonCode: 'CONSENT_MISSING' },
  )
  assert.deepEqual(
    evaluateNativeDecisionConsent(route, [
      { providerID: route.model.providerID, modelID: route.model.id, enabled: false },
    ]),
    { allowed: false, reasonCode: 'CONSENT_DISABLED' },
  )
  assert.deepEqual(
    evaluateNativeDecisionConsent(route, [
      { providerID: route.model.providerID, modelID: route.model.id, enabled: true },
      { providerID: route.model.providerID, modelID: route.model.id, enabled: true },
    ]),
    { allowed: false, reasonCode: 'CONSENT_AMBIGUOUS' },
  )
}

function testCorrelation(): void {
  assert.equal(validateNativeDecisionCorrelation(event, undefined), 'CORRELATION_UNAVAILABLE')
  assert.equal(
    validateNativeDecisionCorrelation(event, { ...clearCorrelation, delivery: 'queue' }),
    'QUEUED_TURN',
  )
  assert.equal(
    validateNativeDecisionCorrelation(event, {
      ...clearCorrelation,
      currentMessageID: 'msg_other',
    }),
    'CORRELATION_MISMATCH',
  )
  assert.equal(
    validateNativeDecisionCorrelation(event, {
      ...clearCorrelation,
      pendingMessageIDs: [event.messageID, 'msg_next'],
    }),
    'CONCURRENT_TURN',
  )
  assert.equal(
    validateNativeDecisionCorrelation(event, {
      ...clearCorrelation,
      activeMessageID: 'msg_active',
    }),
    'CONCURRENT_TURN',
  )
  assert.equal(
    validateNativeDecisionCorrelation(event, { ...clearCorrelation, continuation: true }),
    'CONTINUATION_TURN',
  )
  assert.equal(
    validateNativeDecisionCorrelation(event, {
      ...clearCorrelation,
      pendingMessageIDs: null,
    } as unknown as NativeDecisionCorrelationEvidence),
    'CORRELATION_UNAVAILABLE',
  )
  assert.equal(
    validateNativeDecisionCorrelation({ ...event, sessionID: '   ' } as unknown as SessionPrompt, {
      ...clearCorrelation,
      sessionID: '   ',
    }),
    'CORRELATION_MISMATCH',
    'matching whitespace-only session IDs must not correlate',
  )
  assert.equal(
    validateNativeDecisionCorrelation({ ...event, messageID: '' } as unknown as SessionPrompt, {
      ...clearCorrelation,
      messageID: '',
      currentMessageID: '',
      pendingMessageIDs: [''],
    }),
    'CORRELATION_MISMATCH',
    'matching empty message IDs must not correlate',
  )
  assert.equal(
    validateNativeDecisionCorrelation(event, { ...clearCorrelation, sessionID: '  ' }),
    'CORRELATION_UNAVAILABLE',
    'blank evidence IDs are unavailable even when the event ID is valid',
  )
  assert.equal(validateNativeDecisionCorrelation(event, clearCorrelation), null)
}

function testRequestPreparation(): void {
  const route = stockRoute()
  const consent = [{ providerID: route.model.providerID, modelID: route.model.id, enabled: true }]
  assert.deepEqual(prepareNativeDecisionRequest(route, event, ['hermes', 'aphrodite'], consent), {
    ok: false,
    reasonCode: 'CORRELATION_UNAVAILABLE',
  })

  const prepared = prepareNativeDecisionRequest(
    route,
    event,
    ['hermes', 'aphrodite'],
    consent,
    clearCorrelation,
  )
  assert.equal(prepared.ok, true)
  if (!prepared.ok) throw new Error('expected a prepared request')
  assert.deepEqual(prepared.request.input, [{ type: 'text', text: event.prompt.text }])
  assert.deepEqual(Object.keys(prepared.request.input[0] ?? {}).sort(), ['text', 'type'])
  assert.deepEqual(prepared.request.questions[0], {
    type: 'choice',
    name: 'specialist',
    instructions:
      'Choose one listed specialist only when the current request clearly needs it; otherwise choose none. This is advisory only.',
    choices: [{ value: 'hermes' }, { value: 'aphrodite' }, { value: 'none' }],
  })
  assert.doesNotMatch(
    JSON.stringify(prepared.request),
    /ignored|metadata|tools|system|files|path|description/i,
  )

  const withFile = {
    ...event,
    prompt: { ...event.prompt, files: [{ uri: 'file:///private/path.txt' }] },
  } as unknown as SessionPrompt
  assert.deepEqual(
    prepareNativeDecisionRequest(route, withFile, ['hermes'], consent, clearCorrelation),
    { ok: false, reasonCode: 'FILES_NOT_ALLOWED' },
  )
  assert.deepEqual(
    prepareNativeDecisionRequest(route, event, ['zeus'], consent, clearCorrelation),
    { ok: false, reasonCode: 'INVALID_CANDIDATES' },
  )
}

async function testMockV225Host(): Promise<void> {
  // This mock is typed against @opencode/plugin@2.2.5's actual Context API.
  let received: NativeDecisionRequest | undefined
  const mockV225Host: OpenCodeV225DecisionApi = {
    decisions: async (input) => {
      received = input
      return {
        answers: [
          {
            type: 'choice',
            name: 'specialist',
            choice: 'hermes',
            probabilities: [],
            confidence: 0.94,
          },
        ],
      } satisfies NativeDecisionResponse
    },
  }

  const route = stockRoute()
  const prepared = prepareNativeDecisionRequest(
    route,
    event,
    ['hermes'],
    [{ providerID: route.model.providerID, modelID: route.model.id, enabled: true }],
    clearCorrelation,
  )
  assert.equal(prepared.ok, true)
  if (!prepared.ok) throw new Error('expected a prepared request')
  const response = await mockV225Host.decisions(prepared.request)
  assert.deepEqual(received, prepared.request)
  assert.deepEqual(consumeNativeDecisionAdvice(response, ['hermes']), {
    agent: 'hermes',
    reasonCode: 'RECOMMENDED',
    effect: 'none',
  })
  assert.deepEqual(consumeNativeDecisionAdvice(response, ['aphrodite']), {
    agent: null,
    reasonCode: 'INVALID_RESPONSE',
    effect: 'none',
  })
  assert.deepEqual(
    consumeNativeDecisionAdvice(
      { answers: [{ type: 'choice', name: 'specialist', choice: 'zeus', confidence: 0.94 }] },
      ['zeus'],
    ),
    { agent: null, reasonCode: 'INVALID_RESPONSE', effect: 'none' },
  )
}

async function testProductionRemainsOff(): Promise<void> {
  const admission = { prompt: { text: 'Do not mutate this prompt.', skills: ['simplify'] } }
  const before = structuredClone(admission)
  assert.deepEqual(await applyDecisionRouterToPrompt(admission), {
    markerApplied: false,
    skillsFiltered: false,
    skillsSource: 'none',
    reason: 'decision.inactive',
  })
  assert.deepEqual(admission, before)

  const pluginSource = readFileSync(new URL('../../src/plugin-v2.ts', import.meta.url), 'utf8')
  const nativeSource = readFileSync(
    new URL('../../src/pantheon/v2-native-decisions.ts', import.meta.url),
    'utf8',
  )
  const promptSource = readFileSync(
    new URL('../../src/pantheon/local-decision-prompt.ts', import.meta.url),
    'utf8',
  )
  const toolSource = readFileSync(
    new URL('../../src/pantheon/jev-decision-tool.ts', import.meta.url),
    'utf8',
  )
  // The prompt hook stays local-only: no provider runner, and the native API
  // appears in the plugin ONLY as the tool's feature-detect, never as a
  // prompt-path call.
  assert.doesNotMatch(pluginSource, /runProviderDecision/)
  assert.match(pluginSource, /typeof decisionsFn === 'function'/)
  // The prompt-hook admission path itself stays local-only: within the call's
  // neighborhood there is no native API or feature-detect reference.
  const callSite = pluginSource.indexOf('applyDecisionRouterToPrompt(admission')
  assert.ok(callSite > 0, 'the prompt hook still applies the advisory router')
  const promptHookRegion = pluginSource.slice(callSite, callSite + 400)
  assert.doesNotMatch(promptHookRegion, /decisionsFn|experimental/)
  assert.doesNotMatch(nativeSource, /\bfetch\s*\(|process\.env/)
  assert.match(promptSource, /decideLocalForTurn/)
  assert.doesNotMatch(promptSource, /\bdecideForTurn\b|runProviderDecision|globalThis\.fetch/)
  // The explicit tool surface carries no transport of its own.
  assert.doesNotMatch(toolSource, /\bfetch\s*\(|api\.typesafe\.ai|openrouter\.ai/)
}

testRouteResolution()
testConsent()
testCorrelation()
testRequestPreparation()
await testMockV225Host()
await testProductionRemainsOff()

console.log('V2.2.5 native Decisions scaffolding: all offline checks passed')
