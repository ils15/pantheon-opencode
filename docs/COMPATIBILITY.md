# Compatibility and Support Policy

This page is the only home of the support policy, the host gate rules, the Node
floor, and the known-issue list. Other pages state the support summary once and
link here.

## Supported hosts

Support is declared for an OpenCode **family**, not for individual minors. A
minor does not need its own measurement to be supported.

- **OpenCode 2.x** — supported. Every 2.x minor is supported, including minors
  released after this document was written. 2.0 removed the OpenCode V1
  contract entirely: the package registers only the host-native plugin surface
  described in [Architecture](ARCHITECTURE.md).
- **Known broken: OpenCode 2.0.22.** It does not expose
  `ctx.permission.assert` (`src/plugin.ts`;
  `bench/results/p05-permission-matrix-2026-10-22.md:169`), so Pantheon's
  permission-ordering and bounded-read paths fail there. The host loader also
  requires the plugin entry to be a directory
  (`scripts/install/opencode.mjs`); the installer already writes that form for
  every 2.x host, so it is not a 2.0.22-specific failure. Do not install
  Pantheon on 2.0.22.
- **Node.js >=26.4.0** is the package floor; Python **>=3.11** is required for
  the optional MCP servers. The `node:sqlite` >=22.5 threshold for
  `pantheon_cost` is a capability threshold, not the package floor.

| Pantheon line | OpenCode 1.19.x | OpenCode 2.x | OpenCode 2.0.22 |
|---|---|---|---|
| **1.7.x** — **last line with V1 support** | Supported — V1 plugin | Supported — the plugin | Known broken — not supported |
| **2.0 and later** | Not supported | Supported — the plugin | Known broken — not supported |

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

## The host gate

There is exactly one contract to write, and the installer must CONFIRM the
host is OpenCode 2.x before any file is written. There is no generation to
select and no fallback: an install decision made on an unconfirmed host would
be a guess, and guessing is the defect the gate exists to prevent. The gate
lives in `scripts/install/opencode-version.mjs` and resolves in this order:

1. An explicit `OPENCODE_VERSION=v2` environment pin skips the probe entirely.
   It exists so CI, sandboxes, and operators can make the answer deterministic
   without a runnable host binary. `v1` (or any other value) is refused —
   `v1` gets the unsupported-host message, anything else an invalid-value
   error.
2. An `OPENCODE_BIN` basename of `opencode2` is an explicit operator hint and
   always resolves to 2.x.
3. A `--version` probe of the host binary. The probe runs inside a throwaway
   HOME/XDG sandbox (5-second budget on an apply, 2-second on a dry run — plan
   and apply must make the SAME decision), captures stdout and stderr, and
   anchors on the tool name: a version token immediately preceded by
   `opencode` is the host's own version, so a runtime token ahead of it
   (`node v22.1.0 (opencode 2.0.29)`) or a trailing build date
   (`opencode v2.0.29 built 2026.10.04`) cannot flip the answer. A major the
   gate refuses to interpret (0, or a calendar-year value) is reported, not
   read.

Every refusal happens before any write:

- **major === 1** — a confirmed 1.x host is a fact, not a detection gap: the
  `plugins` registry this installer writes would be silently ignored there.
- **probe failed / unreadable / unparseable / contradictory** — the installer
  cannot confirm the one premise it writes for, so it refuses loudly instead
  of guessing.

In every refusal case the message names the deterministic escape hatch:
`OPENCODE_VERSION=v2`. An operator whose `opencode` is a wrapper that prints a
bare path is indistinguishable from a real host by construction; the remedy is
the env pin, not a heuristic.

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

Within `opencode.json` the installer strips Pantheon references from both the
legacy singular `plugin` key and the plural `plugins` key, then registers only
the current entry, so a host never loads two Pantheon plugins. The singular
`plugin` key is legacy: a third-party entry found there that the host could
actually load is additionally registered under the plural `plugins` key (and
reported), because the 2.x host does not read the singular key and the entry
would otherwise stop loading silently. Legacy V1-shaped config keys (`agent`,
`permission`, flat `mcp`, …) are normalized to the 2.x shapes before the write.

## Historical note: OpenCode 1.19.x (removed in 2.0)

2.0 requires OpenCode 2.x. The V1 plugin line was removed. Of its old
registrations, only stale references are still recognized, for cleanup: a
singular `plugin` key entry and a `src/plugins/pantheon-hooks.ts` path are
stripped or migrated, never registered — the hooks file no longer exists in
this package, and `src/plugin.ts` today is the entry of the one remaining
plugin, not a V1 identity.

The V1 surface is kept here for history: it registered six tools
(`hashline_edit`, the three `pantheon_goal_*` tools, `pantheon_cost`,
`pantheon_model`), the BackgroundJobBoard lifecycle, the V1 event/tool hooks,
and the V1 compaction path.

On OpenCode `1.19.4`, with `bash`, `write`, and `edit` set to `deny` and `read`
set to `allow`, the host makes `bash` and `write` unavailable, produces no side
effect, and `read` still works. The proof is config-level, not hook-based: the
probe recorded zero `permission.ask` invocations. The permission request goes
to the client instead (`permission.asked`, `GET /permission`, then
`POST /permission/{id}/reply`), and a client `reject` does block the call.

## The OpenCode 2 path

The 2.x path is the only path: it registers tools with `input`/`output`
schemas, event subscriptions, session hooks, a read-only-enforcing
`execute.before` hook (which also denies the orchestrator `read`/`glob`/`grep`
of source, tests and scripts), and — when the host exposes it — a
`permission.evaluate` delegation-matrix hook. It is not full V1 feature parity:
the three goal tools remain unsupported and are reported as `goal-tools`, as are
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
| `1.19.4` | V1 (historical) | `bench/results/p05-permission-matrix-2026-10-22.md` |
| `2.0.29` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md`; `bench/results/f4a-v229-admission-identity-2026-10-14.md` |
| `2.0.30` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md` |
| `2.1.0` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md` |
| `2.1.2` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md`; `docs/internal/validation.md` |
| `2.1.3` | 2.x | `bench/results/p05-permission-matrix-2026-10-22.md` |

The table above is a measurement record, not a release checklist. A new 2.x
minor is supported on release day; measuring it is optional evidence work.

## End of life and known issues

**1.7.x is the last Pantheon line that supports an OpenCode 1.X host.** From
2.0 onward the line drops the V1 contract and requires OpenCode 2.x. This is a
Pantheon support boundary, not a claim that 1.7 lacked OpenCode 2 support.

- **OpenCode 2.0.22 is known broken.** It does not expose
  `ctx.permission.assert`, so the permission-ordering and bounded-read paths
  cannot run there. It is the only known-broken host in the supported family.
- A supported host is not required to have a measurement row. The table above
  is evidence; the supported family is the boundary.
