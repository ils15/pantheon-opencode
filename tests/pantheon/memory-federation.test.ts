import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { resolveFederatedRepoDirs } from '../../src/pantheon/memory-federation.ts'
import { createNativeMemoryAndPersistenceTools } from '../../src/pantheon/native-memory-tools.ts'

test('multi-repo knowledge federation searches peer memory stores read-only with provenance', async () => {
  const isoHome = mkdtempSync(join(tmpdir(), 'pantheon-fed-home-'))
  const repoA = mkdtempSync(join(tmpdir(), 'pantheon-fed-a-'))
  const repoB = mkdtempSync(join(tmpdir(), 'pantheon-fed-b-'))
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  const prevEnv = process.env.PANTHEON_FEDERATED_REPOS
  try {
    process.env.HOME = isoHome
    process.env.XDG_CONFIG_HOME = join(isoHome, '.config')
    const toolsB = new Map(createNativeMemoryAndPersistenceTools(repoB).map((t) => [t.name, t]))
    const storeB = toolsB.get('memory_store')
    assert.ok(storeB)
    await storeB.execute(
      {
        namespace: 'architecture',
        key: 'fed-rule-jwt',
        value: 'Always rotate asymmetric RS256 signing keys every 30 days',
      },
      { directory: repoB },
    )

    process.env.PANTHEON_FEDERATED_REPOS = repoB
    const peers = resolveFederatedRepoDirs(repoA)
    assert.equal(peers.length, 1)

    const toolsA = new Map(createNativeMemoryAndPersistenceTools(repoA).map((t) => [t.name, t]))
    const searchA = toolsA.get('memory_search')
    const statsA = toolsA.get('memory_stats')
    assert.ok(searchA && statsA)

    const resFed = JSON.parse(
      (await searchA.execute({ query: 'RS256 signing', federated: true }, { directory: repoA }))
        .output,
    ) as {
      ok: boolean
      count: number
      results: Array<{ key: string; sourceRepo?: string }>
    }
    assert.equal(resFed.ok, true)
    assert.equal(resFed.count, 1)
    assert.equal(resFed.results[0]?.key, 'fed-rule-jwt')
    assert.equal(resFed.results[0]?.sourceRepo, basename(repoB))

    const resLocalOnly = JSON.parse(
      (await searchA.execute({ query: 'RS256 signing', federated: false }, { directory: repoA }))
        .output,
    ) as { ok: boolean; count: number }
    assert.equal(resLocalOnly.ok, true)
    assert.equal(resLocalOnly.count, 0)

    const statsOut = JSON.parse((await statsA.execute({}, { directory: repoA })).output) as {
      ok: boolean
      total: number
      federated?: { total: number; repos: Array<{ repo: string; total: number }> }
    }
    assert.equal(statsOut.ok, true)
    assert.equal(statsOut.total, 0)
    assert.equal(statsOut.federated?.total, 1)
    assert.equal(statsOut.federated?.repos[0]?.repo, basename(repoB))
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    if (prevEnv === undefined) delete process.env.PANTHEON_FEDERATED_REPOS
    else process.env.PANTHEON_FEDERATED_REPOS = prevEnv
    rmSync(isoHome, { recursive: true, force: true })
    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
  }
})
