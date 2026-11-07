# B8/B9 Verification Matrix

Scope: verify the requested behaviors against the current checkout and record
reproducible checks. This is a test plan/evidence record only; no product code or
live provider was exercised. Isolated host/fixture-MCP evidence is labeled below.
Synthetic tokens/configuration only.

## Status key

- **PASS (offline)** — focused automated test or isolated temp-HOME check ran.
- **SOURCE / test gap** — behavior is described or wired in source, but this
  checkout does not contain a focused assertion for it.
- **MANUAL — NOT RUN** — requires a real host/process observation; do not treat
  this as verified evidence.
- **UNRESOLVED** — the requested exact procedure was not found in tracked
  sources; no command sequence is invented.

## Matrix

| ID | Setup → action | Expected evidence | Traceability and verification |
|---|---|---|---|
| B8-1a | Feed synthetic high-confidence token-shaped text to the in-process scanner. | Exit code `2`, `[SECRET SCAN]`, block verdict, no raw token; long match uses `first4****last4`. | **PASS (offline):** `./node_modules/.bin/tsx tests/pantheon/v2-hook-engine.test.ts`. `tests/pantheon/v2-hook-engine.test.ts` (`testScanContract`, `testMasking`); implementation `src/pantheon/v2-hook-engine.ts` (`runSecretScanInProcess`, `maskSecretMatch`). |
| B8-1b | Feed a synthetic key-name/value shape that is low-confidence. | Exit code `1` with the advisory marker/message; not the high-confidence block result. | **PASS (offline):** same command as B8-1a. The test asserts code `1` and the “low confidence” marker. |
| B8-1c | Call the scan applicability classifier with read-only and unknown tool names; separately inspect the unexpected-error path. | Read-only tools skip; unknown/missing names remain scanned. Internal scan error is code `1` without the marker and the plugin classifier must fail closed. | **PASS for applicability:** same command as B8-1a checks `read`/`grep`/`glob` skip and unknown/missing names scan. **SOURCE / test gap for error classification:** `src/pantheon/v2-hook-engine.ts` catch path and `src/plugin-v2.ts` `evaluateSecretScanResult`; no focused forced-internal-error classifier assertion was found. |
| B8-1d | Observe a real tool call while checking child processes. | Secret scan is in-process; no bash child is created by the scan. | **MANUAL — NOT RUN:** source path is `runSecretScanInProcess` in `src/plugin-v2.ts`/`src/pantheon/v2-hook-engine.ts`; `ps` was not observed. A source read or unit test is not evidence that `ps` was empty. |
| B8-2a | Build start/stop delegation records with synthetic metadata and append to a temp state directory. | `delegations.log` has one JSON object per line; start/stop fields join on `delegation_id`; empty `task_id` is omitted and `duration_ms` is numeric or omitted when absent. | **PASS (offline):** `./node_modules/.bin/tsx tests/pantheon/v2-hook-engine.test.ts`. `testAuditLines` and `testAuditAppenderAndDir` assert fields and parse an appended line. **Caveat:** the test parses the JSON line; it does not assert byte-for-byte exact serialized text. Source serializes `JSON.stringify(line) + "\n"` in `src/pantheon/v2-hook-engine.ts`. |
| B8-2b | Observe a real delegation audit start/stop and check child processes. | Audit line creation/appending has zero child processes; this is separate from formatting. | **MANUAL — NOT RUN:** `src/pantheon/v2-shell-hooks.ts` default runner directly calls the in-process line builders/appender. No `ps` observation was run. Eligible formatting can still spawn a formatter; do not generalize this row to zero children for every tool call. |
| B8-2c | Exercise edit/write/hashline with supported and unsupported extensions, read/grep, and bash. | File-edit formatting is gated by recognized extension; non-file/read-only calls skip. `bash` remains conservatively eligible even without a file extension. | **PASS (offline predicate):** B8-1 command checks `formatterApplies` for `.ts`, `.py`, `.png`, read/grep, and bash. `docs/reference/performance.md` and `src/pantheon/v2-hook-engine.ts` document the same distinction. **Caveat:** “extension-gated” applies to file tools, not bash. |
| B8-3a | In a temporary HOME/XDG and project, run `init` with a Console decision-model target and explicit caps. | A single init invocation configures route, consent, user/provider/model caps, and period through `setup-model`; no provider request is made by installation. | **PASS (isolated temp-HOME subprocess probe):** arguments `init --project --components agents --no-mcp --yes --headless --opencode-version v2 --decision-model opencode-console-jev/jev-1.13 --decision-monthly-usd 5 --decision-per-decision-usd 0.10`; verified enabled route, consent, three cap scopes, and budget period in the temporary config/ledger. Existing focused test: `node --test tests/decision-router-cli.test.mjs` (11/11 pass). Sources: `bin/pantheon-init.mjs` around `readArgValue` and decision activation; `CHANGELOG.md` beta.8. |
| B8-3b | Repeat the isolated init with `--decision-no-consent`; inspect the temporary decision-router config and output. | Route/caps are configured, but `egress_consent` remains false. | **PASS (isolated temp-HOME subprocess probe):** consent was false. **Caveat found:** output also contains `Unknown option ignored: --decision-no-consent`; the parser allowlist in `bin/pantheon-init.mjs` omits this flag even though the later activation path reads it. Underlying `setup-model --no-consent` is covered by `node --test tests/decision-router-cli.test.mjs` (11/11 pass). |
| B8-3c | Run temp-project `init --dry-run --decision-model typesafe-jev/jev-1.14.0`; inspect output and user config. | No files/config are written. Whether Jev intent must also appear in the preview is unspecified in the handoff. | **PASS for generic dry-run/no writes; caveat for Jev preview:** isolated temp-HOME subprocess left the OpenCode config unchanged, but emitted no decision-model intent. `bin/pantheon-init.mjs` returns from the dry-run branch before the optional Jev activation block (around lines 912–953 versus 1030+). `node --test tests/install-preview-apply.test.mjs` (27/27 pass) covers generic dry-run, not the Jev flag. |
| B8-3d | In a temporary OpenCode config, select TypeSafe through init with an existing unrelated provider/model entry. Also consider a non-JSON config as a separate negative case. | Add `providers.typesafe-ai.models.jev-1.14.0` with `type: "decision"`, preserve existing keys; do not overwrite a non-JSON config. | **PASS for additive JSON merge:** isolated temp-HOME init probe preserved the synthetic existing provider and added the decision model. **SOURCE / test gap for non-JSON case:** `provisionTypesafeProvider` in `bin/pantheon-init.mjs` returns a reason without overwriting; no focused test for that helper was found. No credentials/sign-in/provider call used. |
| B8-4a | Run the interactive prompt contract with the fake prompt adapter. | Choices are exactly Skip, Console Jev, Console free variant, and TypeSafe direct; skip is the initial choice and wizard route caps are explicit. | **PASS (offline):** `node --test tests/install-interactive-prompts.test.mjs` (18/18 pass). `tests/install-interactive-prompts.test.mjs` checks the exact choice values and the three route targets/default caps. |
| B8-4b | Pass legacy spellings (`jev`, `openai-decisions`, `auto`, `local`) through the fake wizard selection. | They degrade to skip/no activation; they do not silently become a native route. | **PASS (offline):** same command as B8-4a; test `choosing a Jev route activates it with explicit caps; unknown legacy values degrade to skip`. |
| B8-4c | Run install truthfulness checks in temporary project/config directories, default and verbose. | Capability notice absent by default and printed once when verbose. | **PASS (offline):** `node --test tests/install-truthfulness.test.mjs` (31/31 pass). Relevant test: `a V2 install keeps the capability block quiet by default and prints it once under --verbose`. |
| B9-1a | Under the real OpenCode host, configure a deny on the measured `shell` action and issue the canary’s twin permission assertions for `shell` then `bash`. | Record both outcomes as `shell → deny/reject | bash → allow` for the historical unruled twin; separately prove the denied command has no side effect. | **MANUAL — NOT RUN in this task.** The beta.9 changelog records the measured host behavior (`CHANGELOG.md` lines 21–22); twin probe is in `tests/canary/plugin-v2-tool-canary.test.mjs`; isolated host runner is `bash tests/canary/run-v2-permission-proof.sh`. This matrix does not claim a fresh host observation. |
| B9-1b | Run the existing all-agent/frontmatter test, then inspect terminal permission fields on all canonical agent files. | Exactly 14 canonical agents; each has a `permission.shell` entry and each `shell: deny` also has `bash: deny`. | **PASS:** `node --test tests/pantheon/delegation-matrix.test.mjs` (64/64 pass) checks the 14 canonical files/frontmatter validity, but not these shell keys. A separate read-only source audit in this task found 14 files, no missing `shell`, and no deny without a bash twin. |
| B9-2 | Ask Zeus to perform a terminal action and inspect the instruction boundary. | Zeus must delegate terminal work; it must not tell the user to type/run terminal commands. | **SOURCE / behavior test gap:** `src/agents/zeus.md` says not to ask the user for terminal commands (around line 102). No automated behavioral/model assertion was found; no live prompt was run. |
| B9-3 | Run the isolated host permission proof with a managed deny and verify attempted command side effects. | A real host permission rejection blocks execution, rather than merely recording a deny. | **MANUAL — NOT RUN:** `bash tests/canary/run-v2-permission-proof.sh` is the available opt-in proof; it requires the configured OpenCode binary and `bwrap`. Source: `tests/canary/run-v2-permission-proof.sh`, `tests/canary/plugin-v2-tool-canary.test.mjs`. |
| B9-4 | Exercise decision-router doctor in an isolated config where no host binary/catalog is available. | Doctor reports config/consent/selection/budget independently and degrades the unavailable catalog probe to a warning with a fix hint; it remains read-only. | **PASS (offline):** `node --test tests/decision-router-cli.test.mjs` (11/11 pass), test `doctor diagnoses the chain read-only and degrades when the host probe fails`. This is not a real host catalog probe. |
| B9-5 | Reproduce the requested “stray hosts”, webhooks, and catalog-without-Jev regression sequence. | Use the exact intended ordered commands, preserve the known caveats, and route an unavailable/missing Jev catalog to `decision-router doctor`. | **UNRESOLVED:** no tracked test/doc defines the exact regression sequence for stray hosts or webhooks; no commands are invented here. The repository does define `npx pantheon-opencode decision-router doctor` and its offline no-host test above. A real `doctor`/catalog check is manual and was not run. Zeus must supply the intended sequence before this row can be marked complete. |

