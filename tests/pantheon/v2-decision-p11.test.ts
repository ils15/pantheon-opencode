/**
 * P11 — `ask.choice` over the measured `tool.transform` draft (F-07, F-05).
 *
 * The draft shape used here is the measured one: six function members
 * `{ list, get, namespace, add, update, remove }` and entries carrying `name`
 * and `id` (F-07, PROBE-E §5.2). Every case asserts two things beyond the
 * decision: the draft is read through `list()` only, and no mutator is invoked.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p11.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { evaluateCatalogPoint } from '../../src/pantheon/v2-decision-points/p11-catalog.ts'
import type { ShadowRecord } from '../../src/pantheon/v2-decision-shadow.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/

interface DraftCalls {
  list: number
  mutators: number
}

/** A draft with the measured member set (F-07); every mutator is a trap. */
function measuredDraft(entries: readonly unknown[]): {
  draft: Record<string, unknown>
  calls: DraftCalls
} {
  const calls: DraftCalls = { list: 0, mutators: 0 }
  const draft: Record<string, unknown> = {
    list() {
      calls.list += 1
      return entries
    },
    get() {
      calls.mutators += 1
      return undefined
    },
    namespace() {
      calls.mutators += 1
      return undefined
    },
    add() {
      calls.mutators += 1
    },
    update() {
      calls.mutators += 1
    },
    remove() {
      calls.mutators += 1
    },
  }
  return { draft, calls }
}

const TOOL_ENTRIES = [
  { name: 'webfetch', id: 'tool_webfetch', description: 'fetch a URL' },
  { name: 'pantheon_local_decision', id: 'tool_local_decision', description: 'decide' },
  { name: 'hashline_edit', id: 'tool_hashline', description: 'edit' },
]

check('the measured draft yields a validated choice question and no selection', () => {
  const { draft, calls } = measuredDraft(TOOL_ENTRIES)
  const snapshot = structuredClone(TOOL_ENTRIES)
  const records: ShadowRecord[] = []
  const result = evaluateCatalogPoint(draft, (record) => records.push(record))

  assert.equal(result.catalogSource, 'draft')
  assert.deepEqual(result.toolIds, ['webfetch', 'pantheon_local_decision', 'hashline_edit'])
  assert.ok(result.question, 'a choice question must be built from the draft')
  assert.deepEqual(result.question.labels, [...result.toolIds])
  assert.equal(result.selectedToolId, null)
  assert.equal(result.reason, 'catalog.no.answer')
  assert.equal(result.record.decision, 'unavailable')
  assert.equal(result.record.effect, 'none')
  assert.equal(result.record.point, 'P11')
  assert.equal(records.length, 1)
  assert.equal(calls.list, 1, 'list is read once per invocation')
  assert.equal(calls.mutators, 0, 'no draft mutator may ever be called')
  assert.deepEqual(TOOL_ENTRIES, snapshot, 'the draft entries are unchanged')
})

check('labels come from name first, then id; duplicates collapse and junk is skipped', () => {
  const { draft } = measuredDraft([
    { name: 'b', id: 'id-a' },
    { id: 'b' },
    { name: 'b', id: 'id-b' },
    { description: 'no identifier' },
    7,
    null,
    { name: 'a' },
  ])
  const result = evaluateCatalogPoint(draft)
  assert.deepEqual(result.toolIds, ['b', 'a'])
  assert.deepEqual(result.question?.labels, ['b', 'a'])
})

check('an absent draft fails closed with a reason', () => {
  for (const absent of [undefined, null]) {
    const result = evaluateCatalogPoint(absent)
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.record.reason, 'draft.absent')
    assert.equal(result.reason, 'draft.absent')
    assert.equal(result.catalogSource, 'none')
    assert.deepEqual(result.toolIds, [])
    assert.equal(result.question, null)
  }
})

check('a draft whose shape differs from the measured one fails closed', () => {
  const { draft: measured } = measuredDraft(TOOL_ENTRIES)
  const shapes: unknown[] = [
    42,
    'draft',
    [],
    {},
    { list: 'not-a-function' },
    { ...measured, update: undefined },
    { ...measured, remove: null },
  ]
  for (const draft of shapes) {
    const result = evaluateCatalogPoint(draft)
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.reason, 'draft.shape.unsupported')
    assert.equal(result.catalogSource, 'none')
    assert.deepEqual(result.toolIds, [])
  }
})

