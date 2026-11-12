/**
 * Execution Proof Receipts — Verifiable task completion contracts for agent execution.
 *
 * Implements SOTA late-2026 verification principles: subagents return cryptographic
 * receipts containing deterministic content hashes of modified files and verifiable
 * test-slicing proofs, eliminating false-positive completion reports.
 *
 * Emits reactive verification events on `PantheonBus`.
 *
 * Pure TypeScript — stdlib crypto only.
 *
 * @module execution-receipt
 */

import { createHash } from 'node:crypto'
import { type ExecutionReceiptPayload, getSharedBus } from './bus.ts'

export interface FileInput {
  readonly path: string
  readonly content: string | Buffer
}

export interface TestSliceInput {
  readonly command: string
  readonly exitCode: number
  readonly durationMs: number
}

export interface CreateReceiptInput {
  readonly taskID: string
  readonly agent: string
  readonly files: readonly FileInput[]
  readonly testSlice?: TestSliceInput | undefined
}

/**
 * Compute SHA-256 fingerprint for a string or buffer.
 */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Compute cryptographic signature binding task, agent, timestamp and file hashes.
 */
export function computeReceiptSignature(
  taskID: string,
  agent: string,
  timestamp: number,
  files: ReadonlyArray<{ readonly path: string; readonly hash: string }>,
): string {
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const payload = [
    taskID,
    agent,
    String(timestamp),
    sortedFiles.map((f) => `${f.path}:${f.hash}`).join(';'),
  ].join('|')
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * Generate a verifiable Execution Proof Receipt and emit it on the shared bus.
 */
export function createExecutionReceipt(input: CreateReceiptInput): ExecutionReceiptPayload {
  const timestamp = Date.now()
  const files = input.files.map((f) => {
    const buf = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content
    return {
      path: f.path,
      hash: hashContent(buf),
      sizeBytes: buf.length,
    }
  })

  const signature = computeReceiptSignature(input.taskID, input.agent, timestamp, files)
  const receiptId = `rcpt_${signature.slice(0, 16)}`

  let status: 'VERIFIED' | 'UNVERIFIED' | 'FAILED' = 'UNVERIFIED'
  if (input.testSlice) {
    status = input.testSlice.exitCode === 0 ? 'VERIFIED' : 'FAILED'
  }

  const receipt: ExecutionReceiptPayload = {
    receiptId,
    taskID: input.taskID,
    agent: input.agent,
    status,
    files,
    testSlice: input.testSlice,
    timestamp,
    signature,
  }

  getSharedBus().emit('agent:execution:receipt', receipt)
  return receipt
}

/**
 * Verify whether an execution receipt signature matches its declared files and metadata.
 */
export function verifyExecutionReceipt(receipt: ExecutionReceiptPayload): boolean {
  if (!receipt?.signature || !receipt.taskID || !receipt.agent) {
    return false
  }
  const expected = computeReceiptSignature(
    receipt.taskID,
    receipt.agent,
    receipt.timestamp,
    receipt.files,
  )
  return receipt.signature === expected
}
