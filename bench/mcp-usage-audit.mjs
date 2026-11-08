#!/usr/bin/env node
/**
 * mcp-usage-audit.mjs — measured audit of NATIVE MCP usage (memory,
 * persistence, vision, code-mode, resources) answering four questions:
 * when do these calls actually fire, why, is the volume excessive, and is
 * each surface necessary.
 *
 * Read-only over four local sources (nothing leaves the machine):
 *   1. opencode.db session_message — the authoritative transcript. Field
 *      finding baked into the design: agents never call `pantheon-*_*` tools
 *      directly; every MCP touch rides inside the code-mode `execute` tool's
 *      JS (`tools["pantheon-memory"].memory_store(...)`), so usage is counted
 *      by parsing executed-code references, server × method × agent × month.
 *      User rows carry `{time, text}`; assistant rows carry `content[]` with
 *      `type:'tool'` items — the two shapes never mix.
 *   2. memory MCP db (`created_at` per row) — the durable store timeline.
 *   3. persistence DBs (global.db + runtime project.db kv) — checkpoint
 *      namespaces vs machinery rows (delegation telemetry).
 *   4. .pantheon/logs/hooks.log `[bench]` lines — per-call durations.
 *
 * Output: a dated markdown report in bench/results/. Qualitative samples are
 * bounded excerpts (snippet ≤160 chars, nearest-seen user turn ≤120 chars);
 * the "nearby user turn" is a heuristic — rows are scanned unordered, so the
 * excerpt is the most recently SEEN turn of that session, not a guaranteed
 * predecessor.
 *
 * Usage:
 *   node bench/mcp-usage-audit.mjs                    # audit, write report
 *   node bench/mcp-usage-audit.mjs --db <opencode.db> # explicit transcript db
 *   node bench/mcp-usage-audit.mjs --stdout           # report to stdout only
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { parseBenchHookLines } from './lib/hooklog.mjs'

const SERVERS = [
  'pantheon-memory',
  'pantheon-persistence',
  'pantheon-vision',
  'pantheon-code-mode',
  'pantheon-resources',
]
const METHOD_RE =
  /tools\[["'](pantheon-(?:memory|persistence|vision|code-mode|resources))["']\]\.(\w+)/g
const CALL_RE =
  /\.(memory_store|memory_search|memory_recall|memory_forget|memory_list|memory_stats|code_query|code_neighbors|context_save|context_get|context_rehydrate|context_list|context_stats|context_session_summary|kv_store|kv_get|kv_search|kv_list|kv_stats|kv_delete_namespace|goal_create|goal_get|goal_update|goal_done|vision_describe|vision_ocr|vision_analyze|execute_code_script|approve_code_script)\(/g
const SAMPLE_STORES = 24
const SAMPLE_CHECKPOINTS = 12

/** pantheon_home(): PANTHEON_HOME > XDG_CONFIG_HOME/opencode > ~/.config/opencode. */
export function pantheonHome(env = process.env) {
  if (env.PANTHEON_HOME) return env.PANTHEON_HOME
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'opencode')
  return join(homedir(), '.config', 'opencode')
}

/** opencode.db path, mirroring cost-command.ts resolveCostDbPath precedence. */
export function resolveTranscriptDbPath(env = process.env) {
  return (
    env.PANTHEON_COST_DB ??
    env.OPENCODE_DB ??
    join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  )
}

/** Persistence DB candidates that exist on disk (global + runtime project fallback). */
export function resolvePersistenceDbPaths(env = process.env, cwd = process.cwd()) {
  const home = pantheonHome(env)
  const candidates = [
    join(home, 'persistence', 'global.db'),
    join(home, '.pantheon', 'persistence', 'project.db'),
    join(cwd, '.pantheon', 'persistence', 'project.db'),
  ]
  if (env.PANTHEON_PROJECT)
    candidates.unshift(join(env.PANTHEON_PROJECT, '.pantheon', 'persistence', 'project.db'))
  return candidates.filter((p) => existsSync(p))
}

/**
 * Extract MCP references from one executed-code string.
 * Returns { servers:Set, methods:Map<'server.method',n> }.
 */
export function extractMcpRefs(code) {
  const servers = new Set()
  const methods = new Map()
  const text = String(code)
  for (const m of text.matchAll(/pantheon-(?:memory|persistence|vision|code-mode|resources)/g))
    servers.add(m[0])
  for (const m of text.matchAll(METHOD_RE)) {
    const key = `${m[1]}.${m[2]}`
    methods.set(key, (methods.get(key) ?? 0) + 1)
  }
  return { servers, methods }
}

