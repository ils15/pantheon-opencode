/** Shared, data-only formatting and visual helpers for compact context gauges. */

export type ContextProgressTone = 'info' | 'success' | 'warning' | 'error'

export const CONTEXT_BAR_CELLS = 12
export const CONTEXT_BAR_FILLED_CELL = '\u25B0'
export const CONTEXT_BAR_EMPTY_CELL = '\u25B1'

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
  cells = CONTEXT_BAR_CELLS,
): { filled: string; empty: string } | null {
  const value = numberOrNull(percent)
  if (value === null) return null
  const total = Math.max(1, Math.floor(cells))
  const filled = contextBarFilled(value, total)
  return {
    filled: CONTEXT_BAR_FILLED_CELL.repeat(filled),
    empty: CONTEXT_BAR_EMPTY_CELL.repeat(total - filled),
  }
}

export function formatSpent(cost: number | null | undefined): string | null {
  const value = numberOrNull(cost)
  if (value === null || value < 0) return null
  return `$${value.toFixed(2)}`
}
