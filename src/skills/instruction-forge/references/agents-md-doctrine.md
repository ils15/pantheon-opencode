# Agents.md Doctrine

The two artifacts are generated, disjunct, and budgeted. Every session pays
for global + project exactly once; overlap is a defect pinned by
`tests/eval/instruction-golden.test.mjs`.

## The managed region

- Sentinels: `<!-- pantheon:generated:begin -->` … `<!-- pantheon:generated:end -->`.
- Content between them is machine-written by `scripts/build-agents-md.mjs`
  (source of truth: project sections in that script + `src/instructions/`).
- To change generated content: edit the generator or the instruction files,
  then run `node scripts/build-agents-md.mjs`. The `--check` flag fails on a
  stale artifact — CI and doctor both run it.
- User content outside the region is preserved verbatim across regeneration
  (`writeAgentsMdManaged` carves by sentinel). The installer deliberately
  excludes AGENTS.md from the file inventory: a file carrying user content is
  never safe to claim or remove.

## Global vs project

- **Global artifact** (`AGENTS.global.md`, installed to the config dir as the
  user's AGENTS.md): agent table + shared instruction bodies
  (`agents: ["*"]`). Repo-agnostic — the same on every project.
- **Project artifact** (`AGENTS.md`): THIS repo's setup only — commands,
  layout, lint/test gates, conventions. It must not contain a rule a session
  could need on any other repo.
- A shared instruction is a file in `src/instructions/*.instructions.md` with
  `agents: ["*"]`. An agent-scoped one declares `agents: [<id>]` and rides
  that agent's prompt at build (`generateAgentPrompt`); it never rides
  another agent's.

## Writing rules that survive

- One imperative per line where possible; a threshold is a number, not "fast".
- State the trigger ("when X"), the action ("do Y"), and the exception
  ("unless Z") — an "always" with a known unstated exception is a defect.
- No narrative, no rationale paragraphs: the artifact pays per session, the
  rationale lives in docs/ or the commit that introduced the rule.
- Budget awareness: `logicalLineCount` and the carve tests bound the
  artifacts; if growth is needed, carve a new shared instruction instead of
  inflating a static section.
- Never restate what a hook or gate already enforces deterministically —
  point at it once. Enforcement lives in code; prose only explains.

## Testing

Structural golden cases run in `tests/eval/instruction-golden.test.mjs`
(carve, zero-overlap, scoped routing). When you change a shared instruction
or the generator, add the negative case you just protected against there.
