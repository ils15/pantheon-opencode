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
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type DelegationEntry,
  parseDelegationMarkdown,
  readDelegationEntries,
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

  // ─── Type-level: the entry shape is exported for the TUI row ───────────

  await testAsync('type: DelegationEntry shape is exported', async () => {
    const e: DelegationEntry = {
      alias: 'her-1',
      agent: 'hermes',
      state: 'completed',
      startedAt: 0,
      updatedAt: 1000,
      timedOut: false,
      description: '',
    }
    assert.equal(e.alias, 'her-1')
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
