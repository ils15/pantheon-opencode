/**
 * Typed Review Verdict Tool & Auto-Remediation (`review-verdict.ts`).
 *
 * Exposes `pantheon_review_verdict` for `@themis` / review roles to record
 * structured verdicts (`APPROVE`, `APPROVE_WITH_NOTES`, `BLOCK`), emits
 * `'review:verdict'` on `getSharedBus()`, and automatically triggers a bounded
 * `ctx.session.synthetic` remediation turn when verdict === 'BLOCK'.
 */

import { getSharedBus } from './bus.ts'
import { attachThemisVerdictSafe } from './strategy-store.ts'
import { resolveMemoryStoreCwd } from './tool-context.ts'
import type { PantheonToolDef, PantheonToolResult } from './tools.ts'

export type ReviewVerdictValue = 'APPROVE' | 'APPROVE_WITH_NOTES' | 'BLOCK'

export interface ReviewFinding {
  readonly severity: 'critical' | 'major' | 'minor'
  readonly file?: string
  readonly message: string
  readonly suggestion?: string
}

export interface ReviewSyntheticSessionDomain {
  get?: (input: { readonly sessionID: string }) => Promise<unknown>
  switchAgent?: (input: { readonly sessionID: string; readonly agent: string }) => Promise<unknown>
  synthetic?: (input: {
    readonly sessionID: string
    readonly text: string
    readonly description?: string
    readonly metadata?: Readonly<Record<string, unknown>>
    readonly resume?: boolean
  }) => Promise<unknown>
}

const MAX_AUTO_REMEDIATIONS = 2

function jsonResult(payload: unknown): PantheonToolResult {
  return { output: JSON.stringify(payload) }
}

function normalizeFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewFinding[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const msg = typeof rec.message === 'string' ? rec.message.trim() : ''
    if (!msg) continue
    const sev =
      rec.severity === 'critical' || rec.severity === 'major' || rec.severity === 'minor'
        ? rec.severity
        : 'major'
    out.push({
      severity: sev,
      ...(typeof rec.file === 'string' && rec.file.trim() ? { file: rec.file.trim() } : {}),
      message: msg,
      ...(typeof rec.suggestion === 'string' && rec.suggestion.trim()
        ? { suggestion: rec.suggestion.trim() }
        : {}),
    })
  }
  return out
}

export function formatRemediationPrompt(params: {
  verdict: ReviewVerdictValue
  summary: string
  targetAgent: string
  findings: readonly ReviewFinding[]
}): string {
  const lines = [
    `[THEMIS REVIEW ${params.verdict} — AUTO REMEDIATION]`,
    `Target specialist: @${params.targetAgent}`,
    `Summary: ${params.summary}`,
  ]
  if (params.findings.length > 0) {
    lines.push('Findings to fix:')
    for (const f of params.findings) {
      const loc = f.file ? ` (${f.file})` : ''
      const fix = f.suggestion ? ` — Fix: ${f.suggestion}` : ''
      lines.push(`- [${f.severity}]${loc} ${f.message}${fix}`)
    }
  }
  lines.push('Remediate the blocking issues above and re-run targeted verification.')
  return lines.join('\n')
}

