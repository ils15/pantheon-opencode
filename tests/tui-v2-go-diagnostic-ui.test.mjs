import assert from 'node:assert/strict'
import test from 'node:test'

const ui = await import('../src/plugins/tui/dist/tui-v2.js')

function harness(confirm, result = { category: 'success', status: 200 }) {
  const calls = []
  const alerts = []
  const confirmations = []
  const context = {
    ui: {
      dialog: {
        confirm: async (options) => {
          confirmations.push(options)
          return confirm()
        },
        alert: async (options) => {
          alerts.push(options)
        },
      },
    },
    client: {
      rpc: (definition) => ({
        go_key_diagnostic: async (...args) => {
          calls.push({ id: definition.id, args })
          return result
        },
        status: () => {
          throw new Error('must not refresh quota')
        },
      }),
    },
    location: { scope: 'test' },
  }
  return { command: ui.quotaGoCheckCommand(context), calls, alerts, confirmations }
}

test('Go check is manual, cancelable, confirmation-gated and sends only one diagnostic RPC', async () => {
  let accept
  const h = harness(
    () =>
      new Promise((resolve) => {
        accept = resolve
      }),
  )
  assert.equal(h.command.slash.name, 'quota-go-check')
  assert.equal(h.calls.length, 0)
  const running = h.command.run()
  assert.equal(h.calls.length, 0)
  await h.command.run() // A repeated invocation cannot open a second confirmation.
  assert.equal(h.confirmations.length, 1)
  assert.match(h.confirmations[0].message, /https:\/\/opencode\.ai\/zen\/go\/v1\/usage/)
  assert.match(h.confirmations[0].message, /configured Go API key once/)
  accept(true)
  await running
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].id, 'pantheon.quota')
  assert.deepEqual(h.calls[0].args[0], {})
  for (const answer of [false, undefined]) {
    const canceled = harness(() => answer)
    await canceled.command.run()
    assert.equal(canceled.calls.length, 0)
  }
})

test('diagnostic categories use safe explanations and discard arbitrary response fields', async () => {
  const explanations = {
    not_run: /no request was sent/i,
    already_used: /no request was sent/i,
    success: /HTTP success only.*not.*stable quota contract.*parsed quota correctness/i,
    unauthorized: /request rejected; cause unknown/i,
    redirect: /not followed/i,
    http_error: /HTTP error/i,
    timeout: /timed out/i,
    network_error: /network error/i,
  }
  for (const [category, explanation] of Object.entries(explanations)) {
    const h = harness(() => true, {
      category,
      status: 401,
      content_type: 'text/html',
      body: 'SECRET',
      error: 'SECRET',
    })
    await h.command.run()
    const message = h.alerts[0].message
    assert.match(message, new RegExp(category))
    assert.match(message, explanation)
    assert.match(message, /401/)
    assert.doesNotMatch(message, /SECRET|key invalid/i)
  }
  const hostile = harness(() => true, {
    category: 'SECRET',
    status: 'SECRET',
    content_type: 'SECRET',
  })
  await hostile.command.run()
  assert.doesNotMatch(JSON.stringify(hostile.alerts), /SECRET/)
})

test('401 structural metadata is allowlisted, inconclusive, and never exposes upstream details', async () => {
  for (const [error_structure, explanation] of [
    ['present', 'erro estruturado presente'],
    ['absent', 'erro estruturado não detectado'],
    ['unavailable', 'não foi possível inspecionar'],
  ]) {
    const h = harness(() => true, {
      category: 'unauthorized',
      status: 401,
      error_structure,
      error: { code: 'UPSTREAM_SENTINEL', type: 'UPSTREAM_SENTINEL', message: 'UPSTREAM_SENTINEL' },
      body: 'UPSTREAM_SENTINEL',
      raw_response: 'UPSTREAM_SENTINEL',
      request_id: 'UPSTREAM_SENTINEL',
      byte_count: 314159,
    })
    await h.command.run()
    const message = h.alerts[0].message
    assert.ok(message.includes(explanation))
    assert.match(message, /HTTP 401/)
    assert.match(message, /cause unknown/)
    assert.doesNotMatch(message, /UPSTREAM_SENTINEL|314159|key invalid|invalid key/i)
    assert.equal(h.calls.length, 1)
  }
})

test('unexpected structural values and non-401 results retain generic wording', async () => {
  const generic = harness(() => true, { category: 'unauthorized', status: 401 })
  await generic.command.run()
  for (const error_structure of ['UPSTREAM_SENTINEL', '__proto__', 'constructor', null, {}, 42]) {
    const h = harness(() => true, { category: 'unauthorized', status: 401, error_structure })
    await h.command.run()
    assert.equal(h.alerts[0].message, generic.alerts[0].message)
  }
  for (const result of [{ category: 'http_error', status: 403 }, { category: 'unauthorized' }]) {
    const h = harness(() => true, { ...result, error_structure: 'present' })
    await h.command.run()
    assert.doesNotMatch(h.alerts[0].message, /erro estruturado/)
  }
})

test('malformed optional fields and RPC failures never disclose raw data or claim no request', async () => {
  const h = harness(() => true, { category: 'success', status: 'SECRET', content_type: 'SECRET' })
  await h.command.run()
  assert.doesNotMatch(JSON.stringify(h.alerts), /SECRET/)
  const failed = harness(() => true)
  // Simulate a transport failure after confirmation, not a provider response.
  const command = ui.quotaGoCheckCommand({
    ui: {
      dialog: { confirm: async () => true, alert: async (options) => failed.alerts.push(options) },
    },
    client: {
      rpc: () => ({
        go_key_diagnostic: async () => {
          throw new Error('SECRET')
        },
      }),
    },
    location: {},
  })
  await command.run()
  assert.doesNotMatch(JSON.stringify(failed.alerts), /SECRET|no request was sent/i)
})
