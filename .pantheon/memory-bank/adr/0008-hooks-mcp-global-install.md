# ADR-0008: Instalação Global do pantheon-opencode no opencode 1.18 (Hooks via spawn + MCP Hermetizado)

**Status:** Accepted
**Date:** 2026-08-05
**Approval:** Council 2026-08-05 — `council:2026-08-05:instalacao-global-pantheon-hooks-mcp` (3/3 especialistas, High confidence, 33 specific claims); implementado no PR #26; revisado por @themis (changes-requested → 3 issues corrigidos).
**Sources:** @prometheus, @hermes, @themis (council); @themis (audit gate)

## Context

A instalação global do pacote pantheon-opencode no opencode 1.18 apresentava 4 falhas:

1. **Plugin de hooks quebrado**: a implementação anterior usava o Bun Shell `$` injetado pela plugin API (`$.quiet().nothrow().timeout(...)`). `.timeout()` NÃO existe na interface BunShell do opencode 1.18 → TypeError em todo hook → camada de segurança de hooks removida (24-25/07).
2. **MCP servers falhando**: scripts MCP emitiam ENOENT na instalação global (path não resolvido); foi considerada a criação de um retry wrapper no plugin.
3. **Packaging incompleto**: `files[]` do package.json não incluía `src/plugins/**` nem `scripts/hooks/**` — glob npm não atravessa subdiretórios → plugins e 10 scripts hooks não publicados no npm.
4. **Sync MCP stale**: scripts MCP sincronizados da cópia raiz `scripts/` (stale) em vez de `src/mcp/` (fonte da verdade) → bug do `import uuid` ausente propagado para a instalação.

## Decision

### D1 — Runner de hooks com node:child_process spawn (não Bun Shell)
- Plugin recriado em `src/plugins/pantheon-hooks.ts` + runner dedicado `src/plugins/hook-runner.ts`.
- Runner usa SOMENTE `node:child_process` `spawn` — estável em todo Node >= 18 e todo loader de plugin opencode. Version-proof.
- Protocolo Claude Code: hooks recebem `{tool_name, tool_input, agent_id, session_id}` como JSON via stdin; scripts que leem env vars (log-session-start.sh, on-subagent-delegation-*) recebem SESSION_ID/AGENT_NAME/TASK_DESC mapeados no ambiente do filho (PATH preservado).
- `stdin.write(JSON)` + `stdin.end()` INCONDICIONAIS (mesmo para payload vazio) — o filho nunca bloqueia esperando input (evita o "Hook X timed out after 30000ms" do core).
- Timeout 15s + killSignal SIGKILL; maxBuffer 10MB; `stdio: 'pipe'` (nunca o TUI do opencode); windowsHide.
- Hooks NUNCA lançam: qualquer falha (script ausente, timeout, exit não-zero) → HookResult estruturado; a sessão opencode nunca cai pela camada de segurança.
- Empírico (documentado no runner): a opção `input:` do `execFile()` async é silenciosamente ignorada pelo Node — só existe em spawnSync/execFileSync → stdin escrito explicitamente no spawn.

### D2 — Retry wrapper de MCP REJEITADO; hermetização de paths
- opencode 1.18 NÃO expõe hook de reconnect de MCP servers falhados → retry é upstream (não é bug do pacote).
- Mitigação adotada: comandos MCP hermetizados com path absoluto (elimina ENOENT na origem) + doctor B.5 + documentação (restart cura).
- `python3 >= 3.8` documentado como pré-requisito (acoplamento frágil, tornado explícito).

### D3 — Packaging corrigido
- `files[]` do package.json += `src/plugins/**` e `scripts/hooks/**` (glob npm não atravessa subdiretórios — por isso a entrada explícita por nível).
- Self-reference beta `pantheon-opencode ^1.2.0-beta.9.7bef03e` removida.
- Pin exato `@opencode-ai/plugin` `1.18.11` na raiz (devDependencies) + `.opencode/package.json` e `~/.config/opencode/package.json` alinhados (1.18.5 → 1.18.11).

