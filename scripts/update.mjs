import { spawnSync as nodeSpawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertNoSymlinkAncestors } from './install/verify.mjs'

function parseVersion(version) {
  const match = String(version)
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/)
  if (!match) return null
  return {
    core: [+match[1], +match[2], +match[3]],
    beta: match[4] === undefined ? Number.POSITIVE_INFINITY : +match[4],
  }
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  }
  return a.beta - b.beta
}

/** Update only the authorized global installation, then refresh its config. */
export function runUpdate(
  args,
  {
    root,
    currentVersion,
    runningScript = process.argv[1],
    execPath = process.execPath,
    spawnSync = nodeSpawnSync,
    refresh,
  },
) {
  const channel = args.includes('--stable') ? 'latest' : 'beta'
  const globalRootResult = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  let globalPackageRoot = null
  let runningPackageRoot = null
  let runningScriptPath = null
  try {
    const npmGlobalRoot = (globalRootResult.stdout || '').trim()
    if (globalRootResult.status === 0 && npmGlobalRoot) {
      // Check the lexical npm root before realpath: a linked ancestor can make
      // a workspace path look identical to an actual global package after
      // canonicalization.
      assertNoSymlinkAncestors(npmGlobalRoot)
      const actualGlobalRoot = fs.realpathSync(npmGlobalRoot)
      const installedEntry = path.join(actualGlobalRoot, 'pantheon-opencode')
      const installedEntryStat = fs.lstatSync(installedEntry)
      const runningRootStat = fs.lstatSync(path.resolve(root))
      const runningScriptStat = fs.lstatSync(path.resolve(runningScript))
      // A global npm link into a checkout resolves to the same realpath as the
      // running source. Do not treat that provenance as a global installation.
      if (
        installedEntryStat.isSymbolicLink() ||
        !installedEntryStat.isDirectory() ||
        runningRootStat.isSymbolicLink() ||
        !runningRootStat.isDirectory() ||
        runningScriptStat.isSymbolicLink() ||
        !runningScriptStat.isFile()
      ) {
        throw new Error('Global package identity is not a regular installed package')
      }
      globalPackageRoot = fs.realpathSync(installedEntry)
      runningPackageRoot = fs.realpathSync(path.resolve(root))
      runningScriptPath = fs.realpathSync(path.resolve(runningScript))
    }
  } catch {
    // Missing, linked, or uncertain package identity is not authorized.
  }
  if (
    !globalPackageRoot ||
    path.resolve(root) !== globalPackageRoot ||
    globalPackageRoot !== runningPackageRoot ||
    runningScriptPath !== path.join(globalPackageRoot, 'bin', 'pantheon-init.mjs')
  ) {
    console.error(
      '❌ update is available only from the global Pantheon installation; local, workspace, and npx copies are refused. ' +
        'Install globally with `npm install -g pantheon-opencode@beta`, then run `pantheon-opencode update`.',
    )
    return 1
  }

  console.log(`Pantheon OpenCode v${currentVersion} — checking the "${channel}" channel...`)
  const view = spawnSync('npm', ['view', `pantheon-opencode@${channel}`, 'version'], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  const latest = (view.stdout || '').trim().split('\n').filter(Boolean).pop()
  if (view.status !== 0 || !latest) {
    console.error(
      `❌ Could not reach the npm registry: ${(view.stderr || view.stdout || '').trim() || 'no version returned'}`,
    )
    return 1
  }

  if (compareVersions(latest, currentVersion) <= 0) {
    console.log(
      `✅ Already up to date (installed v${currentVersion}; ${channel} channel: v${latest}).`,
    )
    return 0
  }

  console.log(`Updating v${currentVersion} → v${latest} (channel: ${channel})...`)
  const install = spawnSync('npm', ['install', '-g', `pantheon-opencode@${channel}`], {
    stdio: 'inherit',
  })
  if (install.status !== 0) {
    console.error(
      '❌ npm install failed; npm global replacement is not atomic and may have partially changed the package. ' +
        'Verify the global install with `pantheon-opencode --version` or reinstall the package.',
    )
    return install.status ?? 1
  }

  let refreshedPackageRoot = null
  let refreshedVersion = null
  try {
    const refreshedRootResult = spawnSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    if (refreshedRootResult.status === 0) {
      const refreshedGlobalRoot = fs.realpathSync((refreshedRootResult.stdout || '').trim())
      const refreshedEntry = path.join(refreshedGlobalRoot, 'pantheon-opencode')
      const refreshedEntryStat = fs.lstatSync(refreshedEntry)
      if (refreshedEntryStat.isSymbolicLink() || !refreshedEntryStat.isDirectory()) {
        throw new Error('Refreshed global package identity is not a regular installed package')
      }
      refreshedPackageRoot = fs.realpathSync(refreshedEntry)
      refreshedVersion = JSON.parse(
        fs.readFileSync(path.join(refreshedPackageRoot, 'package.json'), 'utf8'),
      ).version
    }
  } catch {
    // The post-install check reports an incomplete package refresh.
  }
  if (refreshedVersion !== latest || !refreshedPackageRoot) {
    console.error(
      `❌ npm reported success, but the global package is v${refreshedVersion ?? 'unknown'} (expected v${latest}); config refresh was not run.`,
    )
    return 1
  }

  const globalEntry = path.join(refreshedPackageRoot, 'bin', 'pantheon-init.mjs')
  const init = refresh
    ? refresh(globalEntry)
    : spawnSync(execPath, [globalEntry, 'init', '--yes', '--headless'], { stdio: 'inherit' })
  if (init.status !== 0 || init.error) {
    console.error(
      '⚠️  Updated, but the config refresh did not complete — run `npx pantheon-opencode init` manually.',
    )
    return init.status ?? 1
  }
  console.log(`✅ Updated to v${latest}.`)
  return 0
}
