# F1 evidence — interleaved v2.0.29 double-injection run

**Date:** 2026-10-14 · **Runtime:** OpenCode v2.0.29 · **Plugin:** repo V2
**Model:** `opencode-go/glm-5.3-flash` · **Scenario:** B · **Runs:** N=5 per arm
**Profile:** `double-injection` · **Schedule:** C1/K1, C2/K2, C3/K3, C4/K4, C5/K5
**Source commit:** `fb8585a8c9316ba1c50914599a3cd30d40bf0e37` · **HEAD tree:** `7033f34f43c0c90cdcf6c475c5a67b0860671b62`

Each invocation ran `--runs 1`; control and candidate were alternated, never overlapped, and no
source/config edits occurred during the sequence. Each result records `gitDirty=false`, short SHA
`fb8585a`, OpenCode v2.0.29, plugin generation V2, and the same plugin reference. The full clean
commit/tree identity substitutes a separate plugin-file digest: it identifies every tracked source
file used by the plugin. The run order is confirmed by timestamps in the JSON artifacts.

## Config and source fingerprints

Only hashes are published; no config content or credential values are included.

| Input | SHA-256 | Stability |
|---|---|---|
| Host `opencode.json` after sensitive-key/value redaction | `d31f2344363019b86128f8a5b800b8a74f5cad6c660fd65d56058f6a20d3e567` | same before and after |
| Shared config inputs (`agents`, `instructions`, `commands`, `skills`, `prompts`, `routing.yml`, `skills-lock.json`; excludes `AGENTS.md`) | `fe88dfa4a72ad24facf1ca849e2dfce028eaecafe006df83883fd6b0067213ee` | same before and after |
| Effective shadow `opencode.json` | `806200e34a3267626f375e833378c1ad76784e80e84eb2d97fe8b8058b24a23b` | identical in all 10 invocations |
| Source commit/tree | `fb8585a8c9316ba1c50914599a3cd30d40bf0e37` / `7033f34f43c0c90cdcf6c475c5a67b0860671b62` | identical in all 10 invocations; clean |

## D4 fidelity

All 10 runs report exactly two expected instruction files, including their path, byte length, and
SHA-256 from the runtime ledger:

| Arm | Global | Project | Total loaded |
|---|---:|---:|---:|
| Control | 11,175 B, SHA `425b7338…cb95ab1e` | 11,175 B, same SHA | **22,350 B** |
| Candidate | 11,410 B, SHA `797fb47e…d5753eb3` | 1,990 B, SHA `199ae561…b37c6b0` | **13,400 B** |

The carve removes 8,950 B (−40.0%) from the loaded payload. All roots were Zeus, all 10 runs
completed, and every run had one child.

## Correctness oracle

The oracle was pre-registered in
[`f1-di-v229-interleaved-oracle-2026-10-14.md`](./f1-di-v229-interleaved-oracle-2026-10-14.md).
It accepts the Portuguese abbreviation **EUA** as United States. The following values are
normalized to millions; every row is in India, China, United States order and within ±2% of the
UN WPP 2024 reference. Each run has only `bench-run-B.md` as a task artifact; `AGENTS.md` and
`.pantheon/logs/hooks.log` are harness artifacts excluded by the oracle.

| Pair / arm | India / China / US (millions) | Task artifact SHA-256 | Oracle |
|---|---:|---|---|
| 1 Control | 1,460 / 1,410 / 342 | `7056a984f3ddba1369ccf621e2a1e3bae2cf66e54f11580ca15f3df8ae262b50` | pass |
| 1 Candidate | 1,476.626 / 1,412.914 / 349.035 | `da31a344897b8337635479139dbecfc1e9e2041be936f25e2230fba135a42ef8` | pass |
| 2 Control | 1,464 / 1,411 / 342 | `3a5c9c557f1541f9b126067e6db7487cf04408757cce70c74004cca4598bf26e` | pass |
| 2 Candidate | 1,460 / 1,420 / 342 | `ea0b67ae606a26452ee152fbc02606617af6b37fbc9f0fd12bd0e8c5559e5300` | pass |
| 3 Control | 1,450 / 1,420 / 341 | `de47f4b70c30ef44f02d822e516e23ba7cdd5eced59ca02eb38aab79afb16267` | pass |
| 3 Candidate | 1,440 / 1,420 / 340 | `ef38ea717b95776ab99bfcdea82973e994904f154e0072ebcceaf5f261529844` | pass |
| 4 Control | 1,440 / 1,420 / 341 | `f6f623b92df6d29ad48adc4644b5db9e27bfd99c364f49c3a68691ace1c7eb9f` | pass |
| 4 Candidate | 1,476.626 / 1,412.914 / 349.035 | `b25b90ca1304500414b1c47c85bce2fd0852cc8a5b701e459047724e8e0950a2` | pass |
| 5 Control | 1,450 / 1,410 / 342 | `e7053c2c3d0fca3e1c2622120fb0f26884915c1329b313250d8089cdfacabf7b` | pass |
| 5 Candidate | 1,476.626 / 1,412.914 / 349.035 | `dfc3083bc8ebf4650b4fdadac67f108092717dd498fa0b5efe9e22d9803b2ad9` | pass |

**Correctness: 5/5 in both arms.** No runs were replaced.

## Results

| Metric | Control | Candidate | Difference | Classification |
|---|---:|---:|---:|---|
| First-request context (`input` + `cache.read`) | median 17,555; range 17,555–17,569 | median 15,489; range 15,489–15,503 | **−2,066 (−11.8%)** | **confirmed**; effect exceeds within-arm spread (14 tokens in each arm) |
| Tree-total input | median 47,594; range 30,502–59,814 | median 38,253; range 26,348–66,574 | −9,341 (−19.6%) | **inconclusive**; ranges overlap and spread exceeds median shift |
| Wall time | median 30.078 s; range 9.179–58.129 s | median 24.130 s; range 10.673–32.762 s | −5.948 s (−19.8%) | **inconclusive**; shift is much smaller than same-day spread |

The inherited ≤30k tree-input hypothesis is **not met**: candidate median is 38,253 tokens. Monetary
cost remains unavailable; cache pricing semantics were not measured. No wall-time gain is claimed.

## Per-run artifacts

The ten JSON records are named
`f1-di-v229-interleaved-{control|candidate}-0N-fb8585a.json`. They are kept individually so the
alternation, D4 records, run metadata, and failure state remain inspectable.
