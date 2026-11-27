/**
 * `pantheon_strategy` — record, query, inspect and prune per-step strategies.
 *
 * A separate tool surface from `memory_*`: strategy tables are never federated
 * and never returned by memory search. Actions:
 * - `record`  — persist one terminal step outcome (FTS5 summary optional)
 * - `query`   — ladder-ranked strategies (FTS5 BM25 or plain listing)
 * - `stats`   — run/aggregate counts, resolved policy and retention
 * - `prune`   — retention pass (aggregates are never pruned)
 *
 * @module pantheon/strategy-tool
 */

import {
  pruneStrategyRuns,
  queryStrategies,
  recordStrategyRunSafe,
  type StrategyRunInput,
  type StrategyStatus,
  strategyStats,
} from './strategy-store.ts'
import { resolveMemoryStoreCwd } from './tool-context.ts'
import type { PantheonToolDef, PantheonToolResult } from './tools.ts'

function jsonResult(payload: unknown): PantheonToolResult {
  return { output: JSON.stringify(payload) }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const STATUSES: readonly StrategyStatus[] = ['candidate', 'proven', 'anti_pattern']

export function createStrategyTool(fallbackDir?: string): PantheonToolDef {
  return {
    name: 'pantheon_strategy',
    description:
      'Persist and query per-step strategy outcomes (FTS5 BM25, no embeddings). ' +
      'Actions: record | query | stats | prune. Query ranks by success_rate*decay DESC, ' +
      'attempts DESC and labels proven (>=3 attempts, success >=0.8) or anti_pattern ' +
      '(>=3 attempts, failure >0.6); retention prunes runs only, never aggregates.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['record', 'query', 'stats', 'prune'],
          description: 'record | query | stats | prune',
        },
        strategyId: {
          type: 'string',
          description: 'Stable strategy identity (e.g. "hermes:feature" or a decomposition name)',
        },
        agent: { type: 'string', description: 'Owning specialist agent' },
        success: { type: 'boolean', description: 'Whether the step succeeded' },
        taskType: {
          type: 'string',
          description: 'Step task shape (feature | bugfix | refactor | chore)',
        },
        stepKey: { type: 'string', description: 'Associated step-ledger key' },
        attempt: { type: 'number', description: 'Attempt number within the step (run id suffix)' },
        wave: { type: 'number', description: 'Dependency wave index' },
        sliceCount: { type: 'number', description: 'Number of verification slices used' },
        parallel: { type: 'boolean', description: 'Whether the step ran in parallel with peers' },
        durationMs: { type: 'number', description: 'Observed wall-clock duration' },
        filesTouched: { type: 'number', description: 'Number of files mutated' },
        themisVerdict: {
          type: 'string',
          description: 'Themis verdict for this run (BLOCK forces success=0)',
        },
        retries: { type: 'number', description: 'Failed verification attempts before success' },
        errorClass: { type: 'string', description: 'Failure class for unsuccessful runs' },
        summary: { type: 'string', description: 'Searchable description of the strategy' },
        query: { type: 'string', description: 'FTS5 search terms (query action)' },
        status: {
          type: 'string',
          enum: ['candidate', 'proven', 'anti_pattern', 'all'],
          description: 'Filter query results by ladder status',
        },
        limit: { type: 'number', description: 'Maximum rows to return (default 10, max 50)' },
      },
    },
    output: {},
    execute: async (input, context) => {
      try {
        const cwd = resolveMemoryStoreCwd(context, fallbackDir)
        const action = typeof input.action === 'string' ? input.action : ''

        if (action === 'record') {
          const strategyId = optionalString(input.strategyId)
          const agent = optionalString(input.agent)
          if (!strategyId) return jsonResult({ ok: false, error: 'strategyId is required' })
          if (!agent) return jsonResult({ ok: false, error: 'agent is required' })
          if (typeof input.success !== 'boolean') {
            return jsonResult({ ok: false, error: 'success must be a boolean' })
          }
          const runInput: StrategyRunInput = {
            strategyId,
            agent,
            success: input.success,
            taskType: optionalString(input.taskType),
            stepKey: optionalString(input.stepKey),
            attempt: optionalNumber(input.attempt),
            wave: optionalNumber(input.wave),
            sliceCount: optionalNumber(input.sliceCount),
            parallel: typeof input.parallel === 'boolean' ? input.parallel : null,
            durationMs: optionalNumber(input.durationMs),
            filesTouched: optionalNumber(input.filesTouched),
            themisVerdict: optionalString(input.themisVerdict),
            retries: optionalNumber(input.retries),
            errorClass: optionalString(input.errorClass),
            summary: optionalString(input.summary),
          }
          const result = recordStrategyRunSafe(cwd, runInput)
          return jsonResult({ ...result, action })
        }

        if (action === 'query') {
          const limit =
            typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
              ? Math.min(Math.floor(input.limit), 50)
              : 10
          const rawStatus = optionalString(input.status)
          if (rawStatus && rawStatus !== 'all' && !STATUSES.includes(rawStatus as StrategyStatus)) {
            return jsonResult({ ok: false, error: `unknown status "${rawStatus}"` })
          }
          const result = queryStrategies(cwd, {
            ...(optionalString(input.query) ? { query: input.query as string } : {}),
            ...(optionalString(input.strategyId) ? { strategyId: input.strategyId as string } : {}),
            ...(optionalString(input.agent) ? { agent: input.agent as string } : {}),
            ...(rawStatus && rawStatus !== 'all'
              ? { status: rawStatus as StrategyStatus }
              : { status: 'all' as const }),
            limit,
          })
          return jsonResult({ ...result, action })
        }

        if (action === 'stats') {
          const result = strategyStats(cwd)
          return jsonResult({ ...result, action })
        }

        if (action === 'prune') {
          const result = pruneStrategyRuns(cwd, {})
          return jsonResult({
            ok: result.ok,
            action,
            deletedByAge: result.deletedByAge,
            deletedByRows: result.deletedByRows,
            remainingRuns: result.remainingRuns,
            aggregateRows: result.aggregateRows,
            ...(result.error ? { error: result.error } : {}),
          })
        }

        return jsonResult({ ok: false, error: `Unsupported action: ${action || '(missing)'}` })
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
