import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { getSharedBus } from '../src/pantheon/bus.ts'
import { wireCockpitBusRecorder } from '../src/pantheon/cockpit-events.ts'
import {
  buildBoardInteractionGraph,
  buildCockpitSnapshot,
  formatCockpitReplayArtifact,
  formatGanttBar,
  formatGateMatrixGlyphs,
  renderWorkMapLines,
  writeCockpitReplayArtifact,
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

    const replay = formatCockpitReplayArtifact(snapshot, new Date('2026-11-19T18:00:00Z'))
    assert.match(replay.filename, /^cockpit-replay-2026-11-19T18-00-00\.md$/)
    assert.match(replay.markdown, /```mermaid\nsequenceDiagram/)
    assert.match(replay.markdown, /athena/)
    const relWritten = writeCockpitReplayArtifact(dir, snapshot, new Date('2026-11-19T18:00:00Z'))
    assert.equal(relWritten, `.pantheon/reports/${replay.filename}`)
    const saved = readFileSync(join(dir, relWritten), 'utf8')
    assert.ok(saved.includes('## Execution Replay Diagram'))
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

test('wireCockpitBusRecorder persists PantheonBus events for cross-process TUI Flightdeck stream', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cockpit-bus-'))
  const stop = wireCockpitBusRecorder(dir)
  try {
    getSharedBus().emit('review:verdict', {
      verdict: 'APPROVE_WITH_NOTES',
      targetAgent: 'hermes',
      summary: 'Looks clean with minor naming note',
      findingsCount: 1,
      timestamp: 12_345,
    })
    const snap = buildCockpitSnapshot({ workspaceDir: dir, children: [] })
    assert.ok(snap.flightdeck.logs.some((e) => e.kind === 'review:verdict' && e.agent === 'hermes'))
  } finally {
    stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cockpit-state groups board messages into Goal -> Threads -> Workstreams across worktrees', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pantheon-cockpit-threads-'))
  try {
    const repo = join(tmp, 'repo')
    const wt = join(tmp, 'wt-tui')
    mkdirSync(join(repo, '.git', 'worktrees', 'wt-tui'), { recursive: true })
    mkdirSync(join(repo, '.pantheon', 'board'), { recursive: true })
    mkdirSync(wt, { recursive: true })

    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(repo, '.git', 'worktrees', 'wt-tui', 'commondir'), '../..\n')
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt-tui')}\n`)

    const lines = [
      JSON.stringify({
        seq: 1,
        timestamp: 1000,
        channel: 'swarm',
        threadId: 'thr-auth',
        goal: 'Ship OAuth PKCE',
        workstream: 'backend',
        stepKey: 'step-oauth',
        from: 'zeus',
        mentions: ['hermes'],
        tag: 'claim',
        body: 'Start PKCE flow',
        ephemeral: {
          role: 'oauth-worker',
          baseAgent: 'hermes',
          sessionID: 'ses_e1',
          worktreeDir: wt,
          status: 'running',
        },
      }),
      JSON.stringify({
        seq: 2,
        timestamp: 2000,
        channel: 'swarm',
        threadId: 'thr-auth',
        replyToSeq: 1,
        stepKey: 'step-oauth',
        from: 'hermes',
        mentions: ['themis'],
        tag: 'handoff',
        body: 'Ready for review',
        ephemeral: {
          role: 'oauth-worker',
          baseAgent: 'hermes',
          sessionID: 'ses_e1',
          worktreeDir: wt,
          status: 'cleaned',
        },
      }),
      JSON.stringify({
        seq: 3,
        timestamp: 3000,
        channel: 'council',
        threadId: 'thr-arch',
        goal: 'Ship OAuth PKCE',
        workstream: 'token-storage',
        from: 'apollo',
        mentions: ['zeus'],
        tag: 'note',
        body: 'Recommend memory-only refresh cache',
      }),
      '{malformed-json-line',
    ]
    writeFileSync(join(repo, '.pantheon', 'board', 'messages.ndjson'), `${lines.join('\n')}\n`)

    const snapshot = buildCockpitSnapshot({ workspaceDir: wt, children: [] })
    assert.equal(snapshot.threads.totalMessages, 3)
    assert.equal(snapshot.threads.headSeq, 3)
    assert.equal(snapshot.threads.groups.length, 1)

    const group = snapshot.threads.groups[0]
    assert.equal(group.goal, 'Ship OAuth PKCE')
    assert.equal(group.latestSeq, 3)
    assert.equal(group.threads.length, 2)

    const authThread = group.threads.find((t) => t.threadId === 'thr-auth')
    assert.ok(authThread)
    assert.equal(authThread.statusTag, 'handoff')
    assert.equal(authThread.workstreams.length, 1)
    assert.equal(authThread.workstreams[0]?.workstream, 'backend')
    assert.equal(authThread.workstreams[0]?.stepKey, 'step-oauth')
    assert.equal(authThread.workstreams[0]?.ephemeral?.role, 'oauth-worker')
    assert.equal(authThread.workstreams[0]?.ephemeral?.status, 'cleaned')
    assert.equal(authThread.workstreams[0]?.messages.length, 2)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('cockpit-state ranks attention queue decision > failure > review > stuck > quota with #seq & stepKey refs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cockpit-attn-'))
  try {
    mkdirSync(join(dir, '.pantheon', 'board'), { recursive: true })
    mkdirSync(join(dir, '.pantheon', 'telemetry'), { recursive: true })

    // Resolved deadlock (#1 -> #2 consensus) must drop out; unresolved deadlock (#6) must rank #1
    const boardLines = [
      JSON.stringify({
        seq: 1,
        timestamp: 100,
        channel: 'council',
        threadId: 'thr-resolved',
        goal: 'DB Choice',
        workstream: 'schema',
        from: 'apollo',
        mentions: ['zeus'],
        tag: 'deadlock',
        body: 'Postgres vs SQLite',
      }),
      JSON.stringify({
        seq: 2,
        timestamp: 200,
        channel: 'council',
        threadId: 'thr-resolved',
        goal: 'DB Choice',
        workstream: 'schema',
        replyToSeq: 1,
        from: 'zeus',
        mentions: [],
        tag: 'consensus',
        body: 'Resolved: SQLite FTS5',
      }),
      JSON.stringify({
        seq: 4,
        timestamp: 4000,
        channel: 'swarm',
        threadId: 'thr-build',
        goal: 'Release v2.3',
        workstream: 'runtime',
        stepKey: 'step-watchdog',
        from: 'hermes',
        mentions: ['zeus'],
        tag: 'blocker',
        body: 'Watchdog timer leak on dispose',
      }),
      JSON.stringify({
        seq: 6,
        timestamp: 2000,
        channel: 'council',
        threadId: 'thr-open-deadlock',
        goal: 'Release v2.3',
        workstream: 'agora',
        stepKey: 'step-agora',
        from: 'athena',
        mentions: ['zeus'],
        tag: 'deadlock',
        body: 'Need user tie-break on rebuttal cap',
      }),
    ]
    writeFileSync(join(dir, '.pantheon', 'board', 'messages.ndjson'), `${boardLines.join('\n')}\n`)

    const eventLines = [
      JSON.stringify({
        kind: 'board:message',
        timestamp: 100,
        agent: 'apollo',
        seq: 1,
        threadId: 'thr-resolved',
        attentionCategory: 'decision',
        detail: '[deadlock] Postgres vs SQLite',
        severity: 'warn',
      }),
      JSON.stringify({
        kind: 'board:message',
        timestamp: 2000,
        agent: 'athena',
        seq: 6,
        threadId: 'thr-open-deadlock',
        stepKey: 'step-agora',
        attentionCategory: 'decision',
        detail: '[deadlock] Need user tie-break on rebuttal cap',
        severity: 'warn',
      }),
      JSON.stringify({
        kind: 'review:verdict',
        timestamp: 9000,
        agent: 'themis',
        detail: 'APPROVE: all tests green',
        severity: 'ok',
      }),
      JSON.stringify({
        kind: 'review:verdict',
        timestamp: 5000,
        agent: 'themis',
        stepKey: 'step-review',
        attentionCategory: 'review',
        detail: 'APPROVE_WITH_NOTES: check edge case',
        severity: 'warn',
      }),
      JSON.stringify({
        kind: 'swarm:stall:detected',
        timestamp: 6000,
        agent: 'talos',
        stepKey: 'step-stuck',
        attentionCategory: 'stuck',
        detail: 'No progress for 90s',
        severity: 'warn',
      }),
      JSON.stringify({
        kind: 'quota:warning',
        timestamp: 7000,
        agent: 'zeus',
        attentionCategory: 'quota',
        detail: 'Model quota at 15% remaining',
        severity: 'warn',
      }),
    ]
    writeFileSync(
      join(dir, '.pantheon', 'telemetry', 'cockpit-events.ndjson'),
      `${eventLines.join('\n')}\n`,
    )

    const snapshot = buildCockpitSnapshot({ workspaceDir: dir, children: [] })
    assert.deepEqual(
      snapshot.attention.map((a) => [a.rank, a.category]),
      [
        [1, 'decision'],
        [2, 'failure'],
        [3, 'review'],
        [4, 'stuck'],
        [5, 'quota'],
      ],
    )
    assert.equal(snapshot.attention[0]?.seq, 6)
    assert.equal(snapshot.attention[0]?.stepKey, 'step-agora')
    assert.equal(snapshot.attention[0]?.threadId, 'thr-open-deadlock')
    assert.equal(snapshot.attention[1]?.seq, 4)
    assert.equal(snapshot.attention[1]?.stepKey, 'step-watchdog')
    assert.equal(snapshot.attention[2]?.stepKey, 'step-review')
    assert.equal(snapshot.attention[3]?.stepKey, 'step-stuck')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cockpit.tsx and settings-i18n.ts expose bilingual Swarm threads and attention queue UI', async () => {
  const { I18N, t } = await import('../src/plugins/tui/src/settings-i18n.ts')
  assert.ok(I18N.cockpit)
  assert.notEqual(t(I18N.cockpit.attentionQueue, 'pt-BR'), t(I18N.cockpit.attentionQueue, 'en'))
  assert.notEqual(t(I18N.cockpit.outcomeThreads, 'pt-BR'), t(I18N.cockpit.outcomeThreads, 'en'))

  const cockpitSrc = readFileSync(join(root, 'src/plugins/tui/src/cockpit.tsx'), 'utf8')
  assert.match(cockpitSrc, /snapshot\(\)\.attention/)
  assert.match(cockpitSrc, /snapshot\(\)\.threads\.groups/)
  assert.match(cockpitSrc, /stopMouseEvent/)
  assert.match(cockpitSrc, /handleMouseClick/)
})

