import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  checkCodeModeManifest,
  resolveCodeModeDir,
  validateCodeModeManifest,
} from '../scripts/doctor.mjs'

function fixture(t, entries = 1) {
  const dir = join(tmpdir(), `pantheon-doctor-${process.pid}-${Date.now()}-${Math.random()}`)
  mkdirSync(dir, { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const scripts = {}
  for (let index = 0; index < entries; index += 1) {
    const name = `script-${index}.py`
    const content = `print(${index})\n`
    writeFileSync(join(dir, name), content)
    scripts[name] = createHash('sha256').update(content).digest('hex')
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, scripts }))
  return { dir, scripts }
}

function writeManifest(dir, data) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(data))
}

test('doctor manifest validator exports the required checks', () => {
  assert.equal(typeof checkCodeModeManifest, 'function')
  assert.equal(typeof validateCodeModeManifest, 'function')
})

test('doctor rejects malformed manifest data', () => {
  assert.equal(validateCodeModeManifest('/tmp/code-mode-does-not-exist').ok, false)
})

test('test_doctor_manifest_16_16', (t) => {
  const { dir } = fixture(t, 16)
  assert.deepEqual(validateCodeModeManifest(dir), { ok: true, count: 16, total: 16 })
})

test('test_doctor_manifest_missing_exits_nonzero', (t) => {
  const { dir } = fixture(t)
  rmSync(join(dir, 'manifest.json'))
  assert.equal(validateCodeModeManifest(dir).ok, false)
})

test('test_doctor_manifest_malformed_json_exits_nonzero', (t) => {
  const { dir } = fixture(t)
  writeFileSync(join(dir, 'manifest.json'), '{not json')
  assert.equal(validateCodeModeManifest(dir).ok, false)
})

test('test_doctor_manifest_invalid_version_exits_nonzero', (t) => {
  const { dir, scripts } = fixture(t)
  writeManifest(dir, { version: 2, scripts })
  assert.match(validateCodeModeManifest(dir).message, /version must be 1/)
})

test('test_doctor_manifest_invalid_digest_type_exits_nonzero', (t) => {
  const { dir, scripts } = fixture(t)
  writeManifest(dir, { version: 1, scripts: { 'script-0.py': 42 } })
  assert.match(validateCodeModeManifest(dir).message, /invalid digest/)
})

test('test_doctor_manifest_invalid_digest_length_exits_nonzero', (t) => {
  const { dir } = fixture(t)
  writeManifest(dir, { version: 1, scripts: { 'script-0.py': 'a' } })
  assert.match(validateCodeModeManifest(dir).message, /invalid digest/)
})

test('test_doctor_manifest_mismatch_exits_nonzero', (t) => {
  const { dir, scripts } = fixture(t)
  scripts['script-0.py'] = 'a'.repeat(64)
  writeManifest(dir, { version: 1, scripts })
  assert.match(validateCodeModeManifest(dir).message, /mismatch/)
})

test('test_doctor_manifest_missing_script_exits_nonzero', (t) => {
  const { dir, scripts } = fixture(t)
  scripts['missing.py'] = 'a'.repeat(64)
  writeManifest(dir, { version: 1, scripts })
  assert.match(validateCodeModeManifest(dir).message, /missing\.py/)
})

test('test_doctor_manifest_reports_divergent_names', (t) => {
  const { dir, scripts } = fixture(t)
  scripts['script-0.py'] = 'a'.repeat(64)
  writeManifest(dir, { version: 1, scripts })
  assert.match(validateCodeModeManifest(dir).message, /script-0\.py/)
})

test('test_doctor_manifest_extra_unlisted_script_exits_nonzero', (t) => {
  const { dir, scripts } = fixture(t)
  writeFileSync(join(dir, 'extra.sh'), '#!/bin/sh\n')
  writeManifest(dir, { version: 1, scripts })
  assert.match(validateCodeModeManifest(dir).message, /extra\.sh/)
})

test('test_doctor_manifest_respects_pantheon_project', (t) => {
  const { dir } = fixture(t)
  const project = join(dir, 'project')
  mkdirSync(join(project, '.pantheon', 'code-mode'), { recursive: true })
  writeFileSync(join(project, '.pantheon', 'code-mode', 'manifest.json'), readFileSync(join(dir, 'manifest.json')))
  assert.equal(
    resolveCodeModeDir({ target: '/wrong-target', env: { PANTHEON_PROJECT: project } }),
    join(project, '.pantheon', 'code-mode'),
  )
})
