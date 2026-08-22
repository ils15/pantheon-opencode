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

function client(options: { messages?: () => unknown[]; status?: string } = {}): ProbeClient {
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
    assert.match(await tools.pantheon_delegate.execute({ prompt: 'x', agent: 'apollo' }, { sessionID: root, agent: 'zeus' }), /apo-1/)
  }
  {
    const c = client({ status: 'busy' })
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({ board, client: c as never, options: opts })
    assert.match(await tools.pantheon_delegate.execute({ prompt: 'x', agent: 'apollo' }, { sessionID: root, agent: 'zeus' }), /apo-1/)
  }
  {
    const c = client({ messages: () => [] })
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({ board, client: c as never, options: opts })
    const result = await tools.pantheon_delegate.execute({ prompt: 'x', agent: 'apollo' }, { sessionID: root, agent: 'zeus' })
    assert.match(result, /STARTUP FAILED|BOOTSTRAP UNKNOWN/)
    assert.equal(c.created.length, 2, 'one retry creates one fresh child')
    assert.equal(board.get('child_1')?.state, 'error')
    assert.equal(board.get('child_2')?.state, 'error')
    assert.equal(board.getRunningCount(), 0)
  }
  {
    const c = client()
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({ board, client: c as never, options: opts })
    const result = await tools.pantheon_delegate.execute({ prompt: 'x', agent: 'apollo' }, { sessionID: root, agent: 'zeus' })
    assert.match(result, /BOOTSTRAP UNKNOWN/)
    assert.equal(board.getRunningCount(), 0)
  }
}

run().then(() => console.log('Results: 4 passed, 0 failed')).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
