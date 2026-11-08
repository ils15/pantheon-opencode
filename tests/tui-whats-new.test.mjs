/**
 * Focused tests for the one-time "What's new" TUI window (per Pantheon
 * version).
 *
 * The feature has three offline-testable layers plus two wiring surfaces:
 *   1. `whats-new-state.ts`  — last-seen version persisted next to the other
 *      TUI state (`<configDir>/.pantheon/whats-new.json`), atomic write,
 *      fail-open on a corrupt file.
 *   2. `whats-new-highlights.ts` — the CHANGELOG section for the running
 *      version, reduced to bounded plain-text lines (mirror of
 *      scripts/changelog-extract.mjs section semantics, pinned by parity).
 *   3. `whats-new-open.ts`   — the show-once decision: first run shows,
 *      dismissal pins, second run does not, version bump shows again.
 *   Wiring (source-level assertions, same style as tui-dispatch-panel):
 *   the V1/V2 entries fire it fire-and-forget, and both installer copies ship
 *   CHANGELOG.md at the plugin copy root so the window can read it offline.
 *
 * The Solid components are not imported here: the packaged dist must not be
 * rebuilt by contributors (byte-reproducible dist is a release-owner job), so
 * the reactive glue is pinned by source assertions while every decision lives
 * in the plain modules imported below.
 */
import assert from 'node:assert/strict'
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
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const loadModule = async (relative) => import(pathToFileURL(join(root, relative)).href)

const state = await loadModule('src/plugins/tui/src/whats-new-state.ts')
const highlights = await loadModule('src/plugins/tui/src/whats-new-highlights.ts')
const open = await loadModule('src/plugins/tui/src/whats-new-open.ts')
const { extractSection } = await import(
  pathToFileURL(join(root, 'scripts/changelog-extract.mjs')).href
)

/* Isolate the default state path: never read or write the developer's real
 * ~/.config (same discipline as tests/tui-dispatch-panel.test.mjs). */
const isolatedXdg = mkdtempSync(join(tmpdir(), 'pantheon-whatsnew-xdg-'))
process.env.XDG_CONFIG_HOME = isolatedXdg
process.on('exit', () => rmSync(isolatedXdg, { recursive: true, force: true }))

function tmpDir(label) {
  return mkdtempSync(join(tmpdir(), `pantheon-whatsnew-${label}-`))
}

/** A changelog shaped exactly like the repository's: `## [v<version>] - date`,
 *  H3 groups, bold-prefixed bullets, prose continuations, HTML comments. */
const FIXTURE_CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [v1.6.3-beta.4] - 2026-11-04',
  '',
  '### Added',
  '',
  '- **routing** — `decision-router setup-model cloudflare-workers-jev/clef --account-id=<id>`',
  '  provisions the Cloudflare Workers AI custom provider entry; the token rides',
  '  `CLOUDFLARE_API_TOKEN` in the host environment.',
  '- **tui** — the sidebar learns a per-session token burn rate.',
  '',
  '### Fixed',
  '',
  '- **install** — the postinstall no longer trips over a read-only npm cache.',
  '',
  '## [v1.6.3-beta.3] - 2026-11-04',
  '',
  '### Fixed',
  '',
  '- **routing** — the OpenRouter-hosted Jev route settles end to end.',
  '',
].join('\n')

/* ─── State: where the last-seen version lives ──────────── */

test('state: first run shows (missing state file → shouldShow true)', async () => {
  const dir = tmpDir('first')
  const statePath = join(dir, 'whats-new.json')
  assert.equal(existsSync(statePath), false)
  assert.equal(await state.shouldShowWhatsNew('1.6.3-beta.4', statePath), true)
})

test('state: markSeen pins the version — the second start never shows again', async () => {
  const dir = tmpDir('pin')
  const statePath = join(dir, 'whats-new.json')

  await state.markSeenWhatsNew('1.6.3-beta.4', statePath)
  assert.equal(await state.shouldShowWhatsNew('1.6.3-beta.4', statePath), false)
  assert.equal(
    await state.shouldShowWhatsNew('1.6.3-beta.4', statePath),
    false,
    'stable across reads',
  )

  const raw = readFileSync(statePath, 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.seenVersion, '1.6.3-beta.4')
  assert.ok(!Number.isNaN(Date.parse(parsed.updatedAt)), 'updatedAt is an ISO timestamp')
  assert.equal(
    raw.endsWith('\n'),
    true,
    'the file ends with a newline like every pantheon JSON file',
  )
})

