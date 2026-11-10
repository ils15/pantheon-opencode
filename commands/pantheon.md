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
- **Parallel Dispatch:** Dispatches 2-3 specialists in a single turn with independent briefs.
- **Assertive Arbitration:** Divergences are resolved via **Domain Authority Precedence** (Themis for Security/Auth vetoes, Demeter for DB/Persistence, Aphrodite for UI/A11y, Prometheus for Infra/CI, Hermes for APIs, Athena for Modularity) or **JEV Multi-Criteria Decision** (`pantheon_jev_decide`).
- **Autonomous & Low-Latency:** Multi-turn debates and rebuttals are avoided unless an unverified factual contradiction exists. Zeus concludes decisively.

Dispatch, specialist selection, and synthesis follow the canonical `## Zeus Council Synthesis` protocol. Send ALL specialist calls in a single message; each specialist returns the `## specialist_response` structure from `## Agent Return Format`.

## Question:
$ARGUMENTS
