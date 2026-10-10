---
name: context-compression
description: "Use only for an explicit request to compact or preserve context; prefer native OpenCode compaction and minimal resumable checkpoints."
context: fork
globs: ["**/01-active-context.md", "**/02-progress-log.md"]
alwaysApply: false
---

# Context and Checkpoint Guidance

This skill is loaded on demand. It does not create an automatic compression, memory, or checkpoint workflow.

## Native compaction

- Let OpenCode handle context pressure with its native compaction.
- Do not call an inline compressor, score summaries, build cross-reference indexes, or copy every phase into the Memory Bank.
- Do not trigger extra MCP calls when a phase ends, a subtask returns, or a delegation starts.
- OpenCode V2 uses the session model for summary-based compaction; it has no native `small_model` setting. Do not tune `keep.tokens` or provider compaction without measuring quality and token use on the installed host.

## Resumable checkpoints

Create a persistence checkpoint only when the user asks to preserve progress or an authorized task is expected to span sessions and lose state otherwise. Use `context_save` for one concise checkpoint and `context_get` when resuming. Do not read after writing just to confirm a successful save; report the save result returned by the tool.

Keep only information needed to continue safely:

- objective and current phase;
- completed work and the next concrete step;
- decisions, blockers, and verification status;
- external actions whose outcomes remain uncertain, with an explicit instruction not to repeat them until verified.

Never checkpoint secrets, full transcripts, routine tool logs, or speculative results. Preserve the exact session identifier required by the persistence server. If the save fails or the tool is unavailable, say so and keep the handoff in the conversation.

## Explicit memory work

Use the Memory Bank only when the user explicitly asks for an artifact, a durable decision, or a sprint close. Keep a record concise and reusable. Do not index routine summaries, delegated findings, or completed phases automatically. Follow `memory-bank` for file locations and `artifact-management` for requested project artifacts.

## Compact handoff format

When asked to shorten a handoff, preserve facts in this order:

1. Goal and scope.
2. Confirmed results and exact verification.
3. Decisions and constraints.
4. Blockers and unresolved outcomes.
5. Next action.

Drop repeated narration and superseded attempts. Do not turn an unknown outcome into a success or failure claim.
