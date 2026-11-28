# Platforms

Pantheon runs **only** on [OpenCode](https://opencode.ai). Multi-platform
adapters were removed in v1.0; Claude Code, Cursor, Windsurf, Cline,
Continue.dev, and VS Code Copilot are not supported. This page is an overview
and links out. It does not restate the support matrix — that is
[Compatibility](COMPATIBILITY.md).

## Form factors

OpenCode ships as a terminal TUI (`opencode`), a desktop app, and an IDE
extension. All three share the same `opencode.json` (`plugins: ["pantheon-opencode"]`):

- **CLI (TUI) & Desktop App (Shared backend `./server`):** all 8 canonical agents, 26
  skills, 9 slash commands, 31 native TypeScript tools, security/edit guardrails,
  worktree shared `.pantheon/` stores, and GFM/Mermaid artifacts work in both.
- **CLI-only (`./tui`):** the `@opentui/solid` sidebar (`Context`, `Todo`,
  `Dispatch`), `/dispatch`, `/pantheon-settings`, `/pantheon-updates`, and
  `/pantheon-whats-new` run in the terminal TUI only; Desktop uses its own native
  GUI chrome (and renders Markdown/GFM artifacts inline).
- **Windows:** WSL2 (Linux) is the fully supported environment today; native
  `win32` outside WSL2 currently rejects POSIX `getuid`/`0o077` config guards in
  `pantheon_model` / `pantheon_local_decision` and assumes `/bin/bash` in `shell`.

## Install

Use OpenCode's native plugin manager (recommended — zero copied files on disk,
works in any directory) or the optional CLI installer:

```bash
# Recommended (global or project, works anywhere without init)
opencode plugin add pantheon-opencode

# Optional CLI installer (materializes .opencode/ files, AGENTS.md, or legacy MCPs)
npx pantheon-opencode init --project --no-mcp
```

Flags, backup, uninstall, and reconcile are in [Installation](INSTALLATION.md).

## Headless cockpit on a VPS (SSH tunnel)

A headless Linux VPS has no terminal sidebar. For that case Pantheon ships an
**opt-in, read-only HTTP cockpit** that serves a reduced view of the same
on-disk artifacts the TUI reads. It is not the TUI and it does not pretend to
be: the payload is the versioned `pantheon.cockpit.v1` envelope, not the TUI
`CockpitSnapshot` type.

### Enable it

```bash
PANTHEON_COCKPIT=1 PANTHEON_COCKPIT_PORT=4747 opencode
```

`PANTHEON_COCKPIT=1` is the only enable switch. Unset or `0` logs
`cockpit disabled` and creates no listener at all. While enabled:

| Variable | Contract |
|---|---|
| `PANTHEON_COCKPIT_PORT` | Integer `1..65535`, default `4747`. `0`, negative, `>65535`, non-numeric, or whitespace-padded (`' 0 '`) is a **fatal startup error** — never an ephemeral port, never a silent disable. |
| `PANTHEON_COCKPIT_HOST` | Must be `127.0.0.1`, `::1`, or `localhost`. Anything else (including `0.0.0.0`) is a **fatal startup error**. `localhost` is bound as `127.0.0.1`. |
| `PANTHEON_COCKPIT_TOKEN` | Optional shared secret. When set, every request must carry it in the `x-pantheon-cockpit-token` header. |

The bound URL is written to `.pantheon/logs/hooks.log` at startup
(`cockpit listening on http://127.0.0.1:4747 ...`).

A port configured while the cockpit is disabled produces a warning and stays
disabled; it never opens a socket.

### Tunnel from your laptop

The server only accepts loopback connections, so reach it through SSH:

```bash
ssh -N -L 4747:127.0.0.1:4747 you@vps.example.com
```

Then, locally:

```bash
curl -s http://127.0.0.1:4747/healthz
curl -s http://127.0.0.1:4747/            # reduced snapshot
curl -s 'http://127.0.0.1:4747/?full=1'   # opt in to bodies/paths/commands
curl -s -H "x-pantheon-cockpit-token: $TOKEN" http://127.0.0.1:4747/
```

