/**
 * settings-i18n.ts — Bilingual (PT-BR / EN) internationalization for TUI settings.
 *
 * Provides localized titles, labels, and explanations for:
 * - Decision Router & Jev model selection
 * - Autonomy & Budgets
 * - Safety & J1 Risk Gate
 *
 * Automatically detects environment locale (LANG / LC_ALL) while allowing
 * manual override in TUI preferences.
 */

export type SettingsLanguage = 'auto' | 'pt-BR' | 'en'

export const SETTINGS_LANGUAGES_CYCLE: readonly string[] = Object.freeze(['auto', 'pt-BR', 'en'])
export const SUPPORTED_LANGUAGES = SETTINGS_LANGUAGES_CYCLE

/**
 * Resolve effective language: 'pt-BR' or 'en'.
 * Defaults to 'pt-BR' if system locale contains 'pt', if Intl locale is pt,
 * or if system timezone is Brazilian/Portuguese; otherwise 'en'.
 */
export function resolveLanguage(
  preference: string = 'auto',
  env: Record<string, string | undefined> = process.env,
): 'pt-BR' | 'en' {
  if (preference === 'pt-BR') return 'pt-BR'
  if (preference === 'en') return 'en'

  // 1. Auto-detection based on environment locale variables
  const lang = (env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? env.LANGUAGE ?? '').toLowerCase()
  if (lang.startsWith('pt')) return 'pt-BR'

  // 2. Auto-detection based on Intl locale
  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase()
    if (intlLocale.startsWith('pt')) return 'pt-BR'
  } catch {}

  // 3. Auto-detection based on timezone (Brazil & Portugal)
  try {
    const tz = (env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? '').toLowerCase()
    if (
      tz.includes('sao_paulo') ||
      tz.includes('brazil') ||
      tz.includes('fortaleza') ||
      tz.includes('recife') ||
      tz.includes('manaus') ||
      tz.includes('belem') ||
      tz.includes('cuiaba') ||
      tz.includes('campo_grande') ||
      tz.includes('porto_velho') ||
      tz.includes('rio_branco') ||
      tz.includes('boa_vista') ||
      tz.includes('maceio') ||
      tz.includes('bahia') ||
      tz.includes('noronha') ||
      tz.includes('araguaina') ||
      tz.includes('santarem') ||
      tz.includes('lisbon') ||
      tz.includes('madeira') ||
      tz.includes('azores')
    ) {
      return 'pt-BR'
    }
  } catch {}

  return 'en'
}

export interface I18nStringPair {
  en: string
  pt: string
}

