# Test 04: Edge Cases and Error Handling

Verify behavior for ambiguous, edge, or error scenarios.

## TC-18: Ambiguous request

**Query:**
> "Fix the app"

**Expected routing:** @zeus (orchestrator) — should ask clarifying questions before delegating

**Model tier:** default

## TC-19: Security audit

**Query:**
> "Audit this code for OWASP Top 10 vulnerabilities"

**Expected routing:** @themis (primary, premium)

**Model tier:** premium

## TC-20: GitHub operations

**Query:**
> "Create a release PR for v3.8.0 with changelog"

**Expected routing:** @iris (primary, fast)

**Model tier:** fast

## TC-21: Documentation request

**Query:**
> "Document the architecture decisions from this sprint"

**Expected routing:** @mnemosyne (primary, fast)

**Model tier:** fast

## TC-22: Codebase discovery

**Query:**
> "Find all files related to authentication in the codebase"

**Expected routing:** @apollo (primary, fast)

**Model tier:** fast

## TC-23: Out of scope

**Query:**
> "Play a game of chess"

**Expected routing:** @zeus — should decline or redirect, not delegate blindly

| **Test** | **Request** | **Expected Agent** | **Status** |
|----------|------------|-------------------|-----------|
| TC-18 | Ambiguous "fix the app" | @zeus (clarify first) | ⬜ |
| TC-19 | OWASP audit | @themis | ⬜ |
| TC-20 | GitHub release PR | @iris | ⬜ |
| TC-21 | Sprint documentation | @mnemosyne | ⬜ |
| TC-22 | Auth codebase search | @apollo | ⬜ |
| TC-23 | Out of scope request | @zeus (decline) | ⬜ |
