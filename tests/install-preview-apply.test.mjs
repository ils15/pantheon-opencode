/**
 * install-preview-apply.test.mjs — Beta 11 Setup phase 1 (per-file preview).
 *
 * Contract: `init --dry-run` must print the REAL per-file change set the SAME
 * code path would produce, and write nothing. This suite covers:
 *
 *  1. plan.mjs unit contracts (no external deps): the module-level no-op
 *     recorder, createRecorder/recordChange/isRecording, NET-OUTCOME path
 *     merging (a no-write never upgrades a path to a scored change), the
 *     secret-safe formatter, snapshot() and the plan/stats consistency guard.
 *  2. An end-to-end preview: exit 0, the plan names expected paths and leaks
 *     no file contents/hashes, every pre-existing file is byte- and
 *     mtime-identical afterwards, and no new file appears target-side.
 *  3. Idempotent re-run: an applied target must preview as unchanged with no
 *     `consistency mismatch` warning (in-process and CLI-level).
 *
 * NOTE: the end-to-end cases spawn the CLI (`bin/pantheon-init.mjs`) with
 * `spawnSync`. The spawned CLI imports the installer (`scripts/install/*.mjs`),
 * which needs the declared `js-yaml` dependency; where node_modules is
 * incomplete those cases fail to load. The plan.mjs unit cases still run
 * because plan.mjs has no external imports.
 *
 * Run: node --test tests/install-preview-apply.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { resolveInstallExitCode } from '../scripts/install/exit-codes.mjs'
import {
  createRecorder,
  formatChangePlan,
  NOOP_RECORDER,
  planStatsMismatch,
  recordChange,
  recordRemovalTree,
  removeReviewedTree,
  snapshot,
  summarizeChanges,
} from '../scripts/install/plan.mjs'

const ROOT = process.cwd()
const BIN = join(ROOT, 'bin', 'pantheon-init.mjs')
// Deterministic English strings for message assertions (strings() caches locale).
process.env.LANG = 'C'
process.env.LC_ALL = 'C'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * Map every regular file under `root` to its { sha256, mtimeMs, size }, keyed
 * by the path relative to `root`. Used to prove the preview mutates nothing.
 */
function snapshotTree(root) {
  const out = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        const st = statSync(full)
        out.set(relative(root, full), {
          sha256: sha256(readFileSync(full)),
          mtimeMs: st.mtimeMs,
          size: st.size,
        })
      }
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

// ---------------------------------------------------------------------------
// plan.mjs unit contracts
// ---------------------------------------------------------------------------

test('plan: the default recorder is a module-level no-op singleton', () => {
  assert.equal(typeof NOOP_RECORDER, 'function')
  // Uninstrumented writers call recordChange with no recorder and must not throw.
  assert.doesNotThrow(() => recordChange({ path: '/tmp/x', action: 'create', bytes: 1 }))
})

test('plan: createRecorder collects changes routed through recordChange', () => {
  const rec = createRecorder()
  recordChange({ path: '/a', action: 'create', bytes: 10 }, rec.recorder)
  recordChange({ path: '/b', action: 'unchanged', bytes: 4 }, rec.recorder)
  assert.equal(rec.entries.length, 2)
  assert.equal(rec.entries[0].path, '/a')
  assert.equal(rec.entries[1].action, 'unchanged')
})

test('plan: summarizes distinct paths and totals per action', () => {
  const plan = summarizeChanges([
    { path: 'a', action: 'create', bytes: 5 },
    { path: 'b', action: 'update', bytes: 7 },
    { path: 'c', action: 'unchanged', bytes: 1 },
  ])
  assert.equal(plan.files.length, 3)
  assert.deepEqual(plan.totals, { create: 1, update: 1, remove: 0, unchanged: 1, conflict: 0 })
})

