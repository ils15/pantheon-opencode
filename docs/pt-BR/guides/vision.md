# Pantheon Vision: Análise Visual e Inspeção de Telas

> 🇺🇸 **English version available:** [Read in English](../../guides/vision.md)

O **Pantheon Vision** conecta modelos multimodais de visão computacional ao OpenCode, permitindo que você compartilhe capturas de tela, designs e layouts para implementação, depuração e inspeção sem atrito.

---

## 1. Como Usar no Dia a Dia

Para inspecionar ou ajustar uma interface:
1. Tire uma captura de tela da tela ou do componente com erro/design desejado.
2. No OpenCode (TUI ou Desktop), **cole a imagem da área de transferência (`Ctrl+V` / `Cmd+V`)**.
3. Digite sua instrução:
   ```text
   ajustar isso daqui, criar um menu lateral responsivo e atualizar as métricas
   ```

---

## 2. Zero Artefatos no Chat (Arquitetura Limpa)

Nas versões legadas, colar uma imagem costumava injetar blocos confusos de texto e comentários HTML no meio da sua mensagem:

```text
<!-- pantheon-v2-visual-context -->
[Visual] "clipboard" at "/tmp/pantheon-vision/6ef92982...png" · Q: '...' · relay session_id=...
```

Na versão moderna do Pantheon:
* **Sua mensagem permanece 100% limpa:** A interface exibe apenas o texto que você digitou.
* **Injeção Silenciosa em Contexto de Sistema:** As referências da imagem e os metadados de inspeção são injetados diretamente no hook `session.context` (`system`). O modelo de IA recebe todas as instruções nos bastidores, sem poluir visualmente a conversa.

---

## 3. Fallback Automático para Modelos Textuais

Se você estiver utilizando um modelo principal que é puramente textual (ou cujo gateway não aceita imagens diretamente):
* O Pantheon **não falha** e não responde que é incapaz de ler a imagem.
* O Pantheon invoca automaticamente o servidor multimodal configurado (`describeImagesNative` / Zen Go), extrai a descrição estruturada da interface (layout, textos visíveis, botões, métricas numéricas e cores) e entrega ao modelo textual.
* O modelo textual passa a "enxergar" a tela por meio da descrição de alta fidelidade e prossegue com a implementação normalmente.

---

## 4. Configurando seu Modelo de Visão Preferido

Você pode escolher qual modelo realiza a inspeção de imagens:

### Opção A — Pela TUI (Interface Gráfica de Terminal)
1. Abra a TUI com `pantheon tui` ou acesse a aba de configurações.
2. Navegue até a aba **Settings** ➔ sub-aba **Preset**.
3. Localize a linha **Vision Model** (`preset.vision_model`).
4. Alterne para o modelo desejado (padrão `auto`, `opencode-go/mimo-v2.6-flash`, `anthropic/claude-3-5-sonnet`, `google/gemini-2.5-flash`, etc.).
5. As alterações são salvas automaticamente no arquivo canônico `opencode-vision.json`.

### Opção B — Via Arquivo de Configuração
Crie ou edite `.opencode/opencode-vision.json` no seu projeto:

```json
{
  "visionModel": "opencode-go/mimo-v2.6-flash"
}
```

### Opção C — Via Variável de Ambiente
```bash
export PANTHEON_VISION_MODEL="opencode-go/mimo-v2.6-flash"
```

---

## 5. Boas Práticas ao Trabalhar com a @aphrodite (Frontend)

Ao enviar imagens para alterações visuais:
* **Uma imagem é contexto, não autorização para reverter trabalho:** A `@aphrodite` compara a imagem com a UI existente e preserva o código funcional já implementado.
* **Declare a intenção:** Indique se a imagem é um *design desejado (mockup)*, um *bug visual em produção* ou uma *referência estética de inspiração*.
* **Acessibilidade primeiro:** Ao implementar uma tela baseada em imagem, a `@aphrodite` sempre aplica conformidade com WCAG (contraste adequado, tags semânticas e acessibilidade de teclado).
