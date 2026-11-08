# Memory Bank — Anti-Patterns

Detail companion for `SKILL.md`. Read on demand when unsure whether a write
pattern violates the memory-bank rules. The golden rules themselves stay in
`SKILL.md`.

---

### ❌ Session output as files
```
# Wrong
Create IMPLEMENTATION_SUMMARY.md
Create STATUS.md

# Right
@mnemosyne Append to 02-progress-log.md: [summary]
```

### ❌ Mandatory handoff after every phase
```
# Wrong: After every phase → handoff to @mnemosyne

# Right: Agent appends to 01-active-context.md directly
At sprint close → explicit @mnemosyne invocation
```

### ❌ Duplicating information
```
# Wrong: duplicate the same fact in both durable Memory and a project document

# Right: Durable reusable fact → pantheon-memory (when warranted and granted)
         Narrative context → 00-project.md (read on demand)
```
