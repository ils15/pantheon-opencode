/**
 * Tests for the TUI sidebar Delegations panel channel — native children +
 * live state, enriched by the markdown reports persisted under
 * `.pantheon/delegations/<sessionID>/<alias>.md` (legacy delegate output,
 * read for backwards compatibility when the md file is present).
 *
 * Trimmed to the essential, behaviour-protecting surface: the parse contract
 * (running / terminal / timedOut / malformed / missing), the children/md/live/
 * merge guards, active-session scoping, retention/ceiling and the
 * orphan-navigation defence, plus the status→tone mapping that drives the
 * whole-row color channel (failed=error, terminal=success, in-flight=warning).
 * Other aesthetic formatting (glyphs, spinner, row lead, elapsed cells, alias
 * padding) is intentionally not unit-tested — the UI functions still render,
 * only the micro-tests are gone.
 *
 * The plugin module is imported for the exported pure helpers only — no TUI
 * runtime is exercised, so no opencode process is needed.
 *
 * Run with: npx tsx tests/pantheon/tui-delegations.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile as readFileP } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildChildrenPath,
  type ChildDelegationLike,
  ceilingDelegationList,
  childrenToDelegationEntries,
  childStatusToState,
  collectDelegationToolParts,
  createDelegationRowOpenHandler,
  DELEGATION_CHILD_STATUS_GRACE_MS,
  DELEGATION_CHILDREN_RECENCY_MS,
  DELEGATION_DONE_RETENTION_MS,
  DELEGATION_FAILED_RETENTION_MS,
  DELEGATION_VISIBLE_CEILING,
  type DelegationEntry,
  delegationRowIdentity,
  delegationRowMarker,
  delegationSpinnerFrame,
  delegationStateTone,
  filterDelegationsToSession,
  formatDelegationHeader,
  isValidSessionId,
  type LiveDelegationEntry,
  markStaleIfRunning,
  mergeChildDelegationSources,
  mergeDelegationSources,
  navigateToDelegationSession,
  parseDelegationMarkdown,
  parseDelegationToolPart,
  readAllDelegationEntries,
  readDelegationEntries,
  reduceDelegationToolPart,
  removeDelegationEntry,
  resolveCurrentSessionID,
  resolveDelegationsDir,
  resolvePantheonRoot,
  safeSessionPath,
  seedLiveDelegationMap,
  splitDelegationList,
  toDelegationEntry,
  visibleDelegationList,
} from '../../src/plugins/tui/src/index.tsx'

// ─── Fixtures (real header shapes from renderDelegationMarkdown) ────────

const COMPLETED_MD = `# Delegation Report — apo-1

- **Task ID**: \`ses_00eb6331dffelZ3iaSnCBdJIGe\`
- **Agent**: apollo
- **Description**: Localizar código do hook e seleção de modelo
- **State**: completed
- **Timed out**: false
- **Started**: 2026-08-11T14:46:13.477Z
- **Finalized**: 2026-08-11T14:48:01.974Z

## Output

Some output text.
`

const RUNNING_MD = `# Delegation Report — apo-5

- **Task ID**: \`ses_running_child\`
- **Agent**: apollo
- **Description**: Busca de código em andamento
- **State**: running
- **Timed out**: false
- **Started**: 2026-08-11T15:00:00.000Z

## Output

(no output yet — still running)
`

const TIMED_OUT_MD = `# Delegation Report — her-7

- **Task ID**: \`ses_timedout_child\`
- **Agent**: hermes
- **Description**: Implementar feature que estourou o timeout
- **State**: error
- **Timed out**: true
- **Started**: 2026-08-11T16:00:00.000Z
- **Finalized**: 2026-08-11T16:15:00.000Z

## Output

_No output captured._

[TIMEOUT REACHED]
`

const MALFORMED_MD = `# Not a delegation report

This file has no delegation headers at all.
`

const NO_FINALIZED_MD = `# Delegation Report — the-9

- **Task ID**: \`ses_no_finalized\`
- **Agent**: themis
- **Description**: Terminal sem campo Finalized
- **State**: completed
- **Timed out**: false
- **Started**: 2026-08-11T17:00:00.000Z

## Output

done
`

// ─── Harness ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

function delegation(overrides: Partial<DelegationEntry> = {}): DelegationEntry {
  return {
    alias: 'job',
    sessionID: 'ses_root',
    taskID: 'ses_job',
    agent: 'apollo',
    state: 'completed',
    startedAt: 1_000,
    updatedAt: 1_000,
    timedOut: false,
    description: 'job',
    ...overrides,
  }
}

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

async function main() {
  // ─── parseDelegationMarkdown ───────────────────────────────────────────

  await testAsync('parse: completed report → structured entry', async () => {
    const e = parseDelegationMarkdown(COMPLETED_MD, 'apo-1.md')
    assert.ok(e, 'completed report must parse')
    assert.equal(e.alias, 'apo-1')
    assert.equal(e.agent, 'apollo')
    assert.equal(e.state, 'completed')
    assert.equal(e.timedOut, false)
    assert.equal(e.startedAt, Date.parse('2026-08-11T14:46:13.477Z'))
    assert.equal(e.updatedAt, Date.parse('2026-08-11T14:48:01.974Z'))
    assert.equal(e.description, 'Localizar código do hook e seleção de modelo')
  })

  await testAsync('parse: running report → null (running state rejected from MD)', async () => {
    const e = parseDelegationMarkdown(RUNNING_MD, 'apo-5.md')
    assert.equal(e, null, 'running state in MD is rejected — only live channels produce running')
  })

  await testAsync('parse: timedOut report → timedOut true, state error', async () => {
    const e = parseDelegationMarkdown(TIMED_OUT_MD, 'her-7.md')
    assert.ok(e, 'timedOut report must parse')
    assert.equal(e.alias, 'her-7')
    assert.equal(e.state, 'error')
    assert.equal(e.timedOut, true)
    assert.equal(e.updatedAt, Date.parse('2026-08-11T16:15:00.000Z'))
  })

  await testAsync('parse: terminal without Finalized → updatedAt null', async () => {
    const e = parseDelegationMarkdown(NO_FINALIZED_MD, 'the-9.md')
    assert.ok(e, 'report without Finalized must parse')
    assert.equal(e.state, 'completed')
    assert.equal(e.updatedAt, null)
  })

  await testAsync('parse: malformed / missing headers → null (skip)', async () => {
    assert.equal(parseDelegationMarkdown(MALFORMED_MD, 'bad.md'), null)
    assert.equal(parseDelegationMarkdown('', 'empty.md'), null)
    assert.equal(
      parseDelegationMarkdown('# Delegation Report — x-1\n\n- **Agent**: hermes\n', 'x-1.md'),
      null,
      'missing State must not parse',
    )
    assert.equal(
      parseDelegationMarkdown(
        '# Delegation Report — x-2\n\n- **Agent**: hermes\n- **State**: weird\n- **Started**: 2026-08-11T15:00:00.000Z\n',
        'x-2.md',
      ),
      null,
      'unknown state must not parse',
    )
    // No H1 title → alias falls back to the filename.
    const e = parseDelegationMarkdown(
      '- **Agent**: zeus\n- **State**: completed\n- **Started**: 2026-08-11T15:00:00.000Z\n',
      'ze-1.md',
    )
    assert.ok(e, 'report without H1 must parse via filename alias')
    assert.equal(e.alias, 'ze-1')
  })

  await testAsync(
    'security: adversarial whitespace → null fast, no regex blowup (<1s)',
    async () => {
      const t0 = Date.now()
      // Old parser: /^#\s+Delegation Report\s*[—\-–]\s*(.+)$/m with `\s*`+`(.+)`
      // overlapping on a huge space run — the polynomial-regex pattern CodeQL flagged.
      assert.equal(
        parseDelegationMarkdown(`# Delegation Report-${' '.repeat(10000)}`),
        null,
        'H1-only adversarial input must not produce an entry',
      )
      assert.equal(
        parseDelegationMarkdown(`- **Agent**:${' '.repeat(10000)}`),
        null,
        'header with only whitespace value must not produce an entry',
      )
      assert.equal(
        parseDelegationMarkdown(`# Delegation Report -${' '.repeat(200000)}`),
        null,
        'very large space run must still parse fast and yield nothing',
      )
      assert.ok(
        Date.now() - t0 < 1000,
        `adversarial inputs must finish in <1s (took ${Date.now() - t0}ms)`,
      )
    },
  )

  // ─── readDelegationEntries / readAllDelegationEntries ─────────────────

  await testAsync('read: missing directory → [] (fail-open)', async () => {
    const entries = await readDelegationEntries(join(tmpdir(), 'pantheon-tui-test-does-not-exist'))
    assert.deepEqual(entries, [])
  })

  await testAsync(
    'read/readAll: terminal reports only, sorted by recency, malformed + non-dirs skipped',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-root-'))
      try {
        const deleg = join(root, '.pantheon', 'delegations')
        const sesA = join(deleg, 'ses_aaa')
        const sesB = join(deleg, 'ses_bbb')
        mkdirSync(sesA, { recursive: true })
        mkdirSync(sesB, { recursive: true })
        writeFileSync(join(sesA, 'apo-1.md'), COMPLETED_MD) // terminal, older
        writeFileSync(join(sesA, 'apo-5.md'), RUNNING_MD) // running → rejected (Fix 3)
        writeFileSync(join(sesB, 'her-7.md'), TIMED_OUT_MD) // terminal, newer
        writeFileSync(join(sesB, 'malformed.md'), MALFORMED_MD) // must be skipped
        writeFileSync(join(root, 'README.md'), '# not a session') // plain file ignored

        const entries = await readAllDelegationEntries(root)
        assert.equal(entries.length, 2, 'only terminal reports parse (running MD rejected)')
        assert.deepEqual(
          entries.map((e) => e.alias),
          ['her-7', 'apo-1'],
          'terminal by Finalized desc across sessions',
        )
        assert.equal(entries[0]?.sessionID, 'ses_bbb')
        assert.equal(entries[1]?.sessionID, 'ses_aaa')
        assert.equal(entries[0]?.state, 'error')
        assert.equal(entries[0]?.timedOut, true)

        const scoped = await readDelegationEntries(deleg)
        assert.deepEqual(
          scoped.map((e) => e.alias),
          ['her-7', 'apo-1'],
          'directory read keeps only the terminal reports, running MD rejected',
        )

        assert.deepEqual(await readAllDelegationEntries(join(root, 'nope')), [])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  // ─── Directory / root resolution ──────────────────────────────────────

  await testAsync(
    'resolve: worktree "/" (no git) → cwd; directory wins; project ignored',
    async () => {
      const cwd = '/srv/opencode'
      const rel = join(cwd, '.pantheon', 'delegations')
      assert.equal(
        resolveDelegationsDir({ worktree: '/' }, cwd),
        rel,
        'root "/" must not produce "/.pantheon/delegations"',
      )
      assert.equal(
        resolveDelegationsDir({ worktree: '/repos/acme' }, cwd),
        join('/repos/acme', '.pantheon', 'delegations'),
      )
      assert.equal(
        resolveDelegationsDir({ directory: '/proj/site' }, cwd),
        join('/proj/site', '.pantheon', 'delegations'),
      )
      assert.equal(
        resolveDelegationsDir({ directory: '/proj/site', worktree: '/' }, cwd),
        join('/proj/site', '.pantheon', 'delegations'),
        'directory beats worktree "/"',
      )
      assert.equal(resolveDelegationsDir({}, cwd), rel)
      assert.equal(resolveDelegationsDir(undefined, cwd), rel)
      assert.equal(
        resolveDelegationsDir(
          { project: '/proj/site' } as unknown as { directory?: string; worktree?: string },
          cwd,
        ),
        rel,
        'project-only state falls back to cwd (field does not exist in the type)',
      )
    },
  )

  await testAsync(
    'root: resolvePantheonRoot — directory wins, worktree fallback, "/"→cwd',
    async () => {
      assert.equal(resolvePantheonRoot({ directory: '/proj', worktree: '/wt' }, '/cwd'), '/proj')
      assert.equal(resolvePantheonRoot({ worktree: '/wt' }, '/cwd'), '/wt')
      assert.equal(resolvePantheonRoot({ directory: '/', worktree: '/' }, '/cwd'), '/cwd')
      assert.equal(resolvePantheonRoot(undefined, '/cwd'), '/cwd')
      assert.equal(resolvePantheonRoot({ directory: '' }, '/cwd'), '/cwd')
    },
  )

  // ─── collectDelegationToolParts + seedLiveDelegationMap (mount re-scan) ─

  const SEED_TASK_RUNNING = {
    id: 'part_seed_1',
    sessionID: 'ses_root',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_seed_1',
    tool: 'task',
    state: {
      status: 'running',
      input: { subagent_type: 'apollo', prompt: 'find x' },
      time: { start: 1000 },
    },
  }
  const SEED_TASK_COMPLETED = {
    ...SEED_TASK_RUNNING,
    state: {
      status: 'completed',
      input: { subagent_type: 'apollo', prompt: 'find x' },
      output: 'Delegated to apollo: [apo-1] (task ses_child_9).',
      time: { start: 1000, end: 1500 },
    },
  }

  await testAsync('collect: embedded parts + getParts fallback + fail-open', async () => {
    const messages = [
      {
        id: 'msg_1',
        parts: [
          SEED_TASK_RUNNING,
          { type: 'text', text: 'hi' },
          { type: 'tool', tool: 'bash', state: {} },
          // Removed V1 delegation tools must be collected by NOTHING now.
          { type: 'tool', tool: 'pantheon_delegate', callID: 'c_old_1', state: {} },
          { type: 'tool', tool: 'pantheon_delegation_read', callID: 'c_old_2', state: {} },
        ],
      },
    ]
    const parts = collectDelegationToolParts(messages)
    assert.equal(parts.length, 1, 'text + bash + removed-tool parts are skipped')
    assert.deepEqual(
      parts.map((p) => p.tool),
      ['task'],
    )
    const getParts = (id: string) => (id === 'msg_1' ? [SEED_TASK_RUNNING] : [])
    const fallback = collectDelegationToolParts([{ id: 'msg_1' }, { id: 'msg_2' }], getParts)
    assert.equal(fallback.length, 1)
    assert.equal(fallback[0]?.tool, 'task')
    assert.deepEqual(
      collectDelegationToolParts([], () => []),
      [],
    )
    assert.deepEqual(collectDelegationToolParts([{ id: 'm1' }], undefined), [])
    assert.deepEqual(collectDelegationToolParts(undefined, undefined), [])
  })

  await testAsync(
    'seed: re-scan from session.messages parts → job restored running, taskID absorbed (compaction recovery)',
    async () => {
      const messages = [
        { id: 'msg_1', parts: [SEED_TASK_RUNNING] },
        { id: 'msg_2', parts: [SEED_TASK_COMPLETED] },
      ]
      const map = new Map<string, LiveDelegationEntry>()
      const parts = collectDelegationToolParts(messages)
      assert.equal(
        seedLiveDelegationMap(map, parts, 9000),
        2,
        'task create + taskID absorb = 2 changes',
      )
      const e = map.get('call_seed_1')
      assert.ok(e, 'job restored into the live map on mount')
      assert.equal(
        e.state,
        'running',
        'no read tool exists — terminal state comes from the children channel',
      )
      assert.equal(e.agent, 'apollo')
      assert.equal(e.taskID, 'ses_child_9', 'taskID parsed from the completed output marker')
      assert.equal(e.updatedAt, null, 'the live channel never stamps terminal by itself')
      assert.equal(
        seedLiveDelegationMap(map, collectDelegationToolParts(messages), 9000),
        0,
        're-seeding identical parts is idempotent (no extra bumps)',
      )
    },
  )

  await testAsync('seed: empty + non-task / untargeted parts are no-ops', async () => {
    const map = new Map<string, LiveDelegationEntry>()
    assert.equal(seedLiveDelegationMap(map, []), 0)
    assert.equal(map.size, 0)
    const changed = seedLiveDelegationMap(map, [
      { type: 'text', text: 'x' },
      { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running' } },
      {
        type: 'tool',
        tool: 'task',
        callID: 'c2',
        state: { status: 'weird', input: { subagent_type: 'apollo' } },
      },
      // Removed V1 delegation tools are unknown now — no row, no mutation.
      {
        type: 'tool',
        tool: 'pantheon_delegate',
        callID: 'c3',
        state: { status: 'running', input: { agent: 'apollo' } },
      },
      {
        type: 'tool',
        tool: 'pantheon_delegation_read',
        callID: 'c4',
        state: { status: 'running', input: { id: 'apo-1' } },
      },
    ])
    assert.equal(changed, 0, 'unknown/removed tools and invalid statuses are no-ops')
    assert.equal(map.size, 0)
  })

  // ─── Live tool-part lifecycle (agent-sidebar pattern) ──────────────────

  const TASK_RUNNING_PART = {
    id: 'part_task_1',
    sessionID: 'ses_root',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_task_1',
    tool: 'task',
    state: {
      status: 'running',
      input: { subagent_type: 'apollo', prompt: 'find x', description: 'Busca' },
      time: { start: 1000 },
    },
  }
  const TASK_COMPLETED_PART = {
    id: 'part_task_1',
    sessionID: 'ses_root',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_task_1',
    tool: 'task',
    state: {
      status: 'completed',
      input: { subagent_type: 'apollo', prompt: 'find x' },
      output: 'Delegated to apollo: [apo-1] (task ses_child_9).',
      time: { start: 1000, end: 1500 },
    },
  }

  await testAsync(
    'parse: task running + completed parts → agent/status/times + alias/taskID from output',
    async () => {
      const running = parseDelegationToolPart(TASK_RUNNING_PART, 2000)
      assert.ok(running, 'task running part must parse')
      assert.equal(running.tool, 'task')
      assert.equal(running.callID, 'call_task_1')
      assert.equal(running.agent, 'apollo')
      assert.equal(running.description, 'Busca')
      assert.equal(running.status, 'running')
      assert.equal(running.startedAt, 1000, 'startedAt comes from state.time.start')
      assert.equal(running.alias, null, 'a running part has no alias yet')

      const completed = parseDelegationToolPart(TASK_COMPLETED_PART, 2000)
      assert.ok(completed)
      assert.equal(completed.status, 'completed')
      assert.equal(completed.alias, 'apo-1', 'alias parsed from "[apo-1]" in the output')
      assert.equal(completed.taskID, 'ses_child_9', 'taskID parsed from "(task ses_...)"')
      assert.equal(completed.endAt, 1500)

      const pending = parseDelegationToolPart(
        {
          id: 'part_task_2',
          sessionID: 'ses_root',
          messageID: 'msg_1',
          type: 'tool',
          callID: 'call_task_2',
          tool: 'task',
          state: { status: 'pending', input: { subagent_type: 'zeus' } },
        },
        4242,
      )
      assert.ok(pending)
      assert.equal(pending.status, 'pending')
      assert.equal(pending.startedAt, 4242, 'pending part without time falls back to now')

      assert.equal(
        parseDelegationToolPart({
          id: 'p3',
          sessionID: 'ses_root',
          messageID: 'm3',
          type: 'tool',
          callID: 'c3',
          tool: 'bash',
          state: { status: 'running', input: { command: 'ls' }, time: { start: 10 } },
        }),
        null,
        'other tools must be ignored',
      )
      assert.equal(
        parseDelegationToolPart({
          id: 'p4',
          sessionID: 'ses_root',
          messageID: 'm4',
          type: 'text',
          text: 'hi',
        }),
        null,
      )
      assert.equal(
        parseDelegationToolPart({ type: 'tool', tool: 'task' }),
        null,
        'no callID → null',
      )
      // REGRESSION (issue #161): the V1 delegation tools were removed in
      // v1.5.0 — they must parse to null like any other unknown tool.
      assert.equal(
        parseDelegationToolPart({
          type: 'tool',
          tool: 'pantheon_delegate',
          callID: 'c_old',
          state: { status: 'running', input: { agent: 'apollo' } },
        }),
        null,
        'removed pantheon_delegate must not parse',
      )
      assert.equal(
        parseDelegationToolPart({
          type: 'tool',
          tool: 'pantheon_delegation_read',
          callID: 'c_old2',
          state: { status: 'completed', input: { id: 'apo-1' } },
        }),
        null,
        'removed pantheon_delegation_read must not parse',
      )
    },
  )

  await testAsync(
    'reduce: task completing only means LAUNCHED — entry stays running with taskID',
    async () => {
      const map = new Map<string, LiveDelegationEntry>()
      assert.equal(reduceDelegationToolPart(map, TASK_RUNNING_PART, 2000), true, 'create')
      let e = map.get('call_task_1')
      assert.ok(e)
      assert.equal(e.state, 'running')
      assert.equal(e.agent, 'apollo')
      assert.equal(e.startedAt, 1000)
      assert.equal(e.alias, null)

      assert.equal(reduceDelegationToolPart(map, TASK_COMPLETED_PART, 2000), true, 'taskID absorb')
      e = map.get('call_task_1')
      assert.ok(e)
      assert.equal(
        e.state,
        'running',
        'task completing only means the call returned — the child keeps running',
      )
      assert.equal(e.taskID, 'ses_child_9')
      assert.equal(e.updatedAt, null)
    },
  )

  await testAsync(
    'reduce: removed V1 delegation tools never touch the live map (regression, issue #161)',
    async () => {
      const map = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(map, TASK_RUNNING_PART, 2000)
      const before = map.get('call_task_1')
      assert.ok(before)

      // Neither the removed delegate tool nor the removed read tool may
      // create rows or mutate an existing one.
      assert.equal(
        reduceDelegationToolPart(
          map,
          {
            id: 'part_old_1',
            sessionID: 'ses_root',
            type: 'tool',
            callID: 'call_old_1',
            tool: 'pantheon_delegate',
            state: { status: 'completed', input: { agent: 'hermes' }, time: { start: 1, end: 2 } },
          },
          3000,
        ),
        false,
        'pantheon_delegate is a no-op',
      )
      assert.equal(
        reduceDelegationToolPart(
          map,
          {
            id: 'part_old_2',
            sessionID: 'ses_root',
            type: 'tool',
            callID: 'call_old_2',
            tool: 'pantheon_delegation_read',
            state: { status: 'completed', input: { id: 'apo-1' }, time: { start: 1, end: 2 } },
          },
          3000,
        ),
        false,
        'pantheon_delegation_read is a no-op (it used to close the entry)',
      )
      assert.equal(map.size, 1, 'no row was created for the removed tools')
      const after = map.get('call_task_1')
      assert.equal(after, before, 'the existing entry is untouched (reference unchanged)')
    },
  )

  await testAsync(
    'remove + toDelegationEntry: cleanup by partID/callID, alias fallback',
    async () => {
      const byPart = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(byPart, TASK_RUNNING_PART, 2000)
      assert.equal(removeDelegationEntry(byPart, 'part_task_1'), true, 'partID matches')
      assert.equal(byPart.size, 0)

      const byCall = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(byCall, TASK_RUNNING_PART, 2000)
      assert.equal(removeDelegationEntry(byCall, 'call_task_1'), true, 'callID matches')
      assert.equal(removeDelegationEntry(byCall, 'nope'), false, 'unknown → unchanged')

      const live: LiveDelegationEntry = {
        callID: 'call_1',
        partID: 'part_1',
        sessionID: 'ses_root',
        tool: 'task',
        agent: 'apollo',
        description: 'Busca',
        alias: 'apo-1',
        taskID: 'ses_child_9',
        state: 'running',
        startedAt: 1000,
        updatedAt: null,
      }
      const e = toDelegationEntry(live)
      assert.equal(e.alias, 'apo-1')
      assert.equal(e.sessionID, 'ses_root')
      assert.equal(e.agent, 'apollo')
      assert.equal(e.state, 'running')
      assert.equal(e.description, 'Busca')
      const noAlias = toDelegationEntry({ ...live, alias: null })
      assert.ok(noAlias.alias.startsWith('live-'), 'alias falls back to a live- prefix')
    },
  )

  // ─── mergeDelegationSources / mergeChildDelegationSources guards ───────

  const liveRunning: LiveDelegationEntry = {
    callID: 'call_1',
    partID: 'part_1',
    sessionID: 'ses_root',
    tool: 'task',
    agent: 'apollo',
    description: 'Busca',
    alias: 'apo-1',
    taskID: null,
    state: 'running',
    startedAt: 1000,
    updatedAt: null,
  }

  await testAsync(
    'merge: md terminal wins; cross-session alias kept distinct; running first by recency',
    async () => {
      const mdTerminal: DelegationEntry = {
        alias: 'apo-1',
        sessionID: 'ses_root',
        agent: 'apollo',
        state: 'completed',
        startedAt: 1000,
        updatedAt: 8000,
        timedOut: false,
        description: 'Busca',
      }
      const merged = mergeDelegationSources([liveRunning], [mdTerminal])
      assert.equal(merged.length, 1, 'same (session, alias) → single row')
      assert.equal(merged[0].state, 'completed', 'terminal md is authoritative over live running')

      const liveOnly = mergeDelegationSources([{ ...liveRunning, alias: 'apo-2' }], [])
      assert.equal(liveOnly.length, 1)
      assert.equal(liveOnly[0].state, 'running')
      assert.equal(liveOnly[0].alias, 'apo-2')

      const mdOtherSession: DelegationEntry = {
        alias: 'apo-1',
        sessionID: 'ses_other',
        agent: 'apollo',
        state: 'completed',
        startedAt: 500,
        updatedAt: 700,
        timedOut: false,
        description: '',
      }
      assert.equal(
        mergeDelegationSources([liveRunning], [mdOtherSession]).length,
        2,
        'different sessions → two distinct jobs',
      )

      const mdOld: DelegationEntry = {
        alias: 'her-1',
        sessionID: 'ses_root',
        agent: 'hermes',
        state: 'completed',
        startedAt: 100,
        updatedAt: 500,
        timedOut: false,
        description: '',
      }
      const mdNew: DelegationEntry = {
        alias: 'the-1',
        sessionID: 'ses_root',
        agent: 'themis',
        state: 'error',
        startedAt: 200,
        updatedAt: 900,
        timedOut: true,
        description: '',
      }
      assert.deepEqual(
        mergeDelegationSources([liveRunning], [mdOld, mdNew]).map((e) => e.alias),
        ['apo-1', 'the-1', 'her-1'],
        'running first, terminal by recency',
      )
    },
  )

  await testAsync(
    'merge: children-only terminal state is NOT overwritten by a stale live running entry',
    async () => {
      // BUG FIX: when a child session goes idle before the MD report is
      // written, childrenToDelegationEntries derives state 'completed' from
      // childStatusToState('idle') with source 'children-only'. The live
      // entry from the task tool part is still 'running' (the live channel
      // never marks terminal by itself). The merge must NOT overwrite the
      // terminal children-only state with the stale live state.
      const child: DelegationEntry = {
        alias: 'native-task',
        sessionID: 'ses_root',
        taskID: 'ses_child_idle',
        agent: 'apollo',
        state: 'completed',
        startedAt: 1000,
        updatedAt: 5000,
        timedOut: false,
        description: 'Fetch data',
        source: 'children-only',
      }
      const staleLive: LiveDelegationEntry = {
        ...liveRunning,
        taskID: 'ses_child_idle',
        state: 'running',
      }
      const merged = mergeChildDelegationSources([child], [staleLive])
      assert.equal(merged.length, 1)
      assert.equal(
        merged[0]?.state,
        'completed',
        'children-only terminal state must not be downgraded to running by a stale live entry',
      )
      assert.equal(merged[0]?.alias, 'apo-1', 'live alias is absorbed')
      assert.equal(merged[0]?.agent, 'apollo', 'live agent is absorbed')
    },
  )

  await testAsync(
    'merge: native task() live rows keep per-call identity and match the child by taskID',
    async () => {
      const mkNative = (n: number): LiveDelegationEntry => ({
        callID: n === 1 ? 'call_A1b2C3d4e5' : 'call_Z9y8X7w6v5',
        partID: `part_task_${n}`,
        sessionID: 'ses_root',
        tool: 'task',
        agent: n === 1 ? 'hermes' : 'apollo',
        description: `Nativa ${n}`,
        alias: null,
        taskID: null,
        state: 'running',
        startedAt: Date.now(),
        updatedAt: null,
      })
      const twoNatives = mergeChildDelegationSources([], [mkNative(1), mkNative(2)])
      assert.equal(
        twoNatives.length,
        2,
        'per-call identity — natives must not collapse onto one row',
      )
      assert.equal(delegationRowIdentity(twoNatives[0] as DelegationEntry), 'hermes')
      assert.equal(delegationRowIdentity(twoNatives[1] as DelegationEntry), 'apollo')

      const child: DelegationEntry = {
        alias: 'native-at_1',
        sessionID: 'ses_root',
        taskID: 'ses_nat_1',
        agent: 'hermes',
        state: 'running',
        startedAt: 1000,
        updatedAt: null,
        timedOut: false,
        description: 'Nativa',
        source: 'children-only',
      }
      const matched = mergeChildDelegationSources(
        [child],
        [{ ...mkNative(1), taskID: 'ses_nat_1', startedAt: 1000 }],
      )
      assert.equal(matched.length, 1, 'taskID match merges live into the child row')
      assert.equal(matched[0]?.taskID, 'ses_nat_1')
      assert.equal(matched[0]?.source, 'children-only')
    },
  )

  // ─── Children channel (childStatusToState + childrenToDelegationEntries) ─

  await testAsync(
    'children: childStatusToState — busy/retry→running, idle/absent→done (fresh absent child → running)',
    async () => {
      assert.equal(childStatusToState('busy'), 'running')
      assert.equal(childStatusToState('retry'), 'retry')
      assert.equal(childStatusToState('idle'), 'completed')
      assert.equal(
        childStatusToState(undefined),
        'completed',
        'absent status → done (historical child, NOT running)',
      )
      assert.equal(
        childStatusToState('weird'),
        'completed',
        'unknown status → done (not evidence of life)',
      )

      // Grace window: an absent status is running ONLY while the child is
      // fresh — a just-spawned child the status API has not registered yet.
      const now = 1_000_000
      assert.equal(
        childStatusToState(undefined, { created: now - 10_000 }, now),
        'running',
        'absent status within the grace window (time.created) → running',
      )
      assert.equal(
        childStatusToState(undefined, { updated: now - 10_000 }, now),
        'running',
        'recent time.updated counts as fresh activity',
      )
      assert.equal(
        childStatusToState(undefined, { created: now - DELEGATION_CHILD_STATUS_GRACE_MS - 1 }, now),
        'completed',
        'absent status past the grace window → done',
      )
      assert.equal(
        childStatusToState(undefined, { created: 1000, updated: 2000 }, now),
        'completed',
        'absent status with an old timestamp → done',
      )
      assert.equal(
        childStatusToState(undefined, { created: now - 10_000 }, now, 0),
        'completed',
        'grace window is injectable (0 = always terminal)',
      )

      // Stale "busy" in the status map: a "busy" child whose last activity is
      // older than STALE_RUNNING_THRESHOLD_MS is likely dead — the status map
      // retained a stale entry. Treat as completed, not running.
      const STALE = 30 * 60 * 1000
      const tNow = STALE + 60_000 // enough headroom so (tNow - STALE - 1) is positive
      assert.equal(
        childStatusToState('busy', { created: tNow - STALE - 1 }, tNow),
        'completed',
        'stale "busy" (created past threshold) → completed',
      )
      assert.equal(
        childStatusToState('busy', { updated: tNow - STALE - 1 }, tNow),
        'completed',
        'stale "busy" (updated past threshold) → completed',
      )
      assert.equal(
        childStatusToState('busy', { created: tNow - 10_000 }, tNow),
        'running',
        'recent "busy" (within threshold) → running',
      )
      assert.equal(
        childStatusToState('busy', { created: tNow - 10_000, updated: tNow - STALE - 1 }, tNow),
        'running',
        '"busy" with recent created + stale updated → running (max picks most recent)',
      )
      assert.equal(
        childStatusToState('busy', { created: tNow - STALE - 1, updated: tNow - 10_000 }, tNow),
        'running',
        '"busy" with stale created + recent updated → running (max picks most recent)',
      )
      assert.equal(
        childStatusToState('busy', { created: tNow - STALE - 1, updated: tNow - STALE - 1 }, tNow),
        'completed',
        '"busy" with both stale → completed',
      )
      // Without time info, trust the status map (can't determine staleness).
      assert.equal(
        childStatusToState('busy'),
        'running',
        '"busy" without time → running (trust status map)',
      )
    },
  )

  await testAsync(
    'children: entries derive state + times, no-md row falls back to title/agent',
    async () => {
      const children: ChildDelegationLike[] = [
        {
          id: 'ses_child_busy',
          title: 'Busca em andamento',
          status: 'busy',
          time: { created: 1000 },
        },
        {
          id: 'ses_child_rty',
          title: 'Tentando de novo',
          status: 'retry',
          time: { created: 2000 },
        },
        {
          id: 'ses_child_idle',
          title: 'Já terminou',
          status: 'idle',
          time: { created: 3000, updated: 8000 },
        },
      ]
      const entries = childrenToDelegationEntries(children, [], 10_000)
      assert.equal(entries.length, 3)
      const byId = new Map(entries.map((e) => [e.taskID, e]))
      assert.equal(byId.get('ses_child_busy')?.state, 'running')
      assert.equal(byId.get('ses_child_rty')?.state, 'retry')
      assert.equal(byId.get('ses_child_idle')?.state, 'completed')
      assert.equal(byId.get('ses_child_busy')?.updatedAt, null, 'running child has no end')
      assert.equal(byId.get('ses_child_idle')?.updatedAt, 8000, 'terminal child uses time.updated')

      const noMd = childrenToDelegationEntries(
        [{ id: 'ses_child_x', title: 'Busca de código', status: 'busy', time: { created: 5000 } }],
        [],
        10_000,
      )
      assert.equal(noMd.length, 1, 'a child without a report still renders')
      assert.equal(noMd[0]?.agent, 'agent', 'agent falls back without a report')
      assert.equal(noMd[0]?.description, 'Busca de código', 'description falls back to the title')
      assert.equal(noMd[0]?.startedAt, 5000)
      assert.equal(noMd[0]?.timedOut, false)
    },
  )

  await testAsync(
    'children: md matched by Task ID (backticks stripped) → alias/agent/description/state win',
    async () => {
      const md = parseDelegationMarkdown(
        '# Delegation Report — apo-1\n' +
          '- **Task ID**: `ses_child_9`\n' +
          '- **Agent**: apollo\n' +
          '- **Description**: Busca de código\n' +
          '- **State**: completed\n' +
          '- **Timed out**: false\n' +
          '- **Started**: 2026-08-11T15:00:00.000Z\n' +
          '- **Finalized**: 2026-08-11T15:10:00.000Z\n',
        'apo-1.md',
      )
      assert.ok(md, 'report with Task ID must parse')
      assert.equal(md.taskID, 'ses_child_9', 'backticked Task ID is stripped')

      const entries = childrenToDelegationEntries(
        [{ id: 'ses_child_9', title: 'fallback title', status: 'idle' }],
        [md],
        10_000,
      )
      assert.equal(entries.length, 1)
      const e = entries[0]
      assert.ok(e)
      assert.equal(e.taskID, 'ses_child_9')
      assert.equal(e.alias, 'apo-1', 'alias comes from the matched md report')
      assert.equal(e.agent, 'apollo')
      assert.equal(e.description, 'Busca de código', 'report description wins over child title')
      assert.equal(e.state, 'completed', 'terminal md state wins over idle-derived')
      assert.equal(e.startedAt, Date.parse('2026-08-11T15:00:00.000Z'))
      assert.equal(e.updatedAt, Date.parse('2026-08-11T15:10:00.000Z'))
    },
  )

  await testAsync('children: refresh/polling does not duplicate (dedupe by child id)', async () => {
    const children = [
      { id: 'ses_child_a', title: 'A', status: 'busy' },
      { id: 'ses_child_a', title: 'A', status: 'busy' },
      { id: 'ses_child_b', title: 'B', status: 'idle' },
    ]
    const first = childrenToDelegationEntries(children, [], 10_000)
    assert.equal(first.length, 2, 'duplicate id in one batch collapses')
    const second = childrenToDelegationEntries(children, [], 11_000)
    assert.equal(second.length, 2, 're-fetch does not accumulate entries')
    assert.deepEqual(first.map((e) => e.taskID).sort(), ['ses_child_a', 'ses_child_b'])
  })

  await testAsync(
    'children: recency window drops historical rows, survivors are newest-first',
    async () => {
      const now = 1_000_000_000_000
      const children: ChildDelegationLike[] = [
        {
          id: 'ses_historical',
          title: 'historical',
          status: 'idle',
          time: {
            created: now - DELEGATION_CHILDREN_RECENCY_MS - 1,
            updated: now - DELEGATION_CHILDREN_RECENCY_MS - 1,
          },
        },
        {
          id: 'ses_recent_new',
          title: 'recent new',
          status: 'idle',
          time: { created: now - 60_000, updated: now - 30_000 },
        },
        {
          id: 'ses_recent_old',
          title: 'recent old',
          status: 'idle',
          time: { created: now - 120_000, updated: now - 90_000 },
        },
      ]
      const entries = childrenToDelegationEntries(children, [], now)
      assert.deepEqual(
        entries.map((e) => e.taskID),
        ['ses_recent_new', 'ses_recent_old'],
        'historical child is dropped; the rest are ordered newest-first',
      )
      // Exactly at the window boundary the child is still kept (age == window).
      assert.equal(
        childrenToDelegationEntries(
          [
            {
              id: 'ses_boundary',
              status: 'idle',
              time: {
                created: now - DELEGATION_CHILDREN_RECENCY_MS,
                updated: now - DELEGATION_CHILDREN_RECENCY_MS,
              },
            },
          ],
          [],
          now,
        ).length,
        1,
        'a child exactly at the window boundary survives',
      )
      // Fail-open: a child with no timestamp at all is never dropped.
      assert.equal(
        childrenToDelegationEntries([{ id: 'ses_untimed', status: 'idle' }], [], now).length,
        1,
        'untimed child kept (cannot be judged)',
      )
      // A fresh report (Finalized) keeps a child whose own times are old.
      const md = delegation({
        taskID: 'ses_reported',
        state: 'completed',
        startedAt: now - DELEGATION_CHILDREN_RECENCY_MS - 10_000,
        updatedAt: now - 1_000,
      })
      assert.equal(
        childrenToDelegationEntries(
          [
            {
              id: 'ses_reported',
              status: 'idle',
              time: { created: now - DELEGATION_CHILDREN_RECENCY_MS - 5_000 },
            },
          ],
          [md],
          now,
        ).length,
        1,
        'recent report keeps the child inside the window',
      )
    },
  )

  await testAsync(
    'children-only: native identity + per-child alias + parentSession stamp',
    async () => {
      const entries = childrenToDelegationEntries(
        [
          { id: 'ses_nat_a', title: 'A', status: 'busy', time: { created: 100 } },
          { id: 'ses_nat_b', title: 'B', status: 'busy', agent: 'hermes', time: { created: 200 } },
        ],
        [],
        10_000,
        'ses_root',
      )
      assert.equal(entries.length, 2)
      const byId = new Map(entries.map((e) => [e.taskID, e]))
      assert.equal(byId.get('ses_nat_a')?.alias, 'native-at_a')
      assert.equal(byId.get('ses_nat_b')?.alias, 'native-at_b')
      assert.equal(
        byId.get('ses_nat_a')?.sessionID,
        'ses_root',
        'focused session is stamped on report-less children',
      )
      assert.equal(byId.get('ses_nat_a')?.source, 'children-only')
      assert.equal(delegationRowIdentity(byId.get('ses_nat_a') as DelegationEntry), 'agent')
      assert.equal(delegationRowIdentity(byId.get('ses_nat_b') as DelegationEntry), 'hermes')
      assert.deepEqual(
        filterDelegationsToSession(entries, 'ses_root')
          .map((e) => e.taskID)
          .sort(),
        ['ses_nat_a', 'ses_nat_b'],
      )
    },
  )

  await testAsync(
    'children-only: child WITH md → md entry (alias) wins, same child NOT duplicated',
    async () => {
      const md = parseDelegationMarkdown(COMPLETED_MD, 'apo-1.md')
      assert.ok(md)
      assert.equal(md.taskID, 'ses_00eb6331dffelZ3iaSnCBdJIGe')
      const entries = childrenToDelegationEntries(
        [
          { id: 'ses_00eb6331dffelZ3iaSnCBdJIGe', title: 'dupe title', status: 'busy' },
          { id: 'ses_00eb6331dffelZ3iaSnCBdJIGe', title: 'dupe title', status: 'busy' },
        ],
        [md],
        10_000,
      )
      assert.equal(entries.length, 1, 'md row only — no duplicate from children')
      const e = entries[0]
      assert.ok(e)
      assert.equal(e.source, 'md', 'md provenance wins')
      assert.equal(e.alias, 'apo-1', 'md alias (not native)')
      assert.equal(delegationRowIdentity(e), 'apo-1', 'single identity: md alias, no agent dup')
      assert.equal(e.state, 'completed', 'terminal md state wins over busy-derived')
    },
  )

  await testAsync(
    'children-only: delegate + task mixture → correct sources, ordering and count',
    async () => {
      const md = parseDelegationMarkdown(COMPLETED_MD, 'apo-1.md')
      assert.ok(md)
      const children: ChildDelegationLike[] = [
        {
          id: md.taskID ?? 'ses_00eb6331dffelZ3iaSnCBdJIGe',
          title: 'delegate child',
          status: 'busy',
          time: { created: 1000 },
        },
        { id: 'ses_task_a', title: 'Task A', status: 'busy', time: { created: 2000 } },
        {
          id: 'ses_task_b',
          title: 'Task B',
          status: 'idle',
          time: { created: 500, updated: 4000 },
        },
      ]
      const entries = childrenToDelegationEntries(children, [md], 10_000)
      assert.equal(entries.length, 3, '3 children → 3 rows (1 md + 2 task)')
      const byId = new Map(entries.map((e) => [e.taskID, e]))
      const mdEntry = byId.get(md.taskID ?? '')
      assert.ok(mdEntry)
      assert.equal(mdEntry.source, 'md')
      assert.equal(delegationRowIdentity(mdEntry), 'apo-1')
      assert.equal(
        mdEntry.state,
        'completed',
        'terminal md state wins over the busy-derived child state',
      )
      assert.equal(byId.get('ses_task_a')?.source, 'children-only')
      assert.equal(byId.get('ses_task_b')?.source, 'children-only')
      assert.equal(entries[0]?.state, 'running', 'running first')
      assert.equal(entries[0]?.taskID, 'ses_task_a')
      assert.equal(entries[1]?.taskID, md.taskID, 'terminal md row sorted by Finalized')
      assert.equal(entries[2]?.taskID, 'ses_task_b')
    },
  )

  await testAsync('children: stale md terminal NEVER downgrades a busy child', async () => {
    // BUG 1 (children channel): an md report from a previous incarnation
    // (Finalized 1000, before the current child activity at 9000) must not
    // flip the live busy child back to completed.
    const md: DelegationEntry = {
      alias: 'apo-1',
      sessionID: 'ses_root',
      taskID: 'ses_child_9',
      agent: 'apollo',
      state: 'completed',
      startedAt: 500,
      updatedAt: 1000,
      timedOut: false,
      description: 'old report',
      source: 'md',
    }
    const entries = childrenToDelegationEntries(
      [
        {
          id: 'ses_child_9',
          title: 'Busca nova',
          status: 'busy',
          time: { created: 5000, updated: 9000 },
        },
      ],
      [md],
      10_000,
      'ses_root',
    )
    assert.equal(entries.length, 1)
    assert.equal(
      entries[0]?.state,
      'running',
      'stale md (Finalized < child updated) must not flip a busy child to terminal',
    )
  })

  // ─── Native task() live signal ─────────────────────────────────────────

  await testAsync('native task(): collect + parse + reduce feed the live signal', async () => {
    const messages = [
      {
        id: 'msg_1',
        parts: [
          SEED_TASK_RUNNING,
          {
            id: 'part_task_1',
            sessionID: 'ses_root',
            type: 'tool',
            callID: 'call_task_1',
            tool: 'task',
            state: {
              status: 'running',
              input: { subagent_type: 'Explore', prompt: 'find auth code' },
              time: { start: 2000 },
            },
          },
          { type: 'text', text: 'hi' },
        ],
      },
    ]
    const parts = collectDelegationToolParts(messages)
    assert.equal(parts.length, 2, 'two task parts collected, text skipped')
    assert.deepEqual(
      parts.map((p) => p.tool),
      ['task', 'task'],
    )
    const p = parseDelegationToolPart(parts[1], 3000)
    assert.ok(p, 'native task part must parse')
    assert.equal(p.tool, 'task')
    assert.equal(p.agent, 'Explore')
    assert.equal(p.description, 'find auth code')
    assert.equal(p.alias, null, 'native task never carries an alias')

    const map = new Map<string, LiveDelegationEntry>()
    const changed = reduceDelegationToolPart(
      map,
      {
        id: 'part_task_2',
        sessionID: 'ses_root',
        type: 'tool',
        callID: 'call_task_2',
        tool: 'task',
        state: { status: 'running', input: { description: 'Busca nativa' }, time: { start: 2000 } },
      },
      3000,
    )
    assert.equal(changed, true)
    const e = map.get('call_task_2')
    assert.ok(e)
    assert.equal(e.tool, 'task')
    assert.equal(e.state, 'running')
    assert.equal(e.description, 'Busca nativa')
  })

  // ─── Ceiling / retention / split / header ─────────────────────────────

  const panEntry = (over: Partial<DelegationEntry> = {}): DelegationEntry => ({
    alias: 'apo-1',
    sessionID: 'ses_pantheon',
    taskID: 'ses_pan_child',
    agent: 'apollo',
    state: 'completed',
    startedAt: 1000,
    updatedAt: 8000,
    timedOut: false,
    description: 'Localizar código do hook e seleção de modelo',
    source: 'md',
    ...over,
  })
  const natEntry = (over: Partial<DelegationEntry> = {}): DelegationEntry =>
    panEntry({ alias: 'native-task', agent: 'hermes', source: 'children-only', ...over })

  await testAsync(
    'ceiling: DONE (2m) / FAILED (10m) retention filters expired terminal rows',
    async () => {
      const now = 1_000_000
      const result = ceilingDelegationList(
        [
          delegation({ alias: 'done-old', updatedAt: now - DELEGATION_DONE_RETENTION_MS - 1 }),
          delegation({
            alias: 'failed-recent',
            state: 'error',
            updatedAt: now - DELEGATION_DONE_RETENTION_MS - 1,
          }),
          delegation({
            alias: 'failed-old',
            state: 'error',
            updatedAt: now - DELEGATION_FAILED_RETENTION_MS - 1,
          }),
        ],
        DELEGATION_VISIBLE_CEILING,
        now,
      )
      assert.deepEqual(
        result.visible.map((entry) => entry.alias),
        ['failed-recent'],
      )
      assert.equal(result.hidden, 0, 'expired terminal history is not reported as hidden')
    },
  )

  await testAsync(
    'ceiling: active-first, >8 overflow reported, unknown-age terminals retained',
    async () => {
      const now = 1_000_000
      const entries = [
        delegation({ alias: 'done-new', updatedAt: now - 1 }),
        delegation({ alias: 'active', state: 'running', updatedAt: now - 1 }),
        delegation({ alias: 'done-old', updatedAt: now - 2 }),
      ]
      const result = ceilingDelegationList(entries, 2, now)
      assert.deepEqual(
        result.visible.map((entry) => entry.alias),
        ['active', 'done-new'],
        'active first and fill remaining slots with newest terminals',
      )

      const many = Array.from({ length: DELEGATION_VISIBLE_CEILING + 2 }, (_, index) =>
        delegation({ alias: `active-${index}`, state: 'running', updatedAt: now - index }),
      )
      const overflow = ceilingDelegationList(many, DELEGATION_VISIBLE_CEILING, now)
      assert.equal(overflow.visible.length, DELEGATION_VISIBLE_CEILING)
      assert.equal(overflow.hiddenActive, 2)
      assert.equal(overflow.hiddenTerminal, 0)
      assert.equal(overflow.hidden, 2)

      const unknown = ceilingDelegationList(
        [delegation({ alias: 'unknown-age', updatedAt: null })],
        DELEGATION_VISIBLE_CEILING,
        now,
      )
      assert.deepEqual(
        unknown.visible.map((entry) => entry.alias),
        ['unknown-age'],
      )
    },
  )

  await testAsync('ceiling: newest-first ordering makes "… +N" hide the OLDEST rows', async () => {
    const now = 1_000_000
    const entries = [
      delegation({ alias: 'oldest', updatedAt: now - 100_000 }),
      delegation({ alias: 'newer', updatedAt: now - 30_000 }),
      delegation({ alias: 'newest', updatedAt: now - 5_000 }),
    ]
    const { visible, hidden, hiddenActive, hiddenTerminal } = ceilingDelegationList(entries, 2, now)
    assert.deepEqual(
      visible.map((entry) => entry.alias),
      ['newest', 'newer'],
      'the two most recent rows render',
    )
    assert.equal(hidden, 1, 'the oldest row is the one collapsed')
    assert.equal(hiddenActive, 0)
    assert.equal(hiddenTerminal, 1)
  })

  await testAsync(
    'split: active + recent cap; running native children never archived',
    async () => {
      const natRun = natEntry({ state: 'running', startedAt: 0, updatedAt: null })
      const natStale = natEntry({ taskID: 'ses_stale', state: 'stale-running' })
      const runningSplit = splitDelegationList([natRun, natStale], 8, 0)
      assert.equal(runningSplit.active.length, 2, 'both running rows stay active')
      assert.equal(runningSplit.recent.length, 0)
      assert.equal(
        runningSplit.recent.some((e) => e.state === 'running' || e.state === 'stale-running'),
        false,
        'nothing running falls to the terminal tail',
      )

      const mk = (id: string, state: DelegationEntry['state'], i: number): DelegationEntry => ({
        alias: `t-${id}`,
        sessionID: 'ses_p',
        taskID: `ses_${id}`,
        agent: 'apollo',
        state,
        startedAt: 1000 + i,
        updatedAt: null,
        timedOut: false,
        description: '',
      })
      const all = [
        mk('run', 'running', 1),
        mk('done-1', 'completed', 2),
        mk('done-2', 'error', 3),
        mk('done-3', 'completed', 4),
      ]
      const split = splitDelegationList(all, 2, 2000)
      assert.equal(split.active.length, 1)
      assert.equal(split.active[0]?.taskID, 'ses_run')
      assert.equal(split.recent.length, 2)
    },
  )

  await testAsync('header: active/done + failed only when >0, no nat/pan', async () => {
    const natRun = natEntry({ state: 'running' })
    const done1 = panEntry({ taskID: 'ses_done_1', state: 'completed' })
    const done2 = panEntry({ taskID: 'ses_done_2', state: 'completed' })
    assert.equal(formatDelegationHeader([natRun, done1, done2]), '(1 active \u00b7 2 done)')
    assert.equal(formatDelegationHeader([]), '(0 active \u00b7 0 done)')
    assert.equal(
      formatDelegationHeader([natEntry({ state: 'stale-running' })]),
      '(1 active \u00b7 0 done)',
      'stale-running counts as active, never as done',
    )
    const failed = panEntry({ taskID: 'ses_fail_1', state: 'error' })
    assert.equal(
      formatDelegationHeader([natRun, done1, failed]),
      '(1 active \u00b7 1 done \u00b7 1 failed)',
    )
    assert.equal(
      formatDelegationHeader([panEntry({ taskID: 'ses_c', state: 'cancelled' })]),
      '(0 active \u00b7 1 done)',
      'cancelled reads as done',
    )
  })

  // ─── Active-session scope (no cross-session history) ──────────────────

  await testAsync(
    'panel scope: no active session → NO rows (cross-session history removed)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-root-'))
      try {
        const deleg = join(root, '.pantheon', 'delegations')
        const ses = join(deleg, 'ses_aaa')
        mkdirSync(ses, { recursive: true })
        writeFileSync(join(ses, 'apo-1.md'), COMPLETED_MD)
        writeFileSync(join(ses, 'her-7.md'), TIMED_OUT_MD)
        writeFileSync(join(ses, 'apo-5.md'), RUNNING_MD)
        writeFileSync(join(ses, 'the-9.md'), NO_FINALIZED_MD)

        const sessionID = resolveCurrentSessionID({ sessionID: '{sessionID}' })
        assert.equal(sessionID, null)
        const md = await readAllDelegationEntries(root)
        assert.equal(
          md.length,
          3,
          'history still readable from disk (enrichment channel — running MD rejected)',
        )
        const panelList = filterDelegationsToSession(
          visibleDelegationList(md, 8, Date.parse('2026-08-11T14:49:00.000Z')),
          sessionID,
        )
        assert.equal(panelList.length, 0, 'no active session → panel is empty, never cross-session')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'panel scope: header/ceiling count ONLY the active-session (filtered) list',
    async () => {
      const mine = panEntry({ sessionID: 'ses_root', taskID: 'ses_a', state: 'running' })
      const mineNat = natEntry({ sessionID: 'ses_root', taskID: 'ses_nat', state: 'running' })
      const theirs = panEntry({ sessionID: 'ses_other', taskID: 'ses_b', state: 'running' })
      const scoped = filterDelegationsToSession([mine, mineNat, theirs], 'ses_root')
      assert.equal(scoped.length, 2, 'other-session row dropped before counting')
      const { visible, hidden } = ceilingDelegationList(scoped, 8, 50_000)
      assert.equal(visible.length, 2)
      assert.equal(hidden, 0)
      assert.ok(
        visible.every((e) => e.sessionID === 'ses_root'),
        'no non-navigable other-session row can render',
      )
      assert.equal(formatDelegationHeader(scoped), '(2 active \u00b7 0 done)')
    },
  )

  await testAsync('scope: md entry from ANOTHER session is never shown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-root-'))
    try {
      const deleg = join(root, '.pantheon', 'delegations')
      const theirs = join(deleg, 'ses_other')
      mkdirSync(theirs, { recursive: true })
      writeFileSync(join(theirs, 'apo-1.md'), COMPLETED_MD)
      const md = await readAllDelegationEntries(root)
      assert.equal(md.length, 1, 'precondition: md read from disk')
      assert.equal(md[0]?.sessionID, 'ses_other')
      assert.equal(filterDelegationsToSession(md, 'ses_root').length, 0)
      assert.equal(filterDelegationsToSession(md, 'ses_other').length, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await testAsync('scope: entry without an attributable sessionID is discarded', async () => {
    const orphan = delegation({ sessionID: '', taskID: 'ses_orphan' })
    assert.equal(filterDelegationsToSession([orphan], 'ses_root').length, 0)
    assert.equal(filterDelegationsToSession([orphan], '').length, 0)
    assert.equal(filterDelegationsToSession([orphan], null).length, 0)
  })

  await testAsync('scope: native children of the active session survive the filter', async () => {
    const entries = childrenToDelegationEntries(
      [{ id: 'ses_nat_1', title: 'Nativa', status: 'busy', time: { created: 100 } }],
      [],
      10_000,
      'ses_root',
    )
    const scoped = filterDelegationsToSession(entries, 'ses_root')
    assert.equal(scoped.length, 1, 'native child must NOT be discarded')
    assert.equal(scoped[0]?.taskID, 'ses_nat_1')
    assert.equal(scoped[0]?.sessionID, 'ses_root')
    assert.equal(scoped[0]?.source, 'children-only')
  })

  await testAsync('scope: active session changes → list follows', async () => {
    const a = delegation({ sessionID: 'ses_root', taskID: 'ses_a', alias: 'a-1' })
    const b = delegation({ sessionID: 'ses_other', taskID: 'ses_b', alias: 'b-1' })
    const all = [a, b]
    assert.deepEqual(
      filterDelegationsToSession(all, 'ses_root').map((e) => e.taskID),
      ['ses_a'],
    )
    assert.deepEqual(
      filterDelegationsToSession(all, 'ses_other').map((e) => e.taskID),
      ['ses_b'],
    )
    assert.equal(filterDelegationsToSession(all, null).length, 0)
  })

  await testAsync(
    'children: unscoped report-less child is discarded by the active-session filter',
    async () => {
      const entries = childrenToDelegationEntries(
        [{ id: 'ses_nat_1', title: 'Nativa', status: 'busy', time: { created: 100 } }],
        [],
        10_000,
      )
      assert.equal(entries[0]?.sessionID, '')
      assert.equal(filterDelegationsToSession(entries, 'ses_root').length, 0)
      assert.equal(filterDelegationsToSession(entries, null).length, 0)
    },
  )

  await testAsync(
    'scope: full pipeline (children+md+live) filtered to the active session',
    async () => {
      const active = 'ses_root'
      const md = [
        delegation({ sessionID: active, taskID: 'ses_child_1', alias: 'apo-1', source: 'md' }),
        delegation({ sessionID: 'ses_other', taskID: 'ses_other_1', alias: 'apo-9', source: 'md' }),
      ]
      const children = childrenToDelegationEntries(
        [{ id: 'ses_child_1', title: 'mine', status: 'busy', time: { created: 100 } }],
        md,
        10_000,
        active,
      )
      const live: LiveDelegationEntry[] = [
        {
          callID: 'call_mine_1',
          partID: 'part_mine_1',
          sessionID: active,
          tool: 'task',
          agent: 'apollo',
          description: 'mine live',
          alias: 'apo-2',
          taskID: 'ses_child_2',
          state: 'running',
          startedAt: 100,
          updatedAt: null,
        },
        {
          callID: 'call_theirs_1',
          partID: 'part_theirs_1',
          sessionID: 'ses_other',
          tool: 'task',
          agent: 'hermes',
          description: 'theirs live',
          alias: 'her-1',
          taskID: 'ses_other_2',
          state: 'running',
          startedAt: 100,
          updatedAt: null,
        },
      ]
      const final = filterDelegationsToSession(mergeChildDelegationSources(children, live), active)
      assert.ok(final.length > 0, 'active-session rows survive')
      assert.ok(
        final.every((e) => e.sessionID === active),
        'every rendered row belongs to the active session',
      )
      assert.ok(
        !final.some((e) => e.taskID === 'ses_other_1' || e.taskID === 'ses_other_2'),
        'other-session rows dropped after all merges',
      )
    },
  )

  // ─── Session resolution + orphan-navigation defence ───────────────────

  await testAsync('sessionID: valid / undefined / empty / absent resolution', async () => {
    assert.equal(resolveCurrentSessionID({ sessionID: 'ses_abc123', api: undefined }), 'ses_abc123')
    assert.equal(resolveCurrentSessionID({ sessionID: undefined }), null)
    assert.equal(resolveCurrentSessionID({ sessionID: '' }), null)
    assert.equal(resolveCurrentSessionID({}), null)
    assert.equal(resolveCurrentSessionID(null), null)
  })

  await testAsync(
    'sessionID: placeholder (literal + URL-encoded) → null, falls through to a valid source',
    async () => {
      assert.equal(resolveCurrentSessionID({ sessionID: '{sessionID}' }), null)
      assert.equal(resolveCurrentSessionID({ sessionID: ' {sessionID} ' }), null)
      assert.equal(resolveCurrentSessionID({ sessionID: '%7BsessionID%7D' }), null)
      assert.equal(
        resolveCurrentSessionID({
          sessionID: '%7BsessionID%7D',
          api: { state: { sessionID: 'ses_x' } },
        }),
        'ses_x',
        'placeholder prop falls through to the next valid source',
      )
    },
  )

  await testAsync('sessionID: isValidSessionId + non-ses garbage → null', async () => {
    assert.equal(isValidSessionId('{sessionID}'), false, 'literal placeholder rejected')
    assert.equal(isValidSessionId('%7BsessionID%7D'), false, 'URL-encoded placeholder rejected')
    assert.equal(isValidSessionId(' {sessionID} '), false)
    assert.equal(isValidSessionId('ses_00eb66a34ffeCHnzDx5hH2BCsS'), true)
    assert.equal(isValidSessionId(''), false)
    assert.equal(isValidSessionId(undefined), false)
    assert.equal(isValidSessionId(42), false)
    assert.equal(resolveCurrentSessionID({ sessionID: 'wrk_123' }), null)
    assert.equal(resolveCurrentSessionID({ sessionID: 'foo-bar' }), null)
    assert.equal(resolveCurrentSessionID({ sessionID: 42 }), null)
  })

  await testAsync(
    'path: safeSessionPath/buildChildrenPath emit the v2 { sessionID } shape',
    async () => {
      // REGRESSION: the TUI client is @opencode-ai/sdk/v2, whose session
      // methods take a FLAT { sessionID } object. The old v1
      // { path: { id } } envelope left the v2 URL template unsubstituted
      // ("/session/%7BsessionID%7D/children") and the panel stayed empty.
      assert.deepEqual(safeSessionPath('ses_x'), { sessionID: 'ses_x' })
      assert.deepEqual(buildChildrenPath('ses_x'), { sessionID: 'ses_x' })
      assert.deepEqual(buildChildrenPath('ses_00eb66a34ffeCHnzDx5hH2BCsS'), {
        sessionID: 'ses_00eb66a34ffeCHnzDx5hH2BCsS',
      })
      // exact shape: no v1 `path` envelope, no extra keys
      assert.deepEqual(Object.keys(safeSessionPath('ses_x') ?? {}), ['sessionID'])

      assert.equal(safeSessionPath(null), null)
      assert.equal(safeSessionPath(undefined), null)
      assert.equal(safeSessionPath(''), null)
      assert.equal(safeSessionPath(42), null)
      assert.equal(safeSessionPath('{sessionID}'), null)
      assert.equal(safeSessionPath('%7BsessionID%7D'), null)
      assert.equal(safeSessionPath('wrk_123'), null)
      assert.equal(buildChildrenPath(null), null)
      assert.equal(buildChildrenPath(undefined), null)
      assert.equal(buildChildrenPath('{sessionID}'), null)
    },
  )

  await testAsync(
    'sessionID: slot prop wins over state and route; invalid falls through',
    async () => {
      const api = {
        state: { sessionID: 'ses_state1' },
        route: { current: { name: 'session', params: { sessionID: 'ses_route1' } } },
      }
      assert.equal(resolveCurrentSessionID({ sessionID: 'ses_prop1', api }), 'ses_prop1')
      assert.equal(resolveCurrentSessionID({ sessionID: '{sessionID}', api }), 'ses_state1')
      const routeOnly = {
        state: { sessionID: undefined },
        route: { current: { name: 'session', params: { sessionID: 'ses_route1' } } },
      }
      assert.equal(resolveCurrentSessionID({ sessionID: '', api: routeOnly }), 'ses_route1')
    },
  )

  await testAsync(
    'regression: placeholder sessionID → resolution null (fetch skipped)',
    async () => {
      const sessionID = resolveCurrentSessionID({ sessionID: '{sessionID}' })
      assert.equal(sessionID, null, 'placeholder never resolves to a fetchable id')
    },
  )

  await testAsync(
    'navigate: orphan defence — no route / missing taskID / failures contained',
    async () => {
      const calls: Array<[string, Record<string, unknown> | undefined]> = []
      const route = {
        navigate: (name: string, params?: Record<string, unknown>) => calls.push([name, params]),
      }
      assert.equal(navigateToDelegationSession(route, 'ses_child_9'), true)
      assert.deepEqual(calls, [['session', { sessionID: 'ses_child_9' }]])

      assert.equal(navigateToDelegationSession(undefined, 'ses_child_9'), false, 'no route → false')
      assert.equal(
        navigateToDelegationSession({}, 'ses_child_9'),
        false,
        'route without navigate → false',
      )
      const noop: string[] = []
      const routeNoTarget = { navigate: (name: string) => noop.push(name) }
      assert.equal(navigateToDelegationSession(routeNoTarget, undefined), false)
      assert.equal(navigateToDelegationSession(routeNoTarget, ''), false)
      assert.deepEqual(noop, [], 'navigate must never be called without a taskID')

      assert.equal(
        navigateToDelegationSession(
          {
            navigate: () => {
              throw new Error('Session not found')
            },
          },
          'ses_orphaned',
        ),
        false,
        'synchronous router failure is contained',
      )

      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)
      try {
        assert.equal(
          navigateToDelegationSession(
            { navigate: () => Promise.reject(new Error('Session not found')) },
            'ses_orphaned',
          ),
          true,
        )
        await new Promise<void>((resolve) => setImmediate(resolve))
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
      assert.deepEqual(unhandled, [], 'rejected router promise is contained')
    },
  )

  await testAsync('navigate: row mouse handler invokes navigation helper', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const open = createDelegationRowOpenHandler(
      { navigate: (name: string, params?: Record<string, unknown>) => calls.push([name, params]) },
      'ses_event_child',
    )
    open()
    assert.deepEqual(calls, [['session', { sessionID: 'ses_event_child' }]])
  })

  // ─── Source-scan: session-API call sites stay guarded ─────────────────

  await testAsync(
    'source-scan: every session.children / session.status call site is id-guarded',
    async () => {
      const source = await readFileP(
        new URL('../../src/plugins/tui/src/index.tsx', import.meta.url),
        'utf8',
      )
      const lines = source.split('\n')
      const near = (idx: number, pat: RegExp) =>
        lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 2)).some((l) => pat.test(l))
      const isComment = (line: string) => {
        const t = line.trim()
        return t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*') || t.startsWith('//')
      }

      const childrenSites: number[] = []
      const statusSites: number[] = []
      lines.forEach((line, idx) => {
        if (isComment(line)) return // doc comments mention the API — not call sites
        if (line.includes('session?.children') || line.includes('session.children'))
          childrenSites.push(idx)
        if (line.includes('session?.status')) statusSites.push(idx)
      })

      assert.ok(childrenSites.length >= 1, 'expected ≥1 session.children call site')
      for (const idx of childrenSites) {
        assert.ok(
          near(idx, /buildChildrenPath\(|safeSessionPath\(/),
          `session.children call must be path-guarded (line ${idx + 1}): ${lines[idx]?.trim()}`,
        )
      }
      assert.ok(statusSites.length >= 1, 'expected ≥1 session.status call site')
      for (const idx of statusSites) {
        assert.ok(
          near(idx, /isValidSessionId\(/),
          `session.status call must be id-guarded (line ${idx + 1}): ${lines[idx]?.trim()}`,
        )
      }
    },
  )

  // ─── Removed-tool regression (issue #161) ─────────────────────────────

  await testAsync(
    'regression: removed V1 delegation tool names must not reappear anywhere in src/',
    async () => {
      // pantheon_delegate + pantheon_delegation_read and the V1 delegation
      // motor were removed in v1.5.0. Any surviving reference (source OR the
      // committed dist bundle) is dead weight shipped to users — fail loudly
      // instead of silently rotting. See issue #161.
      const REMOVED = ['pantheon_delegate', 'pantheon_delegation_read']
      const root = fileURLToPath(new URL('../../src/', import.meta.url))
      const bad: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue
          const next = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(next)
            continue
          }
          const text = readFileSync(next, 'utf8')
          for (const name of REMOVED) {
            if (text.includes(name)) bad.push(`${next.slice(root.length)} mentions "${name}"`)
          }
        }
      }
      walk(root)
      assert.deepEqual(
        bad,
        [],
        `removed V1 tool names reappeared in src/ (dead code): ${bad.join(' | ')}`,
      )
    },
  )

  // ─── Stale-running detector ───────────────────────────────────────────

  await testAsync(
    'stale-running: short stays running, long/stale → stale, recent/terminal unchanged',
    async () => {
      const now = Date.now()
      const mk = (over: Partial<DelegationEntry>): DelegationEntry =>
        delegation({
          alias: 't',
          sessionID: 'ses_test',
          agent: 'apollo',
          state: 'running',
          startedAt: now - 60_000,
          updatedAt: null,
          timedOut: false,
          description: 'x',
          ...over,
        })
      const threshold = 30 * 60 * 1000
      assert.equal(markStaleIfRunning(mk({}), now, threshold).state, 'running')
      assert.equal(
        markStaleIfRunning(mk({ startedAt: now - 31 * 60 * 1000 }), now, threshold).state,
        'stale-running',
      )
      assert.equal(
        markStaleIfRunning(
          mk({ startedAt: now - 35 * 60 * 1000, updatedAt: now - 120_000 }),
          now,
          threshold,
        ).state,
        'stale-running',
      )
      assert.equal(
        markStaleIfRunning(
          mk({ startedAt: now - 35 * 60 * 1000, updatedAt: now - 30_000 }),
          now,
          threshold,
        ).state,
        'running',
      )
      assert.equal(
        markStaleIfRunning(mk({ state: 'completed', updatedAt: now }), now, threshold).state,
        'completed',
      )

      const fresh = mk({ alias: 'fresh', startedAt: now - 5 * 60 * 1000 })
      const stale = mk({ alias: 'stale', startedAt: now - 60 * 60 * 1000 })
      const result = visibleDelegationList([fresh, stale], 8, now, threshold)
      assert.equal(result.length, 2)
      assert.equal(result[0]?.state, 'running', 'fresh entry stays running')
      assert.equal(result[1]?.state, 'stale-running', 'stale entry marked as stale-running')
    },
  )

  // ─── Status tone (whole-row color) ────────────────────────────────────

  await testAsync('tone: failed → error, terminal → success, in-flight → warning', async () => {
    // Red = failure.
    assert.equal(delegationStateTone('error'), 'error')
    assert.equal(delegationStateTone('startup_failed'), 'error')
    // Green = terminal (completed or cancelled).
    assert.equal(delegationStateTone('completed'), 'success')
    assert.equal(delegationStateTone('cancelled'), 'success')
    // Yellow = still in flight.
    assert.equal(delegationStateTone('running'), 'warning')
    assert.equal(delegationStateTone('retry'), 'warning')
    assert.equal(delegationStateTone('stale-running'), 'warning')
    assert.equal(delegationStateTone('startup_unknown'), 'warning')
  })

  await testAsync('tone: every display state maps to one of the three status colors', async () => {
    const states = [
      'running',
      'retry',
      'startup_unknown',
      'stale-running',
      'error',
      'startup_failed',
      'completed',
      'cancelled',
    ] as const
    for (const state of states) {
      const tone = delegationStateTone(state)
      assert.ok(
        tone === 'error' || tone === 'success' || tone === 'warning',
        `${state} must map to a status color, got ${String(tone)}`,
      )
    }
  })

  // ─── Spinner frame (decoupled animation) ─────────────────────────────────

  await testAsync('spinner: frame=0 and frame=1 produce different glyphs', async () => {
    const glyph0 = delegationSpinnerFrame(0)
    const glyph1 = delegationSpinnerFrame(1)
    assert.ok(glyph0.length > 0, 'frame 0 must produce a glyph')
    assert.ok(glyph1.length > 0, 'frame 1 must produce a glyph')
    assert.notEqual(glyph0, glyph1, 'consecutive frames must differ')
  })

  await testAsync('spinner: frame counter wraps around the frame array', async () => {
    const frames = 10 // DELEGATION_SPINNER_FRAMES.length
    const glyph0 = delegationSpinnerFrame(0)
    const glyphWrap = delegationSpinnerFrame(frames)
    assert.equal(glyph0, glyphWrap, 'frame N must equal frame 0 after full cycle')
  })

  await testAsync('spinner: negative frame handled via abs()', async () => {
    const glyph = delegationSpinnerFrame(-3)
    assert.ok(glyph.length > 0, 'negative frame must produce a glyph')
    assert.equal(glyph, delegationSpinnerFrame(3), 'abs(-3) must equal 3')
  })

  await testAsync('rowMarker: running state uses spinner frame, not static glyph', async () => {
    const marker0 = delegationRowMarker('running', 0)
    const marker1 = delegationRowMarker('running', 1)
    assert.notEqual(marker0, marker1, 'running markers at different frames must differ')
    assert.ok(marker0.endsWith(' '), 'marker must have trailing space')
  })

  await testAsync('rowMarker: completed state uses static glyph regardless of frame', async () => {
    const marker0 = delegationRowMarker('completed', 0)
    const marker99 = delegationRowMarker('completed', 99)
    assert.equal(marker0, marker99, 'terminal markers are frame-independent')
    assert.ok(marker0.startsWith('✓'), 'completed marker must be ✓')
  })

  // ─── Report ────────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
