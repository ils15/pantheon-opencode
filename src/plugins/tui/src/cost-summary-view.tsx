/** @jsxImportSource @opentui/solid */

import type { Context } from '@opencode/plugin/tui/context'
import type { Accessor, JSX } from 'solid-js'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import type { CostSummaryRpcAvailable, CostSummaryRpcResult } from './cost-summary-contract'
import { isCostSummaryRpcResult } from './cost-summary-validation'
import {
  costSummaryAgentLines,
  costSummaryTotalsLine,
  costSummaryUnavailableMessage,
} from './cost-summary-view-model'
import { quotaRpc } from './quota-rpc'
import type { UsageHistoryRpcPeriod } from './usage-history-contract'
import {
  usageHistoryCoverageLabel,
  usageHistoryEmptyMessage,
  usageHistoryPartialWarning,
  usageHistoryPricingLabel,
  usageHistoryTextLines,
} from './usage-view-model'

function location(context: Context): ReturnType<Context['data']['location']['default']> {
  return context.location ?? context.data.location.default()
}

/**
 * The `/quota` usage tab's cost section: the same read-only `opencode.db`
 * aggregation `pantheon_cost` reports, per agent, over the period selected by
 * the tab's shared usage-history selector. Aggregate numbers only — never
 * message content, session ids, or database paths.
 */
export function CostSummarySection(props: {
  context: Context
  width: number
  period: Accessor<UsageHistoryRpcPeriod>
}): JSX.Element {
  const [result, setResult] = createSignal<CostSummaryRpcResult | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [requestFailed, setRequestFailed] = createSignal(false)
  const client = props.context.client.rpc(quotaRpc)

  createEffect(() => {
    const selectedPeriod = props.period()
    const controller = new AbortController()
    let current = true
    setLoading(true)
    setRequestFailed(false)
    setResult(null)

    try {
      void client
        .cost_summary(
          { period: selectedPeriod },
          { signal: controller.signal, location: location(props.context) },
        )
        .then((response) => {
          if (!current) return
          if (isCostSummaryRpcResult(response)) setResult(response)
          else setRequestFailed(true)
        })
        .catch(() => {
          if (current) setRequestFailed(true)
        })
        .finally(() => {
          if (current) setLoading(false)
        })
    } catch {
      setRequestFailed(true)
      setLoading(false)
    }

    onCleanup(() => {
      current = false
      controller.abort()
    })
  })

  const unavailable = (): string | null => {
    const current = result()
    return current ? costSummaryUnavailableMessage(current) : null
  }
  const available = (): CostSummaryRpcAvailable | undefined => {
    const current = result()
    return current?.status === 'available' || current?.status === 'partial' ? current : undefined
  }
  const warning = (): string[] => {
    const current = available()
    if (!current) return []
    const message = usageHistoryPartialWarning(current)
    return message ? usageHistoryTextLines(message, props.width) : []
  }
  const agentLines = (): string[] =>
    (available()?.agents ?? []).flatMap((agent) => costSummaryAgentLines(agent, props.width))

  return (
    <box flexDirection="column" paddingTop={1}>
      <text attributes={1}>Custo estimado</text>
      <Show when={loading()}>
        <text>Calculando custo…</text>
      </Show>
      <Show when={!loading() && requestFailed()}>
        <For each={usageHistoryTextLines('Falha ao consultar o custo.', props.width)}>
          {(line) => <text>{line}</text>}
        </For>
      </Show>
      <Show when={!loading() && unavailable()}>
        {(message) => (
          <For each={usageHistoryTextLines(message(), props.width)}>
            {(line) => <text>{line}</text>}
          </For>
        )}
      </Show>
      <Show when={!loading() && !requestFailed() && available()}>
        {(summary) => (
          <box flexDirection="column">
            <For each={usageHistoryTextLines(usageHistoryCoverageLabel(summary()), props.width)}>
              {(line) => <text>{line}</text>}
            </For>
            <For each={warning()}>{(line) => <text>{line}</text>}</For>
            <For each={usageHistoryTextLines(usageHistoryPricingLabel(summary()), props.width)}>
              {(line) => <text>{line}</text>}
            </For>
            <For each={costSummaryTotalsLine(summary(), props.width)}>
              {(line) => <text attributes={1}>{line}</text>}
            </For>
            <Show when={summary().rows === 0}>
              <For each={usageHistoryTextLines(usageHistoryEmptyMessage(), props.width)}>
                {(line) => <text>{line}</text>}
              </For>
            </Show>
            <For each={agentLines()}>{(line) => <text>{line}</text>}</For>
          </box>
        )}
      </Show>
    </box>
  )
}
