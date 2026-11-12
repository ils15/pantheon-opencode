/**
 * deepwork-tool.ts — OpenCode V2 tool for Pantheon Deepwork.
 *
 * Implements canonical JSON-driven plan tracking, DAG generation,
 * fail-first acceptance verification, and native OpenCode gates.
 */

import { z } from 'zod'
import type { ToolContextLike } from '../tool-context.ts'
import type { V2ToolDef, V2ToolResult } from '../tools.ts'
import {
  buildApprovalQuestion,
  generateChatProjection,
  generateMermaidDag,
} from './plan-projection.ts'
import {
  appendJournal,
  computeTaskReadiness,
  deepworkPlanJsonPath,
  deepworkPlanMdPath,
  listPlans,
  readPlan,
  resolvePlanDecision,
  updateTaskState,
  verifyTaskAcceptance,
  writePlan,
} from './plan-tracker.ts'

const DeepworkToolInputSchema = z.object({
  action: z
    .enum([
      'init',
      'status',
      'update_task',
      'verify_acceptance',
      'resolve_decision',
      'list',
      'get_approval_question',
    ])
    .default('list'),
  slug: z.string().optional(),
  title: z.string().optional(),
  intent: z.string().optional(),
  tasks: z.array(z.record(z.unknown())).optional(),
  decisions: z.array(z.record(z.unknown())).optional(),
  done_when: z.array(z.string()).optional(),
  taskId: z.string().optional(),
  state: z.enum(['pending', 'ready', 'in_progress', 'done', 'failed', 'blocked']).optional(),
  checkIndex: z.number().int().min(0).optional(),
  verified: z.boolean().optional(),
  proof: z.string().optional(),
  decisionId: z.string().optional(),
  choice: z.string().optional(),
  summary: z.string().optional(),
})

export type DeepworkToolInput = z.infer<typeof DeepworkToolInputSchema>

