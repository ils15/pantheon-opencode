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
    `${JSON.stringify({ name: 'v2-pack-check', private: true })}\n`,
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
    assert.equal(
      installedManifest.dependencies['@opencode-ai/plugin'],
      readJson(join(ROOT, 'package.json')).dependencies['@opencode-ai/plugin'],
    )
    assert.equal(installedManifest.devDependencies?.['@opencode-ai/plugin'], undefined)
    // 2.0 removed the V1 generation: the `./plugin` export (src/plugin.ts) is
    // gone from the manifest, `./plugin-v2` is the only plugin export.
    assert.equal(installedManifest.exports['./plugin'], undefined)
    assert.equal(installedManifest.exports['./plugin-v2'], './src/plugin-v2.ts')

    const consumerLock = readJson(join(consumer, 'package-lock.json'))
    const runtimePlugin = consumerLock.packages['node_modules/@opencode-ai/plugin']
    assert.ok(runtimePlugin, 'V2 runtime dependency must be installed')
    assert.equal(runtimePlugin.dev, undefined, 'V2 runtime dependency must not be dev-only')

    writeFileSync(
      loader,
      [
        // No top-level await: tsx compiles this .ts as CJS for the consumer.
        'async function main() {',
        '  let v1Export = null',
        '  try {',
        "    v1Export = (await import('pantheon-opencode/plugin')).default",
        '  } catch (err) {',
        "    if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw err",
        '  }',
        "  if (v1Export !== null) throw new Error('the V1 ./plugin export must be gone in 2.0')",
        "  const v2Plugin = (await import('pantheon-opencode/plugin-v2')).default",
        "  if (v2Plugin.id !== 'pantheon-opencode-v2') throw new Error('invalid V2 default export')",
        "  if (typeof v2Plugin.setup !== 'function') throw new Error('V2 setup is not callable')",
        "  console.log('V2 export loaded; V1 export absent')",
        '}',
        'main()',
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
