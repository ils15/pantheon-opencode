import { cellWidth } from './sidebar-width'
import type {
  UsageHistoryRpcAvailable,
  UsageHistoryRpcPeriod,
  UsageHistoryRpcResult,
} from './usage-history-contract'

export type ActiveContextCostResult =
  | {
      status: 'estimated'
      estimatedUsd: number
      billed: false
      basis: 'pre-cache-context-tokens-times-input-price'
      cacheDiscountApplied: false
    }
  | {
      status: 'unavailable'
      billed: false
      basis: 'pre-cache-context-tokens-times-input-price'
      cacheDiscountApplied: false
      reason:
        | 'invalid-context-token-count'
        | 'missing-model-identity'
        | 'no-pricing'
        | 'unknown-model'
        | 'ambiguous-model'
        | 'missing-cache-price'
    }

const HISTORY_PERIODS: readonly UsageHistoryRpcPeriod[] = ['7d', '15d', '30d', 'total']
export const USAGE_HISTORY_PERIOD_BINDINGS = [
  { period: '7d', bind: '7', label: '7d' },
  { period: '15d', bind: '1', label: '15d' },
  { period: '30d', bind: '3', label: '30d' },
  { period: 'total', bind: 't', label: 'total' },
] as const satisfies readonly {
  period: UsageHistoryRpcPeriod
  bind: string
  label: string
}[]

function wrapText(value: string, width: number): string[] {
  const maxWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
  const lines: string[] = []
  const segmenter = new Intl.Segmenter()
  let line = ''

  for (const word of value.trim().split(/\s+/)) {
    if (!word) continue
    if (line && cellWidth(line) + 1 + cellWidth(word) > maxWidth) {
      lines.push(line)
      line = ''
    }
    if (line) line += ' '
    for (const { segment } of segmenter.segment(word)) {
      if (cellWidth(line) + cellWidth(segment) > maxWidth) {
        if (line) lines.push(line)
        line = ''
      }
      line += segment
    }
  }

  if (line) lines.push(line)
  return lines
}

export function usageHistoryTextLines(value: string, width: number): string[] {
  return wrapText(value, width)
}

function formatCount(value: number): string {
  return Math.max(0, value).toLocaleString('en-US')
}

function formatUsd(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined
  return `$${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(value)}`
}

function chartBar(value: number, maxValue: number, width: number): string {
  const cells = Math.max(0, Math.floor(width))
  if (cells === 0 || value <= 0 || maxValue <= 0) return ''
  return '#'.repeat(Math.max(1, Math.min(cells, Math.round((value / maxValue) * cells))))
}

function chartValueLine(value: number, maximum: number, width: number): string {
  const count = `${formatCount(value)} tokens`
  const barWidth = Math.max(0, width - cellWidth(count) - 3)
  const bar = chartBar(value, maximum, Math.min(12, barWidth))
  const line = `  ${bar ? `${bar} ` : ''}${count}`
  return wrapText(line, width).join('\n')
}

function appendWrapped(target: string[], value: string, width: number): void {
  target.push(...wrapText(value, width))
}

export function usageHistorySelectorLabel(selected: UsageHistoryRpcPeriod): string {
  return `Período: ${HISTORY_PERIODS.map((period) => {
    const label = period === 'total' ? 'Total' : period
    return period === selected ? `[${label}]` : label
  }).join(' · ')}`
}

export function usageHistorySelectorLines(
  selected: UsageHistoryRpcPeriod,
  width: number,
): string[] {
  return wrapText(usageHistorySelectorLabel(selected), width)
}

export function usageHistoryPeriodForKey(key: string): UsageHistoryRpcPeriod | undefined {
  return USAGE_HISTORY_PERIOD_BINDINGS.find((binding) => binding.bind === key)?.period
}

export function usageHistoryControlsLines(width: number): string[] {
  return wrapText('7 · 7d   1 · 15d   3 · 30d   T · total', width)
}

export function usageHistoryCoverageLabel(result: UsageHistoryRpcAvailable): string {
  return result.coverageStart === null
    ? 'Início da cobertura indisponível'
    : `Cobertura desde ${result.coverageStart}`
}

export function usageHistoryPartialWarning(result: UsageHistoryRpcAvailable): string | null {
  if (result.partial && result.truncated) return 'Histórico parcial e truncado pelo limite seguro.'
  if (result.partial) return 'Histórico parcial segundo a consulta.'
  if (result.truncated) return 'Histórico truncado pelo limite seguro.'
  return null
}

