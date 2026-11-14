# Guia Completo de Instalação do Pantheon (OpenCode 2.x)

> 🇺🇸 **English version available:** [Read in English](../INSTALLATION.md)

O Pantheon **requer o OpenCode 2.x** como host (o contrato da geração OpenCode 1.x foi completamente removido). A instalação padrão é realizada através do instalador `npx pantheon-opencode init`, que implanta todo o ecossistema: 14 agentes especialistas, 25 skills, regras de contexto (TDD, YAGNI), comandos de chat, interface TUI e servidores MCP locais.

---

## Início Rápido (TL;DR)

```bash
# Instalação Global (recomendada para todos os projetos da máquina)
npx pantheon-opencode init

# Instalação Restrita ao Projeto Atual
npx pantheon-opencode init --project

# Modo Não-Interativo (Headless) para Automação e CI
npx pantheon-opencode init -y

# Visualização de Plano sem Modificações em Disco (Dry-Run)
npx pantheon-opencode init --dry-run

# Diagnóstico de Integridade e Saúde
npx pantheon-opencode doctor
```

---

## Fluxo do Instalador (Ciclo de Vida)

O diagrama abaixo ilustra o comportamento do instalador, desde a detecção do host até a escrita atômica com backup automático:

```mermaid
flowchart TD
    Start(["🚀 npx pantheon-opencode init"]) --> HostCheck{"Verificar Host OpenCode"}
    HostCheck -->|Versão < 2.x| RejectHost["❌ Erro: Requer OpenCode 2.x (Falha de geração)"]
    HostCheck -->|OpenCode 2.x OK| ModeChoice{"Interativo (TTY)?"}

    ModeChoice -->|Sim| PromptScope["Selecionar Escopo: Global ou Projeto"]
    PromptScope --> PromptComp["Selecionar Componentes (agents, skills, tui...)"]
    PromptComp --> BuildPlan["Construir Plano Atômico de Instalação"]

    ModeChoice -->|Não (Headless)| CheckYes{"Flag --yes fornecida?"}
    CheckYes -->|Não| DryRunOnly["Visualização do Plano (Exit Code 2 sem alterações)"]
    CheckYes -->|Sim| BuildPlan

    BuildPlan --> BackupPhase["📦 Criar Backup Exato (modo 0600) em .pantheon/backups/"]
    BackupPhase --> WriteFiles["✏️ Escrita Atômica dos Arquivos Selecionados"]
    WriteFiles --> DoctorCheck["🩺 Auto-diagnóstico de Saúde (Doctor)"]
    DoctorCheck --> Complete(["✅ Instalação Concluída com Sucesso"])
```

---

## Pré-requisitos do Sistema

| Requisito | Versão Mínima | Finalidade |
|---|---|---|
| **OpenCode** | `>= 2.0.0` | Host nativo de execução dos agentes e do plugin. |
| **Node.js** | `>= 26.4.0` | Execução do CLI, scripts de empacotamento, compilação e TUI. |
| **Python** | `>= 3.11` *(Opcional)* | Ambiente virtual para servidores MCP locais em Python. |
| **Git** | `>= 2.30` | Suporte a worktrees para execução concorrente de subagentes. |

> [!WARNING]
> Versões anteriores do Node.js (Node 22, Node 24 e versões Node 26 inferiores a 26.4.0) não são suportadas pelo motor de regras e pelo CLI do Pantheon.

---

## Escopos de Instalação: Global vs. Projeto

O Pantheon pode ser configurado em dois escopos distintos:

### 1. Instalação Global (Recomendada)
- **Localização:** `~/.config/opencode/` (ou `$XDG_CONFIG_HOME/opencode/`).
- **Comportamento:** Fica disponível imediatamente para qualquer repositório ou pasta em que você abrir o OpenCode no seu sistema.
- **Estrutura de Pastas Gerada:**
  - `agents/`: Definições dos 14 agentes especialistas (`zeus.md`, `athena.md`, etc.).
  - `skills/`: Diretório com as 25 skills canônicas.
  - `commands/`: Comandos customizados do OpenCode (`/pantheon`, `/pantheon-deepwork`).
  - `plugins/pantheon-tui/`: Payload compilado da interface visual TUI.
  - `opencode.json`: Registro central de agentes, plugins e servidores MCP.

### 2. Instalação Restrita ao Projeto (`--project`)
- **Localização:** `.opencode/` na raiz do repositório atual.
- **Comportamento:** As regras, agentes e configurações ficam limitados estritamente ao diretório corrente, ideal para projetos com restrições corporativas específicas ou times que compartilham configurações versionadas.
- **Comando:**
  ```bash
  npx pantheon-opencode init --project
  ```

---