## Focused checks run for this matrix

All ran without live provider/MCP calls:

```sh
./node_modules/.bin/tsx tests/pantheon/v2-hook-engine.test.ts
./node_modules/.bin/tsx tests/pantheon/v2-shell-hooks.test.ts
node --test tests/install-interactive-prompts.test.mjs
node --test tests/decision-router-cli.test.mjs
node --test tests/install-truthfulness.test.mjs
node --test tests/install-preview-apply.test.mjs
node --test tests/pantheon/delegation-matrix.test.mjs
npm run docs:lint
python3 - <<'PY'
from pathlib import Path
import re
files = sorted(Path('src/agents').glob('*.md'))
missing, missing_twin, bash_only_deny = [], [], []
for path in files:
    text = path.read_text()
    fm = re.search(r'\A---\n(.*?)\n---', text, re.S)
    permission = re.search(r'^permission:\n(.*?)(?=^[^ \n][^\n]*:|\Z)', fm.group(1), re.M | re.S)
    body = permission.group(1) if permission else ''
    if not re.search(r'^  shell:', body, re.M): missing.append(path.name)
    if (re.search(r'^  shell:\s*deny\s*$', body, re.M)
            and not re.search(r'^  bash:\s*deny\s*$', body, re.M)):
        missing_twin.append(path.name)
    if (re.search(r'^  bash:\s*deny\s*$', body, re.M)
            and not re.search(r'^  shell:\s*deny\s*$', body, re.M)):
        bash_only_deny.append(path.name)
print(f'agents={len(files)} missing_shell={missing} deny_without_bash_twin={missing_twin} bash_only_deny={bash_only_deny}')
PY
```

