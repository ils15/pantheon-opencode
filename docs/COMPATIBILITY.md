# Compatibility and Support Policy

This page is the only home of the support policy, the OpenCode generation
rules, the Node floor, and the known-issue list. Other pages state the support
summary once and link here.

## Supported hosts

Support is declared for an OpenCode **family**, not for individual minors. A
minor does not need its own measurement to be supported.

- **OpenCode 1.19.x** — supported with the V1 plugin.
- **OpenCode 2.x** — supported with the V2 plugin. Every 2.x minor is supported,
  including minors released after this document was written.
- **Known broken: OpenCode 2.0.22.** It does not expose
  `ctx.permission.assert` (`src/plugin-v2.ts:1720-1727`;
  `bench/results/p05-permission-matrix-2026-10-22.md:169`), so Pantheon's V2
  permission-ordering and bounded-read paths fail there. The V2 loader also
  requires the plugin entry to be a directory
  (`scripts/install/opencode.mjs:579-582`); the installer already writes that
  form for every 2.x host, so it is not a 2.0.22-specific failure. Do not
  install Pantheon on 2.0.22.
- **Node.js >=26.4.0** is the package floor; Python **>=3.11** is required for
  the optional MCP servers. The `node:sqlite` >=22.5 threshold for
  `pantheon_cost` is a capability threshold, not the package floor.

| Pantheon line | OpenCode 1.19.x | OpenCode 2.x | OpenCode 2.0.22 |
|---|---|---|---|
| **1.6.x** (current) | Supported — V1 plugin | Supported — V2 plugin | Known broken — not supported |
| **1.7 and later** | Not supported | Supported — V2 plugin | Known broken — not supported |

A missing measurement is not a support gap. The V2 plugin targets the OpenCode 2
contract and degrades feature by feature when a host lacks an optional domain;
it does not require a per-minor blessing. The evidence table below lists the
hosts that happen to have a record in this repository.

## Node runtime floor

Pantheon declares `engines.node` as `>=26.4.0`, its own alignment policy with
the official OpenCode Node build that CI pins to exactly 26.4.0. Node 22, Node
24, and Node 26.0–26.3 are outside the supported range.

This package floor does not imply that every OpenCode host runs on Node.
Official OpenCode 2.x ships a Bun runtime path and a separate Node build
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

## Verified versions (evidence)

This table is **evidence, not the boundary of support**. It lists only hosts
with a measurement recorded in this repository. A 2.x minor absent here is still
supported; it is simply unmeasured.

| Host | Contract | Evidence |
|---|---|---|
| `1.19.4` | V1 | `tests/canary/run-v1-permission-proof.sh`; `bench/results/p05-permission-matrix-2026-10-22.md` |
| `2.0.29` | V2 | `bench/results/p05-permission-matrix-2026-10-22.md`; `bench/results/f4a-v229-admission-identity-2026-10-14.md` |
| `2.0.30` | V2 | `bench/results/p05-permission-matrix-2026-10-22.md` |
| `2.1.0` | V2 | `bench/results/p05-permission-matrix-2026-10-22.md` |
| `2.1.2` | V2 | `bench/results/p05-permission-matrix-2026-10-22.md`; `docs/internal/validation.md` |
| `2.1.3` | V2 | `bench/results/p05-permission-matrix-2026-10-22.md` |

The table above is a measurement record, not a release checklist. A new 2.x
minor is supported on release day; measuring it is optional evidence work.

## End of life and known issues

**1.6.x is the last Pantheon line that supports an OpenCode 1.X host.** From
1.7 onward the line drops the V1 contract and targets OpenCode 2 only. This is a
Pantheon support boundary, not a claim that 1.6 lacks OpenCode 2 support.

- **OpenCode 2.0.22 is known broken.** It does not expose
  `ctx.permission.assert`, so the V2 permission-ordering and bounded-read paths
  cannot run there. It is the only known-broken host in the supported families.
- A supported host is not required to have a measurement row. The table above
  is evidence; the supported families are the boundary.
