# WS3 Token-Opt Measurements (PR #94)

Reproducible per-class comparison of compact JSON vs TOON encoding for the
payloads the codec serves (board signals, checkpoints, KV payloads).
Deterministic: no LLM, no external gateway, fixed `ceil(chars / 4)` token
basis — the same metering used by `src/pantheon/token-opt.ts`.

## Per-class table

| class | json_chars | toon_chars | saved_pct | json_tokens | toon_tokens | token_saved_pct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| board-signal | 161 | 143 | 11.18% | 41 | 36 | 12.2% |
| checkpoint | 804 | 577 | 28.23% | 201 | 145 | 27.86% |
| kv-list | 233 | 156 | 33.05% | 59 | 39 | 33.9% |
| large-tabular-checkpoint | 4170 | 2123 | 49.09% | 1043 | 531 | 49.09% |

Reading: savings are **per payload class** — ~11% on content-dominated
board records (the real floor: TOON wins on structure only) up to ~49% on
large tabular checkpoints (50x jobs + 20x todos; the ~47% cited in code
comments is the same regime at a slightly smaller fixture). The
`checkpoint` (28%) and `kv-list` (33%) rows are the representative
mid-range. Token columns suffer ceiling bias on tiny payloads
(`ceil` rounds 161→41 vs 143→36), so the char columns are the honest
basis and the token columns show what metering debits.

## Methodology

- **JSON basis:** `JSON.stringify(value)` (compact, no spaces) in TS;
  `json.dumps(value, separators=(",", ":"))` in Python — byte-equivalent.
- **TOON basis:** `toonEncode(value)` from `src/pantheon/toon-codec.ts`
  (mirrored byte-for-byte by `src/mcp/toon_codec.py` on the supported
  subset; cross-parity pinned by `tests/fixtures/toon-parity.json`).
- **Tokens:** `ceil(chars / 4)` (`CHARS_PER_TOKEN = 4`), `0` for empty.
  Reported both so the ceiling effect is visible.
- **Fixtures:** `board-signal` (flat minimal record), `checkpoint` (WS2
  shape: phase + tail + 5 jobs + 4 todos + nesting), `kv-list` (3 uniform
  rows), `large-tabular-checkpoint` (50 jobs + 20 todos).
- **Overhead:** TOON replaces bytes in place — `EMPTY_OVERHEAD` (zero).
  Every other lever debits its TOTAL overhead via `measureLeverFull`
  (retrieval + discovery + detail-on-demand + markers); a lever with
  `net <= 0` is DISABLED by flag via `applyGate()` (never removed).

## Regeneration

```bash
npx tsx scripts/ws3-measure-toon.ts
```

Output is the markdown table above. Python cross-check:

```bash
python3 -m pytest tests/test_toon_codec.py -q
npx tsx tests/pantheon/toon-codec.test.ts
npx tsx tests/pantheon/token-opt.test.ts
```