test('plan: the last writer decides the net outcome (no-write wins)', () => {
  // The TUI toggle: unregister computes a would-be update, then register finds
  // the on-disk content already correct and skips. Net result: UNCHANGED.
  const plan = summarizeChanges([
    { path: 'tui.json', action: 'update', bytes: 19, scored: false },
    { path: 'tui.json', action: 'unchanged', bytes: 19 },
  ])
  const tui = plan.files.find((f) => f.path === 'tui.json')
  assert.equal(tui.action, 'unchanged', 'a later no-write must net the path to unchanged')
  assert.equal(tui.scored, false, 'a no-write must never be a scored change')
  assert.equal(plan.scored.create + plan.scored.update + plan.scored.remove, 0)
  assert.equal(planStatsMismatch(plan, { created: 0, skipped: 1 }), null)
})

test('plan: a generated (unscored) write cannot score a path by itself', () => {
  // Idempotent manifest: source sync sees it unchanged; the generated manifest
  // rewrites it (unscored). Net action is update, but it must stay unscored.
  const plan = summarizeChanges([
    { path: 'manifest.json', action: 'unchanged', bytes: 982 },
    { path: 'manifest.json', action: 'update', bytes: 990, scored: false },
  ])
  const manifest = plan.files.find((f) => f.path === 'manifest.json')
  assert.equal(manifest.action, 'update')
  assert.equal(manifest.scored, false)
  assert.equal(planStatsMismatch(plan, { created: 0, skipped: 1 }), null)
})

test('plan: a generated write never demotes a genuinely-counted create', () => {
  // Fresh manifest: syncDir records a scored create, the generated manifest a
  // second unscored create. The path stays ONE scored create.
  const plan = summarizeChanges([
    { path: 'manifest.json', action: 'create', bytes: 982 },
    { path: 'manifest.json', action: 'create', bytes: 990, scored: false },
  ])
  const manifest = plan.files.find((f) => f.path === 'manifest.json')
  assert.equal(manifest.action, 'create')
  assert.equal(manifest.scored, true)
  assert.equal(planStatsMismatch(plan, { created: 1, skipped: 0 }), null)
})

test('plan: a removal is recorded and tallied as its own action', () => {
  const plan = summarizeChanges([{ path: 'stale/skill', action: 'remove', bytes: 0 }])
  assert.equal(plan.totals.remove, 1)
  assert.equal(plan.scored.remove, 1, 'a removal is scored (it counts as a change)')
})

test('plan: unscored entries show in the plan but are excluded from the guard', () => {
  const plan = summarizeChanges([
    { path: 'a', action: 'create', bytes: 1 },
    { path: '.venv', action: 'create', bytes: 0, scored: false },
    { path: 'state.json', action: 'update', bytes: 0, scored: false },
  ])
  // Displayed totals include the synthetic entries...
  assert.deepEqual(plan.totals, { create: 2, update: 1, remove: 0, unchanged: 0, conflict: 0 })
  // ...but only scored entries participate in the consistency guard.
  assert.deepEqual(plan.scored, { create: 1, update: 0, remove: 0, unchanged: 0, conflict: 0 })
  assert.equal(planStatsMismatch(plan, { created: 1, skipped: 0 }), null)
})

test('plan: formatChangePlan is secret-safe — paths, actions, sizes only', () => {
  const plan = summarizeChanges([
    { path: '/target/opencode.json', action: 'update', bytes: 3277 },
    { path: '/target/.opencode/agents/zeus.md', action: 'create', bytes: 12697 },
    { path: '/target/.opencode/skills/x/SKILL.md', action: 'unchanged', bytes: 200 },
  ])
  const text = formatChangePlan('/target', plan)
  assert.match(text, /^Change plan/m)
  assert.match(text, /opencode\.json/)
  assert.match(text, /zeus\.md/)
  assert.match(text, /\bcreate\b/)
  assert.match(text, /\bupdate\b/)
  assert.match(text, /\bunchanged\b/)
  assert.match(text, /No files were written\./)
  // Never print hashes or file contents.
  assert.doesNotMatch(text, /\bsha256\b/i)
  assert.doesNotMatch(text, /\b[0-9a-f]{40,}\b/)
})

