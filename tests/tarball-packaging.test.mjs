import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
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

function pack(destination) {
  // Do not bypass prepack: the published archive is the artifact under test.
  // --json emits the full manifest + file listing (>1MB once the tarball
  // carries every runtime input); the default 1MB child buffer would blow
  // up with ENOBUFS, so raise it explicitly. Keep the archive out of the
  // source tree so it cannot race with install-plan source fingerprints.
  // HUSKY=0 prevents prepare from rewriting shared hook files in parallel.
  const result = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, HUSKY: '0' },
  })
  return join(destination, firstPackEntry(result).filename)
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

    const interactiveInstaller = readFileSync(
      join(packageRoot, 'scripts', 'install', 'interactive.mjs'),
      'utf8',
    )
    const installerDeclaredSkillCount = /Reusable skill workflows \(\$\{(\d+)\} skills\)/.exec(
      interactiveInstaller,
    )?.[1]
    assert.ok(installerDeclaredSkillCount, 'interactive installer must declare its skill count')
    assert.equal(
      Number(installerDeclaredSkillCount),
      actualSkills.length,
      'interactive installer skill count must match the packaged skill inventory',
    )

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
    assert.match(listing, /^package\/src\/plugin\.ts$/m)
    assert.match(listing, /^package\/bin\/pantheon-init\.mjs$/m)
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

