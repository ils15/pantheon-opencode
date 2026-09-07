/**
 * WS3 TOON codec (PR #94) — Token-Oriented Object Notation, TypeScript mirror.
 *
 * Minimal deterministic encoding for board signals, checkpoints and KV
 * payloads. Semantics identical to JSON; structurally smaller (no braces,
 * no per-key quotes, no commas); JSON fallback when the parser is
 * absent/fails. Savings are per payload class (~11% content-dominated
 * board records up to ~49% large tabular checkpoints — see
 * `docs/ws3-token-opt-measurements.md` for the reproducible table).
 * Byte-compatible with `src/mcp/toon_codec.py` on the
 * supported subset (null/bool/int/string, dicts, lists, uniform tables).
 *
 * Pure TypeScript — zero dependencies, no LLM, no external gateway.
 *
 * @module toon-codec
 */

export const TABLE_MARKER = '@table '

/** JSON-compatible value subset covered by the codec. */
export type ToonValue =
  | null
  | boolean
  | number
  | string
  | { [key: string]: ToonValue }
  | ToonValue[]

export interface ToonSizeReport {
  jsonChars: number
  toonChars: number
  ratio: number
  savedPct: number
  jsonTokens: number
  toonTokens: number
  tokenRatio: number
  tokenSavedPct: number
}

/** Default cap on nested-block depth accepted by `toonDecode` (DoS guard). */
export const TOON_MAX_DEPTH = 100

/** Default cap on input length accepted by `toonDecode` (DoS guard). */
export const TOON_MAX_CHARS = 1000000

const BARE_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@+~/-]*$/
const INT_RE = /^-?\d+$/
const FLOAT_RE = /^-?(?:\d+\.\d+|\d+\.\d*[eE][+-]?\d+|\d+[eE][+-]?\d+)$/
const KEYLIKE_RE = /^(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_][A-Za-z0-9_.@+~/-]*)\s*:(?:\s+|$)/
const RESERVED = new Set(['null', 'true', 'false', '{}', '[]'])

function looksNumeric(text: string): boolean {
  return INT_RE.test(text) || FLOAT_RE.test(text)
}

/** Nominal chars-per-token ratio (same fixed basis as token-opt metering). */
export const CHARS_PER_TOKEN = 4

function charsToTokens(chars: number): number {
  if (chars <= 0) return 0
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function quote(text: string): string {
  return JSON.stringify(text)
}

function isBareValue(text: string, inTable = false): boolean {
  if (text === '' || text !== text.trim()) return false
  if (RESERVED.has(text) || looksNumeric(text)) return false
  // In table cells a bare `|` would split the row — quote such values.
  if (inTable && text.includes('|')) return false
  if (text.includes('"') || text.includes('\\') || text.includes('\n') || text.includes('\r')) {
    return false
  }
  return true
}

function encodeScalar(value: ToonValue, itemPosition = false, tableCell = false): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return String(value)
  const text = String(value)
  if (isBareValue(text, tableCell)) {
    if (itemPosition && KEYLIKE_RE.test(text)) return quote(text)
    return text
  }
  return quote(text)
}

function encodeKey(key: string): string {
  return BARE_KEY_RE.test(key) ? key : quote(key)
}

