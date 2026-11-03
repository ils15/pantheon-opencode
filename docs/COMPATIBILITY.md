# Compatibility and Support Policy

This page is the only home of the support policy, the OpenCode generation
rules, the Node floor, and the known-issue list. Other pages state the support
summary once and link here.

## Supported hosts

Support is declared for an OpenCode **family**, not for individual minors. A
minor does not need its own measurement to be supported.

- **OpenCode 2.x** — supported with the plugin. Every 2.x minor is supported,
  including minors released after this document was written. Pantheon 2.0
  requires OpenCode 2.x; the legacy 1.19.x plugin line was removed, and an
  existing 1.x registration is recognized for migration only, never registered.
- **Known broken: OpenCode 2.0.22.** It does not expose
  `ctx.permission.assert` (`src/plugin.ts`;
  `bench/results/p05-permission-matrix-2026-10-22.md:169`), so Pantheon's
  permission-ordering and bounded-read paths fail there. The plugin loader also
  requires the plugin entry to be a directory
  (`scripts/install/opencode.mjs:579-582`); the installer already writes that
  form for every 2.x host, so it is not a 2.0.22-specific failure. Do not
  install Pantheon on 2.0.22.
- **Node.js >=26.4.0** is the package floor; Python **>=3.11** is required for
  the optional MCP servers. The `node:sqlite` >=22.5 threshold for
  `pantheon_cost` is a capability threshold, not the package floor.

| Pantheon line | OpenCode 1.19.x | OpenCode 2.x | OpenCode 2.0.22 |
|---|---|---|---|
| **2.0 and later** (current) | Removed — 2.x only | Supported — the plugin | Known broken — not supported |
| **1.6.x** (historical) | Supported with the V1 plugin, removed in 2.0 | Supported — the plugin | Known broken — not supported |

A missing measurement is not a support gap. The plugin targets the OpenCode 2
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

The installer writes exactly one plugin registration per installation. `auto`
is the default and resolves in this order: an explicit `--opencode-version`
argument, then `OPENCODE_VERSION`, then an `OPENCODE_BIN` basename of
`opencode2`, then a `--version` probe of the host. Only `v2` and `auto` are
valid values; an explicit `v1` is refused with the 2.0 message, and a probe that
reads a 1.x host (major < 2) refuses the install instead of writing a config
that host would drop — with `--opencode-version v2` left as the explicit
override for operators whose binary probes misleadingly.

When the probe cannot run, prints no readable version, or prints contradictory
version-shaped tokens with no tool name to break the tie, `auto` **warns once
and assumes the 2.x generation** — the only generation the installer writes. It
also assumes 2.x, loudly, when the host names itself with a major it refuses to
interpret (0, or a calendar-year value). A successful parse of major >= 2
resolves to the 2.x line, silently.

The probe prefers the version token that follows the tool name, so a runtime
token ahead of it (`node v22.1.0 (opencode 1.18.33)`) or a trailing build date
(`opencode v1.18.33 built 2026.10.04`) cannot flip the result. An operator
whose `opencode` is a wrapper that prints a bare path is indistinguishable from
a real host; the documented remedy is `--opencode-version`, not a heuristic.

## Config registration and the host's config merge

Pantheon registers its plugin in `opencode.json`. The installer reads and writes
**only** that file — it never reads, writes, or edits a sibling
`opencode.jsonc`.

An OpenCode 2.x host also loads `opencode.jsonc` from the same config directory
when one exists and merges the two files: scalars from the `.jsonc` win, and
arrays are unioned. A `plugin`/`plugins` entry in `.jsonc` therefore joins the
effective plugin set instead of replacing the registration Pantheon wrote, and
the merge is silent. What the installer guarantees is narrower than "the
effective set is correct": if both files exist, it **warns** and names both
paths, because anything in the `.jsonc` — including a stale Pantheon entry — is
outside what it can see. Resolve that by moving the entries you want into
`opencode.json` and deleting the `.jsonc`.

Within `opencode.json` the installer strips Pantheon references from both plugin
keys and registers only the current entry, so a host never loads two Pantheon
plugins. On a 1.x→2.x migration a
third-party entry found in the legacy singular `plugin` key is additionally
registered under the 2.x plural `plugins` key (and reported), because the 2.x host
does not read the singular key and the entry would otherwise stop loading
silently.

## Historical note: OpenCode 1.19.x (removed in 2.0)

2.0 requires OpenCode 2.x. The V1 plugin line was removed — its identities
(`src/plugin.ts` as it existed then, `src/plugins/pantheon-hooks.ts`) remain
RECOGNIZED for migration only, never registered. The V1 surface described below
is kept for history: That surface registers six tools (`hashline_edit`, the three
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

The 2.x path is real, not inert: it registers tools with `input`/`output`
schemas, event subscriptions, session hooks, a read-only-enforcing
`execute.before` hook (which also denies the orchestrator `read`/`glob`/`grep`
of source, tests and scripts), and — when the host exposes it — a
`permission.evaluate` delegation-matrix hook. It does not carry over the
removed V1 line's goal tools: the three goal tools remain unsupported and are
reported as `goal-tools`, as are
the host-domain gaps the seed names (`idle-todo-enforcer`, `tool-ceiling`,
`todo-restore`, `board-transitions`). See
[Architecture](ARCHITECTURE.md) for the contract and
[OpenCode 2.x](opencode.md) for user-facing behavior.

## Verified versions (evidence)

This table is **evidence, not the boundary of support**. It lists only hosts
with a measurement recorded in this repository. A 2.x minor absent here is still
supported; it is simply unmeasured.

| Host | Contract | Evidence |
|---|---|---|
| `1.19.4` | V1 | `tests/canary/run-v1-permission-proof.sh`; `bench/results/p05-permission-matrix-2026-10-22.md` |
| `2.0.29` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md`; `bench/results/f4a-v229-admission-identity-2026-10-14.md` |
| `2.0.30` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md` |
| `2.1.0` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md` |
| `2.1.2` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md`; `docs/internal/validation.md` |
| `2.1.3` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md` |

The table above is a measurement record, not a release checklist. A new 2.x
minor is supported on release day; measuring it is optional evidence work.

## End of life and known issues

**The V1 removal shipped in 2.0.** Pantheon 2.0 requires OpenCode 2.x; see
[Upgrading](UPGRADING.md) for what the move changes and what happens to a
legacy install.

- **OpenCode 2.0.22 is known broken.** It does not expose
  `ctx.permission.assert`, so the permission-ordering and bounded-read paths
  cannot run there. It is the only known-broken host in the supported families.
- A supported host is not required to have a measurement row. The table above
  is evidence; the supported families are the boundary.