export const I18N = {
  tabs: {
    decision: { en: 'Decision (Jev)', pt: 'Decisão (Jev)' },
    autonomy: { en: 'Autonomy', pt: 'Autonomia' },
    safety: { en: 'Safety (J1)', pt: 'Segurança (J1)' },
    tui: { en: 'TUI', pt: 'TUI' },
  },
  decision: {
    groupRouter: {
      en: 'Decision Router (Jev Assistant)',
      pt: 'Assistente de Decisão (Jev)',
    },
    groupCredentials: {
      en: 'Credentials (status only — values never enter the window)',
      pt: 'Credenciais (apenas status — valores protegidos)',
    },
    routerName: {
      en: 'Router (Decision Assistant)',
      pt: 'Assistente Jev',
    },
    routerNote: {
      en: 'applies live — enables intelligent route arbitration and candidate ranking',
      pt: 'aplica em tempo real — motor de arbitragem inteligente e ranking de rotas',
    },
    modelName: {
      en: 'Decision model',
      pt: 'Modelo de Decisão',
    },
    modelNote: {
      en: 'local routes on-device (free); auto/explicit pick a remote decision model',
      pt: 'local decide no seu PC (grátis); auto/explícito usa modelo nuvem (OpenRouter)',
    },
    selectionModeName: {
      en: 'Selection mode',
      pt: 'Modo de operação',
    },
    selectionModeNote: {
      en: 'local routes on-device; auto/explicit pick a remote decision model',
      pt: 'local decide no dispositivo; auto/explícito usa modelo remoto',
    },
    egressName: {
      en: 'Cloud API access (Egress)',
      pt: 'Acesso à Nuvem (Egress)',
    },
    egressNoteGranted: {
      en: 'granted = remote decision routes may call their gateway (budget-capped)',
      pt: 'permitido = rotas remotas podem consultar a API (com limite de orçamento)',
    },
    egressNoteNotGranted: {
      en: 'not granted = remote routes blocked; local heuristic decisions only',
      pt: 'não permitido = chamadas remotas bloqueadas; apenas heurística local',
    },
    candidatesName: {
      en: 'Active candidates',
      pt: 'Candidatos ativos',
    },
  },
  autonomy: {
    groupGoalLoop: {
      en: 'Goal loop (multi-turn session auto-continuation)',
      pt: 'Execução Contínua (Goal Loop)',
    },
    goalLoopName: {
      en: 'Goal loop',
      pt: 'Loop contínuo',
    },
    goalLoopNote: {
      en: 'auto-continues multi-turn tasks when session goes idle · applies after OpenCode restart',
      pt: 'continua tarefas de múltiplos passos automaticamente · requer reinício',
    },
    maxContinuationsName: {
      en: 'Max continuations',
      pt: 'Limite de turnos',
    },
    maxContinuationsNote: {
      en: '1..200 — safety ceiling to prevent runaway tasks',
      pt: '1..200 — teto de segurança contra tarefas infinitas',
    },
    cooldownName: {
      en: 'Cooldown (ms)',
      pt: 'Intervalo (ms)',
    },
    cooldownNote: {
      en: 'delay between autonomous turns (min 1000ms)',
      pt: 'tempo de espera entre turnos autônomos (mín 1000ms)',
    },
    groupBudgets: {
      en: 'Decision budgets (applies live per gated call)',
      pt: 'Orçamento Jev (teto financeiro de proteção)',
    },
    monthlyCapName: {
      en: 'Monthly cap',
      pt: 'Teto mensal (USD)',
    },
    monthlyCapNote: {
      en: 'monthly USD ceiling for gated arbitrator decisions',
      pt: 'teto mensal em dólares para decisões do assistente Jev',
    },
    perDecisionCapName: {
      en: 'Per-decision cap',
      pt: 'Teto por consulta (USD)',
    },
    perDecisionCapNote: {
      en: 'price cap — gated decisions above this are refused',
      pt: 'teto por decisão — consultas remotas que excederem são recusadas',
    },
    groupGradient: {
      en: 'Decision gradient (reference policy · J1 owns the risk axis)',
      pt: 'Níveis de Decisão & Segurança (Referência)',
    },
    soloName: {
      en: 'Decide solo',
      pt: 'Decisão direta',
    },
    soloNote: {
      en: 'reversible & low-risk edits, routine fixes (no gate)',
      pt: 'edições reversíveis e baixo risco, sem portão de bloqueio',
    },
    jevName: {
      en: 'Jev decides',
      pt: 'Decisão Jev',
    },
    jevNote: {
      en: 'typed ambiguity & candidate ranking (budget-capped)',
      pt: 'ambiguidade e ranking de skills com teto de orçamento',
    },
    humanName: {
      en: 'Human decides',
      pt: 'Aprovação humana',
    },
    humanNote: {
      en: 'high-risk & destructive operations (J1 gate)',
      pt: 'ações de alto risco e destrutivas (portão de segurança J1)',
    },
  },
  safety: {
    groupSafety: {
      en: 'Safety & Risk Level (J1 Gate)',
      pt: 'Nível de Proteção & Portão de Risco (J1)',
    },
    modeName: {
      en: 'Protection mode',
      pt: 'Modo de proteção',
    },
    thresholdName: {
      en: 'Enforce threshold',
      pt: 'Teto para bloqueio',
    },
    thresholdNote: {
      en: 'deny at or above · 0..1 · default 0.8',
      pt: 'bloqueia em ou acima de · 0..1 · padrão 0.8',
    },
    gateName: {
      en: 'Safety gate',
      pt: 'Portão de segurança',
    },
  },
} as const

/** Helper to get localized text */
export function t(entry: I18nStringPair, lang: 'pt-BR' | 'en'): string {
  return lang === 'pt-BR' ? entry.pt : entry.en
}
