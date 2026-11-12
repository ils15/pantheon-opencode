/**
 * plan-projection.ts — Generates projections from canonical Deepwork JSON plans.
 *
 * Rules:
 * - JSON is truth, Markdown is projection.
 * - STRICTLY NO HTML. Everything renders natively in OpenCode Desktop & TUI.
 * - Native OpenCode `question` tool formats for approval and decisions.
 * - DAG representation using Mermaid.
 */

import { join } from 'node:path'
import type { DeepworkPlan, PlanDecision } from './plan-schema.ts'

/**
 * Generate a compact status projection for chat (<= 15 lines).
 * Puts "Needs you" (decisions) first, followed by Next task, Blocked, and Progress.
 * Includes direct clickable deeplinks (file://) to open the complete PLAN.md and plan.json.
 */
export function generateChatProjection(plan: DeepworkPlan, cwd = process.cwd()): string {
  const pendingDecisions = plan.decisions_needed.filter((d) => d.status === 'pending')
  const totalTasks = plan.tasks.length
  const doneTasks = plan.tasks.filter((t) => t.state === 'done').length
  const inProgressTasks = plan.tasks.filter((t) => t.state === 'in_progress')
  const blockedTasks = plan.tasks.filter((t) => t.state === 'blocked')
  const readyTasks = plan.tasks.filter((t) => t.state === 'ready')

  const nextTask =
    inProgressTasks[0] || readyTasks[0] || plan.tasks.find((t) => t.state === 'pending')

  const percent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0

  const absPlanMd = join(cwd, '.pantheon', 'deepwork', plan.plan_id, 'PLAN.md')
  const absPlanJson = join(cwd, '.pantheon', 'deepwork', plan.plan_id, 'plan.json')

  const lines: string[] = []
  lines.push(`### Deepwork: ${plan.title} (\`${plan.plan_id}\`)`)
  lines.push(
    `🔗 **Deeplink:** [Abrir PLAN.md](file://${absPlanMd}) · [plan.json](file://${absPlanJson})`,
  )

  if (pendingDecisions.length > 0) {
    lines.push(`🔴 **Decisões necessárias (${pendingDecisions.length})**:`)
    for (const dec of pendingDecisions.slice(0, 3)) {
      lines.push(`- **[${dec.id}]** ${dec.question}`)
    }
  }

  if (nextTask) {
    lines.push(
      `🎯 **Próxima tarefa**: **[${nextTask.id}]** ${nextTask.title} (@${nextTask.agent} · Fase ${nextTask.phase})`,
    )
  } else if (doneTasks === totalTasks && totalTasks > 0) {
    lines.push('🎉 **Todas as tarefas foram concluídas!**')
  }

  if (blockedTasks.length > 0) {
    lines.push(`🟡 **Bloqueadas**: ${blockedTasks.length} tarefa(s) aguardando dependências`)
  }

  lines.push(
    `🟢 **Progresso**: ${doneTasks}/${totalTasks} concluída(s) (${percent}%)` +
      (inProgressTasks.length > 0 ? ` · ${inProgressTasks.length} em andamento` : ''),
  )

  return lines.join('\n')
}

/**
 * Generate a Mermaid dependency DAG (`flowchart LR`) with state-based styling.
 */
