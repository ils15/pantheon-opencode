# Eval Doctrine — how a rule is tested

Instructions are code written in prose: they get trigger tests, no-trigger
tests, and exception tests. What they do NOT get is a guarantee — passing
every check proves the artifact says the right thing, never that an agent
will obey. Say so when reporting; keep real enforcement deterministic.

## The three cases (write all three)

1. **Trigger** — an input where the rule MUST change the behavior. Assert the
   visible effect (block emitted, section present, route chosen).
2. **No-trigger** — a near-miss where the rule MUST stay silent. This is the
   case authors forget; most instruction bugs are over-firing.
3. **Exception** — the stated "unless" of the rule, exercised end to end.
   An exception you cannot exercise is a rule you cannot enforce.

## Where the tests live

- **Structural (CI, deterministic)** — `tests/eval/*.test.mjs` over the real
  generators and artifacts: carve semantics, zero-overlap, scoped routing,
  budgets, lock integrity, reference graphs. Import the generator, call it,
  assert the output; a golden case is a diff you refuse, not a snapshot you
  bless.
- **Semantic (documented, not automated)** — for rules whose trigger is
  judgment ("proportional effort"), write the three cases as examples IN the
  artifact (wrong/right pairs beat paragraphs) and note the limits.
- **Model-in-the-loop (gated)** — routing/complexity scoring against held-out
  cases follows `docs/reference/offline-evaluation.md`: frozen rubric, slot
  labels, pre-registered acceptance. Never run it ad hoc.

## The honest disclaimer

A green eval suite means: the artifacts say what they must, the seams hold,
and the deterministic gates fire where designed. It does not measure
compliance. When a rule matters enough that non-compliance is expensive,
move it out of prose — hook, gate, permission, or the behaviors registry —
and test THAT.
