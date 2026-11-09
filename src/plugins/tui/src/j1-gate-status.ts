/**
 * j1-gate-status.ts — the J1 Risk Gate section of the settings window.
 *
 * TUI-local replica of the ladder in src/pantheon/jev-risk-gate.ts (the
 * bundle must stay self-contained); tests/tui-settings-j1.test.mjs pins the
 * env names, the ladder values and the default threshold against that source.
 *
 * STATUS ONLY by design: the ladder has no file surface yet — mode and
 * threshold are env-only and read once at plugin setup — so nothing here
 * writes, and the section says so. A file surface is a runtime-plugin change
 * (beta.3 candidate), not a window change.
 */
import type { SettingsTab } from './pantheon-settings-state.ts'

export const J1_FLAG_ENV = 'PANTHEON_J1_RISK_SCORE'
export const J1_THRESHOLD_ENV = 'PANTHEON_J1_ENFORCE_THRESHOLD'
export const J1_THRESHOLD_DEFAULT = 0.8

export type J1Mode = 'off' | 'shadow' | 'warn' | 'enforce'

/** `1`/`on`/`true` map to `shadow` for back-compatibility with the shipped setup. */
const FLAG_ON = new Set(['1', 'on', 'true', 'shadow'])

export function j1ModeFromEnv(env: Record<string, string | undefined> = process.env): J1Mode {
  const raw = (env[J1_FLAG_ENV] ?? '').trim().toLowerCase()
  if (raw === 'enforce') return 'enforce'
  if (raw === 'warn') return 'warn'
  return FLAG_ON.has(raw) ? 'shadow' : 'off'
}

/** Invalid or out-of-range values fall back to the default — a typo must not disable the gate. */
export function j1ThresholdFromEnv(env: Record<string, string | undefined> = process.env): number {
  const text = (env[J1_THRESHOLD_ENV] ?? '').trim()
  if (text === '') return J1_THRESHOLD_DEFAULT
  const raw = Number(text)
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return J1_THRESHOLD_DEFAULT
  return raw
}

const MODE_DESCRIPTION: Record<J1Mode, string> = {
  off: 'nothing fires (hard zero)',
  shadow: 'observe + record; invisible in the session',
  warn: 'RESERVED — behaves as shadow in this release',
  enforce: 'high-risk scores DENY the tool call (fail-open on gate unavailability)',
}

export function buildJ1Tab(
  env: Record<string, string | undefined>,
  disabledByOverride: boolean,
): SettingsTab {
  const mode = j1ModeFromEnv(env)
  const threshold = j1ThresholdFromEnv(env)
  const gateState = disabledByOverride
    ? 'disabled via overrides'
    : mode === 'off'
      ? 'off (env unset)'
      : 'active'
  return {
    id: 'j1',
    title: 'J1',
    groups: [
      {
        title: 'Ladder (env-only — never written here)',
        rows: [
          {
            id: 'j1.mode',
            name: 'Mode',
            value: mode,
            note: `${MODE_DESCRIPTION[mode]} · restart applies`,
          },
          {
            id: 'j1.threshold',
            name: 'Enforce threshold',
            value: String(threshold),
            note: 'deny at or above · 0..1 · default 0.8',
          },
          {
            id: 'j1.gate',
            name: 'Gate',
            value: gateState,
            note: `${J1_FLAG_ENV} / ${J1_THRESHOLD_ENV} · read once at startup`,
          },
        ],
      },
    ],
  }
}
