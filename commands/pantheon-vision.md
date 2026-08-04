---
description: "Configure Pantheon vision interactively: auth check, mode (native|tool|auto), vision model, tool fallback. Saves to opencode-vision.json. Usage: /pantheon-vision"
agent: hermes
---
# /pantheon-vision — Configure Vision

**What:** Walks the user through configuring Pantheon's image-vision plugin
(native multimodal model via the opencode Zen endpoint, or MCP tool fallback).
**Usage:** `/pantheon-vision [--global]`
**When:** First-time setup, changing the vision model, troubleshooting images
not being described, switching between native and tool mode.

## Steps

1. **Check connectivity & key source**
   - Read the opencode auth store: `<data dir>/auth.json`
     (default `~/.local/share/opencode/auth.json`, provider entries
     `opencode-go` then `opencode`) via `readOpencodeAuthToken`.
   - Report whether the user is connected (`opencode auth login`) or has an
     env key (`PANTHEON_OPENCODE_API_KEY` / `OPENCODE_API_KEY`).
   - **Never log or echo the token itself** — only connected/not connected.

2. **Show current status**
   - Effective mode precedence: env `PANTHEON_VISION_MODE` > config file
     `mode` > default `auto`.
   - Read the current config file if present (project `.opencode/opencode-vision.json`
     then user `~/.config/opencode/opencode-vision.json`).

3. **Ask what to set (interactive)**
   - **Mode:** `native` | `tool` | `auto`
     - `native` — describe images via the multimodal model directly (needs key)
      - `tool` — always use the MCP tool fallback (`imageAnalysisTool`)
     - `auto` — try native first, fall back to the tool (default)
   - **Vision model:** e.g. `opencode-go/mimo-v2.5`, `opencode-go/minimax-m3`,
     or an explicit override (precedence: env `PANTHEON_VISION_MODEL` > config
     `visionModel` > active preset `vision.model` > default `opencode-go/mimo-v2.5`).
    - **Tool fallback:** `imageAnalysisTool` (default
      `pantheon_vision_vision_describe`). Bifrost is opt-in only when
      explicitly selected here or through `PANTHEON_VISION_TOOL`.

4. **Save the config**
   - Default: project config `.opencode/opencode-vision.json`
     (merged with the user config `~/.config/opencode/opencode-vision.json`;
     project wins on conflicts).
   - `--global` → write to `~/.config/opencode/opencode-vision.json`.
   - Shape:
     ```json
     {
       "mode": "auto",
       "visionModel": "opencode-go/mimo-v2.5",
        "imageAnalysisTool": "pantheon_vision_vision_describe"
     }
     ```
   - Optional fields also supported: `models` (model wildcard patterns),
     `promptTemplate` (with `{imageList}`/`{imageCount}`/`{toolName}`/`{userText}`).

5. **Wrap up**
   - Tell the user to restart opencode (config is read at startup / per turn)
     and test by pasting an image with a question.
   - If no key and no auth store entry exist, recommend `opencode auth login`
     (native mode) or leaving the tool fallback enabled.

## Rules

- Do NOT print tokens or auth.json contents.
- Do NOT overwrite existing config keys not being changed — merge.
- If the config file is corrupted JSON, warn and ask before overwriting.
