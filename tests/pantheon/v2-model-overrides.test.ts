import { strict as assert } from 'node:assert'
import { constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyV2ModelOverrides,
  readV2ModelConfiguration,
  readV2PresetFile,
  type V2AgentDraftLike,
} from '../../src/pantheon/v2-model-overrides.ts'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v2-model-overrides-'))
  try {
    const projectDir = join(root, 'project', '.pantheon')
    const globalDir = join(root, 'global', '.pantheon')
    const projectFile = join(projectDir, 'active-preset.json')
    const globalFile = join(globalDir, 'active-preset.json')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(globalDir, { recursive: true })

    // The preset reader opens nonblocking, fstats the opened descriptor, and
    // refuses a FIFO/non-regular file before attempting to read it.
    if (constants.O_NOFOLLOW && constants.O_NONBLOCK) {
      const calls: string[] = []
      let openedFlags = 0
      assert.throws(
        () =>
          readV2PresetFile('fake-active-preset.json', {
            openSync: (_path, flags) => {
              calls.push('open')
              openedFlags = flags
              return 17
            },
            fstatSync: (fileDescriptor) => {
              calls.push('fstat')
              assert.equal(fileDescriptor, 17)
              return { isFile: () => false }
            },
            readFileSync: () => {
              calls.push('read')
              return '{}'
            },
            closeSync: (fileDescriptor) => {
              calls.push('close')
              assert.equal(fileDescriptor, 17)
            },
          }),
        /regular file/i,
      )
      assert.equal(openedFlags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      assert.deepEqual(calls, ['open', 'fstat', 'close'])
    }

    writeFileSync(
      globalFile,
      JSON.stringify({
        version: 1,
        preset: 'go-fast',
        overrides: {
          agents: {
            hermes: { model: 'deepseek/deepseek-v4-pro', variant: 'high' },
            gaia: { model: 'openai/gpt-5.6', variant: 'low' },
          },
        },
      }),
    )
    // V2 ignores global overrides, even when the project file has no overrides.
    writeFileSync(projectFile, JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }))

    const configuration = readV2ModelConfiguration({
      candidates: [projectFile, globalFile],
      env: { PANTHEON_MODEL_PRESET: 'go-fast' } as NodeJS.ProcessEnv,
    })
    assert.deepEqual(configuration.legacyPresetMarker, { source: 'env' })
    assert.deepEqual(configuration.overrides, {})

    // Only the explicit project override is read/applied; other agents retain
    // the host defaults rather than inheriting global configuration.
    writeFileSync(
      projectFile,
      JSON.stringify({
        version: 1,
        preset: 'go-free',
        overrides: { agents: { hermes: { model: 'deepseek/deepseek-v4-pro', variant: 'high' } } },
      }),
    )
    const merged = readV2ModelConfiguration({ candidates: [projectFile, globalFile], env: {} })
    assert.deepEqual(merged.overrides.hermes, {
      model: 'deepseek/deepseek-v4-pro',
      variant: 'high',
    })
    assert.equal(merged.overrides.gaia, undefined)

    writeFileSync(
      projectFile,
      JSON.stringify({
        overrides: {
          agents: {
            hermes: { model: 'openai/gpt-5.6', variant: 'low' },
            gaia: { model: 'openai/gpt-5.6', variant: 'medium' },
            athena: { model: 'deepseek/deepseek-v4-pro', variant: 'high' },
            apollo: { model: 'openai/gpt-5.6', reasoning_effort: 'medium' },
          },
        },
      }),
    )
    const variants = readV2ModelConfiguration({ candidates: [projectFile], env: {} })
    assert.deepEqual(variants.overrides, {
      hermes: { model: 'openai/gpt-5.6', variant: 'low' },
      gaia: { model: 'openai/gpt-5.6', variant: 'medium' },
      athena: { model: 'deepseek/deepseek-v4-pro', variant: 'high' },
      apollo: { model: 'openai/gpt-5.6', variant: 'medium' },
    })
    assert.deepEqual(variants.warnings, [])

    const originalModel = {
      providerID: 'host-provider',
      id: 'host-default',
      variant: 'host-variant',
    }
    const agents = new Map<string, Record<string, unknown>>([
      ['hermes', { id: 'hermes', model: originalModel, request: { body: { keep: true } } }],
      ['gaia', { id: 'gaia', model: { providerID: 'host-provider', id: 'gaia-default' } }],
      [
        'unsupported-secret-agent',
        {
          id: 'unsupported-secret-agent',
          model: { providerID: 'host-provider', id: 'host-default' },
        },
      ],
    ])
    const draft: V2AgentDraftLike = {
      list: () => [...agents.values()] as Array<{ id: string }>,
      update: (id, update) => {
        const agent = agents.get(id)
        if (agent) update(agent as { id: string; model?: unknown })
      },
    }
    const hermesOverride = merged.overrides.hermes
    assert.ok(hermesOverride)
    applyV2ModelOverrides(draft, {
      hermes: hermesOverride,
      'unsupported-secret-agent': { model: 'openai/gpt-5.6' },
    })

    const hermes = agents.get('hermes')
    assert.ok(hermes)
    assert.deepEqual(hermes.model, {
      providerID: 'deepseek',
      id: 'deepseek-v4-pro',
      variant: 'high',
    })
    assert.deepEqual(hermes.request, { body: { keep: true } }, 'other host settings stay intact')
    assert.deepEqual(
      agents.get('gaia')?.model,
      { providerID: 'host-provider', id: 'gaia-default' },
      'an agent without a manual override keeps its host model unchanged',
    )
    assert.deepEqual(
      agents.get('unsupported-secret-agent')?.model,
      { providerID: 'host-provider', id: 'host-default' },
      'non-canonical host IDs are not overridden',
    )

    // Explicit model changes update variant when supplied and clear inherited
    // variants when omitted, without dropping unrelated host model properties.
    const variantAgent = {
      id: 'hermes',
      model: { providerID: 'old-provider', id: 'old-model', variant: 'high', temperature: 0.2 },
    }
    const variantDraft: V2AgentDraftLike = {
      list: () => [variantAgent],
      update: (_id, update) => update(variantAgent),
    }
    applyV2ModelOverrides(variantDraft, {
      hermes: { model: 'openai/gpt-5.6', variant: 'low' },
    })
    assert.deepEqual(variantAgent.model, {
      providerID: 'openai',
      id: 'gpt-5.6',
      variant: 'low',
      temperature: 0.2,
    })
    applyV2ModelOverrides(variantDraft, { hermes: { model: 'anthropic/claude-sonnet-4-6' } })
    assert.deepEqual(variantAgent.model, {
      providerID: 'anthropic',
      id: 'claude-sonnet-4-6',
      temperature: 0.2,
    })

    const unchangedModel = {
      providerID: 'host-provider',
      id: 'host-default',
      variant: 'host-variant',
    }
    const noOverrideAgent = { id: 'gaia', model: unchangedModel }
    const noOverrideDraft: V2AgentDraftLike = {
      list: () => [noOverrideAgent],
      update: (_id, update) => update(noOverrideAgent),
    }
    applyV2ModelOverrides(noOverrideDraft, {})
    assert.strictEqual(
      noOverrideAgent.model,
      unchangedModel,
      'without an override host model stays intact',
    )

    const unsupportedVariantModel = {
      providerID: 'host-provider',
      id: 'host-default',
      variant: 'host-variant',
    }
    const unsupportedVariantAgent = { id: 'hermes', model: unsupportedVariantModel }
    const unsupportedVariantDraft: V2AgentDraftLike = {
      list: () => [unsupportedVariantAgent],
      update: (_id, update) => update(unsupportedVariantAgent),
    }
    applyV2ModelOverrides(unsupportedVariantDraft, {
      hermes: { model: 'opencode/deepseek-v4-flash-free', variant: 'high' },
    })
    assert.strictEqual(
      unsupportedVariantAgent.model,
      unsupportedVariantModel,
      'unsupported model variants leave the host model unchanged',
    )

    // A legacy marker alone is inert: it does not produce any model override.
    writeFileSync(
      projectFile,
      JSON.stringify({ version: 1, preset: 'secret-marker-value', overrides: {} }),
    )
    const legacyOnly = readV2ModelConfiguration({ candidates: [projectFile], env: {} })
    assert.deepEqual(legacyOnly.overrides, {})
    assert.deepEqual(legacyOnly.legacyPresetMarker, { source: 'file' })
    assert.doesNotMatch(JSON.stringify(legacyOnly), /secret-marker-value/)
    const unchanged = { id: 'hermes', model: originalModel }
    const unchangedDraft: V2AgentDraftLike = {
      list: () => [unchanged],
      update: (_id, update) => update(unchanged),
    }
    applyV2ModelOverrides(unchangedDraft, legacyOnly.overrides)
    assert.strictEqual(unchanged.model, originalModel, 'no preset fallback writes a model')

    // Invalid project JSON fails closed, and the warning never includes the
    // config contents or falls through to a global file.
    const secretLikeContent = '{"token":"private-config-value"'
    writeFileSync(projectFile, secretLikeContent)
    const malformed = readV2ModelConfiguration({ candidates: [projectFile, globalFile], env: {} })
    assert.deepEqual(malformed.overrides, {})
    assert.ok(malformed.warnings.some((warning) => /invalid JSON/i.test(warning)))
    assert.doesNotMatch(malformed.warnings.join('\n'), /private-config-value|token/i)

    // A malformed project agents object warns; global overrides are ignored.
    writeFileSync(projectFile, JSON.stringify({ overrides: { agents: [] } }))
    writeFileSync(
      globalFile,
      JSON.stringify({ overrides: { agents: { gaia: { model: 'openai/gpt-5.6' } } } }),
    )
    const invalidRoot = readV2ModelConfiguration({ candidates: [projectFile, globalFile], env: {} })
    assert.deepEqual(invalidRoot.overrides, {})
    assert.equal(invalidRoot.warnings.length, 1)
    assert.match(invalidRoot.warnings[0] ?? '', /overrides\.agents.*expected an object/i)

    // Rejected entries produce actionable warnings while valid agents in the
    // same object continue to apply; warning text never echoes model values.
    writeFileSync(
      projectFile,
      JSON.stringify({
        overrides: {
          agents: {
            hermes: {
              model: 'openai/gpt-5.6',
              variant: null,
              reasoning_effort: 'high',
            },
            gaia: { model: 'openai/gpt-5.6' },
            'unsupported-secret-agent': { model: 'openai/gpt-5.6' },
            apollo: { model: 'opencode/deepseek-v4-flash-free', variant: 'high' },
          },
        },
      }),
    )
    const invalidEntries = readV2ModelConfiguration({ candidates: [projectFile], env: {} })
    assert.deepEqual(invalidEntries.overrides, { gaia: { model: 'openai/gpt-5.6' } })
    assert.equal(invalidEntries.warnings.length, 3)
    assert.ok(invalidEntries.warnings.some((warning) => /unsupported agent/i.test(warning)))
    assert.ok(
      invalidEntries.warnings.some((warning) => /model or variant is unsupported/i.test(warning)),
    )
    assert.doesNotMatch(
      invalidEntries.warnings.join('\n'),
      /hermes|unsupported-secret-agent|private-model-value|deepseek-v4-flash-free|secret-variant|openai\/gpt-5\.6|high/,
    )
    assert.ok(
      invalidEntries.warnings.some(
        (warning) =>
          warning ===
          'Override entry ignored because its model or variant is unsupported; choose a supported model and reasoning variant.',
      ),
    )
    const invalidVariantHost = {
      id: 'hermes',
      model: { providerID: 'host-provider', id: 'host-default', variant: 'host-variant' },
    }
    const invalidVariantDraft: V2AgentDraftLike = {
      list: () => [invalidVariantHost],
      update: (_id, update) => update(invalidVariantHost),
    }
    applyV2ModelOverrides(invalidVariantDraft, invalidEntries.overrides)
    assert.deepEqual(invalidVariantHost.model, {
      providerID: 'host-provider',
      id: 'host-default',
      variant: 'host-variant',
    })

    // A second candidate cannot inject a global read failure into project
    // status or override application.
    if (process.platform === 'linux') {
      const combined = readV2ModelConfiguration({
        candidates: [projectFile, '/proc/self/mem'],
        env: {},
      })
      assert.equal(combined.warnings.length, 3)
      assert.ok(combined.warnings.some((warning) => /unsupported agent/i.test(warning)))
      assert.equal(
        combined.warnings.some((warning) => /could not be read/i.test(warning)),
        false,
      )
      assert.deepEqual(combined.overrides, { gaia: { model: 'openai/gpt-5.6' } })
    }

    // /proc/self/mem is a regular file whose read fails on Linux, exercising
    // the distinct filesystem-read failure path rather than the type guard.
    if (process.platform === 'linux') {
      const unreadable = readV2ModelConfiguration({ candidates: ['/proc/self/mem'], env: {} })
      assert.deepEqual(unreadable.overrides, {})
      assert.ok(unreadable.warnings.some((warning) => /could not be read/i.test(warning)))
      assert.doesNotMatch(unreadable.warnings.join('\n'), /private-config-value|EIO|mem/i)
    }

    // A final-component symlink is rejected by opening with O_NOFOLLOW; the
    // target contents never become configuration or warning text.
    const symlinkTarget = join(root, 'symlink-target.json')
    const symlinkPath = join(projectDir, 'symlink-active-preset.json')
    writeFileSync(
      symlinkTarget,
      JSON.stringify({ overrides: { agents: { hermes: { model: 'openai/gpt-5.6' } } } }),
    )
    symlinkSync(symlinkTarget, symlinkPath)
    const symlinkConfig = readV2ModelConfiguration({ candidates: [symlinkPath], env: {} })
    assert.deepEqual(symlinkConfig.overrides, {})
    assert.equal(symlinkConfig.warnings.length, 1)
    assert.doesNotMatch(symlinkConfig.warnings.join('\n'), /symlink-target|openai\/gpt-5\.6/)

    console.log(
      '✅ V2 model overrides: explicit models apply; host defaults and legacy markers stay inert',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
