# F4A V2 admission identity and lifecycle proof — 2026-10-14

## Result

F4A is implemented on `perf/beta10-latency` and passed its v2.0.29 runtime
canary. The decision stays fail-closed unless the host's `tool.execute.before`
event and `permission.evaluate` event carry the same session, message and tool
call IDs, and the authoritative session lookup confirms a root session.

The canary used the installed OpenCode **v2.0.29** binary from
`~/pantheon-sandbox/`, the real `src/plugin-v2.ts`, a local deterministic mock
model, a temporary project/config/database and Bubblewrap user/PID/network/mount
namespaces. It did not read or write the development OpenCode config, stop an
existing service or contact a model provider.

## Runtime results

`bash tests/canary/run-v2-permission-proof.sh` completed:

- Managed `shell:* deny` over conflicting project allow: **15 passed, 0 failed,
  3 opt-in F4A checks skipped**.
- Project allow with F4A probes: **18 passed, 0 failed, 0 skipped**.

The 18-check run proves:

1. Athena→Demeter is denied despite project allow. Its matching permission event
  changes `allow` to `deny`; the native tool returns an error, the root is the
  only persisted session, and the mock-model request count stays at 12.
2. Zeus→Apollo is admitted. `tool.execute.before` and `permission.evaluate`
  share the host session ID, message ID and tool-call ID; both report caller
  `zeus` and target `apollo`. The root returned by `ctx.session.get()` omits
  `agent` and `parentID`, but its ID matches the host tool event and the canary
  created it as a root through the server API.
3. The observed `permission.evaluate` record precedes the `session.created`
  record for the new Apollo child. The latter contains its own ID, the root
  `parentID` and agent `apollo`.
4. A second canary creates an Athena child, then attempts the matrix-valid
  Athena→Apollo edge from that child. The permission event's session lookup
  carries the root `parentID`; Pantheon denies the call and no grandchild is
  persisted. The fixture raises `experimental.subagent_depth` to 2 only so the
  native host reaches Pantheon's child-session gate.

## Source and trust boundary

OpenCode v2.0.29 emits `tool.execute.before` with `tool`, `sessionID`, `agent`,
`messageID`, `id` and the native tool input in its internal tool context
([pinned tool source](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/tool.ts#L1027-L1042)).
The native subagent tool calls `permission.assert` with the target agent, caller
agent and source `{type: "tool", messageID, id}` before calling
`sessions.create({parentID, agent, ...})`
([pinned subagent source](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/tool/plugin/subagent.ts#L1062-L1085),
[child creation](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/tool/plugin/subagent.ts#L1148-L1164)).
`Session.Info.parentID` is optional, and the v2.0.29 row mapper turns a null
parent ID into `undefined`; for a session returned by the host API, that
represents a root ([session schema](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/schema/src/session.ts#L369-L386),
[row mapping](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/session/info.ts#L347-L372)).

Pantheon stores only a bounded, short-lived origin keyed by the three host
identifiers. The permission hook consumes it once, checks the source type,
action and exact target, compares any event agent against the captured caller,
then enforces the matrix and root check. An absent, stale, replayed or mismatched
origin denies. `execute.after` clears any origin left by a tool path that never
reached permission evaluation. Native-only permission requests still pass to
OpenCode unchanged, and an explicit host deny remains final.

## Reproduction

```bash
bash tests/canary/run-v2-permission-proof.sh
```

This phase proves admission identity, root/child handling and ordering on
v2.0.29. It does not establish a latency improvement; those claims require the
same-day benchmark protocol in the active plan.
