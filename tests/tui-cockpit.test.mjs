import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildCockpitSnapshot,
  formatGanttBar,
  formatGateMatrixGlyphs,
  renderWorkMapLines,
} from '../src/plugins/tui/src/cockpit-state.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('cockpit-state builds Overview, Swarm Gantt bars, Work Map, and Flightdeck Gate Matrix cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cockpit-'))
  try {
    mkdirSync(join(dir, '.pantheon', 'ledger'), { recursive: true })
    writeFileSync(
      join(dir, '.pantheon', 'ledger', 'step-ledger.json'),
      JSON.stringify({
        version: 1,
        steps: {
          'step-auth': {
            stepKey: 'step-auth',
            objective: 'Implement OAuth PKCE handler',
            agent: 'hermes',
            state: 'done',
            mutatedFiles: ['src/auth.ts'],
            lastMutationAt: 1000,
            lastVerifiedAt: 2000,
            verificationExitCode: 0,
            receiptId: 'rcpt_1234',
            updatedAt: new Date(2000).toISOString(),
          },
          'step-fix': {
            stepKey: 'step-fix',
            objective: 'Fix session timeout bug',
            agent: 'talos',
            state: 'in_progress',
            taskType: 'bugfix',
            mutatedFiles: [],
            lastMutationAt: null,
            lastVerifiedAt: null,
            updatedAt: new Date(3000).toISOString(),
          },
        },
      }),
    )

    const snapshot = buildCockpitSnapshot({
      workspaceDir: dir,
      sessionTitle: 'OAuth Refactor',
      modelName: 'claude-sonnet-4.5',
      contextTokens: 48_000,
      contextWindow: 200_000,
      sessionCost: 0.42,
      cacheRate: 92,
      children: [
        {
          id: 'ses_c1',
          agent: 'athena',
          kind: 'plan',
          status: 'completed',
          cost: 0.08,
          startedAt: 1000,
          updatedAt: 5000,
          tokens: 12_000,
        },
        {
          id: 'ses_c2',
          agent: 'hermes',
          kind: 'oth',
          status: 'running',
          cost: 0.19,
          startedAt: 4000,
          updatedAt: 9000,
          tokens: 24_000,
        },
      ],
      events: [
        {
          kind: 'lsp:diagnostics',
          timestamp: 4500,
          agent: 'hermes',
          detail: 'src/auth.ts clean (0 errors)',
          severity: 'ok',
        },
        {
          kind: 'review:verdict',
          timestamp: 5500,
          agent: 'themis',
          detail: 'BLOCK: Missing rate limit on token exchange',
          severity: 'error',
        },
      ],
    })

    assert.equal(snapshot.overview.contextPercent, 24)
    assert.equal(snapshot.overview.subagentCount, 2)
    assert.ok(snapshot.overview.workMap.some((line) => line.includes('[Zeus]')))

    assert.equal(snapshot.swarm.rows.length, 2)
    assert.ok(snapshot.swarm.rows[0]?.ganttBar.includes('█'))

    assert.equal(snapshot.flightdeck.steps.length, 2)
    assert.equal(snapshot.flightdeck.logs.length, 2)
    assert.ok(snapshot.flightdeck.gateSummary.includes('allowed'))
    assert.match(formatGateMatrixGlyphs(3, 1, 1, 1), /■.*▣.*□.*✗/)

    const gantt = formatGanttBar(2000, 6000, 1000, 9000, 16)
    assert.equal(gantt.length, 16)
    assert.ok(gantt.includes('█'))

    const mapLines = renderWorkMapLines({ subagents: 2, artifacts: 3, stepsDone: 1, stepsTotal: 2 })
    assert.ok(mapLines.length >= 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index.tsx wires /pantheon-cockpit command to openCockpit', () => {
  const indexSrc = readFileSync(join(root, 'src/plugins/tui/src/index.tsx'), 'utf8')
  assert.match(indexSrc, /import \{[\s\S]*openPantheonCockpit[\s\S]*\} from '\.\/cockpit'/)
  assert.match(indexSrc, /id:\s*'pantheon\.cockpit\.open'/)
  assert.match(indexSrc, /name:\s*'pantheon-cockpit'/)
})