export function createReviewVerdictTool(
  sessionDomain?: ReviewSyntheticSessionDomain,
): PantheonToolDef {
  const remediationCounts = new Map<string, number>()

  return {
    name: 'pantheon_review_verdict',
    description:
      'Emit a structured Themis review verdict (APPROVE | APPROVE_WITH_NOTES | BLOCK) with ' +
      'typed findings. Emits a reactive PantheonBus event and dispatches bounded synthetic ' +
      'remediation when verdict is BLOCK.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'summary'],
      properties: {
        verdict: {
          type: 'string',
          enum: ['APPROVE', 'APPROVE_WITH_NOTES', 'BLOCK'],
          description: 'Final structured review verdict',
        },
        summary: { type: 'string', description: 'Concise review verdict summary' },
        targetAgent: {
          type: 'string',
          description: 'Specialist agent responsible for remediation (e.g. hermes, aphrodite)',
        },
        stepKey: { type: 'string', description: 'Optional associated step-ledger key' },
        findings: {
          type: 'array',
          description: 'Structured review findings',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
              file: { type: 'string' },
              message: { type: 'string' },
              suggestion: { type: 'string' },
            },
          },
        },
      },
    },
    output: {},
    execute: async (input, context) => {
      const verdict =
        input.verdict === 'APPROVE' ||
        input.verdict === 'APPROVE_WITH_NOTES' ||
        input.verdict === 'BLOCK'
          ? input.verdict
          : null
      const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
      if (!verdict) return jsonResult({ ok: false, error: 'Invalid verdict' })
      if (!summary) return jsonResult({ ok: false, error: 'summary is required' })

      const targetAgent =
        typeof input.targetAgent === 'string' && input.targetAgent.trim()
          ? input.targetAgent.trim().replace(/^@/, '')
          : 'hermes'
      const findings = normalizeFindings(input.findings)
      const ctxRec = (context ?? {}) as { sessionID?: unknown }
      const sessionID = typeof ctxRec.sessionID === 'string' ? ctxRec.sessionID : undefined

      getSharedBus().emit('review:verdict', {
        verdict,
        targetAgent,
        ...(sessionID ? { sessionID } : {}),
        summary,
        findingsCount: findings.length,
        timestamp: Date.now(),
      })

      let syntheticTriggered = false
      let syntheticSessionID: string | undefined
      let remediationAttempt = 0
      if (verdict === 'BLOCK' && sessionID && typeof sessionDomain?.synthetic === 'function') {
        const key = `${sessionID}:${targetAgent}`
        const prev = remediationCounts.get(key) ?? 0
        if (prev < MAX_AUTO_REMEDIATIONS) {
          remediationAttempt = prev + 1
          remediationCounts.set(key, remediationAttempt)
          const text = formatRemediationPrompt({ verdict, summary, targetAgent, findings })
          try {
            let dispatchSid = sessionID
            if (typeof sessionDomain.get === 'function') {
              const info = (await sessionDomain.get({ sessionID }).catch(() => undefined)) as
                | { parentID?: unknown }
                | null
                | undefined
              if (typeof info?.parentID === 'string' && info.parentID.trim()) {
                dispatchSid = info.parentID.trim()
              }
            }
            if (dispatchSid === sessionID && typeof sessionDomain.switchAgent === 'function') {
              await sessionDomain
                .switchAgent({ sessionID: dispatchSid, agent: targetAgent })
                .catch(() => {})
            }
            await sessionDomain.synthetic({
              sessionID: dispatchSid,
              text,
              description: `Themis BLOCK remediation -> @${targetAgent}`,
              metadata: { targetAgent, verdict, remediationAttempt },
              resume: true,
            })
            syntheticTriggered = true
            syntheticSessionID = dispatchSid
          } catch {
            syntheticTriggered = false
          }
        }
      } else if (verdict !== 'BLOCK' && sessionID) {
        remediationCounts.delete(`${sessionID}:${targetAgent}`)
      }

      // S4: a BLOCK is also a failed strategy. Attach it to the latest run so
      // the ladder cannot keep advertising a strategy Themis refused; a broken
      // strategy store must never fail the verdict (attachThemisVerdictSafe).
      let strategy: Record<string, unknown> | undefined
      if (verdict === 'BLOCK') {
        const stepKey =
          typeof input.stepKey === 'string' && input.stepKey.trim()
            ? input.stepKey.trim()
            : undefined
        // Without a step key the review still names the agent under review, so
        // attach to that agent's latest run — never to an unrelated agent's.
        const attach = attachThemisVerdictSafe(resolveMemoryStoreCwd(context), {
          verdict,
          ...(stepKey ? { stepKey } : { agent: targetAgent }),
        })
        strategy = {
          attached: attach.attached,
          ...(attach.runId ? { runId: attach.runId } : {}),
          ...(attach.strategyId ? { strategyId: attach.strategyId } : {}),
          ...(attach.reason ? { reason: attach.reason } : {}),
          ...(typeof attach.forcedSuccessZero === 'boolean'
            ? { forcedSuccessZero: attach.forcedSuccessZero }
            : {}),
          ...(typeof attach.objections === 'number' ? { objections: attach.objections } : {}),
          ...(attach.status ? { status: attach.status } : {}),
          ...(attach.error ? { error: attach.error } : {}),
        }
      }

      return jsonResult({
        ok: true,
        verdict,
        targetAgent,
        findingsCount: findings.length,
        syntheticTriggered,
        ...(syntheticSessionID ? { syntheticSessionID } : {}),
        ...(remediationAttempt > 0
          ? { remediationAttempt, maxRemediations: MAX_AUTO_REMEDIATIONS }
          : {}),
        ...(strategy ? { strategy } : {}),
      })
    },
  }
}
