module.exports = {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message) => message.startsWith('Changes before error encountered'),
    (message) => message.startsWith('Potential fix for pull request finding'),
  ],
  rules: {
    'body-max-line-length': [0],
    'scope-enum': [2, 'always', [
      'agents', 'skills', 'scripts', 'docs', 'ci', 'deps', 'release',
      'config', 'validate', 'commands', 'tui', 'installer', 'routing',
      'instructions', 'mcp', 'beta',
      'zeus', 'athena', 'apollo', 'hermes', 'aphrodite', 'demeter',
      'themis', 'prometheus', 'hephaestus', 'nyx', 'gaia', 'iris',
      'mnemosyne', 'talos', 'persistence', 'memory', 'council',
      'deepwork', 'audit', 'optimize', 'consolidate', 'merge',
      'model', 'auth', 'compaction', 'checkpoint',
    ]],
    'header-max-length': [2, 'always', 120],
  },
};
