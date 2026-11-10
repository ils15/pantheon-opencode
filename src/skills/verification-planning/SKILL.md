---
name: verification-planning
description: Plans an evidence path before non-trivial changes, ensuring changes are testable and verifiable
---

# Verification Planning

Before making non-trivial changes, plan how you'll verify correctness. Define the evidence needed to confirm the change works.

## When to Use

- Before any change that touches 3+ files
- Before database migrations or schema changes
- Before API contract changes
- Before dependency upgrades
- Before refactoring critical paths

## Plan Structure

```markdown
## Verification Plan

### Change Scope
- Files to modify: <list>
- Risk level: <low|medium|high>

### Verification Strategy
| What to verify | How to verify | Tool/Command | Expected Outcome |
|----------------|---------------|-------------|------------------|

### Rollback Plan
- <how to revert if something goes wrong>

### Acceptance Criteria
- [ ] All existing tests pass
- [ ] New tests cover changed paths
- [ ] No regression in <critical metric>
- [ ] Rollback tested
```

## Risk Levels

| Level | Triggers | Verification Required |
|-------|----------|----------------------|
| Low | 1-2 files, bounded scope | Existing tests pass |
| Medium | 3-5 files, shared logic | New tests for changed paths |
| High | 5+ files, schema/API changes | Full plan + rollback test |

## Rules
- **Fast-Track (Low Risk, 1–2 files)**: Self-contained inline verification (1–2 lines). **Zero pre-implementation approval or delegation needed** — run the targeted test and proceed directly.
- **Medium Risk (3–5 files)**: Focused verification plan executed directly by the specialist. Run focused tests for changed paths; Themis review occurs after implementation only if behavioral ambiguity exists.
- **Deep-Track / High Risk (5+ files, Auth, Schema/DB, Payments)**: Verification plan must be approved by @themis before implementation.
- Escalate to @athena if verification planning reveals unknown scope.
