# TDD with Agents — Advanced Testing Patterns

Detail companion for `SKILL.md`. Advanced patterns are reserved for changes
that warrant them — read on demand only when the change's risk or surface
calls for that pattern. The TDD cycle, proportional rules, coverage rules,
and anti-patterns stay in `SKILL.md`.

---

## E2E Testing (Playwright)
```typescript
test('user can complete full signup flow', async ({ page }) => {
  await page.goto('/signup')
  await page.fill('[name="email"]', 'test@example.com')
  await page.fill('[name="password"]', 'secure123')
  await page.click('button[type="submit"]')
  await expect(page.locator('.welcome-banner')).toBeVisible()
})
```

---

## Load Testing (k6/Locust)
```javascript
// k6 script
export const options = { vus: 50, duration: '30s' }
export default function () {
  http.get('http://localhost:8000/api/users')
}
```

---

## Contract Testing (Pact)
```python
# Provider verifies consumer contract
@pact.verify_provider
def test_provider_satisfies_consumer_contract():
    # Verify all interactions from pact file
    pass
```

---

## Mutation Testing (high-risk/critical logic only)
- Mutate source code (change `>` to `<`, remove conditions)
- Run tests → should fail (mutation killed)
- If tests pass → test is weak; improve it

---

## Visual Regression (visual behavior only)
```typescript
test('homepage looks the same', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveScreenshot('homepage.png')
})
```
