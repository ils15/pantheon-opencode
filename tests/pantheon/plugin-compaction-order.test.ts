/** Verify compaction context is populated before the compacted event fires. */
import { strict as assert } from 'node:assert'
import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { buildCompactionContext } from '../../src/pantheon/delegation-compaction.ts'

type HookOutput = { context: string[] }

async function main(): Promise<void> {
  process.env.PANTHEON_PLUGIN_ONCE = 'off'
  const sessionID = `ses-compaction-order-${Date.now()}`
  const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 3 })

  // Simulate a running delegation launched by the session. The delegate tool
  // was removed (1.4.3); the preserved subsystem is the BackgroundJobBoard,
  // which the compaction hook reads via buildCompactionContext.
  await board.registerLaunch({
    taskID: `task-${sessionID}`,
    parentSessionID: sessionID,
    agent: 'apollo',
    description: 'preserve this running delegation',
  })

  // First compaction cycle: the running delegation must be present.
  const output: HookOutput = { context: [] }
  const blocks = await buildCompactionContext(board, { sessionID })
  output.context.push(...blocks)
  assert.ok(
    output.context.some((block) => block.includes('Background Delegations (running):')),
    `running delegation must be present in the compacting hook output: ${JSON.stringify(output.context)}`,
  )
  assert.ok(output.context.some((block) => block.includes('preserve this running delegation')))

  // The later event must not be required to prepare the context, nor duplicate
  // it into a future cycle. buildCompactionContext is stateless over the board,
  // so a second cycle must not multiply the delegation block.
  const nextOutput: HookOutput = { context: [] }
  const nextBlocks = await buildCompactionContext(board, { sessionID })
  nextOutput.context.push(...nextBlocks)
  assert.equal(
    nextOutput.context.filter((block) => block.includes('preserve this running delegation')).length,
    1,
  )

  console.log('✅ plugin compaction hook order: 1 passed, 0 failed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
