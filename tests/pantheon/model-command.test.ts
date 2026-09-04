import { strict as assert } from 'node:assert'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createModelCommand,
  KNOWN_AGENTS,
  validateModelRef,
} from '../../src/pantheon/model-command.ts'

type TestScope = {
  root: string
  project: string
  global: string
}

function makeScope(): TestScope {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-model-command-'))
  const project = join(root, 'project')
  const global = join(root, 'xdg', 'opencode')
  mkdirSync(project, { recursive: true })
  return { root, project, global }
}

function command(
  scope: TestScope,
  opts: { env?: NodeJS.ProcessEnv; ask?: (q: unknown[]) => Promise<Record<string, unknown>> } = {},
) {
  const candidates = [
    join(scope.project, '.pantheon', 'active-preset.json'),
    join(scope.global, '.pantheon', 'active-preset.json'),
  ]
  return createModelCommand({
    cwd: scope.project,
    globalConfigPath: join(scope.global, 'opencode.json'),
    activePresetCandidates: candidates,
    env: opts.env,
    ask: opts.ask,
  }).pantheon_model
}

function projectActive(scope: TestScope): string {
  return join(scope.project, '.pantheon', 'active-preset.json')
}
function globalActive(scope: TestScope): string {
  return join(scope.global, '.pantheon', 'active-preset.json')
}

