---
description: "Bounded retries and lightweight subtask routing for Zeus"
name: "Zeus Timeout & Retry"
agents: [zeus]
fallback: shared
---

# Bounded delegation

Use the native `task()` result as the source of truth. Do not simulate per-agent timers, poll without a known background task ID, or check for reusable sessions through APIs that are not available. `routing.yml` defines the concurrency limit, retry count, and canonical fallback chains.

For a transient dispatch failure (timeout, crash, or empty response), retry that agent once. If it fails again, follow its configured fallback chain left-to-right once; if none is configured or the chain is exhausted, report what failed and stop. Never retry a refusal, failed test, validation, or migration as though it were a dispatch error. Do not restart an exhausted chain.

Fallbacks for auth/security/data/schema work must preserve specialist competence, Themis review, and human approval. Full-auto does not bypass these gates.

## Lightweight subtask

For clear, bounded, reversible, low-risk work, dispatch directly to one specialist. Skip routine plan/artifact phases and discovery; ask the specialist to inspect only relevant context, make the change, run focused verification, and return `subtask_summary`. Add planning, artifacts, Themis review, or approval only when scope or risk requires them.