export function createDeepworkTool(cwd = process.cwd()): V2ToolDef {
  return {
    name: 'pantheon_deepwork',
    description:
      'Manage canonical Deepwork plans (.pantheon/deepwork/<slug>/plan.json, journal.ndjson, PLAN.md). Track DAG dependencies, update task states, record fail-first verification receipts, and inspect compact chat projections.',
    input: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'init',
            'status',
            'update_task',
            'verify_acceptance',
            'resolve_decision',
            'list',
            'get_approval_question',
          ],
          description: 'The Deepwork plan management action to perform.',
        },
        slug: {
          type: 'string',
          description: 'Unique plan slug / directory name (e.g. auth-jwt, dashboard-ui).',
        },
        title: {
          type: 'string',
          description: 'Human-readable title of the deepwork plan (for init).',
        },
        intent: {
          type: 'string',
          description: 'The intent, problem description, and objectives (for init).',
        },
        tasks: {
          type: 'array',
          description: 'List of structured tasks with acceptance criteria (for init).',
        },
        decisions: {
          type: 'array',
          description: 'List of required architectural decisions (for init).',
        },
        done_when: {
          type: 'array',
          description: 'List of done criteria strings (for init).',
        },
        taskId: {
          type: 'string',
          description: 'Target task ID (e.g. T01, T02) for updates or verification.',
        },
        state: {
          type: 'string',
          enum: ['pending', 'ready', 'in_progress', 'done', 'failed', 'blocked'],
          description: 'New state for the specified task.',
        },
        checkIndex: {
          type: 'number',
          description: 'Zero-based index of the acceptance criterion to verify.',
        },
        verified: {
          type: 'boolean',
          description: 'Whether the acceptance criterion check passed.',
        },
        proof: {
          type: 'string',
          description: 'Evidence snippet, command output, or test receipt.',
        },
        decisionId: {
          type: 'string',
          description: 'Target decision ID (e.g. D01) for resolution.',
        },
        choice: {
          type: 'string',
          description: 'The chosen option for the decision.',
        },
        summary: {
          type: 'string',
          description: 'Summary of results or deliverable for a completed task.',
        },
      },
      required: [],
    },
    output: {},
    async execute(input: Record<string, unknown>, context: unknown): Promise<V2ToolResult> {
      const parsed = DeepworkToolInputSchema.parse(input)
      const effectiveCwd =
        typeof (context as ToolContextLike)?.directory === 'string'
          ? (context as ToolContextLike).directory
          : cwd

      if (parsed.action === 'list') {
        const plans = await listPlans(effectiveCwd)
        if (plans.length === 0) {
          return {
            output: 'Nenhum plano de Deepwork encontrado em .pantheon/deepwork/.',
            title: 'Deepwork: List',
          }
        }
        const lines = [
          '### Planos de Deepwork Disponíveis:',
          '| Slug | Título | Progresso | Atualizado em |',
          '|---|---|---|---|',
        ]
        for (const p of plans) {
          lines.push(
            `| \`${p.slug}\` | ${p.title} | ${p.done_count}/${p.tasks_count} tarefas | ${p.updated_at} |`,
          )
        }
        return {
          output: lines.join('\n'),
          title: 'Deepwork: List',
        }
      }

      const slug = parsed.slug?.trim()
      if (!slug) {
        throw new Error(`O parâmetro 'slug' é obrigatório para a ação '${parsed.action}'.`)
      }

      if (parsed.action === 'init') {
        const title = parsed.title?.trim() || slug
        const intent = parsed.intent?.trim() || 'Plano de deepwork estruturado.'
        const rawTasks = parsed.tasks ?? []
        const rawDecisions = parsed.decisions ?? []
        const doneWhen = parsed.done_when ?? []

        const tasks = rawTasks.map((t, idx) => ({
          id: typeof t.id === 'string' ? t.id : `T${String(idx + 1).padStart(2, '0')}`,
          title: typeof t.title === 'string' ? t.title : `Task ${idx + 1}`,
          description: typeof t.description === 'string' ? t.description : undefined,
          agent: typeof t.agent === 'string' ? t.agent : 'zeus',
          phase: typeof t.phase === 'number' ? t.phase : 1,
          state: (typeof t.state === 'string' ? t.state : 'pending') as
            | 'pending'
            | 'ready'
            | 'in_progress'
            | 'done'
            | 'failed'
            | 'blocked',
          depends_on: Array.isArray(t.depends_on) ? (t.depends_on as string[]) : [],
          parallel_safe: Boolean(t.parallel_safe),
          acceptance: Array.isArray(t.acceptance)
            ? (
                t.acceptance as Array<{
                  kind: 'test' | 'command' | 'file' | 'manual'
                  check: string
                  fails_now?: boolean
                  verified?: boolean
                  proof?: string
                }>
              ).map((a) => ({
                kind: a.kind || 'command',
                check: a.check || 'verify',
                fails_now: a.fails_now ?? true,
                verified: a.verified ?? false,
                proof: a.proof,
              }))
            : [],
        }))

        const decisions = rawDecisions.map((d, idx) => ({
          id: typeof d.id === 'string' ? d.id : `D${String(idx + 1).padStart(2, '0')}`,
          question: typeof d.question === 'string' ? d.question : 'Decisão necessária',
          options: Array.isArray(d.options) ? (d.options as string[]) : ['Sim', 'Não'],
          chosen: typeof d.chosen === 'string' ? d.chosen : undefined,
          status: (d.chosen ? 'resolved' : 'pending') as 'pending' | 'resolved',
        }))

        const initialPlan = computeTaskReadiness({
          plan_id: slug,
          title,
          intent,
          done_when: doneWhen,
          decisions_needed: decisions,
          risks: [],
          out_of_scope: [],
          tasks,
          metadata: {
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: 1,
          },
        })

        await writePlan(effectiveCwd, initialPlan)
        await appendJournal(effectiveCwd, slug, {
          type: 'plan_created',
          timestamp: new Date().toISOString(),
          payload: { slug, title, tasks_count: tasks.length },
        })

        const projection = generateChatProjection(initialPlan, effectiveCwd)
        const approvalQ = buildApprovalQuestion(initialPlan)

        return {
          output: [
            `✅ Plano de Deepwork '${title}' inicializado com sucesso em \`.pantheon/deepwork/${slug}/\`!`,
            `- 🔗 **Deeplink PLAN.md:** [Abrir PLAN.md](file://${deepworkPlanMdPath(effectiveCwd, slug)})`,
            `- 🔗 **Deeplink plan.json:** [Abrir plan.json](file://${deepworkPlanJsonPath(effectiveCwd, slug)})`,
            '',
            projection,
            '',
            '**Pergunta de Aprovação Nativa (Gate 1):**',
            `\`${JSON.stringify(approvalQ)}\``,
          ].join('\n'),
          title: `Deepwork Init: ${slug}`,
        }
      }

      const currentPlan = await readPlan(effectiveCwd, slug)
      if (!currentPlan) {
        throw new Error(`Plano de Deepwork '${slug}' não encontrado.`)
      }

      if (parsed.action === 'status') {
        const projection = generateChatProjection(currentPlan, effectiveCwd)
        const dag = generateMermaidDag(currentPlan)
        return {
          output: [projection, '', '#### Grafo de Dependências (DAG):', dag].join('\n'),
          title: `Deepwork Status: ${slug}`,
        }
      }

      if (parsed.action === 'get_approval_question') {
        const q = buildApprovalQuestion(currentPlan)
        return {
          output: JSON.stringify(q, null, 2),
          title: `Deepwork Approval Question: ${slug}`,
        }
      }

      if (parsed.action === 'update_task') {
        if (!parsed.taskId) throw new Error("Parâmetro 'taskId' obrigatório para update_task.")
        if (!parsed.state) throw new Error("Parâmetro 'state' obrigatório para update_task.")

        const updated = await updateTaskState(effectiveCwd, slug, parsed.taskId, parsed.state, {
          summary: parsed.summary,
        })
        const projection = generateChatProjection(updated, effectiveCwd)
        return {
          output: [
            `Tarefa **[${parsed.taskId}]** atualizada para \`${parsed.state}\`.`,
            '',
            projection,
          ].join('\n'),
          title: `Deepwork Task: ${parsed.taskId} -> ${parsed.state}`,
        }
      }

      if (parsed.action === 'verify_acceptance') {
        if (!parsed.taskId)
          throw new Error("Parâmetro 'taskId' obrigatório para verify_acceptance.")
        if (parsed.checkIndex === undefined)
          throw new Error("Parâmetro 'checkIndex' obrigatório para verify_acceptance.")
        if (parsed.verified === undefined)
          throw new Error("Parâmetro 'verified' obrigatório para verify_acceptance.")

        const updated = await verifyTaskAcceptance(
          effectiveCwd,
          slug,
          parsed.taskId,
          parsed.checkIndex,
          parsed.verified,
          parsed.proof,
        )
        const projection = generateChatProjection(updated, effectiveCwd)
        return {
          output: [
            `Critério de aceite #${parsed.checkIndex} da tarefa **[${parsed.taskId}]** verificado: ${parsed.verified ? '✅ PASS' : '❌ FAIL'}.`,
            parsed.proof ? `*Evidência/Receipt:* \`${parsed.proof}\`` : '',
            '',
            projection,
          ]
            .filter(Boolean)
            .join('\n'),
          title: `Deepwork Verify: ${parsed.taskId} [${parsed.checkIndex}]`,
        }
      }

      if (parsed.action === 'resolve_decision') {
        if (!parsed.decisionId)
          throw new Error("Parâmetro 'decisionId' obrigatório para resolve_decision.")
        if (!parsed.choice) throw new Error("Parâmetro 'choice' obrigatório para resolve_decision.")

        const updated = await resolvePlanDecision(
          effectiveCwd,
          slug,
          parsed.decisionId,
          parsed.choice,
        )
        const projection = generateChatProjection(updated, effectiveCwd)
        return {
          output: [
            `Decisão **[${parsed.decisionId}]** resolvida com a opção: "${parsed.choice}".`,
            '',
            projection,
          ].join('\n'),
          title: `Deepwork Decision: ${parsed.decisionId}`,
        }
      }

      throw new Error(`Ação '${parsed.action}' não reconhecida.`)
    },
  }
}