export function generateMermaidDag(plan: DeepworkPlan): string {
  if (plan.tasks.length === 0) {
    return '```mermaid\nflowchart LR\n  empty["(Sem tarefas no plano)"]\n```'
  }

  const lines: string[] = ['```mermaid', 'flowchart LR']

  // Nodes definition
  for (const task of plan.tasks) {
    const cleanTitle = task.title.replace(/["\\]/g, "'")
    lines.push(`  ${task.id}["[${task.id}] ${cleanTitle}"]`)
  }

  // Edges definition
  let hasEdges = false
  for (const task of plan.tasks) {
    for (const depId of task.depends_on) {
      if (plan.tasks.some((t) => t.id === depId)) {
        lines.push(`  ${depId} --> ${task.id}`)
        hasEdges = true
      }
    }
  }

  // If no dependencies specified, link sequentially across phases for readable visual flow
  if (!hasEdges && plan.tasks.length > 1) {
    for (let i = 0; i < plan.tasks.length - 1; i++) {
      lines.push(`  ${plan.tasks[i].id} -.-> ${plan.tasks[i + 1].id}`)
    }
  }

  // Classes styling
  lines.push('  classDef done fill:#22c55e,stroke:#15803d,color:#ffffff;')
  lines.push('  classDef in_progress fill:#3b82f6,stroke:#1d4ed8,color:#ffffff;')
  lines.push('  classDef blocked fill:#eab308,stroke:#a16207,color:#000000;')
  lines.push('  classDef failed fill:#ef4444,stroke:#b91c1c,color:#ffffff;')
  lines.push('  classDef ready fill:#64748b,stroke:#334155,color:#ffffff;')

  const byState: Record<string, string[]> = {
    done: [],
    in_progress: [],
    blocked: [],
    failed: [],
    ready: [],
  }

  for (const task of plan.tasks) {
    if (byState[task.state]) {
      byState[task.state].push(task.id)
    }
  }

  for (const [state, ids] of Object.entries(byState)) {
    if (ids.length > 0) {
      lines.push(`  class ${ids.join(',')} ${state};`)
    }
  }

  lines.push('```')
  return lines.join('\n')
}

/**
 * Generate full Markdown document for `PLAN.md`.
 * Strictly zero HTML. Renders in Markdown viewers, Desktop, and TUI.
 */
export function generateMarkdownDocument(plan: DeepworkPlan): string {
  const lines: string[] = []

  lines.push(`# Deepwork: ${plan.title}`)
  lines.push('')
  lines.push(`> **ID do Plano:** \`${plan.plan_id}\`  `)
  lines.push(
    `> **Criado em:** ${plan.metadata.created_at} · **Atualizado em:** ${plan.metadata.updated_at}`,
  )
  lines.push('')

  lines.push('## 1. Intenção & Objetivos')
  lines.push(plan.intent.trim())
  lines.push('')

  if (plan.done_when.length > 0) {
    lines.push('## 2. Critérios de Conclusão (Done When)')
    for (const item of plan.done_when) {
      lines.push(`- [ ] ${item}`)
    }
    lines.push('')
  }

  if (plan.decisions_needed.length > 0) {
    lines.push('## 3. Decisões do Plano (Needs You)')
    lines.push('| ID | Pergunta | Status | Decisão Escolhida |')
    lines.push('|---|---|---|---|')
    for (const dec of plan.decisions_needed) {
      const statusIcon = dec.status === 'resolved' ? '✅ Resolvida' : '🔴 Pendente'
      const chosen = dec.chosen ?? '*(Aguardando decisão)*'
      lines.push(`| \`${dec.id}\` | ${dec.question} | ${statusIcon} | ${chosen} |`)
    }
    lines.push('')
  }

  lines.push('## 4. Grafo de Dependências (DAG)')
  lines.push(generateMermaidDag(plan))
  lines.push('')

  lines.push('## 5. Tarefas & Critérios de Aceite')
  for (const task of plan.tasks) {
    const stateIcon =
      task.state === 'done'
        ? '✅'
        : task.state === 'in_progress'
          ? '⏳'
          : task.state === 'blocked'
            ? '🚫'
            : task.state === 'failed'
              ? '❌'
              : '📋'
    lines.push(`### ${stateIcon} [${task.id}] ${task.title}`)
    lines.push(
      `- **Fase:** ${task.phase} | **Agente Responsável:** @${task.agent} | **Estado:** \`${task.state}\``,
    )
    if (task.depends_on.length > 0) {
      lines.push(`- **Depende de:** ${task.depends_on.map((d) => `\`${d}\``).join(', ')}`)
    }
    if (task.parallel_safe) {
      lines.push('- **Execução Paralela:** Isolado em worktree (`parallel_safe: true`)')
    }
    if (task.description) {
      lines.push(`- **Descrição:** ${task.description}`)
    }
    if (task.acceptance.length > 0) {
      lines.push('- **Critérios de Aceite (Fail-First):**')
      for (const acc of task.acceptance) {
        const mark = acc.verified ? '[x]' : '[ ]'
        const failFirst = acc.fails_now ? ' *(falha antes da implementação)*' : ''
        lines.push(`  - ${mark} \`${acc.kind}\`: ${acc.check}${failFirst}`)
        if (acc.proof) {
          lines.push(`    - *Evidência/Receipt:* \`${acc.proof}\``)
        }
      }
    }
    if (task.result?.summary) {
      lines.push(`- **Resultado:** ${task.result.summary}`)
    }
    lines.push('')
  }

  if (plan.risks.length > 0) {
    lines.push('## 6. Riscos & Mitigações')
    for (const r of plan.risks) {
      lines.push(`- **${r.id}:** ${r.description}`)
      if (r.mitigation) lines.push(`  - *Mitigação:* ${r.mitigation}`)
    }
    lines.push('')
  }

  if (plan.out_of_scope.length > 0) {
    lines.push('## 7. Fora de Escopo')
    for (const item of plan.out_of_scope) {
      lines.push(`- ${item}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Build parameters for the native OpenCode `question` tool for Gate 1 approval.
 */
export function buildApprovalQuestion(plan: DeepworkPlan): {
  question: string
  options: string[]
} {
  return {
    question: `Deseja aprovar o plano de Deepwork "${plan.title}" (${plan.tasks.length} tarefas)?`,
    options: [
      '(Recomendado) Aprovar e iniciar execução (Fase 1)',
      'Solicitar ajustes ou refinar tarefas',
      'Rejeitar / Cancelar plano',
    ],
  }
}

/**
 * Build parameters for the native OpenCode `question` tool for a pending decision.
 */
export function buildDecisionQuestion(decision: PlanDecision): {
  question: string
  options: string[]
} {
  const options = decision.options.map((opt, index) =>
    index === 0 && !opt.startsWith('(') ? `(Recomendado) ${opt}` : opt,
  )
  return {
    question: `Decisão necessária [${decision.id}]: ${decision.question}`,
    options,
  }
}
