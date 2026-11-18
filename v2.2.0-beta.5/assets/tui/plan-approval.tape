# docs/assets/tui/plan-approval.tape
#
# STATUS: UNVERIFIED — no image has been produced from this tape. See
# docs/internal/validation.md#tui-media-gap for the blocker record.
#
# Target slot: docs/opencode-v2.md#plan-before-approval (media slug
# `opencode-v2-plan-approval`).
# Output: plan-approval.gif (this directory).
#
# Requirements:
#   - vhs, ttyd and ffmpeg on PATH (`npm run docs:media --check`);
#   - an isolated install prepared by scripts/test-opencode-v2-sandbox.sh
#     --prepare, started by ~/pantheon-sandbox/start-pantheon.sh;
#   - a provider credential *inside that sandbox HOME*.
#
# The capture must show the plan itself in the main conversation before the
# approval question. Without `--full-auto` the workflow stops at the gate.
#
# Determinism: fixed geometry, font size, theme, shell and explicit sleeps.
# The approval gate is a real model turn, so the plan text differs per run;
# the frames that matter are "full plan rendered" and "question asked".

Output plan-approval.gif

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
Type "/pantheon-deepwork 'audit the MCP permission rules in docs/MCP.md'"
Enter
Sleep 120s
