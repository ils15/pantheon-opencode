---
name: prompt-refinery
description: "Turn a vague multi-concern request into a usable brief — internally and silently by default; the full contract is shown only via >>. Use when the request mixes refactor/fix/redesign without acceptance criteria, or starts with >>."
---

# Prompt Refinery

> **A vague request executes expensively and wrong. Tier 1 refines it INTERNALLY (the user sees the work begin); Tier 2 — only via `>>` — shows the full contract for confirmation.**

---

## When this fires — TRÊS NÍVEIS

| Nível | Gatilho | O que acontece |
|---|---|---|
| **0 — Passa intacto** | Pedido claro e delimitado ("corrija o typo do README"), cumprimentos e conversa fiada (o `__SKIP__` do prompt-enhancer) | Executa direto, zero token de refinamento |
| **1 — Ajuste mínimo INTERNO (automático)** | O sinal determinístico dispara | Reescreve o prompt **silenciosamente, para uso próprio**: PT corrigido, estrutura leve, expansão do implícito, lacunas viram escolhas com default declarado. SEM apresentar contrato, SEM pedir aprovação — o usuário vê o trabalho começar. Limite: o essencial (~10-15 linhas internas); escopo pode ser generoso quando o pedido pede |
| **2 — Contrato completo** | **SOMENTE prefixo `>>`** | As seis seções inteiras apresentadas ao usuário para confirmar-ou-ajustar (a ÚNICA via com aprovação explícita) |

O modelo ativo da sessão faz os dois níveis sem problema — o custo é controlado pelo LIMITE de saída de cada nível, não por trocar de modelo. Nível 1 nunca vira nível 2 sem o prefixo.

---

## The contract shape — tiers and caps

**NÍVEL 1 — Ajuste mínimo INTERNO (o default do sinal determinístico):** reescrita para uso próprio, SEM apresentar ao usuário. O essencial + o que o pedido pedir (o escopo mínimo não é um aperto: expanda o implícito, estime o que falta com default declarado). Exemplo de saída aceitável:

```
Objetivo: publicar deploys pendentes e liberar espaço nos VPS sem perder dados.
Fatias: 1) identificar pendências vs produção 2) deploy por serviço 3) limpeza segura de disco.
Aceite: lista de SHAs por serviço; espaço antes/depois; nada persistente apagado.
Perguntas: quais VPS? (default: os que rodam estes serviços) | limpeza destrutiva? (default: não).
```

**NÍVEL 2 — Contrato completo (SOMENTE com o prefixo `>>`):** as seis seções abaixo, inteiras, apresentadas ao usuário para confirmar-ou-ajustar.

Produce ALL of the following sections, filling from the request and marking real gaps as open questions — never invent requirements silently:

1. **Objetivo do projeto** — one paragraph: what changes and why.
2. **Escopo em fatias numeradas** — each slice independently verifiable (audit/corrections; architecture/IA; nomenclature/statistics; UI/UX; …). Slices the user did not ask for go under "fora de escopo", not here.
3. **Critérios de aceite por fatia** — testable statements ("toda moeda passa por Decimal; nenhum float em valor monetário"), not vibes.
4. **Entregáveis esperados** — the concrete artifacts (report, route map, dictionary, implementation).
5. **Perguntas abertas** — the gaps that change the plan, with your recommended default for each so silence means "proceed with the default".
6. **Glossário/nomenclatura proposta** — when the domain has ambiguous terms, propose the canonical names up front.

---

## Operating rules

- **Tier 1 é INTERNO**: o ajuste mínimo acontece na cabeça do agente — o usuário vê o trabalho começar, não o reescrito. Aprovação explícita só existe no Tier 2 (`>>`).
- **Domain mapping stays the ladder's**: after confirmation, slices route through the normal discovery ladder (local selector → Jev → specialist dispatch). The contract is the SPEC, not the dispatcher.
- **Preserve the user's language** (a PT-BR request refines into PT-BR).
- **Falha = fail-open**: qualquer erro no rewrite e o prompt ORIGINAL segue — nunca bloqueia.
- **Nudge self-cancel cheap** (do claude-code-prompt-improver): perguntas abertas com "se isso não se aplicar ao seu caso, ignore" — o nudge barato se anula sozinho quando o palpite erra.
- **Perguntas pela tool `question` nativa** (NUNCA Jev — decisão de paid/free; não prosa solta): uma lacuna que BLOQUEIA a execução vira uma pergunta com opções e o default recomendado. Lacuna não-bloqueante vira escolha com default declarado e segue.
- **`extra_instructions` do projeto**: convenções do projeto (stack, hosts de deploy, domínios como cupons ML/AliExpress) têm PRIORIDADE sobre os defaults recomendados — leia o AGENTS.md do projeto antes de propor defaults.
- **Referências**: `omkarxpatel/prompt-enhancer` (prefixo opt-in, cap de saída, fail-open) e `severity1/claude-code-prompt-improver` (nudges self-cancel, clarificação com opções) — os dois designs que este skill incorpora.
- **Modelo**: o rewrite roda no modelo ativo da sessão; o controle de custo é o CAP de cada nível (interno ~10-15 linhas; completo = as seis seções) — quando houver modelo free/rápido no preset ativo (ex.: mimo-v2.5-free, deepseek-v4-flash-free), prefira-o via routing para o turno de rewrite.
- **One refinement turn.** The rewrite is a single planning pass on the session model — no extra provider call, no Jev needed for the rewrite itself (decision models answer typed scalars, they do not write prose).
- **Cost honesty**: the refinement costs roughly one planning turn (~1–4K tokens each way). The expensive thing is executing a mis-specified request; this skill buys that back.
