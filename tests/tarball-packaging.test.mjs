import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  cpSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'

// test:node runs on machines without an OpenCode binary, so the host gate
// could not confirm the generation it writes for. Pin it for this file: every
// install in here targets the only supported host line. Gate-specific tests
// that pass their own env/probe stay deterministic either way.
process.env.OPENCODE_VERSION = 'v2'
const ROOT = process.cwd()
const escapedRoot = ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const forbidden = new RegExp(
  `(?:${escapedRoot}|\\/home\\/|\\/workspace\\/|pantheon[\\\\/]src[\\\\/])`,
  'i',
)
const executableForbidden = new RegExp(
  `(?:${escapedRoot}|\\/home\\/|\\/workspace\\/|pantheon[\\\\/]src[\\\\/])`,
  'i',
)
const privateUrl =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s"]+\.(?:local|internal|corp))(?:[:/]|$)/i

function writableNpmCacheEnv(workDir) {
  const defaultCache = process.env.npm_config_cache || join(homedir(), '.npm')
  try {
    accessSync(defaultCache, fsConstants.W_OK)
    return {}
  } catch {
    return { npm_config_cache: join(workDir, '.npm-cache') }
  }
}

function pack(destination) {
  // Do not bypass prepack: the published archive is the artifact under test.
  // --json emits the full manifest + file listing (>1MB once the tarball
  // carries every runtime input); the default 1MB child buffer would blow
  // up with ENOBUFS, so raise it explicitly. Keep the archive out of the
  // source tree so it cannot race with install-plan source fingerprints.
  // HUSKY=0 prevents prepare from rewriting shared hook files in parallel.
  let result
  try {
    result = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...writableNpmCacheEnv(destination), HUSKY: '0' },
    })
  } catch (error) {
    // prepack aborts with `[DRIFT] …` on stderr. execFileSync keeps only
    // "Command failed: npm pack" in the message, which hides the actionable
    // line; surface both streams so the next drift is diagnosable from the log.
    const stderr = String(error?.stderr ?? '').trim()
    const stdout = String(error?.stdout ?? '').trim()
    error.message = [
      'npm pack failed (see prepack output below)',
      stderr && `--- stderr ---\n${stderr}`,
      stdout && `--- stdout ---\n${stdout}`,
      error.message,
    ]
      .filter(Boolean)
      .join('\n')
    throw error
  }
  return join(destination, firstPackEntry(result).filename)
}

function unpackInstalledPackage(tarball, prefixDir) {
  const installedRoot = join(prefixDir, 'node_modules', 'pantheon-opencode')
  mkdirSync(installedRoot, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', installedRoot, '--strip-components=1'], {
    encoding: 'utf8',
  })
  const runtimeDeps = ['@opencode-ai', 'js-yaml', 'jsonc-parser', 'tiktoken']
  for (const dep of runtimeDeps) {
    const src = join(ROOT, 'node_modules', dep)
    const dst = join(prefixDir, 'node_modules', dep)
    if (existsSync(src) && !existsSync(dst)) {
      cpSync(src, dst, { recursive: true })
    }
  }
  return installedRoot
}

/**
 * Return the first pack entry in `output`. npm emits either an array or an
 * object keyed by package name, and lifecycle scripts (prepack, prepare) append
 * lines such as `npm notice run ...` or `HUSKY=0 skip install` to stdout, so
 * slicing to the end of the output is not parseable.
 */
