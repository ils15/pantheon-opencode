/**
 * mermaid-ascii.ts — Zero-dependency Unicode diagram renderer for Mermaid
 * code blocks displayed inside the `/pantheon-artifacts` terminal reader.
 */

interface FlowNode {
  readonly id: string
  label: string
}

interface FlowEdge {
  readonly from: string
  readonly to: string
  readonly label?: string
  readonly dashed: boolean
}

function cleanLabel(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitOperandsOutsideDelimiters(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let bracketDepth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? ''
    if (quote) {
      if (ch === quote) quote = null
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      bracketDepth += 1
      cur += ch
      continue
    }
    if ((ch === ']' || ch === ')' || ch === '}') && bracketDepth > 0) {
      bracketDepth -= 1
      cur += ch
      continue
    }
    if (ch === '&' && bracketDepth === 0) {
      const part = cur.trim()
      if (part) out.push(part)
      cur = ''
      continue
    }
    cur += ch
  }
  const tail = cur.trim()
  if (tail) out.push(tail)
  return out
}

function parseNodeToken(token: string): { id: string; label?: string } {
  const trimmed = token.trim()
  if (trimmed === '[*]') return { id: '__star__', label: '●' }

  const match =
    /^([A-Za-z0-9_.:-]+)\s*(?:\[\[([^\]]*)\]\]|\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\{\{([^}]*)\}\}|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/.exec(
      trimmed,
    )
  if (!match) {
    const idOnly = trimmed.replace(/[^A-Za-z0-9_.:-]/g, '') || trimmed
    return { id: idOnly, label: cleanLabel(trimmed) }
  }
  const id = match[1] ?? trimmed
  const rawLabel = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[8]
  return rawLabel !== undefined ? { id, label: cleanLabel(rawLabel) } : { id }
}

function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 1) return text.slice(0, Math.max(0, maxLen))
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}

function drawBox(label: string, maxWidth: number, indent = ''): string[] {
  const innerLimit = Math.max(8, maxWidth - indent.length - 4)
  const text = truncateText(label, innerLimit)
  const bar = '─'.repeat(text.length + 2)
  return [`${indent}╭${bar}╮`, `${indent}│ ${text} │`, `${indent}╰${bar}╯`]
}

const ARROW_PATTERN = String.raw`(?:(?:-->|-\.->|==>)\|([^|]+)\||--\s+([^->\n]+?)\s+-->|-\.\s*([^.]+?)\s*\.->|==\s*([^=]+?)\s*==>|-->|-\.->|==>|---)`
const EDGE_RE = new RegExp(String.raw`^(.*?)\s+${ARROW_PATTERN}\s+(.*)$`)

function splitChainOperands(line: string): {
  parts: string[]
  connectors: Array<{ label?: string; dashed: boolean }>
} {
  // Walk left-to-right extracting arrow connectors between operand groups
  const arrowTokenRe = new RegExp(String.raw`\s+(${ARROW_PATTERN})\s+`, 'g')
  const parts: string[] = []
  const connectors: Array<{ label?: string; dashed: boolean }> = []
  let lastIdx = 0
  for (const m of line.matchAll(arrowTokenRe)) {
    const idx = m.index ?? 0
    parts.push(line.slice(lastIdx, idx).trim())
    const arrow = m[1] ?? ''
    const labelRaw = m[2] ?? m[3] ?? m[4] ?? m[5]
    connectors.push({
      label: labelRaw ? cleanLabel(labelRaw) : undefined,
      dashed: arrow.includes('-.'),
    })
    lastIdx = idx + m[0].length
  }
  parts.push(line.slice(lastIdx).trim())
  return { parts, connectors }
}

