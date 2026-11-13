# Guia de Instalação do Pantheon (OpenCode 2.x)

> 🇺🇸 **English version available:** [Read in English](../INSTALLATION.md)

O Pantheon **requer o OpenCode 2.x** (o contrato legado do OpenCode V1 foi removido a partir da versão 2.0). Há duas maneiras complementares de instalação: carregar o plugin diretamente pelo fluxo nativo do OpenCode, ou usar o assistente interativo `npx pantheon-opencode init` para instalar todo o conjunto de agentes, skills, comandos e interface de terminal.

---

## Início Rápido (TL;DR)

```bash
# Recomendado: Carregar o plugin através do OpenCode nativo
opencode plugin add pantheon-opencode

# Conjunto completo: agentes, skills, instruções, comandos, TUI e MCPs
npx pantheon-opencode init

# Prévia sem confirmação interativa (headless preview)
npx pantheon-opencode init --headless

# Instalação automática com opções padrão (headless apply)
npx pantheon-opencode init --headless --yes

# Verificar integridade da instalação
npx pantheon-opencode doctor
```

---

## Pré-requisitos do Sistema

1. **Host:** OpenCode 2.x suportado (consulte [Compatibilidade](../COMPATIBILITY.md)).
2. **Node.js:** Versão `>=26.4.0` para o CLI do Pantheon, ferramentas de empacotamento e compilação do TUI.
3. **Python (Opcional):** Versão `3.11+` para servidores MCP em Python.

---

## Modos de Instalação

### 1. Instalação Interativa com Wizard

Ao executar `npx pantheon-opencode init`, um assistente no terminal guia a configuração:

- **Escopo:** Escolha entre **Global** (`~/.config/opencode/`) para que todos os seus repositórios tenham acesso aos agentes, ou **Projeto** (`.opencode/`) para manter as configurações restritas ao repositório atual.
- **Componentes:**
  - `agents`: 14 personas de agentes especialistas (`@zeus`, `@athena`, `@hermes`, etc.).
  - `skills`: 25 habilidades modulares para workflows e ferramentas.
  - `instructions`: Regras canônicas de TDD, economia de contexto, YAGNI e comunicação.
  - `plugins`: Plugin do Pantheon e a interface TUI moderna.
  - `commands`: Comandos de atalho para o chat (`/pantheon`, `/pantheon-deepwork`, etc.).

### 2. Instalação em CI / Automação (Headless)

Para ambientes de integração contínua (CI), scripts de setup de máquina ou contêineres Docker:

```bash
npx pantheon-opencode init --headless --yes
```

Esse comando cria o backup do estado prévio, instala os componentes padrão e finaliza com código de saída `0` quando bem-sucedido.

---

## Validação e Diagnóstico (`doctor`)

Após instalar ou atualizar, valide o ambiente:

```bash
npx pantheon-opencode doctor
```

O `doctor` verifica:
- Permissões do sistema de arquivos e integridade dos manifestos.
- Registro correto do plugin em `opencode.json`.
- Conexão e status dos 5 servidores MCP embarcados.
- Versões dos pacotes instalados vs executáveis em execução.

---

## Backups e Restauração Segura

O instalador cria automaticamente um backup exato antes de qualquer modificação em:
`~/.config/opencode/.pantheon/backups/<timestamp>/` (ou no diretório do projeto).

Para restaurar um backup anterior a qualquer momento:

```bash
npx pantheon-opencode restore
```

---

## Desinstalação

Para remover os componentes gerenciados pelo Pantheon mantendo suas alterações manuais intactas:

```bash
npx pantheon-opencode uninstall
```

Para uma remoção forçada sem prompts interativos:

```bash
npx pantheon-opencode uninstall --yes
```
