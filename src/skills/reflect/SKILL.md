---
name: reflect
description: Turns repeated workflow friction into reusable skills, agents, or configuration improvements
---

# Reflect

After completing a task, reflect on what could be improved in the workflow itself. Turn recurring patterns into reusable assets.

## When to Use

- After completing a complex feature
- When you notice the same manual steps repeating
- After debugging something that should have been automated
- At the end of a work session

## Reflection Checklist

| Question | If Yes → |
|----------|----------|
| Did I repeat the same search 3+ times? | → Create a command or skill |
| Did I follow the same steps manually? | → Create a recipe/checklist |
| Did I debug something preventable? | → Add a lint rule or test |
| Did I context-switch between tools? | → Create an automation script |
| Did I need info I didn't have? | → Add to memory-bank or instructions |

## Output

```markdown
## Reflection

### What went well
- ...

### What was friction
- ... (3+ repeats = automation opportunity)

### Action Items
- [ ] Create skill: <name>
- [ ] Add instruction: <topic>
- [ ] Update agent: <agent-name>
- [ ] Add test: <scenario>
```

## Rules
- Be specific: "Searched for auth patterns 4x" not "too much searching"
- One action item per friction point
- Escalate to @mnemosyne for memory-bank updates
- At end: "Reflection complete. Action items created."
