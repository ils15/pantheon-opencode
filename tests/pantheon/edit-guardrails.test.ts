import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type ExecRunner,
  evaluateEditGuardrail,
  guardrailApprovalMarker,
  parseGitDiffChangedLines,
  runPostEditLint,
} from '../../src/pantheon/edit-guardrails.ts'
import { createV2ExecuteAfter } from '../../src/pantheon/execute-after.ts'
import { hasApproval, mintApproval } from '../../src/pantheon/j1-approvals.ts'

test('evaluateEditGuardrail blocks newly introduced suppression directives and lint config edits', () => {
  const clean = evaluateEditGuardrail('edit', {
    filePath: 'src/app.ts',
    oldString: 'const x = 1',
    newString: 'const x = 2',
  })
  assert.equal(clean.allowed, true)

  for (const directive of [
    '// biome-ignore lint/suspicious/noExplicitAny: shortcut',
    '// eslint-disable-next-line no-console',
    '// @ts-ignore',
    '# noqa: F401',
    '# type: ignore[assignment]',
  ]) {
    const blocked = evaluateEditGuardrail('edit', {
      filePath: 'src/app.ts',
      oldString: 'const x: any = 1',
      newString: `${directive}\nconst x: any = 1`,
    })
    assert.equal(blocked.allowed, false, `Expected ${directive} to be blocked`)
    assert.equal(blocked.kind, 'suppression')
    assert.ok(blocked.approvalHash && blocked.approvalMarker?.startsWith('guardrail-approval-'))
  }

  // Preserving an existing suppression inside oldString is allowed
  const preserved = evaluateEditGuardrail('edit', {
    filePath: 'src/app.ts',
    oldString: '// @ts-ignore\nconst x = 1',
    newString: '// @ts-ignore\nconst x = 2',
  })
  assert.equal(preserved.allowed, true)

  // Editing protected lint/tsconfig files is gated
  for (const cfg of ['biome.json', 'tsconfig.json', '.eslintrc.json', 'ruff.toml']) {
    const cfgBlocked = evaluateEditGuardrail('write', {
      filePath: cfg,
      content: '{}',
    })
    assert.equal(cfgBlocked.allowed, false, `Expected ${cfg} to be gated`)
    assert.equal(cfgBlocked.kind, 'lint-config')
  }

  // Approval marker unlocks the exact edit hash
  assert.ok(
    (() => {
      const gated = evaluateEditGuardrail('hashline_edit', {
        filePath: 'src/foo.ts',
        edits: [{ op: 'replace', pos: '1#AA', lines: '// @ts-nocheck' }],
      })
      assert.equal(gated.allowed, false)
      assert.ok(gated.approvalHash)
      mintApproval('ses-gr-1', gated.approvalHash)
      assert.equal(
        guardrailApprovalMarker(gated.approvalHash),
        `guardrail-approval-${gated.approvalHash}`,
      )
      return hasApproval('ses-gr-1', gated.approvalHash)
    })(),
  )
})

test('parseGitDiffChangedLines extracts only modified/added line ranges', () => {
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '@@ -10,0 +11,3 @@', '@@ -40 +43 @@'].join('\n')
  const changed = parseGitDiffChangedLines(diff)
  assert.deepEqual(
    [...changed].sort((a, b) => a - b),
    [11, 12, 13, 43],
  )
})

test('runPostEditLint filters Biome diagnostics to lines touched since HEAD and detects JSON syntax errors', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pantheon-edit-lint-'))
  try {
    mkdirSync(join(tmp, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(tmp, 'src'), { recursive: true })
    writeFileSync(join(tmp, 'biome.json'), '{}')
    writeFileSync(join(tmp, 'node_modules', '.bin', 'biome'), '#!/bin/sh\n')

    const tsFile = join(tmp, 'src', 'demo.ts')
    writeFileSync(
      tsFile,
      [
        'const legacyUnused = 1', // L1 (offset 0..22)
        'const editedBroken = 2', // L2 (offset 23..45)
        'export const ok = 3', // L3
      ].join('\n'),
    )

    const fakeBiomeRunner: ExecRunner = async (cmd, args) => {
      if (cmd.endsWith('biome')) {
        return {
          exitCode: 1,
          stderr: '',
          stdout: JSON.stringify({
            diagnostics: [
              {
                category: 'lint/correctness/noUnusedVariables',
                severity: 'warning',
                description: 'legacyUnused is unused',
                location: { span: [6, 18] }, // line 1 (untouched legacy)
              },
              {
                category: 'lint/correctness/noUnusedVariables',
                severity: 'error',
                description: 'editedBroken is unused',
                location: { span: [29, 41] }, // line 2 (edited line)
              },
            ],
          }),
        }
      }
      if (cmd === 'git' && args[0] === 'ls-files') {
        return { exitCode: 0, stdout: 'src/demo.ts\n', stderr: '' }
      }
      if (cmd === 'git' && args[0] === 'diff') {
        return { exitCode: 0, stdout: '@@ -2 +2 @@\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const out = await runPostEditLint(tsFile, { cwd: tmp, runner: fakeBiomeRunner })
    assert.ok(out !== null)
    assert.match(out, /Pantheon Edit-Lint/)
    assert.match(out, /L2: editedBroken is unused/)
    assert.doesNotMatch(out, /legacyUnused/, 'untouched legacy lint warning must be filtered out')

    // Integration through createV2ExecuteAfter appends diagnostic directly to edit result
    const afterHook = createV2ExecuteAfter({
      editLint: { cwd: tmp, runner: fakeBiomeRunner },
    })
    const event = {
      tool: 'edit',
      status: 'completed',
      input: { filePath: tsFile },
      result: { output: 'Edited src/demo.ts cleanly.' },
    }
    await afterHook(event)
    assert.match(event.result.output, /\[Pantheon Edit-Lint\]/)
    assert.match(event.result.output, /L2: editedBroken is unused/)

    // Fallback JSON syntax check when biome emits nothing
    const badJson = join(tmp, 'src', 'broken.json')
    writeFileSync(badJson, '{ "broken": ')
    const jsonErr = await runPostEditLint(badJson, {
      cwd: tmp,
      runner: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    })
    assert.ok(jsonErr !== null)
    assert.match(jsonErr, /JSON syntax error/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
