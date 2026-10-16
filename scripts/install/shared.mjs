/**
 * shared.mjs — Shared utilities for the OpenCode installer
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_NODE_MAJOR = 18
if (parseInt(process.versions.node.split('.')[0], 10) < REQUIRED_NODE_MAJOR) {
  console.error(`❌ Node.js >= ${REQUIRED_NODE_MAJOR} required (current: ${process.versions.node})`)
  process.exit(1)
}

import { dump, load } from 'js-yaml'

import {
  ACTIONS,
  fingerprintOutput,
  isRecording,
  recordChange,
  recordRemovalTree,
  removeReviewedTree,
} from './plan.mjs'
import {
  assertNoSymlinkAncestors,
  assertPathWithin,
  assertSafeRemoval,
  verifyPathRemoved,
  verifyRegularFile,
} from './verify.mjs'

export const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(__dirname, '..', '..')
export const AGENTS_DIR = join(ROOT, 'src', 'agents')

// Auto-detect agent names from agents/ directory
export function getAgentNames() {
  if (!existsSync(AGENTS_DIR)) return []
  return readdirSync(AGENTS_DIR)
    .filter(
      (f) => (f.endsWith('.agent.md') || f.endsWith('.md')) && f.toLowerCase() !== 'readme.md',
    )
    .map((f) => f.replace(/\.(agent\.)?md$/, ''))
    .sort()
}

// Cached constant for backward compatibility
export const AGENT_NAMES = getAgentNames()

export const summary = { opencode: { created: 0, skipped: 0, errors: 0, warnings: 0 } }

export function showHelp() {
  console.log(`
pantheon-init.mjs — Pantheon OpenCode installer

Usage:
  npx pantheon-opencode init                                        auto-detect, cwd
  npx pantheon-opencode init --project                              auto-detect, project
  npx pantheon-opencode init --project                              install in a project
  npx pantheon-opencode init --project --dry-run                    preview without writing
  npx pantheon-opencode init --project --backup                     create timestamped backup before writing
  npx pantheon-opencode init --project --clean                      wipe + fresh install (all components)
  npx pantheon-opencode init --project --clean --components agents,skills  wipe only agents+skills, reinstall
  npx pantheon-opencode init --project --components agents          install only agents (no skills/instructions)
  npx pantheon-opencode init --help                                 show this help

Components (--components):
  Comma-separated list of what to install. Default: agents,skills,instructions,commands,plugins
    agents        → agent .md files
    skills        → skill definitions (.opencode/skills/)
    instructions  → AGENTS.md + instructions/*.instructions.md
    prompts       → prompts/*.prompt.md (optional)
    commands      → .opencode/commands/*.md (OpenCode command shortcuts)

Clean mode (--clean):
  Deletes ALL existing Pantheon files for selected components, then
  re-installs fresh from source. Useful after removing/renaming agents or skills.
  OFF by default — without --clean only copies new/changed files (never deletes).

Platform:
  opencode    → .opencode/agents/ + opencode.json
`)
}

export function parseArgs(argv) {
  const args = {
    target: null,
    platforms: null,
    components: null,
    dryRun: false,
    clean: false,
    backup: false,
    help: false,
    detect: false,
  }

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--target':
        args.target = argv[++i]
        break
      case '--platforms':
        args.platforms = argv[++i].split(',').map((s) => s.trim().toLowerCase())
        break
      case '--components':
        args.components = argv[++i].split(',').map((s) => s.trim().toLowerCase())
        break
      case '--detect':
        args.detect = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--clean':
        args.clean = true
        break
      case '--backup':
        args.backup = true
        break
      case '--help':
        args.help = true
        break
      default:
        console.warn(`⚠️  Unknown option: ${argv[i]}`)
        break
    }
  }

  if (!args.target) {
    args.target = process.cwd()
  }

  // Resolve to absolute path
  args.target = resolveTarget(args.target)

  return args
}

export function resolveTarget(target) {
  // If it's already absolute, use it
  if (target.startsWith('/')) return target
  // If it's relative, resolve from cwd
  return join(process.cwd(), target)
}

export function detectAndReport(target) {
  const found = detectPlatforms(target).length > 0

  console.log(`\n  🔍 Pantheon Platform Detection`)
  console.log(`     Target: ${target}\n`)

  console.log(`  ${'Platform'.padEnd(12)} ${'Detected?'.padEnd(12)} Config file`)
  console.log(`  ${'─'.repeat(55)}`)
  const status = (found ? '✅ YES' : '❌ no').padEnd(12)
  console.log(`  ${'OpenCode'.padEnd(12)} ${status} ${found ? 'opencode.json' : '(not found)'}`)
  console.log(`\n  📊 ${found ? 1 : 0} of 1 platforms detected.`)
  if (found) {
    console.log('  → Install with: npx pantheon-opencode init')
  }

  return found ? ['opencode'] : []
}

export function detectPlatforms(target) {
  return existsSync(join(target, 'opencode.json')) ? ['opencode'] : []
}

export function sourceDirValid(dir) {
  if (!existsSync(dir)) return false
  const entries = readdirSync(dir)
  return entries.length > 0
}

export function copyFiles(srcDir, dstDir, dryRun, renameMap = null, clean = false) {
  assertNoSymlinkAncestors(dstDir)
  const entries = readdirSync(srcDir)
  let created = 0
  let skipped = 0

  // Build set of expected destination filenames (after rename)
  const dstNames = new Set()
  for (const entry of entries) {
    if (entry.toLowerCase() === 'readme.md') continue
    const srcFile = join(srcDir, entry)
    if (!existsSync(srcFile)) continue
    const dstName = renameMap ? (renameMap(entry) ?? entry) : entry
    if (dstName.toLowerCase() === 'readme.md') continue
    dstNames.add(dstName)

    const dstFile = join(dstDir, dstName)
    assertPathWithin(dstDir, dstFile)
    assertNoSymlinkAncestors(dstFile)

    if (statSync(srcFile).isDirectory()) continue
    const content = readFileSync(srcFile, 'utf8')
    const existing = existsSync(dstFile) ? readFileSync(dstFile, 'utf8') : null

    if (existing !== null) {
      if (existing === content) {
        skipped++
        continue
      }
      writeIfChanged(dstFile, content, dryRun)
      created++
    } else {
      writeIfChanged(dstFile, content, dryRun)
      created++
    }
  }

  // Remove stale Pantheon agent files from dst (opt-in via clean flag)
  // Safety: ONLY removes files whose name matches the agent file pattern
  // (lowercase name + .md/.mdc extension), regardless of AGENT_NAMES membership.
  // This handles deleted canonical agents (e.g., agora) whose source file is gone.
  if (clean && existsSync(dstDir)) {
    assertNoSymlinkAncestors(dstDir)
    const dstEntries = readdirSync(dstDir)
    const agentPattern = /^[a-z-]+\.(md|mdc)$/
    for (const entry of dstEntries) {
      if (dstNames.has(entry)) continue // still in source
      const dstFile = join(dstDir, entry)
      assertSafeRemoval(dstDir, dstFile)
      if (!statSync(dstFile).isFile()) continue
      // Safety: only remove files that match agent file naming pattern
      // (user custom files with different naming patterns are untouched)
      if (!agentPattern.test(entry)) continue
      if (!dryRun) {
        assertSafeRemoval(dstDir, dstFile)
        rmSync(dstFile, { force: true })
        verifyPathRemoved(dstFile)
      }
      created++
    }
  }

  return { created, skipped }
}

/**
 * `lstat` that returns `null` instead of throwing for an absent path.
 *
 * Deliberately `lstat`, not `stat`/`existsSync`: both of those follow the link,
 * so a DANGLING symlink reads as absent and the atomic rename below would then
 * silently replace the link itself. `lstat` sees the link and lets the write
 * guard refuse it.
 */
