# The What's-new TUI window

When the Pantheon version changes since the last TUI start, the OpenCode V2 TUI
shows a one-time, dismissable **"O que há de novo — Pantheon `<version>`"**
dialog listing the highlights for that version, taken from the `CHANGELOG.md`
section of the running version (H3 subsection headings plus their bullets, at
most 12 bullets, reduced to plain text). Dismiss it with `esc` or `q`; the
version is then recorded and the window never appears again until the next
version — including downgrades, which also count as a change.

## Where the seen-version lives

`<configDir>/.pantheon/whats-new.json`, next to the other OpenCode-level
Pantheon state (`install-state.json`, the active-preset file). `<configDir>`
resolves like the rest of the installer: `$XDG_CONFIG_HOME/opencode`, then the
legacy `~/.opencode` when that is what exists. The file is one small JSON
document written atomically (unique temp file + rename):

```json
{ "seenVersion": "1.6.3-beta.4", "updatedAt": "2026-11-04T12:00:00.000Z" }
```

## Re-showing a window

The window is keyed by version, not by a flag, so there is nothing to toggle in
the configuration:

- **Re-show the current version's window:** delete the state file (or remove
  the `seenVersion` field) and restart OpenCode:

  ```bash
  rm ~/.config/opencode/.pantheon/whats-new.json
  ```

- **Never show it again for this version:** dismiss it once (`esc`/`q`), or
  pre-seed `seenVersion` with the running version.

## Failure behavior

The window is a nicety and fails open everywhere: a missing or corrupt state
file reads as "never seen" (the window may show), a failed write is silent, and
a missing or unreadable `CHANGELOG.md`, an unknown version, or a section with
no bullets all mean the window simply does not show. Nothing here can block or
break TUI startup. The window exists in the V2 generation (`dist/tui-v2.js`);
the legacy V1 generation does not show it. `CHANGELOG.md` ships at the plugin
copy root (`<configDir>/plugins/pantheon-tui/CHANGELOG.md`) so the window can
read the release notes offline.
