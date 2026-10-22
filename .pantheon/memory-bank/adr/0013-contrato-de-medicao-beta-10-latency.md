# ADR-0013: Contrato de medição da fatia beta-10 (latência) + limites de evidência V1/V2

**Status:** **Accepted** (2026-10-14 — F-15; era *Proposed*)
**Date:** 2026-10-14
**Author:** @mnemosyne (doc-only, por delegação)
**Branch:** `perf/beta10-latency`
**Plano vigente (RE-AIMED V2-first):** `.pantheon/deepwork/beta-10-latency/PLAN-v2-v2first.md` (fonte @athena/GPT-6.1-Sol, status *aguardando revisão Themis*)
**Plano anterior:** `.pantheon/deepwork/beta-10-latency/PLAN.md` — **SUPERSEDED** por `PLAN-v2-v2first.md` (2026-10-14)

> **Nota (2026-10-14) — re-aiming V2-first:** o contrato de medição (D1–D6) permanece
> válido. A cláusula **"adapter V2 sai da fatia"** (D3, abaixo) foi **superseded** pelo
> `PLAN-v2-v2first.md`: adapters V2 pequenos e necessários (bounded reading, admissão,
> instrumentação) **entram** na fatia. Histórico preservado — a linha original permanece
> marcada como superseded, sem remoção.

## Context

A fatia de deep work **beta-10** reduz contexto repetido e orquestração
desnecessária em tarefas delimitadas do pantheon-opencode (referência de origem:
**~2x vs Codex CLI — observação não reproduzida in-repo**, F-05). Sem um contrato
de medição explícito, ganhos não são comparáveis
entre fases e fica fácil atribuir otimização de uma superfície (V1) a outra
(V2), ou mascarar uma fase pela seguinte.

Duas descobertas forçam este contrato:

1. O host do bench roda **V2** → F2 (hooks V1) e parte de F3 (arquivos V1) **não
   têm delta E2E local**.
2. O runner do bench usa **symlink** dos prompts instalados do host e **ainda não
   está provado** que injeta o `AGENTS.md` de projeto.

## Decision

### D1 — Contrato de medição (aplica-se a toda a fatia)

- **N≥5 same-day**, A/B intercalados.
- **Nada de dois benches simultâneos.**
- **Nunca medir durante edições.**
- **Root + descendentes contados 1×.**
- Tools contados **só** por `parts` `type:'tool'`.
- **Métrica ausente = `unavailable`** (nunca 0).
- **Sessão concluída ≠ resposta correta** — validar artefatos.
- **Outliers ficam no relatório.**
- **Sinal vs ruído (F-09):** um efeito só é **confirmado** se **exceder o spread same-day** (ou exigir **N maior** para wall). Wall varia **≈8× em A** e **≈13× em B** → **wall é pista, não critério**; **preferir tokens** (F3 ≤25k in fica abaixo do mínimo observado de B, 33,9k → detectável).
- **Oráculo de correção (F-10):** "5/5 correto" = **"5/5 com checklist verde"** — **A:** `index.html`/`styles.css`/`app.js`, N carros, cada um com imagem real acessível, specs técnicas e link do fabricante; **B:** markdown com tabela dos 3 países e populações corretas.
- **Variância de rede (F-13):** **wall de A não é métrica de claim** (usar tokens); pin/cache das respostas web do A = melhoria do commit 3.

### D2 — Ganho incremental ≠ acumulado

Cada fase compara com o **checkpoint anterior** e com a **referência** (baseline
F0 / controle same-day). Hipóteses são **hipótese, não promessa**.

### D3 — Limites de evidência V1/V2 (sem claim cruzado)

- No host V2, **conversão V1 e cache V1 não têm delta E2E atribuível**; F2
  substitui evidência E2E por **golden shell↔TS + microbench cold/warm** e
  **declara a limitação**.
- **Métrica de F2 (F-03):** custo de **setup de child/validador em ms** no
  microbench cold/warm (payloads fixos); hipótese = **chain V1 in-process ≤50%
  do tempo da implementação spawn equivalente**.
- **Limite de instrumento (F-04/F-08):** os **~25ms** observados são do
  **before-hook handler da superfície V2** — **não** são baseline do microbench
  **V1** (comparação cruzada proibida). **Tokens incrementais** (F5) e
  **contexto do 1º request da child** (F4B) **não existem** no harness atual →
  **requer extensão de harness (commit 3)** antes de avaliáveis.
