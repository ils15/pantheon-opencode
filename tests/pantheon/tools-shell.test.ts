import { strict as assert } from 'node:assert'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createShellTool } from '../../src/pantheon/tools.ts'

describe('createShellTool', () => {
  it('executes command in the explicit context directory', async () => {
    const rawDir = mkdtempSync(join(tmpdir(), 'shell-ctx-'))
    const dir = realpathSync(rawDir)
    try {
      const tool = createShellTool()
      const res = await tool.execute({ command: 'pwd' }, { directory: dir })
      assert.equal(res.ok, true)
      assert.equal(String(res.output).trim(), dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to fallbackDir when context directory is omitted', async () => {
    const rawDir = mkdtempSync(join(tmpdir(), 'shell-fallback-'))
    const dir = realpathSync(rawDir)
    try {
      const tool = createShellTool(dir)
      const res = await tool.execute({ command: 'pwd' }, {})
      assert.equal(res.ok, true)
      assert.equal(String(res.output).trim(), dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects empty command', async () => {
    const tool = createShellTool()
    const res = await tool.execute({ command: '   ' }, {})
    assert.equal(res.ok, false)
    assert.match(String(res.error), /Command cannot be empty/)
  })

  it('returns failure output on command error', async () => {
    const tool = createShellTool()
    const res = await tool.execute({ command: 'non_existent_command_12345' }, {})
    assert.equal(res.ok, false)
    assert.match(String(res.output), /not found|127/)
  })
})
