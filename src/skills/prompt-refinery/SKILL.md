---
name: prompt-refinery
description: "Turn a rough, vague, or one-line request into a structured execution contract (objective, scope slices, acceptance criteria, deliverables, open questions) shown to the user BEFORE executing. Use when a request spans multiple concerns or lacks explicit acceptance criteria."
---

# Prompt Refinery

> **A vague request executes expensively and wrong. Refine it into a contract, show the contract, then execute what was confirmed.**

---

## When this fires

- The request spans multiple concerns ("refatora o dashboard, corrige os cálculos, melhora a UI") with no explicit acceptance criteria.
- The request names a desired OUTCOME but not the slices, nomenclature, data sources, or quality bar.
- The user pastes a long context dump and asks for "melhorar/refatorar/revisar" without structure.

A one-line bounded fix ("troque essa cor", "corrija esse typo") does NOT fire this skill — execute directly.

---

## The contract shape (the rewrite target)

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
- **One refinement turn.** The rewrite is a single planning pass on the session model — no extra provider call, no Jev needed for the rewrite itself (decision models answer typed scalars, they do not write prose).
- **Cost honesty**: the refinement costs roughly one planning turn (~1–4K tokens each way). The expensive thing is executing a mis-specified request; this skill buys that back.
