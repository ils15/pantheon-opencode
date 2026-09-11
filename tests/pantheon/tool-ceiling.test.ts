import { strict as assert } from 'node:assert'

import {
  handleToolCeilingEvent,
  probeToolCeiling,
  probeToolCeilingFromHost,
} from '../../src/pantheon/tool-ceiling.ts'

const validSnapshot = {
  usage: { inputTokens: 120, outputTokens: 80 },
  limit: { contextTokens: 1000 },
  supportsToolFiltering: true,
}

function hostClient(onProviders?: () => void): Parameters<typeof probeToolCeilingFromHost>[0] {
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
                  model: {
                    limit: { context: 1000 },
                    capabilities: { toolcall: true },
                  },
                },
              },
            ],
          },
        }
      },
    },
  } as Parameters<typeof probeToolCeilingFromHost>[0]
}

async function main(): Promise<void> {
  const supported = await probeToolCeiling(() => validSnapshot)
  assert.equal(supported.status, 'OK')
  if (supported.status === 'OK') assert.equal(supported.ceiling, 800)

  const hostResult = await probeToolCeilingFromHost(hostClient(), {
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'session',
        providerID: 'provider',
        modelID: 'model',
        tokens: { input: 120, output: 80 },
      },
    },
  })
  assert.equal(hostResult.status, 'OK')
  if (hostResult.status === 'OK') assert.equal(hostResult.ceiling, 800)

  let providerCalls = 0
  const wiredCeilings = new Map<string, Awaited<ReturnType<typeof probeToolCeilingFromHost>>>()
  const wiredEvent = {
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'wired-session',
        providerID: 'provider',
        modelID: 'model',
        tokens: { input: 120, output: 80 },
      },
    },
  }
  const wiredResult = await handleToolCeilingEvent(
    hostClient(() => {
      providerCalls += 1
    }),
    wiredEvent,
    wiredCeilings,
  )
  assert.equal(providerCalls, 1, 'the real event path must query the SDK provider catalogue')
  assert.equal(wiredResult?.status, 'OK')
  assert.equal(wiredCeilings.get('wired-session')?.status, 'OK')

  const diagnostics: string[] = []
  for (const malformed of [{}, { properties: {} }, { properties: { info: {} } }]) {
    const result = await handleToolCeilingEvent(
      hostClient(() => {
        throw new Error('must not query providers for malformed events')
      }),
      malformed,
      wiredCeilings,
      { warn: (message: string) => diagnostics.push(message) },
    )
    assert.equal(result?.status, 'UNSUPPORTED')
  }
  assert.equal(diagnostics.length, 3)

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

  for (const malformed of [
    { ...validSnapshot, usage: { inputTokens: -1, outputTokens: 0 } },
    { ...validSnapshot, usage: { inputTokens: Number.NaN, outputTokens: 0 } },
    { ...validSnapshot, usage: { inputTokens: '120', outputTokens: 0 } },
    { ...validSnapshot, limit: { contextTokens: -1 } },
    { ...validSnapshot, limit: { contextTokens: '1000' } },
    { ...validSnapshot, supportsToolFiltering: 'true' },
  ]) {
    assert.equal((await probeToolCeiling(() => malformed)).status, 'CORRUPT_DATA')
  }

  assert.equal(
    (
      await probeToolCeiling(() => ({
        ...validSnapshot,
        usage: { inputTokens: 1001, outputTokens: 0 },
      }))
    ).status,
    'CORRUPT_DATA',
  )
  assert.equal(
    (await probeToolCeilingFromHost(hostClient(), { type: 'session.updated', properties: {} }))
      .status,
    'UNSUPPORTED',
  )
  assert.equal(
    (
      await probeToolCeilingFromHost(
        {
          config: { providers: async () => ({ data: { providers: [] } }) },
        } as Parameters<typeof probeToolCeilingFromHost>[0],
        {
          type: 'message.updated',
          properties: {
            info: {
              sessionID: 'session',
              providerID: 'missing',
              modelID: 'missing',
              tokens: { input: 1, output: 1 },
            },
          },
        },
      )
    ).status,
    'UNSUPPORTED',
  )

  const unavailableClient = {
    config: {
      providers: async () => {
        throw new Error('provider unavailable')
      },
    },
  } as Parameters<typeof probeToolCeilingFromHost>[0]
  assert.equal(
    (
      await probeToolCeilingFromHost(unavailableClient, {
        type: 'message.updated',
        properties: {
          info: { providerID: 'provider', modelID: 'model', tokens: { input: 1, output: 1 } },
        },
      })
    ).status,
    'UNAVAILABLE',
  )
  assert.equal(
    (
      await probeToolCeilingFromHost(
        {
          config: { providers: async () => ({ error: new Error('failed') }) },
        } as Parameters<typeof probeToolCeilingFromHost>[0],
        {
          type: 'message.updated',
          properties: {
            info: { providerID: 'provider', modelID: 'model', tokens: { input: 1, output: 1 } },
          },
        },
      )
    ).status,
    'UNAVAILABLE',
  )
  assert.equal(
    (
      await probeToolCeilingFromHost(
        {
          config: { providers: async () => ({ data: { providers: 'bad' } }) },
        } as Parameters<typeof probeToolCeilingFromHost>[0],
        {
          type: 'message.updated',
          properties: {
            info: { providerID: 'provider', modelID: 'model', tokens: { input: 1, output: 1 } },
          },
        },
      )
    ).status,
    'CORRUPT_DATA',
  )
}

await main()
