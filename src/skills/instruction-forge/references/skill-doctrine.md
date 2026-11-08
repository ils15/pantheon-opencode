# Skill Doctrine

A skill is a workflow a specialist executes on demand. The core pays its
context cost every invocation; depth must be earned by the trigger, not
carried by default.

## Anatomy (the enforced contract)

- `src/skills/<id>/SKILL.md` — the ONLY required file. Frontmatter allows
  exactly `name`, `description`, `license`, `compatibility`, `metadata`
  (`tests/agent-skills-contract.test.mjs` rejects anything else); `name` must
  equal the directory id; `description` must be non-empty and work as a
  router.
- Optional `references/*.md` — depth, loaded on demand by the agent's own
  `read`. Every shipped reference MUST be cited in the core's `## Routing`
  table; an uncited reference is dead weight (validate-routing warns).
- Optional `scripts/` — deterministic helpers, never prose in disguise.

## The description is the router

Selection reads the description, not the body. It must name the trigger
surfaced to the model ("Use when…") and the domain keywords for routing.
Write it as the ONE line a busy router sees among 22.

## Core budget: 120 lines

`tests/agent-skills-contract.test.mjs` pins the budget. The core keeps:

- frontmatter, one-line thesis, When-this-fires (triggers AND non-triggers),
- the operational contract (the rules that change behavior — format contracts
  stay in core: the agent cannot pause to load a file mid-output),
- the `## Routing` table + the interruption rule.

Everything else — worked examples, long checklists, edge cases, fixtures —
moves to `references/`. The split precedent is `auto-continue`: 2,656 →
1,003 tokens core, details under demand.

## The Routing section (mandatory when references/ exists)

```markdown
## Routing

| Action / trigger | Reference |
|---|---|
| <what the agent is about to do> | [references/x.md](references/x.md) |

A missing reference interrupts the action — read nothing in its place, never
improvise from memory.
```

The table is the source of truth; validate-routing fails the build when a
cited path is missing on disk and warns when a shipped reference is never
cited.

## Lifecycle

- New skill → add the catalog entry (`src/pantheon/pantheon-decision-catalog.ts`),
  the index (`src/skills/README.md`), then run `node scripts/update-skills-lock.mjs`.
- Grants: an agent runs a skill only if its frontmatter `skills:` grants it;
  permissions derive fail-closed (`permission.skill: { '*': 'deny' }`).
- Capture the friction through `reflect` first; if the artifact is an agent
  (not a skill), route to `agent-forge` instead.
