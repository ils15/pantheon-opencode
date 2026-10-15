# F5 — terceira medição: regra de tarefa composta

Executada em 2026-10-15 no checkout limpo `58322e5`, após a regra de
especialista único em `ad17806` e o oracle desta rodada serem registrados.
OpenCode v2.0.29 isolado, `opencode-go/glm-5.3-flash`, cenário B,
double-injection, cinco pares C1/K1…C5/K5 em série. Não houve substituição ou
reparo de run. O oracle é
[`f5-prompt-diet-oracle-2026-10-15-route-v2.md`](./f5-prompt-diet-oracle-2026-10-15-route-v2.md);
os dados completos estão em
[`f5-prompt-diet-20261015-route-v2.json`](./f5-prompt-diet-20261015-route-v2.json).

## Proveniência e completude

- O artifact identifica `gitDirty=false`, runtime `opencode v2.0.29`, plugin
  V2 e modelo solicitado `opencode-go/glm-5.3-flash`.
- D4 passou em **10/10**: cada run carregou o fixture global (11.410 B,
  SHA-256 `797fb47e…5753eb3`) e o de projeto (1.990 B, SHA-256
  `199ae561…b37c6b0`).
- Zeus de controle: 29.477 B, SHA-256
  `11c79c4e…09d2c0b`. Candidata: 22.037 B, SHA-256
  `bc6273cf…c5de2ef`. O task fixture registrado tem 414 B e SHA-256
  `e6cee2f4…e5b758ae`.
- **8/10** execuções completaram; controle 3/5, candidata 5/5. C1 e C5
  controle falharam por timeout configurado de 1.200.000 ms. Nenhuma criou
  `bench-run-B.md`; ambas ficam como falhas, não como zero nem como artefatos
  corretos.
- Dos oito artefatos presentes, **8/8** eram arquivos regulares, sem symlink,
  UTF-8, com exatamente três linhas de tabela na ordem pedida e citação de WPP
  2024; os valores passaram ±2% da referência. Nenhum outro arquivo de tarefa
  foi encontrado fora de `.pantheon/` e `AGENTS.md` de setup.

## Rotas

Só os pares **2/5** passaram paridade exata. Zeus→Talos com uma chamada
`subagent` coincidiu em C2/K2 e C3/K3. Os outros pares divergiram:

- C1 controle executou Zeus→Apollo; K1 candidata, Zeus→Talos (uma chamada em
  cada braço).
- C4 controle observou Zeus→Apollo e Zeus→Talos; K4 candidata observou
  Zeus→Talos. O ledger registrou duas chamadas `subagent` em cada braço.
- C5 controle expirou sem child; K5 candidata completou Zeus→Talos.

Assim, a regra candidata estabilizou a execução observada em Zeus→Talos nas
cinco candidatas, mas **não passou o oracle de paridade com o controle**. O
resultado não sustenta aceite F5.

## Contexto do primeiro request

O harness encontrou primeiro request em 4/5 controles (C1 indisponível) e
5/5 candidatas. Valores incluem os registros disponíveis, inclusive C5,
cujo processo terminou em timeout; são descritivos e não tornam a run elegível.

| Arm / conjunto | Input mediana (faixa) | Cache-read mediana (faixa) | Contexto mediana (faixa) |
|---|---:|---:|---:|
| Controle, first requests disponíveis (n=4) | 16.340 (16.333–16.347) | 0 (0–0) | 16.340 (16.333–16.347) |
| Candidata, first requests disponíveis (n=5) | 14.692 (14.692–14.706) | 0 (0–0) | 14.692 (14.692–14.706) |
| Controle, pares elegíveis 2–3 (n=2) | 16.347 (16.347–16.347) | 0 (0–0) | 16.347 (16.347–16.347) |
| Candidata, pares elegíveis 2–3 (n=2) | 14.699 (14.692–14.706) | 0 (0–0) | 14.699 (14.692–14.706) |

Os valores individuais de input/contexto disponíveis foram controle 16.347,
16.347, 16.333, 16.333 e candidata 14.692, 14.706, 14.692, 14.692, 14.692.

Nos dois pares elegíveis, o proxy de contexto caiu 1.648 tokens (10,08%);
cache-read no primeiro request foi zero. Esse subconjunto tem **N=2**, enquanto
o oracle exige os cinco pares e campos completos; portanto é exploratório e
não confirma o critério F5. Uma run de controle não teve campos de primeiro
request disponíveis.

## Wall e decisão

Entre os pares elegíveis, a mediana de wall foi 82,797 s controle e 116,322 s
candidata; faixas 59,088–106,506 s e 47,017–185,627 s. As faixas se sobrepõem
e o delta não supera o spread observado. Os timeouts e a run de controle de
974,359 ms também tornam inadequado reivindicar ganho de latência. Custo
monetário continua unavailable.

F5 **não passou**: 3/5 controles completaram, 8/10 artefatos existem,
paridade de rota passou em 2/5 pares, e só dois pares são elegíveis para a
comparação primária. O resultado anterior de fonte alinhada permanece
inalterado; esta rodada também não autoriza claim global de prompt diet,
tokens ou latência. Preservar o relatório, os dez registros e os dois
timeouts como evidência de falha do gate.

## Revisão Themis

Veredito final: **BLOCK**. Os bloqueios são a paridade estrita de rota em
2/5 pares, dois timeouts do controle sem artefato e a cobertura incompleta do
primeiro request. O resumo N=2 de tokens está corretamente rotulado como
exploratório; D4 e os oito artefatos existentes foram verificados.

Nota baixa: os timeouts declaram 1.200.000 ms, mas `wallMs` é aproximadamente
1.113.000 ms. O runner media elapsed time com `Date.now()`, enquanto os timers
de timeout usam relógio monotônico; um ajuste do relógio civil pode explicar a
diferença. Nenhuma medição elegível ou claim de latência usa esses wall times de
timeout. Em seguida, o harness foi corrigido para medir deadline e duração com
relógio monotônico; o resultado bruto desta rodada permanece inalterado e não
foi recalculado.
