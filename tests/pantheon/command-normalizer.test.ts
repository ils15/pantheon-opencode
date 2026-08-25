/**
 * Tests for the Command Normalizer (Fase 1) — command-normalizer.ts.
 *
 * The guard rewrites `python` → `python3` in `bash` commands via the
 * `tool.execute.before` hook. Unlike the read-only enforcement guard (which
 * THROWS to deny), this guard REWRITES `output.args.command` in place and lets
 * the command run.
 *
 * Run with: npx tsx tests/pantheon/command-normalizer.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  createCommandNormalizer,
  isPythonCEval,
  normalizePythonCommand,
} from '../../src/pantheon/command-normalizer.ts'

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

/** Invoke the guard against a bash command, returning the rewritten command. */
async function runNormalizer(
  command: string,
  logger?: { warn: (m: string) => void },
): Promise<{ command: string; warnings: string[] }> {
  const warnings: string[] = []
  const sink = logger ?? { warn: (m: string) => warnings.push(m) }
  const guard = createCommandNormalizer({ logger: sink })
  const args: Record<string, unknown> = { command }
  await guard({ tool: 'bash', sessionID: 'ses_test' }, { args })
  return { command: args.command as string, warnings }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('normalizePythonCommand: python script.py → python3 script.py', async () => {
    const { normalized, wasRewritten } = normalizePythonCommand('python script.py')
    assert.equal(normalized, 'python3 script.py')
    assert.equal(wasRewritten, true)
  })

  await testAsync('normalizePythonCommand: python -m pytest → python3 -m pytest', async () => {
    const { normalized, wasRewritten } = normalizePythonCommand('python -m pytest')
    assert.equal(normalized, 'python3 -m pytest')
    assert.equal(wasRewritten, true)
  })

  await testAsync(
    'normalizePythonCommand: python -c "print(1)" → python3 -c + WARNING',
    async () => {
      const { normalized, wasRewritten } = normalizePythonCommand('python -c "print(1)"')
      assert.equal(normalized, 'python3 -c "print(1)"')
      assert.equal(wasRewritten, true)
      assert.equal(isPythonCEval('python -c "print(1)"'), true, 'python -c must be flagged')
    },
  )

  await testAsync(
    'normalizePythonCommand: bash -c "python foo" → bash -c "python3 foo"',
    async () => {
      const { normalized, wasRewritten } = normalizePythonCommand('bash -c "python foo"')
      assert.equal(normalized, 'bash -c "python3 foo"')
      assert.equal(wasRewritten, true)
    },
  )

  await testAsync('normalizePythonCommand: pip install python-dateutil → UNCHANGED', async () => {
    const { normalized, wasRewritten } = normalizePythonCommand('pip install python-dateutil')
    assert.equal(normalized, 'pip install python-dateutil')
    assert.equal(wasRewritten, false, 'substring python-dateutil must NOT be rewritten')
  })

  await testAsync(
    'normalizePythonCommand: python3 script.py → UNCHANGED (already correct)',
    async () => {
      const { normalized, wasRewritten } = normalizePythonCommand('python3 script.py')
      assert.equal(normalized, 'python3 script.py')
      assert.equal(wasRewritten, false)
    },
  )

  await testAsync(
    'normalizePythonCommand: cat python-config → UNCHANGED (not a command)',
    async () => {
      const { normalized, wasRewritten } = normalizePythonCommand('cat python-config')
      assert.equal(normalized, 'cat python-config')
      assert.equal(wasRewritten, false)
    },
  )

  await testAsync('guard: rewrites output.args.command for the bash tool', async () => {
    const { command } = await runNormalizer('python foo.py')
    assert.equal(command, 'python3 foo.py')
  })

  await testAsync('guard: non-bash tool passes through untouched', async () => {
    const guard = createCommandNormalizer()
    const args: Record<string, unknown> = { command: 'python foo.py' }
    await guard({ tool: 'read', sessionID: 'ses_test' }, { args })
    assert.equal(args.command, 'python foo.py', 'non-bash tool must not be rewritten')
  })

  await testAsync('guard: python -c logs a WARNING', async () => {
    const { warnings } = await runNormalizer('python -c "print(1)"')
    assert.ok(
      warnings.some((w) => w.includes('WARNING python -c detected')),
      'python -c must emit a WARNING log',
    )
  })

  await testAsync('guard: every rewrite is logged with original + normalized', async () => {
    const { warnings } = await runNormalizer('python foo.py')
    assert.ok(
      warnings.some(
        (w) =>
          w.includes('python→python3 rewritten') &&
          w.includes('original="python foo.py"') &&
          w.includes('normalized="python3 foo.py"'),
      ),
      'rewrite must be logged with original + normalized command',
    )
  })

  await testAsync('guard: already-correct python3 command logs nothing', async () => {
    const { warnings } = await runNormalizer('python3 foo.py')
    assert.equal(warnings.length, 0, 'no rewrite → no log')
  })

  // ═══════════════════════════════════════════════════════════════════════

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