function lstatOrNull(filePath) {
  try {
    return lstatSync(filePath)
  } catch {
    return null
  }
}

/**
 * Read a path's raw text, or `null` when it cannot be read (absent, dangling
 * symlink target, permission error). The caller decides what "unreadable"
 * means; this never throws.
 */
function readFileOrNull(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Atomically create/overwrite a text file, skipping an unchanged write.
 *
 * @param {string} filePath - destination path
 * @param {string} content - full file content
 * @param {boolean} dryRun - when true, compute the outcome without writing
 * @param {object} [options]
 * @param {string|null} [options.expectedContent] - the raw content the caller
 *   read this path from, if any. When supplied, the write proceeds only if the
 *   on-disk content STILL matches it — compared once up front AND again
 *   immediately before the rename; otherwise it returns `'conflict'` and leaves
 *   the file alone. This is a best-effort COMPARE-BEFORE-WRITE guard, NOT a
 *   filesystem CAS: the final re-read and the rename are still two syscalls, so
 *   a writer that lands between them is not prevented. What it does close is
 *   the window the installer actually races with — a config the caller parsed
 *   going stale during the same run — and it keeps the target consistent with
 *   the bytes that were checked.
 * @param {(existing: string|null) => void} [options.beforeRecheck] - runs after
 *   the initial content check and before the last-moment re-read. Injection
 *   point so tests can simulate a concurrent writer landing in the window;
 *   production callers omit it (undefined is a no-op).
 * @param {(existing: string|null) => void} [options.beforeSwap] - runs after the
 *   expected-content checks pass and immediately before the rename, for side
 *   effects that must not fire on a conflict.
 * @param {(change: object) => void} [options.recorder] - optional change
 *   recorder. When supplied, the outcome is recorded (path + action + byte
 *   size only) so `--dry-run` can print the real per-file plan. Defaults to
 *   the module-level no-op singleton, so an uninstrumented caller is
 *   byte-identical to before.
 * @param {number} [options.mode] - mode for a newly created file; existing
 *   destination modes are preserved.
 * @param {boolean} [options.scored] - set `false` when this write is not part
 *   of the install summary (e.g. stale-ref cleanup), so it is shown in the plan
 *   but excluded from the consistency guard.
 * @returns {'created'|'skipped'|'conflict'}
 */
export function writeIfChanged(filePath, content, dryRun, options = {}) {
  const { expectedContent, beforeSwap, beforeRecheck, recorder, scored, mode } = options

  // A linked parent redirects both the atomic temp write and the eventual
  // rename, so validate the full path rather than only its final component.
  assertNoSymlinkAncestors(filePath)
  const stat = lstatOrNull(filePath)
  if (stat?.isSymbolicLink()) {
    throw new Error(`Refusing to write through symlink: ${filePath}`)
  }
  // Preserve the destination's access mode across the atomic rename. A mode
  // supplied by the caller is used only for a newly created destination.
  const targetMode = stat === null ? mode : stat.mode & 0o777

  const existing = stat === null ? null : readFileOrNull(filePath)
  const record = (outcome) => {
    if (!isRecording(recorder)) return
    const action =
      outcome === 'conflict'
        ? ACTIONS.CONFLICT
        : outcome === 'skipped'
          ? ACTIONS.UNCHANGED
          : existing === null
            ? ACTIONS.CREATE
            : ACTIONS.UPDATE
    recordChange(
      {
        path: filePath,
        action,
        bytes: Buffer.byteLength(content, 'utf8'),
        outputFingerprint: fingerprintOutput(content),
        scored,
      },
      recorder,
    )
  }
  if (existing === content) {
    record('skipped')
    return 'skipped'
  }
  if (expectedContent !== undefined && existing !== expectedContent) {
    // The file changed since the caller read it (or appeared/disappeared).
    // Do not clobber the newer content; the caller decides how to react.
    record('conflict')
    return 'conflict'
  }
  if (!dryRun) {
    // Seam for a concurrent writer to land between the read above and the
    // re-read below. No production caller passes this.
    if (typeof beforeRecheck === 'function') beforeRecheck(existing)

    // Atomic write: write a temp sibling and rename over the target so a
    // crash mid-write can never leave a truncated file behind (rename is
    // atomic within the same directory).
    const tmpPath = `${filePath}.tmp-${process.pid}`
    assertNoSymlinkAncestors(tmpPath)
    let fd
    let createdTemporary = false
    try {
      // Exclusive creation establishes ownership. Cleanup below is limited to
      // this exact path and only runs after this invocation opened it.
      fd = openSync(tmpPath, 'wx', targetMode)
      createdTemporary = true
      writeFileSync(fd, content, { encoding: 'utf8' })
      closeSync(fd)
      fd = undefined
      if (targetMode !== undefined) chmodSync(tmpPath, targetMode)

      // Last-moment re-read. The initial compare and this rename are separate
      // syscalls, so a concurrent writer can land in between; re-check the
      // expected bytes immediately before the swap. On a mismatch, leave the
      // target byte-identical; finally removes only the temp created above.
      if (expectedContent !== undefined) {
        const current = readFileOrNull(filePath)
        if (current !== expectedContent) {
          record('conflict')
          return 'conflict'
        }
      }

      if (typeof beforeSwap === 'function') beforeSwap(existing)
      assertNoSymlinkAncestors(filePath)
      renameSync(tmpPath, filePath)
      createdTemporary = false
      verifyRegularFile(filePath, content)
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Preserve the write error; closing a failed descriptor is best-effort.
        }
      }
      if (createdTemporary) {
        try {
          assertSafeRemoval(dirname(tmpPath), tmpPath)
          rmSync(tmpPath, { force: true })
          verifyPathRemoved(tmpPath)
        } catch {
          // Preserve the write error and never follow an unsafe temp path.
        }
      }
    }
  }
  record('created')
  return 'created'
}

