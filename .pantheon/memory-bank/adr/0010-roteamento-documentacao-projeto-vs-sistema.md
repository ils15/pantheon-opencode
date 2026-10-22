# ADR-0010: Roteamento de documentação — projeto vs sistema (P0-1)

**Status:** Accepted
**Date:** 2026-08-06
**Approval:** Council 2026-08-06 — decisão P1-2, prioridade P0-1 (crítica). Decidido por: council 2026-08-06.
**Sources:** @zeus (roteamento), @mnemosyne (recusa registrada), @talos (re-roteamento + edição), audit findings (P1-1)

## Context

Incidente de delegação (2026-08-06): uma edição de README.md (documentação de PROJETO) foi roteada para @mnemosyne por correspondência de palavra-chave na árvore de roteamento de @zeus — linha `documentacao, memory-bank, ADRs -> @mnemosyne` em `src/agents/zeus.md`. Mnemosyne recusou corretamente (`edit: deny`): o alvo (README.md) está fora do guard de escopo "Memory Bank ONLY". A edição foi então re-roteada para @talos, que a executou.

**Causa raiz:** correspondência por palavra-chave em vez de capacidade. O token "documentacao" capturou tanto docs de PROJETO (README.md, docs/, changelog) quanto docs de SISTEMA (.pantheon/memory-bank/, ADRs, task records), mas apenas Mnemosyne carrega o guard que impede escrita fora de `.pantheon/`.

**Achados de auditoria relacionados (P1-1):**
- `scripts/hooks/validate-talos-scope.sh` apontado como dead code — o guard real do escopo de Mnemosyne é interno do agente, não hook PreToolUse.
- Telemetria honesta: o incidente só veio à tona porque Mnemosyne registrou a recusa em vez de contorná-la; recusas não eram reportadas (P1-1 — telemetria de recusas passa a ser reportada).

## Decision

### D1 — Árvore de roteamento desambiguada por tipo de doc
- **Documentação de PROJETO** (README.md, docs/, changelog) → @talos (trivial) | implementador (técnica) | @iris (changelog/release).
- **Documentação de SISTEMA** (.pantheon/memory-bank/, ADRs, task records) → @mnemosyne.

### D2 — Regra de escopo explícita: "fora de .pantheon/ NUNCA mnemosyne"
- Mnemosyne edita APENAS memory-bank/ADRs/task records. Nenhum alvo fora de `.pantheon/` é delegado a Mnemosyne.

### D3 — Taxonomia de recusa: re-rotear, nunca retry com prompt reformulado (P0-3)
- Recusa de um agente = sinal de agente errado → re-rotear para o agente com a capacidade correta.
- PROIBIDO retry com prompt reformulado no mesmo agente após recusa — ignora o guard de escopo e força trabalho fora de capacidade.

### D4 — Write-back no cache de delegação
- Registrar padrões no cache (`kv` namespace `delegation-cache`, TTL 30d): `documentacao-projeto` → talos/implementador/iris; `documentacao-sistema` → mnemosyne.
- Antes de despachar, consultar `kv_get`/`memory_search` no padrão de delegação — impede misrouting recorrente.

## Alternatives Considered

| Opção | Veredicto | Razão |
|---|---|---|
| Manter linha única `documentacao -> @mnemosyne` | ❌ Rejeitada | Causa direta do incidente — conflation projeto/sistema |
| Remover Mnemosyne de todo roteamento de docs | ❌ Rejeitada | Mnemosyne segue dona de system docs (memory-bank/ADRs/task records) |
| Hook validate-talos-scope como proteção de escopo | ❌ Rejeitada (P1-1) | Dead code; guard de escopo é interno do agente |
| Retry com prompt reformulado após recusa | ❌ Proibida (P0-3) | Recusa = agente errado; retry contorna o guard |

## Consequences

### Positive
- Edições de docs de projeto caem em agentes com capacidade de escrita (talos/implementador/iris) — sem bounce.
- Guard de escopo de Mnemosyne preservado para docs de sistema; a recusa continua sendo o comportamento correto.
- Cache de delegação (TTL 30d) previne misrouting repetido.
- Telemetria de recusas passa a ser reportada (P1-1) — falhas de roteamento ficam visíveis.

### Negative
- Custódia dupla de "documentação" exige árvore explícita mantida em zeus.md (linhas 116-117, 124).
- Cache TTL 30d expira — reincidência possível após expiração se a árvore estiver desatualizada.

### Neutral
- Mnemosyne continua recusando (`edit: deny`) qualquer alvo fora de `.pantheon/` — comportamento inalterado e correto.

## Risks & Rollback

- **Risco:** palavra-chave "documentacao" reaparecer em outro nó da árvore → mitigação: regra D2 explícita + cache D4.
- **Risco:** cache desatualizado rotear doc de sistema para implementador → follow-up: verificar guard equivalente para implementadores (P1-1).
- **Rollback:** reverter D1 = reintroduzir o incidente; fix forward recomendado.

## References

- Incidente: zeus → mnemosyne → recusa (edit: deny) → talos (README edit), 2026-08-06
- `src/agents/zeus.md` linhas 116-117 (árvore desambiguada), 124 (regra "fora de .pantheon/ NUNCA mnemosyne")
- `src/agents/mnemosyne.md` — Memory Bank ONLY scope boundary
- `scripts/hooks/validate-talos-scope.sh` — auditado como dead code (P1-1)
- Council decision (memória): `council:2026-08-06:roteamento-documentacao-projeto-vs-sistema`
- Task record: `TASK-020` (incidente registrado)
- Relacionado: ADR-0002 (single source of truth — routing.yml), ADR-0007/0008 (série atual em `adr/`)
