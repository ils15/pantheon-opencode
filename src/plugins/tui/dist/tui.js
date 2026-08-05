import { createComponent, createElement, createTextNode, effect, insert, insertNode, memo, setProp } from "@opentui/solid";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
//#region src/index.tsx
/** @jsxImportSource @opentui/solid */
/**
* pantheon-tui — Pantheon TUI plugin for opencode.
*
* Single self-contained entry file: `tsdown && cp src/index.tsx dist/tui.tsx`
* keeps the no-build load path working (dist/tui.tsx is raw source, transpiled
* on the fly by opencode). All feature code lives in this one file.
*
* Slots:
*   - sidebar_content        (order 900) — Pantheon sidebar (header/version/
*     branch, Sessions, Commands, Agents, Config, Memory).
*   - app_bottom             (order 60)  — AI subscription usage gauges
*     (Anthropic/OpenAI quotas, OpenCode Go/Zen dollar limits + provider
*     status incidents).
*
* ─────────────────────────────────────────────────────────────────────────────
* VENDORED FEATURES (MIT) — incorporated with their license headers preserved:
*
*   • satas20/opencode-usage-bar (MIT)
*       https://github.com/satas20/opencode-usage-bar
*
*   v1.2.0 added an OpenCode Go/Zen usage provider (`opencodego`) on top of
*   the vendored base — dollar-denominated rolling limits ($12/5h, $30/7d,
*   $60/month) via the same key used for inference. Still MIT-credited to
*   satas20 for the original bar/config/poll code.
*
* satas20/opencode-todo-progress was vendored in v1.1.0 alongside the
* usage-bar but has since been REMOVED as redundant — the native session
* footer already surfaces todo/context state, so its todo bar slot was
* dropped entirely. Only usage-bar code remains.
* ─────────────────────────────────────────────────────────────────────────────
*
* LIMITATION — native context/tokens statusline:
*   The opencode session footer natively shows a context/tokens statusline
*   next to the prompt. There is NO config option to hide it: the tui.json
*   schema (opencode.ai/tui.json) only exposes `theme`, `keybinds`,
*   `scroll_speed`, `scroll_acceleration`, `diff_style`, `mouse` and
*   `attention`, and the SDK `Config` type has no statusline/tokens display
*   flag (checked against @opencode-ai/sdk `Config` and the published
*   schema). The Pantheon sidebar therefore no longer duplicates that footer
*   (the old ContextBar was removed) and we deliberately do NOT hack the
*   native footer. Track upstream: opencode statusline config.
*/
const COMMANDS = [
	{
		name: "/pantheon",
		desc: "Council synthesis"
	},
	{
		name: "/pantheon-status",
		desc: "System status"
	},
	{
		name: "/pantheon-audit",
		desc: "Full audit"
	},
	{
		name: "/pantheon-bg",
		desc: "List background tasks"
	},
	{
		name: "/pantheon-cancel",
		desc: "Cancel task"
	},
	{
		name: "/pantheon-deepwork",
		desc: "Deep work mode"
	},
	{
		name: "/pantheon-focus",
		desc: "Focus on scope"
	},
	{
		name: "/pantheon-remember",
		desc: "Memory store/recall"
	},
	{
		name: "/pantheon-search",
		desc: "Memory search"
	},
	{
		name: "/pantheon-consolidate",
		desc: "Merge memories"
	},
	{
		name: "/pantheon-forget",
		desc: "Compress memories"
	}
];
/** How often the sidebar re-reads .pantheon/active-preset.json so `set-tier`
*  changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 3e4;
const AGENTS = [
	{
		name: "zeus",
		tier: "default",
		role: "Orchestrator"
	},
	{
		name: "athena",
		tier: "premium",
		role: "Strategic planner"
	},
	{
		name: "apollo",
		tier: "fast",
		role: "Codebase discovery"
	},
	{
		name: "hermes",
		tier: "default",
		role: "Backend"
	},
	{
		name: "aphrodite",
		tier: "default",
		role: "Frontend"
	},
	{
		name: "demeter",
		tier: "default",
		role: "Database"
	},
	{
		name: "themis",
		tier: "premium",
		role: "Quality & security"
	},
	{
		name: "prometheus",
		tier: "default",
		role: "Infrastructure"
	},
	{
		name: "hephaestus",
		tier: "default",
		role: "AI pipelines"
	},
	{
		name: "nyx",
		tier: "fast",
		role: "Observability"
	},
	{
		name: "gaia",
		tier: "fast",
		role: "Remote sensing"
	},
	{
		name: "iris",
		tier: "fast",
		role: "GitHub operations"
	},
	{
		name: "mnemosyne",
		tier: "fast",
		role: "Memory bank"
	},
	{
		name: "talos",
		tier: "fast",
		role: "Hotfixes"
	}
];
function fmtInt(n) {
	return Intl.NumberFormat("en-US").format(Math.max(0, Math.round(n)));
}
/** Read .pantheon/active-preset.json — mirrors the presets.mjs file leg:
*  first existing candidate wins; malformed JSON or a `preset` that is
*  missing, empty or "none" → null (no fall-through to lower candidates). */
async function readActivePresetFile(cwd) {
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
				name,
				source: "file"
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
/** Resolve the active preset for the sidebar: env > file > default. */
async function resolvePresetForTui(env, cwd) {
	const envPreset = presetFromEnv(env);
	if (envPreset.source === "env") return envPreset;
	return await readActivePresetFile(cwd) ?? {
		name: null,
		source: null
	};
}
async function detectVersion(api) {
	try {
		const match = (await readFile(fileURLToPath(new URL("../../../../package.json", import.meta.url)), "utf8")).match(/"version":\s*"([^"]+)"/);
		if (match?.[1]) return match[1];
	} catch {}
	try {
		const wt = api.state.path?.worktree ?? "";
		const fp = wt ? `${wt}/package.json` : "package.json";
		const result = await api.client.file.read({ path: fp });
		const match = String(result?.data?.content ?? "").match(/"version":\s*"([^"]+)"/);
		if (match?.[1]) return match[1];
	} catch {}
	try {
		const proc = api.client?.process;
		if (typeof proc?.exec === "function") {
			const r = await proc.exec({
				command: "git",
				args: [
					"describe",
					"--tags",
					"--always"
				],
				timeoutMs: 3e3
			});
			const tag = (r.stdout ?? r.output ?? "").trim().replace(/^v/, "").replace(/-\d+-g[0-9a-f]+$/, "");
			if (tag && tag !== "5.0.0") return tag;
		}
	} catch {}
	try {
		const proc = api.client?.process;
		if (typeof proc?.exec === "function") {
			const r = await proc.exec({
				command: "opencode",
				args: ["--version"],
				timeoutMs: 3e3
			});
			const ver = (r.stdout ?? r.output ?? "").trim().replace(/^v/, "");
			if (ver) return ver;
		}
	} catch {}
	return null;
}
/**
* usage-bar — AI subscription usage gauge for the opencode TUI.
*
* Renders a compact usage strip in the `app_bottom` slot — a full-width row
* just below the session footer:
*
*   ▓▓▓▓░░ 65% · 0h 11m                                  (one window)
*   cld ▓▓▓▓░ 65% · 0h 11m  7d ▓░░░░ 19% · 1d 11h   oai ▓░░░░ 12% · 3h 4m
*   ! cld ▓▓▓▓░ 65% · 0h 11m                             (anthropic incident)
*
* Providers:
*   anthropic — Claude Pro/Max via the OAuth token in ~/.claude/.credentials.json
*   openai    — ChatGPT Plus/Pro via the Codex CLI login in ~/.codex/auth.json
*   opencodego— OpenCode Go/Zen dollar limits ($12/5h, $30/7d, $60/mo) via
*               PANTHEON_OPENCODE_API_KEY (fallback OPENCODE_API_KEY). No
*               status page — the provider hides silently when unconfigured
*               or when the (not yet public) usage endpoint is unavailable.
*
* When a provider's public status page reports an incident, a colored `!`
* marker appears next to its prefix (red = major/critical, amber = minor,
* cyan = maintenance). The usage bar itself is unaffected. Disable with
* `show_status = false` under `[ui]`.
*
* Configured via ~/.config/opencode/usage-bar.toml (auto-created with
* commented defaults on first run; read once at startup). Tokens/keys are
* only ever sent to their own provider's API host.
*
* Loaded via tui.json, e.g.:
*   { "plugin": ["@satas/opencode-usage-bar"] }      // published npm package
*   { "plugin": ["/abs/path/to/src/index.tsx"] }     // local file (no build)
*/
const POLL_MS = 12e4;
const FETCH_TIMEOUT_MS = 1e4;
const CONFIG_FILE = "usage-bar.toml";
/** Which quota window a value belongs to; toggled per provider in config. */
/** Provider health from the vendor's public status page (Statuspage schema). */
function expandTilde(p) {
	return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
function fmtDuration(ms) {
	const totalMinutes = Math.max(0, Math.ceil(ms / 6e4));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor(totalMinutes % 1440 / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	return `${hours}h ${minutes}m`;
}
/** Decode a JWT's `exp` claim (unix seconds) without verifying. 0 on failure. */
function jwtExp(token) {
	try {
		const payload = token.split(".")[1];
		if (!payload) return 0;
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return typeof claims.exp === "number" ? claims.exp : 0;
	} catch {
		return 0;
	}
}
async function fetchJson(url, headers) {
	try {
		const res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}
/** Fetch a vendor's overall status from its public Statuspage JSON endpoint.
*  Returns the `indicator` ("none" when healthy), or `null` when the fetch
*  itself failed — so a network blip never clears a known incident. */
async function fetchStatus(url) {
	const data = await fetchJson(url, {});
	if (!data?.status) return null;
	const indicator = data.status.indicator;
	return indicator === "minor" || indicator === "major" || indicator === "critical" || indicator === "maintenance" ? indicator : "none";
}
/** Set from `api.state.path.state` at startup; default matches opencode's
*  XDG data dir. */
let opencodeAuthFile = join(homedir(), ".local", "share", "opencode", "auth.json");
/** Read a provider's entry from opencode's own auth store
*  (`opencode auth login`). Returns null when missing/unreadable. */
async function opencodeAuth(...ids) {
	try {
		const auth = JSON.parse(await readFile(opencodeAuthFile, "utf8"));
		for (const id of ids) {
			const entry = auth[id];
			if (entry) return entry;
		}
		return null;
	} catch {
		return null;
	}
}
/** Claude Pro/Max — Anthropic's OAuth usage endpoint (same one Claude Code's
*  `/usage` uses). Token from ~/.claude/.credentials.json, falling back to
*  opencode's own auth store; sent only to api.anthropic.com. */
const anthropicProvider = {
	id: "anthropic",
	short: "cld",
	statusUrl: "https://status.anthropic.com/api/v2/status.json",
	async fetchUsage(cfg) {
		let token;
		try {
			const path = expandTilde(cfg.credentialsPath ?? join(homedir(), ".claude", ".credentials.json"));
			const oauth = JSON.parse(await readFile(path, "utf8")).claudeAiOauth;
			if (oauth?.accessToken && !(oauth.expiresAt && Date.now() >= oauth.expiresAt)) token = oauth.accessToken;
		} catch {}
		if (!token) {
			const entry = await opencodeAuth("anthropic");
			if (entry?.access && !(entry.expires && Date.now() >= entry.expires)) token = entry.access;
		}
		if (!token) return null;
		const data = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
			authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20"
		});
		if (!data || !Array.isArray(data.limits)) return null;
		const windows = [];
		for (const limit of data.limits) {
			if (!limit || typeof limit.percent !== "number" || !Number.isFinite(limit.percent)) continue;
			if (!limit.kind || !limit.resets_at) continue;
			const resetsAt = Date.parse(limit.resets_at);
			if (Number.isNaN(resetsAt)) continue;
			const category = limit.kind === "session" ? "5h" : limit.kind === "weekly_all" ? "7d" : "model";
			const label = category === "model" ? limit.scope?.model?.display_name ?? "model" : category;
			windows.push({
				category,
				label,
				percent: limit.percent,
				resetsAt
			});
		}
		windows.sort((a, b) => Number(b.category === "5h") - Number(a.category === "5h"));
		return windows.length > 0 ? windows : null;
	}
};
/** ChatGPT Plus/Pro (Codex) — reads the Codex CLI login and asks the wham
*  usage endpoint. Read-only: never refreshes/rewrites auth.json; when the
*  token is expired we simply hide (Codex CLI refreshes the file itself). */
const openaiProvider = {
	id: "openai",
	short: "oai",
	statusUrl: "https://status.openai.com/api/v2/status.json",
	async fetchUsage(cfg) {
		let accessToken;
		let accountId;
		try {
			const path = expandTilde(cfg.codexAuthPath ?? join(homedir(), ".codex", "auth.json"));
			const tokens = JSON.parse(await readFile(path, "utf8")).tokens;
			const exp = tokens?.access_token ? jwtExp(tokens.access_token) : 0;
			if (tokens?.access_token && !(exp > 0 && exp * 1e3 <= Date.now() + 6e4)) {
				accessToken = tokens.access_token;
				accountId = tokens.account_id;
			}
		} catch {}
		if (!accessToken) {
			const entry = await opencodeAuth("openai");
			if (entry?.access && !(entry.expires && Date.now() >= entry.expires)) {
				accessToken = entry.access;
				accountId = entry.accountId;
			}
		}
		if (!accessToken) return null;
		const headers = {
			authorization: `Bearer ${accessToken}`,
			"user-agent": "codex-cli"
		};
		if (accountId) headers["chatgpt-account-id"] = accountId;
		const data = await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers);
		if (!data?.rate_limit) return null;
		const windows = [];
		const primary = parseWhamWindow(data.rate_limit.primary_window, "5h");
		if (primary) windows.push(primary);
		const secondary = parseWhamWindow(data.rate_limit.secondary_window, "7d");
		if (secondary) windows.push(secondary);
		windows.sort((a, b) => Number(b.category === "5h") - Number(a.category === "5h"));
		return windows.length > 0 ? windows : null;
	}
};
function parseWhamWindow(w, fallback) {
	if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) return null;
	let resetsAt;
	if (typeof w.reset_at === "number") resetsAt = w.reset_at * 1e3;
	else if (typeof w.reset_after_seconds === "number") resetsAt = Date.now() + w.reset_after_seconds * 1e3;
	if (!resetsAt || !Number.isFinite(resetsAt)) return null;
	const category = typeof w.limit_window_seconds === "number" && w.limit_window_seconds > 0 ? w.limit_window_seconds <= 21600 ? "5h" : "7d" : fallback;
	return {
		category,
		label: category,
		percent: w.used_percent,
		resetsAt
	};
}
const providers = [
	anthropicProvider,
	openaiProvider,
	{
		id: "opencodego",
		short: "go",
		async fetchUsage(_cfg) {
			const token = process.env.PANTHEON_OPENCODE_API_KEY ?? process.env.OPENCODE_API_KEY;
			if (!token) return null;
			const data = await fetchJson("https://opencode.ai/zen/go/v1/usage", { authorization: `Bearer ${token}` });
			if (!data) return null;
			const windows = [];
			const push = (w, category) => {
				if (!w) return;
				if (typeof w.usagePercent !== "number" || !Number.isFinite(w.usagePercent)) return;
				if (typeof w.resetInSec !== "number" || !Number.isFinite(w.resetInSec)) return;
				windows.push({
					category,
					label: category,
					percent: Math.round(w.usagePercent),
					resetsAt: Date.now() + w.resetInSec * 1e3
				});
			};
			push(data.rolling5h, "5h");
			push(data.weekly, "7d");
			push(data.monthly, "1m");
			return windows.length > 0 ? windows : null;
		}
	}
];
const DEFAULT_TOML = `# opencode-usage-bar configuration
# Read once at startup — restart opencode after editing.

[ui]
show_bars = true      # render ▓▓░░ mini-bars (false = text only)
show_status = true    # show a ! marker next to a provider during incidents
# bar_width = 6       # override bar width (default: 6 for a single window, 5 otherwise)

[anthropic]
enabled = true        # Claude Pro/Max via ~/.claude/.credentials.json
show_5h = true        # rolling 5-hour session window
show_7d = false       # weekly cap across all models
show_model = false    # per-model weekly windows (e.g. Fable)
# credentials_path = "~/.claude/.credentials.json"

[openai]
enabled = false       # ChatGPT Plus/Pro via the Codex CLI login
show_5h = true
show_7d = false
# codex_auth_path = "~/.codex/auth.json"

[opencodego]
enabled = true        # OpenCode Go/Zen dollar usage via PANTHEON_OPENCODE_API_KEY
show_5h = true        # rolling 5-hour window ($12)
show_7d = true        # rolling 7-day window ($30)
show_1m = false       # subscription-month window ($60) — opt-in
# Falls back to OPENCODE_API_KEY when PANTHEON_OPENCODE_API_KEY is unset.
`;
function defaultConfig() {
	const show = (over = {}) => ({
		"5h": true,
		"7d": false,
		"1m": false,
		model: false,
		...over
	});
	return {
		showBars: true,
		showStatus: true,
		providers: {
			anthropic: {
				enabled: true,
				show: show()
			},
			openai: {
				enabled: false,
				show: show()
			},
			opencodego: {
				enabled: true,
				show: show({ "7d": true })
			}
		}
	};
}
function asTable(v) {
	return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function bool(v, fallback) {
	return typeof v === "boolean" ? v : fallback;
}
function str(v) {
	return typeof v === "string" && v.length > 0 ? v : void 0;
}
function parseConfig(raw) {
	const toml = globalThis.Bun?.TOML;
	if (!toml?.parse) return defaultConfig();
	const root = asTable(toml.parse(raw));
	const cfg = defaultConfig();
	const ui = asTable(root["ui"]);
	cfg.showBars = bool(ui["show_bars"], cfg.showBars);
	cfg.showStatus = bool(ui["show_status"], cfg.showStatus);
	const rawWidth = ui["bar_width"];
	if (typeof rawWidth === "number" && Number.isFinite(rawWidth) && rawWidth >= 1) cfg.barWidth = Math.min(40, Math.floor(rawWidth));
	for (const id of [
		"anthropic",
		"openai",
		"opencodego"
	]) {
		const t = asTable(root[id]);
		const p = cfg.providers[id];
		p.enabled = bool(t["enabled"], p.enabled);
		p.show["5h"] = bool(t["show_5h"], p.show["5h"]);
		p.show["7d"] = bool(t["show_7d"], p.show["7d"]);
		p.show["1m"] = bool(t["show_1m"], p.show["1m"]);
		p.show.model = bool(t["show_model"], p.show.model);
		const credentialsPath = str(t["credentials_path"]);
		if (credentialsPath !== void 0) p.credentialsPath = credentialsPath;
		const codexAuthPath = str(t["codex_auth_path"]);
		if (codexAuthPath !== void 0) p.codexAuthPath = codexAuthPath;
	}
	return cfg;
}
/** Load `<config dir>/usage-bar.toml`, creating it with commented defaults on
*  first run. Any failure falls back to defaults without touching an existing
*  file. */
async function loadConfig(configPath) {
	const dir = configPath && !configPath.endsWith(".json") ? configPath : configPath ? dirname(configPath) : join(homedir(), ".config", "opencode");
	const file = join(dir, CONFIG_FILE);
	try {
		const raw = await readFile(file, "utf8");
		try {
			return parseConfig(raw);
		} catch {
			return defaultConfig();
		}
	} catch (err) {
		if (err?.code === "ENOENT") try {
			await mkdir(dir, { recursive: true });
			await writeFile(file, DEFAULT_TOML, { flag: "wx" });
		} catch {}
		return defaultConfig();
	}
}
/** Vendored usage-bar plugin init: reads config, seeds the kv cache, starts
*  the poll loop and registers the `app_bottom` slot. Skips everything (and
*  registers nothing) when no provider is enabled — mirrors the standalone
*  plugin's early return. */
async function setupUsageBar(api) {
	const config = await loadConfig(api.state.path?.config);
	if (api.state.path?.state) opencodeAuthFile = join(api.state.path.state, "auth.json");
	const enabled = providers.filter((p) => config.providers[p.id].enabled);
	if (enabled.length === 0) return;
	const seed = {};
	for (const p of enabled) {
		const cached = api.kv.get(`usage-bar.${p.id}.windows`, void 0);
		if (cached) seed[p.id] = cached;
	}
	const [byProvider, setByProvider] = createSignal(seed);
	const [byStatus, setByStatus] = createSignal({});
	const [now, setNow] = createSignal(Date.now());
	setInterval(() => setNow(Date.now()), 1e3);
	for (const p of enabled) {
		const cfg = config.providers[p.id];
		const poll = async () => {
			const statusP = config.showStatus && p.statusUrl ? fetchStatus(p.statusUrl) : null;
			const [all, status] = await Promise.all([p.fetchUsage(cfg), statusP]);
			if (all) {
				const windows = all.filter((w) => cfg.show[w.category] && w.resetsAt > Date.now());
				setByProvider((prev) => ({
					...prev,
					[p.id]: windows
				}));
				api.kv.set(`usage-bar.${p.id}.windows`, windows);
			}
			if (status !== null) setByStatus((prev) => ({
				...prev,
				[p.id]: status
			}));
			setTimeout(poll, all ? POLL_MS : POLL_MS * 3);
		};
		poll();
	}
	api.slots.register({
		order: 60,
		slots: { app_bottom() {
			const theme = () => api.theme.current;
			const groups = createMemo(() => {
				const map = byProvider();
				const statusMap = byStatus();
				const out = [];
				for (const p of enabled) {
					const windows = (map[p.id] ?? []).filter((w) => w.resetsAt > now());
					if (windows.length > 0) out.push({
						short: p.short,
						status: statusMap[p.id] ?? "none",
						windows
					});
				}
				return out;
			});
			const totalWindows = createMemo(() => groups().reduce((sum, g) => sum + g.windows.length, 0));
			const barWidth = createMemo(() => config.barWidth ?? (totalWindows() === 1 ? 6 : 5));
			const multiProvider = createMemo(() => groups().length >= 2);
			const pctOf = (w) => Math.min(100, Math.max(0, Math.round(w.percent)));
			const filledOf = (w) => Math.min(barWidth(), Math.max(0, Math.round(pctOf(w) / 100 * barWidth())));
			const colorOf = (w) => {
				const t = theme();
				const pct = pctOf(w);
				if (pct > 85) return t.error;
				if (pct >= 50) return t.warning;
				return t.success;
			};
			const statusColor = (s) => {
				const t = theme();
				if (s === "critical" || s === "major") return t.error;
				if (s === "minor") return t.warning;
				return t.info;
			};
			return createComponent(Show, {
				get when() {
					return groups().length > 0;
				},
				get children() {
					var _el$ = createElement("box");
					setProp(_el$, "flexDirection", "row");
					setProp(_el$, "gap", 3);
					setProp(_el$, "alignItems", "center");
					setProp(_el$, "width", "100%");
					setProp(_el$, "paddingLeft", 1);
					insert(_el$, createComponent(For, {
						get each() {
							return groups();
						},
						children: (g) => (() => {
							var _el$2 = createElement("box");
							setProp(_el$2, "flexDirection", "row");
							setProp(_el$2, "gap", 2);
							setProp(_el$2, "alignItems", "center");
							setProp(_el$2, "flexShrink", 0);
							insert(_el$2, createComponent(Show, {
								get when() {
									return memo(() => !!config.showStatus)() && g.status !== "none";
								},
								get children() {
									var _el$3 = createElement("text");
									insertNode(_el$3, createTextNode(`!`));
									effect((_$p) => setProp(_el$3, "fg", statusColor(g.status), _$p));
									return _el$3;
								}
							}), null);
							insert(_el$2, createComponent(Show, {
								get when() {
									return multiProvider();
								},
								get children() {
									var _el$5 = createElement("text");
									insert(_el$5, () => g.short);
									effect((_$p) => setProp(_el$5, "fg", theme().textMuted, _$p));
									return _el$5;
								}
							}), null);
							insert(_el$2, createComponent(For, {
								get each() {
									return g.windows;
								},
								children: (w) => (() => {
									var _el$6 = createElement("box"), _el$1 = createElement("text"), _el$10 = createTextNode(`%`), _el$11 = createElement("text");
									insertNode(_el$6, _el$1);
									insertNode(_el$6, _el$11);
									setProp(_el$6, "flexDirection", "row");
									setProp(_el$6, "gap", 1);
									setProp(_el$6, "alignItems", "center");
									setProp(_el$6, "flexShrink", 0);
									insert(_el$6, createComponent(Show, {
										get when() {
											return g.windows.length >= 2;
										},
										get children() {
											var _el$7 = createElement("text");
											insert(_el$7, () => w.label);
											effect((_$p) => setProp(_el$7, "fg", theme().textMuted, _$p));
											return _el$7;
										}
									}), _el$1);
									insert(_el$6, createComponent(Show, {
										get when() {
											return config.showBars;
										},
										get children() {
											var _el$8 = createElement("box"), _el$9 = createElement("text"), _el$0 = createElement("text");
											insertNode(_el$8, _el$9);
											insertNode(_el$8, _el$0);
											setProp(_el$8, "flexDirection", "row");
											insert(_el$9, () => "▓".repeat(filledOf(w)));
											insert(_el$0, () => "░".repeat(barWidth() - filledOf(w)));
											effect((_p$) => {
												var _v$ = colorOf(w), _v$2 = theme().textMuted;
												_v$ !== _p$.e && (_p$.e = setProp(_el$9, "fg", _v$, _p$.e));
												_v$2 !== _p$.t && (_p$.t = setProp(_el$0, "fg", _v$2, _p$.t));
												return _p$;
											}, {
												e: void 0,
												t: void 0
											});
											return _el$8;
										}
									}), _el$1);
									insertNode(_el$1, _el$10);
									insert(_el$1, () => pctOf(w), _el$10);
									insert(_el$11, () => `· ${fmtDuration(w.resetsAt - now())}`);
									effect((_p$) => {
										var _v$3 = theme().text, _v$4 = theme().textMuted;
										_v$3 !== _p$.e && (_p$.e = setProp(_el$1, "fg", _v$3, _p$.e));
										_v$4 !== _p$.t && (_p$.t = setProp(_el$11, "fg", _v$4, _p$.t));
										return _p$;
									}, {
										e: void 0,
										t: void 0
									});
									return _el$6;
								})()
							}), null);
							return _el$2;
						})()
					}));
					return _el$;
				}
			});
		} }
	});
}
function SessionRow(props) {
	const theme = () => props.api.theme.current;
	const status = createMemo(() => {
		try {
			const s = props.api.state.session?.status?.(props.session.id);
			if (s?.type) return s.type;
		} catch {}
		return null;
	});
	const statusIcon = createMemo(() => {
		switch (status()) {
			case "busy": return "● ";
			case "retry": return "⚠ ";
			default: return "";
		}
	});
	return (() => {
		var _el$12 = createElement("text");
		insert(_el$12, () => `${statusIcon()}${props.session?.id?.slice(0, 8) ?? "????"}... ${props.session?.title?.slice(0, 26) ?? "(untitled)"}`);
		effect((_$p) => setProp(_el$12, "fg", theme().textMuted, _$p));
		return _el$12;
	})();
}
function View(props) {
	const [showCommands, setShowCommands] = createSignal(false);
	const [showAgents, setShowAgents] = createSignal(false);
	const [showConfig, setShowConfig] = createSignal(false);
	const [showSessions, setShowSessions] = createSignal(false);
	const theme = () => props.api.theme.current;
	const branch = createMemo(() => props.api.state.vcs?.branch ? `\u2387 ${props.api.state.vcs.branch}` : null);
	const [preset, setPreset] = createSignal(presetFromEnv(process.env));
	onMount(() => {
		const cwd = (props.api.state.path?.worktree ?? "") || process.cwd();
		let cancelled = false;
		const refresh = async () => {
			try {
				const info = await resolvePresetForTui(process.env, cwd);
				if (!cancelled) setPreset(info);
			} catch {}
		};
		refresh();
		const timer = setInterval(() => void refresh(), PRESET_REFRESH_MS);
		onCleanup(() => {
			cancelled = true;
			clearInterval(timer);
		});
	});
	const [sessionList, { refetch: refetchSessions }] = createResource(async () => {
		try {
			return await props.api.client?.session?.list?.({ limit: 100 }) ?? { data: [] };
		} catch {
			return { data: [] };
		}
	});
	const totalSessions = createMemo(() => {
		const result = sessionList();
		if (!result) return 0;
		const data = result.data ?? result;
		if (!Array.isArray(data)) return 0;
		return data.filter((s) => !s.parentID).length;
	});
	const recentSessions = createMemo(() => {
		const result = sessionList();
		if (!result) return [];
		const data = result.data ?? result;
		if (!Array.isArray(data)) return [];
		return data.filter((s) => !s.parentID && s.id !== props.sessionID).sort((a, b) => {
			const ta = a.time?.updated ?? a.updated ?? 0;
			return (b.time?.updated ?? b.updated ?? 0) - ta;
		}).slice(0, 8);
	});
	const [memoryCount, setMemoryCount] = createSignal(null);
	onMount(() => {
		const cleanup = [];
		try {
			cleanup.push(props.api.event.on("session.status", refetchSessions));
			cleanup.push(props.api.event.on("session.created", refetchSessions));
			cleanup.push(props.api.event.on("session.updated", refetchSessions));
			cleanup.push(props.api.event.on("session.deleted", refetchSessions));
		} catch {}
		try {
			const ev = props.api.event;
			if (typeof ev?.on === "function") {
				cleanup.push(ev.on("memory.created", () => setMemoryCount((c) => c !== null ? c + 1 : 1)));
				cleanup.push(ev.on("memory.deleted", () => setMemoryCount((c) => c !== null ? Math.max(0, c - 1) : 0)));
			}
		} catch {}
		onCleanup(() => cleanup.forEach((fn) => {
			fn();
		}));
	});
	const configSummary = createMemo(() => {
		const cfg = props.api.state.config;
		if (!cfg) return null;
		return {
			mcpCount: cfg.mcp ? Object.keys(cfg.mcp).length : 0,
			pluginCount: Array.isArray(cfg.plugin) ? cfg.plugin.length : 0,
			autoCompaction: cfg.compaction?.auto === true
		};
	});
	const HR = () => (() => {
		var _el$13 = createElement("text");
		insertNode(_el$13, createTextNode(`────────────────────────────`));
		effect((_$p) => setProp(_el$13, "fg", theme().textMuted, _$p));
		return _el$13;
	})();
	return (() => {
		var _el$15 = createElement("box"), _el$16 = createElement("text"), _el$17 = createElement("box"), _el$18 = createElement("text"), _el$19 = createElement("text"), _el$21 = createElement("box"), _el$22 = createElement("text"), _el$23 = createElement("text"), _el$25 = createElement("box"), _el$26 = createElement("text"), _el$27 = createElement("text"), _el$29 = createElement("box"), _el$30 = createElement("text"), _el$31 = createElement("box"), _el$32 = createElement("text");
		insertNode(_el$15, _el$16);
		insertNode(_el$15, _el$17);
		insertNode(_el$15, _el$21);
		insertNode(_el$15, _el$25);
		insertNode(_el$15, _el$29);
		insertNode(_el$15, _el$31);
		setProp(_el$15, "flexDirection", "column");
		setProp(_el$15, "width", "100%");
		setProp(_el$16, "attributes", 1);
		insert(_el$16, () => `Pantheon${props.version ? ` v${props.version}` : ""}`);
		insert(_el$15, createComponent(Show, {
			get when() {
				return branch();
			},
			children: (b) => (() => {
				var _el$33 = createElement("text");
				insert(_el$33, b);
				effect((_$p) => setProp(_el$33, "fg", theme().textMuted, _$p));
				return _el$33;
			})()
		}), _el$17);
		insert(_el$15, createComponent(Show, {
			get when() {
				return preset().name;
			},
			get fallback() {
				return (() => {
					var _el$34 = createElement("box"), _el$35 = createElement("text");
					insertNode(_el$34, _el$35);
					setProp(_el$34, "flexDirection", "row");
					setProp(_el$34, "gap", 1);
					insertNode(_el$35, createTextNode(`Preset: default`));
					effect((_$p) => setProp(_el$35, "fg", theme().textMuted, _$p));
					return _el$34;
				})();
			},
			children: (name) => (() => {
				var _el$37 = createElement("box"), _el$38 = createElement("text"), _el$40 = createElement("text"), _el$41 = createElement("text");
				insertNode(_el$37, _el$38);
				insertNode(_el$37, _el$40);
				insertNode(_el$37, _el$41);
				setProp(_el$37, "flexDirection", "row");
				setProp(_el$37, "gap", 1);
				insertNode(_el$38, createTextNode(`⚡ Preset:`));
				insert(_el$40, name);
				insert(_el$41, () => `(${preset().source ?? ""})`);
				effect((_p$) => {
					var _v$12 = theme().textMuted, _v$13 = theme().accent, _v$14 = theme().textMuted;
					_v$12 !== _p$.e && (_p$.e = setProp(_el$38, "fg", _v$12, _p$.e));
					_v$13 !== _p$.t && (_p$.t = setProp(_el$40, "fg", _v$13, _p$.t));
					_v$14 !== _p$.a && (_p$.a = setProp(_el$41, "fg", _v$14, _p$.a));
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0
				});
				return _el$37;
			})()
		}), _el$17);
		insert(_el$15, createComponent(HR, {}), _el$17);
		insertNode(_el$17, _el$18);
		insertNode(_el$17, _el$19);
		setProp(_el$17, "onMouseDown", () => setShowSessions((x) => !x));
		setProp(_el$18, "attributes", 1);
		insert(_el$18, () => `${showSessions() ? "▼" : "▶"} Sessions`);
		insert(_el$19, () => ` (${String(totalSessions())})`);
		insert(_el$15, createComponent(Show, {
			get when() {
				return showSessions();
			},
			get children() {
				return createComponent(Show, {
					get when() {
						return recentSessions().length > 0;
					},
					get fallback() {
						return (() => {
							var _el$42 = createElement("box"), _el$43 = createElement("text");
							insertNode(_el$42, _el$43);
							setProp(_el$42, "marginLeft", 1);
							insertNode(_el$43, createTextNode(`No recent sessions`));
							effect((_$p) => setProp(_el$43, "fg", theme().textMuted, _$p));
							return _el$42;
						})();
					},
					get children() {
						var _el$20 = createElement("box");
						setProp(_el$20, "marginLeft", 1);
						setProp(_el$20, "flexDirection", "column");
						insert(_el$20, createComponent(For, {
							get each() {
								return recentSessions();
							},
							children: (ses) => createComponent(SessionRow, {
								get api() {
									return props.api;
								},
								session: ses
							})
						}));
						return _el$20;
					}
				});
			}
		}), _el$21);
		insertNode(_el$21, _el$22);
		insertNode(_el$21, _el$23);
		setProp(_el$21, "onMouseDown", () => setShowCommands((x) => !x));
		setProp(_el$22, "attributes", 1);
		insert(_el$22, () => `${showCommands() ? "▼" : "▶"} Commands`);
		insert(_el$23, () => ` (${String(COMMANDS.length)})`);
		insert(_el$15, createComponent(Show, {
			get when() {
				return showCommands();
			},
			get children() {
				var _el$24 = createElement("box");
				setProp(_el$24, "marginLeft", 1);
				setProp(_el$24, "flexDirection", "column");
				insert(_el$24, createComponent(For, {
					each: COMMANDS,
					children: (cmd) => (() => {
						var _el$45 = createElement("box"), _el$46 = createElement("text"), _el$47 = createElement("text");
						insertNode(_el$45, _el$46);
						insertNode(_el$45, _el$47);
						setProp(_el$45, "onMouseDown", (e) => {
							e.stopPropagation();
							try {
								const cmdApi = props.api.command;
								const cmdName = cmd.name.replace("/", "");
								if (cmdApi?.trigger?.(cmdName)) return;
							} catch {}
							props.api.ui?.toast?.({
								title: "Command",
								message: `Type ${cmd.name} in chat`
							});
						});
						insert(_el$46, () => cmd.name);
						insert(_el$47, () => ` \u2014 ${cmd.desc}`);
						effect((_p$) => {
							var _v$15 = cmd.name === "/pantheon" ? theme().accent : theme().textMuted, _v$16 = theme().textMuted;
							_v$15 !== _p$.e && (_p$.e = setProp(_el$46, "fg", _v$15, _p$.e));
							_v$16 !== _p$.t && (_p$.t = setProp(_el$47, "fg", _v$16, _p$.t));
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$45;
					})()
				}));
				return _el$24;
			}
		}), _el$25);
		insertNode(_el$25, _el$26);
		insertNode(_el$25, _el$27);
		setProp(_el$25, "onMouseDown", () => setShowAgents((x) => !x));
		setProp(_el$26, "attributes", 1);
		insert(_el$26, () => `${showAgents() ? "▼" : "▶"} Agents`);
		insert(_el$27, () => ` (${String(AGENTS.length)})`);
		insert(_el$15, createComponent(Show, {
			get when() {
				return showAgents();
			},
			get children() {
				var _el$28 = createElement("box");
				setProp(_el$28, "marginLeft", 1);
				setProp(_el$28, "flexDirection", "column");
				insert(_el$28, createComponent(For, {
					each: AGENTS,
					children: (agent) => (() => {
						var _el$48 = createElement("box"), _el$49 = createElement("text"), _el$50 = createElement("text");
						insertNode(_el$48, _el$49);
						insertNode(_el$48, _el$50);
						insert(_el$49, () => `${agent.tier === "premium" ? "✦ " : "· "}${agent.name}`);
						insert(_el$50, () => ` \u2014 ${agent.role}`);
						effect((_p$) => {
							var _v$17 = agent.tier === "premium" ? theme().accent : theme().textMuted, _v$18 = theme().textMuted;
							_v$17 !== _p$.e && (_p$.e = setProp(_el$49, "fg", _v$17, _p$.e));
							_v$18 !== _p$.t && (_p$.t = setProp(_el$50, "fg", _v$18, _p$.t));
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$48;
					})()
				}));
				return _el$28;
			}
		}), _el$29);
		insertNode(_el$29, _el$30);
		setProp(_el$29, "onMouseDown", () => setShowConfig((x) => !x));
		setProp(_el$30, "attributes", 1);
		insert(_el$30, () => `${showConfig() ? "▼" : "▶"} Config`);
		insert(_el$15, createComponent(Show, {
			get when() {
				return showConfig();
			},
			get children() {
				return createComponent(Show, {
					get when() {
						return configSummary();
					},
					get fallback() {
						return (() => {
							var _el$51 = createElement("box"), _el$52 = createElement("text");
							insertNode(_el$51, _el$52);
							setProp(_el$51, "marginLeft", 1);
							insertNode(_el$52, createTextNode(`No config data`));
							effect((_$p) => setProp(_el$52, "fg", theme().textMuted, _$p));
							return _el$51;
						})();
					},
					children: (cfg) => (() => {
						var _el$54 = createElement("box"), _el$55 = createElement("text"), _el$56 = createElement("text");
						insertNode(_el$54, _el$55);
						insertNode(_el$54, _el$56);
						setProp(_el$54, "marginLeft", 1);
						setProp(_el$54, "flexDirection", "column");
						insert(_el$55, () => `MCP: ${String(cfg().mcpCount)}  Plugins: ${String(cfg().pluginCount)}`);
						insert(_el$56, () => `Auto-compaction: ${cfg().autoCompaction ? "ON" : "OFF"}`);
						effect((_p$) => {
							var _v$19 = theme().textMuted, _v$20 = theme().textMuted;
							_v$19 !== _p$.e && (_p$.e = setProp(_el$55, "fg", _v$19, _p$.e));
							_v$20 !== _p$.t && (_p$.t = setProp(_el$56, "fg", _v$20, _p$.t));
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$54;
					})()
				});
			}
		}), _el$31);
		insertNode(_el$31, _el$32);
		setProp(_el$31, "marginTop", 1);
		insert(_el$32, (() => {
			var _c$ = memo(() => memoryCount() !== null);
			return () => _c$() ? `Memory: ${fmtInt(memoryCount())} entries` : "Memory: N/A";
		})());
		effect((_p$) => {
			var _v$5 = theme().accent, _v$6 = theme().text, _v$7 = theme().textMuted, _v$8 = theme().text, _v$9 = theme().textMuted, _v$0 = theme().text, _v$1 = theme().textMuted, _v$10 = theme().text, _v$11 = theme().textMuted;
			_v$5 !== _p$.e && (_p$.e = setProp(_el$16, "fg", _v$5, _p$.e));
			_v$6 !== _p$.t && (_p$.t = setProp(_el$18, "fg", _v$6, _p$.t));
			_v$7 !== _p$.a && (_p$.a = setProp(_el$19, "fg", _v$7, _p$.a));
			_v$8 !== _p$.o && (_p$.o = setProp(_el$22, "fg", _v$8, _p$.o));
			_v$9 !== _p$.i && (_p$.i = setProp(_el$23, "fg", _v$9, _p$.i));
			_v$0 !== _p$.n && (_p$.n = setProp(_el$26, "fg", _v$0, _p$.n));
			_v$1 !== _p$.s && (_p$.s = setProp(_el$27, "fg", _v$1, _p$.s));
			_v$10 !== _p$.h && (_p$.h = setProp(_el$30, "fg", _v$10, _p$.h));
			_v$11 !== _p$.r && (_p$.r = setProp(_el$32, "fg", _v$11, _p$.r));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0,
			i: void 0,
			n: void 0,
			s: void 0,
			h: void 0,
			r: void 0
		});
		return _el$15;
	})();
}
const tui = async (api, _options, _meta) => {
	const version = await detectVersion(api);
	setupUsageBar(api);
	api.slots.register({
		order: 900,
		slots: { sidebar_content(_ctx, props) {
			return createComponent(View, {
				api,
				get sessionID() {
					return props.session_id;
				},
				version
			});
		} }
	});
};
const plugin = {
	id: "pantheon.tui",
	tui
};
//#endregion
export { plugin as default };

//# sourceMappingURL=tui.js.map
