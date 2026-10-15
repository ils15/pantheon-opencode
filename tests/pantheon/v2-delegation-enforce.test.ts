import { strict as assert } from 'node:assert'
import {
  evaluateV2Delegation,
  V2SubagentOriginRegistry,
} from '../../src/pantheon/v2-delegation-enforce.ts'

const agents = [
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
]

function event(sessionID: string, target: string, callerAgent?: string) {
  return {
    sessionID,
    action: 'subagent',
    resources: [target],
    source: { type: 'tool', messageID: 'message-1', id: 'call-1' },
    ...(callerAgent ? { agent: callerAgent } : {}),
  }
}

function resourcesEvent(sessionID: string, resources: unknown[], callerAgent?: string) {
  return { sessionID, resources, ...(callerAgent ? { agent: callerAgent } : {}) }
}

function session(id: string, agent: string, parentID?: string) {
  return { id, agent, ...(parentID ? { parentID } : {}) }
}

function origin(sessionID: string, caller: string, target: string) {
  return { sessionID, messageID: 'message-1', callID: 'call-1', caller, target }
}

const cases: Array<{ caller: string; target: string; allowed: boolean }> = [
  ...agents.map((target) => ({ caller: 'zeus', target, allowed: true })),
  { caller: 'athena', target: 'apollo', allowed: true },
  { caller: 'hermes', target: 'apollo', allowed: true },
  ...agents
    .filter((target) => target !== 'apollo')
    .flatMap((target) => [
      { caller: 'athena', target, allowed: false },
      { caller: 'hermes', target, allowed: false },
    ]),
  ...agents
    .filter((caller) => !['zeus', 'athena', 'hermes'].includes(caller))
    .flatMap((caller) => agents.map((target) => ({ caller, target, allowed: false }))),
]

for (const { caller, target, allowed } of cases) {
  const expected = allowed ? 'allow' : 'deny'
  assert.equal(
    evaluateV2Delegation(
      event('root', target),
      session('root', caller),
      undefined,
      origin('root', caller, target),
    ),
    expected,
    `${caller} → ${target}`,
  )
}