test('wireCockpitBusRecorder persists subagent:start and subagent:stop telemetry events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-subagent-bus-'))
  const stop = wireCockpitBusRecorder(dir)
  try {
    getSharedBus().emit('subagent:start', {
      tool: 'task',
      agent: 'apollo',
      callID: 'call-1',
      description: 'Inspect auth flow',
      timestamp: 1000,
    })
    getSharedBus().emit('subagent:stop', {
      tool: 'task',
      agent: 'apollo',
      callID: 'call-1',
      status: 'completed',
      timestamp: 2000,
    })
    const ndjson = readFileSync(
      join(dir, '.pantheon', 'telemetry', 'cockpit-events.ndjson'),
      'utf8',
    )
    assert.match(ndjson, /"kind":"subagent:start"/)
    assert.match(ndjson, /"kind":"subagent:stop"/)
    assert.match(ndjson, /"agent":"apollo"/)
  } finally {
    stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gui-experimental.cjs uses dynamic version and fixed settings/telemetry/sqlite readers', () => {
  const bundle = readFileSync(join(root, 'src/plugins/tui/dist/gui-experimental.cjs'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'src/plugins/tui/package.json'), 'utf8'))
  assert.doesNotMatch(bundle, /v2\.3\.3/)
  assert.ok(bundle.includes(pkg.version))
  assert.match(bundle, /cockpit-settings\.json/)
  assert.match(bundle, /session_message/)
  assert.match(bundle, /parent_id/)
  assert.match(bundle, /cockpit-events\.ndjson/)
  assert.doesNotMatch(bundle, /require\(["']node:sqlite["']\)/)
})

test('buildBoardInteractionGraph extracts @mention edges, supports #seq replay cap, and enriches formatCockpitReplayArtifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-cockpit-graph-'))
  try {
    const messages = [
      {
        seq: 10,
        timestamp: 1000,
        channel: 'swarm',
        threadId: 'th-1',
        from: 'zeus',
        mentions: ['@hermes', 'hermes'],
        tag: 'claim',
        body: 'Claiming OAuth workstream for @hermes',
      },
      {
        seq: 11,
        timestamp: 2000,
        channel: 'swarm',
        threadId: 'th-1',
        from: 'hermes',
        mentions: [],
        replyToSeq: 10,
        tag: 'blocker',
        body: 'Blocked on @themis review before merge',
      },
      {
        seq: 12,
        timestamp: 3000,
        channel: 'swarm',
        threadId: 'th-1',
        from: 'themis',
        mentions: ['zeus'],
        replyToSeq: 11,
        tag: 'done',
        body: 'Approved and unblocked',
      },
    ]

    const fullGraph = buildBoardInteractionGraph(messages)
    assert.equal(fullGraph.edges.length, 3)
    assert.deepEqual(fullGraph.nodes, ['zeus', 'hermes', 'themis'])
    assert.equal(fullGraph.maxSeq, 12)
    assert.equal(fullGraph.edgeCountByPair['zeus->hermes'], 1)
    assert.equal(fullGraph.edgeCountByPair['hermes->themis'], 1)
    assert.equal(fullGraph.edgeCountByPair['themis->zeus'], 1)
    assert.equal(fullGraph.edges[1]?.replyToSeq, 10)
    assert.equal(fullGraph.edges[1]?.tag, 'blocker')

    const replayGraph = buildBoardInteractionGraph(messages, 11)
    assert.equal(replayGraph.edges.length, 2)
    assert.equal(replayGraph.maxSeq, 11)

    const snapshot = buildCockpitSnapshot({
      workspaceDir: dir,
      children: [],
      boardMessages: messages,
    })
    assert.equal(snapshot.interactions.edges.length, 3)

    const replay = formatCockpitReplayArtifact(snapshot, new Date('2026-11-27T00:00:00Z'))
    assert.match(replay.markdown, /zeus->>hermes: #10 \[claim\]/)
    assert.match(replay.markdown, /hermes->>themis: #11 \[blocker\] \(re:#10\)/)
    assert.match(replay.markdown, /themis->>zeus: #12 \[done\] \(re:#11\)/)
    assert.match(replay.markdown, /## @mention Interaction Graph \(#seq Causal Replay\)/)
    assert.match(replay.markdown, /\*\*@hermes → @themis\*\*/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gui.tsx and cockpit.tsx expose @mention interaction graph and #seq replay UI', () => {
  const guiSrc = readFileSync(join(root, 'src/plugins/tui/src/gui.tsx'), 'utf8')
  assert.match(guiSrc, /'dag' \| 'gantt' \| 'interactions'/)
  assert.match(guiSrc, /tr\('Interactions', 'Interações'\)/)
  assert.match(guiSrc, /interactionEdges\(\)/)
  assert.match(guiSrc, /edge\.replyToSeq/)

  const cockpitSrc = readFileSync(join(root, 'src/plugins/tui/src/cockpit.tsx'), 'utf8')
  assert.match(cockpitSrc, /I18N\.cockpit\.interactionGraph/)
  assert.match(cockpitSrc, /snapshot\(\)\.interactions\.edges/)
})
