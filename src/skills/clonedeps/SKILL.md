---
name: clonedeps
description: Clones dependency source locally so agents can inspect library internals, understand behavior, and debug integration issues
---

# Clone Dependencies

Clone relevant dependency source code into a local directory for inspection and debugging.

## When to Use

- Debugging a library integration issue
- Understanding how a dependency works internally
- Checking if a bug is in your code or the dependency
- Evaluating a dependency before adding it
- Contributing a fix to an upstream project

## How to Clone

```bash
# Clone to local inspection directory
git clone <repo-url> .deps/<dependency-name>

# Or use a shallow clone for speed
git clone --depth 1 <repo-url> .deps/<dependency-name>

# For npm packages, find the repo from package.json
# For Python packages, check PyPI or source distribution
```

## Inspection Workflow

1. Identify the dependency and the specific behavior to investigate
2. Clone to `.deps/<name>/` (gitignored by default)
3. Read relevant source files
4. Return findings to the requesting agent
5. Clean up: `rm -rf .deps/<name>/` (optional)

## Rules
- Clone to `.deps/` directory (always gitignored)
- Shallow clone preferred (faster, less disk)
- Never commit dependency source to the project
- Never modify dependency source (unless contributing upstream)
- Escalate to @themis if a dependency vulnerability is found
- `rm -rf .deps/` after finishing to keep workspace clean