assert.equal(
  evaluateV2Delegation(
    event('child', 'apollo'),
    session('child', 'zeus', 'root'),
    undefined,
    origin('child', 'zeus', 'apollo'),
  ),
  'deny',
  'a Pantheon child session cannot delegate even when the matrix edge is otherwise allowed',
)
assert.equal(
  evaluateV2Delegation(
    event('root', 'apollo'),
    session('root', 'zeus'),
    undefined,
    origin('root', 'zeus', 'apollo'),
  ),
  'allow',
  'a root session (no parentID) may delegate according to the matrix',
)
assert.equal(
  evaluateV2Delegation(
    event('root', 'apollo'),
    { id: 'root', parentID: '' },
    undefined,
    origin('root', 'zeus', 'apollo'),
  ),
  'deny',
  'a present but empty parentID is malformed and cannot prove a root session',
)
assert.equal(
  evaluateV2Delegation(
    event('root', 'apollo'),
    undefined,
    undefined,
    origin('root', 'zeus', 'apollo'),
  ),
  'deny',
  'missing session denies',
)
assert.equal(
  evaluateV2Delegation(
    event('root', 'apollo', 'hermes'),
    session('root', 'athena'),
    undefined,
    origin('root', 'athena', 'apollo'),
  ),
  'deny',
  'event identity cannot forge the authoritative session agent',
)
assert.equal(
  evaluateV2Delegation(
    event('other', 'apollo'),
    session('root', 'zeus'),
    undefined,
    origin('root', 'zeus', 'apollo'),
  ),
  'deny',
  'session id mismatch denies',
)
assert.equal(
  evaluateV2Delegation(
    event('root', 'apollo'),
    session('root', 'custom-agent'),
    undefined,
    origin('root', 'custom-agent', 'apollo'),
  ),
  'deny',
  'an unrecognized caller cannot target Pantheon agents',
)
assert.equal(
  evaluateV2Delegation({ sessionID: 'root', resources: [] }, session('root', 'zeus')),
  'deny',
  'missing target is invalid',
)
assert.equal(
  evaluateV2Delegation({ sessionID: 'root', resources: [42] }, session('root', 'zeus')),
  'deny',
  'non-string target is invalid',
)
assert.equal(
  evaluateV2Delegation(event('root', 'explore'), session('root', 'build')),
  'passthrough',
  'native-to-native permission remains owned by the host',
)
assert.equal(
  evaluateV2Delegation(event('root', 'explore'), undefined),
  'passthrough',
  'native targets preserve host policy without requiring Pantheon identity',
)
assert.equal(
  evaluateV2Delegation(
    resourcesEvent('root', ['explore', 'demeter']),
    session('root', 'athena'),
    undefined,
    origin('root', 'athena', 'demeter'),
  ),
  'deny',
  'native-first mixed resources cannot bypass Pantheon enforcement',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', ['apollo', 'explore']), session('root', 'athena')),
  'deny',
  'mixed resources do not match a single native subagent dispatch',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', ['demeter', 'explore']), session('root', 'athena')),
  'deny',
  'mixed resources are denied when their Pantheon target is not allowed',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', ['apollo', 'hermes']), session('root', 'zeus')),
  'deny',
  'multiple Pantheon targets do not match a single native subagent dispatch',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', ['apollo', 'hermes']), session('root', 'athena')),
  'deny',
  'a partially allowed multi-Pantheon request is denied',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', [{ target: 'apollo' }]), session('root', 'athena')),
  'deny',
  'host resource entries carrying an explicit target are enforced',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', ['explore', null]), session('root', 'zeus')),
  'deny',
  'unknown resource entries fail closed',
)
assert.equal(
  evaluateV2Delegation(event('root', 'apollo'), session('root', 'zeus'), 'deny'),
  'preserve-deny',
  'an explicit host deny is final',
)

const askPermissionEvent = { ...event('root', 'apollo', 'zeus'), effect: 'ask' }
assert.equal(
  evaluateV2Delegation(
    askPermissionEvent,
    session('root', 'zeus'),
    'ask',
    origin('root', 'zeus', 'apollo'),
  ),
  'allow',
  'a matrix-allowed request does not turn an existing host ask into a grant',
)
assert.equal(askPermissionEvent.effect, 'ask', 'Pantheon leaves the host ask effect unchanged')

let bodyRuns = 0
const decision = evaluateV2Delegation(
  event('root', 'demeter'),
  session('root', 'athena'),
  undefined,
  origin('root', 'athena', 'demeter'),
)
if (decision !== 'allow' && decision !== 'passthrough') bodyRuns += 0
else bodyRuns += 1
assert.equal(bodyRuns, 0, 'a denied delegation never runs its body')

const registry = new V2SubagentOriginRegistry()
const captured = registry.capture(
  {
    tool: 'subagent',
    sessionID: 'root',
    messageID: 'message-1',
    id: 'call-1',
    agent: 'Zeus',
    input: { agent: 'Apollo' },
  },
  100,
)
assert.deepEqual(captured, origin('root', 'zeus', 'apollo'))
const correlatedEvent = event('root', 'apollo', 'zeus')
assert.deepEqual(registry.consume(correlatedEvent, 101), captured)
assert.equal(
  registry.consume(correlatedEvent, 102),
  undefined,
  'an origin can be consumed only once',
)

registry.capture(
  {
    tool: 'subagent',
    sessionID: 'root',
    messageID: 'message-2',
    id: 'call-2',
    agent: 'zeus',
    input: { agent: 'apollo' },
  },
  100,
)
assert.equal(
  registry.consume(
    {
      ...event('root', 'apollo', 'zeus'),
      source: { type: 'tool', messageID: 'forged', id: 'call-2' },
    },
    101,
  ),
  undefined,
  'caller-supplied source cannot consume a different host tool event',
)

