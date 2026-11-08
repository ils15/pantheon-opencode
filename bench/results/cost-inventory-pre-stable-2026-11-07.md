# Levantamento de custo — skills, agentes e Jev (pré-stable, 2026-11-07)

## Os 3 níveis medidos

| Nível | O que é | Medido |
|---|---|---|
| **1. Descoberta** (fixo, toda sessão) | 22 descriptions de skills + 14 descriptions de agentes | **~1.282 tokens** (666 skills + 616 agentes) |
| **2. Ativação** (quando a skill dispara) | Corpo do SKILL.md | **17.171 tokens se TODAS dispararem** (nunca acontece; 2-4 por tarefa é o real) |
| **3. Execução** | references/, scripts | 0 skills têm references/ hoje — nada lazy-loadável ainda |

## Tier 1 — o custo fixo que você paga sempre (~1.282 tok)

Skills: **666 tok** (agent-forge 86 é a maior — justo, é a skill mais nova e complexa).
Agentes: **616 tok** (mnemosyne 74, hephaestus 54, iris 53...). Zeotipe: zeus 22 é enxuto ✓.

**Otimize primeiro AQUI** — é custo fixo. Regra: description em 3ª pessoa, "o que faz + Use when <triggers>". As maiores (agent-forge 86, prompt-refinery 68) estão no limite aceitável por serem as mais novas — candidatos a enxugar na próxima passada.

## Tier 2 — as gordas (só custam quando disparadas)

| Skill | tokens | nota |
|---|---|---|
| auto-continue | 2.656 | **a mais gorda** — candidato a references/ (core loop curto + detalhes em refs) |
| visual-review-pipeline | 1.858 | idem (fluxo detalhado → references/) |
| tdd-with-agents | 1.462 | idem |
| memory-bank | 1.395 | idem |
| session-goal | 1.090 | idem |
| code-review-checklist | 921 | idem |
| agent-forge | 845 | ok por ser skill de forja complexa |
| ...as demais | <900 | saudáveis |

Se todas disparassem: 17.171 tok. Real: 2-4 skills/tarefa ≈ 1-3k tok — aceitável.

## Jev — custo REAL do ledger (não estimativa)

- **275 decisões reconciliadas: $0.0068 acumulado** (nov)
- Média: **$0.000025/decisão** — 40 decisões por centavo
- 33 holds antigos openrouter continuam congelados até o rolamento do período (1/dez)

## Candidatos a `disable-model-invocation` (skills de rotina do usuário)

Nenhuma skill atual é rotina-pura do usuário — todas são de fluxo de agente. A flag entra em cena quando você criar skills pessoais (template de cupom, formato de post): essas com a flag custam ZERO no baseline.
