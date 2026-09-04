/**
 * PWD must be scoped to the stdio transport of the resource and persistence
 * servers. This checks every generated platform/server entry, rather than
 * checking only one hand-picked config file.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMcpEntry, MCPS, PLATFORMS } from '../scripts/install-mcp.mjs'

const PWD_SERVERS = new Set(['pantheon-resources', 'pantheon-persistence'])
const PWD_REFERENCE = ['$', '{PWD}'].join('')

// The production catalog uses OpenCode's `local` spelling. Keep this fixture
// test-only so the PWD contract is exercised against real Pantheon server
// commands without adding a fake transport or MCP to the production catalog.
const STDIO_FIXTURE = Object.fromEntries(
  ['pantheon-resources', 'pantheon-persistence', 'pantheon-memory'].map((mcpKey) => {
    const mcp = MCPS[mcpKey]
    return [
      mcpKey,
      {
        ...mcp,
        env: ['PWD'],
        platforms: {
          opencode: { ...mcp.platforms.opencode, type: 'stdio', env: ['PWD'] },
        },
      },
    ]
  }),
)

function containsPwd(value) {
  if (Array.isArray(value)) return value.some(containsPwd)
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => key === 'PWD' || containsPwd(entry))
  }
  return value === 'PWD' || value === `\${PWD}`
}

test('every MCP keeps env as an array', () => {
  for (const mcp of Object.values(MCPS)) {
    assert.ok(Array.isArray(mcp.env))
    for (const platform of Object.values(mcp.platforms)) {
      if (platform.env !== undefined) assert.ok(Array.isArray(platform.env))
    }
  }
})

test('all generated entries scope PWD exclusively to approved stdio servers', () => {
  const originalPwd = process.env.PWD
  try {
    for (const pwd of ['/tmp/pantheon-test', undefined]) {
      if (pwd === undefined) delete process.env.PWD
      else process.env.PWD = pwd

      for (const [mcpKey, mcp] of Object.entries(MCPS)) {
        for (const platformName of Object.keys(PLATFORMS)) {
          const platform = mcp.platforms[platformName]
          if (!platform) continue

          const entry = buildMcpEntry(mcpKey, platformName)
          assert.ok(entry, `entry should be generated for ${mcpKey}/${platformName}`)
          const hasPwd = containsPwd(entry)
          const isApproved = PWD_SERVERS.has(mcpKey) && platform.type === 'stdio'

          assert.equal(
            hasPwd,
            isApproved && pwd !== undefined,
            `PWD scope violation in ${mcpKey}/${platformName} with PWD ${pwd ? 'present' : 'absent'}`,
          )
        }
      }
    }
  } finally {
    if (originalPwd === undefined) delete process.env.PWD
    else process.env.PWD = originalPwd
  }
})

test('real Pantheon stdio fixture receives PWD only for approved servers', () => {
  const originalPwd = process.env.PWD
  process.env.PWD = '/tmp/pantheon-test'
  try {
    for (const mcpKey of Object.keys(STDIO_FIXTURE)) {
      const entry = buildMcpEntry(mcpKey, 'opencode', STDIO_FIXTURE)
      assert.equal(entry.type, 'stdio')
      assert.equal(entry.command[1].endsWith('.py'), true)
      if (PWD_SERVERS.has(mcpKey)) assert.deepEqual(entry.environment, { PWD: PWD_REFERENCE })
      else assert.equal(containsPwd(entry), false)
    }
  } finally {
    if (originalPwd === undefined) delete process.env.PWD
    else process.env.PWD = originalPwd
  }
})

test('GitHub and every non-stdio configuration never contains PWD', () => {
  for (const [mcpKey, mcp] of Object.entries(MCPS)) {
    for (const [platformName, platform] of Object.entries(mcp.platforms)) {
      const entry = buildMcpEntry(mcpKey, platformName)
      assert.ok(entry, `entry should be generated for ${mcpKey}/${platformName}`)
      if (mcpKey === 'github' || platform.type !== 'stdio') {
        assert.equal(containsPwd(entry), false, `${mcpKey}/${platformName} must not contain PWD`)
      }
    }
  }
})