function parseFlowchart(lines: readonly string[]): {
  direction: 'LR' | 'TD'
  nodes: Map<string, FlowNode>
  edges: FlowEdge[]
} {
  const nodes = new Map<string, FlowNode>()
  const edges: FlowEdge[] = []
  let direction: 'LR' | 'TD' = 'TD'

  const ensureNode = (id: string, label?: string): void => {
    const existing = nodes.get(id)
    if (existing) {
      if (label && existing.label === existing.id) existing.label = label
      return
    }
    nodes.set(id, { id, label: label ?? id })
  }

  for (const rawLine of lines) {
    const stripped = rawLine.trim()
    if (!stripped || stripped.startsWith('%%')) continue
    if (/^(flowchart|graph)\s+/i.test(stripped)) {
      if (/\bLR\b|\bRL\b/i.test(stripped)) direction = 'LR'
      continue
    }
    if (/^(classDef|style|linkStyle|click|class|direction|subgraph|end)\b/i.test(stripped)) {
      continue
    }

    for (const stmt of stripped.split(';')) {
      const s = stmt.trim()
      if (!s) continue
      if (EDGE_RE.test(` ${s} `) || /(-->|-\.->|==>|---)/.test(s)) {
        const { parts, connectors } = splitChainOperands(s)
        if (parts.length >= 2 && connectors.length === parts.length - 1) {
          for (let i = 0; i < connectors.length; i += 1) {
            const leftGroup = splitOperandsOutsideDelimiters(parts[i] ?? '')
            const rightGroup = splitOperandsOutsideDelimiters(parts[i + 1] ?? '')
            const conn = connectors[i]
            for (const lTok of leftGroup) {
              const left = parseNodeToken(lTok)
              ensureNode(left.id, left.label)
              for (const rTok of rightGroup) {
                const right = parseNodeToken(rTok)
                ensureNode(right.id, right.label)
                edges.push({
                  from: left.id,
                  to: right.id,
                  label: conn?.label,
                  dashed: Boolean(conn?.dashed),
                })
              }
            }
          }
          continue
        }
      }

      const single = parseNodeToken(s)
      if (single.id) ensureNode(single.id, single.label)
    }
  }

  return { direction, nodes, edges }
}

function renderHorizontalChain(
  chain: readonly FlowNode[],
  edges: readonly FlowEdge[],
  maxWidth: number,
): string[] | null {
  if (chain.length < 2 || chain.length > 5) return null
  const boxes = chain.map((n) => drawBox(n.label, 28))
  const edgeWidths = edges.map((e) => (e.label ? Math.max(5, e.label.length + 4) : 4))
  const totalW =
    boxes.reduce((sum, b) => sum + (b[0]?.length ?? 0), 0) +
    edgeWidths.reduce((sum, w) => sum + w, 0)
  if (totalW > maxWidth) return null

  const top: string[] = []
  const mid: string[] = []
  const bot: string[] = []
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i]
    if (!box) continue
    top.push(box[0] ?? '')
    mid.push(box[1] ?? '')
    bot.push(box[2] ?? '')
    if (i < edges.length) {
      const ew = edgeWidths[i] ?? 4
      const lbl = edges[i]?.label
      const stem = edges[i]?.dashed ? '╌' : '─'
      const arrowMid = `${stem.repeat(ew - 1)}►`
      const arrowTop = lbl ? ` ${lbl}`.padEnd(ew, ' ') : ' '.repeat(ew)
      top.push(arrowTop)
      mid.push(arrowMid)
      bot.push(' '.repeat(ew))
    }
  }
  return [top.join(''), mid.join(''), bot.join('')]
}