test('state: a version bump shows again, and downgrades count as changes', async () => {
  const dir = tmpDir('bump')
  const statePath = join(dir, 'whats-new.json')

  await state.markSeenWhatsNew('1.6.2', statePath)
  assert.equal(await state.shouldShowWhatsNew('1.6.3-beta.4', statePath), true)
  await state.markSeenWhatsNew('1.6.3-beta.4', statePath)
  assert.equal(
    await state.shouldShowWhatsNew('1.6.2', statePath),
    true,
    'a downgrade is a change too',
  )
})

test('state: a corrupt state file is tolerated as never-seen and overwritten by markSeen', async () => {
  const dir = tmpDir('corrupt')
  const statePath = join(dir, 'whats-new.json')
  writeFileSync(statePath, '{ this is not json', 'utf8')

  assert.equal(await state.shouldShowWhatsNew('1.6.3-beta.4', statePath), true)
  assert.equal(await state.readWhatsNewState(statePath), null)

  await state.markSeenWhatsNew('1.6.3-beta.4', statePath)
  assert.equal(
    await state.shouldShowWhatsNew('1.6.3-beta.4', statePath),
    false,
    'markSeen recovers the file',
  )
})

test('state: wrong-shape JSON (arrays, non-string versions) is treated as absent', async () => {
  const dir = tmpDir('shape')
  const statePath = join(dir, 'whats-new.json')
  writeFileSync(statePath, JSON.stringify([{ seenVersion: '1.0.0' }]), 'utf8')
  assert.equal(await state.shouldShowWhatsNew('1.6.3-beta.4', statePath), true)
  writeFileSync(statePath, JSON.stringify({ seenVersion: 42, updatedAt: 'x' }), 'utf8')
  assert.equal(await state.shouldShowWhatsNew('1.6.3-beta.4', statePath), true)
})

test('state: an absent or empty version never shows', async () => {
  const dir = tmpDir('novers')
  const statePath = join(dir, 'whats-new.json')
  assert.equal(await state.shouldShowWhatsNew(null, statePath), false)
  assert.equal(await state.shouldShowWhatsNew('', statePath), false)
  assert.equal(await state.shouldShowWhatsNew('   ', statePath), false)
})

test('state: markSeen never throws and leaves no temp files behind', async () => {
  const dir = tmpDir('tmpclean')
  const statePath = join(dir, 'nested', 'deeper', 'whats-new.json')
  await state.markSeenWhatsNew('1.0.0', statePath)
  assert.equal(existsSync(statePath), true, 'missing parent directories are created')

  // A state path that cannot be written (parent "dir" is a FILE) resolves
  // silently — the window is one-time nicety, never a startup risk.
  const blocked = tmpDir('blocked')
  writeFileSync(join(blocked, 'file'), 'x', 'utf8')
  await state.markSeenWhatsNew('1.0.0', join(blocked, 'file', 'whats-new.json'))
  await state.markSeenWhatsNew('1.0.0', join(blocked, 'whats-new.json'))

  const written = readdirSync(join(dir, 'nested', 'deeper'))
  assert.deepEqual(written, ['whats-new.json'], 'no *.tmp-* litter')
})

test('state: the default path lives next to the other TUI state in <configDir>/.pantheon', async () => {
  const home = tmpDir('home')
  const xdg = tmpDir('xdg')
  mkdirSync(join(xdg, 'opencode'), { recursive: true })
  assert.equal(
    await state.defaultWhatsNewStatePath({ XDG_CONFIG_HOME: xdg }, home),
    join(xdg, 'opencode', '.pantheon', 'whats-new.json'),
  )

  const home2 = tmpDir('home2')
  mkdirSync(join(home2, '.opencode'), { recursive: true })
  assert.equal(
    await state.defaultWhatsNewStatePath({}, home2),
    join(home2, '.opencode', '.pantheon', 'whats-new.json'),
    'a legacy ~/.opencode install keeps its state there',
  )

  const home3 = tmpDir('home3')
  assert.equal(
    await state.defaultWhatsNewStatePath({}, home3),
    join(home3, '.config', 'opencode', '.pantheon', 'whats-new.json'),
    'no config dir yet → the XDG location init creates',
  )
})

