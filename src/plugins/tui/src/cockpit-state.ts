/**
 * cockpit-state.ts — Pure selectors, Gantt renderers, Work Map topology, and
 * Gate Matrix aggregation for the TUI Mission Control Cockpit (`Overview`,
 * `Swarm`, `Flightdeck`).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { scanPantheonArtifacts } from './artifacts-state.ts'

export type CockpitTabId = 'overview' | 'swarm' | 'flightdeck'

export interface CockpitChildEntry {
  readonly id: string
  readonly agent: string
  readonly kind: string
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown'
  readonly cost: number
  readonly startedAt: number
  readonly updatedAt: number
  readonly tokens: number
  readonly model?: string
}

export interface CockpitLogEntry {
  readonly kind: string
  readonly timestamp: number
  readonly agent: string
  readonly detail: string
  readonly severity: 'ok' | 'warn' | 'error'
}

export interface CockpitStepEntry {
  readonly stepKey: string
  readonly objective: string
  readonly agent: string
  readonly state: string
  readonly taskType?: string
  readonly mutatedCount: number
  readonly receiptId?: string
  readonly hasBaselineTree: boolean
  readonly updatedAt: string
}

export interface CockpitInput {
  readonly workspaceDir: string
  readonly sessionTitle?: string
  readonly modelName?: string
  readonly contextTokens?: number
  readonly contextWindow?: number
  readonly sessionCost?: number
  readonly cacheRate?: number
  readonly children: readonly CockpitChildEntry[]
  readonly events?: readonly CockpitLogEntry[]
  readonly isPt?: boolean
}

export interface CockpitSnapshot {
  readonly sessionTitle: string
  readonly modelName: string
  readonly overview: {
    readonly contextTokens: number
    readonly contextWindow: number
    readonly contextPercent: number
    readonly contextGauge: string
    readonly sessionCost: number
    readonly cacheRate: number
    readonly subagentCount: number
    readonly runningCount: number
    readonly velocityBars: string
    readonly workMap: readonly string[]
    readonly surfaces: ReadonlyArray<{ readonly label: string; readonly status: string }>
  }
  readonly swarm: {
    readonly activeCount: number
    readonly completedCount: number
    readonly failedCount: number
    readonly totalCost: number
    readonly rows: ReadonlyArray<
      CockpitChildEntry & {
        readonly durationSec: number
        readonly ganttBar: string
      }
    >
  }
  readonly flightdeck: {
    readonly allowed: number
    readonly approved: number
    readonly waiting: number
    readonly blocked: number
    readonly gateGlyphs: string
    readonly gateSummary: string
    readonly steps: readonly CockpitStepEntry[]
    readonly logs: readonly CockpitLogEntry[]
  }
}

export function formatGanttBar(
  startMs: number,
  endMs: number,
  minMs: number,
  maxMs: number,
  width = 24,
): string {
  const span = Math.max(1, maxMs - minMs)
  const s = Math.max(0, Math.min(width - 1, Math.floor(((startMs - minMs) / span) * width)))
  const e = Math.max(s + 1, Math.min(width, Math.ceil(((endMs - minMs) / span) * width)))
  const cells: string[] = []
  for (let i = 0; i < width; i += 1) {
    cells.push(i >= s && i < e ? '█' : '░')
  }
  return cells.join('')
}

export function formatGateMatrixGlyphs(
  allowed: number,
  approved: number,
  waiting: number,
  blocked: number,
): string {
  const cap = (n: number, ch: string) => ch.repeat(Math.min(12, Math.max(0, n)))
  const parts = [
    cap(allowed, '■'),
    cap(approved, '▣'),
    cap(waiting, '□'),
    cap(blocked, '✗'),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : '■'
}

export function renderWorkMapLines(counts: {
  readonly subagents: number
  readonly artifacts: number
  readonly stepsDone: number
  readonly stepsTotal: number
}): string[] {
  const subs = String(counts.subagents).padStart(2, ' ')
  const arts = String(counts.artifacts).padStart(2, ' ')
  const stps = `${counts.stepsDone}/${counts.stepsTotal}`
  return [
    `  [You] ────── [Zeus] ────── [Swarm (${subs})]`,
    `                 │                 │`,
    `  [Artifacts ${arts}] ─┼─ [Step Ledger ${stps}] ─ [Review & Gates]`,
    `                 │`,
    `  [FTS5 Memory] ─┴─ [AST + LSP Diagnostics]`,
  ]
}

function loadStepEntries(workspaceDir: string): CockpitStepEntry[] {
  const ledgerPath = join(workspaceDir, '.pantheon', 'ledger', 'step-ledger.json')
  if (!existsSync(ledgerPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      steps?: Record<string, Record<string, unknown>>
    }
    const list = Object.values(parsed.steps ?? {})
    return list
      .map((s) => ({
        stepKey: String(s.stepKey ?? ''),
        objective: String(s.objective ?? ''),
        agent: String(s.agent ?? 'specialist'),
        state: String(s.state ?? 'pending'),
        ...(typeof s.taskType === 'string' ? { taskType: s.taskType } : {}),
        mutatedCount: Array.isArray(s.mutatedFiles) ? s.mutatedFiles.length : 0,
        ...(typeof s.receiptId === 'string' ? { receiptId: s.receiptId } : {}),
        hasBaselineTree: typeof s.baselineTree === 'string' && s.baselineTree.length === 40,
        updatedAt: String(s.updatedAt ?? ''),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

export function buildCockpitSnapshot(input: CockpitInput): CockpitSnapshot {
  const ctxTokens = Math.max(0, input.contextTokens ?? 0)
  const ctxWindow = Math.max(1, input.contextWindow ?? 200_000)
  const ctxPct = Math.min(100, Math.round((ctxTokens / ctxWindow) * 100))
  const filled = Math.min(20, Math.round((ctxPct / 100) * 20))
  const gauge = `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${ctxPct}%`

  const artifacts = input.workspaceDir ? scanPantheonArtifacts(input.workspaceDir) : []
  const steps = input.workspaceDir ? loadStepEntries(input.workspaceDir) : []
  const stepsDone = steps.filter((s) => s.state === 'done').length

  const runningCount = input.children.filter((c) => c.status === 'running').length
  const completedCount = input.children.filter((c) => c.status === 'completed').length
  const failedCount = input.children.filter(
    (c) => c.status === 'failed' || c.status === 'interrupted',
  ).length
  const childCost = input.children.reduce((acc, c) => acc + c.cost, 0)

  const minMs = input.children.reduce((m, c) => Math.min(m, c.startedAt), Infinity)
  const maxMs = input.children.reduce((m, c) => Math.max(m, c.updatedAt), 0)
  const safeMin = Number.isFinite(minMs) ? minMs : 0
  const safeMax = maxMs > safeMin ? maxMs : safeMin + 1000

  const swarmRows = input.children.map((c) => ({
    ...c,
    durationSec: Math.max(0, Math.round((c.updatedAt - c.startedAt) / 100) / 10),
    ganttBar: formatGanttBar(c.startedAt, Math.max(c.startedAt + 1, c.updatedAt), safeMin, safeMax),
  }))

  const events = [...(input.events ?? [])].sort((a, b) => b.timestamp - a.timestamp).slice(0, 40)
  const allowed = stepsDone + events.filter((e) => e.severity === 'ok').length + completedCount
  const approved = steps.filter((s) => Boolean(s.receiptId)).length
  const waiting =
    steps.filter((s) => s.state === 'in_progress' || s.state === 'pending').length + runningCount
  const blocked =
    steps.filter((s) => s.state === 'blocked' || s.state === 'rolled_back').length +
    events.filter((e) => e.severity === 'error').length +
    failedCount

  const velocityBlocks =
    input.children.length > 0
      ? input.children
          .slice(0, 14)
          .map((c) =>
            c.tokens > 20_000 ? '█' : c.tokens > 10_000 ? '▆' : c.tokens > 3_000 ? '▄' : '▂',
          )
          .join('')
      : '▁▃▅▆▄▂'

  return {
    sessionTitle: input.sessionTitle?.trim() || (input.isPt ? 'Sessão ativa' : 'Active Session'),
    modelName: input.modelName?.trim() || 'auto',
    overview: {
      contextTokens: ctxTokens,
      contextWindow: ctxWindow,
      contextPercent: ctxPct,
      contextGauge: gauge,
      sessionCost: input.sessionCost ?? childCost,
      cacheRate: input.cacheRate ?? 0,
      subagentCount: input.children.length,
      runningCount,
      velocityBars: velocityBlocks,
      workMap: renderWorkMapLines({
        subagents: input.children.length,
        artifacts: artifacts.length,
        stepsDone,
        stepsTotal: steps.length,
      }),
      surfaces: [
        { label: 'Native Tools (29)', status: 'active' },
        { label: 'FTS5 Memory + Worktree', status: 'ready' },
        { label: 'Step-Ledger & Checkpoints', status: `${stepsDone}/${steps.length} done` },
        { label: 'LSP + Per-Edit Guardrails', status: 'active' },
        { label: 'Artifacts & Mermaid', status: `${artifacts.length} file(s)` },
      ],
    },
    swarm: {
      activeCount: runningCount,
      completedCount,
      failedCount,
      totalCost: childCost,
      rows: swarmRows,
    },
    flightdeck: {
      allowed,
      approved,
      waiting,
      blocked,
      gateGlyphs: formatGateMatrixGlyphs(allowed, approved, waiting, blocked),
      gateSummary: `${allowed} allowed · ${approved} receipts · ${waiting} active · ${blocked} blocked`,
      steps,
      logs: events,
    },
  }
}

export interface CockpitReplayExport {
  readonly filename: string
  readonly relPath: string
  readonly markdown: string
}

/**
 * Render a deterministic Markdown + Mermaid Flightdeck replay trace ready for
 * archival under `.pantheon/reports/` and inspection via `/pantheon-artifacts`.
 */
