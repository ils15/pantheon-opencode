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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile as readFileP } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildChildrenPath,
  type ChildDelegationLike,
  ceilingDelegationList,
  childrenToDelegationEntries,
  childStatusToState,
  collectDelegationToolParts,
  createDelegationRowOpenHandler,
  DELEGATION_DONE_RETENTION_MS,
  DELEGATION_FAILED_RETENTION_MS,
  DELEGATION_VISIBLE_CEILING,
  type DelegationEntry,
  delegationRowIdentity,
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

  const SEED_DELEGATE_RUNNING = {
    id: 'part_seed_1',
    sessionID: 'ses_root',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_seed_1',
    tool: 'pantheon_delegate',
    state: {
      status: 'running',
      input: { agent: 'apollo', prompt: 'find x' },
      time: { start: 1000 },
    },
  }
  const SEED_DELEGATE_COMPLETED = {
    ...SEED_DELEGATE_RUNNING,
    state: {
      status: 'completed',
      input: { agent: 'apollo', prompt: 'find x' },
      output:
        'Delegated to apollo: [apo-1] (task ses_child_9).\nRead with pantheon_delegation_read({ id: "apo-1" }).',
      time: { start: 1000, end: 1500 },
    },
  }
  const SEED_READ_COMPLETED = {
    id: 'part_seed_2',
    sessionID: 'ses_root',
    messageID: 'msg_2',
    type: 'tool',
    callID: 'call_seed_2',
    tool: 'pantheon_delegation_read',
    state: {
      status: 'completed',
      input: { id: 'apo-1' },
      output: '# Delegation Report — apo-1\n\n- **Agent**: apollo\n',
      time: { start: 5000, end: 8000 },
    },
  }

  await testAsync('collect: embedded parts + getParts fallback + fail-open', async () => {
    const messages = [
      {
        id: 'msg_1',
        parts: [
          SEED_DELEGATE_RUNNING,
          { type: 'text', text: 'hi' },
          { type: 'tool', tool: 'bash', state: {} },
        ],
      },
      { id: 'msg_2', parts: [SEED_READ_COMPLETED] },
    ]
    const parts = collectDelegationToolParts(messages)
    assert.equal(parts.length, 2, 'text + bash parts are skipped')
    assert.deepEqual(
      parts.map((p) => p.tool),
      ['pantheon_delegate', 'pantheon_delegation_read'],
    )
    const getParts = (id: string) => (id === 'msg_1' ? [SEED_DELEGATE_RUNNING] : [])
    const fallback = collectDelegationToolParts([{ id: 'msg_1' }, { id: 'msg_2' }], getParts)
    assert.equal(fallback.length, 1)
    assert.equal(fallback[0]?.tool, 'pantheon_delegate')
    assert.deepEqual(
      collectDelegationToolParts([], () => []),
      [],
    )
    assert.deepEqual(collectDelegationToolParts([{ id: 'm1' }], undefined), [])
    assert.deepEqual(collectDelegationToolParts(undefined, undefined), [])
  })

  await testAsync(
    'seed: re-scan from session.messages parts → job restored terminal (compaction recovery)',
    async () => {
      const messages = [
        { id: 'msg_1', parts: [SEED_DELEGATE_RUNNING] },
        { id: 'msg_2', parts: [SEED_DELEGATE_COMPLETED] },
        { id: 'msg_3', parts: [SEED_READ_COMPLETED] },
      ]
      const map = new Map<string, LiveDelegationEntry>()
      const parts = collectDelegationToolParts(messages)
      assert.equal(
        seedLiveDelegationMap(map, parts, 9000),
        3,
        'delegate create + alias absorb + read close = 3 changes',
      )
      const e = map.get('call_seed_1')
      assert.ok(e, 'job restored into the live map on mount')
      assert.equal(e.state, 'completed')
      assert.equal(e.alias, 'apo-1')
      assert.equal(e.taskID, 'ses_child_9')
      assert.equal(e.read, true)
      assert.equal(e.updatedAt, 8000, 'terminal stamped from the read end')
      assert.equal(
        seedLiveDelegationMap(map, collectDelegationToolParts(messages), 9000),
        0,
        're-seeding identical parts is idempotent (no extra bumps)',
      )
    },
  )

  await testAsync('seed: empty + non-pantheon / untargeted parts are no-ops', async () => {
    const map = new Map<string, LiveDelegationEntry>()
    assert.equal(seedLiveDelegationMap(map, []), 0)
    assert.equal(map.size, 0)
    const changed = seedLiveDelegationMap(map, [
      { type: 'text', text: 'x' },
      { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running' } },
      {
        type: 'tool',
        tool: 'pantheon_delegation_read',
        callID: 'c2',
        state: { status: 'running', input: { id: 'nope' } },
      },
    ])
    assert.equal(changed, 0, 'read without a target delegate is a no-op')
    assert.equal(map.size, 0)
  })

  // ─── Live tool-part lifecycle (agent-sidebar pattern) ──────────────────

  const DELEGATE_RUNNING_PART = {
    id: 'part_deleg_1',
    sessionID: 'ses_root',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_deleg_1',
    tool: 'pantheon_delegate',
    state: {
      status: 'running',
      input: { agent: 'apollo', prompt: 'find x', description: 'Busca' },
      time: { start: 1000 },
    },
  }
  const DELEGATE_COMPLETED_PART = {
    id: 'part_deleg_1',
    sessionID: 'ses_root',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_deleg_1',
    tool: 'pantheon_delegate',
    state: {
      status: 'completed',
      input: { agent: 'apollo', prompt: 'find x' },
      output:
        'Delegated to apollo: [apo-1] (task ses_child_9).\n' +
        'Read the result with pantheon_delegation_read({ id: "apo-1" }).',
      time: { start: 1000, end: 1500 },
    },
  }
  const READ_RUNNING_PART = {
    id: 'part_read_1',
    sessionID: 'ses_root',
    messageID: 'msg_2',
    type: 'tool',
    callID: 'call_read_1',
    tool: 'pantheon_delegation_read',
    state: { status: 'running', input: { id: 'apo-1' }, time: { start: 5000 } },
  }
  const READ_COMPLETED_PART = {
    id: 'part_read_1',
    sessionID: 'ses_root',
    messageID: 'msg_2',
    type: 'tool',
    callID: 'call_read_1',
    tool: 'pantheon_delegation_read',
    state: {
      status: 'completed',
      input: { id: 'apo-1' },
      output: '# Delegation Report — apo-1\n\n- **Agent**: apollo\n',
      time: { start: 5000, end: 8000 },
    },
  }
  const READ_ERROR_PART = {
    id: 'part_read_1',
    sessionID: 'ses_root',
    messageID: 'msg_2',
    type: 'tool',
    callID: 'call_read_1',
    tool: 'pantheon_delegation_read',
    state: {
      status: 'error',
      input: { id: 'apo-1' },
      error: 'read timed out',
      time: { start: 5000, end: 9000 },
    },
  }

  await testAsync(
    'parse: delegate running + completed parts → agent/status/times + alias/taskID from output',
    async () => {
      const running = parseDelegationToolPart(DELEGATE_RUNNING_PART, 2000)
      assert.ok(running, 'delegate running part must parse')
      assert.equal(running.tool, 'pantheon_delegate')
      assert.equal(running.callID, 'call_deleg_1')
      assert.equal(running.agent, 'apollo')
      assert.equal(running.description, 'Busca')
      assert.equal(running.status, 'running')
      assert.equal(running.startedAt, 1000, 'startedAt comes from state.time.start')
      assert.equal(running.alias, null)

      const completed = parseDelegationToolPart(DELEGATE_COMPLETED_PART, 2000)
      assert.ok(completed)
      assert.equal(completed.status, 'completed')
      assert.equal(completed.alias, 'apo-1', 'alias parsed from "[apo-1]" in the output')
      assert.equal(completed.taskID, 'ses_child_9', 'taskID parsed from "(task ses_...)"')
      assert.equal(completed.endAt, 1500)
    },
  )

  await testAsync(
    'parse: read part (alias / taskID), pending fallback to now, non-pantheon → null',
    async () => {
      const p = parseDelegationToolPart(READ_RUNNING_PART, 6000)
      assert.ok(p, 'read part must parse')
      assert.equal(p.tool, 'pantheon_delegation_read')
      assert.equal(p.alias, 'apo-1', 'alias comes from input.id')
      assert.equal(p.agent, null)
      const byTask = parseDelegationToolPart(
        {
          ...READ_RUNNING_PART,
          state: { status: 'running', input: { id: 'ses_child_9' }, time: { start: 5000 } },
        },
        6000,
      )
      assert.ok(byTask)
      assert.equal(byTask.alias, null)
      assert.equal(byTask.taskID, 'ses_child_9')

      const pending = parseDelegationToolPart(
        {
          id: 'part_deleg_2',
          sessionID: 'ses_root',
          messageID: 'msg_1',
          type: 'tool',
          callID: 'call_deleg_2',
          tool: 'pantheon_delegate',
          state: { status: 'pending', input: { agent: 'zeus' } },
        },
        4242,
      )
      assert.ok(pending)
      assert.equal(pending.status, 'pending')
      assert.equal(pending.startedAt, 4242)

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
      assert.equal(parseDelegationToolPart({ type: 'tool', tool: 'pantheon_delegate' }), null)
    },
  )

  await testAsync(
    'reduce: delegate completing only means LAUNCHED — entry stays running with alias',
    async () => {
      const map = new Map<string, LiveDelegationEntry>()
      assert.equal(reduceDelegationToolPart(map, DELEGATE_RUNNING_PART, 2000), true, 'create')
      let e = map.get('call_deleg_1')
      assert.ok(e)
      assert.equal(e.state, 'running')
      assert.equal(e.agent, 'apollo')
      assert.equal(e.startedAt, 1000)
      assert.equal(e.alias, null)

      assert.equal(reduceDelegationToolPart(map, DELEGATE_COMPLETED_PART, 2000), true, 'alias')
      e = map.get('call_deleg_1')
      assert.ok(e)
      assert.equal(
        e.state,
        'running',
        'delegate tool completing only means the job LAUNCHED — still running',
      )
      assert.equal(e.alias, 'apo-1')
      assert.equal(e.taskID, 'ses_child_9')
      assert.equal(e.updatedAt, null)
    },
  )

  await testAsync(
    'reduce: read closes the entry at the read end (once); read error → error',
    async () => {
      const map = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(map, DELEGATE_RUNNING_PART, 2000)
      reduceDelegationToolPart(map, DELEGATE_COMPLETED_PART, 2000)
      const e = map.get('call_deleg_1')
      assert.ok(e)
      assert.equal(e.read, false)

      assert.equal(reduceDelegationToolPart(map, READ_RUNNING_PART, 6000), true)
      assert.equal(e.read, true, 'read start marks the delegation as read')
      assert.equal(e.state, 'running', 'read blocks until terminal — still running')

      assert.equal(reduceDelegationToolPart(map, READ_COMPLETED_PART, 9000), true)
      assert.equal(e.state, 'completed')
      assert.equal(e.updatedAt, 8000, 'job duration = read end (blocks until terminal)')
      assert.equal(reduceDelegationToolPart(map, READ_COMPLETED_PART, 10000), false)
      assert.equal(e.updatedAt, 8000, 'terminal timestamp is stamped only once')

      const map2 = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(map2, DELEGATE_RUNNING_PART, 2000)
      reduceDelegationToolPart(map2, DELEGATE_COMPLETED_PART, 2000)
      const e2 = map2.get('call_deleg_1')
      assert.ok(e2)
      assert.equal(reduceDelegationToolPart(map2, READ_ERROR_PART, 9500), true)
      assert.equal(e2.state, 'error')
      assert.equal(e2.updatedAt, 9000)
      assert.equal(e2.read, true)
    },
  )

  await testAsync(
    'remove + toDelegationEntry: cleanup by partID/callID, alias fallback',
    async () => {
      const byPart = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(byPart, DELEGATE_RUNNING_PART, 2000)
      assert.equal(removeDelegationEntry(byPart, 'part_deleg_1'), true, 'partID matches')
      assert.equal(byPart.size, 0)

      const byCall = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(byCall, DELEGATE_RUNNING_PART, 2000)
      assert.equal(removeDelegationEntry(byCall, 'call_deleg_1'), true, 'callID matches')
      assert.equal(removeDelegationEntry(byCall, 'nope'), false, 'unknown → unchanged')

      const live: LiveDelegationEntry = {
        callID: 'call_1',
        partID: 'part_1',
        sessionID: 'ses_root',
        tool: 'pantheon_delegate',
        agent: 'apollo',
        description: 'Busca',
        alias: 'apo-1',
        taskID: 'ses_child_9',
        state: 'running',
        startedAt: 1000,
        updatedAt: null,
        read: false,
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
    tool: 'pantheon_delegate',
    agent: 'apollo',
    description: 'Busca',
    alias: 'apo-1',
    taskID: null,
    state: 'running',
    startedAt: 1000,
    updatedAt: null,
    read: false,
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
      // entry from the delegate tool part is still 'running' (it only
      // transitions on pantheon_delegation_read). The merge must NOT
      // overwrite the terminal children-only state with the stale live state.
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
        read: false,
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
    'children: childStatusToState — busy→running, retry→retry, idle→completed, unknown→running',
    async () => {
      assert.equal(childStatusToState('busy'), 'running')
      assert.equal(childStatusToState('retry'), 'retry')
      assert.equal(childStatusToState('idle'), 'completed')
      assert.equal(childStatusToState(undefined), 'running', 'no status → running (fail-open)')
      assert.equal(childStatusToState('weird'), 'running', 'unknown status → running (fail-open)')
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
          SEED_DELEGATE_RUNNING,
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
    assert.equal(parts.length, 2, 'delegate + task parts collected, text skipped')
    assert.deepEqual(
      parts.map((p) => p.tool),
      ['pantheon_delegate', 'task'],
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
          tool: 'pantheon_delegate',
          agent: 'apollo',
          description: 'mine live',
          alias: 'apo-2',
          taskID: 'ses_child_2',
          state: 'running',
          startedAt: 100,
          updatedAt: null,
          read: false,
        },
        {
          callID: 'call_theirs_1',
          partID: 'part_theirs_1',
          sessionID: 'ses_other',
          tool: 'pantheon_delegate',
          agent: 'hermes',
          description: 'theirs live',
          alias: 'her-1',
          taskID: 'ses_other_2',
          state: 'running',
          startedAt: 100,
          updatedAt: null,
          read: false,
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