/** The invocation targets one execute block actually calls (method names only). */
export function extractCalledMethods(code) {
  const out = new Set()
  for (const m of String(code).matchAll(CALL_RE)) out.add(m[1])
  return out
}

/** A method belongs to exactly one server (kv_/goal_/context_ = persistence; memory_/code_ = memory). */
export function serverForMethod(method) {
  if (method.startsWith('memory_') || method.startsWith('code_')) return 'pantheon-memory'
  if (method.startsWith('context_') || method.startsWith('kv_') || method.startsWith('goal_'))
    return 'pantheon-persistence'
  if (method.startsWith('vision_')) return 'pantheon-vision'
  if (method.endsWith('_code_script')) return 'pantheon-code-mode'
  return 'pantheon-resources'
}

/** Bounded snippet of the first `method(` invocation site in the code. */
export function callSnippet(code, method, max = 160) {
  const idx = String(code).indexOf(`${method}(`)
  if (idx < 0) return ''
  return String(code)
    .slice(idx, idx + max)
    .replaceAll('\n', ' ')
}

/**
 * Stream-scan the transcript. Counts stay bounded; no row accumulates.
 * `lastUserBySession` keeps one bounded excerpt per session for the "why"
 * sample (heuristic nearest-seen turn, not a guaranteed predecessor).
 */
export function scanTranscripts(
  dbPath,
  { sampleStores = SAMPLE_STORES, sampleCheckpoints = SAMPLE_CHECKPOINTS } = {},
) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const result = {
    assistantMessages: 0,
    userTurns: 0,
    userTurnsByMonth: {},
    directMcpToolCalls: 0,
    toolNameCounts: {},
    executeCalls: 0,
    executeCompleted: 0,
    executeMentioning: 0,
    executeMentioningCompleted: 0,
    mcpSessions: new Set(),
    perServer: Object.fromEntries(
      SERVERS.map((s) => [s, { executeBlocks: 0, methods: {}, agents: {}, months: {} }]),
    ),
    samples: { memory_store: [], context_save: [], vision: [] },
  }
  const lastUserBySession = new Map()
  const storeCandidates = []
  const checkpointCandidates = []
  const visionCandidates = []
  const stmt = db.prepare('SELECT session_id, type, data, time_created FROM session_message')
  for (const row of stmt.iterate()) {
    let d
    try {
      d = JSON.parse(row.data)
    } catch {
      continue
    }
    const month = new Date(Number(row.time_created)).toISOString().slice(0, 7)
    if (row.type === 'user') {
      result.userTurns++
      result.userTurnsByMonth[month] = (result.userTurnsByMonth[month] ?? 0) + 1
      lastUserBySession.set(row.session_id, { month, excerpt: String(d?.text ?? '').slice(0, 120) })
      continue
    }
    if (row.type !== 'assistant' || !Array.isArray(d?.content)) continue
    result.assistantMessages++
    for (const c of d.content) {
      if (c?.type !== 'tool' || typeof c.name !== 'string') continue
      result.toolNameCounts[c.name] = (result.toolNameCounts[c.name] ?? 0) + 1
      if (c.name.startsWith('pantheon-')) result.directMcpToolCalls++
      if (c.name !== 'execute') continue
      result.executeCalls++
      const completed = c.state?.status === 'completed'
      if (completed) result.executeCompleted++
      const code = String(c.state?.input?.code ?? '')
      const { servers } = extractMcpRefs(code)
      if (servers.size === 0) continue
      result.executeMentioning++
      if (completed) result.executeMentioningCompleted++
      result.mcpSessions.add(row.session_id)
      const called = extractCalledMethods(code)
      const user = lastUserBySession.get(row.session_id)?.excerpt ?? ''
      for (const server of servers) {
        const bucket = result.perServer[server]
        bucket.executeBlocks++
        bucket.agents[d.agent ?? '?'] = (bucket.agents[d.agent ?? '?'] ?? 0) + 1
        bucket.months[month] = (bucket.months[month] ?? 0) + 1
      }
      for (const method of called) {
        const bucket = result.perServer[serverForMethod(method)]
        bucket.methods[method] = (bucket.methods[method] ?? 0) + 1
        const snippet = callSnippet(code, method)
        if (method === 'memory_store') {
          storeCandidates.push({ month, agent: d.agent ?? '?', snippet, user })
        } else if (method === 'context_save') {
          checkpointCandidates.push({ month, agent: d.agent ?? '?', snippet, user })
        } else if (method.startsWith('vision_')) {
          visionCandidates.push({ month, agent: d.agent ?? '?', snippet })
        }
      }
    }
  }
  result.samples.memory_store = storeCandidates.slice(-sampleStores)
  result.samples.context_save = checkpointCandidates.slice(-sampleCheckpoints)
  result.samples.vision = visionCandidates.slice(-8)
  db.close()
  return result
}

