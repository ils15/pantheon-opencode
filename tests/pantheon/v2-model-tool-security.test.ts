import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createV2ToolDefinitions } from '../../src/pantheon/v2-tools.ts'

async function main(): Promise<void> {
  const originalCwd = process.cwd()
  const originalHome = process.env.HOME
  const originalXdg = process.env.XDG_CONFIG_HOME
  const root = mkdtempSync(join(tmpdir(), 'pantheon-v2-model-security-'))
  try {
    const projectFile = join(root, '.pantheon', 'active-preset.json')
    const globalFile = join(root, 'xdg', 'opencode', '.pantheon', 'active-preset.json')
    mkdirSync(join(root, '.pantheon'), { recursive: true })
    mkdirSync(join(root, 'xdg', 'opencode', '.pantheon'), { recursive: true })
    const projectContent = JSON.stringify({
      version: 1,
      preset: 'keep-project-marker',
      overrides: { agents: { hermes: { model: 'openai/gpt-5.6' } } },
    })
    const globalContent = JSON.stringify({
      version: 1,
      preset: 'keep-global-marker',
      overrides: { agents: { hermes: { model: 'anthropic/claude-sonnet-4-6' } } },
    })
    writeFileSync(projectFile, projectContent)
    writeFileSync(globalFile, globalContent)
    process.chdir(root)
    process.env.HOME = join(root, 'home')
    process.env.XDG_CONFIG_HOME = join(root, 'xdg')

    const modelTool = createV2ToolDefinitions().find((tool) => tool.name === 'pantheon_model')
    assert.ok(modelTool)
    const snapshot = () => [readFileSync(projectFile, 'utf8'), readFileSync(globalFile, 'utf8')]
    const before = snapshot()

    const status = await modelTool.execute({ action: 'status' }, {})
    assert.match(status.output, /project only/i)
    assert.match(status.output, /openai\/gpt-5\.6/)
    assert.doesNotMatch(status.output, /anthropic\/claude-sonnet-4-6/)

    const globalSet = await modelTool.execute(
      {
        action: 'set',
        agent: 'hermes',
        model: 'openai/gpt-5.6',
        scope: 'global',
        confirm: true,
        authorize_global: true,
      },
      {},
    )
    assert.match(globalSet.output, /project-only/i)
    assert.deepEqual(snapshot(), before, 'global set must not change project or global files')

    const globalReset = await modelTool.execute(
      {
        action: 'reset',
        agent: 'hermes',
        scope: 'global',
        confirm: true,
        authorize_global: true,
      },
      {},
    )
    assert.match(globalReset.output, /project-only/i)
    assert.deepEqual(snapshot(), before, 'global reset must not change project or global files')

    const explicitConfirmation = await modelTool.execute(
      {
        action: 'set',
        agent: 'hermes',
        model: 'openai/gpt-5.6',
        scope: 'project',
        confirm: true,
      },
      {},
    )
    assert.match(
      explicitConfirmation.output,
      /does not accept authorization flags; global authorization is not supported/i,
    )
    assert.deepEqual(snapshot(), before, 'authorization flags must be rejected before writing')

    const explicitGlobalAuthorization = await modelTool.execute(
      {
        action: 'reset',
        agent: 'hermes',
        scope: 'project',
        authorize_global: true,
      },
      {},
    )
    assert.match(
      explicitGlobalAuthorization.output,
      /does not accept authorization flags; global authorization is not supported by this tool/i,
    )
    assert.deepEqual(snapshot(), before, 'global authorization must be rejected before writing')
    const statusAfterRejectedCalls = await modelTool.execute({ action: 'status' }, {})
    assert.match(statusAfterRejectedCalls.output, /hermes: openai\/gpt-5\.6 \(origin: override/i)
    assert.doesNotMatch(statusAfterRejectedCalls.output, /anthropic\/claude-sonnet-4-6/)

    console.log(
      '✅ V2 model tool is project-only and rejects global scope/authorization without writes',
    )
  } finally {
    process.chdir(originalCwd)
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalXdg
    rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
