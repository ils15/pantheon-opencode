---
description: "Dispatch a question to 2-4 specialist agents via inline Zeus council"
agent: zeus
---
# /pantheon — Council Synthesis

**What:** Dispatches an architectural or high-impact question to 2-3 specialist agents **in parallel**, then synthesizes their perspectives into an assertive, actionable decision with resolved divergences.
**Usage:** `/pantheon <question>` (add `--research` for a 30s Apollo pre-scan)
**When:** Architecture trade-offs, technology selection, security reviews, multi-stakeholder decisions. (Never for routine fixes or single-file edits — use Fast-Track instead).
**Returns:** Structured synthesis with decisive recommendation, confidence level, and clear arbitration.

### Execution & Arbitration:
- **Parallel Round 1 (`pantheon_board` Agora):** Open `pantheon_board(action="channel", channel="council", threadId=..., goal=...)`, dispatch 2-3 specialists in a single turn with independent briefs, and record each `## specialist_response` as a `#seq`-indexed board slot (`agreement_signals` omitted or `none` in Round 1).
- **Assertive Arbitration:** Divergences are resolved via **Domain Authority Precedence** (Themis for Security/Auth vetoes, Demeter for DB/Persistence, Aphrodite for UI/A11y, Hermes for Backend/API/Infra, Athena for Modularity) or **JEV Multi-Criteria Decision** (`pantheon_jev_decide`).
- **Targeted `#seq` Rebuttal & Convergence:** When `agreement_rate < 50%` (with no timeouts) and an unverified factual contradiction remains, run 1 targeted `@agent #seq` rebuttal (`replyToSeq`) requiring `[consensus]` or `[deadlock]`. Post `[consensus]` to close or `[deadlock]` to escalate 2-3 options via native `question`.

Dispatch, specialist selection, and synthesis follow the canonical `## Zeus Council Synthesis` protocol (`skill: council-agora`). Send ALL Round 1 specialist calls in a single message; each specialist returns the `## specialist_response` structure from `## Agent Return Format`.

## Question:
$ARGUMENTS
