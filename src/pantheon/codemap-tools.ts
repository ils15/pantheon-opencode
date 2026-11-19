/**
 * Native In-Process Codebase Structural Graph & Symbol Indexer (`codemap-tools.ts`).
 *
 * Replaces the legacy Python `mcp_codemap_module.py` with a fast, polyglot
 * TypeScript symbol and dependency graph indexer backed by `node:sqlite`.
 * Extracts functions, classes, interfaces, types, and import/call relationships
 * across TypeScript, JavaScript, Python, Go, and Rust without spawning Python.
 *
 * Exposes `code_index`, `code_query`, and `code_neighbors` as native plugin tools.
 *
 * @module pantheon/codemap-tools
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveToolCwd } from './tool-context.ts'
import type { PantheonToolDef, PantheonToolResult } from './tools.ts'

export interface CodeEntity {
  readonly name: string
  readonly kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'module'
  readonly file: string
  readonly line: number
  readonly signature: string
}

export interface CodeRelation {
  readonly source: string
  readonly target: string
  readonly kind: 'imports' | 'calls' | 'extends'
  readonly file: string
  readonly line: number
}

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.pantheon',
  '.opencode',
  'coverage',
])

const SUPPORTED_EXT_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
}

const codemapDbCache = new Map<string, DatabaseSync>()

function getCodemapDb(workspaceDir: string): DatabaseSync {
  const memoryDir = join(workspaceDir, '.pantheon', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const canonicalBase = realpathSync(memoryDir)
  const dbPath = resolve(canonicalBase, 'memory.db')
  const prefix = canonicalBase.endsWith(sep) ? canonicalBase : `${canonicalBase}${sep}`
  if (!dbPath.startsWith(prefix)) {
    throw new Error('Path traversal denied for codemap database')
  }
  const cached = codemapDbCache.get(dbPath)
  if (cached) return cached

  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      language TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS code_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      signature TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_entities_name ON code_entities(name);
    CREATE INDEX IF NOT EXISTS idx_code_entities_file ON code_entities(file);
    CREATE TABLE IF NOT EXISTS code_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_relations_source ON code_relations(source);
    CREATE INDEX IF NOT EXISTS idx_code_relations_target ON code_relations(target);
  `)
  codemapDbCache.set(dbPath, db)
  return db
}

export function extractSymbolsAndRelations(
  relPath: string,
  content: string,
  language: string,
): { entities: CodeEntity[]; relations: CodeRelation[] } {
  const entities: CodeEntity[] = []
  const relations: CodeRelation[] = []
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const trimmed = rawLine.trim()
    const lineNo = i + 1
    if (
      !trimmed ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('*')
    ) {
      continue
    }

    if (language === 'typescript' || language === 'javascript') {
      const fnMatch = trimmed.match(
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
      )
      if (fnMatch?.[1]) {
        entities.push({
          name: fnMatch[1],
          kind: 'function',
          file: relPath,
          line: lineNo,
          signature: trimmed.slice(0, 120),
        })
        continue
      }
      const classMatch = trimmed.match(
        /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*))?/,
      )
      if (classMatch?.[1]) {
        entities.push({
          name: classMatch[1],
          kind: 'class',
          file: relPath,
          line: lineNo,
          signature: trimmed.slice(0, 120),
        })
        if (classMatch[2]) {
          relations.push({
            source: classMatch[1],
            target: classMatch[2],
            kind: 'extends',
            file: relPath,
            line: lineNo,
          })
        }
        continue
      }
      const ifaceMatch = trimmed.match(/^(?:export\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)/)
      if (ifaceMatch?.[1] && ifaceMatch[2]) {
        entities.push({
          name: ifaceMatch[2],
          kind: ifaceMatch[1] === 'interface' ? 'interface' : 'type',
          file: relPath,
          line: lineNo,
          signature: trimmed.slice(0, 120),
        })
        continue
      }
      const constMatch = trimmed.match(/^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/)
      if (constMatch?.[1]) {
        entities.push({
          name: constMatch[1],
          kind: 'variable',
          file: relPath,
          line: lineNo,
          signature: trimmed.slice(0, 120),
        })
        continue
      }
      const importMatch = trimmed.match(/from\s+['"]([^'"]+)['"]/)
      if (importMatch?.[1] && trimmed.startsWith('import ')) {
        relations.push({
          source: relPath,
          target: importMatch[1],
          kind: 'imports',
          file: relPath,
          line: lineNo,
        })
      }
    } else if (language === 'python') {
      const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
      if (defMatch?.[1]) {
        entities.push({
          name: defMatch[1],
          kind: 'function',
          file: relPath,
          line: lineNo,
          signature: trimmed.slice(0, 120),
        })
        continue
      }
      const pyClassMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)(?:\(([^)]+)\))?:/)
      if (pyClassMatch?.[1]) {
        entities.push({
          name: pyClassMatch[1],
          kind: 'class',
          file: relPath,
          line: lineNo,
          signature: trimmed.slice(0, 120),
        })
        if (pyClassMatch[2]) {
          relations.push({
            source: pyClassMatch[1],
            target: pyClassMatch[2].split(',')[0]?.trim() ?? pyClassMatch[2],
            kind: 'extends',
            file: relPath,
            line: lineNo,
          })
        }
        continue
      }
      const pyImportMatch = trimmed.match(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/)
      const targetMod = pyImportMatch?.[1] ?? pyImportMatch?.[2]
      if (targetMod) {
        relations.push({
          source: relPath,
          target: targetMod,
          kind: 'imports',
          file: relPath,
          line: lineNo,
        })
      }
    } else if (language === 'go') {
      const goFnMatch = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\(/)
      if (goFnMatch?.[1]) {
        entities.push({
          name: goFnMatch[1],
          kind: 'function',
          file: relPath,
          line: lineNo,
          signature: trimmed.slice(0, 120),
        })
      }
    } else if (language === 'rust') {
      const rsFnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/)
      if (rsFnMatch?.[1]) {
        entities.push({
          name: rsFnMatch[1],
          kind: 'function',
          file: relPath,
          line: lineNo,
          signature: trimmed.slice(0, 120),
        })
      }
    }
  }

  return { entities, relations }
}

function collectSourceFiles(currentDir: string, maxFiles = 500): string[] {
  const results: string[] = []
  function walk(dir: string): void {
    if (results.length >= maxFiles) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return
      const name = String(entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(name) && !name.startsWith('.')) {
          walk(join(dir, name))
        }
      } else if (entry.isFile()) {
        const ext = extname(name).toLowerCase()
        if (ext in SUPPORTED_EXT_LANG) {
          results.push(join(dir, name))
        }
      }
    }
  }
  walk(currentDir)
  return results
}

function jsonResult(payload: unknown): PantheonToolResult {
  return { output: JSON.stringify(payload) }
}

function deleteIndexedFile(db: DatabaseSync, relFile: string): void {
  db.prepare('DELETE FROM code_entities WHERE file = ?').run(relFile)
  db.prepare('DELETE FROM code_relations WHERE file = ?').run(relFile)
  db.prepare('DELETE FROM code_files WHERE path = ?').run(relFile)
}

function pruneMissingFilesInScope(db: DatabaseSync, canonicalRoot: string, subRel: string): number {
  const cleanScope = subRel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const rows =
    cleanScope === '' || cleanScope === '.'
      ? (db.prepare('SELECT path FROM code_files').all() as Array<{ path: string }>)
      : (db
          .prepare("SELECT path FROM code_files WHERE path = ? OR path LIKE ? ESCAPE '\\'")
          .all(cleanScope, `${cleanScope.replace(/[\\%_]/g, '\\$&')}/%`) as Array<{ path: string }>)
  let pruned = 0
  for (const row of rows) {
    if (typeof row?.path !== 'string') continue
    if (!existsSync(resolve(canonicalRoot, row.path))) {
      deleteIndexedFile(db, row.path)
      pruned += 1
    }
  }
  return pruned
}

function filterAndPruneExistingRows<T extends { file?: unknown }>(
  db: DatabaseSync,
  canonicalRoot: string,
  rows: T[],
): T[] {
  const kept: T[] = []
  const missing = new Set<string>()
  for (const row of rows) {
    const file = typeof row.file === 'string' ? row.file : ''
    if (!file) {
      kept.push(row)
      continue
    }
    if (missing.has(file) || !existsSync(resolve(canonicalRoot, file))) {
      if (!missing.has(file)) {
        missing.add(file)
        deleteIndexedFile(db, file)
      }
      continue
    }
    kept.push(row)
  }
  return kept
}

export function createCodemapTools(fallbackDir?: string): PantheonToolDef[] {
  return [
    {
      name: 'code_index',
      description:
        'Index codebase symbols (functions, classes, interfaces, types) and import/inheritance edges into SQLite.',
      input: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description:
              'Optional relative subdirectory or file path within the workspace to index',
          },
          force: {
            type: 'boolean',
            description: 'Re-index files even when SHA-256 hash is unchanged',
          },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const cwd = resolveToolCwd(context, fallbackDir)
          const canonicalRoot = realpathSync(cwd)
          const subPath =
            typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.'
          const targetPath = resolve(canonicalRoot, subPath)
          const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`
          if (targetPath !== canonicalRoot && !targetPath.startsWith(rootPrefix)) {
            return jsonResult({ ok: false, error: 'path escapes workspace root' })
          }
          if (!existsSync(targetPath)) {
            return jsonResult({ ok: false, error: `path not found: ${subPath}` })
          }

          const force = input.force === true
          const db = getCodemapDb(canonicalRoot)
          const st = statSync(targetPath)
          const files = st.isFile() ? [targetPath] : collectSourceFiles(targetPath)

          let indexed = 0
          let skipped = 0
          let entitiesCount = 0
          let relationsCount = 0
          const nowIso = new Date().toISOString()

          for (const filePath of files) {
            const ext = extname(filePath).toLowerCase()
            const lang = SUPPORTED_EXT_LANG[ext]
            if (!lang) continue
            const relFile = relative(canonicalRoot, filePath).replace(/\\/g, '/')
            const content = readFileSync(filePath, 'utf8')
            const hash = createHash('sha256').update(content).digest('hex')

            const existing = db
              .prepare('SELECT hash FROM code_files WHERE path = ?')
              .get(relFile) as { hash?: string } | undefined
            if (!force && existing?.hash === hash) {
              skipped += 1
              continue
            }

            const { entities, relations } = extractSymbolsAndRelations(relFile, content, lang)
            db.prepare('DELETE FROM code_entities WHERE file = ?').run(relFile)
            db.prepare('DELETE FROM code_relations WHERE file = ?').run(relFile)

            const insertEnt = db.prepare(
              'INSERT INTO code_entities (name, kind, file, line, signature) VALUES (?, ?, ?, ?, ?)',
            )
            for (const ent of entities) {
              insertEnt.run(ent.name, ent.kind, ent.file, ent.line, ent.signature)
              entitiesCount += 1
            }

            const insertRel = db.prepare(
              'INSERT INTO code_relations (source, target, kind, file, line) VALUES (?, ?, ?, ?, ?)',
            )
            for (const rel of relations) {
              insertRel.run(rel.source, rel.target, rel.kind, rel.file, rel.line)
              relationsCount += 1
            }

            db.prepare(
              'INSERT OR REPLACE INTO code_files (path, hash, language, indexed_at) VALUES (?, ?, ?, ?)',
            ).run(relFile, hash, lang, nowIso)
            indexed += 1
          }

          const pruned = st.isFile()
            ? 0
            : pruneMissingFilesInScope(db, canonicalRoot, relative(canonicalRoot, targetPath))

          return jsonResult({
            ok: true,
            indexed,
            skipped,
            pruned,
            entities: entitiesCount,
            relations: relationsCount,
          })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'code_query',
      description:
        'Query indexed symbols (functions, classes, interfaces, types) by name prefix or substring.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Symbol name or substring to search for' },
          kind: {
            type: 'string',
            description: 'Optional filter: function, class, interface, type, variable',
          },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const q = typeof input.query === 'string' ? input.query.trim() : ''
          if (!q) return jsonResult({ ok: false, error: 'query is required', results: [] })
          const limit =
            typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
              ? Math.min(Math.floor(input.limit), 100)
              : 25
          const cwd = resolveToolCwd(context, fallbackDir)
          const canonicalRoot = realpathSync(cwd)
          const db = getCodemapDb(canonicalRoot)
          const escaped = q.replace(/[\\%_]/g, '\\$&')
          let sql = `
            SELECT name, kind, file, line, signature
            FROM code_entities
            WHERE name LIKE ? ESCAPE '\\'
          `
          const params: Array<string | number> = [`%${escaped}%`]
          if (typeof input.kind === 'string' && input.kind.trim()) {
            sql += ' AND kind = ?'
            params.push(input.kind.trim())
          }
          sql +=
            ' ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, file, line LIMIT ?'
          params.push(q, `${escaped}%`, limit)
          const rows = filterAndPruneExistingRows(
            db,
            canonicalRoot,
            db.prepare(sql).all(...params) as Array<{ file?: unknown }>,
          )
          return jsonResult({ ok: true, count: rows.length, results: rows })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'code_neighbors',
      description:
        'Find structural neighbors (imports, callers, subclasses) for a symbol or file path.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Symbol name or relative file path' },
          direction: {
            type: 'string',
            enum: ['both', 'outgoing', 'incoming'],
            description: 'Edge direction to traverse (default both)',
          },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const target = typeof input.target === 'string' ? input.target.trim() : ''
          if (!target) return jsonResult({ ok: false, error: 'target is required', neighbors: [] })
          const direction = typeof input.direction === 'string' ? input.direction : 'both'
          const cwd = resolveToolCwd(context, fallbackDir)
          const canonicalRoot = realpathSync(cwd)
          const db = getCodemapDb(canonicalRoot)
          const escaped = target.replace(/[\\%_]/g, '\\$&')

          const outgoing =
            direction === 'incoming'
              ? []
              : filterAndPruneExistingRows(
                  db,
                  canonicalRoot,
                  db
                    .prepare(
                      `SELECT source, target, kind, file, line
                       FROM code_relations
                       WHERE source = ? OR source LIKE ? ESCAPE '\\'
                       LIMIT 50`,
                    )
                    .all(target, `%${escaped}%`) as Array<{ file?: unknown }>,
                )

          const incoming =
            direction === 'outgoing'
              ? []
              : filterAndPruneExistingRows(
                  db,
                  canonicalRoot,
                  db
                    .prepare(
                      `SELECT source, target, kind, file, line
                       FROM code_relations
                       WHERE target = ? OR target LIKE ? ESCAPE '\\'
                       LIMIT 50`,
                    )
                    .all(target, `%${escaped}%`) as Array<{ file?: unknown }>,
                )

          return jsonResult({
            ok: true,
            target,
            outgoing,
            incoming,
          })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
  ]
}
