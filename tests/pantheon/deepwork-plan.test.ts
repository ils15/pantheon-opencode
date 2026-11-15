import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createDeepworkTool } from '../../src/pantheon/deepwork/deepwork-tool.ts'
import {
  buildApprovalQuestion,
  buildDecisionQuestion,
  generateChatProjection,
  generateMarkdownDocument,
  generateMermaidDag,
} from '../../src/pantheon/deepwork/plan-projection.ts'
import { type DeepworkPlan, validatePlan } from '../../src/pantheon/deepwork/plan-schema.ts'
import {
  appendJournal,
  computeTaskReadiness,
  deepworkPlanJsonPath,
  deepworkPlanMdPath,
  listPlans,
  readJournal,
  readPlan,
  resolvePlanDecision,
  updateTaskState,
  verifyTaskAcceptance,
  writePlan,
} from '../../src/pantheon/deepwork/plan-tracker.ts'

function samplePlan(): DeepworkPlan {
  return {
    plan_id: 'test-auth-jwt',
    title: 'Migração de Autenticação para JWT',
    intent: 'Substituir sessões em memória por tokens JWT com refresh rotativo.',
    done_when: ['Endpoints protegidos por JWT', 'Cobertura de testes acima de 85%'],
    decisions_needed: [
      {
        id: 'D01',
        question: 'Algoritmo de assinatura para os tokens?',
        options: ['(Recomendado) EdDSA (Ed25519)', 'RS256', 'HS256'],
        status: 'pending',
      },
    ],
    risks: [
      {
        id: 'R01',
        description: 'Revogação de token antes da expiração',
        mitigation: 'Implementar blocklist em Redis',
      },
    ],
    out_of_scope: ['Migração de SSO SAML'],
    tasks: [
      {
        id: 'T01',
        title: 'Mapeamento de rotas de autenticação',
        agent: 'apollo',
        phase: 1,
        state: 'done',
        depends_on: [],
        parallel_safe: false,
        acceptance: [
          {
            kind: 'file',
            check: 'DISCOVERY.md criado',
            fails_now: true,
            verified: true,
            proof: 'sha256:abc1234',
          },
        ],
      },
      {
        id: 'T02',
        title: 'Implementação do gerador de token JWT',
        agent: 'hermes',
        phase: 2,
        state: 'in_progress',
        depends_on: ['T01'],
        parallel_safe: true,
        acceptance: [
          {
            kind: 'test',
            check: 'npm test tests/auth/jwt.test.ts',
            fails_now: true,
            verified: false,
          },
        ],
      },
      {
        id: 'T03',
        title: 'Middleware de validação de rota',
        agent: 'hermes',
        phase: 2,
        state: 'pending',
        depends_on: ['T02'],
        parallel_safe: true,
        acceptance: [
          {
            kind: 'test',
            check: 'npm test tests/auth/middleware.test.ts',
            fails_now: true,
            verified: false,
          },
        ],
      },
    ],
    metadata: {
      created_at: '2026-11-12T12:00:00.000Z',
      updated_at: '2026-11-12T12:00:00.000Z',
      version: 1,
    },
  }
}

describe('Deepwork Schema & Validation', () => {
  it('validates a conformant deepwork plan', () => {
    const plan = samplePlan()
    const validated = validatePlan(plan)
    assert.equal(validated.plan_id, 'test-auth-jwt')
    assert.equal(validated.tasks.length, 3)
  })

  it('rejects an invalid plan with missing required fields', () => {
    assert.throws(() => validatePlan({ title: 'Sem id nem intent' }), /plan_id/)
  })
})

describe('Dependency DAG & Task Readiness', () => {
  it('updates task states based on dependencies', () => {
    const raw = samplePlan()
    const readyComputed = computeTaskReadiness(raw)

    const t02 = readyComputed.tasks.find((t) => t.id === 'T02')
    assert.equal(t02?.state, 'in_progress', 'already in_progress stays in_progress')

    const t03 = readyComputed.tasks.find((t) => t.id === 'T03')
    assert.equal(t03?.state, 'blocked', 'T03 depends on T02 which is not done -> blocked')
  })

  it('marks task ready when all dependencies are done', () => {
    const raw = samplePlan()
    raw.tasks[1].state = 'done' // T02 done
    const readyComputed = computeTaskReadiness(raw)

    const t03 = readyComputed.tasks.find((t) => t.id === 'T03')
    assert.equal(t03?.state, 'ready', 'T03 becomes ready when T02 is done')
  })
})

