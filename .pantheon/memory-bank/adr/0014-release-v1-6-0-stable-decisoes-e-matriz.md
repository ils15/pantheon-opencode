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
explícita (A1.1, A1.2, A1.3), com as retificações de A1.9.

**Evidência primária desta emenda (artefato externo ao repositório, não copiado):**
`/home/ils15/pantheon-sandbox/p05-hosts-20261022/evidence/EVIDENCE-P05.md` (doravante
`EVIDENCE-P05.md`), com os `*.log` e `*.exitcode` no mesmo diretório e o registro de
instalação em `/home/ils15/pantheon-sandbox/p05-hosts-20261022/INSTALL-RECORD.md`
(doravante `INSTALL-RECORD.md`). O conjunto **pré-fix** cobre **cinco** hosts instalados
em prefixos e `HOME`/XDG isolados: `1.19.4`, `2.0.22`, `2.0.30`, `2.1.0`, `2.1.2`
(`EVIDENCE-P05.md:12-20`, `INSTALL-RECORD.md:12-16`); `2.0.29` **não** aparece nessa
rodada pré-fix (`EVIDENCE-P05.md:183`). Nenhum host do `PATH` foi usado como evidência
(`EVIDENCE-P05.md:20`).

> **Retificação (2026-10-22, revisão de segurança):** a redação anterior dizia que
> `2.0.29` "não foi instalado", o que contradiz A1.3/A1.4. A `2.0.29` **foi instalada e
> medida na rodada pós-fix** (A1.3, A1.4; `EVIDENCE-P05.md:200` — conjunto fresco de 5
> hosts incluindo `2.0.29` —, `:223`, `:289`). O que não existe é medição **pré-fix**
> dela; `EVIDENCE-P05.md:183` descreve apenas o conjunto original e não se aplica ao
> estado final da matriz.

### A1.1 — OpenCode `2.0.22` removido da matriz: **não suportado**

Decisão do usuário (2026-10-22). A linha `2.0.22` deixa de ser "Suportado — a testar"
e passa a **não suportado** — não é o caso de "sem evidência": é reprovação verificada em
runtime, por **ausência de superfície do host** (`ctx.permission.assert` e as tools V2), e
não por falha de enforcement de permissões (precisão em A1.1, abaixo):

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

**Precisão do motivo (retificação, 2026-10-22):** a exclusão **não** é por falha de
enforcement de permissões. As células A/B/D passam na 2.0.22 no run arquivado pós-fix
(`EVIDENCE-P05.md:294` — `"write":"edit"`, read-only com `sideEffects =
{"shell":false,"write":false}`, `task` glob com `demeter` negado; C1/C2 `reject`), e o
único conjunto que fica fora é o de ordenação, por indisponibilidade de API
(`:300-301`). O motivo da exclusão são duas **ausências de superfície do host**, não
reprovação de política: (i) `ctx.permission.assert` ausente só na 2.0.22
(`EVIDENCE-P05.md:100-104`); (ii) `worktree_*` e `pantheon_bounded_read` ausentes do
catálogo de tools (`EVIDENCE-P05.md:113-116`). O `FAIL` de A2 na tabela acima é da
rodada **pré-fix** e está superado (A1.4); o "falso verde" de `:101-104` segue como
defeito de relatório (item 4 de A1.8), não como motivo de exclusão.

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
  `pushPermission`, `:329-340`), nunca por ordem de iteração.
- Mapa reverso com "primeira chave vence" preservando `edit` canônico:
  `scripts/install/config-migration.mjs:450-493` (`ACTION_TO_V1` em `:456-459`).

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

**Limitação de escopo da evidência (revisão de segurança, 2026-10-22):** a ordem
`last-match-wins` foi medida **no namespace literal `write`**, injetado via
`ctx.permission.assert` (`EVIDENCE-P05.md:296-297`, `:357-358`), mas o host avalia
**escritas reais como `edit`** (A1.4; `EVIDENCE-P05.md:69`, `:265`). Logo o resultado
**não descreve** a ordenação que governa `write`/`edit` em uso real: ele descreve a
ordem de avaliação de um namespace que o próprio host não é quem decide. Registrado como
limitação da evidência, **não** como contrato — e a linha 4 de
`docs/PERMISSIONS-QUALITY-DELEGATION.md:811` (BLOCKER — P0-5) continua exigindo a ordem
medida sobre o namespace que decide a chamada.

> **Atualização (A1.15).** Esta limitação foi **fechada**: a ordem passou a ser medida no
> namespace `edit` e por chamadas reais de escrita (`EVIDENCE-ORDER-EDIT.md`). O texto acima
> permanece como registro do estado da evidência naquele momento.

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

**Limitação correlata (registrada em A1.5):** a classe de ordenação `last-match-wins` foi
medida com `action: "write"` literal via `assert`, namespace que **não** é o que o host
usa para escritas reais (`edit`); portanto a evidência de ordem **não** cobre a ordenação
que governa `write`/`edit`, e este ADR não a promove a contrato.

**Escopo do PASS:** medido no **`1.19.4`** (host instalado e probe executado). Outros patches
da linha `1.19.x` — **não medidos**; a célula declara PASS para `1.19.x` com a evidência do
`1.19.4` e a restrição de que o mecanismo medido é config, não hook.

### A1.7 — Chaves de permissão não observadas (não é Known Issue de P0-5)

Nenhum host medido expôs ação de permissão para as chaves **`skill`, `websearch`,
`webfetch` e `mcp`**. As avaliações de ação observadas cobrem apenas `shell`, `edit` e
`read` (`EVIDENCE-P05.md:87-90`, `:68-70`), e o tradutor registra que entradas de
identidade (`skill`, `websearch`, `edit`) e chaves fora da tabela (`webfetch`, `mcp`, …)
**não têm ação de host observada** e ficam como passthrough em vez de serem renomeadas por
suposição (`scripts/install/config-migration.mjs:43-47`).

**`mcp` sai desta lista e volta a ser bloqueador** (ver A1.8): o instalador emite
`permission.mcp.<server>` com `ask` (`scripts/install/opencode.mjs:965-981`) e **nenhum**
host da matriz avaliou a ação `mcp`; a row 3 de
`docs/PERMISSIONS-QUALITY-DELEGATION.md:810` lista `mcp` **explicitamente** entre os nomes
de ação cuja falta de reconhecimento impede o GO. Isso não é aceitável como Known Issue
em P0-5.

Estado de `skill`, `websearch` e `webfetch`: **não observadas** — não são `PASS`, não são
falha declarada. E "não observado" **não** é Known Issue aceitável no escopo P0-5: pela
regra de `docs/PERMISSIONS-QUALITY-DELEGATION.md:802-804` (rows que tocam P0-5 são
**blockers, nunca Known Issues**) e pelo critério de `ROADMAP.md:448-450` (o tradutor deve
emitir **apenas** nomes de ação que o host reconhece), a ausência de observação é
**pendência de evidência** e conta como bloqueio enquanto o nome for emitido. Os mesmos
nomes já foram declarados não observados em `ROADMAP.md:438-445` (o que o host faz com
chave não reconhecida "não é verificável a partir do repositório"). Não entram, portanto,
na extensão de Q5.

> **Correção de observação (A1.13).** `skill` e `webfetch` **passaram a ser observados**: a
> matriz de nomes de ação registra `PASS` para `grep`, `glob`, `webfetch`, `skill` e
> `question` nos cinco hosts (`EVIDENCE-ACTIONS.md:16-20`, `:92`; logs `v2.*.log:14-20`).
> Permanece não observado apenas `websearch`, e ele **não é emitido** pelo produto (KI-3).
> O critério desta seção não muda; o que muda é o conjunto de fatos que ele consome.

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

Nada do exposto acima emite GO. **Bloqueio do pacote no escopo P0-5: 2 bloqueadores
abertos (≥ 1)** — contagem **da época**, **superada por A1.13** (contagem vigente: **0**).

**Bloqueia (2) no escopo P0-5 — a contagem "0" desta emenda foi refutada em A1.9.**
Registro histórico: a contagem vigente está em **A1.13** (**0**).

1. **(a) Nomes de ação emitidos e não observados no host — `mcp` primeiro.** Nenhum host
   da matriz avaliou a ação `mcp` (`EVIDENCE-P05.md:87-90`, `:68-70`), e o instalador
   emite `permission.mcp.<server>` com efeito `ask`
   (`scripts/install/opencode.mjs:965-981`). Na sequência, `webfetch`, `skill`,
   `websearch`, `grep`, `glob` e `hashline_edit` também não têm avaliação de host
   observada, e ficam como passthrough em vez de serem renomeados por suposição
   (A1.7; `scripts/install/config-migration.mjs:43-47`). A row 3 de
   `docs/PERMISSIONS-QUALITY-DELEGATION.md:810` é **BLOCKER — P0-5**, cita `mcp`
   nominalmente, e o critério de aceitação de `ROADMAP.md:448-450` exige que o tradutor
   emita **apenas** nomes de ação que o host reconhece. Pela regra de
   `docs/PERMISSIONS-QUALITY-DELEGATION.md:802-804`, linhas que tocam P0-5 são
   **BLOCKER, nunca Known Issue**.
