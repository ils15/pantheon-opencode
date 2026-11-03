# Quota & usage

The Pantheon TUI no longer ships a quota surface. The native quota panel, the
sidebar quota block, usage history, and the `pantheon.quota` RPC were removed
in 1.6.2; the sidebar keeps only the non-quota blocks (Pantheon version,
preset/source, git state, `Context`, `Todo`, `Dispatch`).

## Recommended: the community plugin

To see provider quota and usage inside OpenCode, install the recommended
community plugin:

```bash
opencode plugin add @slkiser/opencode-quota
```

This path requires OpenCode 2.0.26 or newer. On an OpenCode 1.x host, use the
plugin's own installer instead:

```bash
npx @slkiser/opencode-quota@4 init
```

One line on coverage: `@slkiser/opencode-quota` supports 20+ providers and
ships `/quota`, `/quota_usage`, and `/quota_status` terminal commands, a TUI
surface, a Desktop app, and i18n — see
[github.com/slkiser/opencode-quota](https://github.com/slkiser/opencode-quota)
for the provider matrix and troubleshooting.

## What Pantheon still shows natively

- The sidebar `Context` block: tokens, percent gauge, `$<spent> spent`, and the
  muted `cache <n>% · <n.n> tok/s` line — all derived from the session
  transcript and the local OpenCode stats route, no provider calls.
- The `pantheon_cost` tool: tokens and USD by agent, model, and session, read
  from the session database and priced with the models.dev catalog.
