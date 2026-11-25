# docs/assets/tui/dispatch-panel.tape
#
# STATUS: UNVERIFIED — no image has been produced from this tape. See
# docs/internal/validation.md#tui-media-gap for the blocker record.
#
# Target slot: docs/opencode-v2.md#dispatch-panel (media slug
# `opencode-v2-dispatch-panel`).
# Output: dispatch-panel.gif + dispatch-panel-detail.png (this directory).
#
# Requirements:
#   - vhs, ttyd and ffmpeg on PATH (`npm run docs:media --check`);
#   - an isolated install prepared by scripts/test-opencode-v2-sandbox.sh
#     --prepare, started by ~/pantheon-sandbox/start-pantheon.sh;
#   - a provider credential *inside that sandbox HOME*.
#
# The panel reads only host-cached state; the child sessions themselves come
# from the real fan-out below. Width 1200 keeps the host above the panel's
# 72-column threshold, so the list and detail render side by side.
#
# Determinism: fixed geometry, font size, theme, shell and explicit sleeps.
# The row values are sampled from a real run; the thirty-second wait before
# opening the panel is what keeps "running" rows on screen.

Output dispatch-panel.gif

Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 800
Set Padding 16
Set Margin 16
Set Theme "Catppuccin Mocha"
Set CursorBlink false

Sleep 2s
Type "cd ~/pantheon-sandbox && ./start-pantheon.sh"
Enter
Sleep 15s
Type "/pantheon-deepwork --full-auto 'audit the MCP permission rules in docs/MCP.md'"
Enter
Sleep 30s

# `j` selects the newest child so the detail pane has a subject; the detail
# renders expanded by default, so `enter` would collapse it.
Type "/dispatch"
Enter
Sleep 4s
Type "j"
Sleep 3s
Screenshot dispatch-panel-detail.png
Sleep 2s
Type "q"
Sleep 2s
