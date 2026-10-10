# Pantheon TUI compatibility

- **OpenCode V1:** supported by the existing `@opencode-ai/plugin@1.18.33`
  TUI API and its `sidebar_content` / `app_bottom` slots.
- **OpenCode V2 TUI:** unsupported. This package still exports the V1
  `TuiPlugin` factory; it has no verified V2 TUI adapter. Do not infer the V2
  TUI registration or slot contract from the V2 plugin `setup` contract. The
  installed OpenCode host could not be analyzed with REA in this environment
  because no native analysis provider was available, so a V2 contract must be
  verified against a suitable shipped host artifact before adding an adapter.

The V1 UI and its slot registrations remain unchanged. Keep this package on its
existing V1 pins until a separately verified V2 migration can preserve the
legacy UI behavior or explicitly replace it.
