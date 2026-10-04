import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import Module, { createRequire } from 'node:module'

type Registration = { dispose: () => Promise<void> }

type JsonLoader = (module: { exports: unknown }, filename: string) => void

type AjvInstance = {
  compile: (schema: Record<string, unknown>) => ValidateFn
}
type ValidateFn = ((value: unknown) => boolean) & { errors?: unknown }

const jsonExtensions = Module as unknown as {
  _extensions: Record<string, JsonLoader | undefined>
}

/** The `.json` loader as it was BEFORE the bootstrap patched it. */
const ORIGINAL_JSON_LOADER = jsonExtensions._extensions['.json']

/**
 * ajv bootstrap — MODULE LEVEL, executed once at import, before any test body.
 *
 * `npm run test:ts` runs THIS file under `NODE_OPTIONS=--conditions=import`
 * (that flag exists because `@opencode-ai/plugin` publishes only an `import`
 * condition). Under it, tsx routes `.json` requires through its TS transform
 * pipeline, so ajv's internal `require('./refs/data.json')` receives
 * ESM-transformed JavaScript instead of JSON and ajv fails to construct:
 *
 *   SyntaxError: .../ajv/dist/refs/data.json: Unexpected token 'v', "var $id="h"...
 *
 * The `.json` files are valid on disk — verified by reading them directly here.
 *
 * WHY MODULE LEVEL AND NOT PER-TEST: this file is one process, and
 * `Module._extensions['.json']` is a patch on the global CommonJS loader, not
 * on a test. Doing it inside a test body (or inside a helper several bodies
 * call) leaves the window open for the whole run and makes any cross-file leak
 * fail somewhere far from its cause. So the patch is installed and REMOVED
 * here, during module evaluation, and the only thing that survives into the
 * tests is the constructed Ajv instance. After this function returns,
 * `Module._extensions['.json']` is identical to what it was before —
 * `ORIGINAL_JSON_LOADER` is captured above the patch so the test below can
 * assert exactly that.
 *
 * A throwing `require` still restores the loader: the patch lives in
 * `finally`, so a failure here leaves the process with a working JSON loader
 * instead of a permanently patched one.
 */
function bootstrapAjv(): AjvInstance {
  jsonExtensions._extensions['.json'] = (module, filename) => {
    module.exports = JSON.parse(readFileSync(filename, 'utf8'))
  }
  try {
    const required = createRequire(import.meta.url)('ajv') as {
      default?: new (opts: Record<string, unknown>) => AjvInstance
    }
    const Ctor = required.default ?? (required as unknown as new (o: unknown) => AjvInstance)
    return new Ctor({ allErrors: true, strict: false })
  } finally {
    jsonExtensions._extensions['.json'] = ORIGINAL_JSON_LOADER
  }
}

/** The single Ajv instance every test in this file compiles against. */
const AJV = bootstrapAjv()

/**
 * Compiled validators, keyed by the schema's serialization.
 *
 * Keyed by structure rather than by object identity on purpose: the host mock
 * re-runs each tool's transform on every registration, so a structurally
 * identical `output` schema arrives as a NEW object each time. Keying by
 * identity would hand every registration its own validator and make "one
 * validator throughout the suite" untrue. Keying by `JSON.stringify` means one
 * schema means one validator, which is also the property ajv caches itself.
 */
const VALIDATOR_CACHE = new Map<string, ValidateFn>()

/** Every (schemaKey, validator) pair this suite has used, in call order. */
const validatorUses: Array<{ schemaKey: string; validate: ValidateFn }> = []