### D4 — Sync canônico de MCP scripts
- `scripts/install/opencode.mjs` `canonicalMcpScripts` expandido: MCP scripts SEMPRE sincronizados de `src/mcp/` (fonte da verdade), nunca da cópia raiz `scripts/` stale (causa-raiz do bug do `import uuid` em mcp_persistence_server.py).
- `scrub-secrets.py` (não presente em src/mcp/) cai no fallback `join(ROOT, 'scripts')`.

## Alternatives Considered

| Opção | Veredicto | Razão |
|---|---|---|
| Bun Shell `$` (plugin API) | ❌ Rejeitada | `.timeout()` não existe na interface BunShell do opencode 1.18 → TypeError em todo hook |
| Git hooks em vez de plugin | ❌ Rejeitada (prometheus propôs) | Não cobrem tool calls → regressão de segurança (themis: risco HIGH; gitleaks só cobre staged files) |
| Retry wrapper de MCP no plugin | ❌ Rejeitada (hermes propôs) | opencode 1.18 não expõe hook de reconnect de MCP; retry é upstream |
| `execFile` async com `input:` | ❌ Rejeitada (empírico) | Node ignora `input:` em execFile async |
| Sync MCP da cópia raiz `scripts/` | ❌ Rejeitada | Cópia stale propagou o bug do `import uuid` ausente |

## Consequences

### Positive
- Camada de segurança de hooks restaurada e version-proof (spawn estável em qualquer runtime/loader).
- Zero ENOENT na origem com paths hermetizados; diagnóstico padronizado via doctor B.5.
- Pacote npm global completo (plugins + 10 scripts hooks publicados via files[]).
- Sync MCP idempotente e canônico — bugs de fonte stale não propagam mais.
- Hooks impossibilitados de derrubar a sessão (nunca-throw).

### Negative
- `spawn` não invoca shell → comandos compostos exigem wrapper .sh (scripts já seguem esse padrão).
- Timeout 15s pode matar hooks longos (ex.: scan-secrets em repo grande); maxBuffer 10MB limita stdout.
- Retry de MCP permanece upstream: usuários dependem de restart + documentação (fricção residual).
- Pré-requisito python3 >= 3.8 explícito = acoplamento frágil documentado.

## Risks & Rollback

- **Risco**: hook longo morto por timeout em repo grande → mitigar com timeout configurável via `RunHookOptions` (já suportado).
- **Risco**: script sem permissão de execução → spawn ENOENT → HookResult código 1 (nunca crash da sessão).
- **Rollback**: reverter para o plugin anterior = camada de segurança ausente (regressão conhecida) → fix forward recomendado.
- **Proibido**: reintroduzir Bun Shell `$`; reintroduzir sync a partir da cópia raiz stale `scripts/`.

## Acceptance Criteria (resumo)

1. `npm pack` inclui `src/plugins/**` e `scripts/hooks/**` (10 scripts hooks presentes).
2. Hook roda em instalação global recebendo JSON via stdin, exit 0.
3. Hook em timeout → SIGKILL em 15s e a sessão não cai.
4. MCP server com path absoluto não emite ENOENT na origem.
5. Sync MCP copia de `src/mcp/` (hash igual à fonte canônica).
6. `@opencode-ai/plugin` == 1.18.11 em todas as árvores npm; zero self-reference beta.
7. doctor B.5 valida comandos MCP sem erro.

## References

- Council decision (memória): `council:2026-08-05:instalacao-global-pantheon-hooks-mcp` (namespace `council_decisions`)
- Implementação: PR #26 — `src/plugins/pantheon-hooks.ts`, `src/plugins/hook-runner.ts`, `scripts/install/opencode.mjs`, `package.json`, `.opencode/package.json`
- Review: @themis (audit gate) — 3 issues corrigidos: retry wrapper registrado, python3 pré-requisito, dist/plugins vs src/plugins textual
- Relacionados: ADR-0007 (padronização de release — pinning/packaging), NOTE0004 (hook compatibility & fallback strategy)