2. **(b) Defeitos de merge introduzidos pelo próprio fix, enquanto não corrigidos** —
   `scripts/install/config-migration.mjs`:
   - **B1 — `deny` rebaixado a efeito desconhecido:** efeito não reconhecido recebe
     `UNKNOWN_EFFECT_RANK = 4` (`:68`) e o vencedor é o de posto maior (`:102`), então um
     `deny` em colisão com efeito desconhecido **perde** para o desconhecido — o oposto do
     contrato declarado `deny > ask > allow` (`:41`, `:63-65`).
   - **B2 — colisão wildcard × glob aninhado dependente de ordem:** `pushPermission`
     deduplica pela chave exata `action\0resource` (`:81-107`); `*` e um glob aninhado são
     recursos distintos, ficam ambos emitidos e o efeito passa a depender da ordem
     avaliada pelo host. A ordem medida é `last-match-wins` (A1.5;
     `EVIDENCE-P05.md:296-297`, `:271-275`), logo o resultado é sensível à ordem de
     emissão. A row 4 de `docs/PERMISSIONS-QUALITY-DELEGATION.md:811` é **BLOCKER —
     P0-5**.

**Ressalva explícita, atualizada:** a revisão de segurança do `@themis` **ocorreu em
2026-10-22** e é ela que refuta a contagem 0 (A1.9); o gate de GO por Q4 continua valendo
(`ROADMAP.md:404` — o P0-5 está ali hoje; a faixa `:384-425` citada na decisão original
deixou de apontar para ele conforme o `ROADMAP.md` andou, e o corpo original não é
reescrito por esta emenda; `docs/RELEASE.md:106-108`), e o parecer não fecha GO com os
dois bloqueadores acima abertos.

**Fechados nesta emenda — não bloqueiam mais (3):**

1. **Evidência V2 do P0-5 (parcial)** — matriz pós-fix com `SHA256SUMS`, zero `FAIL`, A2
   `PASS` nos cinco hosts (A1.4; `EVIDENCE-P05.md:185-204`, `:262-281`, `:317-340`). Vale
   para os nomes de ação **observados** (`shell`, `edit`, `read`); **não** cobre `mcp`,
   `webfetch`, `skill`, `websearch`, `grep`, `glob` nem `hashline_edit` — esses seguem
   bloqueando em (a) acima.
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

### A1.9 — Retificação por revisão de segurança (2026-10-22)

O parecer de segurança do `@themis` sobre esta emenda **refutou a contagem 0** de A1.8 e
devolveu ao estado de bloqueio os itens que ela havia declarado fechados ou Known Issue:

- `docs/PERMISSIONS-QUALITY-DELEGATION.md:802-804` estabelece que linhas que tocam o P0-5
  são **BLOCKER, nunca Known Issue**, e a row 3 (`:810`) lista `mcp` explicitamente;
- o instalador emite `permission.mcp.<server>` com `ask`
  (`scripts/install/opencode.mjs:965-981`) e **nenhum** host da matriz avaliou a ação
  `mcp`, logo a reclassificação de A1.7 era indevida;
- o critério de aceitação de `ROADMAP.md:448-450` exige que o tradutor emita **apenas**
  nomes de ação que o host reconhece; `mcp`, `webfetch`, `skill`, `websearch`, `grep`,
  `glob` e `hashline_edit` não foram observados;
- o fix introduziu dois defeitos de merge não corrigidos — `deny` rebaixado (`B1`,
  `scripts/install/config-migration.mjs:68`, `:102`) e colisão wildcard × glob aninhado
  dependente de ordem (`B2`, `:81-107`) —, relevantes porque a ordem medida é
  `last-match-wins`.

Estado resultante (contagem da época): **bloqueio ≥ 1 no escopo P0-5** — 2 bloqueadores
abertos em A1.8. **Superada por A1.13** — contagem vigente: **0**.
Nenhuma outra seção deste ADR, e nenhuma decisão de Q1–Q7, é alterada por esta nota.

> **Nota de contagem (adicionada por A1.13).** Os números "2 bloqueadores" desta seção e de
> A1.8 são **históricos**. A contagem vigente do escopo P0-5 está em **A1.13** e é **0**;
> o GO segue pendente por **processo** — o parecer do `@themis` exigido por Q4 —, não por
> bloqueador de evidência.

### A1.10 — Gate de MCP em 2.x: forma × efeito, correção aplicada e consequência de produto

**Evidência nova (2026-10-22).** Artefato primário:
`/home/ils15/pantheon-sandbox/p05-hosts-20261022/evidence/mcp-gating/EVIDENCE.md`
(doravante **`EVIDENCE-MCP.md`**), com `v2.*.log`, `v2.*.exitcode`,
`v2.*-report/mcp-gating-report.json` e `SHA256SUMS` no mesmo diretório
(`EVIDENCE-MCP.md:147-156`). A sonda é opt-in —
`tests/canary/plugin-v2-tool-canary.test.mjs` com `PANTHEON_TOOL_CANARY_MCP_GATING=1`
(`EVIDENCE-MCP.md:5-7`) — e roda em `2.0.29`, `2.0.30`, `2.1.0`, `2.1.2` e `2.1.3`
(`:9`). O resultado é **idêntico nos cinco hosts** (`:59`).

**Como o host avalia.** A chamada de uma tool MCP é avaliada com ação
**`<server>_<tool>`** e `resources: ["*"]` (`EVIDENCE-MCP.md:16-19`; evento bruto em
`:73`). `resource` é sempre `["*"]` e não discrimina nada — **`action` é o único campo
efetivo** (`:76-77`).

| Regra escrita no config | Efeito observado (idêntico nos cinco) | Evidência |
|---|---|---|
| `{action:"<server>_<tool>", resource:"*", effect:"allow"}` | executa (controle) | `EVIDENCE-MCP.md:47` |
| `{action:"<server>_<tool>", resource:"*", effect:"deny"}` | **bloqueia** | `:48` |
| `{action:"<server>_<tool>"}` com resource `echo` e `deny` | executa — `resource` inerte | `:49` |
| `{action:"<server>_<tool>"}` com resource `<server>_<tool>` e `deny` | executa — `resource` inerte | `:50` |
| `{action:"<server>_<tool>"}` com resource `<server>_*` e `deny` | executa — `resource` inerte | `:51` |
| `{action:"<server>_*", resource:"*", effect:"deny"}` | **bloqueia** todas as tools do servidor | `:52` |
| `{action:"<server>", resource:"*", effect:"deny"}` | executa — nome de servidor não é ação | `:53` |
| `{action:"mcp", resource:"<server>" \| "*", effect:"deny"}` | executa — ação `mcp` é inerte | `:54-55` |
| `{action:"canary-mcp_*", resource:"*", effect:"deny"}` (servidor com hífen) | **bloqueia** — o glob casa hífen | `:56` |
| `{action:"<server>_<tool>", resource:"*", effect:"ask"}` | **esconde** a tool; **não** pergunta | `:57` |

O `deny` é **catalog-level**, não call-time: a tool sai do catálogo antes de o modelo
vê-la e **nenhum `permission.evaluate` é emitido** para a chamada negada
(`EVIDENCE-MCP.md:59-61`); o resultado literal no Code Mode é
`Unknown tool 'canary.echo'.` (`:65-68`). O gate, portanto, é de **exposição**, não
sandbox: o processo do servidor continua iniciando e alcançável quando as tools são
escondidas (`:142-143`).

**Correção aplicada (código, sem commit).**
- `convertMcpPermissions` traduz `permission.mcp.<server>` para a forma que o host
  honra: `deny` → `{action:"<server>_*", resource:"*", effect:"deny"}`, `allow` → idem
  `allow`, e **`ask` → nenhuma regra + warning explícito**
  (`scripts/install/config-migration.mjs:342-401`; ramos em `:385-388` e `:389-396`).
- O bloco `permission.mcp` passa por esse tradutor em vez do mapa de ações
  (`scripts/install/config-migration.mjs:421-423`), e a regra inerte `action:"mcp"`
  **deixa de ser emitida** (`tests/install-config-migration.test.mjs:423-427`). Num
  alvo V2 o bloco é consumido: `allow`/`deny` viram `<server>_*`, `ask` não deixa
  regra nenhuma.
- O instalador **mantém** os defaults `ask` de `pantheon-code-mode` e
  `pantheon-vision` para compatibilidade V1 (`scripts/install/opencode.mjs:981-982`,
  `:990-991`), mas **avisa na instalação** que não são aplicáveis no 2.x
  (`:994-1005`; texto em `scripts/install/strings.mjs:49-52` e `:111-114`).
- A allowlist `mcp_tools` do frontmatter vira regra nativa: `<alias>_*` `deny` por
  servidor e depois `<alias>_*`/`<alias>_<tool>` `allow` conforme a allowlist
  (`scripts/install/opencode.mjs:346-390`, ligado em `:1855-1859`) — as duas formas
  medidas como efetivas.
- O comportamento fica fixado por teste: `tests/install-config-migration.test.mjs:410-497`
  (`deny`→`<server>_*` em `:416-428`, `allow` em `:430-437`, `ask` sem regra + warning
  em `:439-457`, determinismo de ordem de chave em `:459-478`).

**Consequência de produto.** **`ask` não existe para MCP no 2.x.** Quem tem `ask` nos
defaults **não está protegido** — está apenas avisado, e a tool continua disponível.
`deny` funciona, e funciona via `<server>_*`. Traduzir `ask` para uma ação de MCP seria
pior que não traduzir: `effect:"ask"` **esconde** a tool, isto é, removeria em silêncio
`pantheon-code-mode` e `pantheon-vision` sem prompt e sem equivalente ao
comportamento que o nome promete (`EVIDENCE-MCP.md:109-114`). A escolha registrada é
**nenhuma regra + warning** — nunca um `deny` nem um `allow` implícitos.

### A1.11 — Known Issues desta emenda

Nominais, como exige Q5: aceitação explícita, nunca silenciosa.