function firstPackEntry(output) {
  const starts = ['{\n', '[\n']
    .map((needle) => output.indexOf(needle))
    .filter((index) => index >= 0)
  if (starts.length === 0) throw new Error('npm pack did not return JSON metadata')
  const start = Math.min(...starts)
  const closing = { '{': '}', '[': ']' }
  const stack = []
  let inString = false
  let escaped = false
  for (let index = start; index < output.length; index += 1) {
    const character = output[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{' || character === '[') stack.push(closing[character])
    else if (character === '}' || character === ']') {
      if (stack.pop() !== character) throw new Error('npm pack returned unbalanced JSON metadata')
      if (stack.length === 0) {
        const parsed = JSON.parse(output.slice(start, index + 1))
        const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
        if (!entry?.filename) throw new Error('npm pack returned no tarball filename')
        return entry
      }
    }
  }
  throw new Error('npm pack did not return complete JSON metadata')
}

function textFiles(root) {
  const files = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) files.push(...textFiles(path))
    else files.push(path)
  }
  return files
}

// Executable configs npm actually publishes. Kept in sync with the
// `files` allow-list in package.json — no hardcoded opencode.json.
const shippedExecutableConfigs = ['plugin.json', 'src/plugins/tui/package.json']

function assertExecutableConfigIsPathFree(packageRoot) {
  for (const rel of shippedExecutableConfigs) {
    const configPath = join(packageRoot, rel)
    assert.ok(existsSync(configPath), `published executable config is missing: ${rel}`)
    const text = readFileSync(configPath, 'utf8')
    assert.doesNotMatch(text, executableForbidden, `machine path in published ${rel}`)
    assert.doesNotMatch(text, privateUrl, `private URL in published ${rel}`)
    const config = JSON.parse(text)
    if (Array.isArray(config.plugin))
      assert.equal(
        config.plugin.some((entry) => entry.startsWith('/')),
        false,
        `${rel} must be a path-free template (no absolute plugin entries)`,
      )
  }
}

test('tarball contains no machine paths and ships the runtime inputs', () => {
  const work = mkdtempSync(join(tmpdir(), 'pantheon-tarball-'))
  try {
    const tarball = pack(work)
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    assert.doesNotMatch(listing, forbidden)
    assert.doesNotMatch(listing, /(?:^|\/)logs(?:\/|$)|\.log$/i)
    // Python bytecode/build dirs must never ship — the `files` whitelist in
    // package.json carries explicit `!**/__pycache__/**` / `!**/*.pyc`
    // negations because .npmignore is overridden by a files whitelist.
    assert.doesNotMatch(listing, /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/)
    execFileSync('tar', ['-xzf', tarball, '-C', work])
    const packageRoot = join(work, 'package')
    const actualSkills = textFiles(join(packageRoot, 'src', 'skills'))
      .map((file) => relative(packageRoot, file).split('\\').join('/'))
      .filter((file) => /^src\/skills\/[^/]+\/SKILL\.md$/.test(file))
      .sort()
    const skillLock = JSON.parse(readFileSync(join(packageRoot, 'skills-lock.json'), 'utf8'))
    const expectedSkills = Object.keys(skillLock)
      .filter((file) => /^src\/skills\/[^/]+\/SKILL\.md$/.test(file))
      .sort()
    assert.deepEqual(
      actualSkills,
      expectedSkills,
      'tarball must ship the canonical skill inventory',
    )

    const pluginMetadata = JSON.parse(readFileSync(join(packageRoot, 'plugin.json'), 'utf8'))
    const declaredSkillCount = /\b(\d+) skills\b/i.exec(pluginMetadata.description)?.[1]
    assert.ok(declaredSkillCount, 'plugin description must declare its skill count')
    assert.equal(
      Number(declaredSkillCount),
      actualSkills.length,
      'plugin skill metadata must match the packaged skill inventory',
    )

    // beta.5: the interactive wizard is gone — the skill-count truthfulness
    // check above (plugin.json description vs the packaged inventory) is the
    // remaining contract.

    const codeModeRoot = join(packageRoot, '.pantheon', 'code-mode')
    const codeModeManifest = JSON.parse(readFileSync(join(codeModeRoot, 'manifest.json'), 'utf8'))
    const manifestEntries = Object.entries(codeModeManifest.scripts ?? {})
    const shippedScripts = textFiles(codeModeRoot)
      .filter((file) => /\.(?:py|sh)$/.test(file))
      .map((file) => file.slice(codeModeRoot.length + 1))
      .sort()
    assert.deepEqual(
      manifestEntries.map(([script]) => script).sort(),
      shippedScripts,
      'code-mode manifest must contain exactly the scripts shipped in the tarball',
    )
    for (const [script, expectedHash] of manifestEntries) {
      const scriptPath = join(codeModeRoot, script)
      assert.equal(existsSync(scriptPath), true, `manifest script is missing: ${script}`)
      const actualHash = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
      assert.equal(actualHash, expectedHash, `manifest hash mismatch: ${script}`)
    }
    assertExecutableConfigIsPathFree(packageRoot)
    // Node refuses to strip TypeScript types inside node_modules, so any
    // published .mjs that imports a relative .ts specifier is dead on install.
    for (const file of textFiles(packageRoot).filter((candidate) => candidate.endsWith('.mjs'))) {
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /(?:from\s*|import\s*\(\s*)['"]\.{1,2}\/[^'"]+\.ts['"]/,
        `${relative(packageRoot, file)} imports TypeScript, which Node cannot load from node_modules`,
      )
    }
    for (const file of textFiles(join(work, 'package'))) {
      const rel = file.slice(join(work, 'package').length + 1)
      const text = readFileSync(file, 'utf8')
      // Documentation may show safe placeholder commands/paths. Executable
      // configs and archive entries may not contain machine paths or logs.
      if (
        /^(?:README\.md|AGENTS\.md|CHANGELOG\.md|docs\/|src\/skills\/|src\/agents\/|src\/pantheon\/vision\.ts)/.test(
          rel,
        )
      )
        continue
      assert.doesNotMatch(text, forbidden, `forbidden path in ${file}`)
      assert.doesNotMatch(text, /\/tmp\//i, `temporary machine path in ${file}`)
      assert.doesNotMatch(text, privateUrl, `private URL in ${file}`)
    }
    assert.match(listing, /^package\/scripts\/doctor\.mjs$/m)
    // The removed generation's hooks plugin must not ship.
    assert.doesNotMatch(listing, /package\/src\/plugins\/pantheon-hooks\.ts/)
    // The plugin export target and its directory shim both ship.
    assert.match(listing, /^package\/src\/plugin\/index\.ts$/m)
    assert.match(listing, /^package\/src\/plugin\/index\.js$/m)
    assert.match(listing, /^package\/src\/plugin\.ts$/m)
    assert.match(listing, /^package\/scripts\/postinstall\.mjs$/m)
    assert.doesNotMatch(listing, /^package\/bin\//m)
    // The code-mode payload must ship inside the tarball so fresh installs
    // can seed the runtime scripts directory.
    assert.match(listing, /^package\/\.pantheon\/code-mode\/compress-inline\.py$/m)
    assert.doesNotMatch(
      listing,
      /package\/\.pantheon\/code-mode\/session-end-save\.(?:py|sh)/,
      'retired session-save scripts must not be packaged',
    )
    assert.doesNotMatch(
      listing,
      /package\/\.pantheon\/code-mode\/eval-[^/]+\.py/,
      'evaluation helpers must remain local-only',
    )
    assert.doesNotMatch(
      listing,
      /(?:^|\/)evals?(?:\/|$)|(?:^|\/)promptfoo(?:\/|$)/i,
      'local evals and Promptfoo assets must remain excluded',
    )

    const redaction = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'redaction-gate.mjs'), tarball],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(redaction.status, 0, redaction.stderr || redaction.stdout)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('installed tarball runs postinstall legacy cleanup and serves native plugin scripts without bin CLI', () => {
  const work = mkdtempSync(join(tmpdir(), 'pantheon-prefix-'))
  const project = join(work, 'project')
  mkdirSync(project)
  try {
    const tarball = pack(work)
    const sandboxConfig = join(work, 'sandbox-config')
    const opencodeDir = join(sandboxConfig, 'opencode')
    mkdirSync(join(opencodeDir, 'plugins', 'pantheon-tui', 'dist'), {
      recursive: true,
      mode: 0o700,
    })
    writeFileSync(
      join(opencodeDir, 'plugins', 'pantheon-tui', 'dist', 'tui.js'),
      '// stale legacy copied TUI\n',
    )
    writeFileSync(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify(
        {
          plugins: ['pantheon-opencode', join(opencodeDir, 'plugins', 'pantheon-tui')],
          mcp: {
            servers: {
              'pantheon-code-mode': {
                type: 'local',
                command: [join(opencodeDir, '.venv', 'bin', 'python3'), 'scripts/code_mode.py'],
              },
              context7: {
                type: 'remote',
                url: 'https://mcp.context7.com/mcp',
              },
            },
          },
          theme: 'user-theme',
        },
        null,
        2,
      ),
    )

    const installedRoot = unpackInstalledPackage(tarball, work)
    const installedManifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))
    assert.equal(installedManifest.bin, undefined, 'retired bin CLI must not ship in package.json')
    assert.equal(
      existsSync(join(installedRoot, 'opencode.json')),
      false,
      'installed package must not ship an opencode.json template',
    )

    const postinstall = spawnSync(
      process.execPath,
      [join(installedRoot, 'scripts', 'postinstall.mjs')],
      {
        cwd: work,
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: sandboxConfig, HOME: join(work, 'home') },
      },
    )
    assert.equal(postinstall.status, 0, postinstall.stderr || postinstall.stdout)
    assert.match(postinstall.stdout, /opencode plugin add pantheon-opencode/)

    const cleanedConfig = JSON.parse(readFileSync(join(opencodeDir, 'opencode.json'), 'utf8'))
    assert.equal(cleanedConfig.mcp?.servers?.['pantheon-code-mode'], undefined)
    assert.equal(cleanedConfig.mcp?.servers?.context7?.type, 'remote')
    assert.deepEqual(cleanedConfig.plugins, ['pantheon-opencode'])
    assert.equal(cleanedConfig.theme, 'user-theme')
    assert.equal(existsSync(join(opencodeDir, 'plugins', 'pantheon-tui')), false)

    const routerStatus = spawnSync(
      process.execPath,
      [join(installedRoot, 'scripts', 'decision-router.mjs'), 'status'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(work, 'home'),
          XDG_CONFIG_HOME: sandboxConfig,
          XDG_STATE_HOME: join(work, 'state'),
        },
      },
    )
    assert.equal(routerStatus.status, 0, routerStatus.stderr || routerStatus.stdout)
    assert.match(routerStatus.stdout, /Enabled: no/)
    assert.doesNotMatch(routerStatus.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/)

    const doctor = spawnSync(
      process.execPath,
      [join(installedRoot, 'scripts', 'doctor.mjs'), '--target', project],
      {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(work, 'home'),
          XDG_CONFIG_HOME: sandboxConfig,
        },
      },
    )
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('package validator rejects executable templates with machine paths', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pantheon-package-fixture-'))
  try {
    mkdirSync(join(fixture, 'scripts'), { recursive: true })
    execFileSync('cp', [
      join(ROOT, 'scripts', 'validate-package.mjs'),
      join(fixture, 'scripts', 'validate-package.mjs'),
    ])
    execFileSync('cp', [join(ROOT, 'package.json'), join(fixture, 'package.json')])
    execFileSync('cp', [join(ROOT, 'plugin.json'), join(fixture, 'plugin.json')])
    execFileSync('cp', [
      join(ROOT, 'src', 'plugins', 'tui', 'package.json'),
      join(fixture, 'tui.json'),
    ])
    const configPath = join(fixture, 'plugin.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.plugin = ['/home/checkout/src/plugins/pantheon-hooks.ts']
    writeFileSync(configPath, `${JSON.stringify(config)}\n`)
    const result = spawnSync(process.execPath, [join(fixture, 'scripts', 'validate-package.mjs')], {
      cwd: fixture,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Package validation failed/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
