import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('V2 export loads from a clean production-only consumer', () => {
  const work = mkdtempSync(join(tmpdir(), 'pantheon-v2-consumer-'))
  const consumer = join(work, 'consumer')
  const loader = join(consumer, 'load-plugins.ts')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'v2-pack-check', private: true }) + '\n',
  )

  try {
    const packOutput = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', work],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )
    const tarball = join(work, readJsonFromPack(packOutput).filename)

    execFileSync(
      'npm',
      [
        'install',
        '--prefix',
        consumer,
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarball,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )

    const installedRoot = join(consumer, 'node_modules', 'pantheon-opencode')
    const installedManifest = readJson(join(installedRoot, 'package.json'))
    assert.equal(installedManifest.type, 'module')
    assert.equal(installedManifest.dependencies['@opencode-ai/plugin'], '1.18.18')
    assert.equal(installedManifest.devDependencies?.['@opencode-ai/plugin'], undefined)
    assert.equal(installedManifest.exports['./plugin'], './src/plugin.ts')
    assert.equal(installedManifest.exports['./plugin-v2'], './src/plugin-v2.ts')

    const consumerLock = readJson(join(consumer, 'package-lock.json'))
    const runtimePlugin = consumerLock.packages['node_modules/@opencode-ai/plugin']
    assert.ok(runtimePlugin, 'V2 runtime dependency must be installed')
    assert.equal(runtimePlugin.dev, undefined, 'V2 runtime dependency must not be dev-only')

    writeFileSync(
      loader,
      [
        "import v2Plugin from 'pantheon-opencode/plugin-v2'",
        "import v1Plugin from 'pantheon-opencode/plugin'",
        "if (v2Plugin.id !== 'pantheon-opencode-v2') throw new Error('invalid V2 default export')",
        "if (typeof v2Plugin.setup !== 'function') throw new Error('V2 setup is not callable')",
        "if (typeof v1Plugin !== 'function') throw new Error('V1 export changed')",
        "console.log('V2 and V1 exports loaded')",
        '',
      ].join('\n'),
    )
    execFileSync('npx', ['--yes', '--package=tsx@4.19.4', 'tsx', loader], {
      cwd: consumer,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--conditions=import' },
    })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

function readJsonFromPack(output) {
  const metadata = JSON.parse(output)
  assert.equal(metadata.length, 1)
  return metadata[0]
}
