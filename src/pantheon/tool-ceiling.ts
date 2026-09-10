/** Host-real context ceiling probe for C9/tool filtering. */

import type { PluginInput } from '@opencode-ai/plugin'
import type { NativeTaskStatus } from './native-task-status.ts'

export interface ToolCeilingSnapshot {
  usage: { inputTokens: number; outputTokens: number }
  limit: { contextTokens: number }
  supportsToolFiltering: boolean
}

export type ToolCeilingResult =
  | {
      status: 'OK'
      ceiling: number
      usage: ToolCeilingSnapshot['usage']
      limit: ToolCeilingSnapshot['limit']
    }
  | { status: Exclude<NativeTaskStatus, 'OK'>; detail: string }

export type HostToolCeilingSource = () => unknown | Promise<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isSnapshot(value: unknown): value is ToolCeilingSnapshot {
  if (!isRecord(value) || !isRecord(value.usage) || !isRecord(value.limit)) return false
  return (
    isFiniteNonNegative(value.usage.inputTokens) &&
    isFiniteNonNegative(value.usage.outputTokens) &&
    isFiniteNonNegative(value.limit.contextTokens) &&
    typeof value.supportsToolFiltering === 'boolean'
  )
}

/** Probe exact host usage/limit without estimation, fallback, or retry. */
export async function probeToolCeiling(source?: HostToolCeilingSource): Promise<ToolCeilingResult> {
  if (source === undefined)
    return { status: 'UNSUPPORTED', detail: 'host SDK exposes no context probe' }

  let raw: unknown
  try {
    raw = await source()
  } catch (error: unknown) {
    return { status: 'UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!isSnapshot(raw))
    return { status: 'CORRUPT_DATA', detail: 'host context probe returned malformed data' }
  if (raw.supportsToolFiltering === false) {
    return { status: 'UNSUPPORTED', detail: 'host SDK does not filter tools' }
  }
  const used = raw.usage.inputTokens + raw.usage.outputTokens
  if (used > raw.limit.contextTokens) {
    return { status: 'CORRUPT_DATA', detail: 'host usage exceeds context limit' }
  }
  return {
    status: 'OK',
    ceiling: raw.limit.contextTokens - used,
    usage: raw.usage,
    limit: raw.limit,
  }
}

/**
 * Read a ceiling from the actual OpenCode SDK event and provider catalogue.
 *
 * `message.updated` is the SDK's runtime usage source (`info.tokens`). The
 * provider catalogue supplies the selected model's context limit and its
 * `capabilities.toolcall` flag. This adapter intentionally does not accept a
 * caller-provided snapshot/callback, so tests cannot accidentally turn a
 * fixture into a claimed host probe.
 */
export async function probeToolCeilingFromHost(
  client: PluginInput['client'],
  event: unknown,
): Promise<ToolCeilingResult> {
  if (!isRecord(event) || event.type !== 'message.updated' || !isRecord(event.properties)) {
    return { status: 'UNSUPPORTED', detail: 'host SDK event has no message usage' }
  }
  const info = event.properties.info
  if (
    !isRecord(info) ||
    typeof info.providerID !== 'string' ||
    typeof info.modelID !== 'string' ||
    !isRecord(info.tokens)
  ) {
    return { status: 'UNSUPPORTED', detail: 'host SDK message has no token usage' }
  }
  const providerID = info.providerID as string
  const modelID = info.modelID as string
  const tokens = info.tokens as Record<string, unknown>

  let providersResult: unknown
  try {
    providersResult = await client.config.providers()
  } catch (error: unknown) {
    return { status: 'UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!isRecord(providersResult) || providersResult.error !== undefined) {
    return { status: 'UNAVAILABLE', detail: 'host SDK provider catalogue unavailable' }
  }
  const data = providersResult.data
  if (!isRecord(data) || !Array.isArray(data.providers)) {
    return { status: 'CORRUPT_DATA', detail: 'host SDK provider catalogue malformed' }
  }

  const provider = data.providers.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.id === providerID &&
      isRecord(candidate.models) &&
      isRecord(candidate.models[modelID]),
  )
  if (!isRecord(provider) || !isRecord(provider.models)) {
    return { status: 'UNSUPPORTED', detail: 'host SDK model metadata unavailable' }
  }
  const model = provider.models[modelID]
  if (!isRecord(model) || !isRecord(model.limit) || !isRecord(model.capabilities)) {
    return { status: 'UNSUPPORTED', detail: 'host SDK model ceiling capability unavailable' }
  }

  return probeToolCeiling(() => ({
    usage: { inputTokens: tokens.input, outputTokens: tokens.output },
    limit: { contextTokens: (model.limit as Record<string, unknown>).context },
    supportsToolFiltering: (model.capabilities as Record<string, unknown>).toolcall,
  }))
}
