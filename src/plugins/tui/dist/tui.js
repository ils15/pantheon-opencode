import { createComponent, createElement, createTextNode, effect, insert, insertNode, memo, setProp } from "@opentui/solid";
import { Buffer } from "node:buffer";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
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
*     branch, Sessions, real-time Delegations panel).
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
/** How often the sidebar re-reads .pantheon/active-preset.json so `set-tier`
*  changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 3e4;
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
			if (tag) return tag;
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
/** True for `\s` characters (space, tab, newline, CR) — plain char checks so
*  the parser stays regex-free (CodeQL flagged the old `\s*`/`\s+` + `(.+)`
*  patterns as polynomial ReDoS: 12x HIGH). */
function isWs(ch) {
	return ch === " " || ch === "	" || ch === "\n" || ch === "\r";
}
/** Em/en dash + hyphen — the separators accepted after the H1 title. */
const TITLE_SEPARATORS = "—–-";
/** Parse one delegation report md header into a structured entry.
*  Returns null (skip) when the file is not a recognizable report:
*  missing agent/state/startedAt, an unknown state, or an unparsable
*  Started timestamp. The alias falls back to the file name when the H1
*  title is missing. Pure — no I/O.
*
*  Linear, single-pass over `raw.split('\n')` with plain string operations
*  (startsWith/indexOf/slice) — zero regex, so worst case is O(bytes) even
*  on adversarial whitespace-heavy input (ReDoS regression, CodeQL 12x HIGH). */
function parseDelegationMarkdown(raw, fileAlias, sessionID = "") {
	let title;
	let agent;
	let description = "";
	let state;
	let timedOut = false;
	let started;
	let finalized;
	let taskID;
	for (const rawLine of raw.split("\n")) {
		if (rawLine[0] === "#" && isWs(rawLine[1])) {
			let i = 2;
			while (i < rawLine.length && isWs(rawLine[i])) i++;
			if (rawLine.startsWith("Delegation Report", i)) {
				i += 17;
				while (i < rawLine.length && isWs(rawLine[i])) i++;
				if (i < rawLine.length && TITLE_SEPARATORS.includes(rawLine[i])) {
					const rest = rawLine.slice(i + 1).trim();
					if (rest !== "" && title === void 0) title = rest;
				}
			}
			continue;
		}
		if (rawLine[0] !== "-") continue;
		let i = 1;
		while (i < rawLine.length && isWs(rawLine[i])) i++;
		if (!rawLine.startsWith("**", i)) continue;
		const nameStart = i + 2;
		const valueEnd = rawLine.indexOf("**:", nameStart);
		if (valueEnd < 0) continue;
		const name = rawLine.slice(nameStart, valueEnd);
		const value = rawLine.slice(valueEnd + 3).trim();
		switch (name) {
			case "Task ID":
				if (value !== "" && taskID === void 0) taskID = stripTaskIdTicks(value);
				break;
			case "Agent":
				if (value !== "" && agent === void 0) agent = value;
				break;
			case "Description":
				description = value;
				break;
			case "State":
				if (value !== "" && state === void 0) state = value;
				break;
			case "Timed out":
				timedOut = value.startsWith("true");
				break;
			case "Started":
				if (value !== "" && started === void 0) started = value;
				break;
			case "Finalized":
				finalized = value;
				break;
			default: break;
		}
	}
	const startedAt = started !== void 0 ? Date.parse(started) : NaN;
	if (agent === void 0 || state === void 0 || Number.isNaN(startedAt)) return null;
	const normalized = state.toLowerCase();
	if (normalized !== "running" && normalized !== "completed" && normalized !== "error" && normalized !== "cancelled") return null;
	const finalizedAt = finalized !== void 0 ? Date.parse(finalized) : NaN;
	return {
		alias: title ?? (fileAlias !== void 0 ? stripMdSuffix(fileAlias) : "unknown"),
		sessionID,
		...taskID !== void 0 ? { taskID } : {},
		agent,
		state: normalized,
		startedAt,
		updatedAt: Number.isNaN(finalizedAt) ? null : finalizedAt,
		timedOut,
		description,
		source: "md"
	};
}
/** Strip a trailing `.md` (any case) — linear replacement for /\.md$/i. */
function stripMdSuffix(name) {
	return name.toLowerCase().endsWith(".md") ? name.slice(0, name.length - 3) : name;
}
/** Strip surrounding backticks from a `Task ID` value: "`ses_x`" → "ses_x". */
function stripTaskIdTicks(value) {
	const start = value[0] === "`" ? 1 : 0;
	const end = value.length > start && value[value.length - 1] === "`" ? value.length - 1 : value.length;
	return value.slice(start, end);
}
/** Read every delegation report under `<dir>/<sessionID>/<alias>.md`.
*  Fail-open: a missing/unreadable directory yields [], and each unreadable
*  or malformed file is skipped individually. Entries are sorted running
*  first, then terminal by `updatedAt` (most recent first) so the panel can
*  render them in order directly. */
async function readDelegationEntries(dir) {
	let sessionDirs;
	try {
		sessionDirs = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const entries = [];
	for (const session of sessionDirs) {
		if (!session.isDirectory()) continue;
		let files;
		try {
			files = await readdir(join(dir, session.name), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(".md")) continue;
			try {
				const entry = parseDelegationMarkdown(await readFile(join(dir, session.name, file.name), "utf8"), file.name, session.name);
				if (entry !== null) entries.push(entry);
			} catch {}
		}
	}
	entries.sort(compareDelegationEntries);
	return entries;
}
/** Read delegation reports from EVERY session under
*  `<root>/.pantheon/delegations/<sessionID>/<alias>.md` — the panel's
*  HISTORY channel. Unlike the children/live channels it does NOT depend on a
*  resolved sessionID: with no focused session (null/placeholder), the panel
*  still shows the reports from all past sessions (running first, Finalized
*  desc — the sort applied by readDelegationEntries). Fail-open: a
*  missing/unreadable directory yields []. */
async function readAllDelegationEntries(root) {
	return readDelegationEntries(join(root, ".pantheon", "delegations"));
}
/** Resolve the directory where the job board writes delegation md reports.
*  The board writes `.pantheon/delegations` RELATIVE to the server cwd,
*  which the TUI exposes as `TuiState.path.directory`. `project` does NOT
*  exist on `TuiState.path` (the old `state?.project ?? state?.worktree`
*  resolution was always undefined for the first term) and `worktree` is
*  `/` when there is no git (e.g. the sandbox test project) — a root of
*  `''` or `'/'` must fall back to `process.cwd()`. */
function resolveDelegationsDir(state, cwd = process.cwd()) {
	const root = state?.directory ?? state?.worktree ?? "";
	if (root === "" || root === "/") return join(cwd, ".pantheon", "delegations");
	return join(root, ".pantheon", "delegations");
}
/** Project root derived from the delegations dir: `<root>/.pantheon/delegations`
*  → `<root>`. Used to point the panel logger at the REAL hooks.log — passing
*  the delegations dir (or its dirname) directly made createTuiLogger append
*  to `<root>/.pantheon/.pantheon/logs/hooks.log`, a nested empty dir the real
*  log never saw. Pure — no I/O. */
function panelLogDir(delegationsDir) {
	return dirname(dirname(delegationsDir));
}
/** Where the panel logger appends lines: `<projectRoot>/.pantheon/logs/hooks.log`.
*  Pure — testable without the runtime. */
function tuiLogPath(projectRoot) {
	return join(projectRoot, ".pantheon", "logs", "hooks.log");
}
/** Sort delegations: running first, then terminal by recency (updatedAt,
*  falling back to startedAt, descending). Shared by the md reader and
*  mergeDelegationSources. */
function compareDelegationEntries(a, b) {
	const aRun = a.state === "running" ? 1 : 0;
	const bRun = b.state === "running" ? 1 : 0;
	if (aRun !== bRun) return bRun - aRun;
	return (b.updatedAt ?? b.startedAt) - (a.updatedAt ?? a.startedAt);
}
/** The list the panel actually renders: running jobs first, then the most
*  recent terminal reports (capped). Pure — so the history-only panel (no
*  sessionID) is testable without the TUI runtime. The header count uses the
*  same "running + recentes" list. */
function visibleDelegationList(all, maxTerminal = 8) {
	const running = all.filter((d) => d.state === "running");
	const terminal = all.filter((d) => d.state !== "running").slice(0, maxTerminal);
	return [...running, ...terminal];
}
/** Compact elapsed-time label: "5m 12s", "1h 30m", "2d 4h" — ticks every
*  second for running jobs. */
function fmtElapsed(ms) {
	const total = Math.max(0, Math.floor(ms / 1e3));
	const days = Math.floor(total / 86400);
	const hours = Math.floor(total % 86400 / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const seconds = total % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}
/** Elapsed label for one entry: running → ticks `now - startedAt`, terminal
*  → fixed `updatedAt - startedAt` (em dash when no finalized timestamp). */
function delegationElapsed(entry, now) {
	if (entry.state === "running") return fmtElapsed(now - entry.startedAt);
	return entry.updatedAt !== null ? fmtElapsed(entry.updatedAt - entry.startedAt) : "—";
}
/** The activity labels shown by the animated row. Keeping this pure makes the
* state machine testable without booting OpenCode's renderer. */
function delegationActivity(entry) {
	if (entry.state === "completed") return "completed";
	if (entry.state === "error") return "error";
	if (entry.state === "cancelled") return "cancelled";
	if (entry.read) return "reading";
	if (entry.alias.startsWith("live-") && entry.taskID === void 0) return "delegating";
	return "working";
}
function delegationActivityLabel(entry) {
	switch (delegationActivity(entry)) {
		case "delegating": return "DELEGATING";
		case "working": return "WORKING";
		case "reading": return "READING RESULT";
		case "completed": return entry.timedOut ? "DONE (TIMED OUT)" : "DONE";
		case "error": return "ERROR";
		default: return "CANCELLED";
	}
}
const DELEGATION_SPINNER_FRAMES = [
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
/** Return a deterministic spinner frame. The View ticks this every 140ms. */
function delegationSpinnerFrame(now) {
	const index = Math.floor(Math.max(0, now) / 140) % DELEGATION_SPINNER_FRAMES.length;
	return DELEGATION_SPINNER_FRAMES[index] ?? DELEGATION_SPINNER_FRAMES[0];
}
/** Merge the immediate tool-event channel into the child-session channel.
*
* Children remain the durable source, while live entries make a delegation
* visible before the child API/report catches up. A finalized md entry wins
* over a stale live entry; a child-only row is upgraded with live agent,
* alias, phase and timestamps. */
function mergeChildDelegationSources(children, live) {
	const result = [...children];
	const byTask = /* @__PURE__ */ new Map();
	const bySessionAlias = /* @__PURE__ */ new Map();
	const key = (sessionID, alias) => `${sessionID}\u0000${alias}`;
	result.forEach((entry, index) => {
		if (entry.taskID !== void 0) byTask.set(entry.taskID, index);
		bySessionAlias.set(key(entry.sessionID, entry.alias), index);
	});
	for (const liveEntry of live) {
		const incoming = toDelegationEntry(liveEntry);
		const index = (incoming.taskID !== void 0 ? byTask.get(incoming.taskID) : void 0) ?? (incoming.alias !== "" ? bySessionAlias.get(key(incoming.sessionID, incoming.alias)) : void 0);
		if (index === void 0) {
			result.push(incoming);
			const newIndex = result.length - 1;
			if (incoming.taskID !== void 0) byTask.set(incoming.taskID, newIndex);
			bySessionAlias.set(key(incoming.sessionID, incoming.alias), newIndex);
			continue;
		}
		const existing = result[index];
		if (existing === void 0) continue;
		if (existing.source === "md" && existing.state !== "running") continue;
		result[index] = {
			...existing,
			alias: liveEntry.alias !== null ? incoming.alias : existing.alias,
			sessionID: existing.sessionID || incoming.sessionID,
			taskID: existing.taskID ?? incoming.taskID,
			agent: incoming.agent !== "agent" ? incoming.agent : existing.agent,
			description: incoming.description !== "" ? incoming.description : existing.description,
			state: incoming.state,
			startedAt: Math.min(existing.startedAt, incoming.startedAt),
			updatedAt: incoming.updatedAt,
			read: incoming.read,
			source: "live"
		};
	}
	result.sort(compareDelegationEntries);
	return result;
}
/** Duck-typed subset of a tool part (SDK v2 `ToolPart` / `ToolState`). */
/** One live delegation tracked in-memory, keyed by the delegate callID. */
/** Result of parsing one tool part into lifecycle-relevant fields. */
/** Alias in the delegate output: "Delegated to apollo: [apo-1] (task …)". */
const DELEGATE_ALIAS_PATTERN = /\[([a-z]{2,8}-\d+)\]/i;
/** Child task id in the delegate output: "(task ses_child_9)". */
const DELEGATE_TASKID_PATTERN = /\(task\s+([a-z0-9_]+)\)/i;
/** Plain alias, as passed to pantheon_delegation_read input.id: "apo-1". */
const READ_ALIAS_PATTERN = /^[a-z]{2,8}-\d+$/i;
/** Extract the tool name + args from a `message.part.updated` part and
*  reduce it to what the panel needs. Returns null for anything that is
*  not a pantheon delegation tool part (or is missing its callID). */
function parseDelegationToolPart(part, now = Date.now()) {
	if (part.type !== "tool") return null;
	if (part.tool !== "pantheon_delegate" && part.tool !== "pantheon_delegation_read") return null;
	const callID = part.callID;
	if (callID === void 0 || callID === "") return null;
	const sessionID = part.sessionID ?? "";
	const state = part.state ?? {};
	const status = state.status ?? "pending";
	if (status !== "pending" && status !== "running" && status !== "completed" && status !== "error") return null;
	const input = state.input ?? {};
	const startedAt = state.time?.start ?? now;
	const endAt = state.time?.end ?? null;
	if (part.tool === "pantheon_delegation_read") {
		const target = typeof input.id === "string" ? input.id : null;
		let alias = null;
		let taskID = null;
		if (target !== null) {
			if (READ_ALIAS_PATTERN.test(target)) alias = target;
			else if (target.startsWith("ses_")) taskID = target;
		}
		return {
			callID,
			partID: part.id ?? "",
			sessionID,
			tool: "pantheon_delegation_read",
			agent: null,
			description: "",
			status,
			alias,
			taskID,
			startedAt,
			endAt
		};
	}
	const agent = typeof input.agent === "string" ? input.agent : "agent";
	const description = typeof input.description === "string" ? input.description : "";
	let alias = null;
	let taskID = null;
	if (status === "completed") {
		const output = state.output ?? "";
		alias = DELEGATE_ALIAS_PATTERN.exec(output)?.[1] ?? null;
		taskID = DELEGATE_TASKID_PATTERN.exec(output)?.[1] ?? null;
	}
	return {
		callID,
		partID: part.id ?? "",
		sessionID,
		tool: "pantheon_delegate",
		agent,
		description,
		status,
		alias,
		taskID,
		startedAt,
		endAt
	};
}
/** Find a live entry by alias or taskID (read parts resolve by id). */
function findLiveByTarget(map, alias, taskID) {
	if (alias === null && taskID === null) return void 0;
	for (const entry of map.values()) {
		if (alias !== null && entry.alias === alias) return entry;
		if (taskID !== null && entry.taskID === taskID) return entry;
	}
}
/** Apply one tool part to the live map. Returns true when the map changed.
*  Pure w.r.t. I/O — only mutates `map`. */
function reduceDelegationToolPart(map, part, now = Date.now()) {
	const parsed = parseDelegationToolPart(part, now);
	if (parsed === null) return false;
	if (parsed.tool === "pantheon_delegation_read") {
		const target = findLiveByTarget(map, parsed.alias, parsed.taskID);
		if (target === void 0) return false;
		let changed = false;
		if (!target.read) {
			target.read = true;
			changed = true;
		}
		if (parsed.status === "completed" && target.state === "running") {
			target.state = "completed";
			target.updatedAt = parsed.endAt ?? now;
			changed = true;
		} else if (parsed.status === "error" && target.state === "running") {
			target.state = "error";
			target.updatedAt = parsed.endAt ?? now;
			changed = true;
		}
		return changed;
	}
	const existing = map.get(parsed.callID);
	if (parsed.status === "error") {
		if (existing !== void 0 && existing.state === "error" && existing.updatedAt === parsed.endAt) return false;
		map.set(parsed.callID, {
			callID: parsed.callID,
			partID: parsed.partID,
			sessionID: parsed.sessionID,
			tool: "pantheon_delegate",
			agent: parsed.agent ?? "agent",
			description: parsed.description,
			alias: existing?.alias ?? null,
			taskID: existing?.taskID ?? null,
			state: "error",
			startedAt: existing?.startedAt ?? parsed.startedAt,
			updatedAt: parsed.endAt ?? now,
			read: existing?.read ?? false
		});
		return true;
	}
	if (existing === void 0) {
		map.set(parsed.callID, {
			callID: parsed.callID,
			partID: parsed.partID,
			sessionID: parsed.sessionID,
			tool: "pantheon_delegate",
			agent: parsed.agent ?? "agent",
			description: parsed.description,
			alias: parsed.alias,
			taskID: parsed.taskID,
			state: "running",
			startedAt: parsed.startedAt,
			updatedAt: null,
			read: false
		});
		return true;
	}
	let changed = false;
	if (parsed.alias !== null && existing.alias !== parsed.alias) {
		existing.alias = parsed.alias;
		changed = true;
	}
	if (parsed.taskID !== null && existing.taskID !== parsed.taskID) {
		existing.taskID = parsed.taskID;
		changed = true;
	}
	if (parsed.agent !== null && existing.agent !== parsed.agent) {
		existing.agent = parsed.agent;
		changed = true;
	}
	if (parsed.description !== "" && existing.description !== parsed.description) {
		existing.description = parsed.description;
		changed = true;
	}
	if (existing.partID === "" && parsed.partID !== "") {
		existing.partID = parsed.partID;
		changed = true;
	}
	return changed;
}
/** Remove a live entry by part id (message.part.removed) or call id.
*  Returns true when something was removed. */
function removeDelegationEntry(map, partIDOrCallID) {
	if (map.delete(partIDOrCallID)) return true;
	for (const [key, entry] of map) if (entry.partID === partIDOrCallID) {
		map.delete(key);
		return true;
	}
	return false;
}
/** Collect pantheon delegation tool parts from a session's messages.
*  Messages may carry their parts inline (duck-typed `msg.parts`); when
*  they don't, the optional `getParts(messageID)` callback is used (the TUI
*  SDK exposes `api.state.part(messageID)`). Pure w.r.t. I/O — used by the
*  mount re-scan to re-seed the live map after compaction/attach. */
function collectDelegationToolParts(messages, getParts) {
	const out = [];
	for (const msg of messages ?? []) {
		let parts;
		if (Array.isArray(msg?.parts)) parts = msg.parts;
		else if (msg?.id !== void 0 && typeof getParts === "function") parts = getParts(msg.id);
		if (!parts) continue;
		for (const raw of parts) {
			const part = raw;
			if (part?.type === "tool" && (part.tool === "pantheon_delegate" || part.tool === "pantheon_delegation_read")) out.push(part);
		}
	}
	return out;
}
/** Apply a batch of tool parts (in message order) to the live map. Used on
*  mount to re-seed entries that `message.part.removed` (compaction) wiped,
*  from the session's existing tool parts. Returns how many parts changed
*  the map (0 on the second identical seed — idempotent, no extra bumps). */
function seedLiveDelegationMap(map, parts, now = Date.now()) {
	let changed = 0;
	for (const part of parts) if (reduceDelegationToolPart(map, part, now)) changed++;
	return changed;
}
/** Convert a live entry into the shared display shape. Alias falls back to
*  a `live-<callID>` prefix while the delegate tool has not completed yet. */
function toDelegationEntry(live) {
	return {
		alias: live.alias ?? `live-${live.callID.slice(0, 8)}`,
		sessionID: live.sessionID,
		...live.taskID !== null ? { taskID: live.taskID } : {},
		agent: live.agent,
		state: live.state,
		startedAt: live.startedAt,
		updatedAt: live.updatedAt,
		timedOut: false,
		description: live.description,
		read: live.read,
		source: "live"
	};
}
/** Combine the live channel with the md (historical) channel into one
*  display list. Dedupes by (sessionID, alias) — aliases are per-parent-
*  session, so the same alias in different sessions stays separate. A
*  terminal md entry is authoritative over a live running entry for the
*  same job (it carries Finalized/timedOut/cancelled from finalize). */
function mergeDelegationSources(live, md) {
	const keyOf = (sessionID, alias) => `${sessionID}\u0000${alias}`;
	const byKey = /* @__PURE__ */ new Map();
	for (const m of md) {
		const key = keyOf(m.sessionID, m.alias);
		const existing = byKey.get(key);
		if (existing === void 0 || existing.state === "running" && m.state !== "running") byKey.set(key, m);
	}
	const aliasless = [];
	for (const l of live) {
		const e = toDelegationEntry(l);
		if (l.alias === null) {
			aliasless.push(e);
			continue;
		}
		const key = keyOf(l.sessionID, l.alias);
		const mdEntry = byKey.get(key);
		if (mdEntry !== void 0 && mdEntry.state !== "running") continue;
		byKey.set(key, e);
	}
	const all = [...aliasless, ...byKey.values()];
	all.sort(compareDelegationEntries);
	return all;
}
/** Server-aligned session id validity: opencode rejects anything not starting
*  with "ses" (SchemaError). This deliberately mirrors that exact contract —
*  nothing stricter, nothing looser — so a template placeholder ("{sessionID}"),
*  its URL-encoded form ("%7BsessionID%7D", what the server reported in the
*  schema error), an empty/undefined value, or a foreign id (e.g. "wrk_") can
*  never reach a path and error-spam the log. Confirmed: "{sessionID}" starts
*  with "{" and "%7BsessionID%7D" with "%" — both fail startsWith("ses"), so
*  the placeholder is rejected WITHOUT an explicit denylist (covered by tests). */
function isValidSessionId(id) {
	return typeof id === "string" && id.startsWith("ses");
}
/** Sources the sidebar can resolve the CURRENT session id from. Duck-typed
*  subsets of TuiPluginApi / TuiState / TuiRouteCurrent so the helper stays
*  pure and testable without the TUI runtime. */
/** Resolve the current session id for the sidebar. Order: slot prop →
*  api.state.sessionID (runtime superset) → api.route.current.params.sessionID
*  (typed route). Every source is validated; invalid/absent → next source.
*  NEVER returns a placeholder or non-ses id. Null → callers MUST skip the
*  fetch (empty panel, zero errors). Pure — no I/O, no runtime required. */
function resolveCurrentSessionID(sources) {
	const candidates = [
		sources?.sessionID,
		sources?.api?.state?.sessionID,
		sources?.api?.route?.current?.params?.sessionID
	];
	for (const candidate of candidates) if (isValidSessionId(candidate)) return candidate;
	return null;
}
/** THE single choke point for every `session.children` / session-API path.
*  Returns `{ path: { id } }` ONLY for a server-valid session id; returns
*  null for anything else (placeholder, empty, foreign id) so the caller
*  skips the call entirely instead of sending an unsubstituted placeholder
*  (the "%7BsessionID%7D" regression). Every session-API call site MUST go
*  through this function (enforced by the source-scan test in
*  tests/pantheon/tui-delegations.test.ts). */
function safeSessionPath(id) {
	if (!isValidSessionId(id)) return null;
	return { path: { id } };
}
/** Build the `session.children` path ONLY from a validated session id.
*  Delegates to {@link safeSessionPath} — the single choke point. Returns
*  null for null/invalid ids so the caller skips the fetch instead of
*  sending an unsubstituted placeholder (the "%7BsessionID%7D" regression). */
function buildChildrenPath(id) {
	return safeSessionPath(id);
}
/** Duck-typed subset of a child Session (+ its live status type). */
/** Map a child status type to a display state. busy/retry → running
*  (the child is actively working), idle → completed, unknown → running
*  (fail-open: a freshly-seen child is assumed active; the 1s poll + md
*  correct it as soon as terminal data exists). */
function childStatusToState(status) {
	if (status === "idle") return "completed";
	return "running";
}
/** Row tag for a delegation entry: `[task]` for native task() children
*  (source 'children-only' — no board report), `[<alias>]` for board rows
*  ([apo-1]). The panel renders the tag with a distinct style so native
*  task() children are visually separable from pantheon_delegate jobs. */
function delegationTag(entry) {
	return entry.source === "children-only" ? "[task]" : `[${entry.alias}]`;
}
/** Turn child sessions (PRIMARY) enriched with md reports into the display
*  list. One entry per child id (duplicates across re-fetches collapse).
*  The md report is matched by `Task ID` (== child.id) and supplies alias,
*  agent, description, terminal state and duration. A child without a
*  report still renders: description from its title, agent from the child
*  itself (fallback 'agent'), state derived from its status, startedAt from
*  time.created. A report-less child is a NATIVE task() child (every
*  child of the current session — pantheon_delegate OR the native `task()`
*  tool — carries parentID = caller), so it gets source 'children-only'
*  and the `[task]` tag instead of a board alias.
*  Terminal md state wins over the derived state; a running md defers to
*  the child's live status. Sorted running-first (compareDelegationEntries).
*  Pure — no I/O. */
function childrenToDelegationEntries(children, md, now = Date.now()) {
	const byTaskID = /* @__PURE__ */ new Map();
	for (const m of md) if (m.taskID !== void 0 && !byTaskID.has(m.taskID)) byTaskID.set(m.taskID, m);
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const child of children ?? []) {
		if (child.id === "" || seen.has(child.id)) continue;
		seen.add(child.id);
		const mdEntry = byTaskID.get(child.id);
		const state = mdEntry !== void 0 && mdEntry.state !== "running" ? mdEntry.state : childStatusToState(child.status);
		out.push({
			alias: mdEntry?.alias ?? "task",
			sessionID: mdEntry?.sessionID ?? "",
			taskID: child.id,
			agent: mdEntry?.agent ?? child.agent ?? "agent",
			state,
			startedAt: mdEntry?.startedAt ?? child.time?.created ?? now,
			updatedAt: mdEntry?.updatedAt ?? (state === "running" ? null : child.time?.updated ?? null),
			timedOut: mdEntry?.timedOut ?? false,
			description: mdEntry !== void 0 && mdEntry.description !== "" ? mdEntry.description : child.title ?? "",
			source: mdEntry !== void 0 ? "md" : "children-only"
		});
	}
	out.sort(compareDelegationEntries);
	return out;
}
/** Navigate the TUI to a child session (click/Enter on a delegation row).
*  Returns false when the route API is unavailable or the target id is
*  missing/placeholder — the row stays inert instead of crashing. Only a
*  server-valid session id ("ses...") ever reaches the router, so an
*  unsubstituted "{sessionID}" placeholder can never be routed. */
function navigateToDelegationSession(route, taskID) {
	if (typeof route?.navigate !== "function" || !isValidSessionId(taskID)) return false;
	route.navigate("session", { sessionID: taskID });
	return true;
}
/** Silence-by-default panel logger.
*  @param projectRoot the PROJECT ROOT — the logger appends to
*  `<projectRoot>/.pantheon/logs/hooks.log` (tuiLogPath). Passing anything
*  deeper (e.g. the delegations dir) used to double-nest the path into
*  `<root>/.pantheon/.pantheon/logs/hooks.log` and never reach the real log;
*  derive the root with {@link panelLogDir}. */
function createTuiLogger(projectRoot, module = "pantheon-tui") {
	const echo = (process.env.PANTHEON_HOOKS_LOG ?? "").trim() !== "";
	const logPath = tuiLogPath(projectRoot ?? process.cwd());
	const formatArg = (arg) => {
		if (arg instanceof Error) return arg.stack ?? arg.message;
		if (typeof arg === "string") return arg;
		try {
			return JSON.stringify(arg);
		} catch {
			return String(arg);
		}
	};
	const write = (message, args) => {
		const lines = [message, ...args.map(formatArg)].join(" ").split("\n").map((p) => p.trim()).filter((p) => p !== "");
		if (lines.length === 0) return;
		(async () => {
			try {
				await mkdir(dirname(logPath), { recursive: true });
				const stamp = (/* @__PURE__ */ new Date()).toISOString();
				await appendFile(logPath, `${lines.map((l) => `[${stamp}] [${module}] ${l}`).join("\n")}\n`, "utf8");
			} catch {}
		})();
		if (echo) for (const line of lines) console.log(`[${module}] ${line}`);
	};
	return { info: (message, ...args) => write(message, args) };
}
function SessionRow(props) {
	const theme = () => props.api.theme.current;
	const status = createMemo(() => {
		if (!isValidSessionId(props.session?.id)) return null;
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
function DelegationRow(props) {
	const theme = () => props.api.theme.current;
	const color = createMemo(() => {
		const t = theme();
		switch (props.job.state) {
			case "running": return t.warning;
			case "completed": return t.success;
			case "error": return t.error;
			default: return t.textMuted;
		}
	});
	const marker = createMemo(() => {
		if (props.job.state === "running") return `${delegationSpinnerFrame(props.animationNow)} `;
		switch (props.job.state) {
			case "completed": return "✓ ";
			case "error": return "✕ ";
			default: return "○ ";
		}
	});
	const tagColor = createMemo(() => props.job.source === "children-only" ? theme().info : color());
	const detail = createMemo(() => {
		const line = `${delegationElapsed(props.job, props.now)}${props.job.description !== "" ? ` \u2014 ${props.job.description}` : ""}`;
		return line.length > 180 ? `${line.slice(0, 177)}\u2026` : line;
	});
	const open = () => {
		navigateToDelegationSession(props.api.route, props.job.taskID);
	};
	return (() => {
		var _el$13 = createElement("box"), _el$14 = createElement("box"), _el$15 = createElement("text"), _el$16 = createElement("text"), _el$17 = createElement("text"), _el$18 = createElement("text");
		insertNode(_el$13, _el$14);
		insertNode(_el$13, _el$18);
		setProp(_el$13, "onMouseDown", open);
		insertNode(_el$14, _el$15);
		insertNode(_el$14, _el$16);
		insertNode(_el$14, _el$17);
		setProp(_el$14, "flexDirection", "row");
		insert(_el$15, marker);
		insert(_el$16, () => delegationTag(props.job));
		insert(_el$17, () => ` ${props.job.agent} \u2014 ${delegationActivityLabel(props.job)}`);
		insert(_el$18, detail);
		effect((_p$) => {
			var _v$5 = color(), _v$6 = tagColor(), _v$7 = color(), _v$8 = theme().textMuted;
			_v$5 !== _p$.e && (_p$.e = setProp(_el$15, "fg", _v$5, _p$.e));
			_v$6 !== _p$.t && (_p$.t = setProp(_el$16, "fg", _v$6, _p$.t));
			_v$7 !== _p$.a && (_p$.a = setProp(_el$17, "fg", _v$7, _p$.a));
			_v$8 !== _p$.o && (_p$.o = setProp(_el$18, "fg", _v$8, _p$.o));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0
		});
		return _el$13;
	})();
}
/** Plugin-level live delegation store shared with the event subscriptions
*  in `tui()`: the map of live entries + a version signal bumped on every
*  mutation. The View subscribes to the version (in an effect) to refresh the
*  durable child list and also reads the map as an optimistic live source. */
function View(props) {
	const [showSessions, setShowSessions] = createSignal(false);
	const [showDelegations, setShowDelegations] = createSignal(true);
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
		return data.filter((s) => !s.parentID && s.id !== resolveCurrentSessionID({
			sessionID: props.sessionID,
			api: props.api
		})).sort((a, b) => {
			const ta = a.time?.updated ?? a.updated ?? 0;
			return (b.time?.updated ?? b.updated ?? 0) - ta;
		}).slice(0, 8);
	});
	const delegationsDir = createMemo(() => resolveDelegationsDir(props.api.state.path));
	const panelLog = createTuiLogger(panelLogDir(delegationsDir()));
	const [childDelegations, setChildDelegations] = createSignal([]);
	const [now, setNow] = createSignal(Date.now());
	const [animationNow, setAnimationNow] = createSignal(Date.now());
	let eventRefreshCount = 0;
	let delegationsInflight = null;
	const refreshDelegations = () => {
		if (delegationsInflight !== null) return delegationsInflight;
		delegationsInflight = (async () => {
			try {
				const state = props.api.state;
				let md = [];
				try {
					md = await readAllDelegationEntries(panelLogDir(delegationsDir()));
				} catch {
					md = [];
				}
				const sessionID = resolveCurrentSessionID({
					sessionID: props.sessionID,
					api: props.api
				});
				if (sessionID === null) {
					setChildDelegations(md);
					panelLog.info(`panel: children=0 md=${md.length} events=${eventRefreshCount} (no sessionID — history shown)`);
					return;
				}
				let children = [];
				try {
					const result = await props.api.client?.session?.children?.(buildChildrenPath(sessionID));
					const data = result?.data ?? result;
					children = Array.isArray(data) ? data : [];
				} catch (err) {
					children = [];
					panelLog.info("panel: error children fetch", err);
				}
				const resolveStatus = (childID) => {
					if (!isValidSessionId(childID)) return void 0;
					try {
						return state?.session?.status?.(childID)?.type;
					} catch {
						return;
					}
				};
				const childEntries = childrenToDelegationEntries(children.map((c) => ({
					...c,
					status: resolveStatus(c.id)
				})), md, now());
				const liveEntries = [...props.liveStore.map.values()].filter((entry) => entry.sessionID === sessionID);
				setChildDelegations(mergeChildDelegationSources(childEntries, liveEntries));
				panelLog.info(`panel: children=${children.length} md=${md.length} events=${eventRefreshCount}`);
			} finally {
				delegationsInflight = null;
			}
		})();
		return delegationsInflight;
	};
	const visibleDelegations = createMemo(() => visibleDelegationList(childDelegations()));
	onMount(() => {
		const cleanup = [];
		try {
			cleanup.push(props.api.event.on("session.status", refetchSessions));
			cleanup.push(props.api.event.on("session.created", refetchSessions));
			cleanup.push(props.api.event.on("session.updated", refetchSessions));
			cleanup.push(props.api.event.on("session.deleted", refetchSessions));
		} catch {}
		try {
			const eventRefresh = () => {
				eventRefreshCount += 1;
				refreshDelegations();
			};
			cleanup.push(props.api.event.on("session.created", eventRefresh));
			cleanup.push(props.api.event.on("session.updated", eventRefresh));
			cleanup.push(props.api.event.on("session.deleted", eventRefresh));
			cleanup.push(props.api.event.on("session.status", eventRefresh));
		} catch {}
		createEffect(() => {
			props.liveStore.version();
			eventRefreshCount += 1;
			refreshDelegations();
		});
		const poll = setInterval(() => {
			setNow(Date.now());
			refreshDelegations();
		}, 1e3);
		cleanup.push(() => clearInterval(poll));
		const animation = setInterval(() => setAnimationNow(Date.now()), 140);
		cleanup.push(() => clearInterval(animation));
		try {
			const sdk = props.api.state?.session;
			const mountSessionID = resolveCurrentSessionID({
				sessionID: props.sessionID,
				api: props.api
			});
			if (mountSessionID !== null && typeof sdk?.messages === "function") {
				const messages = sdk.messages(mountSessionID) ?? [];
				const state = props.api.state;
				const parts = collectDelegationToolParts(messages, typeof state?.part === "function" ? (messageID) => state.part(messageID) : void 0);
				if (parts.length > 0 && seedLiveDelegationMap(props.liveStore.map, parts) > 0) props.liveStore.bump();
			}
		} catch {}
		onCleanup(() => cleanup.forEach((fn) => {
			fn();
		}));
	});
	const HR = () => (() => {
		var _el$19 = createElement("text");
		insertNode(_el$19, createTextNode(`────────────────────────────`));
		effect((_$p) => setProp(_el$19, "fg", theme().textMuted, _$p));
		return _el$19;
	})();
	return (() => {
		var _el$21 = createElement("box"), _el$22 = createElement("text"), _el$23 = createElement("box"), _el$24 = createElement("text"), _el$25 = createElement("text"), _el$27 = createElement("box"), _el$28 = createElement("text"), _el$29 = createElement("text");
		insertNode(_el$21, _el$22);
		insertNode(_el$21, _el$23);
		insertNode(_el$21, _el$27);
		setProp(_el$21, "flexDirection", "column");
		setProp(_el$21, "width", "100%");
		setProp(_el$22, "attributes", 1);
		insert(_el$22, () => `Pantheon${props.version ? ` v${props.version}` : ""}`);
		insert(_el$21, createComponent(Show, {
			get when() {
				return branch();
			},
			children: (b) => (() => {
				var _el$31 = createElement("text");
				insert(_el$31, b);
				effect((_$p) => setProp(_el$31, "fg", theme().textMuted, _$p));
				return _el$31;
			})()
		}), _el$23);
		insert(_el$21, createComponent(Show, {
			get when() {
				return preset().name;
			},
			get fallback() {
				return (() => {
					var _el$32 = createElement("box"), _el$33 = createElement("text");
					insertNode(_el$32, _el$33);
					setProp(_el$32, "flexDirection", "row");
					setProp(_el$32, "gap", 1);
					insertNode(_el$33, createTextNode(`Preset: default`));
					effect((_$p) => setProp(_el$33, "fg", theme().textMuted, _$p));
					return _el$32;
				})();
			},
			children: (name) => (() => {
				var _el$35 = createElement("box"), _el$36 = createElement("text"), _el$38 = createElement("text"), _el$39 = createElement("text");
				insertNode(_el$35, _el$36);
				insertNode(_el$35, _el$38);
				insertNode(_el$35, _el$39);
				setProp(_el$35, "flexDirection", "row");
				setProp(_el$35, "gap", 1);
				insertNode(_el$36, createTextNode(`⚡ Preset:`));
				insert(_el$38, name);
				insert(_el$39, () => `(${preset().source ?? ""})`);
				effect((_p$) => {
					var _v$12 = theme().textMuted, _v$13 = theme().accent, _v$14 = theme().textMuted;
					_v$12 !== _p$.e && (_p$.e = setProp(_el$36, "fg", _v$12, _p$.e));
					_v$13 !== _p$.t && (_p$.t = setProp(_el$38, "fg", _v$13, _p$.t));
					_v$14 !== _p$.a && (_p$.a = setProp(_el$39, "fg", _v$14, _p$.a));
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0
				});
				return _el$35;
			})()
		}), _el$23);
		insert(_el$21, createComponent(HR, {}), _el$23);
		insertNode(_el$23, _el$24);
		insertNode(_el$23, _el$25);
		setProp(_el$23, "onMouseDown", () => setShowSessions((x) => !x));
		setProp(_el$24, "attributes", 1);
		insert(_el$24, () => `${showSessions() ? "▼" : "▶"} Sessions`);
		insert(_el$25, () => ` (${String(totalSessions())})`);
		insert(_el$21, createComponent(Show, {
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
							var _el$40 = createElement("box"), _el$41 = createElement("text");
							insertNode(_el$40, _el$41);
							setProp(_el$40, "marginLeft", 1);
							insertNode(_el$41, createTextNode(`No recent sessions`));
							effect((_$p) => setProp(_el$41, "fg", theme().textMuted, _$p));
							return _el$40;
						})();
					},
					get children() {
						var _el$26 = createElement("box");
						setProp(_el$26, "marginLeft", 1);
						setProp(_el$26, "flexDirection", "column");
						insert(_el$26, createComponent(For, {
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
						return _el$26;
					}
				});
			}
		}), _el$27);
		insertNode(_el$27, _el$28);
		insertNode(_el$27, _el$29);
		setProp(_el$27, "onMouseDown", () => setShowDelegations((x) => !x));
		setProp(_el$28, "attributes", 1);
		insert(_el$28, () => `${showDelegations() ? "▼" : "▶"} Delegations`);
		insert(_el$29, () => ` (${String(visibleDelegations().length)})`);
		insert(_el$21, createComponent(Show, {
			get when() {
				return showDelegations();
			},
			get children() {
				return createComponent(Show, {
					get when() {
						return visibleDelegations().length > 0;
					},
					get fallback() {
						return (() => {
							var _el$43 = createElement("box"), _el$44 = createElement("text");
							insertNode(_el$43, _el$44);
							setProp(_el$43, "marginLeft", 1);
							insertNode(_el$44, createTextNode(`No delegations`));
							effect((_$p) => setProp(_el$44, "fg", theme().textMuted, _$p));
							return _el$43;
						})();
					},
					get children() {
						var _el$30 = createElement("box");
						setProp(_el$30, "marginLeft", 1);
						setProp(_el$30, "flexDirection", "column");
						insert(_el$30, createComponent(For, {
							get each() {
								return visibleDelegations();
							},
							children: (job) => createComponent(DelegationRow, {
								get api() {
									return props.api;
								},
								job,
								get now() {
									return now();
								},
								get animationNow() {
									return animationNow();
								}
							})
						}));
						return _el$30;
					}
				});
			}
		}), null);
		effect((_p$) => {
			var _v$9 = theme().accent, _v$0 = theme().text, _v$1 = theme().textMuted, _v$10 = theme().text, _v$11 = theme().textMuted;
			_v$9 !== _p$.e && (_p$.e = setProp(_el$22, "fg", _v$9, _p$.e));
			_v$0 !== _p$.t && (_p$.t = setProp(_el$24, "fg", _v$0, _p$.t));
			_v$1 !== _p$.a && (_p$.a = setProp(_el$25, "fg", _v$1, _p$.a));
			_v$10 !== _p$.o && (_p$.o = setProp(_el$28, "fg", _v$10, _p$.o));
			_v$11 !== _p$.i && (_p$.i = setProp(_el$29, "fg", _v$11, _p$.i));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0,
			i: void 0
		});
		return _el$21;
	})();
}
const tui = async (api, _options, _meta) => {
	const version = await detectVersion(api);
	setupUsageBar(api);
	const [liveVersion, setLiveVersion] = createSignal(0);
	const liveStore = {
		map: /* @__PURE__ */ new Map(),
		version: liveVersion,
		bump: () => setLiveVersion((v) => v + 1)
	};
	const unsubLive = [];
	try {
		unsubLive.push(api.event.on("message.part.updated", (event) => {
			const props = event?.properties ?? {};
			const part = props.part ?? props.info?.part;
			if (part === void 0) return;
			if (reduceDelegationToolPart(liveStore.map, part)) liveStore.bump();
		}));
	} catch {}
	try {
		unsubLive.push(api.event.on("message.part.removed", (event) => {
			const props = event?.properties ?? {};
			const partID = props.partID ?? props.part?.id;
			if (partID !== void 0 && removeDelegationEntry(liveStore.map, partID)) liveStore.bump();
		}));
	} catch {}
	api.lifecycle.onDispose(() => {
		for (const unsub of unsubLive) try {
			unsub();
		} catch {}
		liveStore.map.clear();
	});
	api.slots.register({
		order: 900,
		slots: { sidebar_content(_ctx, props) {
			return createComponent(View, {
				api,
				get sessionID() {
					return props.session_id;
				},
				version,
				liveStore
			});
		} }
	});
};
const plugin = {
	id: "pantheon.tui",
	tui
};
//#endregion
export { buildChildrenPath, childStatusToState, childrenToDelegationEntries, collectDelegationToolParts, compareDelegationEntries, plugin as default, delegationActivity, delegationActivityLabel, delegationElapsed, delegationSpinnerFrame, delegationTag, fmtElapsed, isValidSessionId, mergeChildDelegationSources, mergeDelegationSources, navigateToDelegationSession, panelLogDir, parseDelegationMarkdown, parseDelegationToolPart, readAllDelegationEntries, readDelegationEntries, reduceDelegationToolPart, removeDelegationEntry, resolveCurrentSessionID, resolveDelegationsDir, safeSessionPath, seedLiveDelegationMap, toDelegationEntry, tuiLogPath, visibleDelegationList };

//# sourceMappingURL=tui.js.map
