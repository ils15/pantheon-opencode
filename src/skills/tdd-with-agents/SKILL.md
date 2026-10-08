---
name: tdd-with-agents
description: "TDD enforcement with RED→GREEN→REFACTOR cycle and advanced testing patterns. Use for test-driven development across all layers."
context: fork
globs: []
alwaysApply: false
---

# TDD with Agents

Use RED → GREEN → REFACTOR for behavior-changing implementation where a meaningful test can express the change. Keep verification proportional to the changed surface and risk; advanced testing patterns are reserved for changes that warrant them.

---

## Core Principle

> **For testable behavior changes, write the focused test first, observe RED, implement minimally, then refactor.**

## Proportional TDD

- Use the complete RED → GREEN → REFACTOR cycle for new or changed behavior when a focused test is practical. Include a focused regression check for bug fixes.
- For typo, formatting, documentation-only, or otherwise non-behavioral edits, do not invent a test; inspect the diff and run the narrowest relevant validation.
- Run targeted tests for a small change. Run broader suites when the changed surface, integration boundaries, or risk make them useful; do not run the whole suite solely because one line changed.
- If a relevant existing test already captures the behavior, use it instead of adding a duplicate. If no automated check can express the change, report the manual or static verification performed.
- Auth, security, payment, data-integrity, and schema/migration changes retain focused RED/GREEN tests, required regression coverage, and Themis review. Do not weaken a project-specific required safety gate.

---

## TDD Cycle (RED → GREEN → REFACTOR)

### RED — Write Failing Test
- Write test for the behavior you want
- Run it → **must fail** (confirms test works)
- Test should be specific: one assertion per test

### GREEN — Make It Pass
- Write **minimal** code to pass the test
- No extra features, no premature optimization
- If it feels hard → design problem; refactor test

### REFACTOR — Improve Without Breaking
- Clean up code while tests stay green
- Extract functions, rename, remove duplication
- Tests are your safety net

---

## Testing by Layer

### Backend (Hermes)
```python
# Unit: service logic
def test_calculate_discount_applies_percentage():
    result = calculate_discount(100, 10)
    assert result == 90.0

# Integration: API endpoint
def test_get_user_returns_404_for_missing():
    response = client.get("/users/nonexistent")
    assert response.status_code == 404

# Database: repository
def test_user_repository_saves_and_retrieves():
    repo.save(User(id="1", name="Test"))
    assert repo.find("1").name == "Test"
```

### Frontend (Aphrodite)
```typescript
// Test behavior, not implementation
test('shows error message on invalid form', async () => {
  render(<LoginForm />)
  await userEvent.click(screen.getByText('Submit'))
  expect(screen.getByText('Email is required')).toBeInTheDocument()
})
```

### Database (Demeter)
```python
def test_migration_creates_users_table():
    alembic upgrade(head)
    assert inspector.has_table('users')

def test_migration_rollback_drops_table():
    alembic upgrade(head)
    alembic downgrade(-1)
    assert not inspector.has_table('users')
```

---

## Advanced Testing Patterns

### E2E Testing (Playwright)
```typescript
test('user can complete full signup flow', async ({ page }) => {
  await page.goto('/signup')
  await page.fill('[name="email"]', 'test@example.com')
  await page.fill('[name="password"]', 'secure123')
  await page.click('button[type="submit"]')
  await expect(page.locator('.welcome-banner')).toBeVisible()
})
```

### Load Testing (k6/Locust)
```javascript
// k6 script
export const options = { vus: 50, duration: '30s' }
export default function () {
  http.get('http://localhost:8000/api/users')
}
```

### Contract Testing (Pact)
```python
# Provider verifies consumer contract
@pact.verify_provider
def test_provider_satisfies_consumer_contract():
    # Verify all interactions from pact file
    pass
```

### Mutation Testing (high-risk/critical logic only)
- Mutate source code (change `>` to `<`, remove conditions)
- Run tests → should fail (mutation killed)
- If tests pass → test is weak; improve it

### Visual Regression (visual behavior only)
```typescript
test('homepage looks the same', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveScreenshot('homepage.png')
})
```

---

## Coverage Rules

- Follow a repository's explicit coverage threshold when the changed code is in its measurement scope; do not manufacture a coverage target for docs, formatting, or a tiny isolated edit.
- **Critical paths:** preserve project-required coverage and tests for auth, payments, and data integrity.
- **No snapshot testing** — test behavior, not output shape
- **Test edge cases**: empty input, null, boundary values, errors

---

## Agent Responsibilities

| Agent | Tests |
|-------|-------|
| **Hermes** | Unit + integration for FastAPI endpoints, services, middleware |
| **Aphrodite** | Component behavior tests with React Testing Library |
| **Demeter** | Migration upgrade/downgrade, query correctness |
| **Themis** | Reviews the changed surface, relevant edge/error cases, and applicable repository coverage requirements; always review sensitive/material changes |

---

## Workflow

```
1. Use a plan/spec only when scope, risk, or ambiguity warrants it; a bounded fix may proceed directly
2. Hermes writes failing test (RED)
3. Hermes implements minimal code (GREEN)
4. Hermes refactors (REFACTOR)
5. Aphrodite writes frontend tests in parallel
6. Themis reviews sensitive or material changes, checking changed behavior and applicable quality gates
7. Escalate unmet repository or safety-critical test requirements; do not fail a micro-edit against an unrelated global coverage figure
```

---

## Anti-Patterns

- ❌ Writing code before test
- ❌ Testing implementation details (private methods, internal state)
- ❌ Mocking everything (test real behavior where possible)
- ❌ Skipping RED step (test must fail first)
- ❌ Ignoring flaky tests (fix or delete)