/* ─── Highlights: the CHANGELOG section, bounded and sanitized ── */

test('highlights: extractSection mirrors scripts/changelog-extract.mjs', () => {
  for (const [text, version] of [
    [FIXTURE_CHANGELOG, '1.6.3-beta.4'],
    [FIXTURE_CHANGELOG, 'v1.6.3-beta.4'],
    [FIXTURE_CHANGELOG, '1.6.3-beta.3'],
    ['# Changelog\n\n## [Unreleased]\n\n- x\n', 'Unreleased'],
    [
      '# Changelog\n\n## [1.0.0-beta] - 2026-01-01\n\n- beta\n\n## [1.0.0] - 2026-01-02\n\n- stable\n',
      '1.0.0',
    ],
  ]) {
    assert.deepEqual(
      highlights.extractSection(text, version),
      extractSection(text, version),
      `parity for ${version}`,
    )
  }
  assert.deepEqual(highlights.extractSection(FIXTURE_CHANGELOG, '9.9.9'), {
    found: false,
    body: null,
  })
})

test('highlights: a real section becomes plain-text groups and bullets', () => {
  const result = highlights.extractHighlights(FIXTURE_CHANGELOG, '1.6.3-beta.4')
  assert.equal(result.found, true)
  assert.equal(result.version, '1.6.3-beta.4')
  assert.equal(result.truncated, false)
  assert.deepEqual(
    result.groups.map((group) => group.heading),
    ['Added', 'Fixed'],
  )
  const items = result.groups.flatMap((group) => group.items)
  assert.equal(items.length, 3)
  assert.equal(items[0].includes('decision-router setup-model'), true)
  for (const artifact of ['**', '`', '](', '<!--']) {
    for (const item of items) {
      assert.equal(
        item.includes(artifact),
        false,
        `no ${artifact} artifact in ${JSON.stringify(item)}`,
      )
    }
  }
  assert.ok(
    items[0].includes('CLOUDFLARE_API_TOKEN'),
    'continuation lines are folded into the bullet',
  )
})

test('highlights: a missing section or a bullet-less section yields an empty window', () => {
  for (const text of [
    '',
    FIXTURE_CHANGELOG,
    '## [v1.0.0] - 2026-01-01\n\nJust prose, no bullets.\n',
  ]) {
    const result = highlights.extractHighlights(
      text,
      text === FIXTURE_CHANGELOG ? '9.9.9' : '1.0.0',
    )
    assert.deepEqual(result.groups, [])
    assert.deepEqual(highlights.whatsNewLines(result), [], 'no lines → no window')
  }
})

test('highlights: hostile content is stripped and bounded to the documented budget', () => {
  const bullets = []
  for (let index = 0; index < 20; index += 1) {
    bullets.push(
      `- **agent${index}** — see [\`link ${index}\`](https://evil.example/${index}) and ` +
        '`rm -rf /` <!-- x -->',
    )
  }
  const text = [
    '## [v2.0.0] - 2026-01-01',
    '',
    '### Added',
    '',
    ...bullets,
    '',
    '### Changed',
    '',
  ].join('\n')
  const result = highlights.extractHighlights(text, '2.0.0')
  assert.equal(result.found, true)
  assert.equal(result.totalItems, 20)
  assert.equal(result.truncated, true, 'the overflow is flagged')
  const lines = highlights.whatsNewLines(result)
  const items = result.groups.flatMap((group) => group.items)
  assert.equal(items.length, highlights.WHATS_NEW_MAX_ITEMS, 'exactly the budget survives')
  assert.ok(lines.at(-1).includes('+8'), 'the remainder is counted, not dropped silently')
  for (const item of items) {
    for (const artifact of ['**', '`', '](', '<!--', 'https://evil.example']) {
      assert.equal(item.includes(artifact), false, `no ${artifact} survives`)
    }
  }
})

