# V2 TUI quota provider coverage

Quota windows display a local countdown and an absolute UTC reset date/time only
for valid reset timestamps reported by the provider. Missing reset timing is
omitted, including for OpenAI responses that do not provide it; the UI does not
infer a reset from a window label. Once the timestamp has passed, “aguardando
atualização” remains visible without showing a stale date until fresh data arrives.
The countdown advances using a local clock and does not request provider data; the
enabled quota runtime refreshes provider status every 60 seconds. Empty quota
gauges retain a visible track when reported usage is zero.
When a quota status request fails, the last valid snapshot is preserved
and the failure cause is shown as `Erro: <causa>` (plus a `Último erro`
line in the detail panel) instead of a blind "Status indisponível". The
server keeps the original cause out of the UI response and logs it as
`[pantheon-tui quota]`.

Financial values and provider states wrap onto additional lines as needed. The
sidebar keeps session costs, balances and selected-key usage distinct, including
any period or status supplied by the source; a missing period is not inferred.
The quota detail panel retains both used and remaining amounts.

The V2 quota RPC exposes providers with a listed active connection using a
supported auth method and a locally resolved nonblank API key or OAuth access
token. OpenCode Go also accepts its configured key sources without a saved
login: `OPENCODE_API_KEY`, then effective `opencode-go`/`opencode` provider
settings exposed by OpenCode. Catalog-only providers, inactive connections,
missing credentials, and local CLI-only sources are otherwise omitted and
never queried. This is a local eligibility check, not proof that the provider
accepted the credential. Eligible connections without an adapter or whose
request fails remain visible with an unavailable reason and no invented
metrics. `available` means the provider returned a strictly validated
normalized value.

