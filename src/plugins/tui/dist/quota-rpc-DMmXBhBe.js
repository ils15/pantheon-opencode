import { n as USAGE_HISTORY_PERIODS } from "./usage-history-contract-nt1rnBPE.js";
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
const usageHistoryTotalsSchema = {
	type: "object",
	properties: {
		input: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		output: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		cacheRead: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		cacheWrite: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		total: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		}
	},
	required: [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"total"
	],
	additionalProperties: false
};
const usageHistoryBucketSchema = {
	type: "object",
	properties: {
		date: {
			type: "string",
			pattern: "^\\d{4}-\\d{2}-\\d{2}$"
		},
		input: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		output: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		cacheRead: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		cacheWrite: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		total: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		estimatedUsd: {
			type: "number",
			minimum: 0
		},
		pricingComplete: { type: "boolean" }
	},
	required: [
		"date",
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"total",
		"pricingComplete"
	],
	additionalProperties: false
};
const usageHistoryAvailableSchema = {
	type: "object",
	properties: {
		status: {
			type: "string",
			enum: ["available", "partial"]
		},
		period: {
			type: "string",
			enum: USAGE_HISTORY_PERIODS
		},
		coverageStart: {
			type: ["string", "null"],
			pattern: "^\\d{4}-\\d{2}-\\d{2}$"
		},
		partial: { type: "boolean" },
		truncated: { type: "boolean" },
		rows: {
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		},
		buckets: {
			type: "array",
			items: usageHistoryBucketSchema,
			maxItems: 366
		},
		totals: usageHistoryTotalsSchema,
		models: {
			type: "array",
			maxItems: 64,
			items: {
				type: "object",
				properties: {
					providerID: {
						type: "string",
						minLength: 1,
						maxLength: 128
					},
					modelID: {
						type: "string",
						minLength: 1,
						maxLength: 128
					},
					totals: usageHistoryTotalsSchema,
					estimatedUsd: {
						type: "number",
						minimum: 0
					},
					pricingComplete: { type: "boolean" }
				},
				required: [
					"providerID",
					"modelID",
					"totals",
					"pricingComplete"
				],
				additionalProperties: false
			}
		},
		pricing: {
			type: "object",
			properties: {
				status: {
					type: "string",
					enum: [
						"empty",
						"unavailable",
						"partial",
						"complete"
					]
				},
				complete: { type: "boolean" },
				billed: { const: false },
				estimatedUsd: {
					type: "number",
					minimum: 0
				},
				unpricedModels: {
					type: "integer",
					minimum: 0,
					maximum: Number.MAX_SAFE_INTEGER
				}
			},
			required: [
				"status",
				"complete",
				"billed",
				"unpricedModels"
			],
			additionalProperties: false
		}
	},
	required: [
		"status",
		"period",
		"coverageStart",
		"partial",
		"truncated",
		"rows",
		"buckets",
		"totals",
		"models",
		"pricing"
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
		},
		usage_history: {
			input: {
				type: "object",
				properties: { period: {
					type: "string",
					enum: USAGE_HISTORY_PERIODS
				} },
				required: ["period"],
				additionalProperties: false
			},
			output: { oneOf: [usageHistoryAvailableSchema, {
				type: "object",
				properties: {
					status: { const: "unavailable" },
					reason: {
						type: "string",
						enum: [
							"invalid_period",
							"history_unavailable",
							"history_timeout"
						]
					}
				},
				required: ["status", "reason"],
				additionalProperties: false
			}] }
		},
		active_context_cost: {
			input: {
				type: "object",
				properties: {
					providerID: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 128
					},
					modelID: {
						type: ["string", "null"],
						minLength: 1,
						maxLength: 128
					},
					contextTokens: { type: ["number", "null"] }
				},
				required: [
					"providerID",
					"modelID",
					"contextTokens"
				],
				additionalProperties: false
			},
			output: { oneOf: [{
				type: "object",
				properties: {
					status: { const: "estimated" },
					estimatedUsd: {
						type: "number",
						minimum: 0
					},
					billed: { const: false },
					basis: { const: "pre-cache-context-tokens-times-input-price" },
					cacheDiscountApplied: { const: false }
				},
				required: [
					"status",
					"estimatedUsd",
					"billed",
					"basis",
					"cacheDiscountApplied"
				],
				additionalProperties: false
			}, {
				type: "object",
				properties: {
					status: { const: "unavailable" },
					billed: { const: false },
					basis: { const: "pre-cache-context-tokens-times-input-price" },
					cacheDiscountApplied: { const: false },
					reason: {
						type: "string",
						enum: [
							"invalid-context-token-count",
							"missing-model-identity",
							"no-pricing",
							"unknown-model",
							"ambiguous-model",
							"missing-cache-price"
						]
					}
				},
				required: [
					"status",
					"billed",
					"basis",
					"cacheDiscountApplied",
					"reason"
				],
				additionalProperties: false
			}] }
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

//# sourceMappingURL=quota-rpc-DMmXBhBe.js.map
