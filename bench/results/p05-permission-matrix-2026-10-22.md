# P0-5 permission matrix evidence across installed hosts — 2026-10-22

## Result

P0-5 is measured on the Pantheon 1.6.0 line. The post-fix V2 matrix has **zero
`FAIL` cells** on five isolated hosts (`2.0.29`, `2.0.30`, `2.1.0`, `2.1.2`,
`2.1.3`). The only non-`PASS` cells are `C3`/`C4`/`C5`, which are recorded
observations by design, not assertions.

The V1 host (`1.19.4`) uses a different mechanism and is measured separately:
`permission.ask` never fires, the permission request goes to the client over the
HTTP API, and the read-only guarantee comes from config (`bash`/`write`/`edit`
denied, `read` allowed). Its V2 matrix row is not applicable.

All runs used per-version isolated installs under
`/home/ils15/pantheon-sandbox/p05-hosts-20261022/`, inside `bwrap` with private
`HOME`/`XDG_*`. The live `/home/ils15/.config/opencode` tree was checksummed
before and after the re-run: identical (`6e21c9e9…ef615`, 46252 bytes,
mtime 2026-10-22 06:04:52), and 0 files newer than 12:20 were created under it.

## Scope and date

- **Item:** P0-5, permission matrix across installed hosts.
- **Release line:** Pantheon **1.6.0** (checkout `707adad`, package version
  `1.6.0-beta.18`).
- **Date:** 2026-10-22. Post-fix matrix window 12:23–12:26 -03:00; V1 probe
  13:12 -03:00.
- **Scope:** execution and collection only. No code, test, CI or doc change;
  nothing committed. Pre-existing working-tree edits were not touched.

## Hosts measured

`P05_ROOT` is `/home/ils15/pantheon-sandbox/p05-hosts-20261022`.

| Host | Contract | Binary | `--version` | Binary SHA-256 |
|---|---|---|---|---|
| 1.19.4 | V1 | `$P05_ROOT/v1.19.4/prefix/bin/opencode` | `1.19.4` | `538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7` |
| 2.0.29 | V2 | `$P05_ROOT/v2.0.29/prefix/bin/opencode2` | `opencode v2.0.29` | `7e23471f4ebe2313d78baacc9ac96fe9e197ce26d808de4b0fcc37efbe473dad` |
| 2.0.30 | V2 | `$P05_ROOT/v2.0.30/prefix/bin/opencode2` | `opencode v2.0.30` | `3eb9af9b4ab07d4de85b68a2678a1e17534f9cfa833ade80b80831e51972da72` |
| 2.1.0 | V2 | `$P05_ROOT/v2.1.0/prefix/bin/opencode2` | `opencode v2.1.0` | `2784487050196257e6dcdb91e57a766c47d0c76a9a9e1523309842a25a083c12` |
| 2.1.2 | V2 | `$P05_ROOT/v2.1.2/prefix/bin/opencode2` | `opencode v2.1.2` | `cf5841e6666aeb469abec8b39ca494cef07a637756454a34a742b2f4996e1675` |
| 2.1.3 | V2 | `$P05_ROOT/v2.1.3/prefix/bin/opencode2` | `opencode v2.1.3` | `4c2630769fa853343a781e765b2280fc1a07f33f7c10d484f75d59e61eb85bc3` |

No host from `PATH` was used, and the live global install was never invoked.
Each `prefix/bin/…` entry above is a symlink; the SHA-256 is of the resolved
file. V2 resolves to that host's own
`prefix/lib/node_modules/@opencode/cli/bin/opencode.exe`; V1 resolves to
`prefix/lib/node_modules/opencode-ai/bin/opencode.exe`.

## V2 matrix — post-fix

The fix under test is `scripts/install/config-migration.mjs` mapping
`write → edit` and collapsing duplicate `edit` entries by effect
restrictiveness (`pushPermission`). The matrix harness drove real `shell`,
`write` and `read` calls plus `ctx.permission.assert` order probes and
`permission.task` globs.

`PASS` = harness verdict; `observed` = value measured and reported without a
pass/fail verdict.

