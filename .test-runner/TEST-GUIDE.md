# Guia de Testes — Pantheon v4.0 Novos Comandos

> **Objetivo:** Validar que todos os novos comandos funcionam corretamente antes do commit.
> **Local:** `.test-runner/` (não comitável)
> **Como usar:** Execute cada teste com o agente de IA e registre o resultado.

---

## 📋 Testes de Comandos

### Teste 1: `/praxis` — Executar Plan via Task System

**Descrição:** O comando `/praxis` deve iniciar execução de um plan do Athena criando tasks com dependencies.

**Setup:**
1. Peça ao Athena: `/plan-architecture "Adicionar endpoint GET /health"`
2. Aprovar o plan
3. Executar: `/praxis`

**Resultado Esperado:**
- [ ] Zeus lê o plan aprovado
- [ ] Tasks são criados com dependencies (`blockedBy`)
- [ ] Tasks sem blockers começam imediatamente
- [ ] Tasks dependentes esperam blockers completarem
- [ ] Wisdom Accumulation passa learnings entre waves
- [ ] Para nos safety gates (plan approval, phase review, git commit)

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

### Teste 2: `/cancel` — Cancelar Auto-Continue Mode

**Descrição:** O comando `/cancel` deve parar o Auto-Continue Mode sem descartar trabalho.

**Setup:**
1. Ativar: `auto-continue mode "Criar 5 arquivos de teste"`
2. Agente começa a trabalhar
3. Executar: `/cancel`

**Resultado Esperado:**
- [ ] Auto-Continue Mode para imediatamente
- [ ] Trabalho já feito é preservado
- [ ] Sessão não é fechada
- [ ] Tasks e learnings não são deletados
- [ ] User retoma controle

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

### Teste 3: `/stop-continuation` — Parar Todos os Mecanismos

**Descrição:** O comando `/stop-continuation` deve parar TODOS os mecanismos de continuação.

**Setup:**
1. Ativar: `auto-continue mode "Criar 10 arquivos"`
2. Executar: `/stop-continuation`

**Resultado Esperado:**
- [ ] Auto-Continue para
- [ ] Task System auto-continue para
- [ ] Tool execution manual ainda funciona
- [ ] Agent delegation ainda funciona
- [ ] Safety gates ainda funcionam

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

### Teste 4: `/metamorphosis` — Refactoring Inteligente

**Descrição:** O comando `/metamorphosis` deve fazer refactoring com análise LSP, detecção de padrões, e verificação TDD.

**Setup:**
1. Criar um arquivo com code smells:
```python
# .test-runner/sample.py
# This function handles user authentication by checking the provided credentials
# against the database and returning a JWT token if successful
def authenticate_user(email, password):
    # Try to fetch the user from the database
    # If the user is not found, raise a 404 error
    # If there is a database error, raise a 500 error
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(404)
    return user
```
2. Executar: `/metamorphosis .test-runner/sample.py --scope=file --strategy=safe`

**Resultado Esperado:**
- [ ] Apollo analisa o arquivo (code smells, duplicações)
- [ ] Athena cria plan de refactoring (3-5 fases)
- [ ] User aprova o plan
- [ ] Hermes executa com TDD (testes antes)
- [ ] Themis verifica (testes passam, coverage >80%)
- [ ] AI slop removido dos comentários
- [ ] LSP diagnostics limpos

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

## 📋 Testes de Skills

### Teste 5: `auto-continue` — Continuação Moderada

**Descrição:** A skill `auto-continue` deve continuar entre safety gates quando próximo passo é claro.

**Setup:**
1. Peça: "Implemente um endpoint CRUD para 'Product' com TDD"
2. Agente deve criar todos os steps
3. Verificar se continua automaticamente entre steps claros

**Resultado Esperado:**
- [ ] Agente cria todos os steps no início
- [ ] Continua automaticamente entre steps claros
- [ ] Para no Gate 1 (plan approval)
- [ ] Para no Gate 2 (phase review)
- [ ] Para no Gate 3 (git commit)
- [ ] Não pergunta "should I continue?" entre steps claros

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

### Teste 6: `auto-continue` — Auto-Continue via Idle Detection

**Descrição:** A skill `auto-continue` deve continuar injetando reminder até `<promise>DONE</promise>`.

**Setup:**
1. Ativar: `auto-continue mode "Criar 5 arquivos com testes"`
2. Agente vai trabalhando
3. Se agente parar sem DONE, verificar se system reminder é injetado

