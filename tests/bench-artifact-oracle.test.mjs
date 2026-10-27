import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { assessScenarioArtifact } = await import('../bench/lib/artifact-oracle.mjs')

function withRunDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'bench-artifact-oracle-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const GOOD_TABLE = `| Posição | País | População estimada |
|---:|---|---:|
| 1 | Índia | 1.463.000.000 |
| 2 | China | 1.416.000.000 |
| 3 | Estados Unidos | 347.000.000 |
`

test('scenario B requires a regular markdown population table with the expected three countries', () => {
  withRunDir((runDir) => {
    writeFileSync(join(runDir, 'bench-run-B.md'), GOOD_TABLE)
    assert.deepEqual(assessScenarioArtifact({ scenario: 'B', runDir }), {
      status: 'ok',
      artifact: 'bench-run-B.md',
      bytes: Buffer.byteLength(GOOD_TABLE),
      checks: { markdownTable: true, populationColumn: true, topThreeCountries: 3 },
    })
  })
})

test('missing and incomplete artifacts fail the task oracle', () => {
  withRunDir((runDir) => {
    assert.equal(assessScenarioArtifact({ scenario: 'B', runDir }).status, 'failed')
    writeFileSync(
      join(runDir, 'bench-run-B.md'),
      '| País | População |\n|---|---|\n| Índia | 1 |\n',
    )
    const result = assessScenarioArtifact({ scenario: 'B', runDir })
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.checks, {
      markdownTable: false,
      populationColumn: true,
      topThreeCountries: 1,
    })
  })
})

test('custom prompts and other scenarios are unavailable rather than misjudged', () => {
  withRunDir((runDir) => {
    assert.equal(
      assessScenarioArtifact({ scenario: 'B', runDir, customPrompt: true }).status,
      'unavailable',
    )
    assert.equal(assessScenarioArtifact({ scenario: 'A', runDir }).status, 'unavailable')
  })
})

test('artifact oracle rejects symlinks instead of reading outside the run directory', () => {
  withRunDir((runDir) => {
    const outside = join(runDir, 'outside.md')
    writeFileSync(outside, GOOD_TABLE)
    symlinkSync(outside, join(runDir, 'bench-run-B.md'))
    const result = assessScenarioArtifact({ scenario: 'B', runDir })
    assert.equal(result.status, 'failed')
    assert.match(result.reason, /regular file/i)
  })
})
