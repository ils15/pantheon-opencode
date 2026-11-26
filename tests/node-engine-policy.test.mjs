import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  isSupportedNodeVersion,
  REQUIRED_NODE_ENGINE_RANGE,
  validateNodeEnginePolicy,
} from '../scripts/node-engine-policy.mjs'

test('Node runtime support starts at 26.3.0', () => {
  for (const version of [
    '18.20.8',
    '22.22.2',
    '24.15.0',
    '26.0.0',
    '26.2.99',
    '26.3.0-rc.1',
    '27.0.0-rc.1',
  ]) {
    assert.equal(isSupportedNodeVersion(version), false, `${version} must be rejected`)
  }
  for (const version of ['26.3.0', '26.4.0', '26.4.1', '27.0.0', 'v26.3.0']) {
    assert.equal(isSupportedNodeVersion(version), true, `${version} must be accepted`)
  }
})

function writeJson(root, path, value) {
  const file = join(root, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'node-engine-policy-'))
  const rootPackage = {
    name: 'pantheon-opencode',
    version: '1.2.3',
    engines: { node: REQUIRED_NODE_ENGINE_RANGE },
  }
  const tuiPackage = {
    name: 'pantheon-tui',
    version: '1.2.3',
    engines: { node: REQUIRED_NODE_ENGINE_RANGE },
  }
  writeJson(root, 'package.json', rootPackage)
  writeJson(root, 'src/plugins/tui/package.json', tuiPackage)
  writeJson(root, 'package-lock.json', {
    name: rootPackage.name,
    version: rootPackage.version,
    lockfileVersion: 3,
    packages: {
      '': { ...rootPackage },
      'src/plugins/tui': { ...tuiPackage },
    },
  })
  writeJson(root, 'src/plugins/tui/package-lock.json', {
    name: tuiPackage.name,
    version: tuiPackage.version,
    lockfileVersion: 3,
    packages: { '': { ...tuiPackage } },
  })
  return root
}

test('engine policy validates package manifests and both lockfiles', () => {
  const root = makeFixture()
  try {
    assert.deepEqual(validateNodeEnginePolicy(root), [])
    const lockPath = join(root, 'src/plugins/tui/package-lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    lock.packages[''].engines.node = '>=26.0.0'
    writeJson(root, 'src/plugins/tui/package-lock.json', lock)
    assert.match(validateNodeEnginePolicy(root).join('\n'), /src\/plugins\/tui\/package-lock\.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
