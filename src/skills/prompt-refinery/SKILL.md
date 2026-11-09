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

**Anti-padrões que ESCALAM o nível** (qualquer um presente = no mínimo Tier 1; dois ou mais = considere perguntar via tool `question` antes de seguir):
- **Escopo sem fronteira** — "melhorar tudo", "refatorar o projeto": sem fatias, sem fim.
- **Adjetivo sem critério** — "mais rápido", "melhor": sem número, sem baseline, sem like-to-like.
- **Unidade/versão ausente** — "32" de quê? "atualize" pra qual versão? O default pode ser errado.
- **Multi-concern em um parágrafo** — fix + refactor + redesign sem prioridade (o caso que criou esta skill).
- **Premissa implícita de ambiente** — assume stack/host/credenciais que o agente não pode inferir.
| **1 — Ajuste mínimo INTERNO (automático)** | O sinal determinístico dispara | Reescreve o prompt **silenciosamente, para uso próprio**: PT corrigido, estrutura leve, expansão do implícito, lacunas viram escolhas com default declarado. SEM apresentar contrato, SEM pedir aprovação — o usuário vê o trabalho começar. Limite: o essencial (~10-15 linhas internas); escopo pode ser generoso quando o pedido pede |
| **2 — Contrato completo** | **SOMENTE prefixo `>>`** | As seis seções inteiras apresentadas ao usuário para confirmar-ou-ajustar (a ÚNICA via com aprovação explícita) |

O modelo ativo da sessão faz os dois níveis sem problema — o custo é controlado pelo LIMITE de saída de cada nível, não por trocar de modelo. Nível 1 nunca vira nível 2 sem o prefixo.

---

## The contract shape — tiers and caps

**NÍVEL 1 — Ajuste mínimo INTERNO (o default do sinal determinístico):** reescrita para uso próprio, SEM apresentar ao usuário. O essencial + o que o pedido pedir (o escopo mínimo não é um aperto: expanda o implícito, estime o que falta com default declarado).

**Diagnóstico interno ANTES do rewrite** (os improvers oficiais diagnosticam primeiro — o rewrite que não diagnostica chuta):
1. **Tarefa** — qual ação concreta o usuário quer? (verbo + objeto)
2. **Restrições ausentes** — o que ele não disse que LIMITA o resultado? (prazo, tamanho, compatibilidade, budget)
3. **Sucesso indefinido** — como saber que ficou pronto? Se não dá pra testar, formule o teste.
4. **Premissas implícitas** — o que o pedido ASSUME que você sabe? (stack, ambiente, histórico)
5. **Conflitos** — o pedido se contradiz? (peça X mas o aceite implica ¬X)

Cada ponto do diagnóstico vira OU uma decisão no rewrite OU um default declarado OU uma pergunta bloqueante — nada fica implícito duas vezes. Quando o pedido tiver **duas leituras com resultados materialmente diferentes** ("atualizar o README" = patch ou reescrita?), é bloqueante — a leitura errada executa caro e errado. E é aqui que o **Jev entra quando ativado** (ver a regra de desambiguação nas Operating rules): o decision model resolve a leitura como escalar tipado, e a interrupção do usuário vira exceção, não regra.

**Restrições negativas entram no rewrite quando detectadas** — "não tocar em X", "sem nova dependência", "sem migrar ainda". O usuário raramente as diz; o agente que infere incorretamente é quem executa drift.

**Formato da resposta**: se o pedido implicar entrega estruturada (relatório, tabela, plano), o rewrite fixa o formato — "responda como tabela com colunas X/Y" custa uma frase e economiza um redo.

Exemplo de saída aceitável:

```
Objetivo: publicar deploys pendentes e liberar espaço nos VPS sem perder dados.
Fatias: 1) identificar pendências vs produção 2) deploy por serviço 3) limpeza segura de disco.
Aceite: lista de SHAs por serviço; espaço antes/depois; nada persistente apagado.
Perguntas: quais VPS? (default: os que rodam estes serviços) | limpeza destrutiva? (default: não).
```

**Self-check do rewrite** (rubrica interna, custo zero — a versão agent-side do loop OPRO/DSPy): antes de seguir, o rewrite passa por — objetivo único e único verbo? | fatias verificáveis individualmente? | todo default declarado por escrito? | formato da resposta definido (quando a entrega é estruturada)? | restrições negativas registradas? Qualquer não = uma passada de correção interna, não uma nova conversa.

**NÍVEL 2 — Contrato completo (SOMENTE com o prefixo `>>`):** as seis seções abaixo, inteiras, apresentadas ao usuário para confirmar-ou-ajustar.

