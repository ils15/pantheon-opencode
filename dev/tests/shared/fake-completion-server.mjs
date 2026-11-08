/**
 * Shared fixture: a deterministic OpenAI-compatible SSE completion server.
 * Extracted from the pickleball host-runtime harness so evals and canaries
 * reuse the same stub. Returns { server, url, requestCount } via promise.
 */
import { createServer } from 'node:http'

export function fakeCompletionServer() {
  let requestCount = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end()
      return
    }
    requestCount += 1
    request.resume()
    request.on('end', () => {
      const id = `pickleball-stub-${Date.now()}`
      const chunks = [
        {
          id,
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: 'pickleball-local',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        },
        {
          id,
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: 'pickleball-local',
          choices: [{ index: 0, delta: { content: 'READY' }, finish_reason: null }],
        },
        {
          id,
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: 'pickleball-local',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ]
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.requestCount = () => requestCount
      resolveServer(server)
    })
  })
}
