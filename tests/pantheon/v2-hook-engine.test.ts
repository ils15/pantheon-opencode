/**
 * Focused tests for the in-process hook engine: the secret-scan verdict
 * contract (mirroring scripts/hooks/scan-secrets.sh), the delegation audit
 * line shapes, and the formatter applicability gate.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendDelegationAuditLine,
  delegationStartLine,
  delegationStopLine,
  formatterApplies,
  maskSecretMatch,
  resolveDelegationLogDir,
  runSecretScanInProcess,
  secretScanApplies,
} from '../../src/pantheon/v2-hook-engine.ts'

function scan(payload: unknown) {
  return runSecretScanInProcess(payload as never)
}

function testScanContract(): void {
  // Clean input → exit 0.
  assert.equal(scan({ tool_input: 'refactor the parser module' }).code, 0)
  assert.equal(scan({ tool_input: '' }).code, 0)

  // High-confidence token formats → exit 2 with the block line.
  // The AWS example key is assembled at runtime: the CI critical-secret scan
  // matches the raw literal in tracked sources.
  const awsExample = `${'AKIA'}${'IOSFODNN7EXAMPLE'}`
  const high = scan({
    tool_input: `key = "${awsExample}" plus GH_TOKEN=ghp_${'a'.repeat(36)}`,
  })
  assert.equal(high.code, 2)
  assert.ok(high.stderr.includes('[SECRET SCAN]'))
  assert.ok(high.stderr.includes('Tool call will be BLOCKED'))
  assert.ok(!high.stderr.includes(awsExample), 'match is masked')
  assert.ok(high.stderr.includes('AKIA****MPLE'), 'first4****last4 masking')

  // Bifrost prefix and bearer/JWT families.
  assert.equal(scan({ tool_input: `${'sk'}${'-bf-'}abcdef12` }).code, 2)
  assert.equal(scan({ tool_input: `Authorization: Bearer ${'x'.repeat(24)}` }).code, 2)
  assert.equal(
    scan({ tool_input: 'eyJhbGciOi.eyJzdWIiOi.signature' }).code,
    2,
    'JWT shape is high confidence',
  )

  // Low-confidence key names → exit 1 WITH the marker (advisory).
  const low = scan({ tool_input: 'api_key = "abcdefghijklmnop"' })
  assert.equal(low.code, 1)
  assert.ok(low.stderr.includes('[SECRET SCAN]'))
  assert.ok(low.stderr.includes('low confidence'))

  // Plain password prose without a value shape stays clean (parity with the
  // shell script, which requires the quoted value form).
  assert.equal(scan({ tool_input: 'use the password from the vault' }).code, 0)
}

function testMasking(): void {
  assert.equal(maskSecretMatch('short'), '****')
  assert.equal(maskSecretMatch('abcdefgh'), '****')
  assert.equal(maskSecretMatch('abcdefghijklmnop'), 'abcd****mnop')
}

function testAuditLines(): void {
  const now = Date.parse('2026-11-02T12:00:00.000Z')
  const start = delegationStartLine({
    agent: 'hermes',
    task: '',
    sessionID: 'ses_1',
    delegationID: 'd-1',
    now,
  })
  assert.deepEqual(start, {
    event: 'SubagentStart',
    timestamp: '2026-11-02T12:00:00Z',
    agent: 'hermes',
    task: 'hermes',
    session_id: 'ses_1',
    delegation_id: 'd-1',
  })

  const stop = delegationStopLine({
    agent: 'hermes',
    status: 'success',
    reason: 'success',
    task: 'implement endpoint',
    sessionID: 'ses_1',
    result: { output: 'done' },
    delegationID: 'd-1',
    taskID: '',
    durationMs: 0,
    now,
  }) as Record<string, unknown>
  assert.equal(stop.event, 'SubagentStop')
  assert.equal(stop.delegation_id, 'd-1')
  assert.equal(Object.hasOwn(stop, 'task_id'), false, 'empty task_id is omitted')
  // Parity with the shell script: duration 0 is a real number and is emitted;
  // only an absent duration (null) is omitted.
  assert.equal(stop.duration_ms, 0)

  const withMeta = delegationStopLine({
    agent: 'hermes',
    status: 'dispatched',
    reason: 'dispatched',
    task: 'x',
    sessionID: 'ses_1',
    result: null,
    delegationID: 'd-2',
    taskID: 't-9',
    durationMs: 1500,
    now,
  }) as Record<string, unknown>
  assert.equal(withMeta.task_id, 't-9')
  assert.equal(withMeta.duration_ms, 1500)

  const noDuration = delegationStopLine({
    agent: 'hermes',
    status: 'failure',
    reason: 'failure',
    task: 'x',
    sessionID: 'ses_1',
    result: null,
    delegationID: 'd-3',
    taskID: '',
    durationMs: null,
    now,
  }) as Record<string, unknown>
  assert.equal(Object.hasOwn(noDuration, 'duration_ms'), false, 'absent duration is omitted')
}

function testAuditAppenderAndDir(): void {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-hook-engine-'))
  const env = { XDG_STATE_HOME: join(root, 'state') }
  const dir = resolveDelegationLogDir({ ...env } as never)
  assert.ok(dir.includes(join('pantheon', 'hooks')), `xdg resolution: ${dir}`)
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = join(root, 'state')
  try {
    assert.equal(
      appendDelegationAuditLine(
        delegationStartLine({ agent: 'a', task: 't', sessionID: 's', delegationID: 'd', now: 0 }),
      ),
      true,
    )
    const lines = readFileSync(join(dir, 'delegations.log'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>
    assert.equal(parsed.event, 'SubagentStart')
    assert.match(String(parsed.timestamp), /Z$/)
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
}

function testScanGate(): void {
  assert.equal(secretScanApplies('bash'), true)
  assert.equal(secretScanApplies('write'), true)
  assert.equal(secretScanApplies('Edit'), true)
  assert.equal(secretScanApplies('hashline_edit'), true)
  assert.equal(secretScanApplies('webfetch'), true)
  assert.equal(secretScanApplies('read'), false)
  assert.equal(secretScanApplies('grep'), false)
  assert.equal(secretScanApplies('glob'), false)
  assert.equal(secretScanApplies('session_list'), false)
  assert.equal(secretScanApplies('unknown_future_tool'), true, 'unknown names stay scanned')
  assert.equal(secretScanApplies(undefined), true, 'missing tool name stays scanned')
}

function testFormatterGate(): void {
  assert.equal(formatterApplies('edit', { file_path: 'src/mod.ts' }), true)
  assert.equal(formatterApplies('Write', { file_path: 'README.md' }), true)
  assert.equal(formatterApplies('hashline_edit', { file_path: 'a/b/c.py' }), true)
  assert.equal(formatterApplies('edit', { file_path: 'assets/logo.png' }), false)
  assert.equal(formatterApplies('grep', { pattern: 'x' }), false)
  assert.equal(formatterApplies('read', { file_path: 'src/mod.ts' }), false)
  assert.equal(formatterApplies('bash', { command: 'echo hi' }), true, 'bash stays conservative')
}

testScanContract()
testMasking()
testAuditLines()
testAuditAppenderAndDir()
testFormatterGate()
testScanGate()
console.log('v2 hook engine tests passed')
