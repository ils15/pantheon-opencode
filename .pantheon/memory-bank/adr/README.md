# ADR Index — `.pantheon/memory-bank/adr/`

> Managed by `@mnemosyne`. ADRs aqui registram decisões aprovadas de arquitetura/release.
> Este índice lista **exatamente** os arquivos presentes neste diretório — nenhuma entrada
> aponta para arquivo ausente, e nenhum arquivo presente fica sem entrada.
> Reconciliação: 2026-10-22 (`@mnemosyne`), a pedido da abertura da exceção de git para
> `.pantheon/memory-bank/adr/`. Total: **7 ADRs**.

| ID | Title | File | Date | Status |
|----|-------|------|------|--------|
| ADR-0007 | Padronização de Release (semver 1.x + Single Source of Truth) | `0007-release-standardization.md` | 2026-08-05 | Accepted |
| ADR-0008 | Instalação Global do pantheon-opencode no opencode 1.18 (Hooks via spawn + MCP Hermetizado) | `0008-hooks-mcp-global-install.md` | 2026-08-05 | Accepted |
| — | **ADR-0009 — id não usado (ver nota abaixo)** | — | — | — |
| ADR-0010 | Roteamento de documentação — projeto vs sistema (P0-1) | `0010-roteamento-documentacao-projeto-vs-sistema.md` | 2026-08-06 | Accepted |
| ADR-0011 | Delegation Engine Contract — Legacy vs Native | `0011-delegation-engine-contract.md` | 2026-09-13 | Accepted |
| ADR-0012 | Contrato B1–B6 + Thresholds + SemVer 1.6=dual (proposta oficial) | `0012-contrato-b1-b6-thresholds-semver.md` | 2026-10-08 | Proposed |
| ADR-0013 | Contrato de medição da fatia beta-10 (latência) + limites de evidência V1/V2 | `0013-contrato-de-medicao-beta-10-latency.md` | 2026-10-14 | Accepted — **needs confirmation** |
| ADR-0014 | Release da `v1.6.0` stable — decisões de corte (Q1–Q7), matriz de hosts e Known Issues | `0014-release-v1-6-0-stable-decisoes-e-matriz.md` | 2026-10-22 | Accepted |

## ADR-0009 — lacuna de id

O id **ADR-0009 não existe e não foi usado**: não há arquivo `0009-*` neste diretório nem
em `.pantheon/`, e a busca por `ADR-0009` em toda a árvore `.pantheon/` não retorna
nenhuma referência. A numeração saltou de 0008 para 0010. O motivo do salto não está
registrado em lugar nenhum do memory bank.

**Não renumerar.** Os ids existentes são imutáveis (regra de ADR); 0009 fica reservado
como lacuna conhecida até decisão humana explícita de reutilizá-lo ou declará-lo queimado.

## Série legada — fora deste diretório (não movida)

Estes ADRs existem e são referenciados pelo restante do memory bank, mas **permanecem onde
estão**. Não foram movidos nem renumerados por esta reconciliação:

| ID | Title | Real path | Date | Status |
|----|-------|-----------|------|--------|
| ADR-005 | Pantheon v1.0 — OpenCode-Only | `../ADR-005-v5-opencode-only.md` (raiz do memory bank) | 2026-07-24 | Accepted |
| ADR-006 | Slash Commands Consolidation (16 → 5) | `../ADR-006-slash-commands-consolidation.md` (raiz do memory bank) | 2026-07-29 | Accepted |
| ADR-006 | Memory Persistence Protocol | `../_notes/ADR-006-memory-persistence-protocol.md` | 2026-07-21 | Accepted — **colisão de id** |

Além destes, `_notes/` contém a série curta `ADR-0001`–`ADR-0004`, `ADR-001` e `ADR-002`
(mais as NOTEs), indexada em `../_notes/_index.md`.

### ⚠ Colisão de id ADR-006

Dois documentos diferentes carregam `ADR-006`:

- `../ADR-006-slash-commands-consolidation.md` — 2026-07-29
- `../_notes/ADR-006-memory-persistence-protocol.md` — 2026-07-21

**Nada foi renumerado.** A resolução é decisão humana (renumerar um dos dois, ou aceitar a
série legada como namespace separado com sufixo de data). Este índice apenas documenta o fato.

## Pendências que exigem decisão humana

1. **Colisão ADR-006** — dois arquivos com o mesmo id (acima). Bloqueia afirmar que a série
   legada está unívoca.
2. **ADR-0009** — id pulado sem registro de motivo; decidir se fica queimado ou é reutilizado.
3. **ADR-0013 status** — o arquivo declara `**Accepted** (2026-10-14 — F-15; era *Proposed*)`,
   mas a transição F-15 não tem nenhuma outra evidência in-repo (busca por `F-15` em
   `.pantheon/` retorna zero). O índice reflete o arquivo (`Accepted`) e marca
   **needs confirmation**; o arquivo **não foi editado**.
4. **Escopo da exceção de git** — a exceção planejada cobre apenas `adr/`, portanto
   ADR-005 e ADR-006 (raiz e `_notes/`) continuam fora do versionamento. Se a intenção é
   versionar "toda a série", a exceção precisa cobrir esses três caminhos também.
5. **`_notes/_index.md` omite ADR-005** — documentado aqui para não se perder; o arquivo
   `_notes/_index.md` não foi alterado nesta tarefa.

## Notes

- Títulos das entradas acima foram normalizados a partir do `# ADR-00XX: ...` (H1) de cada
  arquivo. O índice anterior de ADR-0012 trazia "Thresholds 20/10/5pp" no título, detalhe
  que **não** está no H1 do arquivo; o título aqui segue o arquivo.
- `README.md` é o índice do diretório, não um ADR — por isso não aparece na tabela.
