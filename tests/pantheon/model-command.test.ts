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

import { createModelCommand, validateModelRef } from '../../src/pantheon/model-command.ts'

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

function command(scope: TestScope) {
  return createModelCommand({
    cwd: scope.project,
    globalConfigPath: join(scope.global, 'opencode.json'),
    activePresetCandidates: [join(scope.project, '.pantheon', 'active-preset.json')],
  }).pantheon_model
}

async function main(): Promise<void> {
  assert.equal(validateModelRef('openai/gpt-5.6'), true)
  assert.equal(validateModelRef('provider/model-id:free'), true)
  assert.equal(validateModelRef('missing-provider'), false)
  assert.equal(validateModelRef('/missing-provider'), false)
  assert.equal(validateModelRef('provider/'), false)
  assert.equal(validateModelRef('provider/model with spaces'), false)

  const scope = makeScope()
  try {
    const tool = command(scope)
    const configPath = join(scope.project, 'opencode.json')
    mkdirSync(join(scope.project, '.pantheon'), { recursive: true })
    writeFileSync(
      join(scope.project, '.pantheon', 'active-preset.json'),
      JSON.stringify({ preset: 'go-fast', overrides: { providers: { secret: 'hidden' } } }),
    )
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          provider: { secretProvider: { apiKey: 'do-not-touch' } },
          agent: { hermes: { model: 'agent-model' } },
          'active-preset': 'do-not-touch',
          model: 'old/provider-model',
          small_model: 'old/small-model',
          custom: { keep: true },
        },
        null,
        2,
      )}\n`,
    )

    const setModel = await tool.execute(
      { action: 'set', model: 'openai/gpt-5.6', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(setModel, /restart OpenCode/i)
    const afterModel = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(afterModel.model, 'openai/gpt-5.6')
    assert.equal(afterModel.small_model, 'old/small-model')
    assert.equal(afterModel.provider.secretProvider.apiKey, 'do-not-touch')
    assert.equal(afterModel.agent.hermes.model, 'agent-model')
    assert.equal(afterModel.custom.keep, true)
    assert.ok(existsSync(`${configPath}.bak`))
    assert.equal(JSON.parse(readFileSync(`${configPath}.bak`, 'utf8')).model, 'old/provider-model')

    await tool.execute(
      { action: 'set', small_model: 'openai/gpt-5.6-mini', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    const afterSmallModel = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(afterSmallModel.model, 'openai/gpt-5.6')
    assert.equal(afterSmallModel.small_model, 'openai/gpt-5.6-mini')

    const status = await tool.execute({ action: 'status' }, { sessionID: 'root', agent: 'zeus' })
    assert.match(status, /model: openai\/gpt-5\.6/)
    assert.match(status, /model origin: project/)
    assert.match(status, /small_model origin: project/)
    assert.match(status, /active preset: go-fast \(project\)/)
    assert.doesNotMatch(status, /do-not-touch/)
    assert.doesNotMatch(status, /hidden/)

    const deniedGlobalResult = await tool.execute(
      { action: 'set', model: 'anthropic/claude-3.7', scope: 'global', confirm: true },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(deniedGlobalResult, /explicit confirmation and separate global authorization/i)
    const globalPath = join(scope.global, 'opencode.json')
    assert.equal(existsSync(globalPath), false)

    const yesOnlyArgs = {
      action: 'set',
      model: 'anthropic/claude-3.7',
      scope: 'global',
      yes: true,
    } as unknown as Parameters<typeof tool.execute>[0]
    const yesOnlyResult = await tool.execute(yesOnlyArgs, { sessionID: 'root', agent: 'zeus' })
    assert.match(yesOnlyResult, /explicit confirmation and separate global authorization/i)
    assert.equal(existsSync(globalPath), false)

    const globalResult = await tool.execute(
      {
        action: 'set',
        model: 'anthropic/claude-3.7',
        scope: 'global',
        confirm: true,
        authorize_global: true,
      },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(globalResult, /global/i)
    assert.equal(JSON.parse(readFileSync(globalPath, 'utf8')).model, 'anthropic/claude-3.7')

    const deniedGlobalReset = await tool.execute(
      { action: 'reset', scope: 'global', confirm: true },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(deniedGlobalReset, /explicit confirmation and separate global authorization/i)
    assert.equal(JSON.parse(readFileSync(globalPath, 'utf8')).model, 'anthropic/claude-3.7')

    const resetResult = await tool.execute(
      { action: 'reset', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(resetResult, /reset|removed/i)
    const afterReset = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(afterReset.model, undefined)
    assert.equal(afterReset.small_model, undefined)
    assert.equal(afterReset.provider.secretProvider.apiKey, 'do-not-touch')
    assert.equal(afterReset.custom.keep, true)

    const fallbackStatus = await tool.execute(
      { action: 'show' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(fallbackStatus, /model: anthropic\/claude-3\.7/)
    assert.match(fallbackStatus, /model origin: global/)

    const globallyReset = await tool.execute(
      { action: 'reset', scope: 'global', confirm: true, authorize_global: true },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(globallyReset, /global/i)
    assert.equal(JSON.parse(readFileSync(globalPath, 'utf8')).model, undefined)
  } finally {
    rmSync(scope.root, { recursive: true, force: true })
  }

  const absent = makeScope()
  try {
    const tool = command(absent)
    const status = await tool.execute({ action: 'status' }, { sessionID: 'root', agent: 'zeus' })
    assert.match(status, /model: not configured/)
    assert.match(status, /model origin: none/)
    assert.match(status, /small_model: not configured/)
    assert.match(status, /small_model origin: none/)
  } finally {
    rmSync(absent.root, { recursive: true, force: true })
  }

  const invalid = makeScope()
  try {
    const tool = command(invalid)
    const configPath = join(invalid.project, 'opencode.json')
    const original = '{ invalid json\n'
    writeFileSync(configPath, original)
    const result = await tool.execute(
      { action: 'set', model: 'openai/gpt-5.6', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(result, /invalid JSON/i)
    assert.equal(readFileSync(configPath, 'utf8'), original)
    assert.equal(existsSync(`${configPath}.bak`), false)

    writeFileSync(configPath, `${JSON.stringify({ keep: true })}\n`)
    const invalidModel = await tool.execute(
      { action: 'set', model: 'not-a-model', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(invalidModel, /provider\/model/i)
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { keep: true })

    const missingModel = await tool.execute(
      { action: 'set', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(missingModel, /requires --model and\/or --small[-_]model/i)

    mkdirSync(`${configPath}.bak`)
    const beforeWriteFailure = readFileSync(configPath, 'utf8')
    const writeFailure = await tool.execute(
      { action: 'set', model: 'openai/gpt-5.6', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(writeFailure, /failed|preserved/i)
    assert.equal(readFileSync(configPath, 'utf8'), beforeWriteFailure)
  } finally {
    rmSync(invalid.root, { recursive: true, force: true })
  }

  const concurrency = makeScope()
  try {
    const configPath = join(concurrency.project, 'opencode.json')
    writeFileSync(configPath, `${JSON.stringify({ keep: true })}\n`)
    const tool = command(concurrency)
    const [modelResult, smallModelResult] = await Promise.all([
      tool.execute(
        { action: 'set', model: 'openai/gpt-5.6', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      ),
      tool.execute(
        { action: 'set', small_model: 'openai/gpt-5.6-mini', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      ),
    ])
    assert.match(modelResult, /updated/i)
    assert.match(smallModelResult, /updated/i)
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      keep: true,
      model: 'openai/gpt-5.6',
      small_model: 'openai/gpt-5.6-mini',
    })
  } finally {
    rmSync(concurrency.root, { recursive: true, force: true })
  }

  const symlinkedTarget = makeScope()
  try {
    const realConfigPath = join(symlinkedTarget.root, 'real-opencode.json')
    const configPath = join(symlinkedTarget.project, 'opencode.json')
    writeFileSync(realConfigPath, `${JSON.stringify({ keep: true })}\n`)
    symlinkSync(realConfigPath, configPath)
    const result = await command(symlinkedTarget).execute(
      { action: 'set', model: 'openai/gpt-5.6', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(result, /failed|symlink/i)
    assert.equal(lstatSync(configPath).isSymbolicLink(), true)
    assert.equal(JSON.parse(readFileSync(realConfigPath, 'utf8')).model, undefined)
  } finally {
    rmSync(symlinkedTarget.root, { recursive: true, force: true })
  }

  const protectedFiles = makeScope()
  try {
    const configPath = join(protectedFiles.project, 'opencode.json')
    const backupPath = `${configPath}.bak`
    const backupTarget = join(protectedFiles.root, 'backup-target.json')
    writeFileSync(configPath, `${JSON.stringify({ keep: true })}\n`)
    writeFileSync(backupTarget, 'must remain untouched\n')
    symlinkSync(backupTarget, backupPath)
    const before = readFileSync(configPath, 'utf8')
    const result = await command(protectedFiles).execute(
      { action: 'set', model: 'openai/gpt-5.6', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.match(result, /failed|symlink/i)
    assert.equal(readFileSync(configPath, 'utf8'), before)
    assert.equal(readFileSync(backupTarget, 'utf8'), 'must remain untouched\n')
  } finally {
    rmSync(protectedFiles.root, { recursive: true, force: true })
  }

  const permissions = makeScope()
  try {
    const configPath = join(permissions.project, 'opencode.json')
    writeFileSync(configPath, `${JSON.stringify({ keep: true })}\n`, { mode: 0o640 })
    chmodSync(configPath, 0o640)
    const tool = command(permissions)
    await tool.execute(
      { action: 'set', model: 'openai/gpt-5.6', scope: 'project' },
      { sessionID: 'root', agent: 'zeus' },
    )
    assert.equal(statSync(configPath).mode & 0o7777, 0o640)
    assert.equal(statSync(`${configPath}.bak`).mode & 0o7777, 0o600)
    assert.equal(
      readdirSync(permissions.project).some((entry) => entry.includes('.tmp-')),
      false,
    )

    const newScope = makeScope()
    try {
      const newPath = join(newScope.project, 'opencode.json')
      await command(newScope).execute(
        { action: 'set', model: 'openai/gpt-5.6', scope: 'project' },
        { sessionID: 'root', agent: 'zeus' },
      )
      assert.equal(statSync(newPath).mode & 0o7777, 0o600)
    } finally {
      rmSync(newScope.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(permissions.root, { recursive: true, force: true })
  }

  console.log('✅ model command: all tests passed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
