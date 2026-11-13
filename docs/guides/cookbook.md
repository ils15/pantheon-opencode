# Pantheon Cookbook: Everyday Practical Recipes

> 🇧🇷 **Versão em Português disponível:** [Leia em Português](../pt-BR/guides/cookbook.md)

This practical cookbook aggregates the most common everyday development workflows with Pantheon, showcasing exact prompts and which specialist to call for each scenario.

---

## Recipe 1: Full-Stack Feature with TDD & Quality Gates

**Scenario:** Implement a complete feature (e.g., CSV export endpoint with schema validation and tests).

**Prompt:**
```text
/pantheon Add CSV export support to /reports with unit tests and schema validation.
```

**Workflow:**
1. `@zeus` analyzes scope and delegates planning to `@athena`.
2. `@athena` defines phases and acceptance criteria; trade-offs are presented via the native `question` dialog.
3. Upon approval, `@hermes` writes failing tests (RED) and implements until green (GREEN).
4. `@themis` runs linters, security scans, and confirms coverage.

---

## Recipe 2: 1-Turn Express Hotfix (Bugs & Typos)

**Scenario:** Fix a CSS styling bug, a typo, or a missing import that does not require architectural ceremony.

**Prompt:**
```text
@talos Update the login submit button background from blue to emerald green in login.css
```

**Why use @talos?**
`@talos` is Pantheon's fast lane. It operates without subagents, skips Deepwork planning ceremonies, executes surgical single-turn edits, and finishes immediately.

---

## Recipe 3: Database Migrations & Query Optimization

**Scenario:** Add a new table or column with proper indexing and foreign key constraints without N+1 query pitfalls.

**Prompt:**
```text
@demeter Create an Alembic migration adding the 'user_preferences' table with a foreign key to 'users' and an index on 'created_at'.
```

**Why use @demeter?**
`@demeter` is Pantheon's persistence specialist. It enforces SQLAlchemy, Prisma, Alembic, and PostgreSQL best practices, ensuring referential integrity and optimized indexes.

---

## Recipe 4: Visual Refactoring from a Screenshot

**Scenario:** Rebuild or polish a frontend component to match a mockup.

**Prompt:**
*(Paste screenshot with Ctrl+V / Cmd+V into chat)*
```text
@aphrodite Refactor this metrics card component to match the visual styling, spacing, and typography in the pasted screenshot.
```

**Workflow:**
1. Pantheon Vision processes the screenshot silently via `session.context`.
2. `@aphrodite` inspects colors, layout hierarchy, and typography, updating React and CSS components with WCAG AA compliance.

---

## Recipe 5: Safe Codebase Investigation (Read-Only)

**Scenario:** Understand complex logic across multiple files without risking unintended modifications.

**Prompt:**
```text
@apollo Search the repository and trace how authentication tokens are validated in incoming WebSocket connections.
```

**Why use @apollo?**
`@apollo` is strictly read-only (`edit: deny`, `bash: deny`). It performs fast parallel exploration, returning structured findings with exact file paths and line ranges.

---

## Recipe 6: Pre-PR Quality & Security Audit

**Scenario:** Review all changes on the current branch before opening a pull request.

**Prompt:**
```text
@themis Audit all changes on this branch against OWASP Top 10 security standards, run Biome and test suites, and generate a quality verdict.
```

**Why use @themis?**
`@themis` has read-only audit permissions (`edit: deny`). It never modifies code directly; it runs test suites, checks linting rules, and issues clear compliance verdicts (`PASS`, `PASS_WITH_NOTES`, `BLOCK`).

---

## Recipe 7: AI Pipelines and RAG Tooling

**Scenario:** Implement a semantic search service with vector embeddings.

**Prompt:**
```text
@hephaestus Implement a vector search pipeline using LangChain and pgvector for document chunk retrieval.
```

**Why use @hephaestus?**
`@hephaestus` specializes in embeddings, vector stores, prompt chaining, and AI model integrations.

---

## Recipe 8: Docker & CI/CD Pipelines

**Scenario:** Create a multi-stage Dockerfile and a GitHub Actions workflow.

**Prompt:**
```text
@prometheus Create a multi-stage Dockerfile for our Node.js application and a GitHub Actions CI workflow to run tests on pull requests.
```

**Why use @prometheus?**
`@prometheus` owns containerization, GitHub Actions, build automation, and infrastructure configurations.