function isPlainObject(value: ToonValue): value is { [key: string]: ToonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUniformDictList(value: ToonValue): value is { [key: string]: ToonValue }[] {
  if (!Array.isArray(value) || value.length === 0) return false
  if (!value.every((item) => isPlainObject(item))) return false
  const firstKeys = Object.keys(value[0] as { [key: string]: ToonValue })
  if (firstKeys.length === 0) return false
  return (value as { [key: string]: ToonValue }[]).every((item) => {
    const keys = Object.keys(item)
    return keys.length === firstKeys.length && keys.every((k, i) => k === firstKeys[i])
  })
}

/** Split a table row on `|` outside double quotes. */
function splitCells(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  let escaped = false
  for (const char of line) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\' && inQuotes) {
      current += char
      escaped = true
    } else if (char === '"') {
      current += char
      inQuotes = !inQuotes
    } else if (char === '|' && !inQuotes) {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells
}

/** Encode a value to a TOON string (deterministic). */
export function toonEncode(value: ToonValue): string {
  return encodeValue(value, 0).join('\n')
}

function encodeValue(value: ToonValue, indent: number): string[] {
  const pad = ' '.repeat(indent)
  if (value === null || typeof value !== 'object') return [pad + encodeScalar(value)]
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return [`${pad}{}`]
    const lines: string[] = []
    for (const [key, item] of entries) {
      const encodedKey = encodeKey(key)
      if (item === null || typeof item !== 'object') {
        lines.push(`${pad}${encodedKey}: ${encodeScalar(item)}`)
      } else if (isPlainObject(item) && Object.keys(item).length === 0) {
        lines.push(`${pad}${encodedKey}: {}`)
      } else if (Array.isArray(item) && item.length === 0) {
        lines.push(`${pad}${encodedKey}: []`)
      } else {
        lines.push(`${pad}${encodedKey}:`)
        lines.push(...encodeValue(item, indent + 2))
      }
    }
    return lines
  }
  if (value.length === 0) return [`${pad}[]`]
  if (isUniformDictList(value)) {
    const keys = Object.keys(value[0] as { [key: string]: ToonValue })
    const lines = [pad + TABLE_MARKER + keys.map((k) => encodeKey(k)).join('|')]
    for (const item of value) {
      lines.push(
        pad +
          keys
            .map((k) =>
              encodeScalar((item as Record<string, ToonValue>)[k] as ToonValue, true, true),
            )
            .join('|'),
      )
    }
    return lines
  }
  return (value as ToonValue[]).flatMap((item) => encodeItem(item, indent))
}

function encodeItem(item: ToonValue, indent: number): string[] {
  const pad = ' '.repeat(indent)
  if (item === null || typeof item !== 'object') return [`${pad}- ${encodeScalar(item, true)}`]
  if (isPlainObject(item) && Object.keys(item).length === 0) return [`${pad}- {}`]
  if (Array.isArray(item) && item.length === 0) return [`${pad}- []`]
  const sub = encodeValue(item, indent + 2)
  const first = sub[0]?.trim() ?? ''
  return [`${pad}- ${first}`, ...sub.slice(1)]
}

function parseScalar(token: string): ToonValue {
  if (token === 'null') return null
  if (token === 'true') return true
  if (token === 'false') return false
  if (token === '{}') return {}
  if (token === '[]') return []
  if (INT_RE.test(token)) return Number.parseInt(token, 10)
  if (FLOAT_RE.test(token)) return Number.parseFloat(token)
  if (token.startsWith('"')) return JSON.parse(token) as ToonValue
  return token
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * Split `key: value` on the FIRST colon (values may contain colons).
 * A quoted key is parsed FIRST (mirror of the py `raw_decode` fix): the
 * colon is searched AFTER the closing quote, so `{"a:b": 2}` splits into
 * key `a:b` instead of breaking inside the quotes.
 */
function splitKeyValue(text: string): [string, string] {
  if (text.startsWith('"')) {
    let i = 1
    let closed = -1
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '"') {
        closed = i
        break
      }
      i += 1
    }
    if (closed < 0) throw new Error(`TOON: line without ':' separator: ${JSON.stringify(text)}`)
    const rest = text.slice(closed + 1).trimStart()
    if (!rest.startsWith(':')) {
      throw new Error(`TOON: line without ':' separator: ${JSON.stringify(text)}`)
    }
    let key: unknown
    try {
      key = JSON.parse(text.slice(0, closed + 1)) as unknown
    } catch {
      throw new Error(`TOON: line without ':' separator: ${JSON.stringify(text)}`)
    }
    if (typeof key !== 'string' || key === '') {
      throw new Error(`TOON: empty key in line: ${JSON.stringify(text)}`)
    }
    return [key, rest.slice(1).trim()]
  }
  const idx = text.indexOf(':')
  if (idx < 0) throw new Error(`TOON: line without ':' separator: ${JSON.stringify(text)}`)
  const rawKey = text.slice(0, idx).trim()
  if (rawKey === '') throw new Error(`TOON: empty key in line: ${JSON.stringify(text)}`)
  const key = rawKey.startsWith('"') ? (JSON.parse(rawKey) as string) : rawKey
  return [key, text.slice(idx + 1).trim()]
}

