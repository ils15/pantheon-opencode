> Internal engineering record — not user guidance.

# Validation and Benchmark Evidence

This page records sandbox validation and benchmark evidence. It is not part of
the user documentation and is not in the site navigation.

## Sandbox validation (V2)

`scripts/test-opencode-v2-sandbox.sh` validates the globally installed package
as a real user inside an isolated sandbox (own `HOME`, npm prefix, and venv) —
never the development environment. It checks the OpenCode V2 leg: the binary,
MCP connectivity, `doctor`, and — with `--prompts` — a prompt battery covering
the `pantheon://agents` resource, memory store/recall, filesystem writes, and
agent delegation. The gate is fail-closed: every required check must return an
explicit PASS; timeouts, auth/network/provider failures, and missing
prerequisites block the run.

The runner defaults to the current stable `@opencode/cli` package and its
`opencode2` alias; set `OPENCODE_V2_SPEC` only when a test needs a different
host build. This keeps Pantheon beta testing separate from the OpenCode CLI
release channel.

"V2" here names the host generation, not a measured guarantee. See
[Compatibility](../COMPATIBILITY.md) for which hosts are supported and on what
evidence. The project is V2-exclusive, so there is a single leg.

```bash
scripts/test-opencode-v2-sandbox.sh --prepare     # tarball + install + init in the sandbox
~/pantheon-sandbox/start-pantheon.sh              # interactive TUI in that isolated beta sandbox
scripts/test-opencode-v2-sandbox.sh --run v2      # base validation only
scripts/test-opencode-v2-sandbox.sh --prompts     # base validation + prompt battery
scripts/test-opencode-v2-sandbox.sh --hooks       # V2 hook callback canary
scripts/test-opencode-v2-sandbox.sh --reset       # wipe the sandbox root
```

Modes are combinable (for example `--prepare --run v2 --prompts`). `--hooks`
runs a V2 hook canary against the sandbox binary to check that hook callbacks
fire; it does not test transform callback effects or prove Pantheon's
`execute.before` security enforcement. These are test/sandbox canaries, not
proof of Pantheon security enforcement.

Binaries are resolved strictly inside the sandbox npm prefix — a non-prepared
sandbox fails fast instead of silently testing the host installation. The
sandbox is always built from the checkout this script lives in; it never infers
a repository from a sibling directory.

This validates the prepared isolated sandbox only. A PASS is not proof of
support for every real host or for host configurations that were not exercised.

## Latency benchmark

`bench/` measures end-to-end session latency of the installed `opencode` CLI
with the repository's V2 plugin — the baseline every performance change in a
release must be compared against. It runs two scenarios N times each,
interleaved (non-interactive, one fresh sandbox directory per run), collects
per-run metrics from `opencode.db` in READ-ONLY mode (tokens root + child
sessions without double counting, tool calls per name, child-session count) and
hook timings from the `[bench]` lines the plugin appends to `hooks.log`:

```bash
node bench/bin/bench.mjs            # 5 runs per scenario (A and B), ~1h
BENCH_MODEL=opencode-go/glm-5.3-flash node bench/bin/bench.mjs   # pin a model
node bench/bin/bench.mjs --runs 1   # smoke: one run per scenario
```

Results land in `bench/results/<label>-<git-sha>.json` (median + p80 +
failures per scenario); the label defaults to `baseline` and the harness refuses
to overwrite an existing result, so the run identity lives in the file name.
Scenario A performs real web research, so its variance is network-dependent and
recorded per run.

`reportVersion` remains `3`; token usage fields are unchanged and
`tokens.sessionBreakdown` is an optional additive field. It belongs to the
benchmark report in the unpublished `bench/` harness, not to the shipped
`pantheon_cost` tool. That tool aggregates by agent and phase in V1; V2 reports
the phase as the literal `unknown`. When available, `sessionBreakdown` reports
input, output, and input+output total per unique session, plus root and
descendant subtotals. These are overlapping views of the aggregate, not extra
usage; no agent/call/section attribution is inferred. Incomplete token-field
coverage or a session without assistant usage makes the breakdown unavailable
without zero-fill. If token collection itself is unavailable, the optional key
may be absent; consumers should handle either case.

### Measurement profiles

Instructions are injected from two surfaces: the global config dir and the
project directory. The harness states which one it exercises, because a result
only means anything in the profile where the change acts:

| `--profile` | Global `AGENTS.md` | Project `AGENTS.md` | Use |
|---|---|---|---|
| `host` (default) | host config dir (or `--global-agents`) | none — run dirs stay empty | the host's real, unmodified injection |
| `double-injection` | host config dir (or `--global-agents`) | `--project-agents`, written into every run dir | the in-repo profile where global+project overlap |

