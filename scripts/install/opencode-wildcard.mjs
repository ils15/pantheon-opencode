/** OpenCode's permission wildcard matcher and exact language intersection. */

const CASE_INSENSITIVE = process.platform === 'win32'

function normalizePattern(pattern) {
  return pattern.replaceAll('\\', '/')
}

function escapeRegexCharacter(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}

/** Match the OpenCode Wildcard.match behavior used by permission evaluation. */
export function opencodeWildcardMatch(input, pattern) {
  const normalizedPattern = normalizePattern(pattern)
  const trailingSpaceStar = normalizedPattern.endsWith(' *')
  const body = trailingSpaceStar ? normalizedPattern.slice(0, -2) : normalizedPattern
  let expression = '^'
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '*') expression += '.*'
    else if (char === '?') expression += '.'
    else expression += escapeRegexCharacter(char)
  }
  if (trailingSpaceStar) expression += '(?: .*)?'
  return new RegExp(`${expression}$`, CASE_INSENSITIVE ? 'is' : 's').test(normalizePattern(input))
}

function compileWildcard(pattern) {
  const normalized = normalizePattern(pattern)
  const trailingSpaceStar = normalized.endsWith(' *')
  const body = trailingSpaceStar ? normalized.slice(0, -2) : normalized
  const states = [{ epsilon: [], edges: [] }]
  let current = 0
  const addState = () => {
    states.push({ epsilon: [], edges: [] })
    return states.length - 1
  }
  const edge = (from, to, kind, value) => states[from].edges.push({ to, kind, value })

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '*') {
      const next = addState()
      states[current].epsilon.push(next)
      edge(current, current, 'any')
      current = next
    } else {
      const next = addState()
      edge(current, next, char === '?' ? 'any' : 'literal', char)
      current = next
    }
  }

  if (trailingSpaceStar) {
    const next = addState()
    const spaceLoop = addState()
    states[current].epsilon.push(next)
    edge(current, spaceLoop, 'literal', ' ')
    states[spaceLoop].epsilon.push(next)
    edge(spaceLoop, spaceLoop, 'any')
    current = next
  }

  return { states, start: 0, accept: current }
}

function literalCharactersOverlap(left, right) {
  if (!CASE_INSENSITIVE) return left === right
  return new RegExp(`^${escapeRegexCharacter(left)}$`, 'i').test(right)
}

function edgesOverlap(left, right) {
  if (left.kind === 'any' || right.kind === 'any') return true
  return literalCharactersOverlap(left.value, right.value)
}

/**
 * Exact non-empty language intersection for OpenCode's `*`/`?` wildcard
 * grammar. Brackets and other regex punctuation are literal; backslashes are
 * normalized to slashes; `*` crosses slashes; and a final ` *` is optional.
 */
export function opencodeWildcardPatternsOverlap(leftPattern, rightPattern) {
  const left = compileWildcard(leftPattern)
  const right = compileWildcard(rightPattern)
  const queue = [[left.start, right.start]]
  const visited = new Set()

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [leftState, rightState] = queue[cursor]
    const key = `${leftState}:${rightState}`
    if (visited.has(key)) continue
    visited.add(key)
    if (leftState === left.accept && rightState === right.accept) return true

    for (const next of left.states[leftState].epsilon) queue.push([next, rightState])
    for (const next of right.states[rightState].epsilon) queue.push([leftState, next])
    for (const leftEdge of left.states[leftState].edges) {
      for (const rightEdge of right.states[rightState].edges) {
        if (edgesOverlap(leftEdge, rightEdge)) queue.push([leftEdge.to, rightEdge.to])
      }
    }
  }

  return false
}
