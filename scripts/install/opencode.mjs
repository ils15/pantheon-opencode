#!/usr/bin/env node
/**
 * opencode.mjs — OpenCode platform installer
 *
 * Dual-version install (Phase 3): V1 and V2 receive the schema each runtime
 * actually consumes. V1 (`opencode` 1.18.x) uses the singular `plugin` key;
 * V2 (`opencode2`, OpenCode 2.x — `opencode2 --version` prints
 * "opencode v2.0.22") converts that list to `plugins` before
 * writing its config. An early 2.x prerelease printed "0.0.0-next-17444"
 * instead; that is history, not what hosts report today, and it must not be
 * cited as an observation (see the precedence rationale in
 * scripts/install/opencode-version.mjs). Known V2 beta gaps handled here:
 * top-level `subagent_depth` is migrated to `experimental.subagent_depth`, and
 * the instruction content is consolidated into AGENTS.md, which both versions
 * load. Pass --version v2 to pantheon-init for an informational label.
 *
 * Nothing here isolates host STATE: both generations read one OpenCode store,
 * and the resolver in scripts/install/opencode-state.mjs (not a literal in this
 * file) is what the V2 notice reports.
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { copyAgentPrompts, writeAgentsMdManaged } from '../build-agents-md.mjs'
import { backupWarning, createBackupSet, previewBackupSet } from './backup.mjs'
import {
  bullet,
  colors,
  configure,
  gauge as createGauge,
  endGaugeLine,
  error,
  info,
  notice,
  printSummary,
  printWorktreeGuidance,
  section,
  spinner,
  step,
  success,
  tag,
  warning,
} from './cli-ui.mjs'
import {
  mergeContextSandboxBlocks,
  migrateMcpEntrypointPaths,
  migrateV1toV2,
} from './config-migration.mjs'
import { componentForInstalledPath, updateFileInventory } from './file-inventory.mjs'
import { healthCheck } from './health-check.mjs'
import { detectVersion, runMigrations } from './migrate.mjs'
import { describeSharedState } from './opencode-state.mjs'
import { DRY_RUN_PROBE_TIMEOUT_MS, resolveOpenCodeVersion } from './opencode-version.mjs'
import {
  ACTIONS,
  createRecorder,
  displayPath,
  fingerprintOutput,
  formatChangePlan,
  isRecording,
  planStatsMismatch,
  recordChange,
  recordRemovalTree,
  removeReviewedTree,
  snapshot,
  summarizeChanges,
} from './plan.mjs'
import { findPlanDrift } from './plan-artifact.mjs'
import { copyPluginFiles, installPlugin, registerPlugin, unregisterPlugin } from './plugin.mjs'
import { PROMPT_CANCELED } from './prompt-result.mjs'
import {
  checkRuntimePrerequisites,
  collectSkillNames,
  installSkills,
  parseFrontmatter,
  ROOT,
  sourceDirValid,
  summary,
  syncDir,
  writeConfigWithBackup,
  writeIfChanged,
} from './shared.mjs'
import { createInitialState, hasState, readState, setComponentState, writeState } from './state.mjs'
import { strings } from './strings.mjs'
import {
  describePluginOptionsReachability,
  formatV2CapabilityNotice,
  v2Capabilities,
} from './v2-capabilities.mjs'
import { setupVenv, venvPythonPath } from './venv.mjs'
import { assertNoSymlinkAncestors, assertPathWithin, assertSafeRemoval } from './verify.mjs'

const COMPONENT_NAMES = [
  'agents',
  'skills',
  'instructions',
  'prompts',
  'commands',
  'plugins',
  'runtime',
]

/**
 * The ordered phases one install invocation really runs, derived from the
 * FINAL component selection (the interactive wizard may have changed it) and
 * from dry-run semantics. `gauge.total` must be this length — never a fixed
 * guess — so the counter can never drift from the work.
 *
 *   * prerequisites run only on an apply with the runtime component;
 *   * the backup is planned (dry run) or created (apply);
 *   * venv setup runs in BOTH modes (a dry run reports what it would create);
 *   * the health check and the install-state write are apply-only.
 *
 * @param {{ components: Iterable<string>, dryRun: boolean }} options
 * @returns {string[]} phase labels, in execution order
 */
export function planInstallPhases({ components, dryRun }) {
  const S = strings()
  const selected = new Set(components)
  const phases = []
  if (selected.has('runtime') && !dryRun) phases.push(S.checkingPrerequisites)
  phases.push(dryRun ? S.planningBackup : S.creatingBackup)
  if (selected.has('agents')) phases.push(S.installingAgents)
  if (selected.has('skills')) phases.push(S.installingSkills)
  if (selected.has('instructions')) phases.push(S.installingInstructions)
  if (selected.has('prompts')) phases.push(S.installingPrompts)
  if (selected.has('commands')) phases.push(S.installingCommands)
  if (selected.has('plugins')) phases.push(S.installingPlugins)
  if (selected.has('runtime')) {
    phases.push(S.installingRuntime)
    phases.push(S.settingUpRuntime)
    if (!dryRun) phases.push(S.runningHealthChecks)
  }
  phases.push(S.writingConfiguration)
  if (selected.has('runtime')) phases.push(S.runningMigrations)
  if (!dryRun) phases.push(S.recordingState)
  return phases
}

/**
 * MCP server scripts the runtime component installs. Hoisted so the backup-set
 * enumeration and the runtime writer share one source of truth.
 */
const MCP_SCRIPTS = [
  'mcp_resources.py',
  'code_mode.py',
  'memory_mcp.py',
  'scrub-secrets.py',
  '_pantheon_paths.py',
  'mcp_codemap_module.py',
  'mcp_persistence.py',
  'pantheon_vision.py',
  'eval_store.py',
  'themis_heuristic_scan.py',
]

/** Recursively list regular files under `root`, relative to `root`. */
function walkFiles(root, base = root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) walkFiles(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full))
  }
  return out
}

/**
 * Enumerate what the backup set must preserve, derived from the selected
 * components. It returns:
 *   - `entries`: paths (relative to `target`) the run can CREATE/UPDATE/REMOVE.
 *     For every managed destination tree we take the UNION of the files that
 *     already exist there (so a `--clean`, a stale removal, or an
 *     instructions-only refresh is captured) and the source-derived destination
 *     paths (so a file that will be created is recorded as absent). The union is
 *     a superset of the plan's changes — unchanged files are backed up too.
 *   - `notRevertible`: paths the run may delete or write but whose byte-for-byte
 *     copy is not feasible or is out of the config dir (bulk `.venv` / plugin
 *     `node_modules`, the global `tui.json` copies and the global vision config).
 *     These are recorded explicitly in the manifest rather than silently ignored.
 * It never reads file contents.
 *
 * @param {string} target
 * @param {Set<string>} componentSet
 * @param {string} version
 * @param {boolean} isGlobal
 * @returns {{ entries: string[], notRevertible: string[] }}
 */
function collectInstallBackupEntries(target, componentSet, version, isGlobal) {
  const entries = []
  const notRevertible = []
  const rel = (abs) => relative(target, abs)
  const addFile = (abs) => entries.push(rel(abs))
  // Existing files under an in-target tree (covers removals / clean / refresh).
  // `skipDirNames` prunes bulk subdirectories (e.g. plugin `node_modules`) so the
  // walk stays cheap while everything else — including legacy files a clean pass
  // deletes — is captured.
  const addExisting = (dir, skipDirNames = null) => {
    if (!existsSync(dir)) return
    const walk = (base) => {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (skipDirNames && entry.isDirectory() && skipDirNames.has(entry.name)) continue
        const full = join(base, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) addFile(full)
      }
    }
    walk(dir)
  }
  // Destination paths derived from a source tree (covers files to be created).
  const addSource = (srcDir, dstDir, filter = null) => {
    if (!existsSync(srcDir)) return
    for (const r of walkFiles(srcDir)) {
      if (filter && !filter(r)) continue
      addFile(join(dstDir, r))
    }
  }

  const baseDir = isGlobal ? target : join(target, '.opencode')
  const agentPrefix = isGlobal || version === 'v2' ? 'agents' : '.opencode/agents'
  const agentDir = join(target, agentPrefix)

  // Always touched.
  addFile(join(target, 'opencode.json'))
  addFile(join(target, '.pantheon', 'install-state.json'))
  addFile(join(baseDir, 'opencode-vision.json'))
  // The active-preset writer (writeActivePreset(target, …)) lives at
  // <target>/.pantheon, NOT under <baseDir>, for both project and global scope.
  addFile(join(target, '.pantheon', 'active-preset.json'))
  addFile(join(target, '.pantheon', 'active-preset.json.bak'))

  // The agent prompt dir is refreshed (existing-only) by an instructions-only
  // run too, so enumerate it whenever EITHER component can write it.
  if (componentSet.has('agents') || componentSet.has('instructions')) {
    addExisting(agentDir)
  }
  if (componentSet.has('agents')) {
    addFile(join(target, 'routing.yml'))
    addSource(
      join(ROOT, 'src', 'agents'),
      agentDir,
      (r) => r.endsWith('.md') && r.toLowerCase() !== 'readme.md',
    )
  }
  if (componentSet.has('skills')) {
    addExisting(join(baseDir, 'skills'))
    addSource(join(ROOT, 'src', 'skills'), join(baseDir, 'skills'))
  }
  if (componentSet.has('instructions')) addFile(join(target, 'AGENTS.md'))
  if (componentSet.has('prompts')) {
    addExisting(join(target, 'prompts'))
    addSource(join(ROOT, 'prompts'), join(target, 'prompts'))
  }
  if (componentSet.has('commands')) {
    const commandDir = isGlobal || version === 'v2' ? 'commands' : '.opencode/commands'
    addExisting(join(target, commandDir))
    addSource(join(ROOT, 'commands'), join(target, commandDir), (r) => r.endsWith('.md'))
  }
  if (componentSet.has('plugins')) {
    const dstPluginDir = isGlobal
      ? join(target, 'plugins', 'pantheon-tui')
      : join(target, '.opencode', 'plugins', 'pantheon-tui')
    // Existing files under the installed plugin dir (legacy `index.tsx` /
    // `dist/tui.tsx` and any extras a `--clean` run deletes) are captured, like
    // every sibling tree — EXCEPT the bulk `node_modules`, which is regenerated
    // by `npm ci` and listed as not revertible.
    addExisting(dstPluginDir, new Set(['node_modules']))
    addSource(join(ROOT, 'src', 'plugins', 'tui', 'dist'), join(dstPluginDir, 'dist'))
    addFile(join(dstPluginDir, 'package.json'))
    addFile(join(dstPluginDir, 'package-lock.json'))
    addFile(join(dstPluginDir, 'tui.ts'))
    addFile(join(dstPluginDir, 'index.ts'))
    notRevertible.push(rel(join(dstPluginDir, 'node_modules')))
    if (version === 'v1') {
      const projectTui = join(baseDir, 'tui.json')
      addFile(projectTui)
      // Cross-location cleanup touches copies OUTSIDE the config dir.
      for (const loc of tuiConfigLocations(target)) {
        if (resolve(loc) !== resolve(projectTui)) notRevertible.push(loc)
      }
    }
    // V2's single terminal-client config, which this install also edits (it
    // cancels the builtin Context sidebar block). Captured so `restore` reverts
    // it byte-for-byte like every other file we touch.
    if (version === 'v2' && isGlobal) addFile(join(baseDir, V2_CLI_CONFIG_FILENAME))
  }
  if (componentSet.has('runtime')) {
    const runtimeTarget = isGlobal ? target : join(target, '.opencode')
    addExisting(join(runtimeTarget, 'scripts'))
    for (const script of MCP_SCRIPTS) addFile(join(runtimeTarget, 'scripts', script))
    addFile(join(runtimeTarget, 'requirements-vision.txt'))
    addSource(join(ROOT, '.pantheon', 'code-mode'), join(runtimeTarget, '.pantheon', 'code-mode'))
    addExisting(join(runtimeTarget, '.pantheon', 'code-mode'))
    addFile(join(runtimeTarget, '.pantheon', 'tiers.json'))
    // `--force` recreates the venv from scratch: bulk, not copied.
    notRevertible.push(rel(join(target, '.venv')))
  }

  // The vision config is written GLOBALLY (outside the config dir).
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const globalVision = join(xdg, 'opencode', 'opencode-vision.json')
  if (resolve(globalVision) !== resolve(join(baseDir, 'opencode-vision.json'))) {
    notRevertible.push(globalVision)
  }

  return { entries, notRevertible }
}

/**
 * The product defaults an install seeds into the user's `opencode.json`.
 *
 * They live HERE, in code, rather than in a template shipped in the npm
 * tarball: that template also carried a maintainer's private MCP endpoint,
 * provider models and per-developer permission overrides, and shipping it to
 * every installer was the bug (#199). Reading defaults off it meant deleting it
 * silently stopped the seeding, so the defaults are now stated next to the code
 * that consumes them.
 *
 * PERSONAL CONFIGURATION MUST NEVER BE SEEDED HERE: this is the installer's
 * contract with every user, and a value that is only right on one machine
 * belongs in that machine's own `opencode.json`. Deliberately NOT carried over
 * from the template, each because it was personal rather than a product
 * default:
 *   - `provider` — pinned the maintainer's provider, model and modalities.
 *   - `mcp` — a private remote MCP endpoint.
 *   - `agent` — the maintainer's per-agent permission overrides.
 *   - `permission.websearch: "deny"` — a personal restriction; a user may rely
 *     on web search, so denying it is not ours to decide.
 *   - `permission.bash` — the template's dev allowlist (git, npm, ruff, …), a
 *     personal judgement about which commands to trust.
 * Anything added here must be justifiable as "correct for a fresh install of
 * the product, for anyone".
 *
 * Other seeding paths are untouched by this constant and still run: the config
 * merge derives plugin refs, provider and compaction from a repository-root
 * opencode.json when a contributor has one, and separately gates its own
 * permission grants — `skill` on the skills component, `bash` unconditionally —
 * on whether the user's own config already set them.
 *
 * Frozen, and copied only into a confirmed gap (never into a key the user
 * already set), so nothing here can be mutated through a user's config.
 */
const PRODUCT_CONFIG_DEFAULTS = Object.freeze({
  default_agent: 'zeus',
})

/**
 * Per-agent fields owned by the framework: for an agent that already exists in
 * the target config these are overwritten from the canonical source, and for a
 * new agent they are the seed. Everything else on an existing entry is the
 * user's and is left alone.
 *
 * `source` is written right next to these (for both new and existing agents) but
 * is kept out of the loop so it can also be set independently — the migration in
 * config-migration.mjs mirrors this list plus `source`, and tests assert the two
 * stay equal as sets.
 *
 * KNOWN DEBT: `permission` is the V1 spelling. V2 reads `permissions`, so an
 * agent can carry both keys after an install and the V1 one becomes dead weight.
 * Tracked for the next slice; changing it here would change what an install
 * writes.
 *
 * @type {readonly string[]}
 */
export const MANAGED_FIELDS = Object.freeze([
  'temperature',
  'color',
  'permission',
  'mode',
  'hidden',
  'disable_model_invocation',
])

/**
 * The five managed MCP servers, in the ORDER the installer writes them.
 *
 * This table is the single source for both the write (`applyMcpServerEntries`)
 * and the dry-run preview: the preview names the servers this pass seeds, so
 * reordering a server here changes both in lockstep. `script` is the runtime
 * entrypoint, relative to the runtime directory.
 *
 * @type {readonly {name: string, script: string}[]}
 */
const PANTHEON_MCP_SERVER_ENTRIES = Object.freeze([
  Object.freeze({ name: 'pantheon-resources', script: 'scripts/mcp_resources.py' }),
  Object.freeze({ name: 'pantheon-code-mode', script: 'scripts/code_mode.py' }),
  Object.freeze({ name: 'pantheon-memory', script: 'scripts/memory_mcp.py' }),
  Object.freeze({ name: 'pantheon-persistence', script: 'scripts/mcp_persistence.py' }),
  Object.freeze({ name: 'pantheon-vision', script: 'scripts/pantheon_vision.py' }),
])

/** The managed server names, in write order. */
const PANTHEON_MCP_SERVERS = Object.freeze(PANTHEON_MCP_SERVER_ENTRIES.map((entry) => entry.name))

function normalizeMcpPermissionSegment(value) {
  return value.replace(/[^a-zA-Z0-9_]/g, '_')
}