registry.capture(
  {
    tool: 'subagent',
    sessionID: 'root',
    messageID: 'message-3',
    id: 'call-3',
    agent: 'zeus',
    input: { agent: 'apollo' },
  },
  100,
)
assert.equal(
  registry.consume(
    {
      ...event('root', 'apollo', 'zeus'),
      source: { type: 'tool', messageID: 'message-3', id: 'call-3' },
    },
    60_101,
  ),
  undefined,
  'expired host tool origins are rejected',
)

const noOriginDecision = evaluateV2Delegation(
  event('root', 'apollo', 'zeus'),
  session('root', 'zeus'),
)
assert.equal(noOriginDecision, 'deny', 'a Pantheon target requires a matched host tool event')

const forgedActionDecision = evaluateV2Delegation(
  { ...event('root', 'apollo', 'zeus'), action: 'shell' },
  session('root', 'zeus'),
  undefined,
  origin('root', 'zeus', 'apollo'),
)
assert.equal(forgedActionDecision, 'deny', 'only native subagent permission can enter the matrix')

const mismatchedTargetDecision = evaluateV2Delegation(
  event('root', 'apollo', 'zeus'),
  session('root', 'zeus'),
  undefined,
  origin('root', 'zeus', 'demeter'),
)
assert.equal(mismatchedTargetDecision, 'deny', 'permission target must match the host tool input')

const mismatchedSourceDecision = evaluateV2Delegation(
  {
    ...event('root', 'apollo', 'zeus'),
    source: { type: 'tool', messageID: 'message-forged', id: 'call-forged' },
  },
  session('root', 'zeus'),
  undefined,
  origin('root', 'zeus', 'apollo'),
)
assert.equal(
  mismatchedSourceDecision,
  'deny',
  'permission source must match the captured tool call',
)

assert.equal(
  registry.capture({
    tool: 'read',
    sessionID: 'root',
    messageID: 'message-4',
    id: 'call-4',
    agent: 'zeus',
    input: { agent: 'apollo' },
  }),
  undefined,
  'only the host subagent tool can produce a delegation origin',
)
assert.equal(
  registry.capture({
    tool: 'subagent',
    sessionID: 'root',
    messageID: 'message-5',
    id: 'call-5',
    agent: 'zeus',
    input: { agent: 'explore' },
  }),
  undefined,
  'native target calls do not enter the Pantheon origin registry',
)

registry.capture(
  {
    tool: 'subagent',
    sessionID: 'root',
    messageID: 'message-6',
    id: 'call-6',
    agent: 'zeus',
    input: { agent: 'apollo' },
  },
  100,
)
registry.forget({
  tool: 'subagent',
  sessionID: 'root',
  messageID: 'message-6',
  id: 'call-6',
})
assert.equal(
  registry.consume({
    ...event('root', 'apollo', 'zeus'),
    source: { type: 'tool', messageID: 'message-6', id: 'call-6' },
  }),
  undefined,
  'execute.after clears a captured origin when permission.evaluate did not consume it',
)

const boundedRegistry = new V2SubagentOriginRegistry()
for (let index = 0; index < 256; index += 1) {
  assert.ok(
    boundedRegistry.capture({
      tool: 'subagent',
      sessionID: 'capacity-root',
      messageID: `capacity-message-${index}`,
      id: `capacity-call-${index}`,
      agent: 'zeus',
      input: { agent: 'apollo' },
    }),
    `origin ${index} fits within the registry capacity`,
  )
}
assert.equal(
  boundedRegistry.capture({
    tool: 'subagent',
    sessionID: 'capacity-root',
    messageID: 'capacity-message-overflow',
    id: 'capacity-call-overflow',
    agent: 'zeus',
    input: { agent: 'apollo' },
  }),
  undefined,
  'the origin registry refuses entries beyond its bounded capacity',
)

console.log(`V2 delegation enforcement: ${cases.length + 281} checks passed`)
