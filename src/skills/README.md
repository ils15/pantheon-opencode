# Skills Reference — Pantheon

## Overview

Skills are reference modules loaded on demand by agents. Each skill provides domain-specific knowledge — architecture patterns, security checklists, optimization strategies, and implementation guides. Agents load skills when their task matches the skill's description, keeping context focused and token-efficient.

There are **21 skills** divided into **5 domains**.

## Skills by Domain

### Domain 1: Orchestration & Workflow

1. **agent-coordination** — `agent-coordination/SKILL.md`
   - Multi-agent orchestration with model routing, category delegation, and sprint management.
   - Used by: Zeus

2. **artifact-management** — `artifact-management/SKILL.md`
   - Structured artifact trail for feature implementations — plans, implementations, reviews, and decisions.
   - Used by: Zeus, Mnemosyne, Iris

3. **auto-continue** — `auto-continue/SKILL.md`
   - Auto-continue through todos with idle detection and safety gates for multi-step orchestration.
   - Used by: Zeus, Apollo, Hephaestus, Nyx, Gaia

4. **context-compression** — `context-compression/SKILL.md`
   - Level 2 — Pantheon-native context compression with priority scoring, semantic summarization, budget allocation, and cross-references.
   - Used by: Zeus, Mnemosyne, Themis

5. **memory-bank** — `memory-bank/SKILL.md`
   - Memory bank rules, structure, and optimization — complete guide to Pantheon memory management.
   - Used by: Mnemosyne, Athena

6. **orchestration-workflow** — `orchestration-workflow/SKILL.md`
   - Practical step-by-step walkthrough for orchestrating features end-to-end using the multi-agent system, from planning through deployment.
   - Used by: Zeus

7. **session-goal** — `session-goal/SKILL.md`
   - Pin session objectives to prevent scope creep across long multi-agent sessions.
   - Used by: Zeus, Mnemosyne

### Domain 2: Development Tools

8. **clonedeps** — `clonedeps/SKILL.md`
   - Clones dependency source locally so agents can inspect library internals, understand behavior, and debug integration issues.
   - Used by: Hermes, Hephaestus

9. **git-workflow-and-versioning** — `git-workflow-and-versioning/SKILL.md`
   - Atomic commits, conventional commits, trunk-based development workflow.
   - Used by: Hermes, Prometheus, Iris

10. **incremental-implementation** — `incremental-implementation/SKILL.md`
    - Implement in thin vertical slices — one commit per task, testable, rollback-safe.
    - Used by: Zeus, Hermes, Aphrodite, Demeter, Prometheus, Talos

11. **loop-engineering** — `loop-engineering/SKILL.md`
    - Iterative refinement pattern for complex problems — solve, review, improve, repeat in controlled cycles.
    - Used by: All agents

12. **reflect** — `reflect/SKILL.md`
    - Turns repeated workflow friction into reusable skills, agents, or configuration improvements.
    - Used by: All agents

13. **simplify** — `simplify/SKILL.md`
    - Behavior-preserving code simplification for readability, maintainability, and reduced complexity.
    - Used by: All agents

14. **worktrees** — `worktrees/SKILL.md`
    - Git worktrees as safe, isolated coding lanes for risky or parallel work without affecting the main workspace.
    - Used by: All agents

### Domain 3: Quality & Security

15. **code-review-checklist** — `code-review-checklist/SKILL.md`
    - Systematic code review with quality gates, security audit, and parallel checks for structured feedback.
    - Used by: Themis

16. **security-hardening** — `security-hardening/SKILL.md`
    - Security gate — OWASP, SAST, secrets detection, MCP hardening, dependency audit.
    - Used by: Themis, Nyx

17. **tdd-with-agents** — `tdd-with-agents/SKILL.md`
    - TDD enforcement with RED→GREEN→REFACTOR cycle and advanced testing patterns across all layers.
    - Used by: Hermes, Aphrodite, Demeter, Themis, Hephaestus

### Domain 4: Planning

18. **codemap** — `codemap/SKILL.md`
    - Generates hierarchical repository maps so agents understand codebase structure without re-reading every file.
    - Used by: Apollo, Zeus

19. **spec-driven-development** — `spec-driven-development/SKILL.md`
    - Define requirements via spec-first before any code — PRD, edge cases, acceptance criteria.
    - Used by: Athena

20. **verification-planning** — `verification-planning/SKILL.md`
    - Plans an evidence path before non-trivial changes, ensuring changes are testable and verifiable.
    - Used by: Athena, Zeus

### Domain 5: Frontend Development

21. **visual-review-pipeline** — `visual-review-pipeline/SKILL.md`
    - Automated visual review pipeline — Playwright screenshots, self-analysis, fix loop, escalation.
    - Used by: Aphrodite

## Skills File Structure

Each skill follows a consistent layout:

```
src/skills/[skill-name]/
├── SKILL.md          — main reference document (YAML frontmatter + content)
├── scripts/          — optional helper scripts (if any)
└── examples/         — optional example files, templates, or configs (if any)
```

The `SKILL.md` file contains YAML frontmatter with `name`, `description`, and platform metadata, followed by the full reference content in Markdown.

## How Skills Work

- **On-demand loading**: Skills are loaded when an agent's task matches the skill's description. The agent invokes the skill via the `skill` tool, injecting the domain knowledge into context.
- **Agent frontmatter**: Agents declare which skills they use via the `skills:` field in their `.agent.md` frontmatter. The platform uses this to determine relevance.
- **VS Code Copilot**: Automatically injects skill content when the agent detects a matching task description. Skills appear in the Available Skills list and can be loaded via `/skill` commands.
- **OpenCode platform**: Skills are listed in the system prompt's `<available_skills>` block. The agent invokes `skill` with the matching name to load the full content.
- **Other platforms**: Each platform loads skills differently. Refer to platform-specific documentation for integration details.

## Quick Reference Table

| # | Skill Name | Domain | Used By |
|---|------------|--------|---------|
| 1 | agent-coordination | Orchestration & Workflow | Zeus |
| 2 | artifact-management | Orchestration & Workflow | Zeus, Mnemosyne, Iris |
| 3 | auto-continue | Orchestration & Workflow | Zeus, Apollo, Hephaestus, Nyx, Gaia |
| 4 | context-compression | Orchestration & Workflow | Zeus, Mnemosyne, Themis |
| 5 | memory-bank | Orchestration & Workflow | Mnemosyne, Athena |
| 6 | orchestration-workflow | Orchestration & Workflow | Zeus |
| 7 | session-goal | Orchestration & Workflow | Zeus, Mnemosyne |
| 8 | clonedeps | Development Tools | Hermes, Hephaestus |
| 9 | git-workflow-and-versioning | Development Tools | Hermes, Prometheus, Iris |
| 10 | incremental-implementation | Development Tools | Zeus, Hermes, Aphrodite, Demeter, Prometheus, Talos |
| 11 | loop-engineering | Development Tools | All agents |
| 12 | reflect | Development Tools | All agents |
| 13 | simplify | Development Tools | All agents |
| 14 | worktrees | Development Tools | All agents |
| 15 | code-review-checklist | Quality & Security | Themis |
| 16 | security-hardening | Quality & Security | Themis, Nyx |
| 17 | tdd-with-agents | Quality & Security | Hermes, Aphrodite, Demeter, Themis, Hephaestus |
| 18 | codemap | Planning | Apollo, Zeus |
| 19 | spec-driven-development | Planning | Athena |
| 20 | verification-planning | Planning | Athena, Zeus |
| 21 | visual-review-pipeline | Frontend Development | Aphrodite |

---

[Main Documentation](../README.md)
