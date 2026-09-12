/**
 * strings.mjs — installer strings with locale auto-detection.
 *
 * LANG/LC_ALL/LC_MESSAGES starting with "pt" selects the PT-BR table;
 * everything else (and the absence of a locale) selects EN. A plain string
 * table — deliberately no i18n framework (YAGNI).
 *
 * Scope: the user journey (banner → install steps → health → summary →
 * next steps). Deep diagnostics (per-file copy detail, doctor output) and
 * the model-picker wizard remain single-language by design.
 */

const TABLE = {
  en: {
    installing: 'Installing...',
    dryRun: 'DRY RUN',
    canceled: 'Installation canceled — nothing was broken; run init again anytime.',
    canceledShort: 'Installation canceled.',
    installFailed: (msg) => `❌ Installation failed: ${msg}`,
    failHintNoMcp:
      '   Run with --no-mcp to skip Python dependencies:\n     npx pantheon-opencode init --no-mcp',
    failHintForce:
      '   Or retry with --force to recreate the venv:\n     npx pantheon-opencode init --force',
    runningHealthCheck: 'Running health check...',
    installedTitle: (v) => `✅ Pantheon OpenCode v${v} installed!`,
    nextSteps: 'Next steps:',
    nextVerify: '1. Verify installation:\n     npx pantheon-opencode doctor',
    nextLaunch: '2. Launch OpenCode',
    nextAgents: '3. Invoke agents with @agent-name in chat',
    nextProject: '4. For project-local install:\n     npx pantheon-opencode init --project',
    // install steps
    globalLayout:
      'Global config directory detected — using flat layout (agents/, skills/, commands/)',
    installingAgents: 'Installing agents',
    installingSkills: 'Installing skills',
    installingInstructions: 'Installing instructions',
    installingPrompts: 'Installing prompts',
    installingCommands: 'Installing commands',
    installingPlugins: 'Installing plugins',
    settingUpRuntime: 'Setting up Python virtual environment',
    healthSection: 'Health Check',
    runningHealthChecks: 'Running health checks',
    runtimeFailed: (msg) => `Python runtime setup failed: ${msg}`,
    runtimeSkippedMcp:
      'MCP servers were NOT configured because the Python runtime is unavailable. ' +
      'Fix python3 (or free disk space) and re-run init to add them; everything else was installed.',
    prereqMissing:
      'runtime prerequisites missing — install the tools above, or re-run with --no-mcp to install without Python MCP servers',
    v2Migrating: 'Migrating config to V2 native format...',
    // summary (printSummary)
    summaryInstalled: (target) => `OpenCode installed in ${target}`,
    summaryWithErrors: (target) => `Installation finished WITH ERRORS in ${target}`,
    summaryComponents: (created, skipped) =>
      `  Components:\t${created} installed, ${skipped} skipped`,
    summaryErrors: (n) => `  ${n} error(s) found`,
    summaryWarnings: (n) => `  ${n} warning(s) — run 'doctor' for details`,
    summaryNext: '  Next steps:',
    summaryNextAgents: '   • Configure your agents in opencode.json',
    summaryNextMcp: '   • Add MCP servers in opencode.json (mcp section)',
    summaryNextDoctor: "   • Run 'opencode doctor' to verify the installation",
  },
  pt: {
    installing: 'Instalando...',
    dryRun: 'SIMULAÇÃO',
    canceled: 'Instalação cancelada — nada foi quebrado; rode init de novo quando quiser.',
    canceledShort: 'Instalação cancelada.',
    installFailed: (msg) => `❌ Instalação falhou: ${msg}`,
    failHintNoMcp:
      '   Rode com --no-mcp para pular dependências Python:\n     npx pantheon-opencode init --no-mcp',
    failHintForce:
      '   Ou tente de novo com --force para recriar a venv:\n     npx pantheon-opencode init --force',
    runningHealthCheck: 'Rodando verificação de saúde...',
    installedTitle: (v) => `✅ Pantheon OpenCode v${v} instalado!`,
    nextSteps: 'Próximos passos:',
    nextVerify: '1. Verifique a instalação:\n     npx pantheon-opencode doctor',
    nextLaunch: '2. Abra o OpenCode',
    nextAgents: '3. Invoc agentes com @nome-do-agente no chat',
    nextProject: '4. Para instalar no projeto:\n     npx pantheon-opencode init --project',
    // install steps
    globalLayout:
      'Diretório de config global detectado — layout plano (agents/, skills/, commands/)',
    installingAgents: 'Instalando agentes',
    installingSkills: 'Instalando skills',
    installingInstructions: 'Instalando instruções',
    installingPrompts: 'Instalando prompts',
    installingCommands: 'Instalando comandos',
    installingPlugins: 'Instalando plugins',
    settingUpRuntime: 'Configurando ambiente virtual Python',
    healthSection: 'Verificação de saúde',
    runningHealthChecks: 'Rodando verificações de saúde',
    runtimeFailed: (msg) => `Falha ao configurar o runtime Python: ${msg}`,
    runtimeSkippedMcp:
      'Os servidores MCP NÃO foram configurados porque o runtime Python está indisponível. ' +
      'Corrija o python3 (ou libere espaço em disco) e rode init de novo para adicioná-los; todo o resto foi instalado.',
    prereqMissing:
      'pré-requisitos do runtime ausentes — instale as ferramentas acima, ou rode de novo com --no-mcp para instalar sem os MCPs Python',
    v2Migrating: 'Migrando config para o formato nativo V2...',
    // summary (printSummary)
    summaryInstalled: (target) => `OpenCode instalado em ${target}`,
    summaryWithErrors: (target) => `Instalação concluída COM ERROS em ${target}`,
    summaryComponents: (created, skipped) =>
      `  Componentes:\t${created} instalados, ${skipped} pulados`,
    summaryErrors: (n) => `  ${n} erro(s) encontrados`,
    summaryWarnings: (n) => `  ${n} aviso(s) — rode 'doctor' para detalhes`,
    summaryNext: '  Próximos passos:',
    summaryNextAgents: '   • Configure seus agentes em opencode.json',
    summaryNextMcp: '   • Adicione MCP servers em opencode.json (seção mcp)',
    summaryNextDoctor: "   • Rode 'opencode doctor' para verificar a instalação",
  },
}

/** Pure locale resolution (exported for tests). */
export function detectLocale(env = process.env) {
  const raw = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? ''
  return /^pt/i.test(raw) ? 'pt' : 'en'
}

/** Pure table access (exported for tests and explicit-locale callers). */
export function stringsFor(locale) {
  return TABLE[locale] ?? TABLE.en
}

let cached = null

/** Locale-resolved string table for the current process. */
export function strings(env = process.env) {
  if (cached === null) cached = stringsFor(detectLocale(env))
  return cached
}