- **Proibido** atribuir ganho V1 ao V2 ou carregar V1 artificialmente para
  fabricar ganho.
- ~~`src/plugin.ts` não carrega no host V2 do bench; se F3 exigir adapter V2, **sai
  da fatia**.~~ **[SUPERSEDED 2026-10-14 por `PLAN-v2-v2first.md`: adapters V2 pequenos e
  necessários (bounded reading, admissão, instrumentação) **entram** na fatia; a
  necessidade de adapter V2 **não** retira a fase da fatia. Texto original preservado
  acima, riscado, por histórico.]**
- **Microbench F2 reportado separado do E2E.**

### D4 — Fidelidade do bench como pré-requisito

Antes de claims de F1/F5: **fixture congelada + hashes + prova do conteúdo
carregado** dos prompts instalados (incluindo o `AGENTS.md` de projeto).
**Condição dura (F-07/F-14a):** mudanças do próprio harness (**commit 3**) e a
prova de injeção do `AGENTS.md` de projeto são **gate obrigatório**; **não
provadas → _halt_ de F1/F5** — nenhum claim antes disso.

### D5 — Gates e decision points (vinculantes)

| Ponto | Gate | Se falhar |
|---|---|---|
| Sensíveis | Revisão do plano por Themis | recolher revisão antes de autorizar |
| F1 | preservação de prompts + config fiel | corrigir experimento/carving |
| F2 | golden + secret scan + **aprovação humana explícita** (secret scan/fail-closed + cache de providers) | bloquear/reduzir conversão |
| **Instrumento (commit 3)** | mudanças do harness + fidelidade **D4** | **condição dura**: sem isso, nenhum claim de F1/F5 |
| F3 | Themis + humano + reachability | plano B prompt-only |
| F4A | recusa antes do spawn | não aceitar pós-criação |
| F4B | SDK + canary + humano | deferir sem fallback silencioso |
| F5 | economia sem perda funcional | restaurar indispensável |
| Final | qualidade + instalação + evidências | sem PR pronto |
| Push/PR/merge | autorização humana | iris aguarda |

### D6 — Sem promessa de velocidade

Proibido no PR: promessa de **"2× mais rápido"**, promessa de redução de **p80**,
F6 sem medição, upgrade de SDK para salvar F4B, alterações globais no ambiente de
dev, push/merge/npm/release automáticos, código experimental sem reachability.
**F-05:** o claim **"~2x vs Codex CLI"** é observação **não reproduzida in-repo** —
**proibido** citá-lo como resultado; medir com o harness **ou** remover o número.

## Consequences

### Positive

- Comparabilidade entre fases e honestidade de escopo (sem claim V1→V2).
- Baselines UNKNOWN (F4A/F4B/F6) tratados como **medir antes**, não estimar.
- Resultado publicado **mesmo quando a hipótese falha**.
- **F-14b:** **"wall não move, tokens movem" é sucesso parcial aceitável**, registrado explicitamente (nem falha, nem ganho de wall).

### Negative

- Menos "vitórias" retóricas: partes de F2/F3 não geram delta E2E local e serão
  declaradas como tal.
- Custo de serialização de benches e commits reduz paralelismo.

## Risks & Rollback

- **Risco:** bench com prompts antigos / shadow config sem dupla injeção →
  mitigação: D4 (fixture congelada + hashes + prova do conteúdo carregado).
- **Risco:** `gitDirty:true` quebrando reprodução → limitação registrada (**F-11:**
  baseline **sem hash do diff/stash**; o commit 3 passa a **exigir** esse hash); F0 e
  `a305942` (chore(skills)) preservados separados dos claims de performance.
- **Rollback:** hipótese não confirmada é reportada como
  **confirmada / não confirmada / inconclusiva / deferred** — sem remover a
  evidência.

## References

- TASK-023 (beta-10 — Latência e cerimônia proporcional)
- Plano vigente (V2-first): `.pantheon/deepwork/beta-10-latency/PLAN-v2-v2first.md`
- Plano anterior (SUPERSEDED): `.pantheon/deepwork/beta-10-latency/PLAN.md`
- Baseline: `bench/results/baseline-2575a41.json` (commit `2575a41`)
- Harness: `bench/bin/bench.mjs`
- ADR-0011 (Delegation Engine Contract), ADR-0012 (Contrato B1–B6)
- **Revisão Themis (2026-10-14):** PASS_WITH_NOTES (*changes-requested*); emendas **F-01..F-15** aplicadas (detalhe por achado na seção homônima do `PLAN.md`).
