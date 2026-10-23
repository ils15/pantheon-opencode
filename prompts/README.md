# Prompt Files

Reusable prompt templates for common development workflows. Each prompt
specifies a target agent, required tools, and structured instructions.

## Available Prompts (10)

| Prompt | Agent | Purpose |
|---|---|---|
| **orchestrate-with-zeus** | Zeus | Full feature orchestration — planning, implementation, review, deployment |
| **implement-feature** | Zeus | End-to-end feature implementation with TDD and quality gates |
| **plan-architecture** | Athena | Strategic architecture planning with research and TDD-driven plan |
| **debug-issue** | Apollo | Rapid debugging with parallel file discovery and analysis |
| **optimize-database** | Demeter | Database schema, query, and performance optimization |
| **focus** | Zeus | Pin a session goal to keep all work aligned with a single objective |
| **sketch** | Athena | Interview a rough idea into a structured feature spec (3–5 questions) |
| **subtask** | Zeus | Delegate a bounded child task to a specialist and receive a structured result |
| **quick-discovery-large-codebase** | Apollo | Fast-path bounded discovery for large codebases (8-minute cap) |
| **quick-plan-large-feature** | Athena | Fast-path bounded planning for large features (5-minute cap) |

## Usage

Prompt templates are **not** slash commands. OpenCode slash commands live in
`commands/` and are invoked in chat:

```text
/pantheon Add CSV export to the reports page, including tests and a review.
/pantheon-audit Changes in src/auth/
/pantheon-focus Implement email verification end-to-end with TDD
/pantheon-deepwork Migrate the billing module
/pantheon-model status
/pantheon-optimize
/pantheon-vision
/pantheon-consolidate
```

The templates in this directory are loaded by the command or agent that needs
them; they are not invoked directly by filename. In particular:

- `focus.prompt.md` is used by `/pantheon-focus`.
- The audit guidance is used by `/pantheon-audit`.
- `sketch.prompt.md` has **no matching command file**, so it is available as a
  template only. There is currently no `/sketch` command.

For the full command list, see the commands directory in the repository. For
agent roles, see `docs/agents/README.md`.