| # | Case | Expected | 2.0.29 | 2.0.30 | 2.1.0 | 2.1.2 | 2.1.3 |
|---|---|---|---|---|---|---|---|
| A1 | action name for a `shell` call | `shell` | `shell` — **PASS** | `shell` — **PASS** | `shell` — **PASS** | `shell` — **PASS** | `shell` — **PASS** |
| A2 | action name for a `write` call | `edit` | `edit` — **PASS** | `edit` — **PASS** | `edit` — **PASS** | `edit` — **PASS** | `edit` — **PASS** |
| A3 | action name for a `read` call | `read` | `read` — **PASS** | `read` — **PASS** | `read` — **PASS** | `read` — **PASS** | `read` — **PASS** |
| A4 | `write` call really ran under permissive config | ran | ran — **PASS** | ran — **PASS** | ran — **PASS** | ran — **PASS** | ran — **PASS** |
| B1 | read-only: `shell` not executed | not executed | not executed — **PASS** | not executed — **PASS** | not executed — **PASS** | not executed — **PASS** | not executed — **PASS** |
| B2 | read-only: `write` not executed | not executed | not executed — **PASS** | not executed — **PASS** | not executed — **PASS** | not executed — **PASS** | not executed — **PASS** |
| B3 | read-only: `read` still allowed | allowed | allowed — **PASS** | allowed — **PASS** | allowed — **PASS** | allowed — **PASS** | allowed — **PASS** |
| C1 | control of order, nested-first: control outside allow glob | reject | `reject` — **PASS** | `reject` — **PASS** | `reject` — **PASS** | `reject` — **PASS** | `reject` — **PASS** |
| C2 | control of order, wildcard-first: control outside allow glob | reject | `reject` — **PASS** | `reject` — **PASS** | `reject` — **PASS** | `reject` — **PASS** | `reject` — **PASS** |
| C3 | observation of order, nested-first: probe inside allow glob | measured | `reject` — observed | `reject` — observed | `reject` — observed | `reject` — observed | `reject` — observed |
| C4 | observation of order, wildcard-first: probe inside allow glob | measured | `allow` — observed | `allow` — observed | `allow` — observed | `allow` — observed | `allow` — observed |
| C5 | observation of order: resolution class | measured | `last-match-wins` — observed | `last-match-wins` — observed | `last-match-wins` — observed | `last-match-wins` — observed | `last-match-wins` — observed |
| D1 | `permission.task` glob: `apollo` allowed | allowed + child | allow, 1 child — **PASS** | allow, 1 child — **PASS** | allow, 1 child — **PASS** | allow, 1 child — **PASS** | allow, 1 child — **PASS** |
| D2 | `permission.task` glob: `demeter` denied | denied, no child | `Permission denied: subagent`, 0 — **PASS** | same — **PASS** | same — **PASS** | same — **PASS** | same — **PASS** |

Per host that is **11 `PASS` cells and 3 observed cells, 0 `FAIL`**. Each fresh
log contains three canary runs (managed-deny, admission, matrix) with harness
summaries `19 pass / 0 fail / 7 skip`, `23 pass / 0 fail / 3 skip`, and
`19 pass / 0 fail / 7 skip`. Each log has 0 `✖` lines and wrapper exit code 0.

## Key values (identical on all five V2 hosts)

| Value | Observed |
|---|---|
| `translator.entries.write` | `edit` |
| `actionNames.evaluations` | `shell/allow`, `edit/allow`, `read/allow` |
| `actionNames.sideEffects` | `{"shell":true,"write":true}` |
| `readOnly.evaluations` | `read/allow` |
| `readOnly.sideEffects` | `{"shell":false,"write":false}` |
| `order.resolution` | `last-match-wins` |
| `order.nestedFirst` probe / control | `reject` / `reject` |
| `order.wildcardFirst` probe / control | `allow` / `reject` |
| `taskGlob.apollo` | `status=completed`, 1 child, evaluation `subagent/apollo allow` |
| `taskGlob.demeter` | `status=error`, 0 children, `Permission denied: subagent` |

## V1 result (1.19.4)

