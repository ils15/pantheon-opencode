/**
 * Persistent Multi-Repo Shared Knowledge Federation (`memory-federation.ts`).
 *
 * Discovers peer repositories configured via `PANTHEON_FEDERATED_REPOS` or
 * `~/.pantheon/federation.json` and runs strictly read-only FTS5/LIKE queries
 * across their `.pantheon/memory/memory.db` stores with explicit provenance.
 *
 * @module pantheon/memory-federation
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveSharedPantheonRoot } from './tool-context.ts'

export interface FederatedHit {
  readonly namespace: string
  readonly key: string
  readonly value: string
  readonly metadata: string | null
  readonly created_at: string
  readonly score?: number
  readonly sourceRepo: string
  readonly sourcePath: string
}

export interface FederatedRepoStat {
  readonly repo: string
  readonly path: string
  readonly total: number
}

export interface FederationOptions {
  readonly federatedEnv?: string | undefined
  readonly manifestPath?: string | undefined
  readonly explicitRepos?: readonly string[] | undefined
}

const NOT_EXPIRED_SQL = '(expires_at IS NULL OR expires_at > ?)'

function safeRealpath(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

/**
 * Resolve unique valid peer repository directories containing a `.pantheon/memory/memory.db`,
 * excluding `primaryWorkspaceDir` itself.
 */
export function resolveFederatedRepoDirs(
  primaryWorkspaceDir: string,
  options: FederationOptions = {},
): string[] {
  const candidates: string[] = []
  if (Array.isArray(options.explicitRepos)) {
    candidates.push(...options.explicitRepos)
  }

  const rawEnv = options.federatedEnv ?? process.env.PANTHEON_FEDERATED_REPOS ?? ''
  if (rawEnv.trim()) {
    for (const part of rawEnv.split(/[,;]/)) {
      const trimmed = part.trim()
      if (trimmed) candidates.push(trimmed)
    }
  }

  const manifestFile = options.manifestPath ?? join(homedir(), '.pantheon', 'federation.json')
  if (existsSync(manifestFile)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
        repos?: unknown
      }
      if (Array.isArray(parsed.repos)) {
        for (const item of parsed.repos) {
          if (typeof item === 'string' && item.trim()) candidates.push(item.trim())
        }
      }
    } catch {
      /* ignore malformed federation manifest */
    }
  }

  const primaryStore = safeRealpath(resolveSharedPantheonRoot(primaryWorkspaceDir))
  const seenStores = new Set<string>([primaryStore])
  const peers: string[] = []

  for (const candidate of candidates) {
    const abs = resolve(candidate)
    if (!existsSync(abs)) continue
    const peerStore = safeRealpath(resolveSharedPantheonRoot(abs))
    if (seenStores.has(peerStore)) continue
    const dbPath = join(peerStore, '.pantheon', 'memory', 'memory.db')
    if (!existsSync(dbPath)) continue
    seenStores.add(peerStore)
    peers.push(peerStore)
  }

  return peers
}

function querySinglePeerDb(
  peerRoot: string,
  rawQuery: string,
  nowIso: string,
  limit: number,
  namespace?: string,
): FederatedHit[] {
  const dbPath = join(peerRoot, '.pantheon', 'memory', 'memory.db')
  if (!existsSync(dbPath)) return []
  const repoName = basename(peerRoot) || peerRoot
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const tokens = rawQuery
      .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 2)

    if (tokens.length > 0) {
      try {
        const ftsExpr = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ')
        let ftsSql = `
          SELECT m.namespace, m.key, m.value, m.metadata, m.created_at, bm25(memories_fts) AS score
          FROM memories_fts
          JOIN memories m ON m.id = memories_fts.rowid
          WHERE memories_fts MATCH ? AND (m.expires_at IS NULL OR m.expires_at > ?)
        `
        const ftsParams: Array<string | number> = [ftsExpr, nowIso]
        if (namespace) {
          ftsSql += ' AND m.namespace = ?'
          ftsParams.push(namespace)
        }
        ftsSql += ' ORDER BY score LIMIT ?'
        ftsParams.push(limit)
        const rows = db.prepare(ftsSql).all(...ftsParams) as Array<
          Omit<FederatedHit, 'sourceRepo' | 'sourcePath'>
        >
        if (rows.length > 0) {
          return rows.map((r) => ({ ...r, sourceRepo: repoName, sourcePath: peerRoot }))
        }
      } catch {
        /* fallback to LIKE */
      }
    }

    const escaped = rawQuery.replace(/[\\%_]/g, '\\$&')
    let sql = `
      SELECT namespace, key, value, metadata, created_at
      FROM memories
      WHERE (value LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\')
        AND ${NOT_EXPIRED_SQL}
    `
    const params: Array<string | number> = [`%${escaped}%`, `%${escaped}%`, nowIso]
    if (namespace) {
      sql += ' AND namespace = ?'
      params.push(namespace)
    }
    sql += ' ORDER BY id DESC LIMIT ?'
    params.push(limit)
    const rows = db.prepare(sql).all(...params) as Array<
      Omit<FederatedHit, 'sourceRepo' | 'sourcePath'>
    >
    return rows.map((r) => ({ ...r, sourceRepo: repoName, sourcePath: peerRoot }))
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/** Query peer federated repositories (read-only) with repo provenance. */
export function searchFederatedMemories(
  primaryWorkspaceDir: string,
  query: string,
  options: FederationOptions & { readonly namespace?: string; readonly limit?: number } = {},
): FederatedHit[] {
  const peers = resolveFederatedRepoDirs(primaryWorkspaceDir, options)
  if (peers.length === 0) return []
  const nowIso = new Date().toISOString()
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100))
  const results: FederatedHit[] = []
  for (const peer of peers) {
    const hits = querySinglePeerDb(peer, query, nowIso, limit, options.namespace)
    results.push(...hits)
    if (results.length >= limit) break
  }
  return results.slice(0, limit)
}

/** Collect memory counts across federated peer repositories. */
export function getFederatedStats(
  primaryWorkspaceDir: string,
  options: FederationOptions = {},
): { readonly total: number; readonly repos: readonly FederatedRepoStat[] } {
  const peers = resolveFederatedRepoDirs(primaryWorkspaceDir, options)
  const nowIso = new Date().toISOString()
  const repos: FederatedRepoStat[] = []
  let total = 0
  for (const peer of peers) {
    const dbPath = join(peer, '.pantheon', 'memory', 'memory.db')
    let count = 0
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const row = db
        .prepare(`SELECT count(*) as count FROM memories WHERE ${NOT_EXPIRED_SQL}`)
        .get(nowIso) as { count?: number } | undefined
      count = typeof row?.count === 'number' ? row.count : 0
    } catch {
      count = 0
    } finally {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
    }
    repos.push({ repo: basename(peer) || peer, path: peer, total: count })
    total += count
  }
  return { total, repos }
}
