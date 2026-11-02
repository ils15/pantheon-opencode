# Skill provenance search with Jev — investigation

**Status: design only. Deliberately unwired.** This document specifies what a
skill-discovery layer would be, what Jev's role in it is (and is not), and the
consent surface it requires. Nothing here is implemented; wiring it needs its
own review, exactly like the native Decisions tool did.

## The problem

An agent that needs a capability has three disjoint sources today: the
Pantheon catalog (fixed), the skills installed in the host (visible via
`ctx.skill.list()`), and the open ecosystem (skills.sh and arbitrary repos),
which is reachable only by a human running `npx skills find`. Nothing tells the
agent what exists, where a candidate came from, or whether it was reviewed.

## Design shape

A `pantheon_skill_search` advisory tool (Zeus-first, same caller-matrix rule
as `pantheon_jev_decide`) over THREE tiers, each answer carrying PROVENANCE:

| Tier | Source | Provenance fields | Network |
| --- | --- | --- | --- |
| 1. Installed | `ctx.skill.list()` | skill id, install path, host | none |
| 2. Registry | a Pantheon-approved registry (e.g. `ils15/pantheon-skills`) | repo@commit, reviewed-by, date | git fetch, opt-in flag |
| 3. Ecosystem | skills.sh / `npx skills find` output | repo, stars/metadata, UNREVIEWED flag | networked, separate explicit consent |

Jev's role is deliberately narrow: given the task state and a bounded candidate
list WITH provenance attached, a typed `choice` question picks which candidate
merits loading — the same stack-the-skills decision the preset makes today,
extended with the provenance tier as a visible field. Jev NEVER fetches,
evaluates code, or vouches for trust; a rank from tier 3 is always labeled
UNREVIEWED in the answer.

## Why Jev and not a bigger model

Ranking a short annotated candidate list is exactly the System One shape: one
typed call, ~150 ms class, no open-ended generation. The expensive part —
reading a SKILL.md and judging quality — stays a human/dispatched-agent task.

## Consent surface (the reason this is unwired)

Tier 2/3 create a NEW egress class: networked queries with attacker-influenced
content (registry metadata, ecosystem listings). Wiring requires: an explicit
`skill.search.egress` permission action (same kill-switch pattern as
`decision.egress`), a per-tier consent flag in the decision-router config, a
payload policy (query text only — no task content, no code), a result-size
bound, and the Themis review the native tool went through. Tier 1 alone needs
none of that and could ship as a pure local ranking — the recommended first
step if this is built.

## Provenance schema (proposal)

```json
{
  "id": "docker-build-strategies",
  "tier": "ecosystem",
  "origin": { "repo": "docker/skills", "commit": "abc1234", "path": "..." },
  "reviewed": { "by": "human|agent", "date": "2026-11-02", "verdict": "approved|quarantine" },
  "installedAt": "2026-11-02T09:00:00Z"
}
```

The registry repo is where review verdicts live; installs copy the verdict
forward. An UNREVIEWED ecosystem skill is decidable but labeled — the user
decides whether to install, which is the trust boundary that stays outside
the model.
