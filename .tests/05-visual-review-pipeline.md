# Test 05: Visual Review Pipeline

Verify the end-to-end visual review pipeline: Aphrodite visual analysis schema, routing.yml handoffs, iteration tracking, and MCP availability fallback.

## Impact Assessment

What this means for library users:
- **Visual quality assurance** — screenshots are self-analyzed by Aphrodite before Themis review
- **Iteration limits** — prevents infinite fix loops (max 3 iterations)
- **Graceful degradation** — pipeline works even when Playwright MCP is unavailable

## Pre-conditions
- Agents directory has `aphrodite.agent.md`, `zeus.agent.md`
- `routing.yml` has visual review handoff entries
- `instructions/visual-review-pipeline.instructions.md` exists

---

## TC-27: Visual Analysis JSON Schema Validation

**What to verify:**
Aphrodite visual analysis response follows the correct JSON schema: `verdict` field with values `pass | fail | warn`, `issues[]` array, `pass_if_fixed` string array, `iteration` integer, `summary` string.

**How to test:**
```
grep the visual review instructions for verdict, issues, pass_if_fixed
```

**Expected result:**
Visual review pipeline instructions reference these fields in the JSON schema.

**Validation command:**
```bash
grep -q "verdict" instructions/visual-review-pipeline.instructions.md && \
grep -q "issues" instructions/visual-review-pipeline.instructions.md && \
grep -q "pass_if_fixed" instructions/visual-review-pipeline.instructions.md && \
grep -q "iteration" instructions/visual-review-pipeline.instructions.md && \
echo "✅ TC-27 passed" || echo "❌ TC-27 failed"
```

**Status:** ⬜

---

## TC-28: Routing.yml Handoffs

**What to verify:**
The `routing.yml` file contains visual review handoffs: `visual_review` (aphrodite), `visual_fix` (aphrodite), `visual_escalate` (zeus).

**How to test:**
```
grep routing.yml for visual_review, visual_fix, visual_escalate handoff entries
```

**Expected result:**
Three handoff entries exist:
- `visual_review` → agent: aphrodite
- `visual_fix` → agent: aphrodite
- `visual_escalate` → agent: zeus

**Validation command:**
```bash
grep -q "visual_review" routing.yml && \
grep -q "visual_fix" routing.yml && \
grep -q "visual_escalate" routing.yml && \
echo "✅ TC-28 passed" || echo "❌ TC-28 failed"
```

**Status:** ⬜

---

## TC-29: Iteration Tracking (Max 3, Escalation to Zeus)

**What to verify:**
Visual review iterations are capped at 3. After 3 iterations issues must escalate to Zeus.

**How to test:**
```
grep for "3 iterations" or "max 3" and escalation patterns in zeus.agent.md and visual-review-pipeline.instructions.md
```

**Expected result:**
Both `zeus.agent.md` and `instructions/visual-review-pipeline.instructions.md` mention:
- Max 3 iterations limit
- Escalation to Zeus after exceeding iterations

**Validation command:**
```bash
grep -q "3 iterations\|max 3\|max_iterations: 3\|3 rounds" instructions/visual-review-pipeline.instructions.md && \
grep -q "escalat" agents/aphrodite.agent.md && \
grep -q "escalat" agents/zeus.agent.md && \
echo "✅ TC-29 passed" || echo "❌ TC-29 failed"
```

**Status:** ⬜

---

## TC-30: MCP Availability Check Fallback

**What to verify:**
When Playwright MCP is unavailable, the visual review pipeline should skip with a warning instead of blocking.

**How to test:**
```
grep for Playwright MCP availability check and fallback in zeus.agent.md
```

**Expected result:**
Zeus template has an MCP availability check that issues a warning when Playwright is unavailable and continues to Themis review.

**Validation command:**
```bash
grep -q "Playwright MCP\|⚠️.*Visual review skipped\|MCP unavailable\|MCP Check Protocol" agents/zeus.agent.md && \
echo "✅ TC-30 passed" || echo "❌ TC-30 failed"
```

**Status:** ⬜

---

## Results

| Test | Description | Status |
|------|-------------|--------|
| TC-27 | Visual analysis schema validation | ⬜ |
| TC-28 | Routing.yml handoffs | ⬜ |
| TC-29 | Iteration tracking | ⬜ |
| TC-30 | MCP availability fallback | ⬜ |
