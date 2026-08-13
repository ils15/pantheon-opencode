/**
 * Tests for the TUI sidebar Delegations panel channel — the markdown reports
 * the job board persists under `.pantheon/delegations/<sessionID>/<alias>.md`
 * (written by src/pantheon/delegation-finalize.ts `renderDelegationMarkdown`).
 *
 * The TUI never touches the in-memory board; it only reads these files via
 * the pure `parseDelegationMarkdown` / `readDelegationEntries` helpers. These
 * tests cover the parse contract (running / terminal / timedOut / malformed /
 * missing) using real report shapes written by the finalize module.
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
  childrenToDelegationEntries,
  childStatusToState,
  collectDelegationToolParts,
  type DelegationEntry,
  delegationActivity,
  delegationActivityLabel,
  delegationElapsed,
  delegationSpinnerFrame,
  delegationTag,
  fmtElapsed,
  isValidSessionId,
  type LiveDelegationEntry,
  mergeChildDelegationSources,
  mergeDelegationSources,
  navigateToDelegationSession,
  panelLogDir,
  parseDelegationMarkdown,
  parseDelegationToolPart,
  readAllDelegationEntries,
  readDelegationEntries,
  reduceDelegationToolPart,
  removeDelegationEntry,
  resolveCurrentSessionID,
  resolveDelegationsDir,
  seedLiveDelegationMap,
  toDelegationEntry,
  tuiLogPath,
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

  await testAsync('parse: running report → updatedAt null, timedOut false', async () => {
    const e = parseDelegationMarkdown(RUNNING_MD, 'apo-5.md')
    assert.ok(e, 'running report must parse')
    assert.equal(e.alias, 'apo-5')
    assert.equal(e.state, 'running')
    assert.equal(e.updatedAt, null, 'running job has no Finalized timestamp')
    assert.equal(e.timedOut, false)
    assert.equal(e.startedAt, Date.parse('2026-08-11T15:00:00.000Z'))
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

  await testAsync('parse: malformed file → null (skip)', async () => {
    assert.equal(parseDelegationMarkdown(MALFORMED_MD, 'bad.md'), null)
    assert.equal(parseDelegationMarkdown('', 'empty.md'), null)
  })

  await testAsync('parse: missing required headers → null even with filename', async () => {
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
  })

  await testAsync('parse: no H1 title → alias falls back to filename', async () => {
    const e = parseDelegationMarkdown(
      '- **Agent**: zeus\n- **State**: completed\n- **Started**: 2026-08-11T15:00:00.000Z\n',
      'ze-1.md',
    )
    assert.ok(e, 'report without H1 must parse via filename alias')
    assert.equal(e.alias, 'ze-1')
  })

  // ─── Security: ReDoS regression (CodeQL 12x HIGH on the old regex parser) ─

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

  await testAsync('parse: ** inside values + empty fields do not break parsing', async () => {
    // (b) ** and **: inside a value must be preserved, not confuse the parser.
    const e = parseDelegationMarkdown(
      '# Delegation Report — apo-1\n' +
        '- **Agent**: apollo\n' +
        '- **Description**: watch out for **bold** and **: colons\n' +
        '- **State**: completed\n' +
        '- **Started**: 2026-08-11T14:46:13.477Z\n',
      'apo-1.md',
    )
    assert.ok(e, 'report with ** inside values must parse')
    assert.equal(e.description, 'watch out for **bold** and **: colons')

    // Empty required-field value → missing (no cross-line regex leak).
    assert.equal(
      parseDelegationMarkdown(
        '- **Agent**:\n- **State**: completed\n- **Started**: 2026-08-11T15:00:00.000Z\n',
        'x.md',
      ),
      null,
      'empty Agent value must be treated as missing',
    )

    // Empty title after separator → alias falls back to the filename.
    const e2 = parseDelegationMarkdown(
      '# Delegation Report —\n- **Agent**: a\n- **State**: completed\n- **Started**: 2026-08-11T15:00:00.000Z\n',
      'ze-9.md',
    )
    assert.ok(e2, 'report with empty title must still parse')
    assert.equal(e2.alias, 'ze-9', 'empty title falls back to filename alias')

    // Timed out keeps the old prefix semantics: `true`-prefixed → true, else false.
    const e3 = parseDelegationMarkdown(
      '- **Agent**: a\n- **State**: error\n- **Timed out**: trueX\n- **Started**: 2026-08-11T15:00:00.000Z\n',
    )
    assert.ok(e3)
    assert.equal(e3.timedOut, true, '`trueX` is prefix-matched as true')
    const e4 = parseDelegationMarkdown(
      '- **Agent**: a\n- **State**: error\n- **Timed out**: True\n- **Started**: 2026-08-11T15:00:00.000Z\n',
    )
    assert.ok(e4)
    assert.equal(e4.timedOut, false, '`True` is not matched (case-sensitive)')
  })

  // ─── readDelegationEntries (directory channel) ─────────────────────────

  await testAsync('read: missing directory → [] (fail-open)', async () => {
    const entries = await readDelegationEntries(join(tmpdir(), 'pantheon-tui-test-does-not-exist'))
    assert.deepEqual(entries, [])
  })

  await testAsync(
    'read: tmp tree with mixed reports → sorted running-first, malformed skipped',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'pantheon-tui-deleg-'))
      try {
        const ses = join(tmp, 'ses_abc')
        const other = join(tmp, 'ses_def')
        mkdirSync(ses)
        mkdirSync(other)
        writeFileSync(join(ses, 'apo-1.md'), COMPLETED_MD)
        writeFileSync(join(ses, 'apo-5.md'), RUNNING_MD)
        writeFileSync(join(other, 'her-7.md'), TIMED_OUT_MD)
        writeFileSync(join(other, 'malformed.md'), MALFORMED_MD) // must be skipped
        writeFileSync(join(other, 'notes.txt'), 'not a report') // non-md ignored
        // A plain file at the top level (not a session dir) must be ignored.
        writeFileSync(join(tmp, 'README.md'), '# not a session')

        const entries = await readDelegationEntries(tmp)
        assert.equal(entries.length, 3, 'only the 3 valid reports are read')
        assert.deepEqual(
          entries.map((e) => e.alias),
          ['apo-5', 'her-7', 'apo-1'],
          'running first, then terminal by recency (Finalized desc)',
        )
        const running = entries[0]
        assert.ok(running)
        assert.equal(running.state, 'running')
        const timedOut = entries[1]
        assert.ok(timedOut)
        assert.equal(timedOut.state, 'error')
        assert.equal(timedOut.timedOut, true)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync('read: garbage-only directory yields [] (fail-open, never crash)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pantheon-tui-deleg-'))
    try {
      mkdirSync(join(tmp, 'ses_garbage'))
      writeFileSync(join(tmp, 'ses_garbage', 'junk.md'), '\uFFFD\uFFFD\uFFFD')
      const entries = await readDelegationEntries(tmp)
      assert.equal(entries.length, 0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // ─── panelLogDir + tuiLogPath (double-path fix) ─────────────────────────
  // Regression: the View created the logger with `dirname(delegationsDir())`
  // (= <root>/.pantheon), so createTuiLogger joined `.pantheon/logs/hooks.log`
  // onto it → <root>/.pantheon/.pantheon/logs/hooks.log — a nested empty dir
  // that the real hooks.log never saw. panelLogDir(delegationsDir) returns
  // the PROJECT ROOT so the logger lands on the real <root>/.pantheon/logs.

  await testAsync(
    'panelLogDir: delegations dir → project root (kills the .pantheon/.pantheon nesting)',
    async () => {
      assert.equal(
        panelLogDir('/repos/acme/.pantheon/delegations'),
        '/repos/acme',
        'absolute delegations dir → project root',
      )
      assert.equal(panelLogDir('.pantheon/delegations'), '.', 'relative dir → cwd root')
      assert.equal(
        panelLogDir('/repos/acme/.pantheon/delegations'),
        '/repos/acme',
        'always yields the root, never a .pantheon-level dir',
      )
    },
  )

  await testAsync(
    'tuiLogPath: logger appends to <root>/.pantheon/logs/hooks.log (the REAL file)',
    async () => {
      assert.equal(tuiLogPath('/repos/acme'), '/repos/acme/.pantheon/logs/hooks.log')
      // Full chain: the View derives root from the delegations dir, then the
      // logger writes .pantheon/logs/hooks.log under it — NOT the nested
      // .pantheon/.pantheon/logs/hooks.log the bug produced.
      assert.equal(
        tuiLogPath(panelLogDir('/repos/acme/.pantheon/delegations')),
        '/repos/acme/.pantheon/logs/hooks.log',
      )
      assert.ok(
        !tuiLogPath(panelLogDir('/repos/acme/.pantheon/delegations')).includes(
          '.pantheon/.pantheon',
        ),
        'no double-nested .pantheon in the final log path',
      )
    },
  )

  // ─── readAllDelegationEntries (history across ALL sessions) ─────────────
  // The View reads reports from EVERY session subdir under
  // <root>/.pantheon/delegations/*/<alias>.md — the panel shows the full
  // delegation history even when no sessionID resolves (no focused session).

  await testAsync(
    'readAll: aggregates reports from MULTIPLE session subdirs, sorted running-first',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-root-'))
      try {
        const deleg = join(root, '.pantheon', 'delegations')
        const sesA = join(deleg, 'ses_aaa')
        const sesB = join(deleg, 'ses_bbb')
        mkdirSync(sesA, { recursive: true })
        mkdirSync(sesB, { recursive: true })
        writeFileSync(join(sesA, 'apo-1.md'), COMPLETED_MD) // terminal, older
        writeFileSync(join(sesB, 'her-7.md'), TIMED_OUT_MD) // terminal, newer
        writeFileSync(join(sesA, 'apo-5.md'), RUNNING_MD) // running → first

        const entries = await readAllDelegationEntries(root)
        assert.equal(entries.length, 3, 'all sessions aggregated')
        assert.deepEqual(
          entries.map((e) => e.alias),
          ['apo-5', 'her-7', 'apo-1'],
          'running first, then terminal by Finalized desc across sessions',
        )
        // sessionID comes from each report's own session dir.
        assert.equal(entries[2]?.sessionID, 'ses_aaa')
        assert.equal(entries[1]?.sessionID, 'ses_bbb')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  await testAsync('readAll: root without delegations dir → [] (fail-open)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-root-'))
    try {
      assert.deepEqual(await readAllDelegationEntries(root), [])
      assert.deepEqual(
        await readAllDelegationEntries(join(tmpdir(), 'pantheon-tui-root-does-not-exist')),
        [],
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // ─── resolveDelegationsDir (md channel root resolution) ─────────────
  // The board writes `.pantheon/delegations` RELATIVE to the server cwd
  // (= TuiState.path.directory). `project` does NOT exist on TuiState.path
  // and `worktree` is `/` when there is no git (e.g. the sandbox test
  // project) — a root of `''` or `'/'` must fall back to `process.cwd()`.
  // An explicit `cwd` param keeps these tests deterministic.

  await testAsync('resolve: worktree "/" (no git) → cwd fallback', async () => {
    assert.equal(
      resolveDelegationsDir({ worktree: '/' }, '/srv/opencode'),
      join('/srv/opencode', '.pantheon', 'delegations'),
      'root "/" must not produce "/.pantheon/delegations"',
    )
  })

  await testAsync('resolve: valid worktree dir → join(worktree)', async () => {
    assert.equal(
      resolveDelegationsDir({ worktree: '/repos/acme' }, '/srv/opencode'),
      join('/repos/acme', '.pantheon', 'delegations'),
    )
  })

  await testAsync('resolve: directory present (no project) → uses directory', async () => {
    assert.equal(
      resolveDelegationsDir({ directory: '/proj/site' }, '/srv/opencode'),
      join('/proj/site', '.pantheon', 'delegations'),
      'directory wins when present (board writes relative to the server cwd)',
    )
  })

  await testAsync('resolve: directory beats worktree "/" (sandbox case)', async () => {
    assert.equal(
      resolveDelegationsDir({ directory: '/proj/site', worktree: '/' }, '/srv/opencode'),
      join('/proj/site', '.pantheon', 'delegations'),
    )
  })

  await testAsync('resolve: empty state object → cwd fallback', async () => {
    assert.equal(
      resolveDelegationsDir({}, '/srv/opencode'),
      join('/srv/opencode', '.pantheon', 'delegations'),
    )
  })

  await testAsync('resolve: undefined state → cwd fallback', async () => {
    assert.equal(
      resolveDelegationsDir(undefined, '/srv/opencode'),
      join('/srv/opencode', '.pantheon', 'delegations'),
    )
  })

  await testAsync('resolve: legacy "project" field ignored (not on TuiState.path)', async () => {
    // `project` is not part of TuiState.path — the old resolution read it
    // via `state?.project` which was always undefined. Passing it must not
    // change the result (directory/worktree still rule, else cwd).
    assert.equal(
      resolveDelegationsDir(
        { project: '/proj/site' } as unknown as { directory?: string; worktree?: string },
        '/srv/opencode',
      ),
      join('/srv/opencode', '.pantheon', 'delegations'),
      'project-only state falls back to cwd (field does not exist in the type)',
    )
  })

  // ─── collectDelegationToolParts + seedLiveDelegationMap (mount re-scan) ─
  // `message.part.removed` (compaction) clears live entries; on mount the
  // panel re-seeds the live map from the session's EXISTING tool parts via
  // `api.state.session.messages(sessionID)` so pós-compaction/attach the
  // panel still shows jobs. Extraction + reduction are pure helpers tested
  // here with a mocked messages array (the SDK method is synchronous).

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

  await testAsync('collect: embedded parts → only pantheon tool parts', async () => {
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
  })

  await testAsync('collect: messages without parts → getParts(msg.id) fallback', async () => {
    const messages = [{ id: 'msg_1' }, { id: 'msg_2' }]
    const getParts = (id: string) => (id === 'msg_1' ? [SEED_DELEGATE_RUNNING] : [])
    const parts = collectDelegationToolParts(messages, getParts)
    assert.equal(parts.length, 1)
    assert.equal(parts[0]?.tool, 'pantheon_delegate')
  })

  await testAsync('collect: no parts anywhere → [] (fail-open)', async () => {
    assert.deepEqual(
      collectDelegationToolParts([], () => []),
      [],
    )
    assert.deepEqual(collectDelegationToolParts([{ id: 'm1' }], undefined), [])
    assert.deepEqual(collectDelegationToolParts(undefined, undefined), [])
  })

  await testAsync('seed: empty parts → 0 changes, map untouched', async () => {
    const map = new Map<string, LiveDelegationEntry>()
    assert.equal(seedLiveDelegationMap(map, []), 0)
    assert.equal(map.size, 0)
  })

  await testAsync(
    'seed: re-scan from session.messages parts → job restored terminal (compaction recovery)',
    async () => {
      // Simulates: state.session.messages(sessionID) → collect → seed, the
      // exact mount path. The delegate runs, completes (alias), read blocks
      // until terminal → entry closes at the read end timestamp.
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

  await testAsync('seed: non-pantheon parts skipped, unknown tools no-op', async () => {
    const map = new Map<string, LiveDelegationEntry>()
    const skippedParts = [
      { type: 'text', text: 'x' },
      { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running' } },
      {
        type: 'tool',
        tool: 'pantheon_delegation_read',
        callID: 'c2',
        state: { status: 'running', input: { id: 'nope' } },
      },
    ]
    const changed = seedLiveDelegationMap(map, skippedParts)
    assert.equal(changed, 0, 'read without a target delegate is a no-op')
    assert.equal(map.size, 0)
  })

  // ─── Type-level: the entry shape is exported for the TUI row ───────────

  await testAsync('type: DelegationEntry shape is exported', async () => {
    const e: DelegationEntry = {
      alias: 'her-1',
      sessionID: 'ses_root',
      agent: 'hermes',
      state: 'completed',
      startedAt: 0,
      updatedAt: 1000,
      timedOut: false,
      description: '',
    }
    assert.equal(e.alias, 'her-1')
    assert.equal(e.sessionID, 'ses_root')
  })

  // ─── Live tool-part lifecycle (agent-sidebar pattern) ──────────────────
  // The PRIMARY channel: `message.part.updated` events for tool parts named
  // pantheon_delegate / pantheon_delegation_read. A delegate tool completing
  // means the JOB LAUNCHED — it stays `running` until a read resolves it or
  // the md terminal report lands. A read tool blocks until terminal, so its
  // end timestamp is the authoritative job duration.

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
    'parse: delegate running part → agent/status/startedAt from state.time',
    async () => {
      const p = parseDelegationToolPart(DELEGATE_RUNNING_PART, 2000)
      assert.ok(p, 'delegate running part must parse')
      assert.equal(p.tool, 'pantheon_delegate')
      assert.equal(p.callID, 'call_deleg_1')
      assert.equal(p.agent, 'apollo')
      assert.equal(p.description, 'Busca')
      assert.equal(p.status, 'running')
      assert.equal(p.startedAt, 1000, 'startedAt comes from state.time.start')
      assert.equal(p.alias, null)
    },
  )

  await testAsync(
    'parse: delegate completed part → alias + taskID extracted from output',
    async () => {
      const p = parseDelegationToolPart(DELEGATE_COMPLETED_PART, 2000)
      assert.ok(p)
      assert.equal(p.status, 'completed')
      assert.equal(p.alias, 'apo-1', 'alias parsed from "[apo-1]" in the output')
      assert.equal(p.taskID, 'ses_child_9', 'taskID parsed from "(task ses_...)" in the output')
      assert.equal(p.endAt, 1500)
    },
  )

  await testAsync('parse: read part → alias from input args, agent null', async () => {
    const p = parseDelegationToolPart(READ_RUNNING_PART, 6000)
    assert.ok(p, 'read part must parse')
    assert.equal(p.tool, 'pantheon_delegation_read')
    assert.equal(p.alias, 'apo-1', 'alias comes from input.id')
    assert.equal(p.agent, null)
    // A raw child session id in input.id resolves by taskID instead.
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
  })

  await testAsync('parse: pending part without time → startedAt falls back to now', async () => {
    const pending = {
      id: 'part_deleg_2',
      sessionID: 'ses_root',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'call_deleg_2',
      tool: 'pantheon_delegate',
      state: { status: 'pending', input: { agent: 'zeus' } },
    }
    const p = parseDelegationToolPart(pending, 4242)
    assert.ok(p)
    assert.equal(p.status, 'pending')
    assert.equal(p.startedAt, 4242)
  })

  await testAsync('parse: non-pantheon tool and non-tool parts → null', async () => {
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
      'text parts must be ignored',
    )
    assert.equal(
      parseDelegationToolPart({ type: 'tool', tool: 'pantheon_delegate' }),
      null,
      'missing callID → null',
    )
  })

  await testAsync(
    'reduce: delegate running creates entry; completed KEEPS running + sets alias',
    async () => {
      const map = new Map<string, LiveDelegationEntry>()
      assert.equal(
        reduceDelegationToolPart(map, DELEGATE_RUNNING_PART, 2000),
        true,
        'create → changed',
      )
      let e = map.get('call_deleg_1')
      assert.ok(e)
      assert.equal(e.state, 'running')
      assert.equal(e.agent, 'apollo')
      assert.equal(e.startedAt, 1000)
      assert.equal(e.alias, null)

      assert.equal(
        reduceDelegationToolPart(map, DELEGATE_COMPLETED_PART, 2000),
        true,
        'alias discovery → changed',
      )
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
    'reduce: read marks entry read + read completed → terminal, updatedAt stamped once',
    async () => {
      const map = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(map, DELEGATE_RUNNING_PART, 2000)
      reduceDelegationToolPart(map, DELEGATE_COMPLETED_PART, 2000)
      const e = map.get('call_deleg_1')
      assert.ok(e)
      assert.equal(e.read, false)

      assert.equal(
        reduceDelegationToolPart(map, READ_RUNNING_PART, 6000),
        true,
        'read running → changed',
      )
      assert.equal(e.read, true, 'read start marks the delegation as read')
      assert.equal(e.state, 'running', 'read blocks until terminal — still running')

      assert.equal(
        reduceDelegationToolPart(map, READ_COMPLETED_PART, 9000),
        true,
        'read completed → changed',
      )
      assert.equal(e.state, 'completed')
      assert.equal(e.updatedAt, 8000, 'job duration = read end (blocks until terminal)')

      assert.equal(
        reduceDelegationToolPart(map, READ_COMPLETED_PART, 10000),
        false,
        're-applying terminal → no change',
      )
      assert.equal(e.updatedAt, 8000, 'terminal timestamp is stamped only once')
    },
  )

  await testAsync('reduce: read error → entry error with read end timestamp', async () => {
    const map = new Map<string, LiveDelegationEntry>()
    reduceDelegationToolPart(map, DELEGATE_RUNNING_PART, 2000)
    reduceDelegationToolPart(map, DELEGATE_COMPLETED_PART, 2000)
    const e = map.get('call_deleg_1')
    assert.ok(e)
    assert.equal(reduceDelegationToolPart(map, READ_ERROR_PART, 9500), true)
    assert.equal(e.state, 'error')
    assert.equal(e.updatedAt, 9000)
    assert.equal(e.read, true)
  })

  await testAsync('reduce: delegate tool error → entry error (job never launched)', async () => {
    const map = new Map<string, LiveDelegationEntry>()
    const DELEGATE_ERROR_PART = {
      ...DELEGATE_RUNNING_PART,
      state: {
        status: 'error',
        input: { agent: 'apollo', prompt: 'x' },
        error: 'concurrency limit reached',
        time: { start: 1000, end: 1100 },
      },
    }
    assert.equal(reduceDelegationToolPart(map, DELEGATE_ERROR_PART, 1200), true)
    const e = map.get('call_deleg_1')
    assert.ok(e)
    assert.equal(e.state, 'error')
    assert.equal(e.updatedAt, 1100)
  })

  await testAsync(
    'remove: delete by partID and by callID (message.part.removed cleanup)',
    async () => {
      const byPart = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(byPart, DELEGATE_RUNNING_PART, 2000)
      assert.equal(removeDelegationEntry(byPart, 'part_deleg_1'), true, 'partID matches')
      assert.equal(byPart.size, 0)

      const byCall = new Map<string, LiveDelegationEntry>()
      reduceDelegationToolPart(byCall, DELEGATE_RUNNING_PART, 2000)
      assert.equal(removeDelegationEntry(byCall, 'call_deleg_1'), true, 'callID matches')
      assert.equal(removeDelegationEntry(byCall, 'nope'), false, 'unknown → unchanged')
    },
  )

  await testAsync('toDelegationEntry: live → DelegationEntry with alias fallback', async () => {
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
  })

  await testAsync(
    'merge: md terminal beats live running; live running without md kept',
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
      const merged = mergeDelegationSources([liveRunning], [mdTerminal])
      assert.equal(merged.length, 1, 'same (session, alias) → single row')
      assert.equal(merged[0].state, 'completed', 'terminal md is authoritative over live running')

      const liveOnly = mergeDelegationSources([{ ...liveRunning, alias: 'apo-2' }], [])
      assert.equal(liveOnly.length, 1)
      assert.equal(liveOnly[0].state, 'running')
      assert.equal(liveOnly[0].alias, 'apo-2')
    },
  )

  await testAsync(
    'merge: cross-session same alias NOT collapsed (aliases are per-session)',
    async () => {
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
      const liveRunning: LiveDelegationEntry = {
        callID: 'call_1',
        partID: 'part_1',
        sessionID: 'ses_root',
        tool: 'pantheon_delegate',
        agent: 'apollo',
        description: '',
        alias: 'apo-1',
        taskID: null,
        state: 'running',
        startedAt: 1000,
        updatedAt: null,
        read: false,
      }
      const merged = mergeDelegationSources([liveRunning], [mdOtherSession])
      assert.equal(merged.length, 2, 'different sessions → two distinct jobs')
    },
  )

  await testAsync('merge: running first, then terminal by recency (updatedAt desc)', async () => {
    const liveRunning: LiveDelegationEntry = {
      callID: 'call_1',
      partID: 'part_1',
      sessionID: 'ses_root',
      tool: 'pantheon_delegate',
      agent: 'apollo',
      description: '',
      alias: 'apo-1',
      taskID: null,
      state: 'running',
      startedAt: 1000,
      updatedAt: null,
      read: false,
    }
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
    const merged = mergeDelegationSources([liveRunning], [mdOld, mdNew])
    assert.deepEqual(
      merged.map((e) => e.alias),
      ['apo-1', 'the-1', 'her-1'],
      'running first, terminal by recency',
    )
  })

  await testAsync('elapsed: fmtElapsed formatting (s/m/h/d compact)', async () => {
    assert.equal(fmtElapsed(0), '0s')
    assert.equal(fmtElapsed(500), '0s')
    assert.equal(fmtElapsed(5_000), '5s')
    assert.equal(fmtElapsed(65_000), '1m 5s')
    assert.equal(fmtElapsed(3_600_000), '1h 0m')
    assert.equal(fmtElapsed(86_400_000), '1d 0h')
    assert.equal(fmtElapsed(90_000_000), '1d 1h')
  })

  await testAsync(
    'elapsed: delegationElapsed — running ticks now-startedAt, terminal fixed',
    async () => {
      const running: DelegationEntry = {
        alias: 'apo-1',
        sessionID: 'ses_root',
        agent: 'apollo',
        state: 'running',
        startedAt: 1000,
        updatedAt: null,
        timedOut: false,
        description: '',
      }
      assert.equal(delegationElapsed(running, 1500), '0s')
      assert.equal(delegationElapsed(running, 6_000), '5s')
      const terminal: DelegationEntry = { ...running, state: 'completed', updatedAt: 8_000 }
      assert.equal(
        delegationElapsed(terminal, 100_000),
        '7s',
        'terminal uses updatedAt-startedAt, not now',
      )
    },
  )

  await testAsync(
    'visual state: live delegation exposes phase labels and spinner frames',
    async () => {
      const live: DelegationEntry = {
        alias: 'live-call_1',
        sessionID: 'ses_root',
        agent: 'apollo',
        state: 'running',
        startedAt: 1000,
        updatedAt: null,
        timedOut: false,
        description: 'Busca',
      }
      assert.equal(delegationActivity(live), 'delegating')
      assert.equal(delegationActivityLabel(live), 'DELEGATING')
      assert.notEqual(delegationSpinnerFrame(0), delegationSpinnerFrame(140))
      assert.equal(
        delegationActivityLabel({ ...live, alias: 'apo-1', taskID: 'ses_child', read: true }),
        'READING RESULT',
      )
      assert.equal(delegationActivityLabel({ ...live, state: 'completed' }), 'DONE')
    },
  )

  await testAsync(
    'children/live merge: live phase appears before child/report and md terminal wins',
    async () => {
      const child: DelegationEntry = {
        alias: 'ses_child_9',
        sessionID: '',
        taskID: 'ses_child_9',
        agent: 'agent',
        state: 'running',
        startedAt: 1000,
        updatedAt: null,
        timedOut: false,
        description: 'Busca',
        source: 'child',
      }
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
        read: true,
      }
      const merged = mergeChildDelegationSources([child], [live])
      assert.equal(merged.length, 1)
      assert.equal(merged[0]?.alias, 'apo-1')
      assert.equal(merged[0]?.agent, 'apollo')
      assert.equal(merged[0]?.read, true)
      assert.equal(delegationActivityLabel(merged[0] as DelegationEntry), 'READING RESULT')

      const finalized = mergeChildDelegationSources(
        [{ ...child, alias: 'apo-1', state: 'completed', updatedAt: 9000, source: 'md' }],
        [live],
      )
      assert.equal(finalized[0]?.state, 'completed', 'finalized md remains authoritative')
    },
  )

  // ─── Children channel (PRIMARY source, delegations-sidebar pattern) ───
  // The panel's source of truth is `api.client.session.children` — every
  // pantheon_delegate spawns a child session (parentID = caller), so the
  // children of the current session ARE the delegation list. Status types
  // map busy/retry → running, idle → completed, unknown → running (fail-
  // open). The md report (matched by the `Task ID` header == child.id)
  // enriches alias/agent/description/duration; a child without a report
  // still renders from its own title. These pure helpers power
  // View.refreshDelegations + DelegationRow navigation.

  await testAsync('children: childStatusToState — busy/retry → running', async () => {
    assert.equal(childStatusToState('busy'), 'running')
    assert.equal(childStatusToState('retry'), 'running')
  })

  await testAsync(
    'children: childStatusToState — idle → completed, unknown → running',
    async () => {
      assert.equal(childStatusToState('idle'), 'completed')
      assert.equal(childStatusToState(undefined), 'running', 'no status → running (fail-open)')
      assert.equal(childStatusToState('weird'), 'running', 'unknown status → running (fail-open)')
    },
  )

  await testAsync(
    'children: entries derive state from live status (busy/retry running, idle completed)',
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
      assert.equal(byId.get('ses_child_rty')?.state, 'running')
      assert.equal(byId.get('ses_child_idle')?.state, 'completed')
      assert.equal(byId.get('ses_child_busy')?.updatedAt, null, 'running child has no end')
      assert.equal(byId.get('ses_child_idle')?.updatedAt, 8000, 'terminal child uses time.updated')
    },
  )

  await testAsync(
    'children: md matched by Task ID (backticks stripped) → alias/agent/description',
    async () => {
      // The board report carries `- **Task ID**: \`ses_child_9\`` — the parse
      // must strip the surrounding backticks so the map keys on the raw child
      // session id and the child↔md match lands.
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
    // The 1s poll + event refetches re-read the same children — duplicate ids
    // in one batch AND across calls must collapse to a single entry each.
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
    'children: no md → child still renders (title as description, agent fallback)',
    async () => {
      const entries = childrenToDelegationEntries(
        [{ id: 'ses_child_x', title: 'Busca de código', status: 'busy', time: { created: 5000 } }],
        [],
        10_000,
      )
      assert.equal(entries.length, 1, 'a child without a report still renders')
      const e = entries[0]
      assert.ok(e)
      assert.equal(e.agent, 'agent', 'agent falls back to "agent" without a report')
      assert.equal(e.description, 'Busca de código', 'description falls back to the child title')
      assert.equal(e.state, 'running')
      assert.equal(e.startedAt, 5000, 'startedAt from time.created')
      assert.equal(e.timedOut, false)
    },
  )

  // ─── Native task() children ([task] tag) ─────────────────────────────────
  // `session.children` returns EVERY child of the current session — both
  // pantheon_delegate jobs AND subagent sessions spawned by the native
  // `task()` tool (parentID = caller). A child WITHOUT a board report is a
  // native task child: it renders with source 'children-only' and the `[task]`
  // tag (vs the board's [apo-1] alias), agent from child.agent ?? 'agent',
  // state derived from the live child status (busy/retry→running,
  // idle→completed) and duration from the child's own time (created→updated).

  await testAsync(
    'children-only: native task() child without md → source children-only, [task] tag, derived state',
    async () => {
      const entries = childrenToDelegationEntries(
        [
          {
            id: 'ses_task_1',
            title: 'Tarefa nativa (task tool)',
            status: 'busy',
            time: { created: 5000 },
          },
        ],
        [],
        10_000,
      )
      assert.equal(entries.length, 1)
      const e = entries[0]
      assert.ok(e)
      assert.equal(e.source, 'children-only', 'child without md is children-only')
      assert.equal(e.alias, 'task', 'label/alias is the [task] tag')
      assert.equal(delegationTag(e), '[task]', 'row tag renders [task]')
      assert.equal(e.agent, 'agent', 'agent falls back to "agent" without child.agent')
      assert.equal(e.state, 'running', 'busy → running')
      assert.equal(e.startedAt, 5000, 'startedAt from child time.created')
      assert.equal(e.updatedAt, null, 'running child has no end timestamp')
      assert.equal(e.description, 'Tarefa nativa (task tool)', 'title becomes the description')
    },
  )

  await testAsync(
    'children-only: native task() child agent honored + idle → completed with duration',
    async () => {
      const entries = childrenToDelegationEntries(
        [
          {
            id: 'ses_task_2',
            title: 'Tarefa concluída',
            agent: 'hermes',
            status: 'idle',
            time: { created: 1000, updated: 9000 },
          },
        ],
        [],
        10_000,
      )
      assert.equal(entries.length, 1)
      const e = entries[0]
      assert.ok(e)
      assert.equal(e.source, 'children-only')
      assert.equal(e.agent, 'hermes', 'child.agent is honored')
      assert.equal(e.state, 'completed', 'idle → completed')
      assert.equal(e.updatedAt, 9000, 'duration end from child time.updated')
      assert.equal(delegationElapsed(e, 50_000), '8s', 'duration = updated - created')
    },
  )

  await testAsync(
    'children-only: child WITH md → board entry (alias) wins, same child NOT duplicated',
    async () => {
      // A pantheon_delegate child has BOTH a board report (md) and appears in
      // session.children — the board entry (alias [apo-1]) must prevail and
      // the same child must NOT render twice.
      const md = parseDelegationMarkdown(COMPLETED_MD, 'apo-1.md')
      assert.ok(md)
      assert.equal(md.taskID, 'ses_00eb6331dffelZ3iaSnCBdJIGe')
      const entries = childrenToDelegationEntries(
        [
          { id: 'ses_00eb6331dffelZ3iaSnCBdJIGe', title: 'dupe title', status: 'busy' },
          // duplicate child id in the same batch (poll overlap) — must collapse
          { id: 'ses_00eb6331dffelZ3iaSnCBdJIGe', title: 'dupe title', status: 'busy' },
        ],
        [md],
        10_000,
      )
      assert.equal(entries.length, 1, 'board row only — no duplicate from children')
      const e = entries[0]
      assert.ok(e)
      assert.equal(e.source, 'md', 'board provenance wins')
      assert.equal(e.alias, 'apo-1', 'board alias (not [task])')
      assert.equal(delegationTag(e), '[apo-1]', 'row tag renders the board alias')
      assert.equal(e.state, 'completed', 'terminal md state wins over busy-derived')
    },
  )

  await testAsync(
    'children-only: delegate + task mixture → correct ordering and count',
    async () => {
      // One pantheon_delegate child (has md → board [apo-1]), two native
      // task() children (no md → [task]) — all from session.children.
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
      assert.equal(entries.length, 3, '3 children → 3 rows (1 board + 2 task)')
      const byId = new Map(entries.map((e) => [e.taskID, e]))
      const board = byId.get(md.taskID ?? '')
      assert.ok(board)
      assert.equal(board.source, 'md')
      assert.equal(delegationTag(board), '[apo-1]')
      assert.equal(
        board.state,
        'completed',
        'terminal md state wins over the busy-derived child state',
      )
      assert.equal(byId.get('ses_task_a')?.source, 'children-only')
      assert.equal(byId.get('ses_task_b')?.source, 'children-only')
      // Ordering: running first, then terminal by recency (board md Finalized
      // timestamp >> the task child's time.updated) — sources interleave.
      assert.equal(entries[0]?.state, 'running', 'running first')
      assert.equal(entries[0]?.taskID, 'ses_task_a')
      assert.equal(entries[1]?.taskID, md.taskID, 'terminal board row sorted by Finalized')
      assert.equal(entries[2]?.taskID, 'ses_task_b')
    },
  )

  await testAsync(
    'children-only: task child status derived (busy/retry→running, idle→completed)',
    async () => {
      const children: ChildDelegationLike[] = [
        { id: 'ses_t1', status: 'busy', time: { created: 100 } },
        { id: 'ses_t2', status: 'retry', time: { created: 200 } },
        { id: 'ses_t3', status: 'idle', time: { created: 300, updated: 1000 } },
        { id: 'ses_t4', status: undefined, time: { created: 400 } }, // unknown → running (fail-open)
      ]
      const entries = childrenToDelegationEntries(children, [], 10_000)
      const byId = new Map(entries.map((e) => [e.taskID, e]))
      assert.equal(byId.get('ses_t1')?.state, 'running')
      assert.equal(byId.get('ses_t2')?.state, 'running')
      assert.equal(byId.get('ses_t3')?.state, 'completed')
      assert.equal(byId.get('ses_t4')?.state, 'running')
      assert.equal(byId.get('ses_t3')?.updatedAt, 1000)
    },
  )

  await testAsync('navigate: route.navigate present → calls session navigation', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const route = {
      navigate: (name: string, params?: Record<string, unknown>) => calls.push([name, params]),
    }
    assert.equal(navigateToDelegationSession(route, 'ses_child_9'), true)
    assert.deepEqual(calls, [['session', { sessionID: 'ses_child_9' }]])
  })

  await testAsync('navigate: route API absent / taskID missing → false, never calls', async () => {
    const calls: string[] = []
    assert.equal(navigateToDelegationSession(undefined, 'ses_child_9'), false, 'no route → false')
    assert.equal(
      navigateToDelegationSession({}, 'ses_child_9'),
      false,
      'route without navigate → false',
    )
    const route = { navigate: (name: string) => calls.push(name) }
    assert.equal(navigateToDelegationSession(route, undefined), false, 'missing taskID → false')
    assert.equal(navigateToDelegationSession(route, ''), false, 'empty taskID → false')
    assert.deepEqual(calls, [], 'navigate must never be called')
  })

  // ─── Current-session resolution + children path guard ──────────────────
  // Regression: the sidebar forwarded `props.session_id` verbatim to
  // `session.children({ path: { id } })`. When the TUI runtime has no focused
  // session it leaves the template UNSUBSTITUTED — the literal "{sessionID}"
  // placeholder — which the server rejected every poll (~1 err/s: "Expected a
  // string starting with \"ses\", got \"%7BsessionID%7D\"") and failed open
  // into "Delegations (0)". Contract: resolution NEVER yields a placeholder;
  // a null resolution means the fetch is SKIPPED (empty panel, zero errors).

  await testAsync('sessionID: valid ses_ slot prop resolves', async () => {
    assert.equal(resolveCurrentSessionID({ sessionID: 'ses_abc123', api: undefined }), 'ses_abc123')
  })

  await testAsync('sessionID: undefined / empty / absent → null (fetch skipped)', async () => {
    assert.equal(resolveCurrentSessionID({ sessionID: undefined }), null)
    assert.equal(resolveCurrentSessionID({ sessionID: '' }), null)
    assert.equal(resolveCurrentSessionID({}), null)
    assert.equal(resolveCurrentSessionID(null), null)
  })

  await testAsync(
    'sessionID: unsubstituted "{sessionID}" placeholder → null (regression)',
    async () => {
      // The exact runtime value behind the "%7BsessionID%7D" error — the guard
      // must NEVER forward it into a path.
      assert.equal(resolveCurrentSessionID({ sessionID: '{sessionID}' }), null)
      assert.equal(resolveCurrentSessionID({ sessionID: ' {sessionID} ' }), null)
    },
  )

  await testAsync(
    'sessionID: isValidSessionId rejects placeholder + URL-encoded placeholder',
    async () => {
      // Contract confirmed: opencode session ids start with "ses". A literal
      // "{sessionID}" starts with "{" and its URL-encoded form with "%", so
      // BOTH fail the startsWith("ses") check — the placeholder can never be
      // forwarded to the server (the "%7BsessionID%7D" schema-error spam).
      assert.equal(isValidSessionId('{sessionID}'), false, 'literal placeholder rejected')
      assert.equal(isValidSessionId('%7BsessionID%7D'), false, 'URL-encoded placeholder rejected')
      assert.equal(
        isValidSessionId(' {sessionID} '),
        false,
        'whitespace-wrapped placeholder rejected',
      )
      assert.equal(
        isValidSessionId('ses_00eb66a34ffeCHnzDx5hH2BCsS'),
        true,
        'real session id accepted',
      )
      assert.equal(isValidSessionId(''), false)
      assert.equal(isValidSessionId(undefined), false)
      assert.equal(isValidSessionId(42), false)
    },
  )

  await testAsync(
    'sessionID: URL-encoded "%7BsessionID%7D" placeholder → null in resolution',
    async () => {
      // The exact string opencode's server reported in the SchemaError.
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

  await testAsync('sessionID: non-ses garbage / non-string → null', async () => {
    assert.equal(resolveCurrentSessionID({ sessionID: 'wrk_123' }), null)
    assert.equal(resolveCurrentSessionID({ sessionID: 'foo-bar' }), null)
    assert.equal(resolveCurrentSessionID({ sessionID: 42 }), null)
  })

  await testAsync('sessionID: slot prop wins over state and route', async () => {
    const api = {
      state: { sessionID: 'ses_state1' },
      route: { current: { name: 'session', params: { sessionID: 'ses_route1' } } },
    }
    assert.equal(resolveCurrentSessionID({ sessionID: 'ses_prop1', api }), 'ses_prop1')
  })

  await testAsync('sessionID: invalid prop falls back to api.state.sessionID', async () => {
    const api = { state: { sessionID: 'ses_state1' } }
    assert.equal(resolveCurrentSessionID({ sessionID: '{sessionID}', api }), 'ses_state1')
  })

  await testAsync(
    'sessionID: invalid prop+state fall back to route.current.params.sessionID',
    async () => {
      const api = {
        state: { sessionID: undefined },
        route: { current: { name: 'session', params: { sessionID: 'ses_route1' } } },
      }
      assert.equal(resolveCurrentSessionID({ sessionID: '', api }), 'ses_route1')
    },
  )

  await testAsync('children path: valid id → { path: { id } }, never a placeholder', async () => {
    assert.deepEqual(buildChildrenPath('ses_abc123'), { path: { id: 'ses_abc123' } })
    const serialized = JSON.stringify(buildChildrenPath('ses_abc123'))
    assert.ok(
      !serialized.includes('{sessionID}'),
      'path must never contain an unsubstituted placeholder',
    )
  })

  await testAsync('children path: null / empty / placeholder → null (call skipped)', async () => {
    assert.equal(buildChildrenPath(null), null)
    assert.equal(buildChildrenPath(undefined), null)
    assert.equal(buildChildrenPath(''), null)
    assert.equal(buildChildrenPath('{sessionID}'), null)
    assert.equal(buildChildrenPath('wrk_123'), null)
  })

  await testAsync('regression: placeholder sessionID → resolution null → no fetch', async () => {
    const sessionID = resolveCurrentSessionID({ sessionID: '{sessionID}' })
    const path = sessionID === null ? null : buildChildrenPath(sessionID)
    assert.equal(
      path,
      null,
      'the children call must be skipped entirely (empty panel, zero errors)',
    )
  })

  // ─── History-only panel (no sessionID) ──────────────────────────────────
  // When sessionID does not resolve (no focused session) the panel shows the
  // md history read from ALL sessions — never "(0)". visibleDelegationList is
  // the exact list the View memo renders: running first, then the most recent
  // terminal reports (capped at 8).

  await testAsync(
    'panel history: reports shown even with NO sessionID (combined state, running first)',
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

        // Simulates View.refreshDelegations with sessionID === null: the md
        // history is read and rendered WITHOUT any children/live channel.
        const sessionID = resolveCurrentSessionID({ sessionID: '{sessionID}' })
        assert.equal(sessionID, null)
        const md = await readAllDelegationEntries(root)
        assert.equal(md.length, 4, 'history collected from disk despite null sessionID')
        const panelList = visibleDelegationList(md)
        assert.equal(panelList.length, 4, 'history renders — panel is NOT (0)')
        assert.equal(panelList[0]?.state, 'running', 'running job first')
        assert.deepEqual(
          panelList
            .slice(1)
            .map((e) => e.alias)
            .sort(),
          ['apo-1', 'her-7', 'the-9'],
          'terminal history present',
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  await testAsync('panel history: terminal reports capped at 8, running always shown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-root-'))
    try {
      const deleg = join(root, '.pantheon', 'delegations')
      const ses = join(deleg, 'ses_aaa')
      mkdirSync(ses, { recursive: true })
      writeFileSync(join(ses, 'run-1.md'), RUNNING_MD)
      for (let i = 0; i < 12; i++) {
        const ts = new Date(Date.UTC(2026, 7, 10 + i, 12)).toISOString()
        writeFileSync(
          join(ses, `term-${i}.md`),
          `# Delegation Report — her-${i}\n\n` +
            `- **Agent**: hermes\n- **Description**: job ${i}\n- **State**: completed\n` +
            `- **Timed out**: false\n- **Started**: ${ts}\n- **Finalized**: ${ts}\n`,
        )
      }
      const md = await readAllDelegationEntries(root)
      assert.equal(md.length, 13, 'all reports collected')
      const panelList = visibleDelegationList(md)
      assert.equal(panelList[0]?.state, 'running', 'running job first')
      assert.equal(panelList.length, 1 + 8, '1 running + at most 8 terminal')
      // Recency: the 8 most recently finalized terminals are kept.
      const terminalAliases = panelList.slice(1).map((e) => e.alias)
      assert.ok(terminalAliases.includes('her-11'), 'most recent terminal kept')
      assert.ok(!terminalAliases.includes('her-0'), 'oldest terminal trimmed by the cap')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // ─── Source-scan: session-API call sites stay guarded ───────────────────
  // Every `session.children` path goes through buildChildrenPath/safeSessionPath
  // and every `session.status` call is isValidSessionId-guarded — a future edit
  // that forwards a raw/placeholder id to the wire breaks this test.

  await testAsync(
    'source-scan: every session.children / session.status call site is id-guarded',
    async () => {
      const source = await readFileP(
        new URL('../../src/plugins/tui/src/index.tsx', import.meta.url),
        'utf8',
      )
      const lines = source.split('\n')
      // Look 2 lines before and 1 after the call site: the guard sits on its
      // own line (isValidSessionId) or the path expression spans lines
      // (buildChildrenPath on the line after `session?.children?.(`).
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
        // API calls use optional chaining (`session?.status?.(`); the event
        // subscription name `event.on('session.status')` must NOT match.
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
