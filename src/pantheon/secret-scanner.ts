import { types as utilTypes } from 'node:util'

/**
 * In-process runtime secret scanner shared by the OpenCode V1 and V2 hooks.
 *
 * Patterns preserve the former shell scanner semantics: high-confidence
 * formats deny, while key/header names and generic assignments are advisory.
 * Findings contain only the former scanner's masked representation;
 * neither input nor raw matches are returned or logged here.
 */

export type SecretScanFinding = {
  confidence: 'high' | 'low'
  pattern: string
  masked: string
}

export type SecretScanResult =
  | { status: 'clean' }
  | { status: 'invalid' }
  | { status: 'block'; findings: SecretScanFinding[] }
  | { status: 'advisory'; findings: SecretScanFinding[] }

/** Maximum UTF-8 size of the serialized scanner input (5 MiB). */
export const MAX_SECRET_SCAN_INPUT_BYTES = 5 * 1024 * 1024

type SecretPattern = {
  name: string
  confidence: 'high' | 'low'
  regex: RegExp
}

const bifrostTokenPrefix = ['sk', '-bf-'].join('')
const bifrostHeader = ['x', '-bf-', 'vk'].join('')
const notLineFeedWhitespace = String.raw`[^\S\n]`
const IDENTIFIER_TOKEN_RE = /[A-Za-z0-9_-]+/g
const WHITESPACE_RE = /\s/

// Compile all runtime detection expressions once when this shared module loads.
// Do not add the repository-hygiene patterns from scripts/secret-scan.mjs here.
// The expressions use bounded character classes and fixed separators; none has
// nested ambiguous quantifiers. The 5 MiB input cap also bounds their linear
// scans and the assignment/JWT parsing loops below.
const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'aws-access-key', confidence: 'high', regex: /AKIA[0-9A-Z]{16}/i },
  { name: 'github-token', confidence: 'high', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/i },
  { name: 'gitlab-token', confidence: 'high', regex: /glpat-[A-Za-z0-9_-]{20}/i },
  { name: 'api-token', confidence: 'high', regex: /sk-[A-Za-z0-9]{20,}/i },
  { name: 'live-api-token', confidence: 'high', regex: /sk_live_[A-Za-z0-9]{20,}/i },
  { name: 'test-api-token', confidence: 'high', regex: /sk_test_[A-Za-z0-9]{20,}/i },
  {
    name: 'messaging-token',
    confidence: 'high',
    regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24}/i,
  },
  {
    name: 'bearer-token',
    confidence: 'high',
    regex: new RegExp(`bearer${notLineFeedWhitespace}+[A-Za-z0-9_.-]{20,}`, 'i'),
  },
  {
    name: 'jwt',
    confidence: 'high',
    regex: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/i,
  },
  {
    name: 'bifrost-token',
    confidence: 'high',
    regex: new RegExp(`${bifrostTokenPrefix}[A-Za-z0-9_-]{8,}`, 'i'),
  },
  {
    name: 'api-key-assignment',
    confidence: 'low',
    regex: /api[_-]?key/i,
  },
  {
    name: 'password-assignment',
    confidence: 'low',
    regex: /password/i,
  },
  {
    name: 'secret-assignment',
    confidence: 'low',
    regex: /secret/i,
  },
  { name: 'bifrost-header', confidence: 'low', regex: new RegExp(bifrostHeader, 'i') },
]

export const SECRET_SCAN_PATTERN_COUNT = SECRET_PATTERNS.length

const MAX_SECRET_SCAN_JSON_DEPTH = 512

type JsonPreflightFrame =
  | { kind: 'value'; value: unknown; depth: number }
  | {
      kind: 'array'
      value: unknown[]
      index: number
      length: number
      depth: number
    }
  | {
      kind: 'object'
      value: Record<string, unknown>
      keys: IterableIterator<string>
      first: boolean
      depth: number
    }

function serializedStringBytes(value: string, remainingBytes: number): number | undefined {
  let bytes = 2 // The JSON quotes.
  if (bytes > remainingBytes) return undefined

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2
    } else if (code < 0x20) {
      bytes += 6
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else {
        // Well-formed JSON.stringify escapes unpaired surrogates as \udxxx.
        bytes += 6
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6
    } else if (code <= 0x7f) {
      bytes++
    } else if (code <= 0x7ff) {
      bytes += 2
    } else {
      bytes += 3
    }

    if (bytes > remainingBytes) return undefined
  }

  return bytes
}

function ownEnumerableKeys(value: Record<string, unknown>): IterableIterator<string> {
  return (function* (): IterableIterator<string> {
    for (const key in value) {
      if (Object.hasOwn(value, key)) yield key
    }
  })()
}

/**
 * Measure JSON.stringify's compact UTF-8 output without creating serialized
 * strings. Returns undefined for oversized or non-plain JSON data.
 */