/**
 * Write a config file atomically, honoring the compare-before-write guard.
 * This used to always keep a `<config>.bak` sidecar; the main `opencode.json`
 * no longer does — the target-scoped exact backup set
 * (scripts/install/backup.mjs) preserves it byte-for-byte and
 * `pantheon-opencode restore` reverts it.
 *
 * A caller may still supply `beforeSwap` for a file the exact set does NOT
 * cover: the GLOBAL `opencode-vision.json` lives outside the config dir, so
 * vision-prompt passes a `beforeSwap` that keeps its `<file>.bak` recovery.
 * New config files default to mode `0600`; existing destination modes survive
 * replacement.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {boolean} dryRun
 * @param {object} [options] - forwarded to {@link writeIfChanged}
 */
export function writeConfigWithBackup(filePath, content, dryRun, options = {}) {
  return writeIfChanged(filePath, content, dryRun, {
    expectedContent: options.expectedContent,
    beforeRecheck: options.beforeRecheck,
    beforeSwap: options.beforeSwap,
    recorder: options.recorder,
    scored: options.scored,
    mode: options.mode ?? 0o600,
  })
}

/**
 * beta.5 preflight: verify the toolchain pieces the runtime component needs
 * BEFORE any files are written, so a missing python3/npm fails in seconds
 * with a clear message instead of aborting a half-done install.
 * Returns a list of human-readable problems (empty = all good).
 */