test('installed package resolves hooks to its installed absolute path', () => {
  const work = mkdtempSync(join(tmpdir(), 'pantheon-prefix-'))
  const project = join(work, 'project')
  mkdirSync(project)
  try {
    const tarball = pack(work)
    // Install the tarball with a redirected OpenCode config dir. Installing our
    // own tarball runs its `postinstall` (`postinstall.mjs && sync-tui.mjs`), and
    // sync-tui resolves the developer's REAL config dir: $XDG_CONFIG_HOME/
    // opencode if it exists, else ~/.opencode. Left unredirected it copies the
    // repo's src/plugins/tui over the live ~/.config/opencode/plugins/pantheon-tui
    // and then runs `npm ci --omit=dev` *there* — silently rewriting the user's
    // environment (and dropping dev deps) while this suite still reports green.
    //
    // The sandbox dir must CONTAIN an `opencode` entry: resolveConfigDir() only
    // falls through to the real ~/.opencode when the XDG path is absent.
    const sandboxConfig = join(work, 'sandbox-config')
    mkdirSync(join(sandboxConfig, 'opencode'), { recursive: true })
    execFileSync('npm', ['install', '--prefix', work, tarball], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: sandboxConfig },
    })
    const cli = join(work, 'node_modules', 'pantheon-opencode', 'bin', 'pantheon-init.mjs')
    const routerStatus = spawnSync(process.execPath, [cli, 'decision-router', 'status'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(work, 'home'),
        XDG_CONFIG_HOME: sandboxConfig,
        XDG_STATE_HOME: join(work, 'state'),
      },
    })
    assert.equal(routerStatus.status, 0, routerStatus.stderr || routerStatus.stdout)
    assert.match(routerStatus.stdout, /Enabled: no/)
    assert.doesNotMatch(routerStatus.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/)
    const result = spawnSync(
      process.execPath,
      // OPENCODE_VERSION pins the gate: this asserts path resolution inside the
      // INSTALLED package, not the host gate. Left on the default it would
      // resolve against the developer's real OpenCode and assert nothing.
      [cli, 'init', '--project', '--no-mcp', '--headless', '-y'],
      {
        cwd: project,
        encoding: 'utf8',
        env: { ...process.env, OPENCODE_VERSION: 'v2' },
      },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const config = JSON.parse(readFileSync(join(project, 'opencode.json'), 'utf8'))
    const installedRoot = resolve(work, 'node_modules', 'pantheon-opencode')
    // The defaults asserted below are read from the installer's code. Pin that
    // independence here: if a template ever ships again and quietly starts
    // seeding them, this test stops proving the code path it exists to guard.
    assert.equal(
      existsSync(join(installedRoot, 'opencode.json')),
      false,
      'installed package must not ship an opencode.json template',
    )
    // Installer contract: the plugin DIRECTORY inside the INSTALLED package is
    // registered under the plural `plugins` key, in object form, resolved to an
    // absolute path (never a dev-machine path). The singular `plugin` key is
    // never written.
    assert.ok(!('plugin' in config), 'the legacy singular plugin key must not be written')
    const registered = (config.plugins ?? []).find(
      (entry) => typeof entry === 'object' && entry?.package === join(installedRoot, 'src', 'plugin'),
    )
    assert.ok(registered, `the installed plugin directory must be registered: ${JSON.stringify(config.plugins)}`)
    assert.equal(existsSync(registered.package), true, `registered plugin must exist: ${registered.package}`)
    assert.deepEqual(registered.options, {})
    // Regression guard (after the packaged opencode.json template was dropped
    // from `files`): the product defaults an install seeds are code constants in
    // scripts/install/opencode.mjs, NOT read from a template that no longer
    // ships. If they move back to a template — or back out of the installer —
    // these two assertions are what fails.
    assert.equal(config.default_agent, 'zeus')
    // The skills component IS selected by this install (`pantheon-init` default
    // component list includes skills, and no --components narrows it), so the
    // grant below is the gated one — not the unconditional merge it used to be
    // shadowed by. Assert the component explicitly so the two cannot be
    // confused again.
    assert.ok(
      existsSync(join(project, '.opencode', 'skills')),
      'this install must select the skills component for the skill grant to apply',
    )
    // The seeded grants are written in the host's plural `permissions` rule
    // shape. The skills component IS selected by this install (`pantheon-init`
    // default component list includes skills, and no --components narrows it),
    // so the skill grant below is the gated one.
    const rules = config.permissions ?? []
    const ruleEffect = (action, resource) =>
      rules.find((rule) => rule.action === action && rule.resource === resource)?.effect
    assert.equal(ruleEffect('skill', '*'), 'allow')
    // Regression guard: the default shell allowlist is the five commands
    // Pantheon's own agents must run unattended, and nothing else. Growing it
    // again is a silent product/security decision made for every installer, so
    // the allow-set and the deny-set are both pinned here.
    const shellResources = rules.filter((rule) => rule.action === 'shell').map((rule) => rule.resource)
    for (const required of ['git *', 'npm *', 'npx *', 'pytest *', 'ruff *']) {
      assert.equal(ruleEffect('shell', required), 'allow', `permissions must allow shell \`${required}\``)
    }
    for (const forbidden of ['black', 'pip', 'docker', 'curl', 'gh', 'make']) {
      assert.equal(
        shellResources.includes(`${forbidden} *`) || shellResources.includes(forbidden),
        false,
        `permissions must NOT pre-allow \`${forbidden}\` — that is the installing user's call`,
      )
    }
    assert.deepEqual(
      shellResources.slice().sort(),
      ['git *', 'npm *', 'npx *', 'pytest *', 'ruff *'],
      'shell grants must be exactly the five agent-required commands',
    )
    assert.doesNotMatch(JSON.stringify(config), executableForbidden)
    // Installer contract: the TUI plugin is COPIED to the target config's
    // plugins/pantheon-tui and the COPY is registered under `plugins` — never
    // the in-package src/plugins/tui — so installs stay hermetic and
    // idempotent. No tui.json is written: the host loads the copy through its
    // plugins entry, and the copy carries the loader contract (dist/tui.js).
    const tuiDir = join(project, '.opencode', 'plugins', 'pantheon-tui')
    assert.equal(existsSync(join(project, '.opencode', 'tui.json')), false, 'no tui.json is written')
    assert.equal(existsSync(join(tuiDir, 'dist', 'tui.js')), true)
    assert.ok(
      (config.plugins ?? []).some(
        (entry) => typeof entry === 'string' ? entry === tuiDir : entry?.package === tuiDir,
      ),
      'the copied TUI plugin must be registered under plugins',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('installed package leaves an explicit permission.skill choice alone', () => {
  // Same mechanism as the installer tests that seed an existing user config
  // (runInstall(target, existingConfig) in install-opencode.test.mjs): write the
  // user's own opencode.json into the target, then install over it. This one
  // does it against the real tarball, because the bug is in shipped code.
  const work = mkdtempSync(join(tmpdir(), 'pantheon-prefix-skill-'))
  const project = join(work, 'project')
  mkdirSync(project)
  try {
    const tarball = pack(work)
    const sandboxConfig = join(work, 'sandbox-config')
    mkdirSync(join(sandboxConfig, 'opencode'), { recursive: true })
    execFileSync('npm', ['install', '--prefix', work, tarball], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: sandboxConfig },
    })
    // A user who locked skills down on purpose. The skills component IS selected
    // (same default component list as the test above), so the installer reaches
    // the grant — and must decline to make it.
    writeFileSync(
      join(project, 'opencode.json'),
      JSON.stringify(
        { permission: { skill: { '*': 'deny' }, websearch: 'allow' }, theme: 'user-theme' },
        null,
        2,
      ),
    )
    const cli = join(work, 'node_modules', 'pantheon-opencode', 'bin', 'pantheon-init.mjs')
    const result = spawnSync(
      process.execPath,
      // Pinned to v2 for the same reason as the test above: the subject is the
      // permission merge, not the host gate.
      [cli, 'init', '--project', '--no-mcp', '--headless', '-y'],
      { cwd: project, encoding: 'utf8', env: { ...process.env, OPENCODE_VERSION: 'v2' } },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.ok(
      existsSync(join(project, '.opencode', 'skills')),
      'this install must select the skills component, or the guard proves nothing',
    )
    const config = JSON.parse(readFileSync(join(project, 'opencode.json'), 'utf8'))
    // The regression: an unconditional `config.permission.skill = {'*':'allow'}`
    // silently flipped this deny to allow on every install that selected skills.
    // The user's V1-spelled block is normalized to the host's rule array, and
    // the deny must survive it verbatim.
    const rules = config.permissions ?? []
    assert.deepEqual(
      rules.find((rule) => rule.action === 'skill'),
      { action: 'skill', resource: '*', effect: 'deny' },
      'explicit deny must survive',
    )
    assert.equal(
      rules.find((rule) => rule.action === 'websearch')?.effect,
      'allow',
      'the neighbouring allow rule survives the normalization',
    )
    assert.equal(rules.some((rule) => rule.action === 'skill' && rule.effect === 'allow'), false)
    assert.equal(config.theme, 'user-theme')
    assert.equal(config.default_agent, 'zeus', 'unrelated defaults are still seeded')
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
