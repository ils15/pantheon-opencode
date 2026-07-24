# Test 09: Platform Adapter Conformance

Verify that all platform adapters generate valid agents from canonical templates, and that all 7 platforms (OpenCode, Claude, Cursor, Windsurf, Cline, Continue, Copilot CLI) sync correctly.

## Impact Assessment

What this means for library users:
- **Cross-platform compatibility** — agents work across all 7 supported platforms
- **Adapter integrity** — `sync-platforms.mjs` and `test-adapter-conformance.mjs` validate all outputs
- **CI gate** — broken platform adapters are caught early in development

## Pre-conditions
- `scripts/test-adapter-conformance.mjs` exists
- `scripts/sync-platforms.mjs` exists
- `platform/` directory has all adapter configs
- Node.js is available

---

## TC-44: All 7 Platforms Sync Correctly

**What to verify:**
The `sync-platforms.mjs` script runs without errors and produces output for all 7 platform targets.

**How to test:**
```bash
node scripts/sync-platforms.mjs --dry-run 2>&1
```

**Expected result:**
Script completes without throwing an error, showing what files would be generated/updated for each platform.

**Validation command:**
```bash
node scripts/sync-platforms.mjs --dry-run 2>&1 | grep -q "files" && \
echo "✅ TC-44: Platforms sync correctly" || echo "❌ TC-44: Sync failed"
```

**Status:** ⬜

---

## TC-45: OpenCode Adapter Generates Valid Agents

**What to verify:**
The OpenCode adapter (`platform/opencode/`) generates valid agent files with correct frontmatter.

**How to test:**
```bash
ls platform/opencode/agents/ | wc -l
head -5 platform/opencode/agents/aphrodite.md
```

**Expected result:**
The OpenCode adapter directory contains 14 agent files with valid YAML frontmatter matching the canonical format.

**Validation command:**
```bash
count=$(ls platform/opencode/agents/*.md 2>/dev/null | wc -l)
[ "$count" -eq 14 ] && echo "✅ TC-45: OpenCode has $count agents" || echo "❌ TC-45: Expected 14, found $count"
```

**Status:** ⬜

---

## TC-46: Claude Adapter Generates Valid Agents

**What to verify:**
The Claude adapter (`platform/claude/`) generates valid `.md` agent files with correct Claude-specific frontmatter.

**How to test:**
```bash
ls platform/claude/agents/ | wc -l
grep -q "name:" platform/claude/agents/zeus.md
```

**Expected result:**
Claude adapter directory has 14 agent files with valid YAML frontmatter.

**Validation command:**
```bash
count=$(ls platform/claude/agents/*.md 2>/dev/null | wc -l)
[ "$count" -eq 14 ] && echo "✅ TC-46: Claude has $count agents" || echo "❌ TC-46: Expected 14, found $count"
```

**Status:** ⬜

---

## TC-47: Cursor Adapter Generates Valid Agents

**What to verify:**
The Cursor adapter (`platform/cursor/`) generates valid `.mdc` agent rule files.

**How to test:**
```bash
ls platform/cursor/rules/*.mdc 2>/dev/null | wc -l
grep -q "description:" platform/cursor/rules/zeus.mdc
```

**Expected result:**
Cursor adapter directory has 14 `.mdc` rule files with valid metadata.

**Validation command:**
```bash
count=$(ls platform/cursor/rules/*.mdc 2>/dev/null | wc -l)
[ "$count" -eq 14 ] && echo "✅ TC-47: Cursor has $count agents" || echo "❌ TC-47: Expected 14, found $count"
```

**Status:** ⬜

---

## TC-48: Windsurf Adapter Generates Valid Agents

**What to verify:**
The Windsurf adapter (`platform/windsurf/`) generates valid rule files.

**How to test:**
```bash
ls platform/windsurf/rules/*.md 2>/dev/null | wc -l
grep -q "description:" platform/windsurf/rules/zeus.md
```

**Expected result:**
Windsurf adapter directory has 14 rule files.

**Validation command:**
```bash
count=$(ls platform/windsurf/rules/*.md 2>/dev/null | wc -l)
[ "$count" -eq 14 ] && echo "✅ TC-48: Windsurf has $count agents" || echo "❌ TC-48: Expected 14, found $count"
```

**Status:** ⬜

---

## Results

| Test | Description | Status |
|------|-------------|--------|
| TC-44 | All platforms sync correctly | ⬜ |
| TC-45 | OpenCode adapter valid | ⬜ |
| TC-46 | Claude adapter valid | ⬜ |
| TC-47 | Cursor adapter valid | ⬜ |
| TC-48 | Windsurf adapter valid | ⬜ |