function renderFlowchart(lines: readonly string[], maxWidth: number): string[] | null {
  const { direction, nodes, edges } = parseFlowchart(lines)
  if (nodes.size === 0) return null

  const outEdges = new Map<string, FlowEdge[]>()
  const inDegree = new Map<string, number>()
  const incomingSources = new Map<string, string[]>()
  for (const id of nodes.keys()) {
    outEdges.set(id, [])
    inDegree.set(id, 0)
    incomingSources.set(id, [])
  }
  for (const e of edges) {
    outEdges.get(e.from)?.push(e)
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
    incomingSources.get(e.to)?.push(e.from)
  }

  // Try horizontal side-by-side rendering for concise LR chains
  const isSimpleChain =
    edges.length === nodes.size - 1 &&
    [...outEdges.values()].every((list) => list.length <= 1) &&
    [...inDegree.values()].every((deg) => deg <= 1)
  if (direction === 'LR' && isSimpleChain) {
    const startId = [...nodes.keys()].find((id) => (inDegree.get(id) ?? 0) === 0)
    if (startId) {
      const chain: FlowNode[] = []
      const chainEdges: FlowEdge[] = []
      let cur: string | undefined = startId
      const seen = new Set<string>()
      while (cur && !seen.has(cur)) {
        seen.add(cur)
        const node = nodes.get(cur)
        if (!node) break
        chain.push(node)
        const nextEdge = outEdges.get(cur)?.[0]
        if (!nextEdge) break
        chainEdges.push(nextEdge)
        cur = nextEdge.to
      }
      const horiz = renderHorizontalChain(chain, chainEdges, maxWidth)
      if (horiz) return horiz
    }
  }

  // General vertical DAG/tree box renderer
  const out: string[] = []
  const visited = new Set<string>()
  const renderedJoin = new Set<string>()

  const renderSubtree = (
    nodeId: string,
    prefix: string,
    isRoot: boolean,
    edgeFromParent?: FlowEdge,
  ): void => {
    const node = nodes.get(nodeId)
    if (!node) return
    const deg = inDegree.get(nodeId) ?? 0

    if (!isRoot && deg > 1 && !renderedJoin.has(nodeId)) {
      const sources = incomingSources.get(nodeId) ?? []
      const remaining = sources.some((src) => !visited.has(src) && src !== edgeFromParent?.from)
      if (remaining) {
        const lbl = edgeFromParent?.label ? ` (${edgeFromParent.label})` : ''
        out.push(
          `${prefix}  ╰─► converges at ${truncateText(node.label, Math.max(12, maxWidth - prefix.length - 20))}${lbl}`,
        )
        return
      }
      renderedJoin.add(nodeId)
    }

    if (visited.has(nodeId)) {
      const lbl = edgeFromParent?.label ? ` (${edgeFromParent.label})` : ''
      out.push(
        `${prefix}  ╰─► ↺ ${truncateText(node.label, Math.max(12, maxWidth - prefix.length - 10))}${lbl}`,
      )
      return
    }
    visited.add(nodeId)

    if (!isRoot && deg > 1) {
      const sources = (incomingSources.get(nodeId) ?? [])
        .map((s) => nodes.get(s)?.id ?? s)
        .filter((v, i, arr) => arr.indexOf(v) === i)
      out.push(`${prefix}  (from ${sources.join(', ')})`)
    }

    const box = drawBox(node.label, maxWidth, prefix)
    out.push(...box)

    const children = outEdges.get(nodeId) ?? []
    if (children.length === 0) return

    if (children.length === 1 && children[0]) {
      const child = children[0]
      const stemX = `${prefix}    `
      const lineChar = child.dashed ? '┆' : '│'
      const lbl = child.label ? ` ${child.label}` : ''
      out.push(`${stemX}${lineChar}${lbl}`)
      out.push(`${stemX}▼`)
      renderSubtree(child.to, prefix, false, child)
      return
    }

    for (let i = 0; i < children.length; i += 1) {
      const child = children[i]
      if (!child) continue
      const isLast = i === children.length - 1
      const branch = isLast ? '└──►' : '├──►'
      const edgeTag = child.label ? `[${child.label}] ` : ''
      const childPrefix = `${prefix}  ${isLast ? '    ' : '│   '}`
      out.push(
        `${prefix}  ${branch} ${edgeTag}${truncateText(nodes.get(child.to)?.label ?? child.to, Math.max(12, maxWidth - prefix.length - edgeTag.length - 8))}`,
      )
      const grandChildren = outEdges.get(child.to) ?? []
      if (!visited.has(child.to)) {
        visited.add(child.to)
        if (grandChildren.length > 0) {
          for (let j = 0; j < grandChildren.length; j += 1) {
            const gc = grandChildren[j]
            if (!gc) continue
            const gcDeg = inDegree.get(gc.to) ?? 0
            if (gcDeg > 1) {
              const srcs = incomingSources.get(gc.to) ?? []
              const pending = srcs.some((s) => !visited.has(s))
              if (pending) {
                out.push(
                  `${childPrefix}  ╰─► converges at ${truncateText(nodes.get(gc.to)?.label ?? gc.to, Math.max(12, maxWidth - childPrefix.length - 20))}`,
                )
                continue
              }
            }
            out.push(`${childPrefix}  │`)
            out.push(`${childPrefix}  ▼`)
            renderSubtree(gc.to, childPrefix, false, gc)
          }
        }
      }
    }
  }

  const roots = [...nodes.keys()].filter((id) => (inDegree.get(id) ?? 0) === 0)
  const queue = roots.length > 0 ? roots : [...nodes.keys()].slice(0, 1)
  for (let i = 0; i < queue.length; i += 1) {
    const rootId = queue[i]
    if (!rootId || visited.has(rootId)) continue
    if (out.length > 0) out.push('')
    renderSubtree(rootId, '', true)
  }

  for (const id of nodes.keys()) {
    if (!visited.has(id)) {
      if (out.length > 0) out.push('')
      renderSubtree(id, '', true)
    }
  }

  return out
}

