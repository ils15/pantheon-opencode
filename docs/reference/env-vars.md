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
| `XDG_STATE_HOME` | `~/.local/state` | User state root for the separate local decision-budget SQLite ledger. |
| `PANTHEON_PROJECT` | unset | Absolute project root for project-first resolution (code mode, persistence). A relative value is rejected where an absolute path is required. |
| `PANTHEON_HOOKS_LOG` | `<project>/.pantheon/logs/hooks.log` | Overrides the plugin hook log path. |

## Memory

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_MEMORY_MAX_ENTRY_BYTES` | `65536` | Per-entry serialized size cap for `memory_store`. Any positive integer; an invalid value falls back to 64 KiB. Read per write. |

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

## Local decision recommendation

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_LOCAL_DECISION_ROUTER` | unset (disabled) | Set to `1` to enable only the standalone local advisory API. It does not enable provider transport, host dispatch, or permissions. |

The API contract and its abstention behavior are in
[Local Decision Router](local-decision-router.md).

## V2 decision layer

Both flags are read once when the plugin registers, so changing either needs a
host restart. Neither is set in a default install; anything other than the listed
truthy values leaves the feature off.

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_V2_P7_LOOP` | unset (off) | `1`, `on` or `true` enables the P7 loop adapter on `session.execution.succeeded`. It counts executions and writes `effect: none` observations to an in-memory, bounded collector that the plugin never reads back (it is exposed only to tests); it does not enforce loop limits. The 12-execution cap (`P7_LOOP_MAX_EXECUTIONS`) is advisory: no measured host surface signals a new user turn, so the streak is not claimed to reset. |
| `PANTHEON_V2_P8_GUARDRAIL` | unset (off) | `1`, `on` or `true` enables the P8 guardrail on `permission.evaluate` only. It can only narrow, and it is not a no-op: a native event with no usable `action` token, and an `allow` decision with no attributed `sessionID`, are narrowed to `deny`. `execute.before` remains the only hard barrier; activation is blocked pending PH5-1…PH5-5. |

Shadow points (P1, P2, P3) have no environment switch: there is no
behaviour to switch. P1 and P2 are registered on `session.hook('prompt')` and
observe a projection of the admission payload carrying only `prompt.agents` and
`prompt.skills` — no text, no file bytes, no metadata. P3 is registered at its
declared `tool.invoke`: the `pantheon_local_decision` tool hands the adapter its
own input, which carries `complexity` and `gateStatus`, so it records a
classification when the tool is invoked. Each record says `effect: none` and goes
to an in-memory, bounded collector that the plugin never reads back (exposed only
to tests). They cannot deny, delay or mutate admission; P2 stays advisory and
never filters.

The remaining six — P4, P5, P6, P9, P10 and P11 — have **no production call
site**: no production file imports them. Their adapters are constructed only by
their per-point test suites (`v2-decision-p4.test.ts` … `v2-decision-p11.test.ts`).
P6 and P10 declared the prompt hook, but that payload carries neither council
candidates nor counsellor claims, so they are unwired rather than recording a
refusal from a surface that cannot feed them. On a host they do not read the
turn, record no telemetry and change nothing — not because they are disabled, but
because nothing constructs them. Coverage and unmeasured surfaces are in
[Local Decision Router](local-decision-router.md#measured-coverage-and-unmeasured-surfaces-v2-decision-layer).

## Decision-provider transport

Provider calls are disabled unless the user-level decision-router config is
explicitly enabled and every local gate passes. See
[Local Decision Router](local-decision-router.md).

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | unset | Credential read only after enablement, consent, a cap-valid OpenAI Decisions candidate, a confirmed period, and the host permission gate. Never used by the local selector. |
| `TYPESAFE_API_KEY` | unset | Same gate for TypeSafe direct Jev (`jev-1.14.0`). |
| `OPENCODE_API_KEY` | unset | Not read by the decision router for OpenCode Console/Free; those providers are ineligible for egress. It remains in use by other documented OpenCode integrations. |

There is no configurable base URL, retry, failover, or fan-out switch. The fixed
endpoints, one-call-per-turn cache, and 12,000-character request cap live in the
private adapter. Console/Free and Bifrost are never eligible. Caps have no
defaults, and a denied host permission means zero requests.

## Runtime-specific

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | unset | Experimental gate for some runtimes; set by Pantheon's `npm run start` launcher. It is not a universal prerequisite and does not create a missing tool. |

## What is not here

Local Promptfoo/evaluation experiments are development-only: place them under
`evals/promptfoo/`, which is gitignored and excluded from packaging, package
evidence, CI tests, coverage, and release gates. Publish reviewed findings as
documentation, not the harness, datasets, outputs, or credentials.
