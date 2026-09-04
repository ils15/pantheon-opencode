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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    target: null,
    platform: null,
    fix: false,
    verbose: false,
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

  if (args.profile === 'auto') {
    args.profile = args.target.includes('pantheon-sandbox') ? 'sandbox' : 'global'
  }

  // Resolve to absolute
  if (!args.target.startsWith('/')) {
    args.target = join(process.cwd(), args.target)
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

function emit(category, message) {
  counts[category]++
  results.push({ category, message })
  if (category === 'pass' && !process.argv.includes('--verbose')) return
  const prefix = ICON[category] ?? category
  console.log(`  ${prefix} ${message}`)
}

function pass(msg) {
  emit('pass', msg)
}
function warn(msg) {
  emit('warn', msg)
}
function error(msg) {
  emit('error', msg)
  exitCode = 2
}
function info(msg) {
  emit('info', msg)
}

function section(title) {
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
   F. Runtime Layer        — venv python + pinned pip dependencies

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
  const requiredMcpNames = args.profile === 'lite' ? [] : ['pantheon-memory', 'pantheon-resources']

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
      if (!mcpEntry || mcpEntry.type !== 'local') continue
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
        pass(`Required MCP "${required}" configured in an available config`)
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
      if (!entry || entry.type !== 'local') continue
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
  if (existsSync(agentsDir)) pass('OpenCode agents directory is present')
  else info('OpenCode agents directory not present — project may use global agents')
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
// Check F: Runtime Layer — Venv, Python & pinned dependencies
// ---------------------------------------------------------------------------
// The MCP servers run on the venv Python under ~/.config/opencode/.venv
// (same resolution as scripts/install-mcp.mjs). This layer verifies the venv
// exists, the interpreter responds, and the installed packages satisfy the
// EXACT pins in src/mcp/requirements-mcp.txt and requirements-vision.txt
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

function checkVenvLayer(args) {
  section('F. Runtime Layer — Venv, Python & Dependencies')

  const venvPython = resolveRuntimePython(args)

  if (!existsSync(venvPython)) {
    if (args.profile === 'lite') {
      info(`Venv python not found — runtime layer skipped for lite profile`)
    } else {
      error(`Venv python not found: ${venvPython} (run \`pantheon-opencode init\` to create it)`)
    }
    return
  }
  pass(`Venv python exists: ${venvPython}`)

  const probe = spawn(venvPython, ['-c', 'import sys; print(sys.version.split()[0])'])
  if (probe.status !== 0) {
    error(`Venv python does not respond (exit ${probe.status}): ${probe.stderr}`)
    return
  }
  pass(`Venv python responds (Python ${probe.stdout})`)

  const freeze = spawn(venvPython, ['-m', 'pip', 'freeze'])
  if (freeze.status !== 0) {
    warn(`pip freeze failed (exit ${freeze.status}) — cannot verify pinned versions`)
    return
  }
  const installed = parsePipFreeze(freeze.stdout)

  const reqFiles = [
    join(ROOT, 'src', 'mcp', 'requirements-mcp.txt'),
    join(ROOT, 'src', 'mcp', 'requirements-vision.txt'),
  ]
  for (const reqFile of reqFiles) {
    if (!existsSync(reqFile)) {
      warn(`requirements file not found: ${reqFile}`)
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

/** Resolve the venv created by init for either a project or global install. */
export function resolveRuntimePython(args) {
  const target = resolve(args.target)
  const isProject = existsSync(join(target, '.opencode'))
  const runtimeRoot = isProject ? target : resolveOpenCodeConfigDir(args.env ?? process.env)
  return join(runtimeRoot, '.venv', 'bin', 'python3')
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

async function main() {
  const args = parseArgs(process.argv)

  if (args.help) {
    showHelp()
    process.exit(0)
  }

  // Report the resolved validation profile up front (auto → global/sandbox)
  // so callers — including the `doctor` CLI wrapper — can see which policy
  // gate applied before any check output.
  console.log(`Validation profile: ${args.profile}`)

  if (!existsSync(args.target)) {
    console.error(`❌ Target directory does not exist: ${args.target}`)
    process.exit(2)
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
  checkAgentFiles(args)
  checkMcpConfig(args)
  checkVenvLayer(args)
  await checkMcpRuntimeSmoke(args)
  checkPermissionMismatches(args)
  checkSyncStatus(args)
  checkGitStatus(args)
  checkAgentsMdFreshness(args)
  checkSubagentDepthPlacement(args)
  checkPermissionTaskPresence(args)

  printSummary(args.target)

  process.exit(exitCode)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ Doctor crashed: ${err.stack ?? err.message}`)
    process.exit(2)
  })
}