The default measures scenarios A and B. Use `--scenarios B` to isolate the F1
one-shot claim; the selected scenario still runs N times (`--runs 5` by
default).

```bash
# candidate arm: the carved global artifact + the carved project artifact
node bench/bin/bench.mjs --runs 5 --scenarios B --profile double-injection \
  --global-agents AGENTS.global.md --project-agents AGENTS.md --label f1-candidate
```

Each arm records, per run and read from the database, the identity (path, bytes,
sha256) of every instruction file the session actually loaded
(`instruction_state` + `instruction_blob`) — the fidelity proof that what was
measured is what was generated. A claim may only rest on a run whose provenance
shows the intended global **and** project artifacts were loaded.

### Signal versus noise

Wall time is a lead, not a criterion: same-day spread reaches ~8× in scenario A
and ~13× in B. An effect is **confirmed** only when it exceeds the same-day
spread (or demands a larger N); otherwise it is recorded as **inconclusive**.
Prefer token medians, which are far more stable. Scenario A's wall is not a
claim metric — it performs real web research, so network variance dominates.

### First-request proxy and F1 evidence

The injected instruction payload only lands on the first request, so the
tree-total `tokens.input` (summed over every turn) is dominated by
session-length variance. Each run also records `firstRequest` — the first
assistant row's `tokens.input` + `tokens.cache.read` — the proxy that isolates
the payload.

An interleaved OpenCode v2.0.29 run (C1/K1…C5/K5, N=5/arm) measured
first-request context at 17555 tokens for control and 15489 for candidate
(**−2066, −11.8%**; within-arm spread 14 tokens in each arm). D4 confirmed
22350 B loaded for control and 13400 B for candidate (−8950 B, −40.0%); the
pre-registered correctness oracle passed 5/5 in both arms. Themis accepted F1
with **PASS_WITH_NOTES**. The first-request effect is confirmed against
within-arm spread. Tree-total input fell from a median 47594 to 38253 tokens,
but ranges overlap and the ≤30k hypothesis was not met. Wall medians were
30.078 s and 24.130 s, with high spread; tree-total input and wall remain
**inconclusive**. No wall-time or monetary-cost gain is claimed.

Details and per-run records:
[`f1-di-v229-interleaved-2026-10-14.md`](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/f1-di-v229-interleaved-2026-10-14.md).
The earlier sequential pair remains supporting-only in
[`f1-di-v229-clean-2026-10-14.md`](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/f1-di-v229-clean-2026-10-14.md).
Earlier exploratory runs are retained separately in
[`f1-double-injection.md`](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/f1-double-injection.md)
and
[`f1-di-v229-preliminary-2026-10-14.md`](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/f1-di-v229-preliminary-2026-10-14.md).

### Explicit root specialist result (F3a)

For the bounded one-shot scenario B, explicitly starting Talos as the root
produced the oracle-passing artifact in 5/5 runs with no child session or
`subagent` call. In the same-day paired sample, Talos used 16,171 median input
tokens per run versus 33,301 for Zeus (−51.4%); this is a descriptive result for
this task, model, and configuration, not a general routing or monetary savings
claim. Wall time is inconclusive: medians were 30.347 s and 31.893 s, the ranges
overlap widely, and Talos had the higher p80. No automatic LLM-selected root
routing is introduced by this result.

A final integration check after F4A/F3b initially completed 4/5 Talos artifacts.
Talos's prompt now says to finish named files with native `write`/`edit` tools
and not confuse MCP tool discovery with the host's native tool catalog. The
failure remains recorded in
[`beta10-final-integration-2026-10-15.md`](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/beta10-final-integration-2026-10-15.md).
A new pre-registered cohort on that prompt passed the artifact oracle in 5/5
Talos runs with zero children or `subagent` calls. Its first-request context
proxy was 9,675 tokens versus 13,009 for Zeus (−25.6%, confirmed against the
same-arm spread). Tree-total input is descriptive, and wall time remains
inconclusive. See the
[follow-up report](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/beta10-final-integration-followup-2026-10-15.md)
and
[raw run record](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/beta10-final-integration-followup-20261015.json).

The v2.0.29 harness requires explicit agent and fixture selection, and proves
global plus project instruction provenance for each run:

```bash
BENCH_MODEL=opencode-go/glm-5.3-flash node bench/bin/bench.mjs \
  --scenario B --runs 5 --profile double-injection \
  --global-agents AGENTS.global.md --project-agents AGENTS.md \
  --agents-dir src/agents --skills-dir src/skills \
  --root-agent talos --control-root-agent zeus --paired \
  --out bench/results/phase3-root-paired-20261014.json
```

Themis reviewed the harness and evidence (**PASS_WITH_NOTES**). Full method,
oracle audit, limitations, and per-run data are in
[`f3a-root-paired-2026-10-14.md`](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/f3a-root-paired-2026-10-14.md)
and
[`phase3-root-paired-20261014.json`](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/phase3-root-paired-20261014.json).

