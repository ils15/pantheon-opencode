---
name: council-agora
description: "Structured #seq council synthesis, targeted rebuttals, and swarm board handoffs. Use for /pantheon Agora councils, peer handoffs, and ephemeral slice workers."
---

# Council Agora & Swarm Board

Protocol for `#seq`-indexed council deliberations, targeted rebuttals, peer verifier handoffs, and ephemeral operation workers on `pantheon_board`.

## 1. Council Channel & Round 1 (Independent Positions)

1. Open a council thread before dispatching specialists:
   `pantheon_board(action="channel", channel="council", threadId="<slug>", goal="<question>")`
2. Dispatch 2–3 domain specialists with **independent** briefs (do not share peer responses in Round 1; require `agreement_signals` omitted or `none`).
3. Record each returned `## specialist_response` onto the board to assign monotonic `#seq` IDs:
   `pantheon_board(action="post", channel="council", threadId="<slug>", from="<agent>", tag="note", body="<summary>")`

## 2. Agreement Rate & Targeted `#seq` Rebuttal

- Group substantive positions by issue and compute `agreement_rate = agreeing_pairs / total_comparable_pairs` (`n*(n-1)/2` per comparable issue; exclude issues with `< 2` positions; never trigger rebuttal from an indeterminate zero denominator).
- Resolve divergences first via **Domain Authority Precedence** (`@themis`, `@demeter`, `@aphrodite`, `spawn_ephemeral` role `infra-ci`, `@hermes`, `@athena`) or **JEV Arbitration** (`pantheon_jev_decide`).
- If `agreement_rate < 0.5` (with zero timeouts) and an unverified factual contradiction remains, run **one targeted rebuttal round**:
  - Pass visible Round 1 positions with their exact `#seq` IDs.
  - Specialists cite peer `#seq` via `replyToSeq` / `@agent #seq` and declare `[consensus]` or `[deadlock]`.

## 3. Convergence (`[consensus]` / `[deadlock]`)

| Outcome | Board Action | Next Step |
|---|---|---|
| `[consensus]` | `pantheon_board(action="post", channel="council", threadId="<slug>", tag="consensus", replyToSeq=<seq>, body="...")` | Emit synthesis + `@themis` audit gate |
| `[deadlock]` | `pantheon_board(action="post", channel="council", threadId="<slug>", tag="deadlock", replyToSeq=<seq>, body="...")` | Surfaces in Cockpit Attention Queue as `decision`; escalate 2–3 concrete options via native `question` tool |

## 4. Peer Handoffs & Ephemeral Operation Workers

- **Peer Handoffs:** Cite the preceding `#seq` via `replyToSeq` and `@mention` only the next peer (e.g. implementer -> `@themis` verifier); tag `@zeus` only on `[done]` or `[blocker]`.
- **Watchdog Awareness:** Check `pantheon_board(action="status")` or `pantheon_board(action="read", tag="alert")` when `swarm:stall:detected` fires (`[alert]` from `watchdog`).
- **Ephemeral Slice Workers:** Use `pantheon_step_ledger(action="spawn_ephemeral", stepKey=..., role=..., baseAgent=...)` for short-lived isolated worktree slices; it posts `[claim]` / `[done]` / `[blocker]` `#seq` slots and cleans up sub-sessions and `.pantheon-worktrees/` automatically without writing `.opencode/agents/`.
