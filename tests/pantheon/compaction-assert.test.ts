import { strict as assert } from 'node:assert'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import {
  type CompactionAssertDeps,
  REASSERT_HEADER,
  reassertAfterCompaction,
} from '../../src/pantheon/compaction-assert.ts'

const SESSION = 'ses_root'

async function runningBoard(): Promise<BackgroundJobBoard> {
  const board = new BackgroundJobBoard()
  await board.registerLaunch({
    taskID: 'task-1',
    parentSessionID: SESSION,
    agent: 'apollo',
    description: 'search widgets',
  })
  return board
}

function deps(board: BackgroundJobBoard, extra: Partial<CompactionAssertDeps> = {}) {
  return { sessionID: SESSION, board, ...extra }
}

async function main(): Promise<void> {
  const board = await runningBoard()
  let warned = false
  let delivered: string[] | undefined
  assert.deepEqual(
    await reassertAfterCompaction(
      deps(board, {
        logger: {
          warn: () => {
            warned = true
          },
        },
        deliverContext: (context) => {
          delivered = context
        },
      }),
    ),
    [`${REASSERT_HEADER}`, '  running [apo-1] apollo — search widgets'],
  )
  assert.deepEqual(delivered, [REASSERT_HEADER, '  running [apo-1] apollo — search widgets'])
  assert.equal(warned, false)

  const empty = new BackgroundJobBoard()
  assert.equal(await reassertAfterCompaction(deps(empty)), undefined)

  const broken = deps(
    {
      list: () => {
        throw new Error('board unavailable')
      },
    } as unknown as BackgroundJobBoard,
    {
      logger: {
        warn: () => {
          warned = true
        },
      },
    },
  )
  assert.equal(await reassertAfterCompaction(broken), undefined)
  assert.equal(warned, true)

  // Keep the public marker covered: state is carried by the board, never chat.
  assert.match(REASSERT_HEADER, /compaction/i)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
