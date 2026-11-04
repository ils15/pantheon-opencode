# Field baseline — J1/J3/J4 shadow gates (2026-11-04)

**Source**: the j-telemetry mirror (`.pantheon/logs/j-telemetry.jsonl`),
collected on the user's host with the flags on during diagnostic windows.

## Collected records

- **J3 escalation**: 7 records, all `esc-cheap-c2` — the classifier judged
  real delegate dispatches cheap with complexity 2, recorded, applied
  nothing (shadow contract held: zero model changes in the field).
- **J4 review**: 7 records `q-7-review-yes` (review-mode probes) + skip
  records from the user's 7-call battery: `skip-usage-unreconciled`,
  `skip-criteria-invalid`, `skip-review-input-invalid` — the diagnostics
  fired exactly as designed against the stale-build inputs.
- **J1 risk gate**: 0 records — every battery tool call was read-scope
  (trivial echo), correctly skipped by the exfil-capable filter. Write-scope
  records accumulate in real usage with the flag on.

## What this proves

- The mirror captures sanitized tokens from REAL sessions (user's battery),
  end to end, with zero content leakage.
- The J3 classifier runs and judges in the field; the shadow contract
  (never applies) held.
- The J1 filter correctly scopes itself.

## Activation checklist (per the plan's gate)

1. Volume: collect the mirror through real usage until J1 write-scope and
   J3 dispatch records number 20+ each (clock-bounded, not count-forced).
2. Baseline scorecard from the mirror tokens (skip rates, complexity
   distribution).
3. Themis review of the activation change (shadow → enforce for J1;
   cheap-apply for J3) with this file as evidence.
4. Decision ratified by the session principal.