describe('Projections (Markdown & Mermaid)', () => {
  it('generates a compact chat projection with decisions first', () => {
    const plan = samplePlan()
    const chat = generateChatProjection(plan)
    const lines = chat.split('\n')

    assert.ok(lines.length <= 15, `chat projection should be <= 15 lines, got ${lines.length}`)
    assert.match(chat, /🔗 \*\*Deeplink:\*\* \[Abrir PLAN\.md\]\(file:\/\//)
    assert.match(chat, /🔴 \*\*Decisões necessárias/)
    assert.match(chat, /\[D01\]\*\* Algoritmo de assinatura/)
    assert.match(chat, /🎯 \*\*Próxima tarefa\*\*: \*\*\[T02\]\*\*/)
    assert.match(chat, /🟢 \*\*Progresso\*\*: 1\/3 concluída\(s\)/)
  })

  it('generates a Mermaid flowchart LR with class definitions', () => {
    const plan = samplePlan()
    const mermaid = generateMermaidDag(plan)

    assert.match(mermaid, /```mermaid/)
    assert.match(mermaid, /flowchart LR/)
    assert.match(mermaid, /T01 --> T02/)
    assert.match(mermaid, /T02 --> T03/)
    assert.match(mermaid, /classDef done/)
    assert.match(mermaid, /class T01 done;/)
  })

  it('generates markdown document strictly without HTML tags', () => {
    const plan = samplePlan()
    const md = generateMarkdownDocument(plan)

    assert.match(md, /# Deepwork: Migração de Autenticação para JWT/)
    assert.match(md, /## 1\. Intenção & Objetivos/)
    assert.match(md, /## 4\. Grafo de Dependências \(DAG\)/)
    assert.match(md, /## 5\. Tarefas & Critérios de Aceite/)
    // Strictly NO HTML elements (e.g. <div, <span, <button, <table, <p)
    assert.equal(/<(?:div|span|button|table|p|a|ul|li)\b/i.test(md), false, 'strictly NO HTML')
  })

  it('builds native OpenCode question payloads for approval and decisions', () => {
    const plan = samplePlan()
    const approval = buildApprovalQuestion(plan)
    assert.match(approval.question, /Deseja aprovar o plano/)
    assert.equal(approval.options[0].startsWith('(Recomendado)'), true)

    const decision = buildDecisionQuestion(plan.decisions_needed[0])
    assert.match(decision.question, /Decisão necessária \[D01\]/)
    assert.equal(decision.options.length, 3)
  })
})

describe('Deepwork Persistence & Lifecycle Tracker', () => {
  it('persists plan.json and updates PLAN.md atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantheon-deepwork-test-'))
    try {
      const plan = samplePlan()
      await writePlan(dir, plan)

      const jsonPath = deepworkPlanJsonPath(dir, plan.plan_id)
      const mdPath = deepworkPlanMdPath(dir, plan.plan_id)

      assert.equal(existsSync(jsonPath), true)
      assert.equal(existsSync(mdPath), true)

      const loaded = await readPlan(dir, plan.plan_id)
      assert.ok(loaded)
      assert.equal(loaded.title, plan.title)

      const mdContent = readFileSync(mdPath, 'utf8')
      assert.match(mdContent, /# Deepwork:/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records events to journal.ndjson append-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantheon-deepwork-test-'))
    try {
      const slug = 'test-journal'
      await appendJournal(dir, slug, {
        type: 'plan_created',
        timestamp: new Date().toISOString(),
        payload: { title: 'Test' },
      })
      await appendJournal(dir, slug, {
        type: 'task_started',
        timestamp: new Date().toISOString(),
        payload: { taskId: 'T01' },
      })

      const events = await readJournal(dir, slug)
      assert.equal(events.length, 2)
      assert.equal(events[0].type, 'plan_created')
      assert.equal(events[1].type, 'task_started')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('updates task states and verifies acceptance criteria', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantheon-deepwork-test-'))
    try {
      const plan = samplePlan()
      await writePlan(dir, plan)

      // Update T02 state
      const updated = await updateTaskState(dir, plan.plan_id, 'T02', 'in_progress', {
        summary: 'Iniciando implementação do token',
      })
      assert.equal(updated.tasks[1].state, 'in_progress')
      assert.equal(updated.tasks[1].result?.summary, 'Iniciando implementação do token')

      // Verify acceptance criterion with proof
      const verified = await verifyTaskAcceptance(
        dir,
        plan.plan_id,
        'T02',
        0,
        true,
        'pass: 12 tests passed in 45ms',
      )
      assert.equal(verified.tasks[1].acceptance[0].verified, true)
      assert.equal(verified.tasks[1].state, 'done', 'task becomes done when all acceptance pass')

      // Resolve decision
      const resolved = await resolvePlanDecision(dir, plan.plan_id, 'D01', 'EdDSA (Ed25519)')
      assert.equal(resolved.decisions_needed[0].status, 'resolved')
      assert.equal(resolved.decisions_needed[0].chosen, 'EdDSA (Ed25519)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists existing plans in workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantheon-deepwork-test-'))
    try {
      const plan = samplePlan()
      await writePlan(dir, plan)

      const plans = await listPlans(dir)
      assert.equal(plans.length, 1)
      assert.equal(plans[0].slug, 'test-auth-jwt')
      assert.equal(plans[0].tasks_count, 3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pantheon_deepwork Tool execution', () => {
  it('executes init, status, update_task, and verify_acceptance via tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantheon-deepwork-test-'))
    try {
      const tool = createDeepworkTool(dir)
      const context = { directory: dir }

      // Init
      const initResult = await tool.execute(
        {
          action: 'init',
          slug: 'dash-ui',
          title: 'Dashboard UI Modernization',
          intent: 'Criar menu lateral e gráficos interativos',
          tasks: [
            {
              id: 'T01',
              title: 'Estruturar menu lateral',
              agent: 'aphrodite',
              acceptance: [{ kind: 'file', check: 'Sidebar.tsx exists' }],
            },
            {
              id: 'T02',
              title: 'Integrar gráficos',
              agent: 'aphrodite',
              depends_on: ['T01'],
              acceptance: [{ kind: 'test', check: 'npm test' }],
            },
          ],
        },
        context,
      )
      assert.match(initResult.output, /inicializado com sucesso/)
      assert.match(initResult.output, /Pergunta de Aprovação Nativa/)

      // Status
      const statusResult = await tool.execute({ action: 'status', slug: 'dash-ui' }, context)
      assert.match(statusResult.output, /Dashboard UI Modernization/)
      assert.match(statusResult.output, /flowchart LR/)

      // Update task
      const updateResult = await tool.execute(
        { action: 'update_task', slug: 'dash-ui', taskId: 'T01', state: 'in_progress' },
        context,
      )
      assert.match(updateResult.output, /atualizada para `in_progress`/)

      // Verify acceptance
      const verifyResult = await tool.execute(
        {
          action: 'verify_acceptance',
          slug: 'dash-ui',
          taskId: 'T01',
          checkIndex: 0,
          verified: true,
          proof: 'created src/Sidebar.tsx',
        },
        context,
      )
      assert.match(verifyResult.output, /verificado: ✅ PASS/)

      // List
      const listResult = await tool.execute({ action: 'list' }, context)
      assert.match(listResult.output, /dash-ui/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prevents data loss and ENOENT during concurrent resolve_decision calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepwork-concurrency-'))
    try {
      const tool = createDeepworkTool(dir)
      const slug = 'concurrent-decisions'
      const decisions = Array.from({ length: 6 }, (_, i) => ({
        id: `D0${i + 1}`,
        question: `Decision question ${i + 1}?`,
        options: ['Opt A', 'Opt B'],
        status: 'pending',
      }))

      await tool.execute(
        {
          action: 'init',
          slug,
          title: 'Concurrency Test Plan',
          decisions,
          tasks: [{ id: 'T01', title: 'Task 1' }],
        },
        {},
      )

      // Fire 6 concurrent resolve_decision calls simultaneously
      const results = await Promise.all(
        decisions.map((d, i) =>
          tool.execute(
            {
              action: 'resolve_decision',
              slug,
              decisionId: d.id,
              choice: `Opt A choice ${i + 1}`,
            },
            {},
          ),
        ),
      )

      for (const res of results) {
        assert.match(res.output, /resolvida com a opção/)
      }

      // Verify that all 6 decisions are resolved on disk with zero lost updates
      const updated = await readPlan(dir, slug)
      assert.ok(updated, 'Plan must exist')
      assert.equal(updated.decisions_needed.length, 6)
      for (const d of updated.decisions_needed) {
        assert.equal(d.status, 'resolved', `Decision ${d.id} must be resolved`)
        assert.match(d.chosen || '', /Opt A choice/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves project workspace directory when tool context directory is omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepwork-workspace-'))
    try {
      // Injected workspace directory (like host.location?.directory)
      const tool = createDeepworkTool(dir)
      const slug = 'workspace-plan'

      const initResult = await tool.execute(
        {
          action: 'init',
          slug,
          title: 'Workspace Test',
          tasks: [{ id: 'T01', title: 'T1' }],
        },
        {}, // Empty tool context without directory
      )

      assert.match(initResult.output, /inicializado com sucesso/)
      // Must be written in dir, not process.cwd() or HOME
      assert.ok(existsSync(join(dir, '.pantheon', 'deepwork', slug, 'plan.json')))
      assert.ok(existsSync(join(dir, '.pantheon', 'deepwork', slug, 'PLAN.md')))
      assert.match(initResult.output, new RegExp(join(dir, '.pantheon', 'deepwork', slug)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('handles multi-decision plans, single-option decisions, string acceptance criteria, and owner aliases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepwork-multi-dec-'))
    try {
      const tool = createDeepworkTool(dir)
      const slug = 'webhook-dispatcher-test'

      // Blueprint-like payload: 9 decisions (one with single option), string criteria, owner with @
      const decisions = [
        { id: 'D01', question: 'Persistência?', options: ['A', 'B'] },
        { id: 'D02', question: 'Assinatura?', options: ['HMAC', 'JWT'] },
        { id: 'D03', question: 'Idempotência?', options: ['UUID', 'Key'] },
        { id: 'D04', question: 'Backoff?', options: ['Fixo', 'Exponencial'] },
        { id: 'D05', question: 'Classificação?', options: ['Retry', 'DLQ'] },
        { id: 'D06', question: 'Concorrência?', options: ['Single', 'Worker pool'] },
        { id: 'D07', question: 'Poisoning?', options: ['Nenhum', 'Tamanho e SSRF'] },
        { id: 'D08', question: 'DLQ?', options: ['Flag', 'Tabela separada'] },
        { id: 'D09', question: 'Isolamento?', options: ['Ownership estrito: Demeter e Hermes'] }, // 1 option!
      ]

      const tasks = [
        {
          id: 'T01',
          title: 'Models e Migrations',
          owner: '@demeter', // owner alias with @
          phase: 1,
          acceptance: [
            'alembic upgrade head && alembic downgrade -1', // string criterion
            'pytest tests/test_models.py -q', // string criterion
            'WAL mode ativo', // string criterion
          ],
        },
        {
          id: 'T02',
          title: 'Core Dispatcher',
          agent: 'hermes',
          phase: 2,
          depends_on: ['T01'],
          criteria: ['pytest tests/test_dispatcher.py -q'],
        },
      ]

      const initResult = await tool.execute(
        {
          action: 'init',
          slug,
          title: 'Webhook Dispatcher',
          intent: 'Dispatcher robusto',
          decisions,
          tasks,
        },
        {},
      )

      assert.match(initResult.output, /inicializado com sucesso/)

      // Verify task normalization on disk
      const loaded = await readPlan(dir, slug)
      assert.ok(loaded, 'Plan must load successfully without null')
      assert.equal(loaded.decisions_needed.length, 9)
      assert.equal(loaded.decisions_needed[8].options.length, 1)

      const t01 = loaded.tasks.find((t) => t.id === 'T01')
      assert.ok(t01)
      assert.equal(t01.agent, 'demeter', 'agent must be normalized from @demeter')
      assert.equal(t01.acceptance.length, 3)
      assert.equal(t01.acceptance[0].check, 'alembic upgrade head && alembic downgrade -1')
      assert.equal(t01.acceptance[0].kind, 'command')
      assert.equal(t01.acceptance[1].check, 'pytest tests/test_models.py -q')
      assert.equal(t01.acceptance[1].kind, 'test')
      assert.equal(t01.acceptance[2].check, 'WAL mode ativo')

      const t02 = loaded.tasks.find((t) => t.id === 'T02')
      assert.ok(t02)
      assert.equal(t02.agent, 'hermes')
      assert.equal(t02.acceptance.length, 1)
      assert.equal(t02.acceptance[0].check, 'pytest tests/test_dispatcher.py -q')
      assert.equal(t02.acceptance[0].kind, 'test')

      // status must work without "Plano não encontrado"
      const statusRes = await tool.execute({ action: 'status', slug }, {})
      assert.match(statusRes.output, /Webhook Dispatcher/)
      assert.match(statusRes.output, /Decisões necessárias \(9\)/)

      // resolve_decision must resolve without "Plano não encontrado"
      const resolveRes = await tool.execute(
        {
          action: 'resolve_decision',
          slug,
          decisionId: 'D09',
          choice: 'Ownership estrito: Demeter e Hermes',
        },
        {},
      )
      assert.match(resolveRes.output, /resolvida/)

      // update_task must update state without "Plano não encontrado"
      const updateRes = await tool.execute(
        {
          action: 'update_task',
          slug,
          taskId: 'T01',
          state: 'in_progress',
        },
        {},
      )
      assert.match(updateRes.output, /in_progress/)

      const afterUpdate = await readPlan(dir, slug)
      assert.equal(afterUpdate?.tasks.find((t) => t.id === 'T01')?.state, 'in_progress')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