| ID | Known Issue | Evidência |
|---|---|---|
| **KI-1** | **`ask` não é expressável para MCP** e os defaults do instalador são afetados. `effect:"ask"` em ação de MCP **esconde** a tool em vez de perguntar; o tradutor emite zero regra e avisa, o instalador reporta por servidor. Os dois servidores com default `ask` (`pantheon-code-mode`, `pantheon-vision`) ficam **sem gate** no 2.x. | `EVIDENCE-MCP.md:57`, `:109-114`; `scripts/install/config-migration.mjs:389-396`; `scripts/install/opencode.mjs:981-982`, `:990-991`, `:994-1005`; `scripts/install/strings.mjs:49-52`, `:111-114` |
| **KI-2** | **`hashline_edit` e `vision_describe` não têm gate de permissão.** São plugin tools alcançáveis só por Code Mode; o host **não emite avaliação de permissão** para elas, então nenhuma regra as gateia. A negação existe no template (`hashline_edit: deny`) e é executada **pelo guard do plugin**, não pela camada de permissão. **Por que não é bloqueador:** não há nome de ação a reconhecer — o evento não existe, e o probe só reporta `NOT_APPLICABLE` depois de a chamada **completar** (`part="completed"`), ou seja, a ausência é da camada de permissão, não de um caminho morto. | `EVIDENCE-ACTIONS.md:22-23`, `:62-74`; `EVIDENCE-MCP.md:118-124`; `src/plugin-v2.ts:1132-1138`; `src/agents/apollo.md:15`; `src/agents/gaia.md:14`; `src/agents/zeus.md:8`, `:10`; `src/agents/aphrodite.md:10` |
| **KI-3** | **`websearch` não foi medido — e não é emitido pelo produto.** O probe foi **tentado**: com nenhum provider configurado o turno nunca settleu, o run passou de 300 s e foi morto, e o caso foi removido em vez de ficar flaky (`EVIDENCE-ACTIONS.md:24`, `:76-81`). Não há `permission.websearch` em `src/agents/` (0 ocorrências), `src/routing.yml:551` é apenas alias de tool (`web_search: websearch`) e o instalador declara que **não** semeia `permission.websearch: "deny"` porque é restrição pessoal (`scripts/install/opencode.mjs:277-278`; `PRODUCT_CONFIG_DEFAULTS` só tem `default_agent`, `:293-295`). Só existe regra se o config do usuário já tiver a chave, e aí ela passa por identidade como ação `websearch` (`scripts/install/config-migration.mjs:45-47`, `:57`). **Por que não é bloqueador:** o produto não emite a chave, logo não há regra nossa pendente de verificação — é não medido, não não reconhecido. | `EVIDENCE-ACTIONS.md:24`, `:76-81`; `EVIDENCE-MCP.md:126-130`; `src/routing.yml:551`; `scripts/install/opencode.mjs:277-278`, `:293-295` |
| **KI-4** | **`2.0.22` está fora por ausência de superfície, não por falha de permissão.** As células A/B/D passam nela; o que falta é `ctx.permission.assert` e as tools V2 no catálogo. | A1.1; `EVIDENCE-P05.md:100-104`, `:113-116`, `:294`, `:300-301` |
| **KI-5** | **Divergência entre o tipo pinado e o runtime V1** (`KI-V1-2` de A1.7b): o tipo `Permission` do SDK pinado declara `type`/`pattern`, o runtime `1.19.4` entrega `permission`/`patterns`. | A1.7b; `package.json:103-104`; `evidence/v1-permission/v1.19.4.evidence.json:26-61` |
| **KI-6** | **Bloco `agents` V2: o campo gerenciado é sobrescrito — a ordem do usuário só sobrevive para agente exclusivo do bloco V2.** Mecanismo real (a redação anterior descrevia o inverso): `MANAGED_AGENT_FIELDS` **inclui `permissions`** (`scripts/install/config-migration.mjs:804-812`) e `mergeManagedAgents` **sobrescreve** os campos gerenciados com os valores V1 (`:864-880`, laço em `:877-879`). Para um agente presente nos **dois** blocos o array da base é **descartado**, não preservado — entra o valor convertido e canonicamente ordenado. O passthrough **sem reordenação** vale apenas para um agente que exista **só** no bloco V2: `{ ...base }` o mantém intacto (`:865`) e nada o reordena. Nesse caso a direção é **fail-open**: se o array do usuário trouxer um `allow` amplo **depois** de um `deny` específico, `last-match-wins` faz o allow vencer e o `deny` deixa de valer — sem aviso, porque não houve merge. Débito correlato já declarado no código: o instalador ainda escreve a grafia V1 `permission` (`:798-802`), então um agente pode carregar as duas chaves e a V1 fica morta. **Por que continua aceito:** só alcança config escrito à mão pelo usuário, não o que o instalador emite (que sai ordenado). | `scripts/install/config-migration.mjs:804-812`, `:864-880`, `:865`, `:877-879`, `:798-802`; `scripts/install/opencode.mjs:308-322` |
| **KI-7** | **O mapa reverso resolve por restritividade — e é lossy.** `convertPermissionsV2toV1` funde o mesmo key+resource com `resolveEffects`, então `[{edit,*,deny},{edit,*,allow}]` volta como `deny`: direção segura, mas o `allow` desaparece **sem aviso**. Ações fora da tabela passam como chave literal. | `scripts/install/config-migration.mjs:450-490` (merge em `:472-476`; mapeamento em `:456-459`, passthrough em `:466`) |
| **KI-8** | **A ordem `<server>_*` × `<server>_<tool>` vem da comparação lexical da _ação_, não de uma noção de especificidade.** `comparePermissions` ordena primeiro por `action` (`:112-114`); como `*` é 0x2A e todo caractere válido de nome é maior (`-` 0x2D, `.` 0x2E, dígitos 0x30+, `_` 0x5F, letras), e nomes são validados em `[a-zA-Z0-9._-]`, `<server>_*` **sempre** sai antes de `<server>_<tool>` e a literal é a última — com `last-match-wins`, a literal vence. **Nos dois sentidos:** deny amplo `canary_*` + allow específico `canary_echo` → o allow sobrevive no escopo (escopo intencional preservado); allow amplo `canary_*` + deny específico `canary_echo` → o deny vence (fail-closed). **Seguro nos dois sentidos hoje, portanto não é bloqueador**; o que fica aberto é manutenção — se o validador de nomes relaxar ou o host mudar a composição do nome, a premissa cai sem teste que avise. | `scripts/install/config-migration.mjs:111-124` (ordenação derivada do comparador, não medida como par); `scripts/install/opencode.mjs:355`, `:362`; `EVIDENCE-MCP.md:47-48`, `:56` |

Nenhum dos oito é bloqueador disfarçado: **KI-1** é fail-open **anunciado** por servidor e
não toca o read-only de `shell`/`edit`, que está medido (B1–B3, `bench/results/p05-permission-matrix-2026-10-22.md:67-69`);
**KI-2** e **KI-3** são ausência de superfície / de emissão, não nome não reconhecido;
**KI-4** é host fora da matriz; **KI-5** é divergência de tipo de SDK; **KI-7** erra para o
lado **fail-closed** (o `deny` permanece); **KI-6** pode errar para o lado **fail-open**, e é
por isso que ele está escrito acima com o mecanismo e a direção corretos, em vez de
reaproveitar a redação anterior; **KI-8** foi verificado seguro nos dois sentidos.

**Lista autoritativa de Known Issues desta release: KI-1 … KI-8 — exatamente os oito
acima, e nenhum outro.** É esta a lista que o `ROADMAP.md` e o pacote de GO devem citar.
Nenhuma correção desta rodada criou KI novo: **B6** e **B7** foram **corrigidos** (A1.14),
**D-2** foi **medida e fechada** (A1.15) e os achados de documentação **D-1/D-3/D-4** não são
Known Issues de produto — são bloqueadores de parecer, tratados em A1.13.

### A1.12 — Retificação de A1.4/A1.2: a política de ordenação é especificidade, não restritividade global

A política que vale hoje são **duas perguntas separadas**, não uma:

1. **Mesmo `action` + mesmo `resource` → restritividade** (`deny > ask > allow`), com
   efeito desconhecido **nunca** substituindo um conhecido e `deny` sempre vencendo
   (`resolveEffects`, `scripts/install/config-migration.mjs:276-306`, chamado por
   `pushPermission`, `:329-340`).
2. **Recursos distintos → especificidade.** A emissão vai do menos específico para o
   mais específico — `*` → glob → literal — porque o host resolve sobreposição com
   `last-match-wins`; a regra mais específica é a última e vence
   (`resourceSpecificity`, `:91-95`; `comparePermissions`, `:111-123`; `sortPermissions`,
   `:144-151`; aplicação em `:438`).
3. **Restritividade dentro da mesma classe de especificidade é só desempate**, e
   `deny` fica por último **naquela classe**, nunca "por último para a ação inteira"
   (`effectEmissionOrder`, `:86-88`; desconhecido = `2.5`, `:77-81`).

Consequência verificável, no caso que o produto realmente entrega: o `allow` escopado do
`mnemosyne` **sobrevive** ao `deny` amplo — `write`/`edit` com `"*": deny` mais
`.pantheon/memory-bank/**`: `allow` e `.pantheon/deepwork/**`: `allow`
(`src/agents/mnemosyne.md:24-40`); **fora do escopo, `deny`**. Um `deny` emitido depois
de um `allow` escopado não vence por ser `deny`: vence por ser mais específico.

