/** Shared, data-only formatting and visual helpers for compact context gauges. */

export type ContextProgressTone = 'info' | 'success' | 'warning' | 'error'

export const CONTEXT_BAR_CELLS = 12
export const CONTEXT_BAR_FILLED_CELL = '\u25B0'
export const CONTEXT_BAR_EMPTY_CELL = '\u25B1'

export type BarShape = 'block' | 'line' | 'smooth' | 'ascii' | 'dots' | 'braille'

export interface BarShapeGlyphs {
  filled: string
  empty: string
  mark?: string
}

export const BAR_SHAPES: Record<BarShape, BarShapeGlyphs> = {
  block: { filled: '\u25B0', empty: '\u25B1', mark: '│' },
  line: { filled: '━', empty: '─', mark: '┼' },
  smooth: { filled: '█', empty: '░', mark: '┆' },
  ascii: { filled: '=', empty: '-', mark: '|' },
  dots: { filled: '●', empty: '○', mark: '│' },
  braille: { filled: '⣿', empty: '⣀', mark: '⡇' },
}

export interface ContextBarOptions {
  cells?: number
  shape?: BarShape
  evenMark?: boolean
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function contextUsageTone(percent: number): ContextProgressTone {
  if (percent > 90) return 'error'
  if (percent > 50) return 'warning'
  if (percent > 25) return 'success'
  return 'info'
}

export function formatTokenCount(tokens: number | null | undefined): string | null {
  const value = numberOrNull(tokens)
  if (value === null || value < 0) return null
  return Math.round(value).toLocaleString('en-US')
}

export function formatContextWindow(limit: number | null | undefined): string | null {
  const value = numberOrNull(limit)
  if (value === null || value <= 0) return null
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.floor(value / 1_000)}K`
  return `${Math.floor(value)}`
}

export function contextBarFilled(percent: number, cells = CONTEXT_BAR_CELLS): number {
  const total = Math.max(1, Math.floor(cells))
  const filled = Math.round((percent / 100) * total)
  if (!Number.isFinite(filled)) return 0
  return Math.min(total, Math.max(0, filled))
}

export function contextBar(
  percent: number | null | undefined,
  options: number | ContextBarOptions = CONTEXT_BAR_CELLS,
): { filled: string; empty: string } | null {
  const value = numberOrNull(percent)
  if (value === null) return null
  const total = Math.max(
    1,
    Math.floor(typeof options === 'number' ? options : (options?.cells ?? CONTEXT_BAR_CELLS)),
  )
  const shapeKey =
    typeof options === 'object' && options?.shape && options.shape in BAR_SHAPES
      ? options.shape
      : 'block'
  const glyphs = BAR_SHAPES[shapeKey] ?? BAR_SHAPES.block
  const evenMark = typeof options === 'object' ? Boolean(options?.evenMark) : false

  const filledCount = contextBarFilled(value, total)
  const emptyCount = total - filledCount

  if (!evenMark || total < 4) {
    return {
      filled: glyphs.filled.repeat(filledCount),
      empty: glyphs.empty.repeat(emptyCount),
    }
  }

  // Insert even-use mark at the midpoint (50%)
  const mid = Math.floor(total / 2)
  const mark = glyphs.mark ?? '|'

  if (filledCount <= mid) {
    // Mark is in the empty portion
    const emptyBefore = mid - filledCount
    const emptyAfter = Math.max(0, emptyCount - emptyBefore - 1)
    return {
      filled: glyphs.filled.repeat(filledCount),
      empty: `${glyphs.empty.repeat(emptyBefore)}${mark}${glyphs.empty.repeat(emptyAfter)}`,
    }
  }

  // Mark is in the filled portion
  const filledBefore = mid
  const filledAfter = Math.max(0, filledCount - filledBefore - 1)
  return {
    filled: `${glyphs.filled.repeat(filledBefore)}${mark}${glyphs.filled.repeat(filledAfter)}`,
    empty: glyphs.empty.repeat(emptyCount),
  }
}

export function formatSpent(cost: number | null | undefined): string | null {
  const value = numberOrNull(cost)
  if (value === null || value < 0) return null
  return `$${value.toFixed(2)}`
}
