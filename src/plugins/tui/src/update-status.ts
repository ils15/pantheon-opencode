/**
 * update-status.ts — the Updates section of the settings window.
 *
 * TUI-local; derives rows from the update-notice.ts primitives. The registry
 * fetch and state persistence stay in the .tsx glue (host side) — this module
 * only classifies the channel and builds rows from injected state, so the
 * whole thing is testable without network.
 */

import type { SettingsRow, SettingsSection } from './pantheon-settings-state.ts'
import {
  comparePantheonVersions,
  UPDATE_CHECK_TTL_MS,
  type UpdateCheckState,
} from './update-notice.ts'

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
  /** Latest version seen this session (a check-now inside this window). */
  lastCheckedVersion?: string
  /** A check-now is in flight (this window). */
  checking?: boolean
  nowMs?: number
}

export function buildUpdatesSection(input: UpdatesSectionInput): SettingsSection {
  const nowMs = input.nowMs ?? Date.now()
  const channel = updateChannelFor(input.currentVersion)
  const lastCheckMs = input.state.lastCheckMs
  const latest = input.lastCheckedVersion ?? input.state.lastNotifiedVersion

  const rows: SettingsRow[] = [
    {
      id: 'update.channel',
      title: `Channel: ${channel}`,
      description: 'stable tracks npm `latest`; beta tracks npm `beta`',
      selectable: false,
    },
    {
      id: 'update.check',
      title: 'Check now',
      description: input.checking
        ? 'checking…'
        : lastCheckMs
          ? `last check ${formatAgo(nowMs - lastCheckMs)}`
          : 'never checked',
      marker: ' → ',
      selectable: true,
    },
  ]

  if (latest) {
    // Same guard as pickUpdateNotice: a stable install is never advertised a
    // beta — the update CLI owns that crossing (explicit opt-in).
    const stable = (version: string) => !/-beta\.\d+$/.test(version)
    const newer =
      comparePantheonVersions(latest, input.currentVersion) > 0 &&
      !(stable(input.currentVersion) && !stable(latest))
    rows.push({
      id: 'update.latest',
      title: newer ? `Update available: v${latest}` : `Up to date (latest seen v${latest})`,
      description: newer ? 'adopt with `pantheon-opencode update`' : 'checked against the registry',
      marker: newer ? '[!]' : '[✓]',
      selectable: false,
    })
  }

  return {
    id: 'updates',
    title: 'Updates',
    hint: `refresh = \`pantheon-opencode update\` · notice TTL ${UPDATE_CHECK_TTL_MS / 3_600_000}h`,
    rows,
  }
}