The V1 probe registers a plugin shaped like `src/plugin.ts` on the real `1.19.4`
host and drives real `bash`, `write` and `read` calls through the host's own
session API.

- **`permission.ask` is absent.** It was registered on the V1 plugin surface and
  fired **0 times** across all three scenarios (`hookFired: false`). The three
  cases that need it are `NOT_APPLICABLE`, never `PASS`. The standalone hook name
  occurs **0 times** in the 1.19.4 binary; the 21 raw substring hits for
  `permission.ask` are all `permission.asked`.
  *Note on the string count:* the exact `permission.ask` string occurs **0
  times** in both binaries; the raw substring hits belong to `permission.asked`
  (21 on `1.19.4`, 10 on `2.0.30`). An earlier "12 occurrences in `2.0.30`"
  count was withdrawn from the docs because it is not reproducible. The
  load-bearing fact is unchanged: the hook does not fire on `1.19.4` and is not
  the enforcement mechanism there.
- **The real mechanism is the client.** On `1.19.4` the host emits
  `permission.asked`/`permission.replied` and exposes pending asks via
  `GET /permission`; the answer goes back through
  `POST /permission/{id}/reply`. The harness rejects there, and the tool returns
  `The user rejected permission to use this specific tool call.` with
  `sideEffects {"shell":false,"write":false}` — a client reject does block.
- **Read-only works through config.** With `bash`, `write`, `edit` set to `deny`
  and `read` to `allow`, the host removes `bash` and `write` from the tool list
  (`Model tried to call unavailable tool …`), produces no side effect, and
  `read` still returns the fixture (`V1-CANARY-ALPHA-LINE`).
- **`write` is governed by `edit`.** `permissionKeyObserved.write = ["edit"]`,
  and the pending ask for the write call carries `"permission": "edit"`.

V1 harness result: 10 tests, **7 pass / 0 fail / 3 skipped** (the 3 skips are
the absent-hook cases).

## Archived logs and checksums

All paths relative to `$P05_ROOT/evidence/`. `sha256sum -c` was run against each
real `SHA256SUMS`; every entry verified `OK`.

| Host | Log | Wrapper exit | SHA-256 |
|---|---|---|---|
| 2.0.22 (archived) | `rerun-postfix/v2.0.22.log` | not captured (content: 2 failures) | `17676e3ef32a78cc9573f3b5ff7350c6c10c5fbfdb85683cef3c7b187f7d3523` |
| 2.0.29 | `rerun-postfix/v2.0.29.log` | 0 | `f56a9374e97f37cd5db3c2b795dd9c9b4f6bf48dfb87329c026ef2188f957066` |
| 2.0.30 | `rerun-postfix/v2.0.30.log` | 0 | `333460164604e0f677370ab9edcdd65101ded5d6844fb869719868d6eaa4ceef` |
| 2.1.0 | `rerun-postfix/v2.1.0.log` | 0 | `36a438e9cfd059f4b7f8ca2a62d2fa17e7fce7cc43f82fc22ea058f2a0823219` |
| 2.1.2 | `rerun-postfix/v2.1.2.log` | 0 | `183865ffc40ee46232bfb97144ff6ced88ab71357263e20bad86c282b9eae84a` |
| 2.1.3 | `rerun-postfix/v2.1.3.log` | 0 | `77d4a21cff92e67c6d549d868ec765f412426f9455c3154921674ae378bd6f33` |

The volatile `/tmp` round was archived byte-identically under
`rerun-postfix/archived-tmp-20261022/`. Its own `SHA256SUMS`:

| Log | SHA-256 |
|---|---|
| `archived-tmp-20261022/v2.0.22.log` | `17676e3ef32a78cc9573f3b5ff7350c6c10c5fbfdb85683cef3c7b187f7d3523` |
| `archived-tmp-20261022/v2.0.30.log` | `9def3588844d7e6ea54a2e7736835e2d5f1ddc88da2bf2dfa466951b9f757648` |
| `archived-tmp-20261022/v2.1.0.log` | `2164d0099866da25f4320cd5e6f940c4280eca8ec8cd8ce76c6b5f7a91341132` |
| `archived-tmp-20261022/v2.1.2.log` | `da5266ec606a0c24ef490af963a45f64c36357fd0cf6bcef2c3f973f44fbe216` |

