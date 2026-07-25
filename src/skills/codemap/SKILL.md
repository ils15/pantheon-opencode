---
name: codemap
description: Generates hierarchical repository maps so agents understand codebase structure without re-reading every file
---

# Codemap

Generate a hierarchical map of the codebase to understand its structure, key modules, and entry points.

## When to Use

- Starting work on an unfamiliar codebase
- Before planning a cross-cutting change
- After significant refactoring
- When you need to understand module boundaries

## How to Generate

1. **Top-level structure**: List directories, entry points, config files
2. **Module boundaries**: Identify public APIs, internal modules, shared utilities
3. **Data flow**: Trace how data moves between layers
4. **Output**: Structured markdown with hierarchy, purpose, and key files per module

## Format

```markdown
# Codemap: <project-name>

## Structure
<top-level tree>

## Modules
| Module | Purpose | Key Files | Entry Points |
|--------|---------|-----------|--------------|

## Data Flow
<description of how data moves through the system>

## Dependencies
| External | Purpose | Version |
|----------|---------|---------|
```

## Rules
- Focus on structure, not implementation details
- Max 3 levels deep unless a module is critical
- Return to agent: "Codemap generated. Send to @athena for planning."
