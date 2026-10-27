# Harness optimization baseline: Vasco site task

**Status:** exploratory historical baseline, one task per route (`n=1`). These
records identify measurement gaps; they do not establish a performance winner.

## Data sources and setup

- OpenCode V2 2.2.0, `openai/gpt-6-luna`, xhigh effort.
- CLI session ledger read from the local OpenCode database in read-only mode;
  ACP timing and MCP counts from the run metadata recorded for the task.
- The CLI task used a Zeus session with Aphrodite implementation and Themis
  review. ACP ran Aphrodite directly. Both produced a Vasco site, but the
  routes and completion criteria differed.

## Observations

| Route / measurement | Elapsed | Calls and outcomes |
|---|---:|---|
| CLI root session, including Zeus and Themis | 3,484.2 s | 20 shell, 19 read, 5 patch, 2 execute, 2 subagent calls |
| CLI Aphrodite implementation child | 302.5 s | 17 shell, 5 patch, 2 execute |
| ACP active time recorded by `ACP_RUN.json` | 311.6 s | 6 shell, 6 patch, 3 read, 4 execute; 5 browser searches |
| ACP database create-to-update span | 480.3 s | Same session ID; this interval does not match the active-time total above |

The four CLI shell calls containing `npm test` took 0.828 s, 1.144 s, 1.603 s,
and 1.639 s. Their combined command time was about 5.2 s; two commands also ran
the build, so this is an upper bound for the tests alone. The first test call
exited 1 and the next three exited 0. The task had one Vitest test.

ACP installed dependencies in 10.27 s. Its first build failed on a missing Vite
CSS declaration and the repair build passed. It ran no tests. The ACP metadata
reports 50,335 input tokens, 9,102 output tokens, 3,218 reasoning tokens, and
671,488 cached-read tokens. The direct Aphrodite CLI child reports 54,138 input,
15,318 output, 5,572 reasoning, and 483,456 cached-read tokens in the local
ledger. Token accounting is not used to infer elapsed time.

Neither route recorded a `pantheon-memory` or persistence MCP call. The ACP run
used browser search and Code Mode. The available record does not establish
whether compaction pruned useful context.

The retrospective tool telemetry found two CLI `subagent` calls with observed
durations of 216.3 s and 302.6 s, plus one `question` call at 114.4 s. These
durations include the host-visible call interval and may include waiting or
child work; they are not isolated harness overhead. The four ACP Code Mode
`execute` calls had a median duration of 5.26 s (p80 5.73 s); all five nested
browser-search calls completed. The CLI route had one failed nested
`playwright.browser_navigate` call. Its error detail was not retained in the
safe aggregate.

Across the CLI root and children, shell tool duration was 62 ms median / 1.10 s
p80 over 20 calls, with one failed call. The ACP route's five nested browser
search calls and one nested Code Mode `search` call all completed. These numbers
come from the host's tool-part timestamps; nested MCP calls do not expose
individual durations in the stored record.

## Interpretation and decisions

1. Repeated full-suite calls are a real policy smell, but their observed cost
   was roughly 1.7% of the CLI Aphrodite child duration at most. Removing them
   cannot explain or resolve most of the task's elapsed time.
2. The direct Aphrodite spans (302.5 s CLI and 311.6 s ACP metadata) differ by
   only 9.1 s, but this is a single unpaired task. ACP's 480.3 s database span
   also conflicts with its active-time record. No ACP-versus-CLI speed claim is
   supported until the timing definitions are reconciled and runs are paired.
3. The immediate code changes therefore align test instructions and extend the
   read-only collector with per-tool outcome, duration, text-output byte, and
   nested MCP/tool counts. The collector omits tool inputs and output content.
   A long `subagent` or `question` duration remains ambiguous until the host
   time is separated into model work, child execution, and time waiting for a
   user response.
4. Existing prompt-diet runs also caution against treating context reduction as
   a speed result: F5 reduced first-request context by 10.36% while its wall
   median moved from 83.3 s to 105.0 s; Beta10 reduced context by 25.6% while
   wall median changed by only about 0.8%. Those results do not justify broad
   prompt removal for latency.
5. The existing Beta10 paired run completed its bounded task in 5/5 direct
   Talos runs with no child or subagent calls, and reduced first-request context
   against Zeus. Its wall-time result was inconclusive, and that small task does
   not justify removing Zeus from larger workflows.
6. Memory relevance and compaction quality remain unmeasured. Keep ambient
   memory injection off and preserve current persistence and pruning behavior
   until a controlled task shows a benefit and checks retained information.

The follow-up five-pair route experiment found one Zeus run that exited 0 but
did not create its requested artifact. The corrected post-hoc quality and route
analysis is in
[`harness-route-zeus-vs-talos-review-20261027.md`](harness-route-zeus-vs-talos-review-20261027.md).

## Next measurement

Use the existing paired benchmark runner for an interleaved sample with fixed
model, task, route, and host configuration. Run at least five pairs for each
single factor; increase the count if dispersion is large. Record completion
quality and failures alongside wall time, tokens, tool timings, MCP/tool status,
and output bytes. Review memory usefulness on a small, privacy-safe labeled
sample; aggregate counts alone cannot establish relevance.
