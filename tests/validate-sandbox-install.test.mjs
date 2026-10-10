import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  SANDBOX_SOURCE_FILES,
  validateSandboxInstall,
} from '../scripts/validate-sandbox-install.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-proof-'))
  const repo = join(root, 'repo')
  const install = join(root, 'home', '.npm-global', 'lib', 'node_modules', 'pantheon-opencode')
  const config = join(root, 'project-v2', 'opencode.json')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(install, 'src'), { recursive: true })
  mkdirSync(join(root, 'project-v2'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '1.6.0-beta.6' }))
  writeFileSync(join(install, 'package.json'), JSON.stringify({ version: '1.6.0-beta.6' }))
  for (const file of SANDBOX_SOURCE_FILES) {
    mkdirSync(join(repo, file, '..'), { recursive: true })
    mkdirSync(join(install, file, '..'), { recursive: true })
    writeFileSync(join(repo, file), `current ${file}\n`)
    writeFileSync(join(install, file), `current ${file}\n`)
  }
  writeFileSync(config, JSON.stringify({ plugins: [join(install, 'src', 'plugin-v2')] }))
  return { root, repo, install, config }
}

test('sandbox install proof checks package version, plugin source, and active project config', () => {
  const paths = fixture()
  try {
    assert.equal(
      validateSandboxInstall({
        repoDir: paths.repo,
        installDir: paths.install,
        projectConfig: paths.config,
      }).status,
      'PASS',
    )
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('sandbox install proof rejects a stale npm package ref even when the package is current', () => {
  const paths = fixture()
  try {
    writeFileSync(
      paths.config,
      JSON.stringify({
        plugins: ['pantheon-opencode@1.6.0-beta.7', join(paths.install, 'src', 'plugin-v2')],
      }),
    )
    assert.throws(
      () =>
        validateSandboxInstall({
          repoDir: paths.repo,
          installDir: paths.install,
          projectConfig: paths.config,
        }),
      /stale Pantheon package reference.*pantheon-opencode@1\.6\.0-beta\.7/,
    )
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('sandbox install proof rejects a same-version package with stale installer source', () => {
  const paths = fixture()
  try {
    writeFileSync(join(paths.install, 'scripts/install/opencode.mjs'), 'stale installer source\n')
    assert.throws(
      () =>
        validateSandboxInstall({
          repoDir: paths.repo,
          installDir: paths.install,
          projectConfig: paths.config,
        }),
      /installed package source differs from checkout: scripts\/install\/opencode\.mjs/,
    )
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})
