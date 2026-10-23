#!/usr/bin/env node

/**
 * doctor.mjs — Pantheon health check CLI tool
 *
 * Validates that a Pantheon installation is working correctly:
 *   - Canonical agent file presence
 *   - MCP configuration (gh_grep, Context7, etc.)
 *   - Permission/frontmatter mismatches
 *   - OpenCode artifact freshness
 *   - Git status
 *   - Node runtime (node:sqlite availability for pantheon_cost)
 *
 * Usage:
 *   node scripts/doctor.mjs                          # auto-detect, cwd
 *   node scripts/doctor.mjs --target /path/to/project
 *   node scripts/doctor.mjs --fix                    # attempt auto-fixes
 *   node scripts/doctor.mjs --verbose
 *   node scripts/doctor.mjs --help
 *
 * Result classification: PASS, WARN (advisory), ERROR (blocking), or SKIP.
 * Exit codes: 0 = no blocking errors (warnings are allowed), 2 = errors.
 */

import { spawn as spawnAsync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listV2UnsupportedFeatures } from '../src/pantheon/v2-unsupported.mjs'
import { classifyFileInventory } from './install/file-inventory.mjs'
import { staleTuiRefs } from './install/plugin.mjs'
import { readState } from './install/state.mjs'
import { describePluginOptionsReachability } from './install/v2-capabilities.mjs'
import { isSupportedNodeVersion, MIN_SUPPORTED_NODE_VERSION } from './node-engine-policy.mjs'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const AGENTS_DIR = join(ROOT, 'src', 'agents')
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{ pass: number; warn: number; error: number; info: number }} */
const counts = { pass: 0, warn: 0, error: 0, info: 0 }

const results = []
let exitCode = 0
let jsonMode = false
let jsonOriginalWrite = null
let jsonArgs = null

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    target: null,
    platform: null,
    fix: false,
    verbose: false,
    json: false,
    help: false,
    profile: process.env.PANTHEON_PROFILE ?? 'auto',
  }

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--target':
        args.target = argv[++i]
        break
      case '--fix':
        args.fix = true
        break
      case '--verbose':
        args.verbose = true
        break
      case '--json':
        args.json = true
        break
      case '--profile':
        args.profile = argv[++i] ?? 'auto'
        break
      case '--help':
      case '-h':
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

  // Resolve to absolute
  if (!args.target.startsWith('/')) {
    args.target = join(process.cwd(), args.target)
  }

  if (args.profile === 'auto') {
    const target = resolve(args.target)
    // A checkout is not a managed OpenCode installation: its repository
    // config intentionally contains only development MCPs. Use the lite
    // policy for `npm run doctor` so a fresh checkout does not require a
    // user's global MCP registry or pre-existing venv.
    args.profile =
      target === resolve(ROOT)
        ? 'lite'
        : args.target.includes('pantheon-sandbox')
          ? 'sandbox'
          : 'global'
  }

  return args
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const ICON = {
  pass: '\u2705', // ✅
  warn: '\u26A0\uFE0F', // ⚠️
  error: '\u274C', // ❌
  info: '\u2139\uFE0F', // ℹ️
}

// Per-section tally of PASS checks. Without --verbose the individual passing
// lines are suppressed, so a section used to print its header and then nothing
// — indistinguishable from a check that never ran. The tally is flushed when
// the next section starts (and before the summary) so every section accounts
// for itself.
let sectionPasses = 0

function verboseOutput() {
  return process.argv.includes('--verbose')
}

function flushSectionPasses() {
  const passed = sectionPasses
  sectionPasses = 0
  if (passed === 0 || verboseOutput()) return
  console.log(`  ${ICON.pass} ${passed} ${passed === 1 ? 'check' : 'checks'} passed`)
}

function emit(category, message, metadata = {}) {
  counts[category]++
  results.push({ category, message, ...metadata })
  if (category === 'pass' && !verboseOutput()) {
    sectionPasses++
    return
  }
  const prefix = ICON[category] ?? category
  console.log(`  ${prefix} ${message}`)
}

function pass(msg, metadata = {}) {
  emit('pass', msg, metadata)
}
function warn(msg, metadata = {}) {
  emit('warn', msg, metadata)
}
function error(msg, metadata = {}) {
  emit('error', msg, metadata)
  exitCode = 2
}
function info(msg, metadata = {}) {
  emit('info', msg, metadata)
}

function section(title) {
  flushSectionPasses()
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${'='.repeat(60)}`)
}

function showHelp() {
  console.log(`
 Pantheon Doctor — Health Check CLI

 Usage:
   node scripts/doctor.mjs                              auto-detect, cwd
   node scripts/doctor.mjs --target /path/to/project     target project
   node scripts/doctor.mjs --profile global|lite|sandbox profile policy
  node scripts/doctor.mjs --fix                         attempt auto-fixes
  node scripts/doctor.mjs --json                        read-only JSON report
   node scripts/doctor.mjs --verbose                     detailed output
   node scripts/doctor.mjs --help                        show this help

 Checks:
   A. Agent Files          — canonical agent files
   B. MCP Configuration    — opencode.json MCP settings (Config layer)
   B.5 MCP Spawn Paths     — local MCP exe/args resolve to existing files
   B.6 MCP Runtime Smoke   — spawn each local MCP + JSON-RPC initialize handshake
   C. Permission Checks    — frontmatter validation
   D. OpenCode Status      — OpenCode artifact layout
   E. Git Status           — uncommitted changes
    F. Runtime Layer        — runtime Python + pinned pip dependencies
   H3. Plugin Drift        — registered plugin version vs this package
   H5. TUI Plugin          — copied TUI payload + host registration (fail-closed)
   K. Node Runtime         — node:sqlite availability for pantheon_cost

 Exit codes:
   0  — no blocking errors (warnings are advisory)
    2  — blocking errors

  Profiles: global (core MCPs required), lite (MCPs optional), sandbox (core MCPs required)

 Report bugs: https://github.com/ils15/pantheon/issues
`)
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/** @type {Set<string>} agent-defining frontmatter fields */
const AGENT_FRONTMATTER_FIELDS = new Set(['name', 'description', 'mode'])

/**
 * Return true if the file content has YAML frontmatter containing at least
 * one agent-defining field (name, description, or mode). Non-agent .md files
 * such as README.md are excluded.
 * @param {string} content
 * @returns {boolean}
 */
export function isValidAgentFile(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return false
  const fm = match[1]
  for (const field of AGENT_FRONTMATTER_FIELDS) {
    if (new RegExp(`(?:^|\\r?\\n)${field}\\s*:`).test(fm)) return true
  }
  return false
}

/**
 * Collect canonical agent names from agents/*.md
 * @returns {string[]} sorted list of agent names (without extension)
 */
function getCanonicalAgentNames() {
  if (!existsSync(AGENTS_DIR)) return []
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: f, path: join(AGENTS_DIR, f) }))
    .filter(({ path: p }) => isValidAgentFile(readFileSync(p, 'utf8')))
    .map(({ name }) => name.replace(/\.agent\.md$/, ''))
    .sort()
}

/**
 * Read JSON from a file, returning null on failure.
 * @param {string} filePath
 * @returns {object|null}
 */
function readJson(filePath) {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Spawn a process and return { status, stdout, stderr }.
 */
function spawn(prog, args, cwd = null) {
  const result = spawnSync(prog, args, {
    cwd: cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

// ---------------------------------------------------------------------------
// Check A: Agent Files
// ---------------------------------------------------------------------------

function checkAgentFiles() {
  section('A. Agent Files')

  const canonical = getCanonicalAgentNames()
  if (canonical.length === 0) {
    error('No canonical agent files found in agents/')
    return
  }
  pass(`${canonical.length} canonical agents found in agents/`)
}

// ---------------------------------------------------------------------------
// Check B: MCP Configuration
// ---------------------------------------------------------------------------

/** Resolve the effective OpenCode user config directory. */
export function resolveOpenCodeConfigDir(env = process.env) {
  if (env.PANTHEON_HOME) return resolve(env.PANTHEON_HOME)
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config')
  return join(base, 'opencode')
}

/**
 * Collect every reachable opencode.json (project → repository → user config)
 * with its parsed content, for the config, spawn-path and runtime layers.
 * @returns {{label:string, path:string, data:object}[]}
 */
export function collectMcpConfigs(args) {
  const candidates = [{ label: 'project root', path: join(args.target, 'opencode.json') }]
  // The package's own template is useful when doctor is run from the
  // repository, but must not be treated as a user's config from an installed
  // package. Otherwise every global/project sandbox reports false MCP errors.
  if (resolve(args.target) === resolve(ROOT))
    candidates.push({ label: 'repository root', path: join(ROOT, 'opencode.json') })

  // OpenCode resolves user configuration independently of cwd. Keep the
  // project-local .opencode config for repository checks, but always include
  // the effective user config so a sandbox HOME is not mistaken for cwd.
  candidates.push({
    label: 'project .opencode config',
    path: join(args.target, '.opencode', 'opencode.json'),
  })
  candidates.push({
    label: 'user config',
    path: join(resolveOpenCodeConfigDir(args.env ?? process.env), 'opencode.json'),
  })

  const configs = []
  const seen = new Set()
  for (const c of candidates) {
    if (seen.has(c.path)) continue
    seen.add(c.path)
    const data = readJson(c.path)
    if (data) {
      configs.push({ label: c.label, data, path: c.path })
    }
  }
  return configs
}

function checkMcpConfig(args) {
  section('B. MCP Configuration')

  const configs = collectMcpConfigs(args)
  // This required-server check tests config-entry presence only. It does not
  // verify enabled state, command/transport usability, connectivity, or health.
  const requiredMcpNames =
    args.profile === 'lite' ? [] : ['pantheon-memory', 'pantheon-resources', 'pantheon-persistence']

  if (configs.length === 0) {
    if (requiredMcpNames.length > 0) {
      error(
        `No opencode.json found (searched project/repository and ${resolveOpenCodeConfigDir(args.env ?? process.env)}); required MCPs missing: ${requiredMcpNames.join(', ')}`,
      )
    } else {
      info(`No opencode.json found for ${args.profile} profile — MCP check skipped`)
    }
    return
  }

  for (const cfg of configs) {
    info(`Checking ${cfg.label} opencode.json`)

    const mcp = cfg.data.mcp
    if (!mcp || typeof mcp !== 'object') {
      if (requiredMcpNames.length > 0)
        error(`${cfg.label}: required MCPs missing — no "mcp" section`)
      else info(`${cfg.label}: no "mcp" section (${args.profile} profile — optional)`)
      continue
    }

    // 1. gh_grep MCP check (optional in every supported profile)
    const ghGrep = mcp.gh_grep
    if (ghGrep) {
      if (ghGrep.type === 'remote' && ghGrep.url === 'https://mcp.grep.app') {
        pass(`${cfg.label}: gh_grep MCP configured correctly`)
      } else {
        const gotUrl = ghGrep.url ?? '<missing>'
        const detail =
          ghGrep.type !== 'remote'
            ? `type is "${ghGrep.type}" instead of "remote"`
            : `url is "${gotUrl}"`
        warn(`${cfg.label}: gh_grep MCP may need review — ${detail}`)
      }
    } else {
      info(`${cfg.label}: optional gh_grep MCP not configured (${args.profile} profile)`)
    }

    // 2. Context7 MCP check
    const context7 = mcp.context7
    if (context7) {
      const isLocal = context7.type === 'local'
      const hasCommand =
        Array.isArray(context7.command) &&
        context7.command.length > 0 &&
        context7.command.some((s) => s.includes('context7-mcp') || s.includes('context7'))
      const enabled = context7.enabled !== false

      if (isLocal && hasCommand && enabled) {
        pass(`${cfg.label}: Context7 MCP configured correctly`)
      } else {
        const details = []
        if (!isLocal) details.push(`type should be "local"`)
        if (!hasCommand) details.push("command missing or doesn't mention context7-mcp")
        if (!enabled) details.push('not enabled')
        warn(`${cfg.label}: Context7 MCP issues — ${details.join(', ')}`)
      }
    } else {
      info(`${cfg.label}: optional Context7 MCP not configured (${args.profile} profile)`)
    }

    // 3. Check for deprecated "tools" field format
    // In opencode.json, tools was deprecated in favor of "permission" field
    if (cfg.data.tools && !cfg.data.permission) {
      warn(`${cfg.label}: uses deprecated top-level "tools" field — migrate to "permission"`)
    } else if (cfg.data.tools && cfg.data.permission) {
      info(`${cfg.label}: has both "tools" and "permission" — verify "tools" is intentional`)
    }

    // 4. Check MCP servers list — verify tool references
    // Look at agent files for mcpServers and cross-reference with opencode.json MCP config
    if (args.verbose) {
      checkAgentMcpReferences(cfg)
    }

    // 5. Hermetic spawn check — every local MCP command must resolve to an
    // existing executable and existing absolute script paths. Catches the
    // ENOENT-on-spawn failure class (dead hardcoded path, ambiguous relative
    // path) before opencode tries to spawn the server.
    for (const [name, mcpEntry] of Object.entries(mcp)) {
      if (mcpEntry?.type !== 'local') continue
      const cmd = mcpEntry.command
      if (!Array.isArray(cmd) || cmd.length === 0) {
        warn(`${cfg.label}: MCP "${name}" has no command array`)
        continue
      }
      const exe = cmd[0]
      if (!exe.includes('/')) {
        // PATH-resolved executable — cannot verify statically; surface for manual check
        info(
          `${cfg.label}: MCP "${name}" uses PATH executable "${exe}" (verify with \`which ${exe}\`)`,
        )
        continue
      }
      const effectiveCwd = resolveMcpCwd(mcpEntry, cfg.path)
      const effectiveExe = exe.startsWith('/') ? exe : resolve(effectiveCwd, exe)
      if (!existsSync(effectiveExe)) {
        error(`${cfg.label}: MCP "${name}" executable does not exist: ${effectiveExe}`)
        continue
      }
      const deadArgs = resolveMcpScriptPaths(mcpEntry, cfg.path).filter((path) => !existsSync(path))
      if (deadArgs.length > 0) {
        error(`${cfg.label}: MCP "${name}" has missing script path(s): ${deadArgs.join(', ')}`)
      }
    }
  }

  if (requiredMcpNames.length > 0) {
    const configured = new Set(configs.flatMap((cfg) => Object.keys(cfg.data.mcp ?? {})))
    for (const required of requiredMcpNames) {
      if (configured.has(required))
        pass(
          `Required MCP "${required}" entry is present (presence check only; this check does not verify enabled state, command/transport usability, connectivity, or health)`,
        )
      else error(`Required MCP "${required}" not configured in any available config`)
    }
  }
}

