# Livro de Receitas do Pantheon: Casos Práticos do Dia a Dia

> 🇺🇸 **English version available:** [Read in English](../../guides/cookbook.md)

Este livro de receitas reúne os fluxos de trabalho mais comuns no desenvolvimento diário com o Pantheon, apresentando os prompts exatos, ferramentas utilizadas e qual especialista acionar em cada cenário.

---

## Receita 1: Funcionalidade Full-Stack com TDD e Portão de Qualidade

**Cenário:** Implementar uma nova funcionalidade de ponta a ponta (ex: endpoint de exportação de relatórios em CSV com validação de schema e testes).

**Prompt:**
```text
@zeus Adicione suporte a exportação CSV em /reports com testes unitários e validação de schema.
```

**Fluxo de Execução:**
1. O `@zeus` analisa o escopo e delega o planejamento para a `@athena`.
2. A `@athena` estrutura as fases e critérios de aceite; dúvidas de design são apresentadas pela ferramenta interativa nativa `question`.
3. Após aprovação, o `@hermes` escreve testes que falham (RED) e implementa até passarem (GREEN).
4. A `@themis` roda linters, auditoria de segurança e valida a cobertura de testes antes da conclusão.

---

## Receita 2: Hotfix em 1 Turno (Bugs e Correções Pontuais)

**Cenário:** Corrigir um erro visual de CSS, um erro de digitação ou um import quebrado sem cerimônia de planejamento.

**Prompt:**
```text
@talos Altere a cor de fundo do botão de login de azul para verde esmeralda no arquivo login.css
```

**Por que usar o @talos?**
O `@talos` é a faixa expressa do Pantheon. Ele opera sem subagentes, pula rituais de planejamento Deepwork, realiza edições cirúrgicas em um único turno e finaliza imediatamente.

---

## Receita 3: Migrações de Banco de Dados e Otimização de Consultas

**Cenário:** Criar uma nova tabela ou coluna com índices adequados e integridade referencial.

**Prompt:**
```text
@demeter Crie uma migration Alembic adicionando a tabela 'user_preferences' com chave estrangeira para 'users' e índice em 'created_at'.
```

**Por que usar o @demeter?**
O `@demeter` é o especialista em persistência do Pantheon. Ele domina SQLAlchemy, Prisma, Alembic e PostgreSQL, prevenindo problemas clássicos de consultas N+1 e índices ausentes.

---

## Receita 4: Refatoração Visual Baseada em Captura de Tela (Screenshot)

**Cenário:** Reconstruir ou refinar um componente frontend para corresponder a um mockup.

**Prompt:**
*(Cole a imagem da área de transferência com Ctrl+V / Cmd+V no chat)*
```text
@aphrodite Refatore este card de métricas para refletir fielmente o espaçamento, tipografia e cores da captura colada.
```

**Fluxo de Execução:**
1. O Pantheon Vision processa a imagem silenciosamente via contexto de sistema (`session.context`).
2. A `@aphrodite` analisa a hierarquia visual, espaçamentos e acessibilidade WCAG AA, atualizando os componentes React/Tailwind.

---

## Receita 5: Investigação Segura da Base de Código (Somente Leitura)

**Cenário:** Compreender uma lógica complexa espalhada por vários arquivos sem risco de edições indesejadas.

**Prompt:**
```text
@apollo Rastreie o repositório e explique como os tokens de autenticação são validados em conexões WebSocket ativas.
```

**Por que usar o @apollo?**
O `@apollo` opera em modo estritamente somente leitura (`edit: deny`, `bash: deny`). Ele realiza buscas rápidas e paralelas, retornando caminhos exatos de arquivos e intervalos de linhas relevantes.

---

## Receita 6: Auditoria de Segurança e Qualidade Pré-PR

**Cenário:** Fazer uma revisão completa de todas as alterações feitas na branch antes de abrir um Pull Request.