Produce ALL of the following sections, filling from the request and marking real gaps as open questions — never invent requirements silently:

1. **Objetivo do projeto** — one paragraph: what changes and why.
2. **Escopo em fatias numeradas** — each slice independently verifiable (audit/corrections; architecture/IA; nomenclature/statistics; UI/UX; …). Slices the user did not ask for go under "fora de escopo", not here.
3. **Critérios de aceite por fatia** — testable statements ("toda moeda passa por Decimal; nenhum float em valor monetário"), not vibes.
4. **Entregáveis esperados** — the concrete artifacts (report, route map, dictionary, implementation).
5. **Perguntas abertas** — the gaps that change the plan, with your recommended default for each so silence means "proceed with the default".
6. **Glossário/nomenclatura proposta** — when the domain has ambiguous terms, propose the canonical names up front.
7. **Formato da resposta** — como o usuário recebe cada entregável (tabela, checklist, diff, PR, relatório com seções): o improver oficial trata output structure como parte do prompt, não do acaso.

---

## Operating rules

- **Tier 1 é INTERNO**: o ajuste mínimo acontece na cabeça do agente — o usuário vê o trabalho começar, não o reescrito. Aprovação explícita só existe no Tier 2 (`>>`).
- **Domain mapping stays the ladder's**: after confirmation, slices route through the normal discovery ladder (local selector → Jev → specialist dispatch). The contract is the SPEC, not the dispatcher.
- **Preserve the user's language** (a PT-BR request refines into PT-BR).
- **Falha = fail-open**: qualquer erro no rewrite e o prompt ORIGINAL segue — nunca bloqueia.
- **Nudge self-cancel cheap** (do claude-code-prompt-improver): perguntas abertas com "se isso não se aplicar ao seu caso, ignore" — o nudge barato se anula sozinho quando o palpite erra.
- **Desambiguação — Jev PRIMEIRO quando ativo, `question` como fallback** (revê a regra antiga "NUNCA Jev": com o decision router ATIVO e com budget o usuário já consentiu gastar; a leitura errada custa mais que o escalar):
  1. Ambiguidade bloqueante (leitores materialmente diferentes) + decision router ATIVO → `jev_decide` modo `choice` — candidatos = as leituras, o default recomendado marcado como tal. Decisão interna, silenciosa (Tier 1).
  2. Jev OFF / indisponível / veredito UNVERIFIABLE ou FAIL / timeout → tool `question` nativa com opções e o default recomendado — exatamente o comportamento anterior.
  3. Lacuna NÃO-bloqueante vira escolha com default declarado e segue (nada de Jev nem pergunta — decisa é barata).
  4. **Fail-open nos dois lados**: qualquer erro do Jev cai na `question`; qualquer erro da `question` segue com o default. Nada bloqueia além de uma pergunta legítima.
  5. O Jev decide a LEITURA — nunca escreve o rewrite (prosa é do modelo de sessão).
- **`extra_instructions` do projeto**: convenções do projeto (stack, hosts de deploy, domínios como cupons ML/AliExpress) têm PRIORIDADE sobre os defaults recomendados — leia o AGENTS.md do projeto antes de propor defaults.
- **Referências**: `omkarxpatel/prompt-enhancer` (prefixo opt-in, cap de saída, fail-open) e `severity1/claude-code-prompt-improver` (nudges self-cancel, clarificação com opções) — os dois designs que este skill incorpora. Fundação teórica dos padrões de diagnóstico-e-rewrite: os prompt improvers oficiais (Anthropic/OpenAI), meta-prompting (LLMs guiando LLMs) e o loop de otimização com verificação (OPRO/DSPy) — esta skill é a versão agent-side de custo-controlado: um turno, sem loop de API.
- **Modelo**: o rewrite roda no modelo ativo da sessão; o controle de custo é o CAP de cada nível (interno ~10-15 linhas; completo = as seis seções) — quando houver modelo free/rápido no preset ativo (ex.: mimo-v2.5-free, deepseek-v4-flash-free), prefira-o via routing para o turno de rewrite.
- **One refinement turn + no máx. um escalar.** The rewrite is a single planning pass on the session model — no extra provider call, no Jev for the rewrite itself (decision models answer typed scalars, they do not write prose). The ONE exception is the ambiguity `choice` above: quando o router está ativo, é um escalar a mais no budget — se o budget recusar, cai na `question` sem cerimônia.
- **Cost honesty**: the refinement costs roughly one planning turn (~1–4K tokens each way). The expensive thing is executing a mis-specified request; this skill buys that back.
