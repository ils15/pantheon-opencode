import assert from 'node:assert/strict'
import test from 'node:test'
import {
  executeTestSlice,
  findRepoSliceScript,
  mapFileToSlice,
  resolveTestSlice,
} from '../scripts/test-slice.mjs'

test('Criterion 1: findRepoSliceScript detects repository focused selector (test:quick)', () => {
  const script = findRepoSliceScript()
  assert.ok(script !== null, 'repository should have a focused slice script')
  assert.equal(script.name, 'test:quick')
  assert.equal(script.command, 'npm run test:quick')
})

test('Criterion 1: mapFileToSlice maps source file directly to test slice', () => {
  const slice = mapFileToSlice('src/pantheon/auto-permissions.ts')
  assert.equal(slice.type, 'ts-slice')
  assert.equal(slice.testFile, 'tests/pantheon/auto-permissions.test.ts')
  assert.equal(slice.command, 'npx tsx tests/pantheon/auto-permissions.test.ts')
})

test('Criterion 1: mapFileToSlice recognizes existing test files directly', () => {
  const slice = mapFileToSlice('tests/pantheon/delegation-enforce.test.ts')
  assert.equal(slice.type, 'ts-test')
  assert.equal(slice.command, 'npx tsx tests/pantheon/delegation-enforce.test.ts')

  const pySlice = mapFileToSlice('tests/test_service.py')
  assert.equal(pySlice.type, 'python-test')
  assert.match(pySlice.command, /pytest tests\/test_service\.py/)
})

test('Criterion 2: mapFileToSlice identifies mapping gaps with bounded fallback', () => {
  const gap = mapFileToSlice('src/unknown-orphan-component.ts')
  assert.equal(gap.type, 'mapping-gap')
  assert.equal(gap.command, null)
  assert.match(gap.fallback, /biome check/)
  assert.match(gap.selection, /mapping gap/)
})

test('Criterion 1 & 2: resolveTestSlice uses repo selector when multiple files change', () => {
  const plan = resolveTestSlice(['src/foo.ts', 'src/bar.ts', 'src/baz.ts'])
  assert.equal(plan.type, 'repo-selector')
  assert.equal(plan.command, 'npm run test:quick')
  assert.match(plan.selection, /repo selector: test:quick/)
})

test('Criterion 1: resolveTestSlice targets single file directly for localized edit', () => {
  const plan = resolveTestSlice(['src/pantheon/auto-permissions.ts'])
  assert.equal(plan.type, 'ts-slice')
  assert.equal(plan.command, 'npx tsx tests/pantheon/auto-permissions.test.ts')
})

test('Criterion 3: resolveTestSlice supports failedOnly filter for failure/fix loop', () => {
  const pyPlan = resolveTestSlice(['tests/test_auth.py'], { failedOnly: 'test_token_expiry' })
  assert.equal(pyPlan.type, 'python-test')
  assert.match(pyPlan.command, /pytest tests\/test_auth\.py -k "test_token_expiry"/)

  const nodePlan = resolveTestSlice(['tests/plan-visibility-contract.test.mjs'], {
    failedOnly: 'Athena returns the complete plan',
  })
  assert.equal(nodePlan.type, 'node-test')
  assert.equal(
    nodePlan.command,
    'node --test --test-name-pattern="Athena returns the complete plan" tests/plan-visibility-contract.test.mjs',
  )
})

test('Criterion 4: executeTestSlice formats observable task summary line', () => {
  const mockPlan = {
    command: 'node -e "console.log(\'✔ test passed\')"',
    selection: 'unit slice for mock',
  }
  const receipt = executeTestSlice(mockPlan)
  assert.equal(receipt.status, 'PASS')
  assert.ok(receipt.durationSec !== undefined)
  assert.match(receipt.summaryLine, /^\*\*tests:\*\* \[PASS\] `node -e/)
  assert.match(receipt.summaryLine, /targets: 1/)
  assert.match(receipt.summaryLine, /selection: unit slice for mock/)
})
