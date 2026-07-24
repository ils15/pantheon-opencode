# Test 07: Search Optimization

Verify that Apollo has the correct search MCP tooling, 12 agents are blocked from self-search, and delegation rules are enforced in the Zeus template.

## Impact Assessment

What this means for library users:
- **Cost optimization** — search is delegated to Apollo (fast model tier) instead of premium agents
- **Tool consolidation** — Apollo has all search tools (Exa, Grep.app, Context7, brave-search)
- **Security** — implementation agents cannot perform web searches (reduces credential leakage risk)

## Pre-conditions
- All agent `.agent.md` files exist
- `routing.yml` has search delegation rules
- `zeus.agent.md` has Search Delegation Policy section

---

## TC-35: Apollo Has Exa + Grep.app + Context7 + Brave-Search

**What to verify:**
Apollo's mcpServers include all four search MCPs: `exa`, `grep-app`, `context7`, `brave-search`.

**How to test:**
```bash
grep -A40 'mcpServers:' agents/apollo.agent.md | grep "name:\|tools:"
```

**Expected result:**
Apollo's frontmatter contains:
- `name: context7` with tools: `context7_resolve-library-id`, `context7_query-docs`
- `name: brave-search` with tools: `brave-search_search`
- `name: exa` with tools: `exa_web_search_exa`, `exa_web_fetch_exa`
- `name: grep-app` with tools: `grep_app_searchGitHub`

**Validation command:**
```bash
grep -q "name: exa" agents/apollo.agent.md && \
grep -q "exa_web_search_exa" agents/apollo.agent.md && \
grep -q "name: grep-app" agents/apollo.agent.md && \
grep -q "grep_app_searchGitHub" agents/apollo.agent.md && \
grep -q "name: context7" agents/apollo.agent.md && \
grep -q "name: brave-search" agents/apollo.agent.md && \
echo "✅ TC-35: Apollo has all 4 search MCPs" || echo "❌ TC-35: Missing search MCP"
```

**Status:** ⬜

---

## TC-37: Implementation Agents Have Search Policy Blocking Self-Search

**What to verify:**
The following 10 agents have a Search Policy blocking self-search: hermes, aphrodite, demeter, themis, prometheus, hephaestus, nyx, iris, mnemosyne, talos.

**How to test:**
```bash
for agent in hermes aphrodite demeter themis prometheus hephaestus nyx iris mnemosyne talos; do
  grep -q "You do NOT perform web searches directly" "agents/${agent}.agent.md" || echo "MISSING Search Policy: $agent"
done
```

**Expected result:**
All 10 agents have the Search Policy header: `"You do NOT perform web searches directly"`.

**Validation command:**
```bash
missing=0
for agent in hermes aphrodite demeter themis prometheus hephaestus nyx iris mnemosyne talos; do
  grep -q "You do NOT perform web searches directly" "agents/${agent}.agent.md" || { echo "MISSING: $agent"; missing=$((missing+1)); }
done
[ "$missing" -eq 0 ] && echo "✅ TC-37: All 10 agents blocked from self-search" || echo "❌ TC-37: $missing agents missing search policy"
```

**Status:** ⬜

---

## TC-38: Delegation Rules in Zeus Template

**What to verify:**
Zeus template has a Search Delegation Policy section that routes search requests correctly.

**How to test:**
```bash
grep "Search Delegation Policy\|Search Policy\|apollo.*search\|Never delegate search" agents/zeus.agent.md
```

**Expected result:**
Zeus template contains:
- Search Delegation Policy table or section
- Apollo is designated as primary search agent
- Implementation agents must delegate to Apollo for search

**Validation command:**
```bash
grep -q "Search Delegation Policy" agents/zeus.agent.md && \
grep -q "apollo" agents/zeus.agent.md | grep -q "search" && \
echo "✅ TC-38: Zeus has search delegation rules" || echo "❌ TC-38: Missing delegation rules"
```

**Status:** ⬜

---

## Results

| Test | Description | Status |
|------|-------------|--------|
| TC-35 | Apollo has Exa + Grep.app + Context7 + brave-search | ⬜ |
| TC-37 | 10 agents blocked from self-search | ⬜ |
| TC-38 | Delegation rules in Zeus template | ⬜ |