export function checkRuntimePrerequisites(env = process.env) {
  const problems = []
  const checks = [
    { cmd: 'python3', hint: 'install Python 3.10+ (https://www.python.org/downloads/)' },
    { cmd: 'npm', hint: 'install Node.js 22+ (https://nodejs.org) — npm ships with it' },
  ]
  for (const { cmd, hint } of checks) {
    const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10_000, env })
    if (probe.error || probe.status !== 0) {
      problems.push(`${cmd} not found or not runnable — ${hint}`)
    }
  }
  return problems
}

export function collectSkillNames() {
  const skillsDir = join(ROOT, 'src', 'skills')
  if (!existsSync(skillsDir)) return []
  return readdirSync(skillsDir)
    .filter((entry) => {
      const entryPath = join(skillsDir, entry)
      return statSync(entryPath).isDirectory() && existsSync(join(entryPath, 'SKILL.md'))
    })
    .sort()
}

// ---------------------------------------------------------------------------
// YAML / frontmatter helpers
// ---------------------------------------------------------------------------

/**
 * Parse ---frontmatter--- + body from a markdown file.
 * Returns { fm: object, body: string } or null if no frontmatter.
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---\r?\n?([\s\S]*)$/)
  if (!match) return null
  return {
    fm: match[1].trim() ? (load(match[1]) ?? {}) : {},
    body: match[2],
  }
}

/**
 * Serialize a frontmatter object back to YAML.
 * Uses long-line mode and avoids unnecessary quoting.
 */
export function serializeFm(fm) {
  return dump(fm, {
    lineWidth: -1,
    quoteStyle: 'double',
    forceQuotes: false,
    noRefs: true,
  })
}

function recordDirectoryOutcomes(srcDir, dstDir, recorder) {
  recordChange({ path: dstDir, action: ACTIONS.UNCHANGED, bytes: 0, scored: false }, recorder)
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    recordDirectoryOutcomes(join(srcDir, entry.name), join(dstDir, entry.name), recorder)
  }
}