/** Durable-state stats from the memory MCP db. */
export function memoryDbStats(dbPath) {
  if (!existsSync(dbPath)) return null
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const byMonth = db
    .prepare('SELECT substr(created_at,1,7) m, COUNT(*) c FROM memories GROUP BY m ORDER BY m')
    .all()
  const byNamespace = db
    .prepare(
      'SELECT namespace, COUNT(*) c FROM memories GROUP BY namespace ORDER BY c DESC LIMIT 8',
    )
    .all()
  const size = db.prepare('SELECT SUM(LENGTH(value)) b, AVG(LENGTH(value)) a FROM memories').get()
  const recent = db
    .prepare(
      'SELECT namespace, key, substr(value,1,120) head, created_at FROM memories ORDER BY created_at DESC LIMIT 6',
    )
    .all()
  db.close()
  return {
    total: byMonth.reduce((acc, r) => acc + r.c, 0),
    byMonth: Object.fromEntries(byMonth.map((r) => [r.m, r.c])),
    byNamespace: Object.fromEntries(byNamespace.map((r) => [r.namespace, r.c])),
    valueBytes: size.b ?? 0,
    avgValueBytes: Math.round(size.a ?? 0),
    recent: recent.map((r) => ({
      ns: r.namespace,
      key: r.key,
      head: String(r.head).replaceAll('\n', ' '),
    })),
  }
}

/** Durable-state stats from the persistence kv DBs. */
export function persistenceDbStats(paths) {
  const out = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      db.prepare('SELECT 1 FROM kv_store LIMIT 1').get()
    } catch {
      db.close()
      continue
    }
    const byMonth = db
      .prepare('SELECT substr(created_at,1,7) m, COUNT(*) c FROM kv_store GROUP BY m ORDER BY m')
      .all()
    const byKind = db
      .prepare(
        "SELECT CASE WHEN namespace LIKE 'checkpoint:%' THEN 'checkpoint' WHEN namespace LIKE 'deleg%' THEN 'delegation-telemetry' WHEN namespace = 'memory-wal' THEN 'memory-wal' ELSE 'other' END kind, COUNT(*) c FROM kv_store GROUP BY kind",
      )
      .all()
    const ckNamespaces = db
      .prepare(
        "SELECT COUNT(DISTINCT namespace) n FROM kv_store WHERE namespace LIKE 'checkpoint:%'",
      )
      .get()
    const size = db.prepare('SELECT SUM(LENGTH(value)) b FROM kv_store').get()
    db.close()
    out.push({
      path,
      rows: byMonth.reduce((acc, r) => acc + r.c, 0),
      byMonth: Object.fromEntries(byMonth.map((r) => [r.m, r.c])),
      kinds: Object.fromEntries(byKind.map((r) => [r.kind, r.c])),
      checkpointNamespaces: ckNamespaces.n,
      valueBytes: size.b ?? 0,
    })
  }
  return out
}

/** Per-tool duration percentiles for pantheon-* tools from bench hook lines. */
export function hooksLogMcpDurations(logPath) {
  if (!existsSync(logPath)) return null
  const entries = parseBenchHookLines(readFileSync(logPath, 'utf8')).filter(
    (e) => e.phase === 'after' && SERVERS.some((s) => e.tool.startsWith(s)),
  )
  const byTool = {}
  for (const e of entries) {
    if (!Array.isArray(byTool[e.tool])) byTool[e.tool] = []
    byTool[e.tool].push(e.durationMs)
  }
  const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b)
    return s.length === 0 ? null : s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  }
  return Object.fromEntries(
    Object.entries(byTool).map(([tool, arr]) => [
      tool,
      { calls: arr.length, p50: pct(arr, 50), p95: pct(arr, 95) },
    ]),
  )
}

function fmtCounts(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(', ')
}

function fmtMonths(obj) {
  return Object.entries(obj)
    .sort()
    .map(([k, v]) => `${k}:${v}`)
    .join(', ')
}

