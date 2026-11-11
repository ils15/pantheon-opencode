# Visual Review Pipeline — Workflow Steps

Detail companion for `SKILL.md`. Read on demand: running the capture → analyze
→ fix loop, Playwright MCP setup/fallback, escalation message format,
integration points, or a worked example. The loop contract, findings schema,
iteration rules, and escalation triggers stay in `SKILL.md`.

---

## Workflow Steps

### Step 1: Capture
Aphrodite uses Playwright MCP to capture screenshots.
- Navigate to target URL or render component
- Capture full-page screenshot via `browser/screenshotPage`
- Capture viewport-specific screenshots for responsive checks
- Name files descriptively: `screenshot-iteration-N-component.png`

### Step 2: Analyze
Aphrodite self-analyzes screenshots visually.
- Examine screenshot(s) for visual issues
- Identify problems in layout, contrast, responsive behavior, and accessibility
- Return findings in the structured JSON schema (in `SKILL.md`)
- Include iteration number in findings
- Mark issues with `pass_if_fixed` IDs

### Step 3: Fix
Aphrodite addresses each finding from self-analysis.
- Triage findings by severity (critical → high → medium → low)
- Fix each issue in component code
- Commit changes with descriptive message
- Re-capture screenshot for next iteration

### Step 4: Loop
Repeat Steps 1-3 for up to **3 iterations**.
- Each iteration must fix at least one `pass_if_fixed` issue
- Track iteration count in findings object
- If no progress detected (zero fixes applied), escalate immediately
- Compare before/after screenshots to verify fixes

### Step 5: Escalate
Zeus intervenes if issues persist after 3 iterations.
- **Trigger:** 3 iterations exhausted or zero-progress detected
- **Action:** Zeus coordinates manual review or architectural decision

**Escalation format:**
```
@zeus Visual review escalation: [component] failed after [N] iterations.
Remaining issues: [list of unresolved pass_if_fixed IDs]
Root cause: [backend | architectural | conflicting]
```

---

## Progress Detection

```
Iteration N:
  - Compare pass_if_fixed list to previous iteration
  - If any ID removed from pass_if_fixed → progress detected
  - If pass_if_fixed unchanged → zero progress → escalate
```

---

## MCP Requirements

### Playwright MCP (Required)
- Use `browser/screenshotPage` for full-page captures
- Use `browser/snapshot` for accessibility tree context
- Fallback: If Playwright MCP is unavailable, skip with warning:
  ```
  [WARN] Playwright MCP unavailable — visual review skipped.
  Install Playwright MCP server to enable visual review pipeline.
  ```
For UI implementation review, Aphrodite self-reviews.

---

## Integration Points

- **Code Review (Themis):** Visual review runs as part of frontend code review; findings feed into Themis's verdict.
- **Artifact Protocol:** Visual review findings can attach to `IMPL-` artifacts. Escalation decisions documented in `_notes/`.
- **Memory Bank:** Recurring visual issues documented in `01-active-context.md`. Architectural visual decisions recorded as `_notes/NOTE000X-*.md`.

---

## Example Workflow

```
1. Aphrodite captures screenshot of LoginButton
   → screenshot-iteration-1-login-button.png

2. Self-analysis returns:
   {
     "verdict": "fail", "iteration": 1,
     "issues": [{
       "id": "VIS-001", "category": "contrast", "severity": "high",
       "description": "White text on light blue bg, contrast ratio 2.1:1",
       "recommendation": "Darken background to #1a56db"
     }],
     "pass_if_fixed": ["VIS-001"]
   }

3. Fix contrast, re-capture → screenshot-iteration-2-login-button.png

4. Re-analysis: { "verdict": "pass", "iteration": 2, "issues": [],
     "summary": "All visual issues resolved", "pass_if_fixed": [] }

5. Pipeline complete — 2 iterations, all issues fixed.
```
