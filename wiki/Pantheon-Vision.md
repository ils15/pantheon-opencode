# Pantheon Vision: Análise Visual

O **Pantheon Vision** permite inspecionar interfaces visuais e designs colando imagens diretamente no OpenCode.

---

## Como Usar

1. Copie qualquer imagem para a área de transferência (`Ctrl+C` ou captura de tela).
2. Cole no chat do OpenCode (`Ctrl+V`).
3. Digite sua instrução:
   ```text
   ajustar isso daqui, criar um menu lateral responsivo e atualizar os cards
   ```

---

## Configuração do Modelo Visual

Você pode configurar o modelo que faz a análise de imagem:
* **Na TUI:** `pantheon tui` ➔ **Settings** ➔ **Preset** ➔ **Vision Model**.
* **No arquivo:** `.opencode/opencode-vision.json`.
* **Por variável de ambiente:** `export PANTHEON_VISION_MODEL="opencode-go/mimo-v2.6-flash"`.
