/**
 * Gate-contract tests for the decision egress kill-switch. The consent/config
 * selection helpers and the direct-fetch runner were removed with the legacy
 * provider path; what is tested here is what the native `pantheon_jev_decide`
 * tool actually uses: the request shape, the defensive denial reader, and the
 * throw-to-deny normalization.
 */
import { strict as assert } from 'node:assert'
import {
  assertDecisionEgressPermission,
  buildDecisionEgressRequest,
  DECISION_EGRESS_ACTION,
  DECISION_EGRESS_SOURCE_PREFIX,
  isDecisionAssertionDenial,
} from '../../src/pantheon/local-decision-egress-gate.ts'

const ENDPOINT = 'pantheon-native-decisions://opencode/jev-1.13'

function testRequestShape(): void {
  const request = buildDecisionEgressRequest({
    sessionID: 'ses-egress',
    messageID: 'msg-egress',
    endpoint: ENDPOINT,
  })
  assert.equal(request.action, DECISION_EGRESS_ACTION)
  assert.deepEqual(request.resources, [ENDPOINT])
  assert.deepEqual(request.save, [])
  assert.deepEqual(request.source, {
    type: 'tool',
    id: `${DECISION_EGRESS_SOURCE_PREFIX}ses-egress:msg-egress`,
    messageID: 'msg-egress',
  })
  assert.equal(Object.hasOwn(request, 'agent'), false, 'agent is never fabricated')
  assert.equal(
    buildDecisionEgressRequest({
      sessionID: 'ses-egress',
      messageID: 'msg-egress',
      endpoint: ENDPOINT,
      agent: 'zeus',
    }).agent,
    'zeus',
  )
  for (const blank of ['', '   ']) {
    assert.equal(
      Object.hasOwn(
        buildDecisionEgressRequest({
          sessionID: 'ses-egress',
          messageID: 'msg-egress',
          endpoint: ENDPOINT,
          agent: blank,
        }),
        'agent',
      ),
      false,
      'a blank agent is omitted, not fabricated',
    )
  }
}

async function testAssertContract(): Promise<void> {
  const request = buildDecisionEgressRequest({
    sessionID: 'ses-assert',
    messageID: 'msg-assert',
    endpoint: ENDPOINT,
  })
  // Allow has no positive representation: an unruled assertion resolves
  // undefined and is treated as allow (the config gates are the authority).
  assert.equal(await assertDecisionEgressPermission(async () => undefined, request), 'allow')
  assert.equal(await assertDecisionEgressPermission(async () => null, request), 'allow')
  assert.equal(await assertDecisionEgressPermission(async () => true, request), 'allow')
  // Deny is observable: a throw, a boolean false, an enum value, or prose.
  assert.equal(
    await assertDecisionEgressPermission(async () => {
      throw new Error('Permission denied: decision.egress')
    }, request),
    'deny',
  )
  assert.equal(await assertDecisionEgressPermission(async () => false, request), 'deny')
  assert.equal(await assertDecisionEgressPermission(async () => 'deny', request), 'deny')
  assert.equal(
    await assertDecisionEgressPermission(async () => 'Permission denied: decision.egress', request),
    'deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => 'not allowed by policy', request),
    'deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => 'blocked by policy', request),
    'deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ denied: true }), request),
    'deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ status: 'denied' }), request),
    'deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(
      async () => ({ message: 'Permission denied: decision.egress' }),
      request,
    ),
    'deny',
  )
  // A negated block is not a denial.
  assert.equal(await assertDecisionEgressPermission(async () => 'not blocked', request), 'allow')
  assert.equal(
    await assertDecisionEgressPermission(
      async () => ({ status: 'allow', message: 'not blocked' }),
      request,
    ),
    'allow',
  )
  assert.equal(isDecisionAssertionDenial(null), false)
  assert.equal(isDecisionAssertionDenial('deny'), true)
  assert.equal(isDecisionAssertionDenial('Permission denied: decision.egress'), true)
  assert.equal(isDecisionAssertionDenial('not allowed by policy'), true)
  assert.equal(isDecisionAssertionDenial('blocked by policy'), true)
  assert.equal(isDecisionAssertionDenial('not blocked'), false, 'a negated block is not a denial')
  assert.equal(isDecisionAssertionDenial({ status: 'allow', message: 'not blocked' }), false)
  assert.equal(isDecisionAssertionDenial({ status: 'allow', message: 'ok' }), false)
}

testRequestShape()
await testAssertContract()

console.log('local decision egress gate tests passed')