For providers other than OpenCode Go, remote credentials are resolved only from
a selected, listed `ctx.integration` credential connection for the provider's
fixed integration ID and allowed method. Go follows the [OpenCode Quota key
order](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#opencode-go):
`OPENCODE_API_KEY`, effective `opencode-go` then legacy `opencode` provider
settings read through the OpenCode provider API, then a selected, listed API-key
connection. The Console OAuth login is still tried first; the selected API key
is sent only to the fixed Go usage route after an eligible Console failure.
Only the credential needed for the request is retained in memory briefly and
passed to that provider's fixed HTTPS adapter; adapters without support do not
retain the secret. A small allowlisted projection of OAuth
metadata (Google project ID and OpenCode Console account/org IDs) may be used as
request data; opaque metadata is discarded. For OpenCode Console OAuth, the
resolved `metadata.server` is checked in memory: absent metadata uses the
official default, the official default and retired `console.opencode.ai` alias
normalize to the already approved fixed host, and any custom or malformed value
is rejected before a request. The host is never selected dynamically and is
never shown in the UI. The RPC, TUI storage, and error results never contain
credentials. Pantheon does not parse OpenCode config files or inspect auth
databases, browser stores/cookies, user PAT files, or custom provider URLs. The
only environment secret read for quota is the documented OpenCode Go
`OPENCODE_API_KEY`.

The fixed Alibaba Personal Token Plan CLI adapter remains isolated from this
credential-bound RPC surface: without an active OpenCode credential connection,
it is not displayed or invoked. No local CLI identity is inspected.

## Adapter coverage and limitations

| Provider | Approved audience | Data returned | Endpoint/source scope |
| --- | --- | --- | --- |
| Anthropic / Claude | US personal and business | Provider-reported 5-hour, weekly, and enabled extra-usage windows | Upstream-derived `GET https://api.anthropic.com/api/oauth/usage`; private/unofficial usage route; OAuth only |
| GitHub Copilot | US personal | Provider-reported premium-interaction quota; no enterprise billing | Upstream-derived `GET https://api.github.com/copilot_internal/user`; private/unofficial route; OAuth only |
| Google AGY | US personal and business | Provider-reported quota buckets; only queried when selected OAuth metadata supplies a valid project ID | Upstream-derived `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`; private/unofficial route |
| OpenCode Go | US personal | Console-reported quota first when a login is selected; otherwise API key. Console failure can fall back to the first configured/selected API key except 404/no subscription; API-key 401 remains inconclusive | Fixed Console OAuth `GET /console/api/go/status` first, then API-key `GET /zen/go/v1/usage`, matching the [OpenCode Quota provider guide](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#opencode-go). OpenCode confirms this route remains supported and uses the same backend as `/inference/go/v1/usage` ([maintainer note](https://github.com/anomalyco/opencode/issues/52227)). API keys are never sent to the Console route |
| OpenAI / Codex | US personal and business | Provider-reported ChatGPT quota windows | Upstream-derived `GET https://chatgpt.com/backend-api/wham/usage`; private/unofficial route; selected OAuth method IDs `chatgpt-browser` or `chatgpt-headless` only |
| OpenCode Zen | US personal and business | Console balance and monthly credit limit when available | Upstream-derived fixed-host Console billing/account and daily-usage routes; private/unofficial routes; OpenCode OAuth only |
| xAI SuperGrok | US personal and business | Provider-reported billing-period usage; billing route queried only after an active SuperGrok tier is verified | Upstream-derived `GET https://grok.com/rest/subscriptions` and `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`; private/unofficial routes; OAuth only |
| DeepSeek | China personal | Provider-reported USD/CNY balance and availability status; not time quota | Documented `GET https://api.deepseek.com/user/balance` |
| Ollama Cloud | US personal | Included and purchased USD balance; session/weekly quota only for legacy response shape | Documented `GET https://ollama.com/api/balance`; team balances are shared by the provider |
| OpenRouter | US personal and business | Selected API key's reported USD budget/remaining amount, or selected-key spend when no limit is configured | Documented `GET https://openrouter.ai/api/v1/key`; never represented as account credit |
| Chutes AI | US personal and business | Reported daily used/limit values | Upstream-derived `GET https://api.chutes.ai/users/me/quota_usage/me`; private/unofficial endpoint |
| NanoGPT | US personal and business | Subscription status, daily/monthly usage windows, USD balance | Upstream-derived `GET https://nano-gpt.com/api/subscription/v1/usage` and `/api/check-balance`; private/unofficial endpoints |
| Kilo Gateway | US personal | Kilo Pass credit quota, or gateway balance if no pass subscription exists | Upstream-derived `GET https://app.kilo.ai/api/trpc/kiloPass.getState` and `GET https://api.kilo.ai/api/profile/balance`; private/unofficial endpoints |
| Synthetic | US personal and business | Rolling five-hour quota and weekly USD credit limit | Upstream-derived `GET https://api.synthetic.new/v2/quotas`; private/unofficial endpoint |
| Kimi Code global | China personal and business/team | Provider-reported usage windows | Upstream-derived `GET https://api.kimi.ai/coding/v1/usages`; regional key required; private/unofficial endpoint |
| Kimi Code CN | China personal and business/team | Provider-reported usage windows | Upstream-derived `GET https://api.kimi.com/coding/v1/usages`; regional key required; private/unofficial endpoint |
| MiniMax Token Plan global | China personal and business/team | Provider-reported 5-hour/weekly count or percentage windows | Upstream-derived `GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains`; token-plan key required; private/unofficial endpoint |
| MiniMax Token Plan CN | China personal and business/team | Provider-reported 5-hour/weekly count or percentage windows | Upstream-derived `GET https://api.minimaxi.com/v1/token_plan/remains`; token-plan key required; private/unofficial endpoint |
| Z.ai Coding Plan | China personal | Provider-reported coding-plan percentage windows | Upstream-derived `GET https://api.z.ai/api/monitor/usage/quota/limit`; API-key auth format; private/unofficial endpoint |
| Zhipu Coding Plan | China personal and business/team | Provider-reported coding-plan percentage windows | Upstream-derived `GET https://bigmodel.cn/api/monitor/usage/quota/limit`; API-key auth format; private/unofficial endpoint |
| Alibaba Personal Token Plan | China personal | Not surfaced by the credential-bound V2 quota RPC | The fixed CLI adapter is not invoked; no local CLI identity is inspected |

OpenCode Go has separate Console and API-key routes. The Console status route
is private. To match the OpenCode Quota provider guide, Pantheon uses
`/zen/go/v1/usage`; OpenCode maintainers confirm this route remains supported
and reaches the same backend as canonical `/inference/go/v1/usage`. The adapter
first uses a selected, listed `opencode` Console OAuth login with
method ID `device` at the fixed Console status route when that login is
selected. API keys are selected in this order: `OPENCODE_API_KEY`, effective
`opencode-go` settings, effective legacy `opencode` settings, then active
listed `opencode-go` and legacy `opencode` API-key logins. If no Console login
is available, or its request fails, the first available API key may be used at
the fixed Go usage route. A Console 404 or successful
response without an `access` object is shown as no Go subscription and stops
fallback;
other Console failures may fall back. A failed API-key connection lookup does
not discard a usable Console result. API keys are never sent to the Console
route, and Console OAuth tokens are never sent to the API-key route. A 401 from
the API-key route remains unavailable/unauthorized with an unknown cause.
Provider settings are read through OpenCode's provider API; Pantheon does not
read or parse config files directly. Only `OPENCODE_API_KEY` is read from the
environment. Auth databases and browser stores are not read directly. No live
Go request was made.

For OpenCode Go reset labels, each valid meter `resetsAt` takes precedence. If
the monthly meter omits it, a valid `access.endsAt` is used for the monthly
window only; it is not applied to the 5-hour or weekly windows.

Adapter requests use fixed HTTPS URLs, the provider-specific bearer or raw API
key auth header, redirect rejection, a 5-second per-request timeout, a 64 KiB response
cap, strict response projection, in-flight deduplication, a short result cache,
and bounded `Retry-After` handling. Tests mock all network responses; no live
provider calls are made by tests. Adapters currently cover 21 of the 25 provider identities in the registry;
the remaining four have explicit fail-closed setup/unavailable states below.
Approved audiences are declared separately and are never inferred from an
unverified account label.

The non-public endpoint paths above are adapted from the pinned public upstream
snapshot [`slkiser/opencode-quota` at
`350122edce30ca924012e45a64f476fbde97be70`](https://github.com/slkiser/opencode-quota/tree/350122edce30ca924012e45a64f476fbde97be70).
The user explicitly authorized HTTPS transmission of matching `ctx.integration`
credentials to the endpoint families listed above, including Chutes, NanoGPT,
Kilo Gateway, Synthetic, regional coding-plan providers, and selected OAuth
usage/billing routes. Authorization does not extend to other hosts or routes.
OpenCode Go is separately adapted from the named public reference's
Console-first/API-key-fallback behavior and key-source order, limited to its two
fixed HTTPS routes and the documented environment, effective provider settings,
and selected OpenCode credential sources. The API key is only sent to the Go
usage route; OAuth is only sent to the Console route.
OpenAI is enabled only for the two source-registered Codex OAuth methods listed
below; Gemini remains disabled because eligibility cannot be established from
the current integration context. Contracts are mocked in tests only; future
endpoint changes can make a row unavailable. OpenCode Go uses its selected
Console OAuth login before an API-key fallback, as detailed above; all requests
remain fixture-tested only.

## Approved matrix and current blockers

`private_endpoint` means a required private/unofficial route lacks explicit
authorization and remains disabled. The specifically authorized OpenCode Go
Console/API-key routes and the other upstream-derived routes remain limited to
their fixed hosts, methods, and credential types; this is not provider
endorsement and is not consent for another host or method.
`runtime_accounting_unavailable` means no supported OpenCode runtime-accounting
API is exposed by the current plugin context. `cli_identity_unavailable` means
the fixed official CLI path is not explicitly trusted/configured or the
executable cannot be started. `unsupported` means no approved source or safe
documented usage-only invocation is available.

| Provider | Personal | Business/team | Current state when connected |
| --- | --- | --- | --- |
| Anthropic / Claude | US | US | Implemented from the upstream-derived OAuth usage route; no CLI/auth-store fallback |
| Chutes AI | US | US | Implemented from upstream/private route (above) |
| Cursor | US estimate | US estimate | Unavailable: current OpenCode plugin context has no supported runtime-accounting API; no estimate is fabricated |
| GitHub Copilot | US personal quota | US billing | Personal OAuth user quota implemented; business billing remains unavailable without a billing-scoped integration credential; no PAT-file workaround |
| Google AGY | US | US | Implemented only when selected OAuth metadata includes a valid project ID; otherwise `eligibility_unverified` and no request |
| Kilo Gateway | US | — | Implemented from upstream/private routes (above) |
| NanoGPT | US | US | Implemented from upstream/private endpoints (above) |
| Ollama Cloud | US | — | Implemented (above) |
| OpenAI / Codex | US | US | Implemented only for selected OAuth method IDs `chatgpt-browser` and `chatgpt-headless`; generic OAuth, token-sharing, API keys, and unknown methods are blocked |
| OpenCode Go | US | — | Console OAuth first, then selected API-key fallback after Console failures except 404 or a successful response without an access object; private/unofficial routes. API-key 401 is inconclusive; API keys are never sent to Console |
| OpenCode Zen | US | US | Implemented from fixed-host Console billing/account/daily-usage routes using the selected `opencode` OAuth login; no member-policy request |
| OpenRouter | US | US | Implemented (above) |
| Synthetic | US | US | Implemented from upstream/private route (above) |
| xAI SuperGrok | US | US | Implemented only after subscriptions confirms an active SuperGrok tier; otherwise billing is not queried |
| Gemini CLI / Code Assist | — | US Standard/Enterprise only | Authorized route remains disabled because Code Assist Standard/Enterprise eligibility cannot be proven; consumer accounts are never queried |
| Alibaba Coding Plan | China estimate | — | Unavailable: no supported OpenCode runtime-accounting API; CLI quota is not substituted for an estimate |
| Alibaba Token Plan | China CLI/setup | — | Not surfaced by the credential-bound V2 quota RPC; its fixed CLI adapter is not invoked and no local CLI identity is inspected |
| DeepSeek | China | — | Implemented (above) |
| Kimi Code global | China | China/team | Implemented from upstream/private regional route (above) |
| Kimi Code CN | China | China/team | Implemented from upstream/private regional route (above) |
| MiniMax Token Plan global | China | China/team | Implemented from upstream/private regional route (above) |
| MiniMax Token Plan CN | China | China/team | Implemented from upstream/private regional route (above) |
| Xiaomi MiMo | China dashboard/API setup | — | Unavailable: no approved `ctx.integration` endpoint contract; dashboard cookies and `mimo.json` are not read |
| Z.ai Coding Plan | China | — | Implemented from upstream/private route (above) |
| Zhipu Coding Plan | China | China/team | Implemented from upstream/private route (above) |

### Eligibility and explicit exclusions

- OpenAI issues a ChatGPT quota request only for a selected listed OAuth
  connection whose method ID is exactly `chatgpt-browser` or
  `chatgpt-headless`, matching the OpenCode v2.0.22 provider registrations. It
  blocks generic/unknown OAuth methods, `chatgpt-token-sharing`, and API keys;
  only the approved WHAM usage route is queried.
- OpenCode Go follows the [OpenCode Quota provider guide](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#opencode-go): `OPENCODE_API_KEY`, effective provider settings, then selected API-key login; the selected Console OAuth login is attempted first. An API key is used only after a failed Console request other than 404/no subscription. The Console token and API key remain isolated to their respective fixed routes. API-key 401 is sanitized and does not prove the key is invalid. These private routes are fixture-tested; no live Go request was made.
- Gemini CLI quota is never requested unless Code Assist Standard/Enterprise
  eligibility is proven. The current integration context does not expose that
  proof, so connected Gemini sources are shown unavailable.
- Copilot business billing's separate PAT-file method is not used. Xiaomi
  dashboard-cookie/file sources are not used. Alibaba Coding Plan estimates
  remain blocked without runtime accounting; the Alibaba Token Plan adapter
  uses only the official fixed CLI command and does not inspect CLI credentials.
- Copilot's private user-quota route is used only with the selected OAuth
  credential. Business billing is not attempted without explicit billing-scope
  evidence. Google AGY requires a valid project ID from resolved OAuth metadata.
- OpenCode Zen uses only the fixed `https://opencode.ai/console` host. Its
  selected OAuth credential is also rejected before requests when
  `metadata.server` is custom or malformed. Only the authorized billing/account
  and daily-usage routes are requested; member-policy endpoints are not called.
- xAI billing usage is requested only after the selected `xai` OAuth
  subscriptions response proves an active supported SuperGrok tier.
- Custom providers remain disabled pending a safe SSRF design and Themis review.

## Normalized metric distinctions

- `provider_quota`: provider-reported used/remaining values and unit/window.
- `balance`: provider-reported funds/credits, distinct from time quota.
- `key_usage`: usage attributed to the selected API key when no key budget is
  configured; not account credit or remaining quota.
- `provider_status`: a provider-reported status, kept distinct from accounting
  amounts and quota windows.
- `estimate` and `session_usage` are separate types and are not populated by
  these adapters.