**Resultado Esperado:**
- [ ] Agente trabalha continuamente
- [ ] Se idle + todos incompletos + sem DONE → reminder injetado
- [ ] Repete até DONE ou maxIterations
- [ ] Para nos safety gates
- [ ] `/cancel` funciona

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

### Teste 7: `wisdom-accumulation` — Learnings entre Waves

**Descrição:** A skill `wisdom-accumulation` deve extrair learnings após cada wave e passar para o próximo.

**Setup:**
1. Implementar feature multi-wave (ex: backend + frontend)
2. Após Wave 1, verificar se learnings.md foi criado
3. Iniciar Wave 2, verificar se learnings foram injetados

**Resultado Esperado:**
- [ ] `.pantheon/learnings/<feature>/learnings.md` criado após Wave 1
- [ ] Learnings têm 5 categorias (Conventions, Successes, Failures, Gotchas, Commands)
- [ ] Wave 2 recebe learnings no prompt
- [ ] Learnings são deletados após merge

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

### Teste 8: `ai-slop-remover` — Detecção de AI Slop

**Descrição:** A skill `ai-slop-remover` deve detectar e remover AI slop em comentários.

**Setup:**
1. Criar arquivo com AI slop:
```python
# .test-runner/slop_test.py
# This function provides a comprehensive user management service
# that handles all CRUD operations for the User model
# with proper error handling and validation
class UserService:
    def __init__(self, db):
        # Initialize the service with a database session
        # This allows us to perform database operations
        self.db = db
```
2. Pedir ao agente para melhorar o arquivo
3. Verificar se AI slop foi removido

**Resultado Esperado:**
- [ ] Comentários verbose detectados
- [ ] Comentários redundantes removidos
- [ ] AI filler phrases removidas
- [ ] Código lê como senior escreveu
- [ ] Bypass `# @allow` funciona

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

### Teste 9: `metis-gap-analysis` — Gap Analysis de Plans

**Descrição:** A skill `metis-gap-analysis` deve analisar plans antes de entregar ao user.

**Setup:**
1. Peça: `/plan-architecture "Adicionar sistema de notificações"`
2. Verificar se Metis analisa o plan antes de entregar
3. Verificar se gaps são injetados no plan

**Resultado Esperado:**
- [ ] Metis roda APÓS Athena gerar plan, ANTES de entregar
- [ ] Gaps identificados: Hidden Intentions, Ambiguities, Missing Criteria, AI Slop, Edge Cases
- [ ] Gaps injetados no plan
- [ ] Athena revisa plan com gaps
- [ ] Plan final é mais robusto

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

### Teste 10: `review-work` — Review Paralelo

**Descrição:** A skill `review-work` deve rodar 5 checks paralelos em vez de sequencial.

**Setup:**
1. Implementar uma feature
2. Pedir review ao Themis
3. Verificar se 5 checks rodam em paralelo

**Resultado Esperado:**
- [ ] 5 checks rodam em paralelo (Goal, Quality, Security, QA, Context)
- [ ] Review é mais rápido que sequencial
- [ ] Todos os checks devem passar para APPROVED
- [ ] Se algum falha → NEEDS_REVISION com lista de issues

**Registrar:**
```
Status: ✅ PASS / ❌ FAIL
Observações: <o que funcionou, o que falhou>
```

---

## 📊 Resumo de Resultados

| Teste | Comando/Skill | Status | Observações |
|-------|---------------|--------|-------------|
| 1 | `/praxis` | ⬜ | |
| 2 | `/cancel` | ⬜ | |
| 3 | `/stop-continuation` | ⬜ | |
| 4 | `/metamorphosis` | ⬜ | |
| 5 | `auto-continue` | ⬜ | |
| 6 | `auto-continue` | ⬜ | |
| 7 | `wisdom-accumulation` | ⬜ | |
| 8 | `ai-slop-remover` | ⬜ | |
| 9 | `metis-gap-analysis` | ❌ FAIL | Gaps found but auto-injection failed. 12 gaps identified. See metis-result.md |
| 10 | `review-work` | ⬜ | |

**Total:** ⬜/10 passados

---

## 🚀 Como Executar

1. Abra o OpenCode com o projeto Pantheon
2. Para cada teste:
   - Siga o setup descrito
   - Execute o comando ou ative a skill
   - Verifique o resultado esperado
   - Registre ✅ PASS ou ❌ FAIL na tabela acima
3. Se algum teste falhar:
   - Documente o erro em `Observações`
   - Corrija o problema
   - Re-execute o teste
4. Quando todos passarem → commit!