async function main(): Promise<void> {
  // validateModelRef
  assert.equal(validateModelRef('openai/gpt-5.6'), true)
  assert.equal(validateModelRef('opencode-go/kimi-k2.7-code'), true)
  assert.equal(validateModelRef('provider/model-id:free'), true)
  assert.equal(validateModelRef('missing-provider'), false)
  assert.equal(validateModelRef('/missing-provider'), false)
  assert.equal(validateModelRef('provider/'), false)
  assert.equal(validateModelRef('provider/model with spaces'), false)
  assert.equal(KNOWN_AGENTS.length, 14)

  // 1. set per-agent writes overrides.agents[agent] with variant, .bak, atomic, mode
  {
    const scope = makeScope()
    try {
      const tool = command(scope)
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      writeFileSync(
        projectActive(scope),
        JSON.stringify({
          version: 1,
          preset: 'go-free',
          source: 'cli',
          updated_at: new Date().toISOString(),
          overrides: { providers: { secret: 'hidden-should-not-leak' } },
        }),
      )
      // Also create an opencode.json with global model keys to ensure we don't touch them
      const configPath = join(scope.project, 'opencode.json')
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            provider: { secretProvider: { apiKey: 'do-not-touch' } },
            agent: { hermes: { model: 'old-agent-model' } },
            'active-preset': 'do-not-touch',
            model: 'old/provider-model',
            small_model: 'old/small-model',
            custom: { keep: true },
          },
          null,
          2,
        ),
      )
      const setResult = await tool.execute(
        {
          action: 'set',
          agent: 'hermes',
          model: 'opencode-go/kimi-k2.7-code',
          effort: 'high',
          scope: 'project',
        },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(setResult, /restart OpenCode/i)
      assert.match(setResult, /hermes/i)
      const after = JSON.parse(readFileSync(projectActive(scope), 'utf8'))
      assert.equal(after.preset, 'go-free')
      assert.equal(after.overrides.agents.hermes.model, 'opencode-go/kimi-k2.7-code')
      assert.equal(after.overrides.agents.hermes.variant, 'high')
      assert.equal(after.overrides.providers.secret, 'hidden-should-not-leak')
      // .bak exists and contains previous content without hermes override
      assert.ok(existsSync(`${projectActive(scope)}.bak`))
      const bak = JSON.parse(readFileSync(`${projectActive(scope)}.bak`, 'utf8'))
      assert.equal(bak.overrides?.agents?.hermes, undefined)
      // Ensure opencode.json top-level model/small_model not injected/changed
      const opencodeAfter = JSON.parse(readFileSync(configPath, 'utf8'))
      assert.equal(opencodeAfter.model, 'old/provider-model')
      assert.equal(opencodeAfter.small_model, 'old/small-model')
      assert.equal(opencodeAfter.provider.secretProvider.apiKey, 'do-not-touch')
      assert.equal(opencodeAfter.custom.keep, true)
      // No .env file created
      assert.equal(existsSync(join(scope.project, '.env')), false)
      assert.equal(existsSync(join(scope.project, '.pantheon', '.env')), false)

      // status lists 14 agents with origin
      const status = await tool.execute({ action: 'status' }, { sessionID: 'root', agent: 'zeus' })
      for (const agent of KNOWN_AGENTS) {
        assert.match(status, new RegExp(`${agent}:`))
      }
      // hermes should show override
      assert.match(status, /hermes: opencode-go\/kimi-k2\.7-code \(origin: override/)
      // zeus still from preset
      assert.match(status, /zeus: .*\(origin: preset/)
      assert.doesNotMatch(status, /hidden-should-not-leak/)
      assert.doesNotMatch(status, /do-not-touch/)
      // active preset line contains go-free and preset source
      assert.match(status, /active preset: go-free \(file\)/i)

      // set with effort clamped: deepseek-v4-flash maxEffort medium, request high should clamp
      const clampResult = await tool.execute(
        {
          action: 'set',
          agent: 'apollo',
          model: 'opencode-go/deepseek-v4-flash',
          effort: 'high',
          scope: 'project',
        },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(clampResult, /clamped/i)
      const afterClamp = JSON.parse(readFileSync(projectActive(scope), 'utf8'))
      assert.equal(afterClamp.overrides.agents.apollo.variant, 'medium')

      // hasVision warning for text-only (deepseek is text-only)
      const visionResult = await tool.execute(
        {
          action: 'set',
          agent: 'gaia',
          model: 'opencode-go/deepseek-v4-flash',
          effort: 'medium',
          scope: 'project',
        },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(visionResult, /text-only/i)

      // reset removes override
      const resetResult = await tool.execute(
        { action: 'reset', agent: 'hermes', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(resetResult, /removed/i)
      const afterReset = JSON.parse(readFileSync(projectActive(scope), 'utf8'))
      assert.equal(afterReset.overrides.agents.hermes, undefined)
      // After reset, hermes should fall back to preset origin, not override
      const statusAfterReset = await tool.execute(
        { action: 'status' },
        { sessionID: 'root', agent: 'zeus' },
      )
      // hermes from go-free preset is deepseek-v4-flash-free, origin preset
      assert.match(statusAfterReset, /hermes: opencode\/deepseek-v4-flash-free \(origin: preset/)
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 2. env origin
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      writeFileSync(
        projectActive(scope),
        JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }),
      )
      const toolEnv = command(scope, {
        env: { PANTHEON_MODEL_PRESET: 'go-fast', HOME: scope.global } as NodeJS.ProcessEnv,
      })
      const status = await toolEnv.execute(
        { action: 'status' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(status, /active preset: go-fast \(env\)/i)
      // agents should show env origin
      assert.match(status, /zeus: .*\(origin: env/)
      assert.doesNotMatch(status, /hidden/)
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 3. none origin when no preset
  {
    const scope = makeScope()
    try {
      const tool = command(scope, { env: {} })
      const status = await tool.execute({ action: 'status' }, { sessionID: 'root', agent: 'zeus' })
      assert.match(status, /active preset: none/)
      for (const agent of KNOWN_AGENTS) {
        assert.match(status, new RegExp(`${agent}: not configured \\(origin: none`))
      }
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 4. global scope requires confirm + authorize_global, atomic .bak, lock
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      mkdirSync(join(scope.global, '.pantheon'), { recursive: true })
      writeFileSync(
        projectActive(scope),
        JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }),
      )
      const tool = command(scope)
      const denied = await tool.execute(
        { action: 'set', agent: 'hermes', model: 'openai/gpt-5.6', scope: 'global', confirm: true },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(denied, /explicit confirmation and separate global authorization/i)
      assert.equal(existsSync(globalActive(scope)), false)

      const yesOnly = await tool.execute(
        {
          action: 'set',
          agent: 'hermes',
          model: 'openai/gpt-5.6',
          scope: 'global',
          confirm: true,
        } as unknown as Parameters<typeof tool.execute>[0],
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(yesOnly, /explicit confirmation and separate global authorization/i)

      const okGlobal = await tool.execute(
        {
          action: 'set',
          agent: 'hermes',
          model: 'openai/gpt-5.6',
          effort: 'high',
          scope: 'global',
          confirm: true,
          authorize_global: true,
        },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(okGlobal, /global/i)
      const gAfter = JSON.parse(readFileSync(globalActive(scope), 'utf8'))
      assert.equal(gAfter.overrides.agents.hermes.model, 'openai/gpt-5.6')
      assert.equal(gAfter.overrides.agents.hermes.variant, 'medium') // gpt-5.6 max medium clamped from high
      assert.match(okGlobal, /clamped|restart/i)

      const deniedReset = await tool.execute(
        { action: 'reset', agent: 'hermes', scope: 'global', confirm: true },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(deniedReset, /explicit confirmation and separate global authorization/i)
      assert.ok(existsSync(globalActive(scope)))

      const okReset = await tool.execute(
        {
          action: 'reset',
          agent: 'hermes',
          scope: 'global',
          confirm: true,
          authorize_global: true,
        },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(okReset, /removed/i)
      const gAfterReset = JSON.parse(readFileSync(globalActive(scope), 'utf8'))
      assert.equal(gAfterReset.overrides.agents.hermes, undefined)
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 5. invalid model ref, unknown agent, missing capability
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      writeFileSync(
        projectActive(scope),
        JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }),
      )
      const tool = command(scope)

      const invalidFormat = await tool.execute(
        { action: 'set', agent: 'hermes', model: 'not-a-model', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(invalidFormat, /provider\/model/i)
      const afterInvalid = JSON.parse(readFileSync(projectActive(scope), 'utf8'))
      assert.equal(
        (afterInvalid as unknown as { overrides?: { agents?: Record<string, unknown> } })?.overrides
          ?.agents?.hermes,
        undefined,
      )

      const unknownAgent = await tool.execute(
        { action: 'set', agent: 'unknown-agent', model: 'openai/gpt-5.6', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(unknownAgent, /unknown agent/i)

      const missingModel = await tool.execute(
        { action: 'set', agent: 'hermes', scope: 'project' } as unknown as Parameters<
          typeof tool.execute
        >[0],
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(missingModel, /requires --model/i)

      const unknownCapability = await tool.execute(
        { action: 'set', agent: 'hermes', model: 'openai/unknown-model-xyz-123', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(unknownCapability, /no capability entry/i)

      const invalidAgentReset = await tool.execute(
        { action: 'reset', agent: 'nope', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(invalidAgentReset, /unknown agent/i)

      const missingAgentReset = await tool.execute(
        { action: 'reset', scope: 'project' } as unknown as Parameters<typeof tool.execute>[0],
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(missingAgentReset, /requires --agent/i)
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 6. invalid JSON handling
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      const original = '{ invalid json\n'
      writeFileSync(projectActive(scope), original)
      const tool = command(scope)
      const result = await tool.execute(
        { action: 'set', agent: 'hermes', model: 'openai/gpt-5.6', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(result, /invalid JSON/i)
      assert.equal(readFileSync(projectActive(scope), 'utf8'), original)
      assert.equal(existsSync(`${projectActive(scope)}.bak`), false)
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 7. write failure due to .bak symlink protection
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      const p = projectActive(scope)
      writeFileSync(p, JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }))
      const before = readFileSync(p, 'utf8')
      mkdirSync(`${p}.bak`)
      const tool = command(scope)
      const result = await tool.execute(
        { action: 'set', agent: 'hermes', model: 'openai/gpt-5.6', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(result, /failed|preserved/i)
      assert.equal(readFileSync(p, 'utf8'), before)
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 8. concurrency with per-path lock
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      writeFileSync(
        projectActive(scope),
        JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }),
      )
      const tool = command(scope)
      const [r1, r2] = await Promise.all([
        tool.execute(
          {
            action: 'set',
            agent: 'hermes',
            model: 'openai/gpt-5.6',
            effort: 'medium',
            scope: 'project',
          },
          { sessionID: 'root', agent: 'zeus' },
        ),
        tool.execute(
          {
            action: 'set',
            agent: 'apollo',
            model: 'openai/gpt-5.6-luna-fast',
            effort: 'low',
            scope: 'project',
          },
          { sessionID: 'root', agent: 'zeus' },
        ),
      ])
      assert.match(r1, /updated|set/i)
      assert.match(r2, /updated|set/i)
      const after = JSON.parse(readFileSync(projectActive(scope), 'utf8'))
      assert.equal(after.overrides.agents.hermes.model, 'openai/gpt-5.6')
      assert.equal(after.overrides.agents.apollo.model, 'openai/gpt-5.6-luna-fast')
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 9. symlink protection for active-preset.json
  {
    const scope = makeScope()
    try {
      const real = join(scope.root, 'real-preset.json')
      const p = projectActive(scope)
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      writeFileSync(real, JSON.stringify({ version: 1, preset: 'go-free' }))
      symlinkSync(real, p)
      const result = await command(scope).execute(
        { action: 'set', agent: 'hermes', model: 'openai/gpt-5.6', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(result, /failed|symlink/i)
      assert.equal(lstatSync(p).isSymbolicLink(), true)
      assert.equal(JSON.parse(readFileSync(real, 'utf8')).overrides, undefined)
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 10. permission mode preservation
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      const p = projectActive(scope)
      writeFileSync(p, JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }), {
        mode: 0o640,
      })
      chmodSync(p, 0o640)
      const tool = command(scope)
      await tool.execute(
        { action: 'set', agent: 'hermes', model: 'openai/gpt-5.6', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.equal(statSync(p).mode & 0o7777, 0o640)
      assert.equal(statSync(`${p}.bak`).mode & 0o7777, 0o600)
      assert.equal(
        readdirSync(join(scope.project, '.pantheon')).some((e) => e.includes('.tmp-')),
        false,
      )

      // new file gets 0o600
      const s2 = makeScope()
      try {
        const p2 = projectActive(s2)
        await command(s2).execute(
          { action: 'set', agent: 'hermes', model: 'openai/gpt-5.6', scope: 'project' },
          { sessionID: 'root', agent: 'zeus' },
        )
        assert.equal(statSync(p2).mode & 0o7777, 0o600)
      } finally {
        rmSync(s2.root, { recursive: true, force: true })
      }
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 11. backup symlink protection
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      const p = projectActive(scope)
      const bak = `${p}.bak`
      const bakTarget = join(scope.root, 'bak-target.json')
      writeFileSync(p, JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }))
      writeFileSync(bakTarget, 'must remain untouched\n')
      symlinkSync(bakTarget, bak)
      const before = readFileSync(p, 'utf8')
      const result = await command(scope).execute(
        { action: 'set', agent: 'hermes', model: 'openai/gpt-5.6', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.match(result, /failed|symlink/i)
      assert.equal(readFileSync(p, 'utf8'), before)
      assert.equal(readFileSync(bakTarget, 'utf8'), 'must remain untouched\n')
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 12. wizard askQuestions when no args (agent → model → effort → scope)
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      writeFileSync(
        projectActive(scope),
        JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }),
      )
      let asked: unknown[] | undefined
      const ask = async (questions: unknown[]) => {
        asked = questions
        return { agent: 'nyx', model: 'openai/gpt-5.6-luna', effort: 'low', scope: 'project' }
      }
      const tool = command(scope, { ask: ask as never })
      const result = await tool.execute({} as never, { sessionID: 'root', agent: 'zeus' })
      assert.ok(asked && asked.length >= 3, 'wizard should ask at least 3 questions')
      assert.match(result, /nyx.*openai\/gpt-5\.6-luna/i)
      const after = JSON.parse(readFileSync(projectActive(scope), 'utf8'))
      assert.equal(after.overrides.agents.nyx.model, 'openai/gpt-5.6-luna')
      assert.equal(after.overrides.agents.nyx.variant, 'low')
      // never writes .env
      assert.equal(existsSync(join(scope.project, '.env')), false)
      // never injects top-level model/small_model
      const configPath = join(scope.project, 'opencode.json')
      if (existsSync(configPath)) {
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
        assert.equal(cfg.model, undefined)
        assert.equal(cfg.small_model, undefined)
      }
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 13. wizard via empty args but with global scope auto-confirms
  {
    const scope = makeScope()
    try {
      mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
      mkdirSync(join(scope.global, '.pantheon'), { recursive: true })
      writeFileSync(
        projectActive(scope),
        JSON.stringify({ version: 1, preset: 'go-free', overrides: {} }),
      )
      const ask = async () => ({
        agent: 'iris',
        model: 'openai/gpt-5.6',
        effort: 'medium',
        scope: 'global',
      })
      const tool = command(scope, { ask: ask as never })
      const result = await tool.execute({} as never, { sessionID: 'root', agent: 'zeus' })
      assert.match(result, /global/i)
      const g = JSON.parse(readFileSync(globalActive(scope), 'utf8'))
      assert.equal(g.overrides.agents.iris.model, 'openai/gpt-5.6')
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  // 14. ensure never writes .env even when preset requires key check (no .env write)
  {
    const scope = makeScope()
    try {
      const tool = command(scope)
      await tool.execute(
        { action: 'set', agent: 'hermes', model: 'openai/gpt-5.6', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.equal(existsSync(join(scope.project, '.env')), false)
      assert.equal(existsSync(join(scope.global, '.env')), false)
      assert.equal(existsSync(join(scope.project, '.pantheon', '.env')), false)
      const files = readdirSync(scope.project)
      assert.ok(!files.includes('.env'))
    } finally {
      rmSync(scope.root, { recursive: true, force: true })
    }
  }

  console.log('✅ model command: all tests passed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
