/**
 * update-status.ts — the Updates section of the settings window.
 *
 * TUI-local; derives rows from the update-notice.ts primitives. The registry
 * fetch and state persistence stay in the .tsx glue (host side) — this module
 * only classifies the channel and builds rows from injected state, so the
 * whole thing is testable without network.
 */

import type { SettingsRow, SettingsTab } from './pantheon-settings-state.ts'
import { comparePantheonVersions, type UpdateCheckState } from './update-notice.ts'

export type UpdateChannel = 'stable' | 'beta'

/** The running version's channel: a `-beta.N` suffix rides the beta dist-tag. */
export function updateChannelFor(version: string): UpdateChannel {
  return /-beta\.\d+$/.test(version) ? 'beta' : 'stable'
}

/** The npm dist-tag the registry check should query for the channel. */
export function registryTagForChannel(channel: UpdateChannel): string {
  return channel === 'beta' ? 'beta' : 'latest'
}

export function registryUrlForChannel(channel: UpdateChannel): string {
  return `https://registry.npmjs.org/pantheon-opencode/${registryTagForChannel(channel)}`
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export interface UpdatesSectionInput {
  currentVersion: string
  state: UpdateCheckState
  /** Selected channel (defaults to updateChannelFor(currentVersion)). */
  selectedChannel?: UpdateChannel
  /** Latest version seen this session (a check-now inside this window). */
  lastCheckedVersion?: string
  /** A check-now is in flight (this window). */
  checking?: boolean
  /** An update run is in flight (this window). */
  updating?: boolean
  nowMs?: number
}

export function buildUpdatesTab(input: UpdatesSectionInput): SettingsTab {
  const nowMs = input.nowMs ?? Date.now()
  const channel = input.selectedChannel ?? updateChannelFor(input.currentVersion)
  const lastCheckMs = input.state.lastCheckMs
  const latest = input.lastCheckedVersion ?? input.state.lastNotifiedVersion

  const stable = (version: string) => !/-beta\.\d+$/.test(version)
  const newer =
    latest !== undefined &&
    comparePantheonVersions(latest, input.currentVersion) > 0 &&
    !(stable(input.currentVersion) && !stable(latest))

  const rows: SettingsRow[] = [
    {
      id: 'update.channel',
      name: 'Channel',
      value: channel,
      cycle: ['stable', 'beta'] as const,
      note: 'stable tracks npm `latest`; beta tracks npm `beta`',
    },
    {
      id: 'update.check',
      name: 'Check now',
      value: input.checking
        ? 'checking…'
        : lastCheckMs
          ? `last check ${formatAgo(nowMs - lastCheckMs)}`
          : 'never checked',
      action: 'update-check',
      note: 'enter probes the registry for the running channel',
    },
  ]

  if (latest) {
    rows.push({
      id: 'update.latest',
      name: 'Registry',
      value: newer ? `v${latest} available` : 'up to date',
      note: newer ? 'adopt with `pantheon-opencode update`' : 'no newer compatible version',
    })
    rows.push({
      id: 'update.run',
      name: 'Update now',
      value: input.updating ? 'updating…' : newer ? `install v${latest}` : 'reinstall / refresh',
      action: 'update-run',
      note: newer ? 'enter runs `pantheon-opencode update`' : 'enter refreshes installed copy',
    })
  }

  rows.push({
    id: 'update.command',
    name: 'CLI command',
    value: channel === 'beta' ? 'pantheon-opencode update' : 'pantheon-opencode update --stable',
    note: 'run in terminal or OpenCode Desktop terminal',
  })

  return {
    id: 'updates',
    title: 'Updates',
    groups: [{ title: 'Updates & Maintenance', rows }],
  }
}
