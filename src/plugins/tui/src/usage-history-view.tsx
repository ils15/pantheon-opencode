/** @jsxImportSource @opentui/solid */

import type { Context, KeymapLayer, PanelInput } from '@opencode/plugin/tui/context'
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from 'solid-js'
import { quotaRpc } from './quota-rpc'
import type { UsageHistoryRpcPeriod, UsageHistoryRpcResult } from './usage-history-contract'
import { isActiveContextCostResult, isUsageHistoryRpcResult } from './usage-history-validation'
import {
  type ActiveContextCostResult,
  activeContextEstimateErrorLines,
  activeContextEstimateLines,
  activeContextEstimateMissingLines,
  activeContextEstimatePendingLines,
  USAGE_HISTORY_PERIOD_BINDINGS,
  usageHistoryChartLines,
  usageHistoryControlsLines,
  usageHistoryCoverageLabel,
  usageHistoryPartialWarning,
  usageHistoryPricingLabel,
  usageHistorySelectorLines,
  usageHistoryTextLines,
  usageHistoryUnavailableMessage,
} from './usage-view-model'

function location(context: Context): ReturnType<Context['data']['location']['default']> {
  return context.location ?? context.data.location.default()
}

export function ActiveContextEstimate(props: {
  context: Context
  providerID: string | null
  modelID: string | null
  contextTokens: number | null
  width: number
}): JSX.Element {
  const [result, setResult] = createSignal<ActiveContextCostResult | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const client = props.context.client.rpc(quotaRpc)

  createEffect(() => {
    const providerID = props.providerID
    const modelID = props.modelID
    const contextTokens = props.contextTokens
    if (contextTokens === null) {
      setResult(null)
      setFailed(false)
      setLoading(false)
      return
    }
    if (!providerID || !modelID) {
      setResult({
        status: 'unavailable',
        billed: false,
        basis: 'pre-cache-context-tokens-times-input-price',
        cacheDiscountApplied: false,
        reason: 'missing-model-identity',
      })
      setFailed(false)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    let current = true
    setResult(null)
    setFailed(false)
    setLoading(true)
    try {
      void client
        .active_context_cost(
          { providerID, modelID, contextTokens },
          { signal: controller.signal, location: location(props.context) },
        )
        .then((response) => {
          if (!current) return
          if (isActiveContextCostResult(response)) setResult(response)
          else setFailed(true)
        })
        .catch(() => {
          if (current) setFailed(true)
        })
        .finally(() => {
          if (current) setLoading(false)
        })
    } catch {
      setFailed(true)
      setLoading(false)
    }

    onCleanup(() => {
      current = false
      controller.abort()
    })
  })

  const lines = (): string[] => {
    if (loading()) return activeContextEstimatePendingLines(props.width)
    if (failed()) return activeContextEstimateErrorLines(props.width)
    const current = result()
    if (current) return activeContextEstimateLines(current, props.width)
    return activeContextEstimateMissingLines(props.width)
  }

  return (
    <box flexDirection="column">
      <For each={lines()}>{(line) => <text>{line}</text>}</For>
    </box>
  )
}

export function UsageHistorySection(props: {
  context: Context
  panel: PanelInput
  width: number
}): JSX.Element {
  const [period, setPeriod] = createSignal<UsageHistoryRpcPeriod>('7d')
  const [result, setResult] = createSignal<UsageHistoryRpcResult | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [requestFailed, setRequestFailed] = createSignal(false)
  const client = props.context.client.rpc(quotaRpc)

  const keymap = (): KeymapLayer => ({
    mode: 'global',
    enabled: () => props.panel.focused === true,
    commands: USAGE_HISTORY_PERIOD_BINDINGS.map(({ period: selected, bind, label }) => ({
      id: `pantheon.quota.history.${selected}`,
      title: `Histórico de uso: ${label}`,
      bind,
      run: () => {
        if (props.panel.focused !== true) return false
        setPeriod(selected)
        return undefined
      },
    })),
  })
  props.context.keymap.layer(keymap)

  createEffect(() => {
    const selectedPeriod = period()
    const controller = new AbortController()
    let current = true
    setLoading(true)
    setRequestFailed(false)
    setResult(null)

    try {
      void client
        .usage_history(
          { period: selectedPeriod },
          { signal: controller.signal, location: location(props.context) },
        )
        .then((response) => {
          if (!current) return
          if (isUsageHistoryRpcResult(response)) setResult(response)
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

  const chartLines = (): string[] => {
    const current = result()
    return current?.status === 'available' || current?.status === 'partial'
      ? usageHistoryChartLines(current, props.width)
      : []
  }
  const unavailable = (): string | null => {
    const current = result()
    return current ? usageHistoryUnavailableMessage(current) : null
  }
  const available = ():
    | Extract<UsageHistoryRpcResult, { status: 'available' | 'partial' }>
    | undefined => {
    const current = result()
    return current?.status === 'available' || current?.status === 'partial' ? current : undefined
  }
  const warning = (): string[] => {
    const current = result()
    if (current?.status !== 'available' && current?.status !== 'partial') return []
    const message = usageHistoryPartialWarning(current)
    return message ? usageHistoryTextLines(message, props.width) : []
  }

  return (
    <box flexDirection="column" paddingTop={1}>
      <text attributes={1}>Histórico de uso</text>
      <For each={usageHistorySelectorLines(period(), props.width)}>
        {(line) => <text>{line}</text>}
      </For>
      <For each={usageHistoryControlsLines(props.width)}>{(line) => <text>{line}</text>}</For>
      <Show when={loading()}>
        <text>Carregando histórico…</text>
      </Show>
      <Show when={!loading() && requestFailed()}>
        <For each={usageHistoryTextLines('Falha ao consultar o histórico.', props.width)}>
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
        {(history) => (
          <box flexDirection="column">
            <For each={usageHistoryTextLines(usageHistoryCoverageLabel(history()), props.width)}>
              {(line) => <text>{line}</text>}
            </For>
            <For each={warning()}>{(line) => <text>{line}</text>}</For>
            <For each={usageHistoryTextLines(usageHistoryPricingLabel(history()), props.width)}>
              {(line) => <text>{line}</text>}
            </For>
            <For each={chartLines()}>{(line) => <text>{line}</text>}</For>
          </box>
        )}
      </Show>
    </box>
  )
}
