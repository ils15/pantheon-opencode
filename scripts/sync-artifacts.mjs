/**
 * sync-artifacts.mjs — postinstall freshness sync for copy-only artifacts.
 *
 * Guarantees that an `npm install -g pantheon-opencode` (or npx cache
 * refresh) brings an EXISTING installation up to date for everything that is
 * a pure byte-compare copy: agents + routing.yml, skills, AGENTS.md,
 * commands, the runtime MCP scripts, the code-mode payload and tiers.json.
 *
 * Deliberately NOT done here (they belong to `pantheon-opencode init` /
 * `update`, which the doctor points at when versions drift):
 *   - opencode.json merge (config keys, plugin registration, MCP entries)
 *   - venv/pip setup
 *   - tui.json registration changes
 *
 * The user's opencode.json already references the installed package root for
 * plugins, so after a package update those references hit the NEW code
 * automatically; this sync refreshes the COPIES that would otherwise stay
 * stale until the next manual init.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  collectSkillNames,
  copyFiles,
  installSkills,
  ROOT,
  syncDir,
  writeIfChanged,
} from './install/shared.mjs'

/** Canonical MCP script sources — mirrors installOpenCode phase 2.10. */
const MCP_SCRIPTS = {
  'mcp_resources_server.py': () => join(ROOT, 'src', 'mcp', 'mcp_resources_server.py'),
  'code_mode_server.py': () => join(ROOT, 'src', 'mcp', 'code_mode_server.py'),
  'memory_mcp_server.py': () => join(ROOT, 'src', 'mcp', 'memory_mcp_server.py'),
  'mcp_persistence_server.py': () => join(ROOT, 'src', 'mcp', 'mcp_persistence_server.py'),
  '_pantheon_paths.py': () => join(ROOT, 'src', 'mcp', '_pantheon_paths.py'),
  'mcp_codemap_module.py': () => join(ROOT, 'src', 'mcp', 'mcp_codemap_module.py'),
  'pantheon_vision_server.py': () => join(ROOT, 'src', 'mcp', 'pantheon_vision_server.py'),
  'eval_store.py': () => join(ROOT, 'src', 'mcp', 'eval_store.py'),
  'scrub-secrets.py': () => join(ROOT, 'scripts', 'scrub-secrets.py'),
}

/**
 * Sync all copy-only artifacts from the installed package into configDir
 * (the GLOBAL OpenCode config dir). Byte-compare idempotent; never throws.
 * @returns {{ created: number, skipped: number, errors: string[] }}
 */
export function syncCopyArtifacts(configDir) {
  const result = { created: 0, skipped: 0, errors: [] }
  const bump = (r) => {
    result.created += r.created
    result.skipped += r.skipped
  }

  // ── agents + routing.yml ──
  try {
    const dstAgents = join(configDir, 'agents')
    if (existsSync(join(ROOT, 'src', 'agents'))) {
      mkdirSync(dstAgents, { recursive: true })
      bump(copyFiles(join(ROOT, 'src', 'agents'), dstAgents, false))
      const routing = join(ROOT, 'src', 'routing.yml')
      if (existsSync(routing)) {
        if (
          writeIfChanged(join(configDir, 'routing.yml'), readFileSync(routing, 'utf8'), false) ===
          'created'
        ) {
          result.created++
        } else result.skipped++
      }
    }
  } catch (err) {
    result.errors.push(`agents: ${err.message}`)
  }

  // ── skills ──
  try {
    const names = collectSkillNames()
    if (names.length > 0) bump(installSkills(names, configDir, false, ''))
  } catch (err) {
    result.errors.push(`skills: ${err.message}`)
  }

  // ── instructions (AGENTS.md) ──
  try {
    const src = join(ROOT, 'AGENTS.md')
    if (existsSync(src)) {
      if (
        writeIfChanged(join(configDir, 'AGENTS.md'), readFileSync(src, 'utf8'), false) === 'created'
      ) {
        result.created++
      } else result.skipped++
    }
  } catch (err) {
    result.errors.push(`instructions: ${err.message}`)
  }

  // ── commands (*.md) ──
  try {
    const srcCmds = join(ROOT, 'commands')
    if (existsSync(srcCmds)) {
      bump(syncDir(srcCmds, join(configDir, 'commands'), false, false, (f) => f.endsWith('.md')))
    }
  } catch (err) {
    result.errors.push(`commands: ${err.message}`)
  }

  // ── runtime payload (MCP scripts, code-mode, tiers) ──
  try {
    const dstScripts = join(configDir, 'scripts')
    mkdirSync(dstScripts, { recursive: true })
    for (const [name, srcFn] of Object.entries(MCP_SCRIPTS)) {
      const src = srcFn()
      if (!existsSync(src)) continue
      const content = readFileSync(src, 'utf8')
      const dst = join(dstScripts, name)
      if (writeIfChanged(dst, content, false) === 'created') {
        statSync(dst)
        result.created++
      } else result.skipped++
    }

    const req = join(ROOT, 'src', 'mcp', 'requirements-vision.txt')
    if (existsSync(req)) {
      if (
        writeIfChanged(
          join(configDir, 'requirements-vision.txt'),
          readFileSync(req, 'utf8'),
          false,
        ) === 'created'
      ) {
        result.created++
      } else result.skipped++
    }

    const srcCodeMode = join(ROOT, '.pantheon', 'code-mode')
    const dstCodeMode = join(configDir, '.pantheon', 'code-mode')
    if (existsSync(srcCodeMode)) {
      bump(syncDir(srcCodeMode, dstCodeMode, false, false))
    }

    const srcTiers = join(ROOT, '.pantheon', 'tiers.json')
    const dstTiers = join(configDir, '.pantheon', 'tiers.json')
    if (existsSync(srcTiers)) {
      if (writeIfChanged(dstTiers, readFileSync(srcTiers, 'utf8'), false) === 'created')
        result.created++
      else result.skipped++
    }
  } catch (err) {
    result.errors.push(`runtime: ${err.message}`)
  }

  return result
}

/** Drop stale entries in dst that no longer exist in src (agents/skills dirs). */
export function pruneMissing(srcDir, dstDir) {
  if (!existsSync(srcDir) || !existsSync(dstDir)) return 0
  const src = new Set(readdirSync(srcDir))
  let removed = 0
  for (const entry of readdirSync(dstDir)) {
    if (!src.has(entry)) {
      rmSync(join(dstDir, entry), { recursive: true, force: true })
      removed++
    }
  }
  return removed
}