/**
 * Decode a TOON string back to the identical value (throws on invalid).
 * `maxDepth`/`maxChars` are DoS guards: oversized inputs fail with a
 * controlled `Error` instead of a stack overflow / memory blowup.
 */
export function toonDecode(
  text: string,
  maxDepth: number = TOON_MAX_DEPTH,
  maxChars: number = TOON_MAX_CHARS,
): ToonValue {
  if (text.length > maxChars) {
    throw new Error(`TOON: input too large (${text.length} chars > maxChars=${maxChars})`)
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) throw new Error('TOON: empty input')
  const first = lines[0]?.trim() ?? ''
  if (first.startsWith('{') || first.startsWith('[')) {
    try {
      return JSON.parse(text) as ToonValue
    } catch {
      throw new Error('TOON: invalid JSON fallback')
    }
  }
  const [value, nextIdx] = parseBlock(lines, 0, 0, 0, maxDepth)
  if (nextIdx !== lines.length) throw new Error(`TOON: trailing content at line ${nextIdx + 1}`)
  return value
}

function parseBlock(
  lines: string[],
  idx: number,
  indent: number,
  depth: number,
  maxDepth: number,
): [ToonValue, number] {
  if (depth > maxDepth) throw new Error(`TOON: maxDepth=${maxDepth} exceeded`)
  const stripped = lines[idx]?.trim() ?? ''
  if (stripped.startsWith('@table ')) return parseTable(lines, idx, indent)
  if (stripped.startsWith('- ') || stripped === '-')
    return parseList(lines, idx, indent, depth, maxDepth)
  return parseDict(lines, idx, indent, depth, maxDepth)
}

function parseTable(lines: string[], idx: number, indent: number): [ToonValue, number] {
  const headerLine = lines[idx]?.trim() ?? ''
  const header = headerLine.slice(TABLE_MARKER.length)
  const keys = splitCells(header).map((cell) =>
    cell.startsWith('"') ? (JSON.parse(cell) as string) : cell,
  )
  if (keys.length === 0 || keys.some((k) => k === '')) {
    throw new Error(`TOON: bad @table header at line ${idx + 1}`)
  }
  const rows: { [key: string]: ToonValue }[] = []
  idx += 1
  while (idx < lines.length && indentOf(lines[idx] as string) === indent) {
    const rowStripped = (lines[idx] as string).trim()
    if (rowStripped.startsWith('@table ') || rowStripped.startsWith('- ') || rowStripped === '-') {
      break
    }
    if (rowStripped.includes(':') && KEYLIKE_RE.test(rowStripped)) break
    const cells = splitCells(rowStripped)
    if (cells.length !== keys.length) throw new Error(`TOON: row width mismatch at line ${idx + 1}`)
    const row: { [key: string]: ToonValue } = {}
    keys.forEach((k, i) => {
      row[k] = parseScalar(cells[i] as string)
    })
    rows.push(row)
    idx += 1
  }
  return [rows, idx]
}

function parseDict(
  lines: string[],
  idx: number,
  indent: number,
  depth: number,
  maxDepth: number,
): [ToonValue, number] {
  const result: { [key: string]: ToonValue } = {}
  while (idx < lines.length) {
    const line = lines[idx] as string
    if (line.trim() === '' || indentOf(line) !== indent) break
    const stripped = line.trim()
    if (stripped.startsWith('@table ') || stripped.startsWith('- ') || stripped === '-') break
    const [key, rest] = splitKeyValue(stripped)
    if (rest === '') {
      idx += 1
      const nestedLine = idx < lines.length ? (lines[idx] as string) : undefined
      if (nestedLine === undefined || indentOf(nestedLine) <= indent) {
        throw new Error(`TOON: missing nested block for key ${JSON.stringify(key)}`)
      }
      const [nested, next] = parseBlock(lines, idx, indentOf(nestedLine), depth + 1, maxDepth)
      result[key] = nested
      idx = next
    } else {
      result[key] = parseScalar(rest)
      idx += 1
    }
  }
  return [result, idx]
}

