import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const athena = read('../src/agents/athena.md')
const zeus = read('../src/agents/zeus.md')
const deepwork = read('../commands/pantheon-deepwork.md')
const coordination = read('../src/skills/agent-coordination/SKILL.md')
const quickPlan = read('../prompts/quick-plan-large-feature.prompt.md')
const orchestration = read('../prompts/orchestrate-with-zeus.prompt.md')
const agentReturnFormat = read('../src/instructions/agent-return-format.instructions.md')

test('quick-plan prompt records unknowns and leaves user approval to Zeus', () => {
  for (const childSolicitation of [
    /@ask-questions/i,
    /\bask(?:ing)?\s+(?:the\s+)?user\b/i,
    /\bask\s+for\s+(?:user\s+)?clarification\b/i,
    /\b(?:ask|request|seek)\b.{0,40}\b(?:user|approval|clarification|decision)\b/i,
    /\b(?:wait|pause|stop)\s+(?:for|until)\s+(?:the\s+)?user\b/i,
    /ready\s+to\s+approve/i,
    /user:\s*["“]yes/i,
    /delegate\s+to\s+@apollo\?/i,
    /plan\s+[XYZ]\s+first\?/i,
  ]) {
    assert.doesNotMatch(quickPlan, childSolicitation)
  }

  assert.match(quickPlan, /return the complete Markdown plan to Zeus/i)
  assert.match(quickPlan, /document[^\n]*unknowns|open questions/i)
  assert.match(quickPlan, /Zeus publishes[\s\S]*?main conversation[\s\S]*?user approval/i)
})

test('Athena returns the complete plan to Zeus without opening approval in the child session', () => {
  assert.match(
    athena,
    /When delegated by Zeus through the root `subagent` dispatch,[\s\S]*?return the complete Markdown plan[\s\S]*?final task result/i,
  )
  assert.match(
    athena,
    /Do not call `agent\/askQuestions`, pause for user\s+input, or ask the user to approve from the child session/i,
  )
  assert.match(athena, /return the complete Markdown plan in[\s\S]*?final task result/i)
  assert.match(athena, /affected files or areas/i)
  assert.match(athena, /dependencies[\s\S]*?tests[\s\S]*?risks/i)
  assert.match(athena, /assumptions[\s\S]*?open questions[\s\S]*?acceptance criteria/i)
  assert.match(athena, /overrides the generic investigation[\s\S]*?format/i)
  assert.match(
    agentReturnFormat,
    /When Zeus delegates Athena through the root `subagent` dispatch,[\s\S]*?final task\s+result MUST contain[\s\S]*?the complete Markdown plan/i,
  )
  assert.match(
    agentReturnFormat,
    /Athena must not call `agent\/askQuestions`, pause for user input, or ask for\s+approval in the child session/i,
  )
})

test('Zeus shows Athena’s full plan in the main conversation before asking for approval', () => {
  const section = zeus.match(/## Plan Handoff and Approval([\s\S]*?)(?=\n## |\n---|$)/i)?.[1]

  assert.ok(section, 'Zeus must define a dedicated plan handoff contract')
  assert.match(section, /publish the \*\*entire returned plan as a normal assistant message/i)
  assert.match(section, /visible in the conversation before you trigger any\s+approval UI/i)
  assert.match(section, /do not summarize|without summarizing/i)
  // The slice reworded the handoff to the observed Beta-10 `subagent` dispatch;
  // the equivalent guarantee is that Zeus, not the child session, owns the
  // user-facing approval gate.
  assert.match(section, /Zeus owns the user-facing approval gate/)
  const approval = section.indexOf('After the plan has been published')
  assert.ok(
    section.indexOf('normal assistant message') < approval,
    'the full plan must be published before the approval UI is triggered',
  )
  assert.match(section, /If the runtime cannot guarantee[\s\S]*?plain text after it/i)
  assert.match(section, /if the plan is missing[\s\S]*?do not ask for approval/i)
  assert.match(section, /if the user requests changes/i)
  assert.match(section, /revised plan/i)
})

test('orchestration defaults to Athena task-result plans and keeps artifacts optional', () => {
  const athenaHandoff = orchestration.match(
    /#### When to Delegate to Athena[\s\S]*?(?=\n#### |\n---|$)/i,
  )?.[0]
  const approvalGate = orchestration.match(/#### Plan approval[\s\S]*?(?=\n#### |\n---|$)/i)?.[0]

  assert.ok(athenaHandoff, 'Athena delegation must describe its handoff')
  assert.match(athenaHandoff, /complete Markdown plan in (?:its|the) final task result/i)
  assert.match(athenaHandoff, /artifact file[\s\S]*?only when the user requests/i)
  assert.match(athenaHandoff, /(?:do not|must not) ask the user for approval in the child session/i)
  assert.doesNotMatch(athenaHandoff, /Wait for:\s*plans\/\[feature\]\/plan\.md/i)

  assert.ok(approvalGate, 'Zeus must define plan approval requirements')
  assert.match(
    approvalGate,
    /publish[\s\S]*?complete Markdown plan[\s\S]*?before asking for approval/i,
  )
  assert.match(approvalGate, /complete Markdown plan as a normal assistant message/i)
})

test('orchestration quick-reference covers the canonical fourteen-agent roster', () => {
  const matrix = orchestration.match(
    /## Quick Reference: Agent Matrix([\s\S]*?)(?=\n---|\n\*\*Version:)/i,
  )?.[1]
  const canonicalAgents = [
    'Zeus',
    'Athena',
    'Apollo',
    'Hermes',
    'Aphrodite',
    'Demeter',
    'Themis',
    'Prometheus',
    'Hephaestus',
    'Nyx',
    'Gaia',
    'Iris',
    'Mnemosyne',
    'Talos',
  ]

  assert.ok(matrix, 'quick-reference matrix must exist')
  for (const agent of canonicalAgents) {
    assert.match(matrix, new RegExp(`^\\| ${agent} \\|`, 'm'), `${agent} must be listed`)
  }
  assert.doesNotMatch(orchestration, /Authority:\*\* Delegates to 9 specialized agents/i)
})

test('/pantheon-deepwork gates discovery and implementation on the visible plan approval', () => {
  const workflow = deepwork.match(/## Workflow([\s\S]*?)(?=\n## Checkpoints)/)?.[1]

  assert.ok(workflow, 'deepwork must define its workflow phases')
  const plan = workflow.indexOf('Phase 0: PLAN AND APPROVAL')
  const visible = workflow.indexOf('main conversation')
  const approval = workflow.indexOf('explicit approval')
  const revised = workflow.indexOf('entire revised plan')
  const discovery = workflow.indexOf('Phase 1: DISCOVERY')
  const implementation = workflow.indexOf('Phase 2-N: IMPLEMENTATION')

  assert.ok(plan >= 0 && visible > plan, 'Phase 0 must display the complete plan')
  assert.ok(approval > visible, 'the approval gate must follow plan presentation')
  assert.ok(revised > approval, 'requested changes must return through a full-plan approval')
  assert.ok(discovery > approval, 'discovery must not start before plan approval')
  assert.ok(implementation > discovery, 'implementation must follow discovery')
})

test('agent coordination defines Gate 1 in the main conversation', () => {
  assert.match(coordination, /Athena returns the complete PLAN to Zeus/i)
  assert.match(coordination, /Zeus displays the full PLAN in the main conversation/i)
  assert.match(coordination, /complete revised plan and repeats Gate 1/i)
})

test('deepwork Gate 1 makes plan publication precede and separate from approval UI', () => {
  assert.match(
    deepwork,
    /publishes the full plan as a normal message[\s\S]*?approval UI only after that plan message is visible/i,
  )
  assert.match(deepwork, /cannot guarantee that order[\s\S]*?plain text after the plan/i)
})
