import { createComponent, createElement, createTextNode, effect, insert, insertNode, memo, setProp } from "@opentui/solid";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { execFile } from "node:child_process";
import { Plugin } from "@opencode/plugin/tui";
//#region src/index-v2.tsx
/** @jsxImportSource @opentui/solid */
const SINGLETON = Symbol.for("pantheon.tui.v2.loaded");
/** How often the sidebar re-reads .pantheon/active-preset.json (V1 parity) so
*  `set-tier` changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 3e4;
/** Running-row spinner cadence — matches V1's animation tick. */
const SPINNER_INTERVAL_MS = 80;
/** Bounded warm-up: sync at most this many sessions at plugin load. */
const WARMUP_SESSION_LIMIT = 24;
/** Sidebar body shown while the host has not published a session yet. */
const SIDEBAR_WAITING_LABEL = "Aguardando sessão…";
/** Delegate-completion toast title. */
const TOAST_TITLE = "Pantheon";
/** Marker before the preset label (fixed header, home status, prompt footer).
*  `▸` U+25B8 is one cell; the previous bolt (U+26A1) carries
*  Emoji_Presentation and is measured as two cells, which misaligned the line. */
const PRESET_MARKER = "▸";
/** Git ahead / behind arrows (U+2191 / U+2193), one cell each — the glyphs the
*  reference sidebars use for `↑ahead ↓behind`. */
const GIT_ARROW_UP = "↑";
const GIT_ARROW_DOWN = "↓";
/** One event name the host publishes on `data.on` — the OpenCode V2 union. */
/** V2 events that refresh the sidebar. V1 also listened to `session.updated`,
*  but that name is absent from the OpenCode V2 event union (verified against
*  `@opencode/client`'s `OpenCodeEvent`), so the valid events that carry the
*  same state changes are used instead: `session.renamed` /
*  `session.metadata.updated` / `session.moved` (the mutations `session.updated`
*  used to stand for) and `session.idle` (a child finishing). `satisfies` keeps
*  the literals while making a name outside the union a type error (surfaced by
*  `tsc -p tsconfig.build.json`), and the sidebar test asserts the same names
*  against the installed union at runtime. */
const SIDEBAR_REFRESH_EVENTS = [
	"session.created",
	"session.renamed",
	"session.metadata.updated",
	"session.moved",
	"session.idle",
	"session.status",
	"session.deleted"
];
/** One `overrides.agents[<agent>]` entry from active-preset.json. */
/** The override map the CLI wrote into active-preset.json. */
/** A preset plus the explicit overrides stored next to it. */
function emptyOverrides() {
	return { agents: {} };
}
/** Keep only well-formed per-agent overrides: unknown keys are ignored and a
*  non-string model/variant is dropped instead of leaking into the render. */
function parsePresetOverrides(value) {
	const overrides = emptyOverrides();
	if (!value || typeof value !== "object") return overrides;
	const agents = value.agents;
	if (!agents || typeof agents !== "object") return overrides;
	for (const [agent, entry] of Object.entries(agents)) {
		if (agent === "" || !entry || typeof entry !== "object") continue;
		const model = entry.model;
		const variant = entry.variant;
		const override = {};
		if (typeof model === "string" && model !== "") override.model = model;
		if (typeof variant === "string" && variant !== "") override.variant = variant;
		if (override.model !== void 0 || override.variant !== void 0) overrides.agents[agent] = override;
	}
	return overrides;
}
/** Read .pantheon/active-preset.json — first existing candidate wins; malformed
*  JSON or a `preset` that is missing, empty or "none" → null (no fall-through
*  to lower candidates). The explicit per-agent overrides stored in the same
*  file come along so the sidebar can mark them with `*`. */
async function readActivePresetDetail(cwd) {
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	const candidates = [
		join(cwd, ".pantheon", "active-preset.json"),
		join(xdgConfig, "opencode", ".pantheon", "active-preset.json"),
		join(homedir(), ".opencode", ".pantheon", "active-preset.json")
	];
	for (const candidate of candidates) {
		let raw;
		try {
			raw = await readFile(candidate, "utf8");
		} catch {
			continue;
		}
		try {
			const parsed = JSON.parse(raw);
			const name = parsed && typeof parsed === "object" ? parsed.preset : void 0;
			if (typeof name !== "string" || name.length === 0 || name === "none") return null;
			return {
				info: {
					name,
					source: "file"
				},
				overrides: parsePresetOverrides(parsed.overrides)
			};
		} catch {
			return null;
		}
	}
	return null;
}
/** Env leg of resolution: PANTHEON_MODEL_PRESET set and !== 'none' wins. */
function presetFromEnv(env) {
	const name = env.PANTHEON_MODEL_PRESET;
	if (name !== void 0 && name !== "" && name !== "none") return {
		name,
		source: "env"
	};
	return {
		name: null,
		source: null
	};
}
/** Resolve the active preset plus its per-agent overrides: env > file > default.
*  An env-selected preset has no file overrides by construction. */
async function resolveActivePresetForTui(env, cwd) {
	const envPreset = presetFromEnv(env);
	if (envPreset.source === "env") return {
		info: envPreset,
		overrides: emptyOverrides()
	};
	return await readActivePresetDetail(cwd) ?? {
		info: {
			name: null,
			source: null
		},
		overrides: emptyOverrides()
	};
}
/** `SessionInfo.id` is always a `ses…` handle. Guarded so a placeholder or a
*  foreign id never reaches the status/navigate APIs. */
function isValidSessionID(id) {
	return typeof id === "string" && id.startsWith("ses");
}
function numberOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** Model reference shapes the host publishes: `ModelRef` objects, bare ids, or
*  `provider/model` strings. Returns the id part, never throws. */
function modelRefID(ref) {
	if (typeof ref === "string") return ref === "" ? null : ref;
	if (ref && typeof ref === "object") {
		const id = ref.id;
		if (typeof id === "string" && id !== "") return id;
	}
	return null;
}
/** Short display id: the segment after the last `/` (`opencode-go/kimi-k3` →
*  `kimi-k3`), truncated so a long id never wraps the sidebar. */
function shortModelID(ref, max = 24) {
	const id = modelRefID(ref);
	if (id === null) return null;
	const segment = id.slice(id.lastIndexOf("/") + 1);
	if (segment === "") return null;
	return segment.length > max ? `${segment.slice(0, Math.max(1, max - 1))}…` : segment;
}
/** `providerID` of a model reference, trimmed; null when absent/blank. Derived
*  only from what the host already published — never a lookup table. */
function providerIDFromRef(ref) {
	if (ref === null || typeof ref !== "object") return null;
	const providerID = ref.providerID;
	return typeof providerID === "string" && providerID.trim() !== "" ? providerID.trim() : null;
}
/** Provider for a bare-string model reference: match its id (or bare segment)
*  in the host model list. Null when the list cannot answer. */
function providerIDFromModels(models, ref) {
	if (!Array.isArray(models)) return null;
	const id = modelRefID(ref);
	if (id === null) return null;
	const segment = id.slice(id.lastIndexOf("/") + 1);
	for (const model of models) {
		if (!model || typeof model !== "object") continue;
		const modelID = typeof model.modelID === "string" ? model.modelID : "";
		const rowID = typeof model.id === "string" ? model.id : "";
		if (modelID !== id && rowID !== id && modelID !== segment && rowID !== segment) continue;
		const providerID = providerIDFromRef(model);
		if (providerID !== null) return providerID;
	}
	return null;
}
/** Resolve `model.limit.context` for a model reference. Match order: the
*  provider-qualified id, then the bare id (the host's `id`/`modelID` fields).
*  Absent/ambiguous models degrade to null so the gauge is simply omitted. */
function resolveContextLimit(models, ref) {
	const id = modelRefID(ref);
	if (id === null) return null;
	const providerID = ref && typeof ref === "object" ? ref.providerID : void 0;
	const segment = id.slice(id.lastIndexOf("/") + 1);
	const matches = models.filter((model) => {
		if (!model || typeof model !== "object") return false;
		const modelID = typeof model.modelID === "string" ? model.modelID : "";
		const rowID = typeof model.id === "string" ? model.id : "";
		if (!(modelID === id || rowID === id || modelID === segment || rowID === segment)) return false;
		if (typeof providerID !== "string" || providerID === "") return true;
		return model.providerID === providerID;
	});
	const candidates = matches.length > 0 ? matches : models.filter((model) => {
		const modelID = typeof model?.modelID === "string" ? model.modelID : "";
		const rowID = typeof model?.id === "string" ? model.id : "";
		return modelID === segment || rowID === segment;
	});
	for (const model of candidates) {
		const limit = model?.limit?.context;
		if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) return limit;
	}
	return null;
}
/** Native token total: input + output + reasoning + cache read + cache write. */
function messageTokensTotal(tokens) {
	const cacheRead = numberOrNull(tokens?.cache?.read) ?? 0;
	const cacheWrite = numberOrNull(tokens?.cache?.write) ?? 0;
	return (numberOrNull(tokens?.input) ?? 0) + (numberOrNull(tokens?.output) ?? 0) + (numberOrNull(tokens?.reasoning) ?? 0) + cacheRead + cacheWrite;
}
/** The part of a transcript that still counts: everything before the revert
*  boundary (when a revert is active), then after the last compaction. Both
*  derived numbers that read "the last assistant with usage" — the context
*  gauge and the cache hit rate — share this window, so a reverted-away or
*  compacted-away message can never feed either one. Pure. */
function transcriptWindow(messages, revertMessageID) {
	let end = messages.length;
	if (typeof revertMessageID === "string" && revertMessageID !== "") {
		const boundary = messages.findIndex((message) => message?.id === revertMessageID);
		if (boundary >= 0) end = boundary;
	}
	let start = 0;
	for (let index = end - 1; index >= 0; index--) if (messages[index]?.type === "compaction") {
		start = index + 1;
		break;
	}
	return {
		start,
		end
	};
}
/** Context usage for a message list. Scope: the live window (see
*  `transcriptWindow`). The last assistant message carrying `tokens` in that
*  window wins. Null when there is no limit or no such message — the caller
*  then omits the block. */
function computeContextUsage(messages, contextLimit, revertMessageID) {
	const limit = numberOrNull(contextLimit);
	if (limit === null || limit <= 0) return null;
	if (!Array.isArray(messages) || messages.length === 0) return null;
	const { start, end } = transcriptWindow(messages, revertMessageID);
	for (let index = end - 1; index >= start; index--) {
		const message = messages[index];
		if (message?.type !== "assistant" || !message.tokens) continue;
		const tokens = messageTokensTotal(message.tokens);
		if (!Number.isFinite(tokens) || tokens <= 0) continue;
		return {
			tokens,
			percent: Math.round(tokens / limit * 100),
			limit
		};
	}
	return null;
}
/** Semantic tone for a context percentage, inclusive at the top of each band:
*  info (blue) up to 25%, success (green) up to 50%, warning (yellow) up to
*  90%, error (red) above it. Four explicit stages, each backed by a feedback
*  token, so the gauge follows the active theme. Pure. */
function contextUsageTone(percent) {
	if (percent > 90) return "error";
	if (percent > 50) return "warning";
	if (percent > 25) return "success";
	return "info";
}
/** The gauge's four stages, one per theme feedback token. */
/** Color for one gauge stage. Filled cells and the percent value both come from
*  this one call, so the bar and its number can never disagree. `theme` is the
*  host's resolved theme (loosely typed at runtime); a missing token falls back
*  to the theme's base text instead of an unstyled cell. Pure. */
function contextProgressColor(stage, theme) {
	return theme?.text?.feedback?.[stage]?.base ?? theme?.text?.base;
}
/** The muted extra line under the gauge: `cache 92% · 42.3 tok/s`. Either half
*  may be missing (no cache read, no measurable turn); no data at all yields
*  null so no empty line is rendered. The speed keeps the host's own one
*  decimal and `tok/s` label. Pure. */
function contextPerformanceLine(performance) {
	if (!performance) return null;
	const parts = [];
	const cacheHit = numberOrNull(performance.cacheHit);
	if (cacheHit !== null) parts.push(`cache ${Math.round(cacheHit)}%`);
	const tokensPerSecond = numberOrNull(performance.tokensPerSecond);
	if (tokensPerSecond !== null) parts.push(`${tokensPerSecond.toFixed(1)} tok/s`);
	return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR);
}
/** Cache hit rate of one message: `cache.read / (input + cache.read)` as a
*  percentage. The denominator must be > 0, otherwise the ratio is meaningless
*  (a message that only wrote to the cache has no input to hit). Null when the
*  numbers are absent. Pure. */
function cacheHitPercent(tokens) {
	const read = numberOrNull(tokens?.cache?.read);
	const input = numberOrNull(tokens?.input);
	if (read === null || input === null) return null;
	const denominator = input + read;
	if (!(denominator > 0)) return null;
	return read / denominator * 100;
}
/** The message the cache hit rate comes from: the last assistant of the live
*  window (see `transcriptWindow`) that actually carries `tokens`. Later
*  messages without usage — a streaming placeholder that the host publishes
*  before any step completes, a step that reports no usage — are skipped
*  instead of blanking a ratio the previous message already measured. Null
*  when nothing in the window has usage. Pure. */
function lastAssistantWithTokens(messages, revertMessageID) {
	if (!Array.isArray(messages) || messages.length === 0) return null;
	const { start, end } = transcriptWindow(messages, revertMessageID);
	for (let index = end - 1; index >= start; index--) {
		const message = messages[index];
		if (message?.type !== "assistant" || !message.tokens) continue;
		return message;
	}
	return null;
}
/** Tokens per second of the current turn. Mirrors the host's
*  `turnTokensPerSecond` (anomalyco/opencode v2.0.30,
*  `packages/tui/src/routes/session/rows.ts`) so the sidebar and the native
*  session footer can never disagree: the numerator is `output + reasoning`
*  summed over every assistant step of the turn and the denominator is the
*  summed active streaming time `max(0, time.streamed - time.created)`, so the
*  division happens once, after aggregating — each step weighs by its own
*  duration instead of each step voting equally. `completed` is never used; a
*  turn with a step that has no `time.streamed` has no measurable speed. The
*  turn starts after the last `user` message; with no user message only the
*  last assistant step counts (degraded: there is no boundary to group by).
*  Pure and fail-open. */
function turnTokensPerSecond(messages, position) {
	if (!Array.isArray(messages) || messages.length === 0) return null;
	let anchor = -1;
	if (typeof position === "number" && Number.isInteger(position) && position >= 0 && position < messages.length) anchor = position;
	else for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.type === "assistant") {
		anchor = index;
		break;
	}
	if (anchor === -1 || messages[anchor]?.type !== "assistant") return null;
	let start = -1;
	for (let index = anchor - 1; index >= 0; index--) if (messages[index]?.type === "user") {
		start = index;
		break;
	}
	const steps = start === -1 ? [messages[anchor]] : messages.slice(start + 1, anchor + 1).filter((item) => item?.type === "assistant");
	if (steps.length === 0) return null;
	let output = 0;
	let duration = 0;
	for (const step of steps) {
		output += (numberOrNull(step?.tokens?.output) ?? 0) + (numberOrNull(step?.tokens?.reasoning) ?? 0);
		const created = numberOrNull(step?.time?.created);
		const streamed = numberOrNull(step?.time?.streamed);
		if (created === null || streamed === null) return null;
		duration += Math.max(0, streamed - created);
	}
	if (output <= 0 || duration <= 0) return null;
	const rate = output / (duration / 1e3);
	return Number.isFinite(rate) && rate > 0 ? rate : null;
}
/** Last-message telemetry the Context block renders in muted text. Both halves
*  are optional; the block renders no line when neither is available. */
/** Thousands-separated token total: `55320` → `55,320` (en-US, matching the
*  native block this one replaces). Null for a missing/invalid value. Pure. */
function formatTokenCount(tokens) {
	const value = numberOrNull(tokens);
	if (value === null || value < 0) return null;
	return Math.round(value).toLocaleString("en-US");
}
/** Context-window label: `1_000_000` → `1.0M`, `200_000` → `200K`,
*  `128_000` → `128K`, `32_768` → `32K`. Sub-million limits truncate to whole K
*  so the printed window never overstates the model's capacity. Pure. */
function formatContextWindow(limit) {
	const value = numberOrNull(limit);
	if (value === null || value <= 0) return null;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${Math.floor(value / 1e3)}K`;
	return `${Math.floor(value)}`;
}
/** Cells in the Context gauge: always rendered in full, so the bar never
*  changes width between refreshes. With the space, the percent and the
*  `of <window>` tail (at most 9 columns) the line stays inside 34 columns. */
const CONTEXT_BAR_CELLS = 12;
/** Filled cell (U+25B0) and empty cell (U+25B1), both single-width. */
const CONTEXT_BAR_FILLED_CELL = "▰";
const CONTEXT_BAR_EMPTY_CELL = "▱";
/** Filled cells for a percentage: rounded, clamped to `0..cells`, so 0% is an
*  empty bar and anything at or above 100% is a full one. Pure. */
function contextBarFilled(percent, cells = 12) {
	const total = Math.max(1, Math.floor(cells));
	const filled = Math.round(percent / 100 * total);
	if (!Number.isFinite(filled)) return 0;
	return Math.min(total, Math.max(0, filled));
}
/** The gauge split into its toned half (filled cells) and its muted half (empty
*  cells), so the caller colors each side. Null when the percentage is missing:
*  the Context block then keeps its tokens + cost rows and renders no bar. Pure. */
function contextBar(percent, cells = 12) {
	const value = numberOrNull(percent);
	if (value === null) return null;
	const total = Math.max(1, Math.floor(cells));
	const filled = contextBarFilled(value, total);
	return {
		filled: "▰".repeat(filled),
		empty: "▱".repeat(total - filled)
	};
}
/** USD spent with two decimals (`$0.18`), the native block's format. Null for
*  a missing/negative value. Pure. */
function formatSpent(cost) {
	const value = numberOrNull(cost);
	if (value === null || value < 0) return null;
	return `$${value.toFixed(2)}`;
}
/** One rendered context row. `lead` and `tail` carry the gauge bar when the row
*  has one (`lead` is toned with the value, `tail` is muted), so the 12 cells
*  stay contiguous while the empty half still reads as background. */
/** The `Context` block's data rows; null rows are not rendered. */
/** Rows for the `Context` block:
*  `<tokens> tokens` / `▰▰▰▰▰▱▱▱▱▱▱▱ <percent>% of <window>` /
*  `$<spent> spent`. The percentage row carries the only semantic tone, the
*  gauge bar (12 cells) and is omitted entirely when the percentage is
*  unavailable (never `undefined%`). A block with neither tokens nor cost
*  yields null. Pure. */
function contextBlockRows(usage, cost) {
	const spentValue = formatSpent(cost);
	const spent = spentValue === null ? null : {
		lead: null,
		value: spentValue,
		tail: null,
		suffix: " spent",
		tone: null
	};
	if (usage === null) return spent === null ? null : {
		tokens: null,
		percent: null,
		spent
	};
	const tokensValue = formatTokenCount(usage.tokens);
	const tokens = tokensValue === null ? null : {
		lead: null,
		value: tokensValue,
		tail: null,
		suffix: " tokens",
		tone: null
	};
	const percentValue = numberOrNull(usage.percent);
	const window = formatContextWindow(usage.limit);
	const bar = contextBar(percentValue);
	const percent = bar === null || percentValue === null ? null : {
		lead: bar.filled,
		value: ` ${Math.round(percentValue)}%`,
		tail: bar.empty,
		suffix: window === null ? null : ` of ${window}`,
		tone: contextUsageTone(percentValue)
	};
	if (tokens === null && percent === null && spent === null) return null;
	return {
		tokens,
		percent,
		spent
	};
}
/** Models rendered in the Context block before the aggregate `… +N` line. */
const MODEL_USAGE_VISIBLE_CEILING = 3;
/** Newest messages read per session — bounds the O(n) walk on long sessions. */
const MODEL_USAGE_MESSAGE_LIMIT = 400;
/** Sessions read per family (root + delegations) for the aggregate. */
const MODEL_USAGE_SESSION_LIMIT = 8;
/** Column widths for one model row (labels are muted, numbers right-aligned). */
const MODEL_USAGE_MODEL_WIDTH = 12;
const MODEL_USAGE_TOKEN_WIDTH = 6;
const MODEL_USAGE_COST_WIDTH = 8;
/** Session events arrive in bursts; model rows are recomputed at most once
*  per window (same cadence as the git-count revalidation). */
const MODEL_USAGE_DEBOUNCE_MS = 400;
/** Real usage for one model, summed across the assistant messages that used it. */
/** Totals per model from assistant messages: sums `cost` and `tokens`, drops
*  models whose real cost is 0/absent, and orders by cost (then tokens, then
*  name). `providerID` participates in the key so two providers exposing the
*  same bare id are not merged. Pure. */
function collectModelUsage(messages) {
	if (!Array.isArray(messages)) return [];
	const totals = /* @__PURE__ */ new Map();
	for (const message of messages) {
		if (message?.type !== "assistant") continue;
		const id = modelRefID(message.model);
		const model = shortModelID(message.model, 12);
		if (id === null || model === null) continue;
		const key = `${typeof message.model?.providerID === "string" ? message.model.providerID : ""}\u0000${id}`;
		const tokenCount = message.tokens ? messageTokensTotal(message.tokens) : 0;
		const cost = numberOrNull(message.cost) ?? 0;
		const current = totals.get(key);
		if (current) {
			current.tokens += Math.max(0, tokenCount);
			current.cost += Math.max(0, cost);
		} else totals.set(key, {
			model,
			tokens: Math.max(0, tokenCount),
			cost: Math.max(0, cost)
		});
	}
	return [...totals.values()].filter((row) => row.cost > 0).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model));
}
/** Visible rows plus the aggregate of the models that did not fit. Pure. */
/** Cap the model list at `maxVisible`; the rest is aggregated (still real
*  totals) for the `… +N` line. Pure. */
function ceilingModelUsage(rows, maxVisible = 3) {
	const limit = Math.max(0, maxVisible);
	const visible = rows.slice(0, limit);
	const rest = rows.slice(visible.length);
	return {
		visible,
		hidden: rest.length,
		hiddenCost: rest.reduce((sum, row) => sum + row.cost, 0),
		hiddenTokens: rest.reduce((sum, row) => sum + row.tokens, 0)
	};
}
/** Compact tokens for a model row (`80,000` → `80K`); `0` stays explicit. Pure. */
function formatUsageTokens(tokens) {
	const value = numberOrNull(tokens);
	if (value === null || value <= 0) return "0";
	return formatContextWindow(value) ?? String(Math.round(value));
}
/** Real per-model cost with adaptive precision: cents for `>= $0.01`, up to
*  four decimals below that (a real `$0.0031` must not render as `$0.00`), and
*  an explicit `< $0.0001` for the remainder. Pure. */
function formatUsageCost(cost) {
	const value = numberOrNull(cost);
	if (value === null || value < 0) return null;
	if (value === 0) return "$0.00";
	if (value >= .01) return `$${value.toFixed(2)}`;
	if (value >= 1e-4) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
	return "<$0.0001";
}
/** One formatted model row: truncated label + compact tokens + real cost. */
/** Format the visible model rows for rendering. Labels are already short ids
*  (12 chars); the second truncation only guards host drift. Pure. */
function modelUsageRows(rows) {
	return rows.map((row) => ({
		model: truncateLabel(row.model, 12),
		tokens: formatUsageTokens(row.tokens),
		cost: formatUsageCost(row.cost) ?? "$0.00"
	}));
}
/** Exact single-line text of a model row, with numbers right-aligned. Pure. */
function modelUsageRowText(row) {
	return `${row.model.padEnd(12)}  ${row.tokens.padStart(6)}  ${row.cost.padStart(8)}`;
}
/** Muted aggregate line for the models beyond the cap (`… +2  $0.03`). Null
*  when every model fits. Pure. */
function hiddenModelUsageText(hidden, hiddenCost) {
	if (!Number.isFinite(hidden) || hidden <= 0) return null;
	const cost = formatUsageCost(hiddenCost);
	return cost === null ? `… +${hidden}` : `… +${hidden}  ${cost}`;
}
/** Bucket for a session the host published without an agent id. */
const UNKNOWN_AGENT = "?";
/** Agent key of a session or message: the trimmed id when it is a non-empty
*  string, else the `?` bucket — never `undefined`. Pure. */
function agentKey(value) {
	if (typeof value !== "string") return "?";
	const text = value.trim();
	return text === "" ? "?" : text;
}
/** One rendered todo row. `priority` is carried by the tool but not rendered:
*  the reference block uses a single marker column. */
/** Rows rendered before the `… +N` line. */
const TODO_VISIBLE_CEILING = 6;
/** Content width before the ellipsis — the block has ~30-34 usable columns. */
const TODO_TEXT_WIDTH = 28;
/** Row markers (`•` in progress, `−` cancelled with U+2212, as in the git row). */
const TODO_MARKERS = {
	in_progress: "[•]",
	pending: "[ ]",
	completed: "[x]",
	cancelled: "[−]"
};
/** Group order: live work first, then open, then closed. */
const TODO_STATUS_ORDER = [
	"in_progress",
	"pending",
	"completed",
	"cancelled"
];
/** Narrow a loose `status` value to the tool's four states. */
function isTodoStatus(value) {
	return value === "in_progress" || value === "pending" || value === "completed" || value === "cancelled";
}
/** Items from a `todowrite` `input` payload. A missing/malformed `input`,
*  absent `todos`, an unknown `status` or an empty/missing `content` drops the
*  entry instead of throwing; a list with nothing readable yields `[]`. Pure. */
function parseTodoItems(input) {
	const raw = input?.todos;
	if (!Array.isArray(raw)) return [];
	const items = [];
	for (const entry of raw) {
		const content = entry?.content;
		const status = entry?.status;
		if (typeof content !== "string" || content.trim() === "") continue;
		if (!isTodoStatus(status)) continue;
		items.push({
			content: content.trim(),
			status
		});
	}
	return items;
}
/** Newest completed `todowrite` in a transcript. The tool replaces the list
*  wholesale, so the last write wins; a write with `todos: []` returns null
*  (the block disappears rather than showing the previous list) and a
*  not-yet-completed write is ignored. Null when the transcript carries no
*  such part, so the block never renders a guess. Pure. */
function latestTodoItems(messages) {
	if (!Array.isArray(messages)) return null;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
		const parts = message.content;
		for (let position = parts.length - 1; position >= 0; position--) {
			const part = parts[position];
			if (part?.type !== "tool" || part?.name !== "todowrite") continue;
			if (part?.state?.status !== "completed") continue;
			const items = parseTodoItems(part.state.input);
			return items.length === 0 ? null : items;
		}
	}
	return null;
}
/** Stable group order (in_progress → pending → completed → cancelled); within a
*  group the transcript order is preserved. Pure. */
function orderTodoItems(items) {
	return [...items].sort((a, b) => TODO_STATUS_ORDER.indexOf(a.status) - TODO_STATUS_ORDER.indexOf(b.status));
}
/** Row color channel: `accent` for live work, `muted` for closed items, base
*  for pending. Kept separate from the theme so it is testable. Pure. */
/** Tone for one status — no rainbow, a single accent. Pure. */
function todoTone(status) {
	if (status === "in_progress") return "accent";
	if (status === "completed" || status === "cancelled") return "muted";
	return "base";
}
/** Exact rendered text of one row: `[•] <content truncated to 28>`. Pure. */
function todoRowText(item) {
	return `${TODO_MARKERS[item.status]} ${truncateLabel(item.content, 28)}`;
}
/** Ordered rows capped for the sidebar, plus how many did not fit. Pure. */
/** Order then cap the list at `maxVisible`. Pure. */
function ceilingTodoItems(items, maxVisible = 6) {
	const ordered = orderTodoItems(items);
	const visible = ordered.slice(0, Math.max(0, maxVisible));
	return {
		visible,
		hidden: Math.max(0, ordered.length - visible.length)
	};
}
/** Overflow line (`… +3`); null when every item fits. Pure. */
function hiddenTodoText(hidden) {
	if (!Number.isFinite(hidden) || hidden <= 0) return null;
	return `… +${Math.round(hidden)}`;
}
/** Narrow a `VcsFileStatus["status"]` value read off a loose payload. */
function isGitChangeStatus(value) {
	return value === "added" || value === "modified" || value === "deleted";
}
/** Files per status from a `VcsFileStatus[]` payload. Unknown statuses and
*  malformed entries are ignored. Pure. */
function countGitChanges(files) {
	const counts = {
		added: 0,
		modified: 0,
		deleted: 0
	};
	if (!Array.isArray(files)) return counts;
	for (const entry of files) {
		const status = entry?.status;
		if (isGitChangeStatus(status)) counts[status] += 1;
	}
	return counts;
}
/** `+1 ±2 −3` for the file counts; each zero term is omitted, and an empty
*  change set returns null so the row is not rendered at all. Pure. */
function formatGitChanges(files) {
	const { added, modified, deleted } = countGitChanges(files);
	const parts = [];
	if (added > 0) parts.push(`+${added}`);
	if (modified > 0) parts.push(`±${modified}`);
	if (deleted > 0) parts.push(`\u2212${deleted}`);
	return parts.length === 0 ? null : parts.join(" ");
}
/** Wall-clock ceiling for one git call. A stuck git (index lock, network
*  filesystem) is killed instead of holding the row forever. */
const GIT_CLI_TIMEOUT_MS = 2e3;
/** Session events arrive in bursts; a git probe is scheduled at most once per
*  window instead of once per event. */
const GIT_CLI_DEBOUNCE_MS = 1e3;
/** Minimum spacing between two probe starts. Five seconds keeps a chatty event
*  stream from spawning a git process per step while staying fresh enough to
*  show a file appearing mid-turn. */
const GIT_CLI_MIN_INTERVAL_MS = 5e3;
/** Stdout ceiling for one git call. `status --porcelain=v1 -uall` lists every
*  untracked file, so a large worktree easily passes the 1 MB `execFile`
*  default — which would reject and silently hand the row back to the
*  `vcs.status` fallback. 4 MB is far above a realistic porcelain listing. */
const GIT_CLI_MAX_BUFFER = 4194304;
/** One `execFile` call: `(file, args, options) → { stdout }`. Injectable so the
*  parsing/gating logic is testable without spawning processes. */
/** Default runner: the promisified `node:child_process.execFile`. A non-zero
*  exit (no repository, no upstream) rejects and the caller decides. */
const defaultGitExec = (file, args, options) => new Promise((resolve, reject) => {
	execFile(file, [...args], {
		cwd: options.cwd,
		timeout: options.timeout,
		windowsHide: options.windowsHide,
		maxBuffer: options.maxBuffer
	}, (error, stdout) => {
		if (error) reject(error);
		else resolve({ stdout: typeof stdout === "string" ? stdout : String(stdout ?? "") });
	});
});
/** Files per status from `git status --porcelain=v1 -uall`, including the two
*  columns the protocol cannot report. Each line starts with `XY` (index and
*  worktree state); a rename prints `R  old -> new`, and `??` / `!!` are
*  untracked / ignored. Precedence per file: deleted > added > modified, so
*  `AM` counts once as added and `AD` once as deleted. Renames, copies and
*  unmerged entries count as modified. Pure. */
/** Parse porcelain v1 output into file counts. Empty/malformed output yields
*  zero counts (a clean tree), never a throw. Pure. */
function parseGitStatusPorcelain(output) {
	const counts = {
		added: 0,
		modified: 0,
		deleted: 0,
		untracked: 0
	};
	if (typeof output !== "string" || output === "") return counts;
	for (const line of output.split("\n")) {
		if (line.length < 2) continue;
		const index = line[0];
		const worktree = line[1];
		if (index === "!" && worktree === "!") continue;
		if (index === "?" && worktree === "?") {
			counts.untracked += 1;
			continue;
		}
		if (index === " " && worktree === " ") continue;
		if (index === "D" || worktree === "D") counts.deleted += 1;
		else if (index === "A" || worktree === "A") counts.added += 1;
		else counts.modified += 1;
	}
	return counts;
}
/** `git rev-list --count --left-right @{upstream}...HEAD` prints two numbers:
*  commits only on the upstream (behind) then commits only on HEAD (ahead).
*  Null when the output is not that pair — e.g. the command failed because the
*  branch has no upstream, in which case the arrows are simply omitted. Pure. */
function parseGitAheadBehind(output) {
	if (typeof output !== "string") return null;
	const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output);
	if (match === null) return null;
	const behind = Number(match[1]);
	const ahead = Number(match[2]);
	if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
	return {
		ahead,
		behind
	};
}
/** One git observation: file counts plus the upstream distance (either arrow
*  may be unknown when the branch has no upstream). */
/** One probe: `git status --porcelain=v1 -uall` for the counts, then
*  `git rev-list --count --left-right @{upstream}...HEAD` for the arrows (a
*  failure there only drops the arrows). A status failure rejects — the caller
*  then falls back to `client.vcs.status`. */
async function readGitSnapshot(directory, exec = defaultGitExec) {
	const options = {
		cwd: directory,
		timeout: GIT_CLI_TIMEOUT_MS,
		windowsHide: true,
		maxBuffer: GIT_CLI_MAX_BUFFER
	};
	const changes = parseGitStatusPorcelain((await exec("git", [
		"status",
		"--porcelain=v1",
		"-uall"
	], options))?.stdout);
	let ahead = null;
	let behind = null;
	try {
		const parsed = parseGitAheadBehind((await exec("git", [
			"rev-list",
			"--count",
			"--left-right",
			"@{upstream}...HEAD"
		], options))?.stdout);
		if (parsed !== null) {
			ahead = parsed.ahead;
			behind = parsed.behind;
		}
	} catch {}
	return {
		changes,
		ahead,
		behind
	};
}
/** Rendered git row: `+1 ±2 −1 ?2 ↑3 ↓1`, zero terms omitted. Null when the
*  tree is clean and in sync, so the block keeps only its branch line. Pure. */
function formatGitSnapshot(snapshot) {
	if (!snapshot?.changes) return null;
	const { added, modified, deleted, untracked } = snapshot.changes;
	const parts = [];
	if (added > 0) parts.push(`+${added}`);
	if (modified > 0) parts.push(`±${modified}`);
	if (deleted > 0) parts.push(`\u2212${deleted}`);
	if (untracked > 0) parts.push(`?${untracked}`);
	if ((snapshot.ahead ?? 0) > 0) parts.push(`↑${snapshot.ahead}`);
	if ((snapshot.behind ?? 0) > 0) parts.push(`↓${snapshot.behind}`);
	return parts.length === 0 ? null : parts.join(" ");
}
/** Whether a new probe may start. An in-flight probe always wins (no queue), and
*  the previous start must be older than the cooldown. Pure. */
function gitProbeAllowed(state, cooldownMs = GIT_CLI_MIN_INTERVAL_MS) {
	if (state.inFlight) return false;
	if (state.lastRunAt === null) return true;
	const elapsed = state.now - state.lastRunAt;
	return !Number.isFinite(elapsed) || elapsed >= cooldownMs;
}
/** Spend window labels, in render order. */
const SPEND_TODAY_LABEL = "hoje";
const SPEND_30D_LABEL = "30d";
/** Separator between the two windows on the Context footer line. */
const SPEND_LINE_SEPARATOR = " · ";
/** `30d` window: 30 × 24 h, measured back from "now". */
const SPEND_30D_MS = 2592e6;
/** Probe window: one hour, narrow enough that a unit mix-up cannot line up. */
const SPEND_PROBE_WINDOW_MS = 36e5;
/** The echoed `range` may be rounded server-side; 120 s absorbs that. */
const SPEND_PROBE_TOLERANCE_MS = 12e4;
/** Session events arrive in bursts — same 400 ms window as the other blocks. */
const SPEND_REFRESH_DEBOUNCE_MS = 400;
/** Spend per window in USD. Either side may be unknown (kept `null`). */
/** `from`/`to` unit accepted by the route. `SessionStatsInput` declares both as
*  bare `number` and does not say which unit, so it is measured once per
*  process (`ms` unless the server echoes seconds) instead of guessed. */
/** Resolved unit for this process; `null` until the mount probe answers. */
let spendUnit = null;
/** In-flight probe, so two refreshes cannot each burn the 2-call budget. */
let spendProbe = null;
/** Test-only: forget the process-wide unit resolution. Never called at runtime. */
function resetSpendUnit() {
	spendUnit = null;
	spendProbe = null;
}
/** Resolved unit (`ms` / `s` / `unavailable`) or null while still unknown. */
function resolvedSpendUnit() {
	return spendUnit;
}
/** Local midnight for `now`: `new Date()` with the clock fields zeroed in the
*  current timezone (DST-safe, unlike subtracting hours). Pure. */
function startOfLocalDay(now) {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}
/** The two windows the block shows: `hoje` (local midnight → now) and `30d`
*  (now − 30 days → now). Pure. */
function spendWindows(now) {
	return {
		today: {
			from: startOfLocalDay(now),
			to: now
		},
		thirtyDays: {
			from: now - SPEND_30D_MS,
			to: now
		}
	};
}
/** USD with two decimals (`$0.42`), four for a positive sub-cent amount
*  (`$0.0031`), and `<$0.0001` when even four decimals would read `$0.0000`.
*  `0` prints `$0.00`. Null for a missing/negative/non-finite value. Pure. */
function formatSpendUSD(cost) {
	const value = numberOrNull(cost);
	if (value === null || value < 0) return null;
	if (value === 0) return "$0.00";
	if (value >= .01) return `$${value.toFixed(2)}`;
	const cents = value.toFixed(2);
	if (cents !== "0.00") return `$${cents}`;
	const cents4 = value.toFixed(4);
	return cents4 === "0.0000" ? "<$0.0001" : `$${cents4}`;
}
/** `cost` off a `SessionStatsInfo` (`MoneyUSD` = number) or null when the
*  payload is malformed/negative, so a bad value never reaches a row. Pure. */
function statsCost(result) {
	const cost = numberOrNull(result?.cost);
	return cost !== null && cost >= 0 ? cost : null;
}
/** True when the server echoed the window we sent, within 120 s. `scale` is how
*  many milliseconds one unit of the sent window is worth (`1` for `ms`, `1000`
*  for `s`). The echo is accepted either as the same numbers we sent (the route
*  keeps the caller's unit) or converted to millisecond epoch (`DateTime.Utc`),
*  so the probe pins the unit without assuming which of the two it gets. Pure. */
function statsRangeMatches(range, sent, scale) {
	const from = numberOrNull(range?.from);
	const to = numberOrNull(range?.to);
	if (from === null || to === null) return false;
	const tolerance = SPEND_PROBE_TOLERANCE_MS / scale;
	const sameUnit = Math.abs(from - sent.from) <= tolerance && Math.abs(to - sent.to) <= tolerance;
	const asMilliseconds = Math.abs(from - sent.from * scale) <= 12e4 && Math.abs(to - sent.to * scale) <= 12e4;
	return sameUnit || asMilliseconds;
}
/** The `Context` block's last line: both spend windows on one muted row
*  (`hoje $0.42 · 30d $9.80`). A window without a usable amount is omitted, and
*  no usable window at all yields null so the line (and not the block) is
*  dropped. Pure. */
function contextSpendLine(totals) {
	if (totals === null) return null;
	const parts = [];
	const today = formatSpendUSD(totals.today);
	if (today !== null) parts.push(`${SPEND_TODAY_LABEL} ${today}`);
	const thirtyDays = formatSpendUSD(totals.thirtyDays);
	if (thirtyDays !== null) parts.push(`30d ${thirtyDays}`);
	return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR);
}
/** Grapheme iterator: a cut never splits a surrogate pair, a combining mark
*  from its base or a ZWJ emoji sequence, so truncation stays cell-exact. */
const GRAPHEMES = new Intl.Segmenter(void 0, { granularity: "grapheme" });
/** A grapheme the host draws two cells wide: emoji presentation, an extended
*  pictograph (a bare `❤` counts too, exactly as the host's `emoji-regex`
*  does) and a regional-indicator pair (a flag). */
const EMOJI_GLYPH = /\p{Emoji_Presentation}|\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
/** VS16 asks for emoji presentation; without it `1` is one cell, with it the
*  keycap sequence is drawn as one two-cell glyph. */
const EMOJI_PRESENTATION_SELECTOR = "️";
/** Unicode default-ignorable code points carry no width of their own. */
const IGNORABLE_GLYPH = /^\p{Default_Ignorable_Code_Point}$/u;
/** East Asian Wide/Fullwidth ranges — two cells, never the ambiguous width
*  (the host measures ambiguous as narrow, so `▸`/`✓`/`—` stay one cell).
*  Generated from the host's own measurement (`string-width` over every code
*  point, emoji excluded), so this table can be regenerated verbatim when the
*  host upgrades its Unicode data instead of being hand-edited. */
const CELL_WIDE_RANGES = [
	[4352, 4446],
	[9001, 9002],
	[9776, 9783],
	[9866, 9871],
	[11904, 11929],
	[11931, 12019],
	[12032, 12245],
	[12272, 12335],
	[12337, 12348],
	[12350, 12350],
	[12353, 12438],
	[12441, 12543],
	[12549, 12591],
	[12593, 12643],
	[12645, 12686],
	[12688, 12773],
	[12783, 12830],
	[12832, 12871],
	[12880, 12950],
	[12952, 12952],
	[12954, 42124],
	[42128, 42182],
	[43360, 43388],
	[44032, 55203],
	[63744, 64255],
	[65040, 65049],
	[65072, 65106],
	[65108, 65126],
	[65128, 65131],
	[65281, 65376],
	[65504, 65510],
	[94176, 94180],
	[94192, 94198],
	[94208, 101594],
	[101631, 101664],
	[101760, 101874],
	[101888, 102801],
	[102816, 102866],
	[110576, 110579],
	[110581, 110587],
	[110589, 110590],
	[110592, 110888],
	[110898, 110898],
	[110928, 110930],
	[110933, 110933],
	[110948, 110952],
	[110960, 111355],
	[119552, 119638],
	[119648, 119670],
	[127488, 127488],
	[127504, 127513],
	[127515, 127534],
	[127536, 127537],
	[127547, 127547],
	[127552, 127560],
	[127584, 127589],
	[131072, 196605],
	[196608, 262141]
];
/** One code point the terminal draws no cell for: control characters, the
*  zero-width joiners/marks, combining marks and variation selectors. */
function isZeroWidthCodePoint(code, glyph) {
	if (code <= 31 || code >= 127 && code <= 159) return true;
	if (code >= 8203 && code <= 8207) return true;
	if (code === 65279) return true;
	if (code >= 768 && code <= 879) return true;
	if (code >= 6832 && code <= 6911) return true;
	if (code >= 7616 && code <= 7679) return true;
	if (code >= 8400 && code <= 8447) return true;
	if (code >= 65024 && code <= 65039) return true;
	if (code >= 65056 && code <= 65071) return true;
	if (code >= 917760 && code <= 917999) return true;
	if (code >= 55296 && code <= 57343) return true;
	return IGNORABLE_GLYPH.test(glyph);
}
function isWideCodePoint(code) {
	for (const [low, high] of CELL_WIDE_RANGES) {
		if (code < low) return false;
		if (code <= high) return true;
	}
	return false;
}
/** Cells one grapheme occupies. */
function graphemeWidth(segment) {
	if (EMOJI_GLYPH.test(segment)) return 2;
	if (segment.length > 1 && segment.includes(EMOJI_PRESENTATION_SELECTOR)) return 2;
	let width = 0;
	for (const glyph of segment) {
		const code = glyph.codePointAt(0) ?? 0;
		if (isZeroWidthCodePoint(code, glyph)) continue;
		width += isWideCodePoint(code) ? 2 : 1;
	}
	return width;
}
/** Terminal cells `value` occupies — the unit every column in this plugin is
*  measured in. Mirrors the host (that is how `@opentui/core` sizes a text
*  run): emoji count as two cells, East Asian Wide/Fullwidth as two, East
*  Asian Ambiguous as one, combining marks and variation selectors as none.
*  Pure. */
function cellWidth(value) {
	let width = 0;
	for (const { segment } of GRAPHEMES.segment(value)) width += graphemeWidth(segment);
	return width;
}
/** Clamp a free-form label to `max` terminal cells without wrapping. The width
*  is measured in display cells, never in UTF-16 code units: a CJK or emoji
*  label used to overflow the column it was cut for (`計画の移行` is 5 code
*  units but 10 cells, `🚀` is 2 units and 2 cells). Pure. */
function truncateLabel(value, max = 28) {
	const text = value.trim();
	const budget = Math.max(1, Math.floor(numberOrNull(max) ?? 1));
	if (cellWidth(text) <= budget) return text;
	const ellipsis = "…";
	const room = budget - cellWidth(ellipsis);
	let cut = "";
	let used = 0;
	for (const { segment } of GRAPHEMES.segment(text)) {
		const width = cellWidth(segment);
		if (used + width > room) break;
		cut += segment;
		used += width;
	}
	return `${cut.replace(/\s+$/, "")}${ellipsis}`;
}
/** Right-pad `value` with spaces to exactly `cells` display columns (a wider
*  value is truncated first). `padEnd` counts code units, so it under-pads a
*  CJK/emoji cell and the next column drifts. Pure. */
function padCell(value, cells) {
	const width = Math.max(0, Math.floor(numberOrNull(cells) ?? 0));
	if (width === 0) return "";
	const text = truncateLabel(value, width);
	return `${text}${" ".repeat(Math.max(0, width - cellWidth(text)))}`;
}
/** Columns the fixed header may use before it would wrap the sidebar. */
const HEADER_MAX_WIDTH = 34;
/** Preset row of the fixed header: `▸ <preset> · <provider>`. The provider is
*  cut first when the row overflows, so the preset name is never the casualty;
*  a missing provider leaves the preset alone (no `unknown` placeholder). */
function presetHeaderLine(presetName, providerID) {
	const base = `▸ ${presetName.trim() === "" ? "default" : presetName.trim()}`;
	const provider = providerID === null ? "" : providerID.trim();
	if (provider === "") return truncateLabel(base, 34);
	const room = 34 - `${base} · `.length;
	if (room < 2) return truncateLabel(base, 34);
	return `${base} · ${truncateLabel(provider, room)}`;
}
/** One classification plus the evidence that produced it. */
/** Bracketed description prefix → short label (`[council]` → `coun`). */
const DISPATCH_PREFIX_KINDS = [
	["council", "coun"],
	["discovery", "disc"],
	["hotfix", "hot"],
	["plan", "plan"],
	["review", "revw"]
];
/** Agent → kind, consulted only when the description declares no prefix.
*  `council` is deliberately absent — see the section comment. */
const DISPATCH_AGENT_KINDS = {
	apollo: "disc",
	athena: "plan",
	talos: "hot",
	themis: "revw"
};
/** Kind declared by a leading `[prefix]` on the description: case-insensitive
*  and tolerant of spaces inside the brackets. Null when none is declared. */
function dispatchKindFromPrefix(description) {
	if (typeof description !== "string") return null;
	const match = /^\s*\[\s*([a-z]+)\s*\]/i.exec(description);
	if (match === null) return null;
	const token = (match[1] ?? "").toLowerCase();
	for (const [word, kind] of DISPATCH_PREFIX_KINDS) if (word === token) return kind;
	return null;
}
/** Kind implied by the child's agent, null for an agent that implies none. */
function dispatchKindFromAgent(agent) {
	if (typeof agent !== "string") return null;
	return DISPATCH_AGENT_KINDS[agent.trim().toLowerCase()] ?? null;
}
/** Classify one dispatch. The description prefix always wins over the agent;
*  otherwise the agent decides, and anything else is `oth` (a real dispatch we
*  simply cannot name). A missing call is the only `unavailable` outcome. Pure. */
function classifyDispatchKind(call) {
	if (call === null || call === void 0) return {
		kind: null,
		origin: "unavailable"
	};
	const fromPrefix = dispatchKindFromPrefix(call.description);
	if (fromPrefix !== null) return {
		kind: fromPrefix,
		origin: "prefix"
	};
	return {
		kind: dispatchKindFromAgent(call.agent) ?? "oth",
		origin: "agent"
	};
}
/** A `subagent` tool call the parent made, as its own transcript records it. */
/** Host tool that spawns a child (V2 name; it is not `task`). */
const SUBAGENT_TOOL = "subagent";
/** The tool result also names its child: `<subagent sessionID="ses_…" …>`. */
const SUBAGENT_SESSION_PATTERN = /sessionID="([^"]+)"/;
/** Text of a tool `content` payload, joined; tolerant of the string form. */
function toolContentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const chunks = [];
	for (const part of content) {
		const text = part?.text;
		if (typeof text === "string") chunks.push(text);
	}
	return chunks.join("\n");
}
/** Child session id of one `subagent` call: the exact `metadata.sessionID`
*  first, then an `output`/`result` id, then the `<subagent sessionID="…">` tag
*  in the result text. Null when the call has not produced a child yet. */
function subagentSessionID(state) {
	const direct = [
		state?.metadata?.sessionID,
		state?.output?.sessionID,
		state?.result?.sessionID
	];
	for (const candidate of direct) if (typeof candidate === "string" && candidate !== "") return candidate;
	return SUBAGENT_SESSION_PATTERN.exec(toolContentText(state?.content))?.[1] ?? null;
}
/** Correlate the parent transcript's `subagent` calls with the children they
*  spawned: child session id → `{ agent, description, background }`. One pass
*  over the list the sidebar already holds — no request, no `message.sync` on
*  the child. `streaming`/`pending` states carry their input as *partial JSON
*  text*, so they are skipped rather than parsed. Fail-open: a malformed part
*  contributes nothing. Pure. */
function collectSubagentCalls(messages) {
	const calls = /* @__PURE__ */ new Map();
	if (!Array.isArray(messages)) return calls;
	for (const message of messages) {
		if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part?.type !== "tool" || part?.name !== SUBAGENT_TOOL) continue;
			const state = part.state;
			if (state === null || typeof state !== "object") continue;
			if (state.status === "streaming" || state.status === "pending") continue;
			const sessionID = subagentSessionID(state);
			if (!isValidSessionID(sessionID)) continue;
			const input = state.input !== null && typeof state.input === "object" ? state.input : {};
			const agent = typeof input.agent === "string" ? input.agent : "";
			const description = typeof input.description === "string" ? input.description : "";
			calls.set(sessionID, {
				sessionID,
				agent,
				description,
				background: input.background === true
			});
		}
	}
	return calls;
}
/** Grace window for a child that has not started yet. V2's `session.status()`
*  returns `idle` both for "created but not started" and for "finished", so an
*  idle/unknown/absent child whose own last activity (`time.updated`, falling
*  back to `time.created`) is this recent still reads as running — otherwise a
*  just-spawned child renders a premature ✓. Trade-off (V1 parity: it had the
*  same window for its absent statuses): a child that finished within the window
*  and reports no `outcome` reads as running until the window closes, at which
*  point it turns terminal and its completion toast fires. A child that reports
*  a terminal `outcome` is never held back by the window. */
const DELEGATION_CHILD_STATUS_GRACE_MS = 6e4;
/** One delegated child job as the sidebar renders it. */
/** Map the host's live session status to a display state. V2 exposes only
*  `"idle" | "running"` through the TUI context (the client union adds `retry`
*  and `busy`); `error`/`failed` are handled defensively for host drift.
*  `idle`, `retry` and unknown/absent statuses are terminal only once the
*  child's own activity is older than the grace window — within it the child
*  reads as running (see `DELEGATION_CHILD_STATUS_GRACE_MS`). An interruption is
*  not part of this union: it arrives as a terminal `outcome`. Pure. */
function delegationStateFromStatus(status, time, now = Date.now(), graceMs = DELEGATION_CHILD_STATUS_GRACE_MS) {
	switch (status) {
		case "running":
		case "busy": return "running";
		case "error":
		case "failed": return "failed";
		default: {
			const lastActivity = Math.max(time?.updated ?? 0, time?.created ?? 0);
			if (lastActivity > 0 && now - lastActivity < graceMs) return "running";
			return "completed";
		}
	}
}
/** Map a V2 child `outcome` to a display state. `interrupted` (user abort,
*  shutdown, superseded, inactivity) is distinct from both success and failure,
*  so an aborted child never renders the ✓ of a completed one. Returns null for
*  an absent/unrecognised outcome so the live status decides. Pure. */
function delegationStateFromOutcome(outcome) {
	switch (outcome) {
		case "succeeded": return "completed";
		case "failed": return "failed";
		case "interrupted": return "interrupted";
		default: return null;
	}
}
/** Build a delegation row from a child session + its live status, plus the
*  `subagent` call that spawned it (when the parent transcript had one). A
*  terminal `outcome` wins when present (the only V2 primitive that surfaces a
*  delegation failure/interruption once the status is back to idle); otherwise
*  the live status decides, with the absent/idle grace window applied. The
*  `call` only ever *adds* the purpose and the background flag — an absent one
*  leaves the row fully renderable. Pure. */
function toDelegationView(child, status, now = Date.now(), call) {
	const id = typeof child?.id === "string" ? child.id : "";
	const title = typeof child?.title === "string" && child.title !== "" ? child.title : "";
	const agent = typeof child?.agent === "string" && child.agent !== "" ? child.agent : "";
	const label = title !== "" ? title : agent !== "" ? agent : id.slice(0, 8);
	const state = delegationStateFromOutcome(child?.outcome) ?? delegationStateFromStatus(status, child?.time, now);
	const classification = classifyDispatchKind(call);
	return {
		id,
		label,
		state,
		startedAt: numberOrNull(child?.time?.created),
		updatedAt: numberOrNull(child?.time?.updated),
		agent: agent !== "" ? agent : null,
		model: shortModelID(child?.model),
		cost: numberOrNull(child?.cost),
		kind: classification.kind,
		kindOrigin: classification.origin,
		background: call?.background === true
	};
}
const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏"
];
/** Spinner glyph for a frame counter (incremented every ~80ms while any job is
*  running). Pure. */
function spinnerFrame(frame) {
	const index = Math.abs(Math.floor(frame)) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}
/** Shared order: live work first, then most recent activity. One comparator for
*  every consumer of the dispatch tree (sidebar block and panel list), so the
*  two views can never disagree about which child comes first. Pure. */
function compareDelegations(a, b) {
	const activeA = a.state === "running" ? 1 : 0;
	const activeB = b.state === "running" ? 1 : 0;
	if (activeA !== activeB) return activeB - activeA;
	return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}
/** Token totals published on `SessionInfo.tokens`, one entry per counter. */
/** One child of the dispatch tree: the delegation row plus the fields only the
*  panel's detail view needs (`SessionInfo.title`/`parentID`/`tokens` and the
*  spawning call's description). */
/** Optional inputs of `collectDispatch`: a fixed clock (tests/render ticks) and
*  an already-computed `agent` map, so a caller that walked the parent
*  transcript anyway never pays for a second walk. */
/** `message.list` of one session, degrades to an empty list. The host's list is
*  a cached directory read, not a request. */
function readSessionMessages(context, sessionID) {
	try {
		const result = context?.data?.session?.message?.list?.(sessionID);
		return Array.isArray(result) ? result : [];
	} catch {
		return [];
	}
}
/** Token counters of a child, null when the host published none of them. Pure. */
function dispatchTokens(tokens) {
	if (tokens === null || typeof tokens !== "object") return null;
	const source = tokens;
	const cache = source.cache !== null && typeof source.cache === "object" ? source.cache : {};
	const totals = {
		input: numberOrNull(source.input),
		output: numberOrNull(source.output),
		reasoning: numberOrNull(source.reasoning),
		cacheRead: numberOrNull(cache.read),
		cacheWrite: numberOrNull(cache.write)
	};
	return [
		totals.input,
		totals.output,
		totals.reasoning,
		totals.cacheRead,
		totals.cacheWrite
	].every((value) => value === null) ? null : totals;
}
/** One child `SessionInfo` + its live status → `DispatchEntry`. The call only
*  ever adds the kind and the description; an absent one leaves the entry fully
*  renderable. Pure. */
function toDispatchEntry(child, status, now = Date.now(), call) {
	const title = typeof child?.title === "string" && child.title !== "" ? child.title : null;
	const parentID = typeof child?.parentID === "string" && child.parentID !== "" ? child.parentID : null;
	const description = typeof call?.description === "string" && call.description !== "" ? call.description : null;
	return {
		view: toDelegationView(child, status, now, call),
		title,
		description,
		parentID,
		tokens: dispatchTokens(child?.tokens)
	};
}
/** The delegation tree of `sessionID` — every child `session.family` returns,
*  root excluded, each enriched from `session.get`/`session.status` and the
*  parent's `subagent` calls. Empty when the family API is unavailable or the
*  session id is not a real handle (never falls back to the root). Ordered by
*  the shared `compareDelegations`, so callers render the same list in the same
*  order. A family that repeats an id yields one row per child: the id is
*  deduplicated before the walk, so a duplicate can never double a row or its
*  cost. */
function collectDispatch(context, sessionID, options = {}) {
	if (!isValidSessionID(sessionID)) return [];
	let family = [];
	try {
		const result = context?.data?.session?.family?.(sessionID);
		if (Array.isArray(result)) family = result;
	} catch {
		return [];
	}
	const now = numberOrNull(options.now) ?? Date.now();
	const calls = options.calls ?? collectSubagentCalls(readSessionMessages(context, sessionID));
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const childID of family) {
		if (childID === sessionID || !isValidSessionID(childID)) continue;
		if (seen.has(childID)) continue;
		seen.add(childID);
		let child;
		try {
			child = context.data.session.get(childID);
		} catch {
			continue;
		}
		if (!child) continue;
		entries.push(toDispatchEntry(child, sessionStatusOf(context, childID), now, calls.get(childID) ?? null));
	}
	return entries.sort((a, b) => compareDelegations(a.view, b.view));
}
/** Sidebar blocks in render order. Spacing is derived from this list instead of
*  from the view, so a hidden block can never leave an empty gap behind. */
/** One rendered block: its key, and whether a blank line precedes it. */
/** Header glyph per block — one codepoint each, rendered muted before the bold
*  label. The fixed header (version/preset/session) takes none.
*  Measured as one terminal cell by the host (`@opentui/core` counts
*  `emoji-regex` matches as two): ▤ U+25A4 (EAW=A), ◆ U+25C6 (A), ▾ U+25BE (N),
*  ◈ U+25C8 (A). `☑` U+2611 was rejected for the Todo header because it matches
*  `emoji-regex` and would occupy two cells; `⌁` U+2301 (the old Dispatch glyph)
*  was replaced by the host's own Notice glyph. */
const BLOCK_ICONS = {
	context: "▤",
	git: "◆",
	todo: "▾",
	dispatch: "◈"
};
/** Tag every block that has content with its spacer: never before the first
*  (the view puts a single blank line after the fixed header instead), one
*  blank line before every later block. A repeated key collapses instead of
*  stacking spacers, so an absent optional block can never leave a double gap.
*  Pure. */
function withBlockSpacers(keys) {
	const seen = /* @__PURE__ */ new Set();
	const blocks = [];
	for (const key of keys) {
		if (seen.has(key)) continue;
		seen.add(key);
		blocks.push({
			key,
			spacer: blocks.length > 0
		});
	}
	return blocks;
}
/** Live children rendered one row each; the rest collapse into `… +N rodando`. */
const DISPATCH_RUNNING_CEILING = 3;
/** Agent rollup rows rendered before the `… +K  $<soma>` line. */
const DISPATCH_AGENT_CEILING = 3;
/** Hard cap on the block's rendered rows, header included. The sidebar is
*  short; live work is served first, then the finished rollup. */
const DISPATCH_MAX_LINES = 8;
/** Marker of the aggregated "finished" section. */
const DISPATCH_DONE_MARKER = "✓";
/** Column width of the agent (or of its title/id fallback). */
const DISPATCH_AGENT_WIDTH = 12;
/** Narrowest agent column a row may fall back to before the cost is kept whole
*  and the label truncates further. */
const DISPATCH_MIN_AGENT_WIDTH = 8;
/** Column width of the short model id — the model is dropped before the agent
*  or the cost so a row always fits. */
const DISPATCH_MODEL_WIDTH = 7;
/** Column width of the per-dispatch cost (`$0.04`; a sub-cent cost widens it). */
const DISPATCH_COST_WIDTH = 5;
/** Column width of the duration (`12.7s` / `1m04s` / `820ms`). */
const DISPATCH_DURATION_WIDTH = 5;
/** Column width of the `×<count>` cell of an agent rollup row. */
const DISPATCH_COUNT_WIDTH = 3;
/** Column width of an agent rollup cost (`$0.0051` still fits). */
const DISPATCH_GROUP_COST_WIDTH = 7;
/** Hard column budget for one row — a Dispatch line never wraps:
*  marker(2) + agent(12) + model(7) + cost(5) + duration(5) + 3 spaces = 34.
*  The kind suffix (`·disc`, `·disc~`) is wider evidence than the model, so a
*  classified row spends the model's columns first: marker(2) + agent(≤12) +
*  suffix(≤6) + cost(5) + duration(5) + 2 spaces ≤ 32, still inside 34. */
const DISPATCH_MAX_WIDTH = 34;
/** Middle dot used between a label and its kind (`apollo·disc`). */
const DISPATCH_KIND_SEPARATOR = "·";
/** Background marker: the parent asked the child to run in the background. */
const DISPATCH_BACKGROUND_MARKER = "~";
/** Kind suffix glued to a row's label: `·disc`, `·disc~` for a background run,
*  and empty when the child could not be classified (the row then reads exactly
*  as before). Pure. */
function dispatchKindSuffix(kind, background) {
	if (kind === null || kind === void 0) return "";
	const text = `${DISPATCH_KIND_SEPARATOR}${kind}`;
	return background === true ? `${text}${DISPATCH_BACKGROUND_MARKER}` : text;
}
/** Header summary: `2 rodando · $3.49`. The live count is omitted when nothing
*  runs, and the total spend is always printed (the header only renders while
*  the tree has children, so `$0.00` is a real answer). Pure. */
function dispatchHeaderSummary(running, cost) {
	const parts = [];
	const live = numberOrNull(running) ?? 0;
	if (live > 0) parts.push(`${Math.round(live)} rodando`);
	const formatted = formatSpendUSD(numberOrNull(cost) ?? 0);
	if (formatted !== null) parts.push(formatted);
	return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR);
}
/** Compact duration without an internal space: `820` → `820ms`, `12_400` →
*  `12.4s`, `64_000` → `1m04s`, `3_780_000` → `1h03m`, `172_800_000` → `2d`.
*  An absent or negative value renders an em dash, never `NaN`s. Pure. */
function formatDispatchDuration(ms) {
	const value = numberOrNull(ms);
	if (value === null || value < 0) return "—";
	if (value < 1e3) return `${Math.round(value)}ms`;
	const seconds = value / 1e3;
	if (seconds < 59.95) return `${seconds.toFixed(1)}s`;
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	if (hours >= 24) return `${Math.floor(hours / 24)}d`;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
}
/** Elapsed label for one row: a live child measures `now - created`, a finished
*  one freezes at `updated - created` (em dash when a timestamp is missing).
*  Pure. */
function dispatchElapsed(view, now = Date.now()) {
	if (view.startedAt === null) return "—";
	if (view.state === "running") return formatDispatchDuration(now - view.startedAt);
	if (view.updatedAt === null) return "—";
	return formatDispatchDuration(view.updatedAt - view.startedAt);
}
/** Name column: the agent when the host published one, else the child title,
*  else the short id — never `undefined`. Truncated to the column width. Pure. */
function dispatchAgentText(view, max = 12) {
	const agent = typeof view.agent === "string" ? view.agent.trim() : "";
	const label = typeof view.label === "string" ? view.label.trim() : "";
	const id = typeof view.id === "string" ? view.id.trim() : "";
	const name = agent !== "" ? agent : label !== "" ? label : id;
	return name === "" ? "—" : truncateLabel(name, max);
}
/** Model column, empty when the host published none. Pure. */
function dispatchModelText(view) {
	const model = typeof view.model === "string" ? view.model.trim() : "";
	return model === "" ? "" : truncateLabel(model, 7);
}
/** Cost column: the child's real `SessionInfo.cost` with two decimals (up to
*  four below a cent, so `$0.0031` never collapses to `$0.00`), `$0.00` for a
*  zero cost, and an em dash when the host published no numeric cost. Pure. */
function formatDispatchCost(cost) {
	return formatUsageCost(cost) ?? "—";
}
/** Total spend of every child (live + finished), `0` when none published a
*  numeric cost. Pure. */
function dispatchTotalCost(views) {
	let total = 0;
	for (const view of views ?? []) {
		const cost = numberOrNull(view?.cost);
		if (cost !== null && cost >= 0) total += cost;
	}
	return total;
}
/** One live child: `⠸ <agent 12>·<kind> <custo> <duração>`, with the model as a
*  fourth column only when the row still fits and the child is unclassified —
*  the kind is the stronger evidence at this width, so it takes the model's
*  columns. The kind rides glued to the label (never a column of its own) and
*  disappears with the label's truncation; then the agent column shrinks (never
*  below `DISPATCH_MIN_AGENT_WIDTH`); the cost is always present — `$0.00` for a
*  zero cost, an em dash for a missing one. Pure. */
function runningChildRowText(view, now = Date.now(), frame = 0, max = 34) {
	const marker = `${spinnerFrame(frame)} `;
	const duration = dispatchElapsed(view, now).padStart(5);
	const cost = formatDispatchCost(view.cost).padStart(5);
	const model = dispatchModelText(view);
	const suffix = dispatchKindSuffix(view.kind, view.background);
	const limit = Math.max(1, max);
	const row = (agentWidth, withModel, withSuffix = true) => {
		const kind = withSuffix ? suffix : "";
		const name = dispatchAgentText(view, agentWidth);
		const cell = kind === "" ? name.padEnd(agentWidth) : `${name}${kind}`;
		const tail = withModel ? `${model.padEnd(7)} ${cost} ${duration}` : `${cost} ${duration}`;
		return `${marker}${cell} ${tail}`;
	};
	if (model !== "" && suffix === "") {
		const withModel = row(12, true);
		if (withModel.length <= limit) return withModel;
	}
	const full = row(12, false);
	if (full.length <= limit) return full;
	for (let width = 11; width >= 8; width -= 1) {
		const narrowed = row(width, false);
		if (narrowed.length <= limit) return narrowed;
	}
	if (suffix !== "") return row(8, false, false);
	return row(8, false);
}
/** Sessions and spend attributed to one agent in the finished section. `kind`
*  is only set when every finished session of the group agrees on it — a mixed
*  group carries no single purpose, so the row omits it rather than picking one.
*  `background` follows the same rule (all of them background). */
/** Rollup of the finished children by agent: `×count` sessions and the summed
*  `SessionInfo.cost`. Failed and interrupted children are included (they are
*  finished); running ones are not. The group's kind survives only when the
*  whole group agrees, so an aggregate row never claims a purpose it cannot
*  prove. Ordered by cost, then count, then name. Pure. */
function collectChildAgentUsage(views) {
	const totals = /* @__PURE__ */ new Map();
	for (const view of views ?? []) {
		if (!view || view.state === "running") continue;
		const agent = agentKey(view.agent);
		const current = totals.get(agent) ?? {
			agent,
			count: 0,
			cost: 0,
			kinds: /* @__PURE__ */ new Set(),
			background: true
		};
		current.count += 1;
		current.kinds.add(view.kind ?? null);
		if (view.background !== true) current.background = false;
		const cost = numberOrNull(view.cost);
		if (cost !== null && cost >= 0) current.cost += cost;
		totals.set(agent, current);
	}
	return [...totals.values()].map((entry) => {
		const shared = entry.kinds.size === 1 ? [...entry.kinds][0] ?? null : null;
		return {
			agent: entry.agent,
			count: entry.count,
			cost: entry.cost,
			kind: shared,
			background: entry.background
		};
	}).sort((a, b) => b.cost - a.cost || b.count - a.count || a.agent.localeCompare(b.agent));
}
/** One agent rollup row: `<agent 12> ×<count 3>·<kind> <custo 7>`. The kind is
*  glued to the count (the row's only label) and omitted for a mixed group; the
*  agent column shrinks (never below the minimum) before the cost, which is
*  what the row is for. Pure. */
function childAgentRowText(row, max = 34) {
	const suffix = dispatchKindSuffix(row?.kind, row?.background);
	const count = `\u00D7${String(Math.max(0, Math.round(numberOrNull(row?.count) ?? 0))).padStart(3)}`;
	const cost = formatDispatchCost(row?.cost).padStart(7);
	const limit = Math.max(1, max);
	const text = (agentWidth, withSuffix = true) => {
		const kind = withSuffix ? suffix : "";
		return `${truncateLabel(agentKey(row?.agent), agentWidth).padEnd(agentWidth)} ${count}${kind} ${cost}`;
	};
	const full = text(12);
	if (full.length <= limit) return full;
	for (let width = 11; width >= 8; width -= 1) {
		const narrowed = text(width);
		if (narrowed.length <= limit) return narrowed;
	}
	if (suffix !== "") return text(8, false);
	return text(8);
}
/** The `… +K  $<soma>` line for agents beyond the rollup cap. Null when every
*  agent fits. Pure. */
function hiddenChildAgentsText(hidden, hiddenCost) {
	const count = numberOrNull(hidden) ?? 0;
	if (count <= 0) return null;
	const cost = formatSpendUSD(numberOrNull(hiddenCost) ?? 0);
	return cost === null ? `\u2026 +${Math.round(count)}` : `\u2026 +${Math.round(count)}  ${cost}`;
}
/** Summary of the finished section: `✓ 70 · $3.40 · 9 agentes`. `· $<soma>` is
*  omitted when nothing was spent and `· 1 agente` when a single agent owns
*  every finished child; `✓ <total>` always prints. Null when nothing finished.
*  Pure. */
function completedSummaryText(completed, cost, agents) {
	const total = numberOrNull(completed) ?? 0;
	if (total <= 0) return null;
	const parts = [`✓ ${Math.round(total)}`];
	const spend = numberOrNull(cost) ?? 0;
	if (spend > 0) {
		const formatted = formatSpendUSD(spend);
		if (formatted !== null) parts.push(formatted);
	}
	const groups = Math.round(numberOrNull(agents) ?? 0);
	if (groups > 1) parts.push(`${groups} agentes`);
	return parts.join(SPEND_LINE_SEPARATOR);
}
/** The `· <F> falhas` suffix of the finished summary, null when nothing failed.
*  Pure. */
function failedSuffixText(failures) {
	const count = numberOrNull(failures) ?? 0;
	if (count <= 0) return null;
	const rounded = Math.round(count);
	return `${rounded} ${rounded === 1 ? "falha" : "falhas"}`;
}
/** One rendered live row: its text plus the session it navigates to. */
/** Everything the `Dispatch` block renders, already joined and capped. */
/** Newest activity first, so the live rows that just moved lead the section.
*  Pure. */
function lastActivity(view) {
	return Math.max(numberOrNull(view?.updatedAt) ?? 0, numberOrNull(view?.startedAt) ?? 0);
}
/** Build the whole block from the child set. Null when there is no child, so
*  the block (and its spacer) never renders empty. Live work is capped at
*  `DISPATCH_RUNNING_CEILING` and the finished rollup at
*  `DISPATCH_AGENT_CEILING`, with the rollup giving up rows first to keep the
*  block inside `DISPATCH_MAX_LINES`. Pure. */
function buildDispatchBlock(views, now = Date.now(), frame = 0, max = 34) {
	const list = Array.isArray(views) ? views.filter((view) => view && typeof view.id === "string") : [];
	if (list.length === 0) return null;
	const running = list.filter((view) => view.state === "running").sort((a, b) => lastActivity(b) - lastActivity(a));
	const finished = list.filter((view) => view.state !== "running");
	const groups = collectChildAgentUsage(finished);
	const finishedCost = groups.reduce((sum, group) => sum + group.cost, 0);
	const failures = finished.filter((view) => view.state === "failed").length;
	const totalCost = dispatchTotalCost(list);
	const runningSlots = Math.min(3, running.length);
	const runningHidden = running.length - runningSlots;
	const runningLines = running.map((view) => ({
		id: view.id,
		text: runningChildRowText(view, now, frame, max)
	}));
	const summary = completedSummaryText(finished.length, finishedCost, groups.length);
	const runningRows = runningSlots + (runningHidden > 0 ? 1 : 0);
	const room = Math.max(0, 7 - runningRows - (summary === null ? 0 : 1));
	const wanted = Math.min(3, groups.length);
	const agentSlots = groups.length > wanted ? Math.min(wanted, Math.max(0, room - 1)) : Math.min(wanted, room);
	const visibleAgents = groups.slice(0, agentSlots);
	const hiddenAgents = groups.slice(agentSlots);
	return {
		runningCount: running.length,
		completedCount: finished.length,
		agentCount: groups.length,
		failures,
		totalCost,
		running: runningLines.slice(0, runningSlots),
		runningHidden,
		summary,
		agents: visibleAgents,
		agentsHidden: hiddenAgents.length,
		agentsHiddenCost: hiddenAgents.reduce((sum, group) => sum + group.cost, 0)
	};
}
/** Panel content name, registered by the `session.panel` claim and passed to
*  `ui.panel.open`. */
const DISPATCH_PANEL_NAME = "pantheon.dispatch";
/** Toast shown when `ui.panel.open` refuses (no session route is active). The
*  panel only exists inside a session, so there is no alternative route. */
const DISPATCH_PANEL_TOAST = "Abra uma sessão para ver o Dispatch";
/** Panel title marker — the same glyph the sidebar block header uses. */
const DISPATCH_PANEL_HEADER_MARKER = "◈";
/** Selected-row gutter marker (`▸`, one cell). */
const DISPATCH_PANEL_SELECTION_MARKER = "▸";
/** Cells the selection gutter occupies before a row's own text. */
const DISPATCH_PANEL_SELECTION_GUTTER = 2;
/** Column of the horizontal rule under the header. */
const DISPATCH_PANEL_RULE_CHAR = "─";
/** Em dash for any datum the host did not publish. */
const DISPATCH_PANEL_DASH = "—";
/** Body of an empty panel (the claim still renders, the list is just empty). */
const DISPATCH_PANEL_EMPTY_TEXT = "Nenhuma sessão delegada";
/** Width at or above which the list and the detail sit side by side. */
const DISPATCH_PANEL_WIDE_MIN_WIDTH = 72;
/** Rows the viewport holds; pageup/pagedown move by exactly this many rows. */
const DISPATCH_PANEL_PAGE_SIZE = 10;
/** Panel row columns: marker(2) + agent(12) + kind(4) + cost(≥7) + duration(8).
*  The cost column is at least this wide; a sub-cent cost widens it per row. */
const DISPATCH_PANEL_AGENT_WIDTH = 12;
const DISPATCH_PANEL_MIN_AGENT_WIDTH = 6;
const DISPATCH_PANEL_KIND_WIDTH = 4;
const DISPATCH_PANEL_COST_WIDTH = 7;
const DISPATCH_PANEL_DURATION_WIDTH = 8;
/** Title column budget (`◈ Dispatch — <sessão>`). */
const DISPATCH_PANEL_TITLE_WIDTH = 44;
/** Badge appended to the title while the host presents the panel full screen. */
const DISPATCH_PANEL_FULLSCREEN_BADGE = "[fullscreen]";
/** Columns a row spends before the agent cell, cost column excluded
*  (2 marker + 1 + 4 kind + 1 + 8 duration). The cost is measured per row
*  because `<$0.0001` is one cell wider than `DISPATCH_PANEL_COST_WIDTH`. */
const DISPATCH_PANEL_ROW_FIXED_WIDTH = 16;
/** Human labels of a kind's evidence, as the detail line prints them. */
const DISPATCH_KIND_ORIGIN_LABELS = {
	prefix: "prefixo",
	agent: "agente",
	unavailable: "indisponível"
};
/** Entries in row order: live work first, then most recent activity — the same
*  comparator the sidebar block uses. Pure. */
function orderDispatchEntries(entries) {
	return [...entries].sort((a, b) => compareDelegations(a.view, b.view));
}
/** `◈ Dispatch — <sessão>`, with the session title truncated (never wrapped),
*  plus the `[fullscreen]` badge while the host presents the panel full screen.
*  An absent title leaves the marker and the name alone. Pure. */
function dispatchPanelTitle(sessionTitle, max = 44, presentation) {
	const base = `◈ Dispatch`;
	const badge = presentation === "fullscreen" ? ` ${DISPATCH_PANEL_FULLSCREEN_BADGE}` : "";
	const title = typeof sessionTitle === "string" ? sessionTitle.trim() : "";
	if (title === "") return `${base}${badge}`;
	return `${base} — ${truncateLabel(title, Math.max(4, max))}${badge}`;
}
/** Header counters: `2 rodando · 70 concluídos · 1 falha · $3.59`. A zero
*  counter is omitted (never `0 rodando`); the total spend is printed whenever
*  the tree has a child, because `$0.00` is then a real answer. Null for an
*  empty tree, so the header renders no counter line at all. Pure. */
function dispatchPanelHeader(entries) {
	const list = Array.isArray(entries) ? entries.filter((entry) => entry?.view) : [];
	if (list.length === 0) return null;
	let running = 0;
	let completed = 0;
	let failed = 0;
	for (const entry of list) switch (entry.view.state) {
		case "running":
			running += 1;
			break;
		case "completed":
			completed += 1;
			break;
		case "failed": failed += 1;
	}
	const parts = [];
	if (running > 0) parts.push(`${running} rodando`);
	if (completed > 0) parts.push(`${completed} ${completed === 1 ? "concluído" : "concluídos"}`);
	if (failed > 0) parts.push(`${failed} ${failed === 1 ? "falha" : "falhas"}`);
	const cost = formatSpendUSD(dispatchTotalCost(list.map((entry) => entry.view)));
	if (cost !== null) parts.push(cost);
	return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR);
}
/** Horizontal rule under the header, clamped to the panel's own width. Pure. */
function dispatchPanelRule(width, max = 200) {
	const columns = Math.max(0, Math.min(max, Math.floor(numberOrNull(width) ?? 0)));
	return "─".repeat(columns);
}
/** Row marker: animated spinner while running, `✓` done, `✗` failed, `○`
*  cancelled/interrupted, `?` for a state the host never publishes. Every glyph
*  is one cell wide and `?` is the only fallback, so an unknown state is visible
*  instead of silently rendering as success. Pure. */
function dispatchPanelMarker(state, frame = 0) {
	switch (state) {
		case "running": return `${spinnerFrame(frame)} `;
		case "completed": return "✓ ";
		case "failed": return "✗ ";
		case "interrupted": return "○ ";
		default: return "? ";
	}
}
/** One padded, truncated cell: an absent/blank value becomes the em dash, and
*  the value is cut to the cell's own width (never to the line's length, so one
*  long cell cannot squeeze its neighbours out of alignment). Pure. */
function dispatchPanelCell(value, width) {
	const cells = Math.max(1, Math.floor(numberOrNull(width) ?? 1));
	const text = typeof value === "string" ? value.trim() : "";
	return padCell(text === "" ? "—" : text, cells);
}
/** One list row: `⠋ prometheus   plan   $0.09  14m34s`. The agent cell absorbs
*  the width difference (down to `DISPATCH_PANEL_MIN_AGENT_WIDTH`), so a narrow
*  panel truncates the label rather than the numbers; the cost column grows by
*  itself for a sub-cent value so the row never spends more than its budget.
*  Pure. */
function dispatchPanelRowText(entry, options = {}) {
	const view = entry?.view;
	if (!view) return "";
	const now = numberOrNull(options.now) ?? Date.now();
	const frame = numberOrNull(options.frame) ?? 0;
	const width = Math.floor(numberOrNull(options.max) ?? 35);
	const costText = formatDispatchCost(view.cost);
	const costWidth = Math.max(7, cellWidth(costText));
	const agentWidth = Math.max(6, Math.min(12, width - (DISPATCH_PANEL_ROW_FIXED_WIDTH + costWidth)));
	return `${dispatchPanelMarker(view.state, frame)}${dispatchPanelCell(dispatchAgentText(view, 12), agentWidth)} ${dispatchPanelCell(view.kind, 4)} ${costText.padStart(costWidth)}${truncateLabel(dispatchElapsed(view, now), 8).padStart(8)}`;
}
/** `ses_ab12cd`, short enough for a detail line. Full id when it already fits. */
function shortSessionID(id, max = 10) {
	const text = typeof id === "string" ? id.trim() : "";
	if (text === "") return "—";
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}\u2026`;
}
/** Token counters of one child on a single line (`in 1.2K · out 430 · r 120 ·
*  cache 8K/1K`), or `tokens —` when the host published none. Pure. */
function dispatchTokenLine(tokens) {
	if (!tokens) return `tokens —`;
	const value = (token) => token === null ? "—" : formatContextWindow(token) ?? String(token);
	return [
		`in ${value(tokens.input)}`,
		`out ${value(tokens.output)}`,
		`r ${value(tokens.reasoning)}`,
		`cache ${value(tokens.cacheRead)}/${value(tokens.cacheWrite)}`
	].join(SPEND_LINE_SEPARATOR);
}
/** Detail lines of the selected child: heading (title, else the spawning
*  description, else the row label), short id + model, token counters, and the
*  kind plus its evidence and the parent id. Two to four lines; `expanded:
*  false` keeps only the heading. Every missing datum prints `—`. Pure. */
function dispatchPanelDetail(entry, options = {}) {
	if (!entry?.view) return ["—"];
	const max = Math.max(8, Math.floor(numberOrNull(options.max) ?? 60));
	const view = entry.view;
	const lines = [truncateLabel(entry.title ?? entry.description ?? (typeof view.label === "string" && view.label !== "" ? view.label : null) ?? view.id, max)];
	if (options.expanded === false) return lines;
	lines.push(truncateLabel(`${shortSessionID(view.id)}${SPEND_LINE_SEPARATOR}${view.model ?? "—"}`, max));
	lines.push(truncateLabel(dispatchTokenLine(entry.tokens), max));
	const origin = DISPATCH_KIND_ORIGIN_LABELS[view.kindOrigin] ?? DISPATCH_KIND_ORIGIN_LABELS.unavailable;
	lines.push(truncateLabel(`kind ${view.kind ?? "—"} (${origin})${SPEND_LINE_SEPARATOR}parent ${entry.parentID ?? "—"}`, max));
	return lines;
}
/** Panel geometry for its input width: wide (≥72) puts the detail in a second
*  column, narrow stacks it under the list. `rowWidth` is what a list row may
*  spend after the selection gutter. Pure. */
function dispatchPanelLayout(width) {
	const columns = Math.max(20, Math.floor(numberOrNull(width) ?? 0));
	if (columns >= 72) {
		const listWidth = Math.max(40, Math.min(64, columns - 26));
		return {
			mode: "wide",
			listWidth,
			detailWidth: Math.max(24, columns - listWidth - 2),
			rowWidth: listWidth - 2
		};
	}
	return {
		mode: "narrow",
		listWidth: columns,
		detailWidth: columns,
		rowWidth: columns - 2
	};
}
/** Viewport of the list: the page holding the selection, scrolled so the
*  selected row stays visible with its predecessors. Bounded, so a 71-child
*  tree renders ten rows, never all of them. Pure. */
function dispatchPanelWindow(total, selectedIndex, pageSize = 10) {
	const count = Math.max(0, Math.floor(numberOrNull(total) ?? 0));
	const size = Math.max(1, Math.floor(numberOrNull(pageSize) ?? 10));
	if (count === 0) return {
		start: 0,
		end: 0,
		size
	};
	const index = Math.min(count - 1, Math.max(0, Math.floor(numberOrNull(selectedIndex) ?? 0)));
	const start = Math.min(Math.max(0, index - size + 1), Math.max(0, count - size));
	return {
		start,
		end: Math.min(count, start + size),
		size
	};
}
/** `1-10 de 71` while the list is longer than one page; null when everything
*  fits (and for an empty list), so the footer never pads itself. Pure. */
function dispatchPanelRangeText(start, end, total) {
	const count = Math.max(0, Math.floor(numberOrNull(total) ?? 0));
	const first = Math.max(0, Math.floor(numberOrNull(start) ?? 0));
	const last = Math.min(count, Math.floor(numberOrNull(end) ?? 0));
	if (count === 0 || first === 0 && last >= count) return null;
	return `${first + 1}-${last} de ${count}`;
}
/** One rendered list row, selection resolved by the view against the model's
*  selected id. */
/** Every entry as a row, ordered by the shared comparator. Pure. */
function dispatchPanelRows(entries, options = {}) {
	return orderDispatchEntries(Array.isArray(entries) ? entries.filter((entry) => entry?.view && typeof entry.view.id === "string") : []).map((entry) => ({
		id: entry.view.id,
		state: entry.view.state,
		text: dispatchPanelRowText(entry, options)
	}));
}
/** Panel action, one per command. */
/** One namespaced command: stable id, explicit binding, and the action it runs. */
/** The panel's whole keymap, in table order. `bind` is explicit for every
*  command (no auto-binding), and every id is namespaced, so a `k`/`q`/`f`
*  binding can never collide with the host's own keys. */
const DISPATCH_PANEL_COMMANDS = [
	{
		action: "up",
		id: "pantheon.dispatch.up",
		title: "Dispatch: selecionar anterior",
		bind: "k,up"
	},
	{
		action: "down",
		id: "pantheon.dispatch.down",
		title: "Dispatch: selecionar próxima",
		bind: "j,down"
	},
	{
		action: "home",
		id: "pantheon.dispatch.home",
		title: "Dispatch: primeira",
		bind: "home"
	},
	{
		action: "end",
		id: "pantheon.dispatch.end",
		title: "Dispatch: última",
		bind: "end"
	},
	{
		action: "pageup",
		id: "pantheon.dispatch.pageup",
		title: "Dispatch: página acima",
		bind: "pageup"
	},
	{
		action: "pagedown",
		id: "pantheon.dispatch.pagedown",
		title: "Dispatch: página abaixo",
		bind: "pagedown"
	},
	{
		action: "toggle",
		id: "pantheon.dispatch.toggle",
		title: "Dispatch: expandir detalhe",
		bind: "enter"
	},
	{
		action: "fullscreen",
		id: "pantheon.dispatch.fullscreen",
		title: "Dispatch: tela cheia",
		bind: "f"
	},
	{
		action: "close",
		id: "pantheon.dispatch.close",
		title: "Dispatch: fechar",
		bind: "escape,q"
	}
];
/** Run one action against the model and the host-owned panel input. Kept apart
*  from the keymap so the whole command surface is testable without a renderer.
*/
function performDispatchPanelAction(action, model, panel) {
	switch (action) {
		case "up":
			model.move(-1);
			return;
		case "down":
			model.move(1);
			return;
		case "home":
			model.first();
			return;
		case "end":
			model.last();
			return;
		case "pageup":
			model.pageUp();
			return;
		case "pagedown":
			model.pageDown();
			return;
		case "toggle":
			model.toggle();
			return;
		case "fullscreen":
			panel.toggleFullscreen();
			return;
		case "close":
			panel.close();
			return;
		default: return;
	}
}
/** Footer: the keys the host reports for each command (`keymap.shortcuts`) with
*  an em dash whenever a command has no binding, so the hint can never advertise
*  a key that does nothing. Pure. */
function dispatchPanelFooter(shortcutsOf) {
	const keys = (id) => {
		let list = [];
		try {
			const result = shortcutsOf(id);
			list = Array.isArray(result) ? result : [];
		} catch {
			list = [];
		}
		const text = list.map((key) => String(key ?? "").trim()).filter((key) => key !== "").join("/");
		return text === "" ? "—" : text;
	};
	return [
		`${keys("pantheon.dispatch.up")} ${keys("pantheon.dispatch.down")} mover`,
		`${keys("pantheon.dispatch.toggle")} detalhe`,
		`${keys("pantheon.dispatch.fullscreen")} fullscreen`,
		`${keys("pantheon.dispatch.close")} fechar`
	].join(SPEND_LINE_SEPARATOR);
}
/** The subset of `PanelInput` the model reads, so tests can drive it with a
*  plain object. */
/** `keymap.shortcuts` of one command; empty when the keymap is unavailable. */
function keymapShortcuts(context, id) {
	try {
		const list = context?.keymap?.shortcuts?.(id);
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}
/** Open the panel from the command palette / slash command. `ui.panel.open`
*  only accepts a `session` route, so a refusal (no session open) is answered
*  with a toast — never a fallback route, never a silent no-op. Returns whether
*  the panel opened. */
function openDispatchPanel(context) {
	let opened = false;
	try {
		opened = context?.ui?.panel?.open?.(DISPATCH_PANEL_NAME) === true;
	} catch {
		opened = false;
	}
	if (opened) return true;
	try {
		context?.ui?.toast?.show?.({
			message: DISPATCH_PANEL_TOAST,
			variant: "warning"
		});
	} catch {}
	return false;
}
/** Reactive state the panel view renders. Selection is held by session id, so
*  it survives list updates; the index is derived (and falls back to the first
*  row when the selected child disappears). */
/** Model behind the panel. Mounted only while the panel claim renders (the
*  `Show` in `session.panel`), so the 80 ms tick it arms exists exactly while
*  the panel is open; it also stops on `isOpen()` going false and on dispose.
*  It performs no `message.sync`, writes no `session.metadata` and makes no
*  request: `collectDispatch` reads only host-cached state. */
function createDispatchPanelModel(context, panel) {
	const [revision, setRevision] = createSignal(0);
	const [frame, setFrame] = createSignal(0);
	const [expanded, setExpanded] = createSignal(true);
	const [selectedID, setSelectedID] = createSignal(null);
	const isOpen = () => panel().name === DISPATCH_PANEL_NAME;
	const activeSessionID = () => {
		const id = panel().sessionID;
		return isValidSessionID(id) ? id : "";
	};
	const entries = createMemo(() => {
		revision();
		if (!isOpen()) return [];
		return collectDispatch(context, activeSessionID());
	});
	const layout = createMemo(() => dispatchPanelLayout(panel().width));
	const rows = createMemo(() => {
		const mode = layout();
		return dispatchPanelRows(entries(), {
			now: Date.now(),
			frame: frame(),
			max: mode.rowWidth
		});
	});
	const selectedIndex = createMemo(() => {
		const list = rows();
		if (list.length === 0) return 0;
		const id = selectedID();
		if (id === null) return 0;
		const index = list.findIndex((row) => row.id === id);
		return index === -1 ? 0 : index;
	});
	const selectedIDAccessor = createMemo(() => rows()[selectedIndex()]?.id ?? null);
	const selectedEntry = createMemo(() => entries()[selectedIndex()] ?? null);
	const session = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return void 0;
		try {
			return context.data.session.get(id);
		} catch {
			return;
		}
	});
	const title = createMemo(() => dispatchPanelTitle(session()?.title, 44, panel().presentation));
	const header = createMemo(() => dispatchPanelHeader(entries()));
	const detail = createMemo(() => dispatchPanelDetail(selectedEntry(), {
		expanded: expanded(),
		max: layout().detailWidth
	}));
	const visible = createMemo(() => {
		const list = rows();
		const window = dispatchPanelWindow(list.length, selectedIndex());
		return {
			start: window.start,
			rows: list.slice(window.start, window.end)
		};
	});
	const hasRunning = createMemo(() => rows().some((row) => row.state === "running"));
	const footer = createMemo(() => {
		const list = rows();
		const window = dispatchPanelWindow(list.length, selectedIndex());
		const range = dispatchPanelRangeText(window.start, window.end, list.length);
		const hints = dispatchPanelFooter((id) => keymapShortcuts(context, id));
		return range === null ? hints : `${range}${SPEND_LINE_SEPARATOR}${hints}`;
	});
	const select = (index) => {
		const list = rows();
		if (list.length === 0) return;
		const clamped = Math.min(list.length - 1, Math.max(0, Math.round(index)));
		setSelectedID(list[clamped]?.id ?? null);
	};
	onMount(() => {
		onCleanup(subscribeSidebarRefresh(context, () => setRevision((value) => value + 1)));
	});
	createEffect(() => {
		if (!isOpen() || !hasRunning()) return;
		const spinner = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
		onCleanup(() => clearInterval(spinner));
	});
	return {
		entries,
		rows,
		title,
		header,
		detail,
		layout,
		visible,
		selectedID: selectedIDAccessor,
		selectedIndex,
		expanded,
		hasRunning,
		frame,
		footer,
		move: (delta) => select(selectedIndex() + (numberOrNull(delta) ?? 0)),
		first: () => select(0),
		last: () => select(rows().length - 1),
		pageUp: () => select(selectedIndex() - 10),
		pageDown: () => select(selectedIndex() + 10),
		toggle: () => setExpanded((value) => !value)
	};
}
/** Session ids to eagerly sync at load (deduped, bounded). Pure. */
function collectWarmupTargets(sessions, limit = WARMUP_SESSION_LIMIT) {
	const ids = [];
	for (const session of sessions) {
		if (!isValidSessionID(session?.id) || ids.includes(session.id)) continue;
		ids.push(session.id);
		if (ids.length >= limit) break;
	}
	return ids;
}
/** Body a sidebar instance renders when the host has not published a real
*  session id yet. OpenCode V2 scopes the `sidebar.content` slot to a session
*  (`SlotMap["sidebar.content"] = { sessionID: string }`), so before the first
*  prompt the slot may not mount at all — see the `home.footer.status`
*  contribution for the pre-prompt degradation. Pure. */
function sidebarPlaceholder(sessionID) {
	return isValidSessionID(sessionID) ? null : SIDEBAR_WAITING_LABEL;
}
/** Navigate to a session through the V2 router. Fail-open: an absent router or
*  a removed session must never break the sidebar. Returns whether a valid
*  navigation was dispatched. Pure. */
function navigateToSession(router, sessionID) {
	if (typeof router?.navigate !== "function" || !isValidSessionID(sessionID)) return false;
	try {
		router.navigate({
			type: "session",
			sessionID
		});
		return true;
	} catch {
		return false;
	}
}
/** Diff two delegation observations: entries that were `running` and are no
*  longer running count as completions, fired once per transition. Returns the
*  next snapshot so callers can keep a single tracker. First observation never
*  reports a completion (no toast spam on mount). Pure. */
function detectDelegationCompletions(previous, current) {
	const snapshot = /* @__PURE__ */ new Map();
	const completed = [];
	for (const entry of current) {
		snapshot.set(entry.id, entry.state);
		if (previous.get(entry.id) === "running" && entry.state !== "running") completed.push(entry);
	}
	return {
		completed,
		snapshot
	};
}
function resolveLocation(context) {
	try {
		return context?.location ?? context?.data?.location?.default();
	} catch {
		return;
	}
}
function resolveSidebarCwd(context) {
	const location = resolveLocation(context);
	if (location && typeof location.directory === "string" && location.directory !== "") return location.directory;
	return process.cwd();
}
function sessionStatusOf(context, sessionID) {
	try {
		const status = context?.data?.session?.status?.(sessionID);
		return typeof status === "string" ? status : void 0;
	} catch {
		return;
	}
}
/** Subscribe `refresh` to every V2 event that can change sidebar state. Returns
*  a disposer that releases exactly the subscriptions the host handed out. The
*  event names come from the V2 union; the cast turns an unknown name into a
*  compile error instead of a silent no-op subscription. */
function subscribeSidebarRefresh(context, refresh) {
	const stop = [];
	const data = context?.data;
	if (typeof data?.on === "function") for (const type of SIDEBAR_REFRESH_EVENTS) try {
		const unsubscribe = data.on(type, refresh);
		if (typeof unsubscribe === "function") stop.push(unsubscribe);
	} catch {}
	return () => {
		for (const unsubscribe of stop) if (typeof unsubscribe === "function") unsubscribe();
	};
}
/** Populate the cached data at load so the sidebar has content before the first
*  prompt (Known Issue guard). Fire-and-forget: a missing API or a failed sync
*  degrades silently and the sidebar still renders its static header. */
function warmUpSidebarData(context, location) {
	try {
		Promise.resolve(context?.data?.location?.vcs?.sync?.(location)).catch(() => {});
	} catch {}
	let listed = [];
	try {
		const result = context?.data?.session?.list?.();
		if (Array.isArray(result)) listed = result;
	} catch {}
	for (const id of collectWarmupTargets(listed)) try {
		Promise.resolve(context?.data?.session?.sync?.(id)).catch(() => {});
	} catch {}
}
function showDelegationToast(context, done) {
	const variant = done.state === "failed" ? "error" : done.state === "interrupted" ? "warning" : "success";
	const verb = done.state === "failed" ? "falhou" : done.state === "interrupted" ? "interrompida" : "concluída";
	try {
		context?.ui?.toast?.show?.({
			title: TOAST_TITLE,
			message: `${done.label} ${verb}`,
			variant,
			sessionID: done.id
		});
	} catch {}
}
/** Active preset signal with mount + 30s refresh. Shared by the sidebar and the
*  home-screen status contribution. */
function useActivePreset(context) {
	const [preset, setPreset] = createSignal(presetFromEnv(process.env));
	const [overrides, setOverrides] = createSignal(emptyOverrides());
	onMount(() => {
		const cwd = resolveSidebarCwd(context);
		let cancelled = false;
		const refresh = async () => {
			try {
				const detail = await resolveActivePresetForTui(process.env, cwd);
				if (!cancelled) {
					setPreset(detail.info);
					setOverrides(detail.overrides);
				}
			} catch {}
		};
		refresh();
		const timer = setInterval(() => void refresh(), PRESET_REFRESH_MS);
		onCleanup(() => {
			cancelled = true;
			clearInterval(timer);
		});
	});
	return {
		preset,
		overrides
	};
}
/** Debounce for the git file-count revalidation. `vcs.status` is an HTTP call;
*  session events arrive in bursts, so the row is refreshed at most once per
*  window instead of on every event. */
const GIT_CHANGES_DEBOUNCE_MS = 400;
/** `context.client.vcs.status(input?, requestOptions?)` →
*  `Promise<{ data: VcsFileStatus[] }>` (`GET /api/vcs/status`). Returns the
*  callable or null when the host does not expose it, so callers degrade to
*  the branch-only row instead of throwing. */
function vcsStatusCall(context) {
	const status = context?.client?.vcs?.status;
	return typeof status === "function" ? status.bind(context.client.vcs) : null;
}
/** `context.client.session.stats(input?, requestOptions?)` →
*  `Promise<SessionStatsInfo>` (`GET /api/experimental/session/stats`), served
*  by the local process. Returns the callable or null when the host does not
*  expose it, so the Context spend line simply does not render. */
function statsCall(context) {
	const stats = context?.client?.session?.stats;
	return typeof stats === "function" ? stats.bind(context.client.session) : null;
}
/** Local IANA zone for the stats call (`America/Sao_Paulo`); omitted when the
*  runtime cannot resolve one. */
function localTimezone() {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return typeof zone === "string" && zone !== "" ? zone : void 0;
	} catch {
		return;
	}
}
/** Fields every stats call sends. `tools: 'none'` skips the tool aggregation
*  the block never renders; `project` is omitted (no cheap id in hand) rather
*  than guessed. */
function statsInput() {
	const timezone = localTimezone();
	return timezone === void 0 ? { tools: "none" } : {
		tools: "none",
		timezone
	};
}
/** Convert a millisecond instant to the unit the route accepted. */
function spendInstant(ms, unit) {
	return unit === "s" ? Math.floor(ms / 1e3) : ms;
}
/** Measure the `from`/`to` unit once: millisecond epoch first, then a single
*  seconds attempt. Bounded to two calls and never throws; anything the route
*  rejects (mismatch, throw, malformed echo) ends as `unavailable`, which hides
*  the block for the rest of the process instead of retrying forever. */
async function probeSpendUnit(call) {
	const now = Date.now();
	const fromMs = now - SPEND_PROBE_WINDOW_MS;
	const attempts = [{
		sent: {
			from: fromMs,
			to: now
		},
		scale: 1,
		unit: "ms"
	}, {
		sent: {
			from: Math.floor(fromMs / 1e3),
			to: Math.floor(now / 1e3)
		},
		scale: 1e3,
		unit: "s"
	}];
	for (const attempt of attempts) try {
		if (statsRangeMatches((await call({
			...statsInput(),
			...attempt.sent
		}))?.range, attempt.sent, attempt.scale)) return attempt.unit;
	} catch {}
	return "unavailable";
}
/** Resolve (and cache) the unit for this process. Concurrent callers share one
*  probe, so a burst of refreshes cannot spend more than two calls on it. */
function ensureSpendUnit(call) {
	if (spendUnit !== null) return Promise.resolve(spendUnit);
	if (spendProbe === null) spendProbe = probeSpendUnit(call).then((unit) => {
		spendUnit = unit;
		spendProbe = null;
		return unit;
	}, () => {
		spendUnit = "unavailable";
		spendProbe = null;
		return "unavailable";
	});
	return spendProbe;
}
/** Reactive state the sidebar view renders. Accessors keep the view reactive
*  while the model itself stays free of JSX, so its effects are exercisable
*  without a TUI renderer. */
/** Reactive wiring behind the sidebar: refresh subscription, warm syncs, the
*  running-only spinner and the completion-toast effect. `context` stays loosely
*  typed (the host API only exists at runtime) but the refresh event names are
*  narrowed to the V2 union at the subscription site. */
function createSidebarModel(context, sessionID, gitExec = defaultGitExec) {
	const [revision, setRevision] = createSignal(0);
	const [metricsRevision, setMetricsRevision] = createSignal(0);
	const [frame, setFrame] = createSignal(0);
	const location = resolveLocation(context);
	const activePreset = useActivePreset(context);
	const preset = activePreset.preset;
	const presetOverrides = activePreset.overrides;
	let observedStates = /* @__PURE__ */ new Map();
	let metricsDebounce;
	const scheduleMetrics = () => {
		if (metricsDebounce !== void 0) clearTimeout(metricsDebounce);
		metricsDebounce = setTimeout(() => {
			metricsDebounce = void 0;
			setMetricsRevision((value) => value + 1);
		}, 400);
	};
	const refresh = () => {
		setRevision((value) => value + 1);
		scheduleMetrics();
	};
	const activeSessionID = () => {
		const id = sessionID();
		return isValidSessionID(id) ? id : "";
	};
	const session = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return void 0;
		try {
			return context.data.session.get(id);
		} catch {
			return;
		}
	});
	const branch = createMemo(() => {
		revision();
		try {
			return context.data.location.vcs.info(location)?.branch?.current ?? null;
		} catch {
			return null;
		}
	});
	const [gitChangesRead, setGitChangesRead] = createSignal({
		session: activeSessionID(),
		text: null
	});
	const [gitCliRead, setGitCliRead] = createSignal({
		session: activeSessionID(),
		snapshot: null
	});
	const gitChanges = createMemo(() => {
		const read = gitChangesRead();
		return read.session === activeSessionID() ? read.text : null;
	});
	const gitCli = createMemo(() => {
		const read = gitCliRead();
		return read.session === activeSessionID() ? read.snapshot : null;
	});
	let gitRequest = 0;
	let gitDebounce;
	let gitProbeDebounce;
	let gitProbeSessionID = activeSessionID();
	let gitProbeStartedAt = null;
	let gitProbeInFlight = false;
	let disposed = false;
	const loadGitChanges = async () => {
		const status = vcsStatusCall(context);
		if (status === null) return;
		const session = activeSessionID();
		const request = ++gitRequest;
		try {
			const result = await status({ location: { directory: resolveSidebarCwd(context) } });
			if (request !== gitRequest || session !== activeSessionID()) return;
			const files = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
			setGitChangesRead({
				session,
				text: formatGitChanges(files)
			});
		} catch {}
	};
	const runGitProbe = async () => {
		const session = activeSessionID();
		if (session !== gitProbeSessionID) {
			gitProbeSessionID = session;
			gitProbeStartedAt = null;
			gitProbeInFlight = false;
		}
		if (!gitProbeAllowed({
			now: Date.now(),
			lastRunAt: gitProbeStartedAt,
			inFlight: gitProbeInFlight
		})) return;
		gitProbeInFlight = true;
		gitProbeStartedAt = Date.now();
		try {
			const snapshot = await readGitSnapshot(resolveSidebarCwd(context), gitExec);
			if (!disposed && session === activeSessionID()) setGitCliRead({
				session,
				snapshot
			});
		} catch {} finally {
			if (session === gitProbeSessionID) gitProbeInFlight = false;
		}
	};
	const scheduleGitChanges = () => {
		if (vcsStatusCall(context) === null) return;
		if (gitCli() !== null) return;
		if (gitDebounce !== void 0) clearTimeout(gitDebounce);
		gitDebounce = setTimeout(() => {
			gitDebounce = void 0;
			loadGitChanges();
		}, 400);
	};
	const scheduleGitProbe = () => {
		if (gitProbeDebounce !== void 0) clearTimeout(gitProbeDebounce);
		gitProbeDebounce = setTimeout(() => {
			gitProbeDebounce = void 0;
			runGitProbe();
		}, GIT_CLI_DEBOUNCE_MS);
	};
	const gitLine = createMemo(() => {
		const snapshot = gitCli();
		if (snapshot !== null) return formatGitSnapshot(snapshot);
		return gitChanges();
	});
	createEffect(on(activeSessionID, (id) => {
		if (disposed || id === "") return;
		runGitProbe();
		loadGitChanges();
	}, { defer: true }));
	const [spend, setSpend] = createSignal(null);
	let spendTotals = {
		today: null,
		thirtyDays: null
	};
	let spendRequest = 0;
	let spendDebounce;
	const loadSpend = async () => {
		const stats = statsCall(context);
		if (stats === null) return;
		try {
			const unit = await ensureSpendUnit(stats);
			if (unit === "unavailable") return;
			const request = ++spendRequest;
			const windows = spendWindows(Date.now());
			const settled = await Promise.allSettled([stats({
				...statsInput(),
				from: spendInstant(windows.today.from, unit),
				to: spendInstant(windows.today.to, unit)
			}), stats({
				...statsInput(),
				from: spendInstant(windows.thirtyDays.from, unit),
				to: spendInstant(windows.thirtyDays.to, unit)
			})]);
			if (request !== spendRequest) return;
			const next = { ...spendTotals };
			for (const [index, key] of ["today", "thirtyDays"].entries()) {
				const result = settled[index];
				if (result === void 0 || result.status !== "fulfilled") continue;
				const cost = statsCost(result.value);
				if (cost === null) continue;
				next[key] = cost;
			}
			spendTotals = next;
			setSpend(next);
		} catch {}
	};
	const scheduleSpend = () => {
		if (statsCall(context) === null) return;
		if (spendDebounce !== void 0) clearTimeout(spendDebounce);
		spendDebounce = setTimeout(() => {
			spendDebounce = void 0;
			loadSpend();
		}, 400);
	};
	const messages = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return [];
		try {
			const result = context.data.session.message?.list?.(id);
			return Array.isArray(result) ? result : [];
		} catch {
			return [];
		}
	});
	const familySessionIDs = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return [];
		const ids = [id];
		try {
			const result = context.data.session.family?.(id);
			if (Array.isArray(result)) for (const childID of result) {
				if (!isValidSessionID(childID) || ids.includes(childID)) continue;
				ids.push(childID);
				if (ids.length >= 8) break;
			}
		} catch {}
		return ids;
	});
	const transcript = createMemo(() => {
		metricsRevision();
		const rootID = activeSessionID();
		const collected = [];
		let todo = [];
		for (const id of familySessionIDs()) {
			let list = [];
			try {
				const result = context.data.session.message?.list?.(id);
				if (Array.isArray(result)) list = result;
			} catch {}
			collected.push(...list.slice(-400));
			if (id === rootID) todo = latestTodoItems(list) ?? [];
		}
		return {
			messages: collected,
			todo
		};
	});
	const usageMessages = createMemo(() => transcript().messages);
	const todo = createMemo(() => ceilingTodoItems(transcript().todo, 6));
	const messageCostTotal = createMemo(() => {
		let total = 0;
		for (const message of usageMessages()) {
			if (message?.type !== "assistant") continue;
			const cost = numberOrNull(message.cost);
			if (cost !== null && cost > 0) total += cost;
		}
		return total;
	});
	const cost = createMemo(() => {
		revision();
		const ids = familySessionIDs();
		if (ids.length === 0) return null;
		let total = 0;
		let found = false;
		for (const id of ids) {
			let value;
			try {
				value = context.data.session.cost?.(id);
			} catch {
				value = void 0;
			}
			let resolved = numberOrNull(value);
			if (resolved === null) try {
				resolved = numberOrNull(context.data.session.get(id)?.cost);
			} catch {
				resolved = null;
			}
			if (resolved !== null && resolved >= 0) {
				total += resolved;
				found = true;
			}
		}
		if (found) return Math.max(total, messageCostTotal());
		const fallback = messageCostTotal();
		return fallback > 0 ? fallback : null;
	});
	const modelUsage = createMemo(() => {
		metricsRevision();
		return ceilingModelUsage(collectModelUsage(usageMessages()), 3);
	});
	const modelRefs = createMemo(() => {
		revision();
		const current = session();
		const agent = typeof current?.agent === "string" && current.agent !== "" ? current.agent : "";
		let agentRef;
		if (agent !== "") try {
			const agents = context.data.location?.agent?.list?.(location);
			if (Array.isArray(agents)) agentRef = agents.find((entry) => entry?.id === agent)?.model;
		} catch {}
		const override = agent === "" ? void 0 : presetOverrides().agents[agent]?.model;
		return {
			agent,
			sessionRef: current?.model,
			agentRef,
			override: typeof override === "string" && override !== "" ? override : null
		};
	});
	const agentModel = createMemo(() => {
		const { agent, sessionRef, agentRef, override } = modelRefs();
		const model = shortModelID(override) ?? shortModelID(sessionRef) ?? shortModelID(agentRef);
		if (model === null) return null;
		return {
			agent,
			model,
			overridden: override !== null
		};
	});
	const provider = createMemo(() => {
		revision();
		const fromSession = providerIDFromRef(session()?.model);
		if (fromSession !== null) return fromSession;
		const list = messages();
		for (let index = list.length - 1; index >= 0; index -= 1) {
			const message = list[index];
			if (message?.type !== "assistant") continue;
			const fromMessage = providerIDFromRef(message.model);
			if (fromMessage !== null) return fromMessage;
		}
		const { agentRef } = modelRefs();
		const fromAgent = providerIDFromRef(agentRef);
		if (fromAgent !== null) return fromAgent;
		try {
			return providerIDFromModels(context.data.location?.model?.list?.(location), agentRef);
		} catch {
			return null;
		}
	});
	const contextUsage = createMemo(() => {
		const list = messages();
		if (list.length === 0) return null;
		const refs = modelRefs();
		const ref = [...list].reverse().find((message) => message?.type === "assistant" && message?.model)?.model ?? refs.sessionRef ?? refs.agentRef ?? refs.override;
		let limit = null;
		try {
			const models = context.data.location?.model?.list?.(location);
			limit = resolveContextLimit(Array.isArray(models) ? models : [], ref);
		} catch {
			limit = null;
		}
		return computeContextUsage(list, limit, session()?.revert?.messageID);
	});
	const cachePerformance = createMemo(() => {
		const message = lastAssistantWithTokens(messages(), session()?.revert?.messageID);
		return message === null ? null : cacheHitPercent(message.tokens);
	});
	const turnPerformance = createMemo(() => {
		const list = messages();
		let anchor = -1;
		for (let index = list.length - 1; index >= 0; index--) if (list[index]?.type === "assistant") {
			anchor = index;
			break;
		}
		return anchor === -1 ? null : turnTokensPerSecond(list, anchor);
	});
	const performance = createMemo(() => {
		const cacheHit = cachePerformance();
		const tokensPerSecond = turnPerformance();
		if (cacheHit === null && tokensPerSecond === null) return null;
		return {
			cacheHit,
			tokensPerSecond
		};
	});
	const subagentCalls = createMemo(() => collectSubagentCalls(messages()));
	const dispatchEntries = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return [];
		return collectDispatch(context, id, {
			now: Date.now(),
			calls: subagentCalls()
		});
	});
	/** What the sidebar block renders: the collector's rows, nothing else. */
	const allDelegations = createMemo(() => dispatchEntries().map((entry) => entry.view));
	const hasRunning = createMemo(() => allDelegations().some((view) => view.state === "running"));
	const dispatch = createMemo(() => {
		frame();
		return buildDispatchBlock(allDelegations(), Date.now(), frame());
	});
	const blocks = createMemo(() => {
		const present = [];
		if (contextBlockRows(contextUsage(), cost()) !== null || contextSpendLine(spend()) !== null) present.push("context");
		if (branch() !== null || gitLine() !== null) present.push("git");
		if (todo().visible.length > 0) present.push("todo");
		if (dispatch() !== null) present.push("dispatch");
		return withBlockSpacers(present);
	});
	onMount(() => {
		const unsubscribeAll = subscribeSidebarRefresh(context, () => {
			refresh();
			scheduleGitChanges();
			scheduleGitProbe();
			scheduleSpend();
		});
		const id = activeSessionID();
		if (id !== "") {
			try {
				Promise.resolve(context.data.session.sync(id)).then(refresh);
			} catch {}
			try {
				Promise.resolve(context.data.session.message?.sync?.(id)).then(refresh);
			} catch {}
		}
		try {
			Promise.resolve(context.data.location.vcs.sync(location)).then(refresh);
		} catch {}
		loadGitChanges();
		runGitProbe();
		loadSpend();
		createEffect(() => {
			if (!hasRunning()) return;
			const spinner = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
			onCleanup(() => clearInterval(spinner));
		});
		onCleanup(() => {
			disposed = true;
			if (gitDebounce !== void 0) clearTimeout(gitDebounce);
			if (gitProbeDebounce !== void 0) clearTimeout(gitProbeDebounce);
			if (spendDebounce !== void 0) clearTimeout(spendDebounce);
			if (metricsDebounce !== void 0) clearTimeout(metricsDebounce);
		});
		onCleanup(unsubscribeAll);
	});
	let observedSessionID = activeSessionID();
	createEffect(() => {
		const id = activeSessionID();
		const views = allDelegations();
		if (id !== observedSessionID) {
			observedSessionID = id;
			observedStates = /* @__PURE__ */ new Map();
		}
		if (id === "") {
			observedStates = /* @__PURE__ */ new Map();
			return;
		}
		const { completed, snapshot } = detectDelegationCompletions(observedStates, views.map((view) => ({
			id: view.id,
			label: view.label,
			state: view.state
		})));
		observedStates = snapshot;
		for (const done of completed) showDelegationToast(context, done);
	});
	return {
		activeSessionID,
		session,
		branch,
		gitChanges,
		gitLine,
		gitCli,
		performance,
		dispatch,
		blocks,
		hasRunning,
		frame,
		preset,
		provider,
		presetOverrides,
		cost,
		modelUsage,
		todo,
		spend,
		contextUsage,
		agentModel
	};
}
/** One `Context` row: an optional toned lead segment (the gauge's filled
*  cells), the value, the muted gauge tail (empty cells) and the muted unit
*  suffix (`tokens` / `of 200K` / `spent`). */
function ContextRowView(props) {
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("text");
		insertNode(_el$, _el$2);
		setProp(_el$, "flexDirection", "row");
		insert(_el$, createComponent(Show, {
			get when() {
				return props.row.lead;
			},
			children: (lead) => (() => {
				var _el$3 = createElement("text");
				insert(_el$3, lead);
				effect((_$p) => setProp(_el$3, "fg", props.fg, _$p));
				return _el$3;
			})()
		}), _el$2);
		insert(_el$, createComponent(Show, {
			get when() {
				return props.row.tail;
			},
			children: (tail) => (() => {
				var _el$4 = createElement("text");
				insert(_el$4, tail);
				effect((_$p) => setProp(_el$4, "fg", props.muted, _$p));
				return _el$4;
			})()
		}), _el$2);
		insert(_el$2, () => props.row.value);
		insert(_el$, createComponent(Show, {
			get when() {
				return props.row.suffix;
			},
			children: (suffix) => (() => {
				var _el$5 = createElement("text");
				insert(_el$5, suffix);
				effect((_$p) => setProp(_el$5, "fg", props.muted, _$p));
				return _el$5;
			})()
		}), null);
		effect((_$p) => setProp(_el$2, "fg", props.fg, _$p));
		return _el$;
	})();
}
/** Block title: a muted single-width glyph, then the bold label. The fixed
*  header at the top of the sidebar deliberately renders no icon. `summary` is
*  the muted tail some blocks carry (`· 2 rodando · $0.47`), so the header
*  stays one line. */
function BlockHeader(props) {
	return (() => {
		var _el$6 = createElement("box"), _el$7 = createElement("text"), _el$8 = createElement("text");
		insertNode(_el$6, _el$7);
		insertNode(_el$6, _el$8);
		setProp(_el$6, "flexDirection", "row");
		insert(_el$7, () => `${props.icon} `);
		setProp(_el$8, "attributes", 1);
		insert(_el$8, () => props.label);
		insert(_el$6, createComponent(Show, {
			get when() {
				return props.summary;
			},
			children: (summary) => (() => {
				var _el$9 = createElement("text");
				insert(_el$9, () => `${SPEND_LINE_SEPARATOR}${summary()}`);
				effect((_$p) => setProp(_el$9, "fg", props.muted, _$p));
				return _el$9;
			})()
		}), null);
		effect((_p$) => {
			var _v$ = props.muted, _v$2 = props.fg;
			_v$ !== _p$.e && (_p$.e = setProp(_el$7, "fg", _v$, _p$.e));
			_v$2 !== _p$.t && (_p$.t = setProp(_el$8, "fg", _v$2, _p$.t));
			return _p$;
		}, {
			e: void 0,
			t: void 0
		});
		return _el$6;
	})();
}
function Sidebar(props) {
	const { context } = props;
	const model = createSidebarModel(context, () => props.sessionID);
	const text = () => context.theme.text?.base;
	const muted = () => context.theme.text?.muted ?? text();
	const tone = (value) => context.theme?.text?.feedback?.[value]?.base ?? text();
	const todoFg = (status) => {
		const rowTone = todoTone(status);
		if (rowTone === "accent") return tone("warning");
		return rowTone === "muted" ? muted() : text();
	};
	const open = (sessionID) => () => navigateToSession(context.ui?.router, sessionID);
	const block = (key) => model.blocks().find((entry) => entry.key === key);
	const spacer = (key) => block(key)?.spacer === true;
	const usageRows = () => modelUsageRows(model.modelUsage().visible);
	const usageHidden = () => hiddenModelUsageText(model.modelUsage().hidden, model.modelUsage().hiddenCost);
	const contextRows = () => contextBlockRows(model.contextUsage(), model.cost());
	const spendLine = () => contextSpendLine(model.spend());
	const performanceLine = () => contextPerformanceLine(model.performance());
	const gaugeFg = (row) => contextProgressColor(row.tone ?? "warning", context.theme);
	const dispatchView = () => model.dispatch();
	const dispatchSummary = () => {
		const view = dispatchView();
		return view === null ? null : dispatchHeaderSummary(view.runningCount, view.totalCost);
	};
	const failedSuffix = () => failedSuffixText(dispatchView()?.failures);
	return (() => {
		var _el$0 = createElement("box"), _el$1 = createElement("text"), _el$10 = createElement("text");
		insertNode(_el$0, _el$1);
		insertNode(_el$0, _el$10);
		setProp(_el$0, "flexDirection", "column");
		setProp(_el$0, "width", "100%");
		setProp(_el$0, "padding", 1);
		setProp(_el$1, "attributes", 1);
		insert(_el$1, `Pantheon v1.6.0`);
		insert(_el$10, () => presetHeaderLine(model.preset().name ?? "", model.provider()));
		insert(_el$0, createComponent(Show, {
			get when() {
				return memo(() => model.activeSessionID() !== "")() && model.session();
			},
			get fallback() {
				return (() => {
					var _el$21 = createElement("text");
					insert(_el$21, () => sidebarPlaceholder(props.sessionID));
					effect((_$p) => setProp(_el$21, "fg", muted(), _$p));
					return _el$21;
				})();
			},
			children: (current) => (() => {
				var _el$22 = createElement("text");
				insert(_el$22, () => `Sessão: ${truncateLabel(current().title || current().id)}`);
				effect((_$p) => setProp(_el$22, "fg", text(), _$p));
				return _el$22;
			})()
		}), null);
		insert(_el$0, createComponent(Show, {
			get when() {
				return model.blocks().length > 0;
			},
			get children() {
				var _el$11 = createElement("box");
				setProp(_el$11, "height", 1);
				return _el$11;
			}
		}), null);
		insert(_el$0, createComponent(Show, {
			get when() {
				return block("context");
			},
			get children() {
				var _el$12 = createElement("box");
				setProp(_el$12, "flexDirection", "column");
				insert(_el$12, createComponent(Show, {
					get when() {
						return spacer("context");
					},
					get children() {
						var _el$13 = createElement("box");
						setProp(_el$13, "height", 1);
						return _el$13;
					}
				}), null);
				insert(_el$12, createComponent(BlockHeader, {
					get icon() {
						return BLOCK_ICONS.context;
					},
					label: "Context",
					get fg() {
						return text();
					},
					get muted() {
						return muted();
					}
				}), null);
				insert(_el$12, createComponent(Show, {
					get when() {
						return contextRows();
					},
					children: (rows) => (() => {
						var _el$23 = createElement("box");
						setProp(_el$23, "flexDirection", "column");
						insert(_el$23, createComponent(Show, {
							get when() {
								return rows().tokens;
							},
							children: (row) => createComponent(ContextRowView, {
								get row() {
									return row();
								},
								get fg() {
									return text();
								},
								get muted() {
									return muted();
								}
							})
						}), null);
						insert(_el$23, createComponent(Show, {
							get when() {
								return rows().percent;
							},
							children: (row) => createComponent(ContextRowView, {
								get row() {
									return row();
								},
								get fg() {
									return gaugeFg(row());
								},
								get muted() {
									return muted();
								}
							})
						}), null);
						insert(_el$23, createComponent(Show, {
							get when() {
								return rows().spent;
							},
							children: (row) => createComponent(ContextRowView, {
								get row() {
									return row();
								},
								get fg() {
									return text();
								},
								get muted() {
									return muted();
								}
							})
						}), null);
						insert(_el$23, createComponent(For, {
							get each() {
								return usageRows();
							},
							children: (row) => (() => {
								var _el$24 = createElement("box"), _el$25 = createElement("text"), _el$26 = createElement("text"), _el$27 = createElement("text");
								insertNode(_el$24, _el$25);
								insertNode(_el$24, _el$26);
								insertNode(_el$24, _el$27);
								setProp(_el$24, "flexDirection", "row");
								insert(_el$25, () => row.model.padEnd(12));
								insert(_el$26, () => `  ${row.tokens.padStart(6)}`);
								insert(_el$27, () => `  ${row.cost.padStart(8)}`);
								effect((_p$) => {
									var _v$5 = muted(), _v$6 = text(), _v$7 = text();
									_v$5 !== _p$.e && (_p$.e = setProp(_el$25, "fg", _v$5, _p$.e));
									_v$6 !== _p$.t && (_p$.t = setProp(_el$26, "fg", _v$6, _p$.t));
									_v$7 !== _p$.a && (_p$.a = setProp(_el$27, "fg", _v$7, _p$.a));
									return _p$;
								}, {
									e: void 0,
									t: void 0,
									a: void 0
								});
								return _el$24;
							})()
						}), null);
						insert(_el$23, createComponent(Show, {
							get when() {
								return usageHidden();
							},
							children: (line) => (() => {
								var _el$28 = createElement("text");
								insert(_el$28, line);
								effect((_$p) => setProp(_el$28, "fg", muted(), _$p));
								return _el$28;
							})()
						}), null);
						return _el$23;
					})()
				}), null);
				insert(_el$12, createComponent(Show, {
					get when() {
						return performanceLine();
					},
					children: (line) => (() => {
						var _el$29 = createElement("text");
						insert(_el$29, line);
						effect((_$p) => setProp(_el$29, "fg", muted(), _$p));
						return _el$29;
					})()
				}), null);
				insert(_el$12, createComponent(Show, {
					get when() {
						return spendLine();
					},
					children: (line) => (() => {
						var _el$30 = createElement("text");
						insert(_el$30, line);
						effect((_$p) => setProp(_el$30, "fg", muted(), _$p));
						return _el$30;
					})()
				}), null);
				return _el$12;
			}
		}), null);
		insert(_el$0, createComponent(Show, {
			get when() {
				return block("git");
			},
			get children() {
				var _el$14 = createElement("box");
				setProp(_el$14, "flexDirection", "column");
				insert(_el$14, createComponent(Show, {
					get when() {
						return spacer("git");
					},
					get children() {
						var _el$15 = createElement("box");
						setProp(_el$15, "height", 1);
						return _el$15;
					}
				}), null);
				insert(_el$14, createComponent(BlockHeader, {
					get icon() {
						return BLOCK_ICONS.git;
					},
					label: "Git status",
					get fg() {
						return text();
					},
					get muted() {
						return muted();
					}
				}), null);
				insert(_el$14, createComponent(Show, {
					get when() {
						return model.branch();
					},
					children: (value) => (() => {
						var _el$31 = createElement("box"), _el$32 = createElement("text"), _el$34 = createElement("text");
						insertNode(_el$31, _el$32);
						insertNode(_el$31, _el$34);
						setProp(_el$31, "flexDirection", "row");
						insertNode(_el$32, createTextNode(`⎇ `));
						insert(_el$34, () => truncateLabel(value(), 32));
						effect((_p$) => {
							var _v$8 = muted(), _v$9 = text();
							_v$8 !== _p$.e && (_p$.e = setProp(_el$32, "fg", _v$8, _p$.e));
							_v$9 !== _p$.t && (_p$.t = setProp(_el$34, "fg", _v$9, _p$.t));
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$31;
					})()
				}), null);
				insert(_el$14, createComponent(Show, {
					get when() {
						return model.gitLine();
					},
					children: (line) => (() => {
						var _el$35 = createElement("text");
						insert(_el$35, line);
						effect((_$p) => setProp(_el$35, "fg", text(), _$p));
						return _el$35;
					})()
				}), null);
				return _el$14;
			}
		}), null);
		insert(_el$0, createComponent(Show, {
			get when() {
				return block("todo");
			},
			get children() {
				var _el$16 = createElement("box");
				setProp(_el$16, "flexDirection", "column");
				insert(_el$16, createComponent(Show, {
					get when() {
						return spacer("todo");
					},
					get children() {
						var _el$17 = createElement("box");
						setProp(_el$17, "height", 1);
						return _el$17;
					}
				}), null);
				insert(_el$16, createComponent(Show, {
					get when() {
						return model.todo().visible.length > 0;
					},
					get children() {
						var _el$18 = createElement("box");
						setProp(_el$18, "flexDirection", "column");
						insert(_el$18, createComponent(BlockHeader, {
							get icon() {
								return BLOCK_ICONS.todo;
							},
							label: "Todo",
							get fg() {
								return tone("warning");
							},
							get muted() {
								return muted();
							}
						}), null);
						insert(_el$18, createComponent(For, {
							get each() {
								return model.todo().visible;
							},
							children: (item) => (() => {
								var _el$36 = createElement("text");
								insert(_el$36, () => todoRowText(item));
								effect((_$p) => setProp(_el$36, "fg", todoFg(item.status), _$p));
								return _el$36;
							})()
						}), null);
						insert(_el$18, createComponent(Show, {
							get when() {
								return hiddenTodoText(model.todo().hidden);
							},
							children: (line) => (() => {
								var _el$37 = createElement("text");
								insert(_el$37, line);
								effect((_$p) => setProp(_el$37, "fg", muted(), _$p));
								return _el$37;
							})()
						}), null);
						return _el$18;
					}
				}), null);
				return _el$16;
			}
		}), null);
		insert(_el$0, createComponent(Show, {
			get when() {
				return block("dispatch");
			},
			get children() {
				var _el$19 = createElement("box");
				setProp(_el$19, "flexDirection", "column");
				insert(_el$19, createComponent(Show, {
					get when() {
						return spacer("dispatch");
					},
					get children() {
						var _el$20 = createElement("box");
						setProp(_el$20, "height", 1);
						return _el$20;
					}
				}), null);
				insert(_el$19, createComponent(Show, {
					get when() {
						return dispatchView();
					},
					children: (view) => (() => {
						var _el$38 = createElement("box");
						setProp(_el$38, "flexDirection", "column");
						insert(_el$38, createComponent(BlockHeader, {
							get icon() {
								return BLOCK_ICONS.dispatch;
							},
							label: "Dispatch",
							get fg() {
								return memo(() => view().runningCount > 0)() ? tone("success") : muted();
							},
							get muted() {
								return muted();
							},
							get summary() {
								return dispatchSummary();
							}
						}), null);
						insert(_el$38, createComponent(For, {
							get each() {
								return view().running;
							},
							children: (row) => (() => {
								var _el$40 = createElement("box"), _el$41 = createElement("text");
								insertNode(_el$40, _el$41);
								setProp(_el$40, "flexShrink", 0);
								insert(_el$41, () => row.text);
								effect((_p$) => {
									var _v$0 = open(row.id), _v$1 = tone("success");
									_v$0 !== _p$.e && (_p$.e = setProp(_el$40, "onMouseDown", _v$0, _p$.e));
									_v$1 !== _p$.t && (_p$.t = setProp(_el$41, "fg", _v$1, _p$.t));
									return _p$;
								}, {
									e: void 0,
									t: void 0
								});
								return _el$40;
							})()
						}), null);
						insert(_el$38, createComponent(Show, {
							get when() {
								return view().runningHidden > 0;
							},
							get children() {
								var _el$39 = createElement("text");
								insert(_el$39, () => `\u2026 +${view().runningHidden} rodando`);
								effect((_$p) => setProp(_el$39, "fg", muted(), _$p));
								return _el$39;
							}
						}), null);
						insert(_el$38, createComponent(Show, {
							get when() {
								return view().summary;
							},
							children: (line) => (() => {
								var _el$42 = createElement("box"), _el$43 = createElement("text");
								insertNode(_el$42, _el$43);
								setProp(_el$42, "flexDirection", "row");
								setProp(_el$42, "flexShrink", 0);
								insert(_el$43, line);
								insert(_el$42, createComponent(Show, {
									get when() {
										return failedSuffix();
									},
									children: (suffix) => (() => {
										var _el$44 = createElement("text");
										insert(_el$44, () => `${SPEND_LINE_SEPARATOR}${suffix()}`);
										effect((_$p) => setProp(_el$44, "fg", tone("error"), _$p));
										return _el$44;
									})()
								}), null);
								effect((_$p) => setProp(_el$43, "fg", muted(), _$p));
								return _el$42;
							})()
						}), null);
						insert(_el$38, createComponent(For, {
							get each() {
								return view().agents;
							},
							children: (row) => (() => {
								var _el$45 = createElement("text");
								insert(_el$45, () => childAgentRowText(row));
								effect((_$p) => setProp(_el$45, "fg", muted(), _$p));
								return _el$45;
							})()
						}), null);
						insert(_el$38, createComponent(Show, {
							get when() {
								return hiddenChildAgentsText(view().agentsHidden, view().agentsHiddenCost);
							},
							children: (line) => (() => {
								var _el$46 = createElement("text");
								insert(_el$46, line);
								effect((_$p) => setProp(_el$46, "fg", muted(), _$p));
								return _el$46;
							})()
						}), null);
						return _el$38;
					})()
				}), null);
				return _el$19;
			}
		}), null);
		effect((_p$) => {
			var _v$3 = text(), _v$4 = muted();
			_v$3 !== _p$.e && (_p$.e = setProp(_el$1, "fg", _v$3, _p$.e));
			_v$4 !== _p$.t && (_p$.t = setProp(_el$10, "fg", _v$4, _p$.t));
			return _p$;
		}, {
			e: void 0,
			t: void 0
		});
		return _el$0;
	})();
}
/** Panel actions that only make sense with a row selected. A panel over an
*  empty tree still owns `f`/`escape`, but the navigation keys fall through
*  instead of being swallowed by a no-op. */
const DISPATCH_PANEL_ROW_ACTIONS = /* @__PURE__ */ new Set([
	"up",
	"down",
	"home",
	"end",
	"pageup",
	"pagedown",
	"toggle"
]);
/** One command: runs only while the panel owns the keyboard, and reports
*  `false` (the host keeps the key) when it cannot act. `undefined` means the
*  key was consumed. */
function runDispatchPanelCommand(action, panel, model) {
	if (panel.focused !== true) return false;
	if (DISPATCH_PANEL_ROW_ACTIONS.has(action) && model.rows().length === 0) return false;
	performDispatchPanelAction(action, model, panel);
}
/** Keymap layer of the panel, as data. It is registered inside the
*  `session.panel` claim, but the host mounts the effects of *every* panel
*  contribution, so the layer itself is not proof of focus: without `enabled`
*  the `j/k/f/q/enter/escape` bindings were consumed while the panel was not
*  focused and the composer lost its keys. `enabled` (the documented gate) makes
*  the whole layer inert until `panel.focused` is true. Pure. */
function dispatchPanelKeymapLayer(panel, model) {
	const focused = () => panel.focused === true;
	return {
		mode: "global",
		enabled: focused,
		commands: DISPATCH_PANEL_COMMANDS.map((spec) => ({
			id: spec.id,
			title: spec.title,
			bind: spec.bind,
			run: () => focused() ? runDispatchPanelCommand(spec.action, panel, model) : false
		}))
	};
}
/** Keymap layer of the panel. Created inside the `session.panel` claim, so the
*  host removes it with the panel; it renders nothing. */
function DispatchPanelKeymap(props) {
	props.context.keymap.layer(() => dispatchPanelKeymapLayer(props.panel, props.model));
	return null;
}
/** The full-width dispatch panel: header counters, one row per child session,
*  the detail of the selected child and the key hints. Wide panels put the
*  detail beside the list; narrow ones stack it under the list and every cell is
*  truncated to its own column instead of wrapping. */
function DispatchPanel(props) {
	const model = createDispatchPanelModel(props.context, () => props.panel);
	const text = () => props.context.theme.text?.base;
	const muted = () => props.context.theme.text?.muted ?? text();
	const tone = (value) => props.context.theme?.text?.feedback?.[value]?.base ?? text();
	const rowFg = (state) => {
		if (state === "failed") return tone("error");
		if (state === "running") return tone("success");
		if (state === "interrupted") return tone("warning");
		return text();
	};
	const selected = (id) => id === model.selectedID();
	const rows = () => createComponent(For, {
		get each() {
			return model.visible().rows;
		},
		children: (row) => (() => {
			var _el$47 = createElement("box"), _el$48 = createElement("text"), _el$49 = createElement("text");
			insertNode(_el$47, _el$48);
			insertNode(_el$47, _el$49);
			setProp(_el$47, "flexDirection", "row");
			setProp(_el$47, "flexShrink", 0);
			insert(_el$48, () => selected(row.id) ? `▸ ` : "  ");
			insert(_el$49, () => row.text);
			effect((_p$) => {
				var _v$10 = selected(row.id) ? text() : muted(), _v$11 = rowFg(row.state), _v$12 = selected(row.id) ? 1 : 0;
				_v$10 !== _p$.e && (_p$.e = setProp(_el$48, "fg", _v$10, _p$.e));
				_v$11 !== _p$.t && (_p$.t = setProp(_el$49, "fg", _v$11, _p$.t));
				_v$12 !== _p$.a && (_p$.a = setProp(_el$49, "attributes", _v$12, _p$.a));
				return _p$;
			}, {
				e: void 0,
				t: void 0,
				a: void 0
			});
			return _el$47;
		})()
	});
	const detail = () => createComponent(For, {
		get each() {
			return model.detail();
		},
		children: (line, index) => (() => {
			var _el$50 = createElement("text");
			insert(_el$50, line);
			effect((_$p) => setProp(_el$50, "fg", index() === 0 ? text() : muted(), _$p));
			return _el$50;
		})()
	});
	const empty = () => (() => {
		var _el$51 = createElement("text");
		insertNode(_el$51, createTextNode(`Nenhuma sessão delegada`));
		effect((_$p) => setProp(_el$51, "fg", muted(), _$p));
		return _el$51;
	})();
	return (() => {
		var _el$53 = createElement("box"), _el$54 = createElement("text"), _el$55 = createElement("text"), _el$59 = createElement("box"), _el$60 = createElement("text");
		insertNode(_el$53, _el$54);
		insertNode(_el$53, _el$55);
		insertNode(_el$53, _el$59);
		insertNode(_el$53, _el$60);
		setProp(_el$53, "flexDirection", "column");
		setProp(_el$53, "width", "100%");
		setProp(_el$53, "padding", 1);
		insert(_el$53, createComponent(DispatchPanelKeymap, {
			get context() {
				return props.context;
			},
			get panel() {
				return props.panel;
			},
			model
		}), _el$54);
		setProp(_el$54, "attributes", 1);
		insert(_el$54, () => model.title());
		insert(_el$53, createComponent(Show, {
			get when() {
				return model.header();
			},
			children: (line) => (() => {
				var _el$61 = createElement("text");
				insert(_el$61, line);
				effect((_$p) => setProp(_el$61, "fg", muted(), _$p));
				return _el$61;
			})()
		}), _el$55);
		insert(_el$55, () => dispatchPanelRule(props.panel.width - 2));
		insert(_el$53, createComponent(Show, {
			get when() {
				return model.layout().mode === "wide";
			},
			get fallback() {
				return (() => {
					var _el$62 = createElement("box");
					setProp(_el$62, "flexDirection", "column");
					insert(_el$62, createComponent(Show, {
						get when() {
							return model.rows().length > 0;
						},
						get fallback() {
							return empty();
						},
						get children() {
							var _el$63 = createElement("box");
							setProp(_el$63, "flexDirection", "column");
							insert(_el$63, rows);
							return _el$63;
						}
					}), null);
					insert(_el$62, createComponent(Show, {
						get when() {
							return model.selectedID();
						},
						get children() {
							var _el$64 = createElement("box"), _el$65 = createElement("box");
							insertNode(_el$64, _el$65);
							setProp(_el$64, "flexDirection", "column");
							setProp(_el$65, "height", 1);
							insert(_el$64, detail, null);
							return _el$64;
						}
					}), null);
					return _el$62;
				})();
			},
			get children() {
				var _el$56 = createElement("box"), _el$57 = createElement("box");
				insertNode(_el$56, _el$57);
				setProp(_el$56, "flexDirection", "row");
				setProp(_el$57, "flexDirection", "column");
				insert(_el$57, createComponent(Show, {
					get when() {
						return model.rows().length > 0;
					},
					get fallback() {
						return empty();
					},
					get children() {
						return rows();
					}
				}));
				insert(_el$56, createComponent(Show, {
					get when() {
						return model.selectedID();
					},
					get children() {
						var _el$58 = createElement("box");
						setProp(_el$58, "flexDirection", "column");
						insert(_el$58, detail);
						effect((_$p) => setProp(_el$58, "width", model.layout().detailWidth, _$p));
						return _el$58;
					}
				}), null);
				effect((_$p) => setProp(_el$57, "width", model.layout().listWidth, _$p));
				return _el$56;
			}
		}), _el$59);
		setProp(_el$59, "height", 1);
		insert(_el$60, () => model.footer());
		effect((_p$) => {
			var _v$13 = text(), _v$14 = muted(), _v$15 = muted();
			_v$13 !== _p$.e && (_p$.e = setProp(_el$54, "fg", _v$13, _p$.e));
			_v$14 !== _p$.t && (_p$.t = setProp(_el$55, "fg", _v$14, _p$.t));
			_v$15 !== _p$.a && (_p$.a = setProp(_el$60, "fg", _v$15, _p$.a));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0
		});
		return _el$53;
	})();
}
/** App-level command claim: the only way into the panel. It registers the
*  `pantheon.dispatch.open` command (palette + `/dispatch`) and renders nothing;
*  the panel itself lives behind its own `session.panel` claim. */
function DispatchCommandLayer(props) {
	props.context.keymap.layer(() => ({
		mode: "global",
		commands: [{
			id: "pantheon.dispatch.open",
			title: "Pantheon: Dispatch",
			group: "Pantheon",
			palette: true,
			slash: {
				name: "dispatch",
				aliases: ["pantheon-dispatch"]
			},
			run: () => {
				openDispatchPanel(props.context);
			}
		}]
	}));
	return null;
}
/** Home-screen status contribution. The sidebar slot is session-scoped, so
*  before the first prompt the sidebar may not mount at all (Known Issue) —
*  this keeps a compact Pantheon line visible on the home footer meanwhile. */
function HomeStatus(props) {
	const preset = useActivePreset(props.context).preset;
	const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base;
	return (() => {
		var _el$66 = createElement("text");
		insert(_el$66, () => `Pantheon v1.6.0${preset().name ? ` ▸ ${preset().name}` : ""}`);
		effect((_$p) => setProp(_el$66, "fg", muted(), _$p));
		return _el$66;
	})();
}
/** Lean footer model: only the preset label and the live delegation count. It
*  deliberately does not reuse `createSidebarModel` — that model owns the
*  completion toasts and the spinner, and a second instance would double-toast.
*  No session id in the slot input is a graceful no-op (count 0). */
function createFooterModel(context, sessionID) {
	const [revision, setRevision] = createSignal(0);
	const preset = useActivePreset(context).preset;
	const activeSessionID = () => {
		const id = sessionID();
		return isValidSessionID(id) ? id : "";
	};
	const running = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return 0;
		let family = [];
		try {
			const result = context.data.session.family?.(id);
			if (Array.isArray(result)) family = result;
		} catch {
			return 0;
		}
		const now = Date.now();
		let count = 0;
		for (const childID of family) {
			if (childID === id || !isValidSessionID(childID)) continue;
			try {
				const child = context.data.session.get(childID);
				if (child?.parentID !== id) continue;
				if (toDelegationView(child, sessionStatusOf(context, childID), now).state === "running") count += 1;
			} catch {}
		}
		return count;
	});
	onMount(() => {
		onCleanup(subscribeSidebarRefresh(context, () => setRevision((value) => value + 1)));
	});
	return {
		preset,
		running
	};
}
/** Prompt-footer contribution: `▸<preset> · ✦<n> ativos`, appended next to the
*  native line (never replacing it) and only while a delegation is running. */
function PromptFooter(props) {
	const model = createFooterModel(props.context, () => props.sessionID);
	const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base;
	return createComponent(Show, {
		get when() {
			return model.running() > 0;
		},
		get children() {
			var _el$67 = createElement("text");
			insert(_el$67, () => `▸${model.preset().name ?? "default"} · ✦${model.running()} ativos`);
			effect((_$p) => setProp(_el$67, "fg", muted(), _$p));
			return _el$67;
		}
	});
}
const plugin = Plugin.define({
	id: "pantheon.tui",
	setup(context) {
		const globalState = globalThis;
		if (globalState[SINGLETON]) return;
		globalState[SINGLETON] = true;
		warmUpSidebarData(context, resolveLocation(context));
		const unregisterSidebar = context.ui.slot({
			append: "sidebar.content",
			render: ({ sessionID }) => createComponent(Sidebar, {
				context,
				sessionID
			})
		});
		const unregisterHome = context.ui.slot({
			append: "home.footer.status",
			render: () => createComponent(HomeStatus, { context })
		});
		const unregisterPromptFooter = context.ui.slot({
			append: "prompt.footer",
			render: ({ sessionID }) => createComponent(PromptFooter, {
				context,
				sessionID
			})
		});
		const unregisterPanel = context.ui.slot({
			append: "session.panel",
			render: (panel) => createComponent(Show, {
				get when() {
					return panel.name === DISPATCH_PANEL_NAME;
				},
				get children() {
					return createComponent(DispatchPanel, {
						context,
						panel
					});
				}
			})
		});
		const unregisterCommands = context.ui.slot({
			append: "app",
			render: () => createComponent(DispatchCommandLayer, { context })
		});
		return () => {
			if (typeof unregisterSidebar === "function") unregisterSidebar();
			if (typeof unregisterHome === "function") unregisterHome();
			if (typeof unregisterPromptFooter === "function") unregisterPromptFooter();
			if (typeof unregisterPanel === "function") unregisterPanel();
			if (typeof unregisterCommands === "function") unregisterCommands();
			delete globalState[SINGLETON];
		};
	}
});
//#endregion
export { BLOCK_ICONS, CONTEXT_BAR_CELLS, CONTEXT_BAR_EMPTY_CELL, CONTEXT_BAR_FILLED_CELL, DELEGATION_CHILD_STATUS_GRACE_MS, DISPATCH_AGENT_CEILING, DISPATCH_AGENT_WIDTH, DISPATCH_COST_WIDTH, DISPATCH_COUNT_WIDTH, DISPATCH_DONE_MARKER, DISPATCH_DURATION_WIDTH, DISPATCH_GROUP_COST_WIDTH, DISPATCH_KIND_ORIGIN_LABELS, DISPATCH_MAX_LINES, DISPATCH_MAX_WIDTH, DISPATCH_MIN_AGENT_WIDTH, DISPATCH_MODEL_WIDTH, DISPATCH_PANEL_AGENT_WIDTH, DISPATCH_PANEL_COMMANDS, DISPATCH_PANEL_COST_WIDTH, DISPATCH_PANEL_DASH, DISPATCH_PANEL_DURATION_WIDTH, DISPATCH_PANEL_EMPTY_TEXT, DISPATCH_PANEL_FULLSCREEN_BADGE, DISPATCH_PANEL_HEADER_MARKER, DISPATCH_PANEL_KIND_WIDTH, DISPATCH_PANEL_MIN_AGENT_WIDTH, DISPATCH_PANEL_NAME, DISPATCH_PANEL_PAGE_SIZE, DISPATCH_PANEL_RULE_CHAR, DISPATCH_PANEL_SELECTION_GUTTER, DISPATCH_PANEL_SELECTION_MARKER, DISPATCH_PANEL_TITLE_WIDTH, DISPATCH_PANEL_TOAST, DISPATCH_PANEL_WIDE_MIN_WIDTH, DISPATCH_RUNNING_CEILING, GIT_ARROW_DOWN, GIT_ARROW_UP, GIT_CHANGES_DEBOUNCE_MS, GIT_CLI_DEBOUNCE_MS, GIT_CLI_MAX_BUFFER, GIT_CLI_MIN_INTERVAL_MS, GIT_CLI_TIMEOUT_MS, HEADER_MAX_WIDTH, MODEL_USAGE_COST_WIDTH, MODEL_USAGE_DEBOUNCE_MS, MODEL_USAGE_MESSAGE_LIMIT, MODEL_USAGE_MODEL_WIDTH, MODEL_USAGE_SESSION_LIMIT, MODEL_USAGE_TOKEN_WIDTH, MODEL_USAGE_VISIBLE_CEILING, PRESET_MARKER, SIDEBAR_REFRESH_EVENTS, SIDEBAR_WAITING_LABEL, SPEND_30D_LABEL, SPEND_30D_MS, SPEND_LINE_SEPARATOR, SPEND_PROBE_TOLERANCE_MS, SPEND_PROBE_WINDOW_MS, SPEND_REFRESH_DEBOUNCE_MS, SPEND_TODAY_LABEL, TODO_TEXT_WIDTH, TODO_VISIBLE_CEILING, UNKNOWN_AGENT, agentKey, buildDispatchBlock, cacheHitPercent, ceilingModelUsage, ceilingTodoItems, cellWidth, childAgentRowText, classifyDispatchKind, collectChildAgentUsage, collectDispatch, collectModelUsage, collectSubagentCalls, collectWarmupTargets, completedSummaryText, computeContextUsage, contextBar, contextBarFilled, contextBlockRows, contextPerformanceLine, contextProgressColor, contextSpendLine, contextUsageTone, countGitChanges, createDispatchPanelModel, createFooterModel, createSidebarModel, plugin as default, defaultGitExec, delegationStateFromOutcome, delegationStateFromStatus, detectDelegationCompletions, dispatchAgentText, dispatchElapsed, dispatchHeaderSummary, dispatchKindFromAgent, dispatchKindFromPrefix, dispatchKindSuffix, dispatchModelText, dispatchPanelCell, dispatchPanelDetail, dispatchPanelFooter, dispatchPanelHeader, dispatchPanelKeymapLayer, dispatchPanelLayout, dispatchPanelMarker, dispatchPanelRangeText, dispatchPanelRowText, dispatchPanelRows, dispatchPanelRule, dispatchPanelTitle, dispatchPanelWindow, dispatchTokenLine, dispatchTokens, dispatchTotalCost, failedSuffixText, formatContextWindow, formatDispatchCost, formatDispatchDuration, formatGitChanges, formatGitSnapshot, formatSpendUSD, formatSpent, formatTokenCount, formatUsageCost, formatUsageTokens, gitProbeAllowed, hiddenChildAgentsText, hiddenModelUsageText, hiddenTodoText, isTodoStatus, isValidSessionID, lastAssistantWithTokens, latestTodoItems, messageTokensTotal, modelRefID, modelUsageRowText, modelUsageRows, navigateToSession, openDispatchPanel, orderDispatchEntries, orderTodoItems, padCell, parseGitAheadBehind, parseGitStatusPorcelain, parsePresetOverrides, parseTodoItems, performDispatchPanelAction, presetFromEnv, presetHeaderLine, providerIDFromModels, providerIDFromRef, readGitSnapshot, resetSpendUnit, resolveActivePresetForTui, resolveContextLimit, resolvedSpendUnit, runDispatchPanelCommand, runningChildRowText, shortModelID, shortSessionID, sidebarPlaceholder, spendWindows, spinnerFrame, startOfLocalDay, statsCost, statsRangeMatches, toDelegationView, toDispatchEntry, todoRowText, todoTone, transcriptWindow, truncateLabel, turnTokensPerSecond, withBlockSpacers };

//# sourceMappingURL=tui-v2.js.map
