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
  type SettingsSection,
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

export function buildDoctorSection(input: DoctorSectionInput): SettingsSection {
  const env = input.env ?? process.env
  const rows: SettingsRow[] = []

  const version = classifyInstallVersion(input.runningVersion, env)
  rows.push({
    id: 'doctor.version',
    title:
      version.status === 'ok'
        ? `Installed version: v${version.installed} — matches`
        : version.status === 'older'
          ? `Installed v${version.installed} is older than the runtime v${input.runningVersion}`
          : version.status === 'newer'
            ? `Installed v${version.installed} is newer than the runtime v${input.runningVersion}`
            : 'Installed version: unknown (no install-state)',
    description:
      version.status === 'older'
        ? 'refresh with `pantheon-opencode update`'
        : 'read from <config>/opencode/.pantheon/install-state.json',
    marker: version.status === 'ok' ? '[✓]' : version.status === 'older' ? '[!]' : '[i]',
    selectable: false,
  })

  const nodeOk = isSupportedNodeFloor(input.nodeVersion)
  rows.push({
    id: 'doctor.node',
    title: `Node runtime: ${input.nodeVersion.replace(/^v/, '')}`,
    description: nodeOk
      ? `meets the >= ${MIN_SUPPORTED_NODE_VERSION} floor`
      : `below the >= ${MIN_SUPPORTED_NODE_VERSION} floor — tooling may refuse`,
    marker: nodeOk ? '[✓]' : '[!]',
    selectable: false,
  })

  const overrides = classifyOverridesHealth(input.load)
  rows.push({
    id: 'doctor.overrides',
    title:
      overrides.status === 'clean'
        ? 'Overrides: valid'
        : overrides.status === 'corrupt'
          ? 'Overrides: global file unreadable'
          : `Overrides: ${overrides.unknownIds.length} unknown id(s)`,
    description:
      overrides.status === 'unknown-ids'
        ? `${overrides.unknownIds.join(', ')} — harmless; repair with doctor --fix`
        : overrides.status === 'corrupt'
          ? 'writes are refused until repaired (doctor --fix)'
          : 'both files parse against the behavior registry',
    marker: overrides.status === 'clean' ? '[✓]' : overrides.status === 'corrupt' ? '[✗]' : '[!]',
    selectable: false,
  })

  const decision = classifyDecisionConfigHealth(env)
  rows.push({
    id: 'doctor.decision',
    title:
      decision.status === 'ok'
        ? 'Decision config: valid'
        : decision.status === 'corrupt'
          ? 'Decision config: unreadable — runtime fail-closes'
          : 'Decision config: absent (local defaults)',
    description: 'read from <config>/pantheon/decision-router.json',
    marker: decision.status === 'corrupt' ? '[✗]' : '[✓]',
    selectable: false,
  })

  return {
    id: 'doctor',
    title: 'Doctor',
    rows,
    hint: 'file checks only — the full doctor (MCP smoke, venv, git) is `pantheon-opencode doctor`',
  }
}