test('plan: snapshot reports exists/sha256/size/mode and is stable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-snap-'))
  try {
    const file = join(dir, 'f.txt')
    writeFileSync(file, 'hello')
    const snap = snapshot(file)
    assert.equal(snap.exists, true)
    assert.equal(snap.size, 5)
    assert.equal(snap.sha256, sha256('hello'))
    assert.equal(typeof snap.mode, 'number')
    assert.deepEqual(snapshot(join(dir, 'missing')), {
      exists: false,
      sha256: null,
      size: 0,
      mode: null,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clean preview enumerates plugin, agent, and skill subtree removals with snapshots', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-clean-preview-'))
  const extraFiles = [
    join(target, '.opencode', 'plugins', 'pantheon-tui', 'user-extra.js'),
    join(target, '.opencode', 'agents', 'user-agent.md'),
    join(target, '.opencode', 'skills', 'user-skill', 'notes.txt'),
  ]
  try {
    for (const file of extraFiles) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'user-owned content')
    }

    const result = await installOpenCode(target, true, true, ['plugins', 'agents', 'skills'], {
      yes: true,
      headless: true,
      version: 'v1',
    })

    for (const file of extraFiles) {
      assert.ok(result.removals.includes(file), `removal review must include ${file}`)
      assert.ok(result.snapshots.some((item) => item.path === file && item.exists))
    }
    assert.ok(result.removals.includes(join(target, '.opencode', 'skills', 'user-skill')))
    assert.ok(
      extraFiles.every((file) => existsSync(file)),
      'a clean preview must not delete any existing files',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('clean apply aborts on an unreviewed subtree addition before removing reviewed paths', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-clean-drift-'))
  const pluginDir = join(target, '.opencode', 'plugins', 'pantheon-tui')
  const reviewedFile = join(pluginDir, 'user-extra.js')
  const unreviewedFile = join(pluginDir, 'added-after-preview.js')
  try {
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(reviewedFile, 'reviewed content')

    const result = await installOpenCode(target, false, true, ['plugins'], {
      yes: true,
      headless: true,
      version: 'v1',
      deps: {
        betweenPlanAndApply: () => writeFileSync(unreviewedFile, 'unreviewed content'),
      },
    })

    assert.equal(result.applied, false)
    assert.equal(result.reason, 'drift')
    assert.equal(readFileSync(reviewedFile, 'utf8'), 'reviewed content')
    assert.equal(readFileSync(unreviewedFile, 'utf8'), 'unreviewed content')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('clean apply removes reviewed agent and skill extras and reinstalls managed assets', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-clean-apply-'))
  const extraAgent = join(target, '.opencode', 'agents', 'user-agent.md')
  const extraSkill = join(target, '.opencode', 'skills', 'user-skill', 'notes.txt')
  try {
    mkdirSync(dirname(extraAgent), { recursive: true })
    mkdirSync(dirname(extraSkill), { recursive: true })
    writeFileSync(extraAgent, 'user agent')
    writeFileSync(extraSkill, 'user skill data')

    let result
    await captureOutput(async () => {
      result = await installOpenCode(target, false, true, ['agents', 'skills'], {
        yes: true,
        headless: true,
        version: 'v1',
      })
    })

    assert.equal(result.applied, true)
    assert.equal(existsSync(extraAgent), false)
    assert.equal(existsSync(join(target, '.opencode', 'skills', 'user-skill')), false)
    assert.equal(existsSync(join(target, '.opencode', 'agents', 'zeus.md')), true)
    assert.equal(
      existsSync(join(target, '.opencode', 'skills', 'agent-coordination', 'SKILL.md')),
      true,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('reviewed cleanup never recursively removes a path added after its exact-set check', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-reviewed-removal-'))
  const reviewedFile = join(root, 'reviewed.txt')
  const unreviewedFile = join(root, 'unreviewed.txt')
  try {
    writeFileSync(reviewedFile, 'reviewed')
    const { recorder } = createRecorder()
    const reviewedTree = recordRemovalTree(root, recorder)
    const reviewedRemovals = new Set(reviewedTree.map((entry) => entry.path))
    const reviewedSnapshots = new Map(reviewedTree.map((entry) => [entry.path, entry.snapshot]))
    writeFileSync(unreviewedFile, 'must survive')

    assert.throws(
      () => removeReviewedTree(root, reviewedRemovals, reviewedSnapshots),
      /Removal set changed after review/,
    )
    assert.equal(readFileSync(reviewedFile, 'utf8'), 'reviewed')
    assert.equal(readFileSync(unreviewedFile, 'utf8'), 'must survive')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan: planStatsMismatch gates only the changed count, not skipped', () => {
  const plan = summarizeChanges([
    { path: 'a', action: 'create', bytes: 1 },
    { path: 'b', action: 'unchanged', bytes: 1 },
  ])
  // changed (1) matches stats.created (1); stats.skipped is not gated because
  // it also counts logical no-op skips that touch no file.
  assert.equal(planStatsMismatch(plan, { created: 1, skipped: 1 }), null)
  assert.equal(planStatsMismatch(plan, { created: 1, skipped: 99 }), null)
  // A counted change with no recorded change is a real inconsistency.
  assert.notEqual(planStatsMismatch(plan, { created: 2, skipped: 0 }), null)
})

// ---------------------------------------------------------------------------
// End-to-end preview (requires the installer's declared deps to be present)
// ---------------------------------------------------------------------------

test('init --dry-run: prints the real plan and writes nothing', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-preview-'))
  const home = mkdtempSync(join(tmpdir(), 'pantheon-preview-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-preview-xdg-'))
  try {
    const seed = `${JSON.stringify({ theme: 'seed' }, null, 2)}\n`
    writeFileSync(join(target, 'opencode.json'), seed)
    const before = snapshotTree(target)
    const beforeStat = statSync(join(target, 'opencode.json'))

    const result = spawnSync(
      process.execPath,
      [BIN, 'init', '--project', '--dry-run', '--yes', '--headless', '--version', 'v1'],
      {
        cwd: target,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
      },
    )
    const output = `${result.stdout}\n${result.stderr}`

    assert.equal(result.status, 0, `dry-run must exit 0:\n${output}`)
    // The plan names expected paths and actions.
    assert.match(output, /Change plan/)
    assert.match(output, /opencode\.json/)
    assert.match(output, /AGENTS\.md/)
    assert.match(output, /agents\/zeus\.md/)
    assert.match(output, /\bupdate\b/)
    assert.match(output, /No files were written\./)
    assert.match(output, /\[DRY-RUN\]/, 'a genuine dry run stays [DRY-RUN]-tagged')

    // The consistency guard is ADD-only (Scoped Plan+Stats) — a fresh preview
    // must NOT emit a mismatch warning.
    assert.doesNotMatch(output, /consistency mismatch/i)

    // Secret-safe: no file contents and no hashes.
    assert.doesNotMatch(output, /Agent Return Format/)
    assert.doesNotMatch(output, /\b[0-9a-f]{40,}\b/)

    // Every pre-existing file is byte- and mtime-identical.
    const after = snapshotTree(target)
    const afterStat = statSync(join(target, 'opencode.json'))
    assert.equal(readFileSync(join(target, 'opencode.json'), 'utf8'), seed)
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'seed mtime must be unchanged')
    for (const [path, meta] of before) {
      assert.ok(after.has(path), `pre-existing file disappeared: ${path}`)
      assert.equal(after.get(path).sha256, meta.sha256, `pre-existing file changed: ${path}`)
      assert.equal(after.get(path).mtimeMs, meta.mtimeMs, `pre-existing mtime changed: ${path}`)
    }

    // No new files anywhere target-side.
    const added = [...after.keys()].filter((path) => !before.has(path))
    assert.deepEqual(added, [], `preview must create no files: ${added.join(', ')}`)
    assert.equal(existsSync(join(target, '.pantheon')), false, 'no .pantheon dir')
    assert.equal(existsSync(join(target, '.opencode')), false, 'no .opencode dir')
    assert.equal(existsSync(join(target, 'AGENTS.md')), false, 'no AGENTS.md written')
    const tmpFiles = [...after.keys()].filter((path) => /\.tmp-\d+$/.test(path))
    assert.deepEqual(tmpFiles, [], 'no temp files may be left behind')
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Idempotent re-run — apply once, then preview the SAME target
// ---------------------------------------------------------------------------

/** Run `fn` while capturing everything it writes to stdout AND stderr. */
async function captureOutput(fn) {
  const outWrite = process.stdout.write
  const errWrite = process.stderr.write
  const chunks = []
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    await fn()
  } finally {
    process.stdout.write = outWrite
    process.stderr.write = errWrite
  }
  return chunks.join('')
}

test('in-process: two dry passes in one process never warn (stats scoped per call)', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-inproc-'))
  try {
    const opts = { yes: true, headless: true, version: 'v1' }
    const components = ['agents', 'skills', 'commands']
    await captureOutput(() => installOpenCode(target, true, false, components, opts))
    const second = await captureOutput(() => installOpenCode(target, true, false, components, opts))
    assert.match(second, /Change plan/, 'the second dry pass must still print a plan')
    assert.doesNotMatch(second, /consistency mismatch/i)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('cli: a re-run on an applied target previews as unchanged with no warning', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-idem-'))
  const home = mkdtempSync(join(tmpdir(), 'pantheon-idem-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-idem-xdg-'))
  try {
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg }
    // No runtime (--no-mcp) keeps the apply network-free; plugins still exercise
    // the TUI unregister→register toggle that produced the phantom update.
    const base = [
      'init',
      '--project',
      '--yes',
      '--headless',
      '--version',
      'v1',
      '--no-mcp',
      '--components',
      'agents,skills,instructions,commands,plugins',
    ]

    const apply = spawnSync(process.execPath, [BIN, ...base], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120_000,
      env,
    })
    assert.equal(apply.status, 0, `apply must succeed:\n${apply.stdout}\n${apply.stderr}`)

    const preview = spawnSync(process.execPath, [BIN, ...base, '--dry-run'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120_000,
      env,
    })
    const output = `${preview.stdout}\n${preview.stderr}`
    assert.equal(preview.status, 0, `idempotent preview must exit 0:\n${output}`)
    assert.doesNotMatch(output, /consistency mismatch/i)
    assert.match(output, /Change plan/)
    // A re-run still creates a FRESH backup set (recorded unscored), but no new
    // content files; the TUI toggle must net to unchanged, not update.
    assert.match(output, /create\s+\.pantheon\/backups\//)
    assert.doesNotMatch(output, /create\s+\.opencode\//)
    assert.doesNotMatch(output, /update\s+\.opencode\/tui\.json/)
    assert.match(output, /unchanged\s+\.opencode\/tui\.json/)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})

test('cli: an idempotent runtime re-run previews manifest.json as unchanged', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-idem-rt-'))
  const home = mkdtempSync(join(tmpdir(), 'pantheon-idem-rt-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-idem-rt-xdg-'))
  try {
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg }
    // Keep the apply fast and offline-deterministic: a pre-seeded venv python
    // makes setupVenv skip `python3 -m venv`; the absent pip then fails fast and
    // is non-fatal (the runtime setup never aborts the install).
    mkdirSync(join(target, '.venv', 'bin'), { recursive: true })
    writeFileSync(join(target, '.venv', 'bin', 'python3'), '')
    const base = [
      'init',
      '--project',
      '--yes',
      '--headless',
      '--version',
      'v1',
      '--components',
      'agents,skills,instructions,commands,plugins,runtime',
    ]

    const apply = spawnSync(process.execPath, [BIN, ...base], {
      cwd: target,
      encoding: 'utf8',
      timeout: 180_000,
      env,
    })
    assert.equal(apply.status, 0, `apply must succeed:\n${apply.stdout}\n${apply.stderr}`)

    const preview = spawnSync(process.execPath, [BIN, ...base, '--dry-run'], {
      cwd: target,
      encoding: 'utf8',
      timeout: 120_000,
      env,
    })
    const output = `${preview.stdout}\n${preview.stderr}`
    assert.equal(preview.status, 0, `idempotent runtime preview must exit 0:\n${output}`)
    assert.doesNotMatch(output, /consistency mismatch/i)
    assert.match(output, /Change plan/)
    // manifest.json is owned by the generated-manifest writer; a clean re-run
    // must net it to unchanged, never a phantom update.
    assert.doesNotMatch(output, /update\s+\.opencode\/\.pantheon\/code-mode\/manifest\.json/)
    assert.match(output, /unchanged\s+\.opencode\/\.pantheon\/code-mode\/manifest\.json/)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})

test('init without --yes (non-TTY) prints the plan, applies nothing and exits 2', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-noyes-'))
  const home = mkdtempSync(join(tmpdir(), 'pantheon-noyes-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-noyes-xdg-'))
  try {
    const result = spawnSync(
      process.execPath,
      [
        BIN,
        'init',
        '--project',
        '--headless',
        '--version',
        'v1',
        '--no-mcp',
        '--components',
        'agents,commands',
      ],
      {
        cwd: target,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
      },
    )
    const output = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 2, `apply-without-authorization must exit 2:\n${output}`)
    assert.match(output, /Change plan/, 'the plan is printed')
    assert.match(output, /re-run with --yes/i)
    assert.doesNotMatch(output, /installed!/, 'no success banner')
    assert.deepEqual(readdirSync(target), [], 'nothing may be written')
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Phase 4 — drift detection (plan pass vs apply)
// ---------------------------------------------------------------------------

const driftOpts = (betweenPlanAndApply) => ({
  yes: true,
  headless: true,
  version: 'v1',
  deps: { betweenPlanAndApply },
})

test('drift: a planned file changed between plan and apply aborts with no writes', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-drift-file-'))
  try {
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true })
    writeFileSync(join(target, '.opencode', 'agents', 'hermes.md'), 'STALE\n')
    const result = await installOpenCode(
      target,
      false,
      false,
      ['agents', 'commands'],
      driftOpts(() => writeFileSync(join(target, '.opencode', 'agents', 'hermes.md'), 'MUTATED\n')),
    )
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'drift')
    assert.deepEqual(result.drift, ['.opencode/agents/hermes.md'])
    assert.equal(
      readFileSync(join(target, '.opencode', 'agents', 'hermes.md'), 'utf8'),
      'MUTATED\n',
    )
    assert.equal(existsSync(join(target, '.pantheon')), false, 'no backup/state written')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('drift: opencode.json changed between plan and apply aborts with no writes', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-drift-config-'))
  try {
    writeFileSync(join(target, 'opencode.json'), '{"theme":"seed"}\n')
    const result = await installOpenCode(
      target,
      false,
      false,
      ['agents'],
      driftOpts(() => writeFileSync(join(target, 'opencode.json'), '{"theme":"mutated"}\n')),
    )
    assert.equal(result.reason, 'drift')
    assert.deepEqual(result.drift, ['opencode.json'])
    assert.equal(existsSync(join(target, '.opencode')), false, 'no agents written')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('drift: a planned-new file appearing before apply is drift', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-drift-new-'))
  try {
    const result = await installOpenCode(
      target,
      false,
      false,
      ['agents'],
      driftOpts(() => {
        mkdirSync(join(target, '.opencode', 'agents'), { recursive: true })
        writeFileSync(join(target, '.opencode', 'agents', 'zeus.md'), 'SNEAKED\n')
      }),
    )
    assert.equal(result.reason, 'drift')
    assert.deepEqual(result.drift, ['.opencode/agents/zeus.md'])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('exit code mapping: drift -> 3, not-authorized -> 2, canceled -> 130, else 0', () => {
  assert.equal(resolveInstallExitCode({ applied: false, reason: 'drift' }, false), 3)
  assert.equal(resolveInstallExitCode({ applied: false, reason: 'not-authorized' }, false), 2)
  assert.equal(resolveInstallExitCode({ applied: false, reason: 'canceled' }, false), 130)
  assert.equal(resolveInstallExitCode({ applied: false, reason: 'declined' }, false), 0)
  assert.equal(resolveInstallExitCode({ applied: true, reason: 'applied' }, false), 0)
  assert.equal(resolveInstallExitCode({ applied: false, reason: 'plan' }, true), 0)
})

test('failure: a mid-apply throw reports applied paths and preserves unrelated temp-like files', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const target = mkdtempSync(join(tmpdir(), 'pantheon-fail-'))
  try {
    const tmpSibling = join(target, `leftover.txt.tmp-${process.pid}`)
    writeFileSync(tmpSibling, 'x')
    let out = ''
    const ow = process.stdout.write.bind(process.stdout)
    const ew = process.stderr.write.bind(process.stderr)
    process.stdout.write = (c) => {
      out += String(c)
      return true
    }
    process.stderr.write = (c) => {
      out += String(c)
      return true
    }
    let threw = false
    try {
      await installOpenCode(target, false, false, ['agents', 'commands'], {
        yes: true,
        headless: true,
        version: 'v1',
        deps: { failAfter: 3 },
      })
    } catch {
      threw = true
    } finally {
      process.stdout.write = ow
      process.stderr.write = ew
    }
    assert.equal(threw, true, 'the injected failure must propagate')
    assert.match(out, /Apply failed/)
    assert.match(out, /already applied/)
    assert.match(out, /pantheon-opencode restore/)
    assert.doesNotMatch(out, /\[DRY-RUN\]/, 'a failure is not a dry run')
    assert.equal(
      readFileSync(tmpSibling, 'utf8'),
      'x',
      'failure handling must preserve a pre-existing temp-like user file',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('failure (default global target): report preserves unrelated temp-like file with target=undefined', async () => {
  const { installOpenCode } = await import('../scripts/install/opencode.mjs')
  const home = mkdtempSync(join(tmpdir(), 'pantheon-fail-global-'))
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  try {
    const target = join(home, '.config', 'opencode')
    mkdirSync(target, { recursive: true })
    const tmpSibling = join(target, `leftover.md.tmp-${process.pid}`)
    writeFileSync(tmpSibling, 'x')
    let out = ''
    const ow = process.stdout.write.bind(process.stdout)
    const ew = process.stderr.write.bind(process.stderr)
    process.stdout.write = (c) => {
      out += String(c)
      return true
    }
    process.stderr.write = (c) => {
      out += String(c)
      return true
    }
    let threw = false
    try {
      await installOpenCode(undefined, false, false, ['agents', 'commands'], {
        yes: true,
        headless: true,
        version: 'v1',
        deps: { failAfter: 2 },
      })
    } catch {
      threw = true
    } finally {
      process.stdout.write = ow
      process.stderr.write = ew
    }
    assert.equal(threw, true, 'the injected failure must propagate')
    assert.match(out, /Apply failed/, 'the failure report must print for the default global target')
    assert.match(out, /already applied/)
    assert.match(out, /pantheon-opencode restore/)
    assert.equal(
      readFileSync(tmpSibling, 'utf8'),
      'x',
      'failure handling must preserve a pre-existing temp-like global file',
    )
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    rmSync(home, { recursive: true, force: true })
  }
})

test('authorized apply (--yes) emits no [DRY-RUN] plan block and writes for real', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-apply-quiet-'))
  const home = mkdtempSync(join(tmpdir(), 'pantheon-apply-quiet-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-apply-quiet-xdg-'))
  try {
    const result = spawnSync(
      process.execPath,
      [
        BIN,
        'init',
        '--project',
        '--yes',
        '--headless',
        '--version',
        'v1',
        '--no-mcp',
        '--components',
        'agents,commands',
      ],
      {
        cwd: target,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
      },
    )
    const output = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 0, `authorized apply must exit 0:\n${output}`)
    assert.doesNotMatch(output, /\[DRY-RUN\]/, 'a real apply is not dry-run tagged')
    assert.doesNotMatch(
      output,
      /No files were written\./,
      'a real apply must not claim it wrote nothing',
    )
    assert.ok(existsSync(join(target, 'opencode.json')), 'the apply actually wrote')
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})