function renderSequence(lines: readonly string[], maxWidth: number): string[] | null {
  const participants = new Map<string, string>()
  const messages: Array<{ from: string; to: string; text: string; dashed: boolean }> = []

  const addParticipant = (id: string, label?: string): void => {
    if (!participants.has(id)) participants.set(id, cleanLabel(label ?? id))
    else if (label) participants.set(id, cleanLabel(label))
  }

  for (const raw of lines) {
    const s = raw.trim()
    if (!s || s.startsWith('%%') || /^sequenceDiagram\b/i.test(s)) continue
    const partMatch = /^(?:participant|actor)\s+([A-Za-z0-9_.-]+)(?:\s+as\s+(.+))?$/i.exec(s)
    if (partMatch?.[1]) {
      addParticipant(partMatch[1], partMatch[2])
      continue
    }
    const msgMatch = /^([A-Za-z0-9_.-]+)\s*(-->>|->>|-->|->)\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(
      s,
    )
    if (msgMatch?.[1] && msgMatch[2] && msgMatch[3]) {
      addParticipant(msgMatch[1])
      addParticipant(msgMatch[3])
      messages.push({
        from: msgMatch[1],
        to: msgMatch[3],
        text: cleanLabel(msgMatch[4] ?? ''),
        dashed: msgMatch[2].startsWith('--'),
      })
    }
  }

  if (participants.size === 0 || messages.length === 0) return null
  const ids = [...participants.keys()]
  const count = ids.length
  const colStep = Math.floor((maxWidth - 4) / Math.max(1, count - 1))

  // Render full aligned lifelines when 2-4 participants fit comfortably
  if (count >= 2 && count <= 4 && colStep >= 18) {
    const centers = ids.map((_, idx) => 5 + idx * Math.min(colStep, 22))
    const totalW = (centers[count - 1] ?? 10) + 8
    const out: string[] = []
    const topLine = Array(totalW).fill(' ')
    const midLine = Array(totalW).fill(' ')
    const botLine = Array(totalW).fill(' ')

    for (let i = 0; i < count; i += 1) {
      const id = ids[i]
      if (!id) continue
      const label = truncateText(participants.get(id) ?? id, 12)
      const boxW = label.length + 4
      const start = Math.max(0, (centers[i] ?? 0) - Math.floor(boxW / 2))
      const top = `╭${'─'.repeat(label.length + 2)}╮`
      const mid = `│ ${label} │`
      const bot = `╰${'─'.repeat(label.length + 2)}╯`
      for (let k = 0; k < boxW; k += 1) {
        if (start + k < totalW) {
          topLine[start + k] = top[k]
          midLine[start + k] = mid[k]
          botLine[start + k] = k === (centers[i] ?? 0) - start ? '┬' : bot[k]
        }
      }
    }
    out.push(topLine.join('').trimEnd(), midLine.join('').trimEnd(), botLine.join('').trimEnd())

    const emptyLifelines = (): string[] => {
      const arr = Array(totalW).fill(' ')
      for (const c of centers) arr[c] = '│'
      return arr
    }

    for (const msg of messages) {
      const iFrom = ids.indexOf(msg.from)
      const iTo = ids.indexOf(msg.to)
      if (iFrom < 0 || iTo < 0) continue
      const cFrom = centers[iFrom] ?? 0
      const cTo = centers[iTo] ?? 0
      const left = Math.min(cFrom, cTo)
      const right = Math.max(cFrom, cTo)

      const labelRow = emptyLifelines()
      const msgText = truncateText(msg.text, Math.max(6, right - left - 2))
      for (let k = 0; k < msgText.length; k += 1) {
        if (left + 2 + k < totalW) labelRow[left + 2 + k] = msgText[k]
      }
      out.push(labelRow.join('').trimEnd())

      const arrowRow = emptyLifelines()
      const wire = msg.dashed ? '┄' : '─'
      for (let x = left + 1; x < right; x += 1) arrowRow[x] = wire
      if (cFrom < cTo) {
        arrowRow[left] = '├'
        arrowRow[right - 1] = '►'
      } else {
        arrowRow[left + 1] = '◄'
        arrowRow[right] = '┤'
      }
      out.push(arrowRow.join('').trimEnd())
    }
    out.push(emptyLifelines().join('').trimEnd())
    return out
  }

  // Fallback compact sequence list
  return messages.map((m, idx) => {
    const arrow = m.dashed ? '╌╌►' : '──►'
    const fromLbl = participants.get(m.from) ?? m.from
    const toLbl = participants.get(m.to) ?? m.to
    return truncateText(`${idx + 1}. [${fromLbl}] ${arrow} [${toLbl}]: ${m.text}`, maxWidth)
  })
}

