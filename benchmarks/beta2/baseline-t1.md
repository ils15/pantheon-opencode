# Pantheon T1 baseline

- Mode: `offline`
- Measurement source: `offline_static`
- Repetitions: `5`
- Frozen: `True` (`congela-pos-T1`)
- Snapshots: base `850191c` → head `18adb64`
- Snapshot head commit: `18adb64c05b42bcfe4f614dbcfa6ed127dc7678e` (2026-10-08T11:22:18-03:00)
- Generated: `2026-10-09`
- Command: `python3 -m benchmarks.beta2.t1 --repo . --output-json benchmarks/beta2/baseline-t1.json --output-markdown benchmarks/beta2/baseline-t1.md`
- Comparison gate: eligible `False` (offline static baseline — no live model measurement)
- Excluded metrics: currency, JEVS

## Parity (higher tokens/latency and lower quality are regressions)

| Block | Δ tokens % | Δ latency % | Δ quality pp | Verdict |
|---|---:|---:|---:|---|
| B1 | 0.5649 | n/a | 0 | within |
| B2 | 2.795 | n/a | 0 | within |
| B3 | 2.1856 | n/a | 0 | within |
| B4 | 3.6981 | n/a | 0 | within |
| B5 | 0.9732 | n/a | 0 | within |
| B6 | -31.0602 | n/a | 0 | within |

Overall: **within**

## Caveats (offline static)

- Numbers estimate canonical **source** size (`estimate_tokens`), not live model usage.
- Negative token delta (B6) is **source shrink**, not a model/token-cost saving.
- The comparison gate stays **ineligible** until a live run (`--mode live`) with a provider (`*_API_KEY`) measures real usage.
