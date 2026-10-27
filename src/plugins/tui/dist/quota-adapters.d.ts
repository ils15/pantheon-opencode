import { queryAlibabaTokenPlanUsage } from "./quota-cli.js";
//#region src/quota-rpc.d.ts
/** Full provider matrix approved for the V2 quota surface. */
declare const QUOTA_PROVIDER_IDS: readonly ['anthropic', 'chutes', 'cursor', 'github-copilot', 'google-agy', 'kilo-gateway', 'nanogpt', 'ollama-cloud', 'openai', 'opencode-go', 'opencode-zen', 'openrouter', 'synthetic', 'xai-supergrok', 'gemini-cli', 'alibaba-coding-plan', 'alibaba-token-plan', 'deepseek', 'kimi-code-global', 'kimi-code-cn', 'minimax-plan-global', 'minimax-plan-cn', 'xiaomi-mimo', 'zai-coding-plan', 'zhipu-coding-plan'];
type QuotaProviderId = (typeof QUOTA_PROVIDER_IDS)[number];
//#endregion
//#region src/quota-adapters.d.ts
export declare const OPENAI_CODEX_OAUTH_METHOD_IDS: readonly ['chatgpt-browser', 'chatgpt-headless'];
type OpenAICodexOAuthMethodID = (typeof OPENAI_CODEX_OAUTH_METHOD_IDS)[number];
export declare function isOpenAICodexOAuthMethod(value: unknown): value is OpenAICodexOAuthMethodID;
export declare const OPENCODE_CONSOLE_OAUTH_METHOD_IDS: readonly ['device'];
type OpenCodeConsoleOAuthMethodID = (typeof OPENCODE_CONSOLE_OAUTH_METHOD_IDS)[number];
export declare function isOpenCodeConsoleOAuthMethod(value: unknown): value is OpenCodeConsoleOAuthMethodID;
type OAuthMethodID = OpenAICodexOAuthMethodID | OpenCodeConsoleOAuthMethodID;
export type QuotaAdapterContext = {
  readonly projectId?: string;
  readonly accountId?: string;
  readonly orgId?: string;
  readonly methodID?: OAuthMethodID;
};
export type QuotaAudience = 'us_personal' | 'us_business' | 'china_personal' | 'china_business';
export type QuotaMetric = {
  kind: 'provider_quota';
  used: number;
  remaining: number;
  unit: string;
  label: string;
  period?: string;
  resetsAt?: number;
} | {
  kind: 'balance';
  amount: number;
  currency: 'USD' | 'CNY';
  label: string;
  status?: 'available' | 'unavailable' | 'active' | 'inactive';
} | {
  kind: 'estimate';
  amount: number;
  unit: string;
  label: string;
} | {
  kind: 'provider_status';
  status: 'available' | 'unavailable' | 'active' | 'inactive';
  label: string;
} | {
  kind: 'key_usage';
  amount: number;
  currency: 'USD' | 'CNY';
  label: string;
  period?: string;
} | {
  kind: 'session_usage';
  amount: number;
  unit: string;
  label: string;
};
export type AdapterFailureReason = 'provider_error' | 'not_subscribed' | 'rate_limited' | 'unauthorized' | 'forbidden' | 'timeout' | 'network_error' | 'invalid_response' | 'cli_identity_unavailable' | 'eligibility_unverified';
export type AdapterFailure = {
  readonly reason: AdapterFailureReason;
  readonly retryAfterMs?: number;
};
type ProviderDefinition = {
  readonly label: string;
  readonly integrationID: string;
  readonly fallbackIntegrationIDs?: readonly string[];
  readonly audiences: readonly QuotaAudience[];
  readonly scope: 'account' | 'selected_key' | 'team' | 'session';
  readonly methods: readonly ('key' | 'oauth' | 'cli')[];
  readonly source?: 'integration' | 'local-cli';
  readonly adapter?: 'anthropic' | 'chutes' | 'copilot' | 'deepseek' | 'google-agy' | 'alibaba-token-plan-cli' | 'kilo-gateway' | 'kimi-global' | 'kimi-cn' | 'minimax-global' | 'minimax-cn' | 'nanogpt' | 'ollama-cloud' | 'openai' | 'openrouter' | 'opencode-go' | 'opencode-zen' | 'synthetic' | 'xai-supergrok' | 'zai' | 'zhipu';
  readonly blockedReason?: 'unsupported' | 'private_endpoint' | 'eligibility_unverified' | 'runtime_accounting_unavailable' | 'cli_identity_unavailable';
};
/**
 * Closed provider/integration/method allowlist. Only rows with a reviewed
 * adapter may make a network request; remaining rows are explicitly blocked.
 * Audience lists describe the approved matrix and do not claim that account
 * type was inferred from credentials.
 */
export declare const QUOTA_PROVIDER_CATALOG: Record<QuotaProviderId, ProviderDefinition>;
export type AdapterResult = {
  readonly state: 'available';
  readonly metrics: QuotaMetric[];
  readonly routeKind?: 'api_key' | 'console_oauth';
} | (AdapterFailure & {
  readonly routeKind?: 'api_key' | 'console_oauth';
});
export declare function runQuotaAdapter(provider: QuotaProviderId, secret: string | undefined, shutdownSignal: AbortSignal, queryCli?: typeof queryAlibabaTokenPlanUsage, adapterContext?: QuotaAdapterContext, fallbackSecret?: string): Promise<AdapterResult>;
//#endregion
//# sourceMappingURL=quota-adapters.d.ts.map