/**
 * Translate an agent's `mcp_tools` frontmatter into per-tool native
 * permissions. V1 matches the original server-tool names; V2 normalizes
 * punctuation to underscores. Emitting both spellings keeps the same source
 * metadata valid for either host. Unlisted bundled Pantheon servers default to
 * deny; unrelated user MCP servers are not touched.
 *
 * @param {Record<string, 'all' | string[]>} mcpTools
 * @returns {Record<string, 'allow' | 'deny'>}
 */
export function deriveNativeMcpPermissions(mcpTools) {
  if (mcpTools === null || typeof mcpTools !== 'object' || Array.isArray(mcpTools)) {
    throw new TypeError('mcp_tools must be an object keyed by MCP server name')
  }

  const servers = new Set([...PANTHEON_MCP_SERVERS, ...Object.keys(mcpTools)])
  const permissions = {}

  for (const server of servers) {
    if (!/^[a-zA-Z0-9._-]+$/.test(server)) {
      throw new TypeError(`mcp_tools server name is invalid: ${server}`)
    }
    const tools = Object.hasOwn(mcpTools, server) ? mcpTools[server] : []
    if (
      tools !== 'all' &&
      (!Array.isArray(tools) ||
        tools.some((tool) => typeof tool !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(tool)))
    ) {
      throw new TypeError(`mcp_tools.${server} must be "all" or an array of tool names`)
    }

    const serverAliases = new Set([server, normalizeMcpPermissionSegment(server)])
    for (const alias of serverAliases) permissions[`${alias}_*`] = 'deny'
  }

  for (const server of servers) {
    const tools = Object.hasOwn(mcpTools, server) ? mcpTools[server] : []
    const serverAliases = new Set([server, normalizeMcpPermissionSegment(server)])
    if (tools === 'all') {
      for (const alias of serverAliases) permissions[`${alias}_*`] = 'allow'
      continue
    }

    for (const tool of tools) {
      const toolAliases = new Set([tool, normalizeMcpPermissionSegment(tool)])
      for (const serverAlias of serverAliases) {
        for (const toolAlias of toolAliases) {
          permissions[`${serverAlias}_${toolAlias}`] = 'allow'
        }
      }
    }
  }

  return permissions
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * (Re)generate the code-mode manifest with SHA-256 digests for every bundled
 * script, and write it to the destination. This is the explicit installation
 * opt-in: the MCP server only executes scripts listed here whose on-disk hash
 * matches. Missing or empty source approves nothing — execution is never
 * implicit.
 *
 * This function is the SINGLE owner of `manifest.json`: `syncDir` deliberately
 * excludes it (see the runtime block), so exactly one writer and one stats
 * count exist for that path. The payload is derived from the SOURCE scripts
 * (what will be installed), then compared against the CURRENT installed
 * manifest, so the preview action matches what apply writes — including on a
 * script upgrade, where the installed manifest is stale.
 *
 * @returns {{ approved: number, status: 'created'|'skipped'|'conflict'|null }}
 */
function writeCodeModeManifest(srcDir, dstDir, dryRun, recorder = null) {
  if (!existsSync(srcDir)) return { approved: 0, status: null }
  let names
  try {
    names = readdirSync(srcDir)
      .filter((name) => /\.(sh|py)$/i.test(name) && !name.startsWith('.'))
      .sort()
  } catch {
    return { approved: 0, status: null }
  }
  if (names.length === 0) return { approved: 0, status: null }
  const scripts = {}
  for (const name of names) {
    scripts[name] = createHash('sha256')
      .update(readFileSync(join(srcDir, name)))
      .digest('hex')
  }
  const payload = `${JSON.stringify({ version: 1, scripts }, null, 2)}\n`
  const status = writeIfChanged(join(dstDir, 'manifest.json'), payload, dryRun, { recorder })
  return { approved: names.length, status }
}

function readJsonConfig(filePath) {
  if (!existsSync(filePath)) return {}

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (cause) {
    throw new Error(`Invalid JSON in ${filePath}`, { cause })
  }
}

/**
 * Read a JSON config AND the exact raw text it was parsed from.
 *
 * The raw text is threaded to {@link writeConfigWithBackup} as the
 * expected-content guard, so the compare-before-rename uses the SAME bytes the
 * caller parsed — no second read that could observe a different file.
 *
 * @param {string} filePath
 * @returns {{ config: object, raw: string|null }}
 * @throws {Error} on invalid JSON (before any write happens)
 */
function readJsonConfigWithRaw(filePath) {
  if (!existsSync(filePath)) return { config: {}, raw: null }
  const raw = readFileSync(filePath, 'utf8')
  try {
    return { config: JSON.parse(raw), raw }
  } catch (cause) {
    throw new Error(`Invalid JSON in ${filePath}`, { cause })
  }
}

function mergeMissing(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target
  if (!target || typeof target !== 'object' || Array.isArray(target)) return deepClone(source)

  for (const [key, sourceVal] of Object.entries(source)) {
    const targetVal = target[key]

    if (targetVal === undefined) {
      target[key] = deepClone(sourceVal)
      continue
    }

    if (
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      mergeMissing(targetVal, sourceVal)
    }
  }

  return target
}

/**
 * Resolve a plugin ref from the repository-root opencode.json to a path INSIDE
 * the installed package.
 *
 * Only exact Pantheon plugin identities are resolved into the installed
 * package. In particular, a third-party absolute path ending in
 * `src/plugin.ts` or `src/plugins/pantheon-hooks.ts` is not evidence that the
 * plugin belongs to Pantheon and must be preserved verbatim.
 */
export function resolveInstalledPlugin(plugin) {
  if (typeof plugin !== 'string') return plugin
  const normalized = normalizePluginRef(plugin)
  if (PANTHEON_PLUGIN_IDENTITIES.has(normalized)) return join(ROOT, normalized)
  // Legacy V2 file ref (pre-directory-contract): migrate to the installed
  // plugin directory so the beta loader accepts the entry.
  if (normalized === PANTHEON_V2_LEGACY_FILE) return join(ROOT, PANTHEON_V2_PLUGIN)
  const identity = managedPluginIdentity(plugin)
  if (identity !== null && isAbsolute(normalized)) {
    return INSTALLED_PANTHEON_PLUGIN_PATHS.get(identity) ?? plugin
  }
  return plugin
}

function normalizePluginRef(ref) {
  return typeof ref === 'string' ? ref.replaceAll('\\', '/').replace(/\/$/, '') : ref
}

/**
 * Whether a path-ish plugin ref is a filesystem path rather than a package spec.
 *
 * The V2 loader treats anything that is not an obvious path as an npm/GitHub
 * spec and runs `npm install` on it — including `a/b`, which it reads as a
 * GitHub repository and fails on (`NpmInstallFailedError`). A relative path is
 * always spelled with `./` or `../`, so that spelling is the discriminator.
 *
 * @param {string} value
 * @returns {boolean}
 */
function looksLikePluginPath(value) {
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('~')) return true
  return /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Whether the OpenCode V2 loader can load a `plugins` entry EXACTLY as written.
 *
 * This is the gate for the V1→V2 migration: the V1 singular `plugin` list is
 * ignored by the V2 host, but moving an entry there into `plugins` only helps
 * when the loader accepts it. The loader's contract (documented on
 * PANTHEON_V2_PLUGIN and proven by sandbox probes) is:
 *   - a DIRECTORY containing a real index.ts/index.js loads;
 *   - a file path is rejected ("must be a directory");
 *   - a package shorthand is resolved through `npm install` and dies with
 *     NpmInstallFailedError.
 * Migrating a file path or a shorthand would therefore convert "silently
 * ignored" into "config fails to load", which is worse than leaving it alone.
 *
 * @param {unknown} entry the `plugins`/`plugin` entry
 * @param {string} configDir the config directory the loader resolves against
 * @returns {{ loadable: boolean, reason: 'directory'|'file'|'missing'|'npm-spec'|'unverifiable', resolved: string|null }}
 */
export function v2PluginEntryLoadability(entry, configDir) {
  if (typeof entry !== 'string' || entry.trim() === '') {
    return { loadable: false, reason: 'unverifiable', resolved: null }
  }
  const value = entry.trim()
  if (!looksLikePluginPath(value)) {
    return { loadable: false, reason: 'npm-spec', resolved: null }
  }
  const resolved = isAbsolute(value) ? value : resolve(configDir, value)
  if (!existsSync(resolved)) {
    return { loadable: false, reason: 'missing', resolved }
  }
  try {
    if (!statSync(resolved).isDirectory()) {
      return { loadable: false, reason: 'file', resolved }
    }
  } catch {
    return { loadable: false, reason: 'missing', resolved }
  }
  return { loadable: true, reason: 'directory', resolved }
}

/** Human explanation of a non-loadable entry, naming the exact failure mode. */
const V2_LOAD_FAILURES = {
  'npm-spec':
    'is a package/GitHub shorthand, which the V2 loader resolves through `npm install` and fails on (NpmInstallFailedError)',
  file: 'is a file, and the V2 loader only accepts a directory containing index.ts ("must be a directory")',
  missing:
    'does not exist, and the V2 loader only accepts an existing directory containing index.ts',
  unverifiable:
    'is not a path this installer can verify, so it was left untouched rather than guessed at',
}

/** Render a plugin entry for a warning without ever printing a bare object. */
function describePluginEntry(entry) {
  return typeof entry === 'string' ? entry : JSON.stringify(entry)
}

const PANTHEON_V1_PLUGIN = 'src/plugin.ts'
const PANTHEON_V1_HOOKS = 'src/plugins/pantheon-hooks.ts'
// Canonical V2 entry is the plugin DIRECTORY (beta loader contract: entries
// must be dirs with a real index.ts — file paths warn "must be a directory",
// symlinks are ignored). The shim at src/plugin-v2/index.ts re-exports the
// real entry src/plugin-v2.ts (single source of truth).
const PANTHEON_V2_PLUGIN = 'src/plugin-v2'
// Legacy V2 file ref from before the directory contract (installer + template
// used to register src/plugin-v2.ts). Still recognized for migration.
const PANTHEON_V2_LEGACY_FILE = 'src/plugin-v2.ts'
const PANTHEON_V1_EXPORT = 'pantheon-opencode/plugin'
const PANTHEON_V2_EXPORT = 'pantheon-opencode/plugin-v2'
const PANTHEON_PACKAGE_REF = /^pantheon-opencode(?:@[^/]+)?(?:\/(plugin|plugin-v2))?$/
const PANTHEON_PLUGIN_IDENTITIES = new Set([
  PANTHEON_V1_PLUGIN,
  PANTHEON_V1_HOOKS,
  PANTHEON_V2_PLUGIN,
])

const INSTALLED_PANTHEON_PLUGIN_PATHS = new Map([
  [PANTHEON_V1_PLUGIN, resolve(ROOT, PANTHEON_V1_PLUGIN)],
  [PANTHEON_V1_HOOKS, resolve(ROOT, PANTHEON_V1_HOOKS)],
  [PANTHEON_V2_PLUGIN, resolve(ROOT, PANTHEON_V2_PLUGIN)],
])

function normalizePluginPath(ref) {
  return ref.replaceAll('\\', '/')
}

function pluginMetadataReferences(ref) {
  if (typeof ref === 'string') return [ref]
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return []
  return ['package', 'id', 'name', 'path', 'source']
    .filter((key) => typeof ref[key] === 'string')
    .map((key) => ref[key])
}

function managedPluginIdentity(ref) {
  const normalized = normalizePluginRef(ref)
  if (typeof normalized !== 'string') return null

  // Older installs registered the package root itself (often pinned to a
  // beta version) in OpenCode's plural `plugins` list. Treat all exact npm
  // specs for this package as managed so an update removes the old cached
  // copy before registering the current package path. Do not match similarly
  // named third-party packages such as `pantheon-opencode-fork`.
  const packageRef = normalized.match(PANTHEON_PACKAGE_REF)
  if (packageRef !== null) {
    if (packageRef[1] === 'plugin') return PANTHEON_V1_PLUGIN
    return PANTHEON_V2_PLUGIN
  }

  if (PANTHEON_PLUGIN_IDENTITIES.has(normalized)) return normalized
  if (normalized === PANTHEON_V2_LEGACY_FILE) return PANTHEON_V2_PLUGIN
  if (normalized === PANTHEON_V1_EXPORT || normalized.startsWith(`${PANTHEON_V1_EXPORT}@`)) {
    return PANTHEON_V1_PLUGIN
  }
  if (normalized === PANTHEON_V2_EXPORT || normalized.startsWith(`${PANTHEON_V2_EXPORT}@`)) {
    return PANTHEON_V2_PLUGIN
  }

  if (isAbsolute(normalized)) {
    const absolutePath = normalizePluginPath(resolve(normalized))
    for (const [identity, installedPath] of INSTALLED_PANTHEON_PLUGIN_PATHS) {
      if (absolutePath === normalizePluginPath(installedPath)) return identity
    }
    // Legacy absolute V2 file path inside OUR installed package (pre-
    // directory-contract installs) migrates to the directory identity.
    // ROOT-scoped: third-party paths ending in src/plugin-v2.ts stay theirs.
    if (absolutePath === normalizePluginPath(resolve(ROOT, PANTHEON_V2_LEGACY_FILE))) {
      return PANTHEON_V2_PLUGIN
    }
    // beta.5: stale refs from OTHER installed copies of this package (older
    // nvm prefixes, npx cache hashes). Only paths inside
    // `node_modules/pantheon-opencode/` count as installed copies — a dev
    // checkout elsewhere (e.g. a vendor folder named pantheon-opencode) remains
    // protected by the third-party rule above.
    const installedMarker = '/node_modules/pantheon-opencode/'
    const withSlashes = normalizePluginPath(normalized)
    const markerIndex = withSlashes.lastIndexOf(installedMarker)
    if (markerIndex !== -1) {
      const suffix = withSlashes.slice(markerIndex + installedMarker.length)
      if (suffix === PANTHEON_V1_PLUGIN) return PANTHEON_V1_PLUGIN
      if (suffix === PANTHEON_V1_HOOKS) return PANTHEON_V1_HOOKS
      if (suffix === PANTHEON_V2_PLUGIN) return PANTHEON_V2_PLUGIN
      if (suffix === PANTHEON_V2_LEGACY_FILE) return PANTHEON_V2_PLUGIN
    }
  }

  return null
}

/**
 * Return the stable identity for a Pantheon plugin, or its normalized path.
 * Basenames are deliberately not used: unrelated user plugins may share a
 * filename such as `plugin.ts`.
 */
export function pluginReferenceIdentity(ref) {
  const references = pluginMetadataReferences(ref)
  for (const reference of references) {
    const identity = managedPluginIdentity(reference)
    if (identity !== null) return identity
  }
  if (references.length > 0) return normalizePluginPath(normalizePluginRef(references[0]))
  return ref
}

function isPantheonPluginReference(ref) {
  return PANTHEON_PLUGIN_IDENTITIES.has(pluginReferenceIdentity(ref))
}

function removePantheonPluginReferences(refs) {
  return (Array.isArray(refs) ? refs : []).filter((ref) => !isPantheonPluginReference(ref))
}

function hasPluginReference(refs, candidate) {
  const identity = pluginReferenceIdentity(candidate)
  return refs.some((ref) => pluginReferenceIdentity(ref) === identity)
}

