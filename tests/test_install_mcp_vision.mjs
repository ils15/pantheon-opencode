/** Installation contract tests for the local Pantheon Vision MCP. */

import { strict as assert } from 'node:assert'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  resolveInstalledPlugin,
  resolveTuiCopyTarget,
  syncTuiRegistration,
} from '../scripts/install/opencode.mjs'
import { staleTuiRefs } from '../scripts/install/plugin.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

// P2-4: only exact managed plugin references may be treated as Pantheon-owned.
// A third-party checkout can use either of the historical directory names, so
// the directory name alone must never rewrite its absolute path.
assert.ok(
  resolveInstalledPlugin(join(ROOT, 'src', 'plugin.ts')) === join(ROOT, 'src', 'plugin.ts') &&
    resolveInstalledPlugin(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')) ===
      join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
  'exact installed Pantheon paths remain managed',
)
assert.equal(
  resolveInstalledPlugin('/old/vendor/src/plugin.ts'),
  '/old/vendor/src/plugin.ts',
  'external paths with the same filename remain untouched',
)
assert.equal(
  resolveInstalledPlugin('/tmp/vendor/pantheon-opencode/src/plugin.ts'),
  '/tmp/vendor/pantheon-opencode/src/plugin.ts',
  'external paths under a pantheon-opencode directory remain untouched',
)
assert.equal(
  resolveInstalledPlugin('/tmp/vendor/pantheon/src/plugin.ts'),
  '/tmp/vendor/pantheon/src/plugin.ts',
  'external paths under a pantheon directory remain untouched',
)

// The vision server has a single canonical home in the package.
assert.equal(existsSync('scripts/pantheon_vision_server.py'), false)
assert.ok(existsSync('src/mcp/pantheon_vision_server.py'))
assert.equal(existsSync('src/pantheon/pantheon_vision_server.py'), false)

// The committed opencode.json must never carry provider credentials.
const configText = readFileSync('opencode.json', 'utf8')
const config = JSON.parse(configText)
assert.ok(config.mcp?.bifrost?.url)
assert.equal(config.mcp.bifrost.headers, undefined)
const bifrostHeader = ['x', '-bf-', 'vk'].join('')
const bifrostTokenPrefix = ['sk', '-bf-'].join('')
assert.equal(new RegExp(bifrostHeader, 'i').test(configText), false)
assert.equal(new RegExp(bifrostTokenPrefix, 'i').test(configText), false)
assert.equal(/(?:api[_-]?key|token|secret)\s*[:=]\s*["'][^"']{12,}/i.test(configText), false)

// The packaged vision requirements stay minimal (no heavy ML deps).
const visionRequirements = readFileSync('src/mcp/requirements-vision.txt', 'utf8')
assert.deepEqual(
  visionRequirements
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[<>=!~]/, 1)[0])
    .filter(Boolean),
  ['mcp', 'fastmcp', 'httpx'],
)
for (const dependency of ['pillow', 'paddle', 'gemini', 'torch']) {
  assert.equal(new RegExp(`^${dependency}(?:[<>=!~]|$)`, 'mi').test(visionRequirements), false)
}

// ---------------------------------------------------------------------------
// P2-5b: behavioral — single source of truth for the TUI plugin. OpenCode
// reads tui.json from ~/.opencode, $XDG_CONFIG_HOME/opencode AND
// <project>/.opencode, so stale absolute refs from old checkouts/package/npx
// installs must be cleaned from ALL of them, while the CURRENT plugin is
// copied into <config>/plugins/pantheon-tui and registered by that single
// absolute directory reference.
// ---------------------------------------------------------------------------
const PACKAGE_TUI_SRC = join(ROOT, 'src', 'plugins', 'tui')
// Old Pantheon references are removed only when their identity is unambiguous;
// the same-suffix user path below is intentionally retained.
const STALE_REFS = [
  join(PACKAGE_TUI_SRC, 'dist', 'tui.tsx'), // legacy dist file (tsx era)
  join(PACKAGE_TUI_SRC, 'dist', 'tui.js'), // legacy dist file (js era)
  PACKAGE_TUI_SRC, // in-package source dir
  '/home/olddev/.opencode/plugins/pantheon-tui', // user-owned same-suffix dir
  'plugins/pantheon-tui', // bare relative id (pre-1.19 writes)
  '/home/olddev/.npm/_npx/ab12cd34/node_modules/pantheon-tui', // npx cache copy
  'npx -y pantheon-tui', // npx spec string
]

function readTuiJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function withGlobalDirs(run) {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-tui-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-tui-xdg-'))
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = xdg
  try {
    run({ home, xdg })
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
}

const tuiAt = (dir, global_) =>
  global_ ? join(dir, 'tui.json') : join(dir, '.opencode', 'tui.json')

// (a) clean global install → exactly 1 registration, pointing at the COPIED
// directory, and that directory exists with dist/tui.js (the loader entry).
withGlobalDirs(({ home, xdg }) => {
  const target = join(home, '.opencode')
  mkdirSync(target, { recursive: true })
  const status = syncTuiRegistration(target, { isGlobal: true, dryRun: false })
  assert.equal(status, 'created', 'clean install registers the copied TUI dir')
  const targetCfg = readTuiJson(tuiAt(target, true))
  assert.ok(targetCfg, 'target tui.json created')
  assert.equal(targetCfg.plugin.length, 1, 'exactly one TUI registration')
  const [ref] = targetCfg.plugin
  const copyDir = resolveTuiCopyTarget(target)
  assert.equal(ref, copyDir, 'the registered ref is the copied plugin directory')
  assert.ok(existsSync(ref), 'copied plugin dir exists')
  assert.ok(existsSync(join(ref, 'dist', 'tui.js')), 'copied dir has dist/tui.js (loader entry)')
  assert.ok(existsSync(join(ref, 'package.json')), 'copied dir has package.json (exports map)')
  const other = tuiAt(join(xdg, 'opencode'), true)
  assert.equal(
    readTuiJson(other)?.plugin.length ?? 0,
    0,
    'the non-target global location has no TUI registrations',
  )
})

// (b) idempotency: a second install produces a byte-identical tui.json with
// the same single registration, and the copied dist files are untouched.
withGlobalDirs(({ home, xdg }) => {
  const target = join(home, '.opencode')
  mkdirSync(target, { recursive: true })
  syncTuiRegistration(target, { isGlobal: true, dryRun: false })
  const targetTui = tuiAt(target, true)
  const first = readFileSync(targetTui, 'utf8')
  const copyDir = resolveTuiCopyTarget(target)
  const firstDist = readFileSync(join(copyDir, 'dist', 'tui.js'), 'utf8')

  syncTuiRegistration(target, { isGlobal: true, dryRun: false })

  assert.equal(
    readFileSync(targetTui, 'utf8'),
    first,
    'reinstall is a byte-identical no-op on tui.json',
  )
  const cfg = readTuiJson(targetTui)
  assert.equal(cfg.plugin.length, 1, 'still exactly one registration')
  assert.equal(cfg.plugin[0], copyDir, 'registration unchanged after reinstall')
  assert.equal(
    readFileSync(join(copyDir, 'dist', 'tui.js'), 'utf8'),
    firstDist,
    'copied dist files unchanged after reinstall',
  )
  const other = tuiAt(join(xdg, 'opencode'), true)
  assert.equal(readTuiJson(other)?.plugin.length ?? 0, 0, 'other location stays clean')
})

// (c) stale refs (dist file, package source, bare copy, npx) seeded in ALL
// THREE tui.json locations are cleaned; the project target keeps exactly the
// copied-dir registration — one Pantheon TUI reference system-wide.
withGlobalDirs(({ home, xdg }) => {
  const project = mkdtempSync(join(tmpdir(), 'pantheon-tui-proj-'))
  try {
    const projectTuiDir = join(project, '.opencode')
    mkdirSync(projectTuiDir, { recursive: true })
    const global1 = join(home, '.opencode', 'tui.json') // ~/.opencode
    const global2 = join(xdg, 'opencode', 'tui.json') // ~/.config/opencode
    const projectTui = join(projectTuiDir, 'tui.json') // <project>/.opencode
    for (const p of [global1, global2, projectTui]) {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify({ plugin: [...STALE_REFS] }, null, 2))
    }

    syncTuiRegistration(project, { isGlobal: false, dryRun: false })

    assert.deepEqual(
      readTuiJson(projectTui).plugin,
      [STALE_REFS[3], resolveTuiCopyTarget(projectTuiDir)],
      'project target keeps the user plugin and adds exactly one copied-dir registration',
    )
    for (const p of [global1, global2]) {
      assert.deepEqual(
        readTuiJson(p)?.plugin ?? [],
        [STALE_REFS[3]],
        `same-suffix user plugin is preserved in ${p}`,
      )
    }
    const allRefs = [global1, global2, projectTui]
      .filter(existsSync)
      .flatMap((p) => readTuiJson(p)?.plugin ?? [])
      .filter((r) => typeof r === 'string' && r.includes('pantheon-tui'))
    assert.equal(
      allRefs.filter((ref) => ref !== STALE_REFS[3]).length,
      1,
      'exactly ONE Pantheon TUI reference is installed system-wide',
    )
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// (d) the copied <config>/plugins/pantheon-tui is byte-identical to the
// source of truth (dist/* + package.json + index.tsx).
withGlobalDirs(({ home }) => {
  const target = join(home, '.opencode')
  mkdirSync(target, { recursive: true })
  syncTuiRegistration(target, { isGlobal: true, dryRun: false })
  const copyDir = resolveTuiCopyTarget(target)
  for (const f of readdirSync(join(PACKAGE_TUI_SRC, 'dist'))) {
    assert.equal(
      readFileSync(join(copyDir, 'dist', f), 'utf8'),
      readFileSync(join(PACKAGE_TUI_SRC, 'dist', f), 'utf8'),
      `dist/${f} is byte-identical to the source of truth`,
    )
  }
  assert.equal(
    readFileSync(join(copyDir, 'package.json'), 'utf8'),
    readFileSync(join(PACKAGE_TUI_SRC, 'package.json'), 'utf8'),
    'package.json is byte-identical to the source of truth',
  )
  assert.equal(
    readFileSync(join(copyDir, 'index.tsx'), 'utf8'),
    readFileSync(join(PACKAGE_TUI_SRC, 'src', 'index.tsx'), 'utf8'),
    'index.tsx is byte-identical to src/index.tsx',
  )
})

// (e) pure helpers: resolveTuiCopyTarget derives the copy dir; staleTuiRefs
// flags old Pantheon TUI references only when their identity is unambiguous;
// a user-owned plugin with the same suffix must survive cleanup.
assert.equal(
  resolveTuiCopyTarget('/x/.opencode'),
  join('/x/.opencode', 'plugins', 'pantheon-tui'),
  'resolveTuiCopyTarget appends plugins/pantheon-tui under the config dir',
)
const currentShape = '/home/current/.opencode/plugins/pantheon-tui'
const userSameSuffix = '/home/user/plugins/pantheon-tui'
const staleOnly = staleTuiRefs([...STALE_REFS, currentShape, userSameSuffix])
assert.deepEqual(
  staleOnly,
  STALE_REFS.filter((ref) => !ref.includes('/home/olddev/.opencode/plugins/pantheon-tui')),
  'staleTuiRefs flags identifiable Pantheon refs but preserves same-suffix user plugins',
)

console.log('✅ Pantheon Vision MCP installation contract passed')