`rerun-postfix/v2.0.22.log` is byte-identical (`cmp`) to the archived 2.0.22
copy. The V1 artifacts are `v1-permission/v1.19.4.log` and
`v1-permission/v1.19.4.evidence.json` (structured payload:
`mechanism: "absent"`).

## Limitations

- The read-only profile denies `write` **and** `edit` together, so B2 does not
  prove an isolated `deny` on `write`.
- The order result is an **observation** (`last-match-wins`), not a contract.
  C3/C4/C5 record the class rather than asserting it.
- `skill`, `websearch`, `webfetch` and `mcp` were not exercised. The translator
  table includes `skill`/`websearch`, but no call evaluated them; `webfetch` and
  `mcp` are not in the table at all.
- `2.0.22` is outside the matrix: the host has no `ctx.permission.assert`, so
  its order cells are `not-applicable` and would be a false green as `PASS`.
- The order probes pass `action: "write"` explicitly through
  `ctx.permission.assert`, so they exercise host policy matching, not the
  translator mapping. A2 is what proves the mapping.
- No real `edit` tool call was scripted, so it is unproven whether the host also
  maps a native `edit` call to `edit` the same way.
- 2.0.22 has no `.exitcode` file (the archived copy came from `/tmp`, which held
  logs only); its log shows 2 failures, so its wrapper exit was non-zero.
- The V1 row is not a V2 matrix row: on `1.19.4` the V2 probes cannot run, and
  the V1 proof is config/client-level only.

## Where the raw artifacts live

`/home/ils15/pantheon-sandbox/p05-hosts-20261022/`:

- `evidence/EVIDENCE-P05.md` — source document for the run;
- `evidence/rerun-postfix/` — authoritative post-fix logs, exit codes,
  `SHA256SUMS`, and the archived `/tmp` round;
- `evidence/v1-permission/` — V1 log and structured evidence;
- `logs/` — per-version install logs;
- `env.sh`, `install-host.sh`, `run-postfix-matrix.sh` — isolation and runner.

The sandbox is **disposable** (`rm -rf ~/pantheon-sandbox`); it is not a durable
store. This document is the durable, curated copy: it records the numbers and
the checksums, not the raw logs.

## Reproduction

V2 matrix, one isolated host per execution:

```bash
for tag in v2.0.29 v2.0.30 v2.1.0 v2.1.2 v2.1.3; do
  (
    source ~/pantheon-sandbox/p05-hosts-20261022/env.sh "$tag"
    cd /home/ils15/pantheon
    PANTHEON_TOOL_CANARY_BIN="$P05_ROOT/$tag/prefix/bin/opencode2" \
    PANTHEON_TOOL_CANARY_ACCEPTED_VERSIONS='2.0.29,2.0.30,2.1.0,2.1.2,2.1.3' \
    PANTHEON_TOOL_CANARY_PERMISSION_MATRIX=1 \
    bash tests/canary/run-v2-permission-proof.sh \
      >"$P05_ROOT/evidence/rerun-postfix/$tag.log" 2>&1
    echo "$?" >"$P05_ROOT/evidence/rerun-postfix/$tag.exitcode"
  )
done
```

This is `run-postfix-matrix.sh` in the sandbox; the per-host subshell keeps
`HOME`/`XDG_*`/npm prefix isolated. One host per wrapper invocation.

V1 probe:

```bash
source ~/pantheon-sandbox/p05-hosts-20261022/env.sh v1.19.4
cd /home/ils15/pantheon
PANTHEON_V1_CANARY_BIN=$P05_ROOT/v1.19.4/prefix/bin/opencode \
PANTHEON_V1_CANARY_ACCEPTED_VERSIONS='1.19.*' \
bash tests/canary/run-v1-permission-proof.sh 2>&1 | tee /tmp/p05-v1.19.4.log
```

`PANTHEON_V1_CANARY_ACCEPTED_VERSIONS` defaults to `1.19.*`; neither wrapper
spawns a host outside its gated version range. Both wrappers require `bwrap`.