test('highlights: the title matches the sidebar convention and the lines carry bullets', () => {
  assert.equal(
    highlights.whatsNewTitle('1.6.3-beta.4'),
    'O que há de novo — Pantheon v1.6.3-beta.4',
  )
  const result = highlights.extractHighlights(FIXTURE_CHANGELOG, '1.6.3-beta.4')
  const lines = highlights.whatsNewLines(result)
  assert.equal(lines[0], 'Added')
  assert.match(lines[1], /^• /u)
  assert.equal(lines.filter((line) => line.startsWith('• ')).length, 3)
})

test("highlights: the 🆕 What's New summary block wins over the full section", () => {
  const text = [
    '## [v1.7.0] - 2026-11-05',
    '',
    "### 🆕 What's New",
    '- Short curated highlight one',
    '- Short curated highlight two',
    '',
    '### Added',
    '',
    '- Long added bullet that the window must NOT show because the summary exists',
    '',
  ].join('\n')
  const result = highlights.extractHighlights(text, '1.7.0')
  assert.equal(result.found, true)
  assert.equal(result.totalItems, 2, 'summary bullets only')
  assert.deepEqual(result.groups, [
    { heading: null, items: ['Short curated highlight one', 'Short curated highlight two'] },
  ])
  // H2 level also parses.
  const h2 = text.replace("### 🆕 What's New", "## 🆕 What's New")
  assert.equal(highlights.extractHighlights(h2, '1.7.0').totalItems, 2)
})

test('highlights: the summary caps at six items and truncates long bullets', () => {
  const bullets = []
  for (let index = 0; index < 9; index += 1) {
    bullets.push(`- highlight ${index} ${'x'.repeat(160)}`)
  }
  const text = ['## [v1.7.1] - 2026-11-05', '', "### 🆕 What's New", ...bullets, ''].join('\n')
  const result = highlights.extractHighlights(text, '1.7.1')
  const items = result.groups.flatMap((group) => group.items)
  assert.equal(items.length, highlights.WHATS_NEW_SUMMARY_MAX_ITEMS)
  for (const item of items) {
    assert.ok(item.length <= highlights.WHATS_NEW_ITEM_MAX_CHARS, 'one-line rule enforced')
    assert.ok(item.endsWith('…'), 'truncation is visible')
  }
})

test('open: pagination slices fixed-size pages and the hint names the page keys', () => {
  const { paginateWhatsNewLines, WHATS_NEW_PAGE_SIZE, wrapWhatsNewLine } = open
  const lines = Array.from({ length: WHATS_NEW_PAGE_SIZE + 3 }, (_, i) => `line ${i}`)
  const pages = paginateWhatsNewLines(lines)
  assert.equal(pages.length, 2)
  assert.equal(pages[0].length, WHATS_NEW_PAGE_SIZE)
  assert.equal(pages[1].length, 3)
  assert.deepEqual(paginateWhatsNewLines([]), [[]])
  assert.deepEqual(wrapWhatsNewLine('short', 76), ['short'])
  assert.equal(wrapWhatsNewLine('x'.repeat(160), 76).length, 3)
  assert.equal(wrapWhatsNewLine('x'.repeat(100), 0).length, 2, 'width floor applies')
})

/* ─── Sources: where the CHANGELOG and the version come from ── */

test('highlights: changelog candidates — copy root first, package root second', () => {
  const copy = highlights.changelogCandidates(
    join('/home/u/.config/opencode', 'plugins', 'pantheon-tui', 'dist', 'tui.js'),
  )
  assert.deepEqual(copy, [
    join('/home/u/.config/opencode', 'plugins', 'pantheon-tui', 'CHANGELOG.md'),
    join('/home/u/.config', 'CHANGELOG.md'),
  ])
  const dev = highlights.changelogCandidates(join(root, 'src', 'plugins', 'tui', 'dist', 'tui.js'))
  assert.deepEqual(dev, [
    join(root, 'src', 'plugins', 'tui', 'CHANGELOG.md'),
    join(root, 'CHANGELOG.md'),
  ])
})