export function deduplicatePluginReferences(refs) {
  const seen = new Set()
  return (Array.isArray(refs) ? refs : []).filter((ref) => {
    const identity = pluginReferenceIdentity(ref)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

/**
 * Duplicate the V1 top-level `context_sandbox` block into the exact Pantheon V2
 * plugin entry's `options`, converting a plain-string entry into the
 * `{ package, options }` object form the host accepts.
 *
 * Why the copy is required: OpenCode V2.0.25 silently drops a top-level
 * `context_sandbox` key (probe evidence in the module header of
 * config-migration.mjs), so the V1 setting would be lost on a V1→V2 install.
 * The V1 top-level block is LEFT IN PLACE so a downgrade keeps working.
 *
 * Precedence is delegated to {@link mergeContextSandboxBlocks}: an explicit V2
 * option leaf wins, the legacy block fills only unset leaves, and the runtime
 * resolver supplies defaults. Only the Pantheon V2 entry is touched — every
 * other plugin entry, and every other option on this entry, is preserved.
 *
 * The managed V2 option is ALWAYS validated — even when no legacy V1 block is
 * present — because the migration is the only place that validates it. An
 * earlier version returned early on `legacySandbox === undefined`, so an
 * explicit `plugins[].options.context_sandbox` of `null` (or any type-invalid
 * known value) was never checked and persisted straight to disk.
 *
 * @param {unknown[]} plugins - V2 `plugins` array (mutated in place)
 * @param {unknown} legacySandbox - V1 top-level `context_sandbox` (may be undefined)
 * @returns {unknown[]} the same array
 * @throws {Error} when the legacy block or the existing V2 option is null or
 *   type-invalid (checked before any config write)
 */
export function applyContextSandboxToV2Plugins(plugins, legacySandbox) {
  if (!Array.isArray(plugins)) return plugins

  const index = plugins.findIndex((ref) => pluginReferenceIdentity(ref) === PANTHEON_V2_PLUGIN)
  if (index === -1) return plugins

  const entry = plugins[index]
  const isObjectEntry = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  const hasOptions =
    isObjectEntry &&
    typeof entry.options === 'object' &&
    entry.options !== null &&
    !Array.isArray(entry.options)
  const existingOptions = hasOptions ? entry.options : {}
  const hasExistingSandbox = Object.hasOwn(existingOptions, 'context_sandbox')

  // Nothing managed to migrate OR validate: leave the entry untouched so a
  // re-install stays a true no-op. `legacySandbox === undefined` covers an
  // absent V1 key; `!hasExistingSandbox` covers a V2 entry with no managed
  // option yet. An explicit `null` is a PRESENT key (`hasExistingSandbox`), so
  // it is deliberately NOT skipped and must be validated below.
  if (legacySandbox === undefined && !hasExistingSandbox) return plugins

  // Run the managed option through the validator unconditionally, merging the
  // legacy block in only when it exists. A null/type-invalid existing option
  // throws here, BEFORE the config is written.
  const mergedSandbox = mergeContextSandboxBlocks(existingOptions.context_sandbox, legacySandbox)
  const packageId = isObjectEntry ? entry.package : entry

  // Rebuild the entry as an object so the options survive a V2 host (which
  // preserves plugin option objects verbatim).
  plugins[index] = {
    package: packageId,
    options: { ...existingOptions, context_sandbox: mergedSandbox },
  }
  return plugins
}

export { parseOpenCodeVersion, resolveOpenCodeVersion } from './opencode-version.mjs'

/**
 * Detect whether `target` is the user's global OpenCode installation directory
 * (~/.opencode or $XDG_CONFIG_HOME/opencode).
 * Global installs use a flat layout: agents/ skills/ commands/ plugins/
 * Project installs use the .opencode/ sub-directory layout.
 */
export function isGlobalConfigDir(target) {
  // Primary: ~/.opencode (actual OpenCode installation)
  const homeDir = resolve(join(homedir(), '.opencode'))
  if (resolve(target) === homeDir) return true

  // Fallback: $XDG_CONFIG_HOME/opencode (legacy/alternative)
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const xdgDir = resolve(join(xdgConfig, 'opencode'))
  return resolve(target) === xdgDir
}

/**
 * Derive where the TUI plugin must be COPIED for a given config directory.
 *
 * The TUI plugin's single source of truth is src/plugins/tui inside the
 * package; the loader must NEVER be pointed at that in-package dir (a package
 * reinstall/upgrade replaces the dir under a live registration and leaves
 * diverging copies loading). Instead the installer always copies it into the
 * config dir's plugins/ dir and uses THAT copy:
 *
 *   <configDir>/plugins/pantheon-tui      (tui.ts + dist/ + package manifests)
 *
 * V1 registers that copy through tui.json. V2 discovers the local plugin's
 * index.ts + tui.ts pair; the V2 shim re-exports dist/tui-v2.js.
 *
 * @param {string} configDir - OpenCode config directory (target for global
 *   installs, <target>/.opencode for project installs)
 * @returns {string} absolute path of the copied plugin directory
 */
export function resolveTuiCopyTarget(configDir) {
  return join(configDir, 'plugins', 'pantheon-tui')
}

/**
 * Every tui.json location OpenCode reads: the two global config dirs
 * (~/.opencode and $XDG_CONFIG_HOME/opencode) plus the target's own project
 * config. Cleanup runs over ALL of them so a stale Pantheon TUI registration
 * can never survive in a location the loader still reads.
 *
 * @param {string} target - install target directory
 * @returns {string[]} unique tui.json paths (deterministic order)
 */
export function tuiConfigLocations(target) {
  const homeTui = join(homedir(), '.opencode', 'tui.json')
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const xdgTui = join(xdgConfig, 'opencode', 'tui.json')
  const projectTui = join(target, '.opencode', 'tui.json')
  return [...new Set([homeTui, xdgTui, projectTui])]
}

/**
 * V2 terminal-client config filename. V2 replaced the layered V1 `tui.json(c)`
 * files with ONE GLOBAL client config (`~/.config/opencode/cli.json`); there is
 * no project-local equivalent, so this file only ever lives in a config dir
 * that is a global host config dir.
 */
export const V2_CLI_CONFIG_FILENAME = 'cli.json'

/**
 * Builtin V2 sidebar plugin that renders the Context block.
 *
 * Pantheon's TUI plugin renders its OWN Context block, so leaving the builtin
 * enabled draws the block twice (nativo + nosso). The host cancels a plugin
 * through an EXACT `-<id>` entry in the client config's `plugins` array; a
 * wildcard (`-opencode.sidebar.*`) would also disable the mcp and footer blocks,
 * so it is never used here.
 */
export const CONTEXT_SIDEBAR_NEGATION = '-opencode.sidebar.context'

/**
 * Bundle the V2 host loads from the copied TUI plugin dir (relative to it).
 *
 * The capability check below must read the bytes the host will ACTUALLY load,
 * i.e. the copy under the config dir — never the in-package build artifact,
 * which a package upgrade replaces independently of what was deployed.
 */
export const TUI_V2_BUNDLE_RELATIVE_PATH = 'dist/tui-v2.js'

/**
 * Stable marker proving the deployed TUI bundle renders Pantheon's own Context
 * block.
 *
 * It is a named export of the bundle (`export { ..., contextBlockRows, ... }`).
 * ESM export names are the module's public interface and CANNOT be mangled by
 * tsdown/rolldown (or any minifier): mangling renames only non-exported
 * bindings, because consumers resolve exports by name. The bundle also cannot
 * tree-shake it away — the sidebar imports it, and
 * `tests/tui-v2-sidebar.test.mjs` imports it from `dist/tui-v2.js`, so a build
 * that drops the export fails the suite.
 *
 * A rebuild that changes the block's user-facing copy or internals keeps the
 * export; only a rewrite that REMOVES the block drops it — which is exactly
 * when the builtin Context block must stay enabled.
 */
export const CONTEXT_BLOCK_BUNDLE_MARKER = 'contextBlockRows'

/**
 * Path of the V2 TUI bundle inside an installed config dir.
 *
 * @param {string} configDir - OpenCode config directory
 * @returns {string} absolute path of the copied `dist/tui-v2.js`
 */
export function resolveInstalledTuiBundlePath(configDir) {
  return join(resolveTuiCopyTarget(configDir), TUI_V2_BUNDLE_RELATIVE_PATH)
}

/**
 * Pure capability test: does this bundle text provide Pantheon's Context block?
 *
 * Deliberately a plain byte scan: the answer must not depend on importing the
 * bundle (the host API it needs is absent while installing).
 *
 * @param {unknown} bundleText - contents of the deployed `dist/tui-v2.js`
 * @returns {{ ok: boolean, reason: string }} `reason` is empty when `ok`
 */
export function bundleProvidesContextBlock(bundleText) {
  if (typeof bundleText !== 'string') {
    return { ok: false, reason: 'the TUI bundle could not be read as text' }
  }
  if (!new RegExp(`\\b${CONTEXT_BLOCK_BUNDLE_MARKER}\\b`).test(bundleText)) {
    return {
      ok: false,
      reason:
        `the deployed TUI bundle has no "${CONTEXT_BLOCK_BUNDLE_MARKER}" export, so it ` +
        'predates the Pantheon Context block',
    }
  }
  return { ok: true, reason: '' }
}

/**
 * Inspect the TUI bundle that the host will load for the given config dir.
 *
 * A dry run copies nothing, so it evaluates the in-package build artifact
 * instead (what WOULD be deployed) and only falls back to an existing deployed
 * copy — a preview must not report a capability failure that the real run
 * would not have.
 *
 * @param {string} configDir - OpenCode config directory
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {{ ok: boolean, reason: string, bundlePath: string }}
 */
export function inspectContextBlockCapability(configDir, { dryRun = false } = {}) {
  const installedPath = resolveInstalledTuiBundlePath(configDir)
  const sourcePath = join(ROOT, 'src', 'plugins', 'tui', TUI_V2_BUNDLE_RELATIVE_PATH)
  const bundlePath = dryRun && !existsSync(installedPath) ? sourcePath : installedPath
  let bundleText
  try {
    bundleText = readFileSync(bundlePath, 'utf8')
  } catch (cause) {
    return {
      ok: false,
      bundlePath,
      reason: `${bundlePath} is missing or unreadable (${cause.code ?? cause.message})`,
    }
  }
  return { ...bundleProvidesContextBlock(bundleText), bundlePath }
}

/**
 * Remove {@link CONTEXT_SIDEBAR_NEGATION} from a V2 `plugins` array, preserving
 * every other entry and its order. Only the EXACT directive is removed: the
 * host honors nothing else, and a wildcard would also cancel the mcp and
 * footer blocks.
 *
 * Idempotent: an array without the directive is returned untouched.
 *
 * @param {unknown} plugins - current `plugins` value (may be absent or invalid)
 * @returns {{ plugins: unknown[], changed: boolean }}
 */
export function withContextSidebarEnabled(plugins) {
  const current = Array.isArray(plugins) ? plugins : []
  const next = current.filter((entry) => entry !== CONTEXT_SIDEBAR_NEGATION)
  return { plugins: next, changed: next.length !== current.length }
}

/**
 * Append {@link CONTEXT_SIDEBAR_NEGATION} to a V2 `plugins` array while
 * preserving every existing entry (plain strings and `{ package, options }`
 * objects) and their order.
 *
 * Idempotent: when the exact directive is already present the array is returned
 * untouched, so a second `init` never duplicates it.
 *
 * @param {unknown} plugins - current `plugins` value (may be absent or invalid)
 * @returns {{ plugins: unknown[], changed: boolean }}
 */
export function withContextSidebarDisabled(plugins) {
  const current = Array.isArray(plugins) ? plugins : []
  if (current.includes(CONTEXT_SIDEBAR_NEGATION)) return { plugins: current, changed: false }
  return { plugins: [...current, CONTEXT_SIDEBAR_NEGATION], changed: true }
}

/**
 * Reconcile the builtin Context sidebar block in the V2 terminal-client config
 * with the deployed TUI bundle.
 *
 * Cancelling the builtin block is only safe when the deployed bundle really
 * draws Pantheon's replacement (see {@link bundleProvidesContextBlock});
 * negating against a stale bundle removed the Context block from the sidebar
 * entirely. So the negation tracks the capability on EVERY run:
 *
 *   capability present  → add the exact negation (or leave it in place);
 *   capability absent   → remove a previously written negation, keeping the
 *                         native readout working, and warn with the reason and
 *                         the rebuild/redeploy step.
 *
 * Only the `plugins` array is merged; the rest of the user's `cli.json` (theme,
 * session, keybinds, anything else) is preserved verbatim, key order included,
 * and the write is skipped byte-for-byte when the array is already correct.
 * A file that cannot be parsed — or whose `plugins` is not an array — is NEVER
 * overwritten: the caller reports a warning and the install continues, because
 * clobbering a hand-edited client config is worse than a duplicated block.
 *
 * @param {string} configDir - config dir holding cli.json (global config dir)
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {(change: object) => void} [options.recorder=null] - preview recorder
 * @param {(message: string) => void} [options.warn] - warning sink
 * @param {{ ok: boolean, reason: string } | null} [options.capability=null]
 *   pre-computed verdict (tests/preview); inspected from disk when omitted
 * @returns {'created'|'removed'|'skipped'|'unverified'|'invalid'|'conflict'}
 */
export function applyContextSidebarNegation(
  configDir,
  { dryRun = false, recorder = null, warn = warning, capability = null } = {},
) {
  const cliConfigPath = join(configDir, V2_CLI_CONFIG_FILENAME)
  let config = {}
  let raw = null
  if (existsSync(cliConfigPath)) {
    raw = readFileSync(cliConfigPath, 'utf8')
    try {
      config = JSON.parse(raw)
    } catch {
      warn(
        `Left ${cliConfigPath} untouched: it is not valid JSON, so the builtin Context ` +
          'sidebar block stays enabled (it may render twice alongside the Pantheon block).',
      )
      return 'invalid'
    }
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    warn(`Left ${cliConfigPath} untouched: expected a JSON object at the top level.`)
    return 'invalid'
  }
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
    // Never replace a value we do not understand: the user may have written it
    // by hand in a shape a future host accepts.
    warn(`Left ${cliConfigPath} untouched: its "plugins" value is not an array.`)
    return 'invalid'
  }

  // The host only honours the exact directive, so `next` never invents one.
  const verdict = capability ?? inspectContextBlockCapability(configDir, { dryRun })
  const next = verdict.ok
    ? withContextSidebarDisabled(config.plugins)
    : withContextSidebarEnabled(config.plugins)
  const removing = !verdict.ok && next.changed

  if (!verdict.ok) {
    // A silent negation here is the bug this check exists for: the native
    // readout disappears and nothing replaces it.
    warn(
      `Builtin Context sidebar block left ENABLED: ${verdict.reason}. ` +
        (removing
          ? `Removed ${CONTEXT_SIDEBAR_NEGATION} from ${cliConfigPath} so the native block ` +
            'keeps rendering. '
          : '') +
        'Rebuild the TUI bundle (npm run build --prefix src/plugins/tui) and redeploy ' +
        'pantheon-tui, then re-run init to de-duplicate the Context block.',
    )
  }
  if (!next.changed) return verdict.ok ? 'skipped' : 'unverified'
  config.plugins = next.plugins

  const content = `${JSON.stringify(config, null, 2)}\n`
  const status = writeConfigWithBackup(cliConfigPath, content, dryRun, {
    expectedContent: raw,
    recorder,
  })
  if (status === 'conflict') {
    warn(
      `Left ${cliConfigPath} untouched: it changed on disk during the install. ` +
        'Re-run init to disable the builtin Context sidebar block.',
    )
    return 'conflict'
  }
  if (status !== 'created') return 'skipped'
  return removing ? 'removed' : 'created'
}

/**
 * Sync the Pantheon TUI plugin payload and V1 registration. V2 discovers the
 * copied local-plugin entrypoints and does not use a project tui.json.
 *
 * Contract (single source of truth):
 *   1. ALWAYS copy src/plugins/tui → <configDir>/plugins/pantheon-tui with the
 *      selected host entrypoints and compiled bundle. The copy is idempotent.
 *   2. Clean stale Pantheon TUI refs from ALL tui.json locations OpenCode
 *      loads — ~/.opencode, $XDG_CONFIG_HOME/opencode and
 *      <target>/.opencode — covering every old reference shape: dist file
 *      paths, in-package src/plugins/tui dirs, bare plugins/pantheon-tui
 *      copies, and npx paths. A stale ref left in the non-target location
 *      would still be loaded and break the TUI.
 *   3. V1 registers the copied directory in the selected target. V2 relies on
 *      local-plugin discovery and does not write a project tui.json entry.
 *
 * @param {string} target - install target directory
 * @param {object} [opts]
 * @param {boolean} [opts.isGlobal=false] - flat global layout vs .opencode/
 * @param {boolean} [opts.dryRun=false]
 * @param {(change: object) => void} [opts.recorder] - optional change recorder for preview
 * @returns {'created'|'skipped'} status for the target registration
 */
export function syncTuiRegistration(
  target,
  {
    isGlobal = false,
    dryRun = false,
    version = 'v1',
    recorder = null,
    reviewedRemovals = null,
    reviewedSnapshots = null,
  } = {},
) {
  const configDir = isGlobal ? target : join(target, '.opencode')
  const targetTuiConfigPath = join(configDir, 'tui.json')

  // 1. Copy the host-specific plugin into the target config's
  //    plugins/pantheon-tui. This keeps the installed entry hermetic.
  const tuiSrcDir = join(ROOT, 'src', 'plugins', 'tui')
  const tuiCopyDir = resolveTuiCopyTarget(configDir)
  // Fail closed: silently skipping the copy left `plugins` "installed" with no
  // payload — the host then loads a tui.json entry that points at nothing.
  if (!existsSync(tuiSrcDir)) {
    throw new Error(
      `Pantheon TUI plugin source not found: ${tuiSrcDir}. The package payload is ` +
        'incomplete — reinstall pantheon-opencode (the published tarball must ship ' +
        'src/plugins/tui), then re-run init.',
    )
  }
  const copyResult = copyPluginFiles(tuiSrcDir, tuiCopyDir, {
    dryRun,
    version,
    recorder,
    reviewedRemovals,
    reviewedSnapshots,
  })
  if (copyResult.errors > 0) {
    throw new Error(
      `${copyResult.problems[0] ?? `TUI plugin payload could not be copied to ${tuiCopyDir}.`}`,
    )
  }

  // 2. Clean stale Pantheon TUI refs from every location OpenCode reads.
  //    unregisterPlugin covers the bare relative id plus the extended stale
  //    patterns (dist files, identifiable in-package paths, owned copied
  //    directories, relative ids, and npx package identities).
  for (const tuiConfigPath of tuiConfigLocations(target)) {
    const configDirForPath = dirname(tuiConfigPath)
    const ownedCopy = resolveTuiCopyTarget(configDirForPath)
    unregisterPlugin(tuiConfigPath, 'plugins/pantheon-tui', {
      dryRun,
      knownPantheonPaths: [ownedCopy, tuiCopyDir],
      recorder,
    })
  }

  // OpenCode V2 discovers local plugins from the config plugins directories;
  // its TUI plugin API is exposed by the sibling tui.ts entrypoint. V1 still
  // requires the explicit tui.json registration.
  if (version === 'v2') return 'skipped'

  // 3. Register the copied directory in the selected target only.
  return registerPlugin(targetTuiConfigPath, tuiCopyDir, { dryRun, recorder })
}

/**
 * beta.5: set up the Python venv + run the health check. Never throws —
 * failures are reported as warnings and return false so the caller omits
 * MCP entries from the config (entries pointing at a missing venv would
 * make every MCP fail to launch). `deps` is injectable for tests.
 */
export function setupRuntimePhase(
  target,
  {
    dryRun,
    clean,
    isGlobal,
    recorder = null,
    reviewedRemovals = null,
    reviewedSnapshots = null,
    onVenvDone = null,
    onHealthDone = null,
  },
  stats,
  deps = {},
) {
  const S = strings()
  const setup = deps.setupVenv ?? setupVenv
  const check = deps.healthCheck ?? healthCheck
  let stopProgress
  try {
    stopProgress = spinner(S.settingUpRuntime)
    try {
      setup(target, {
        dryRun,
        force: clean,
        recorder,
        reviewedRemovals,
        reviewedSnapshots,
      })
    } finally {
      // Count the phase even when setup throws: it DID run (and failed). The
      // failure is reported below as a warning, not as a missing phase.
      onVenvDone?.()
    }
    stopProgress(true)
    stopProgress = null

    // A dry run creates no venv and installs no dependencies, so there is
    // nothing to verify yet. Running the health check here reported the
    // PRE-install target as broken and flipped runtimeHealthy=false, which
    // silently dropped every MCP entry from the previewed plan while the real
    // apply wrote them. Say what will happen instead of probing.
    if (dryRun) {
      info(S.runtimeVerifiedAfterApply)
      return true
    }

    const runtimeTarget = isGlobal ? target : join(target, '.opencode')
    let health
    try {
      health = check(runtimeTarget, { dryRun, pythonTarget: target })
    } finally {
      onHealthDone?.()
    }

    section(S.healthSection)
    stopProgress = step(S.runningHealthChecks)
    for (const p of health.passed) success(`${p.check}: ${p.detail}`)
    for (const w of health.warnings) warning(`${w.check}: ${w.detail}`)
    for (const f of health.failed) error(`${f.check}: ${f.detail}`)

    if (health.failed.length > 0) {
      stopProgress(false)
      stopProgress = null
      warning(`${health.failed.length} check(s) failed — review above`)
      stats.warnings += health.failed.length
      return false
    }
    stopProgress(true)
    stopProgress = null
    return true
  } catch (err) {
    stopProgress?.(false)
    error(S.runtimeFailed(err.message))
    warning(S.runtimeSkippedMcp)
    stats.warnings += 1
    return false
  }
}

/**
 * Write the five managed MCP server entries into `config`, healing any stale
 * entrypoint paths first.
 *
 * The heal runs on EVERY install, not only when an entry is missing: the
 * per-server guards below are add-only, so an existing install whose
 * `opencode.json` still carries a pre-rename `*_server.py` path would never be
 * repaired. Healing first means a re-run of the installer fixes an orphaned
 * config in place — the migration that makes the rename non-breaking.
 *
 * @param {object} config - full config object (mutated in place)
 * @param {{ runtimeTarget: string, venvPython: string, version?: 'v1' | 'v2' }} ctx
 * @returns {{ healed: number, warnings: string[], servers: string[] }} number of
 *   stale path strings rewritten, one warning per MCP permission the host
 *   cannot enforce, and the server names this call actually seeded (write
 *   order) — the dry-run preview reports exactly these
 */
export function applyMcpServerEntries(config, { runtimeTarget, venvPython, version = 'v2' }) {
  config.mcp = config.mcp || {}
  // MCP stays a flat named-server map for BOTH V1 and V2: OpenCode 1.18.x has
  // no `mcp.servers` wrapper and rejects one with "Missing key
  // mcp.servers.enabled". config-migration.mjs normalizes any legacy
  // wrapper-shaped entries back to the flat map.
  const healed = migrateMcpEntrypointPaths(config.mcp)

  // Only add if not already configured by user.
  const servers = []
  for (const entry of PANTHEON_MCP_SERVER_ENTRIES) {
    if (config.mcp[entry.name]) continue
    config.mcp[entry.name] = {
      type: 'local',
      cwd: runtimeTarget,
      command: [venvPython, entry.script],
      enabled: true,
    }
    servers.push(entry.name)
  }

  // Default MCP permissions.
  //
  // WARNING: on OpenCode 2.x, `permission.mcp.<server>` is NOT enforced. The
  // host evaluates an MCP call as the action `<server>_<tool>` with resources
  // ["*"]; `permission.mcp.<server>` and `action:"mcp"` are inert (measured on
  // 2.0.29–2.1.3). These defaults are kept for V1 compatibility, but `ask` does
  // not prompt and `allow` grants nothing it did not already have — every `ask`
  // server below is reported to the user as unenforced. The enforceable form is
  // `{ action: "<server>_*", resource: "*", effect: "deny" }`; `ask` there
  // HIDES the tool instead of asking, so it is never emitted as a default.
  config.permission = config.permission || {}
  config.permission.mcp = config.permission.mcp || {}
  if (!config.permission.mcp['pantheon-resources']) {
    config.permission.mcp['pantheon-resources'] = 'allow'
  }
  if (!config.permission.mcp['pantheon-code-mode']) {
    config.permission.mcp['pantheon-code-mode'] = 'ask'
  }
  if (!config.permission.mcp['pantheon-memory']) {
    config.permission.mcp['pantheon-memory'] = 'allow'
  }
  if (!config.permission.mcp['pantheon-persistence']) {
    config.permission.mcp['pantheon-persistence'] = 'allow'
  }
  if (!config.permission.mcp['pantheon-vision']) {
    config.permission.mcp['pantheon-vision'] = 'ask'
  }

  // Report every `ask` entry, whether just seeded or left by a previous
  // install: the config claims a gate the host does not apply. V1's MCP
  // permission semantics were not measured, so the warning is V2-only.
  const S = strings()
  const warnings =
    version === 'v2'
      ? Object.entries(config.permission.mcp)
          .filter(([, effect]) => effect === 'ask')
          .map(([server]) => S.mcpAskNotEnforceable(server))
      : []

  return { healed, warnings, servers }
}

/**
 * Phase 4 drift detection: the planned targets whose on-disk state changed
 * between the plan pass (snapshots) and the apply pass. A path counts as drifted
 * when its existence, content hash, size, or mode differs — which includes a
 * planned-NEW path that now exists. Returns the absolute paths (empty = no
 * drift); callers print only these paths, never contents or hashes.
 */
function detectSnapshotDrift(snapshots) {
  if (!Array.isArray(snapshots)) return []
  const changed = []
  for (const before of snapshots) {
    const now = snapshot(before.path)
    if (
      now.exists !== before.exists ||
      now.sha256 !== before.sha256 ||
      now.size !== before.size ||
      now.mode !== before.mode
    ) {
      changed.push(before.path)
    }
  }
  return changed
}

/**
 * Phase 5 failure semantics. `installPass` is the whole installer; this thin
 * wrapper reports a mid-apply failure HONESTLY: it aborts the remaining writes
 * (the throw), relies on each writer to clean up only its own temporary file,
 * reports the PATHS already applied (never contents), prints the recovery
 * path, and re-throws so the CLI exits non-zero. There is NO automatic rollback — the
 * exact backup set + `pantheon-opencode restore` is the recovery.
 *
 * Progress is tracked in `_lastRun` (set only by a non-dry pass, so the nested
 * dry plan pass never clobbers it). The RESOLVED target is read back from
 * `_lastRun.target` so the report and the sweep work when the caller passed
 * `undefined` (the default global install resolves to `~/.config/opencode`).
 */
let _lastRun = null
// The gauge of the install currently running (never the nested plan pass), so
// an exception can close it with `✖ reason` instead of leaving a half line.
let _activeGauge = null

export async function installOpenCode(
  target,
  dryRun = false,
  clean = false,
  components = ['agents', 'skills', 'instructions', 'commands', 'plugins', 'runtime'],
  opts = {},
) {
  // Reset per-call so a stale run can never leak into a fresh failure report.
  if (!dryRun) _lastRun = null
  // The installer is a PROGRESS surface: the gauge replaces per-step logs
  // unless --verbose asks for them back. Doctor and the other CLIs never set
  // verbose, so their output is untouched; restore it on the way out.
  const previousUi = configure({ verbose: opts.verbose === true })
  try {
    return await installPass(target, dryRun, clean, components, opts)
  } catch (err) {
    _activeGauge?.fail(err instanceof Error ? err.message : String(err))
    const run = dryRun ? null : _lastRun
    if (run) {
      const S = strings()
      const paths = summarizeChanges(run.entries ?? [])
        .files.filter((f) => f.action !== ACTIONS.UNCHANGED && f.action !== ACTIONS.CONFLICT)
        .map((f) => displayPath(run.target, f.path))
      error(S.applyFailed(err instanceof Error ? err.message : String(err)))
      if (paths.length > 0) {
        warning(S.alreadyApplied)
        for (const p of paths) warning(`  ${p}`)
      }
      warning(run.backupDir ? S.restoreRecoveryHint(run.backupDir) : S.restoreNoBackup)
    }
    throw err
  } finally {
    // An early return (canceled/declined preview) leaves the gauge mid-line on
    // a TTY; clear it without claiming completion. `done()`/`fail()` already
    // set `finished`, so this is a no-op on every normal path.
    if (_activeGauge && !_activeGauge.finished) _activeGauge.cancel()
    _activeGauge = null
    configure(previousUi)
  }
}

async function installPass(
  target,
  dryRun = false,
  clean = false,
  components = ['agents', 'skills', 'instructions', 'commands', 'plugins', 'runtime'],
  opts = {},
) {
  // Default target if not provided (global ~/.config/opencode)
  if (!target) {
    target = join(homedir(), '.config', 'opencode')
  }

  const componentSet = new Set(
    opts.noMcp ? components.filter((component) => component !== 'runtime') : components,
  )
  const stats = summary.opencode
  // Per-call baseline. `stats` is the module-level cumulative summary, so the
  // consistency guard must compare against THIS call's delta, not the total.
  const statsBefore = { created: stats.created, skipped: stats.skipped }
  // Number of planned changes, filled by a dry plan pass (used by the gate).
  let plannedChanges = 0
  let planFiles = []
  let planTotals = null
  let removalPaths = []
  // MCP servers this pass seeds into opencode.json, in write order. Filled by
  // applyMcpServerEntries so the preview names exactly what the apply writes.
  let mcpServers = []
  const planTimestamp = opts.planTimestamp ?? new Date().toISOString()
  let projectedState = null
  // Phase 4: planned-target snapshots from the plan pass, used for drift checks.
  let plannedSnapshots = null
  let reviewedRemovals = null
  let reviewedSnapshots = null
  const S = strings()

  // Configure the UI channel BEFORE any output: the version resolver below
  // warns when a dry run skips the host probe, and a quiet preview (doctor's
  // internal preflight, --json) must not print it. Quiet used to be applied
  // much later, so that one warning escaped every silent preview.
  configure({ dryRun, quiet: opts.quiet === true })

  // Beta 11 (Setup phase 1): a dry pass records every writer's intended change
  // so we can print the REAL per-file plan without writing anything. A recorder
  // ALWAYS runs now: a dry pass builds the preview/plan from it, and an apply
  // pass uses it to report which PATHS were already written if a writer throws
  // (Phase 5 failure semantics). The default is the module-level no-op recorder,
  // so an uninstrumented caller stays byte-identical.
  const ownRecorder = opts.recorder ? null : createRecorder()
  const preview = dryRun && ownRecorder ? ownRecorder : null
  let recorder = opts.recorder ?? ownRecorder.recorder
  // Test-only failure seam: throw after N recorded writes so the failure path is
  // deterministic. Never reachable from production callers (opts.deps is not a
  // CLI flag) and never applied to the internal dry plan pass.
  if (!dryRun && typeof opts.deps?.failAfter === 'number') {
    const base = recorder
    const limit = opts.deps.failAfter
    let applied = 0
    recorder = (change) => {
      base(change)
      if (++applied >= limit) throw new Error('injected failure (test-only failAfter seam)')
    }
  }
  // Track this apply so the wrapper can report the paths written on a failure.
  if (!dryRun) _lastRun = { target, entries: ownRecorder?.entries ?? [], backupDir: null }

  // V1/V2 dual-version awareness (Phase 3): the installer builds a unified
  // config, then applies V2-native migration (migrateV1toV2) when
  // --opencode-version=v2. V2 normalizes V1 fields in memory (no rewrite).
  // Neither generation isolates state: both read the same OpenCode store, so
  // the V2 notice reports the path an actual resolver returns instead of a
  // literal, and claims no service port because nothing binds one.
  // Default to 'auto' so a flagless run resolves against the actual host. A
  // hardcoded 'v1' here (or in bin/pantheon-init.mjs) is what shipped the bug:
  // the V1 branch writes .ts file paths that a 2.x host drops from the config.
  // `opts` is forwarded as the resolver's options bag so a caller (and CI) can
  // pin env/probe instead of spawning a real host binary.
  //
  // A DRY RUN probes the host too. It used to pass `skipProbe` and assume V1,
  // so `init --dry-run` on a 2.x host previewed the V1 plan (target `tui.json`,
  // removed `index.ts`) while the apply wrote `index.ts` and no `tui.json` —
  // a preview that contradicted the apply. The probe runs in a throwaway state
  // directory, and the dry run bounds it with the shorter
  // DRY_RUN_PROBE_TIMEOUT_MS so a hanging host cannot stall a preview. When the
  // probe still fails, V1 is assumed and `versionAssumed` marks the plan as
  // such (text + --json).
  let versionFallback = null
  const version = resolveOpenCodeVersion(opts.version ?? 'auto', {
    ...opts,
    probeTimeoutMs: dryRun ? DRY_RUN_PROBE_TIMEOUT_MS : undefined,
    onFallback: (reason) => {
      versionFallback = reason
    },
  })
  if (version === 'v2' && opts.preset) {
    throw new Error(
      '--preset is not supported for OpenCode V2 because V2 ignores the legacy active-preset marker. ' +
        'Configure models using V2-native OpenCode configuration instead.',
    )
  }
  const versionAssumed = dryRun && versionFallback !== null
  // Both V2 notices belong to the run the USER started, not to the internal
  // plan pass the gate spawns. That pass runs with the same output channel, so
  // an ungated notice printed twice on the unauthorized-preview path (`init`
  // without --yes: plan pass, then the outer apply pass, both loud). The
  // sibling `warning()` for a sibling opencode.jsonc is gated the same way;
  // a real --dry-run is not a plan pass, so it still prints them once.
  if (version === 'v2' && !opts.planOnly) {
    // The notice states only what this installer actually does and what the
    // host actually reads. It previously claimed an isolated state database and
    // a dedicated service port: nothing in this package sets OPENCODE_DB, no
    // install creates a per-generation file, nothing binds that port, and the
    // repo's own database consumer documents the opposite
    // (src/pantheon/cost-command.ts). The path below comes from the shared
    // resolver, so the sentence cannot drift from the code.
    notice(`OpenCode V2 target — ${describeSharedState()}`)
    // Say what the V2 contract gives you AND what it does not, at the moment
    // the user picks it. "Reduced surface" alone is misleading in both
    // directions: V2 registers real hooks, transforms and events, and it also
    // drops the goal tools. The not-registered half is the same SEED
    // `getUnsupportedFeatures()` is built from (imported, never restated), so
    // this notice cannot drift from what the plugin reports; the notice says
    // so, because the live list is a superset that grows at runtime. Advisory:
    // a V2 install is a supported configuration, not a failure.
    notice(formatV2CapabilityNotice())
  }

  // Interactive mode handling
  const stdinTTY = process.stdin.isTTY && process.stdout.isTTY
  const forceInteractive = opts.interactive === true
  const forceHeadless = opts.headless === true
  const autoYes = opts.yes === true
  const interactive = forceInteractive || (stdinTTY && !forceHeadless)

  if (interactive && !dryRun) {
    const { runInteractiveInstall } = await import('./interactive.mjs')
    const hasRequestedComponents = Array.isArray(opts.requestedComponents)
    const promptComponents = hasRequestedComponents ? opts.requestedComponents : components
    const promptDefaults = hasRequestedComponents
      ? []
      : opts.noMcp
        ? COMPONENT_NAMES.filter((component) => component !== 'runtime')
        : COMPONENT_NAMES
    const result = await runInteractiveInstall({
      components: promptComponents,
      defaultComponents: promptDefaults,
      noMcp: opts.noMcp === true,
      prompts: opts.deps?.prompts,
      isTTY: opts.deps?.isTTY,
    })

    // Resolve the location from the SELECTION before any cancel return: a
    // cancel after the user picked "Current project" must record that
    // directory, not the global default the caller would fall back to. The
    // recorded target is where the user was installing, not where a file was
    // written (nothing was written either way).
    const selectedTarget = result.target === 'project' ? process.cwd() : target

    if (result.canceled) {
      // The named point is what makes the message explainable. The interactive
      // module already printed the single cancel line through the prompt
      // library's own cancel channel, so printing another one here was the
      // duplicate the issue reports: the user saw the same sentence twice and
      // learned nothing about WHERE it stopped.
      return {
        ...stats,
        applied: false,
        reason: 'canceled',
        cancelPoint: result.cancelPoint ?? 'components',
        target: selectedTarget,
      }
    }

    if (!result.confirmed) {
      // Answering "No" at the pre-install confirmation is not the prompt
      // library's cancel channel, so nothing was printed yet: this is the one
      // message, and it names the point.
      notice(S.canceledAt(S.cancelPoints.confirmation))
      return {
        ...stats,
        applied: false,
        reason: 'canceled',
        cancelPoint: 'confirmation',
        target: selectedTarget,
      }
    }

    // Map target selection to actual path
    const newComponents = [...result.components].filter(
      (component) => !opts.noMcp || component !== 'runtime',
    )
    componentSet.clear()
    for (const c of newComponents) componentSet.add(c)

    target = selectedTarget
  }

  // Product defaults live in code (PRODUCT_CONFIG_DEFAULTS). A repository-root
  // opencode.json is a contributor's PERSONAL dev harness, not product data, so
  // it must never be read just because it happens to exist: doing so silently
  // injects the developer's provider/plugins/compaction into every config an
  // install generates. The merge is therefore opt-in only, via
  // --merge-dev-config <path>. Absent the flag, no root-level config is read.
  const mergeDevConfigOpt = opts.mergeDevConfig ?? null
  if (mergeDevConfigOpt !== null && typeof mergeDevConfigOpt !== 'string') {
    throw new Error('mergeDevConfig requires a file path string')
  }
  const pantheonConfigPath =
    typeof mergeDevConfigOpt === 'string' ? resolve(mergeDevConfigOpt) : null
  const targetConfigPath = join(target, 'opencode.json')
  // The installer reads and writes ONLY `opencode.json`, but the V2 host also
  // loads a sibling `opencode.jsonc` and unions arrays from both. A Pantheon
  // entry there is invisible to this installer, so a "second config" is a real
  // ambiguity the user has to resolve — name it instead of leaving the two
  // files to disagree silently.
  const siblingJsonc = join(target, 'opencode.jsonc')
  const configAdvisories = []
  if (version === 'v2' && existsSync(siblingJsonc)) {
    configAdvisories.push(
      `Both ${targetConfigPath} and ${siblingJsonc} exist and an OpenCode V2 host merges ` +
        'them (scalars from the .jsonc win, arrays are unioned). The installer reads and ' +
        'writes only opencode.json, so anything plugin-related in the .jsonc — including a ' +
        'Pantheon entry — is neither seen nor changed by this install. Move those entries ' +
        'into opencode.json and delete the .jsonc, or edit both by hand.',
    )
    // The internal plan pass is not a user-facing report; the apply pass (and a
    // real --dry-run) prints it once.
    if (!opts.planOnly) warning(configAdvisories[0])
  }
  const { config, raw: configRaw } = readJsonConfigWithRaw(targetConfigPath)
  const pantheonConfig =
    pantheonConfigPath !== null && existsSync(pantheonConfigPath)
      ? readJsonConfig(pantheonConfigPath)
      : null

  // beta.5 preflight: fail BEFORE any files are written when the runtime
  // component needs toolchain pieces that are missing. Nothing has been
  // copied yet at this point, so the failure is clean.
  if (componentSet.has('runtime') && !dryRun) {
    const missing = checkRuntimePrerequisites()
    if (missing.length > 0) {
      for (const problem of missing) error(problem)
      throw new Error(S.prereqMissing)
    }
  }

  // V1 project installs use the legacy .opencode/agents layout. OpenCode V2's
  // active config directory is the project root and its agent loader scans
  // <config-dir>/{agent,agents}/**, so V2 project agents must be at ./agents.
  // Global installs are flat for both versions.
  const isGlobal = opts.global ?? isGlobalConfigDir(target)
  const _subDir = isGlobal ? '' : '.opencode'
  const agentPrefix = isGlobal || version === 'v2' ? 'agents' : '.opencode/agents'

  // -----------------------------------------------------------------------
  // Plan pass + apply gate + drift check (Beta 11 Setup phases 3-4).
  //   * the plan pass (a dry run — writes nothing) prints the plan and
  //     snapshots every planned target;
  //   * applying requires explicit authorization (Phase 3): a declined or
  //     unauthorized run writes NOTHING;
  //   * drift (Phase 4) aborts BEFORE any write if a planned target changed
  //     between the plan pass and now.
  // A result with `applied: false` means the caller must not print success.
  // -----------------------------------------------------------------------
  const applyRequested = !dryRun
  if (applyRequested) {
    const savedStats = { ...stats }
    let planned
    try {
      // Use the LIVE selection: the wizard above may have changed componentSet.
      // An AUTHORIZED apply (`--yes`) is not a preview: compute the plan +
      // snapshots but stay silent. The gate path (no `--yes`) still prints the
      // plan for the review / decline preview.
      planned = await installOpenCode(target, true, clean, [...componentSet], {
        ...opts,
        // Hand the RESOLVED generation to the plan pass. Re-resolving would
        // probe the host a second time and could land on a different answer
        // (a transient probe failure), making the plan disagree with the
        // apply it is about to authorize.
        version,
        planTimestamp,
        planOnly: true,
        quiet: autoYes,
        quietPlan: autoYes,
      })
    } finally {
      Object.assign(stats, savedStats)
      // The plan pass left the UI in dry-run mode; restore this run's mode.
      configure({ dryRun, quiet: opts.quiet === true })
    }
    plannedSnapshots = planned?.snapshots ?? null

    if (opts.expectedPlan) {
      const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
      const drift = findPlanDrift(opts.expectedPlan, {
        target,
        packageRoot: ROOT,
        packageVersion,
        files: planned?.files ?? [],
        snapshots: planned?.snapshots ?? [],
      })
      if (drift.length > 0) {
        warning('Reviewed install plan drifted; no files were written.')
        for (const item of drift) warning(`  ${item}`)
        return { ...stats, applied: false, reason: 'drift', drift }
      }
    }

    if (!autoYes) {
      const injected = opts.deps?.promptReview
      const canPrompt = typeof injected === 'function' || interactive
      if (canPrompt) {
        const { promptReview } = await import('./interactive.mjs')
        const ask = typeof injected === 'function' ? injected : promptReview
        const accepted = await ask(`Apply these ${planned?.planned ?? 0} changes?`, {
          default: false,
          prompts: opts.deps?.prompts,
          isTTY: opts.deps?.isTTY,
        })
        if (accepted === PROMPT_CANCELED) {
          // The real prompt already printed the one cancel line through clack's
          // own cancel channel. An INJECTED reviewer (tests, other callers)
          // prints nothing, so this is the single place that guarantees the
          // message exists exactly once, and it names the point.
          if (typeof injected === 'function') notice(S.canceledAt(S.cancelPoints.review))
          return { ...stats, applied: false, reason: 'canceled', cancelPoint: 'review' }
        }
        if (!accepted) {
          // Answering "No" is not a cancel: it used to reach the caller as a
          // silent `reason: 'declined'` and exit 0 with "Nothing applied." and
          // no explanation at all.
          notice(S.declinedAt(S.cancelPoints.review))
          return { ...stats, applied: false, reason: 'declined', cancelPoint: 'review' }
        }
      } else {
        notice(S.planOnlyNoYes)
        return { ...stats, applied: false, reason: 'not-authorized' }
      }
    }

    // Test seam: mutate a target between the plan/authorization and the drift
    // check. Absent in production callers.
    if (typeof opts.deps?.betweenPlanAndApply === 'function') opts.deps.betweenPlanAndApply()

    const drifted = detectSnapshotDrift(plannedSnapshots)
    if (drifted.length > 0) {
      warning(S.driftHeader)
      for (const p of drifted) warning(`  ${displayPath(target, p)}`)
      warning(S.driftAbort)
      return {
        ...stats,
        applied: false,
        reason: 'drift',
        drift: drifted.map((p) => displayPath(target, p)),
      }
    }
    reviewedRemovals = new Set((planned?.removals ?? []).map((filePath) => resolve(filePath)))
    reviewedSnapshots = new Map(
      (plannedSnapshots ?? []).map((before) => [resolve(before.path), before]),
    )
  }

  // -----------------------------------------------------------------------
  // Progress gauge: the user sees progress, not a log. The phase list is
  // derived from the FINAL component selection, so total == work performed.
  // `--verbose` keeps the old step-by-step output and draws no gauge; the
  // internal plan pass (`planOnly`) never owns the terminal.
  // -----------------------------------------------------------------------
  const phases = planInstallPhases({ components: componentSet, dryRun })
  let phaseCursor = 0
  const progress =
    opts.planOnly || opts.verbose === true ? null : createGauge({ total: phases.length })
  if (progress) _activeGauge = progress
  const advancePhase = (label) => {
    const phase = label ?? phases[phaseCursor]
    // Defensive: a phase that the code path skipped must not reprint the last
    // label at the clamped counter.
    if (phase === undefined) return
    phaseCursor += 1
    progress?.advance(1, phase)
  }
  // Prerequisites already ran above (apply + runtime only); account for it.
  if (phases[0] === S.checkingPrerequisites) advancePhase()

  // -----------------------------------------------------------------------
  // 0. Exact backup (Beta 11 Setup phase 2): preserve the CURRENT state of
  //    every regular file this run can modify/remove INSIDE the config dir,
  //    byte-for-byte, BEFORE the first modifying write. Bulk directories and
  //    out-of-target global files are recorded in the manifest as
  //    `notRevertible`. A dry run records the planned backup-manifest path only.
  // -----------------------------------------------------------------------
  if (componentSet.has('agents')) {
    const agentTarget = join(target, agentPrefix)
    assertPathWithin(target, agentTarget)
    assertNoSymlinkAncestors(agentTarget)
  }
  if (componentSet.has('skills')) {
    const skillsTarget = isGlobal ? join(target, 'skills') : join(target, '.opencode', 'skills')
    assertPathWithin(target, skillsTarget)
    assertNoSymlinkAncestors(skillsTarget)
  }
  const backupPlan = collectInstallBackupEntries(target, componentSet, version, isGlobal)
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  if (dryRun) {
    const preview = previewBackupSet({
      configDir: target,
      entries: backupPlan.entries,
      notRevertible: backupPlan.notRevertible,
      packageVersion: pkgVersion,
      clock: () => new Date(planTimestamp),
    })
    if (isRecording(recorder)) {
      for (const file of preview.files) {
        recordChange(
          {
            path: file.path,
            action: ACTIONS.CREATE,
            bytes: file.bytes,
            outputFingerprint: file.outputFingerprint,
            scored: false,
          },
          recorder,
        )
      }
      recordChange(
        {
          path: preview.manifestPath,
          action: ACTIONS.CREATE,
          bytes: preview.manifestBytes,
          outputFingerprint: preview.manifestFingerprint,
          scored: false,
        },
        recorder,
      )
    }
  } else {
    const backupStep = step(S.creatingBackup)
    const { dir: backupDir } = createBackupSet({
      configDir: target,
      entries: backupPlan.entries,
      notRevertible: backupPlan.notRevertible,
      packageVersion: pkgVersion,
      clock: () => new Date(planTimestamp),
    })
    backupStep(true)
    if (_lastRun && _lastRun.target === target) _lastRun.backupDir = backupDir
    // Secret-safe: the path only. The exact wording is fixed (once per apply).
    // Close the gauge line first: this notice must never be appended to it.
    endGaugeLine()
    console.warn(backupWarning(backupDir))
  }
  advancePhase()

  if (isGlobal) {
    info(S.globalLayout)
  }

  // -----------------------------------------------------------------------
  // 1. Install agents (--components agents)
  // -----------------------------------------------------------------------
  if (componentSet.has('agents')) {
    section('Agents')
    const srcDir = join(ROOT, 'src', 'agents')
    if (!sourceDirValid(srcDir)) {
      warning(`Agent source directory not found: ${srcDir}`)
      stats.errors++
    } else {
      const agentStep = step(S.installingAgents)
      const dstDir = join(target, agentPrefix)
      assertPathWithin(target, dstDir)
      assertNoSymlinkAncestors(dstDir)
      if (!dryRun) {
        mkdirSync(dstDir, { recursive: true })
        assertNoSymlinkAncestors(dstDir)
      }
      if (clean && existsSync(dstDir)) {
        assertNoSymlinkAncestors(dstDir)
        const existing = readdirSync(dstDir)
        for (const f of existing) {
          const agentPath = join(dstDir, f)
          assertSafeRemoval(dstDir, agentPath)
          if (dryRun) {
            recordRemovalTree(agentPath, recorder)
          } else {
            removeReviewedTree(agentPath, reviewedRemovals, reviewedSnapshots)
          }
        }
      }
      const { created, skipped } = copyAgentPrompts(srcDir, dstDir, dryRun, false, recorder)
      stats.created += created
      stats.skipped += skipped
      agentStep(true)
    }
  }

  // -----------------------------------------------------------------------
  // 1.5 Install routing.yml (routing configuration)
  // -----------------------------------------------------------------------
  if (componentSet.has('agents')) {
    const srcRouting = join(ROOT, 'src', 'routing.yml')
    const dstRouting = join(target, 'routing.yml')
    if (existsSync(srcRouting)) {
      const routingStatus = writeIfChanged(dstRouting, readFileSync(srcRouting, 'utf8'), dryRun, {
        recorder,
      })
      if (routingStatus === 'created') stats.created++
      else stats.skipped++
    }
  }
  if (componentSet.has('agents')) advancePhase()

  // -----------------------------------------------------------------------
  // 2. Install skills (--components skills)
  // -----------------------------------------------------------------------
  if (componentSet.has('skills')) {
    section('Skills')
    const skillNames = collectSkillNames()
    if (skillNames.length > 0) {
      const skillStep = step(`Installing ${skillNames.length} skills`)
      const dstSkillsDir = isGlobal ? join(target, 'skills') : join(target, '.opencode', 'skills')
      assertPathWithin(target, dstSkillsDir)
      assertNoSymlinkAncestors(dstSkillsDir)
      if (clean && existsSync(dstSkillsDir)) {
        assertNoSymlinkAncestors(dstSkillsDir)
        const existing = readdirSync(dstSkillsDir)
        for (const s of existing) {
          const skillPath = join(dstSkillsDir, s)
          assertSafeRemoval(dstSkillsDir, skillPath)
          if (dryRun) {
            recordRemovalTree(skillPath, recorder)
          } else {
            removeReviewedTree(skillPath, reviewedRemovals, reviewedSnapshots)
          }
        }
      }
      const installSubDir = isGlobal ? '' : '.opencode'
      const { created: sCreated, skipped: sSkipped } = installSkills(
        skillNames,
        target,
        dryRun,
        installSubDir,
        recorder,
        reviewedRemovals,
        reviewedSnapshots,
        clean,
      )
      stats.created += sCreated
      stats.skipped += sSkipped
      skillStep(true)
    }
  }
  if (componentSet.has('skills')) advancePhase()

  // -----------------------------------------------------------------------
  // 2.5 Install shared instructions: AGENTS.md (--components instructions)
  // -----------------------------------------------------------------------
  // Both AGENTS.md artifacts are managed regions (scripts/build-agents-md.mjs).
  // A GLOBAL config dir receives the repo-agnostic global artifact (agent
  // table + shared rules); a PROJECT layout keeps the repository artifact.
  // writeAgentsMdManaged is conservative: content outside the managed region
  // is never deleted, and a legacy fully-generated file upgrades in place.
  if (componentSet.has('instructions')) {
    section('Instructions')
    const srcAgentsMd = isGlobal ? join(ROOT, 'AGENTS.global.md') : join(ROOT, 'AGENTS.md')
    const dstAgentsMd = join(target, 'AGENTS.md')
    if (existsSync(srcAgentsMd)) {
      const content = readFileSync(srcAgentsMd, 'utf8')
      const status = writeAgentsMdManaged(dstAgentsMd, content, dryRun, recorder)
      if (status === 'skipped') stats.skipped++
      else {
        stats.created++
        if (status === 'merged') {
          warning(
            `AGENTS.md had non-generated content — it was preserved around the ` +
              `Pantheon managed region in ${dstAgentsMd}. Review and merge manually.`,
          )
        }
      }
    } else {
      warning(`AGENTS.md artifact not found in the package: ${srcAgentsMd}`)
      stats.errors++
    }
    // An instruction-only upgrade must also refresh selective guidance on
    // already-installed Pantheon agents, but must not create agents the user
    // did not install. Full agent installs do this in phase 1 above.
    if (!componentSet.has('agents')) {
      const installedAgents = join(target, agentPrefix)
      const sourceAgents = join(ROOT, 'src', 'agents')
      if (existsSync(installedAgents) && existsSync(sourceAgents)) {
        const refreshed = copyAgentPrompts(sourceAgents, installedAgents, dryRun, true, recorder)
        stats.created += refreshed.created
        stats.skipped += refreshed.skipped
      }
    }
  }
  if (componentSet.has('instructions')) advancePhase()

  // -----------------------------------------------------------------------
  // 2.6 Install prompts (--components prompts)
  // -----------------------------------------------------------------------
  if (componentSet.has('prompts')) {
    section('Prompts')
    const srcPrompts = join(ROOT, 'prompts')
    const dstPrompts = join(target, 'prompts')
    if (existsSync(srcPrompts)) {
      const promptsResult = syncDir(
        srcPrompts,
        dstPrompts,
        dryRun,
        clean,
        null,
        recorder,
        reviewedRemovals,
        reviewedSnapshots,
      )
      stats.created += promptsResult.created
      stats.skipped += promptsResult.skipped
    }
  }
  if (componentSet.has('prompts')) advancePhase()

  // -----------------------------------------------------------------------
  // 2.7 Install commands (--components commands)
  // -----------------------------------------------------------------------
  if (componentSet.has('commands')) {
    section('Commands')
    const srcCmds = join(ROOT, 'commands')
    // V2 project sandboxes use OPENCODE_CONFIG_DIR=<project root>, so OpenCode
    // discovers custom commands from <target>/commands. V1 project installs
    // keep the standard .opencode/commands layout; global installs are flat.
    const commandDir = isGlobal || version === 'v2' ? 'commands' : '.opencode/commands'
    const dstCmds = join(target, commandDir)
    if (existsSync(srcCmds)) {
      const cmdResult = syncDir(
        srcCmds,
        dstCmds,
        dryRun,
        clean,
        (f) => f.endsWith('.md'),
        recorder,
        reviewedRemovals,
        reviewedSnapshots,
      )
      stats.created += cmdResult.created
      stats.skipped += cmdResult.skipped
    }
  }
  if (componentSet.has('commands')) advancePhase()

  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // 2.7 subagent_depth is merged into opencode.json in the config section
  // below (always runs) — see "Ensure critical top-level config sections".
  // Previously this was a separate block gated on the config file already
  // existing, so a FRESH install only gained subagent_depth on the SECOND
  // init run (idempotence bug, issue #19).
  // -----------------------------------------------------------------------

  // 2.8 Install TUI plugins (--components plugins)
  // -----------------------------------------------------------------------
  if (componentSet.has('plugins')) {
    section('Plugins')
    const srcPluginDir = join(ROOT, 'src', 'plugins', 'tui')
    const dstPluginDir = isGlobal
      ? join(target, 'plugins', 'pantheon-tui')
      : join(target, '.opencode', 'plugins', 'pantheon-tui')
    const pluginStats = installPlugin(srcPluginDir, dstPluginDir, {
      dryRun,
      clean,
      version,
      recorder,
      reviewedRemovals,
      reviewedSnapshots,
    })
    stats.created += pluginStats.created
    stats.skipped += pluginStats.skipped
    stats.errors += pluginStats.errors
    for (const problem of pluginStats.problems ?? []) error(problem)
  }

  // -----------------------------------------------------------------------
  // 2.9 Create/update tui.json with plugin registration (--components plugins)
  // -----------------------------------------------------------------------
  if (componentSet.has('plugins')) {
    let tuiStatus
    try {
      tuiStatus = syncTuiRegistration(target, {
        isGlobal,
        dryRun,
        version,
        recorder,
        reviewedRemovals,
        reviewedSnapshots,
      })
    } catch (cause) {
      error(`TUI plugin setup failed: ${cause.message}`)
      stats.errors++
      throw new Error('TUI plugin setup failed; installation was not completed', { cause })
    }
    if (tuiStatus === 'created') stats.created++
    else stats.skipped++
  }
  // -----------------------------------------------------------------------
  // 2.9b V2 terminal-client config: cancel the builtin Context sidebar block
  // -----------------------------------------------------------------------
  // The directive belongs in the V2 client config, which exists ONLY globally
  // (V2 has no project-local client config), so a project install must not
  // create one. Keeping it in the installer is what makes the de-duplication
  // durable: a hand edit in ~/.config/opencode/cli.json would be lost as soon as
  // the user re-runs init, and the Context block would render twice again.
  if (componentSet.has('plugins') && version === 'v2' && isGlobal) {
    try {
      const cliStatus = applyContextSidebarNegation(target, { dryRun, recorder })
      if (cliStatus === 'created') stats.created++
      else if (cliStatus === 'removed' || cliStatus === 'unverified') stats.warnings++
      else stats.skipped++
    } catch (cause) {
      // A client config we cannot update is not a failed install: the plugin
      // payload and the host config are already in place.
      warning(`Could not disable the builtin Context sidebar block: ${cause.message}`)
      stats.warnings++
    }
  }
  if (componentSet.has('plugins')) advancePhase()

  // -----------------------------------------------------------------------
  // 2.10 Install runtime infrastructure (--components runtime)
  //      MCP server scripts, code-mode scripts, tiers.json
  // -----------------------------------------------------------------------
  if (componentSet.has('runtime')) {
    section('Runtime')
    const runtimeTarget = isGlobal ? target : join(target, '.opencode')

    // ── MCP server scripts ──
    const mcpScripts = MCP_SCRIPTS
    const srcScriptsDir = join(ROOT, 'scripts')
    // Canonical MCP server sources live in src/mcp/. Map them explicitly so the
    // sync always copies from the canonical source, never from the stale root
    // scripts/ copies (which previously propagated bugs like the missing
    // `import uuid` in mcp_persistence.py). scrub-secrets.py is not in
    // src/mcp/ and intentionally falls back to join(ROOT, 'scripts').
    const canonicalMcpScripts = {
      'mcp_resources.py': join(ROOT, 'src', 'mcp', 'mcp_resources.py'),
      'code_mode.py': join(ROOT, 'src', 'mcp', 'code_mode.py'),
      'memory_mcp.py': join(ROOT, 'src', 'mcp', 'memory_mcp.py'),
      '_pantheon_paths.py': join(ROOT, 'src', 'mcp', '_pantheon_paths.py'),
      'mcp_codemap_module.py': join(ROOT, 'src', 'mcp', 'mcp_codemap_module.py'),
      'mcp_persistence.py': join(ROOT, 'src', 'mcp', 'mcp_persistence.py'),
      'pantheon_vision.py': join(ROOT, 'src', 'mcp', 'pantheon_vision.py'),
      'eval_store.py': join(ROOT, 'src', 'mcp', 'eval_store.py'),
    }
    const dstScriptsDir = join(runtimeTarget, 'scripts')
    if (!dryRun) mkdirSync(dstScriptsDir, { recursive: true })
    for (const script of mcpScripts) {
      const src = canonicalMcpScripts[script] || join(srcScriptsDir, script)
      if (!existsSync(src)) {
        warning(`Script not found: ${src}`)
        stats.errors++
        continue
      }
      const content = readFileSync(src, 'utf8')
      const dst = join(dstScriptsDir, script)
      const status = writeIfChanged(dst, content, dryRun, { recorder })
      if (status === 'created') {
        stats.created++
        // Make executable
        if (!dryRun) {
          try {
            chmodSync(dst, 0o755)
          } catch {
            /* non-critical */
          }
        }
      } else stats.skipped++
    }

    // Keep Vision's dependency contract available to the installed runtime.
    const visionRequirements = join(ROOT, 'src', 'mcp', 'requirements-vision.txt')
    if (existsSync(visionRequirements)) {
      const destination = join(runtimeTarget, 'requirements-vision.txt')
      const status = writeIfChanged(destination, readFileSync(visionRequirements, 'utf8'), dryRun, {
        recorder,
      })
      if (status === 'created') stats.created++
      else stats.skipped++
    } else {
      warning(`Requirements file not found: ${visionRequirements}`)
      stats.errors++
    }

    // ── Code-mode scripts ──
    const srcCodeModeDir = join(ROOT, '.pantheon', 'code-mode')
    const dstCodeModeDir = join(runtimeTarget, '.pantheon', 'code-mode')
    if (existsSync(srcCodeModeDir)) {
      // manifest.json is owned by writeCodeModeManifest (below), not by the dir
      // sync. Excluding it here keeps exactly ONE writer/count for that path,
      // so the preview action and the install summary can never diverge.
      const cmResult = syncDir(
        srcCodeModeDir,
        dstCodeModeDir,
        dryRun,
        clean,
        (f) => f !== 'manifest.json',
        recorder,
        reviewedRemovals,
        reviewedSnapshots,
      )
      stats.created += cmResult.created
      stats.skipped += cmResult.skipped
    } else {
      // The code-mode payload ships inside the published tarball
      // (package.json `files` includes .pantheon/code-mode/**). When it is
      // absent, still create the runtime dir so the code-mode MCP server has
      // a stable home, and warn loudly instead of silently skipping.
      warning(`Code-mode source not found: ${srcCodeModeDir} — creating empty ${dstCodeModeDir}`)
      if (!dryRun) mkdirSync(dstCodeModeDir, { recursive: true })
      stats.created++
      // The empty runtime dir is a real create counted by `stats.created`, so
      // record it too (or the preview under-reports on this fallback path).
      recordChange({ path: dstCodeModeDir, action: ACTIONS.CREATE, bytes: 0 }, recorder)
    }

    // B3-08: explicit installation mode — seed the manifest with SHA-256
    // digests so the server never executes a script implicitly.
    const manifest = writeCodeModeManifest(srcCodeModeDir, dstCodeModeDir, dryRun, recorder)
    if (manifest.status === 'created') stats.created++
    else if (manifest.status === 'skipped') stats.skipped++
    if (manifest.approved > 0) {
      info(`Code-mode manifest: ${manifest.approved} script(s) approved`)
    }

    // ── tiers.json ──
    const srcTiers = join(ROOT, '.pantheon', 'tiers.json')
    const dstTiers = join(runtimeTarget, '.pantheon', 'tiers.json')
    if (existsSync(srcTiers)) {
      const content = readFileSync(srcTiers, 'utf8')
      const status = writeIfChanged(dstTiers, content, dryRun, { recorder })
      if (status === 'created') stats.created++
      else stats.skipped++
    }
  }
  if (componentSet.has('runtime')) advancePhase()

  // -----------------------------------------------------------------------
  // 2.11 Setup virtual environment + health check (--components runtime)
  // beta.5: runs BEFORE the config write and is no longer fatal — on failure
  // the install completes without MCP entries (which would point at a venv
  // that does not exist) instead of aborting a half-done installation.
  // -----------------------------------------------------------------------
  let runtimeHealthy = !componentSet.has('runtime')
  if (componentSet.has('runtime')) {
    runtimeHealthy = setupRuntimePhase(
      target,
      {
        dryRun,
        clean,
        isGlobal,
        recorder,
        reviewedRemovals,
        reviewedSnapshots,
        // Two distinct gauge phases share this one call: the venv setup and
        // the health check. Hooks keep the gauge honest without leaking the
        // UI object into the runtime module.
        onVenvDone: () => advancePhase(S.settingUpRuntime),
        onHealthDone: () => advancePhase(S.runningHealthChecks),
      },
      stats,
      opts.deps,
    )
  }

  // -----------------------------------------------------------------------
  // 3. Create/update opencode.json (always runs)
  //    Reads TARGET's existing config first, then merges Pantheon settings
  //    on top. Preserves user's MCP, provider, plugins, compaction, theme.
  // -----------------------------------------------------------------------
  // --------------------------------------------------------------------
  // A. Parse canonical agent config from src/agents/*.md frontmatter
  //    and merge into opencode.json config.
  // --------------------------------------------------------------------
  function getAgentSources(agentPrefix) {
    const agentsDir = join(ROOT, 'src', 'agents')
    if (!existsSync(agentsDir)) return {}
    const sources = {}
    const files = readdirSync(agentsDir).filter(
      (f) => (f.endsWith('.agent.md') || f.endsWith('.md')) && f.toLowerCase() !== 'readme.md',
    )
    for (const f of files) {
      const name = f.replace(/\.(agent\.)?md$/, '')
      sources[name] = `${agentPrefix}/${name}.md`
    }
    return sources
  }

  function readAgentConfigFromCanonical() {
    const agentsDir = join(ROOT, 'src', 'agents')
    if (!existsSync(agentsDir)) return {}
    const config = {}
    const files = readdirSync(agentsDir).filter(
      (f) => (f.endsWith('.agent.md') || f.endsWith('.md')) && f.toLowerCase() !== 'readme.md',
    )
    for (const f of files) {
      const name = f.replace(/\.(agent\.)?md$/, '')
      const content = readFileSync(join(agentsDir, f), 'utf8')
      const parsed = parseFrontmatter(content)
      if (!parsed) continue
      const fm = parsed.fm
      const agent = {}

      // Extract fields from frontmatter
      if (fm.color) agent.color = fm.color
      if (fm.description) agent.description = fm.description
      if (fm.mode) agent.mode = fm.mode
      if (fm.hidden) agent.hidden = fm.hidden
      if (fm.temperature !== undefined) agent.temperature = fm.temperature
      // Support both hyphen (YAML) and underscore (JSON) key variants
      if (fm['disable-model-invocation'] !== undefined)
        agent.disable_model_invocation = fm['disable-model-invocation']
      else if (fm.disable_model_invocation !== undefined)
        agent.disable_model_invocation = fm.disable_model_invocation

      // Build permission from frontmatter
      if (fm.permission) {
        agent.permission = JSON.parse(JSON.stringify(fm.permission))
      }
      if (fm.mcp_tools !== undefined) {
        agent.permission = {
          ...(agent.permission ?? {}),
          ...deriveNativeMcpPermissions(fm.mcp_tools),
        }
      }

      config[name] = agent
    }
    return config
  }

  const canonicalAgentConfig = readAgentConfigFromCanonical()
  const agentSources = getAgentSources(agentPrefix)

  if (config.agent === undefined) config.agent = {}

  if (config.agent && typeof config.agent === 'object' && !Array.isArray(config.agent)) {
    for (const [agentName, agentCfg] of Object.entries(canonicalAgentConfig)) {
      if (!agentCfg || typeof agentCfg !== 'object') continue

      if (Object.hasOwn(config.agent, agentName)) {
        // ── Agent exists in target config ──
        // Update framework-managed fields from canonical source
        // Preserve user-customized fields (model, provider, mcp, etc.)
        const existing = config.agent[agentName]
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) continue
        if (agentSources[agentName]) existing.source = agentSources[agentName]
        for (const field of MANAGED_FIELDS) {
          if (field in agentCfg) {
            existing[field] = JSON.parse(JSON.stringify(agentCfg[field]))
          }
        }
        // Existing agent fields belong to the user; never remove them during
        // an install. Canonical values are merged only when absent.
      } else {
        // ── New agent ──
        const newAgent = {}
        if (agentSources[agentName]) newAgent.source = agentSources[agentName]
        if (agentCfg.description) newAgent.description = agentCfg.description

        // Copy all framework-managed fields from canonical config
        for (const field of MANAGED_FIELDS) {
          if (field in agentCfg) {
            newAgent[field] = JSON.parse(JSON.stringify(agentCfg[field]))
          }
        }

        // Ensure bash permission is set from canonical (default to deny if missing)
        if (newAgent.permission === undefined) {
          newAgent.permission = {}
        }
        if (newAgent.permission.bash === undefined && agentCfg.permission?.bash) {
          newAgent.permission.bash = JSON.parse(JSON.stringify(agentCfg.permission.bash))
        }

        config.agent[agentName] = newAgent
      }
    }

    // Do not remove stale or user-defined agents. Installation is additive.
  }

  // --------------------------------------------------------------------
  // B. Commands from .md frontmatter (commands.json removed)
  // --------------------------------------------------------------------
  // Commands are now sourced from .md frontmatter in commands/.
  // The .md frontmatter is the canonical source — no json merge needed.

  // --------------------------------------------------------------------
  // B.5 Ensure critical top-level OpenCode config sections
  // --------------------------------------------------------------------
  // Seeded from code, not from a packaged template: see
  // PRODUCT_CONFIG_DEFAULTS. Only fills a gap — a user who already chose a
  // default agent keeps it.
  if (config.default_agent === undefined) {
    config.default_agent = PRODUCT_CONFIG_DEFAULTS.default_agent
  }
  // Apply only explicit top-level model overrides. Existing values remain
  // untouched and an install without either flag leaves both fields absent.
  const modelFlag = typeof opts.model === 'string' && opts.model !== '' ? opts.model : undefined
  const smallModelFlag =
    typeof opts.smallModel === 'string' && opts.smallModel !== '' ? opts.smallModel : undefined
  if (modelFlag !== undefined) config.model = modelFlag
  if (smallModelFlag !== undefined) config.small_model = smallModelFlag
  // Merge subagent_depth HERE (the config merge always runs, including on a
  // fresh install) instead of a file-existence-gated block, so run #1 already
  // produces the final config — run #2 must be a byte-identical no-op (#19).
  //
  // V1/V2 compat (Phase 3): top-level `subagent_depth` is in V2's
  // unsupportedTopLevel list and is SILENTLY IGNORED. The accepted form is
  // `experimental.subagent_depth`. Migrate any existing top-level value into
  // experimental (preserving the user's choice) and default fresh installs to
  // experimental.subagent_depth = 2. V1 reads experimental.subagent_depth
  // too, so the V1-shape config stays valid under both versions.
  if (config.experimental === undefined) {
    config.experimental = {}
  }
  if (
    typeof config.experimental === 'object' &&
    config.experimental !== null &&
    !Array.isArray(config.experimental)
  ) {
    if (config.subagent_depth !== undefined) {
      if (config.experimental.subagent_depth === undefined) {
        config.experimental.subagent_depth = config.subagent_depth
      }
      delete config.subagent_depth
    } else if (config.experimental.subagent_depth === undefined) {
      config.experimental.subagent_depth = 2
    }
  } else if (config.subagent_depth !== undefined) {
    delete config.subagent_depth
  }

  // --------------------------------------------------------------------
  // B.5.1 Hermetic plugin resolution (packaging fix)
  // --------------------------------------------------------------------
  // A developer running from a checkout has a repository-root opencode.json
  // that may reference plugins via developer-machine absolute paths (e.g.
  // <dev>/pantheon/.../src/plugin.ts or
  // <dev>/pantheon/.../src/plugins/pantheon-hooks.ts). Copying those
  // verbatim into the user's config would break every global install on any
  // other machine. resolveInstalledPlugin() rewrites each entry to the plugin
  // file inside the INSTALLED package (derived from ROOT — never hardcoded),
  // so both dev and global installs resolve to a path that actually exists.
  // The source opencode.json keeps its dev path for local development; the
  // transform happens at install/sync time only.

  if (version === 'v1') {
    // V1 loads the singular `plugin` list. Remove every Pantheon V2 entry from
    // both config shapes before restoring the two V1 plugins. User plugins in
    // either list are retained verbatim.
    if (Array.isArray(config.plugins)) {
      config.plugins = removePantheonPluginReferences(config.plugins)
    }
    if (config.plugin === undefined) config.plugin = []
    if (Array.isArray(config.plugin)) {
      config.plugin = removePantheonPluginReferences(config.plugin)
      if (Array.isArray(pantheonConfig?.plugin)) {
        for (const plugin of pantheonConfig.plugin) {
          if (!isPantheonPluginReference(plugin) && !hasPluginReference(config.plugin, plugin)) {
            config.plugin.push(deepClone(plugin))
          }
        }
      }

      const ensurePantheonPlugin = (ref) => {
        const resolved = resolveInstalledPlugin(ref)
        config.plugin = config.plugin.filter(
          (plugin) => pluginReferenceIdentity(plugin) !== pluginReferenceIdentity(resolved),
        )
        config.plugin.push(resolved)
      }
      // Root-level delegation plugin remains a V1-only registration.
      ensurePantheonPlugin('src/plugin.ts')
      ensurePantheonPlugin('src/plugins/pantheon-hooks.ts')
    }
  }

  if (version === 'v2') {
    // V2 loads the plural `plugins` list, and the singular `plugin` key is dead
    // on this host. Migrating a V1 config therefore means deciding, entry by
    // entry, whether the V2 loader can load it AT ALL: a directory can, a file
    // path is rejected ("must be a directory") and a package shorthand dies in
    // `npm install`. Copying every entry across would turn "silently ignored"
    // into "config fails to load", so only loadable entries move; the rest stay
    // where they are and the warning names the exact failure mode.
    if (Array.isArray(config.plugin)) {
      // Strip Pantheon refs FIRST, exactly as the V1 branch does: a stale V1
      // .ts path is not a registrable entry on this host and must not be moved.
      config.plugin = removePantheonPluginReferences(config.plugin)
      if (!Array.isArray(config.plugins)) config.plugins = []
      const migrated = []
      const blocked = []
      for (const plugin of config.plugin) {
        const verdict = v2PluginEntryLoadability(plugin, target)
        if (!verdict.loadable) {
          blocked.push({ plugin, reason: verdict.reason })
          continue
        }
        if (!hasPluginReference(config.plugins, plugin)) {
          config.plugins.push(deepClone(plugin))
          migrated.push(plugin)
        }
      }
      if (migrated.length > 0) {
        warning(
          `V2 host ignores the singular "plugin" key; also registered ${migrated.length} ` +
            `third-party entr${migrated.length === 1 ? 'y' : 'ies'} under "plugins" so ` +
            `they keep loading: ${migrated.map(describePluginEntry).join(', ')}. ` +
            'Remove any that only support the V1 plugin API.',
        )
      }
      if (blocked.length > 0) {
        warning(
          'V2 host ignores the singular "plugin" key; these entries were left in it ' +
            `because the V2 loader cannot load them, so they will NOT be active: ${blocked
              .map(
                ({ plugin, reason }) =>
                  `${describePluginEntry(plugin)} ${V2_LOAD_FAILURES[reason]}`,
              )
              .join('; ')}.`,
        )
      }
      // Pantheon refs are already gone. An emptied array is not configuration:
      // drop the dead key entirely so the written config points at the list the
      // V2 host actually reads. A surviving V1 list is the user's own data and
      // is left in place (a downgrade still finds it).
      if (config.plugin.length === 0) delete config.plugin
    }
    if (!Array.isArray(config.plugins)) config.plugins = []
    // Preserve any options already set on the Pantheon V2 entry across the
    // remove/re-add below. The context_sandbox migration reads them, and a
    // silent drop would lose a hand-set sandbox limit or any other plugin
    // option the user chose. Only the object form can carry options.
    const existingV2Options =
      config.plugins
        .filter((ref) => pluginReferenceIdentity(ref) === PANTHEON_V2_PLUGIN)
        .map((ref) =>
          typeof ref === 'object' && ref !== null && !Array.isArray(ref) ? ref.options : null,
        )
        .find((options) => options && typeof options === 'object' && !Array.isArray(options)) ??
      null
    config.plugins = deduplicatePluginReferences(removePantheonPluginReferences(config.plugins))
    if (Array.isArray(pantheonConfig?.plugins)) {
      for (const plugin of pantheonConfig.plugins) {
        if (!isPantheonPluginReference(plugin) && !hasPluginReference(config.plugins, plugin)) {
          config.plugins.push(deepClone(plugin))
        }
      }
    }
    // The beta resolves every `plugins` entry through npm install, so an
    // `a/b` shorthand (e.g. the published `pantheon-opencode/plugin-v2`
    // export) is treated as a GitHub repo and dies with NpmInstallFailedError
    // (beta log evidence). The beta loader additionally requires each entry
    // to be a DIRECTORY with a real index.js/index.ts — a file path warns
    // "must be a directory" and a symlink is ignored (sandbox probe
    // evidence). Register the V2 plugin DIRECTORY inside the INSTALLED
    // package — exactly like V1's ensurePantheonPlugin, but pointing at
    // src/plugin-v2 whose index.ts shim re-exports the real entry.
    // Legacy refs (npm shorthand, the old src/plugin-v2.ts file path) are
    // recognized via managedPluginIdentity and already stripped above, so
    // they migrate here.
    const resolvedV2 = resolveInstalledPlugin(PANTHEON_V2_PLUGIN)
    config.plugins = config.plugins.filter(
      (plugin) => pluginReferenceIdentity(plugin) !== pluginReferenceIdentity(resolvedV2),
    )
    // ALWAYS the object form, even on a fresh install with nothing to preserve.
    // The host hands a plugin its `options` only from `{ package, options }`,
    // and the opt-in features (`context_pruner`, `memory_injection`) read
    // `ctx.options`. Emitting a bare string — which a fresh install used to do —
    // left those features unreachable for anyone who did not already know the
    // object syntax from the docs, so the shape (with an empty options bag) is
    // written from the start and a user's hand-added keys survive a re-run.
    config.plugins.push({
      package: resolvedV2,
      options: existingV2Options === null ? {} : deepClone(existingV2Options),
    })

    // A path that LOOKS like a Pantheon V2 entry but is not one this package
    // can prove it owns (managedPluginIdentity only recognizes installed copies
    // and this package's own paths) would now be registered twice: the host
    // would run both copies' hooks. Retiring it on a guess could delete a
    // third-party plugin, so say what is happening instead of guessing.
    const lookalikes = config.plugins.filter(
      (ref) =>
        !isPantheonPluginReference(ref) &&
        pluginMetadataReferences(ref).some((reference) =>
          /(^|\/)plugin-v2(?:\.ts)?$/.test(normalizePluginRef(reference)),
        ),
    )
    if (lookalikes.length > 0) {
      warning(
        'This config also points at another copy of the Pantheon V2 plugin, which this ' +
          'installer cannot prove it owns: ' +
          `${lookalikes.map(describePluginEntry).join(', ')}. With the entry registered in ` +
          'this install, BOTH copies would load and their hooks would run twice. Remove that ' +
          'entry by hand if it is an older Pantheon installation; it is left alone because a ' +
          'third-party plugin could share the path.',
      )
    }
  }

  // Report whether the entry the host will read can actually carry options.
  // Computed here, from the config this pass is about to write, so it answers
  // the installed state rather than an assumption.
  const v2PluginOptions =
    version === 'v2' ? describePluginOptionsReachability(config.plugins) : null
  if (v2PluginOptions !== null && !v2PluginOptions.reachable && !opts.planOnly) {
    warning(`Pantheon V2 plugin options are not reachable: ${v2PluginOptions.detail}`)
  }

  if (pantheonConfig !== null) {
    if (config.provider === undefined && pantheonConfig.provider !== undefined) {
      config.provider = deepClone(pantheonConfig.provider)
    } else if (config.provider !== undefined && pantheonConfig.provider !== undefined) {
      mergeMissing(config.provider, pantheonConfig.provider)
    }

    if (config.compaction === undefined && pantheonConfig.compaction !== undefined) {
      config.compaction = deepClone(pantheonConfig.compaction)
    } else if (config.compaction !== undefined && pantheonConfig.compaction !== undefined) {
      mergeMissing(config.compaction, pantheonConfig.compaction)
    }
  }

  // --------------------------------------------------------------------
  // C. Merge permissions
  // --------------------------------------------------------------------
  if (config.permission === undefined) config.permission = {}
  if (
    typeof config.permission === 'object' &&
    config.permission !== null &&
    !Array.isArray(config.permission)
  ) {
    // Fill-if-absent, never overwrite. Pantheon's skills cannot be invoked
    // without this grant, so an install that just installed them seeds it —
    // but a user who deliberately set `permission.skill` (to `deny`, or to a
    // partial map of their own) keeps their choice. This was an unconditional
    // assignment nine lines below a comment that said "never overwrite", which
    // silently flipped an explicit deny to allow.
    //
    // Gated on the skills component AND absent-only, which is the whole point:
    // `skill` is a capability grant for something this install just wrote to
    // disk. A runtime-only or agents-only install has nothing to grant, so it
    // must not seed the key. It used to anyway, via the unconditional
    // PRODUCT_CONFIG_DEFAULTS.permission merge that sat above this block —
    // which also made this gate dead code.
    if (componentSet.has('skills') && config.permission.skill === undefined) {
      config.permission.skill = { '*': 'allow' }
    }
    // These five are the commands Pantheon's OWN agents must be able to run
    // unattended to do their job: version control, package execution, and the
    // test/lint pair every implementation agent reaches for. That is the whole
    // bar for a grant made on every install.
    //
    // Anything beyond it is the installing user's judgement about which
    // commands to trust on their machine, to be made in THEIR config — not ours
    // to grant silently on their behalf. The personal dev allowlist this grew
    // out of was the same category of decision, one layer further out of view.
    //
    // Specifically NOT granted, and why:
    //   - `curl` — arbitrary network egress; the widest grant on the list and
    //     not required to install or run anything here.
    //   - `docker` — host/daemon access; a container runtime is not an
    //     installation requirement.
    //   - `gh` — third-party account access on someone's behalf; a GitHub CLI
    //     login is never something an installer may assume.
    //   - `pip`, `black`, `make` — ordinary toolchain commands with no Pantheon
    //     agent dependency; users who want them can add them.
    //
    // NOTE: this grant is NOT gated on the skills component — unlike
    // permission.skill above, agents are installed by the agents component and
    // the test/lint commands are needed whichever components were selected.
    if (config.permission.bash === undefined) {
      config.permission.bash = {
        'git *': 'allow',
        'npm *': 'allow',
        'npx *': 'allow',
        'pytest *': 'allow',
        'ruff *': 'allow',
      }
    }
  }

  // --------------------------------------------------------------------
  // D. Merge instructions paths
  // --------------------------------------------------------------------
  // AGENTS.md is the single instruction file both V1 and V2 load (V1
  // auto-discovers it, V2 loads it explicitly). The generated AGENTS.md
  // contains shared rules; agent-scoped rules are in the installed agent
  // prompts. The `instructions/*.md`
  // glob is no longer needed — keeping it would duplicate content under V1
  // and is ignored under V2 anyway. Only ensure AGENTS.md is present.
  const pantheonInstructions = ['AGENTS.md']
  if (config.instructions === undefined) {
    config.instructions = [...pantheonInstructions]
  } else if (Array.isArray(config.instructions)) {
    // Strip stale per-file instruction globs from PREVIOUS installs
    // (e.g. `instructions/*.instructions.md` / `src/instructions/*.md`).
    // The merge is additive-only otherwise, so without this filter existing
    // configs would keep loading instruction content twice under V1
    // (generated AGENTS.md + individual files). User entries that are not
    // *.instructions.md globs are preserved.
    config.instructions = config.instructions.filter(
      (instr) => typeof instr !== 'string' || !instr.endsWith('.instructions.md'),
    )
    for (const instr of pantheonInstructions) {
      if (!config.instructions.includes(instr)) {
        config.instructions.push(instr)
      }
    }
  }

  // --------------------------------------------------------------------
  // E. Ensure $schema
  // --------------------------------------------------------------------
  if (config.$schema === undefined) {
    config.$schema = 'https://opencode.ai/config.json'
  }

  // --------------------------------------------------------------------
  // F. Compatibility cleanup (OpenCode V1 >= 1.15.7)
  // --------------------------------------------------------------------
  // Recent V1 releases reject the legacy `todoContinuation` setting. Remove
  // it from the merged V1 config, while leaving the V2-shaped configuration
  // untouched.
  if (version === 'v1' && Object.hasOwn(config, 'todoContinuation')) {
    delete config.todoContinuation
  }

  // --------------------------------------------------------------------
  // F.5 MCP server entries (for runtime-deployed scripts)
  // beta.5: skipped when the Python runtime setup failed — entries pointing
  // at a venv that does not exist would make every MCP fail to launch.
  // --------------------------------------------------------------------
  if (componentSet.has('runtime') && runtimeHealthy) {
    // P1-3: derive the MCP python from the SAME venv layout setupVenv creates
    // (<target>/.venv via venvPythonPath). For project installs the runtime
    // payload lives under <target>/.opencode (runtimeTarget), but the venv is
    // created at <target>/.venv — pointing MCP commands at
    // runtimeTarget/.venv would reference an executable that never exists.
    // Point the config at the venv even on a first install; setupVenv runs
    // later in this function and creates this path before OpenCode starts.
    const runtimeTarget = isGlobal ? target : join(target, '.opencode')
    const mcp = applyMcpServerEntries(config, {
      runtimeTarget,
      venvPython: venvPythonPath(target),
      version,
    })
    mcpServers = mcp.servers
    // `permission.mcp.<server>: ask` is inert on OpenCode 2.x. Never leave the
    // user believing the default gated anything: report each unenforced entry
    // and point at the enforceable form.
    for (const message of mcp.warnings ?? []) {
      warning(message)
      stats.warnings += 1
    }
  }

  // ── V2 native migration ──
  // When targeting V2, convert the merged V1-shaped config to native V2 format
  // before writing. V1 path is untouched (zero regression).
  let configToWrite = config
  if (version === 'v2') {
    // The V2 converters can emit raw console warnings (ambiguous legacy
    // values). Close the gauge line first so they are not printed on top of it
    // and then erased by the next `\r` clear.
    endGaugeLine()
    info(S.v2Migrating)
    configToWrite = migrateV1toV2(config)

    // Pantheon no longer sets a step ceiling. Any `steps` sitting on a managed
    // agent was written by an earlier install and never chosen by the user —
    // the merge above is additive by design (no delete path), so drop it here
    // and let the host default apply. This runs after the migration because
    // migrateV1toV2 copies the V1 `agent` block across verbatim (including any
    // stale `steps`), which is exactly how the value reappears in V2.
    // User-defined agents are out of scope and keep their value; the V1
    // singular `agent` block is deliberately untouched (V1 is retiring).
    const v2Agents = configToWrite.agents
    if (v2Agents && typeof v2Agents === 'object' && !Array.isArray(v2Agents)) {
      for (const name of Object.keys(canonicalAgentConfig)) {
        const entry = v2Agents[name]
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) delete entry.steps
      }
    }

    // Carry the V1 top-level `context_sandbox` into the exact Pantheon V2
    // plugin entry's `options` — V2.0.25 silently drops the top-level key, so
    // without this the user's enabled/limits choice is lost on a V1→V2 install.
    // The V1 block itself is preserved by migrateV1toV2 for a downgrade.
    // A null/type-invalid block throws HERE, before any config write.
    configToWrite.plugins = applyContextSandboxToV2Plugins(
      configToWrite.plugins,
      config.context_sandbox,
    )
  }

  const configContent = `${JSON.stringify(configToWrite, null, 2)}\n`
  const configStep = step(S.writingConfig)
  const status = writeConfigWithBackup(targetConfigPath, configContent, dryRun, {
    expectedContent: configRaw,
    // Test seam: lets a test simulate a concurrent writer landing between the
    // initial config read and the pre-swap recheck. Absent in production.
    beforeRecheck: opts.deps?.beforeRecheck,
    recorder,
  })
  if (status === 'conflict') {
    configStep(false)
    // The user's config changed under the installer between the read and the
    // swap. Treating this as an ordinary skipped write would report a
    // successful install over a file we never actually updated — fail loudly
    // and leave the target byte-identical instead.
    throw new Error(
      `Installation aborted: ${targetConfigPath} changed on disk during install ` +
        '(it no longer matches the content that was read); refusing to overwrite it. ' +
        'Re-run the installer once the file is stable.',
    )
  }
  configStep(true)
  if (status === 'created') stats.created++
  else stats.skipped++
  advancePhase()

  // -----------------------------------------------------------------------
  // 3.5 Run migrations (--components runtime)
  // -----------------------------------------------------------------------
  if (componentSet.has('runtime')) {
    const currentVersion = detectVersion(target)
    if (currentVersion) {
      const migrationStep = step(S.runningMigrations)
      const migration = runMigrations(target, currentVersion, {
        dryRun,
        recorder,
        updatedAt: planTimestamp,
      })
      migrationStep(true)
      if (migration.plannedState) projectedState = migration.plannedState
      if (migration.applied > 0) {
        success(`Applied ${migration.applied} migration(s)`)
        for (const msg of migration.messages) {
          bullet(msg, 1)
        }
      }
    }
    // Counted even when there is nothing to migrate: the phase ran its check.
    advancePhase()
  }

  if (opts.preset && dryRun) {
    const { writeActivePreset } = await import('./model-picker.mjs')
    writeActivePreset(target, opts.preset, {
      dryRun: true,
      source: 'cli',
      updatedAt: planTimestamp,
      recorder,
      logger: { log() {} },
    })
  }

  // -----------------------------------------------------------------------
  // 3.75 Preview summary (Beta 11 Setup phase 1): print the REAL per-file
  //      change set this same pass would apply. Paths + action + byte size
  //      ONLY — never file contents or hashes. Nothing was written.
  // -----------------------------------------------------------------------
  // A dry run has finished every phase it runs at this point (no state write):
  // close the gauge BEFORE the plan so the final line stands on its own.
  if (dryRun) {
    progress?.done()
    if (preview) endGaugeLine()
  }
  if (preview) {
    // Project the terminal state write using the plan's stable timestamp so
    // saved-plan apply can validate its exact output fingerprint.
    const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    let state = projectedState ?? readState(target)
    if (!state) state = createInitialState(packageVersion, planTimestamp)
    state.pantheon_version = packageVersion
    state.updated_at = planTimestamp
    state.schema_version = 2
    for (const component of ['agents', 'skills', 'plugins', 'runtime']) {
      if (!componentSet.has(component)) continue
      const componentStatus = component === 'runtime' && !runtimeHealthy ? 'failed' : 'installed'
      const componentVersion = state.components?.[component]?.version ?? 1
      setComponentState(state, component, componentVersion, componentStatus)
    }
    const stateContent = `${JSON.stringify(state, null, 2)}\n`
    // NOTE: this fingerprint is the PROJECTED terminal state, not a byte-exact
    // prediction of the state file an apply leaves behind. The apply writes
    // `install-state.json` only after `updateFileInventory()` has added the
    // verified-file entries, so the final bytes (and hash) differ from this
    // preview by design. Do not "fix" the fingerprint to match the audit run:
    // the inventory entries are an OUTPUT of the apply, not an input to it.
    recordChange(
      {
        path: join(target, '.pantheon', 'install-state.json'),
        action: hasState(target) ? ACTIONS.UPDATE : ACTIONS.CREATE,
        bytes: Buffer.byteLength(stateContent, 'utf8'),
        outputFingerprint: fingerprintOutput(stateContent),
        scored: false,
      },
      recorder,
    )
    const plan = summarizeChanges(preview.entries)
    // The MCP section is derived from the write path: `mcpServers` holds the
    // names `applyMcpServerEntries` seeded in THIS pass, in write order (empty
    // when the runtime component is not selected or failed its prerequisites).
    plan.mcpServers = mcpServers
    plan.versionAssumed = versionAssumed
    planFiles = plan.files
    planTotals = plan.totals
    plannedChanges = plan.totals.create + plan.totals.update + plan.totals.remove
    removalPaths = [
      ...new Set(
        preview.entries
          .filter((entry) => entry.action === ACTIONS.REMOVE)
          .map((entry) => resolve(entry.path)),
      ),
    ].sort()
    // Snapshot both net changes and every raw removal target. A later write can
    // make a removal path look unchanged in the net plan, but it still needs
    // review before the clean operation deletes and recreates it.
    const snapshotPaths = new Set([...plan.files.map((file) => file.path), ...removalPaths])
    plannedSnapshots = [...snapshotPaths].map((filePath) => ({
      path: filePath,
      ...snapshot(filePath),
    }))
    const statsDelta = {
      created: stats.created - statsBefore.created,
      skipped: stats.skipped - statsBefore.skipped,
    }
    const mismatch = planStatsMismatch(plan, statsDelta)
    if (mismatch) {
      // Development safety net: a writer that incremented THIS call's install
      // stats but never recorded a change would otherwise make the preview
      // silently incomplete. Surface it loudly instead of hiding it.
      warning(
        `Change-plan consistency mismatch: plan reports ${mismatch.changed} changed / ` +
          `${mismatch.unchanged} unchanged vs stats ${mismatch.recordedChanged}/${mismatch.recordedUnchanged}`,
      )
    }
    // Dry-run surface: by default a SUMMARY (counts + MCP servers + "No files
    // were written"), never one line per file — the gauge already answered
    // "is it moving?" and per-file detail is opt-in via --verbose. `[DRY-RUN]`
    // marks the header only; it no longer prefixes every line.
    // An internal snapshot pass on the apply path (`quietPlan`, e.g. an
    // authorized `--yes` run) computes the plan and snapshots but must NOT
    // echo it — a real apply is not a dry run.
    if (!opts.quietPlan) {
      const verbose = opts.verbose === true
      const planText = formatChangePlan(target, plan, { perFile: verbose })
      const planLines = planText.split('\n')
      console.log('')
      if (verbose && removalPaths.length > 0) {
        console.log(tag(`Removal review — ${removalPaths.length} path(s):`))
        for (const filePath of removalPaths) {
          console.log(`  remove    ${displayPath(target, filePath)}`)
        }
        console.log('')
      }
      console.log(tag(planLines[0]))
      for (const line of planLines.slice(1)) console.log(line)
      console.log('')
    }
  }

  // -----------------------------------------------------------------------
  // 4. (runtime setup moved to 2.11 — before the config write — so MCP
  //    entries are only added when the Python runtime is actually healthy)
  // -----------------------------------------------------------------------

  if (interactive && !dryRun) {
    endGaugeLine()
    const created = stats.created
    const skipped = stats.skipped
    const errors = stats.errors
    const warnings = stats.warnings ?? 0

    process.stdout.write('\n')
    process.stdout.write(
      `  ${colors.bold(
        errors > 0
          ? colors.yellow('Installation completed with errors')
          : colors.green('Installation complete'),
      )}\n`,
    )
    process.stdout.write(
      `  ${colors.dim('\u2500'.repeat(Math.min(process.stdout.columns || 60, 60)))}\n`,
    )
    process.stdout.write(`  [OK] ${created} component(s) installed\n`)
    if (skipped > 0)
      process.stdout.write(`  ${colors.dim('\u2014')} ${skipped} already up-to-date\n`)
    if (errors > 0) process.stdout.write(`  [WARN] ${errors} error(s) encountered\n`)
    if (warnings > 0)
      process.stdout.write(
        `  [WARN] ${warnings} warning(s) — run 'pantheon-opencode doctor' for details\n`,
      )
    process.stdout.write('\n')
    process.stdout.write(`  ${colors.bold('Next steps:')}\n`)
    process.stdout.write(`  ${colors.dim('\u2022')} Configure agents in opencode.json\n`)
    process.stdout.write(`  ${colors.dim('\u2022')} Run 'pantheon-opencode doctor' to verify\n`)
    process.stdout.write(
      `  ${colors.dim('\u2022')} Run 'opencode' to start using Pantheon agents\n`,
    )
    process.stdout.write('\n')
    printWorktreeGuidance({ projectRoot: process.cwd(), interactive: true })
  }

  // -----------------------------------------------------------------------
  // 5. V1 model preset selection (--components agents). V2 ignores the legacy
  //    active-preset marker, so it has no profile wizard or --preset support.
  //    The V1 interactive wizard runs unless autoYes or an explicit preset was given.
  //    Q1 default "herdar do chat" (inherit) writes no active-preset.json —
  //    delegates inherit the parent chat model (native inheritance).
  // -----------------------------------------------------------------------
  if (interactive && stdinTTY && version === 'v1' && !dryRun && !autoYes && !opts.preset) {
    const { runInitWizard } = await import('./model-picker.mjs')
    await runInitWizard({ presetDir: target, logger: console, prompts: opts.deps?.prompts })
  }

  if (opts.preset && !dryRun) {
    const { writeActivePreset } = await import('./model-picker.mjs')
    writeActivePreset(target, opts.preset, { source: 'cli', updatedAt: planTimestamp, recorder })
  }

  // -----------------------------------------------------------------------
  // 5.5 Optional vision prompt (interactive TTY only). The default — automatic
  //     discovery — writes nothing, and non-interactive flows (no TTY, --yes,
  //     --headless, automated sandboxes) never reach this block, so no run
  //     blocks on stdin and the default behavior is unchanged. A failure here
  //     must never fail the install: vision stays optional.
  // -----------------------------------------------------------------------
  if (interactive && !dryRun && !autoYes) {
    const runVisionPrompt =
      opts.deps?.runVisionPrompt ?? (await import('./vision-prompt.mjs')).runVisionPrompt
    try {
      await runVisionPrompt({ logger: console })
    } catch (err) {
      warning(`Vision setup skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Fail-closed: accumulated stats.errors (bad sources, missing requirements,
  // failed health checks) must never masquerade as a successful installation.
  if (stats.errors > 0) {
    throw new Error(`installation completed with ${stats.errors} error(s); see output above`)
  }

  // Record the component state only after the install has completed. The
  // postinstall marker can predate `init` and start with every component
  // pending; leaving it untouched made a healthy beta install look incomplete
  // to `doctor` forever. Unselected components retain their previous state.
  if (!dryRun) {
    const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    let state = projectedState ?? readState(target)
    if (!state && hasState(target)) {
      throw new Error('Installation state exists but cannot be read; refusing to replace it')
    }
    state ??= createInitialState(packageVersion, planTimestamp)
    state.pantheon_version = packageVersion
    state.updated_at = planTimestamp
    for (const component of ['agents', 'skills', 'plugins', 'runtime']) {
      if (!componentSet.has(component)) continue
      const status = component === 'runtime' && !runtimeHealthy ? 'failed' : 'installed'
      const componentVersion = state.components?.[component]?.version ?? 1
      setComponentState(state, component, componentVersion, status)
    }
    const verifiedFiles = summarizeChanges(ownRecorder?.entries ?? []).files.flatMap((file) => {
      if (!['create', 'update', 'unchanged'].includes(file.action) || !file.outputFingerprint)
        return []
      const owner = componentForInstalledPath(target, file.path, { isGlobal, version })
      if (!owner) return []
      return [
        {
          path: file.path,
          sha256: file.outputFingerprint,
          component: owner.component,
          layout: owner.layout,
          action: file.action,
        },
      ]
    })
    const stateStep = step(S.recordingState)
    updateFileInventory(state, target, {
      selectedComponents: [...componentSet],
      verifiedFiles,
    })
    writeState(target, state, { updatedAt: planTimestamp })
    stateStep(true)
    advancePhase()
  }

  // The apply gauge ends before the human summary; a dry run already closed it
  // before its plan block (`done()` is idempotent). A preview must NOT print
  // the installed banner: bin/pantheon-init prints the preview-only line.
  progress?.done()
  if (!interactive && !dryRun && !opts.planOnly) {
    printSummary(target, ['opencode'], stats)
  }

  // Beta 11 Setup phase 3: report whether this call APPLIED, so the caller can
  // avoid a success banner for a plan-only / unauthorized run. The dry pass also
  // returns the planned-target snapshots for the apply pass's drift check.
  return dryRun
    ? {
        ...stats,
        applied: false,
        reason: 'plan',
        planned: plannedChanges,
        snapshots: plannedSnapshots,
        files: planFiles,
        totals: planTotals,
        mcpServers,
        removals: removalPaths,
        target,
        openCodeVersion: version,
        versionAssumed,
        configAdvisories,
        v2Capabilities: version === 'v2' ? v2Capabilities() : null,
        pluginOptions: v2PluginOptions,
      }
    : {
        ...stats,
        applied: true,
        reason: 'applied',
        target,
        openCodeVersion: version,
        configAdvisories,
        v2Capabilities: version === 'v2' ? v2Capabilities() : null,
        pluginOptions: v2PluginOptions,
      }
}