**Alcance desta retificação.** Ela substitui qualquer leitura de A1.4/A1.2 que trate
`deny` como globalmente último. O texto de A1.4 ("restritividade, nunca por ordem de
iteração") descreve apenas o caso *mesmo recurso* — fica **incompleto, não errado** —, e
os números de linha que ele cita estão defasados: `pushPermission` não está mais em
`:81-107` (hoje `:329-340`) nem o mapa reverso em `:138-149` (hoje `:450-490`).
A1.8/B2 é **fechado** por (2)+(3): dois recursos distintos não dependem mais da ordem de
iteração das chaves V1, porque a ordenação é canônica e o desempate final é por code
unit (`:114`, `:121-122`).

### A1.13 — Recontagem de bloqueios (contagem vigente única)

> **Retificação (2026-10-22, segunda passada).** A redação anterior desta seção contou
> quatro bloqueadores por "ação nunca observada" (`webfetch`, `grep`, `glob`, `question`)
> e somou um quinto fora de recorte (`permission.task`). **As duas contagens estavam
> erradas por falta de leitura de evidência que já existia**: há um artefato dedicado de
> cobertura de nomes de ação, e a matriz de permissão mede o glob de `task`. O texto fica
> corrigido abaixo, contra os arquivos.

**Evidência que resolve (medida, não inferida).** Artefato
`/home/ils15/pantheon-sandbox/p05-hosts-20261022/evidence/action-names/EVIDENCE.md`
(doravante **`EVIDENCE-ACTIONS.md`**): sonda
`tests/canary/plugin-v2-tool-canary.test.mjs` em modo matriz
(`PANTHEON_TOOL_CANARY_PERMISSION_MATRIX=1`), com a expectativa sempre igual à saída do
próprio tradutor (`migrateV1toV2`) — nunca uma lista de nomes do teste
(`EVIDENCE-ACTIONS.md:3-10`). Resultado idêntico nos cinco hosts (`:12`).

| Nome | Host avalia | Tradutor emite | Veredito | Evidência |
|---|---|---|---|---|
| `grep` | `grep` / `["CANARY-ALPHA"]` | `grep` | **PASS** | `EVIDENCE-ACTIONS.md:16`; `v2.1.3.log:14`; `v2.0.29.log:14` |
| `glob` | `glob` / `["*.txt"]` | `glob` | **PASS** | `EVIDENCE-ACTIONS.md:17`; `v2.1.3.log:15`; `v2.0.29.log:15` |
| `webfetch` | `webfetch` / URL | `webfetch` | **PASS** | `EVIDENCE-ACTIONS.md:18`; linha 16 de `v2.0.29.log`, `v2.0.30.log`, `v2.1.0.log`, `v2.1.2.log`, `v2.1.3.log` |
| `skill` | `skill` / `["canary-skill"]` | `skill` | **PASS** | `EVIDENCE-ACTIONS.md:19`; `v2.1.3.log:17`; `v2.0.29.log:17` |
| `question` | `question` / `["*"]` | `question` | **PASS** | `EVIDENCE-ACTIONS.md:20`; linha 20 de `v2.0.29.log`, `v2.0.30.log`, `v2.1.0.log`, `v2.1.2.log`, `v2.1.3.log` |
| `read` / `shell` / `edit` | idem | idem | **PASS** | `EVIDENCE-ACTIONS.md:25-26`; `bench/results/p05-permission-matrix-2026-10-22.md:63-65` |

**`permission.task` glob também está medido**, e não é pendência:
`bench/results/p05-permission-matrix-2026-10-22.md:75-76` traz **D1**
(`{"*": "deny", "apollo": "allow"}` → `apollo` completa com 1 child session e
avaliação `subagent/apollo allow`) e **D2** (`demeter` → `Permission denied: subagent`,
0 child sessions), **PASS nos cinco hosts**; valores brutos em `:95-96`. Os logs
confirmam (`v2.1.3.log:25` e a mesma linha `✔` em `v2.0.29.log:25`, `v2.0.30.log:25`,
`v2.1.0.log:25`, `v2.1.2.log:25`). `EVIDENCE-ACTIONS.md:92` fecha o conjunto: action
names, read-only profile, resolution order e task glob passam nos cinco.

**Nenhum host é exceção.** Cada uma das linhas acima foi lida no log do host indicado;
não existe host em que um desses nomes ou D1/D2 tenha falhado. O único `✖` desses logs é
o diferencial de MCP (`v2.1.3.log:22`), que é da rodada **pré-fix** e está coberto por
`EVIDENCE-MCP.md:45-57` e pela tradução em `scripts/install/config-migration.mjs:385-388`.

| Item do escopo P0-5 | Situação | Evidência |
|---|---|---|
| `webfetch`, `grep`, `glob`, `question`, `skill` | **observados PASS** nos cinco hosts | `EVIDENCE-ACTIONS.md:16-20`; logs `v2.*.log` linhas 14-20 |
| `read`, `shell`, `edit`, `task`→`subagent` | **observados PASS** | `EVIDENCE-ACTIONS.md:25-26`; `bench/results/p05-permission-matrix-2026-10-22.md:63-65` |
| `mcp` | **resolvido**: `<server>_*` bloqueia; `action:"mcp"` é inerte e não é mais emitido | `EVIDENCE-MCP.md:48`, `:52`, `:56`; `scripts/install/config-migration.mjs:385-388`; `tests/install-config-migration.test.mjs:423-427` |
| Ordem / `last-match-wins` | **medida** (C3/C4/C5 são observações por desenho) | `bench/results/p05-permission-matrix-2026-10-22.md:70-74` |
| `permission.task` glob | **medido PASS** (D1/D2) | `bench/results/p05-permission-matrix-2026-10-22.md:75-76`; `v2.*.log:25` |
| B1 / B2 (defeitos de merge) | **corrigidos** no código | `scripts/install/config-migration.mjs:91-151`, `:276-306` |
| B6 (V2 puro reordenado) / B7 (nome MCP inválido) | **corrigidos** no código (A1.14) | `scripts/install/config-migration.mjs:1134-1137`, `:1014-1019`, `:200-218`, `:348`, `:379-384` |
| D-2 (ordem no namespace `edit`) | **medida e fechada** (A1.15) | `evidence/order-edit/EVIDENCE.md:34-58`, `:60-65` |
| `hashline_edit` / `vision_describe` | ausência **estrutural** de superfície → KI-2 | `EVIDENCE-ACTIONS.md:22-23`, `:62-74` |
| `websearch` | **não medido** (run morto em 300 s) e **não emitido** pelo produto → KI-3 | `EVIDENCE-ACTIONS.md:24`, `:76-81` |

**Bloqueadores no escopo P0-5 (código/evidência): 0 (zero).** Nenhum item fica aberto por falta
observação; os dois que não são `PASS` são **ausência estrutural de superfície**
(KI-2) e **chave que o produto não emite** (KI-3), não nomes emitidos que o host não
reconhece.

**Ressalva de escopo, para o zero não ser lido como absoluto.** O zero vale para os
**defaults do produto**: os cinco nomes questionados passam, `mcp` está resolvido e
`permission.task` está medido. Um nome continua pendente **se e somente se** o config do
usuário já trouxer a chave: `permission.websearch` é mapeado por identidade
(`scripts/install/config-migration.mjs:57`) e a ação `websearch` **nunca foi medida**
(`EVIDENCE-ACTIONS.md:76-81`; o próprio artefato registra que "the translator already emits
`websearch` verbatim"). É entrada de usuário, não emissão do produto — mas, se o critério de
`ROADMAP.md:448-450` for aplicado a config arbitrário em vez de aos defaults, **este é o
único nome pendente**, e ele é não medido, não reprovado.

**Contagem única e vigente: 0.** A1.8 ("2 bloqueadores") e A1.9 ("2 bloqueadores
abertos") ficam como **registro histórico** do estado anterior e não são a contagem
vigente; esta seção não afirma, em nenhum ponto, "0 bloqueadores" e "GO negado por
≥ 1" ao mesmo tempo.

**Classificação da contagem (terceira passada).**

- **Bloqueadores de código/evidência no escopo P0-5: 0.** B1/B2 e B6/B7 corrigidos (verificado
  por leitura de código — ver a ressalva de teste abaixo), D-2 medida e fechada, nomes de ação
  `PASS`, `permission.task` `PASS`, `mcp` resolvido.
- **Bloqueadores de parecer: 3 — D-1, D-3 e D-4, todos de documentação.** Continuam abertos e
  **impedem o parecer**, não o código: são pendências documentais apontadas na revisão. Os
  identificadores vêm da revisão; este ADR não os reescreve e **não encontrou artefato deles**
  no repositório nem no memory bank, então não afirma o conteúdo de cada um. Enquanto não
  fecharem, o `@themis` não emite parecer e, por Q4, não há GO — por **processo**, não por
  defeito de código.

**Testes de B6/B7 — existem, e discriminam.** A verificação anterior estava errada por
**instrumento**, não por ausência de teste: os testes assertam **comportamento** (`deepEqual`,
`effectiveEffect`) e casam o aviso por **regex**, não pelas strings literais de implementação —
por isso um `grep` pelas mensagens deu 0. Os nomes, verificados no arquivo:

- `describe('existing V2 permissions ordering (B6)')` — `tests/install-config-migration.test.mjs:680`,
  fecha em `:790`, **7 testes** (6 de ordenação + 1 de entradas malformadas):
  `does not reorder a V2-only array, so a literal deny stays deny` (`:690`);
  `… so a glob deny stays deny` (`:702`); `does not treat an empty V1 block as a reason to
  reorder a pure V2 array` (`:714`); `warns when a merge reorders a deny into an allow
  (literal)` (`:736`); `… (glob)` (`:748`); `does not warn when reordering leaves the
  effective effect unchanged` (`:761`); `does not throw on malformed entries and preserves
  them with a warning` (`:772-789`).
- `emits no rule for an invalid server name and says why (B7)` — `:439-457` (casos `*` e
  `my server`, cada um com `deepEqual(permissions, [])` e asserção do aviso).

**Discriminação por mutação** (parecer do `@themis`): forçar `sortPermissions` no V2 puro faz o
`deepEqual` de `:694` falhar; trocar `MCP_SERVER_NAME_PATTERN` por `/.*/` volta a emitir `*_*` e
falha o `deepEqual(..., [])` de `:444-448`. Mtimes confirmam a ordem: teste `16:29:59`, ADR
`16:42:36` — os testes são **anteriores** a esta emenda.

**P0-5 está pronto para re-revisão — não está fechado.** Quem fecha é o parecer do
`@themis`: Q4 é **gate de processo** sobre esse parecer, não um item de evidência que
esta emenda possa declarar cumprido. Sem o parecer, não há GO — por processo, não por
bloqueador de evidência listado aqui.

### A1.14 — Correções B6, B7 e endurecimentos menores (2026-10-22, terceira passada)

Achados da revisão **seguinte** a A1.13; nenhum dos dois constava da contagem anterior.

**B6 — array `permissions` V2 puro não é mais reordenado.** Quando existe só `permissions`
(sem bloco `permission` V1), `resolveTopLevelPermissions` devolve o array **intacto** e apenas
reporta entradas malformadas (`scripts/install/config-migration.mjs:1134-1137`). A ordenação
canônica passou a ocorrer **somente no merge V1+V2** (`mergePermissionArrays`, `:1014-1019`;
resultado ordenado em `:1065-1067`) e, antes de aplicá-la, ela é confrontada com o efeito
efetivo já em disco: `warnOrderingChangesEffectiveEffect` (`:200-218`) sonda cada
`action`+`resource` distinto e só avisa em `deny` → não-`deny` (`:212-216`), nomeando action,
recurso e os dois efeitos.

| Entrada no config | Comportamento resultante |
|---|---|
| só `permissions` (V2 puro) | ordem do **usuário preservada**, nenhuma reordenação (`:1134-1137`) |
| só `permission` (V1) | convertido e ordenado canonicamente (`:1122`, `:438`) |
| ambos, com **regras** V1 | base V2 preservada, regras V1 anexadas/mergeadas, resultado ordenado (`:1014-1019`, `:1065-1067`) — com **warning** se a ordem canônica, sozinha, transformar um `deny` efetivo em efeito mais fraco (`:200-218`) |
| ambos, mas o bloco V1 **converte a zero regras** (`permission: {}` ou só entradas que não são regra) | **não há merge nem warning**: `hasV1Rules` é falso e o array V2 volta **intacto** (`:1119-1122`, `:1146`); fixado por `does not treat an empty V1 block as a reason to reorder a pure V2 array` (`tests/install-config-migration.test.mjs:714-734`) |

Repro que fixa a regra: V2 puro mantém `a.ts` como `deny`; com um bloco V1 **que produz
regras** (`permission: { read: "allow" }`), `a.ts` passa a `allow` **com aviso**. Bloco V1
vazio não muda nada e não avisa. A mudança de efeito nunca é silenciosa.

**B7 — nome de servidor MCP validado.** `MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/`
(`:348`) e a validação em `:379-384`: nome inválido — incluindo `*` — gera **nenhuma regra +
warning**. Antes, um nome como `*` emitia a ação `*_*`, que nenhum host produz: um gate que só
parecia gate (justificativa no comentário de `:342-347`). O padrão espelha
`deriveNativeMcpPermissions` (`scripts/install/opencode.mjs:355`), para que a ação emitida seja
um nome que o host consegue compor.

**Menores.** Entrada não-objeto em `permissions` é **preservada** com warning, nunca lança:
`warnInvalidPermissionEntries` (`:132-142`) e `sortPermissions` (`:144-151`, com as malformadas
mantidas no fim, fora da ordenação). O aviso de `ask` é deduplicado para **1 por servidor** no
caminho de install (`suppressAskWarning`, `:371`, `:389-394`; `INSTALLER_MCP_SERVERS`,
`:1070-1082`), porque `applyMcpServerEntries` já reporta cada `ask` semeado.

**Efeito na contagem.** Nenhum dos dois era bloqueador listado. As correções removem os últimos
caminhos conhecidos de (i) `deny` enfraquecido **em silêncio** por reordenação e (ii) ação
emitida que nenhum host produz. A contagem de A1.13 continua **0** no escopo de código.

### A1.15 — D-2 fechada: a ordem está medida no namespace que decide a chamada

Artefato: `/home/ils15/pantheon-sandbox/p05-hosts-20261022/evidence/order-edit/EVIDENCE.md`
(doravante **`EVIDENCE-ORDER-EDIT.md`**), com `v2.*.log`, `v2.*.exitcode`, snapshots de config e
`SHA256SUMS` no mesmo diretório; hosts `2.0.29`, `2.0.30`, `2.1.0`, `2.1.2`, `2.1.3` (`:8`).

- A limitação de A1.5 era real e está registrada lá: os probes de ordem usavam
  `action:"write"`, mas o host avalia escrita real como **`edit`** (`EVIDENCE-ORDER-EDIT.md:10-12`).
  D-2 pediu a mesma medição **no namespace avaliado**.
- Método: probes refeitos com `action:"edit"` **e** chamadas reais de `write`, com ground truth
  no **conteúdo do arquivo** — não no status da tool (`:16-30`).
- Resultado idêntico nos cinco hosts: C1–C5 iguais em `write` e `edit`, classe
  **`last-match-wins`** (`:34-47`), com a conclusão explícita "The class does not change between
  `write` and `edit`" (`:47`).
- Chamadas reais (`:49-58`), três ordens de regra:
  `deny .pantheon/**` → `allow .pantheon/memory-bank/**` ⇒ memory-bank **escrito**, fora negado
  (`Permission denied: edit`); `allow .pantheon/memory-bank/**` → `deny .pantheon/**` ⇒ ambos
  negados; `allow .pantheon/**` → `deny .pantheon/memory-bank/**` ⇒ memory negado, fora **escrito**.
- Veredito do artefato: **D-2 fechada em 2.0.29–2.1.3**; ambos os namespaces produzem a mesma
  classe e `sortPermissions` fica ancorado no namespace que o host realmente avalia (`:60-65`).

**Consequência para A1.5/A1.12.** A ressalva de A1.5 ("a ordem não descreve a ordenação que
governa `write`/`edit` em uso real") **deixa de valer**. A política de A1.12 passa a estar
ancorada em `edit`, e o caso do `mnemosyne` deixa de ser inferência: tem contrapartida medida —
o `allow` escopado sobrevive **dentro** do escopo e o `deny` amplo continua valendo **fora**
dele (`EVIDENCE-ORDER-EDIT.md:53`).

### A1.16 — Otimização de contexto dos AGENTS.md (decisão registrada)

A decisão existe e este ADR apenas a registra; não a reabre.

- Contratos fixados por teste: tetos por artefato — `AGENTS.global.md` 9.500 B / 140 linhas e
  `AGENTS.md` 1.800 B (`tests/agents-md-budget.test.mjs:42-54`) — e **exclusividade de 15
  frases-gate**, cada uma em exatamente um dos dois artefatos sempre-carregados (`:146-163`,
  `:167-181`).
- Baselines declarados no próprio teste: `AGENTS.global.md` 9.493 B / 120 linhas e `AGENTS.md`
  1.703 B, medidos após a dedupe da Fase A (`:19-21`). O arquivo tem **120 linhas** hoje
  (verificado em `AGENTS.global.md`); o valor de 9.488 B do relatório de otimização está dentro
  do teto e na mesma faixa do baseline — a diferença é de medição, não de contrato.
- `src/instructions/zeus-memory-operations.instructions.md` fica reduzido ao que é específico do
  Zeus; o que é compartilhado vive nas seções comuns (arquivo referenciado por
  `tests/memory-delegation-prompt.test.mjs:9`).
- **Fase B adiada, por condição explícita:** converter os quatro playbooks do Zeus em skills
  **não** entra nesta release. A condição é **provar carregamento de skill sob demanda** primeiro;
  sem essa prova, a Fase B não é executada.

### A1.17 — P0-6: decisão "só detecção" no `doctor` (registro da decisão)

**Por que esta seção existe:** a decisão existia só no código. `grep` por `P0-6` e por
`plugin_path_missing` em `.pantheon/`, `docs/` e `README.md` retorna **0 ocorrências**; o que
existe é a implementação (`scripts/doctor.mjs`), o teste de regressão — que já se declara
`P0-6 regression (ADR-0014)` (`tests/doctor-plugin-path-staleness.test.mjs:2`) — e o
`ROADMAP.md`, que ainda lista o item como `OPEN` (`:73`, `:211`, `:594`). O **racional** não
estava registrado; fica aqui. Este ADR não altera o `ROADMAP.md`.

**Problema.** O instalador grava um caminho **absoluto** no config do host e só o `init` o
re-resolve; uma rota de upgrade que não rode `init` (prefixo npm diferente, cache npx limpo,
árvore movida) deixa o config apontando para uma árvore que não existe, e o host **descarta o
plugin em silêncio** — a instalação fica sem superfície de tools e sem erro
(`tests/doctor-plugin-path-staleness.test.mjs:4-9`; `scripts/doctor.mjs:1381-1385`).

**As três opções avaliadas.**

| Opção | Veredito | Razão |
|---|---|---|
| (a) gravar ref portátil no config | **inviável** | Não há evidência de que o host aceite algo além de diretório absoluto; o comportamento foi medido em **2.0.22**. A medição não está arquivada neste repositório — fica registrada como afirmação da decisão, **não** como artefato citável. |
| (b) re-resolver na leitura | **impossível** | Quem lê `opencode.json` é o **host**; o repositório não tem hook nesse caminho. |
| (c) detecção **fail-closed** no `doctor` | **escolhida** | O `doctor` é o único ponto do produto que roda depois de qualquer rota de upgrade e antes do uso. |

**Resultado da opção (c).**

- **Árvore sumiu → bloqueante.** `reportDanglingPluginRegistrations` emite `error(...)` com
  `code: 'plugin_path_missing'`, `classification: 'error'` (`scripts/doctor.mjs:1390-1408`,
  `:1399-1405`), e a checagem roda **antes** da comparação de versões, justamente porque uma
  árvore ausente não tem versão a comparar e o laço antigo passava por ela como "skipped"
  (`:1496-1500`).
- **Árvore existe e está antiga → `warn` de drift.** `checkPluginVersionDrift` compara a versão
  da árvore registrada com a deste pacote e emite `warn` ("the registered tool surface is
  stale", remédio: `init`) sem bloquear (`:1523-1527`).
- **Terceiros e specs npm → ignorados.** `managedPluginPath` devolve `null` para qualquer ref
  que não seja identidade Pantheon (`:1361-1363`, `:1368-1376`), e o laço faz `continue`
  (`:1393`). As identidades são `src/plugin.ts`, `src/plugins/pantheon-hooks.ts`, `src/plugin-v2`
  e o legado `src/plugin-v2.ts` (`MANAGED_PLUGIN_IDENTITIES`, `:1342-1349`), reconhecidas também
  sob o marcador `/node_modules/pantheon-opencode/` (`:1314`, `:1372-1375`).
- **`managedPluginPath` é quem define a identidade** (`scripts/doctor.mjs:1368-1376`): é ele que
  separa "superfície que este instalador possui" de "caminho do usuário", e é a razão de o check
  não gerar falso positivo em plugin de terceiro.

**Não-escopo explícito.** A config **não é auto-corrigida**: o `doctor` apenas detecta e aponta
o remédio (`pantheon-opencode init`, mensagem em `:1400-1404`). Auto-corrigir exigiria
`doctor --fix` ou reescrever a config viva num `postinstall` — as duas mudam arquivo do usuário
fora de uma ação explícita, e por isso só entram com **aprovação humana**.

**Ressalvas do parecer (aceitas, não corrigidas aqui).**

- `isV2PluginRef` lê `path`/`source`/`id`/`name` e **ignora a chave `package`**
  (`scripts/doctor.mjs:1560-1565`): um ref declarado via `package` não é reconhecido como V2.
  É **pré-existente** ao P0-6.
- Árvore cujo `package.json` não é legível não entra na comparação
  (`readInstalledPluginVersion` → `null` → `continue`, `:1514-1515`); e sem versão legível
  deste pacote o check sai como `no-version`/`stale`, não como drift (`:1502-1507`). Em ambos os
  casos o resultado é **skip honesto**, nunca `PASS`.

**Status.** Decisão tomada e implementada; o fechamento do **item** no `ROADMAP.md` é de outro
especialista — lá ele ainda consta `OPEN`. Esta seção registra a decisão, não muda o estado do
item.

### A1.18 — P0-3: **fechado** — parecer de 2026-10-22

**Status: `PASS_WITH_NOTES` / `approve`.** O parecer final declarou o P0-3 **fechado**. Os três
bloqueadores foram verificados no parecer por **reprodução independente** — posse por ref
Pantheon (bloqueador 1), superfície 1.5 reconhecida (2), spec npm tratada como `unverifiable`
informativo (3) — e `node scripts/doctor.mjs` no repositório deu **0 errors, exit 0**
(execução do parecer; **não** re-executada nesta emenda, que é doc-only).

> **Retificação (2026-10-22).** Uma redação anterior desta seção registrava o bloqueador 3 como
> **aberto** e descrevia a superfície V2 como arquivo único. O código mudou depois daquela
> leitura; a tabela abaixo é o estado final, com as linhas conferidas uma a uma.

| # | Defeito encontrado | Correção verificada | Linha real (conferida) |
|---|---|---|---|
| 1 | Plugin de **terceiro** no array `plugins` tratado como superfície Pantheon → `tool_registration_missing` com exit 2 numa instalação **saudável** | `isPantheonPluginRef` define posse por três critérios (identidade do instalador, spec do pacote, ou `package.json` com o nome) e o laço **descarta** o que não é Pantheon | `scripts/doctor.mjs:2087-2095` (critérios `:2090-2092`); `continue` em `:2120`; critério documentado em `:2074-2083` |
| 2 | A superfície V2 da linha 1.5 (`src/plugin-v2.ts`) **não** era reconhecida → `tool_registration_missing` com plugin V2 correto | `TOOL_SURFACE_FILES` é **multi-arquivo por geração** (`v2` = `src/plugin-v2.ts` **+** `src/pantheon/v2-tools.ts`) e as declarações são **unidas**; `declared` só vira `null` quando **nenhum** arquivo da geração é legível | `:1971-1974`; união e `readable === 0 ? null` em `:2145-2170` (`:2169`); `readDeclaredToolNames` `:2013-2025` |
| 3 | **Spec npm** resolvia para `ROOT` → **falso verde** (validava a superfície da árvore do próprio `doctor`) | O ramo `includes('pantheon') → ROOT` **não existe mais**: spec pura não resolve para raiz nenhuma (`if (!absolute) return null`) e é transportada como superfície **`unverifiable`**, com achado **informativo** — sem `PASS`, sem erro bloqueante | `resolveRegisteredPluginRoot` `:2054-2072` (`:2064`); `pantheonPackageSpecifier` `:2036-2040`; superfície `unverifiable` `:2122-2136`; status `:2220-2226`; fiação `:2290-2320` e emissão `:2308-2317` (`code` em `:2315`) |

**Falha fechada preservada:** ausência total de superfície registrada (`unregistered`,
`:2197-2202`); superfície ilegível ou tool não declarada (`missing`, `:2211-2217`); perfil `lite`
é a única exceção (`:2190-2196`). Registro com parte verificável e parte não sai como
`partially-verified`, informativo e explicitamente "not a full registration pass" (`:2229-2234`).

**Notas do parecer — registradas, não bloqueantes.**

| # | Nota | Por que não bloqueia |
|---|---|---|
| (a) | A **união** de superfícies pode dar `PASS` numa árvore **híbrida** em que `src/pantheon/v2-tools.ts` esteja obsoleto, porque um nome declarado no arquivo novo basta | O pior caso é um falso **verde** de uma árvore que declara a tool em algum arquivo da geração; não há caminho para falso **vermelho**, e a árvore híbrida é transição, não estado suportado |
| (b) | O extrator V2 é **amplo** (qualquer `name: 'x'` no arquivo conta) | Pode superestimar a superfície, nunca subestimar; a alternativa — exigir o literal exato de `createV2ToolDefinitions` — quebraria com refactor legítimo |
| (c) | A **geração é inferida pela chave** (`plugins` → v2), então um path V1 sob `plugins` daria falso **erro** | Não ocorre nos configs que o produto escreve (V1 usa a chave singular `plugin`); registrado para não virar surpresa se um usuário editar à mão |
| (d) | A asserção de exit/status é **vacuamente verdadeira** no fixture (o caso não exercita o caminho de saída) | Enfraquece a cobertura do teste, não o comportamento verificado por reprodução; a correção é de teste, para a próxima passada |

**Efeito na contagem:** nenhum. A1.13 mede o escopo **P0-5**; P0-3 e P0-6 são itens
independentes.

### A1.19 — Fase 4: adoção do contrato 2.1 — decisão de **não** subir o SDK nesta release

**Pergunta da fase:** a `1.6.0` precisa subir `@opencode-ai/plugin` / `@opencode-ai/sdk`?

**Evidência acumulada.**

- O plugin **carrega e passa os testes de contrato** nos hosts `2.1.0`, `2.1.2` e `2.1.3` com o
  SDK **pinado em `1.18.33`** (`package.json:104-105`).
- `npm run test:ts` passa: **28 arquivos, 0 fail** (script em `package.json:49`, laço `tsx` sobre
  `tests/pantheon/*.test.ts`). Os 28 arquivos são verificáveis no repositório; o "0 fail" é da
  execução reportada, **não** re-executada nesta emenda.
- O domínio `ctx.permission` **não é tipado** nesse SDK: o repositório declara
  `V2PermissionDomain` à mão (`src/plugin-v2.ts:250`, consumido em `:286`). Isso já está
  registrado como **KI-5** (A1.7b/A1.11) — a divergência entre o tipo pinado e o runtime.
- **Não há evidência** de que subir o SDK seja necessário para a 1.6.0.
- Há **risco conhecido** no bump: `@opencode-ai/plugin@1.19.4` reorganiza o pacote e não expõe
  `PluginContext`; um bump cego quebraria o plugin.

**Decisão (release).** Manter o **pin `1.18.33`** nesta release (`package.json:104-105`), com a
superfície V2 tipada **localmente** (`V2PermissionDomain`, `src/plugin-v2.ts:250`) e o **KI-5**
documentado. **Reavaliar o bump na 1.7**, precedido de canary nas **três gerações**
(`1.19.x`, `2.0.x`, `2.1.x`).

**Alcance — o que esta decisão NÃO afirma.** É decisão **de release**, não conclusão de que o
contrato 2.1 está totalmente adotado. O que se afirma é estreito: (i) a 1.6.0 **não depende** do
bump; (ii) subir agora trocaria um risco **conhecido** por um risco **não medido**. O que a 2.1
muda de contrato público (SDK, mensagens/eventos HTTP, plugin — #57260) continua coberto pela
fase própria exigida em **Q2**, e a adoção plena permanece trabalho da linha seguinte. Esta
seção **não reabre Q2** nem altera a matriz de hosts de A1.3.

### Referências da emenda

- `EVIDENCE-P05.md` (artefato externo): hosts `:12-20`; V1 sem caminho `:35-58`, `:179`;
  matriz consolidada `:66-81`; decisões brutas `:85-90`; divergências `:94-116`; status por
  célula `:120-126`; logs e exit codes `:163-169`; limites `:177-183`.
- `INSTALL-RECORD.md:12-16` (instalação por versão) e `:22` (todas as versões pedidas
  existiam no registro).
- Registro npm `@opencode/cli`, consultado em `2026-10-22T15:20Z`: `latest = 2.1.3`,
  publicada em `2026-10-22T12:44:20Z`.
- `scripts/install/config-migration.mjs:36-59`, `:65`, `:329-340`, `:450-493`
  (as âncoras antigas `:81-107` / `:138-149` correspondem a esses dois blocos).
- `scripts/install/opencode.mjs:965-981` (default `permission.mcp.<server>`, incl. `ask`).
- `docs/PERMISSIONS-QUALITY-DELEGATION.md:802-804` (regra BLOCKER × Known Issue) e
  `:810-811` (rows 3 e 4, BLOCKER — P0-5).
- `ROADMAP.md:438-445` (nomes de ação não verificáveis pelo repositório) e `:448-452`
  (critério de aceitação do P0-5).
- `tests/install-config-migration.test.mjs:223-273`.
- `package.json:143` (Node `>=26.4.0`); `docs/INSTALLATION.md:21`, `:140` (Python `3.11+`).
- Regra dura de evidência: `ROADMAP.md:63-65`; `docs/RELEASE.md:106-108`.
- `evidence/mcp-gating/EVIDENCE.md` (artefato externo, doravante `EVIDENCE-MCP.md`):
  forma × efeito `:45-57`; avaliação e `resources` `:16-19`, `:73`, `:76-77`;
  catalog-level `:59-68`; `ask` esconde `:57`, `:109-114`; plugin tools `:118-124`;
  `websearch` `:126-130`; risco residual `:132-145`; artefatos `:147-156`. Logs,
  `*.exitcode`, `v2.*-report/mcp-gating-report.json` e `SHA256SUMS` no mesmo diretório;
  verificação da correção em `evidence/mcp-gating-implementation/v2.0.30.log` e
  `v2.1.3.log`.
- `scripts/install/config-migration.mjs` — **âncoras atuais** (A1.4, A1.10, A1.12 e A1.13
  foram re-sincronizadas para estas linhas na correção D-5): mapa de ações `:49-59`;
  `EFFECT_RESTRICTIVENESS` `:65`; `isKnownEffect` `:72-74`; `resourceSpecificity` `:91-95`;
  `comparePermissions` `:111-123`; `warnInvalidPermissionEntries` `:136-142`; `sortPermissions`
  `:144-151`; `warnOrderingChangesEffectiveEffect` `:200-218`; `resolveEffects` `:276-306`;
  `pushPermission` `:329-340`; MCP `:342-401` (`MCP_SERVER_NAME_PATTERN` `:348`, validação
  `:379-384`, `ask` + supressão `:371`, `:389-396`); `convertPermissionsV1toV2` `:415-438`;
  mapa reverso `:450-493`; `MANAGED_AGENT_FIELDS` `:804-812`; `mergeManagedAgents` `:864-882`;
  `mergePermissionArrays` `:1014-1068`; `resolveTopLevelPermissions` `:1109-1152`;
  agente → `permissions` `:1187`.
- `scripts/install/opencode.mjs`: `permission.websearch` deliberadamente não semeado
  `:277-278`; `PRODUCT_CONFIG_DEFAULTS` `:293-295`; débito `permission` ×
  `permissions` `:308-322`; `deriveNativeMcpPermissions` `:346-390`, ligado em
  `:1855-1859`; defaults `permission.mcp.*` e aviso `:966-1005`.
- `scripts/install/strings.mjs:49-52` e `:111-114` (aviso `mcpAskNotEnforceable`).
- `tests/install-config-migration.test.mjs:410-497` (tradução de `permission.mcp`).
- `docs/PERMISSIONS-QUALITY-DELEGATION.md`: colisão e ordenação `:380-414`; forma MCP
  `:479-502`; tabela de não verificados **atualizada** — row 3 `:936` (**Measured — P0-5**),
  row 4 `:937` (ordem medida), row 5 `:938` (**medida; não é mais blocker**), row 9 `:942`
  (`ask`, Known Issue aceito).
- `src/agents/apollo.md:9-18`, `mnemosyne.md:24-40`, `gaia.md:11-14`,
  `aphrodite.md:10-14` (nomes de ação emitidos por template).
- `src/plugin-v2.ts:1132-1138` (guard read-only que cobre `hashline_edit`).
- `evidence/action-names/EVIDENCE.md` (artefato externo, doravante
  `EVIDENCE-ACTIONS.md`): método `:3-10`; idêntico nos cinco `:12`; tabela por ação
  `:16-26`; `mcp` (achado pré-fix) `:28-55`; superfície estrutural ausente `:62-74`;
  `websearch` não medido `:76-81`; reprodução `:83-92`. Logs e `*.exitcode` no mesmo
  diretório (`v2.0.29`, `v2.0.30`, `v2.1.0`, `v2.1.2`, `v2.1.3`).
- `bench/results/p05-permission-matrix-2026-10-22.md`: hosts e `SHA-256` `:35-48`;
  matriz A/B/C/D `:61-76` (D1/D2 = glob de `permission.task`); `last-match-wins`
  `:72-74`; `11 PASS + 3 observados, 0 FAIL` por host `:78-81`; valores brutos
  `:85-96`.

- `scripts/doctor.mjs`: `INSTALLED_PACKAGE_MARKER` `:1314`; `MANAGED_PLUGIN_IDENTITIES`
  `:1342-1349`; `managedPluginPath` `:1368-1376`; `reportDanglingPluginRegistrations`
  `:1390-1408` (`plugin_path_missing` em `:1404`); `checkPluginVersionDrift` `:1487-1530`;
  `isV2PluginRef` `:1559-1567`; `TOOL_SURFACE_FILES` **multi-arquivo** `:1971-1974`;
  `readDeclaredToolNames` `:2013-2025`; `pantheonPackageSpecifier` `:2036-2040`;
  `resolveRegisteredPluginRoot` `:2054-2072` (spec npm → `null` em `:2064`);
  `isPantheonPluginRef` `:2087-2095`; `resolveRegisteredToolSurfaces` `:2115-2173`
  (`unverifiable` em `:2122-2136`; união de superfícies em `:2145-2170`);
  `classifyToolRegistration` `:2188-2242`; emissão `tool_registration_unverifiable`
  `:2308-2317`.
- Fase 4 / SDK pin (A1.19): `package.json:104-105` (`@opencode-ai/plugin` e `@opencode-ai/sdk` em
  `1.18.33`); script `test:ts` em `package.json:49` sobre `tests/pantheon/*.test.ts` (28
  arquivos); `V2PermissionDomain` em `src/plugin-v2.ts:250`, consumido em `:286`.
- `tests/doctor-plugin-path-staleness.test.mjs` (P0-6): racional `:2-13`; `plugin_path_missing`
  em `:133`, `:226`, `:250`. `tests/doctor-node-runtime.test.mjs:103`, `:117` (P0-3).

- `evidence/order-edit/EVIDENCE.md` (artefato externo, doravante `EVIDENCE-ORDER-EDIT.md`):
  motivação D-2 `:10-12`; método `:16-30`; matriz `write` × `edit` `:34-47`; chamadas reais
  `:49-58`; veredito `:60-65`; artefatos `:67-72`. Logs, `*.exitcode`, snapshots de config e
  `SHA256SUMS` no mesmo diretório.
- `tests/agents-md-budget.test.mjs`: tetos por artefato `:42-54`; guarda de crescimento de
  `prompts/` `:56-76`; 15 frases-gate `:146-163`; teste de exclusividade `:167-181`;
  baselines `:19-21`.

---

## Amendment 2 — Family-level OpenCode support (2026-10-23)

**Aditivo e datado.** O `Status: Accepted` do cabeçalho, as decisões **Q1–Q7**, a tabela
"Matriz de host alvo", as Known Issues de Q5, o **Amendment 1** inteiro (A1.1–A1.19) e as
referências acima **permanecem como escritos** — nada é reescrito nem apagado. Esta emenda
registra a mudança de política de suporte decidida pelo mantenedor em **2026-10-23**, já
implementada em código e documentação neste HEAD, e prevalece **apenas** nas colisões
nomeadas em "O que esta emenda substitui".

### Contexto

A decisão original — e a leitura que A1.1–A1.3 mantiveram — tratava a matriz como uma
**lista de versões medidas**: uma versão só entrava como suportada depois de ter evidência
própria, e a linha `2.0.31`, membro da família 2.x, ficava declarada **não suportada** por
não ter sido medida. O mantenedor rejeitou essa regra: exigir uma medição por host
obrigaria a medir minor por minor, e a política de trabalho declarada é "não dá pra ficar
testando versão minor por minor; em tese todas são suportadas".

A medição continua sendo o que sustenta um `PASS`. O que muda é o **escopo da declaração de
suporte**: ele é da família, não da versão. Uma versão suportada sem medição é
**suportada e não medida** — registrada honestamente, não tratada como lacuna.

### Decisão

**D1 — O suporte é declarado por família.**

| Família | Plugin | Estado |
|---|---|---|
| OpenCode **`1.19.x`** | V1 (`src/plugin.ts` + `src/plugins/pantheon-hooks.ts`) | **Suportado** |
| OpenCode **`2.x`** | V2 (`src/plugin-v2.ts`) | **Suportado** — toda a linha, inclusive minors publicados depois deste documento |

**D2 — Exceção nominal: `2.0.22`.** É o único host conhecido como quebrado dentro das
famílias suportadas. O motivo é **ausência de superfície do host**, não falha de política de
permissões: o registro do bounded-read exige `typeof permission?.assert !== 'function'` como
uma das condições de disponibilidade e, quando falta, chama `markUnsupported('bounded-read')`
e devolve `undefined` (`src/plugin-v2.ts:1720-1727`). Sem `ctx.permission.assert`, os
caminhos V2 de ordenação de permissão e de bounded-read não se aplicam. A documentação
pública repete o motivo e a proibição de instalar ali (`docs/COMPATIBILITY.md:15-22`).

**D3 — Medição é evidência, não requisito de suporte.** A tabela `Verified versions` de
`docs/COMPATIBILITY.md:116-132` (`1.19.4`, `2.0.29`, `2.0.30`, `2.1.0`, `2.1.2`, `2.1.3`)
é **registro rastreável de evidência**, explicitamente "not the boundary of support"
(`:118-120`). `2.0.31` é suportada por família e **não tem linha de medição** — isso é
registrado como fato, não como lacuna. **Nenhum `PASS` é atribuído à `2.0.31`**: não existe
artefato de medição dela, e esta emenda não inventa um.

**D4 — Semântica do gate `host` (`scripts/release-gates.mjs`).**

- `SUPPORTED_FAMILIES = ['1.19.x', '2.x']` (`:62`) e `KNOWN_BROKEN_HOSTS = ['2.0.22']`
  (`:65`) são a fonte da política no código.
- `validateMatrix` rejeita host conhecido quebrado (`:342-344`), família não declarada
  (`:345-349`), host cuja versão não pertence à família declarada (`:350-355`) e `kind`
  incompatível com a família (`:356-361`).
- Família suportada sem linha medida sai em `unmeasuredFamilies` (`:425-428`) com
  `supportLevel: 'family'` (`:432`): é **reportada**, não reprovada.
- Matriz vazia emite **WARNING** (`hostEvidenceWarning`, `:368-372`; `console.warn` em
  `:656-660`) e **ainda passa** — ausência de medição não é evidência de host quebrado.
- Linha medida que não roda é `FAIL`; não existe caminho `SKIP` (`:36-37`).
- A matriz default é o conjunto medido no congelamento (`:73-79`): `1.19.4`, `2.0.29`,
  `2.0.30`, `2.1.0`, `2.1.3`. `PANTHEON_RELEASE_MATRIX` pode substituí-la, mas a substituta
  é validada pelas mesmas regras.
- Contratos fixados por teste em `tests/release-gates.test.mjs`: as duas listas
  (`:11-13`); matriz vazia não lança (`:15-16`); um minor 2.x não listado é evidência válida
  sem bênção por versão (`:18-22`); `2.0.22` e famílias não declaradas são rejeitados
  (`:25-33`); zero hosts medidos é reportado como `unmeasured` sem reprovar o gate
  (`:52-55`).

**D5 — Um único lar para a matriz: `docs/COMPATIBILITY.md`.** Nenhuma outra página reafirma
a matriz. `README.md:38-40`, `:86-91`, `docs/INSTALLATION.md:21`, `:143`,
`docs/releases/v1.6.0.md:40` e `docs/RELEASING.md:283` resumem a política em uma linha e
apontam para lá. As tabelas de host **deste ADR** passam a ser registro histórico da decisão,
não a política vigente.

**D6 — Fim de vida do V1 na linha 1.7.** `1.6.x` é a última linha Pantheon que suporta host
OpenCode 1.X; da `1.7` em diante a linha mira apenas OpenCode 2.x
(`docs/COMPATIBILITY.md:27-30`, `:136-138`). Isso é fronteira do Pantheon, não alegação de
que a `1.6` não suporta 2.x.

### O que esta emenda substitui

1. **"Matriz de host alvo" (tabela da decisão original)** — substituída na íntegra como
   política vigente. Especificamente: a linha `2.0.31` = "NÃO suportado" passa a
   **suportado por família, sem medição**; as linhas `2.0.29` e `2.0.30` = "Suportado — a
   testar" passam a **Suportado**, com PASS medido (A1.3/A1.4); `1.19.x` e `2.1.0` deixam de
   exigir linha própria como condição de suporte; e a "Ressalva registrada" que tratava a
   ausência de evidência em host 1.X como item a fechar **para o suporte** deixa de valer —
   a evidência do `1.19.4` (A1.6) permanece como registro.
2. **A1.3 — "Matriz de host final desta release"** — como política, cai por inteiro: as
   linhas viram evidência. Em particular, a linha `2.0.31` = "NÃO suportado" e a citação a
   `docs/INSTALLATION.md:21` como reafirmação dessa exclusão ficam **revogadas** (a página
   hoje declara a família 2.x suportada). A linha `2.0.22` = "NÃO suportado" e o piso
   `Node >=26.4.0` **não** são alterados.
3. **A1.2 — "A célula `2.1.0` passa a ser a linha `2.1.x`"** — a exigência de **duas provas
   por release** (piso + patch mais novo) deixa de ser condição de suporte. Permanece como
   prática de evidência opcional; medição não é pré-requisito para declarar a família
   suportada.
4. **Q2 — fase própria de adoção/validação da 2.1** — a cláusula "Sem essa fase, a coluna
   2.1 não é declarada suportada" não vale mais como condição de suporte: a 2.x é suportada
   por família. A adoção do contrato 2.1 continua sendo trabalho de engenharia/release
   (A1.19 permanece intacta), não um gate de declaração de suporte.
5. **Justificativas que citam `2.0.31` como não suportado** — o item `Positive` da decisão
   original ("`2.0.31` declarado não suportado em vez de implicitamente 'provavelmente ok'")
   e a frase correlata de A1.3 passam a descrever o **estado anterior**; não descrevem a
   política vigente.

**Não substituídos:** Q1, Q3–Q7, A1.1, A1.4–A1.19 — incluindo a lista autoritativa
KI-1…KI-8 (A1.11), a contagem vigente de bloqueios de A1.13 (**0** no escopo de
código/evidência) e o gate de GO por parecer do `@themis` (Q4).

### Consequências

**Código.** A política vive em duas constantes exportadas e numa validação de matriz
(D4); não há tabela de versões hardcoded como condição de suporte. Adicionar uma versão
medida é adicionar uma linha de evidência, não editar uma allowlist.

**Documentação.** `docs/COMPATIBILITY.md` é o único lar da política, das famílias, do piso
de Node e da lista de known issues. Páginas que precisam citar suporte o fazem em uma linha
com link (D5); duplicar a matriz em outro documento é regressão, não redundância.

**Gate e processo de release.** O gate `host` pode **passar sem nenhum host medido**, com
WARNING explícito no registro de evidência. Isso é decisão de projeto: uma release sem
medição não é uma release com host quebrado — é uma release com evidência mais fraca, e o
pacote de GO (formato exigido na decisão original) deve refletir exatamente o que foi medido.
"Não há linha para a versão X" não é, por si, motivo de NO-GO nem declaração de não suporte.
Uma linha para `2.0.22` **não pode** ser adicionada: o gate a rejeita por ser host conhecido
quebrado.

**Registro de evidência.** A tabela `Verified versions` permanece como o registro
rastreável do que foi executado, com a ressalva de que a linha `2.0.31` está ausente de
propósito. Medir `2.0.31` depois é trabalho opcional de evidência, não ato de suporte.

### Não-consequências (o que esta emenda NÃO decide)

- **Node:** o piso continua `>=26.4.0` (`package.json:143`); Node 22, 24 e 26.0–26.3
  continuam fora da faixa suportada (Q3/A1.3).
- **`2.0.22`:** continua conhecido como quebrado; não há reclassificação, waiver nem
  "Known Issue de suporte".
- **Nenhum `PASS` novo:** esta emenda não afirma que `2.0.31` — ou qualquer host não
  medido — passou em teste algum. O item em aberto é registrado como tal: **`2.0.31` não
  tem artefato de medição**.
- **P0-5 e segurança:** nada muda em permissões, ordenação, MCP `ask`, KI-1…KI-8 ou no gate
  de GO por parecer (Q4).
- **Instalador, seleção de geração e SDK:** inalterados; o pin `1.18.33` e a decisão de não
  subir o SDK na `1.6.0` (A1.19) permanecem.
- **Famílias fora de escopo:** nenhum suporte a 3.x ou a qualquer família não declarada;
  `validateMatrix` rejeita família não declarada (`scripts/release-gates.mjs:345-349`).
- **Linha abandonada:** nada aqui depende de `release/1.6.0-stable`. Os 14 commits únicos
  dessa linha existem como re-SHAs em `release/1.6.0-beta.7` (15 commits no total, incluindo
  o de preparação) e estão registrados em `docs/internal/abandoned-lines.md:19`, `:30-52`,
  `:54-72`.
- **Edição de documentação:** esta emenda não altera `docs/COMPATIBILITY.md`; registra a
  política que a página já declara.
