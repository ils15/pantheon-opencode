import { createComponent, createElement, createTextNode, effect, insert, insertNode, memo, setProp } from "@opentui/solid";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
//#region src/index-v2.tsx
/** @jsxImportSource @opentui/solid */
const SINGLETON = Symbol.for("pantheon.tui.v2.loaded");
/** How often the sidebar re-reads .pantheon/active-preset.json (V1 parity) so
*  `set-tier` changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 3e4;
/** Running delegations rendered before the "… +N more" line (V1 parity). */
const DELEGATIONS_VISIBLE_CEILING = 8;
/** Running-row spinner cadence — matches V1's animation tick. */
const SPINNER_INTERVAL_MS = 80;
/** Bounded warm-up: sync at most this many sessions at plugin load. */
const WARMUP_SESSION_LIMIT = 24;
/** Sidebar body shown while the host has not published a session yet. */
const SIDEBAR_WAITING_LABEL = "Aguardando sessão…";
/** Delegate-completion toast title. */
const TOAST_TITLE = "Pantheon";
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
/** Resolve the active preset for the sidebar: env > file > default. */
async function resolvePresetForTui(env, cwd) {
	return (await resolveActivePresetForTui(env, cwd)).info;
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
/** Context usage for a message list. Scope: everything before the revert
*  boundary (when a revert is active), then after the last compaction. The last
*  assistant message carrying `tokens` in that window wins. Null when there is
*  no limit or no such message — the caller then omits the block. */
function computeContextUsage(messages, contextLimit, revertMessageID) {
	const limit = numberOrNull(contextLimit);
	if (limit === null || limit <= 0) return null;
	if (!Array.isArray(messages) || messages.length === 0) return null;
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
/** Semantic tone for a context percentage: green < 50%, yellow < 75%, red at
*  or above 75%. Reuses the delegation tone union so both rows draw from the
*  same theme tokens. Pure. */
function contextUsageTone(percent) {
	if (percent >= 75) return "error";
	if (percent >= 50) return "warning";
	return "success";
}
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
/** Full single-line text of a context row (`55,320 tokens`,
*  `▰▰▰▰▰▱▱▱▱▱▱▱ 39% of 200K`). Pure. */
function contextRowText(row) {
	if (row === null) return null;
	return `${row.lead ?? ""}${row.tail ?? ""}${row.value}${row.suffix ?? ""}`;
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
/** Clamp a free-form label to the sidebar width without wrapping. */
function truncateLabel(value, max = 28) {
	const text = value.trim();
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}
/** `agente→modelo` identity for a delegation row; either half may be absent. */
function delegationIdentity(view) {
	const agent = view.agent ?? "";
	const model = view.model ?? "";
	if (agent !== "" && model !== "") return `${agent}→${model}`;
	return agent !== "" ? agent : model;
}
/** Sidebar row body: truncated label plus the agent→model identity. */
function delegationSidebarLabel(view, max = 18) {
	const label = truncateLabel(view.label, max);
	const identity = delegationIdentity(view);
	return identity === "" ? label : `${label} · ${identity}`;
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
/** Build a delegation row from a child session + its live status. A terminal
*  `outcome` wins when present (the only V2 primitive that surfaces a
*  delegation failure/interruption once the status is back to idle); otherwise
*  the live status decides, with the absent/idle grace window applied. Pure. */
function toDelegationView(child, status, now = Date.now()) {
	const id = typeof child?.id === "string" ? child.id : "";
	const title = typeof child?.title === "string" && child.title !== "" ? child.title : "";
	const agent = typeof child?.agent === "string" && child.agent !== "" ? child.agent : "";
	return {
		id,
		label: title !== "" ? title : agent !== "" ? agent : id.slice(0, 8),
		state: delegationStateFromOutcome(child?.outcome) ?? delegationStateFromStatus(status, child?.time, now),
		startedAt: numberOrNull(child?.time?.created),
		updatedAt: numberOrNull(child?.time?.updated),
		agent: agent !== "" ? agent : null,
		model: shortModelID(child?.model),
		cost: numberOrNull(child?.cost)
	};
}
const DELEGATION_TONES = {
	running: "warning",
	completed: "success",
	failed: "error",
	interrupted: "warning"
};
/** Whole-row tone: red = failed, green = terminal, yellow = in flight. The
*  glyph stays a redundant channel so the state reads in monochrome. Pure. */
function delegationStateTone(state) {
	return DELEGATION_TONES[state];
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
/** Row marker (`<glyph> `): the animated spinner while running, ✓ when done,
*  ⊘ when interrupted, ✕ on failure. Pure. */
function delegationRowMarker(state, frame = 0) {
	if (state === "running") return `${spinnerFrame(frame)} `;
	if (state === "failed") return "✕ ";
	if (state === "interrupted") return "⊘ ";
	return "✓ ";
}
/** Compact single-unit elapsed label: "12s"/"3m"/"1h"/"2d". Pure. */
function fmtElapsed(ms) {
	const total = Math.max(0, Math.floor(ms / 1e3));
	const days = Math.floor(total / 86400);
	const hours = Math.floor(total % 86400 / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const seconds = total % 60;
	if (days > 0) return `${days}d`;
	if (hours > 0) return `${hours}h`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}
/** Elapsed label for one row: a running job ticks `now - startedAt`; a terminal
*  one is fixed at `updatedAt - startedAt` (em dash when a timestamp is
*  missing). Pure. */
function delegationElapsed(view, now) {
	if (view.state === "running") return view.startedAt === null ? "—" : fmtElapsed(now - view.startedAt);
	if (view.startedAt !== null && view.updatedAt !== null) return fmtElapsed(view.updatedAt - view.startedAt);
	return "—";
}
/** Live rows first (a running job never falls behind the cap), then by most
*  recent activity. Pure. */
function orderDelegations(views) {
	return [...views].sort((a, b) => {
		const activeA = a.state === "running" ? 1 : 0;
		const activeB = b.state === "running" ? 1 : 0;
		if (activeA !== activeB) return activeB - activeA;
		return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
	});
}
/** Cap the panel: at most `maxVisible` rows, the remainder collapsing into the
*  "… +N more" line. Pure. */
function ceilingDelegations(views, maxVisible = 8) {
	const limit = Math.max(0, maxVisible);
	const visible = views.slice(0, limit);
	return {
		visible,
		hidden: Math.max(0, views.length - visible.length)
	};
}
/** Sidebar blocks in render order. Spacing is derived from this list instead of
*  from the view, so a hidden block can never leave an empty gap behind. */
/** One rendered block: its key, and whether a blank line precedes it. */
/** Header glyph per block — one codepoint each, rendered muted before the bold
*  label. The fixed header (version/preset/session) takes none.
*  Measured as one terminal cell by the host (`@opentui/core` counts
*  `emoji-regex` matches as two): ▤ U+25A4 (EAW=A), ◆ U+25C6 (A), ▾ U+25BE (N),
*  ◇ U+25C7 (A), ⌁ U+2301 (N). `☑` U+2611 was rejected for the Todo header
*  because it matches `emoji-regex` and would occupy two cells. */
const BLOCK_ICONS = {
	context: "▤",
	git: "◆",
	todo: "▾",
	agent: "◇",
	dispatch: "⌁"
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
/** Children listed before the "… +N" line. Five keeps the sidebar inside a
*  short pane while still showing the finished job next to the live one. */
const DISPATCH_VISIBLE_CEILING = 5;
/** Column width of the agent (or of its title/id fallback). */
const DISPATCH_AGENT_WIDTH = 12;
/** Column width of the short model id — the model is dropped before the agent
*  or the cost so a row always fits. */
const DISPATCH_MODEL_WIDTH = 7;
/** Column width of the per-dispatch cost (`$0.04`; a sub-cent cost widens it). */
const DISPATCH_COST_WIDTH = 5;
/** Column width of the duration (`12.7s` / `1m04s` / `820ms`). */
const DISPATCH_DURATION_WIDTH = 5;
/** Hard column budget for one row — a Dispatch line never wraps:
*  marker(2) + agent(12) + model(7) + cost(5) + duration(5) + 3 spaces = 34. */
const DISPATCH_MAX_WIDTH = 34;
/** Row marker: ● live, ✓ succeeded, ✗ failed, − interrupted. The glyph is the
*  redundant channel, so the state still reads in monochrome. Pure. */
function dispatchMarker(state) {
	if (state === "running") return "●";
	if (state === "failed") return "✗";
	if (state === "interrupted") return "−";
	return "✓";
}
/** Row tone: live work is the block's only accent, a failed child is red, and
*  every terminal state recedes to muted. Pure. */
function dispatchTone(state) {
	if (state === "running") return "success";
	if (state === "failed") return "error";
	return "muted";
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
/** One Dispatch row, columns aligned:
*  `<marker> <agent> <model> <cost> <duration>`. The agent and model columns are
*  padded, the cost and duration right-aligned, and the model column stays
*  reserved when a child published no model so the numbers line up. When the
*  row would exceed `max` columns the model is dropped first, then the cost —
*  the agent is never cut below `DISPATCH_AGENT_WIDTH`. Pure. */
function dispatchRowText(view, now = Date.now(), max = 34) {
	const marker = `${dispatchMarker(view.state)} `;
	const agent = dispatchAgentText(view);
	const duration = dispatchElapsed(view, now);
	const cost = formatDispatchCost(view.cost);
	const agentColumn = agent.padEnd(12);
	const modelColumn = dispatchModelText(view).padEnd(7);
	const costColumn = cost.padStart(5);
	const durationColumn = duration.padStart(5);
	const limit = Math.max(1, max);
	const full = `${marker}${agentColumn} ${modelColumn} ${costColumn} ${durationColumn}`;
	if (full.length <= limit) return full;
	const withoutModel = `${marker}${agentColumn} ${costColumn} ${durationColumn}`;
	if (withoutModel.length <= limit) return withoutModel;
	return `${marker}${agentColumn} ${durationColumn}`;
}
/** The "… +N" line for children beyond the cap, null when nothing was cut. Pure. */
function hiddenDispatchText(hidden) {
	if (!Number.isFinite(hidden) || hidden <= 0) return null;
	return `\u2026 +${Math.round(hidden)}`;
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
function createSidebarModel(context, sessionID) {
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
	const [gitChanges, setGitChanges] = createSignal(null);
	let gitRequest = 0;
	let gitDebounce;
	const loadGitChanges = async () => {
		const status = vcsStatusCall(context);
		if (status === null) return;
		const request = ++gitRequest;
		try {
			const result = await status({ location: { directory: resolveSidebarCwd(context) } });
			if (request !== gitRequest) return;
			const files = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
			setGitChanges(formatGitChanges(files));
		} catch {}
	};
	const scheduleGitChanges = () => {
		if (vcsStatusCall(context) === null) return;
		if (gitDebounce !== void 0) clearTimeout(gitDebounce);
		gitDebounce = setTimeout(() => {
			gitDebounce = void 0;
			loadGitChanges();
		}, 400);
	};
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
		for (const id of familySessionIDs()) try {
			const result = context.data.session.message?.list?.(id);
			if (!Array.isArray(result)) continue;
			collected.push(...result.slice(-400));
			if (id === rootID) todo = latestTodoItems(result) ?? [];
		} catch {}
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
	const allDelegations = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return [];
		let family = [];
		try {
			const result = context.data.session.family?.(id);
			if (Array.isArray(result)) family = result;
		} catch {
			return [];
		}
		const now = Date.now();
		const views = [];
		for (const childID of family) {
			if (childID === id || !isValidSessionID(childID)) continue;
			const child = context.data.session.get(childID);
			if (child?.parentID !== id) continue;
			views.push(toDelegationView(child, sessionStatusOf(context, childID), now));
		}
		return orderDelegations(views);
	});
	const delegations = createMemo(() => allDelegations().filter((view) => view.state === "running"));
	const hasRunning = createMemo(() => delegations().length > 0);
	const dispatch = createMemo(() => ceilingDelegations(allDelegations(), 5));
	const liveNow = createMemo(() => {
		frame();
		return Date.now();
	});
	const blocks = createMemo(() => {
		const present = [];
		if (contextBlockRows(contextUsage(), cost()) !== null || contextSpendLine(spend()) !== null) present.push("context");
		if (branch() !== null) present.push("git");
		if (todo().visible.length > 0) present.push("todo");
		if (agentModel() !== null) present.push("agent");
		if (dispatch().visible.length > 0) present.push("dispatch");
		return withBlockSpacers(present);
	});
	onMount(() => {
		const unsubscribeAll = subscribeSidebarRefresh(context, () => {
			refresh();
			scheduleGitChanges();
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
		loadSpend();
		createEffect(() => {
			if (!hasRunning()) return;
			const spinner = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
			onCleanup(() => clearInterval(spinner));
		});
		onCleanup(() => {
			if (gitDebounce !== void 0) clearTimeout(gitDebounce);
			if (spendDebounce !== void 0) clearTimeout(spendDebounce);
			if (metricsDebounce !== void 0) clearTimeout(metricsDebounce);
		});
		onCleanup(unsubscribeAll);
	});
	createEffect(() => {
		const views = allDelegations();
		if (activeSessionID() === "") {
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
		delegations,
		dispatch,
		blocks,
		hasRunning,
		frame,
		liveNow,
		preset,
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
*  header at the top of the sidebar deliberately renders no icon. */
function BlockHeader(props) {
	return (() => {
		var _el$6 = createElement("box"), _el$7 = createElement("text"), _el$8 = createElement("text");
		insertNode(_el$6, _el$7);
		insertNode(_el$6, _el$8);
		setProp(_el$6, "flexDirection", "row");
		insert(_el$7, () => `${props.icon} `);
		setProp(_el$8, "attributes", 1);
		insert(_el$8, () => props.label);
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
	const dispatchFg = (state) => {
		const rowTone = dispatchTone(state);
		return rowTone === "muted" ? muted() : tone(rowTone);
	};
	const usageRows = () => modelUsageRows(model.modelUsage().visible);
	const usageHidden = () => hiddenModelUsageText(model.modelUsage().hidden, model.modelUsage().hiddenCost);
	const contextRows = () => contextBlockRows(model.contextUsage(), model.cost());
	const spendLine = () => contextSpendLine(model.spend());
	return (() => {
		var _el$9 = createElement("box"), _el$0 = createElement("text"), _el$1 = createElement("text");
		insertNode(_el$9, _el$0);
		insertNode(_el$9, _el$1);
		setProp(_el$9, "flexDirection", "column");
		setProp(_el$9, "width", "100%");
		setProp(_el$9, "padding", 1);
		setProp(_el$0, "attributes", 1);
		insert(_el$0, `Pantheon v1.6.0-beta.18`);
		insertNode(_el$1, createTextNode(`OpenCode V2 · plugin TUI ativo`));
		insert(_el$9, createComponent(Show, {
			get when() {
				return model.preset().name;
			},
			get fallback() {
				return (() => {
					var _el$24 = createElement("text");
					insertNode(_el$24, createTextNode(`⚡ Preset: default`));
					effect((_$p) => setProp(_el$24, "fg", muted(), _$p));
					return _el$24;
				})();
			},
			children: (name) => (() => {
				var _el$26 = createElement("box"), _el$27 = createElement("text"), _el$29 = createElement("text"), _el$30 = createElement("text");
				insertNode(_el$26, _el$27);
				insertNode(_el$26, _el$29);
				insertNode(_el$26, _el$30);
				setProp(_el$26, "flexDirection", "row");
				insertNode(_el$27, createTextNode(`⚡ Preset: `));
				insert(_el$29, name);
				insert(_el$30, () => ` (${model.preset().source ?? ""})`);
				effect((_p$) => {
					var _v$5 = muted(), _v$6 = text(), _v$7 = muted();
					_v$5 !== _p$.e && (_p$.e = setProp(_el$27, "fg", _v$5, _p$.e));
					_v$6 !== _p$.t && (_p$.t = setProp(_el$29, "fg", _v$6, _p$.t));
					_v$7 !== _p$.a && (_p$.a = setProp(_el$30, "fg", _v$7, _p$.a));
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0
				});
				return _el$26;
			})()
		}), null);
		insert(_el$9, createComponent(Show, {
			get when() {
				return memo(() => model.activeSessionID() !== "")() && model.session();
			},
			get fallback() {
				return (() => {
					var _el$31 = createElement("text");
					insert(_el$31, () => sidebarPlaceholder(props.sessionID));
					effect((_$p) => setProp(_el$31, "fg", muted(), _$p));
					return _el$31;
				})();
			},
			children: (current) => (() => {
				var _el$32 = createElement("text");
				insert(_el$32, () => `Sessão: ${truncateLabel(current().title || current().id)}`);
				effect((_$p) => setProp(_el$32, "fg", text(), _$p));
				return _el$32;
			})()
		}), null);
		insert(_el$9, createComponent(Show, {
			get when() {
				return model.blocks().length > 0;
			},
			get children() {
				var _el$11 = createElement("box");
				setProp(_el$11, "height", 1);
				return _el$11;
			}
		}), null);
		insert(_el$9, createComponent(Show, {
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
						var _el$33 = createElement("box");
						setProp(_el$33, "flexDirection", "column");
						insert(_el$33, createComponent(Show, {
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
						insert(_el$33, createComponent(Show, {
							get when() {
								return rows().percent;
							},
							children: (row) => createComponent(ContextRowView, {
								get row() {
									return row();
								},
								get fg() {
									return tone(row().tone ?? "success");
								},
								get muted() {
									return muted();
								}
							})
						}), null);
						insert(_el$33, createComponent(Show, {
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
						insert(_el$33, createComponent(For, {
							get each() {
								return usageRows();
							},
							children: (row) => (() => {
								var _el$34 = createElement("box"), _el$35 = createElement("text"), _el$36 = createElement("text"), _el$37 = createElement("text");
								insertNode(_el$34, _el$35);
								insertNode(_el$34, _el$36);
								insertNode(_el$34, _el$37);
								setProp(_el$34, "flexDirection", "row");
								insert(_el$35, () => row.model.padEnd(12));
								insert(_el$36, () => `  ${row.tokens.padStart(6)}`);
								insert(_el$37, () => `  ${row.cost.padStart(8)}`);
								effect((_p$) => {
									var _v$8 = muted(), _v$9 = text(), _v$0 = text();
									_v$8 !== _p$.e && (_p$.e = setProp(_el$35, "fg", _v$8, _p$.e));
									_v$9 !== _p$.t && (_p$.t = setProp(_el$36, "fg", _v$9, _p$.t));
									_v$0 !== _p$.a && (_p$.a = setProp(_el$37, "fg", _v$0, _p$.a));
									return _p$;
								}, {
									e: void 0,
									t: void 0,
									a: void 0
								});
								return _el$34;
							})()
						}), null);
						insert(_el$33, createComponent(Show, {
							get when() {
								return usageHidden();
							},
							children: (line) => (() => {
								var _el$38 = createElement("text");
								insert(_el$38, line);
								effect((_$p) => setProp(_el$38, "fg", muted(), _$p));
								return _el$38;
							})()
						}), null);
						return _el$33;
					})()
				}), null);
				insert(_el$12, createComponent(Show, {
					get when() {
						return spendLine();
					},
					children: (line) => (() => {
						var _el$39 = createElement("text");
						insert(_el$39, line);
						effect((_$p) => setProp(_el$39, "fg", muted(), _$p));
						return _el$39;
					})()
				}), null);
				return _el$12;
			}
		}), null);
		insert(_el$9, createComponent(Show, {
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
				insert(_el$14, createComponent(Show, {
					get when() {
						return model.branch();
					},
					children: (value) => (() => {
						var _el$40 = createElement("box"), _el$41 = createElement("box"), _el$42 = createElement("text"), _el$44 = createElement("text");
						insertNode(_el$40, _el$41);
						setProp(_el$40, "flexDirection", "column");
						insert(_el$40, createComponent(BlockHeader, {
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
						}), _el$41);
						insertNode(_el$41, _el$42);
						insertNode(_el$41, _el$44);
						setProp(_el$41, "flexDirection", "row");
						insertNode(_el$42, createTextNode(`⎇ `));
						insert(_el$44, () => truncateLabel(value(), 32));
						insert(_el$40, createComponent(Show, {
							get when() {
								return model.gitChanges();
							},
							children: (changes) => (() => {
								var _el$45 = createElement("text");
								insert(_el$45, changes);
								effect((_$p) => setProp(_el$45, "fg", text(), _$p));
								return _el$45;
							})()
						}), null);
						effect((_p$) => {
							var _v$1 = muted(), _v$10 = text();
							_v$1 !== _p$.e && (_p$.e = setProp(_el$42, "fg", _v$1, _p$.e));
							_v$10 !== _p$.t && (_p$.t = setProp(_el$44, "fg", _v$10, _p$.t));
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$40;
					})()
				}), null);
				return _el$14;
			}
		}), null);
		insert(_el$9, createComponent(Show, {
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
								var _el$46 = createElement("text");
								insert(_el$46, () => todoRowText(item));
								effect((_$p) => setProp(_el$46, "fg", todoFg(item.status), _$p));
								return _el$46;
							})()
						}), null);
						insert(_el$18, createComponent(Show, {
							get when() {
								return hiddenTodoText(model.todo().hidden);
							},
							children: (line) => (() => {
								var _el$47 = createElement("text");
								insert(_el$47, line);
								effect((_$p) => setProp(_el$47, "fg", muted(), _$p));
								return _el$47;
							})()
						}), null);
						return _el$18;
					}
				}), null);
				return _el$16;
			}
		}), null);
		insert(_el$9, createComponent(Show, {
			get when() {
				return block("agent");
			},
			get children() {
				var _el$19 = createElement("box");
				setProp(_el$19, "flexDirection", "column");
				insert(_el$19, createComponent(Show, {
					get when() {
						return spacer("agent");
					},
					get children() {
						var _el$20 = createElement("box");
						setProp(_el$20, "height", 1);
						return _el$20;
					}
				}), null);
				insert(_el$19, createComponent(Show, {
					get when() {
						return model.agentModel();
					},
					children: (identity) => (() => {
						var _el$48 = createElement("box"), _el$49 = createElement("box"), _el$51 = createElement("text");
						insertNode(_el$48, _el$49);
						setProp(_el$48, "flexDirection", "column");
						insert(_el$48, createComponent(BlockHeader, {
							get icon() {
								return BLOCK_ICONS.agent;
							},
							label: "agente",
							get fg() {
								return text();
							},
							get muted() {
								return muted();
							}
						}), _el$49);
						insertNode(_el$49, _el$51);
						setProp(_el$49, "flexDirection", "row");
						insert(_el$49, createComponent(Show, {
							get when() {
								return identity().agent !== "";
							},
							get children() {
								var _el$50 = createElement("text");
								insert(_el$50, () => `${identity().agent} → `);
								effect((_$p) => setProp(_el$50, "fg", muted(), _$p));
								return _el$50;
							}
						}), _el$51);
						insert(_el$51, () => `${identity().model}${identity().overridden ? "*" : ""}`);
						effect((_$p) => setProp(_el$51, "fg", text(), _$p));
						return _el$48;
					})()
				}), null);
				return _el$19;
			}
		}), null);
		insert(_el$9, createComponent(Show, {
			get when() {
				return block("dispatch");
			},
			get children() {
				var _el$21 = createElement("box");
				setProp(_el$21, "flexDirection", "column");
				insert(_el$21, createComponent(Show, {
					get when() {
						return spacer("dispatch");
					},
					get children() {
						var _el$22 = createElement("box");
						setProp(_el$22, "height", 1);
						return _el$22;
					}
				}), null);
				insert(_el$21, createComponent(Show, {
					get when() {
						return model.dispatch().visible.length > 0;
					},
					get children() {
						var _el$23 = createElement("box");
						setProp(_el$23, "flexDirection", "column");
						insert(_el$23, createComponent(BlockHeader, {
							get icon() {
								return BLOCK_ICONS.dispatch;
							},
							label: "Dispatch",
							get fg() {
								return memo(() => !!model.hasRunning())() ? tone("success") : muted();
							},
							get muted() {
								return muted();
							}
						}), null);
						insert(_el$23, createComponent(For, {
							get each() {
								return model.dispatch().visible;
							},
							children: (view) => (() => {
								var _el$52 = createElement("box"), _el$53 = createElement("text");
								insertNode(_el$52, _el$53);
								insert(_el$53, () => dispatchRowText(view, model.liveNow()));
								effect((_p$) => {
									var _v$11 = open(view.id), _v$12 = dispatchFg(view.state);
									_v$11 !== _p$.e && (_p$.e = setProp(_el$52, "onMouseDown", _v$11, _p$.e));
									_v$12 !== _p$.t && (_p$.t = setProp(_el$53, "fg", _v$12, _p$.t));
									return _p$;
								}, {
									e: void 0,
									t: void 0
								});
								return _el$52;
							})()
						}), null);
						insert(_el$23, createComponent(Show, {
							get when() {
								return hiddenDispatchText(model.dispatch().hidden);
							},
							children: (line) => (() => {
								var _el$54 = createElement("text");
								insert(_el$54, line);
								effect((_$p) => setProp(_el$54, "fg", muted(), _$p));
								return _el$54;
							})()
						}), null);
						return _el$23;
					}
				}), null);
				return _el$21;
			}
		}), null);
		effect((_p$) => {
			var _v$3 = text(), _v$4 = muted();
			_v$3 !== _p$.e && (_p$.e = setProp(_el$0, "fg", _v$3, _p$.e));
			_v$4 !== _p$.t && (_p$.t = setProp(_el$1, "fg", _v$4, _p$.t));
			return _p$;
		}, {
			e: void 0,
			t: void 0
		});
		return _el$9;
	})();
}
/** Home-screen status contribution. The sidebar slot is session-scoped, so
*  before the first prompt the sidebar may not mount at all (Known Issue) —
*  this keeps a compact Pantheon line visible on the home footer meanwhile. */
function HomeStatus(props) {
	const preset = useActivePreset(props.context).preset;
	const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base;
	return (() => {
		var _el$55 = createElement("text");
		insert(_el$55, () => `Pantheon v1.6.0-beta.18${preset().name ? ` ⚡ ${preset().name}` : ""}`);
		effect((_$p) => setProp(_el$55, "fg", muted(), _$p));
		return _el$55;
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
/** Prompt-footer contribution: `⚡<preset> · ✦<n> ativos`, appended next to the
*  native line (never replacing it) and only while a delegation is running. */
function PromptFooter(props) {
	const model = createFooterModel(props.context, () => props.sessionID);
	const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base;
	return createComponent(Show, {
		get when() {
			return model.running() > 0;
		},
		get children() {
			var _el$56 = createElement("text");
			insert(_el$56, () => `⚡${model.preset().name ?? "default"} · ✦${model.running()} ativos`);
			effect((_$p) => setProp(_el$56, "fg", muted(), _$p));
			return _el$56;
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
		return () => {
			if (typeof unregisterSidebar === "function") unregisterSidebar();
			if (typeof unregisterHome === "function") unregisterHome();
			if (typeof unregisterPromptFooter === "function") unregisterPromptFooter();
			delete globalState[SINGLETON];
		};
	}
});
//#endregion
export { BLOCK_ICONS, CONTEXT_BAR_CELLS, CONTEXT_BAR_EMPTY_CELL, CONTEXT_BAR_FILLED_CELL, DELEGATIONS_VISIBLE_CEILING, DELEGATION_CHILD_STATUS_GRACE_MS, DISPATCH_AGENT_WIDTH, DISPATCH_COST_WIDTH, DISPATCH_DURATION_WIDTH, DISPATCH_MAX_WIDTH, DISPATCH_MODEL_WIDTH, DISPATCH_VISIBLE_CEILING, GIT_CHANGES_DEBOUNCE_MS, MODEL_USAGE_COST_WIDTH, MODEL_USAGE_DEBOUNCE_MS, MODEL_USAGE_MESSAGE_LIMIT, MODEL_USAGE_MODEL_WIDTH, MODEL_USAGE_SESSION_LIMIT, MODEL_USAGE_TOKEN_WIDTH, MODEL_USAGE_VISIBLE_CEILING, SIDEBAR_REFRESH_EVENTS, SIDEBAR_WAITING_LABEL, SPEND_30D_LABEL, SPEND_30D_MS, SPEND_LINE_SEPARATOR, SPEND_PROBE_TOLERANCE_MS, SPEND_PROBE_WINDOW_MS, SPEND_REFRESH_DEBOUNCE_MS, SPEND_TODAY_LABEL, TODO_TEXT_WIDTH, TODO_VISIBLE_CEILING, ceilingDelegations, ceilingModelUsage, ceilingTodoItems, collectModelUsage, collectWarmupTargets, computeContextUsage, contextBar, contextBarFilled, contextBlockRows, contextRowText, contextSpendLine, contextUsageTone, countGitChanges, createFooterModel, createSidebarModel, plugin as default, delegationElapsed, delegationIdentity, delegationRowMarker, delegationSidebarLabel, delegationStateFromOutcome, delegationStateFromStatus, delegationStateTone, detectDelegationCompletions, dispatchAgentText, dispatchElapsed, dispatchMarker, dispatchModelText, dispatchRowText, dispatchTone, fmtElapsed, formatContextWindow, formatDispatchCost, formatDispatchDuration, formatGitChanges, formatSpendUSD, formatSpent, formatTokenCount, formatUsageCost, formatUsageTokens, hiddenDispatchText, hiddenModelUsageText, hiddenTodoText, isTodoStatus, isValidSessionID, latestTodoItems, messageTokensTotal, modelRefID, modelUsageRowText, modelUsageRows, navigateToSession, orderDelegations, orderTodoItems, parsePresetOverrides, parseTodoItems, presetFromEnv, resetSpendUnit, resolveActivePresetForTui, resolveContextLimit, resolvePresetForTui, resolvedSpendUnit, shortModelID, sidebarPlaceholder, spendWindows, spinnerFrame, startOfLocalDay, statsCost, statsRangeMatches, toDelegationView, todoRowText, todoTone, truncateLabel, withBlockSpacers };

//# sourceMappingURL=tui-v2.js.map