test('highlights: readChangelogForBundle reads the first existing candidate', async () => {
  // Installed-copy layout: <config>/plugins/pantheon-tui/dist/tui.js.
  const dir = tmpDir('bundle')
  const dist = join(dir, 'plugins', 'pantheon-tui', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'tui.js'), 'bundle', 'utf8')
  assert.equal(
    await highlights.readChangelogForBundle(pathToFileURL(join(dist, 'tui.js')).href),
    null,
  )

  writeFileSync(join(dir, 'plugins', 'pantheon-tui', 'CHANGELOG.md'), 'copy-root', 'utf8')
  assert.equal(
    await highlights.readChangelogForBundle(pathToFileURL(join(dist, 'tui.js')).href),
    'copy-root',
  )

  // Dev / npm-package layout: <pkg>/src/plugins/tui/dist/tui.js — the package
  // root three levels above the copy root carries the shipped CHANGELOG.md.
  const pkg = tmpDir('bundle-pkg')
  const pkgDist = join(pkg, 'src', 'plugins', 'tui', 'dist')
  mkdirSync(pkgDist, { recursive: true })
  const pkgBundle = pathToFileURL(join(pkgDist, 'tui.js')).href
  writeFileSync(join(pkg, 'CHANGELOG.md'), 'package-root', 'utf8')
  assert.equal(await highlights.readChangelogForBundle(pkgBundle), 'package-root')
  rmSync(join(pkg, 'CHANGELOG.md'))
  assert.equal(await highlights.readChangelogForBundle(pkgBundle), null)
})

test('highlights: the running version comes from the plugin package.json, then the build embed', async () => {
  const dir = tmpDir('version')
  const dist = join(dir, 'plugins', 'pantheon-tui', 'dist')
  mkdirSync(dist, { recursive: true })
  const bundleUrl = pathToFileURL(join(dist, 'tui.js')).href

  assert.equal(
    await highlights.resolveRunningVersion(bundleUrl, 'built-in'),
    'built-in',
    'no package.json → embed',
  )

  writeFileSync(
    join(dir, 'plugins', 'pantheon-tui', 'package.json'),
    JSON.stringify({ name: 'pantheon-tui', version: '1.6.3-beta.4' }),
    'utf8',
  )
  assert.equal(
    await highlights.resolveRunningVersion(bundleUrl, 'built-in'),
    '1.6.3-beta.4',
    'the installed copy package.json wins',
  )
  assert.equal(await highlights.resolveRunningVersion(bundleUrl, null), '1.6.3-beta.4')

  writeFileSync(join(dir, 'plugins', 'pantheon-tui', 'package.json'), '{ broken', 'utf8')
  assert.equal(
    await highlights.resolveRunningVersion(bundleUrl, null),
    null,
    'unreadable → null → no window',
  )
})

/* ─── The one-time flow: show once per version, pin on dismissal ── */