`GET /` and `GET /snapshot` are aliases. `GET /healthz` returns
`{ ok, schema, version }`.

### What it serves — and what it does not

The envelope is reduced **from on-disk artifacts only**:
`ledger/step-ledger.json` (with S1 readiness: waves, ready, unmet, dangling,
unplaced), the persisted board (`messages.ndjson` / `threads.json`), and the
package version. It carries `kind: "headless"`, `source: "on-disk"`, and
`parity: "not-tui-snapshot"` so the difference is machine-checkable.

It does **not** include live child sessions, bus events, per-session cost or
token counters, session titles, or in-process background jobs. Those require a
running host and are only available in the TUI. Expect the cockpit to lag the
live session and to show only what has been persisted.

A corrupt ledger is reported as `stepsCorrupt: true` with an empty `steps`
array — the same distinction the TUI makes. The cockpit never quarantines or
rewrites the ledger on a read, so the corrupt bytes remain for inspection.

### Redaction

By default the snapshot omits board message bodies, session ids, ephemeral
metadata, receipt ids, file lists, and command lines. `?full=1` opts in to
those fields. Treat `?full=1` as sensitive: board bodies and verification
commands can contain secrets.

### Threat model

- **Loopback is the boundary.** The cockpit authenticates no user and has no
  multi-tenant model. Anyone who can reach the loopback port — including any
  other local user or process on the VPS — can read the snapshot.
- **SSH is the transport.** The tunnel encrypts the traffic and reuses your SSH
  identity; do not expose the port through a reverse proxy or a firewall rule.
- **DNS rebinding is rejected.** The `Host` header must name `127.0.0.1`,
  `localhost`, or `[::1]` for the bound port; anything else gets `421
  Misdirected Request` with an empty body.
- **No write surface.** Only `GET` and `HEAD` are routed; every other method is
  `405`. There are no CORS headers, so a browser cannot read responses
  cross-origin.
- **No caching.** Every response is `Cache-Control: no-store` with
  `X-Content-Type-Options: nosniff`.
- **The token is defence-in-depth, not the boundary.** Loopback plus the SSH
  tunnel is the boundary. The token protects against a local process that can
  reach the port but does not know the secret; it is compared in constant time
  against the header value.
- **Read-only.** The cockpit performs no git operations, no board writes, and
  no ledger writes, so `push --mirror`-style repository operations are not
  reachable from it.

An operator on a VPS can inspect persisted step readiness and board summaries
through the tunnel. They cannot post to the board, mutate the ledger, spawn or
stop workers, read live cost/token telemetry, or reach the repository.


## Configuration

OpenCode reads `opencode.json` (or `opencode.jsonc`) from the global config
directory (`~/.config/opencode/`) or project root.

`default_agent: zeus` and `permission.skill` are seeded automatically in-process
by the plugin (or materialized when running `init`). Contributors who keep a
project-level `opencode.json` for their own sessions should leave it untracked.

Agent definitions live in `src/agents/*.md` (loaded natively by the plugin); do
not maintain duplicate manual copies under `.opencode/agents/` unless you
intentionally override an agent locally.

## File locations

Runtime state created on demand in any project or linked worktree (main repo
`.pantheon/` is shared automatically across git worktrees):

```text
your-project/
└── .pantheon/
    ├── memory/memory.db      # FTS5 memory, checkpoints & goals
    ├── codemap/codemap.db    # structural symbol & relation index
    ├── ledger/step-ledger.json
    ├── deepwork/<slug>/PLAN.md
    └── reports/
```

