# docs/assets/tui/v2-sidebar.tape
#
# STATUS: UNVERIFIED — no image has been produced from this tape. See
# docs/internal/validation.md#tui-media-gap for the blocker record.
#
# Target slot: docs/opencode-v2.md#dispatch-sidebar-block (media slug
# `opencode-v2-dispatch-sidebar`).
# Output: v2-sidebar.gif + sidebar-dispatch-block.png (this directory).
#
# Requirements:
#   - vhs, ttyd and ffmpeg on PATH (`npm run docs:media --check`);
#   - an isolated install prepared by scripts/test-opencode-v2-sandbox.sh
#     --prepare, started by ~/pantheon-sandbox/start-pantheon.sh;
#   - a provider credential *inside that sandbox HOME*.
#
# This tape makes real model calls. The Dispatch block renders only real child
# sessions, and a staged or mocked session is forbidden by the documentation
# rule, so there is no offline variant of this capture.
#
# Determinism: fixed geometry, font size, theme, shell and explicit sleeps.
# Spinner glyphs, durations and costs are sampled from a real run; they are
# stable in shape, not in value. The prompt and sleeps may need retuning on a
# slower host — do not shorten them to "make it fit".

Output v2-sidebar.gif

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

# A real fan-out. The sidebar keeps the Dispatch block only while children
# exist; the finished roll-up appears once they settle.
Type "/pantheon-deepwork --full-auto 'audit the MCP permission rules in docs/MCP.md'"
Enter
Sleep 45s
Screenshot sidebar-dispatch-block.png
Sleep 60s
