import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { finalizeDelegation } from '../../src/pantheon/delegation-finalize.ts'
import {
  delegationToastEnabled,
  showDelegationTerminalToast,
} from '../../src/pantheon/delegation-toast.ts'

async function main(): Promise<void> {
  const toastsEnabled = delegationToastEnabled()
  if (!toastsEnabled) {
    const calls: unknown[] = []
    await showDelegationTerminalToast(
      { tui: { showToast: async () => calls.push(true) } },
      { taskID: 'toast-off', alias: 'off', agent: 'apollo', state: 'completed', timedOut: false },
    )
    assert.equal(delegationToastEnabled(), false)
    assert.equal(calls.length, 0)
  }
  if (toastsEnabled) {
    const calls: Array<{ message: string; variant: string }> = []
    const client = {
      tui: {
        showToast: async ({ body }: { body: { message: string; variant: string } }) => {
          calls.push(body)
        },
      },
    }
    const idempotentJob = {
      taskID: 'toast-idempotent',
      alias: 'apo-0',
      agent: 'apollo',
      state: 'completed' as const,
      timedOut: false,
    }
    await showDelegationTerminalToast(client, idempotentJob)
    await showDelegationTerminalToast(client, idempotentJob)
    await showDelegationTerminalToast(client, { ...idempotentJob, state: 'error', timedOut: true })
    assert.equal(calls.filter((call) => call.message.includes('apo-0')).length, 1)
    for (const [state, expected] of [
      ['completed', 'success'],
      ['error', 'error'],
      ['cancelled', 'warning'],
    ] as const) {
      await showDelegationTerminalToast(client, {
        taskID: `toast-${state}`,
        alias: 'apo-1',
        agent: 'apollo',
        state,
        timedOut: false,
      })
      assert.match(calls.at(-1)?.message ?? '', new RegExp(`apo-1.*${state}`))
      assert.equal(calls.at(-1)?.variant, expected)
    }
    await showDelegationTerminalToast(client, {
      taskID: 'toast-timeout',
      alias: 'apo-2',
      agent: 'apollo',
      state: 'error',
      timedOut: true,
    })
    assert.match(calls.at(-1)?.message ?? '', /apo-2.*timeout/)
    await showDelegationTerminalToast(
      {
        tui: {
          showToast: async () => {
            throw new Error('TUI unavailable')
          },
        },
      },
      {
        taskID: 'toast-error',
        alias: 'apo-3',
        agent: 'apollo',
        state: 'completed',
        timedOut: false,
      },
    )
  }
  const toastFailureBoard = new BackgroundJobBoard()
  toastFailureBoard.onTerminal((taskID) => {
    const job = toastFailureBoard.get(taskID)
    if (job)
      void showDelegationTerminalToast(
        {
          tui: {
            showToast: async () => {
              throw new Error('gone')
            },
          },
        },
        job,
      )
  })
  await toastFailureBoard.registerLaunch({
    taskID: 'toast-failure',
    parentSessionID: 'root',
    agent: 'apollo',
    description: 'toast failure',
  })
  await toastFailureBoard.updateStatus({ taskID: 'toast-failure', state: 'completed' })
  assert.equal(toastFailureBoard.get('toast-failure')?.state, 'completed')

  if (toastsEnabled) {
    const idempotentBoard = new BackgroundJobBoard()
    const idempotentCalls: unknown[] = []
    idempotentBoard.onTerminal((taskID) => {
      const job = idempotentBoard.get(taskID)
      if (job)
        void showDelegationTerminalToast(
          { tui: { showToast: async () => idempotentCalls.push(true) } },
          job,
        )
    })
    await idempotentBoard.registerLaunch({
      taskID: 'board-idempotent',
      parentSessionID: 'root',
      agent: 'apollo',
      description: 'idempotent terminal',
    })
    await idempotentBoard.updateStatus({ taskID: 'board-idempotent', state: 'completed' })
    await idempotentBoard.updateStatus({ taskID: 'board-idempotent', state: 'completed' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(idempotentCalls.length, 1)
  }

  const outputDir = await mkdtemp(join(tmpdir(), 'delegation-regression-'))
  try {
    const board = new BackgroundJobBoard()
    await board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'root',
      agent: 'apollo',
      description: 'echo test',
    })
    const base = {
      board,
      options: { outputDir },
      client: {
        session: {
          messages: async () => [
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'the prompt' }] },
          ],
        },
      },
    }
    const failed = await finalizeDelegation(base as never, 'child-1', { state: 'completed' })
    assert.equal(failed?.state, 'error')
    assert.notEqual(failed?.state, 'completed')

    await board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'root',
      agent: 'apollo',
      description: 'real work',
    })
    const completed = await finalizeDelegation(
      {
        ...base,
        client: {
          session: {
            messages: async () => [
              { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'real answer' }] },
            ],
          },
        },
      } as never,
      'child-2',
      { state: 'completed' },
    )
    assert.equal(completed?.state, 'completed')

    await board.registerLaunch({
      taskID: 'child-3',
      parentSessionID: 'root',
      agent: 'apollo',
      description: 'empty assistant',
    })
    const emptyAssistant = await finalizeDelegation(
      {
        ...base,
        client: { session: { messages: async () => [{ info: { role: 'assistant' }, parts: [] }] } },
      } as never,
      'child-3',
      { state: 'completed' },
    )
    assert.equal(emptyAssistant?.state, 'error')

    await board.registerLaunch({
      taskID: 'child-4',
      parentSessionID: 'root',
      agent: 'apollo',
      description: 'errored assistant',
    })
    const erroredAssistant = await finalizeDelegation(
      {
        ...base,
        client: {
          session: {
            messages: async () => [
              {
                info: { role: 'assistant', error: 'provider failed' },
                parts: [{ type: 'tool', tool: 'bash' }],
              },
            ],
          },
        },
      } as never,
      'child-4',
      { state: 'completed' },
    )
    assert.equal(erroredAssistant?.state, 'error')

    await board.registerLaunch({
      taskID: 'child-5',
      parentSessionID: 'root',
      agent: 'apollo',
      description: 'tool only',
    })
    const toolOnly = await finalizeDelegation(
      {
        ...base,
        client: {
          session: {
            messages: async () => [
              { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash' }] },
            ],
          },
        },
      } as never,
      'child-5',
      { state: 'completed' },
    )
    assert.equal(toolOnly?.state, 'completed')
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
}

main()
  .then(() => console.log('Results: 9 passed, 0 failed'))
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