export function installSkills(
  skills,
  target,
  dryRun,
  subDir = '.opencode',
  recorder = null,
  reviewedRemovals = null,
  reviewedSnapshots = null,
  clean = false,
) {
  const srcSkillsDir = join(ROOT, 'src', 'skills')
  const dstSkillsDir = join(target, subDir, 'skills')
  assertNoSymlinkAncestors(dstSkillsDir)

  let created = 0
  let skipped = 0

  for (const skill of skills) {
    const src = join(srcSkillsDir, skill)
    const dst = join(dstSkillsDir, skill)

    if (!dryRun) {
      assertPathWithin(dstSkillsDir, dst)
      assertNoSymlinkAncestors(dst)
      mkdirSync(dst, { recursive: true })
      assertNoSymlinkAncestors(dst)
    }

    function copyDirRecursive(from, to) {
      const entries = readdirSync(from)
      for (const entry of entries) {
        const srcPath = join(from, entry)
        const dstPath = join(to, entry)
        if (statSync(srcPath).isDirectory()) {
          if (!dryRun) {
            assertPathWithin(dstSkillsDir, dstPath)
            assertNoSymlinkAncestors(dstPath)
            mkdirSync(dstPath, { recursive: true })
            assertNoSymlinkAncestors(dstPath)
          }
          copyDirRecursive(srcPath, dstPath)
        } else {
          const content = readFileSync(srcPath, 'utf8')
          const dstStat = lstatOrNull(dstPath)
          if (dstStat?.isSymbolicLink()) {
            throw new Error(`Refusing to read through symlink: ${dstPath}`)
          }
          const existing = dstStat === null ? null : readFileSync(dstPath, 'utf8')
          if (existing === content) {
            skipped++
            if (isRecording(recorder)) {
              recordChange(
                {
                  path: dstPath,
                  action: ACTIONS.UNCHANGED,
                  bytes: Buffer.byteLength(content, 'utf8'),
                  outputFingerprint: fingerprintOutput(content),
                },
                recorder,
              )
            }
          } else {
            if (!dryRun) {
              writeIfChanged(dstPath, content, false, { recorder })
            } else if (isRecording(recorder)) {
              recordChange(
                {
                  path: dstPath,
                  action: existing === null ? ACTIONS.CREATE : ACTIONS.UPDATE,
                  bytes: Buffer.byteLength(content, 'utf8'),
                  outputFingerprint: fingerprintOutput(content),
                },
                recorder,
              )
            }
            created++
          }
        }
      }
    }

    copyDirRecursive(src, dst)
    if (clean && existsSync(dst)) recordDirectoryOutcomes(src, dst, recorder)
  }

  // Remove stale skills that exist in dst but not in skills list
  if (existsSync(dstSkillsDir)) {
    assertNoSymlinkAncestors(dstSkillsDir)
    const dstEntries = readdirSync(dstSkillsDir)
    for (const entry of dstEntries) {
      const dstPath = join(dstSkillsDir, entry)
      assertSafeRemoval(dstSkillsDir, dstPath)
      if (!statSync(dstPath).isDirectory()) continue
      if (!skills.includes(entry)) {
        if (dryRun) {
          recordRemovalTree(dstPath, recorder)
        } else {
          assertSafeRemoval(dstSkillsDir, dstPath)
          removeReviewedTree(dstPath, reviewedRemovals, reviewedSnapshots)
          console.log(`    🗑️  Removed stale skill: ${entry}`)
        }
        created++
        // A stale removal increments `created` (a change), so it must also be
        // recorded or the preview would under-report on a non-fresh target.
        recordChange({ path: dstPath, action: ACTIONS.REMOVE, bytes: 0 }, recorder)
      }
    }
  }

  return { created, skipped }
}

export function syncDir(
  src,
  dst,
  dryRun,
  clean = false,
  filter = null,
  recorder = null,
  reviewedRemovals = null,
  reviewedSnapshots = null,
) {
  if (!existsSync(src)) return { created: 0, skipped: 0 }
  let created = 0
  let skipped = 0
  const cleanTargetExisted = clean && existsSync(dst)

  if (cleanTargetExisted) {
    if (dryRun) {
      recordRemovalTree(dst, recorder)
    } else {
      assertSafeRemoval(dirname(dst), dst)
      removeReviewedTree(dst, reviewedRemovals, reviewedSnapshots)
    }
  }

  if (!dryRun) {
    assertNoSymlinkAncestors(dst)
    mkdirSync(dst, { recursive: true })
    assertNoSymlinkAncestors(dst)
  }

  const entries = readdirSync(src)
  for (const entry of entries) {
    if (filter && !filter(entry)) continue
    const srcPath = join(src, entry)
    const dstPath = join(dst, entry)
    if (statSync(srcPath).isDirectory()) {
      const sub = syncDir(
        srcPath,
        dstPath,
        dryRun,
        false,
        filter,
        recorder,
        reviewedRemovals,
        reviewedSnapshots,
      )
      created += sub.created
      skipped += sub.skipped
    } else {
      const content = readFileSync(srcPath, 'utf8')
      const status = writeIfChanged(dstPath, content, dryRun, { recorder })
      if (status === 'skipped') {
        skipped++
      } else {
        created++
      }
    }
  }
  if (cleanTargetExisted) recordDirectoryOutcomes(src, dst, recorder)
  return { created, skipped }
}

