import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pingConfiguredRoute, resolveConfiguredRoute } from '../scripts/jev-live-probe.mjs'

test('ping resolves the configured route and never performs a provider request', () => {
  const output = []
  const route = pingConfiguredRoute(
    {
      enabled: true,
      selection: {
        mode: 'explicit',
        provider: 'openrouter-jev',
        model: 'typesafe/jev-1.13',
      },
    },
    { stdout: (line) => output.push(line) },
  )

  assert.deepEqual(route, { providerID: 'openrouter', id: 'typesafe/jev-1.13' })
  assert.deepEqual(output, [
    '✅ configured route: openrouter/typesafe/jev-1.13 (no live provider call)',
  ])
})

test('route resolver refuses disabled, implicit, and unsupported selections', () => {
  assert.throws(
    () => resolveConfiguredRoute({ enabled: false }),
    /enabled with an explicit selection/,
  )
  assert.throws(
    () => resolveConfiguredRoute({ enabled: true, selection: { mode: 'auto' } }),
    /enabled with an explicit selection/,
  )
  assert.throws(
    () =>
      resolveConfiguredRoute({
        enabled: true,
        selection: { mode: 'explicit', provider: 'openrouter-jev', model: 'unknown' },
      }),
    /unknown or unsupported selection/,
  )
})
