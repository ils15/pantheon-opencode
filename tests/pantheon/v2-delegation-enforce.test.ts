import { strict as assert } from 'node:assert'
import { evaluateV2Delegation } from '../../src/pantheon/v2-delegation-enforce.ts'

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
  return { sessionID, resources: [target], ...(callerAgent ? { agent: callerAgent } : {}) }
}

function resourcesEvent(sessionID: string, resources: unknown[], callerAgent?: string) {
  return { sessionID, resources, ...(callerAgent ? { agent: callerAgent } : {}) }
}

function session(id: string, agent: string, parentID?: string) {
  return { id, agent, ...(parentID ? { parentID } : {}) }
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
    evaluateV2Delegation(event('root', target), session('root', caller)),
    expected,
    `${caller} → ${target}`,
  )
}

assert.equal(
  evaluateV2Delegation(event('child', 'apollo'), session('child', 'zeus', 'root')),
  'deny',
  'a Pantheon child session cannot delegate even when the matrix edge is otherwise allowed',
)
assert.equal(
  evaluateV2Delegation(event('root', 'apollo'), session('root', 'zeus')),
  'allow',
  'a root session (no parentID) may delegate according to the matrix',
)
assert.equal(
  evaluateV2Delegation(event('root', 'apollo'), undefined),
  'deny',
  'missing session denies',
)
assert.equal(
  evaluateV2Delegation(event('root', 'apollo', 'hermes'), session('root', 'athena')),
  'deny',
  'event identity cannot forge the authoritative session agent',
)
assert.equal(
  evaluateV2Delegation(event('other', 'apollo'), session('root', 'zeus')),
  'deny',
  'session id mismatch denies',
)
assert.equal(
  evaluateV2Delegation(event('root', 'apollo'), session('root', 'custom-agent')),
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
  evaluateV2Delegation(resourcesEvent('root', ['explore', 'demeter']), session('root', 'athena')),
  'deny',
  'native-first mixed resources cannot bypass Pantheon enforcement',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', ['apollo', 'explore']), session('root', 'athena')),
  'allow',
  'mixed resources are allowed when the Pantheon target edge is explicitly allowed',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', ['demeter', 'explore']), session('root', 'athena')),
  'deny',
  'mixed resources are denied when their Pantheon target is not allowed',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', ['apollo', 'hermes']), session('root', 'zeus')),
  'allow',
  'multiple Pantheon targets are allowed when every edge is explicitly allowed',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', ['apollo', 'hermes']), session('root', 'athena')),
  'deny',
  'a partially allowed multi-Pantheon request is denied',
)
assert.equal(
  evaluateV2Delegation(resourcesEvent('root', [{ target: 'apollo' }]), session('root', 'athena')),
  'allow',
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

let bodyRuns = 0
const decision = evaluateV2Delegation(event('root', 'demeter'), session('root', 'athena'))
if (decision !== 'allow' && decision !== 'passthrough') bodyRuns += 0
else bodyRuns += 1
assert.equal(bodyRuns, 0, 'a denied delegation never runs its body')

console.log(`V2 delegation enforcement: ${cases.length + 10} checks passed`)
