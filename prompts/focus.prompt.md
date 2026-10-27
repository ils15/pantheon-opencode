---
name: focus
description: "Pin a session goal to keep all todos, delegation decisions, and verification steps aligned with a single stated objective"
agent: zeus
tools: ['search']
---

# Pin Session Goal (Zeus + Session-Goal Skill)

## Session Goal

**Goal:** {{TASK_INPUT}}

---

## What to do

1. Confirm the goal is clear and actionable. If ambiguous, ask one clarifying question.
2. Format the goal using the 4-component structure below.
3. Write the pinned goal to `.pantheon/memory-bank/.tmp/current-goal.md`.
4. Announce the pinned goal in chat and confirm readiness to proceed.

---

## Goal Format

```
GOAL: {{WHAT_TO_BUILD}}
SCOPE: {{SCOPE}}
SUCCESS CRITERIA: {{SUCCESS_CRITERIA}}
OUT OF SCOPE: {{OUT_OF_SCOPE}}
```

---

## Alignment Rules (apply for the rest of this session)

- Every todo must relate to this goal
- Zeus invokes only agents relevant to this goal
- Themis checks that implementations serve this goal
- If a task drifts from the goal, flag it before proceeding
- Never change the goal silently — confirm with the user first
