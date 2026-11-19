/**
 * update-status.ts — the Updates section of the settings window.
 *
 * TUI-local; derives rows from the update-notice.ts primitives. The registry
 * fetch and state persistence stay in the .tsx glue (host side) — this module
 * only classifies the channel and builds rows from injected state, so the
 * whole thing is testable without network.
 */

import { formatBytes, type LegacyAuditSummary } from './legacy-audit.ts'
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

function formatAgo(ms: number, isPt = false): string {
  if (ms < 60_000) return isPt ? 'agora mesmo' : 'just now'
  if (ms < 3_600_000)
    return isPt ? `há ${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000)
    return isPt ? `há ${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 3_600_000)}h ago`
  return isPt ? `há ${Math.floor(ms / 86_400_000)}d` : `${Math.floor(ms / 86_400_000)}d ago`
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
  /** Latest scan summary from legacy-audit.ts (global + project). */
  legacyAudit?: LegacyAuditSummary | null
  /** Whether a legacy scan is currently running. */
  legacyScanning?: boolean
  /** Whether a legacy cleanup is currently running. */
  legacyCleaning?: boolean
  /** Outcome notice from the last scan/clean action. */
  legacyNotice?: string
  nowMs?: number
  languagePref?: string
}

export function buildUpdatesTab(input: UpdatesSectionInput): SettingsTab {
  const isPt = input.languagePref === 'pt-BR'
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
      name: isPt ? 'Canal' : 'Channel',
      value: channel,
      cycle: ['stable', 'beta'] as const,
      note: isPt
        ? 'stable segue npm `latest`; beta segue npm `beta`'
        : 'stable tracks npm `latest`; beta tracks npm `beta`',
    },
    {
      id: 'update.check',
      name: isPt ? 'Verificar agora' : 'Check now',
      value: input.checking
        ? isPt
          ? 'verificando…'
          : 'checking…'
        : lastCheckMs
          ? isPt
            ? `verificado ${formatAgo(nowMs - lastCheckMs, true)}`
            : `last check ${formatAgo(nowMs - lastCheckMs, false)}`
          : isPt
            ? 'nunca verificado'
            : 'never checked',
      action: 'update-check',
      note: isPt
        ? 'enter consulta o registro npm para o canal ativo'
        : 'enter probes the registry for the running channel',
    },
  ]

  const pkgSpec = channel === 'beta' ? 'pantheon-opencode@beta' : 'pantheon-opencode'
  const pluginCommand = `opencode plugin update ${pkgSpec}`

  if (latest) {
    rows.push({
      id: 'update.latest',
      name: isPt ? 'Registro (npm)' : 'Registry',
      value: newer
        ? `v${latest} ${isPt ? 'disponível' : 'available'}`
        : isPt
          ? 'atualizado'
          : 'up to date',
      ...(newer ? { action: 'update-run' as const } : {}),
      note: newer
        ? isPt
          ? `enter atualiza agora · ou rode \`${pluginCommand}\``
          : `enter updates now · or run \`${pluginCommand}\``
        : isPt
          ? 'nenhuma versão mais recente compatível'
          : 'no newer compatible version',
    })
    rows.push({
      id: 'update.run',
      name: isPt ? 'Atualizar plugin' : 'Update plugin',
      value: input.updating
        ? isPt
          ? 'atualizando…'
          : 'updating…'
        : newer
          ? `${isPt ? 'atualizar' : 'update'} v${latest}`
          : isPt
            ? 'reinstalar plugin'
            : 'refresh plugin',
      action: 'update-run',
      note: newer
        ? isPt
          ? `enter executa \`${pluginCommand}\` + reload`
          : `enter runs \`${pluginCommand}\` + reload`
        : isPt
          ? 'enter força atualização do plugin instalado'
          : 'enter refreshes the installed plugin',
    })
  }

  rows.push({
    id: 'update.command',
    name: isPt ? 'Comando no terminal' : 'CLI Command',
    value: 'opencode plugin update',
    note: isPt
      ? `sem npx: \`${pluginCommand} && opencode reload\``
      : `native CLI (no npx): \`${pluginCommand} && opencode reload\``,
  })

  const audit = input.legacyAudit
  const legacyRows: SettingsRow[] = [
    {
      id: 'legacy.status',
      name: isPt ? 'Auditoria legada' : 'Legacy & Drift',
      value: input.legacyScanning
        ? isPt
          ? 'escaneando…'
          : 'scanning…'
        : audit === undefined || audit === null
          ? isPt
            ? 'não escaneado'
            : 'not scanned'
          : audit.total === 0
            ? isPt
              ? 'limpo (0 obsoletos)'
              : 'clean (0 obsolete)'
            : isPt
              ? `${audit.total} arquivo(s) (${formatBytes(audit.totalBytes)})`
              : `${audit.total} file(s) (${formatBytes(audit.totalBytes)})`,
      note: input.legacyNotice
        ? input.legacyNotice
        : audit && audit.total > 0
          ? isPt
            ? `global: ${audit.byScope.global} · projeto: ${audit.byScope.project}${audit.unmigratedStores > 0 ? ` · ${audit.unmigratedStores} store(s) p/ migrar` : ''}`
            : `global: ${audit.byScope.global} · project: ${audit.byScope.project}${audit.unmigratedStores > 0 ? ` · ${audit.unmigratedStores} store(s) to migrate` : ''}`
          : isPt
            ? 'verifica hooks V1, bancos não migrados e cópias redundantes'
            : 'checks V1 hooks, unmigrated stores & redundant plugin copies',
    },
    {
      id: 'legacy.scan',
      name: isPt ? 'Escanear obsoletos' : 'Scan legacy & drift',
      value: input.legacyScanning
        ? isPt
          ? 'escaneando…'
          : 'scanning…'
        : isPt
          ? 'escanear agora'
          : 'scan global + project',
      action: 'legacy-scan',
      note: isPt
        ? 'enter escaneia sem modificar ou apagar nenhum arquivo'
        : 'enter scans read-only without deleting anything',
    },
    {
      id: 'legacy.clean',
      name: isPt ? 'Migrar & limpar' : 'Migrate & clean obsolete',
      value: input.legacyCleaning
        ? isPt
          ? 'limpando…'
          : 'cleaning…'
        : audit && audit.total > 0
          ? isPt
            ? `remover ${audit.total} (${formatBytes(audit.totalBytes)})`
            : `remove ${audit.total} (${formatBytes(audit.totalBytes)})`
          : isPt
            ? 'nada para remover'
            : 'nothing to remove',
      action: 'legacy-clean',
      note: isPt
        ? 'migra memória/contexto/goals antes e preserva agentes/skills custom'
        : 'migrates memory/context/goals first · preserves custom agents/skills',
    },
  ]

  return {
    id: 'updates',
    title: isPt ? 'Atualizações' : 'Updates',
    groups: [
      { title: isPt ? 'Atualizações do Plugin' : 'Plugin Updates', rows },
      { title: isPt ? 'Legados, Drift & Limpeza' : 'Legacy, Drift & Cleanup', rows: legacyRows },
    ],
  }
}
