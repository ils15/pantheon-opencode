# Exemplo: CLI Repo Health

Este exemplo demonstra uma ferramenta de linha de comando simples, rápida e testável em TypeScript/Node.js, construída seguindo a filosofia de **fast-path execution** dos agentes `@talos` e `@hermes` do Pantheon.

---

## ⚡ Como Funciona

A ferramenta inspeciona o repositório atual e gera um diagnóstico de saúde com pontuação de 0 a 100, verificando:
* Estado limpo do Git (arquivos não comitados)
* Presença de `package.json` com script `test`
* Presença de documentação `README.md`

---

## 🚀 Como Executar

### 1. Rodar os Testes

```bash
node --test tests/cli.test.mjs
```

### 2. Executar a CLI

```bash
node bin/repo-health.mjs
```

Ou formato JSON:

```bash
node bin/repo-health.mjs --json
```