// ---------------------------------------------------------------------------
// MCP Servers schema validation
// ---------------------------------------------------------------------------

/**
 * Schema definition for mcpServers frontmatter field.
 * Max 5 MCPs per agent, tools must reference tools in agent's tools: array.
 */
export const MCP_SERVERS_SCHEMA = {
  type: 'array',
  maxItems: 5,
  items: {
    type: 'object',
    required: ['name', 'tools', 'when'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        description: 'MCP server identifier',
      },
      tools: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'string',
          minLength: 1,
        },
        description: 'Tools this MCP provides (must exist in agent tools: array)',
      },
      when: {
        type: 'string',
        minLength: 1,
        description: 'Activation condition (e.g., "always", "on-demand")',
      },
    },
    additionalProperties: false,
  },
}

/**
 * Validate mcpServers against schema constraints.
 * @param {Array} mcpServers - The mcpServers array from agent frontmatter
 * @param {string[]} agentTools - The agent's tools: array for cross-reference validation (unused, MCP tools are external)
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMcpServers(mcpServers, _agentTools = []) {
  const errors = []

  if (!Array.isArray(mcpServers)) {
    errors.push('mcpServers must be an array')
    return { valid: false, errors }
  }

  if (mcpServers.length > 5) {
    errors.push(`mcpServers exceeds maximum of 5 (got ${mcpServers.length})`)
  }

  for (let i = 0; i < mcpServers.length; i++) {
    const mcp = mcpServers[i]
    const prefix = `mcpServers[${i}]`

    if (!mcp || typeof mcp !== 'object') {
      errors.push(`${prefix}: must be an object`)
      continue
    }

    // Required fields
    if (!mcp.name || typeof mcp.name !== 'string' || mcp.name.trim() === '') {
      errors.push(`${prefix}.name: required and must be non-empty string`)
    }

    if (!Array.isArray(mcp.tools) || mcp.tools.length === 0) {
      errors.push(`${prefix}.tools: required and must be non-empty array`)
    }

    if (!mcp.when || typeof mcp.when !== 'string' || mcp.when.trim() === '') {
      errors.push(`${prefix}.when: required and must be non-empty string`)
    }

    // Disallow additional properties
    const allowedKeys = ['name', 'tools', 'when']
    for (const key of Object.keys(mcp)) {
      if (!allowedKeys.includes(key)) {
        errors.push(`${prefix}: unexpected property "${key}"`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

export function printSummary(target, platforms) {
  console.log('')
  console.log('='.repeat(60))
  console.log('📋 Installation Summary')
  console.log(`   Target: ${target}`)
  console.log('='.repeat(60))

  let totalCreated = 0
  let totalSkipped = 0
  let totalErrors = 0

  for (const platform of platforms) {
    const label = platform === 'opencode' ? 'OpenCode' : platform
    const stats = summary[platform]
    totalCreated += stats.created
    totalSkipped += stats.skipped
    totalErrors += stats.errors

    const status = stats.errors > 0 ? '⚠️' : '✅'
    console.log(
      ` ${status} ${label}: ${stats.created} created, ${stats.skipped} skipped${stats.errors > 0 ? `, ${stats.errors} errors` : ''}`,
    )
  }

  console.log('-'.repeat(60))
  console.log(
    `   Total: ${totalCreated} files created, ${totalSkipped} files skipped, ${totalErrors} errors`,
  )

  if (totalErrors > 0) {
    console.log('   ⚠️  Some platforms had errors — review warnings above.')
  }

  console.log('')
  console.log('📖 Next Steps:')
  console.log('')

  if (platforms.includes('opencode')) {
    console.log('  OpenCode:')
    console.log(`    - Run \`opencode\` in ${target}`)
    console.log('    - Invoke agents with @agent-name in chat')
    console.log('    - To customize models: edit opencode.json')
    console.log('    - Skills are in .opencode/skills/ (auto-loaded)')
    console.log('')
  }

  console.log('  📚 Full documentation: https://github.com/ils15/pantheon')
  console.log('  🐛 Report issues: https://github.com/ils15/pantheon/issues')
}
