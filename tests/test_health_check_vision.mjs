/** Runtime health-check contract for the canonical Pantheon Vision installer. */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { healthCheck } from '../scripts/install/health-check.mjs'

const target = mkdtempSync(join(tmpdir(), 'pantheon-health-'))
const scripts = join(target, 'scripts')
mkdirSync(scripts, { recursive: true })

try {
  for (const name of [
    'mcp_persistence_server.py',
    'mcp_resources_server.py',
    'code_mode_server.py',
    'memory_mcp_server.py',
    'pantheon_vision_server.py',
  ]) {
    writeFileSync(join(scripts, name), 'print("ok")\n')
  }
  writeFileSync(join(scripts, '_pantheon_paths.py'), 'def pantheon_home():\n    return "/tmp"\n')
  writeFileSync(
    join(target, 'requirements-vision.txt'),
    'mcp>=1.28.0\nfastmcp>=3.4.0\nhttpx>=0.27.0\n',
  )

  const result = healthCheck(target)
  const passed = new Set(result.passed.map(({ check }) => check))
  assert.equal(
    result.failed.some(({ check }) => check === 'requirements-vision.txt'),
    false,
  )
  assert.equal(passed.has('scripts/pantheon_vision_server.py'), true)
  assert.equal(passed.has('requirements-vision.txt'), true)
  assert.equal(passed.has('syntax:pantheon_vision_server.py'), true)
} finally {
  rmSync(target, { recursive: true, force: true })
}

console.log('✅ Pantheon Vision health-check contract passed')
