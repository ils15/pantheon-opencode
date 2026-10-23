# Environment Variables

Only variables that change Pantheon behavior are listed. Test-only and internal
diagnostic variables are not user knobs. Values are read at process start unless
noted.

## Installer and generation

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_VERSION` | unset | `v1` or `v2` selects the plugin generation. Overridden by an explicit `--opencode-version` flag. |
| `OPENCODE_BIN` | `opencode` | Host binary used for the `--version` probe. A basename of `opencode2` selects V2 without probing. |
| `OPENCODE_V2_SPEC` | `@opencode/cli@latest` | Sandbox spec that provides the `opencode2` binary. |

Generation resolution and fallback are described once in
[Compatibility](../COMPATIBILITY.md#how-the-generation-is-selected).

## Sandbox runs

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_SANDBOX_ROOT` | `~/pantheon-sandbox` | Isolated sandbox root. Refused if unsafe for `--reset`. |
| `PANTHEON_SANDBOX_MODEL` | `opencode-go/mimo-v2.5` | Model used by `init` and the prompt battery. |
| `PANTHEON_PROMPT_TIMEOUT` | `300` | Per-prompt timeout in seconds. |

Sandbox mechanics are in [Release Process](../RELEASING.md).

## Paths and storage

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_HOME` | unset | Overrides the config root used for memory and the price cache. Resolution is `PANTHEON_HOME`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. |
| `XDG_CONFIG_HOME` | `~/.config` | Used when `PANTHEON_HOME` is unset. |
| `PANTHEON_PROJECT` | unset | Absolute project root for project-first resolution (code mode, persistence). A relative value is rejected where an absolute path is required. |
| `PANTHEON_HOOKS_LOG` | `<project>/.pantheon/logs/hooks.log` | Overrides the plugin hook log path. |

## Memory

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_MEMORY_MAX_ENTRY_BYTES` | `65536` | Per-entry serialized size cap for `memory_store`. Any positive integer; an invalid value falls back to 64 KiB. Read per write. |
| `PANTHEON_MEMORY_INJECTION_DEBUG` | unset | Set to `1` to append the raw error message to the injection skip log for local debugging. Off by default because it can copy memory text and prompt fragments into the log. |

Memory policy is in [Memory](../MEMORY.md).

## Cost

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_NODE` | `node` from `PATH` | Node >= 22.5 binary used only for the `node:sqlite` capability in the CLI fallback. Must exist and be executable. |
| `PANTHEON_COST_OFFLINE` | unset | Set to `1` to forbid every network request, including `refreshPricing: true`. No socket is opened. |
| `PANTHEON_COST_DB` | unset | Absolute path to the cost database, checked before `OPENCODE_DB`. |
| `OPENCODE_DB` | unset | Absolute path to the cost database, checked before the XDG default. |
| `PANTHEON_OPENCODE_VERSION` | unset | `v1` or `v2` narrows an already-detected schema to one table family. It does not select a file. |

Backend resolution and report dimensions are in
[MCP Tools](../mcp-tools.md#cost-backend-and-attribution).

## Vision

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_VISION_MODEL` | unset | Highest-precedence vision model pin. An explicit pin that does not qualify (non-Zen, text-only, or absent from the catalog) is discarded and automatic selection takes over. |
| `PANTHEON_OPENCODE_API_KEY` | unset | OpenCode Zen credential for native vision and the vision MCP. |
| `OPENCODE_API_KEY` | unset | Shared fallback credential for Zen endpoints. |
| `PANTHEON_VISION_TOOL` | unset | Opts into the Bifrost vision tool; Bifrost is never the default. |

Model precedence and the degradation chain are in [MCP](../MCP.md#pantheon-vision).

## Models

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_MODEL_PRESET` | unset | V1 legacy preset selector. V2 ignores static presets and applies only explicit per-agent project overrides. |

## Runtime-specific

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | unset | Experimental gate for some runtimes; set by Pantheon's `npm run start` launcher. It is not a universal prerequisite and does not create a missing tool. |

## What is not here

Local Promptfoo/evaluation experiments are development-only: place them under
`evals/promptfoo/`, which is gitignored and excluded from packaging, package
evidence, CI tests, coverage, and release gates. Publish reviewed findings as
documentation, not the harness, datasets, outputs, or credentials.