export function usageHistoryPricingLabel(result: UsageHistoryRpcAvailable): string {
  const amount =
    result.pricing.estimatedUsd === undefined ? undefined : formatUsd(result.pricing.estimatedUsd)
  const value = amount ? ` · ${amount}` : ''
  switch (result.pricing.status) {
    case 'complete':
      return `Estimativa pelo catálogo${value} · não cobrada`
    case 'partial':
      return `Estimativa parcial pelo catálogo${value} · não cobrada · ${result.pricing.unpricedModels} modelo(s) sem preço`
    case 'unavailable':
      return 'Estimativa de preço indisponível · nenhum valor cobrado'
    case 'empty':
      return 'Sem dados de preço para estimar · nenhum valor cobrado'
  }
}

export function usageHistoryUnavailableMessage(result: UsageHistoryRpcResult): string | null {
  if (result.status !== 'unavailable') return null
  switch (result.reason) {
    case 'invalid_period':
      return 'Período de histórico inválido.'
    case 'history_timeout':
      return 'Consulta de histórico excedeu o tempo limite.'
    case 'history_unavailable':
      return 'Histórico indisponível neste momento.'
  }
}

export function usageHistoryEmptyMessage(): string {
  return 'Sem histórico neste período.'
}

export function usageHistoryChartLines(result: UsageHistoryRpcAvailable, width: number): string[] {
  const maxWidth = Math.max(1, Math.floor(width))
  if (result.rows === 0 && result.buckets.length === 0 && result.models.length === 0) {
    return wrapText(usageHistoryEmptyMessage(), maxWidth)
  }
  const lines: string[] = []
  appendWrapped(lines, `GERAL · ${formatCount(result.totals.total)} tokens`, maxWidth)

  if (result.buckets.length > 0) {
    lines.push('Uso diário')
    const maxBucket = Math.max(0, ...result.buckets.map((bucket) => bucket.total))
    for (const bucket of result.buckets) {
      appendWrapped(lines, bucket.date, maxWidth)
      lines.push(...chartValueLine(bucket.total, maxBucket, maxWidth).split('\n'))
    }
  } else {
    lines.push('Sem buckets diários neste período.')
  }

  lines.push('Modelos no período')
  if (result.models.length === 0) {
    lines.push('Sem totais por modelo.')
    return lines.flatMap((line) => wrapText(line, maxWidth))
  }

  const maxModel = Math.max(0, ...result.models.map((model) => model.totals.total))
  for (const model of result.models) {
    appendWrapped(lines, `${model.providerID}/${model.modelID}`, maxWidth)
    lines.push(...chartValueLine(model.totals.total, maxModel, maxWidth).split('\n'))
  }
  return lines.flatMap((line) => wrapText(line, maxWidth))
}

export function activeModelIdentity(model: {
  providerID: string | null
  modelID: string | null
  label: string
}): string {
  if (model.providerID && model.modelID) return `${model.providerID}/${model.modelID}`
  if (model.modelID) return model.modelID
  return model.label || 'identidade indisponível'
}

export function sessionSpendLabel(cost: number): string | null {
  if (!Number.isFinite(cost) || cost < 0) return null
  return `Gasto da sessão (relatado) · $${cost.toFixed(2)}`
}

function unavailableContextReason(
  reason: Extract<ActiveContextCostResult, { status: 'unavailable' }>['reason'],
): string {
  switch (reason) {
    case 'invalid-context-token-count':
      return 'contagem de tokens de contexto inválida'
    case 'missing-model-identity':
      return 'identidade do modelo indisponível'
    case 'no-pricing':
    case 'missing-cache-price':
      return 'preço de entrada indisponível'
    case 'unknown-model':
    case 'ambiguous-model':
      return 'modelo não identificado na tabela de preços'
  }
}

export function activeContextEstimateLines(
  result: ActiveContextCostResult,
  width: number,
): string[] {
  const maxWidth = Math.max(1, Math.floor(width))
  if (result.status === 'unavailable') {
    return wrapText(
      `Estimativa de contexto (pré-cache) indisponível · ${unavailableContextReason(result.reason)}`,
      maxWidth,
    )
  }

  const amount = formatUsd(result.estimatedUsd)
  if (!amount) {
    return wrapText('Estimativa de contexto (pré-cache) indisponível · valor inválido', maxWidth)
  }
  return [
    ...wrapText(`Estimativa de contexto (pré-cache) · ${amount}`, maxWidth),
    ...wrapText(
      'Preço de entrada × tokens pré-cache; sem desconto de cache; não é valor cobrado.',
      maxWidth,
    ),
  ]
}

export function activeContextEstimatePendingLines(width: number): string[] {
  return wrapText('Estimativa de contexto (pré-cache) · calculando…', width)
}

export function activeContextEstimateMissingLines(width: number): string[] {
  return wrapText(
    'Estimativa de contexto (pré-cache) indisponível · contexto não reportado.',
    width,
  )
}

export function activeContextEstimateErrorLines(width: number): string[] {
  return wrapText('Estimativa de contexto (pré-cache) indisponível · falha na consulta.', width)
}