function spyShow() {
  const shown = []
  return {
    shown,
    show(render, onClose) {
      shown.push({ data: render(), onClose })
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait (bounded) until the async markSeen fired by onClose has landed. */
async function untilPinned(version, statePath, ms = 2_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!(await state.shouldShowWhatsNew(version, statePath))) return true
    await sleep(10)
  }
  return !(await state.shouldShowWhatsNew(version, statePath))
}

test('flow: first start shows once, dismissal pins, second start does not', async () => {
  const dir = tmpDir('flow')
  const statePath = join(dir, 'whats-new.json')
  const spy = spyShow()

  assert.equal(
    await open.openWhatsNew({
      version: '1.6.3-beta.4',
      statePath,
      changelogText: FIXTURE_CHANGELOG,
      show: spy.show,
    }),
    true,
  )
  assert.equal(spy.shown.length, 1)
  assert.equal(spy.shown[0].data.title, 'O que há de novo — Pantheon v1.6.3-beta.4')
  assert.ok(spy.shown[0].data.lines.length > 0)
  assert.ok(spy.shown[0].data.hint.length > 0, 'the window teaches its own dismiss bind')

  spy.shown[0].onClose()
  assert.equal(await untilPinned('1.6.3-beta.4', statePath), true, 'dismissal pins the version')

  assert.equal(
    await open.openWhatsNew({
      version: '1.6.3-beta.4',
      statePath,
      changelogText: FIXTURE_CHANGELOG,
      show: spy.show,
    }),
    false,
    'the same version never shows again',
  )
  assert.equal(spy.shown.length, 1)
})

test('flow: a version bump shows the new highlights', async () => {
  const dir = tmpDir('flow2')
  const statePath = join(dir, 'whats-new.json')
  const spy = spyShow()
  const input = { statePath, changelogText: FIXTURE_CHANGELOG, show: spy.show }

  await open.openWhatsNew({ ...input, version: '1.6.3-beta.3' })
  spy.shown.at(-1).onClose()
  assert.equal(await untilPinned('1.6.3-beta.3', statePath), true)

  assert.equal(await open.openWhatsNew({ ...input, version: '1.6.3-beta.4' }), true)
  assert.equal(spy.shown.length, 2)
})

test('flow: nothing to show → no window and NO pin (the next start may still show it)', async () => {
  const dir = tmpDir('flow3')
  const statePath = join(dir, 'whats-new.json')
  const spy = spyShow()
  const input = { statePath, changelogText: FIXTURE_CHANGELOG, show: spy.show }

  assert.equal(
    await open.openWhatsNew({ ...input, version: null }),
    false,
    'no version → no window',
  )
  assert.equal(
    await open.openWhatsNew({ ...input, version: '9.9.9' }),
    false,
    'no section → no window',
  )
  assert.equal(await open.openWhatsNew({ ...input, version: '1.6.2', changelogText: null }), false)

  assert.equal(spy.shown.length, 0)
  assert.equal(existsSync(statePath), false, 'a silent miss never writes state')

  // Once the changelog IS readable the window still appears: nothing was pinned.
  assert.equal(await open.openWhatsNew({ ...input, version: '1.6.3-beta.4' }), true)
})

/* ─── Wiring: the entries fire it fire-and-forget; installers ship the file ── */

test('wiring: the canonical entry registers the window fire-and-forget', async () => {
  const entry = readFileSync(join(root, 'src/plugins/tui/src/index.tsx'), 'utf8')
  assert.match(entry, /import \{ maybeShowWhatsNewV2 \} from '\.\/whats-new'/)
  assert.match(entry, /void maybeShowWhatsNewV2\(context\)/, 'never awaited — startup never blocks')

  // There is one entry since 2.0: the dist stays single-file, so nothing
  // else may import the whats-new module (coverage lives in the glue test
  // below and in the sidebar/panel model suites).
  const glue = readFileSync(join(root, 'src/plugins/tui/src/whats-new.tsx'), 'utf8')
  assert.ok(glue.includes('pantheon.whats-new.close'))
})

test('wiring: the close bind is a gated keymap layer, dismissal marks seen', async () => {
  const glue = readFileSync(join(root, 'src/plugins/tui/src/whats-new.tsx'), 'utf8')
  assert.match(glue, /pantheon\.whats-new\.close/)
  assert.match(glue, /bind: 'escape,q'/, 'ESC and q dismiss')
  assert.match(glue, /markSeenWhatsNew/, 'dismissal writes the seen-version')
  assert.match(glue, /dialog\.show\(/, 'shows through the host dialog stack')
  assert.match(glue, /enabled: \(\) => open\(\)/, 'the layer is inert while the window is closed')
})

test('installer: both plugin copies ship CHANGELOG.md at the copy root', async () => {
  const source = join(root, 'src', 'plugins', 'tui')
  const expected = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')

  const { copyPluginFiles: syncCopy } = await import(
    pathToFileURL(join(root, 'scripts/sync-tui.mjs')).href
  )
  const syncTarget = tmpDir('sync-copy')
  try {
    syncCopy(source, syncTarget, 'v1')
    assert.equal(readFileSync(join(syncTarget, 'CHANGELOG.md'), 'utf8'), expected)
  } finally {
    rmSync(syncTarget, { recursive: true, force: true })
  }

  const { copyPluginFiles: installCopy } = await import(
    pathToFileURL(join(root, 'scripts/install/plugin.mjs')).href
  )
  const installTarget = tmpDir('install-copy')
  try {
    installCopy(source, installTarget, { version: 'v1' })
    assert.equal(readFileSync(join(installTarget, 'CHANGELOG.md'), 'utf8'), expected)
  } finally {
    rmSync(installTarget, { recursive: true, force: true })
  }
})