export function formatCockpitReplayArtifact(
  snapshot: CockpitSnapshot,
  now: Date = new Date(),
): CockpitReplayExport {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `cockpit-replay-${stamp}.md`
  const relPath = `.pantheon/reports/${filename}`
  const seqLines: string[] = [
    '```mermaid',
    'sequenceDiagram',
    '  participant You',
    '  participant Zeus',
  ]
  const seenAgents = new Set<string>()
  for (const row of snapshot.swarm.rows.slice(0, 12)) {
    const cleanAgent = row.agent.replace(/[^A-Za-z0-9_-]/g, '') || 'specialist'
    if (!seenAgents.has(cleanAgent)) {
      seenAgents.add(cleanAgent)
      seqLines.push(`  participant ${cleanAgent}`)
    }
    seqLines.push(
      `  Zeus->>${cleanAgent}: ${row.kind} ($${row.cost.toFixed(3)}, ${row.durationSec}s)`,
    )
    seqLines.push(`  ${cleanAgent}-->>Zeus: ${row.status}`)
  }
  if (snapshot.swarm.rows.length === 0) {
    seqLines.push('  You->>Zeus: active session telemetry snapshot')
    seqLines.push('  Zeus-->>You: Flightdeck gate check')
  }
  seqLines.push('```')

  const ganttRows =
    snapshot.swarm.rows.length > 0
      ? snapshot.swarm.rows
          .map(
            (r) =>
              `| \`@${r.agent}\` | ${r.status} | \`${r.ganttBar}\` | ${r.durationSec}s | $${r.cost.toFixed(4)} |`,
          )
          .join('\n')
      : '| _none_ | — | `░░░░░░░░░░░░` | 0s | $0.0000 |'

  const stepLines =
    snapshot.flightdeck.steps.length > 0
      ? snapshot.flightdeck.steps
          .map((s) => `- **${s.stepKey}** (\`${s.state}\`, \`@${s.agent}\`) — ${s.objective}`)
          .join('\n')
      : '- No step-ledger entries recorded.'

  const eventLines =
    snapshot.flightdeck.logs.length > 0
      ? snapshot.flightdeck.logs
          .map((e) => `- \`[${e.kind}]\` **@${e.agent}**: ${e.detail}`)
          .join('\n')
      : '- No semantic bus events recorded.'

  const markdown = [
    `# Pantheon Cockpit Flightdeck Replay`,
    '',
    `- **Session:** ${snapshot.sessionTitle}`,
    `- **Model:** ${snapshot.modelName}`,
    `- **Captured At:** ${now.toISOString()}`,
    `- **Spend / Context:** $${snapshot.overview.sessionCost.toFixed(4)} · ${snapshot.overview.contextTokens} tokens (${snapshot.overview.contextPercent}%)`,
    `- **Gate Matrix:** ${snapshot.flightdeck.gateSummary}`,
    '',
    '## Execution Replay Diagram',
    '',
    ...seqLines,
    '',
    '## Swarm Concurrency Timeline',
    '',
    '| Agent | Status | Gantt Window | Duration | Cost |',
    '|---|---|---|---|---|',
    ganttRows,
    '',
    '## Step-Ledger Checkpoints',
    '',
    stepLines,
    '',
    '## Semantic Event Stream',
    '',
    eventLines,
    '',
  ].join('\n')

  return { filename, relPath, markdown }
}

/** Confined export helper writing a Cockpit replay trace under `<workspaceDir>/.pantheon/reports/`. */
export function writeCockpitReplayArtifact(
  workspaceDir: string,
  snapshot: CockpitSnapshot,
  now: Date = new Date(),
): string {
  const reportsDir = join(workspaceDir, '.pantheon', 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const canonicalReports = realpathSync(reportsDir)
  const artifact = formatCockpitReplayArtifact(snapshot, now)
  const target = resolve(canonicalReports, artifact.filename)
  const prefix = canonicalReports.endsWith(sep) ? canonicalReports : `${canonicalReports}${sep}`
  if (!target.startsWith(prefix)) {
    throw new Error('Cockpit replay target escaped .pantheon/reports')
  }
  writeFileSync(target, artifact.markdown, 'utf8')
  return artifact.relPath
}
