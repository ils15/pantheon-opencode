import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { parseTargetLcov, passesLineThreshold } from '../../scripts/check-plugin-coverage.mjs'

const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname)
const TARGET = resolve(REPO_ROOT, 'src/plugin.ts')

function makeRecord({
  sf = 'src/plugin.ts',
  da = [[1, 1]],
  lf = da.length,
  lh = da.filter(([, count]) => Number(count) > 0).length,
  branch = [0, 0],
  functions = [0, 0],
} = {}) {
  return [
    'TN:',
    `SF:${sf}`,
    ...da.map(([line, count]) => `DA:${line},${count}`),
    `LF:${lf}`,
    `LH:${lh}`,
    `BRF:${branch[0]}`,
    `BRH:${branch[1]}`,
    `FNF:${functions[0]}`,
    `FNH:${functions[1]}`,
    'end_of_record',
  ].join('\n')
}

function parse(text) {
  return parseTargetLcov(text, REPO_ROOT, TARGET)
}

test('parses exactly the target source and keeps branches/functions informational', () => {
  const coverage = parse(
    makeRecord({
      da: [
        [10, 1],
        [20, 0],
        [30, 3],
      ],
      branch: [4, 2],
      functions: [3, 1],
    }),
  )

  assert.equal(coverage.sourcePath, TARGET)
  assert.deepEqual(coverage.lines, { hit: 2, found: 3 })
  assert.deepEqual(coverage.branches, { hit: 2, found: 4 })
  assert.deepEqual(coverage.functions, { hit: 1, found: 3 })
})

test('fails when the target source is missing or resolves to another path', () => {
  assert.throws(() => parse(makeRecord({ sf: 'src/not-plugin.ts' })), /found 0 LCOV records/i)
  assert.throws(
    () => parse(makeRecord({ sf: '/tmp/not-the-repo/src/plugin.ts' })),
    /found 0 LCOV records/i,
  )
})

test('fails when more than one LCOV record resolves to the target', () => {
  const record = makeRecord()
  assert.throws(() => parse(`${record}\n${record}`), /found 2 LCOV records/i)
})

test('fails when a target LCOV record contains multiple SF entries', () => {
  const record = makeRecord().replace(
    'SF:src/plugin.ts',
    'SF:src/plugin.ts\nSF:src/plugin.ts',
  )
  assert.throws(() => parse(record), /exactly one SF entry/i)
})

test('fails when LF is smaller than the number of unique DA records', () => {
  assert.throws(
    () =>
      parse(
        makeRecord({
          da: [
            [1, 1],
            [2, 0],
          ],
          lf: 1,
        }),
      ),
    /LF 1.*less than 2 unique DA/i,
  )
})

test('uses Node 26 LCOV aggregate totals when source-mapped DA records omit lines', () => {
  const coverage = parse(
    makeRecord({
      da: [
        [1, 1],
        [3, 0],
      ],
      lf: 3,
      lh: 2,
    }),
  )
  assert.deepEqual(coverage.lines, { hit: 2, found: 3 })
})

test('rejects malformed, negative, and fractional DA counts', () => {
  for (const count of ['nope', '-1', '0.5']) {
    const record = makeRecord().replace('DA:1,1', `DA:1,${count}`)
    assert.throws(() => parse(record), /DA count.*non-negative integer/i, `count=${count}`)
  }
})

test('requires unique positive integer DA line numbers', () => {
  assert.throws(() => parse(makeRecord({ da: [[0, 1]] })), /DA line number.*positive integer/i)
  assert.throws(
    () =>
      parse(
        makeRecord({
          da: [
            [3, 1],
            [3, 0],
          ],
        }),
      ),
    /duplicate DA line number 3/i,
  )
})

test('rejects a zero LF denominator', () => {
  assert.throws(() => parse(makeRecord({ da: [], lf: 0, lh: 0 })), /LF must be a positive integer/i)
})

test('fails when LH disagrees with positive DA counts', () => {
  assert.throws(
    () =>
      parse(
        makeRecord({
          da: [
            [1, 1],
            [2, 0],
          ],
          lh: 0,
        }),
      ),
    /LH 0.*less than 1 covered DA/i,
  )
})

test('accepts zero hits as valid uncovered data but fails the threshold', () => {
  const coverage = parse(makeRecord({ da: [[1, 0]], lf: 1, lh: 0 }))
  assert.deepEqual(coverage.lines, { hit: 0, found: 1 })
  assert.equal(passesLineThreshold(coverage), false)
})

test('fails the 80 percent line gate below threshold', () => {
  const coverage = parse(
    makeRecord({
      da: [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 0],
      ],
      lf: 4,
      lh: 3,
    }),
  )
  assert.equal(passesLineThreshold(coverage), false)
})

test('passes the exact 80 percent line threshold', () => {
  const coverage = parse(
    makeRecord({
      da: [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
        [5, 0],
      ],
      lf: 5,
      lh: 4,
    }),
  )
  assert.equal(passesLineThreshold(coverage), true)
})