**Prompt:**
```text
@themis Audite as mudanças desta branch contra o OWASP Top 10, execute os testes e o linter Biome, e emita o veredicto de qualidade.
```

**Por que usar a @themis?**
A `@themis` atua como auditora independente em modo read-only. Ela nunca altera código diretamente; executa suítes de teste, analisa regras estáticas e emite pareceres formais (`PASS`, `PASS_WITH_NOTES`, `BLOCK`).

---

## Receita 7: Inteligência Artificial e Pipelines de RAG

**Cenário:** Implementar busca semântica com embeddings vetoriais.

**Prompt:**
```text
@hephaestus Crie um pipeline de busca vetorial usando LangChain e pgvector para recuperação semântica de trechos de documentos.
```

**Por que usar o @hephaestus?**
O `@hephaestus` é especialista em embeddings, bancos de dados vetoriais, orquestração de LLMs e ferramentas de inteligência artificial.

---

## Receita 8: Docker e Automação de CI/CD

**Cenário:** Criar Dockerfile multi-stage e workflow do GitHub Actions.

**Prompt:**
```text
@prometheus Crie um Dockerfile multi-stage otimizado para produção em Node.js e um workflow do GitHub Actions para testar PRs.
```

**Por que usar o @prometheus?**
O `@prometheus` é o especialista em DevOps, contêineres, pipelines de integração contínua e scripts de infraestrutura.

---

## Receita 9: Síntese de Conselho para Decisões de Arquitetura (`/pantheon`)

**Cenário:** Decidir entre duas soluções arquiteturais com múltiplos prós e contras técnicos.

**Prompt:**
```text
/pantheon Devemos utilizar Server-Sent Events (SSE) ou WebSockets para o feed de notificações em tempo real do dashboard?
```

**Por que usar /pantheon?**
Dispara 2 ou 3 especialistas em paralelo (`@athena` para modularidade, `@hermes` para vazão/APIs, `@themis` para limites de conexões e segurança) e sintetiza uma decisão unificada com precedência de domínio.

---

## Receita 10: Projeto Multidisciplinar com Checkpoints (`/pantheon-deepwork`)

**Cenário:** Migrar ou refatorar subsistemas complexos que levam múltiplos turnos e dias de trabalho.

**Prompt:**
```text
/pantheon-deepwork Migre o armazenamento de sessões de usuário de memória para cookies JWT criptografados com lista de revogação no Redis.
```

**Fluxo de Execução:**
1. O plano e o progresso são salvos em `.pantheon/deepwork/<slug>/` (`plan.json`, `PLAN.md`, logs).
2. Especialistas trabalham concorrentemente em git worktrees isolados (`.pantheon-worktrees/`).
3. Cada fase concluída passa pelo portão de aprovação da `@themis` antes do avanço.

---

## Receita 11: Tomada de Decisão Interativa via Portão de Perguntas

**Cenário:** Resolver trade-offs técnicos durante o planejamento de forma dinâmica e interativa.

**Fluxo de Execução:**
Quando a `@athena` elabora um plano com caminhos técnicos alternativos, o `@zeus` aciona a ferramenta nativa `question` do OpenCode:
- A interface exibe caixas interativas com opções claras.
- A alternativa mais alinhada às boas práticas vem marcada como `(Recomendado)`.
- O desenvolvedor clica na opção preferida e a orquestração prossegue imediatamente sem atrito de digitação no chat.

---

## Receita 12: Diagnóstico de Saúde e Detecção de Drift (`doctor`)

**Cenário:** Verificar a saúde dos servidores MCP locais, permissões e integridade de arquivos do Pantheon.

**Comando:**
```bash
npx pantheon-opencode doctor
```

**Quando Executar:**
- Após alternar entre branches git ou sincronizar atualizações do repositório remoto.
- Ao atualizar o Node.js ou o OpenCode.
- Caso alguma ferramenta MCP relate falhas de conexão ou dependências ausentes.