`ledger/step-ledger.json` (`version: 1`) records one entry per step:
`state` is `pending | in_progress | done | blocked | rolled_back`, plus optional
`dependsOn`, `blockedBy`/`cascadeReason`, `verificationAttempts`,
`verificationFailures`, `ownedFiles`, `forbiddenFiles`, and `ephemeral` metadata.
`pending` means prerequisites are still open. A step is *ready* when it is
`pending`, declares at least one dependency, and every dependency is `done`;
`pantheon_step_ledger(action="status")` returns that as `graph.ready` with the
parallel launch `waves` and the `unplaced` steps that can never launch. Every
baseline is anchored under `refs/pantheon/step-baselines/<stepKey>` so Git GC
cannot prune a live checkpoint, and a pruned baseline is reported as
`baseline_missing` instead of rolling back nothing. The lock file
(`.pantheon/ledger/.step-ledger.lock`) carries an owner token so concurrent
writers are safe, and a corrupt ledger is moved aside as
`step-ledger.json.corrupt.<ts>` — see
[Step dependencies](opencode.md#step-dependencies-and-readiness).

Worker branches live in git, not in `.pantheon/`: `spawn_ephemeral` preserves a
worker's edits on `pantheon/eph/<stepKey>` and records `ephemeral.branch` /
`ephemeral.baseHead` on the ledger entry, and
`pantheon_step_ledger(action="merge_ephemeral")` lands it behind a single-use
token (`mergedSha`/`mergedAt`/`mergeTree` afterwards) — see
[Ephemeral branch merge](opencode.md#ephemeral-branch-merge).

With the recommended `opencode plugin add pantheon-opencode` install, agents,
skills, commands, and the TUI bundle are loaded directly from OpenCode's npm
plugin cache—no redundant copies in `~/.config/opencode/agents/` or
`plugins/pantheon-tui/` are needed. See [OpenCode 2.x](opencode.md).

## Quick reference

| Action | Command |
|---|---|
| Start OpenCode (TUI) | `opencode` |
| Run non-interactively | `opencode run "prompt"` |
| Initialize project rules | `/init` in-session |
| Invoke an agent | `@zeus: implement email verification` |
| List agents | `opencode agent list` |
| List models | `opencode models` |
| Add an MCP server | `opencode mcp add` |
| Add a provider key | `opencode auth login` |
| List sessions | `opencode session list` |
| Token stats | `opencode stats` |

`/init` is OpenCode's built-in project-context generator. It is complementary
to Pantheon: `/init` captures project-level conventions, while Pantheon agents
supply role behavior. If `AGENTS.md` already exists, `/init` improves it in
place.

## ACP (Agent Client Protocol)

OpenCode can run as an ACP-compatible agent for editors such as Zed,
JetBrains, or Neovim. Start the server with `opencode acp`; it communicates over
JSON-RPC on stdio. ACP does not change the selected plugin contract: V1
hook/delegate behavior still depends on V1 host events, and the V2 plugin
remains its own surface. Verify the registration in `opencode.json` before
relying on a feature.

For Zed, add this to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "OpenCode": {
      "type": "custom",
      "command": "opencode",
      "args": ["acp"]
    }
  }
}
```

`type: "custom"` is the field Zed's settings schema uses for a hand-configured
agent server rather than a built-in one.

## Troubleshooting

| Symptom | Check |
|---|---|
| Agents not showing up | `opencode agent list`; valid YAML frontmatter; correct agents directory |
| Default agent not working | `default_agent` must match an agent with `mode: primary` |
| Model not available | `provider/model` format; `opencode models`; provider key |
| Instructions not loading | Paths are relative to the config file; global and project layers merge |
| MCP server not connecting | `opencode mcp list`; OAuth via `opencode mcp auth <server>` |
| Skills not discovered | `permission.skill` allows the skill; skills are installed |
| Slow responses | Cheaper model for discovery; fewer instruction files |

For MCP-specific failures, see [MCP](MCP.md#troubleshooting). For installer and
driver problems, see [Installation](INSTALLATION.md).

## Dynamic prompts

OpenCode prompt files support `{file:path}` interpolation. Pantheon's
`/pantheon` council prompt uses that to build a dynamic, per-run prompt. The
generation script and its limits are described in the prompt file itself
(`prompts/`); static prompt templates remain the default for the other
commands.
