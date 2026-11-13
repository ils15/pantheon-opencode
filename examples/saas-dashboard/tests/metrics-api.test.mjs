/**
 * Automated Test Suite by @hermes & @themis.
 * TDD: Verifies endpoint contracts, status codes, and streaming CSV output.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createMetricsServer } from '../src/server/index.mjs'

test('metrics server lifecycle and endpoints', async (t) => {
  const server = createMetricsServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address.port

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  await t.test('GET /api/health returns 200 with status ok', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.status, 'ok')
    assert.ok(json.timestamp)
  })

  await t.test('GET /api/metrics returns metric array snapshot', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/metrics`)
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.ok(Array.isArray(json.data))
    assert.equal(json.data.length, 4)
    assert.equal(json.data[0].id, 'm1')
  })

  await t.test('GET /api/metrics/export streams valid CSV with correct headers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/metrics/export`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/csv/)
    const text = await res.text()
    const lines = text.trim().split('\n')
    assert.equal(lines[0], 'id,name,category,value,unit,changePercent,updatedAt')
    assert.ok(lines.length >= 5)
    assert.match(lines[1], /"m1","Monthly Recurring Revenue \(MRR\)"/)
  })

  await t.test('GET /unknown-route returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown-route`)
    assert.equal(res.status, 404)
  })
})
