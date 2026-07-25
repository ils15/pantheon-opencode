module.exports = {
  "extends": [
    "@commitlint/config-conventional"
  ],
  "ignores": [
    null
  ],
  "rules": {
    "scope-enum": [
      2,
      "always",
      [
        "agents",
        "skills",
        "sync",
        "platform",
        "scripts",
        "docs",
        "ci",
        "deps",
        "release",
        "config",
        "validate",
        "commands",
        "config",
        "tui",
        "installer",
        "routing",
        "instructions",
        "mcp"
      ]
    ]
  }
};