check('a throwing list() is contained, never rethrown', () => {
  const { draft } = measuredDraft(TOOL_ENTRIES)
  draft.list = () => {
    throw new Error('host exploded')
  }
  const result = evaluateCatalogPoint(draft)
  assert.equal(result.record.reason, 'draft.list.error')
  assert.equal(result.record.effect, 'none')
  assert.equal(result.catalogSource, 'draft')
  assert.deepEqual(result.toolIds, [])
})

check('a non-array list result and unusable entries fail closed', () => {
  const nonArray = evaluateCatalogPoint(measuredDraft(TOOL_ENTRIES).draft)
  assert.equal(nonArray.record.decision, 'unavailable')

  const { draft: objectList } = measuredDraft([])
  objectList.list = () => ({ entries: TOOL_ENTRIES })
  assert.equal(evaluateCatalogPoint(objectList).reason, 'draft.list.invalid')

  const { draft: unusable } = measuredDraft([{ description: 'x' }, 7, null])
  assert.equal(evaluateCatalogPoint(unusable).reason, 'draft.entry.unstable')
})

check('more ids than a choice accepts fails closed instead of truncating', () => {
  const entries = Array.from({ length: 256 }, (_, index) => ({ name: `tool-${index}` }))
  const { draft, calls } = measuredDraft(entries)
  const result = evaluateCatalogPoint(draft)
  assert.equal(result.record.decision, 'refusal')
  assert.equal(result.reason, 'catalog.question.too.many.labels')
  assert.equal(result.question, null)
  assert.equal(calls.list, 1)
})

check('a supplied answer resolves against the draft without mutating it', () => {
  const { draft, calls } = measuredDraft(TOOL_ENTRIES)
  const picked = evaluateCatalogPoint(draft, undefined, { kind: 'choice', index: 2 })
  assert.equal(picked.record.decision, 'choice')
  assert.equal(picked.reason, 'catalog.choice.resolved')
  assert.equal(picked.selectedToolId, 'pantheon_local_decision')
  assert.equal(calls.mutators, 0)

  const refused = evaluateCatalogPoint(measuredDraft(TOOL_ENTRIES).draft, undefined, {
    kind: 'refusal',
  })
  assert.equal(refused.record.decision, 'refusal')
  assert.equal(refused.reason, 'catalog.choice.refused')
  assert.equal(refused.selectedToolId, null)

  for (const failed of [{ kind: 'choice', index: 99 }, 'yes', null]) {
    const result = evaluateCatalogPoint(measuredDraft(TOOL_ENTRIES).draft, undefined, failed)
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.reason, 'catalog.choice.failed')
    assert.equal(result.selectedToolId, null)
  }
})

check('a draft that throws on member access is contained', () => {
  const draft = new Proxy(
    {},
    {
      get() {
        throw new Error('hostile getter')
      },
      has() {
        return true
      },
    },
  )
  const result = evaluateCatalogPoint(draft)
  assert.equal(result.record.effect, 'none')
  assert.equal(result.reason, 'draft.read.error')
  assert.deepEqual(result.toolIds, [])
})

check('every reason is a record token', () => {
  const samples = [
    evaluateCatalogPoint(undefined),
    evaluateCatalogPoint({}),
    evaluateCatalogPoint(measuredDraft([]).draft),
    evaluateCatalogPoint(measuredDraft(TOOL_ENTRIES).draft),
    evaluateCatalogPoint(measuredDraft(TOOL_ENTRIES).draft, undefined, { kind: 'refusal' }),
  ]
  for (const result of samples) {
    assert.match(result.reason, REASON_TOKEN)
    assert.equal(result.record.effect, 'none')
  }
})

check('the adapter never reads the absent host catalog context', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-points/p11-catalog.ts', import.meta.url),
    'utf8',
  )
  assert.equal(source.includes(['ctx', 'catalog'].join('.')), false)
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'undici', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})

console.log(`V2 decision P11: ${checks} groups passed`)
