# Pantheon Cookbook: Receitas Práticas do Dia a Dia

> 🇺🇸 **English version available:** [Read in English](../../guides/cookbook.md)

Este guia reúne os casos de uso mais comuns do desenvolvimento diário com o Pantheon, demonstrando os comandos exatos e qual especialista acionar para cada situação.

---

## Receita 1: Nova Feature com TDD e Qualidade Total

**Cenário:** Você precisa implementar uma funcionalidade completa (ex: endpoint de exportação de dados com testes e documentação).

**Comando:**
```text
/pantheon Adicione suporte a exportação de dados em CSV na rota /reports, com testes unitários e validação de schema.
```

**Fluxo:**
1. O `@zeus` detecta que a tarefa envolve múltiplos passos e aciona a `@athena` para o plano.
2. Você aprova o plano pelo diálogo nativo `question`.
3. O `@hermes` escreve o teste em falha (RED) e implementa o código até passar (GREEN).
4. A `@themis` valida linters e segurança.

---

## Receita 2: Hotfix Rápido em 1 Turno (Bugs e Typos)

**Cenário:** Um erro de digitação, um ajuste simples de CSS, ou uma importação faltando que não requer cerimônia de planejamento.

**Comando:**
```text
@talos corrija a cor de fundo do botão de login de azul para verde esmeralda no arquivo login.css
```

**Por que usar o @talos?**
O `@talos` é a faixa expressa do Pantheon. Ele não aciona subagentes, não cria planos de Deepwork e não roda cerimônias pesadas. Ele aplica a edição cirúrgica em 1 turno e termina.

---

## Receita 3: Migrações de Banco de Dados e Queries Otimizadas

**Cenário:** Criar uma nova tabela no banco ou adicionar colunas sem introduzir problemas de N+1 queries.

**Comando:**
```text
@demeter crie uma migration no Alembic adicionando a tabela 'user_preferences' com chave estrangeira para 'users' e índice no campo 'created_at'.
```

**Por que usar a @demeter?**
A `@demeter` é a especialista em persistência do Pantheon. Ela conhece as boas práticas de SQLAlchemy, Prisma, Alembic e PostgreSQL, garantindo integridade referencial e performance.

---

## Receita 4: Investigando Codebases Desconhecidas (Modo Seguro)

**Cenário:** Você entrou em um repositório legado grande e quer entender onde certas funções são chamadas sem risco de o agente alterar arquivos por engano.

**Comando:**
```text
@apollo investigue onde o método calculateDiscount é invocado no projeto e me liste os arquivos e linhas com um resumo de uso.
```

**Por que usar o @apollo?**
O `@apollo` tem permissão estrita `edit: deny` e `bash: deny`. Ele é um batedor puramente investigativo. Ele varre o código com `grep` e `glob` e sintetiza as respostas sem tocar em uma linha de código.

---

## Receita 5: Auditoria Pré-PR e Validação de Segurança

**Cenário:** Você terminou suas alterações manuais ou do time e quer uma revisão rígida antes de abrir o Pull Request.

**Comando:**
```text
@themis audite as alterações da branch atual contra o checklist de segurança OWASP, rode os testes e valide se há código legado ou segredos expostos.
```

**Veredicto da Themis:**
A `@themis` emitirá um relatório categorizado com:
* `PASS`: Pronto para merge.
* `PASS_WITH_NOTES`: Observações não-bloqueantes de melhoria.
* `BLOCK`: Erros de linter, testes falhando ou vulnerabilidades detectadas.

---

## Receita 6: Descobrindo e Instalando Novas Skills

**Cenário:** O projeto precisa de uma capacidade que o Pantheon ainda não possui instalada (ex: skill de deploy na AWS, análise de Dockerfiles, etc.).

**Comando:**
```text
@zeus pesquise se existe uma skill de terraform para o nosso projeto
```

**O que acontece:**
1. O Zeus executa a busca interna no catálogo de skills (`pantheon_skill_search`).
2. Se encontrar, abre a pergunta interativa (`question` tool) oferecendo instalação em 1 clique no projeto atual (`.agents/skills/`).
3. Ao confirmar, o especialista instala com `npx skills add -a opencode -y`.

---

## Receita 7: Consultando Custos e Economia de Tokens

**Cenário:** Você quer saber quantos dólares gastou na sessão e quanto economizou com cache de prompt.

**Comando:**
```text
/pantheon_cost
```

Também é possível acompanhar o medidor de contexto e spend diretamente no painel lateral da TUI (`pantheon tui`).