function renderStateDiagram(lines: readonly string[], maxWidth: number): string[] | null {
  const normalized = lines.map((line) => {
    const trimmed = line.trim()
    if (/^stateDiagram(?:-v2)?$/i.test(trimmed)) return 'flowchart TD'
    // Convert "A --> B : label" into "A -->|label| B"
    const arrowWithLabel = /^(.+?)\s*-->\s*(.+?)\s*:\s*(.+)$/.exec(trimmed)
    if (arrowWithLabel?.[1] && arrowWithLabel[2] && arrowWithLabel[3]) {
      return `${arrowWithLabel[1].trim()} -->|${arrowWithLabel[3].trim()}| ${arrowWithLabel[2].trim()}`
    }
    return line
  })
  return renderFlowchart(normalized, maxWidth)
}

export function renderMermaidToUnicode(
  rawLines: readonly string[],
  maxWidth = 76,
): { header: string; lines: string[] } {
  const firstMeaningful = rawLines.map((l) => l.trim()).find((l) => l && !l.startsWith('%%')) ?? ''

  if (/^(?:flowchart|graph)\b/i.test(firstMeaningful)) {
    const rendered = renderFlowchart(rawLines, maxWidth)
    if (rendered && rendered.length > 0) {
      return { header: '[Diagram: Flowchart]', lines: rendered }
    }
  } else if (/^sequenceDiagram\b/i.test(firstMeaningful)) {
    const rendered = renderSequence(rawLines, maxWidth)
    if (rendered && rendered.length > 0) {
      return { header: '[Diagram: Sequence]', lines: rendered }
    }
  } else if (/^stateDiagram/i.test(firstMeaningful)) {
    const rendered = renderStateDiagram(rawLines, maxWidth)
    if (rendered && rendered.length > 0) {
      return { header: '[Diagram: State]', lines: rendered }
    }
  }

  return {
    header: '[Mermaid Diagram]',
    lines: rawLines.map((l) => `  ${l.trim()}`).filter((l) => l.trim().length > 0),
  }
}