Each listed check passed; the one-off field audit printed
`agents=14 missing_shell=[] deny_without_bash_twin=[] bash_only_deny=[]`. The isolated init probe
used temporary HOME/XDG/project roots and was removed afterward. Initial probe
iterations had harness-only errors (relative CLI path after `cwd` change; an
incorrect expectation for the status caps display); corrected probes passed.
The temporary probes found the two B8 caveats recorded above: the init
no-consent flag is reported as unknown, and decision-model intent is omitted
from dry-run output.

## Host-side integration boundary

There is a supported **host-plugin boundary**, not a standalone site API:

- Native Jev uses the host plugin context’s
  `ctx.experimental.generate.decisions({ model, input, questions })`; the native
  route is documented as available from OpenCode 2.2.0 and feature-detected in
  `src/plugin-v2.ts`. Host-installed skills are read through `ctx.skill.list()`.
  See `docs/reference/native-decisions.md`, `src/plugin-v2.ts` around lines
  695–720, and `src/pantheon/jev-decision-tool.ts`.
- MCP servers are configured in the host’s project/user OpenCode config under
  `mcp`; the host launches local stdio servers as separate OS processes. See
  `docs/MCP.md` and `docs/opencode-v2.md`. A local fixture MCP is therefore
  possible without changing production behavior, provided the test host and
  config are isolated.
