/**
 * Tests for the host-real context ceiling probe (src/pantheon/tool-ceiling.ts).
 *
 * Covers the essential result classification (OK / UNSUPPORTED / UNAVAILABLE /
 * CORRUPT_DATA) and the event wiring that retains the probe result per session.
 *
 * Run with: npx tsx tests/pantheon/tool-ceiling.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  handleToolCeilingEvent,
  probeToolCeiling,
  type probeToolCeilingFromHost,
} from '../../src/pantheon/tool-ceiling.ts'

type HostClient = Parameters<typeof probeToolCeilingFromHost>[0]
type CeilingMap = Map<string, Awaited<ReturnType<typeof probeToolCeilingFromHost>>>

const validSnapshot = {
  usage: { inputTokens: 120, outputTokens: 80 },
  limit: { contextTokens: 1000 },
  supportsToolFiltering: true,
}

function hostClient(onProviders?: () => void): HostClient {
  return {
    config: {
      providers: async () => {
        onProviders?.()
        return {
          data: {
            providers: [
              {
                id: 'provider',
                models: {
                  model: { limit: { context: 1000 }, capabilities: { toolcall: true } },
                },
              },
            ],
          },
        }
      },
    },
  } as HostClient
}

async function main(): Promise<void> {
  // OK — ceiling is the context limit minus current usage.
  const ok = await probeToolCeiling(() => validSnapshot)
  assert.equal(ok.status, 'OK')
  if (ok.status === 'OK') assert.equal(ok.ceiling, 800)

  // Result classification for the non-happy paths.
  assert.equal((await probeToolCeiling()).status, 'UNSUPPORTED')
  assert.equal(
    (
      await probeToolCeiling(() => {
        throw new Error('host unavailable')
      })
    ).status,
    'UNAVAILABLE',
  )
  assert.equal(
    (await probeToolCeiling(() => ({ usage: validSnapshot.usage }))).status,
    'CORRUPT_DATA',
  )
  assert.equal(
    (await probeToolCeiling(() => ({ ...validSnapshot, supportsToolFiltering: false }))).status,
    'UNSUPPORTED',
  )

  // Event wiring — a valid event queries the catalogue once and is retained.
  const ceilings: CeilingMap = new Map()
  let providerCalls = 0
  const wired = await handleToolCeilingEvent(
    hostClient(() => {
      providerCalls += 1
    }),
    {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'wired-session',
          providerID: 'provider',
          modelID: 'model',
          tokens: { input: 120, output: 80 },
        },
      },
    },
    ceilings,
  )
  assert.equal(providerCalls, 1)
  assert.equal(wired.status, 'OK')
  assert.equal(ceilings.get('wired-session')?.status, 'OK')

  // Malformed event is diagnostic-only: no catalogue query, no map entry.
  const diagnostics: string[] = []
  const malformed = await handleToolCeilingEvent(
    hostClient(() => {
      throw new Error('must not query providers for malformed events')
    }),
    { properties: { info: {} } },
    ceilings,
    { warn: (message: string) => diagnostics.push(message) },
  )
  assert.equal(malformed.status, 'UNSUPPORTED')
  assert.equal(diagnostics.length, 1)
}

await main()
