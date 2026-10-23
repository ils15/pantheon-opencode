# Compatibility and Support Policy

This page is the only home of the support matrix, the OpenCode generation
rules, the Node floor, and the known-issue list. Other pages state the support
summary once and link here.

## Supported hosts

The 1.6.x line supports OpenCode **1.19.x** with the V1 plugin, and OpenCode
**2.0.29, 2.0.30, 2.0.31, and 2.1.x** with the V2 plugin. **OpenCode 2.0.22 is
not supported.** Node.js **>=26.4.0** is the package floor; Python **>=3.11** is
required for the optional MCP servers.

| Pantheon line | OpenCode 1.19.x | OpenCode 2.0.29 / 2.0.30 | OpenCode 2.1.x (`>=2.1.0 <2.2`) | OpenCode 2.0.22 | OpenCode 2.0.31 |
|---|---|---|---|---|---|
| **1.6.x** (current) | **Supported — PASS: config-level read-only enforcement.** V1 contract; measured on `1.19.4` | **Supported — PASS measured.** V2 contract; post-fix permission matrix with zero `FAIL` cells | **Supported — PASS measured** at floor `2.1.0` and the newest patch at freeze (`2.1.3`) | **Not supported.** Host lacks `ctx.permission.assert` and `worktree_*` / `pantheon_bounded_read` | **Supported** — V2 contract, by maintainer decision. No permission-matrix row yet |
| **1.7 and later** | **Not supported.** Breaking change | **Target of 1.7+.** V2 only | **Target of 1.7+.** V2 only | **Not supported** | **Supported** — V2 only |

A missing row is not a `PASS`. `2.0.31` is supported without a measured
permission-matrix row, so it is marked supported and not `PASS`. `2.0.29`,
`2.0.30`, and `2.1.x` carry a measured `PASS` from the V2 permission matrix.
`1.19.x` carries a measured `PASS` from a different mechanism — **config-level
read-only enforcement**, not the `permission.ask` hook, which does not fire on
that host.

The `2.1.x` line is proved as a line: two measurements per release, the floor
`2.1.0` and the newest `2.1.x` patch published at freeze.

## Node runtime floor

Pantheon declares `engines.node` as `>=26.4.0`, its own alignment policy with
the official OpenCode Node build that CI pins to exactly 26.4.0. Node 22, Node
24, and Node 26.0–26.3 are outside the matrix.

This package floor does not imply that every OpenCode host runs on Node.
Official OpenCode V2.0.31 ships a Bun runtime path and a separate Node build
pinned to Node 26.4.0, so the host runtime you choose does not move Pantheon's
package floor. No Bun minimum is asserted.

Below the floor the package still installs, but `postinstall` only warns and
skips the TUI and config sync, and the CLI stops with an explicit version
message before any setup write. The optional `pantheon_cost` SQLite backend has
a separate, lower capability threshold — `node:sqlite` on Node >= 22.5 — which
does not lower the package or CLI support floor.

## How the generation is selected

The installer selects exactly one generation per installation. `auto` is the
default and resolves in this order: an explicit `--opencode-version` argument,
then `OPENCODE_VERSION`, then an `OPENCODE_BIN` basename of `opencode2`, then a
`--version` probe of the host where major >= 2 selects V2.

When the probe cannot run, prints no readable version, or prints contradictory
version-shaped tokens with no tool name to break the tie, `auto` **warns once
and falls back to V1**. It does not fail loudly. It also falls back loudly when
the host names itself with a major it refuses to interpret (0, or a
calendar-year value). A successful parse of major < 2 resolves to V1 and major
>= 2 resolves to V2, silently. The fallback direction is deliberate: a plural
`plugins` directory entry on an unknown 1.x host loses the plugin entirely.

The probe prefers the version token that follows the tool name, so a runtime
token ahead of it (`node v22.1.0 (opencode 1.18.33)`) or a trailing build date
(`opencode v1.18.33 built 2026.10.04`) cannot flip the generation. An operator
whose `opencode` is a wrapper that prints a bare path is indistinguishable from
a real host; the documented remedy is `--opencode-version`, not a heuristic.

