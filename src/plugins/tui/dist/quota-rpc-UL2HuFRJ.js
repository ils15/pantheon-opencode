import { Rpc } from "@opencode/plugin/promise/index";
//#region src/quota-rpc.ts
/** Full provider matrix approved for the V2 quota surface. */
const QUOTA_PROVIDER_IDS = [
	"anthropic",
	"chutes",
	"cursor",
	"github-copilot",
	"google-agy",
	"kilo-gateway",
	"nanogpt",
	"ollama-cloud",
	"openai",
	"opencode-go",
	"opencode-zen",
	"openrouter",
	"synthetic",
	"xai-supergrok",
	"gemini-cli",
	"alibaba-coding-plan",
	"alibaba-token-plan",
	"deepseek",
	"kimi-code-global",
	"kimi-code-cn",
	"minimax-plan-global",
	"minimax-plan-cn",
	"xiaomi-mimo",
	"zai-coding-plan",
	"zhipu-coding-plan"
];
const providerStatusSchema = {
	type: "object",
	properties: {
		provider: {
			type: "string",
			enum: QUOTA_PROVIDER_IDS
		},
		label: {
			type: "string",
			minLength: 1,
			maxLength: 48
		},
		scope: {
			type: "string",
			enum: [
				"account",
				"selected_key",
				"team",
				"session"
			]
		},
		authentication: {
			type: "string",
			enum: [
				"connected",
				"not_connected",
				"unavailable"
			]
		},
		state: {
			type: "string",
			enum: [
				"available",
				"needs_setup",
				"unavailable"
			]
		},
		reason: {
			type: "string",
			enum: [
				"none",
				"not_connected",
				"unsupported",
				"private_endpoint",
				"eligibility_unverified",
				"runtime_accounting_unavailable",
				"cli_identity_unavailable",
				"unsupported_credential_method",
				"provider_error",
				"not_subscribed",
				"rate_limited",
				"unauthorized",
				"forbidden",
				"timeout",
				"network_error",
				"invalid_response"
			]
		},
		route_kind: {
			type: "string",
			enum: [
				"api_key",
				"console_oauth",
				"none",
				"unsupported"
			]
		},
		retry_after_ms: {
			type: "integer",
			minimum: 0,
			maximum: 36e5
		},
		metrics: {
			type: "array",
			items: { oneOf: [
				{
					type: "object",
					properties: {
						kind: { const: "provider_quota" },
						used: {
							type: "number",
							minimum: 0
						},
						remaining: {
							type: "number",
							minimum: 0
						},
						unit: {
							type: "string",
							minLength: 1,
							maxLength: 16
						},
						label: {
							type: "string",
							minLength: 1,
							maxLength: 48
						},
						period: {
							type: "string",
							maxLength: 32
						},
						resetsAt: {
							type: "number",
							minimum: 0,
							maximum: 864e13
						}
					},
					required: [
						"kind",
						"used",
						"remaining",
						"unit",
						"label"
					],
					additionalProperties: false
				},
				{
					type: "object",
					properties: {
						kind: { const: "balance" },
						amount: {
							type: "number",
							minimum: 0
						},
						currency: {
							type: "string",
							enum: ["USD", "CNY"]
						},
						label: {
							type: "string",
							minLength: 1,
							maxLength: 48
						},
						status: {
							type: "string",
							enum: [
								"available",
								"unavailable",
								"active",
								"inactive"
							]
						}
					},
					required: [
						"kind",
						"amount",
						"currency",
						"label"
					],
					additionalProperties: false
				},
				{
					type: "object",
					properties: {
						kind: { const: "estimate" },
						amount: {
							type: "number",
							minimum: 0
						},
						unit: {
							type: "string",
							minLength: 1,
							maxLength: 16
						},
						label: {
							type: "string",
							minLength: 1,
							maxLength: 48
						}
					},
					required: [
						"kind",
						"amount",
						"unit",
						"label"
					],
					additionalProperties: false
				},
				{
					type: "object",
					properties: {
						kind: { const: "key_usage" },
						amount: {
							type: "number",
							minimum: 0
						},
						currency: {
							type: "string",
							enum: ["USD", "CNY"]
						},
						label: {
							type: "string",
							minLength: 1,
							maxLength: 48
						},
						period: {
							type: "string",
							maxLength: 32
						}
					},
					required: [
						"kind",
						"amount",
						"currency",
						"label"
					],
					additionalProperties: false
				},
				{
					type: "object",
					properties: {
						kind: { const: "session_usage" },
						amount: {
							type: "number",
							minimum: 0
						},
						unit: {
							type: "string",
							minLength: 1,
							maxLength: 16
						},
						label: {
							type: "string",
							minLength: 1,
							maxLength: 48
						}
					},
					required: [
						"kind",
						"amount",
						"unit",
						"label"
					],
					additionalProperties: false
				},
				{
					type: "object",
					properties: {
						kind: { const: "provider_status" },
						status: {
							type: "string",
							enum: [
								"available",
								"unavailable",
								"active",
								"inactive"
							]
						},
						label: {
							type: "string",
							minLength: 1,
							maxLength: 48
						}
					},
					required: [
						"kind",
						"status",
						"label"
					],
					additionalProperties: false
				}
			] },
			maxItems: 16
		}
	},
	required: [
		"provider",
		"label",
		"scope",
		"authentication",
		"state",
		"reason",
		"metrics"
	],
	additionalProperties: false
};
/** Shared definition keeps the TUI RPC client aligned with the server contract. */
const quotaRpc = Rpc.define({
	id: "pantheon.quota",
	methods: {
		go_key_diagnostic: {
			input: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: {
					category: {
						type: "string",
						enum: [
							"not_run",
							"already_used",
							"success",
							"unauthorized",
							"redirect",
							"http_error",
							"timeout",
							"network_error"
						]
					},
					status: {
						type: "integer",
						minimum: 100,
						maximum: 599
					},
					content_type: {
						type: "string",
						enum: [
							"application/json",
							"text/plain",
							"text/html",
							"other",
							"missing"
						]
					},
					error_structure: {
						type: "string",
						enum: [
							"present",
							"absent",
							"unavailable"
						]
					}
				},
				required: ["category"],
				additionalProperties: false
			}
		},
		status: {
			input: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: {
					providers: {
						type: "array",
						items: providerStatusSchema
					},
					credential_resolution_failed: { const: true }
				},
				required: ["providers"],
				additionalProperties: false
			}
		}
	},
	events: { credentials_changed: { schema: {
		type: "object",
		properties: {},
		additionalProperties: false
	} } }
});
//#endregion
export { quotaRpc as n, QUOTA_PROVIDER_IDS as t };

//# sourceMappingURL=quota-rpc-UL2HuFRJ.js.map
