import { strict as assert } from 'node:assert'
import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { createDelegationTools } from '../../src/pantheon/delegation.ts'

type ProbeClient = {
  session: {
    create: (input: { body: { parentID: string; title?: string } }) => Promise<{ id: string }>
    promptAsync: (input: { path: { id: string }; body: unknown }) => Promise<unknown>
    messages?: (input: { path: { id: string } }) => Promise<unknown[]>
    get?: (input: { path: { id: string } }) => Promise<unknown>
  }
  created: string[]
  prompted: string[]
}

function client(
  options: {
    messages?: () => unknown[]
    status?: string
    prompt?: (id: string, signal?: AbortSignal) => Promise<unknown>
  } = {},
): ProbeClient {
  let count = 0
  const result: ProbeClient = {
    created: [],
    prompted: [],
    session: {
      create: async () => {
        count += 1
        const id = `child_${count}`
        result.created.push(id)
        return { id }
      },
      promptAsync: async (input) => {
        result.prompted.push(input.path.id)
        if (options.prompt)
          return options.prompt(input.path.id, (input as { signal?: AbortSignal }).signal)
        return undefined // upstream 204
      },
    },
  }
  if (options.messages) result.session.messages = async () => options.messages!()
  if (options.status) result.session.get = async () => ({ status: options.status })
  return result
}

async function run(): Promise<void> {
  const root = 'root'
  const opts = { rootSessions: new Set([root]), bootstrapTimeoutMs: 10, bootstrapPollIntervalMs: 1 }

  {
    const c = client({ messages: () => [{ info: { role: 'user' } }] })
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({ board, client: c as never, options: opts })
    assert.match(
      await tools.pantheon_delegate.execute(
        { prompt: 'x', agent: 'apollo' },
        { sessionID: root, agent: 'zeus' },
      ),
      /apo-1/,
    )
  }
  {
    const c = client({ status: 'busy' })
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({ board, client: c as never, options: opts })
    assert.match(
      await tools.pantheon_delegate.execute(
        { prompt: 'x', agent: 'apollo' },
        { sessionID: root, agent: 'zeus' },
      ),
      /apo-1/,
    )
  }
  {
    const c = client({ messages: () => [] })
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({ board, client: c as never, options: opts })
    const result = await tools.pantheon_delegate.execute(
      { prompt: 'x', agent: 'apollo' },
      { sessionID: root, agent: 'zeus' },
    )
    assert.match(result, /STARTUP FAILED|BOOTSTRAP UNKNOWN/)
    assert.equal(c.created.length, 1, 'accepted-but-empty must not create a duplicate prompt')
    assert.equal(board.get('child_1')?.state, 'startup_failed')
    assert.equal(board.getRunningCount(), 0)
  }
  {
    const c = client()
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({ board, client: c as never, options: opts })
    const result = await tools.pantheon_delegate.execute(
      { prompt: 'x', agent: 'apollo' },
      { sessionID: root, agent: 'zeus' },
    )
    assert.match(result, /BOOTSTRAP UNKNOWN/)
    assert.equal(board.getRunningCount(), 0)
  }
  {
    let aborted = false
    const c = client({
      prompt: async (_id, signal) => {
        signal?.addEventListener('abort', () => {
          aborted = true
        })
        return new Promise<never>(() => {})
      },
    })
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({
      board,
      client: c as never,
      options: { ...opts, bootstrapTimeoutMs: 5 },
    })
    const result = await tools.pantheon_delegate.execute(
      { prompt: 'x', agent: 'apollo' },
      { sessionID: root, agent: 'zeus' },
    )
    assert.match(result, /STARTUP FAILED/)
    assert.equal(aborted, true, 'prompt timeout must abort the SDK request')
    assert.equal(c.created.length, 1, 'timed out prompt must not be resent')
    assert.equal(board.get('child_1')?.state, 'startup_failed')
  }
  {
    const c = client({ prompt: async () => Promise.reject(new Error('not accepted')) })
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({
      board,
      client: c as never,
      options: { ...opts, bootstrapTimeoutMs: 5 },
    })
    const result = await tools.pantheon_delegate.execute(
      { prompt: 'x', agent: 'apollo' },
      { sessionID: root, agent: 'zeus' },
    )
    assert.match(result, /STARTUP FAILED|BOOTSTRAP UNKNOWN/)
    assert.equal(c.created.length, 2, 'an explicit prompt rejection is safe to retry once')
    assert.equal(c.prompted.length, 2)
  }
}

run()
  .then(() => console.log('Results: 6 passed, 0 failed'))
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