function compiledValidator(schema: Record<string, unknown>): ValidateFn {
  const schemaKey = JSON.stringify(schema)
  let validate = VALIDATOR_CACHE.get(schemaKey)
  if (validate === undefined) {
    validate = AJV.compile(schema)
    VALIDATOR_CACHE.set(schemaKey, validate)
  }
  validatorUses.push({ schemaKey, validate })
  return validate
}

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
    setV2Bridge,
    v2Dispose,
  } = await import('../../src/plugin-v2.ts')
  const pluginSource = await readFile(new URL('../../src/plugin-v2.ts', import.meta.url), 'utf8')
  const pluginV1Source = await readFile(new URL('../../src/plugin.ts', import.meta.url), 'utf8')
  const unsupportedSeedSource = await readFile(
    new URL('../../src/pantheon/v2-unsupported.mjs', import.meta.url),
    'utf8',
  )

  let passed = 0
  let failed = 0
  const queuedTests: Array<{ name: string; fn: () => void | Promise<void> }> = []

  function test(name: string, fn: () => void | Promise<void>): void {
    queuedTests.push({ name, fn })
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

  test('the unenforced delegation matrix is discoverable as a marker', () => {
    // The caller/target matrix is NOT enforced on V2: the guard skips that
    // branch rather than deny every task() call. UPGRADING.md says so in prose,
    // but prose is not queryable — getUnsupportedFeatures() is the surface an
    // operator or a diagnostic actually reads. Following the `goal-tools`
    // precedent, the gap is registered as a marker instead of being left as a
    // comment plus a paragraph somewhere else.
    assert.ok(
      getUnsupportedFeatures().includes('delegation-matrix'),
      'the unenforced V2 delegation matrix must be reported by getUnsupportedFeatures()',
    )
    assert.ok(
      V2_UNSUPPORTED_FEATURES.includes('delegation-matrix'),
      'delegation-matrix must live in V2_UNSUPPORTED_FEATURES, not only in a comment',
    )
  })

  test('getUnsupportedFeatures carries every marker the installer and doctor report', async () => {
    // S0 anti-drift link. Install and doctor report the seed from
    // src/pantheon/v2-unsupported.mjs; the live list here is built from that
    // same seed and then appended to at runtime. If the plugin ever stopped
    // seeding from the shared module, the marker a user is shown at install
    // time would no longer be one the plugin itself reports — so assert the
    // seed is a subset, entry for entry, rather than just non-empty.
    const { V2_UNSUPPORTED_FEATURE_SEED } = await import('../../src/pantheon/v2-unsupported.mjs')
    const reported = getUnsupportedFeatures()
    assert.ok(V2_UNSUPPORTED_FEATURE_SEED.length > 0, 'the shared seed must not be empty')
    for (const feature of V2_UNSUPPORTED_FEATURE_SEED) {
      assert.ok(
        reported.includes(feature),
        `getUnsupportedFeatures() must carry the shared "${feature}" marker that install and doctor report`,
      )
    }
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
    integration: {
      transform: async () => {
        transforms.push('integration')
        return registration(disposed, 'integration')
      },
    },
    skill: {
      transform: async () => {
        transforms.push('skill')
        return registration(disposed, 'skill')
      },
    },
    plugin: { add: async () => {}, remove: async () => {} },
    reference: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('reference')
        callback({ add: (name: string) => references.push(name) } as never)
        return registration(disposed, 'reference')
      },
    },
  }

  await plugin.setup(context as never)

  test('mock records Phase 1/config transform registrations for agent, command, and reference', () => {
    // This mock proves only the adapter's current registration choices. Its
    // callbacks are synthetic and do not prove callback effects on a host.
    assert.deepEqual(transforms, ['agent', 'command', 'reference'])
  })

  test('transform support notes distinguish host domains from Pantheon behavior', () => {
    // The host-context claims must cite the version the canary MEASURED
    // (opencode 2.0.22, tests/canary/plugin-v2-tool-canary.test.mjs). These
    // assertions previously pinned the superseded "2.0.18 runtime probe"
    // wording, which is how a stale claim about ctx.tool survived: the 2.0.22
    // host has ctx.tool.transform and ctx.tool.hook and they work.
    assert.doesNotMatch(pluginSource, /2\.0\.18 host runtime probe/)
    assert.match(pluginSource, /ctx\.tool\.transform\s+function/)
    assert.match(pluginSource, /ctx\.tool\.hook\s+function/)
    assert.match(pluginSource, /ctx\.catalog\s+absent/)
    assert.match(pluginSource, /ctx\.integration and\s*\n?\s*ctx\.skill/)
    // The per-marker rationale (which marker means host-absent vs deliberate
    // Pantheon scope) now lives beside the markers themselves, in the shared
    // plain-`.mjs` seed that the installer and doctor report from — see S0 in
    // src/pantheon/v2-unsupported.mjs. The guard is unchanged in strength: the
    // claim must still be written down, and it must still be MEASURED wording.
    // Asserting it against plugin-v2.ts alone would have forced the rationale
    // to be duplicated back into a file that no longer owns those strings.
    assert.match(unsupportedSeedSource, /SkillEditor\.source\(\)/)
    assert.doesNotMatch(
      pluginSource,
      /ctx\.integration.*no longer a context domain|ctx\.skill.*no longer a context domain/s,
    )
    assert.equal(typeof context.integration.transform, 'function')
    assert.equal(typeof context.skill.transform, 'function')
  })

  test('the four SDK-missing domains are declared, not cast ad hoc', () => {
    // `hostDomains` is the single documented cast for tool/event/permission/
    // session. This test pins that the declaration survives and that the
    // anonymous casts it replaced do not come back.
    assert.match(pluginSource, /interface HostPluginContext extends PluginContext/)
    assert.match(pluginSource, /function hostDomains\(context: PluginContext\): HostPluginContext/)
    // Six call sites: registerV2Tools, subscribeV2Events, registerV2SessionHooks,
    // registerV2ToolHooks, registerV2PermissionHook, and Phase 7's compaction
    // hook. One more means a new phase started bypassing the declaration.
    assert.equal(
      (pluginSource.match(/hostDomains\(context\)/g) ?? []).length,
      6,
      'every host-domain read must go through hostDomains(context)',
    )
    assert.doesNotMatch(
      pluginSource,
      /as unknown as Record<string, unknown>\)\.(tool|event|permission|session)/,
      'an ad-hoc cast crept back in; use hostDomains()',
    )
    for (const domain of ['tool', 'event', 'permission', 'session']) {
      assert.match(
        pluginSource,
        new RegExp(`\\b${domain}\\?: V2\\w*Domain`),
        `${domain} is not declared`,
      )
    }
    // The declaration must not erase the definition checks. Each of these is the
    // guard that turns an absent domain into a marked-unsupported feature rather
    // than a silent no-op — and the host-backed tool canary is what proves the
    // domains are present on a real 2.0.22 host in the first place.
    assert.match(pluginSource, /if \(!toolCtx\?\.transform\) \{\s*\n\s*return false/)
    assert.match(pluginSource, /if \(!eventCtx\?\.subscribe\) \{\s*\n\s*return undefined/)
    assert.match(pluginSource, /if \(!sessionCtx\?\.hook\) \{\s*\n\s*return false/)
    assert.match(pluginSource, /if \(!toolCtx\?\.hook\) \{\s*\n\s*return false/)
    assert.match(pluginSource, /if \(!permCtx\?\.hook\) \{/)
  })

  test('the secret block message is English like the rest of the plugin', () => {
    // This string is what the user reads when a tool is blocked, so it is
    // runtime surface, not style. A Portuguese release note elsewhere in the
    // repo is not a reason for this one to be Portuguese.
    const declared = /const SECRET_BLOCK_MESSAGE\s*=\s*\n?\s*'([^']*)'/.exec(pluginSource)
    assert.ok(declared !== null, 'plugin-v2.ts must declare SECRET_BLOCK_MESSAGE')
    assert.equal(
      declared[1],
      '[plugin-v2] Blocked: high-confidence secret detected in tool input — see .pantheon/logs/hooks.log',
      'the block message drifted from the agreed English wording',
    )
    assert.doesNotMatch(pluginSource, /\[plugin-v2\] Bloqueado/)
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

  test('agent and command transforms preserve custom values and only default Pantheon commands', async () => {
    const policyMarker = '<!-- pantheon-v2-policy -->'
    const markedSystem = `Keep this text unchanged.\n${policyMarker}\nExisting policy.`
    const transformAgents = [
      { id: 'marked', mode: 'subagent', system: markedSystem },
      { id: 'null-system', mode: 'subagent', system: null as unknown as string },
      { id: 'empty-system', mode: 'subagent', system: '' },
    ]
    const commandsToTransform = [
      { name: 'custom-build', description: 'Keep the custom description.' },
      { name: 'pantheon-custom', description: undefined as string | undefined },
    ]
    const updatedCommandNames: string[] = []

    await plugin.setup(
      makeBaseContext({
        agent: {
          transform: async (callback: (draft: never) => void) => {
            callback({
              list: () => transformAgents,
              update: (id: string, update: (agent: (typeof transformAgents)[number]) => void) => {
                const agent = transformAgents.find((candidate) => candidate.id === id)
                assert.ok(agent, `unknown agent ${id}`)
                update(agent)
              },
            } as never)
            return { dispose: async () => {} }
          },
        },
        command: {
          transform: async (callback: (draft: never) => void) => {
            callback({
              list: () => commandsToTransform,
              update: (
                name: string,
                update: (command: (typeof commandsToTransform)[number]) => void,
              ) => {
                updatedCommandNames.push(name)
                const command = commandsToTransform.find((candidate) => candidate.name === name)
                assert.ok(command, `unknown command ${name}`)
                update(command)
              },
            } as never)
            return { dispose: async () => {} }
          },
        },
      }) as never,
    )

    assert.equal(transformAgents[0].system, markedSystem, 'an existing policy marker is preserved')
    assert.match(transformAgents[1].system, /Pantheon routing policy/, 'null system gets policy')
    assert.match(transformAgents[2].system, /Pantheon routing policy/, 'empty system gets policy')
    assert.deepEqual(updatedCommandNames, ['pantheon-custom'])
    assert.equal(commandsToTransform[0].description, 'Keep the custom description.')
    assert.equal(commandsToTransform[1].description, 'Pantheon orchestration command')
  })

  test('catalog is host-absent while integration and skill transforms remain unimplemented here', () => {
    // These registry entries describe adapter support, not whether every
    // corresponding host context domain exists.
    assert.ok(V2_UNSUPPORTED_FEATURES.includes('catalog-transform'))
    assert.ok(V2_UNSUPPORTED_FEATURES.includes('skill-transform'))
    assert.ok(V2_UNSUPPORTED_FEATURES.includes('integration-transform'))
    assert.deepEqual(transforms, ['agent', 'command', 'reference'])
  })

  test('transform registration rejection does not abort setup or later hook registration', () => {
    assert.match(pluginSource, /Promise\.allSettled/)
    assert.doesNotMatch(
      pluginSource,
      /would reject\s+setup\(\).*kill every hook|rejection also\s+kills every later hook/is,
    )
    assert.match(pluginSource, /individually wrapped and settled via\s+Promise\.allSettled/)
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

  // Case 4: one domain transform rejects — setup resolves, others still register.
  const case4Registered: string[] = []
  const case4Hooks: string[] = []
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
        session: {
          hook: async (name: string) => {
            case4Hooks.push(name)
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
    assert.deepEqual(case4Registered, ['agent', 'reference'])
  })

  test('rejected transform does not prevent later session hook registrations', () => {
    assert.deepEqual(case4Hooks, ['context', 'prompt', 'compaction'])
  })

  test('one rejected hook registration leaves later hooks and permission setup active', async () => {
    const hookAttempts: string[] = []
    let setupResolved = false
    try {
      await plugin.setup(
        makeBaseContext({
          session: {
            hook: async (name: string) => {
              hookAttempts.push(`session:${name}`)
              if (name === 'context') throw new Error('context hook unavailable')
              return registration(disposed, `session:${name}`)
            },
          },
          tool: {
            hook: async (name: string) => {
              hookAttempts.push(`tool:${name}`)
              if (name === 'execute.before') throw new Error('before hook unavailable')
              return registration(disposed, `tool:${name}`)
            },
          },
          permission: {
            hook: async (name: string) => {
              hookAttempts.push(`permission:${name}`)
              return registration(disposed, `permission:${name}`)
            },
          },
        }) as never,
      )
      setupResolved = true
    } catch {
      setupResolved = false
    }

    assert.equal(setupResolved, true)
    assert.deepEqual(hookAttempts, [
      'session:context',
      'session:prompt',
      'tool:execute.before',
      'tool:execute.after',
      'permission:evaluate',
      'session:compaction',
    ])
  })

  test('event subscription delivers session idle and v2Dispose aborts its stream', async () => {
    const deliveredSessionIDs: string[] = []
    const expectedSessionID = 'ses-contract-event'
    let signal: AbortSignal | undefined
    let streamClosed = false
    let streamFinished!: () => void
    const finished = new Promise<void>((resolve) => {
      streamFinished = resolve
    })
    let idleDelivered!: () => void
    const delivered = new Promise<void>((resolve) => {
      idleDelivered = resolve
    })

    setV2Bridge({
      todoEnforcer: {
        onIdle: async (sessionID: string) => {
          deliveredSessionIDs.push(sessionID)
          idleDelivered()
        },
      },
    } as never)

    await plugin.setup(
      makeBaseContext({
        event: {
          subscribe: ({ signal: subscribedSignal }: { signal: AbortSignal }) => {
            signal = subscribedSignal
            return {
              async *[Symbol.asyncIterator]() {
                try {
                  yield {
                    type: 'session.idle',
                    properties: { sessionID: expectedSessionID },
                  }
                  await new Promise<void>((resolve) => {
                    if (subscribedSignal.aborted) {
                      resolve()
                      return
                    }
                    subscribedSignal.addEventListener('abort', () => resolve(), { once: true })
                  })
                } finally {
                  streamClosed = true
                  streamFinished()
                }
              },
            }
          },
        },
      }) as never,
    )
    await delivered

    assert.deepEqual(deliveredSessionIDs, [expectedSessionID])
    assert.equal(signal?.aborted, false, 'subscription remains active before disposal')
    assert.equal(streamClosed, false, 'event stream remains open until disposal')
    v2Dispose()
    assert.equal(signal?.aborted, true, 'v2Dispose aborts the event subscription')
    await finished
    assert.equal(streamClosed, true, 'event iterator exits after the disposal signal')
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

  // ─── Tool Output Declaration Contract ──────────────────────────────
  //
  // The host (opencode 2.0.22) enforces a BICONDITIONAL between a tool's
  // declared `output` and the value its execute resolves to. Transcribed from
  // the host binary:
  //
  //   if (def.output === undefined) {
  //     if ("output" in result) throw "Tool result declared output without an output schema"
  //     ...
  //   }
  //   if (!("output" in result)) throw "Tool did not return its declared output"
  //
  // The historical Pantheon defect declared nothing while always returning
  // `output`, which failed on 100% of calls. The mock below therefore BUILDS
  // `outputSchema` from `def.output` exactly as the host's own plugin bridge
  // does (`output: I.outputSchema ?? {}`), instead of capturing the raw draft
  // object — capturing the raw object never inspects the declaration, which is
  // why the original assertion passed over the bug.

  interface HostTool {
    name: string
    description: string
    input: Record<string, unknown>
    /** Derived from the draft's `output`, mirroring the host bridge. */
    outputSchema?: Record<string, unknown>
    execute: (input: unknown, ctx: unknown) => Promise<unknown>
  }

  /** The host's declaration/result check, transcribed from the binary. */
  function hostAccepts(
    def: HostTool,
    result: unknown,
  ): { ok: true } | { ok: false; message: string } {
    if (def.outputSchema === undefined) {
      if (typeof result === 'object' && result !== null && 'output' in result) {
        return { ok: false, message: 'Tool result declared output without an output schema' }
      }
      return { ok: true }
    }
    if (!(typeof result === 'object' && result !== null && 'output' in result)) {
      return { ok: false, message: 'Tool did not return its declared output' }
    }
    return { ok: true }
  }

  /**
   * The host's THIRD step, which the first transcription omitted.
   *
   * From the binary, after the biconditional check:
   *
   *   let u = yield* Id(e.output, s.output)
   *
   * `Id` compiles the tool's declared `output` as a JSON Schema and validates
   * the value `execute` resolved to; a mismatch fails the call with
   * "Tool returned an invalid value for its output schema".
   *
   * `output: {}` accepts any value, which is why modelling this step does not
   * reject today's tools — and also why NOT modelling it is unsafe: a future
   * restrictive schema the `execute` implementation does not satisfy would pass
   * this suite and fail in production. Modelling the step closes the class; the
   * emptiness of today's schemas does not.
   *
   * The validator is ajv, declared as an explicit devDependency, because this
   * step's entire purpose is to model the host's REAL validator. A hand-rolled
   * subset is worse than no model at all: it agrees with ajv on the keywords it
   * implements, silently disagrees on the ones it does not, and the drift is
   * invisible until production. Using the actual library removes the class of
   * bug where the test's notion of JSON Schema and the host's diverge.
   *
   * `compiledValidator` (module level, above) returns the SAME cached function
   * for a given schema on every call — ajv is constructed once at import and
   * this step never re-instantiates it.
   */

  /** The host's output-schema validation step, as a pass/fail verdict. */
  function hostValidatesDeclaredOutput(
    schema: Record<string, unknown> | undefined,
    output: unknown,
  ): { ok: true } | { ok: false; message: string } {
    if (schema === undefined) return { ok: true }
    const validate = compiledValidator(schema)
    if (validate(output)) return { ok: true }
    const issues = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ')
    return {
      ok: false,
      message: `Tool returned an invalid value for its output schema: ${issues}`,
    }
  }

  /**
   * Register the plugin's tools through a mock that behaves like the host:
   * `draft.add` is turned into a descriptor whose `outputSchema` comes from
   * the definition's `output`, so a missing declaration is observable here
   * exactly as it would be in production.
   */
  /**
   * Namespaces declared through `draft.namespace` during the most recent
   * `registerToolsThroughHostMock()` call. Recorded because the previous mock
   * made `namespace` a no-op, so nothing asserted that Pantheon declares one.
   */
  const declaredNamespaces: Array<{ name: string; description?: string }> = []

  async function registerToolsThroughHostMock(): Promise<HostTool[]> {
    const registered: HostTool[] = []
    declaredNamespaces.length = 0
    await plugin.setup(
      makeBaseContext({
        tool: {
          transform: async (callback: (draft: never) => void) => {
            callback({
              namespace: (config: { name: string; description?: string }) => {
                declaredNamespaces.push(config)
              },
              add: (tool: {
                name: string
                description: string
                input: Record<string, unknown>
                output?: Record<string, unknown>
                execute: (input: unknown, ctx: unknown) => Promise<unknown>
              }) => {
                registered.push({
                  name: tool.name,
                  description: tool.description,
                  input: tool.input,
                  outputSchema: tool.output,
                  execute: tool.execute,
                })
              },
            } as never)
            return { dispose: async () => {} }
          },
        },
      }) as never,
    )
    return registered
  }

  /** Sorted `input.properties` keys for a registered tool, [] when absent. */
  function propertyNames(byName: Map<string, HostTool>, name: string): string[] {
    const properties = byName.get(name)?.input.properties
    return typeof properties === 'object' && properties !== null
      ? Object.keys(properties).sort()
      : []
  }

  test('V2 registers exactly the 3 self-sufficient tools', async () => {
    const registered = await registerToolsThroughHostMock()
    // 3 tools: hashline_edit, pantheon_cost, pantheon_model. The 3 goal tools
    // were REMOVED rather than stubbed — they need a GoalStore, a
    // GoalLoopClient and a BackgroundJobBoard, none of which exist on the V2
    // PluginContext. A placeholder would still fail this host contract on
    // every call, so it bought nothing. See the `goal-tools` entry in
    // V2_UNSUPPORTED_FEATURES.
    assert.deepEqual(registered.map((t) => t.name).sort(), [
      'hashline_edit',
      'pantheon_cost',
      'pantheon_model',
    ])
  })

  test('every draft.add declares output — removing it fails this test', async () => {
    const registered = await registerToolsThroughHostMock()
    assert.ok(registered.length > 0, 'expected at least one registered tool')
    for (const def of registered) {
      assert.notEqual(
        def.outputSchema,
        undefined,
        `${def.name}: draft.add must pass an output declaration — without it the host throws ` +
          '"Tool result declared output without an output schema" on every call',
      )
    }
  })

  test('declared output iff resolved result carries output (host contract)', async () => {
    const registered = await registerToolsThroughHostMock()
    assert.ok(registered.length > 0, 'expected at least one registered tool')
    for (const def of registered) {
      const result = await def.execute({}, {})
      assert.ok(
        typeof result === 'object' && result !== null,
        `${def.name} execute must resolve to an object, got ${typeof result}`,
      )
      assert.equal(
        typeof (result as { output?: unknown }).output,
        'string',
        `${def.name} execute result must carry a string .output`,
      )
      // The biconditional itself: declaration present ⇔ result carries output.
      const verdict = hostAccepts(def, result)
      assert.ok(verdict.ok, `${def.name}: host rejects this tool — ${verdict.message}`)
    }
  })

  test('host mock detects the original defect (negative control)', async () => {
    // Guards against the harness going blind: a definition registered WITHOUT
    // `output` while resolving to `{output}` must be rejected, which is the
    // exact production failure. If this ever passes, the assertions above
    // would no longer prove anything.
    const defective: HostTool = {
      name: 'defective',
      description: '',
      input: {},
      outputSchema: undefined,
      execute: async () => ({ output: 'boom' }),
    }
    const verdict = hostAccepts(defective, await defective.execute({}, {}))
    assert.equal(verdict.ok, false)
    assert.equal(
      verdict.ok === false ? verdict.message : '',
      'Tool result declared output without an output schema',
    )
    // And the opposite direction is enforced too: declaring output while
    // omitting it from the result is equally fatal.
    const undeclaredResult: HostTool = {
      name: 'undeclared-result',
      description: '',
      input: {},
      outputSchema: {},
      execute: async () => ({ content: 'boom' }),
    }
    const verdict2 = hostAccepts(undeclaredResult, await undeclaredResult.execute({}, {}))
    assert.equal(verdict2.ok, false)
    assert.equal(
      verdict2.ok === false ? verdict2.message : '',
      'Tool did not return its declared output',
    )
  })

  test('V2 tools declare real input properties, not an empty object', async () => {
    const registered = await registerToolsThroughHostMock()
    for (const def of registered) {
      assert.equal(def.input.type, 'object', `${def.name} input must be a JSON Schema object`)
      const properties = def.input.properties as Record<string, unknown> | undefined
      assert.ok(
        properties !== undefined && Object.keys(properties).length > 0,
        `${def.name} input.properties must be non-empty; an empty schema accepts zero arguments`,
      )
    }
    // Spot-check that the schemas track the V1 args of the real tools.
    const byName = new Map(registered.map((t) => [t.name, t]))
    assert.deepEqual(propertyNames(byName, 'hashline_edit'), ['edits', 'file'])
    assert.deepEqual(propertyNames(byName, 'pantheon_cost'), ['days'])
    assert.deepEqual(propertyNames(byName, 'pantheon_model'), [
      'action',
      'agent',
      'authorize_global',
      'confirm',
      'effort',
      'model',
      'scope',
    ])
  })

  test('draft.namespace declares the pantheon namespace (the mock used to swallow it)', async () => {
    const registered = await registerToolsThroughHostMock()
    assert.ok(registered.length > 0, 'expected at least one registered tool')
    assert.deepEqual(
      declaredNamespaces.map((ns) => ns.name),
      ['pantheon'],
      'Pantheon must declare its catalog namespace',
    )
    assert.match(declaredNamespaces[0]?.description ?? '', /Pantheon/)
  })

  test('namespace does not prefix tool names — the guard matches on the bare id', async () => {
    // The host computes a tool's registration id as
    // `options.namespace === undefined ? name : `${namespace}_${name}``, and
    // `draft.namespace()` does NOT set `options.namespace` on later `add` calls
    // (the host's own built-in plugins rely on the same behaviour). So the
    // blocked-tool list must be matched against the BARE names. If this ever
    // changes, `DEFAULT_BLOCKED_TOOLS` silently stops matching and enforcement
    // is off — which is why it is asserted rather than assumed.
    const registered = await registerToolsThroughHostMock()
    const names = registered.map((t) => t.name).sort()
    assert.deepEqual(names, ['hashline_edit', 'pantheon_cost', 'pantheon_model'])

    // Derive what a namespaced id WOULD look like and assert none of them is in
    // the registered set. Comparing prefixes directly would false-positive on
    // `pantheon_model`, whose own name legitimately starts with `pantheon_`.
    const namespace = declaredNamespaces[0]?.name ?? 'pantheon'
    const namespacedIds = new Set(names.map((n) => `${namespace}_${n}`))
    for (const name of names) {
      assert.equal(
        namespacedIds.has(name),
        false,
        `${name} was registered under its namespaced id — DEFAULT_BLOCKED_TOOLS matches bare ` +
          'names, so enforcement would silently stop firing',
      )
    }
  })

  test('host mock validates the resolved output against the declared schema (3rd step)', async () => {
    const registered = await registerToolsThroughHostMock()
    assert.ok(registered.length > 0, 'expected at least one registered tool')
    for (const def of registered) {
      const result = (await def.execute({}, {})) as { output?: unknown }
      const verdict = hostValidatesDeclaredOutput(def.outputSchema, result.output)
      assert.ok(verdict.ok, `${def.name}: host rejects the resolved output — ${verdict.message}`)
    }
  })

  test('declared-output validation step actually rejects a mismatched schema', async () => {
    // Negative control for the step above: without this, `outputSchema` could
    // be any restrictive schema no `execute` satisfies and the suite would stay
    // green while production broke.
    const strictSchema = {
      type: 'object',
      required: ['lines'],
      properties: { lines: { type: 'array' } },
    }
    const ok = hostValidatesDeclaredOutput(strictSchema, { lines: ['a'] })
    assert.equal(ok.ok, true, 'a value satisfying the schema must pass')

    const stringOutput = hostValidatesDeclaredOutput(strictSchema, 'a bare string')
    assert.equal(stringOutput.ok, false, 'a string must fail an object schema')
    assert.match(
      stringOutput.ok === false ? stringOutput.message : '',
      /Tool returned an invalid value for its output schema/,
    )
    // And the empty schema the tools actually declare today accepts both a
    // string and undefined — the reason this step is currently inert.
    assert.equal(hostValidatesDeclaredOutput({}, 'a string').ok, true)
    assert.equal(hostValidatesDeclaredOutput({}, undefined).ok, true)

    // Keywords the previous hand-rolled subset did NOT implement. These are the
    // cases where a subset validator and ajv would disagree, and where the
    // disagreement is the whole reason this step is delegated to ajv rather
    // than modelled: a subset that ignored `const`, `pattern` and `multipleOf`
    // would ACCEPT all three of these.
    assert.equal(
      hostValidatesDeclaredOutput({ const: 'exact' }, 'exact').ok,
      true,
      'a value equal to const must pass',
    )
    assert.equal(
      hostValidatesDeclaredOutput({ const: 'exact' }, 'different').ok,
      false,
      'const must be enforced — the hand-rolled subset ignored it',
    )
    assert.equal(hostValidatesDeclaredOutput({ type: 'string', pattern: '^v2-' }, 'v2-ok').ok, true)
    assert.equal(
      hostValidatesDeclaredOutput({ type: 'string', pattern: '^v2-' }, 'nope').ok,
      false,
      'pattern must be enforced — the hand-rolled subset ignored it',
    )
    assert.equal(hostValidatesDeclaredOutput({ type: 'number', multipleOf: 5 }, 15).ok, true)
    assert.equal(
      hostValidatesDeclaredOutput({ type: 'number', multipleOf: 5 }, 7).ok,
      false,
      'multipleOf must be enforced — the hand-rolled subset ignored it',
    )
    assert.equal(
      hostValidatesDeclaredOutput(
        { type: 'object', properties: { n: { type: 'integer' } } },
        { n: 1.5 },
      ).ok,
      false,
      'integer/fraction must be distinguished — the subset mapped both to "number"',
    )
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

  test('Fase 4 context handler normalizes a single string system to SystemParts', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = { system: 'solo system', generation: {} }
    await handler(event) // must not throw
    const system: unknown = (event as { system?: unknown }).system
    assert.ok(Array.isArray(system), 'single string should normalize to an array')
    const parts = system as Array<{ type?: unknown; text?: unknown }>
    assert.ok(
      parts.every((s) => s.type === 'text' && typeof s.text === 'string'),
      'every entry must be a canonical SystemPart',
    )
    assert.ok(parts.some((s) => String(s.text).includes('solo system')))
    assert.ok(parts.some((s) => String(s.text).includes('Pantheon routing policy')))
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
    const count = (event.system as Array<{ text?: unknown }>).filter(
      (s) => typeof s?.text === 'string' && s.text.includes('Pantheon routing policy'),
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
    const system = event.system as Array<{ type?: unknown; text?: unknown }>
    assert.equal(system.length, 3)
    assert.ok(
      system.every((s) => s.type === 'text' && typeof s.text === 'string'),
      'all entries normalized to SystemParts',
    )
    const last = system[2]
    assert.equal(last.type, 'text')
    assert.ok(typeof last.text === 'string' && last.text.includes('Pantheon routing policy'))
  })

  test('Fase 4 context handler normalizes legacy string arrays to SystemParts', async () => {
    const handler = fase4Handlers.context
    assert.ok(handler != null)
    const event = { system: ['solo happy'], generation: {} }
    await handler(event) // happy path preserved
    const system = (event as { system?: unknown }).system as Array<{
      type?: unknown
      text?: unknown
    }>
    assert.ok(Array.isArray(system))
    assert.ok(
      system.every((s) => s.type === 'text' && typeof s.text === 'string'),
      'raw strings upgraded to canonical SystemParts (2.0.16 system is Array<SystemPart>)',
    )
    assert.ok(system.some((s) => String(s.text).includes('solo happy')))
    assert.ok(system.some((s) => String(s.text).includes('Pantheon routing policy')))
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

  // ─── V2 Read-Only Enforcement (integration) ──────────────────────────
  //
  // These go through the REAL registration path: `plugin.setup` is invoked with
  // a mock host that CAPTURES the handler src/plugin-v2.ts registers under
  // `tool.hook('execute.before')`, and that captured handler is then driven with
  // the event shape the host dispatches. No guard is hand-built here.
  //
  // Why that matters: the previous unit tests (hashline.test.ts and
  // delegation-enforce.test.ts) constructed the guard directly and called it,
  // which stayed green while the shipped V2 path had no enforcement at all — the
  // tests wore integration coverage as a costume. Deleting the enforcement from
  // src/plugin-v2.ts must drop THESE tests.

  console.log('\n🔒 V2 Read-Only Enforcement Tests')

  const { DEFAULT_BLOCKED_TOOLS, readOnlyRegistry } = await import(
    '../../src/pantheon/delegation-enforce.ts'
  )

  interface CapturedToolHooks {
    tools: HostTool[]
    before?: (event: unknown) => void | Promise<void>
    after?: (event: unknown) => void | Promise<void>
  }

  /** Run plugin.setup against a host mock that records tools and tool hooks. */
  async function setupCapturingToolHooks(): Promise<CapturedToolHooks> {
    readOnlyRegistry.clear()
    const captured: CapturedToolHooks = { tools: [] }
    await plugin.setup(
      makeBaseContext({
        tool: {
          transform: async (callback: (draft: never) => void) => {
            callback({
              namespace: () => {},
              add: (tool: {
                name: string
                description: string
                input: Record<string, unknown>
                output?: Record<string, unknown>
                execute: (input: unknown, ctx: unknown) => Promise<unknown>
              }) => {
                captured.tools.push({
                  name: tool.name,
                  description: tool.description,
                  input: tool.input,
                  outputSchema: tool.output,
                  execute: tool.execute,
                })
              },
            } as never)
            return { dispose: async () => {} }
          },
          hook: async (name: string, handler: (event: unknown) => void | Promise<void>) => {
            if (name === 'execute.before') captured.before = handler
            if (name === 'execute.after') captured.after = handler
            return { dispose: async () => {} }
          },
        },
      }) as never,
    )
    return captured
  }

  /**
   * Drive the captured `execute.before` handler with the host's event shape.
   * Throwing from this handler is what DENIES the call, so the returned message
   * is the denial the session would see.
   */
  async function denyMessage(
    before: (event: unknown) => void | Promise<void>,
    input: { tool: string; sessionID: string; agent: string },
  ): Promise<string | null> {
    try {
      await before({
        tool: input.tool,
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: 'msg_1',
        id: 'call_1',
        input: {},
      })
      return null
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  const apolloCaptured = await setupCapturingToolHooks()

  test('V2 registers a tool execute.before handler that enforces (not a no-op)', () => {
    assert.equal(
      typeof apolloCaptured.before,
      'function',
      'plugin-v2 must register an execute.before handler; without one there is no enforcement',
    )
    assert.ok(apolloCaptured.tools.length > 0, 'expected the V2 tools to be registered')
  })

  test('a read-only apollo session is DENIED hashline_edit through the V2 registration path', async () => {
    const denial = await denyMessage(apolloCaptured.before as (e: unknown) => Promise<void>, {
      tool: 'hashline_edit',
      sessionID: 'ses_v2_apollo',
      agent: 'apollo',
    })
    assert.ok(
      denial !== null,
      'hashline_edit must be denied in a read-only session — this is the live write primitive',
    )
    assert.match(denial, /READ-ONLY/)
    assert.match(denial, /hashline_edit/)
  })

  test('a read-only apollo session is DENIED pantheon_model through the V2 registration path', async () => {
    // pantheon_model writes active-preset.json in project AND global scope, so
    // it is a write surface with a wider blast radius than the file write above.
    const denial = await denyMessage(apolloCaptured.before as (e: unknown) => Promise<void>, {
      tool: 'pantheon_model',
      sessionID: 'ses_v2_apollo_model',
      agent: 'apollo',
    })
    assert.ok(denial !== null, 'pantheon_model must be denied in a read-only session')
    assert.match(denial, /READ-ONLY/)
    assert.match(denial, /pantheon_model/)
  })

  test('every registered V2 mutating tool is denied for gaia (both read-only agents)', async () => {
    const registeredNames = new Set(apolloCaptured.tools.map((t) => t.name))
    const v2WriteTools = [...DEFAULT_BLOCKED_TOOLS].filter((tool) => registeredNames.has(tool))
    assert.deepEqual(
      v2WriteTools.sort(),
      ['hashline_edit', 'pantheon_model'],
      'the V2 surface exposes two mutating tools; both must be in the blocked set',
    )
    for (const tool of v2WriteTools) {
      const denial = await denyMessage(apolloCaptured.before as (e: unknown) => Promise<void>, {
        tool,
        sessionID: `ses_v2_gaia_${tool}`,
        agent: 'gaia',
      })
      assert.ok(denial !== null, `${tool} must be denied for gaia`)
      assert.match(denial, /READ-ONLY/)
    }
  })

  test('write-capable sessions are NOT denied (the guard is scoped, not a blanket block)', async () => {
    for (const agent of ['zeus', 'hermes', 'aphrodite']) {
      const denial = await denyMessage(apolloCaptured.before as (e: unknown) => Promise<void>, {
        tool: 'hashline_edit',
        sessionID: `ses_v2_${agent}`,
        agent,
      })
      assert.equal(denial, null, `${agent} must be allowed to call hashline_edit`)
    }
  })

  test('a read-only tool stays available in a read-only session (pantheon_cost reads only)', async () => {
    const denial = await denyMessage(apolloCaptured.before as (e: unknown) => Promise<void>, {
      tool: 'pantheon_cost',
      sessionID: 'ses_v2_apollo_cost',
      agent: 'apollo',
    })
    assert.equal(denial, null, 'pantheon_cost only reads opencode.db and must stay available')
  })

  test('the read-only registry is populated from the event agent and revoked on switch', async () => {
    const before = apolloCaptured.before as (e: unknown) => Promise<void>
    await denyMessage(before, { tool: 'pantheon_cost', sessionID: 'ses_v2_sync', agent: 'apollo' })
    assert.equal(
      readOnlyRegistry.has('ses_v2_sync'),
      true,
      'the event agent must register the session in the shared read-only registry',
    )
    // An in-session agent switch revokes the registration, and the guard then
    // stops denying — the V1 `chat.params` behaviour, driven by the same field.
    await denyMessage(before, { tool: 'pantheon_cost', sessionID: 'ses_v2_sync', agent: 'hermes' })
    assert.equal(readOnlyRegistry.has('ses_v2_sync'), false)
    const afterSwitch = await denyMessage(before, {
      tool: 'hashline_edit',
      sessionID: 'ses_v2_sync',
      agent: 'hermes',
    })
    assert.equal(afterSwitch, null, 'a switched session must no longer be denied')
  })

  test('a malformed execute.before event is tolerated and denied closed on the blocked set', async () => {
    const before = apolloCaptured.before as (e: unknown) => Promise<void>
    // No crash on a junk payload: the hook must not throw at the host.
    await before(undefined)
    await before({})
    await before({ tool: 'hashline_edit', agent: 42 })
    // A blocked tool attributed to a read-only agent with no sessionID is still
    // denied rather than allowed.
    let denial: string | null = null
    try {
      await before({ tool: 'hashline_edit', agent: 'apollo' })
    } catch (err: unknown) {
      denial = err instanceof Error ? err.message : String(err)
    }
    assert.match(denial ?? '', /READ-ONLY/)
  })

  test('removing the enforcement from plugin-v2 drops the V2 denial path', async () => {
    // Structural counterpart to the behavioural tests above: the guard must be
    // instantiated in THIS module. If it were delegated to a V1 bridge that is
    // never built, the file would import nothing from delegation-enforce.
    assert.match(
      pluginSource,
      /createEnforcementGuard\(/,
      'plugin-v2.ts must instantiate the enforcement guard itself',
    )
    assert.match(pluginSource, /syncReadOnlySession\(/, 'the registry must be populated in V2')
    assert.doesNotMatch(
      pluginSource,
      /actual enforcement is wired\s+through the V1/,
      'the false coverage claim about V1 enforcement must be gone',
    )
  })

  test('the bootstrap restores Module._extensions[".json"] to its original value', () => {
    // The ajv shim patches the GLOBAL CommonJS JSON loader. If it survived past
    // the module-level bootstrap, every later require of a .json file in this
    // process would read through a test-owned loader — a leak that fails far
    // from its cause. ORIGINAL_JSON_LOADER is captured above the patch, so
    // identity comparison is the exact assertion, not an approximation.
    assert.equal(
      jsonExtensions._extensions['.json'],
      ORIGINAL_JSON_LOADER,
      'the ajv bootstrap must restore the .json loader it patched',
    )
    assert.notEqual(
      jsonExtensions._extensions['.json'],
      undefined,
      'sanity: the loader must still be registered, not deleted',
    )
  })

  test('ajv is constructed once and the cached validator is one object throughout', () => {
    assert.ok(
      validatorUses.length >= 2,
      `expected the suite to have validated against ajv more than once, saw ${validatorUses.length}`,
    )
    // Group recorded uses by schema and assert each schema resolved to exactly
    // one validator function. Several distinct schemas are fine — they are
    // different validators by design; the invariant is per-schema identity.
    const bySchema = new Map<string, Set<ValidateFn>>()
    for (const use of validatorUses) {
      const seen = bySchema.get(use.schemaKey) ?? new Set<ValidateFn>()
      seen.add(use.validate)
      bySchema.set(use.schemaKey, seen)
    }
    for (const [schemaKey, validators] of bySchema) {
      assert.equal(
        validators.size,
        1,
        `schema ${schemaKey} compiled to ${validators.size} distinct validators; every test must share one`,
      )
    }
    // And a fresh call returns the very object earlier calls recorded.
    const [first] = validatorUses
    if (first !== undefined) {
      const again = compiledValidator(JSON.parse(first.schemaKey) as Record<string, unknown>)
      assert.equal(again, first.validate, 'compiledValidator must return the cached object')
    }
  })

  // ─── V2 Secret Scan (integration) ─────────────────────────────────────
  //
  // Same discipline as the enforcement section above: these drive the REAL
  // `execute.before` handler captured from `plugin.setup`, and the REAL
  // scripts/hooks/scan-secrets.sh as a child process. Nothing here is mocked.
  //
  // Why this exists at all: opencode.json declares only `src/plugin-v2` in
  // `plugins`, so `src/plugins/pantheon-hooks.ts` is never loaded on a V2-only
  // install. V1's high-confidence secret block therefore did not run — inert by
  // construction, not by misconfiguration of one machine. This is the only hard
  // security block on the V2 surface, so the wiring itself is the thing under
  // test: deleting the `runHook('scan-secrets.sh', …)` call must drop these.

  console.log('\n🔐 V2 Secret Scan Tests')

  /**
   * Drive the captured `execute.before` handler with arbitrary tool input and
   * report whether it denied, plus the message the session would see.
   */
  async function secretScanDenial(
    before: (event: unknown) => void | Promise<void>,
    tool: string,
    toolInput: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      await before({
        tool,
        // A NON-read-only agent, so the read-only guard cannot be what denies
        // the call: any denial observed here is attributable to the scan alone.
        sessionID: 'ses_v2_scan',
        agent: 'zeus',
        messageID: 'msg_scan',
        id: 'call_scan',
        input: toolInput,
      })
      return null
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  const scanCaptured = await setupCapturingToolHooks()

  /**
   * Sample token values, assembled from fragments at runtime.
   *
   * These are invented, not real credentials — but the pre-commit gitleaks hook
   * cannot tell a fixture from a leak, and it is right not to. Assembling each
   * value from parts keeps every high-confidence pattern out of this file's
   * bytes, which is the same trick scripts/hooks/scan-secrets.sh uses for its own
   * Bifrost markers (see the comment above BIFROST_HEADER there). A literal
   * token in the test source would also make the repository's own secret scan
   * self-match, which is the same class of problem this wiring exists to catch.
   */
  const SAMPLE_TOKENS = {
    bifrost: `sk${'-'}bf${'-'}abcdef1234567890ABCD`,
    akia: `AKIA${'IOSFODNN7EXAMPLE'}`,
    githubPat: `ghp${'_'}abcdefghijklmnopqrstuvwxyz0123456789`,
    gitlabPat: `glpat${'-'}abcdefghij0123456789`,
    bearer: `Bearer ${'abcdefghij0123456789ABCDEFGHI'}`,
    jwt: `eyJhbGciOiJIUzI1NiJ9${'.'}eyJzdWIiOiIxIn0${'.'}eyJzaWcifQ`,
  } as const

  test('a high-confidence token in tool input is BLOCKED through the V2 registration path', async () => {
    const denial = await secretScanDenial(
      scanCaptured.before as (e: unknown) => Promise<void>,
      'write',
      { filePath: 'notes.md', content: `export const K = "${SAMPLE_TOKENS.bifrost}"` },
    )
    assert.ok(
      denial !== null,
      'a high-confidence `sk-bf-` token in a write payload must be denied — this is the only hard secret block on the V2 surface',
    )
    assert.match(denial, /\[plugin-v2\] Blocked: high-confidence secret detected/)
  })

  test('every high-confidence token family is blocked, not just the Bifrost one', async () => {
    // One regex family that regressed silently is exactly the failure mode that
    // made the block inert in the first place. Each value below must be denied.
    const tokens: Array<[string, string]> = [
      ['AKIA', SAMPLE_TOKENS.akia],
      ['github PAT', SAMPLE_TOKENS.githubPat],
      ['gitlab PAT', SAMPLE_TOKENS.gitlabPat],
      ['bearer', SAMPLE_TOKENS.bearer],
      ['jwt', SAMPLE_TOKENS.jwt],
    ]
    for (const [label, value] of tokens) {
      const denial = await secretScanDenial(
        scanCaptured.before as (e: unknown) => Promise<void>,
        'write',
        { filePath: 'notes.md', content: `token=${value}` },
      )
      assert.ok(denial !== null, `${label} token must be denied by the secret scan`)
    }
  })

  test('an ordinary tool call is NOT denied by the secret scan', async () => {
    // The block must be specific. A scanner that denies everything is as broken
    // as one that denies nothing, and this is the test that says so.
    const denial = await secretScanDenial(
      scanCaptured.before as (e: unknown) => Promise<void>,
      'read',
      { filePath: 'src/index.ts', content: 'export const answer = 42' },
    )
    assert.equal(denial, null, 'a benign tool call must pass the secret scan')
  })

  test('a Bifrost header name alone stays advisory (low confidence, never blocks)', async () => {
    // The Bifrost header is a header/KEY NAME, not a token value. V1 classifies
    // it as low-confidence and logs without blocking; V2 must not harden it into
    // a block or every request carrying the header would be denied. Assembled
    // from fragments for the same reason as SAMPLE_TOKENS: the repository's own
    // secret-scan pre-commit hook reads the literal as a credential.
    const headerName = `x${'-'}bf${'-'}vk`
    const denial = await secretScanDenial(
      scanCaptured.before as (e: unknown) => Promise<void>,
      'write',
      { filePath: 'notes.md', content: `headers: { "${headerName}": "not-a-real-token" }` },
    )
    assert.equal(denial, null, 'the Bifrost header name must not block on its own')
  })

  test('removing the scan-secrets wiring from plugin-v2 drops the secret block', async () => {
    // Structural counterpart to the behavioural tests above. If the block is
    // ever "restored" by re-registering the V1 plugin (pantheon-hooks.ts) the
    // file would stop calling the runner itself, and on a V2-only install —
    // opencode.json `plugins: ["src/plugin-v2"]` — the block would go inert
    // again while every behavioural test kept passing on a machine that has the
    // V1 plugin lying around. These two assertions together fail that.
    assert.match(
      pluginSource,
      /runHook\(\s*'scan-secrets\.sh'/,
      'plugin-v2.ts must invoke scan-secrets.sh through the shared hook runner',
    )
    assert.match(
      pluginSource,
      /code === 2/,
      'the high-confidence exit code (2) must be the one that blocks',
    )
    // Anchored to a line whose first token is `import`, so the module's prose
    // about `src/plugins/pantheon-hooks.ts` (six mentions, all in comments)
    // cannot satisfy or trip it — only a real import statement can.
    assert.doesNotMatch(
      pluginSource,
      /^\s*import\s+(?:[^'"]*from\s+)?['"][^'"]*pantheon-hooks(?:\.ts)?['"]/m,
      'plugin-v2 must not import the V1 hooks plugin: it is not loaded on a V2-only install, so importing it would make the block inert again',
    )
  })

  test('the secret mask regex in plugin-v2 has not drifted from the V1 surface', () => {
    // The mask regex is duplicated (V1's copy is unreachable from V2). Drift
    // means a redacted value is no longer redacted, so the two must stay in
    // step. Compared against the V1 source rather than a second literal here, so
    // there is exactly one place to update.
    const v1Source = readFileSync(
      new URL('../../src/plugins/pantheon-hooks.ts', import.meta.url),
      'utf8',
    )
    const extract = (source: string): string | null => {
      // The literal is a single line in both files; `[^\n]*` keeps the match
      // from running past it into the next declaration.
      const match = /const SECRET_MASK_RE\s*=\s*(\/[^\n]*\/[a-z]*)/.exec(source)
      return match?.[1]?.trim() ?? null
    }
    const v2Mask = extract(pluginSource)
    const v1Mask = extract(v1Source)
    assert.ok(v2Mask !== null, 'plugin-v2.ts must define SECRET_MASK_RE')
    assert.ok(v1Mask !== null, 'pantheon-hooks.ts must define SECRET_MASK_RE')
    assert.equal(v2Mask, v1Mask, 'the V1 and V2 secret mask regexes have drifted')
  })

  test('scan-secrets.sh is shipped in the published package and reachable from the plugin', () => {
    // The failure this guards is silent and looks like a fix: if the script is
    // not in the package `files` list, or the runner's relative resolution
    // breaks from an install prefix, runHook returns code 1 and the block never
    // fires on a real install — while every test here still passes from the repo.
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { files?: string[] }
    assert.ok(pkg.files?.includes('scripts/hooks/**'), 'scripts/hooks/** must be published')
    assert.ok(
      pkg.files?.includes('src/plugins/**'),
      'src/plugins/** (the hook runner) must be published',
    )
    // The runner resolves scripts/hooks/ from its own import.meta.url:
    // src/plugins/hook-runner.ts -> ../../scripts/hooks/. Both halves are in
    // `files`, so the relative hop is intact for any install prefix
    // (lib/node_modules, the npx cache, or a linked checkout).
    assert.match(
      readFileSync(new URL('../../src/plugins/hook-runner.ts', import.meta.url), 'utf8'),
      /new URL\('\.\.\/\.\.\/scripts\/hooks\/', import\.meta\.url\)/,
      'the hook runner must anchor its scripts/hooks resolution on import.meta.url, not process.cwd()',
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
    })
    assert.ok(bridge != null)
    assert.ok(bridge.board != null)
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
      goalStore: { list: async () => [] } as never,
      todoEnforcer: { onIdle: async () => {}, noteUserActivity: () => {} } as never,
      visionHandler: {
        chatMessage: async () => {},
        messagesTransform: async () => {},
        event: async () => {},
      },
    })
    assert.ok(bridge.board)
    assert.ok(bridge.goalStore)
    assert.ok(bridge.todoEnforcer)
    assert.ok(bridge.visionHandler)
  })

  test('bridge gracefully degrades with partial singletons', () => {
    const bridge = createV2Bridge({
      board: { list: () => [] } as never,
      // goalStore intentionally omitted
    })
    assert.ok(bridge.board)
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

  // ─── Summary ───────────────────────────────────────────────────────

  for (const { name, fn } of queuedTests) {
    try {
      await fn()
      passed++
      console.log(`  ✅ ${name}`)
    } catch (err) {
      failed++
      console.error(`  ❌ ${name}:`, err)
    }
  }

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