## Referência Completa de Flags do CLI

| Flag | Descrição |
|---|---|
| `--project` | Direciona a instalação para o diretório local do projeto atual (`.opencode/`). |
| `--dry-run` | Calcula e exibe todas as alterações planejadas em formato de tabela sem gravar nada em disco. |
| `--save-plan <caminho>` | Salva o plano auditado em um arquivo JSON canônico para aprovação em esteiras de segurança. |
| `--apply-plan <caminho>` | Executa a instalação estritamente baseada em um plano previamente auditado e salvo. |
| `--yes`, `-y` | Ignora prompts interativos e autoriza a execução com os padrões recomendados. |
| `--components <lista>` | Especifica uma lista separada por vírgulas de componentes (`agents,skills,instructions,commands,plugins`). |
| `--preset <nome>` | Instala e ativa imediatamente um preset de modelos (ex: `balanced`, `quality`, `budget`). |
| `--no-mcp` | Ignora a criação do ambiente virtual Python e a configuração dos servidores MCP. |
| `--force` | Sobrescreve arquivos gerenciados existentes e recria o ambiente virtual do zero. |
| `--clean` | Remove arquivos legados órfãos de versões anteriores durante a instalação. |
| `--verbose` | Exibe logs detalhados de cada fase de escrita e sincronização. |
| `--headless` | Força a execução não-interativa (útil para automações e contêineres). |
| `--decision-model <id>` | Configura o modelo Jev para roteamento de complexidade (ex: `opencode-console-jev/jev-1.13`). |
| `--decision-monthly-usd <v>` | Define o teto mensal de gastos em USD para o roteador de decisões. |

---

## Códigos de Saída (Exit Codes)

O CLI do Pantheon segue rigorosamente os códigos de saída do padrão POSIX para automações:

- **`0` — Sucesso:** Instalação concluída com sucesso ou plano exibido e recusado pelo usuário de forma segura.
- **`1` — Falha Genérica:** Erro de I/O, sintaxe inválida de flag ou dependência faltante.
- **`2` — Aplicação Não Autorizada:** Execução em modo headless/não-interativo sem a presença da flag `--yes`.
- **`3` — Detecção de Drift:** Um arquivo previsto no plano foi alterado externamente antes da execução (`fail-closed`).
- **`130` — Interrupção pelo Usuário:** O processo foi cancelado via `Ctrl+C` (SIGINT) sem alterar o disco.

---

## Validação de Integridade (`doctor`)

Após instalar ou atualizar o Pantheon, execute o diagnóstico de integridade:

```bash
npx pantheon-opencode doctor
```

### O que o Doctor Verifica:
1. **Manifestos e Integridade:** Integridade dos hashes SHA256 dos scripts de runtime.
2. **Registro de Plugins:** Presença do pacote `pantheon-opencode` e da TUI em `opencode.json`.
3. **Servidores MCP Locais:** Conexão e handshake JSON-RPC dos 5 servidores locais em Python.
4. **Permissões do Sistema:** Conformidade das permissões nos diretórios de backup e configurações (modo `0600`).
5. **Node Runtime:** Disponibilidade do driver `node:sqlite` para o módulo de telemetria de custos (`pantheon_cost`).

---

## Backups Atômicos e Restauração Segura

Antes de qualquer modificação no disco, o instalador cria um snapshot exato e completo em:
```text
~/.config/opencode/.pantheon/backups/<timestamp>/
```
Cada backup é criado com permissões restritivas (modo `0600`) para proteger credenciais existentes.

### Restaurando um Backup:
Caso queira reverter sua configuração para um estado anterior:

```bash
# Restaura o backup mais recente de forma interativa
npx pantheon-opencode restore

# Restaura o backup do projeto local
npx pantheon-opencode restore --project --yes
```

---

## Otimização e Limpeza do Espaço

Projetos com muitas sessões de `/pantheon-deepwork` acumulam logs e checkpoints. O Pantheon oferece comandos seguros para manutenção:

```bash
# Visualiza planos antigos arquiváveis e logs que podem ser limpos
npx pantheon-opencode optimize

# Aplica a otimização e limpeza
npx pantheon-opencode optimize --apply

# Remove backups obsoletos com mais de 30 dias
npx pantheon-opencode prune --apply
```

---

## Desinstalação

Para desinstalar o Pantheon mantendo suas configurações pessoais e projetos intactos:

```bash
# Remove os componentes globais com segurança
npx pantheon-opencode uninstall --global

# Remove as configurações restritas ao projeto atual
npx pantheon-opencode uninstall --project
```
O processo de desinstalação remove apenas os arquivos catalogados como gerenciados pelo Pantheon, preservando configurações manuais e chaves de provedores em `opencode.json`.
