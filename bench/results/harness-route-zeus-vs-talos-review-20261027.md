# Route comparison review: Zeus versus direct Talos

**Task:** create a Markdown table of the three most populous countries.
**Protocol:** five interleaved pairs, OpenCode 2.2.0, `openai/gpt-6-luna`, same
task, profile, plugin, and repository revision. The raw record is
[`harness-route-zeus-vs-talos-20261027.json`](harness-route-zeus-vs-talos-20261027.json).

## Result after checking deliverables

The runner's original acceptance criteria checked process completion, agent
identity, and instruction provenance, but did not verify the requested file.
The first Zeus control exited successfully after 846.5 s and created no
`bench-run-B.md`. The other four Zeus controls and all five direct Talos runs
created a population table with the three expected countries. The raw runner
therefore over-counted task success as 5/5 for Zeus; the task-artifact oracle
reduces it to **4/5 Zeus and 5/5 Talos**.

The four pairs with valid artifacts in both arms had these descriptive timing
medians:

| Arm | Valid artifacts | Median wall time | p80 wall time | First-request context median | Child/subagent calls |
|---|---:|---:|---:|---:|---:|
| Zeus → specialists | 4/5 | 23.7 s | 31.3 s | 11,151 tokens | 9 subagent calls across 5 runs |
| Talos direct | 5/5 | 9.2 s | 10.6 s | 7,525 tokens | 0 across 5 runs |

These are results for a **single small, one-file task**. They support routing a
bounded deliverable to its final specialist once, allowing that specialist to
gather needed facts. They do not justify removing Zeus from multi-step work or
claiming that ACP is faster than CLI. The 846.5 s Zeus run remains recorded as
a failed task outcome, not a speed sample.

## Changes made from this finding

- Paired Scenario B now requires the expected population-table artifact before
  a run can enter performance summaries. Custom prompts without an oracle are
  reported as unavailable.
- Zeus guidance now says to send a bounded deliverable once to its final
  specialist and call Apollo separately only when research is itself the
  deliverable or blocks choosing the specialist.

The guidance change has a focused contract test. Its latency effect has not yet
been measured. The route evidence above predates that wording change; do not
attribute these measurements to the new instruction.
