# Test 05: MCP Validation

Verify all configured MCPs are accessible and functional.

## Setup
- OpenCode config: `~/.config/opencode/opencode.json`
- Working directory: Pantheon repo

## TC-21: GitHub MCP (remote)

**Query:**
> "List the open issues in this repo using GitHub MCP"

**Expected:** Returns list of issues from github.com/ils15/pantheon

**MCP used:** `github` (remote, OAuth)

**Status:** ⬜

## TC-22: Context7 MCP (remote)

**Query:**
> "Using context7, show me the latest FastAPI documentation for dependency injection"

**Expected:** Returns structured documentation for FastAPI's Depends()

**MCP used:** `context7` (remote)

**Status:** ⬜

## TC-23: Grep.app MCP (remote, free)

**Query:**
> "Search grep.app for FastAPI user authentication examples"

**Expected:** Returns code search results from public GitHub repos

**MCP used:** `grep-app` (remote, free)

**Status:** ⬜

## TC-24: Brave Search MCP (local)

**Query:**
> "Search the web for 'Pantheon multi-agent framework' using brave-search"

**Expected:** Returns web search results

**MCP used:** `brave-search` (local, requires BRAVE_API_KEY)

**Status:** ⬜

## TC-25: Exa AI MCP (local)

**Query:**
> "Search for recent articles about AI agent orchestration using exa"

**Expected:** Returns web search results with content snippets

**MCP used:** `exa` (local, requires EXA_API_KEY)

**Status:** ⬜

## TC-26: Playwright MCP (local)

**Query:**
> "Open https://example.com and take a screenshot"

**Expected:** Playwright navigates and captures a screenshot

**MCP used:** `playwright` (local, free)

**Status:** ⬜

## Results

| Test | MCP | Status | Notes |
|------|-----|--------|-------|
| TC-21 | GitHub MCP | ⬜ | |
| TC-22 | Context7 | ⬜ | |
| TC-23 | Grep.app | ⬜ | |
| TC-24 | Brave Search | ⬜ | |
| TC-25 | Exa AI | ⬜ | |
| TC-26 | Playwright | ⬜ | |

## Quick Verification

```bash
# OpenCode CLI - check MCP status
opencode mcp list

# Test each MCP
opencode mcp debug github
opencode mcp debug context7
opencode mcp debug grep-app
opencode mcp debug brave-search
opencode mcp debug exa
opencode mcp debug playwright
```