function measureJsonBytes(value: unknown, limit: number): number | undefined {
  let bytes = 0
  const active = new WeakSet<object>()
  const stack: JsonPreflightFrame[] = [{ kind: 'value', value, depth: 0 }]

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame === undefined) return undefined

    if (frame.kind === 'value') {
      stack.pop()
      const current = frame.value
      if (current === null) {
        bytes += 4
      } else if (typeof current === 'string') {
        const stringBytes = serializedStringBytes(current, limit - bytes)
        if (stringBytes === undefined) return undefined
        bytes += stringBytes
      } else if (typeof current === 'boolean') {
        bytes += current ? 4 : 5
      } else if (typeof current === 'number') {
        if (!Number.isFinite(current)) return undefined
        // Number#toString uses JSON's finite-number spelling, including -0 => 0.
        bytes += String(current).length
      } else if (typeof current !== 'object' || utilTypes.isProxy(current)) {
        return undefined
      } else {
        if (frame.depth >= MAX_SECRET_SCAN_JSON_DEPTH || active.has(current)) return undefined

        const prototype = Object.getPrototypeOf(current)
        const isArray = Array.isArray(current)
        if (
          (isArray && prototype !== Array.prototype) ||
          (!isArray && prototype !== Object.prototype && prototype !== null)
        ) {
          return undefined
        }

        // JSON.stringify invokes toJSON even when it is non-enumerable. Reject
        // custom hooks on either the value or its otherwise-plain prototype.
        if (
          Object.getOwnPropertyDescriptor(current, 'toJSON') !== undefined ||
          (prototype !== null && Object.getOwnPropertyDescriptor(prototype, 'toJSON') !== undefined)
        ) {
          return undefined
        }

        active.add(current)
        if (isArray) {
          const array = current as unknown[]
          const length = array.length
          bytes++ // [
          // Even the shortest JSON value takes one byte; account for commas
          // and the closing bracket before traversing potentially huge arrays.
          const minimumContentBytes = length === 0 ? 0 : length * 2 - 1
          if (bytes + minimumContentBytes + 1 > limit) return undefined
          stack.push({ kind: 'array', value: array, index: 0, length, depth: frame.depth })
        } else {
          bytes++ // {
          stack.push({
            kind: 'object',
            value: current as Record<string, unknown>,
            keys: ownEnumerableKeys(current as Record<string, unknown>),
            first: true,
            depth: frame.depth,
          })
        }
      }
    } else if (frame.kind === 'array') {
      if (frame.index === frame.length) {
        bytes++ // ]
        if (bytes > limit) return undefined
        stack.pop()
        active.delete(frame.value)
        continue
      }

      if (frame.index > 0) bytes++ // ,
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, String(frame.index))
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return undefined
      }
      frame.index++
      stack.push({ kind: 'value', value: descriptor.value, depth: frame.depth + 1 })
    } else {
      const next = frame.keys.next()
      if (next.done) {
        bytes++ // }
        if (bytes > limit) return undefined
        stack.pop()
        active.delete(frame.value)
        continue
      }

      const key = next.value
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, key)
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return undefined
      }

      const keyBytes = serializedStringBytes(key, limit - bytes - (frame.first ? 1 : 2))
      if (keyBytes === undefined) return undefined
      bytes += (frame.first ? 0 : 1) + keyBytes + 1 // optional comma, key, colon
      frame.first = false
      stack.push({ kind: 'value', value: descriptor.value, depth: frame.depth + 1 })
    }

    if (bytes > limit) return undefined
  }

  return bytes
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function maskMatch(match: string): string {
  const characters = Array.from(match)
  if (characters.length <= 8) return '****'
  return `${characters.slice(0, 4).join('')}****${characters.slice(-4).join('')}`
}

function isIdentifierCode(code: number | undefined): boolean {
  return (
    code !== undefined &&
    ((code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95 ||
      code === 45)
  )
}

function skipAssignmentWhitespace(input: string, index: number): number {
  while (index < input.length && input[index] !== '\n' && WHITESPACE_RE.test(input[index] ?? '')) {
    index++
  }
  return index
}

function findAssignmentMatch(
  input: string,
  lowerInput: string,
  pattern: SecretPattern,
): string | undefined {
  const marker =
    pattern.name === 'api-key-assignment'
      ? 'api'
      : pattern.name === 'password-assignment'
        ? 'password'
        : 'secret'
  if (!lowerInput.includes(marker)) return undefined

  IDENTIFIER_TOKEN_RE.lastIndex = 0
  let token = IDENTIFIER_TOKEN_RE.exec(input)
  while (token !== null) {
    if (pattern.regex.test(token[0])) {
      let index = skipAssignmentWhitespace(input, token.index + token[0].length)
      if (input[index] === ':' || input[index] === '=') {
        index = skipAssignmentWhitespace(input, index + 1)
        if (pattern.name === 'api-key-assignment') {
          if (input[index] === '"' || input[index] === "'") index++
          const valueStart = index
          while (isIdentifierCode(input.charCodeAt(index))) index++
          if (index - valueStart >= 16) {
            if (input[index] === '"' || input[index] === "'") index++
            return input.slice(token.index, index)
          }
        } else if (input[index] === '"' || input[index] === "'") {
          index++
          const valueStart = index
          while (
            index < input.length &&
            input[index] !== '\n' &&
            input[index] !== '"' &&
            input[index] !== "'"
          ) {
            index++
          }
          if (index - valueStart >= 8 && (input[index] === '"' || input[index] === "'")) {
            return input.slice(token.index, index + 1)
          }
        }
      }
    }
    token = IDENTIFIER_TOKEN_RE.exec(input)
  }
  return undefined
}

function findAsciiInsensitive(input: string, needle: string, from: number): number {
  for (let index = from; index <= input.length - needle.length; index++) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset++) {
      const code = input.charCodeAt(index + offset)
      const lowerCode = code >= 65 && code <= 90 ? code + 32 : code
      if (lowerCode !== needle.charCodeAt(offset)) {
        matched = false
        break
      }
    }
    if (matched) return index
  }
  return -1
}