/** Assemble the markdown report. */
export function buildReport(scan, memory, persistence, durations) {
  const totalMcpBlocks = Object.values(scan.perServer).reduce((acc, s) => acc + s.executeBlocks, 0)
  const lines = [
    '# Native MCP usage audit — measured',
    '',
    `Date: ${new Date().toISOString().slice(0, 10)}. Sources: opencode.db transcript (read-only),`,
    'memory MCP db, persistence kv DBs, hooks.log bench lines. Nothing left the machine;',
    'qualitative samples are bounded excerpts.',
    '',
    '## Headline',
    '',
    `- assistant messages scanned: **${scan.assistantMessages}**; user turns: **${scan.userTurns}**`,
    `- direct \`pantheon-*\` tool calls: **${scan.directMcpToolCalls}** (agents invoke MCP only through the code-mode \`execute\` bridge)`,
    `- \`execute\` calls: **${scan.executeCalls}** (${scan.executeCompleted} completed) — MCP-touching: **${scan.executeMentioning}** (${((100 * scan.executeMentioning) / Math.max(1, scan.executeCalls)).toFixed(1)}%), of which completed: ${scan.executeMentioningCompleted}`,
    `- sessions with MCP activity: **${scan.mcpSessions.size}**`,
    `- server touches (execute blocks): ${SERVERS.map((s) => `\`${s}\` ${scan.perServer[s].executeBlocks}`).join(', ')} — total ${totalMcpBlocks}`,
    '',
    '## Per server',
    '',
    '| server | execute blocks | methods invoked | top agents | by month |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const s of SERVERS) {
    const b = scan.perServer[s]
    lines.push(
      `| ${s} | ${b.executeBlocks} | ${fmtCounts(b.methods) || '—'} | ${fmtCounts(b.agents) || '—'} | ${fmtMonths(b.months) || '—'} |`,
    )
  }
  lines.push('', '## Durable state (what the calls actually left behind)', '')
  if (memory) {
    lines.push(
      `**memory MCP db**: ${memory.total} memories, ${memory.valueBytes} bytes of values (avg ${memory.avgValueBytes}).`,
      `- by month: ${fmtMonths(memory.byMonth)}`,
      `- by namespace: ${fmtCounts(memory.byNamespace)}`,
      '- recent stores:',
      ...memory.recent.map((r) => `  - \`${r.ns}\` / \`${r.key}\` — ${r.head}`),
      '',
    )
  } else {
    lines.push('**memory MCP db**: not found.', '')
  }
  for (const p of persistence) {
    lines.push(
      `**persistence kv** (\`${p.path}\`): ${p.rows} rows, ${p.valueBytes} bytes.`,
      `- by month: ${fmtMonths(p.byMonth)}`,
      `- kinds: ${fmtCounts(p.kinds)} — distinct checkpoint namespaces: **${p.checkpointNamespaces}**`,
      '',
    )
  }
  lines.push('## Latency (hooks.log bench lines, where present)', '')
  if (durations && Object.keys(durations).length > 0) {
    lines.push('| tool | calls | p50 ms | p95 ms |', '| --- | --- | --- | --- |')
    for (const [tool, d] of Object.entries(durations))
      lines.push(`| ${tool} | ${d.calls} | ${d.p50} | ${d.p95} |`)
  } else {
    lines.push('No pantheon-* bench lines found (bench instrumentation off or log absent).')
  }
  lines.push(
    '',
    '## Who decides (ambient vs initiated)',
    '',
    'Code verdict: no ambient caller — hook-engine/plugin contain no memory_*/context_*/kv_*',
    'invocations, and the V2 memory contract test pins "explicit MCP call, no ambient injection',
    'hook". Every counted touch was model-initiated inside `execute`.',
    '',
    '## Why (qualitative sample — bounded excerpts)',
    '',
  )
  for (const [kind, arr] of Object.entries(scan.samples)) {
    lines.push(`### ${kind} (${arr.length} sampled)`, '')
    for (const s of arr) {
      lines.push(
        `- [${s.month}] ${s.agent}: \`${s.snippet}\`${s.user ? ` ← near user turn: "${s.user}"` : ''}`,
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

function main(args = process.argv.slice(2)) {
  const get = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const dbPath = get('--db') ?? resolveTranscriptDbPath()
  if (!existsSync(dbPath)) {
    console.error(`transcript db not found: ${dbPath} (pass --db)`)
    process.exit(1)
  }
  const scan = scanTranscripts(dbPath)
  const memory = memoryDbStats(join(pantheonHome(), 'memory', 'memory.db'))
  const persistence = persistenceDbStats(resolvePersistenceDbPaths())
  const durations = hooksLogMcpDurations(join(process.cwd(), '.pantheon', 'logs', 'hooks.log'))
  const report = buildReport(scan, memory, persistence, durations)
  if (args.includes('--stdout')) {
    console.log(report)
    return
  }
  const date = new Date().toISOString().slice(0, 10)
  const outPath = resolve(`bench/results/mcp-usage-audit-${date}.md`)
  writeFileSync(outPath, `${report}\n`)
  console.log(`audit written: ${outPath}`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) main()
