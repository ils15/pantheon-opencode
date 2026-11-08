# TDD with Agents — Testing by Layer

Detail companion for `SKILL.md`. Read on demand when writing tests for a
specific layer or assigning test duties in a delegation. The TDD cycle,
proportional rules, coverage rules, and workflow stay in `SKILL.md`.

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

## Agent Responsibilities

| Agent | Tests |
|-------|-------|
| **Hermes** | Unit + integration for FastAPI endpoints, services, middleware |
| **Aphrodite** | Component behavior tests with React Testing Library |
| **Demeter** | Migration upgrade/downgrade, query correctness |
| **Themis** | Reviews the changed surface, relevant edge/error cases, and applicable repository coverage requirements; always review sensitive/material changes |
