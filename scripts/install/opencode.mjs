#!/usr/bin/env node
/**
 * opencode.mjs — OpenCode platform installer
 *
 * Dual-version install (Phase 3): the generated config is V1-shaped and valid
 * under BOTH OpenCode V1 (`opencode` 1.18.x) and V2 (`opencode2`
 * v0.0.0-next-17444). V2 reads the same config locations and normalizes V1
 * fields in memory — do NOT convert to native V2 format. Known V2 beta gaps
 * handled here: top-level `subagent_depth` is silently ignored (migrated to
 * `experimental.subagent_depth`), and the `instructions` config key is
 * accepted-but-not-loaded (content consolidated into AGENTS.md, which both
 * versions load). Pass --version v2 to pantheon-init for an informational
 * label; state isolation is handled at runtime via OPENCODE_DB.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  bullet,
  colors,
  configure,
  error,
  info,
  printSummary,
  section,
  spinner,
  step,
  success,
  warning,
} from './cli-ui.mjs'
import { healthCheck } from './health-check.mjs'
import { detectVersion, runMigrations } from './migrate.mjs'
import { copyPluginFiles, installPlugin, registerPlugin, unregisterPlugin } from './plugin.mjs'
import {
  collectSkillNames,
  copyFiles,
  installSkills,
  parseFrontmatter,
  ROOT,
  sourceDirValid,
  summary,
  syncDir,
  writeIfChanged,
} from './shared.mjs'

import { setupVenv, venvPythonPath } from './venv.mjs'

const COMPONENT_NAMES = [
  'agents',
  'skills',
  'instructions',
  'prompts',
  'commands',
  'plugins',
  'runtime',
]

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function readJsonConfig(filePath) {
  if (!existsSync(filePath)) return {}

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
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
 * Resolve a plugin ref from the packaged opencode.json to a path INSIDE the
 * installed package.
 *
 * The packaged config may reference plugins via developer-machine absolute
 * paths (e.g. <dev>/pantheon/.../src/plugin.ts). Copying those verbatim into
 * the user's config would break every install on any other machine. This
 * rewrites the entry to the plugin file inside the INSTALLED package (derived
 * from ROOT — never hardcoded), so both dev and global installs resolve to a
 * path that actually exists.
 */
