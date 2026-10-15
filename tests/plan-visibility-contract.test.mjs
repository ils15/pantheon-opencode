import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const athena = read('../src/agents/athena.md')
const zeus = read('../src/agents/zeus.md')
const deepwork = read('../commands/pantheon-deepwork.md')
const coordination = read('../src/skills/agent-coordination/SKILL.md')

test('Athena returns the complete plan to Zeus without opening approval in the child session', () => {
  assert.match(
    athena,
    /When invoked by Zeus through `task\(\)`[\s\S]*?Do not call `agent\/askQuestions`[\s\S]*?child session/i,
  )
  assert.match(athena, /return the complete Markdown plan in[\s\S]*?final task result/i)
  assert.match(athena, /affected files or areas/i)
  assert.match(athena, /dependencies[\s\S]*?tests[\s\S]*?risks/i)
  assert.match(athena, /assumptions[\s\S]*?open questions[\s\S]*?acceptance criteria/i)
  assert.match(athena, /overrides the generic investigation[\s\S]*?format/i)
  assert.match(athena, /Do not call `agent\/askQuestions`, pause for user\s+input/i)
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
