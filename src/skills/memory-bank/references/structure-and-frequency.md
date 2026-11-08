# Memory Bank — Structure and Update Frequency

Detail companion for `SKILL.md`. Read on demand when creating or updating
memory-bank files and you need the layout, file purposes, or the fill/update
cadence. Golden rules and who-writes-what stay in `SKILL.md`.

---

## Memory Bank Structure

```
.pantheon/memory-bank/
├── 00-project.md           ← What is this project? (fill once)
├── 00-architecture.md      ← System design and agent hierarchy
├── 00-components.md        ← Component breakdown and ownership
├── 00-tech-stack.md        ← Tech stack, setup, environment
├── 01-active-context.md    ← Current sprint focus, decisions, blockers (MOST IMPORTANT)
├── 02-progress-log.md      ← What works, what's left, milestones (append-only)
├── _tasks/
│   ├── _index.md           ← Task master list
│   └── TASK0001-name.md    ← Individual task records
└── _notes/
    ├── _index.md           ← Notes index
    └── NOTE0001-topic.md   ← Architectural decisions, findings
```

Memory Bank files are not automatically synchronized across clones. In
particular, `_tasks/` records may be Git-ignored; only files tracked and
committed under the repository's policy are shared through Git.

---

## File Update Frequency

| File | Fill when | Update frequency |
|------|-----------|-----------------|
| `00-project.md` | Project start | Rarely |
| `00-architecture.md` | Project start | On significant changes |
| `00-components.md` | Project start | When components added/removed |
| `00-tech-stack.md` | Project start | On stack changes |
| `01-active-context.md` | Each sprint | Each sprint / major decision |
| `02-progress-log.md` | First completion | Append-only per milestone |
| `_tasks/` | Sprint tracking | Per task |
| `_notes/` | Significant findings | Per finding |