// ---------------------------------------------------------------------------
// Check B.6: MCP Runtime Smoke (JSON-RPC initialize handshake)
// ---------------------------------------------------------------------------
// The static spawn-path check (B.5) proves the files exist; this layer proves
// the server actually STARTS and answers the JSON-RPC initialize handshake.
// Catches ENOENT-on-spawn, Python import errors and runtime crashes that the
// static check cannot see — with a hard timeout so a hung server fails the
// check instead of blocking the doctor run.

/**
 * Spawn one local MCP server, send a JSON-RPC `initialize` request and wait
 * for a well-formed response.
 * @param {string[]} command - argv of the MCP server (exe + args)
 * @param {string} cwd - working directory (relative script args resolve here)
 * @param {number} timeoutMs - hard timeout for the handshake
 * @returns {Promise<{ok:boolean, serverName?:string, reason?:string}>}
 */
function mcpInitializeSmoke(command, cwd, timeoutMs) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pantheon-doctor', version: '0.0.0' },
    },
  })
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawnAsync(command[0], command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ ok: false, reason: `spawn threw: ${err.message}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, reason: `timeout after ${timeoutMs}ms (no initialize response)` }),
      timeoutMs,
    )
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      const line = stdout.split('\n').find((l) => l.includes('"id":1'))
      if (!line) return
      try {
        const msg = JSON.parse(line.trim())
        if (msg.id === 1 && msg.result) {
          const info = msg.result.serverInfo
          const label = info?.name
            ? `${info.name}${info.version ? ` ${info.version}` : ''}`
            : undefined
          finish({ ok: true, serverName: label })
          return
        }
        if (msg.error) {
          finish({
            ok: false,
            reason: `initialize error: ${msg.error.code ?? ''} ${msg.error.message ?? ''}`,
          })
        }
      } catch {
        /* not JSON yet — keep buffering */
      }
    })
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 4096) stderr = stderr.slice(-4096)
    })
    proc.on('error', (err) =>
      finish({ ok: false, reason: `spawn failed: ${err.code ?? err.message}` }),
    )
    proc.on('exit', (code, signal) => {
      if (done) return
      const tail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ')
      finish({
        ok: false,
        reason: `process exited early (code=${code} signal=${signal})${tail ? ` — ${tail}` : ''}`,
      })
    })
    proc.stdin.write(`${payload}\n`)
    proc.stdin.end()
  })
}

async function checkMcpRuntimeSmoke(args) {
  section('B.6 MCP Runtime Smoke')

  const local = []
  for (const cfg of collectMcpConfigs(args)) {
    for (const [name, entry] of Object.entries(cfg.data.mcp ?? {})) {
      if (entry?.type !== 'local') continue
      if (!Array.isArray(entry.command) || entry.command.length === 0) continue
      const cwd = resolveMcpCwd(entry, cfg.path)
      const command = entry.command.map((part, index) =>
        index === 0 || part.startsWith('-') || part.startsWith('/') ? part : resolve(cwd, part),
      )
      local.push({ name, command, cwd, source: cfg.label })
    }
  }

  if (local.length === 0) {
    if (args.profile === 'lite') {
      info('No local MCP servers found in lite profile — smoke test skipped')
    } else {
      error('No local MCP servers found in any config — required runtime MCPs are missing')
    }
    return
  }

  info(`Smoke-testing ${local.length} local MCP server(s) via JSON-RPC initialize`)

  for (const { name, command, cwd, source } of local) {
    const result = await mcpInitializeSmoke(command, cwd, 10000)
    if (result.ok) {
      pass(
        `MCP "${name}" (${source}): initialize handshake OK${result.serverName ? ` — ${result.serverName}` : ''}`,
      )
    } else {
      error(`MCP "${name}" (${source}): ${result.reason}`)
    }
  }
}

/**
 * Cross-reference agent mcpServers references with opencode.json MCP config entries.
 */
function checkAgentMcpReferences(cfg) {
  const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))
  const mcpNames = new Set(Object.keys(cfg.data.mcp ?? {}))
  const referencedNames = new Set()

  for (const file of agentFiles) {
    const content = readFileSync(join(AGENTS_DIR, file), 'utf8')
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match) continue

    try {
      // Minimal YAML parse for mcpServers field
      const fmRaw = match[1]
      const mcpMatch = fmRaw.match(/mcpServers:\s*\n([\s\S]*?)(?=\n\w|\n---|$)/)
      if (!mcpMatch) continue

      const listRaw = mcpMatch[1]
      const nameMatches = listRaw.matchAll(/^\s+-\s+name:\s*['"]?([\w-]+)['"]?\s*$/gm)
      for (const nm of nameMatches) {
        referencedNames.add(nm[1])
      }
    } catch {
      // skip unparseable
    }
  }

  for (const ref of referencedNames) {
    if (!mcpNames.has(ref)) {
      warn(`${cfg.label}: agent references MCP "${ref}" but it's not in opencode.json mcp config`)
    }
  }
}

// ---------------------------------------------------------------------------
// Check C: Permission Mismatches
// ---------------------------------------------------------------------------

function checkPermissionMismatches(args) {
  section('C. Permission Mismatches')

  // Locate the validation script
  const validator = join(ROOT, 'scripts', 'validate-agent-frontmatter.py')
  if (!existsSync(validator)) {
    info(
      `validate-agent-frontmatter.py not found — optional helper skipped (${args.profile} profile)`,
    )
    return
  }

  // Determine which agent directories to check
  // Validate the canonical agents and the OpenCode installation independently.
  info('Running validate-agent-frontmatter.py...')

  const result = spawn('python3', [validator])

  if (result.status === 0) {
    pass('Frontmatter validation passed')
    if (result.stdout && args.verbose) {
      console.log(`    ${result.stdout}`)
    }
  } else {
    // Parse output for errors and warnings
    const lines = (result.stderr || '').split('\n').filter(Boolean)
    const errLines = lines.filter((l) => l.startsWith('\u274C')) // ❌
    const warnLines = lines.filter((l) => l.includes('\u26A0')) // ⚠️

    if (errLines.length > 0) {
      error(`${errLines.length} frontmatter error(s) found`)
      if (args.verbose) {
        for (const line of errLines) {
          console.log(`    ${line}`)
        }
      }
    }

    if (warnLines.length > 0) {
      warn(`${warnLines.length} frontmatter warning(s) found`)
      if (args.verbose) {
        for (const line of warnLines) {
          console.log(`    ${line}`)
        }
      }
    }

    // If there were only warnings but no errors, the script exits 0
    // If it exited non-zero, there are real errors
    if (errLines.length === 0 && result.status !== 0) {
      error('Frontmatter validation script failed')
      if (result.stderr && args.verbose) {
        console.log(`    ${result.stderr}`)
      }
    }
  }

  // Also do a quick inline check for agents with bash: deny missing the ⛔ section
  info('Checking permission.body consistency...')
  const canonical = getCanonicalAgentNames()
  let bodyIssues = 0

  for (const agent of canonical) {
    const filePath = join(AGENTS_DIR, `${agent}.md`)
    if (!existsSync(filePath)) continue

    const content = readFileSync(filePath, 'utf8')

    // Quick frontmatter parse
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (!fmMatch) continue

    const rawFm = fmMatch[1]
    const body = fmMatch[2]

    // Check bash: deny → must have ⛔ TOOLS NOT AVAILABLE
    const bashDeny = /permission:[\s\S]*?bash:\s*deny/.test(rawFm)
    if (bashDeny && !body.includes('\u26D4 TOOLS NOT AVAILABLE'.normalize())) {
      warn(`${agent}: permission.bash is deny but body missing "⛔ TOOLS NOT AVAILABLE"`)
      bodyIssues++
    }

    // Check edit: deny → should not reference "edit" in body
    const editDeny = /permission:[\s\S]*?edit:\s*deny/.test(rawFm)
    if (editDeny) {
      const editCount = (body.match(/\bedit\b/gi) || []).length
      if (editCount > 0) {
        warn(`${agent}: permission.edit is deny but "edit" appears ${editCount} time(s) in body`)
        bodyIssues++
      }
    }
  }

  if (bodyIssues === 0) {
    pass('All permission.body consistency checks passed')
  }
}

// ---------------------------------------------------------------------------
// Check D: OpenCode Status
// ---------------------------------------------------------------------------

function checkSyncStatus(args) {
  section('D. OpenCode Status')
  const agentsDir = join(args.target, '.opencode', 'agents')
  if (existsSync(agentsDir)) {
    pass('OpenCode agents directory is present')
    // Content gate: validate pantheon://agents CONTENT (zeus/hermes present),
    // not just connectivity/directory presence.
    const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
    if (agentFiles.length === 0) {
      warn('OpenCode agents directory is empty — pantheon://agents will serve no agents')
    } else {
      const names = new Set(agentFiles.map((f) => f.replace(/\.md$/, '').toLowerCase()))
      const missingCanonical = ['zeus', 'hermes'].filter((n) => !names.has(n))
      if (missingCanonical.length > 0) {
        error(
          `pantheon://agents content check failed — missing canonical agents in ${agentsDir}: ${missingCanonical.join(', ')}`,
        )
      } else {
        pass(
          `pantheon://agents content validated (zeus, hermes + ${agentFiles.length - 2} more agents)`,
        )
      }
    }
  } else {
    info('OpenCode agents directory not present — project may use global agents')
  }
}

