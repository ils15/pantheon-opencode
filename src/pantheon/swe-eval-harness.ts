/**
 * Multi-File Engineering Evaluation Harness (`swe-eval-harness.ts`).
 *
 * Replaces synthetic string-match benchmarks ("ZEUS_OK") with reproducible,
 * multi-file software engineering tasks evaluated against hidden test suites
 * in isolated workspaces (RED before patch -> GREEN after patch), integrated
 * with `createExecutionReceipt` and `StepLedger`.
 *
 * @module pantheon/swe-eval-harness
 */

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { createExecutionReceipt } from './execution-receipt.ts'

const execFileAsync = promisify(execFile)

export interface SweEvalTask {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly initialFiles: Readonly<Record<string, string>>
  readonly hiddenTestFile: {
    readonly path: string
    readonly content: string
  }
  readonly referencePatch: Readonly<Record<string, string>>
}

export interface SweEvalTaskResult {
  readonly taskId: string
  readonly failedBeforePatch: boolean
  readonly passedAfterPatch: boolean
  readonly durationMs: number
  readonly receiptId: string
}

export const CANONICAL_SWE_EVAL_TASKS: readonly SweEvalTask[] = [
  {
    id: 'swe-01-token-expiry-boundary',
    title: 'Fix off-by-one boundary & clock skew in multi-file token validator',
    description:
      'Tokens expiring at the exact current second or with negative TTL must be rejected across token.mjs and validator.mjs.',
    initialFiles: {
      'src/token.mjs': [
        'export function parseToken(raw) {',
        '  const parts = String(raw || "").split(":");',
        '  if (parts.length !== 2) return null;',
        '  return { subject: parts[0], expiresAt: Number(parts[1]) };',
        '}',
      ].join('\n'),
      'src/validator.mjs': [
        "import { parseToken } from './token.mjs';",
        'export function isTokenValid(raw, nowMs) {',
        '  const parsed = parseToken(raw);',
        '  if (!parsed || !parsed.subject) return false;',
        '  // BUG: allows expired tokens when expiresAt === nowMs or NaN',
        '  return parsed.expiresAt >= nowMs || Number.isNaN(parsed.expiresAt);',
        '}',
      ].join('\n'),
    },
    hiddenTestFile: {
      path: 'tests/validator.test.mjs',
      content: [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { isTokenValid } from '../src/validator.mjs';",
        "test('rejects expired at boundary and malformed timestamps', () => {",
        "  assert.equal(isTokenValid('user1:1000', 1000), false);",
        "  assert.equal(isTokenValid('user1:abc', 1000), false);",
        "  assert.equal(isTokenValid('user1:1001', 1000), true);",
        '});',
      ].join('\n'),
    },
    referencePatch: {
      'src/validator.mjs': [
        "import { parseToken } from './token.mjs';",
        'export function isTokenValid(raw, nowMs) {',
        '  const parsed = parseToken(raw);',
        '  if (!parsed || !parsed.subject) return false;',
        '  if (!Number.isFinite(parsed.expiresAt) || !Number.isFinite(nowMs)) return false;',
        '  return parsed.expiresAt > nowMs;',
        '}',
      ].join('\n'),
    },
  },
  {
    id: 'swe-02-invoice-cents-rounding',
    title: 'Eliminate floating-point drift in multi-item invoice aggregation',
    description:
      'Invoice subtotal and tax computation across line-item.mjs and invoice.mjs must compute in integer cents.',
    initialFiles: {
      'src/line-item.mjs': [
        'export function lineTotalUsd(priceUsd, qty) {',
        '  return priceUsd * qty;',
        '}',
      ].join('\n'),
      'src/invoice.mjs': [
        "import { lineTotalUsd } from './line-item.mjs';",
        'export function computeInvoiceTotal(items) {',
        '  // BUG: raw float addition yields 0.30000000000000004',
        '  return items.reduce((sum, it) => sum + lineTotalUsd(it.price, it.qty), 0);',
        '}',
      ].join('\n'),
    },
    hiddenTestFile: {
      path: 'tests/invoice.test.mjs',
      content: [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { computeInvoiceTotal } from '../src/invoice.mjs';",
        "test('computes exact two-decimal USD total without IEEE-754 drift', () => {",
        '  const total = computeInvoiceTotal([{ price: 0.1, qty: 1 }, { price: 0.2, qty: 1 }]);',
        '  assert.equal(total, 0.3);',
        '});',
      ].join('\n'),
    },
    referencePatch: {
      'src/line-item.mjs': [
        'export function lineTotalCents(priceUsd, qty) {',
        '  return Math.round(priceUsd * 100) * qty;',
        '}',
      ].join('\n'),
      'src/invoice.mjs': [
        "import { lineTotalCents } from './line-item.mjs';",
        'export function computeInvoiceTotal(items) {',
        '  const cents = items.reduce((sum, it) => sum + lineTotalCents(it.price, it.qty), 0);',
        '  return Number((cents / 100).toFixed(2));',
        '}',
      ].join('\n'),
    },
  },
]

async function runHiddenTest(workspaceDir: string, testRelPath: string): Promise<number> {
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  try {
    await execFileAsync(process.execPath, ['--test', join(workspaceDir, testRelPath)], {
      cwd: workspaceDir,
      env: childEnv,
      timeout: 15_000,
    })
    return 0
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    return typeof code === 'number' ? code : 1
  }
}

function writeWorkspaceFiles(workspaceDir: string, files: Readonly<Record<string, string>>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(workspaceDir, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, content, 'utf8')
  }
}

/**
 * Execute a multi-file SWE evaluation task in an isolated workspace:
 * 1. Verifies the initial buggy codebase FAILS the hidden test suite (RED).
 * 2. Applies the candidate patch.
 * 3. Verifies the patched codebase PASSES the hidden test suite (GREEN).
 * 4. Mints a cryptographic Execution Proof Receipt.
 */
export async function evaluateSweTask(
  task: SweEvalTask,
  candidatePatch: Readonly<Record<string, string>> = task.referencePatch,
): Promise<SweEvalTaskResult> {
  const workDir = mkdtempSync(join(tmpdir(), `pantheon-swe-eval-${task.id}-`))
  const start = Date.now()
  try {
    writeWorkspaceFiles(workDir, task.initialFiles)
    writeWorkspaceFiles(workDir, { [task.hiddenTestFile.path]: task.hiddenTestFile.content })

    const preExit = await runHiddenTest(workDir, task.hiddenTestFile.path)
    const failedBeforePatch = preExit !== 0

    writeWorkspaceFiles(workDir, candidatePatch)
    const postExit = await runHiddenTest(workDir, task.hiddenTestFile.path)
    const passedAfterPatch = postExit === 0
    const durationMs = Date.now() - start

    const receipt = createExecutionReceipt({
      taskID: task.id,
      agent: 'swe-eval-harness',
      files: Object.keys(candidatePatch).map((relPath) => ({
        path: relPath,
        content: readFileSync(join(workDir, relPath), 'utf8'),
      })),
      testSlice: {
        command: `node --test ${task.hiddenTestFile.path}`,
        exitCode: postExit,
        durationMs,
      },
    })

    return {
      taskId: task.id,
      failedBeforePatch,
      passedAfterPatch,
      durationMs,
      receiptId: receipt.receiptId,
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
