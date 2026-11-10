import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyDraft,
  cycleValue,
  draftCount,
  draftDirty,
  isBehaviorDisabled,
  resetTab,
  setOverrideState,
  settledDraft,
  stageValue,
  tabDirty,
  tabRows,
} from '../src/plugins/tui/src/pantheon-settings-state.ts'

const row = (overrides = {}) => ({
  id: 'row.x',
  name: 'X',
  value: 'enabled',
  cycle: ['enabled', 'disabled'],
  ...overrides,
})

describe('cycleValue', () => {
  it('wraps forward and backward', () => {
    assert.equal(cycleValue('enabled', ['enabled', 'disabled'], 1), 'disabled')
    assert.equal(cycleValue('disabled', ['enabled', 'disabled'], 1), 'enabled')
    assert.equal(cycleValue('enabled', ['enabled', 'disabled'], -1), 'disabled')
    assert.equal(cycleValue('disabled', ['enabled', 'disabled'], -1), 'enabled')
  })

  it('wraps across long cycles (the preset line)', () => {
    const cycle = ['none', 'go-free', 'go-fast']
    assert.equal(cycleValue('go-fast', cycle, 1), 'none')
    assert.equal(cycleValue('none', cycle, -1), 'go-fast')
  })

  it('an unknown current value lands on the first cycle entry', () => {
    assert.equal(cycleValue('bogus', ['a', 'b'], 1), 'a')
  })

  it('an empty cycle is a no-op', () => {
    assert.equal(cycleValue('x', [], 1), 'x')
  })
})

describe('stageValue (the draft)', () => {
  it('stages a pending value without touching row.value', () => {
    const draft = stageValue({}, row(), 1)
    assert.equal(draft['row.x'], 'disabled')
    assert.equal(row().value, 'enabled')
  })

  it('stages back onto the disk value and drops the entry (no toggle noise)', () => {
    const staged = stageValue({}, row(), 1)
    const reverted = stageValue(staged, row(), -1)
    assert.deepEqual(reverted, {})
  })

  it('a non-cyclable row never stages', () => {
    const readonly = row({ cycle: undefined })
    assert.deepEqual(stageValue({}, readonly, 1), {})
  })

  it('re-staging builds on the staged value, not the disk value', () => {
    const cycle = ['none', 'a', 'b', 'c']
    const r = row({ id: 'preset', value: 'none', cycle })
    const once = stageValue({}, r, 1)
    assert.equal(once.preset, 'a')
    const twice = stageValue(once, r, 1)
    assert.equal(twice.preset, 'b')
  })
})

describe('reset + dirty accounting', () => {
  const tab = {
    id: 'gates',
    title: 'Gates',
    groups: [
      { title: 'G1', rows: [row({ id: 'gate.a' }), row({ id: 'gate.b' })] },
      { rows: [row({ id: 'gate.c', value: 'disabled' })] },
    ],
  }
  const other = {
    id: 'about',
    title: 'About',
    groups: [{ rows: [row({ id: 'about.version', value: 'v1' })] }],
  }

  it('tabRows flattens groups in order', () => {
    assert.deepEqual(
      tabRows(tab).map((r) => r.id),
      ['gate.a', 'gate.b', 'gate.c'],
    )
  })

  it("resetTab drops only the tab's staged entries", () => {
    const draft = { 'gate.a': 'disabled', 'about.version': 'v2' }
    assert.deepEqual(resetTab(draft, tab), { 'about.version': 'v2' })
    assert.deepEqual(resetTab(draft, other), { 'gate.a': 'disabled' })
  })

  it('dirty helpers count and scope correctly', () => {
    assert.equal(draftDirty({}), false)
    assert.equal(draftCount({ 'gate.a': 'disabled' }), 1)
    assert.equal(tabDirty({ 'gate.a': 'disabled' }, tab), true)
    assert.equal(tabDirty({ 'about.version': 'v2' }, tab), false)
  })
})

