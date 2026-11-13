# Pantheon Vision: Visual Inspection and Multimodal Debugging

> 🇧🇷 **Versão em Português disponível:** [Leia em Português](../pt-BR/guides/vision.md)

**Pantheon Vision** connects multimodal vision models to OpenCode, allowing you to paste screenshots, mockups, and UI layouts directly into chat for effortless implementation, debugging, and inspection.

---

## 1. Everyday Workflow

To inspect or refine an interface:
1. Capture a screenshot of the target screen, component, or visual bug.
2. In OpenCode (TUI or Desktop), **paste the image from clipboard (`Ctrl+V` / `Cmd+V`)**.
3. Type your instructions naturally:
   ```text
   Adjust this layout: build a responsive sidebar navigation matching these metrics
   ```

---

## 2. Zero Prompt Clutter (Clean Architecture)

In legacy versions, pasting an image injected raw comment blocks and temporary file paths directly into your message text:

```text
<!-- pantheon-visual-context -->
[Visual] "clipboard" at "/tmp/pantheon-vision/6ef92982...png" · Q: '...' · relay session_id=...
```

In modern Pantheon:
* **Your message remains clean:** The chat only shows the text you typed.
* **Silent Context Injection:** Image references and metadata are injected directly through the `session.context` (`system`) hook. The agent receives full visual context behind the scenes without polluting chat history.

---

## 3. Automatic Fallback for Text-Only Models

If your active chat model does not natively support multimodal vision:
* Pantheon **does not fail** or throw an unsupported model error.
* Pantheon automatically delegates image inspection to the configured vision server (`describeImagesNative` / Zen Go), extracting layout structure, visible text, buttons, numbers, and color palettes.
* The text model receives this high-fidelity description and implements the requested change seamlessly.

---

## 4. Configuring Your Vision Model

You can configure which model handles visual inspection:

### Option A — Through the TUI
1. Open the TUI with `pantheon tui`.
2. Go to the **Settings** tab ➔ **Preset** sub-tab.
3. Select **Vision Model** (`preset.vision_model`).
4. Choose from supported providers (e.g., `gemini-2.5-flash`, `qwen3.7-vl`, `claude-3-5-sonnet`).

### Option B — Via CLI
Configure the vision model directly from your terminal:

```bash
# List available vision-capable models
npx pantheon-opencode vision --list

# Set project-scoped vision model
npx pantheon-opencode vision --set opencode-go/gemini-2.5-flash

# Set globally for all projects
npx pantheon-opencode vision --global --set opencode-go/gemini-2.5-flash
```

Settings are persisted in `.opencode/opencode-vision.json`.
