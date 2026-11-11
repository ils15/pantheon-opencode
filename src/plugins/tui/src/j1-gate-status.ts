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
import { resolveLanguage } from './settings-i18n.ts'

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

const MODE_DESCRIPTION_EN: Record<J1Mode, string> = {
  off: 'nothing fires (hard zero)',
  shadow: 'observe + record; invisible in the session',
  warn: 'RESERVED — behaves as shadow in this release',
  enforce: 'high-risk scores DENY the tool call (fail-open on gate unavailability)',
}

const MODE_DESCRIPTION_PT: Record<J1Mode, string> = {
  off: 'desativado (hard zero)',
  shadow: 'observa + registra telemetria (modo silencioso)',
  warn: 'RESERVADO (RESERVED) — comporta-se como shadow nesta versão',
  enforce: 'alto risco bloqueia a ferramenta (fail-open se indisponível)',
}

export function buildJ1Tab(
  env: Record<string, string | undefined>,
  disabledByOverride: boolean,
  languagePref?: string | undefined,
): SettingsTab {
  const lang = resolveLanguage(languagePref)
  const isPt = lang === 'pt-BR'
  const mode = j1ModeFromEnv(env)
  const threshold = j1ThresholdFromEnv(env)
  const gateState = disabledByOverride
    ? 'disabled via overrides'
    : mode === 'off'
      ? 'off (env unset)'
      : 'active'
  const desc = isPt ? MODE_DESCRIPTION_PT[mode] : MODE_DESCRIPTION_EN[mode]

  return {
    id: 'j1',
    title: isPt ? 'Segurança J1' : 'J1',
    groups: [
      {
        title: isPt
          ? 'Nível de Segurança e Portão de Risco J1 (env-only)'
          : 'Safety Level & Risk Gate (J1) (env-only — never written here)',
        rows: [
          {
            id: 'j1.mode',
            name: isPt ? 'Modo de execução' : 'Mode',
            value: mode,
            note: `${desc} · ${isPt ? 'reinício necessário (restart applies)' : 'restart applies'}`,
          },
          {
            id: 'j1.threshold',
            name: isPt ? 'Limiar de bloqueio' : 'Enforce threshold',
            value: String(threshold),
            note: isPt
              ? 'bloqueia em ou acima · 0..1 · padrão 0.8'
              : 'deny at or above · 0..1 · default 0.8',
          },
          {
            id: 'j1.gate',
            name: isPt ? 'Estado do portão' : 'Gate',
            value: gateState,
            note: `${J1_FLAG_ENV} / ${J1_THRESHOLD_ENV} · ${isPt ? 'lido na inicialização' : 'read once at startup'}`,
          },
        ],
      },
    ],
  }
}
