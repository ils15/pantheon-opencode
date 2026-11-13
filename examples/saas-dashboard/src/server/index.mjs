/**
 * API Backend implementation by @hermes.
 * REST conventions: strict error shapes, streaming CSV, async I/O.
 */

import { createServer } from 'node:http'
import { getMetricsSnapshot, streamMetricsCsv } from './metrics.mjs'

export function createMetricsServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }))
      return
    }

    if (url.pathname === '/api/metrics') {
      const data = getMetricsSnapshot()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data, count: data.length }))
      return
    }

    if (url.pathname === '/api/metrics/export') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="metrics-report.csv"',
        'Transfer-Encoding': 'chunked',
      })
      streamMetricsCsv(res)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found', message: 'Route does not exist' }))
  })
}

if (process.argv[1]?.endsWith('index.mjs')) {
  const port = process.env.PORT || 3000
  const server = createMetricsServer()
  server.listen(port, () => {
    console.log(`[saas-dashboard] Server listening on http://localhost:${port}`)
  })
}