describe('applyDraft (injected writers; the disk never runs in tests)', () => {
  it('applies every entry through the writer', () => {
    const seen = []
    const { applied, failed } = applyDraft({ a: '1', b: '2' }, (id, value) => {
      seen.push([id, value])
      return { ok: true }
    })
    assert.deepEqual(applied, ['a', 'b'])
    assert.equal(failed.length, 0)
    assert.deepEqual(seen, [
      ['a', '1'],
      ['b', '2'],
    ])
  })

  it('a failed write lands in failed with its reason and never throws', () => {
    const { applied, failed } = applyDraft({ good: '1', bad: '2' }, (id) =>
      id === 'bad' ? { ok: false, reason: 'unreadable file' } : { ok: true },
    )
    assert.deepEqual(applied, ['good'])
    assert.deepEqual(failed, [{ id: 'bad', reason: 'unreadable file' }])
  })

  it('settledDraft keeps only the failed (still-staged) entries', () => {
    const draft = { good: '1', bad: '2' }
    assert.deepEqual(settledDraft(draft, ['good']), { bad: '2' })
  })
})

describe('setOverrideState (the cycler save path keeps toggle semantics)', () => {
  it('writes an explicit disable and removes it on explicit enable', () => {
    const disabled = setOverrideState({}, 'gate-j1-risk-gate', 'disabled')
    assert.equal(isBehaviorDisabled(disabled, 'gate-j1-risk-gate'), true)
    const enabled = setOverrideState(disabled, 'gate-j1-risk-gate', 'enabled')
    assert.equal('gate-j1-risk-gate' in enabled, false)
  })

  it('a no-op target returns the SAME object (no write, no churn)', () => {
    const disabled = setOverrideState({}, 'gate-j1-risk-gate', 'disabled')
    assert.equal(setOverrideState(disabled, 'gate-j1-risk-gate', 'disabled'), disabled)
  })

  it('a replace entry survives disable and is restored on enable', () => {
    const authored = { 'skill-tdd-with-agents': { action: 'replace', content: 'custom' } }
    const disabled = setOverrideState(authored, 'skill-tdd-with-agents', 'disabled')
    assert.equal(disabled['skill-tdd-with-agents'].content, 'custom')
    const restored = setOverrideState(disabled, 'skill-tdd-with-agents', 'enabled')
    assert.equal(restored['skill-tdd-with-agents'].action, 'replace')
    assert.equal(restored['skill-tdd-with-agents'].content, 'custom')
  })
})

describe('draft row display contract', () => {
  it('rows carry cycle presence as the editability marker', () => {
    assert.ok(row().cycle !== undefined)
    assert.equal(row({ cycle: undefined, note: 'env · restart' }).cycle, undefined)
  })
})

describe('autonomy tab (goal loop + budgets)', () => {
  it('builds cyclable rows for goal-loop and budgets with the restart note', async () => {
    const { buildAutonomyTab } = await import('../src/plugins/tui/src/autonomy-state.ts')
    const tab = buildAutonomyTab({
      goalLoop: { enabled: false, cooldownMs: 5000, maxContinuations: 25 },
      budgets: { monthlyUsd: 5, perDecisionUsd: 0.1 },
    })
    const rows = tab.groups.flatMap((g) => g.rows)
    assert.equal(tab.id, 'autonomy')
    const goal = rows.find((r) => r.id === 'autonomy.goal_loop.enabled')
    assert.equal(goal.value, 'disabled')
    assert.deepEqual(goal.cycle, ['enabled', 'disabled'])
    assert.match(goal.note, /restart/)
    const monthly = rows.find((r) => r.id === 'autonomy.budget.monthly')
    assert.equal(monthly.value, '$5')
    assert.ok(monthly.cycle?.includes('$10'))
  })

  it('the gradient rows document the decision ladder without cyclers', async () => {
    const { buildAutonomyTab } = await import('../src/plugins/tui/src/autonomy-state.ts')
    const rows = buildAutonomyTab({
      goalLoop: { enabled: true, cooldownMs: 5000, maxContinuations: 25 },
      budgets: { monthlyUsd: 5, perDecisionUsd: 0.1 },
    }).groups.at(-1).rows
    assert.equal(rows.length, 3)
    for (const row of rows)
      assert.equal(row.cycle, undefined, 'the gradient is documented, not enforced here')
    assert.ok(rows.some((r) => r.name === 'Decide solo'))
    assert.ok(rows.some((r) => r.name === 'Jev decides'))
    assert.ok(rows.some((r) => r.name === 'Human decides'))
  })

  it('parseUsd accepts the cycle cells and rejects junk', async () => {
    const { parseUsd } = await import('../src/plugins/tui/src/autonomy-state.ts')
    assert.equal(parseUsd('$10'), 10)
    assert.equal(parseUsd('$0.10'), 0.1)
    assert.equal(parseUsd('junk'), null)
    assert.equal(parseUsd(''), null)
  })
})