### Bounded workspace reads (F3b)

On OpenCode v2.0.29, the V2 plugin can expose `pantheon_bounded_read` when the
host provides its native permission and session APIs. Only a root Zeus session
can use it. Each call asks the host for `read` permission to one exact
workspace-relative file, with an empty save scope; content is read only after
approval and is scanned by the existing fail-closed secret scanner. Limits are
two calls and two distinct files, 400 lines and 32 KiB per assistant message.
Traversal, symlinks, directories, sensitive scopes, recognized binary/media
formats, and scanner failures are rejected. This is scoped to a local workspace
without concurrent writers; it does not claim adversarial filesystem isolation
or whole-file binary classification. The host-backed evidence is in
[`f3b-v229-bounded-read-2026-10-15.md`](https://github.com/ils15/pantheon-opencode/blob/main/bench/results/f3b-v229-bounded-read-2026-10-15.md).

## Plugin V2 TypeScript coverage

`npm run coverage:plugin-v2` runs the `tests/pantheon/*.test.ts` suite with
Node's source-mapped native coverage and enforces an 80% line-coverage minimum
for `src/plugin-v2.ts` only. It requires Node `>=26.4.0`; branch and function
coverage are reported but are not gates. This is not a repository-wide coverage
claim.

## Memory MCP source of truth

`src/mcp/memory_mcp.py` is the canonical Memory MCP server and exposes the six
`memory_*` tools plus three `code_*` codemap tools. `scripts/memory_mcp.py` is a
source-tree compatibility entrypoint that delegates to it. The runtime installer
copies the canonical source into the installed scripts directory, while
`install-mcp.mjs` prefers that installed copy and falls back to the source-tree
entrypoint when running from a checkout.

## TUI media gap

`docs/opencode-v2.md` reserves three media slots — the sidebar Dispatch block,
the `/dispatch` panel, and the plan-approval turn. **No image has been produced
for any of them.** The slots carry an explicit `illustrative, not a screenshot`
marker and an "Illustrative layout — not a screenshot" caption; the three tapes
under `docs/assets/tui/` are committed with an `UNVERIFIED` status header so the
capture can be completed on a machine with VHS.

Recorded on 2026-10-23 in the documentation environment (OpenCode `v2.1.2`).

### Blockers

1. **The recording toolchain is absent.** `npm run docs:media` checks for VHS
   and its dependencies before recording anything:

   ```console
   $ npm run docs:media
   docs:media: missing prerequisites: vhs, ttyd, ffmpeg

   VHS records the tapes; it drives ttyd and encodes with ffmpeg.
     - vhs: go install github.com/charmbracelet/vhs@latest
     - ttyd: build/install ttyd — https://github.com/tsl0922/ttyd#installation
     - ffmpeg: install ffmpeg (e.g. `apt install ffmpeg`)

   No capture was produced. docs/assets/tui is unchanged.
   ```

   Direct probes confirm the same, and `go` is not installed either:

   ```console
   $ vhs --version
   /bin/bash: line 1: vhs: command not found        # exit 127
   $ ttyd --version
   /bin/bash: line 1: ttyd: command not found       # exit 127
   $ ffmpeg --version
   /bin/bash: line 1: ffmpeg: command not found     # exit 127
   ```

   Installing them would change the developer environment, which the media task
   explicitly forbids. The Node floor is also unmet for a sandbox install
   (`node --version` → `v24.15.0`, `package.json` requires `>=26.4.0`).

2. **The required UI state is produced by a real model run.** The sidebar block
   renders only real children: `collectDispatch` reads host-cached
   `SessionInfo` (`cost`, `updatedAt`, `state`), so a capture with a live row and
   a finished roll-up needs a real fan-out. A staged or mocked session is
   prohibited, and the capture brief also requires no network calls in the
   recording path. Those two requirements cannot both hold for these three
   flows, so no honest recording exists offline.

3. **The TUI is not deterministically drivable from a tape.** Focus, panel
   routing, and the presence of a running child depend on host state; the
   spinner frame, duration, and cost are sampled at record time. Fixed sleeps
   reduce the variance but do not remove it, and a flaky capture was ruled out.

### Re-recording

On a machine with the prerequisites and a sandbox credential:

```bash
scripts/test-opencode-v2-sandbox.sh --prepare   # isolated HOME + install
npm run docs:media --check                       # all three binaries present
npm run docs:media                               # records every *.tape
```

The harness runs each tape with `vhs` from `docs/assets/tui/`, then fails if a
tape's declared `Output`/`Screenshot` file was not written. Replace each
`illustrative` fence with the real image and drop the `status: pending` line in
the same change; never commit media that does not correspond to a committed
tape.
