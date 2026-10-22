# ADR-0014: Release da `v1.6.0` stable — decisões de corte (Q1–Q7), matriz de hosts e Known Issues

**Status:** **Accepted**
**Date:** 2026-10-22
**Author:** @mnemosyne (doc-only, por delegação)
**Escopo:** decisões de release da `v1.6.0` stable do `pantheon-opencode`. Este ADR
registra decisões fechadas; não altera código, `README`, `docs/`, `ROADMAP.md`,
`CHANGELOG` nem workflows — a execução é de outro especialista.

## Context

`package.json:143` fixa `node >=26.4.0` e `package.json:3` registra a versão atual
`1.6.0-beta.18`. Os dist-tags do npm no momento desta decisão (2026-10-22) são:

| dist-tag | versão |
|---|---|
| `latest` | `1.5.2` |
| `beta` | `1.6.0-beta.18` |
| `next` | `1.5.0-beta.9` |

A `1.6.0` é a **primeira versão da série 1.6 submetida ao gate de release stable**:
a stable publicada é `1.5.2` e todo o trabalho da série está no canal `beta`. A série
1.6 é declarada **dual** (legado + nativo coexistem; ADR-0012, ADR-0011), o que
mantém duas superfícies vivas até o flip de default — nenhuma dessas cláusulas é
alterada por este ADR.

