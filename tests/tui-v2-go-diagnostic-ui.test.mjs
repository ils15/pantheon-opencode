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
