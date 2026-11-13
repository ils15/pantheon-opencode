/**
 * Metrics Domain & CSV Streaming Service by @hermes.
 *
 * @typedef {Object} MetricItem
 * @property {string} id
 * @property {string} name
 * @property {'revenue' | 'usage' | 'churn'} category
 * @property {number} value
 * @property {string} unit
 * @property {number} changePercent
 * @property {string} updatedAt
 */

import { Readable } from 'node:stream'

export function getMetricsSnapshot() {
  return [
    {
      id: 'm1',
      name: 'Monthly Recurring Revenue (MRR)',
      category: 'revenue',
      value: 124500,
      unit: 'USD',
      changePercent: 12.4,
      updatedAt: '2026-11-13T00:00:00Z',
    },
    {
      id: 'm2',
      name: 'Active Subscribers',
      category: 'usage',
      value: 3420,
      unit: 'count',
      changePercent: 8.1,
      updatedAt: '2026-11-13T00:00:00Z',
    },
    {
      id: 'm3',
      name: 'Net Revenue Churn',
      category: 'churn',
      value: 1.2,
      unit: 'percent',
      changePercent: -0.4,
      updatedAt: '2026-11-13T00:00:00Z',
    },
    {
      id: 'm4',
      name: 'Customer Acquisition Cost (CAC)',
      category: 'revenue',
      value: 320,
      unit: 'USD',
      changePercent: -5.3,
      updatedAt: '2026-11-13T00:00:00Z',
    },
  ]
}

export function streamMetricsCsv(destination) {
  const items = getMetricsSnapshot()
  const header = 'id,name,category,value,unit,changePercent,updatedAt\n'

  const stream = new Readable({
    read() {
      this.push(header)
      for (const item of items) {
        const line = `"${item.id}","${item.name}","${item.category}",${item.value},"${item.unit}",${item.changePercent},"${item.updatedAt}"\n`
        this.push(line)
      }
      this.push(null)
    },
  })

  stream.pipe(destination)
}
