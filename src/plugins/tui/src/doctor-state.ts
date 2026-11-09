/**
 * doctor-state.ts — the Doctor section of the settings window (read-only).
 *
 * TUI-local replica (the bundle must stay self-contained — the installed copy
 * physically lacks the repo tree, so doctor.mjs itself is unreachable). Only
 * the FILE-DERIVABLE checks are mirrored here; everything that spawns
 * processes, reads the network, or writes (MCP smoke, python validators, git,
 * venv pins, --fix quarantines) stays in the CLI and the section says so.
 *
 * The install-state path mirrors doctor's checkInstallVersionDrift
 * (`<config>/opencode/.pantheon/install-state.json`); the Node floor is
 * drift-pinned against scripts/node-engine-policy.mjs by
 * tests/tui-doctor-state.test.mjs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDecisionRouterConfig } from './decision-router-state.ts'
import type { OverridesLoad } from './pantheon-settings-state.ts'
import {
  SETTINGS_BEHAVIORS,
  type SettingsRow,
  type SettingsTab,
} from './pantheon-settings-state.ts'
import { comparePantheonVersions } from './update-notice.ts'

/** Drift-pinned against scripts/node-engine-policy.mjs MIN_SUPPORTED_NODE_VERSION. */
export const MIN_SUPPORTED_NODE_VERSION = '26.4.0'

export function opencodePantheonDir(env: Record<string, string | undefined> = process.env) {
  const xdg = env.XDG_CONFIG_HOME
  const home = env.HOME ?? ''
  const root = xdg ?? join(home, '.config')
  return join(root, 'opencode', '.pantheon')
}

export interface InstallVersionHealth {
  status: 'ok' | 'older' | 'newer' | 'unknown'
  installed: string | null
}

/**
 * H2: the installed package version (install-state) vs the running one.
 * Fail-open: a missing/unreadable state file means "unknown", not a failure —
 * pre-2.0 installs may not have one.
 */
export function classifyInstallVersion(
  runningVersion: string,
  env: Record<string, string | undefined> = process.env,
): InstallVersionHealth {
  let installed: string | null = null
  try {
    const path = join(opencodePantheonDir(env), 'install-state.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { pantheon_version?: unknown }
    if (typeof raw?.pantheon_version === 'string' && raw.pantheon_version !== '') {
      installed = raw.pantheon_version
    }
  } catch {
    installed = null
  }
  if (installed === null) return { status: 'unknown', installed: null }
  const compared = comparePantheonVersions(installed, runningVersion)
  if (compared === 0) return { status: 'ok', installed }
  return { status: compared < 0 ? 'older' : 'newer', installed }
}

export function isSupportedNodeFloor(version: string): boolean {
  // Same shape as the canonical parser: a prerelease is outside the floor.
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+([\w.-]+))?$/.exec(String(version))
  const minimum = /^v?(\d+)\.(\d+)\.(\d+)/.exec(MIN_SUPPORTED_NODE_VERSION)
  if (!match || !minimum) return false
  const [, major = '', minor = '', patch = '', prerelease = ''] = match
  if (prerelease !== '') return false
  const [, minMajor = '0', minMinor = '0', minPatch = '0'] = minimum
  const currentParts = [+major, +minor, +patch]
  const minimumParts = [+minMajor, +minMinor, +minPatch]
  for (let index = 0; index < 3; index += 1) {
    const currentPart = currentParts[index] ?? 0
    const minimumPart = minimumParts[index] ?? 0
    if (currentPart !== minimumPart) return currentPart > minimumPart
  }
  return true
}

export interface OverridesHealth {
  status: 'clean' | 'unknown-ids' | 'corrupt'
  unknownIds: string[]
}

/** K: validate both overrides files against the window's registry. */
export function classifyOverridesHealth(load: OverridesLoad): OverridesHealth {
  if (load.corruptGlobal) return { status: 'corrupt', unknownIds: [] }
  const known = new Set(SETTINGS_BEHAVIORS.map((behavior) => behavior.id))
  const unknownIds = Object.keys({ ...load.global, ...load.project }).filter((id) => !known.has(id))
  return { status: unknownIds.length > 0 ? 'unknown-ids' : 'clean', unknownIds }
}

export interface DecisionConfigHealth {
  status: 'ok' | 'corrupt' | 'absent'
}

export function classifyDecisionConfigHealth(
  env: Record<string, string | undefined> = process.env,
): DecisionConfigHealth {
  if (
    !existsSync(
      join(
        env.XDG_CONFIG_HOME ?? join(env.HOME ?? '', '.config'),
        'pantheon',
        'decision-router.json',
      ),
    )
  ) {
    return { status: 'absent' }
  }
  return readDecisionRouterConfig(env).corrupt ? { status: 'corrupt' } : { status: 'ok' }
}

export interface DoctorSectionInput {
  runningVersion: string
  nodeVersion: string
  load: OverridesLoad
  env?: Record<string, string | undefined>
}

export function buildDoctorTab(input: DoctorSectionInput): SettingsTab {
  const env = input.env ?? process.env
  const rows: SettingsRow[] = []

  const version = classifyInstallVersion(input.runningVersion, env)
  rows.push({
    id: 'doctor.version',
    name: 'Install version',
    value:
      version.status === 'ok'
        ? `v${version.installed} — matches`
        : version.status === 'older'
          ? `v${version.installed} older`
          : version.status === 'newer'
            ? `v${version.installed} newer`
            : 'unknown',
    note:
      version.status === 'older'
        ? 'refresh with `pantheon-opencode update`'
        : 'read from <config>/opencode/.pantheon/install-state.json',
  })

  const nodeOk = isSupportedNodeFloor(input.nodeVersion)
  rows.push({
    id: 'doctor.node',
    name: 'Node runtime',
    value: input.nodeVersion.replace(/^v/, ''),
    note: nodeOk
      ? `meets the >= ${MIN_SUPPORTED_NODE_VERSION} floor`
      : `below the >= ${MIN_SUPPORTED_NODE_VERSION} floor — tooling may refuse`,
  })

  const overrides = classifyOverridesHealth(input.load)
  rows.push({
    id: 'doctor.overrides',
    name: 'Overrides',
    value:
      overrides.status === 'clean'
        ? 'valid'
        : overrides.status === 'corrupt'
          ? 'unreadable'
          : `${overrides.unknownIds.length} unknown id(s)`,
    note:
      overrides.status === 'unknown-ids'
        ? `${overrides.unknownIds.join(', ')} — harmless; repair with doctor --fix`
        : overrides.status === 'corrupt'
          ? 'writes are refused until repaired (doctor --fix)'
          : 'both files parse against the behavior registry',
  })

  const decision = classifyDecisionConfigHealth(env)
  rows.push({
    id: 'doctor.decision',
    name: 'Decision config',
    value:
      decision.status === 'ok' ? 'valid' : decision.status === 'corrupt' ? 'corrupt' : 'absent',
    note:
      decision.status === 'corrupt'
        ? 'runtime fail-closes to disabled · read from <config>/pantheon/decision-router.json'
        : 'read from <config>/pantheon/decision-router.json',
  })

  return {
    id: 'doctor',
    title: 'Doctor',
    groups: [
      {
        title: 'Health (file-derived)',
        rows,
      },
      {
        rows: [
          {
            id: 'doctor.cli',
            name: 'Full check',
            value: '`pantheon-opencode doctor`',
            note: 'MCP smoke, venv pins, git stay in the CLI',
          },
        ],
      },
    ],
  }
}
