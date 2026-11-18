import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentForgeTool } from '../../src/pantheon/agent-forge-tool.ts'

test('pantheon_agent_forge creates, lists, inspects, and removes custom domain specialists while protecting canonical names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-agent-forge-'))
  try {
    const tool = createAgentForgeTool(dir)
    const ctx = { directory: dir }

    // Canonical agent name is protected by default
    const blockedCanonical = JSON.parse(
      (
        await tool.execute(
          {
            action: 'create',
            name: 'hermes',
            description: 'Attempt to overwrite hermes',
          },
          ctx,
        )
      ).output,
    )
    assert.equal(blockedCanonical.ok, false)

    // Create a custom Rust embedded specialist
    const created = JSON.parse(
      (
        await tool.execute(
          {
            action: 'create',
            name: 'rust-embedded',
            description: 'Rust no_std & embedded firmware specialist',
            archetype: 'backend',
            stack: ['Rust', 'embassy', 'probe-rs'],
            testCommand: 'cargo test --lib',
            conventions: ['Forbid unsafe blocks without SAFETY comments'],
          },
          ctx,
        )
      ).output,
    )
    assert.equal(created.ok, true)
    assert.equal(created.path, '.opencode/agents/rust-embedded.md')

    // List custom agents
    const listed = JSON.parse((await tool.execute({ action: 'list' }, ctx)).output)
    assert.equal(listed.ok, true)
    assert.equal(listed.count, 1)
    assert.equal(listed.agents[0].name, 'rust-embedded')

    // Inspect created agent
    const inspected = JSON.parse(
      (await tool.execute({ action: 'inspect', name: 'rust-embedded' }, ctx)).output,
    )
    assert.equal(inspected.ok, true)
    assert.match(inspected.content, /Rust, embassy, probe-rs/)
    assert.match(inspected.content, /Forbid unsafe blocks without SAFETY comments/)

    // Remove custom agent
    const removed = JSON.parse(
      (await tool.execute({ action: 'remove', name: 'rust-embedded' }, ctx)).output,
    )
    assert.equal(removed.ok, true)
    assert.equal(removed.removed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