## Config registration and the host's config merge

Pantheon registers its plugin in `opencode.json`; the installer never writes
`opencode.jsonc`. The OpenCode V2 host also loads a sibling `opencode.jsonc`
from the same config directory when one exists, and merges the two files:
scalars from `.jsonc` win, and arrays are unioned. A `plugin`/`plugins` entry in
`.jsonc` therefore joins the effective plugin set instead of replacing the
registration Pantheon wrote. The merge is silent, so a host can load a plugin
that appears only in `.jsonc`.

The installer strips Pantheon references from both config shapes and registers
only the selected generation, so a 1.X host never loads the V2 plugin and a V2
host never loads the V1 plugin. Forcing V2 on a 1.X host is an unsupported
mixed/wrong-generation configuration, not a supported mode.

## What "supported on OpenCode 1.19.x" means

An OpenCode 1.19.x host gets the V1 plugin: `src/plugin.ts` plus
`src/plugins/pantheon-hooks.ts`, registered under the singular `plugin` config
key. That surface registers six tools (`hashline_edit`, the three
`pantheon_goal_*` tools, `pantheon_cost`, `pantheon_model`), the
BackgroundJobBoard lifecycle, the V1 event/tool hooks, and the V1 compaction
path.

On OpenCode `1.19.4`, with `bash`, `write`, and `edit` set to `deny` and `read`
set to `allow`, the host makes `bash` and `write` unavailable, produces no side
effect, and `read` still works. The proof is config-level, not hook-based: the
probe recorded zero `permission.ask` invocations. The permission request goes
to the client instead (`permission.asked`, `GET /permission`, then
`POST /permission/{id}/reply`), and a client `reject` does block the call.

## The OpenCode 2 path

The V2 path is real, not inert: it registers tools with `input`/`output`
schemas, event subscriptions, session hooks, a read-only-enforcing
`execute.before` hook, and — when the host exposes it — a `permission.evaluate`
delegation-matrix hook. It is not full V1 feature parity: the three goal tools
remain unsupported and are reported as `goal-tools`. See
[Architecture](ARCHITECTURE.md) for the contract and
[OpenCode V2](opencode-v2.md) for user-facing behavior.

## Verified against

| What | Verified against | How |
|---|---|---|
| V1 plugin and generation gate | OpenCode 1.19.x line — runtime measurement on `1.19.4` (2026-10-22) | Generation-gate unit tests, installer end-to-end tests, V1 permission probe |
| V2 plugin tool surface | OpenCode v2.0.29 | `tests/canary/plugin-v2-tool-canary.test.mjs` through `opencode serve`; F4A permission canary 18/18 |
| V2 native subagent admission | OpenCode v2.0.29 | `tests/canary/run-v2-permission-proof.sh`; evidence in `bench/results/f4a-v229-admission-identity-2026-10-14.md` |
| V2 permission matrix (post-fix) | OpenCode 2.0.29, 2.0.30, and 2.1.x (floor `2.1.0`, newest patch at freeze) | Post-fix rerun on 2026-10-22 with zero `FAIL` cells; curated evidence in `bench/results/p05-permission-matrix-2026-10-22.md` |
| V1 runtime read-only enforcement | OpenCode `1.19.4` on 2026-10-22 | `tests/canary/v1-permission-canary.test.mjs` via `tests/canary/run-v1-permission-proof.sh` |

## End of life and known issues

**1.6.x is the last Pantheon line that supports an OpenCode 1.X host.** From
1.7 onward the line drops the V1 contract and targets OpenCode 2 only. This is a
Pantheon support boundary, not a claim that 1.6 lacks OpenCode 2 support.

- **OpenCode 2.0.22 is not supported.** It exposes neither
  `ctx.permission.assert` nor `worktree_*` / `pantheon_bounded_read`, so its
  permission-ordering cells cannot be observed. It left the matrix on runtime
  evidence, not on absence of evidence.
- **2.0.31 is supported but unmeasured** for the permission matrix. Treat it as
  supported, not as a `PASS`.
- A `WARN`, `SKIP`, `NOT_TESTED`, or `AMBIENTAL` result is not a `PASS`.
