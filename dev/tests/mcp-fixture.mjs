import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const RESOURCE_URI = 'pickleball://fixture/serve-and-rally'
const auditFile = process.env.PICKLEBALL_MCP_AUDIT_PATH

function recordMethod(method) {
  if (typeof auditFile === 'string' && method.startsWith('resources/')) {
    appendFileSync(auditFile, `${method}\n`, { mode: 0o600 })
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function success(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  const { id, method, params } = request ?? {}
  if (typeof method !== 'string') return
  recordMethod(method)

  // Notifications have no id and do not receive a response.
  if (id === undefined) return

  if (method === 'initialize') {
    success(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { resources: { subscribe: false, listChanged: false } },
      serverInfo: { name: 'pickleball-fixture', version: '1.0.0' },
    })
    return
  }
  if (method === 'ping') {
    success(id, {})
    return
  }
  if (method === 'resources/list') {
    success(id, {
      resources: [
        {
          uri: RESOURCE_URI,
          name: 'pickleball-serve-and-rally',
          description: 'Synthetic local practice notes for a pickleball fixture.',
          mimeType: 'text/plain',
        },
      ],
    })
    return
  }
  if (method === 'resources/templates/list') {
    success(id, { resourceTemplates: [] })
    return
  }
  if (method === 'resources/read') {
    if (params?.uri !== RESOURCE_URI) {
      failure(id, -32602, 'Unknown fixture resource URI')
      return
    }
    success(id, {
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: 'text/plain',
          text: 'Synthetic pickleball practice: serve deep, then recover to ready position.',
        },
      ],
    })
    return
  }

  // Deliberately no tools/list, tools/call, or write-capable methods.
  failure(id, -32601, 'Unsupported read-only fixture operation')
})
