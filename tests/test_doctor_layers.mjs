/** Contract tests for the layered doctor healthcheck (issue #18). */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const doctor = readFileSync('scripts/doctor.mjs', 'utf8')

// Layers required by issue #18 (Config layer = section B, existing)
assert.ok(doctor.includes('function checkVenvLayer'), 'venv/python layer present (F)')
assert.ok(doctor.includes('function checkMcpRuntimeSmoke'), 'MCP runtime smoke layer present (B.6)')
assert.ok(doctor.includes('function mcpInitializeSmoke'), 'JSON-RPC initialize smoke helper present')
assert.ok(doctor.includes('function collectMcpConfigs'), 'shared config collection helper present')

// The B.5 spawn-path layer must be preserved
assert.ok(doctor.includes('Hermetic spawn check'), 'B.5 spawn-path layer preserved')

// JSON-RPC initialize handshake contract (source shape of the payload)
assert.ok(doctor.includes("jsonrpc: '2.0'"), 'jsonrpc 2.0')
assert.ok(doctor.includes("method: 'initialize'"), 'initialize method sent')
assert.ok(doctor.includes('protocolVersion: \'2024-11-05\''), 'protocolVersion 2024-11-05')
assert.ok(
  doctor.includes("clientInfo: { name: 'pantheon-doctor', version: '0.0.0' }"),
  'clientInfo identifies pantheon-doctor',
)
assert.ok(doctor.includes('msg.id === 1'), 'smoke validates the initialize response id')

// Venv layer validates against the exact requirements pins
assert.ok(doctor.includes('requirements-mcp.txt'), 'checks requirements-mcp.txt pins')
assert.ok(doctor.includes('requirements-vision.txt'), 'checks requirements-vision.txt pins')
assert.ok(doctor.includes('parsePipFreeze'), 'pip freeze parser present')
assert.ok(doctor.includes('compareVersions'), 'version comparator present')

// Exit-code contract: critical failures must exit non-zero
assert.ok(doctor.includes('exitCode = 2'), 'errors set exit code 2')

console.log('✅ Doctor layered healthcheck contract passed')