// ---------------------------------------------------------------------------
// Check E: Git Status
// ---------------------------------------------------------------------------

function checkGitStatus(args) {
  section('E. Git Status')

  // Check if the target is a git repo
  const gitRoot = spawn('git', ['rev-parse', '--show-toplevel'])
  if (gitRoot.status !== 0) {
    info('Not a git repository — skipping')
    return
  }

  // Check the repository source and OpenCode configuration paths.
  const gitStatus = spawn('git', [
    'status',
    '--porcelain',
    '--',
    'src/agents/',
    'src/instructions/',
    '.opencode/',
    'opencode.json',
  ])

  if (gitStatus.status !== 0) {
    warn('Could not check git status')
    return
  }

  const lines = gitStatus.stdout ? gitStatus.stdout.split('\n').filter(Boolean) : []

  if (lines.length === 0) {
    pass('No uncommitted changes in Pantheon/OpenCode paths')
    return
  }

  // Categorize by type
  const modified = []
  const added = []
  const deleted = []
  const untracked = []

  for (const line of lines) {
    const statusCode = line.substring(0, 2).trim()
    const filePath = line.substring(3)
    if (statusCode === 'M' || statusCode === 'MM') modified.push(filePath)
    else if (statusCode === 'A') added.push(filePath)
    else if (statusCode === 'D') deleted.push(filePath)
    else if (statusCode === '?' || statusCode === '??') untracked.push(filePath)
    else modified.push(filePath)
  }

  const total = lines.length
  const details = []
  if (modified.length > 0) details.push(`${modified.length} modified`)
  if (added.length > 0) details.push(`${added.length} staged`)
  if (deleted.length > 0) details.push(`${deleted.length} deleted`)
  if (untracked.length > 0) details.push(`${untracked.length} untracked`)

  warn(`${total} uncommitted change(s) in Pantheon/OpenCode paths (${details.join(', ')})`)
  if (args.verbose) {
    for (const f of modified.slice(0, 10)) {
      console.log(`    M  ${f}`)
    }
    for (const f of added.slice(0, 5)) {
      console.log(`    A  ${f}`)
    }
    for (const f of deleted.slice(0, 5)) {
      console.log(`    D  ${f}`)
    }
    for (const f of untracked.slice(0, 5)) {
      console.log(`    ?? ${f}`)
    }
    if (lines.length > 20) {
      console.log(`    ... and ${lines.length - 20} more`)
    }
  }
}

// ---------------------------------------------------------------------------
// Check F: Runtime Layer — Runtime Python & pinned dependencies
// ---------------------------------------------------------------------------
// The MCP servers run on the venv Python under ~/.config/opencode/.venv
// (same resolution as scripts/install-mcp.mjs) after installation. A
// repository checkout/CI job is not an installed target, however, so it may
// intentionally have no venv. In that case the doctor uses PANTHEON_PYTHON or
// python3 and still validates the exact pins. Missing or mismatched packages
// remain blocking errors; the fallback never makes the runtime check advisory
// (issue #18 / #21).

/** Parse `pip freeze` output into a normalized name → version map. */
function parsePipFreeze(text) {
  const map = {}
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([A-Za-z0-9_.-]+)==(\S+)/)
    if (!m) continue
    map[m[1].toLowerCase().replace(/-/g, '_')] = m[2]
  }
  return map
}

/** Split a version string into comparable numeric segments. */
function parseVersion(v) {
  const m = String(v).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return []
  return [m[1], m[2] ?? '0', m[3] ?? '0', m[4] ?? '0'].map(Number)
}

/** Compare two versions numerically. Returns <0, 0 or >0. */
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 4; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da - db
  }
  return 0
}

/**
 * Check one requirement line (name + operator + version) against installed.
 * Emits pass/error through the doctor counters.
 */
