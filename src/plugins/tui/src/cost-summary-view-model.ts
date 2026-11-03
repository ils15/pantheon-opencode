import type { CostSummaryRpcAgent, CostSummaryRpcResult } from './cost-summary-contract'
import { formatCount, formatUsd, usageHistoryTextLines } from './usage-view-model'

/** Why a ledger query could not answer; the panel shows the diagnostic, never the error. */
export function costSummaryUnavailableMessage(result: CostSummaryRpcResult): string | null {
  if (result.status !== 'unavailable') return null
  switch (result.reason) {
    case 'invalid_period':
      return 'Período de custo inválido.'
    case 'ledger_unavailable':
      return 'Banco de dados de sessão indisponível: nenhum histórico de custo até o OpenCode armazenar dados.'
    case 'ledger_unsupported':
      return 'Ledger não reconhecido: linhas existem mas nenhum uso pôde ser atribuído.'
    case 'ledger_corrupt':
      return 'Banco de dados de uso ilegível: esquema não reconhecido.'
    case 'ledger_timeout':
      return 'Consulta de custo excedeu o tempo limite.'
  }
}

/**
 * The headline row, wrapped: attributed tokens plus the catalog money of the
 * priced part. A result with no priced model at all shows tokens only — the
 * pricing label line next to it carries the reason, so it never reads as free.
 */
export function costSummaryTotalsLine(result: CostSummaryRpcResult, width: number): string[] {
  if (result.status === 'unavailable') return []
  const estimate = result.pricing.estimatedUsd
  const money = estimate === undefined ? undefined : formatUsd(estimate)
  const line =
    `GERAL · ${formatCount(result.totals.total)} tokens` +
    (money === undefined ? '' : ` · ${money}`)
  return usageHistoryTextLines(line, width)
}

/** Per-agent rows, wrapped; an unpriced agent says so instead of showing $0. */
export function costSummaryAgentLines(agent: CostSummaryRpcAgent, width: number): string[] {
  const fallback = 'preço indisponível'
  const money =
    agent.estimatedUsd === undefined ? fallback : (formatUsd(agent.estimatedUsd) ?? fallback)
  return usageHistoryTextLines(
    `  ${agent.agent} · ${formatCount(agent.total)} tokens · ${money}`,
    width,
  )
}
