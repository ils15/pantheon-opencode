# Memory and persistence MCP evaluation

**Date:** 2026-10-27
**Scope:** direct MCP stdio calls, agent grants/instructions, and V2 compaction wiring.

## Method and limits

Both servers ran as separate MCP stdio processes against a temporary
`PANTHEON_HOME` and temporary project database. The fixture used synthetic
strings only; the temporary databases were removed after the run. Timings are
client-observed MCP round trips on this host, not model time or the full
OpenCode service/agent dispatch path. The memory corpus was intentionally
small (11 entries), so these results do not predict latency at large database
sizes.

The first OpenCode V2 sandbox attempt used stale files and reported no
configured MCP servers from `mcp list`, despite five entries in the project
config. After resetting the isolated sandbox and installing a clean package,
OpenCode 2.2.0 connected all five servers, `doctor` exited 0, and
`pantheon://agents` exposed Zeus and Hermes. That host-level integration gate
is now verified; the timings below still come from direct MCP calls, not model
tool-selection or end-to-end task latency. Full evidence is in
[`opencode-memory-skills-audit-2026-10-27.md`](../../docs/internal/opencode-memory-skills-audit-2026-10-27.md).

The MCP client used Python 3.12.3, `mcp` 2.2.0, and FastMCP 4.1.2. Tool
initialization is reported separately because it is process startup cost, not
the cost of each warmed call.

## Results

| Server/tool | Samples | Median | p90 | Max |
|---|---:|---:|---:|---:|
| Memory server startup + MCP initialize | 1 | 1,284 ms | — | — |
| `memory_store` | 10 | 8.24 ms | 8.57 ms | 8.63 ms |
| `memory_search` | 12 | 1.38 ms | 1.43 ms | 1.48 ms |
| `memory_recall` | 12 | 1.20 ms | 1.45 ms | 2.17 ms |
| Persistence server startup + MCP initialize | 1 | 674 ms | — | — |
| `context_save` (small checkpoint) | 12 | 8.38 ms | 8.88 ms | 25.86 ms |
| `context_get` (small checkpoint) | 12 | 1.04 ms | 2.24 ms | 2.64 ms |
| `context_save` (8,321-byte checkpoint) | 1 | 7.79 ms | — | — |
| `context_get` (8,321-byte checkpoint) | 1 | 1.15 ms | — | — |

All store/save calls returned success. Exact recall and both checkpoint
round-trips returned the synthetic values unchanged. A query using words in
the fixture found it before and after ten unrelated entries were added. A
query using unrelated words returned no matches, as expected for the
documented FTS5/BM25 lexical search; memory has no semantic/vector fallback.

For this small local corpus, warmed tool calls are not a meaningful latency
source. Starting the two MCP processes costs roughly 0.7–1.3 seconds once;
the persistent OpenCode MCP host normally keeps them running. A model call,
serial delegation, or repeated tool round-trips can cost much more than the
SQLite operations measured here. The test does not measure those host/model
costs or infer a production p90.

## Agent decision policy found in the repository

| Situation | Current intended action | Owner/access |
|---|---|---|
| Self-contained question or bounded code change | Skip history search and checkpoints; carry the needed context in the session | Shared memory protocol; Zeus routes the task |
| Past project history could change the decision | One targeted lexical search (`top_k=2`); ignore weak hits and continue without a hit | Zeus has `memory_search`; several specialists have read-only memory search |
| Native context pressure | Let OpenCode run summary compaction; do not invoke an inline compressor or persist every phase | Host controls the trigger; agents have no Pantheon tool for forcing or querying a numeric threshold |
| Long multi-phase task that may lose state across sessions, or an explicit request to preserve progress | Save one concise checkpoint with an explicit session ID; retrieve it when resuming, not just to confirm a successful save | Zeus has `context_save` and `context_get`; the checkpoint store is temporary and TTL-bound |
| Explicit request to retain a reusable fact/decision across sessions | Store one concise durable entry; omit secrets and confirm the write | Mnemosyne has `memory_store`; Zeus does not have durable-write access |
| Routine phase result, child summary, test log, or speculative finding | Do not persist it | Shared memory protocol |

The written rules give agents a usable classification for these cases, and
the focused grant/prompt tests passed. They do **not** prove how a model will
choose in a live conversation: no model-backed scenario evaluation was run.
The isolated sandbox did not expose provider authentication, and I did not
reuse host credentials for an external model run.

## What compaction actually does

OpenCode owns when native summary compaction starts. The Pantheon hook runs
when that event arrives; it does not choose a context-window percentage or
request compaction itself. At that point, the plugin can prune duplicate tool
payloads and old failed-call arguments before OpenCode summarizes. The default
minimum estimated saving is 200 tokens and the default recent-turn window is
four turns. That pruning is structural; it is not a semantic summary and does
not turn the entire conversation into durable memory. The per-request pruning
hook is separately opt-in (`context_pruner.enabled`, default `false`).

The current compaction skill says to trust native OpenCode compaction, but it
does not give the agent a measurable early-warning signal. The agent therefore
knows the policy—keep working context in-session, checkpoint only for durable
resume, use durable memory only for a requested reusable fact—but cannot know
the exact moment the host will compact from Pantheon instructions alone.

## Verification

- `tests/test_memory_mcp_server.py`, `tests/test_memory_mcp_hygiene.py`,
  `tests/test_mcp_persistence_server.py`, and `tests/test_persistence_goals.py`:
  **206 passed**.
- Memory delegation prompt, agent MCP grants, generated agent contracts, and
  routing tests: passed.
- Context pruner: **30 passed**; compaction hook order: **4 passed**.

## Conclusion

Memory and persistence call latency is already low at this scale. The larger
risks are decision quality and payload shape: FTS search can miss synonyms,
saved values are returned as provided rather than semantically compressed,
and `memory_store` has no guaranteed secret redaction. The prompts mitigate
this by using narrow searches, concise checkpoints, explicit durable-write
gates, and no storage of secrets.

To prove that models follow those rules, the next evaluation should run a small
model-backed scenario set covering a one-off fix, a long task with context
pressure, a resume after a session boundary, an explicit durable-memory request,
and a secret-bearing fact that must not be stored. Record the tool calls and
expected decision for each case; first make the isolated sandbox provider
available without reusing the user's personal credentials.
