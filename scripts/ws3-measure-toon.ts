/**
 * WS3 TOON measurements (PR #94) — reproducible per-class size table.
 *
 * Compares compact JSON vs TOON (chars AND tokens) on the four payload
 * classes the codec serves (board signals, checkpoints, KV payloads,
 * large tabular checkpoints). Deterministic: no LLM, no I/O, fixed
 * chars/4 ceiling — the same basis as `token-opt` metering.
 *
 * Regeneration: npx tsx scripts/ws3-measure-toon.ts
 * The output markdown table is mirrored in docs/ws3-token-opt-measurements.md.
 *
 * @module ws3-measure-toon
 */
import { type ToonValue, toonSizeReport } from '../src/pantheon/toon-codec.ts'

interface PayloadClass {
  name: string
  description: string
  value: ToonValue
}

function boardSignal(): Record<string, ToonValue> {
  return {
    taskID: 'ses_child_1',
    alias: 'apo-1',
    agent: 'hermes',
    state: 'completed',
    summary: 'Done: auth router implemented, 12 tests green',
    timestamp: 1787955800816,
  }
}

function checkpoint(): Record<string, ToonValue> {
  return {
    phase: 3,
    agent: 'hermes',
    summary: 'Delegate relaunch e2e green, monitor apo-2 and apo-3',
    remaining: ['monitor', 'reconcile', 'verify'],
    tail: 'last action: reconcile apo-1 completed after 12 tests green, heartbeat refreshed',
    jobs: [
      { taskID: 'ses_child_1', agent: 'hermes', state: 'completed' },
      { taskID: 'ses_child_2', agent: 'apollo', state: 'running' },
      { taskID: 'ses_child_3', agent: 'themis', state: 'running' },
      { taskID: 'ses_child_4', agent: 'demeter', state: 'running' },
      { taskID: 'ses_child_5', agent: 'aphrodite', state: 'error' },
    ],
    todos: [
      { id: 't1', desc: 'dispatch hermes', status: 'done' },
      { id: 't2', desc: 'monitor board', status: 'active' },
      { id: 't3', desc: 'reconcile signals', status: 'pending' },
      { id: 't4', desc: 'verify e2e', status: 'pending' },
    ],
    nested: { retries: 1, capped: false },
  }
}

function kvList(): ToonValue {
  return [
    { namespace: 'checkpoint:auth:abc123', key: 'phase:3', value: 'relaunch green' },
    { namespace: 'checkpoint:auth:abc123', key: 'latest', value: 'relaunch green' },
    { namespace: 'checkpoint:auth:abc123', key: 'heartbeat', value: 'alive' },
  ]
}

function largeTabularCheckpoint(): Record<string, ToonValue> {
  const jobs = Array.from({ length: 50 }, (_, i) => ({
    taskID: `ses_child_${i}`,
    agent: 'hermes',
    state: 'running',
  }))
  const todos = Array.from({ length: 20 }, (_, i) => ({
    id: `t${i}`,
    desc: `task number ${i}`,
    status: 'pending',
  }))
  return { phase: 9, jobs, todos }
}

const CLASSES: PayloadClass[] = [
  {
    name: 'board-signal',
    description: 'flat minimal record (content-dominated floor)',
    value: boardSignal(),
  },
  { name: 'checkpoint', description: 'WS2 checkpoint (jobs + todos tables)', value: checkpoint() },
  { name: 'kv-list', description: 'KV payload (uniform 3-col table)', value: kvList() },
  {
    name: 'large-tabular-checkpoint',
    description: '50x jobs + 20x todos (tabular ceiling)',
    value: largeTabularCheckpoint(),
  },
]

function main(): void {
  console.log(
    '| class | json_chars | toon_chars | saved_pct | json_tokens | toon_tokens | token_saved_pct |',
  )
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const payload of CLASSES) {
    const r = toonSizeReport(payload.value)
    console.log(
      `| ${payload.name} | ${r.jsonChars} | ${r.toonChars} | ${r.savedPct}% | ${r.jsonTokens} | ${r.toonTokens} | ${r.tokenSavedPct}% |`,
    )
  }
}

main()
