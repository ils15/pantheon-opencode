# Code Review — Itemized Checklists and SOLID

Detail companion for `SKILL.md`. Read on demand when executing the itemized
review pass. The review scope, automated-check-first rule, feedback format,
severity definitions, and anti-patterns stay in `SKILL.md`.

---

## Review Checklist

### Correctness
- [ ] Logic is correct and complete
- [ ] Edge cases handled
- [ ] Error handling appropriate
- [ ] Performance acceptable

### Code Quality
- [ ] No duplication (DRY principle)
- [ ] Single responsibility functions
- [ ] Clear and descriptive naming
- [ ] Reasonable complexity (no god functions)
- [ ] Proper file sizes (<300 lines)

### Testing
- [ ] Tests cover the changed behavior where meaningful; documentation/format-only changes do not need invented tests
- [ ] Apply an explicit repository coverage threshold only when measurable and relevant to the changed code
- [ ] Integration tests where the change crosses workflow boundaries
- [ ] Relevant edge cases tested for the changed behavior/risk
- [ ] Relevant error conditions tested

### Security (OWASP Top 10)
- [ ] Input validation present
- [ ] No hardcoded secrets/credentials
- [ ] No XXE, CSRF, XSS vulnerabilities
- [ ] Authentication/authorization proper
- [ ] Sensitive data encrypted
- [ ] Rate limiting on sensitive endpoints
- [ ] Audit logging for security events

### Documentation
- [ ] Public functions documented
- [ ] Comments explain WHY not WHAT
- [ ] README/guides accurate
- [ ] API documentation complete

---

## SOLID Principles Check

- **S**ingle Responsibility: Each class/function does one thing
- **O**pen/Closed: Extensible without modification
- **L**iskov Substitution: Subtypes behave like base types
- **I**nterface Segregation: Small, focused interfaces
- **D**ependency Inversion: Depend on abstractions, not concretions
