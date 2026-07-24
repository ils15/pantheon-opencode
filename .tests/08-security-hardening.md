# Test 08: MCP Security Hardening

Verify that MCP security measures are in place across all agents: parameterized queries, read-only constraints, Docker security flags, violation detection, and credential leakage prevention.

## Impact Assessment

What this means for library users:
- **SQL injection prevention** — all PostgreSQL MCP usage is parameterized-only
- **Container escape prevention** — Docker security flags are mandatory and enforced
- **Credential leakage prevention** — URL scanning rules protect against embedded secrets
- **Audit trail** — every security-sensitive MCP call is logged

## Pre-conditions
- `skills/mcp-security/SKILL.md` exists
- Agent files: `hermes.agent.md`, `demeter.agent.md`, `prometheus.agent.md`, `themis.agent.md`
- `agents/apollo.agent.md` exists

---

## TC-39: Demeter Has Parameterized Query Mandate

**What to verify:**
Demeter's template includes a Parameterized Query Mandate section with rules against f-strings, `.format()`, and `+` concatenation in SQL.

**How to test:**
```bash
grep -A20 "Parameterized Query Mandate" agents/demeter.agent.md
```

**Expected result:**
Demeter's template contains:
- "NEVER use f-strings, `format()`, or `+` concatenation" rule
- "ALWAYS use parameterized queries" with safe/unsafe examples
- Pre-Flight Checklist before every `postgresql_execute`

**Validation command:**
```bash
grep -q "Parameterized Query Mandate" agents/demeter.agent.md && \
grep -q "NEVER use f-strings" agents/demeter.agent.md && \
grep -q "Pre-Flight Checklist" agents/demeter.agent.md && \
echo "✅ TC-39: Demeter parameterized query mandate" || echo "❌ TC-39: Missing mandate"
```

**Status:** ⬜

---

## TC-40: Hermes Has Read-Only PostgreSQL Constraint

**What to verify:**
Hermes' PostgreSQL MCP has `readOnly: true` constraint and only allows SELECT queries.

**How to test:**
```bash
grep -A5 "constraints:" agents/hermes.agent.md
```

**Expected result:**
Hermes PostgreSQL constraints include `readOnly: true`. The text body includes a "Read-Only Constraint" section.

**Validation command:**
```bash
grep -q "readOnly.*true" agents/hermes.agent.md && \
grep -q "Read-Only Constraint" agents/hermes.agent.md && \
grep -q "SELECT only" agents/hermes.agent.md && \
echo "✅ TC-40: Hermes read-only constraint" || echo "❌ TC-40: Missing read-only constraint"
```

**Status:** ⬜

---

## TC-41: Prometheus Has Docker Security Flags Checklist

**What to verify:**
Prometheus template includes mandatory Docker security flags, a forbidden flags list, and a pre-run checklist.

**How to test:**
```bash
grep -A30 "MCP Security: Docker" agents/prometheus.agent.md
```

**Expected result:**
Prometheus contains:
- Mandatory Security Flags: `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, `--user=1000:1000`
- Forbidden Flags: `--privileged`, `--pid=host`, `--network=host`
- Pre-Run Checklist with 7 items
- Audit Logging requirement

**Validation command:**
```bash
grep -q "Mandatory Security Flags" agents/prometheus.agent.md && \
grep -q "--cap-drop=ALL" agents/prometheus.agent.md && \
grep -q "Forbidden Flags" agents/prometheus.agent.md && \
grep -q "--privileged" agents/prometheus.agent.md && \
grep -q "Pre-Run Checklist" agents/prometheus.agent.md && \
echo "✅ TC-41: Prometheus Docker security" || echo "❌ TC-41: Missing Docker security"
```

**Status:** ⬜

---

## TC-42: Themis Has MCP Violation Detection

**What to verify:**
Themis template includes MCP Security Violation Detection with grep patterns for SQL injection, Docker escape, and credential leakage.

**How to test:**
```bash
grep -A20 "MCP Security Violation Detection" agents/themis.agent.md
```

**Expected result:**
Themis contains:
- MCP Security Violation Detection table
- SQL injection detection: `psql_query(f"` pattern
- Docker escape detection: `docker_run` without `--cap-drop=ALL`
- Credential leak detection: `?token=` or `?key=` in fetch URLs
- CRITICAL severity blocks review

**Validation command:**
```bash
grep -q "MCP Security Violation" agents/themis.agent.md && \
grep -q "SQL Injection" agents/themis.agent.md && \
grep -q "Docker escape" agents/themis.agent.md && \
grep -q "Credential leak" agents/themis.agent.md && \
grep -q "CRITICAL.*block" agents/themis.agent.md && \
echo "✅ TC-42: Themis MCP violation detection" || echo "❌ TC-42: Missing violation detection"
```

**Status:** ⬜

---

## TC-43: Apollo Has Credential Leakage Prevention Rules

**What to verify:**
Apollo (main fetch agent) has credential leakage prevention rules: URL scanning, allowlist, response handling.

**How to test:**
```bash
grep -A30 "Credential Leakage\|credential.*leak\|URL.*token\|token.*URL" agents/apollo.agent.md
```

**Expected result:**
- Apollo: "Credential Leakage Rules" section with 6 numbered rules
- Apollo: URL allowlist table with documentation/standards/code domains

**Validation command:**
```bash
grep -q "Credential Leakage" agents/apollo.agent.md && \
grep -q "Scan URLs before fetching" agents/apollo.agent.md && \
grep -q "token=" agents/apollo.agent.md && \
grep -q "URL allowlist" agents/apollo.agent.md && \
echo "✅ TC-43: Credential leakage prevention" || echo "❌ TC-43: Missing credential rules"
```

**Status:** ⬜

---

## Results

| Test | Description | Status |
|------|-------------|--------|
| TC-39 | Demeter parameterized query mandate | ⬜ |
| TC-40 | Hermes read-only PostgreSQL | ⬜ |
| TC-41 | Prometheus Docker security flags | ⬜ |
| TC-42 | Themis MCP violation detection | ⬜ |
| TC-43 | Apollo credential leakage prevention | ⬜ |