O host **OpenCode 2.1.0 (2026-10-20)** mudou **intencionalmente** contratos públicos
de SDK, de mensagens/eventos HTTP e de plugin (#57260). O repositório tem evidência de
runtime apenas em host **2.0.22, 2.0.29 e 2.0.30** — e **nenhuma em host 1.X**.
Publicar stable sobre uma matriz que ignore a 2.1 significaria declarar suporte a um
contrato que ninguém executou.

Backlog no momento da decisão: `ROADMAP.md` com **22 itens `OPEN`** (4 P0, 7 P1,
11 P2). A regra dura do charter vale em todos os gates desta release: evidência
`WARN`, `SKIP`, `NOT_TESTED` ou `AMBIENTAL` **nunca conta como `PASS`**
(`ROADMAP.md:63-65`; `docs/RELEASE.md:104-109`).

## Decision

### Q1–Q7 — decisões fechadas

| ID | Decisão | Consequência |
|---|---|---|
| **Q1** | Publicar **`1.6.0` stable novo**; **não** usar `dist-tag add` sobre o beta. | O artefato validado é o artefato publicado: todos os gates rodam sobre o **tarball/SHA final** da `1.6.0`; nenhum byte é promovido de beta para stable por movimento de tag. Alinha com `docs/RELEASE.md:111-118` (um único `.tgz`, SHA-256 do mesmo arquivo, sem segundo `npm pack`). |
| **Q2** | **OpenCode 2.1.0 entra na matriz** desta release, com **fase própria de adoção/validação do novo contrato**. | A matriz deixa de ser só 2.0.22/2.0.29/2.0.30; a 2.1 precisa de evidência própria (SDK, mensagens/eventos HTTP, plugin) antes de qualquer linha `PASS`. Sem essa fase, a coluna 2.1 não é declarada suportada. |
| **Q3** | Manter Node **`>=26.4.0`** (`package.json:143`). Node 22, 24 e 26.0–26.3 ficam **fora da matriz**. | Essas versões não podem ser citadas como suportadas nem entrar na matriz de evidência; o piso é um só e é o do `engines`. |
| **Q4** | **Bloqueio absoluto de segurança:** P0-5 sem **comportamento de permissões demonstrável no host** = **release não sai**. **Não existe Known Issue de segurança.** | P0-5 (`ROADMAP.md:384-425`) não é aceitável como risco conhecido, nem parcialmente: enquanto o enforcement read-only dos 14 agentes não for demonstrável no host, o GO é negado — não há waiver, não há "Known Issue de segurança". |
| **Q5** | Os **11 P2 abertos são aceitos como Known Issues** e **não bloqueiam o GO**. | Os 11 itens da tabela abaixo vão no pacote de GO e nas notas da release como limitações conhecidas, nominalmente; aceitação é explícita, nunca silenciosa. |
| **Q6** | **Remover a tag npm `next`** (`1.5.0-beta.9`) na fase de publicação, **com verificação pós-remoção**. | A tag `next` aponta para uma beta de 1.5 que não é candidata a nada; some na publicação e a remoção é verificada depois (leitura dos dist-tags), não presumida. |
| **Q7** | **O usuário assina o GO.** Zeus consolida a evidência e apresenta o pacote. **Nenhum agente assina.** | A assinatura é humana e nominal à versão + `TARGET_SHA`; agente que consolida evidência não é parte que aprova. Sem assinatura, não há publicação. |

### Matriz de host alvo

| Host | Estado | Evidência hoje |
|---|---|---|
| `1.19.x` | **Suportado — a testar** | Nenhuma evidência de runtime no repositório; precisa de linha própria na Fase 5. |
| `2.0.22` | **Suportado — a testar** | Evidência de runtime registrada (recusa de caminho `.ts` na array de plugin). |
| `2.0.29` | **Suportado — a testar** | Evidência de runtime registrada no repositório. |
| `2.0.30` | **Suportado — a testar** | Evidência de runtime: campo da `beta.15` contra `opencode v2.0.30` e canary scripted-provider local no host exato `v2.0.30` (P2-12). |
| `2.1.0` | **Suportado — a testar** | **Nenhuma evidência**; contrato público novo (SDK, mensagens/eventos HTTP, plugin — #57260). Coberto pela fase própria exigida em Q2. |
| `2.0.31` | **NÃO suportado** | Sem evidência. Não entra na matriz e não pode ser citado como suportado. |

**Node:** `>=26.4.0` (`package.json:143`).
**Node 22, 24 e 26.0–26.3:** **não suportados** — fora da matriz de evidência.

Ressalva registrada: `1.19.x` é linha suportada **a testar**, não linha com evidência
histórica; a ausência de evidência em host 1.X é um dos itens que a Fase 5 tem de
fechar (ou declarar como não coberto — o que, pela regra dura, não é `PASS`).

### Known Issues aceitos (Q5) — os 11 P2 `OPEN`

Ids e títulos conforme `ROADMAP.md` (status `OPEN` no momento desta decisão):

| ID | Título |
|---|---|
| P2-1 | Duplicação de sistemas de versão no installer |
| P2-2 | Limite de `phase.name` sem teste de fronteira (OS-5) |
| P2-3 | `memory_search` deve expor que é lexical |
| P2-4 | Serializar quem compartilha arquivo com edição pendente |
| P2-5 | Reduzir o tamanho da saída de Wave 0 |
| P2-6 | Definir o papel do `nyx` |
| P2-7 | Tornar o `mnemosyne` utilizável fora do repositório |
| P2-8 | Issue #198: os entrypoints MCP compartilham o token `server.py` |
| P2-9 | Apollo precisa rotular achados como portáteis ou específicos de ambiente |
| P2-10 | O secret scanner não protege contra a leitura de um arquivo de credencial cujo caminho o agente já sabe |
| P2-11 | Board e goal tools não existem no contrato V2, e a bridge que os carregaria nunca foi ligada |

Nenhum destes é bloqueador (Q5). **Nenhum item de segurança entra nesta lista** (Q4).

## Consequences

### Estrutura de execução

- **6 fases** de release. Este ADR fixa apenas a contagem, o caminho crítico e a
  estimativa; o conteúdo detalhado de cada fase pertence ao plano de release.
- **Caminho crítico: 1 → 2 → 4 → 5 → 6.** A fase 3 não aparece no caminho crítico
  indicado, portanto não pode atrasar a publicação por si.
- **Estimativa: ~16–36 dias úteis**, incluindo a fase própria de adoção/validação do
  contrato da 2.1 (Q2).

### Critério de escalada (R9)

> Se o **delta real da 2.1** indicar **> 8 dias úteis de trabalho**, **ou** se a
> **estratégia 1.X ↔ 2.1 não fechar**, a **decisão de corte volta ao usuário**.

R9 não autoriza corte automático: o agente que executa reporta o delta e devolve a
decisão, não escolhe sozinho reduzir a matriz nem adiar a 2.1.

### Positive

- Artefato publicado é o artefato validado (Q1) — sem promoção por tag e sem
  divergência entre evidência e bytes.
- A 2.1 entra por evidência, não por otimismo: contrato novo tem fase própria (Q2).
- Piso de Node explícito e único (Q3); matriz de hosts com estados falsificáveis e
  `2.0.31` declarado não suportado em vez de implicitamente "provavelmente ok".
- Segurança com bloqueio absoluto e sem categoria de waiver (Q4) — o pior caso é
  NO-GO, não Known Issue.
- Known Issues nominais (Q5) e GO assinado por humano (Q7): a aprovação é rastreável.

### Negative

- Não existe caminho rápido: Q1 proíbe promover o `beta.18` já publicado, então todo
  o custo de gates é pago de novo sobre o tarball final.
- A 2.1 na matriz aumenta o custo e o risco de cronograma (mitigado só por R9, que
  devolve a decisão ao usuário — não a resolve).
- `1.19.x` na matriz sem evidência histórica significa que a release pode publicar
  com uma linha suportada que nunca foi medida; fechar isso é trabalho de Fase 5.
- Node 22/24 e 26.0–26.3 sem suporte reduz a base instalável e não pode ser
  compensado por claim de "funciona na prática".

### Neutral

- Os 11 P2 permanecem abertos no `ROADMAP.md`; a aceitação é de release, não
  fechamento de item — nenhum id muda de status por causa deste ADR.
- A remoção da tag `next` (Q6) é higiene de distribuição, não mudança de contrato.

## Pacote de GO (formato exigido)

Zeus consolida e apresenta; o usuário assina. O pacote contém, no mínimo:

1. **Evidência consolidada da Fase 5**, com **matriz host × resultado** (cada célula
   `PASS` / `WARN` / `SKIP` / `NOT_TESTED` / `AMBIENTAL` / `FAIL` explícita).
2. **Versões** de Node, npm, host OpenCode e SDK usadas em cada linha da matriz.
3. **SHA-256 do `.tgz`** publicado/validado.
4. **`TARGET_SHA` completo** (não abreviado).
5. **Saída do `doctor`**.
6. **Resultado dos 6 gates aplicáveis** — `PASS` explícito em cada um; `WARN`, `SKIP`,
   `NOT_TESTED` e `AMBIENTAL` não contam como `PASS` (`ROADMAP.md:63-65`,
   `docs/RELEASE.md:104-109`).
7. **Known Issues**: os 11 P2 da tabela acima, mais qualquer risco aceito
   explicitamente.
8. **Assinatura do usuário citando a versão + `TARGET_SHA`** (Q7). Nenhum agente
   assina.

Risco residual declarado: o pacote de GO pode chegar com uma linha da matriz sem
`PASS`; nesse caso o GO não é emitido — a saída é corrigir, reduzir escopo **com
decisão do usuário** (R9), ou NO-GO.

## References

- `ROADMAP.md` — charter Road to Stable (regra dura de evidência: `:63-65`; P0-5:
  `:384-425`; P2-1…P2-11: `:567-739`)
- `docs/RELEASE.md` — fail-closed (`:104-109`) e evidência do artefato (`:111-118`)
- `docs/RELEASING.md`
- `docs/INSTALLATION.md`
- Issue do host que introduz o contrato novo: **#57260** (OpenCode 2.1.0, 2026-10-20)
- Issue **#198** — entrypoints MCP compartilhando o token `server.py` (P2-8)
- ADR-0007 (padronização de release, semver 1.x + SSOT), ADR-0011 (delegation engine
  contract), ADR-0012 (SemVer 1.6 = dual)

---

## Amendment 1 — 2026-10-22

**Aditivo e datado.** O **Status: Accepted** do cabeçalho, o texto de Q1–Q7, a tabela
"Matriz de host alvo", a lista de Known Issues de Q5, a estrutura de 6 fases e as
`## References` acima **permanecem como escritos** — nada é reescrito nem apagado. Esta
emenda registra decisões tomadas em **2026-10-22** depois da redação original e a
**evidência de runtime** produzida nesse dia, e prevalece apenas onde a colisão for
explícita (A1.1, A1.2, A1.3).

**Evidência primária desta emenda (artefato externo ao repositório, não copiado):**
`/home/ils15/pantheon-sandbox/p05-hosts-20261022/evidence/EVIDENCE-P05.md` (doravante
`EVIDENCE-P05.md`), com os `*.log` e `*.exitcode` no mesmo diretório e o registro de
instalação em `/home/ils15/pantheon-sandbox/p05-hosts-20261022/INSTALL-RECORD.md`
(doravante `INSTALL-RECORD.md`). O conjunto cobre **cinco** hosts instalados em prefixos e
`HOME`/XDG isolados: `1.19.4`, `2.0.22`, `2.0.30`, `2.1.0`, `2.1.2`
(`EVIDENCE-P05.md:12-20`, `INSTALL-RECORD.md:12-16`); `2.0.29` **não** foi instalado
(`EVIDENCE-P05.md:183`). Nenhum host do `PATH` foi usado como evidência
(`EVIDENCE-P05.md:20`).

### A1.1 — OpenCode `2.0.22` removido da matriz: **não suportado**

Decisão do usuário (2026-10-22). A linha `2.0.22` deixa de ser "Suportado — a testar"
e passa a **não suportado** — não é mais o caso de "sem evidência", é reprovação
verificada em runtime:

| Fato verificado em runtime | Evidência |
|---|---|
| `ctx.permission.assert` **ausente só na 2.0.22**; presentes em 2.0.30/2.1.0/2.1.2 | `EVIDENCE-P05.md:100-104`; linha bruta `assert-unavailable` em `EVIDENCE-P05.md:87` |
| Células de ordenação (C1–C5) ficam `NOT_APPLICABLE` na 2.0.22 porque o "reject" é erro de disponibilidade de API, não decisão de política | `EVIDENCE-P05.md:63-64`, `:75-79`, `:124` |
| O relatório do harness ainda imprime ✔ e classifica `deny-precedence` na 2.0.22 — **falso verde** | `EVIDENCE-P05.md:101-104` |
| Teste de contexto V2 falha: o host não expõe `worktree_*` nem `pantheon_bounded_read` no catálogo de tools | `EVIDENCE-P05.md:113-116` |
| Run da 2.0.22 termina com exit 1 e 3 falhas de harness (26/16/3/7) | `EVIDENCE-P05.md:166` |
| A2 reprovado na 2.0.22 (mesma falha estrutural dos demais V2) | `EVIDENCE-P05.md:69`, `:94-97`, `:122` |

Consequência para Q4 (bloqueio absoluto de segurança): numa versão que não expõe
`ctx.permission.assert`, a verificação de ordem de regras não é observável, então a
2.0.22 não pode sustentar "comportamento de permissões demonstrável no host". Ela sai da
matriz em vez de entrar como exceção.

### A1.2 — A célula `2.1.0` passa a ser a linha `2.1.x` (`>=2.1.0 <2.2`)

Decisão do usuário (2026-10-22): a matriz cobre a **linha** `2.1.x`, não um patch. Prova
obrigatória em **duas** versões por release:

1. **`2.1.0` — piso:** medido no pré-fix com A1/A3/A4, B, C e D em `PASS` e A2 reprovado
   então (`EVIDENCE-P05.md:68-81`, `:121-125`, `:89`), e remedido no pós-fix com A2 `PASS`
   (`:265`, `:291`).
2. **Patch mais novo disponível:** `@opencode/cli@2.1.3` — o `latest` do registro no
   momento do congelamento — foi instalado em sandbox isolado e medido: A2 **PASS**
   (`EVIDENCE-P05.md:224`, `:265`, `:293`, `:307-310`, checksum em `:327`). A `2.1.2`
   segue medida com o mesmo resultado (`INSTALL-RECORD.md:16`, `EVIDENCE-P05.md:90`,
   `:125`).

A célula `2.1.x` está fechada com as **duas** provas exigidas: piso `2.1.0` e patch mais
novo `2.1.3`, ambas com A2 PASS e sem nenhuma célula `FAIL`
(`EVIDENCE-P05.md:262-281`, `:289-294`). A regra do "patch mais novo" é a **do momento do
congelamento**: se o registro publicar outro `2.1.x` antes da Fase 5, a linha é medida de
novo contra o patch publicado e a evidência é re-arquivada. Este ADR **não** fixa `2.1.3`
como teto permanente da linha.

### A1.3 — Matriz de host final desta release

Substitui, **para fins de gate**, a tabela "Matriz de host alvo" da decisão original. As
linhas antigas permanecem no texto como registro histórico do estado em que a decisão foi
tomada.

| Host | Estado nesta release | Evidência |
|---|---|---|
| `1.19.x` (V1) | **Suportado — PASS por enforcement de config** (não por hook); read-only provado no `1.19.4` (ver A1.6) | `evidence/v1-permission/v1.19.4.log:9`, `v1.19.4.evidence.json:6`, `:144-229` |
| `2.0.29` | **Suportado — PASS** pós-fix em A/B/C1–C2/D; é o host do bench histórico F4A | `EVIDENCE-P05.md:200`, `:223`, `:264-277`, `:289`; `docs/PERMISSIONS-QUALITY-DELEGATION.md:647`; `README.md:307`, `:359` |
| `2.0.30` | **Suportado — PASS** pós-fix; A2 corrigido no tradutor (A1.4) | `EVIDENCE-P05.md:265`, `:290`, `:279` |
| `2.1.x` (`>=2.1.0 <2.2`) | **Suportado — PASS** com as duas provas: piso `2.1.0` e patch mais novo `2.1.3` (ver A1.2) | `EVIDENCE-P05.md:265`, `:291-293`, `:279` |
| `2.0.22` | **NÃO suportado** (A1.1) — o log pós-fix arquivado mantém as células de ordem `NOT_APPLICABLE` | `EVIDENCE-P05.md:100-104`, `:113-116`, `:166`, `:300-301` |
| `2.0.31` | **NÃO suportado** — sem evidência; mantido da decisão original (linha `2.0.31` da tabela acima) e reafirmado por `docs/INSTALLATION.md:21` | decisão original + `docs/INSTALLATION.md:21` |

**Node:** `>=26.4.0` — mantido sem alteração (`package.json:143`).
**Python:** `>=3.11` (`docs/INSTALLATION.md:21`, `:140`) — requisito de MCP servers, não de
host; registrado aqui porque a matriz de ambiente do pacote de GO pede versões explícitas.

### A1.4 — P0-5: evidência observada e correção aplicada

**Defeito (pré-correção), reproduzido em todos os hosts V2 medidos:** a tool `write` é
avaliada pelo host sob a ação **`edit`**, enquanto o tradutor do repositório emitia a ação
`write`. Como a regra emitida não é a regra que decide a chamada, `permission.write: deny`
**não bloqueava escrita**.

| Host | Ação observada para a tool `write` | Status pré-correção | Evidência |
|---|---|---|---|
| `2.0.22` | `edit` | FAIL | `EVIDENCE-P05.md:69`, `:87` |
| `2.0.30` | `edit` | FAIL | `EVIDENCE-P05.md:69`, `:88` |
| `2.1.0` | `edit` | FAIL | `EVIDENCE-P05.md:69`, `:89` |
| `2.1.2` | `edit` | FAIL | `EVIDENCE-P05.md:69`, `:90` |

Texto de falha idêntico nos quatro hosts: "translator emits \"write\" for permission.write
but the host evaluated \"edit\"" (`EVIDENCE-P05.md:94-97`); a escrita executava
(`sideEffects.write === true`, `EVIDENCE-P05.md:98-99`, com A4 "ran" em `:71`), isto é, o
host **permitia** sob o nome `edit`.
`bash → shell` e `task → subagent` já estavam corretos e não mudaram
(`EVIDENCE-P05.md:68`, `:80-81`).

**Correção aplicada** — `scripts/install/config-migration.mjs`:

- `write: 'edit'` no mapa V1→ação, com `edit: 'edit'` listado **antes** dele para que o
  mapa reverso resolva `edit` para a chave canônica: `scripts/install/config-migration.mjs:49-59`
  (comentário de evidência em `:36-47`).
- Colisão resolvida por **restritividade** `deny > ask > allow`
  (`EFFECT_RESTRICTIVENESS` em `scripts/install/config-migration.mjs:65`; merge em
  `pushPermission`, `:81-107`), nunca por ordem de iteração.
- Mapa reverso com "primeira chave vence" preservando `edit` canônico:
  `scripts/install/config-migration.mjs:138-149`.

**Teste de regressão** — `tests/install-config-migration.test.mjs`:

- `permission.write` → ação `edit` (`:223-230`);
- `permission.write` no nível de agente → `edit` (`:232-239`);
- colisão `write`+`edit` resolvida por restritividade em 7 ordens de chave (`:241-263`);
- regras `write`/`edit` com recursos distintos preservadas separadas (`:265-273`).

**Re-execução pós-correção — comprovada, com artefato arquivado.** A rodada pós-fix existe
em `evidence/rerun-postfix/`, com `SHA256SUMS` para os dois conjuntos (matriz fresca e a
cópia byte-idêntica de `/tmp/p05-rerun`); janela `12:23–12:26 -03:00` para a matriz fresca
e `11:36–11:38` para a rodada de `/tmp` (`EVIDENCE-P05.md:185-204`, `:317-340`).

- Hosts medidos: `2.0.29`, `2.0.30`, `2.1.0`, `2.1.2`, `2.1.3` — **zero célula `FAIL`**
  (`EVIDENCE-P05.md:262-281`; afirmação explícita em `:279`).
- **A2 `PASS` em todos os cinco**, com `translator.entries.write = "edit"` e
  `actionNames.evaluations = shell/edit/read` (`EVIDENCE-P05.md:265`, `:287-294`).
- Perfil read-only com `sideEffects = {"shell":false,"write":false}` nos cinco
  (`EVIDENCE-P05.md:289-294`).
- Prova de que o log é pós-fix: `"write":"edit"` 3×, `✔` do P0-5 3×, 0 linhas `✖` e exit 0
  por host (`EVIDENCE-P05.md:303-315`).
- A rodada antiga de `/tmp/p05-rerun` foi arquivada **byte-idêntica** em
  `evidence/archived-tmp-20261022/`, conferida com `cmp` no momento do arquivamento
  (`EVIDENCE-P05.md:196-204`, `:330-340`).
- Os logs em `evidence/*.log` (`v1.19.4`, `v2.0.22`, `v2.0.30`, `v2.1.0`, `v2.1.2`)
  continuam sendo a rodada **pré-fix** e permanecem como histórico; qualquer afirmação de
  A2 nesta emenda **substitui** aquele `FAIL` (`EVIDENCE-P05.md:206-209`).
- `EVIDENCE-P05.md` passa a ter a seção `## Post-fix re-run (2026-10-22)` com as tabelas e
  os dois conjuntos de checksums (`:185`, `:319-338`).

### A1.5 — Ordem de resolução de permissão: `last-match-wins` (observação datada)

Classificado por probe como **`last-match-wins`** em `2.0.30`, `2.1.0` e `2.1.2`
(`EVIDENCE-P05.md:79`, `:105-108`; linhas brutas em `:88-90`), com o controle fora do glob
de allow negado nas duas ordens. Na `2.0.22` o mesmo probe é **não observável** por falta de
`ctx.permission.assert` (`EVIDENCE-P05.md:79`, `:100-104`).

**Escopo desta afirmação:** é observação de runtime **datada de 2026-10-22**, não contrato
estável do host nem garantia de versões futuras da linha `2.1.x`. Não deve ser tratada como
semântica documentada pelo host; o único uso autorizado é o de descrever o que foi medido
nessas três versões.

### A1.6 — Evidência V1 (`1.19.x`) — PASS por enforcement de config

**Critério do PASS (decisão do usuário, 2026-10-22):** enforcement **por config**, isto é,
o perfil read-only aplicado pelo próprio host — `bash`/`write`/`edit` negados, `read`
permitido, **zero side effects**. O critério **não** é hook, e `permission.ask` **não pode**
ser o critério porque o mecanismo não existe na versão.

**O hook `permission.ask` não dispara no `1.19.4` — zero invocações.** O probe dedicado
registra `mechanism: "absent"` e `hookFired: false` nos três cenários, com `hookInput: null`
(`evidence/v1-permission/v1.19.4.evidence.json:6`, `:24`, `:118`, `:153`), e os três casos
que dependiam do hook saem como `NOT_APPLICABLE` — skip explícito, nunca `PASS`
(`evidence/v1-permission/v1.19.4.log:6-8`). A string exata do nome do hook **não ocorre em
nenhum dos dois binários** (`1.19.4` e `2.0.30`): o que distingue as gerações é o
**mecanismo**, não a presença da string. No V1 o pedido de permissão vai ao **cliente**
(`permission.asked` + `GET /permission` + `POST /permission/{id}/reply`, ver abaixo); no V2 a
decisão passa por `permission.evaluate`, provado pela matriz (A1.4, A1.5).

> **Retificação de 2026-10-22:** a contagem comparativa de strings por binário que constava
> aqui foi **retirada por não ser reproduzível** (número era artefato de método de busca, não
> um fato do host). Não reintroduzir essa contagem citando este ADR.

**Como o host decide:** o pedido de permissão vai ao **cliente**. Os eventos observados são
`permission.asked`/`permission.replied` (`v1.19.4.evidence.json:63-68`); o `GET /permission`
retorna entradas com `id`, `sessionID`, `permission`, `patterns`, `metadata`, `always` e
`tool` (`:26-61`); e `POST /permission/{id}/reply {reply:"reject"}` **bloqueia de fato** — a
tool volta com erro de permissão e nenhum side effect acontece (`:71-100`, `:106-109`).

**O hook está fora do caminho de decisão:** no cenário `permission.bash: "allow"` com hook
`deny` e `hookFired: false`, o comando **executou** (`sideEffects.shell: true`,
`v1.19.4.evidence.json:113-142`). Um `deny` de hook que não dispara não veta nada.

**O enforcement por config funciona:** no cenário `bash/write/edit: deny` + `read: allow`,
`bash` e `write` voltam como tools indisponíveis, `sideEffects = {"shell":false,
"write":false}` e `read` devolve o conteúdo do arquivo
(`v1.19.4.evidence.json:144-229`); o harness fecha com `✔ V1 read-only profile: bash and
write blocked, read allowed`, 10 testes, 7 pass, 0 fail, 3 skip
(`evidence/v1-permission/v1.19.4.log:9`, `:13-19`).

**Write é governado por `edit` também no V1:** `permissionKeyObserved.write = ["edit"]`
(`v1.19.4.evidence.json:7-14`) e a ask pendente da escrita veio com `permission: "edit"`
(`:44-61`) — a mesma ação observada nos hosts V2, corroborando o fix do P0-5 (A1.4) nas duas
gerações.

**Escopo do PASS:** medido no **`1.19.4`** (host instalado e probe executado). Outros patches
da linha `1.19.x` — **não medidos**; a célula declara PASS para `1.19.x` com a evidência do
`1.19.4` e a restrição de que o mecanismo medido é config, não hook.

### A1.7 — Known Issue nova (extensão de Q5): chaves de permissão não verificadas

Nenhum host medido expôs ação de permissão para as chaves **`skill`, `websearch`,
`webfetch` e `mcp`**. As avaliações de ação observadas cobrem apenas `shell`, `edit` e
`read` (`EVIDENCE-P05.md:87-90`, `:68-70`), e o tradutor registra que entradas de
identidade (`skill`, `websearch`, `edit`) e chaves fora da tabela (`webfetch`, `mcp`, …)
**não têm ação de host observada** e ficam como passthrough em vez de serem renomeadas por
suposição (`scripts/install/config-migration.mjs:43-47`).

Estado: **não verificadas** — não são `PASS`, não são falha, e não são um defeito
declarado. Entram no pacote de GO como limitação conhecida nominal, junto dos 11 P2 de Q5,
sem alterar o status de nenhum deles.

### A1.7b — Known Issues V1 (documentadas, não corrigidas)

**KI-V1-1 — o tipo V1 declara `permission.ask`; o runtime `1.19.x` nunca o invoca.** O tipo
pinado `@opencode-ai/plugin@1.18.33` (`package.json:103`) declara
`"permission.ask"?: (input: Permission, output: { status: "ask"|"deny"|"allow" }) => Promise<void>`
em `dist/index.d.ts:225-227`, e o probe registra o hook exatamente nessa forma
(`tests/canary/v1-permission-canary.test.mjs:9-10`, `:342`). No host `1.19.4` o hook **não
dispara**: `hookFired: false` nos três cenários e `mechanism: "absent"`
(`evidence/v1-permission/v1.19.4.evidence.json:6`, `:24`, `:118`, `:153`). A proteção
read-only do produto vem da **config** (A1.6), não do hook. Registro de escopo: o plugin V1
**entregue** pelo repositório (`src/plugin.ts`) **não** declara `permission.ask` — quem
declara é o tipo do SDK e o arquivo de probe; não existe hook de produção a remover nem bug
a corrigir, apenas a expectativa do tipo a documentar.

**KI-V1-2 — divergência entre o tipo pinado e o runtime V1.** O tipo `Permission` de
`@opencode-ai/sdk@1.18.33` (`package.json:104`) é `{ id, type: string, pattern?: string |
string[], sessionID, messageID, callID?, title, metadata, time }`
(`dist/gen/types.gen.d.ts:369-372`), enquanto o runtime `1.19.4` entrega `permission` +
`patterns` (`evidence/v1-permission/v1.19.4.evidence.json:26-61`). **O tipo não corresponde
ao runtime**: um plug-in escrito contra o tipo lê campos que não existem no payload real.
Não há correção de código nesta release; fica conhecido e nominal.

> Nota de verificação: o `node_modules` local de `@opencode-ai/plugin` só traz
> `package.json` (sem `dist/`), então as linhas do `.d.ts` foram conferidas no conteúdo
> publicado da versão pinada, não em disco.

### A1.8 — Efeito no pacote de GO

Nada do exposto acima emite GO. **Bloqueio do pacote no escopo P0-5: 0.**

**Bloqueia (0) no escopo P0-5.**

O P0-5 deixa de bloquear o pacote: as duas gerações estão cobertas — V2 pela matriz
pós-fix com `SHA256SUMS` e zero `FAIL` (A1.4), V1 pelo PASS por enforcement de config no
`1.19.4` (A1.6). **Ressalva explícita:** a revisão de segurança do `@themis` **ainda não
ocorreu**. Ela é **gate de GO** por Q4/ADR (`ROADMAP.md:404` — o P0-5 está ali hoje; a
faixa `:384-425` citada na decisão original deixou de apontar para ele conforme o
`ROADMAP.md` andou, e o corpo original não é reescrito por esta emenda; `docs/RELEASE.md:106-108`),
não um item de evidência em aberto desta emenda: nenhuma célula da matriz fica pendente por
causa dela, mas o GO não é emitido antes do parecer.

**Fechados nesta emenda — não bloqueiam mais (3):**

1. **Evidência V2 do P0-5** — matriz pós-fix com `SHA256SUMS`, zero `FAIL`, A2 `PASS` nos
   cinco hosts (A1.4; `EVIDENCE-P05.md:185-204`, `:262-281`, `:317-340`).
2. **Evidência V1 do P0-5** — PASS por config no `1.19.4` (A1.6;
   `evidence/v1-permission/v1.19.4.log:9`, `v1.19.4.evidence.json:144-229`).
3. **`2.1.3` sem evidência** e **`2.0.29` sem status** — resolvidos: `2.1.3` medido com A2
   `PASS` (`EVIDENCE-P05.md:265`, `:293`, `:327`) e `2.0.29` medida e reintegrada à matriz
   (A1.3; `EVIDENCE-P05.md:200`, `:223`, `:289`).

**Não bloqueiam, mas vão no pacote (4):**

4. **Falso verde do harness na 2.0.22** — a versão saiu da matriz (A1.1), mas o relatório
   ainda imprime ✔ e classifica `deny-precedence` onde não houve decisão de política
   (`EVIDENCE-P05.md:101-104`, `:300-301`); é defeito de relatório a corrigir.
5. **Limites do que a evidência prova** — não prova que um `deny` só de `write` (sem `edit`
   pareado) bloqueie escrita, porque o PASS read-only usa perfil que nega os dois
   (`EVIDENCE-P05.md:181-182`, `:359-360`); os probes de ordem passam `action: "write"`
   explícito e exercitam o casamento do host, não o mapa do tradutor (`:357-358`); não foi
   scriptada uma chamada real de `edit` (`:180`); e o log arquivado da 2.0.22 não tem
   `.exitcode` (`:362-363`).
6. **Patch futuro da linha `2.1.x`** — se o registro publicar outro patch antes da Fase 5,
   mede-se de novo (A1.2).
7. **Known Issues V1 (A1.7b)** — tipo declara hook que o runtime não invoca e divergência
   `type`/`pattern` × `permission`/`patterns`; documentadas, não corrigidas.

### Referências da emenda

- `EVIDENCE-P05.md` (artefato externo): hosts `:12-20`; V1 sem caminho `:35-58`, `:179`;
  matriz consolidada `:66-81`; decisões brutas `:85-90`; divergências `:94-116`; status por
  célula `:120-126`; logs e exit codes `:163-169`; limites `:177-183`.
- `INSTALL-RECORD.md:12-16` (instalação por versão) e `:22` (todas as versões pedidas
  existiam no registro).
- Registro npm `@opencode/cli`, consultado em `2026-10-22T15:20Z`: `latest = 2.1.3`,
  publicada em `2026-10-22T12:44:20Z`.
- `scripts/install/config-migration.mjs:36-59`, `:65`, `:81-107`, `:138-149`.
- `tests/install-config-migration.test.mjs:223-273`.
- `package.json:143` (Node `>=26.4.0`); `docs/INSTALLATION.md:21`, `:140` (Python `3.11+`).
- Regra dura de evidência: `ROADMAP.md:63-65`; `docs/RELEASE.md:106-108`.
