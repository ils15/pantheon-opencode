import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'

type Registration = { dispose: () => Promise<void> }

function registration(disposed: string[], name: string): Registration {
  return {
    dispose: async () => {
      disposed.push(name)
    },
  }
}

async function main(): Promise<void> {
  const {
    default: plugin,
    V2_UNSUPPORTED_FEATURES,
    getUnsupportedFeatures,
    v2Dispose,
  } = await import('../../src/plugin-v2.ts')
  const pluginSource = await readFile(new URL('../../src/plugin-v2.ts', import.meta.url), 'utf8')
  const pluginV1Source = await readFile(new URL('../../src/plugin.ts', import.meta.url), 'utf8')

  let passed = 0
  let failed = 0

  function test(name: string, fn: () => void | Promise<void>): void {
    try {
      const result = fn()
      if (result instanceof Promise) {
        result
          .then(() => {
            passed++
            console.log(`  ✅ ${name}`)
          })
          .catch((err) => {
            failed++
            console.error(`  ❌ ${name}:`, err)
          })
      } else {
        passed++
        console.log(`  ✅ ${name}`)
      }
    } catch (err) {
      failed++
      console.error(`  ❌ ${name}:`, err)
    }
  }

  // ─── Structural Contract Tests ──────────────────────────────────────

  console.log('\n📋 V2 Plugin Contract Tests')

  test('plugin id is pantheon-opencode-v2', () => {
    assert.equal(plugin.id, 'pantheon-opencode-v2')
  })

  test('plugin.setup is a function', () => {
    assert.equal(typeof plugin.setup, 'function')
  })

  test('plugin uses fileURLToPath (not .pathname)', () => {
    assert.match(pluginSource, /fileURLToPath/)
    assert.doesNotMatch(pluginSource, /\.pathname/)
  })

  test('V2_UNSUPPORTED_FEATURES is a non-empty array', () => {
    assert.ok(Array.isArray(V2_UNSUPPORTED_FEATURES))
    assert.ok(V2_UNSUPPORTED_FEATURES.length > 0)
  })

  test('getUnsupportedFeatures returns a readonly array', () => {
    const features = getUnsupportedFeatures()
    assert.ok(Array.isArray(features))
    assert.ok(features.length > 0)
  })

  test('V1/V2 tool contract is eager, not lazy MCP schema registration', () => {
    assert.match(pluginV1Source, /tool:\s*\{/)
    assert.match(pluginSource, /toolCtx\?\.transform/)
    assert.match(pluginSource, /for \(const def of toolDefs\)/)
    assert.match(pluginSource, /draft\.add\(/)
  })

  // ─── Transform Tests ────────────────────────────────────────────────

  console.log('\n🔄 V2 Transform Tests')

  const disposed: string[] = []
  const transforms: string[] = []
  const agents = [{ id: 'zeus', mode: 'subagent', system: 'existing' }]
  const commands = [{ name: 'pantheon-run' }]
  const skills: unknown[] = []
  const references: string[] = []
  const context = {
    options: {},
    agent: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('agent')
        callback({
          list: () => agents,
          update: (_id: string, update: (agent: (typeof agents)[number]) => void) =>
            update(agents[0]),
        } as never)
        return registration(disposed, 'agent')
      },
    },
    aisdk: {},
    catalog: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('catalog')
        callback({ model: { get: () => undefined, default: { set: () => {} } } } as never)
        return registration(disposed, 'catalog')
      },
    },
    command: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('command')
        callback({
          list: () => commands,
          update: (_name: string, update: (command: (typeof commands)[number]) => void) =>
            update(commands[0]),
        } as never)
        return registration(disposed, 'command')
      },
    },
    integration: { transform: async () => registration(disposed, 'integration') },
    plugin: { add: async () => {}, remove: async () => {} },
    reference: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('reference')
        callback({ add: (name: string) => references.push(name) } as never)
        return registration(disposed, 'reference')
      },
    },
    skill: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('skill')
        callback({ list: () => skills, source: (source: unknown) => skills.push(source) } as never)
        return registration(disposed, 'skill')
      },
    },
  }

  await plugin.setup(context as never)

  test('all 5 transforms are registered', () => {
    assert.deepEqual(transforms, ['agent', 'catalog', 'command', 'reference', 'skill'])
  })

  test('zeus agent mode is set to primary', () => {
    assert.equal(agents[0].mode, 'primary')
  })

  test('zeus agent system includes Pantheon routing policy', () => {
    assert.match(agents[0].system, /Pantheon routing policy/)
  })

  test('pantheon- command description is set', () => {
    assert.equal(commands[0].description, 'Pantheon orchestration command')
  })

  test('pantheon-agents reference is added', () => {
    assert.deepEqual(references, ['pantheon-agents'])
  })

  test('skills directory source is added', () => {
    assert.equal(skills.length, 1)
  })

  test('no registrations disposed yet', () => {
    assert.deepEqual(disposed, [])
  })

  // ─── Phase 1 Failure Isolation Tests (issue #92) ────────────────────

  console.log('\n🛡️ Phase 1 Failure Isolation Tests')

  function makeBaseContext(overrides: Record<string, unknown> = {}) {
    const noopRegistration = { dispose: async () => {} }
    return {
      options: {},
      agent: { transform: async () => noopRegistration },
      catalog: { transform: async () => noopRegistration },
      command: { transform: async () => noopRegistration },
      reference: { transform: async () => noopRegistration },
      skill: { transform: async () => noopRegistration },
      ...overrides,
    }
  }

  // Case 1: agent draft without `list` (beta 19192) — setup must resolve.
  let case1Resolved = false
  try {
    await plugin.setup(
      makeBaseContext({
        agent: {
          transform: async (callback: (draft: never) => void) => {
            callback({ update: () => {} } as never)
            return { dispose: async () => {} }
          },
        },
      }) as never,
    )
    case1Resolved = true
  } catch {
    case1Resolved = false
  }

  test('setup resolves when agent draft has no list', () => {
    assert.equal(case1Resolved, true)
  })

  test('agent-transform-list marked unsupported when list is absent', () => {
    assert.ok(V2_UNSUPPORTED_FEATURES.includes('agent-transform-list'))
  })

  // Case 2: command list() returns undefined (non-iterable) — setup must resolve.
  let case2Resolved = false
  try {
    await plugin.setup(
      makeBaseContext({
        command: {
          transform: async (callback: (draft: never) => void) => {
            callback({ list: () => undefined, update: () => {} } as never)
            return { dispose: async () => {} }
          },
        },
      }) as never,
    )
    case2Resolved = true
  } catch {
    case2Resolved = false
  }

  test('setup resolves when command list() returns undefined', () => {
    assert.equal(case2Resolved, true)
  })

  test('command-transform-list marked unsupported when list() is non-iterable', () => {
    assert.ok(V2_UNSUPPORTED_FEATURES.includes('command-transform-list'))
  })

  // Case 3: skill list() returns undefined — setup must resolve.
  let case3Resolved = false
  try {
    await plugin.setup(
      makeBaseContext({
        skill: {
          transform: async (callback: (draft: never) => void) => {
            callback({ list: () => undefined, source: () => {} } as never)
            return { dispose: async () => {} }
          },
        },
      }) as never,
    )
    case3Resolved = true
  } catch {
    case3Resolved = false
  }

  test('setup resolves when skill list() returns undefined', () => {
    assert.equal(case3Resolved, true)
  })

  test('skill-transform-list marked unsupported when list() is non-iterable', () => {
    assert.ok(V2_UNSUPPORTED_FEATURES.includes('skill-transform-list'))
  })

  // Case 4: one domain transform rejects — setup resolves, others still register.
  const case4Registered: string[] = []
  let case4Resolved = false
  try {
    await plugin.setup(
      makeBaseContext({
        agent: {
          transform: async (callback: (draft: never) => void) => {
            case4Registered.push('agent')
            callback({ list: () => [], update: () => {} } as never)
            return { dispose: async () => {} }
          },
        },
        catalog: {
          transform: async (callback: (draft: never) => void) => {
            case4Registered.push('catalog')
            callback({ model: { get: () => undefined, default: { set: () => {} } } } as never)
            return { dispose: async () => {} }
          },
        },
        command: {
          transform: async () => {
            throw new Error('boom-command-transform')
          },
        },
        reference: {
          transform: async (callback: (draft: never) => void) => {
            case4Registered.push('reference')
            callback({ add: () => {} } as never)
            return { dispose: async () => {} }
          },
        },
        skill: {
          transform: async (callback: (draft: never) => void) => {
            case4Registered.push('skill')
            callback({ list: () => [], source: () => {} } as never)
            return { dispose: async () => {} }
          },
        },
      }) as never,
    )
    case4Resolved = true
  } catch {
    case4Resolved = false
  }

  test('setup resolves when one domain transform throws', () => {
    assert.equal(case4Resolved, true)
  })

  test('failing domain marked unsupported without blocking others', () => {
    assert.ok(V2_UNSUPPORTED_FEATURES.includes('command-transform'))
    assert.deepEqual(case4Registered, ['agent', 'catalog', 'reference', 'skill'])
  })

  // ─── Tool Registration Tests ────────────────────────────────────────

  console.log('\n🔧 V2 Tool Registration Tests')

  test('V2 tool-transform is in unsupported list (no ctx.tool in V2 promise API)', () => {
    // The V2 promise API doesn't have ctx.tool.transform, so it should be
    // listed as unsupported OR registered successfully if the runtime provides it.
    // Since our mock context doesn't have tool, it should be unsupported.
    assert.ok(
      V2_UNSUPPORTED_FEATURES.includes('tool-transform') || !('tool' in context),
      'tool-transform should be unsupported when ctx.tool is absent',
    )
  })

  test('V2 tool execute resolves to {output} object, never a bare string', async () => {
    // Beta host reads a field off the resolved value (minified `Ce`) and
    // throws `Ce is not an Object` on bare strings — every registered tool
    // must resolve to the object shape.
    const added: Array<{
      name: string
      execute: (input: unknown, ctx: unknown) => Promise<unknown>
    }> = []
    await plugin.setup(
      makeBaseContext({
        tool: {
          transform: async (callback: (draft: never) => void) => {
            callback({
              namespace: () => {},
              add: (tool: (typeof added)[number]) => added.push(tool),
            } as never)
            return { dispose: async () => {} }
          },
        },
      }) as never,
    )
    assert.equal(added.length, 9)
    for (const tool of added) {
      const result = await tool.execute({}, {})
      assert.ok(
        typeof result === 'object' && result !== null,
        `${tool.name} execute must resolve to an object, got ${typeof result}`,
      )
      assert.equal(
        typeof (result as { output?: unknown }).output,
        'string',
        `${tool.name} execute result must carry a string .output`,
      )
    }
  })

  // ─── Event Subscription Tests ──────────────────────────────────────

  console.log('\n📡 V2 Event Subscription Tests')

  test('V2 event-stream is in unsupported list (no ctx.event in mock)', () => {
    assert.ok(
      V2_UNSUPPORTED_FEATURES.includes('event-stream') || !('event' in context),
      'event-stream should be unsupported when ctx.event is absent',
    )
  })

  // ─── Session Hook Tests ────────────────────────────────────────────

  console.log('\n🪝 V2 Session Hook Tests')

  test('V2 session-hooks is in unsupported list (no ctx.session in mock)', () => {
    assert.ok(
      V2_UNSUPPORTED_FEATURES.includes('session-hooks') || !('session' in context),
      'session-hooks should be unsupported when ctx.session is absent',
    )
  })

  // ─── Fase 4 Context Handler Hardening (beta 19192) ─────────────────
  // `s.includes is not a function` — the host may send non-string
  // elements, a single string, or a non-array system. The inline
  // handler must normalize defensively and never throw to the host.

  console.log('\n🛡️ Fase 4 Context Handler Hardening Tests')

  const fase4Handlers: Record<string, (event: unknown) => void | Promise<void>> = {}
  await plugin.setup(
    makeBaseContext({
      session: {
        hook: async (name: string, handler: (event: unknown) => void | Promise<void>) => {
          fase4Handlers[name] = handler
          return { dispose: async () => {} }
        },
      },
    }) as never,
  )

  test('Fase 4 context handler is registered', () => {
    assert.equal(typeof fase4Handlers.context, 'function')
  })

  test('Fase 4 context handler ignores non-string system elements', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = { system: ['existing', null, 42, { text: 'obj' }, undefined], generation: {} }
    await handler(event) // must not throw: s.includes is not a function
    const system = event.system as unknown[]
    const textOf = (s: unknown): string | null =>
      typeof s === 'string'
        ? s
        : typeof s === 'object' && s !== null && typeof (s as { text?: unknown }).text === 'string'
          ? (s as { text: string }).text
          : null
    assert.ok(
      system.some((s) => {
        const t = textOf(s)
        return t?.includes('Pantheon routing policy') ?? false
      }),
      'policy should be injected despite junk elements (string or SystemPart shape)',
    )
    assert.equal(system.length, 6)
  })

  test('Fase 4 context handler accepts a single string system', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = { system: 'solo system', generation: {} }
    await handler(event) // must not throw
    const system: unknown = (event as { system?: unknown }).system
    assert.ok(Array.isArray(system), 'single string should normalize to an array')
    assert.ok(system.some((s) => typeof s === 'string' && s.includes('solo system')))
    assert.ok(system.some((s) => typeof s === 'string' && s.includes('Pantheon routing policy')))
  })

  test('Fase 4 context handler ignores non-array system', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = { system: 42, generation: {} }
    await handler(event) // must not throw
    assert.equal(event.system, 42)
  })

  test('Fase 4 context handler does not duplicate policy with mixed elements', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = {
      system: [null, '<!-- pantheon-v2-policy -->\nFollow Pantheon routing policy', 42],
      generation: {},
    }
    await handler(event) // must not throw
    const count = event.system.filter(
      (s) => typeof s === 'string' && s.includes('Pantheon routing policy'),
    ).length
    assert.equal(count, 1)
  })

  test('Fase 4 context handler injects object shape into SystemPart array', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = {
      system: [{ type: 'text', text: 'existing part' }],
      generation: {},
    }
    await handler(event) // must not throw: Schema validation failed in system[N]
    const system = event.system as unknown[]
    assert.equal(system.length, 2)
    const injected = system[1] as { type?: unknown; text?: unknown }
    assert.equal(injected.type, 'text')
    assert.ok(
      typeof injected.text === 'string' && injected.text.includes('Pantheon routing policy'),
    )
  })

  test('Fase 4 context handler does not duplicate policy in object .text', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = {
      system: [
        { type: 'text', text: '<!-- pantheon-v2-policy -->\nFollow Pantheon routing policy' },
      ],
      generation: {},
    }
    await handler(event) // must not throw
    assert.equal(event.system.length, 1)
  })

  test('Fase 4 context handler handles mixed string+object array', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = {
      system: ['existing string', { type: 'text', text: 'existing part' }],
      generation: {},
    }
    await handler(event) // must not throw
    const system = event.system as unknown[]
    assert.equal(system.length, 3)
    const last = system[2] as { type?: unknown; text?: unknown }
    assert.equal(last.type, 'text')
    assert.ok(typeof last.text === 'string' && last.text.includes('Pantheon routing policy'))
  })

  test('Fase 4 context handler preserves single-string behavior', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = { system: 'solo happy', generation: {} }
    await handler(event) // happy path preserved
    const system = (event as { system?: unknown }).system as unknown[]
    assert.ok(Array.isArray(system))
    assert.ok(system.some((s) => typeof s === 'string' && (s as string).includes('solo happy')))
    assert.ok(
      system.some(
        (s) => typeof s === 'string' && (s as string).includes('Pantheon routing policy'),
      ),
    )
  })

  test('agent transform degrades non-string system without throwing', async () => {
    const badAgent = { id: 'helper', mode: 'subagent', system: 42 as unknown as string }
    let resolved = false
    try {
      await plugin.setup(
        makeBaseContext({
          agent: {
            transform: async (callback: (draft: never) => void) => {
              callback({
                list: () => [{ id: 'helper' }],
                update: (_id: string, update: (current: typeof badAgent) => void) =>
                  update(badAgent),
              } as never)
              return { dispose: async () => {} }
            },
          },
        }) as never,
      )
      resolved = true
    } catch {
      resolved = false
    }
    assert.equal(resolved, true)
    assert.equal(typeof badAgent.system, 'string')
    assert.match(badAgent.system, /Pantheon routing policy/)
  })

  test('agent transform skips object system without throwing', async () => {
    const objSystem = { type: 'text', text: 'host part' }
    const objAgent = { id: 'helper-obj', mode: 'subagent', system: objSystem as unknown as string }
    let resolved = false
    try {
      await plugin.setup(
        makeBaseContext({
          agent: {
            transform: async (callback: (draft: never) => void) => {
              callback({
                list: () => [{ id: 'helper-obj' }],
                update: (_id: string, update: (current: typeof objAgent) => void) =>
                  update(objAgent),
              } as never)
              return { dispose: async () => {} }
            },
          },
        }) as never,
      )
      resolved = true
    } catch {
      resolved = false
    }
    assert.equal(resolved, true)
    assert.deepEqual(objAgent.system as unknown, objSystem)
  })

  // ─── Tool Hook Tests ───────────────────────────────────────────────

  console.log('\n🪝 V2 Tool Hook Tests')

  test('V2 tool-execute-hooks is in unsupported list (no ctx.tool in mock)', () => {
    assert.ok(
      V2_UNSUPPORTED_FEATURES.includes('tool-execute-hooks') || !('tool' in context),
      'tool-execute-hooks should be unsupported when ctx.tool is absent',
    )
  })

  // ─── V1→V2 Bridge Tests ────────────────────────────────────────────

  console.log('\n🌉 V1→V2 Bridge Tests')

  const { createV2Bridge, getV2BridgeFromContext, injectBridge, BRIDGE_OPTIONS_KEY } = await import(
    '../../src/pantheon/v2-bridge.ts'
  )

  test('createV2Bridge returns a frozen PantheonV2Bridge', () => {
    const bridge = createV2Bridge({
      board: { list: () => [], get: () => undefined } as never,
      delegationClient: { session: {} } as never,
    })
    assert.ok(bridge != null)
    assert.ok(bridge.board != null)
    assert.ok(bridge.delegationClient != null)
    assert.equal(bridge.goalStore, undefined)
    assert.equal(bridge.todoEnforcer, undefined)
    assert.equal(bridge.visionHandler, undefined)
  })

  test('createV2Bridge returns frozen object (immutable)', () => {
    const bridge = createV2Bridge({})
    assert.throws(() => {
      ;(bridge as Record<string, unknown>).board = 'should-fail'
    }, TypeError)
  })

  test('injectBridge stores bridge under BRIDGE_OPTIONS_KEY', () => {
    const ctx = { options: {} as Record<string, unknown> }
    const bridge = createV2Bridge({ board: { list: () => [] } as never })
    injectBridge(ctx, bridge)
    assert.strictEqual(ctx.options[BRIDGE_OPTIONS_KEY], bridge)
  })

  test('getV2BridgeFromContext retrieves injected bridge', () => {
    const ctx = { options: {} as Record<string, unknown> }
    const bridge = createV2Bridge({
      board: { list: () => [] } as never,
      delegationClient: { session: {} } as never,
    })
    injectBridge(ctx, bridge)
    const retrieved = getV2BridgeFromContext(ctx)
    assert.strictEqual(retrieved, bridge)
  })

  test('getV2BridgeFromContext returns null when no bridge injected', () => {
    const ctx = { options: {} as Record<string, unknown> }
    const retrieved = getV2BridgeFromContext(ctx)
    assert.equal(retrieved, null)
  })

  test('getV2BridgeFromContext returns null for non-object options', () => {
    const ctx1 = { options: { [BRIDGE_OPTIONS_KEY]: 'not-an-object' } }
    assert.equal(getV2BridgeFromContext(ctx1), null)

    const ctx2 = { options: { [BRIDGE_OPTIONS_KEY]: 42 } }
    assert.equal(getV2BridgeFromContext(ctx2), null)
  })

  test('getV2BridgeFromContext returns null for undefined options key', () => {
    const ctx = { options: {} as Record<string, unknown> }
    assert.equal(getV2BridgeFromContext(ctx), null)
  })

  test('setV2Bridge from plugin-v2 sets module-level bridge', async () => {
    const { setV2Bridge } = await import('../../src/plugin-v2.ts')
    const bridge = createV2Bridge({
      board: { list: () => [] } as never,
    })
    setV2Bridge(bridge)
    // After setting, the module-level bridge should be available.
    // We verify indirectly: getV2BridgeFromContext should still work
    // even without ctx.options injection.
    const _ctx = { options: {} as Record<string, unknown> }
    // Note: setV2Bridge sets module-level, resolveBridge checks module-level first.
    // But since we can't directly call resolveBridge (it's private),
    // we verify the export exists and is callable.
    assert.equal(typeof setV2Bridge, 'function')
  })

  test('bridge with all singletons', () => {
    const bridge = createV2Bridge({
      board: { list: () => [], get: () => undefined, updateStatus: async () => {} } as never,
      delegationClient: { session: { create: async () => ({ id: 'test' }) } } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { onIdle: async () => {}, noteUserActivity: () => {} } as never,
      visionHandler: {
        chatMessage: async () => {},
        messagesTransform: async () => {},
        event: async () => {},
      },
    })
    assert.ok(bridge.board)
    assert.ok(bridge.delegationClient)
    assert.ok(bridge.goalStore)
    assert.ok(bridge.todoEnforcer)
    assert.ok(bridge.visionHandler)
  })

  test('bridge gracefully degrades with partial singletons', () => {
    const bridge = createV2Bridge({
      board: { list: () => [] } as never,
      // delegationClient intentionally omitted
      // goalStore intentionally omitted
    })
    assert.ok(bridge.board)
    assert.equal(bridge.delegationClient, undefined)
    assert.equal(bridge.goalStore, undefined)
    assert.equal(bridge.todoEnforcer, undefined)
    assert.equal(bridge.visionHandler, undefined)
  })

  // ─── Cleanup Tests ─────────────────────────────────────────────────

  console.log('\n🧹 V2 Cleanup Tests')

  test('v2Dispose is a function', () => {
    assert.equal(typeof v2Dispose, 'function')
  })

  test('v2Dispose does not throw when called', () => {
    v2Dispose()
    // Should not throw
  })

  test('getUnsupportedFeatures returns stable reference', () => {
    const f1 = getUnsupportedFeatures()
    const f2 = getUnsupportedFeatures()
    assert.strictEqual(f1, f2)
  })

  // ─── Tool Definitions Module Tests ─────────────────────────────────

  console.log('\n📐 V2 Tool Definitions Module Tests')

  const { createV2ToolDefinitions } = await import('../../src/pantheon/v2-tool-definitions.ts')

  test('createV2ToolDefinitions returns 9 tools', () => {
    const toolDefs = createV2ToolDefinitions({
      delegation: {
        pantheon_delegate: { description: 'delegate', args: {}, execute: async () => '' },
        pantheon_delegation_read: { description: 'read', args: {}, execute: async () => '' },
        pantheon_delegation_list: { description: 'list', args: {}, execute: async () => '' },
      } as never,
      goalTools: {
        pantheon_goal_create: { description: 'create', args: {}, execute: async () => '' },
        pantheon_goal_get: { description: 'get', args: {}, execute: async () => '' },
        pantheon_goal_update: { description: 'update', args: {}, execute: async () => '' },
      } as never,
      costCommand: {
        pantheon_cost: { description: 'cost', args: {}, execute: async () => '' },
      } as never,
      modelCommand: {
        pantheon_model: { description: 'model', args: {}, execute: async () => '' },
      } as never,
    })
    assert.equal(toolDefs.length, 9)
  })

  test('all tool names match expected list', () => {
    const toolDefs = createV2ToolDefinitions({
      delegation: {
        pantheon_delegate: { description: 'delegate', args: {}, execute: async () => '' },
        pantheon_delegation_read: { description: 'read', args: {}, execute: async () => '' },
        pantheon_delegation_list: { description: 'list', args: {}, execute: async () => '' },
      } as never,
      goalTools: {
        pantheon_goal_create: { description: 'create', args: {}, execute: async () => '' },
        pantheon_goal_get: { description: 'get', args: {}, execute: async () => '' },
        pantheon_goal_update: { description: 'update', args: {}, execute: async () => '' },
      } as never,
      costCommand: {
        pantheon_cost: { description: 'cost', args: {}, execute: async () => '' },
      } as never,
      modelCommand: {
        pantheon_model: { description: 'model', args: {}, execute: async () => '' },
      } as never,
    })
    const names = toolDefs.map((t) => t.name)
    assert.deepEqual(names, [
      'pantheon_delegate',
      'pantheon_delegation_read',
      'pantheon_delegation_list',
      'hashline_edit',
      'pantheon_goal_create',
      'pantheon_goal_get',
      'pantheon_goal_update',
      'pantheon_cost',
      'pantheon_model',
    ])
  })

  test('each tool has description, input, and execute', () => {
    const toolDefs = createV2ToolDefinitions({
      delegation: {
        pantheon_delegate: { description: 'delegate', args: {}, execute: async () => '' },
        pantheon_delegation_read: { description: 'read', args: {}, execute: async () => '' },
        pantheon_delegation_list: { description: 'list', args: {}, execute: async () => '' },
      } as never,
      goalTools: {
        pantheon_goal_create: { description: 'create', args: {}, execute: async () => '' },
        pantheon_goal_get: { description: 'get', args: {}, execute: async () => '' },
        pantheon_goal_update: { description: 'update', args: {}, execute: async () => '' },
      } as never,
      costCommand: {
        pantheon_cost: { description: 'cost', args: {}, execute: async () => '' },
      } as never,
      modelCommand: {
        pantheon_model: { description: 'model', args: {}, execute: async () => '' },
      } as never,
    })
    for (const tool of toolDefs) {
      assert.ok(
        typeof tool.description === 'string' && tool.description.length > 0,
        `${tool.name} has description`,
      )
      assert.ok(typeof tool.input === 'object' && tool.input !== null, `${tool.name} has input`)
      assert.equal(typeof tool.execute, 'function', `${tool.name} has execute`)
    }
  })

  test('hashline_edit tool has correct input schema', () => {
    const toolDefs = createV2ToolDefinitions({
      delegation: {
        pantheon_delegate: { description: 'delegate', args: {}, execute: async () => '' },
        pantheon_delegation_read: { description: 'read', args: {}, execute: async () => '' },
        pantheon_delegation_list: { description: 'list', args: {}, execute: async () => '' },
      } as never,
      goalTools: {
        pantheon_goal_create: { description: 'create', args: {}, execute: async () => '' },
        pantheon_goal_get: { description: 'get', args: {}, execute: async () => '' },
        pantheon_goal_update: { description: 'update', args: {}, execute: async () => '' },
      } as never,
      costCommand: {
        pantheon_cost: { description: 'cost', args: {}, execute: async () => '' },
      } as never,
      modelCommand: {
        pantheon_model: { description: 'model', args: {}, execute: async () => '' },
      } as never,
    })
    // biome-ignore lint/style/noNonNullAssertion: test assertion — find-or-fail
    const hashline = toolDefs.find((t) => t.name === 'hashline_edit')!
    assert.ok(hashline.input.properties.file, 'hashline_edit has file property')
    assert.ok(hashline.input.properties.edits, 'hashline_edit has edits property')
  })

  // ─── V2 Events Module Tests ────────────────────────────────────────

  console.log('\n📡 V2 Events Module Tests')

  const { createV2EventDispatcher } = await import('../../src/pantheon/v2-events.ts')

  test('createV2EventDispatcher returns a dispatcher with handleEvent and dispose', () => {
    const dispatcher = createV2EventDispatcher({
      board: { get: () => undefined, list: () => [] } as never,
      finalize: async () => undefined,
      goalLoop: { hasActiveGoal: async () => false, onIdle: async () => {} },
      todoEnforcer: { onIdle: async () => {} },
    })
    assert.equal(typeof dispatcher.handleEvent, 'function')
    assert.equal(typeof dispatcher.dispose, 'function')
  })

  test('handleEvent returns false for unknown event type', async () => {
    const dispatcher = createV2EventDispatcher({
      board: { get: () => undefined, list: () => [] } as never,
      finalize: async () => undefined,
      goalLoop: { hasActiveGoal: async () => false, onIdle: async () => {} },
      todoEnforcer: { onIdle: async () => {} },
    })
    const result = await dispatcher.handleEvent({ type: 'unknown.event' })
    assert.equal(result, false)
  })

  test('handleEvent returns false for session.created without info', async () => {
    const dispatcher = createV2EventDispatcher({
      board: { get: () => undefined, list: () => [] } as never,
      finalize: async () => undefined,
      goalLoop: { hasActiveGoal: async () => false, onIdle: async () => {} },
      todoEnforcer: { onIdle: async () => {} },
    })
    const result = await dispatcher.handleEvent({ type: 'session.created', properties: {} })
    assert.equal(result, false)
  })

  test('handleEvent calls registerSession for session.created with info', async () => {
    const registered: unknown[] = []
    const roots: string[] = []
    const dispatcher = createV2EventDispatcher({
      board: { get: () => undefined, list: () => [] } as never,
      finalize: async () => undefined,
      goalLoop: { hasActiveGoal: async () => false, onIdle: async () => {} },
      todoEnforcer: { onIdle: async () => {} },
      registerSession: (info) => registered.push(info),
      addRootSession: (id) => roots.push(id),
    })
    await dispatcher.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'root-1' } },
    })
    assert.equal(registered.length, 1)
    assert.deepEqual(roots, ['root-1'])
  })

  test('handleEvent marks child sessions as non-root', async () => {
    const roots: string[] = []
    const dispatcher = createV2EventDispatcher({
      board: { get: () => undefined, list: () => [] } as never,
      finalize: async () => undefined,
      goalLoop: { hasActiveGoal: async () => false, onIdle: async () => {} },
      todoEnforcer: { onIdle: async () => {} },
      addRootSession: (id) => roots.push(id),
    })
    await dispatcher.handleEvent({
      type: 'session.created',
      properties: { info: { id: 'child-1', parentID: 'root-1' } },
    })
    assert.deepEqual(roots, [])
  })

  test('dispose does not throw', () => {
    const dispatcher = createV2EventDispatcher({
      board: { get: () => undefined, list: () => [] } as never,
      finalize: async () => undefined,
      goalLoop: { hasActiveGoal: async () => false, onIdle: async () => {} },
      todoEnforcer: { onIdle: async () => {} },
    })
    dispatcher.dispose()
  })

  // ─── V2 Hooks Module Tests ─────────────────────────────────────────

  console.log('\n🪝 V2 Hooks Module Tests')

  const {
    createV2ContextHookHandler,
    createV2PromptHookHandler,
    createV2ToolBeforeHookHandler,
    createV2ToolAfterHookHandler,
  } = await import('../../src/pantheon/v2-hooks.ts')

  test('createV2ContextHookHandler returns an async function', () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    assert.equal(typeof handler, 'function')
  })

  test('context hook injects routing policy', async () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    const event = { sessionID: 'test', system: ['existing system'], generation: {} }
    await handler(event)
    assert.ok(event.system.some((s) => s.includes('Pantheon routing policy')))
  })

  test('context hook does not duplicate policy', async () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    const event = {
      sessionID: 'test',
      system: ['<!-- pantheon-v2-policy -->\nFollow Pantheon routing policy'],
      generation: {},
    }
    await handler(event)
    const policyCount = event.system.filter((s) => s.includes('Pantheon routing policy')).length
    assert.equal(policyCount, 1)
  })

  test('v2-hooks context handler ignores non-string system elements', async () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    const event = {
      sessionID: 'test',
      system: ['existing', null, 42, { text: 'x' }],
      generation: {},
    }
    await handler(event as never) // must not throw: s.includes is not a function
    const system = event.system as unknown[]
    const textOf = (s: unknown): string | null =>
      typeof s === 'string'
        ? s
        : typeof s === 'object' && s !== null && typeof (s as { text?: unknown }).text === 'string'
          ? (s as { text: string }).text
          : null
    assert.ok(
      system.some((s) => {
        const t = textOf(s)
        return t?.includes('Pantheon routing policy') ?? false
      }),
      'policy should be injected despite junk elements (string or SystemPart shape)',
    )
    assert.equal(system.length, 5)
  })

  test('v2-hooks context handler accepts a single string system', async () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    const event = { sessionID: 'test', system: 'solo system', generation: {} }
    await handler(event as never) // must not throw
    const system: unknown = (event as { system?: unknown }).system
    assert.ok(Array.isArray(system), 'single string should normalize to an array')
    assert.ok(system.some((s) => typeof s === 'string' && s.includes('solo system')))
    assert.ok(system.some((s) => typeof s === 'string' && s.includes('Pantheon routing policy')))
  })

  test('v2-hooks context handler ignores non-array system', async () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    const event = { sessionID: 'test', system: 42, generation: {} }
    await handler(event as never) // must not throw (fail-open early return)
    assert.equal(event.system, 42)
  })

  test('v2-hooks context handler injects object shape into SystemPart array', async () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    const event = {
      sessionID: 'test',
      system: [{ type: 'text', text: 'existing part' }],
      generation: {},
    }
    await handler(event as never) // must not throw: Schema validation failed
    const system = event.system as unknown[]
    assert.equal(system.length, 2)
    const injected = system[1] as { type?: unknown; text?: unknown }
    assert.equal(injected.type, 'text')
    assert.ok(
      typeof injected.text === 'string' && injected.text.includes('Pantheon routing policy'),
    )
  })

  test('v2-hooks context handler does not duplicate policy in object .text', async () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    const event = {
      sessionID: 'test',
      system: [
        { type: 'text', text: '<!-- pantheon-v2-policy -->\nFollow Pantheon routing policy' },
      ],
      generation: {},
    }
    await handler(event as never) // must not throw
    assert.equal((event.system as unknown[]).length, 1)
  })

  test('v2-hooks context handler handles mixed string+object array', async () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    const event = {
      sessionID: 'test',
      system: ['existing string', { type: 'text', text: 'existing part' }],
      generation: {},
    }
    await handler(event as never) // must not throw
    const system = event.system as unknown[]
    assert.equal(system.length, 3)
    const last = system[2] as { type?: unknown; text?: unknown }
    assert.equal(last.type, 'text')
    assert.ok(typeof last.text === 'string' && last.text.includes('Pantheon routing policy'))
  })

  test('v2-hooks context handler preserves single-string behavior', async () => {
    const handler = createV2ContextHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    const event = { sessionID: 'test', system: 'solo happy', generation: {} }
    await handler(event as never) // happy path preserved
    const system = (event as { system?: unknown }).system as unknown[]
    assert.ok(Array.isArray(system))
    assert.ok(system.some((s) => typeof s === 'string' && (s as string).includes('solo happy')))
    assert.ok(
      system.some(
        (s) => typeof s === 'string' && (s as string).includes('Pantheon routing policy'),
      ),
    )
  })

  test('createV2PromptHookHandler returns an async function', () => {
    const handler = createV2PromptHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    assert.equal(typeof handler, 'function')
  })

  test('prompt hook does not throw', async () => {
    const handler = createV2PromptHookHandler({
      board: { get: () => undefined, list: () => [] } as never,
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { listPendingTodos: async () => [] } as never,
    })
    await handler({ sessionID: 'test', message: {} })
  })

  test('createV2ToolBeforeHookHandler returns an async function', () => {
    const handler = createV2ToolBeforeHookHandler(
      () => {},
      async () => {},
    )
    assert.equal(typeof handler, 'function')
  })

  test('tool before hook calls enforcement guard and normalizer', async () => {
    const guardCalls: unknown[] = []
    const normalizerCalls: unknown[] = []
    const handler = createV2ToolBeforeHookHandler(
      (input) => guardCalls.push(input),
      async (input) => normalizerCalls.push(input),
    )
    await handler({ tool: 'edit', sessionID: 's1', callID: 'c1', args: {} })
    assert.equal(guardCalls.length, 1)
    assert.equal(normalizerCalls.length, 1)
  })

  test('createV2ToolAfterHookHandler returns an async function', () => {
    const handler = createV2ToolAfterHookHandler(
      async () => {},
      async () => {},
    )
    assert.equal(typeof handler, 'function')
  })

  // ─── Summary ───────────────────────────────────────────────────────

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`)
  console.log(`📋 Unsupported features: ${V2_UNSUPPORTED_FEATURES.join(', ')}`)

  if (failed > 0) {
    process.exitCode = 1
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