export function resolveInstalledPlugin(plugin) {
  // Map any ref whose path tail starts with `src/` to the matching file INSIDE
  // the installed package. This preserves the ref's relative location, so both
  // src/plugins/* (hooks) and the root-level src/plugin.ts (delegation plugin,
  // PR #45) resolve correctly — nothing is forced into src/plugins/.
  const srcIndex = plugin.indexOf('src/')
  if (srcIndex === -1) return plugin
  const packaged = join(ROOT, plugin.slice(srcIndex))
  return existsSync(packaged) ? packaged : plugin
}

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
 * config dir's plugins/ dir and registers THAT copy:
 *
 *   <configDir>/plugins/pantheon-tui      (dist/ + package.json + index.tsx)
 *
 * The loader reads the copied package.json `exports` map:
 *   exports["./tui"]    → dist/tui.js     (COMPILED Solid output)
 *   exports["./server"] → dist/server.js  (no-op server() stub)
 *
 * @param {string} configDir - directory holding tui.json (target for global
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
 * Sync the Pantheon TUI plugin registration across EVERY tui.json location
 * OpenCode reads.
 *
 * Contract (single source of truth):
 *   1. ALWAYS copy src/plugins/tui → <configDir>/plugins/pantheon-tui
 *      (dist/* + package.json + index.tsx) so the registered reference is a
 *      directory that exists and carries the loader contract (exports →
 *      dist/tui.js, dist/server.js). The copy is idempotent: a second run is
 *      byte-identical.
 *   2. Clean stale Pantheon TUI refs from ALL tui.json locations OpenCode
 *      loads — ~/.opencode, $XDG_CONFIG_HOME/opencode and
 *      <target>/.opencode — covering every old reference shape: dist file
 *      paths, in-package src/plugins/tui dirs, bare plugins/pantheon-tui
 *      copies, and npx paths. A stale ref left in the non-target location
 *      would still be loaded and break the TUI.
 *   3. Register EXACTLY the copied directory in the selected target only —
 *      exactly ONE Pantheon TUI reference exists system-wide after install.
 *
 * @param {string} target - install target directory
 * @param {object} [opts]
 * @param {boolean} [opts.isGlobal=false] - flat global layout vs .opencode/
 * @param {boolean} [opts.dryRun=false]
 * @returns {'created'|'skipped'} status for the target registration
 */
export function syncTuiRegistration(target, { isGlobal = false, dryRun = false } = {}) {
  const configDir = isGlobal ? target : join(target, '.opencode')
  const targetTuiConfigPath = join(configDir, 'tui.json')

  // 1. Always copy the single source of truth into the target config's
  //    plugins/pantheon-tui. Registering this copied directory (never the
  //    in-package src/plugins/tui) keeps installs hermetic and idempotent:
  //    the ref points at a dir that exists and has dist/tui.js.
  const tuiSrcDir = join(ROOT, 'src', 'plugins', 'tui')
  const tuiCopyDir = resolveTuiCopyTarget(configDir)
  if (existsSync(tuiSrcDir)) {
    copyPluginFiles(tuiSrcDir, tuiCopyDir, { dryRun })
  }

  // 2. Clean stale Pantheon TUI refs from every location OpenCode reads.
  //    unregisterPlugin covers the bare relative id plus the extended stale
  //    patterns (dist files, in-package src/plugins/tui dir, bare
  //    plugins/pantheon-tui copies, npx paths).
  for (const tuiConfigPath of tuiConfigLocations(target)) {
    unregisterPlugin(tuiConfigPath, 'plugins/pantheon-tui', { dryRun })
  }

  // 3. Register the copied directory in the selected target only.
  return registerPlugin(targetTuiConfigPath, tuiCopyDir, { dryRun })
}

export async function installOpenCode(
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

  const componentSet = new Set(components)
  const stats = summary.opencode

  // V1/V2 dual-version awareness (Phase 3): the SAME config works under both
  // OpenCode V1 (`opencode`) and V2 (`opencode2`, beta v0.0.0-next-17444).
  // V2 normalizes V1 fields in memory (no rewrite) and isolates its state DB
  // via OPENCODE_DB (~/.local/share/opencode/opencode-v2.db) with a distinct
  // service port (49375 vs V1's 49374). The installer writes one shared
  // config; the --version flag only labels the install for the operator.
  const version = opts.version === 'v2' ? 'v2' : 'v1'
  if (version === 'v2') {
    info(
      'OpenCode V2 target — shared config; state isolated via OPENCODE_DB ' +
        '(~/.local/share/opencode/opencode-v2.db), service port 49375',
    )
  }

  // Interactive mode handling
  const stdinTTY = process.stdin.isTTY && process.stdout.isTTY
  const forceInteractive = opts.interactive === true
  const forceHeadless = opts.headless === true
  const autoYes = opts.yes === true
  const interactive = forceInteractive || (stdinTTY && !forceHeadless)

  if (interactive && !dryRun) {
    const { runInteractiveInstall } = await import('./interactive.mjs')
    const result = await runInteractiveInstall({
      components,
      defaultComponents: COMPONENT_NAMES,
    })

    if (!result.confirmed && !autoYes) {
      info('Installation canceled.')
      return stats
    }

    // Map target selection to actual path
    const newComponents = [...result.components]
    componentSet.clear()
    for (const c of newComponents) componentSet.add(c)

    if (result.target === 'project') {
      target = process.cwd()
    }
  }

  const pantheonConfigPath = join(ROOT, 'opencode.json')
  const targetConfigPath = join(target, 'opencode.json')
  const config = readJsonConfig(targetConfigPath)
  const pantheonConfig = readJsonConfig(pantheonConfigPath)

  // Determine layout based on install scope.
  // Global config dir (~/.opencode or ~/.config/opencode) uses a flat layout:
  //   agents/   skills/   commands/   plugins/
  // Project installs use the .opencode/ sub-directory layout:
  //   .opencode/agents/   .opencode/skills/   .opencode/commands/
  const isGlobal = isGlobalConfigDir(target)
  const _subDir = isGlobal ? '' : '.opencode'
  const agentPrefix = isGlobal ? 'agents' : '.opencode/agents'

  configure({ dryRun })

  if (isGlobal) {
    info('Global config directory detected — using flat layout (agents/, skills/, commands/)')
  }

  // -----------------------------------------------------------------------
  // 1. Install agents (--components agents)
  // -----------------------------------------------------------------------
  if (componentSet.has('agents')) {
    section('\uD83D\uDCE6 Agents')
    const srcDir = join(ROOT, 'src', 'agents')
    if (!sourceDirValid(srcDir)) {
      warning(`Agent source directory not found: ${srcDir}`)
      stats.errors++
    } else {
      const agentStep = step('Installing agents')
      const dstDir = isGlobal ? join(target, 'agents') : join(target, '.opencode', 'agents')
      if (!dryRun) mkdirSync(dstDir, { recursive: true })
      if (clean && existsSync(dstDir) && !dryRun) {
        const existing = readdirSync(dstDir)
        for (const f of existing) {
          rmSync(join(dstDir, f), { recursive: true, force: true })
        }
      }
      const { created, skipped } = copyFiles(srcDir, dstDir, dryRun)
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
      const routingStatus = writeIfChanged(dstRouting, readFileSync(srcRouting, 'utf8'), dryRun)
      if (routingStatus === 'created') stats.created++
      else stats.skipped++
    }
  }

  // -----------------------------------------------------------------------
  // 2. Install skills (--components skills)
  // -----------------------------------------------------------------------
  if (componentSet.has('skills')) {
    section('\uD83D\uDCDA Skills')
    const skillNames = collectSkillNames()
    if (skillNames.length > 0) {
      const skillStep = step(`Installing ${skillNames.length} skills`)
      const dstSkillsDir = isGlobal ? join(target, 'skills') : join(target, '.opencode', 'skills')
      if (clean && existsSync(dstSkillsDir) && !dryRun) {
        const existing = readdirSync(dstSkillsDir)
        for (const s of existing) {
          rmSync(join(dstSkillsDir, s), { recursive: true, force: true })
        }
      }
      const installSubDir = isGlobal ? '' : '.opencode'
      const { created: sCreated, skipped: sSkipped } = installSkills(
        skillNames,
        target,
        dryRun,
        installSubDir,
      )
      stats.created += sCreated
      stats.skipped += sSkipped
      skillStep(true)
    }
  }

  // -----------------------------------------------------------------------
  // 2.5 Install instructions: AGENTS.md only (--components instructions)
  // -----------------------------------------------------------------------
  // AGENTS.md is the single instruction file both V1 and V2 load; the
  // generated file embeds every src/instructions/*.instructions.md body, so
  // the individual files are NOT copied anymore (nothing references
  // <config>/instructions/ after the section-D merge fix — copying them would
  // just leave stale duplicates on disk).
  if (componentSet.has('instructions')) {
    section('\uD83D\uDCCB Instructions')
    // AGENTS.md
    const srcAgentsMd = join(ROOT, 'AGENTS.md')
    const dstAgentsMd = join(target, 'AGENTS.md')
    if (existsSync(srcAgentsMd)) {
      const content = readFileSync(srcAgentsMd, 'utf8')
      const status = writeIfChanged(dstAgentsMd, content, dryRun)
      if (status === 'created') stats.created++
      else stats.skipped++
    }
  }

  // -----------------------------------------------------------------------
  // 2.6 Install prompts (--components prompts)
  // -----------------------------------------------------------------------
  if (componentSet.has('prompts')) {
    section('\uD83D\uDCAC Prompts')
    const srcPrompts = join(ROOT, 'prompts')
    const dstPrompts = join(target, 'prompts')
    if (existsSync(srcPrompts)) {
      const promptsResult = syncDir(srcPrompts, dstPrompts, dryRun, clean)
      stats.created += promptsResult.created
      stats.skipped += promptsResult.skipped
    }
  }

  // -----------------------------------------------------------------------
  // 2.7 Install commands (--components commands)
  // -----------------------------------------------------------------------
  if (componentSet.has('commands')) {
    section('\u26A1 Commands')
    const srcCmds = join(ROOT, 'commands')
    const dstCmds = isGlobal ? join(target, 'commands') : join(target, '.opencode', 'commands')
    if (existsSync(srcCmds)) {
      const cmdResult = syncDir(srcCmds, dstCmds, dryRun, clean, (f) => f.endsWith('.md'))
      stats.created += cmdResult.created
      stats.skipped += cmdResult.skipped
    }
  }

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
    section('\uD83D\uDD0C Plugins')
    const srcPluginDir = join(ROOT, 'src', 'plugins', 'tui')
    const dstPluginDir = isGlobal
      ? join(target, 'plugins', 'pantheon-tui')
      : join(target, '.opencode', 'plugins', 'pantheon-tui')
    const pluginStats = installPlugin(srcPluginDir, dstPluginDir, { dryRun, clean })
    stats.created += pluginStats.created
    stats.skipped += pluginStats.skipped
    stats.errors += pluginStats.errors
  }

  // -----------------------------------------------------------------------
  // 2.9 Create/update tui.json with plugin registration
  // -----------------------------------------------------------------------
  const tuiStatus = syncTuiRegistration(target, { isGlobal, dryRun })
  if (tuiStatus === 'created') stats.created++
  else stats.skipped++

  // -----------------------------------------------------------------------
  // 2.10 Install runtime infrastructure (--components runtime)
  //      MCP server scripts, code-mode scripts, tiers.json
  // -----------------------------------------------------------------------
  if (componentSet.has('runtime')) {
    section('\u2699\uFE0F Runtime')
    const runtimeTarget = isGlobal ? target : join(target, '.opencode')

    // ── MCP server scripts ──
    const mcpScripts = [
      'mcp_resources_server.py',
      'code_mode_server.py',
      'memory_mcp_server.py',
      'scrub-secrets.py',
      '_pantheon_paths.py',
      'mcp_codemap_module.py',
      'mcp_persistence_server.py',
      'pantheon_vision_server.py',
      'eval_store.py',
    ]
    const srcScriptsDir = join(ROOT, 'scripts')
    // Canonical MCP server sources live in src/mcp/. Map them explicitly so the
    // sync always copies from the canonical source, never from the stale root
    // scripts/ copies (which previously propagated bugs like the missing
    // `import uuid` in mcp_persistence_server.py). scrub-secrets.py is not in
    // src/mcp/ and intentionally falls back to join(ROOT, 'scripts').
    const canonicalMcpScripts = {
      'mcp_resources_server.py': join(ROOT, 'src', 'mcp', 'mcp_resources_server.py'),
      'code_mode_server.py': join(ROOT, 'src', 'mcp', 'code_mode_server.py'),
      'memory_mcp_server.py': join(ROOT, 'src', 'mcp', 'memory_mcp_server.py'),
      '_pantheon_paths.py': join(ROOT, 'src', 'mcp', '_pantheon_paths.py'),
      'mcp_codemap_module.py': join(ROOT, 'src', 'mcp', 'mcp_codemap_module.py'),
      'mcp_persistence_server.py': join(ROOT, 'src', 'mcp', 'mcp_persistence_server.py'),
      'pantheon_vision_server.py': join(ROOT, 'src', 'mcp', 'pantheon_vision_server.py'),
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
      const status = writeIfChanged(dst, content, dryRun)
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
      const status = writeIfChanged(destination, readFileSync(visionRequirements, 'utf8'), dryRun)
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
      const cmResult = syncDir(srcCodeModeDir, dstCodeModeDir, dryRun, clean)
      stats.created += cmResult.created
      stats.skipped += cmResult.skipped
    }

    // ── tiers.json ──
    const srcTiers = join(ROOT, '.pantheon', 'tiers.json')
    const dstTiers = join(runtimeTarget, '.pantheon', 'tiers.json')
    if (existsSync(srcTiers)) {
      const content = readFileSync(srcTiers, 'utf8')
      const status = writeIfChanged(dstTiers, content, dryRun)
      if (status === 'created') stats.created++
      else stats.skipped++
    }
  }

  // -----------------------------------------------------------------------
  // 3. Create/update opencode.json (always runs)
  //    Reads TARGET's existing config first, then merges Pantheon settings
  //    on top. Preserves user's MCP, provider, plugin, compaction, theme.
  // -----------------------------------------------------------------------
  // --------------------------------------------------------------------
  // A. Parse canonical agent config from agents/*.agent.md frontmatter
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
      if (fm.steps !== undefined) agent.steps = fm.steps
      // Support both hyphen (YAML) and underscore (JSON) key variants
      if (fm['disable-model-invocation'] !== undefined)
        agent.disable_model_invocation = fm['disable-model-invocation']
      else if (fm.disable_model_invocation !== undefined)
        agent.disable_model_invocation = fm.disable_model_invocation

      // Build permission from frontmatter
      if (fm.permission) {
        agent.permission = JSON.parse(JSON.stringify(fm.permission))
      }

      config[name] = agent
    }
    return config
  }

  const canonicalAgentConfig = readAgentConfigFromCanonical()
  const agentSources = getAgentSources(agentPrefix)
  const MANAGED_FIELDS = [
    'steps',
    'temperature',
    'color',
    'permission',
    'mode',
    'hidden',
    'disable_model_invocation',
  ]

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
        // Remove stale fields that are no longer in canonical config
        delete existing.model
        delete existing.small_model
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

    // Remove stale agents (exist in target config but not in canonical source)
    // Only removes agents whose source is managed (starts with our prefix)
    // so user-defined agents with different source paths are preserved.
    const canonicalNames = new Set(Object.keys(canonicalAgentConfig))
    for (const [agentName, agentCfg] of Object.entries(config.agent)) {
      const source = agentCfg?.source || ''
      if (source.startsWith(agentPrefix) && !canonicalNames.has(agentName)) {
        delete config.agent[agentName]
      }
    }
    if (Object.keys(config.agent).length === 0) delete config.agent
  }

  // --------------------------------------------------------------------
  // B. Commands from .md frontmatter (commands.json removed)
  // --------------------------------------------------------------------
  // Commands are now sourced from .md frontmatter in commands/.
  // The .md frontmatter is the canonical source — no json merge needed.

  // --------------------------------------------------------------------
  // B.5 Ensure critical top-level OpenCode config sections
  // --------------------------------------------------------------------
  if (config.default_agent === undefined && pantheonConfig.default_agent !== undefined) {
    config.default_agent = pantheonConfig.default_agent
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
  // The packaged opencode.json may reference plugins via developer-machine
  // absolute paths (e.g. <dev>/pantheon/.../src/plugin.ts or
  // <dev>/pantheon/.../src/plugins/pantheon-hooks.ts). Copying those
  // verbatim into the user's config would break every global install on any
  // other machine. resolveInstalledPlugin() rewrites each entry to the plugin
  // file inside the INSTALLED package (derived from ROOT — never hardcoded),
  // so both dev and global installs resolve to a path that actually exists.
  // The source opencode.json keeps its dev path for local development; the
  // transform happens at install/sync time only.

  if (config.plugin === undefined) {
    config.plugin = []
  }
  if (Array.isArray(config.plugin)) {
    if (Array.isArray(pantheonConfig.plugin)) {
      for (const plugin of pantheonConfig.plugin) {
        const resolved = resolveInstalledPlugin(plugin)
        const file = basename(resolved)
        // Replace any pre-existing entry for the same plugin file (e.g. a stale
        // dev-machine path from an earlier install) so upgrades stay hermetic.
        config.plugin = config.plugin.filter((p) => basename(p) !== file)
        config.plugin.push(resolved)
      }
    }

    // The two Pantheon plugins MUST always be registered, on fresh installs AND
    // upgrades. The packaged opencode.json carries no `plugin` key (dev-machine
    // paths removed in 3e552cc), so config.plugin would otherwise only contain
    // whatever the user had — a fresh install would register NOTHING and lose
    // delegation tools, GoalLoop, cost command, hashline and vision. Register
    // both unconditionally, replacing any stale entry for the same file
    // (basename-dedup) so installs and upgrades are idempotent and hermetic
    // while preserving any user plugins.
    const ensurePantheonPlugin = (ref) => {
      const resolved = resolveInstalledPlugin(ref)
      const file = basename(resolved)
      config.plugin = config.plugin.filter((p) => basename(p) !== file)
      config.plugin.push(resolved)
    }
    // Root-level delegation plugin (PR #45): tools, GoalLoop, cost, hashline.
    ensurePantheonPlugin('src/plugin.ts')
    // Runtime hooks plugin: chat hooks, hook-runner, TUI wiring.
    ensurePantheonPlugin('src/plugins/pantheon-hooks.ts')
  }

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

  // --------------------------------------------------------------------
  // C. Merge permissions
  // --------------------------------------------------------------------
  if (config.permission === undefined) config.permission = {}
  if (pantheonConfig.permission !== undefined) {
    mergeMissing(config.permission, pantheonConfig.permission)
  }
  if (
    typeof config.permission === 'object' &&
    config.permission !== null &&
    !Array.isArray(config.permission)
  ) {
    if (componentSet.has('skills')) {
      config.permission.skill = { '*': 'allow' }
    }
    if (config.permission.bash === undefined) {
      config.permission.bash = {
        'git *': 'allow',
        'npm *': 'allow',
        'npx *': 'allow',
        'pytest *': 'allow',
        'ruff *': 'allow',
        'black *': 'allow',
        'pip *': 'allow',
        'docker *': 'allow',
        'curl *': 'allow',
        'gh *': 'allow',
        'make *': 'allow',
      }
    }
  }

  // --------------------------------------------------------------------
  // D. Merge instructions paths
  // --------------------------------------------------------------------
  // AGENTS.md is the single instruction file both V1 and V2 load (V1
  // auto-discovers it, V2 loads it explicitly). The generated AGENTS.md
  // (scripts/build-agents-md.mjs) already embeds every
  // src/instructions/*.instructions.md body, so the `instructions/*.md`
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
  // F. Compatibility cleanup (OpenCode >= v1.15.7)
  // --------------------------------------------------------------------
  // `todoContinuation` is rejected by newer OpenCode versions.
  // Remove it from merged user config to avoid startup/config failures.
  if (Object.hasOwn(config, 'todoContinuation')) {
    delete config.todoContinuation
  }

  // --------------------------------------------------------------------
  // F.5 MCP server entries (for runtime-deployed scripts)
  // --------------------------------------------------------------------
  if (componentSet.has('runtime')) {
    config.mcp = config.mcp || {}
    // P1-3: derive the MCP python from the SAME venv layout setupVenv
    // creates (<target>/.venv via venvPythonPath). For project installs the
    // runtime payload lives under <target>/.opencode (runtimeTarget), but the
    // venv is created at <target>/.venv — pointing MCP commands at
    // runtimeTarget/.venv would reference an executable that never exists.
    const runtimeTarget = isGlobal ? target : join(target, '.opencode')
    const venvPython = venvPythonPath(target)
    // Point the config at the venv even on a first install; setupVenv runs
    // later in this function and creates this path before OpenCode starts.
    const memoryPython = venvPython

    // Only add if not already configured by user
    if (!config.mcp['pantheon-resources']) {
      config.mcp['pantheon-resources'] = {
        type: 'local',
        cwd: runtimeTarget,
        command: [memoryPython, 'scripts/mcp_resources_server.py'],
        enabled: true,
      }
    }
    if (!config.mcp['pantheon-code-mode']) {
      config.mcp['pantheon-code-mode'] = {
        type: 'local',
        cwd: runtimeTarget,
        command: [memoryPython, 'scripts/code_mode_server.py'],
        enabled: true,
      }
    }
    if (!config.mcp['pantheon-memory']) {
      config.mcp['pantheon-memory'] = {
        type: 'local',
        cwd: runtimeTarget,
        command: [memoryPython, 'scripts/memory_mcp_server.py'],
        enabled: true,
      }
    }
    if (!config.mcp['pantheon-persistence']) {
      config.mcp['pantheon-persistence'] = {
        type: 'local',
        cwd: runtimeTarget,
        command: [memoryPython, 'scripts/mcp_persistence_server.py'],
        enabled: true,
      }
    }
    if (!config.mcp['pantheon-vision']) {
      config.mcp['pantheon-vision'] = {
        type: 'local',
        cwd: runtimeTarget,
        command: [memoryPython, 'scripts/pantheon_vision_server.py'],
        enabled: true,
      }
    }

    // Default MCP permissions
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
  }

  const configContent = `${JSON.stringify(config, null, 2)}\n`
  const status = writeIfChanged(targetConfigPath, configContent, dryRun)
  if (status === 'created') stats.created++
  else stats.skipped++

  // -----------------------------------------------------------------------
  // 3.5 Run migrations (--components runtime)
  // -----------------------------------------------------------------------
  if (componentSet.has('runtime')) {
    const currentVersion = detectVersion(target)
    if (currentVersion) {
      const migration = runMigrations(target, currentVersion, { dryRun })
      if (migration.applied > 0) {
        success(`Applied ${migration.applied} migration(s)`)
        for (const msg of migration.messages) {
          bullet(msg, 1)
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // 4. Setup virtual environment + health check (--components runtime)
  // -----------------------------------------------------------------------
  if (componentSet.has('runtime')) {
    try {
      const venvSpinner = spinner('Setting up Python virtual environment')
      setupVenv(target, { dryRun, force: clean })
      venvSpinner(true)
      const health = healthCheck(target, { dryRun })

      // Print health summary
      section('\uD83D\uDD0D Health Check')
      const healthStep = step('Running health checks')
      for (const p of health.passed) success(`${p.check}: ${p.detail}`)
      for (const w of health.warnings) warning(`${w.check}: ${w.detail}`)
      for (const f of health.failed) error(`${f.check}: ${f.detail}`)

      if (health.failed.length > 0) {
        healthStep(false)
        warning(`${health.failed.length} check(s) failed — review above`)
        stats.errors += health.failed.length
      } else {
        healthStep(true)
      }
    } catch (err) {
      error(`Setup failed: ${err.message}`)
      throw err // Fatal — abort installation
    }
  }

  if (interactive && !dryRun) {
    const created = stats.created
    const skipped = stats.skipped
    const errors = stats.errors

    process.stdout.write('\n')
    process.stdout.write(`  ${colors.bold(colors.green('Installation complete'))}\n`)
    process.stdout.write(
      `  ${colors.dim('\u2500'.repeat(Math.min(process.stdout.columns || 60, 60)))}\n`,
    )
    process.stdout.write(`  ${colors.green('\u2713')} ${created} component(s) installed\n`)
    if (skipped > 0)
      process.stdout.write(`  ${colors.dim('\u2014')} ${skipped} already up-to-date\n`)
    if (errors > 0)
      process.stdout.write(`  ${colors.yellow('\u26a0')} ${errors} error(s) encountered\n`)
    process.stdout.write('\n')
    process.stdout.write(`  ${colors.bold('Next steps:')}\n`)
    process.stdout.write(`  ${colors.dim('\u2022')} Configure agents in opencode.json\n`)
    process.stdout.write(`  ${colors.dim('\u2022')} Add MCP servers in mcp.json\n`)
    process.stdout.write(`  ${colors.dim('\u2022')} Run 'opencode doctor' to verify\n`)
    process.stdout.write(
      `  ${colors.dim('\u2022')} Run 'opencode' to start using Pantheon agents\n`,
    )
    process.stdout.write('\n')
  } else {
    printSummary(target, ['opencode'], stats)
  }

  // -----------------------------------------------------------------------
  // 5. Model preset selection (--components agents). Interactive wizard runs
  //    unless autoYes (use defaults) or an explicit --preset was given.
  //    Q1 default "herdar do chat" (inherit) writes no active-preset.json —
  //    delegates inherit the parent chat model (native inheritance).
  // -----------------------------------------------------------------------
  if (interactive && !dryRun && !autoYes && !opts.preset) {
    const { runInitWizard } = await import('./model-picker.mjs')
    await runInitWizard({ presetDir: target, logger: console })
  }

  if (opts.preset && !dryRun) {
    const { writeActivePreset } = await import('./model-picker.mjs')
    writeActivePreset(target, opts.preset, { source: 'cli' })
  }
}