function parseList(
  lines: string[],
  idx: number,
  indent: number,
  depth: number,
  maxDepth: number,
): [ToonValue, number] {
  const items: ToonValue[] = []
  while (idx < lines.length) {
    const line = lines[idx] as string
    if (indentOf(line) !== indent) break
    const stripped = line.trim()
    if (!stripped.startsWith('- ') && stripped !== '-') break
    const rest = stripped.slice(1).trim()
    if (rest === '') {
      idx += 1
      const nestedLine = idx < lines.length ? (lines[idx] as string) : undefined
      if (nestedLine === undefined || indentOf(nestedLine) <= indent) {
        throw new Error(`TOON: missing nested block in list at line ${idx + 1}`)
      }
      const [nested, next] = parseBlock(lines, idx, indentOf(nestedLine), depth + 1, maxDepth)
      items.push(nested)
      idx = next
      continue
    }
    if (KEYLIKE_RE.test(rest)) {
      const [key, subRest] = splitKeyValue(rest)
      const item: { [key: string]: ToonValue } = {}
      if (subRest === '') {
        idx += 1
        const nestedLine = idx < lines.length ? (lines[idx] as string) : undefined
        if (nestedLine === undefined || indentOf(nestedLine) <= indent) {
          throw new Error(`TOON: missing nested block for key ${JSON.stringify(key)}`)
        }
        const [nested, next] = parseBlock(lines, idx, indentOf(nestedLine), depth + 1, maxDepth)
        item[key] = nested
        idx = next
      } else {
        item[key] = parseScalar(subRest)
        idx += 1
      }
      while (idx < lines.length && indentOf(lines[idx] as string) > indent) {
        const cont = (lines[idx] as string).trim()
        const [subKey, subValue] = splitKeyValue(cont)
        if (subValue === '') {
          idx += 1
          const nestedLine = idx < lines.length ? (lines[idx] as string) : undefined
          if (nestedLine === undefined || indentOf(nestedLine) <= indent) {
            throw new Error(`TOON: missing nested block for key ${JSON.stringify(subKey)}`)
          }
          const [nested, next] = parseBlock(lines, idx, indentOf(nestedLine), depth + 1, maxDepth)
          item[subKey] = nested
          idx = next
        } else {
          item[subKey] = parseScalar(subValue)
          idx += 1
        }
      }
      items.push(item)
    } else {
      items.push(parseScalar(rest))
      idx += 1
    }
  }
  return [items, idx]
}

/**
 * Decode TOON, falling back to JSON (mirrors "parser absent" mode).
 * Throws a consistent `TOON:` error when the input is neither valid TOON
 * nor valid JSON (never leaks the raw JSON parser message).
 */
export function toonDecodeAuto(
  text: string,
  maxDepth: number = TOON_MAX_DEPTH,
  maxChars: number = TOON_MAX_CHARS,
): ToonValue {
  const stripped = text.trim()
  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    try {
      return JSON.parse(text) as ToonValue
    } catch {
      throw new Error('TOON: invalid JSON fallback')
    }
  }
  try {
    return toonDecode(text, maxDepth, maxChars)
  } catch {
    try {
      return JSON.parse(text) as ToonValue
    } catch {
      throw new Error(
        `TOON: invalid input (neither TOON nor JSON): ${JSON.stringify(stripped.slice(0, 60))}`,
      )
    }
  }
}

/**
 * Compare JSON vs TOON sizes for a value.
 * Reports BOTH chars and tokens: token ratios on tiny payloads suffer
 * ceiling bias (`ceil` rounds 161→41 vs 143→36), so the char columns are
 * the honest basis and the token columns show what metering will debit.
 * Per-class numbers: see `docs/ws3-token-opt-measurements.md`.
 */
export function toonSizeReport(value: ToonValue): ToonSizeReport {
  const compactJson = JSON.stringify(value)
  const toon = toonEncode(value)
  const ratio = compactJson.length > 0 ? toon.length / compactJson.length : 1
  const jsonTokens = charsToTokens(compactJson.length)
  const toonTokens = charsToTokens(toon.length)
  const tokenRatio = jsonTokens > 0 ? toonTokens / jsonTokens : 1
  return {
    jsonChars: compactJson.length,
    toonChars: toon.length,
    ratio: Math.round(ratio * 10000) / 10000,
    savedPct: Math.round((1 - ratio) * 10000) / 100,
    jsonTokens,
    toonTokens,
    tokenRatio: Math.round(tokenRatio * 10000) / 10000,
    tokenSavedPct: Math.round((1 - tokenRatio) * 10000) / 100,
  }
}