- Existing host-backed precedent: `tests/canary/plugin-v2-tool-canary.test.mjs`
  creates a temporary project/plugin and isolates HOME/XDG; it mocks only a local
  model endpoint. `tests/canary/run-v2-mcp-gating-proof.sh` uses bwrap with a
  private HOME and network namespace, allowing only local stdio MCP.

The planned pickleball browser site was superseded by the approved host-loaded,
test-only harness now in `dev/tests/`. It runs as an isolated OpenCode project/plugin
under a real host to obtain `ctx`; no browser UI or browser-facing API is claimed.
The harness verifies local fixture behavior, but does **not** prove a live Jev
Decisions call or MCP resource-content read. Such calls remain opt-in/manual and
were not made here.

## Pickleball development harness addendum

Verified harness commands and evidence labels (the B9-5 row above remains
**UNRESOLVED**):

- `node --test dev/tests/harness.test.mjs` — **PASS (stub/offline)**, 5/5. The
  typed-decision stub and direct MCP fixture checks are not host evidence.
- `PICKLEBALL_OPENCODE_BIN=/home/ils15/.opencode/bin/opencode bash dev/tests/run-host-runtime.sh`
  — **PASS (host)** on OpenCode `v2.2.5`, in bubblewrap's isolated network
  namespace, using a synthetic local model and fixture MCP. The host used the
  actual skill registry (`ctx.skill.transform` / `ctx.skill.list`) and listed the
  fixture through the MCP catalog (`resources/list` and `resources/templates/list`).
  MCP resource content was **not read**; no content read is claimed. A live Jev
  Decisions call was **not invoked** (`decisions.capability` was available but
  `invoked: false`). No external/provider egress was available.
- `node dev/tests/live-jev.mjs --help` — safe usage display only. The separate
  interactive `--live-jev` path was **NOT RUN**; no live Jev/provider operation
  occurred.

See `dev/tests/README.md` for isolation controls, exact labels, limitations, and
the explicit live-command disclosure.
