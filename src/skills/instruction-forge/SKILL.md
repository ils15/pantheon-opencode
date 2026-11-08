---
name: instruction-forge
description: "Write and maintain AI instructions — AGENTS.md, agent prompts, and skill packages. Use when creating or editing any directive artifact, deciding where a rule lives, or testing that a rule fires."
---

# Instruction Forge

> **The smallest context that fully specifies the required behavior. Every rule has exactly one home, and every rule is tested for where it fires — and where it must not.**

---

## When this fires

- Writing or editing any directive artifact: AGENTS.md (either artifact), an agent prompt, an instruction file, a SKILL.md.
- A rule keeps being repeated in prompts or conversation — it needs a single home.
- A directive changed and you must prove nothing the old text required was lost.
- Deciding WHERE a new rule lives at all — or concluding it should not be written down.

Do NOT fire for one-shot task instructions given in conversation; those stay in conversation. Only durable, reusable behavior gets an artifact.

## Where a rule lives — one home per fact

| Rule kind | Home | Loaded when |
|---|---|---|
| Repo setup (commands, layout, gates of THIS repo) | `AGENTS.md` managed region | Every session in the repo |
| Repo-agnostic behavior every session must pay for | `AGENTS.global.md` / shared instruction (`agents: ["*"]`) | Every session |
| Behavior scoped to one agent | `src/instructions/*.instructions.md` with `agents:` selector | That agent's prompt, at build |
| A recurring workflow a specialist executes | A skill (`SKILL.md`, ≤120-line core + `references/`) | On demand via grant |
| A runtime gate the plugin owns | `behaviors:` registry in `routing.yml` (then env/override), never prose | Plugin setup |
| Generated region content | `scripts/build-agents-md.mjs` (source of truth) — NEVER hand-edited | Regenerated |

Two artifacts, zero overlap: the project `AGENTS.md` carries repo setup; `AGENTS.global.md` carries repo-agnostic rules. A session pays for global + project exactly once — a rule in both is a defect (`tests/eval/instruction-golden.test.mjs` pins this).

## The contract (before any edit)

1. **Home first** — place the rule with the table above; if no home fits, the rule is not durable enough to write down.
2. **Nothing lost** — diff the old text's REQUIREMENTS against the new: every imperative, threshold, and exception either survives or has a named successor.
3. **Test the edges** — write the trigger case, the no-trigger case, and the exception. Structural cases go in `tests/eval/`; semantic cases are documented in the artifact.
4. **Budget** — the main artifact pays context every session; depth moves to `references/` behind a Routing table. Passing every check still does not GUARANTEE an agent obeys — say so, and keep enforcement deterministic (hooks, gates) where it matters.

## Routing

| Action / trigger | Reference |
|---|---|
| Writing or editing AGENTS.md or a shared instruction | [references/agents-md-doctrine.md](references/agents-md-doctrine.md) |
| Writing or editing a SKILL.md or skill package | [references/skill-doctrine.md](references/skill-doctrine.md) |
| Deciding how a rule is tested (trigger / no-trigger / exception) | [references/eval-doctrine.md](references/eval-doctrine.md) |

A missing reference interrupts the action — read nothing in its place, never improvise from memory.

## Rules

- Generated regions (`pantheon:generated`) are machine-written: change the generator, never the output.
- Existing conventions of the codebase outrank personal preference — a rule that fights the grain gets rejected, not encoded.
- Frontmatter contracts are enforced by tests (`tests/agent-skills-contract.test.mjs`); never add unlisted keys.
- An instruction that says "always" but has a known exception must state the exception or it is a defect, not a style choice.
- Route friction capture through `reflect` (it decides an artifact is warranted); this skill executes the writing.
