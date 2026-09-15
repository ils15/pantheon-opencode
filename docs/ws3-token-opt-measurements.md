# WS3 Token-Opt Measurements (PR #94)

Reproducible per-class comparison of compact JSON vs TOON encoding for the
payloads the codec serves (board signals, checkpoints, KV payloads).
Deterministic: no LLM, no external gateway, fixed `ceil(chars / 4)` token
basis — the same metering used by `src/pantheon/toon-codec.ts`.

> **Historical note:** an earlier revision documented a C9 context contract
> (`prepareC9Context` / `C9Chunk` / `c9Filter`, `PANTHEON_TOKEN_OPT`). That
> module was removed in the 1.5.0-beta2 agent-economy cleanup; this document
> now covers only the TOON payload measurements below.

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
- **Overhead:** TOON replaces bytes in place — zero added overhead.

## Regeneration

```bash
npx tsx scripts/ws3-measure-toon.ts
```

Output is the markdown table above. Python cross-check:

```bash
python3 -m pytest tests/test_toon_codec.py -q
npx tsx tests/pantheon/toon-codec.test.ts
```

## Beta2 agent economy policy

Beta2 keeps the agent runtime deliberately small and deterministic:

- Native `task()` delegation is mounted directly in the delegate manager; there is no adapter or kill-switch wrapper around the toolset.
- Compaction carry-forward uses a bounded checkpoint/tail and deterministic rehydration. It restores only verified state and does not silently resume child work.
- Token optimization applies TOON encoding, C9 filtering, pre-retrieval, and detail-on-demand only when the measured net saving clears the quality floor.
- Agent selection follows a diet: prefer the smallest capable specialist, keep read-only discovery separate from implementation, and escalate only when the scope or risk requires it.

These rules are operational guidance for the 1.5.0 beta2 review; they do not change the package version or publish a release.

## SDK tool-registration contract (beta2)

The current SDK V1/V2 contract is **eager**: V1 returns the complete `tool`
map during plugin setup, while V2 calls `ctx.tool.transform` and `draft.add`
for each definition during setup. Neither surface supports hiding individual
MCP schemas and invoking that MCP tool later without a dispatcher; a lazy
execute wrapper is not lazy schema registration. Therefore a real lazy tool
surface is classified **`NOT_SUPPORTED_BY_SDK`** and is outside beta2 scope.

Future work is either an upstream SDK capability for deferred MCP schemas and
invocation, or an explicit product decision to add a dispatcher (and its
runtime/adapter contract). Beta2 makes neither change; its token measurements
cover payload/context optimization only, not unimplemented lazy registration.
