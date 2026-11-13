# Início Rápido (Quick Start)

> 🇺🇸 **English version available:** [Read in English](../QUICKSTART.md)

Os primeiros dez minutos: instalar, reiniciar o OpenCode, despachar o primeiro comando e conferir o resultado. Detalhes completos sobre flags de instalação, códigos de saída e backups estão no guia de [Instalação](INSTALLATION.md).

---

## Antes de Começar

Você precisa do OpenCode instalado e de uma versão suportada do Node.js (Node >=26.4.0). Os requisitos detalhados e evidências por ambiente estão documentados em [Compatibilidade](../COMPATIBILITY.md). O Python 3.11+ é opcional, necessário apenas se você for utilizar servidores MCP em Python.

---

## 1. Instalação

Na raiz do projeto onde deseja usar o Pantheon:

```bash
npx pantheon-opencode init
```

O instalador interativo permite escolher os componentes desejados e se a configuração será global ou restrita ao projeto atual. O componente `plugins` vem selecionado por padrão e instala a **TUI** (interface de terminal moderna). Cancelar a qualquer momento não altera nada no disco.

---

## 2. Reiniciar o OpenCode

```bash
opencode
```

É necessário reiniciar o OpenCode após instalar ou atualizar o plugin para que as extensões sejam carregadas.

Com a TUI ativa, a barra lateral exibe a versão do Pantheon, o preset ativo, o estado do git e um bloco de `Context` com tokens consumidos, custos estimados e velocidade de cache.

---

## 3. Verificar a Instalação

```bash
npx pantheon-opencode doctor
```

O comando `doctor` valida a integridade do pacote, o registro do plugin no OpenCode, os servidores MCP conectados e eventuais divergências de versão. Uma instalação saudável reporta zero erros e zero avisos.

---

## 4. Seu Primeiro Despacho

Inicie uma conversa no chat do OpenCode e chame o `@zeus` para orquestrar sua demanda:

```text
@zeus Crie um endpoint GET /health em Node.js com testes unitários usando Node test runner nativo.
```

O `@zeus` analisa o escopo da tarefa:
1. Delega a arquitetura e planejamento para a `@athena`.
2. A `@athena` estrutura as fases e critérios de aceite. Caso haja decisões de design em aberto, elas são apresentadas interativamente via ferramenta nativa `question`.
3. Após aprovação, `@zeus` despacha a implementação em TDD para o `@hermes`.
4. A `@themis` audita o código gerado, garantindo conformidade de estilo, segurança e testes passando.
5. `@zeus` apresenta o resumo do trabalho concluído e o relatório de tokens e custos.

---

## Próximos Passos

- Conheça os papéis e limites de cada agente: [Matriz de Capacidades dos Agentes](AGENT-CAPABILITY-MATRIX.md)
- Aprenda o fluxo completo em um projeto real: [Guia do Primeiro Projeto](guides/first-project.md)
- Explore o planejamento estruturado: [Blueprint do Deepwork](guides/deepwork.md)
- Veja soluções para tarefas do dia a dia: [Livro de Receitas (Cookbook)](guides/cookbook.md)
