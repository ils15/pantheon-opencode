# F5 — V2 prompt diet paired measurement

Measured 2026-10-15 on OpenCode v2.0.29, model
`opencode-go/glm-5.3-flash`, scenario B, commit `cca6180` (`gitDirty: false`).
The serial order was C1/K1 through C5/K5; no run was replaced. Raw records:
[`f5-prompt-diet-20261015.json`](./f5-prompt-diet-20261015.json); the
pre-registered oracle is
[`f5-prompt-diet-oracle-2026-10-15.md`](./f5-prompt-diet-oracle-2026-10-15.md).

## Fidelity and routing

- All 10 runs completed with Zeus as root and no root parent.
- D4 passed 10/10. Every run loaded exactly the same global fixture (11,410 B,
  SHA-256 `797fb47e…5753eb3`) and project fixture (1,990 B, SHA-256
  `199ae561…b37c6b0`).
- Each arm in each pair routed Zeus → Talos with one `subagent` call. The
  normalized route and call count matched for all five pairs.
- The control Zeus prompt was 29,477 B (SHA-256
  `11c79c4e…09d2c0b`); the candidate was 21,808 B (SHA-256
  `0ba6b120…8c20c8b`). All other fixtures were held constant.

## First-request context

The measured proxy is `tokens.input + tokens.cache.read` from the first
assistant request in the root session.

| Arm | Context median | Context range | Input median | Cache-read median |
|---|---:|---:|---:|---:|
| Control | 16,272 | 16,258–16,272 | 16,272 | 0 |
| Candidate | 14,565 | 14,565–14,579 | 14,565 | 0 |

The candidate median is 1,707 tokens (10.49%) lower. The shift exceeds the
larger within-arm range (14 tokens), so the primary metric signal is confirmed
under the pre-registered threshold and spread rule. One candidate run recorded
8,960 cache-read tokens and 5,605 input tokens; the proxy correctly counts
their sum as 14,565. The cache-read median is zero in both arms.

## Correctness and remaining gate

All 10 run directories contain one regular, non-symlink UTF-8 task artifact,
`bench-run-B.md`; no other task files were present. Candidate artifacts passed
the pre-registered country/order/value oracle in 5/5 runs. Four of five control
artifacts passed. Control run 7 reports the United States at 335 million,
2.90% below the 2024 UN reference of 345 million and outside the permitted
±2% range. No run was substituted or repaired.

**F5 acceptance is not met.** The context reduction and route-parity checks
passed, and the candidate showed no correctness failure, but the pre-registered
gate requires all ten artifacts to pass. The single control artifact failure
prevents an overall F5 claim. Any follow-up must be a new, separately identified
measurement; this report remains unchanged.

Wall medians were 18.609 s (control) and 31.660 s (candidate), with overlapping
same-day ranges; no wall-time improvement is claimed. Monetary cost is
unavailable because provider pricing and cache billing semantics were not
verified.
