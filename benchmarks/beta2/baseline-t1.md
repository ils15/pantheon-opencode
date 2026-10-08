# Pantheon T1 baseline

- Mode: `offline`
- Measurement source: `offline_static`
- Repetitions: `5`
- Frozen: `True` (`congela-pos-T1`)
- Snapshots: base `850191c` → head `dc9018d`
- Comparison gate: eligible `False` (offline static baseline — no live model measurement)
- Excluded metrics: currency, JEVS

## Parity (higher tokens/latency and lower quality are regressions)

| Block | Δ tokens % | Δ latency % | Δ quality pp | Verdict |
|---|---:|---:|---:|---|
| B1 | 0.5649 | n/a | 0 | within |
| B2 | 2.795 | n/a | 0 | within |
| B3 | 2.1856 | n/a | 0 | within |
| B4 | 3.6981 | n/a | 0 | within |
| B5 | 0 | n/a | 0 | within |
| B6 | -31.0602 | n/a | 0 | within |

Overall: **within**

## Caveats (offline static)

- Numbers estimate canonical **source** size (`estimate_tokens`), not live model usage.
- Negative token delta (B6) is **source shrink**, not a model/token-cost saving.
- The comparison gate stays **ineligible** until a live run (`--mode live`) with a provider (`*_API_KEY`) measures real usage.
