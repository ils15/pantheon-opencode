# F5 — follow-up com tarefa alinhada à fonte

Executado em 2026-10-15 no commit `689f8f2`, árvore limpa, OpenCode v2.0.29
isolado, modelo `opencode-go/glm-5.3-flash`, cenário B. Foram cinco pares
seriais C1/K1…C5/K5, sem runs substituídas. O oracle foi commitado antes da
medição:
[`f5-prompt-diet-oracle-2026-10-15-followup.md`](./f5-prompt-diet-oracle-2026-10-15-followup.md).
Dados brutos:
[`f5-prompt-diet-20261015-followup.json`](./f5-prompt-diet-20261015-followup.json).

## Proveniência e execução

- Todas as dez runs concluíram e observaram Zeus como root, sem parent.
- D4 passou em 10/10: cada sessão carregou os fixtures global (11.410 B,
  SHA-256 `797fb47e…5753eb3`) e de projeto (1.990 B, SHA-256
  `199ae561…b37c6b0`) esperados.
- A fixture de tarefa registrada no JSON é
  `bench/fixtures/f5-task-2024-un.md`, 414 B, SHA-256
  `e6cee2f4af984a9063d19724a74c509a7d38f04f4252b31d88671464e5b758ae`.
- Zeus controle: 29.477 B, SHA-256
  `11c79c4e…09d2c0b`; Zeus candidata: 21.808 B, SHA-256
  `0ba6b120…8c20c8b`. Runtime, definições auxiliares, skills, plugin,
  configuração e permissões foram iguais.

## Contexto do primeiro request

A métrica é `tokens.input + tokens.cache.read` do primeiro request do root.
Todas as dez runs têm os campos completos; cache-read foi zero nas duas arms.
As cinco observações por arm estão listadas abaixo. O agregador de aceitação
exclui o par 1 porque sua rota divergiu; entre os quatro pares elegíveis, as
medianas e ranges permanecem os mesmos mostrados na tabela.

| Arm | Input/contexto: runs | Mediana | Range |
|---|---|---:|---:|
| Controle | 16.337, 16.351, 16.337, 16.337, 16.337 | 16.337 | 16.337–16.351 |
| Candidata | 14.644, 14.644, 14.644, 14.658, 14.644 | 14.644 | 14.644–14.658 |

A diferença das medianas é 1.693 tokens (10,36%); ela excede tanto o mínimo
pré-registrado de 10% quanto o maior spread intrabraço (14 tokens). O sinal
quantitativo foi confirmado. Este é somente um resultado do proxy de contexto;
não é aceite global de F5.

## Correção e roteamento

- Os dez diretórios continham exatamente um artefato de tarefa além dos arquivos
  de setup: `bench-run-B.md`. Todos eram arquivos regulares, UTF-8, sem symlink,
  citavam WPP 2024 e apresentavam Índia, China e Estados Unidos na ordem correta.
  Os valores passaram a tolerância de ±2% do oracle em 10/10.
- Quatro dos cinco pares tiveram árvores idênticas Zeus → Talos e uma chamada
  `subagent` em cada braço.
- **O par 1 divergiu:** controle chamou Talos uma vez; candidata chamou Apollo
  e Talos, com duas chamadas `subagent`. A sessão candidata e seu artefato
  concluíram, mas a comparação exata de rota pré-registrada falhou nesse par.

## Decisão

F5 **não atingiu o aceite**. D4, disponibilidade dos dez primeiros requests,
correção dos dez artefatos e redução quantitativa passaram; a paridade de rota
passou em 4/5 pares e falhou em 1/5. Não há claim global de F5. O primeiro
resultado permanece inalterado e também não passou seu gate de artefatos
(controle 4/5); este follow-up corrigiu a tarefa/oracle e encontrou a divergência
de rota.

Wall mediano considerando todas as runs: 83,316 s controle e 105,017 s candidata;
os ranges foram 20,789–211,434 s e 80,622–569,852 s. Nenhum ganho de wall é
reivindicado. Custo monetário continua indisponível sem preço e semântica de
cache verificados.
