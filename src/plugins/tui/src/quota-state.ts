/**
 * quota-state.ts — the Quotas & Spend tab (inspired by opencode-quota).
 *
 * Exposes live model token spending, daily budgets, rate-limits per provider,
 * and context token telemetry in a dedicated tab in the Pantheon Settings window.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SettingsTab } from './pantheon-settings-state.ts'
import { resolveLanguage } from './settings-i18n.ts'

export interface QuotaSnapshot {
  todaySpend?: string
  monthSpend?: string
  sessionSpend?: string
  sessionTokens?: string
  cacheHit?: string
  speed?: string
}

export interface QuotaPrefs {
  sessionCap: string
  alertThreshold: 'enabled' | 'disabled'
  autoCompact: 'enabled' | 'disabled'
}

export const DEFAULT_QUOTA_PREFS: QuotaPrefs = {
  sessionCap: '$5.00',
  alertThreshold: 'enabled',
  autoCompact: 'enabled',
}

export function resolveQuotaPrefsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg?.startsWith('/') ? xdg : join(homedir(), '.config')
  return join(base, 'opencode', 'pantheon-quota.json')
}

export function readQuotaPrefs(filePath = resolveQuotaPrefsPath()): QuotaPrefs {
  try {
    if (!existsSync(filePath)) return { ...DEFAULT_QUOTA_PREFS }
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<QuotaPrefs>
    return {
      sessionCap:
        typeof raw.sessionCap === 'string' &&
        ['$1.00', '$2.00', '$5.00', '$10.00', 'unlimited'].includes(raw.sessionCap)
          ? raw.sessionCap
          : DEFAULT_QUOTA_PREFS.sessionCap,
      alertThreshold: raw.alertThreshold === 'disabled' ? 'disabled' : 'enabled',
      autoCompact: raw.autoCompact === 'disabled' ? 'disabled' : 'enabled',
    }
  } catch {
    return { ...DEFAULT_QUOTA_PREFS }
  }
}

export function writeQuotaPrefs(prefs: QuotaPrefs, filePath = resolveQuotaPrefsPath()): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
}

export function applyQuotaRow(prefs: QuotaPrefs, id: string, value: string): QuotaPrefs {
  const next = { ...prefs }
  if (id === 'quota.budget.sessionCap') {
    if (['$1.00', '$2.00', '$5.00', '$10.00', 'unlimited'].includes(value)) {
      next.sessionCap = value
    }
  } else if (id === 'quota.budget.alertThreshold') {
    next.alertThreshold = value === 'disabled' ? 'disabled' : 'enabled'
  } else if (id === 'quota.compaction.auto') {
    next.autoCompact = value === 'disabled' ? 'disabled' : 'enabled'
  }
  return next
}

export function buildQuotaTab(
  snapshot?: QuotaSnapshot,
  languagePref?: string,
  prefs: QuotaPrefs = readQuotaPrefs(),
): SettingsTab {
  const isPt = resolveLanguage(languagePref) === 'pt-BR'

  return {
    id: 'quota',
    title: isPt ? 'Cotas & Gastos' : 'Quotas & Spend',
    groups: [
      {
        title: isPt ? 'Consumo & Gastos de Sessão' : 'Session Spend & Tokens',
        rows: [
          {
            id: 'quota.spend.today',
            name: isPt ? 'Gasto hoje (00h-agora)' : 'Spend today (00h-now)',
            value: snapshot?.todaySpend ?? '—',
            note: isPt ? 'Calculado a partir de opencode.db' : 'Derived from opencode.db ledger',
          },
          {
            id: 'quota.spend.month',
            name: isPt ? 'Gasto acumulado (30d)' : 'Spend last 30 days',
            value: snapshot?.monthSpend ?? '—',
            note: isPt ? 'Janela móvel de 30 dias' : 'Rolling 30-day window',
          },
          {
            id: 'quota.spend.session',
            name: isPt ? 'Gasto na sessão ativa' : 'Active session spend',
            value: snapshot?.sessionSpend ?? '—',
            note: isPt ? 'Custo de todas as mensagens do turno' : 'Sum of turn assistant messages',
          },
          {
            id: 'quota.tokens.context',
            name: isPt ? 'Tokens de contexto' : 'Context tokens',
            value: snapshot?.sessionTokens ?? '—',
            note: isPt
              ? 'Tokens consumidos vs janela do modelo'
              : 'Tokens used vs model context limit',
          },
          {
            id: 'quota.tokens.cache',
            name: isPt ? 'Eficiência de cache' : 'Prompt cache hit',
            value: snapshot?.cacheHit ?? '—',
            note: isPt ? 'Desconto de leitura em cache aplicado' : 'Cache read discount applied',
          },
        ],
      },
      {
        title: isPt ? 'Limites & Teto de Orçamento' : 'Rate Limits & Budget Caps',
        rows: [
          {
            id: 'quota.budget.sessionCap',
            name: isPt ? 'Teto por sessão' : 'Session budget cap',
            value: prefs.sessionCap,
            cycle: ['$1.00', '$2.00', '$5.00', '$10.00', 'unlimited'],
            note: isPt
              ? 'Avisa ou pausa ao atingir o teto'
              : 'Warns or pauses when session spend reaches cap',
          },
          {
            id: 'quota.budget.alertThreshold',
            name: isPt ? 'Alerta em 80% do teto' : 'Alert at 80% of cap',
            value: prefs.alertThreshold,
            cycle: ['enabled', 'disabled'],
            note: isPt
              ? 'Emite aviso visual no footer da TUI'
              : 'Shows visual notice in TUI footer',
          },
          {
            id: 'quota.compaction.auto',
            name: isPt ? 'Auto-compactar em 80% do contexto' : 'Auto-compact at 80% context',
            value: prefs.autoCompact,
            cycle: ['enabled', 'disabled'],
            note: isPt
              ? 'Aciona compressão automática de histórico'
              : 'Triggers automatic context compaction',
          },
        ],
      },
      {
        title: isPt
          ? 'Provedores & Janelas de Cota (Referência)'
          : 'Providers & Quota Windows (Reference)',
        rows: [
          {
            id: 'quota.ref.anthropic',
            name: 'Anthropic (Claude 3.7)',
            value: 'Tier 4',
            note: isPt
              ? '400k TPM · Reset diário às 00:00 UTC'
              : '400k TPM · Daily reset at 00:00 UTC',
          },
          {
            id: 'quota.ref.openai',
            name: 'OpenAI (GPT-4o)',
            value: 'Tier 4',
            note: isPt
              ? '800k TPM · Reset por janela móvel de 1 min'
              : '800k TPM · 1-minute rolling window',
          },
          {
            id: 'quota.ref.google',
            name: 'Google (Gemini 2.5)',
            value: 'Pay-as-you-go',
            note: isPt
              ? '4M TPM · Alta capacidade com cota flexível'
              : '4M TPM · High capacity with flexible quota',
          },
        ],
      },
    ],
  }
}