function checkRequirementLine(line, installed) {
  const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*(==|>=|<=|>|<|~=|!=)\s*([^\s#]+)/)
  if (!m) return
  const name = m[1].toLowerCase().replace(/-/g, '_')
  const op = m[2]
  const want = m[3]
  const have = installed[name]
  if (have === undefined) {
    error(`Dependency "${m[1]}" not installed (required ${op}${want})`)
    return
  }
  const cmp = compareVersions(have, want)
  let ok = false
  switch (op) {
    case '==':
      ok = cmp === 0
      break
    case '>=':
      ok = cmp >= 0
      break
    case '<=':
      ok = cmp <= 0
      break
    case '>':
      ok = cmp > 0
      break
    case '<':
      ok = cmp < 0
      break
    case '!=':
      ok = cmp !== 0
      break
    case '~=': {
      const spec = parseVersion(want)
      const got = parseVersion(have)
      ok = got[0] === spec[0] && got[1] === spec[1] && cmp >= 0
      break
    }
  }
  if (ok) {
    pass(`Dependency ${m[1]}==${have} satisfies ${m[1]}${op}${want}`)
  } else {
    error(`Dependency ${m[1]} version mismatch: installed ${have}, required ${op}${want}`)
  }
}

/** Classify whether a required runtime file is available to the doctor. */
export function classifyRequiredRuntimeFile(exists) {
  return exists ? 'present' : 'error'
}

/** Validate a required runtime requirements file without downgrading absence. */
export function validateRequiredRuntimeFile(filePath) {
  const present = classifyRequiredRuntimeFile(existsSync(filePath)) === 'present'
  return {
    ok: present,
    message: present
      ? `requirements file present: ${filePath}`
      : `requirements file not found: ${filePath}`,
  }
}

function checkVenvLayer(args) {
  section('F. Runtime Layer — Runtime Python & Dependencies')

  const runtimePython = resolveRuntimePython(args)

  if (!isAbsolute(runtimePython) || !existsSync(runtimePython)) {
    if (runtimePython === 'python3') {
      info('No dedicated .venv found — validating the Python interpreter on PATH')
    } else {
      error(
        `Runtime Python not found: ${runtimePython} (set PANTHEON_PYTHON or run \`pantheon-opencode init\` to create a .venv)`,
      )
      return
    }
  }
  if (isAbsolute(runtimePython) && existsSync(runtimePython)) {
    pass(`Runtime Python exists: ${runtimePython}`)
  }

  const probe = spawn(runtimePython, ['-c', 'import sys; print(sys.version.split()[0])'])
  if (probe.status !== 0) {
    error(
      `Runtime Python does not respond (exit ${probe.status}): ${probe.stderr || 'interpreter is unavailable'}`,
    )
    return
  }
  pass(`Runtime Python responds (Python ${probe.stdout})`)

  const freeze = spawn(runtimePython, ['-m', 'pip', 'freeze'])
  if (freeze.status !== 0) {
    error(`pip freeze failed (exit ${freeze.status}) — cannot verify pinned versions`)
    return
  }
  const installed = parsePipFreeze(freeze.stdout)

  const reqFiles = [
    join(ROOT, 'src', 'mcp', 'requirements-mcp.txt'),
    join(ROOT, 'src', 'mcp', 'requirements-vision.txt'),
  ]
  for (const reqFile of reqFiles) {
    const requirement = validateRequiredRuntimeFile(reqFile)
    if (!requirement.ok) {
      error(requirement.message)
      continue
    }
    const base = basename(reqFile)
    info(`Checking ${base} pins against installed packages`)
    const lines = readFileSync(reqFile, 'utf8').split('\n')
    let checked = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      checked++
      checkRequirementLine(trimmed, installed)
    }
    if (checked === 0) warn(`${base}: no requirement entries found`)
  }
}

// ---------------------------------------------------------------------------
// Check F.2: Code-Mode Scripts Directory
// ---------------------------------------------------------------------------

/**
 * Return whether *dir* contains an executable code-mode target.
 *
 * Mirrors `_has_usable_scripts` in `scripts/code_mode.py`: a directory
 * is only a valid resolver candidate when it is a real (non-symlink) directory
 * containing a regular `.py`/`.sh` direct child. This prevents an empty project
 * overlay from masking a lower-priority installation that actually ships
 * scripts. Keep both implementations in sync (see tests/test_doctor_layers.mjs).
 */
function hasUsableScripts(dir) {
  try {
    if (!existsSync(dir)) return false
    const stat = lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    return readdirSync(dir).some((name) => {
      if (name.startsWith('.')) return false
      const lower = name.toLowerCase()
      if (!lower.endsWith('.py') && !lower.endsWith('.sh')) return false
      try {
        return statSync(join(dir, name)).isFile()
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/**
 * Verify the code-mode scripts directory exists for the resolved runtime
 * root (project → <target>/.opencode, otherwise the global config dir).
 * When absent, create it with a warning so the pantheon-code-mode MCP
 * server has a stable home (mirrors the installer's runtime seeding).
 */
export function checkCodeModeDir(args) {
  section('F.2 Code-Mode Scripts')
  const env = args.env ?? process.env
  const target = resolve(env.PANTHEON_PROJECT ?? args.target)
  const projectCandidates = [
    join(target, '.opencode', '.pantheon', 'code-mode'),
    join(target, '.pantheon', 'code-mode'),
  ]
  // Seeding semantics: an existing project candidate wins; a project
  // install (.opencode present) gets its runtime dir created when missing.
  // Only targets with no project layout fall back to the global config dir.
  const codeModeDir =
    projectCandidates.find(hasUsableScripts) ??
    (existsSync(join(target, '.opencode'))
      ? projectCandidates[0]
      : join(resolveOpenCodeConfigDir(env), '.pantheon', 'code-mode'))
  if (existsSync(codeModeDir)) {
    pass(`Code-mode scripts directory exists: ${codeModeDir}`)
    return codeModeDir
  }
  warn(`Code-mode scripts directory missing — creating empty ${codeModeDir}`)
  try {
    mkdirSync(codeModeDir, { recursive: true })
    info(`Created ${codeModeDir} (run \`pantheon-opencode init --components runtime\` to seed it)`)
  } catch (err) {
    error(`Cannot create code-mode directory ${codeModeDir}: ${err.message}`)
  }
  return codeModeDir
}

/** Resolve code-mode using the same project-first rule as the MCP server. */
export function resolveCodeModeDir(args) {
  const env = args.env ?? process.env
  const target = resolve(env.PANTHEON_PROJECT ?? args.target)
  const projectCandidates = [
    join(target, '.opencode', '.pantheon', 'code-mode'),
    join(target, '.pantheon', 'code-mode'),
  ]
  const projectDir = projectCandidates.find(hasUsableScripts)
  if (projectDir) return projectDir
  return join(resolveOpenCodeConfigDir(env), '.pantheon', 'code-mode')
}

/** Validate a code-mode manifest without modifying it. */
export function validateCodeModeManifest(codeModeDir) {
  const manifestPath = join(codeModeDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, message: `Code-mode manifest missing: ${manifestPath}` }
  }

  let data
  try {
    data = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return { ok: false, message: `Code-mode manifest malformed: ${manifestPath}` }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: 'Code-mode manifest malformed: root must be an object' }
  }
  if (data.version !== 1) {
    return { ok: false, message: 'Code-mode manifest malformed: version must be 1' }
  }
  if (!data.scripts || typeof data.scripts !== 'object' || Array.isArray(data.scripts)) {
    return { ok: false, message: 'Code-mode manifest malformed: scripts must be an object' }
  }

  const listed = Object.keys(data.scripts)
  const invalid = listed.filter(
    (name) => typeof data.scripts[name] !== 'string' || !/^[a-f0-9]{64}$/i.test(data.scripts[name]),
  )
  if (invalid.length) {
    return { ok: false, message: `Code-mode manifest invalid digest: ${invalid.join(', ')}` }
  }

  const actualScripts = readdirSync(codeModeDir).filter(
    (name) =>
      !name.startsWith('eval-') &&
      (name.endsWith('.py') || name.endsWith('.sh')) &&
      statSync(join(codeModeDir, name)).isFile(),
  )
  const missing = listed.filter((name) => !existsSync(join(codeModeDir, name)))
  const extra = actualScripts.filter((name) => !Object.hasOwn(data.scripts, name))
  const differing = listed.filter((name) => {
    const path = join(codeModeDir, name)
    if (!existsSync(path)) return false
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
    return digest !== data.scripts[name].toLowerCase()
  })
  if (missing.length || extra.length || differing.length) {
    const names = [...new Set([...missing, ...extra, ...differing])]
    return {
      ok: false,
      message: `Code-mode manifest mismatch: ${differing.length + missing.length + extra.length}/${listed.length} scripts differ — ${names.join(', ')}`,
    }
  }
  return { ok: true, count: listed.length, total: actualScripts.length }
}

/** Run the diagnostic manifest check after directory validation. */
export function checkCodeModeManifest(args) {
  const codeModeDir = resolveCodeModeDir(args)
  const result = validateCodeModeManifest(codeModeDir)
  if (!result.ok) {
    error(result.message)
    return
  }
  pass(`✅ Code-mode manifest valid: ${result.count}/${result.total} scripts verified`)
}

/**
 * Resolve the Python used by the runtime checks.
 *
 * Installed targets use the venv created by init. A checkout in CI does not
 * have that installation state, however, so the explicit PANTHEON_PYTHON
 * override and the PATH fallback make the contract reproducible without
 * silently skipping dependency validation.
 */
export function resolveRuntimePython(args) {
  const env = args.env ?? process.env
  if (typeof env.PANTHEON_PYTHON === 'string' && env.PANTHEON_PYTHON.trim() !== '') {
    return env.PANTHEON_PYTHON.trim()
  }

  const target = resolve(args.target)
  const isProject = existsSync(join(target, '.opencode'))
  const runtimeRoot = isProject ? target : resolveOpenCodeConfigDir(env)
  const venvCandidates =
    process.platform === 'win32'
      ? [
          join(runtimeRoot, '.venv', 'Scripts', 'python.exe'),
          join(runtimeRoot, '.venv', 'Scripts', 'python'),
        ]
      : [join(runtimeRoot, '.venv', 'bin', 'python3'), join(runtimeRoot, '.venv', 'bin', 'python')]
  const existing = venvCandidates.find((candidate) => existsSync(candidate))
  return existing ?? 'python3'
}

/** Return relative script arguments as absolute paths using an MCP entry cwd. */
export function resolveMcpScriptPaths(entry, configPath = '') {
  const cwd = resolveMcpCwd(entry, configPath)
  if (!Array.isArray(entry?.command)) return []
  return entry.command
    .slice(1)
    .filter(
      (arg) =>
        typeof arg === 'string' &&
        !arg.startsWith('-') &&
        (arg.endsWith('.py') || arg.includes('/')),
    )
    .map((arg) => (arg.startsWith('/') ? arg : resolve(cwd, arg)))
}

/** Resolve an MCP entry's cwd relative to the config file, as OpenCode does. */
export function resolveMcpCwd(entry, configPath = '') {
  const configured = entry?.cwd
  if (typeof configured === 'string' && configured !== '') {
    return configured.startsWith('/') ? configured : resolve(dirname(configPath), configured)
  }
  return dirname(configPath)
}

// ---------------------------------------------------------------------------
// Check H2: installed-version drift (beta.5)
// ---------------------------------------------------------------------------

/**
 * Prerelease-aware comparison for pantheon versions (X.Y.Z or X.Y.Z-beta.N).
 * A stable release outranks any beta of the same core version. Returns
 * <0, 0, >0 (a - b). The shared compareVersions/parseVersion above ignores
 * the `-beta.N` suffix (it only reads 4 numeric groups), which would make
 * every beta pair compare equal.
 */
function comparePantheonVersions(a, b) {
  const parse = (v) => {
    const m = String(v)
      .trim()
      .match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/)
    if (!m) return null
    return {
      core: [+m[1], +m[2], +m[3]],
      beta: m[4] === undefined ? Number.POSITIVE_INFINITY : +m[4],
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  // Infinity - Infinity is NaN, which would make equal stable versions compare
  // as drift for any caller using a strict === 0 check.
  if (pa.beta === pb.beta) return 0
  return pa.beta < pb.beta ? -1 : 1
}

/**
 * Compare the version recorded in the installation marker
 * (<config>/.pantheon/install-state.json, written by the postinstall sync)
 * against this package's version. When the package is newer, the config
 * merge/venv/MCP wiring may be stale — point the user at `update`.
 * Advisory only: a missing marker (pre-beta.5 install) is not an error.
 */
export function checkInstallVersionDrift(args) {
  section('H2 Installed Version')
  const env = args.env ?? process.env
  let pkgVersion = null
  try {
    pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return 'no-marker'
  }
  if (!pkgVersion) return 'no-marker'

  const statePath = join(resolveOpenCodeConfigDir(env), '.pantheon', 'install-state.json')
  let installed = null
  if (existsSync(statePath)) {
    try {
      installed = JSON.parse(readFileSync(statePath, 'utf8')).pantheon_version ?? null
    } catch {
      installed = null
    }
  }
  if (!installed) {
    info('No installation version marker found (pre-beta.5 install) — skipping drift check')
    return 'no-marker'
  }
  const drift = comparePantheonVersions(pkgVersion, installed)
  if (drift > 0) {
    warn(
      `Package v${pkgVersion} is newer than the last-synced installation (v${installed}) — ` +
        'run `npx pantheon-opencode update` (or re-run init) to refresh config, venv and MCP entries',
      { code: 'install_version_drift', classification: 'advisory' },
    )
    return 'package-newer'
  }
  if (drift < 0) {
    warn(
      `Installation marker (v${installed}) is newer than this package (v${pkgVersion}) — ` +
        'the doctor is running from a different install than the last sync',
      { code: 'install_version_drift', classification: 'advisory' },
    )
    return 'install-newer'
  }
  pass(`Installation in sync with package v${pkgVersion}`)
  return 'sync'
}

// ---------------------------------------------------------------------------
// Check H3: Plugin version drift (issue #158)
// ---------------------------------------------------------------------------
// npm installs are lockfile-authoritative: a package-lock.json pinned to an
// older pantheon-opencode (e.g. 1.4.1 satisfying ^1.4.1) is never re-resolved,
// so an installed copy under node_modules/pantheon-opencode can lag several
// releases behind the running package. The opencode.json keeps registering
// that stale copy's plugin path and the user silently runs an obsolete tool
// surface — 1.5.0 removed the pantheon_delegate tool, so a drifted install
// still exposes it. This layer compares the version of the package a
// registered plugin points into against this package's own version. Without
// network access the "latest" version IS the running package's version.

/** Locates an installed copy of this package inside a dependency tree. */
const INSTALLED_PACKAGE_MARKER = '/node_modules/pantheon-opencode/'

/**
 * Return the installed-package root containing a plugin path, or null when the
 * path is not inside a `node_modules/pantheon-opencode` tree.
 *
 * Only installed copies are compared: a dev checkout (e.g. <dev>/pantheon)
 * and unrelated directories named pantheon-opencode are deliberately not
 * flagged — the drift signal must never fire on a path the installer does not
 * own (see the third-party guards in scripts/install/opencode.mjs).
 *
 * @param {string|null|undefined} pluginPath
 * @returns {string|null}
 */
export function resolveInstalledPackageRoot(pluginPath) {
  if (typeof pluginPath !== 'string') return null
  const normalized = pluginPath.replaceAll('\\', '/')
  const index = normalized.toLowerCase().lastIndexOf(INSTALLED_PACKAGE_MARKER.toLowerCase())
  if (index === -1) return null
  return normalized.slice(0, index + INSTALLED_PACKAGE_MARKER.length - 1)
}

/**
 * The plugin identities the installer writes into the host config
 * (`resolveInstalledPlugin` in scripts/install/opencode.mjs). Only these refs —
 * and absolute paths to them inside an installed package — are owned by
 * Pantheon; anything else belongs to the user and is never checked here.
 */
const MANAGED_PLUGIN_IDENTITIES = new Set([
  'src/plugin.ts',
  'src/plugins/pantheon-hooks.ts',
  'src/plugin-v2',
  // Legacy V2 file ref from before the directory contract (still migrated by
  // the installer, so a pre-migration config is ours too).
  'src/plugin-v2.ts',
])

/**
 * Return the normalized path of a Pantheon-owned plugin registration, or null
 * when the ref is not a filesystem path this installer writes.
 *
 * P0-6: the installer stores an ABSOLUTE path (`join(ROOT, identity)`) and only
 * `init` re-resolves it. A dangling registration is therefore a real install
 * defect, and telling it apart from a third-party path requires this identity
 * check rather than a basename test — an unrelated user plugin may legitimately
 * end in `src/plugin.ts`.
 *
 * npm specs (`pantheon-opencode`, `pantheon-opencode/plugin-v2`) and
 * third-party paths are NOT paths this installer owns, so they return null and
 * are never reported.
 *
 * @param {unknown} ref
 * @returns {string|null}
 */
export function managedPluginPath(ref) {
  if (typeof ref !== 'string') return null
  const normalized = ref.replaceAll('\\', '/').replace(/\/$/, '')
  if (MANAGED_PLUGIN_IDENTITIES.has(normalized)) return normalized
  const index = normalized.toLowerCase().lastIndexOf(INSTALLED_PACKAGE_MARKER.toLowerCase())
  if (index === -1) return null
  const suffix = normalized.slice(index + INSTALLED_PACKAGE_MARKER.length)
  return MANAGED_PLUGIN_IDENTITIES.has(suffix) ? normalized : null
}

/**
 * Report every Pantheon-owned plugin registration whose target is missing.
 *
 * Fail-closed by design: the host drops a plugin it cannot load without an
 * error, so a dangling registration silently downgrades the install to "no
 * Pantheon tool surface at all". A version comparison cannot catch this — there
 * is no package to read a version from — which is exactly how the defect stayed
 * invisible.
 *
 * @param {{path: string, configPath: string, configLabel: string}[]} refs
 * @returns {boolean} true when at least one dangling registration was reported
 */
function reportDanglingPluginRegistrations(refs) {
  let reported = false
  for (const ref of refs) {
    if (managedPluginPath(ref.path) === null) continue
    // Relative refs resolve against the config directory, never the doctor's
    // cwd — the same rule the host loader and the drift comparison use.
    const absolute = isAbsolute(ref.path) ? ref.path : resolve(dirname(ref.configPath), ref.path)
    if (existsSync(absolute)) continue
    reported = true
    error(
      `${ref.configLabel}: Pantheon plugin is registered at ${ref.path}, which does not exist — ` +
        'the host silently drops a plugin it cannot load, so this install runs without the Pantheon tool surface ' +
        '(an upgrade that did not run `init` leaves the previous absolute path behind). ' +
        'Run `pantheon-opencode init` to re-resolve the registration to the installed tree',
      { code: 'plugin_path_missing', classification: 'error' },
    )
  }
  return reported
}

/**
 * Read the version of the installed pantheon-opencode package a registered
 * plugin path points into.
 * @param {string} pluginPath - absolute or config-relative plugin ref
 * @returns {{root: string, version: string}|null} null when not an installed copy
 */
function readInstalledPluginVersion(pluginPath) {
  const root = resolveInstalledPackageRoot(pluginPath)
  if (!root) return null
  const pkg = readJson(join(root, 'package.json'))
  if (!pkg || typeof pkg.version !== 'string') return null
  return { root, version: pkg.version }
}

/**
 * Classify plugin version drift between the package a registered plugin points
 * into and the running doctor's own package. Uses the prerelease-aware
 * comparator so a stable release outranks its own betas (1.5.0 > 1.5.0-beta.9).
 * Unreadable versions classify as "unknown" rather than drift, so a broken
 * package.json never produces a false warning.
 * @param {string|null} registeredVersion
 * @param {string|null} packageVersion
 * @returns {'sync'|'drift'|'unknown'}
 */
export function classifyPluginVersionDrift(registeredVersion, packageVersion) {
  if (!registeredVersion || !packageVersion) return 'unknown'
  return comparePantheonVersions(registeredVersion, packageVersion) === 0 ? 'sync' : 'drift'
}

/**
 * Collect the plugin refs registered across opencode.json configs, from both
 * the V1 `plugin` and V2 `plugins` lists. Each entry keeps the config it came
 * from so relative refs resolve against the config directory (as the loader
 * does), never against the doctor's cwd.
 * @param {{path: string, data: object}[]} configs
 * @returns {{path: string, configPath: string, configLabel: string}[]}
 */
export function collectRegisteredPluginRefs(configs) {
  const refs = []
  for (const cfg of configs) {
    for (const key of ['plugin', 'plugins']) {
      const list = cfg.data?.[key]
      if (!Array.isArray(list)) continue
      for (const ref of list) {
        if (typeof ref === 'string') {
          refs.push({ path: ref, key, configPath: cfg.path, configLabel: cfg.label })
        } else if (ref && typeof ref === 'object') {
          // Object-shaped entries carry their path under `package` (what the
          // V2 writer emits when it preserves plugin options), `path`/`source`
          // (host spellings) or `id`/`name`.
          const objectPath = ['package', 'path', 'source', 'id', 'name'].find(
            (k) => typeof ref[k] === 'string',
          )
          if (objectPath) {
            refs.push({
              path: ref[objectPath],
              key,
              configPath: cfg.path,
              configLabel: cfg.label,
            })
          }
        }
      }
    }
  }
  return refs
}

/**
 * Compare the version of the package each registered plugin points into (when
 * it is an installed copy under node_modules/pantheon-opencode) against this
 * package's own version, and warn on divergence. A drift warning is advisory
 * (a pinned copy is a legitimate choice); a Pantheon registration that points
 * at a path that no longer exists is a blocking error ('stale').
 * @param {object} args
 * @returns {'stale'|'drift'|'sync'|'skip'|'no-plugin'|'no-version'}
 */
export function checkPluginVersionDrift(args) {
  section('H3. Plugin Version Drift')

  const refs = collectRegisteredPluginRefs(collectMcpConfigs(args))
  if (refs.length === 0) {
    info('No plugin registrations found in opencode.json — version drift skipped')
    return 'no-plugin'
  }

  // P0-6: a missing tree has no version to compare, so the comparison loop
  // below used to `continue` past it and report "skipped" — the defect was
  // silent. Check existence first so the dangling case fails closed regardless
  // of whether this package's own version is readable.
  const staleReported = reportDanglingPluginRegistrations(refs)

  const pkg = readJson(join(ROOT, 'package.json'))
  const packageVersion = pkg?.version
  if (!packageVersion) {
    info('Plugin version drift skipped — this package has no readable version')
    return staleReported ? 'stale' : 'no-version'
  }

  const seen = new Set()
  let compared = 0
  let driftReported = false
  for (const ref of refs) {
    const absolute = isAbsolute(ref.path) ? ref.path : resolve(dirname(ref.configPath), ref.path)
    const installed = readInstalledPluginVersion(absolute)
    if (!installed) continue
    // The doctor running from the very tree the plugin points at is the
    // healthy global-install case — trivially in sync, never flagged.
    if (resolve(installed.root) === resolve(ROOT)) continue
    if (seen.has(installed.root)) continue
    seen.add(installed.root)
    compared++

    if (classifyPluginVersionDrift(installed.version, packageVersion) !== 'drift') continue
    driftReported = true
    warn(
      `${ref.configLabel}: plugin is registered inside pantheon-opencode v${installed.version}, but this package is v${packageVersion} — the registered tool surface is stale (pantheon_delegate was removed in 1.5.0). Run \`npx pantheon-opencode init\`, or update the package, to realign the registered plugin path`,
    )
  }

  if (staleReported) return 'stale'
  if (driftReported) return 'drift'
  if (compared === 0) {
    info(
      'No registered plugin points into an installed pantheon-opencode copy — version drift skipped',
    )
    return 'skip'
  }
  pass(`All registered plugins point at package v${packageVersion}`)
  return 'sync'
}

// ---------------------------------------------------------------------------
// Check H4: V2 feature reduction (the surface a migrating user loses)
// ---------------------------------------------------------------------------

/**
 * Whether an opencode.json registers the V2 generation of the Pantheon plugin.
 *
 * The V2 contract is the PLURAL `plugins` key; V1 is the singular `plugin` key.
 * So the key alone is not the test — a config can legitimately carry a
 * third-party entry in `plugins`. What identifies the generation is a Pantheon
 * V2 entry inside it. Matched on the `plugin-v2` marker so all three real
 * spellings are recognised: the canonical DIRECTORY (`src/plugin-v2`), an
 * absolute path to it, and the package export (`pantheon-opencode/plugin-v2`).
 *
 * @param {unknown} ref
 * @returns {boolean}
 */
function isV2PluginRef(ref) {
  const candidate =
    typeof ref === 'string'
      ? ref
      : ref && typeof ref === 'object'
        ? (ref.path ?? ref.source ?? ref.id ?? ref.name)
        : undefined
  return typeof candidate === 'string' && candidate.includes('plugin-v2')
}

/**
 * Whether any reachable config registers the V2 generation of the Pantheon
 * plugin. Split out of {@link collectV2UnsupportedFeatures} because "is the V2
 * generation registered" and "does the seed list anything" are TWO facts: the
 * first is about the user's config, the second about this repository's seed. A
 * single `features.length === 0` cannot tell them apart, and conflating them
 * let an emptied seed print "no V2 generation registered — nothing reduced".
 *
 * @param {{path:string, data:object}[]} configs
 * @returns {boolean}
 */
export function isV2GenerationRegistered(configs) {
  return configs.some((cfg) => {
    const list = cfg.data?.plugins
    return Array.isArray(list) && list.some(isV2PluginRef)
  })
}

/**
 * The V2 feature-reduction markers to report for a set of collected configs.
 *
 * Returns the shared seed verbatim when ANY reachable config registers the V2
 * generation, and an empty list otherwise. The strings come from
 * `src/pantheon/v2-unsupported.mjs` — the same seed `getUnsupportedFeatures()`
 * is built from — so doctor cannot report a reduction the plugin does not, or
 * miss one it does. Nothing is reworded here.
 *
 * An empty result is ambiguous on its own and deliberately not interpreted
 * here: ask {@link isV2GenerationRegistered} for the registration fact, or
 * {@link describeV2Reduction} to get both at once.
 *
 * @param {{path:string, data:object}[]} configs
 * @returns {string[]}
 */
export function collectV2UnsupportedFeatures(configs) {
  return isV2GenerationRegistered(configs) ? listV2UnsupportedFeatures() : []
}

/**
 * Decide what H4 prints, from the two distinct facts rather than from one list
 * length.
 *
 * Three cases, and the middle one used to be silently reported as the first:
 *
 *   - not registered → info. A V1 install is a supported configuration with
 *     nothing to reduce, and saying so plainly is correct.
 *   - registered, seed EMPTY → warn. This is a packaging fault in THIS repo,
 *     not an absence of reduction: the V2 surface really is reduced and the
 *     report is missing. It must never claim "nothing reduced".
 *   - registered, seed populated → warn, listing every marker.
 *
 * Pure and exported so the empty-seed branch is testable without stubbing the
 * frozen seed module. `status` is returned alongside the text so a caller never
 * has to recover the case by matching on the message.
 *
 * @param {{registered:boolean, features:string[]}} input
 * @returns {{status:'reported'|'empty-seed'|'no-v2-generation', level:'info'|'warn', message:string}}
 */
export function describeV2Reduction({ registered, features }) {
  if (!registered) {
    return {
      status: 'no-v2-generation',
      level: 'info',
      message: 'No V2 plugin generation registered — nothing reduced',
    }
  }
  if (features.length === 0) {
    return {
      status: 'empty-seed',
      level: 'warn',
      message:
        'Pantheon IS registered on the V2 plugin generation, but the shared ' +
        'unsupported-feature seed is empty, so the reduction cannot be reported. ' +
        "That is a fault in this installation's reporting, not an absence of " +
        'reduction: the V2 surface still registers fewer tools than V1 (the three ' +
        'goal tools are absent), so a clean report would be false.',
    }
  }
  return {
    status: 'reported',
    level: 'warn',
    message:
      'Pantheon is registered on the V2 plugin generation: 3 unconditional tools ' +
      '(hashline_edit, pantheon_cost, pantheon_model) plus the host-dependent ones, and a ' +
      "real hook/transform surface, against the V1 surface's 6 tools plus the " +
      'BackgroundJobBoard. Not provided on V2 (static seed — a live host can add runtime ' +
      `markers on top): ${features.join(', ')}`,
  }
}

/**
 * Report the V2 feature reduction through doctor's own output shape
 * (section + warn/info), so it lands in the health summary like every other
 * finding and never changes the exit code: a V2 install is a supported
 * configuration, not a broken one.
 *
 * @param {{target:string, env?:object}} args
 * @returns {'reported'|'empty-seed'|'no-v2-generation'|'no-config'}
 */
export function checkV2UnsupportedFeatures(args) {
  section('H4. V2 Feature Reduction')

  const configs = collectMcpConfigs(args)
  if (configs.length === 0) {
    info('No opencode.json was found — V2 feature reduction check skipped')
    return 'no-config'
  }

  // Branch on REGISTRATION, not on the marker count: an empty seed on a
  // registered V2 generation is a reporting fault and must not be reported as
  // the reassuring "nothing reduced".
  const registered = isV2GenerationRegistered(configs)
  const verdict = describeV2Reduction({
    registered,
    features: collectV2UnsupportedFeatures(configs),
  })
  if (verdict.level === 'info') info(verdict.message)
  else warn(verdict.message)

  // Whether the installed entry can receive plugin `options` at all: the host
  // passes them only from the object form, and `context_pruner` /
  // `memory_injection` read exactly that bag. A bare-string entry installs fine
  // and silently leaves both opt-ins unreachable, which is why this reports the
  // installed shape instead of trusting the installer to have got it right.
  if (registered) {
    const plugins = configs.flatMap((cfg) =>
      Array.isArray(cfg.data?.plugins) ? cfg.data.plugins : [],
    )
    const reach = describePluginOptionsReachability(plugins)
    if (reach.reachable) info(`Plugin options reachable: ${reach.detail}`)
    else warn(`Plugin options NOT reachable: ${reach.detail}`)
  }

  return verdict.status
}

/**
 * Where the TUI checker must look for a config dir's plugin payload.
 *
 * Mirrors the installer's own layout rule (`isGlobalConfigDir` + flat global
 * layout vs `.opencode/` project layout) through the installer exports rather
 * than re-deriving it, so the check cannot drift from what init writes.
 *
 * @param {{target: string}} args
 * @returns {Promise<{isGlobal: boolean, configDir: string, copyDir: string, tuiJsonPath: string}>}
 */
export async function resolveTuiInstallPaths(args) {
  const { isGlobalConfigDir, resolveTuiCopyTarget } = await import('./install/opencode.mjs')
  const isGlobal = isGlobalConfigDir(args.target)
  const configDir = isGlobal ? args.target : join(args.target, '.opencode')
  return {
    isGlobal,
    configDir,
    copyDir: resolveTuiCopyTarget(configDir),
    tuiJsonPath: join(configDir, 'tui.json'),
  }
}

/** Resolve the module a copied TUI package.json advertises for its host. */
function tuiExportTarget(pluginDir) {
  const pkg = readJson(join(pluginDir, 'package.json'))
  const exported = pkg?.exports?.['./tui'] ?? pkg?.main
  if (typeof exported !== 'string') return null
  const targetPath = isAbsolute(exported) ? exported : join(pluginDir, exported)
  return existsSync(targetPath) ? targetPath : null
}

function samePath(left, right) {
  if (typeof left !== 'string') return false
  return resolve(left) === resolve(right)
}

/**
 * Check H5: the installed TUI plugin (fail-closed).
 *
 * The TUI is the one component whose failure is silent: a missing payload or a
 * stale `tui.json` entry leaves the host loading nothing, with no error
 * anywhere. Every defect here gets its own `code` so a report can be acted on.
 *
 * Detection reuses the installer's own classifiers — `isPantheonTuiRef` /
 * `staleTuiRefs` for ownership — instead of a second, weaker notion of "looks
 * like our plugin".
 *
 * @param {{target:string, env?:object}} args
 * @returns {Promise<'not-installed'|'missing-dir'|'missing-dist'|'unregistered'|'stale-ref'|'ok'>}
 */
export async function checkTuiPlugin(args) {
  section('H5. TUI Plugin')

  const state = readState(args.target)
  const { copyDir, tuiJsonPath } = await resolveTuiInstallPaths(args)
  const pluginsInstalled = state?.components?.plugins?.status === 'installed'

  if (!pluginsInstalled && !existsSync(copyDir) && !existsSync(tuiJsonPath)) {
    info('TUI plugin is not installed for this target — check skipped')
    return 'not-installed'
  }

  if (!existsSync(copyDir)) {
    error(
      `TUI plugin directory is missing: ${copyDir} — the plugins component is recorded as ` +
        'installed but its payload is absent. Run `npx pantheon-opencode init` to restore it.',
      { code: 'tui_plugin_dir_missing', classification: 'missing' },
    )
    return 'missing-dir'
  }

  const v1Bundle = join(copyDir, 'dist', 'tui.js')
  const v2Bundle = join(copyDir, 'dist', 'tui-v2.js')
  if (!existsSync(v1Bundle) && !existsSync(v2Bundle)) {
    error(
      `TUI bundle is missing under ${join(copyDir, 'dist')} — the copied plugin cannot be ` +
        'loaded by either host. Run `npx pantheon-opencode init` to reinstall it.',
      { code: 'tui_plugin_dist_missing', classification: 'missing' },
    )
    return 'missing-dist'
  }

  const tuiConfig = readJson(tuiJsonPath)
  const pluginRefs = Array.isArray(tuiConfig?.plugin) ? tuiConfig.plugin : []
  const registered = pluginRefs.some((ref) => samePath(ref, copyDir))
  // V2 discovers local plugins from the plugins directory instead of tui.json;
  // its payload is identified by the sibling index.ts server entrypoint plus a
  // package export that resolves to the compiled V2 bundle.
  const v2Target = tuiExportTarget(copyDir)
  const v2Discovered =
    existsSync(join(copyDir, 'index.ts')) &&
    typeof v2Target === 'string' &&
    v2Target.endsWith('tui-v2.js')

  if (!registered && !v2Discovered) {
    error(
      `TUI plugin is copied to ${copyDir} but no host discovery finds it: ` +
        `${tuiJsonPath} does not reference it and the V2 discovery files are incomplete. ` +
        'Run `npx pantheon-opencode init` to re-register it.',
      { code: 'tui_plugin_not_registered', classification: 'ambiguous' },
    )
    return 'unregistered'
  }

  // Anything our classifier still owns that is NOT the current registration is
  // a leftover the host would also load — stale copies accumulate per init run.
  const stale = staleTuiRefs(pluginRefs, [copyDir]).filter((ref) => !samePath(ref, copyDir))
  if (stale.length > 0) {
    error(
      `tui.json still registers ${stale.length} stale Pantheon TUI reference(s): ` +
        `${stale.join(', ')} — run \`npx pantheon-opencode init\` to clean them.`,
      { code: 'tui_plugin_stale_ref', classification: 'ambiguous' },
    )
    return 'stale-ref'
  }

  pass(`TUI plugin installed at ${copyDir} and discoverable by the host`)
  return 'ok'
}

// ---------------------------------------------------------------------------
// Check G: AGENTS.md freshness
// ---------------------------------------------------------------------------

/**
 * Check AGENTS.md only where the repository's generator can provide a real
 * source-of-truth comparison. Installed targets have no canonical instruction
 * sources available to this process, so their freshness is deliberately not
 * guessed from file age.
 */
function checkAgentsMdFreshness(args) {
  section('G. AGENTS.md Freshness')

  const agentsMdPath = join(args.target, 'AGENTS.md')
  if (args.target !== ROOT) {
    const outcome = classifyAgentsMdFreshness({
      targetIsRoot: false,
      agentsMdExists: existsSync(agentsMdPath),
      generatorExists: false,
    })
    if (outcome === 'unverified') {
      info(
        'AGENTS.md is present; freshness was not checked because the canonical generator sources are not available in an installed target',
      )
    } else {
      warn(
        'AGENTS.md is not present; freshness cannot be verified for this installed target — run `pantheon-opencode init --components instructions`',
      )
    }
    return
  }

  const generator = join(ROOT, 'scripts', 'build-agents-md.mjs')
  if (!existsSync(generator)) {
    info('AGENTS.md freshness skipped — canonical generator is not available')
    return
  }

  const result = spawn(process.execPath, [generator, '--check'], ROOT)
  const outcome = classifyAgentsMdFreshness({
    targetIsRoot: true,
    agentsMdExists: existsSync(agentsMdPath),
    generatorExists: true,
    generatorStatus: result.status,
  })
  if (outcome === 'pass') {
    pass('AGENTS.md matches the canonical generated instructions')
  } else if (outcome === 'unverified' && !existsSync(agentsMdPath)) {
    warn(
      'AGENTS.md is missing — run `node scripts/build-agents-md.mjs` or `pantheon-opencode init`',
    )
  } else if (outcome === 'stale') {
    warn('AGENTS.md is stale — run `node scripts/build-agents-md.mjs` to refresh it')
  } else {
    warn(
      `AGENTS.md freshness could not be verified (generator exited ${result.status ?? 'unknown'})`,
    )
  }
}

/**
 * Classify the generator result without relying on timestamps or fragile
 * process mocks. The doctor CLI uses the same result contract internally.
 *
 * @param {{ targetIsRoot: boolean; agentsMdExists: boolean; generatorExists: boolean; generatorStatus?: number | null }} input
 * @returns {'pass' | 'missing' | 'stale' | 'skipped' | 'unverified'}
 */
export function classifyAgentsMdFreshness(input) {
  if (!input.targetIsRoot) return input.agentsMdExists ? 'unverified' : 'missing'
  if (!input.generatorExists) return 'skipped'
  if (input.generatorStatus === 0) return 'pass'
  if (input.generatorStatus === 1 && input.agentsMdExists) return 'stale'
  return 'unverified'
}

// ---------------------------------------------------------------------------
// Check H: Config migration — no top-level subagent_depth
// ---------------------------------------------------------------------------

function checkSubagentDepthPlacement(args) {
  section('H. Config Migration')

  const configs = collectMcpConfigs(args)
  if (configs.length === 0) {
    info('subagent_depth placement check skipped — no opencode.json was found')
    return
  }
  for (const cfg of configs) {
    if (cfg.data.subagent_depth !== undefined) {
      error(
        `${cfg.label}: top-level "subagent_depth" is unsupported — run \`pantheon-opencode init\` to migrate it to "experimental.subagent_depth"`,
      )
    } else if (
      cfg.data.experimental &&
      typeof cfg.data.experimental === 'object' &&
      cfg.data.experimental.subagent_depth !== undefined
    ) {
      pass(`${cfg.label}: experimental.subagent_depth = ${cfg.data.experimental.subagent_depth}`)
    } else {
      info(
        `${cfg.label}: experimental.subagent_depth is not configured (older/custom config may omit it)`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Check J: Agent permission.task presence
// ---------------------------------------------------------------------------

/** @param {string} content @returns {boolean} */
export function hasPermissionTask(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return false
  const permission = match[1].match(/(?:^|\r?\n)permission:\s*\r?\n([\s\S]*?)(?=\r?\n\S|$)/)
  return Boolean(permission && /^\s+task:\s*/m.test(permission[1]))
}

/**
 * Derive installed agent files from the paths already declared by configs.
 * This supports both global flat and project .opencode layouts without
 * assuming a user home directory.
 *
 * @param {{path: string, data: object}[]} configs
 * @returns {string[]}
 */
export function deriveInstalledAgentFiles(configs) {
  const directories = new Set()
  for (const cfg of configs) {
    for (const agent of Object.values(cfg.data.agent ?? {})) {
      const source = agent && typeof agent === 'object' ? agent.source : undefined
      if (typeof source !== 'string' || !source.includes('/')) continue
      const filePath = resolve(dirname(cfg.path), source)
      if (filePath.startsWith(`${AGENTS_DIR}/`)) continue
      if (existsSync(filePath)) directories.add(dirname(filePath))
    }
  }

  const files = []
  for (const directory of directories) {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const filePath = join(directory, entry.name)
      try {
        if (isValidAgentFile(readFileSync(filePath, 'utf8'))) {
          files.push(filePath)
        }
      } catch {
        // unreadable — skip
      }
    }
  }
  return [...new Set(files)].sort()
}

function checkPermissionTaskPresence(args) {
  section('J. Installed Agent permission.task')

  if (args.profile === 'lite') {
    info(
      'Installed agent permission.task check skipped (lite profile does not require managed agents)',
    )
    return
  }

  const installedFiles = deriveInstalledAgentFiles(collectMcpConfigs(args))
  if (installedFiles.length === 0) {
    info(
      'Installed agent permission.task check skipped — no agent source directory could be derived from available config',
    )
    return
  }

  const missing = findMissingPermissionTask(installedFiles)
  if (classifyPermissionTaskCheck(args.profile, installedFiles.length, missing.length) === 'pass') {
    pass(`All ${installedFiles.length} installed agents have permission.task`)
    return
  }

  for (const filePath of missing) {
    error(
      `${basename(filePath)}: missing permission.task in managed agent — run \`pantheon-opencode init\` to update installed agents`,
    )
  }
}

/** @param {string[]} filePaths @returns {string[]} */
export function findMissingPermissionTask(filePaths) {
  return filePaths.filter((filePath) => !hasPermissionTask(readFileSync(filePath, 'utf8')))
}

/**
 * Classify the installed-agent permission.task layer for a doctor profile.
 *
 * @param {string} profile
 * @param {number} installedCount
 * @param {number} missingCount
 * @returns {'skip' | 'pass' | 'error'}
 */
export function classifyPermissionTaskCheck(profile, installedCount, missingCount) {
  if (profile === 'lite' || installedCount === 0) return 'skip'
  return missingCount === 0 ? 'pass' : 'error'
}

// ---------------------------------------------------------------------------
// Check K: Node Runtime — node:sqlite availability (issue #114)
// ---------------------------------------------------------------------------

// pantheon_cost uses node:sqlite as its read-only backend; below this Node
// version the tool reports UNSUPPORTED (see the "Cost tool backend" README
// section). Matches the floor documented for the PANTHEON_NODE fallback.
const NODE_SQLITE_MIN = '22.5'

/**
 * Probe whether the running Node.js can load `node:sqlite` — the read-only
 * backend used by the `pantheon_cost` tool (issue #114). Runs the import in a
 * `--no-warnings` child so the experimental-feature notice never pollutes the
 * doctor output, and so a probe crash can never take down the doctor itself.
 *
 * @param {{ execPath?: string; module?: string }} [options]
 * @returns {{ available: boolean; version: string; reason?: string }}
 */
export function probeNodeSqlite(options = {}) {
  const execPath = options.execPath ?? process.execPath
  const target = options.module ?? 'node:sqlite'
  const result = spawn(execPath, [
    '--no-warnings',
    '--input-type=module',
    '-e',
    `import '${target}'`,
  ])
  if (result.status === 0) return { available: true, version: process.version }
  const reason = (result.stderr || result.stdout || 'import failed').split('\n')[0]
  return { available: false, version: process.version, reason }
}

/**
 * Classify a node:sqlite probe result for the doctor. Kept free of I/O so the
 * contract is exercised deterministically (see tests/test_doctor_layers.mjs).
 *
 * @param {{ available: boolean; version: string }} probe
 * @returns {{ status: 'ok' | 'unsupported'; message: string }}
 */
export function classifyNodeSqliteProbe(probe) {
  if (probe.available) {
    return {
      status: 'ok',
      message: `node:sqlite available on ${probe.version} — pantheon_cost read-only backend available`,
    }
  }
  return {
    status: 'unsupported',
    message: `pantheon_cost will report UNSUPPORTED on Node ${probe.version} — node:sqlite requires Node >= ${NODE_SQLITE_MIN}`,
  }
}

// ---------------------------------------------------------------------------
// Tool registration — a SEPARATE fact from backend capability (P0-3)
// ---------------------------------------------------------------------------

/**
 * Where each plugin generation declares its tool surface, relative to the
 * package root a registered plugin points into.
 *
 * The backend probe answers "can this Node read opencode.db?". It does NOT
 * answer "is `pantheon_cost` registered on the host at all?" — a tool removed
 * from (or never added to) the surface still had a green doctor before P0-3.
 * These files are the surface the doctor already ships and can inspect without
 * importing or executing plugin code.
 *
 * The V2 generation has TWO surfaces: `src/pantheon/v2-tools.ts` from beta.3
 * and the 1.5.0+ entry `src/plugin-v2.ts`, which declares the tools itself.
 * Reading only the first reported a healthy 1.5 tree as "pantheon_cost is NOT
 * declared", so every declared surface of the generation is inspected and their
 * declarations are unioned.
 */
const TOOL_SURFACE_FILES = Object.freeze({
  v1: Object.freeze([join('src', 'plugin.ts')]),
  v2: Object.freeze([join('src', 'plugin-v2.ts'), join('src', 'pantheon', 'v2-tools.ts')]),
})

/** The published package name — the only package identity this installer owns. */
const PANTHEON_PACKAGE_NAME = 'pantheon-opencode'

/** Remove comments so a name mentioned only in prose never counts as a tool. */
function stripSourceComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Extract the first `key: { ... }` object-literal body, or null. */
function extractObjectLiteralBody(source, key) {
  const match = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(source)
  if (!match) return null
  let depth = 0
  const start = match.index + match[0].length - 1
  for (let index = start; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (depth === 0) return source.slice(start + 1, index)
    }
  }
  return null
}

/**
 * Tool names declared by a plugin-generation source file.
 *
 * V2 declares each tool as `name: 'x'` in `createV2ToolDefinitions`, or — from
 * the 1.5.0 entry — as quoted elements of a `toolNames` array. V1 keys the
 * `tool:` object by tool name. Returns null when the generation's shape cannot
 * be located (unverifiable), which the classifier treats as a failure rather
 * than a pass: "cannot prove registration" is not "registered".
 *
 * @param {string} source
 * @param {'v1'|'v2'} generation
 * @returns {string[]|null}
 */
export function readDeclaredToolNames(source, generation) {
  const body = stripSourceComments(source)
  if (generation === 'v2') {
    const names = new Set(
      [...body.matchAll(/\bname:\s*['"]([A-Za-z0-9_-]+)['"]/g)].map((match) => match[1]),
    )
    for (const match of body.matchAll(/^\s*['"]([A-Za-z0-9_-]+)['"],?\s*$/gm)) names.add(match[1])
    return [...names]
  }
  const toolBlock = extractObjectLiteralBody(body, 'tool')
  if (toolBlock === null) return null
  return [...toolBlock.matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gm)].map((match) => match[1])
}

/**
 * Return the Pantheon package specifier a ref names, or null when it is not
 * one. Covers `pantheon-opencode`, `pantheon-opencode@1.2.3` and an export
 * subpath (`pantheon-opencode/plugin-v2`): the host resolves all of them
 * through its own module graph, not from a path this process can inspect.
 *
 * @param {unknown} refPath
 * @returns {string|null}
 */
export function pantheonPackageSpecifier(refPath) {
  if (typeof refPath !== 'string' || refPath.length === 0) return null
  if (isAbsolute(refPath) || refPath.startsWith('.') || refPath.includes('\\')) return null
  return refPath.split('/')[0].split('@')[0] === PANTHEON_PACKAGE_NAME ? refPath : null
}

/**
 * Resolve the package root a registered plugin ref points into.
 *
 * Path-shaped refs resolve against the config that declares them, exactly as
 * the loader does. A bare package specifier cannot be located from here, so it
 * resolves to null: the package the host loads is NOT necessarily the package
 * running this doctor, and standing ROOT in for it validated a surface the host
 * may never load (a false green, not evidence).
 *
 * @param {{path:string, configPath:string}} ref
 * @returns {string|null}
 */
export function resolveRegisteredPluginRoot(ref) {
  const refPath = typeof ref === 'string' ? ref : ref?.path
  if (typeof refPath !== 'string' || refPath.length === 0) return null

  let absolute = null
  if (isAbsolute(refPath)) {
    absolute = refPath
  } else if (ref?.configPath && /[\\/]/.test(refPath)) {
    absolute = resolve(dirname(ref.configPath), refPath)
  }
  if (!absolute) return null

  const normalized = absolute.replaceAll('\\', '/').replace(/\/+$/, '')
  const marker =
    /^(.*?)\/src\/plugin-v2(?:\/index\.ts|\.ts)?$/.exec(normalized) ??
    /^(.*?)\/src\/plugin(?:-v2)?\.ts$/.exec(normalized)
  const root = marker ? marker[1] : normalized
  return existsSync(join(root, 'package.json')) ? root : null
}

/**
 * Whether a registered ref belongs to Pantheon — the subject of this check.
 *
 * The same ownership criterion P0-6 uses: the plugin identity the installer
 * writes (or a path inside an installed `pantheon-opencode` tree), or a
 * `package.json` naming this package. Everything else belongs to the user, so a
 * third-party plugin registered under `plugins` is ignored instead of being
 * read as a Pantheon surface with a missing `src/pantheon/v2-tools.ts` (which
 * failed a healthy installation as blocking).
 *
 * @param {{path:string, configPath:string}} ref
 * @returns {boolean}
 */
export function isPantheonPluginRef(ref) {
  const refPath = typeof ref === 'string' ? ref : ref?.path
  if (typeof refPath !== 'string' || refPath.length === 0) return false
  if (managedPluginPath(refPath) !== null) return true
  if (pantheonPackageSpecifier(refPath) !== null) return true
  const root = resolveRegisteredPluginRoot(ref)
  if (!root) return false
  return readJson(join(root, 'package.json'))?.name === PANTHEON_PACKAGE_NAME
}

/** Describe one registered surface for a finding message. */
function describeSurface(surface) {
  if (surface.files.length === 0) {
    return `${surface.generation}: no tool surface under ${surface.root}`
  }
  return `${surface.generation}: ${surface.files.join(' + ')}`
}

/**
 * Inspect every registered Pantheon plugin and report the tool names its
 * declared surface contains. Non-Pantheon refs are ignored rather than failed:
 * they are not this check's subject. An npm specifier is Pantheon's own subject
 * but cannot be inspected, so it is carried as an explicit unverifiable surface
 * instead of being skipped or passed against the running package.
 *
 * @param {{target:string, env?:object}} args
 * @returns {{generation:'v1'|'v2'|null, root:string|null, files:string[], declared:string[]|null, unverifiable?:string}[]}
 */
export function resolveRegisteredToolSurfaces(args) {
  const refs = collectRegisteredPluginRefs(collectMcpConfigs(args))
  const surfaces = []
  const seen = new Set()
  for (const ref of refs) {
    if (!isPantheonPluginRef(ref)) continue

    if (pantheonPackageSpecifier(ref.path) !== null) {
      const key = `spec:${ref.path}`
      if (seen.has(key)) continue
      seen.add(key)
      surfaces.push({
        generation: null,
        root: null,
        files: [],
        declared: null,
        unverifiable:
          `"${ref.path}" is an npm specifier, not a path — the host resolves it through its own ` +
          'module graph, so the surface it loads cannot be inspected from here',
      })
      continue
    }

    const root = resolveRegisteredPluginRoot(ref)
    if (!root) continue
    const generation = ref.path?.includes('plugin-v2') || ref.key === 'plugins' ? 'v2' : 'v1'
    const key = `${generation}:${root}`
    if (seen.has(key)) continue
    seen.add(key)

    const files = TOOL_SURFACE_FILES[generation]
      .map((relative) => join(root, relative))
      .filter((file) => existsSync(file))
    const declared = new Set()
    let readable = 0
    for (const file of files) {
      let source = null
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const names = readDeclaredToolNames(source, generation)
      if (names === null) continue
      readable++
      for (const name of names) declared.add(name)
    }
    surfaces.push({
      generation,
      root,
      files,
      // No readable surface stays null so the classifier fails closed. With
      // several generation files present the declarations are unioned, so a
      // tool any of them declares is never reported absent.
      declared: readable === 0 ? null : [...declared],
    })
  }
  return surfaces
}

/**
 * Decide the registration verdict for one tool. Backend availability is NOT an
 * input: this answers only "is the tool in the registered surface?". A missing
 * registration is a blocking error, never a warning (P0-3). A registration that
 * cannot be inspected (npm specifier) is an explicit informative finding — it
 * is neither proof of registration nor a blocking defect.
 *
 * `lite` is the only profile where no registration is expected: it describes a
 * checkout, not a managed OpenCode install.
 *
 * @param {{profile:string, surfaces:{generation:string|null, files:string[], root:string|null, declared:string[]|null, unverifiable?:string}[], toolName:string}} input
 * @returns {{status:'skip'|'unregistered'|'missing'|'registered'|'unverifiable'|'partially-verified', level:'info'|'error'|'pass', message:string}}
 */
export function classifyToolRegistration({ profile, surfaces, toolName }) {
  if (surfaces.length === 0) {
    if (profile === 'lite') {
      return {
        status: 'skip',
        level: 'info',
        message: `${toolName} registration check skipped — a lite checkout has no managed plugin registration`,
      }
    }
    return {
      status: 'unregistered',
      level: 'error',
      message: `${toolName} is not registered: no Pantheon plugin is declared in any reachable opencode.json, so an available backend does not expose the tool (run \`pantheon-opencode init\`)`,
    }
  }

  const unverifiable = surfaces.filter((surface) => typeof surface.unverifiable === 'string')
  const inspectable = surfaces.filter((surface) => typeof surface.unverifiable !== 'string')
  const unverifiableDetail = unverifiable.map(({ unverifiable: reason }) => reason).join('; ')

  const missing = inspectable.filter(
    (surface) => surface.declared === null || !surface.declared.includes(toolName),
  )
  if (missing.length > 0) {
    const detail = missing.map(describeSurface).join(', ')
    return {
      status: 'missing',
      level: 'error',
      message: `${toolName} is NOT declared in the registered tool surface (${detail}) — a working read-only backend does not register the tool`,
    }
  }

  if (inspectable.length === 0) {
    return {
      status: 'unverifiable',
      level: 'info',
      message: `${toolName} registration cannot be verified: ${unverifiableDetail} — this is NOT a registration pass`,
    }
  }

  const detail = inspectable.map(describeSurface).join(', ')
  if (unverifiable.length > 0) {
    return {
      status: 'partially-verified',
      level: 'info',
      message: `${toolName} is declared in the inspectable Pantheon tool surface (${detail}), but another registration cannot be verified: ${unverifiableDetail} — not a full registration pass`,
    }
  }

  return {
    status: 'registered',
    level: 'pass',
    message: `${toolName} is registered in the Pantheon tool surface (${detail})`,
  }
}

/** Classify the Node package-support policy independently of feature probes. */
export function classifyNodePackageRuntime(version) {
  if (isSupportedNodeVersion(version)) {
    return {
      status: 'supported',
      code: 'node_version_supported',
      message: `Node.js v${String(version).replace(/^v/, '')} meets Pantheon's package requirement (>= ${MIN_SUPPORTED_NODE_VERSION})`,
    }
  }
  return {
    status: 'unsupported',
    code: 'node_version_unsupported',
    message: `Pantheon requires Node.js >= ${MIN_SUPPORTED_NODE_VERSION}; current runtime is v${String(version).replace(/^v/, '')}`,
  }
}

function checkNodeRuntime(args = {}) {
  section('K. Node Runtime')
  const packageRuntime = classifyNodePackageRuntime(process.versions.node)
  if (packageRuntime.status === 'supported') {
    pass(packageRuntime.message, {
      code: packageRuntime.code,
      classification: 'runtime',
    })
  } else {
    error(packageRuntime.message, { code: packageRuntime.code, classification: 'runtime' })
  }

  // This capability check is independent of the package support floor: it
  // describes pantheon_cost's optional backend, not Pantheon's Node support.
  const outcome = classifyNodeSqliteProbe(probeNodeSqlite())
  if (outcome.status === 'ok') {
    pass(outcome.message, {
      code: 'node_sqlite_supported',
      classification: 'capability',
    })
  } else {
    warn(outcome.message, {
      code: 'node_sqlite_unsupported',
      classification: 'capability',
    })
    info(
      `Upgrade to Node >= ${NODE_SQLITE_MIN} (or a runtime with node:sqlite) to enable pantheon_cost`,
    )
  }

  // Backend capability is NOT tool health (P0-3). A working node:sqlite with a
  // tool absent from the registered surface used to produce a green doctor;
  // this second, independent finding refuses to pass without registration.
  const registration = classifyToolRegistration({
    profile: args.profile,
    surfaces: resolveRegisteredToolSurfaces(args),
    toolName: 'pantheon_cost',
  })
  if (registration.level === 'pass') {
    pass(registration.message, {
      code: 'tool_registration_present',
      classification: 'capability',
    })
  } else if (registration.level === 'error') {
    error(registration.message, {
      code: 'tool_registration_missing',
      classification: 'capability',
    })
  } else if (
    registration.status === 'unverifiable' ||
    registration.status === 'partially-verified'
  ) {
    // Never a registration PASS: an npm specifier names a package the host may
    // resolve elsewhere, so reporting it as registered would be a false green.
    info(registration.message, {
      code: 'tool_registration_unverifiable',
      classification: 'capability',
    })
  } else {
    info(registration.message)
  }
}

/**
 * Return the final doctor status message without masking blocking errors.
 * @param {{ error: number; warn: number }} summaryCounts
 * @param {number} summaryExitCode
 * @returns {string}
 */
export function summaryMessage(summaryCounts, summaryExitCode) {
  if (summaryCounts.error > 0 || summaryExitCode !== 0) {
    const errorText =
      summaryCounts.error > 0
        ? `${summaryCounts.error} blocking error(s) found`
        : 'Blocking check failure'
    const warningText =
      summaryCounts.warn > 0 ? `; ${summaryCounts.warn} warning(s) remain advisory` : ''
    return `❌ ${errorText}${warningText} — exit code ${summaryExitCode}`
  }

  if (summaryCounts.warn > 0) {
    return `⚠️ Checks passed with ${summaryCounts.warn} warning(s) — warnings are advisory`
  }

  return '✅ All checks passed!'
}

function printSummary(targetPath) {
  flushSectionPasses()
  console.log(`\n${'='.repeat(60)}`)
  console.log('  Summary')
  console.log(`${'='.repeat(60)}`)
  console.log(`  ${ICON.pass} ${counts.pass} passed`)
  console.log(`  ${ICON.warn} ${counts.warn} warnings`)
  console.log(`  ${ICON.error} ${counts.error} errors`)
  console.log(`  ${ICON.info} ${counts.info} info`)
  console.log('')

  console.log(`  ${summaryMessage(counts, exitCode)}`)

  console.log(`\n  Target: ${process.argv.includes('--target') ? targetPath : 'current directory'}`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function checkInstallerFileInventory(args) {
  const state = readState(args.target)
  if (!state) return
  const selectedComponents = [
    'agents',
    'skills',
    'instructions',
    'prompts',
    'commands',
    'plugins',
    'runtime',
  ]
  let desiredFiles = new Map()
  let desiredUnavailable = true
  let selectedLayouts = {}
  try {
    const { installOpenCode, isGlobalConfigDir } = await import('./install/opencode.mjs')
    const preview = await installOpenCode(args.target, true, false, selectedComponents, {
      version: 'auto',
      quiet: true,
      quietPlan: true,
      planOnly: true,
      headless: true,
    })
    desiredFiles = new Map(
      (preview?.files ?? [])
        .filter((file) => typeof file.outputFingerprint === 'string')
        .map((file) => [file.path, { sha256: file.outputFingerprint }]),
    )
    const layout = isGlobalConfigDir(args.target)
      ? 'global'
      : preview?.openCodeVersion === 'v2'
        ? 'project-v2'
        : 'project-v1'
    selectedLayouts = Object.fromEntries(selectedComponents.map((component) => [component, layout]))
    desiredUnavailable = false
  } catch {
    // Doctor remains advisory if a source/layout preview cannot be computed.
    // The fallback labels equal recorded hashes explicitly, never as current.
  }
  let report
  try {
    report = classifyFileInventory(args.target, state, {
      desiredFiles,
      desiredUnavailable,
      selectedComponents,
      selectedLayouts,
    })
  } catch {
    warn('Installer file inventory could not be safely inspected.', {
      code: 'installer_inventory_unreadable',
      classification: 'ambiguous',
    })
    return
  }
  if (report.legacyAmbiguous) {
    warn('Legacy installed files have no ownership inventory; cleanup requires manual review.', {
      code: 'installer_inventory_legacy_unknown',
      classification: 'ambiguous',
    })
  }
  const recordedCurrent = report.entries.filter(
    (entry) => entry.classification === 'recorded-current',
  ).length
  if (recordedCurrent > 0) {
    emit(
      'info',
      `${recordedCurrent} inventoried file(s) match their recorded install hashes; current package payload was not compared.`,
      { code: 'installer_file_recorded_current', classification: 'recorded-current' },
    )
  }
  for (const entry of report.entries) {
    if (entry.classification === 'modified') {
      warn(`Installer-owned file was modified and will be preserved: ${entry.path}`, {
        code: 'installer_file_modified',
        classification: 'modified',
      })
    } else if (entry.classification === 'missing') {
      warn(`Previously installer-owned file is missing: ${entry.path}`, {
        code: 'installer_file_missing',
        classification: 'missing',
      })
    } else if (entry.classification === 'update-drift') {
      warn(`Installer source has a newer version of an unchanged owned file: ${entry.path}`, {
        code: 'installer_file_update_available',
        classification: 'update-drift',
      })
    } else if (entry.classification === 'stale-owned') {
      warn(`Stale installer-owned file is eligible for reviewed cleanup: ${entry.path}`, {
        code: 'installer_file_stale_owned',
        classification: 'stale-owned',
      })
    } else if (entry.classification === 'ambiguous') {
      warn(`Installer ownership is ambiguous for ${entry.path}; file preserved.`, {
        code: 'installer_file_ambiguous',
        classification: 'ambiguous',
      })
    }
  }
}

async function main() {
  const args = parseArgs(process.argv)
  jsonMode = args.json
  jsonArgs = args
  if (jsonMode) {
    jsonOriginalWrite = process.stdout.write
    process.stdout.write = () => true
  }

  if (args.help) {
    if (jsonMode) {
      process.stdout.write = jsonOriginalWrite
      jsonOriginalWrite = null
    }
    showHelp()
    process.exitCode = 0
    return
  }

  if (args.json && args.fix) {
    writeDoctorJson(
      {
        schema_version: 1,
        command: 'doctor',
        status: 'error',
        target: resolve(args.target),
        profile: args.profile,
        summary: { ...counts, exit_code: 1 },
        findings: [{ category: 'error', code: 'json_fix_unsupported', classification: 'usage' }],
      },
      1,
    )
    return
  }

  // Report the resolved validation profile up front (auto → global/sandbox)
  // so callers — including the `doctor` CLI wrapper — can see which policy
  // gate applied before any check output.
  if (!jsonMode) console.log(`Validation profile: ${args.profile}`)

  if (!existsSync(args.target)) {
    if (jsonMode) {
      error(`Target directory does not exist: ${args.target}`)
      writeDoctorJson(createDoctorJsonReport(args), exitCode)
    } else {
      console.error(`❌ Target directory does not exist: ${args.target}`)
      process.exitCode = 2
    }
    return
  }

  // Verify it looks like a Pantheon project or an OpenCode install target.
  const agentsOk = existsSync(join(args.target, 'src', 'agents'))
  const opencodeOk = existsSync(join(args.target, '.opencode'))

  if (!agentsOk && !opencodeOk) {
    // Maybe they pointed at a project root that isn't Pantheon
    // Check if this is a Pantheon install target (has opencode.json with mcp)
    const opencodeJson = readJson(join(args.target, 'opencode.json'))
    if (!opencodeJson) {
      warn(
        'Target does not appear to be a Pantheon project (no src/agents/ or .opencode/ directory)',
      )
    }
  }

  const _isPantheonRoot =
    join(args.target, 'scripts', 'doctor.mjs') === join(ROOT, 'scripts', 'doctor.mjs') ||
    existsSync(join(args.target, 'scripts', 'doctor.mjs')) === false

  // Run checks (layer order: Config → Venv → spawn paths → runtime smoke)
  checkNodeRuntime(args)
  checkAgentFiles(args)
  checkMcpConfig(args)
  checkVenvLayer(args)
  checkCodeModeDir(args)
  checkCodeModeManifest(args)
  checkInstallVersionDrift(args)
  checkPluginVersionDrift(args)
  await checkTuiPlugin(args)
  await checkInstallerFileInventory(args)
  if (jsonMode) {
    info('MCP runtime smoke skipped to keep --json read-only')
    results.at(-1).code = 'mcp_runtime_smoke_skipped'
    results.at(-1).classification = 'not_run'
  } else {
    await checkMcpRuntimeSmoke(args)
  }
  checkPermissionMismatches(args)
  checkSyncStatus(args)
  checkGitStatus(args)
  checkAgentsMdFreshness(args)
  checkSubagentDepthPlacement(args)
  checkPermissionTaskPresence(args)
  checkV2UnsupportedFeatures(args)

  printSummary(args.target)
  if (jsonMode) writeDoctorJson(createDoctorJsonReport(args), exitCode)
  else process.exitCode = exitCode
}

function createDoctorJsonReport(args) {
  return {
    schema_version: 1,
    command: 'doctor',
    status: exitCode === 2 ? 'error' : counts.warn > 0 ? 'warning' : 'ok',
    target: resolve(args.target),
    profile: args.profile,
    summary: { ...counts, exit_code: exitCode },
    findings: results,
  }
}

function writeDoctorJson(report, code) {
  const writer = jsonOriginalWrite ?? process.stdout.write
  process.stdout.write = writer
  jsonOriginalWrite = null
  writer.call(process.stdout, `${JSON.stringify(report)}\n`)
  process.exitCode = code
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (jsonMode) {
      writeDoctorJson(
        {
          schema_version: 1,
          command: 'doctor',
          status: 'error',
          target: jsonArgs ? resolve(jsonArgs.target) : null,
          profile: jsonArgs?.profile ?? null,
          summary: { ...counts, exit_code: 2 },
          findings: [{ category: 'error', code: 'doctor_failure', classification: 'error' }],
        },
        2,
      )
    } else {
      console.error(`❌ Doctor crashed: ${err.stack ?? err.message}`)
      process.exitCode = 2
    }
  })
}
