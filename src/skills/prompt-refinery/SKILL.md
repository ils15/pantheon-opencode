---
name: prompt-refinery
description: "Turn a rough, vague, or one-line request into a structured execution contract (objective, scope slices, acceptance criteria, deliverables, open questions) shown to the user BEFORE executing. Use when a request spans multiple concerns or lacks explicit acceptance criteria."
---

# Prompt Refinery

> **A vague request executes expensively and wrong. Refine it into a contract, show the contract, then execute what was confirmed.**

---

## When this fires — TRÊS NÍVEIS

| Nível | Gatilho | O que acontece |
|---|---|---|
| **0 — Passa intacto** | Pedido claro e delimitado ("corrija o typo do README"), cumprimentos e conversa fiada (o `__SKIP__` do prompt-enhancer) | Executa direto, zero token de refinamento |
| **1 — Ajuste mínimo (automático)** | O sinal determinístico dispara (multi-concern sem critérios) | Reescreve o prompt: **PT corrigido** (typos, acentos), estrutura leve (objetivo + fatias em 1 linha cada + o que falta como pergunta), expansão do implícito. **Limite duro: ~15 linhas.** Não é um contrato — é o mesmo pedido, legível |
| **2 — Contrato completo** | **SOMENTE prefixo `>>`** (`>> fazer os deploys e limpar a vps`) | As seis seções inteiras (objetivo, fatias, critérios, entregáveis, perguntas com defaults, glossário) |

O modelo ativo da sessão faz os dois níveis sem problema — o custo é controlado pelo LIMITE de saída de cada nível, não por trocar de modelo. Nível 1 nunca vira nível 2 sem o prefixo.

---

## The contract shape — TWO tiers (cost control)

**COMPACTO (default, quando o sinal determinístico dispara):** no máximo **8 linhas**, uma por seção, pule o que não se aplica. Exemplo de saída aceitável:

```
Objetivo: publicar deploys pendentes e liberar espaço nos VPS sem perder dados.
Fatias: 1) identificar pendências vs produção 2) deploy por serviço 3) limpeza segura de disco.
Aceite: lista de SHAs por serviço; espaço antes/depois; nada persistente apagado.
Perguntas: quais VPS? (default: os que rodam estes serviços) | limpeza destrutiva? (default: não).
```

**COMPLETO (só quando o usuário pedir "contrato completo" ou o domínio exigir):** as seis seções abaixo, inteiras.

Produce ALL of the following sections, filling from the request and marking real gaps as open questions — never invent requirements silently:

1. **Objetivo do projeto** — one paragraph: what changes and why.
2. **Escopo em fatias numeradas** — each slice independently verifiable (audit/corrections; architecture/IA; nomenclature/statistics; UI/UX; …). Slices the user did not ask for go under "fora de escopo", not here.
3. **Critérios de aceite por fatia** — testable statements ("toda moeda passa por Decimal; nenhum float em valor monetário"), not vibes.
4. **Entregáveis esperados** — the concrete artifacts (report, route map, dictionary, implementation).
5. **Perguntas abertas** — the gaps that change the plan, with your recommended default for each so silence means "proceed with the default".
6. **Glossário/nomenclatura proposta** — when the domain has ambiguous terms, propose the canonical names up front.

---

## Operating rules

- **Show, then execute.** The refined contract is presented to the user for confirm-or-adjust BEFORE implementation — one confirmation, not a dialogue. Silence or "ok" proceeds with the defaults stated in Perguntas abertas.
- **Domain mapping stays the ladder's**: after confirmation, slices route through the normal discovery ladder (local selector → Jev → specialist dispatch). The contract is the SPEC, not the dispatcher.
- **Preserve the user's language** (a PT-BR request refines into PT-BR).
- **Falha = fail-open**: qualquer erro no rewrite e o prompt ORIGINAL segue — nunca bloqueia.
- **Nudge self-cancel cheap** (do claude-code-prompt-improver): perguntas abertas abrem com "se isso não se aplicar ao seu caso, ignore" — o nudge barato se anula sozinho quando o palpite erra, sem custo de diálogo.
- **`extra_instructions` do projeto**: convenções do projeto (stack, hosts de deploy, domínios como cupons ML/AliExpress) têm PRIORIDADE sobre os defaults recomendados — leia o AGENTS.md do projeto antes de propor defaults.
- **Referências**: `omkarxpatel/prompt-enhancer` (prefixo opt-in, cap de saída, fail-open) e `severity1/claude-code-prompt-improver` (nudges self-cancel, clarificação com opções) — os dois designs que este skill incorpora.
- **Modelo**: o rewrite roda no modelo de sessão com o cap de 8 linhas; "barato" é o CAP, não um tier específico — quando houver modelo free/rápido no preset ativo (ex.: mimo-v2.5-free, deepseek-v4-flash-free), prefira-o via routing para o turno de rewrite.
- **One refinement turn.** The rewrite is a single planning pass on the session model — no extra provider call, no Jev needed for the rewrite itself (decision models answer typed scalars, they do not write prose).
- **Cost honesty**: the refinement costs roughly one planning turn (~1–4K tokens each way). The expensive thing is executing a mis-specified request; this skill buys that back.
