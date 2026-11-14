# Settings & TUI window (`/pantheon-settings`)

> Originally published in the root README. Design background:
> [Pantheon 2.0 — Modern Install, Settings UI, and Update Flow](design/2.0-settings-and-install.md).
> Quota providers inside the TUI: [TUI quota providers](tui-quota-providers.md).

Run `/pantheon-settings` (or `Pantheon: Settings` in the command palette) to open the
interactive settings window:

- **Gates & overrides:** toggle named behaviors live; persists to `pantheon-overrides.json`.
- **Model presets:** switch active model tier globally or per project.
- **Decision model selector:** interactive selector to cycle across all remote decision
  models (`openrouter-jev`, `typesafe-jev`, `openai-decisions`, `vercel-gateway-jev`, etc.)
  directly from the UI.
- **Bilingual settings (PT-BR / EN):** full visual localization for Decision, Autonomy,
  and Safety tabs, auto-detecting environment locale with manual toggle in the TUI tab.
- **Updates:** check registry channel (`beta` / `stable`) and trigger upgrades.
- **Doctor:** run inline system health diagnostics.
- **TUI personalization:** adjust spacing (`comfortable` vs `compact`), separators, gauge
  bar styles, context display rows, and language.
- **Non-destructive overlay & mouse navigation:** opens as a floating dialog overlay over
  the active session without blanking the workspace (configurable via `dialog` vs
  `fullscreen`), with full mouse click support for tabs, sidebar, rows, value cyclers, and
  actions.
- **Modernized What's New window:** card layout with rounded border, pagination buttons,
  and a dedicated `[OK, Entendido]` button with keyboard (`Enter`/`Esc`/`Q`) and mouse
  click support. See [The What's-new TUI window](reference/whats-new.md).
