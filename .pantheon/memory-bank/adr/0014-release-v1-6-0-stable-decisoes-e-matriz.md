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
