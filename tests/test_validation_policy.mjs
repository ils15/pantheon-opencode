import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VALIDATION_STATUS,
  classifyDoctorExit,
  classifyTuiExit,
  validationExitCode,
} from '../scripts/validation-policy.mjs'

// Matrix: 0 errors / 7 warnings is a passing global validation.
assert.equal(classifyDoctorExit(0, '7 warnings, 0 errors'), VALIDATION_STATUS.PASS)
assert.equal(classifyDoctorExit(1, '7 warnings, 0 errors found'), VALIDATION_STATUS.WARN)
assert.equal(validationExitCode(VALIDATION_STATUS.PASS, VALIDATION_STATUS.PASS), 0)

// A blocking doctor error remains non-zero, including legacy status 1 output.
assert.equal(classifyDoctorExit(2, '1 errors'), VALIDATION_STATUS.ERROR)
assert.equal(classifyDoctorExit(1, '❌ 1 errors'), VALIDATION_STATUS.ERROR)
assert.equal(validationExitCode(VALIDATION_STATUS.ERROR, VALIDATION_STATUS.PASS), 1)

// TUI failure always blocks; a successful TUI is required for a global PASS.
assert.equal(classifyTuiExit(0), VALIDATION_STATUS.PASS)
assert.equal(classifyTuiExit(1), VALIDATION_STATUS.ERROR)
assert.equal(validationExitCode(VALIDATION_STATUS.PASS, VALIDATION_STATUS.ERROR), 1)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wrapperPath = resolve(repoRoot, 'tests/fixtures/sandbox/run-test.sh')
assert.ok(existsSync(wrapperPath), 'sandbox validation fixture must be present')
const wrapper = readFileSync(wrapperPath, 'utf8')
assert.match(wrapper, /doctor_status/)
assert.match(wrapper, /tui_status/)
assert.match(wrapper, /warnings não bloqueiam/)

console.log('✅ Validation status matrix passed')
