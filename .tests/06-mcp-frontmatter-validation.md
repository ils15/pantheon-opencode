# Test 06: mcpServers Frontmatter Validation

Verify that all 14 agent templates have valid mcpServers frontmatter declarations with correct schema, tool references, and constraints.

## Impact Assessment

What this means for library users:
- **MCP consistency** — all agents declare MCPs in a uniform format
- **Tool integrity** — MCP tools are cross-referenced against agent tool arrays
- **Safety constraints** — security-critical agents have queryMode, readOnly, forbiddenFlags enforcement

## Pre-conditions
- 14 agent `.agent.md` files exist in `agents/`
- Each file has YAML frontmatter delimited by `---`

---

## TC-31: All 14 Agents Have Valid mcpServers

**What to verify:**
Every agent template includes an `mcpServers:` declaration in its frontmatter.

**How to test:**
```bash
for f in agents/*.agent.md; do
  grep -q 'mcpServers:' "$f" || echo "MISSING in $f"
done
```

**Expected result:**
All 14 agents have `mcpServers:` in their frontmatter. No file reports as MISSING.

**Validation command:**
```bash
missing=0; for f in agents/*.agent.md; do
  grep -q 'mcpServers:' "$f" || { echo "MISSING: $f"; missing=$((missing+1)); }
done; [ "$missing" -eq 0 ] && echo "✅ TC-31: All 14 agents have mcpServers" || echo "❌ TC-31: $missing agents missing"
```

**Status:** ⬜

---

## TC-32: No Agent Exceeds 5 MCPs

**What to verify:**
Each agent declares at most 5 MCP servers. (Current max is apollo with 4.)

**How to test:**
```bash
for f in agents/*.agent.md; do
  count=$(awk '/^mcpServers:/,/^---/' "$f" | grep -c "  - name:")
  if [ "$count" -gt 5 ]; then
    echo "OVER LIMIT: $f ($count MCPs)"
  fi
done
```

**Expected result:**
No agent exceeds 5 MCPs.

**Validation command:**
```bash
over=0; for f in agents/*.agent.md; do
  count=$(awk '/^mcpServers:/,/^---/' "$f" | grep -c "  - name:")
  [ "$count" -gt 5 ] && { echo "OVER: $f ($count)"; over=$((over+1)); }
done; [ "$over" -eq 0 ] && echo "✅ TC-32: No agent exceeds 5 MCPs" || echo "❌ TC-32: $over agents over limit"
```

**Status:** ⬜

---

## TC-33: MCP Tool References Exist in Agent's Tools Array

**What to verify:**
Each MCP tool listed in `mcpServers[].tools` is also present in the agent's `tools:` array.

**How to test:**
Match MCP tool names (e.g., `context7_resolve-library-id`) against the agent's tools list. Note that some tools may use alternate naming conventions (`.` vs `_`).

**Expected result:**
All MCP tools are declared in the agent's top-level `tools:` array.

**Validation command:**
```bash
# Check aphrodite: context7 tools + playwright tools should be in tools array
grep -q "context7_resolve-library-id" agents/aphrodite.agent.md && \
grep -q "browser/screenshotPage" agents/aphrodite.agent.md && \
echo "✅ TC-33: Aphrodite MCP tools in array" || echo "❌ TC-33: Missing tool in array"

# Check apollo: context7, brave-search, exa, grep-app tools in array
grep -q "brave-search_search" agents/apollo.agent.md
```

**Status:** ⬜

---

## TC-34: Constraints Schema Is Valid

**What to verify:**
Agents with security-sensitive MCPs have valid constraint schemas:
- `queryMode: "parameterized-only"` for PostgreSQL MCPs (hermes, demeter)
- `readOnly: true` for read-only MCPs (hermes)
- `forbiddenFlags` for Docker MCP (prometheus)

**How to test:**
```bash
grep -A10 "constraints:" agents/hermes.agent.md
grep -A10 "constraints:" agents/demeter.agent.md
grep -A15 "constraints:" agents/prometheus.agent.md
```

**Expected result:**
- Hermes PostgreSQL: `queryMode: "parameterized-only"`, `readOnly: true`
- Demeter PostgreSQL: `queryMode: "parameterized-only"`, `auditLog: true`
- Prometheus Docker: `requiredFlags`, `forbiddenFlags`, `auditLog: true`

**Validation command:**
```bash
grep -q "queryMode.*parameterized-only" agents/hermes.agent.md && \
grep -q "readOnly.*true" agents/hermes.agent.md && \
grep -q "queryMode.*parameterized-only" agents/demeter.agent.md && \
grep -q "forbiddenFlags" agents/prometheus.agent.md && \
grep -q "requiredFlags" agents/prometheus.agent.md && \
echo "✅ TC-34: Constraints valid" || echo "❌ TC-34: Missing constraints"
```

**Status:** ⬜

---

## Results

| Test | Description | Status |
|------|-------------|--------|
| TC-31 | All 14 agents have mcpServers | ⬜ |
| TC-32 | No agent exceeds 5 MCPs | ⬜ |
| TC-33 | MCP tools in agent array | ⬜ |
| TC-34 | Constraints schema valid | ⬜ |
