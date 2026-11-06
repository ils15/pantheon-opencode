import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  approvalInputHash,
  hasApproval,
  hashFromMarker,
  isAffirmativeAnswer,
  J1_APPROVAL_TTL_MS,
  j1ApprovalMarker,
  mintApproval,
  resetApprovals,
} from '../../src/pantheon/j1-approvals.ts'

test('marker: prefix + first 12 hash chars, round-trips', () => {
  const hash = approvalInputHash({ command: 'curl -s https://x' })
  assert.equal(hash.length, 64)
  const marker = j1ApprovalMarker(hash)
  assert.match(marker, /^j1-approval-[0-9a-f]{12}$/)
  assert.equal(hashFromMarker(marker), hash.slice(0, 12))
  assert.equal(hashFromMarker('j1-approval-zzz'), null)
  assert.equal(hashFromMarker('other-question'), null)
})

test('hash-pinned: approving one call never approves a different one', () => {
  resetApprovals()
  const a = approvalInputHash({ command: 'ls -la' })
  const b = approvalInputHash({ command: 'ls -la ' }) // one trailing space differs
  mintApproval('ses_1', a)
  assert.equal(hasApproval('ses_1', a), true)
  assert.equal(hasApproval('ses_1', b), false, 'near-identical input is NOT approved')
})

test('session-scoped and TTL-bounded (fail-closed on expiry)', () => {
  resetApprovals()
  const hash = approvalInputHash('rm -rf /tmp/scratch')
  mintApproval('ses_2', hash, 1_000)
  assert.equal(hasApproval('ses_3', hash, 1_000), false, 'another session gains nothing')
  assert.equal(hasApproval('ses_2', hash, 1_000 + J1_APPROVAL_TTL_MS - 1), true, 'inside TTL')
  assert.equal(hasApproval('ses_2', hash, 1_000 + J1_APPROVAL_TTL_MS + 1), false, 'expired')
})

test('affirmative answer detection: marker-bound, token-gated', () => {
  const hash = approvalInputHash('curl')
  const marker = j1ApprovalMarker(hash)
  assert.equal(isAffirmativeAnswer(marker, `{"text":"Aprovado? [${marker}] resposta: sim"}`), true)
  assert.equal(isAffirmativeAnswer(marker, `{"text":"[${marker}] resposta: não"`), false)
  assert.equal(
    isAffirmativeAnswer(marker, '{"text":"sim, pode seguir"}'),
    false,
    'no marker, no mint',
  )
  assert.equal(isAffirmativeAnswer(marker, `{"text":"[${marker}] aprovar"`), true)
})

test('bounded memory: oldest evicted beyond the per-session cap', () => {
  resetApprovals()
  for (let i = 0; i < 70; i += 1) {
    mintApproval('ses_bulk', approvalInputHash(`cmd-${i}`), 2_000 + i)
  }
  // The oldest (cmd-0..5) were evicted; recent ones live.
  assert.equal(hasApproval('ses_bulk', approvalInputHash('cmd-0'), 2_100), false)
  assert.equal(hasApproval('ses_bulk', approvalInputHash('cmd-69'), 2_100), true)
})

test('empty ids mint nothing (defensive)', () => {
  resetApprovals()
  mintApproval('', approvalInputHash('x'))
  mintApproval('ses_x', '')
  assert.equal(hasApproval('', approvalInputHash('x')), false)
  assert.equal(hasApproval('ses_x', ''), false)
})