function startsWithEyJ(input: string, index: number): boolean {
  if (index < 0 || index + 3 > input.length) return false
  const e = input.charCodeAt(index)
  const y = input.charCodeAt(index + 1)
  const j = input.charCodeAt(index + 2)
  return (e === 69 || e === 101) && (y === 89 || y === 121) && (j === 74 || j === 106)
}

function findJwtMatch(input: string): string | undefined {
  let searchFrom = 0
  while (searchFrom < input.length) {
    const start = findAsciiInsensitive(input, 'eyj', searchFrom)
    if (start < 0) return undefined
    let firstDot = start + 3
    while (isIdentifierCode(input.charCodeAt(firstDot))) firstDot++
    if (input[firstDot] !== '.') {
      // No later prefix inside this base64 segment can reach a period either.
      searchFrom = firstDot + 1
      continue
    }

    const secondStart = firstDot + 1
    if (!startsWithEyJ(input, secondStart)) {
      searchFrom = secondStart
      continue
    }
    let secondDot = secondStart + 3
    while (isIdentifierCode(input.charCodeAt(secondDot))) secondDot++
    if (input[secondDot] !== '.') {
      searchFrom = secondDot + 1
      continue
    }
    let end = secondDot + 1
    while (isIdentifierCode(input.charCodeAt(end))) end++
    return input.slice(start, end)
  }
  return undefined
}

/** Scan serialized tool text, returning no raw input or match values. */
export function scanSecretText(input: unknown): SecretScanResult {
  if (typeof input !== 'string') return { status: 'invalid' }
  // A code-unit precheck avoids doing a full byte count for obviously huge
  // strings. UTF-8 byte size is authoritative for the supported-input limit.
  if (input.length > MAX_SECRET_SCAN_INPUT_BYTES) return { status: 'invalid' }
  if (Buffer.byteLength(input, 'utf8') > MAX_SECRET_SCAN_INPUT_BYTES) {
    return { status: 'invalid' }
  }

  const findings: SecretScanFinding[] = []
  const lowerInput = input.toLowerCase()
  for (const pattern of SECRET_PATTERNS) {
    const match =
      pattern.name === 'jwt'
        ? findJwtMatch(input)
        : pattern.confidence === 'low' && pattern.name !== 'bifrost-header'
          ? findAssignmentMatch(input, lowerInput, pattern)
          : pattern.regex.exec(input)?.[0]
    if (match !== undefined) {
      findings.push({
        confidence: pattern.confidence,
        pattern: pattern.name,
        masked: maskMatch(match),
      })
    }
  }

  if (findings.some((finding) => finding.confidence === 'high')) {
    return { status: 'block', findings }
  }
  if (findings.length > 0) return { status: 'advisory', findings }
  return { status: 'clean' }
}

/** Serialize the hook payload as the former stdin protocol did, then scan it. */
export function scanSecretPayload(payload: unknown): SecretScanResult {
  try {
    if (!isPlainObject(payload)) return { status: 'invalid' }
    const toolInput = Object.getOwnPropertyDescriptor(payload, 'tool_input')
    if (
      toolInput === undefined ||
      !toolInput.enumerable ||
      !Object.hasOwn(toolInput, 'value') ||
      !isPlainObject(toolInput.value)
    ) {
      return { status: 'invalid' }
    }

    const measuredBytes = measureJsonBytes(payload, MAX_SECRET_SCAN_INPUT_BYTES)
    if (measuredBytes === undefined) return { status: 'invalid' }

    const serialized = JSON.stringify(payload)
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') !== measuredBytes) {
      return { status: 'invalid' }
    }
    return scanSecretText(serialized)
  } catch {
    // Never expose serialization errors: hostile/custom values can include input.
    return { status: 'invalid' }
  }
}
