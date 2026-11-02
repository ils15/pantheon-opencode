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

test('the plugin export loads from a clean production-only consumer', () => {
  const work = mkdtempSync(join(tmpdir(), 'pantheon-consumer-'))
  const consumer = join(work, 'consumer')
  const loader = join(consumer, 'load-plugins.ts')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'pack-check', private: true })}\n`,
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
    // 2.0 renamed the plugin: `./plugin` (src/plugin.ts) is the canonical
    // export; `./plugin-v2` remains as a DEPRECATED alias to the same file so
    // configs written before the rename keep loading (removed in 2.1).
    assert.equal(installedManifest.exports['./plugin'], './src/plugin.ts')
    assert.equal(installedManifest.exports['./plugin-v2'], './src/plugin.ts')

    const consumerLock = readJson(join(consumer, 'package-lock.json'))
    const runtimePlugin = consumerLock.packages['node_modules/@opencode-ai/plugin']
    assert.ok(runtimePlugin, 'V2 runtime dependency must be installed')
    assert.equal(runtimePlugin.dev, undefined, 'V2 runtime dependency must not be dev-only')

    writeFileSync(
      loader,
      [
        // No top-level await: tsx compiles this .ts as CJS for the consumer.
        'async function main() {',
        "  const plugin = (await import('pantheon-opencode/plugin')).default",
        "  if (plugin.id !== 'pantheon-opencode') throw new Error('invalid default export')",
        "  if (typeof plugin.setup !== 'function') throw new Error('setup is not callable')",
        "  const alias = (await import('pantheon-opencode/plugin-v2')).default",
        "  if (alias !== plugin) throw new Error('the deprecated ./plugin-v2 alias must load the same plugin')",
        "  console.log('canonical ./plugin loaded; deprecated ./plugin-v2 alias resolves to it')",
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
