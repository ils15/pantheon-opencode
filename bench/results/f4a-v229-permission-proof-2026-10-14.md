# F4A / W1 permission proof — OpenCode v2.0.29

Date: 2026-10-14
Branch: `perf/beta10-latency`
Reproduction: `bash tests/canary/run-v2-permission-proof.sh`

The script requires the isolated `~/pantheon-sandbox` OpenCode v2.0.29 binary
and Bubblewrap. It creates temporary managed-policy fixtures under `/tmp`,
uses user/PID/network and mount namespaces, and removes the fixtures on exit.
It does not write the global OpenCode configuration or install.

## Results

| Invocation | Result | Evidence |
|---|---:|---|
| Managed `shell:* deny` over project `shell:* allow` | 15 passed, 0 failed, 2 opt-in tests skipped | `ctx.permission.assert` from a real tool was rejected by the managed policy. |
| Project allow plus F4A probes | 17 passed, 0 failed, 0 skipped | Athena→Demeter was denied; the identity-gap probe for Zeus→Apollo was also denied. |

The invalid Athena→Demeter dispatch produced one matching
`permission.evaluate` event: caller field `athena`, root session ID,
`effectBefore=allow`, `effectAfter=deny`, and a Pantheon denial message. After
the call, the API listed only the root session and the mock provider had served
the expected 12 model requests for the six scripted prompts. This proves the
observed outcome and absence of a persisted child/extra model request; it does
not establish event-to-spawn timing.

The Zeus→Apollo case is a matrix-allowed edge, included as a positive control.
The `permission_probe` tool saw `ctx.session.get()` return the correct root ID,
but that session object had neither `agent` nor `parentID`. The later native
`subagent(agent="apollo")` event carried `agent="zeus"` and the root session
ID, but the plugin does not treat that event field as authoritative: the host's
`ctx.permission.assert` accepts a caller-supplied optional agent, and the
available runtime evidence does not distinguish host identity from that input.
The `session.hook("prompt")` event did fire for the root session, but its
payload also omitted both `agent` and `parentID`. The current guard therefore
fails closed, denied Apollo, persisted no child, and made no extra model
request. This is a runtime identity gap, not proof that the valid matrix edge
can be admitted. The v2.0.29 [permission implementation](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/permission.ts)
declares `AssertInput.agent` optional and passes that input into permission
evaluation, which is why the event field cannot be treated as authenticated
identity by itself.

## Gate disposition

W1's top-level project allow and managed-policy precedence remain confirmed
through a tool-origin `ctx.permission.assert` request. F4A is **deferred**:
the canary does not prove trusted caller identity, root/freshness, or
event-to-spawn ordering. Keep the fail-closed production behavior. Do not use
`event.agent` as an identity fallback without a new security review, and do
not begin dependent F3a/F3b implementation until their plan gates are resolved.

The OpenCode v2.0.29 host capabilities remain host-owned: native automatic
response continuation and top-level `policies` do not justify a Pantheon retry
loop or a second policy engine. The observed permission API is a probe result;
this report does not claim a dependency or production API migration.
