import assert from 'node:assert/strict'
import test from 'node:test'
import { type ExecutionReceiptPayload, getSharedBus } from '../../src/pantheon/bus.ts'
import {
  createExecutionReceipt,
  hashContent,
  verifyExecutionReceipt,
} from '../../src/pantheon/execution-receipt.ts'

test('hashContent produces deterministic SHA-256 hex string', () => {
  const h1 = hashContent('test content')
  const h2 = hashContent(Buffer.from('test content', 'utf8'))
  assert.equal(h1, h2)
  assert.equal(h1.length, 64)
})

test('createExecutionReceipt generates signed verified receipt and emits event', () => {
  const bus = getSharedBus()
  let captured: ExecutionReceiptPayload | null = null
  const unsub = bus.on('agent:execution:receipt', (r) => {
    captured = r
  })

  try {
    const receipt = createExecutionReceipt({
      taskID: 'task-abc-123',
      agent: 'hermes',
      files: [
        { path: 'src/api.ts', content: 'export const api = 1' },
        { path: 'docs/api.md', content: '# API Docs' },
      ],
      testSlice: { command: 'node --test tests/api.test.ts', exitCode: 0, durationMs: 45 },
    })

    assert.equal(receipt.status, 'VERIFIED')
    assert.equal(receipt.agent, 'hermes')
    assert.equal(receipt.files.length, 2)
    assert.equal(receipt.files[0]?.path, 'src/api.ts')
    assert.ok(receipt.receiptId.startsWith('rcpt_'))
    assert.equal(verifyExecutionReceipt(receipt), true)

    assert.ok(captured !== null)
    assert.equal(captured?.receiptId, receipt.receiptId)
  } finally {
    unsub()
  }
})

test('createExecutionReceipt marks status FAILED when test slice fails', () => {
  const receipt = createExecutionReceipt({
    taskID: 'task-fail-456',
    agent: 'demeter',
    files: [{ path: 'src/db.ts', content: 'broken syntax' }],
    testSlice: { command: 'npm test', exitCode: 1, durationMs: 120 },
  })

  assert.equal(receipt.status, 'FAILED')
  assert.equal(verifyExecutionReceipt(receipt), true)
})

test('verifyExecutionReceipt detects tampered files or metadata', () => {
  const receipt = createExecutionReceipt({
    taskID: 'task-789',
    agent: 'talos',
    files: [{ path: 'src/fix.ts', content: 'let x = 1' }],
  })

  assert.equal(verifyExecutionReceipt(receipt), true)

  // Tamper file hash
  const tampered: ExecutionReceiptPayload = {
    ...receipt,
    files: [{ path: 'src/fix.ts', hash: 'tampered-hash', sizeBytes: 9 }],
  }
  assert.equal(verifyExecutionReceipt(tampered), false)
})
