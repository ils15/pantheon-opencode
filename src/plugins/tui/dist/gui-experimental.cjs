let solid_js_web = require("solid-js/web");
let node_fs = require("node:fs");
let node_os = require("node:os");
let node_path = require("node:path");
let _opencode_plugin_gui = require("@opencode/plugin/gui");
let effect = require("effect");
let solid_js = require("solid-js");
Object.freeze(["enabled", "disabled"]);
/** Exact top-level key set — anything else fail-closes the runtime. */
const DECISION_CONFIG_KEYS = Object.freeze([
	"egress_consent",
	"enabled",
	"enabled_candidates",
	"schema_version",
	"selection"
]);
const DEFAULT_DECISION_CONFIG = Object.freeze({
	schema_version: 2,
	enabled: false,
	selection: Object.freeze({ mode: "local" }),
	egress_consent: false,
	enabled_candidates: Object.freeze([])
});
/** The runtime's provider→model matrix (drift-pinned against the installer source). */
const DECISION_KNOWN_PROVIDERS = Object.freeze([
	"openai-decisions",
	"typesafe-jev",
	"opencode-console-jev",
	"openrouter-jev",
	"vercel-gateway-jev",
	"cloudflare-workers-jev"
]);
Object.freeze(["not granted", "granted"]);
/** provider → model, straight from the runtime matrix (drift-pinned in tests). */
const DECISION_KNOWN_MODELS = Object.freeze({
	"openai-decisions": "gpt-6-luna",
	"typesafe-jev": "jev-1.14.0",
	"opencode-console-jev": "jev-1.13",
	"openrouter-jev": "typesafe/jev-1.13",
	"vercel-gateway-jev": "typesafe-ai/jev",
	"cloudflare-workers-jev": "clef"
});
Object.freeze({
	"openai-decisions": {
		note: "host-configured model — provision via `decision-router setup-model openai-decisions`",
		notePt: "modelo do host — configure via `decision-router setup-model openai-decisions`"
	},
	"typesafe-jev": {
		env: "TYPESAFE_API_KEY",
		note: "export TYPESAFE_API_KEY=… then restart",
		notePt: "export TYPESAFE_API_KEY=… e depois reinicie"
	},
	"opencode-console-jev": {
		note: "rides your OpenCode login — no separate key",
		notePt: "utiliza login do OpenCode — sem chave separada"
	},
	"openrouter-jev": {
		env: "OPENROUTER_API_KEY",
		note: "export OPENROUTER_API_KEY=… then restart",
		notePt: "export OPENROUTER_API_KEY=… e depois reinicie"
	},
	"vercel-gateway-jev": {
		env: "AI_GATEWAY_API_KEY",
		note: "export AI_GATEWAY_API_KEY=… then restart",
		notePt: "export AI_GATEWAY_API_KEY=… e depois reinicie"
	},
	"cloudflare-workers-jev": {
		env: "CLOUDFLARE_API_TOKEN",
		note: "needs accountId (setup-model --account-id=…) + CLOUDFLARE_API_TOKEN",
		notePt: "requer accountId (setup-model --account-id=…) + CLOUDFLARE_API_TOKEN"
	}
});
Object.freeze(DECISION_KNOWN_PROVIDERS.map((provider) => `${provider}/${DECISION_KNOWN_MODELS[provider]}`));
function decisionRouterConfigPath(env = process.env) {
	const xdg = env.XDG_CONFIG_HOME;
	const home = env.HOME ?? "";
	const root = xdg ?? (0, node_path.join)(home, ".config");
	return (0, node_path.join)(root, "pantheon", "decision-router.json");
}
/** Fail-open read: a missing file is the default; an invalid one is reported, not guessed. */
function readDecisionRouterConfig(env = process.env) {
	let raw;
	try {
		raw = JSON.parse((0, node_fs.readFileSync)(decisionRouterConfigPath(env), "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return {
			config: cloneDefault(),
			corrupt: false
		};
		return {
			config: cloneDefault(),
			corrupt: true
		};
	}
	if (isValidDecisionConfig(raw)) return {
		config: raw,
		corrupt: false
	};
	return {
		config: cloneDefault(),
		corrupt: true
	};
}
function cloneDefault() {
	return {
		schema_version: DEFAULT_DECISION_CONFIG.schema_version,
		enabled: DEFAULT_DECISION_CONFIG.enabled,
		selection: { ...DEFAULT_DECISION_CONFIG.selection },
		egress_consent: DEFAULT_DECISION_CONFIG.egress_consent,
		enabled_candidates: [...DEFAULT_DECISION_CONFIG.enabled_candidates]
	};
}
/** The exact-key, exact-shape validation the runtime applies (fail-closed otherwise). */
function isValidDecisionConfig(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value;
	const keys = Object.keys(record).sort();
	if (keys.length !== DECISION_CONFIG_KEYS.length) return false;
	for (const key of DECISION_CONFIG_KEYS) if (!keys.includes(key)) return false;
	if (record.schema_version !== 2) return false;
	if (typeof record.enabled !== "boolean") return false;
	if (typeof record.egress_consent !== "boolean") return false;
	if (!isValidSelection(record.selection)) return false;
	if (!Array.isArray(record.enabled_candidates)) return false;
	for (const candidate of record.enabled_candidates) {
		if (typeof candidate !== "object" || candidate === null) return false;
		const entry = candidate;
		if (typeof entry.provider !== "string" || typeof entry.model !== "string") return false;
		if (Object.keys(entry).length !== 2) return false;
	}
	return true;
}
function isValidSelection(value) {
	if (typeof value !== "object" || value === null) return false;
	const selection = value;
	if (selection.mode !== "local" && selection.mode !== "auto" && selection.mode !== "explicit") return false;
	const keys = Object.keys(selection).sort();
	for (const key of keys) if (key !== "mode" && key !== "provider" && key !== "model") return false;
	if (selection.provider !== void 0 && typeof selection.provider !== "string") return false;
	if (selection.model !== void 0 && typeof selection.model !== "string") return false;
	return true;
}
/** Stable serializer: exact keys in sorted order, 2-space, trailing newline. */
function serializeDecisionConfig(config) {
	const ordered = {
		egress_consent: config.egress_consent,
		enabled: config.enabled,
		enabled_candidates: config.enabled_candidates.map((candidate) => ({
			model: candidate.model,
			provider: candidate.provider
		})),
		schema_version: config.schema_version,
		selection: {
			mode: config.selection.mode,
			...config.selection.model !== void 0 ? { model: config.selection.model } : {},
			...config.selection.provider !== void 0 ? { provider: config.selection.provider } : {}
		}
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}
/**
* Enable/disable the router in a config copy. The guard mirrors the runtime's
* fail-close: with remote candidates and no egress consent, an enabled flag
* would be a lie — enabling requires consent, or a local-only selection.
* Never touches `egress_consent` (CLI-owned).
*/
function setDecisionEnabled(config, enabled) {
	if (enabled) {
		if (!(config.selection.mode === "local" || config.enabled_candidates.length === 0) && !config.egress_consent) return {
			ok: false,
			reason: "remote candidates need egress consent — toggle Egress consent in this tab, then enable"
		};
	}
	return {
		ok: true,
		config: {
			...config,
			enabled
		}
	};
}
/** Atomic-ish write mirroring the canonical writer's privacy posture (0600). */
function writeDecisionRouterConfig(config, env = process.env) {
	if (!isValidDecisionConfig(config)) throw new TypeError("Refusing to persist an invalid decision-router configuration");
	const path = decisionRouterConfigPath(env);
	(0, node_fs.mkdirSync)((0, node_path.dirname)(path), {
		recursive: true,
		mode: 448
	});
	const temp = `${path}.tui.tmp`;
	(0, node_fs.writeFileSync)(temp, serializeDecisionConfig(config), { mode: 384 });
	(0, node_fs.renameSync)(temp, path);
	(0, node_fs.chmodSync)(path, 384);
}
Object.freeze([
	"local",
	"auto",
	"explicit"
]);
Object.freeze({
	"openai-decisions": Object.freeze(["openai"]),
	"typesafe-jev": Object.freeze(["typesafe-ai"]),
	"opencode-console-jev": Object.freeze([]),
	"openrouter-jev": Object.freeze(["openrouter"]),
	"vercel-gateway-jev": Object.freeze(["vercel-ai-gateway", "vercel"]),
	"cloudflare-workers-jev": Object.freeze(["cloudflare-workers-ai"])
});
//#endregion
//#region src/pantheon-settings-state.ts
/** Mirrors routing.yml `behaviors:` — drift-pinned by the registry test. */
const SETTINGS_BEHAVIORS = Object.freeze([
	{
		id: "skill-auto-continue",
		kind: "install",
		title: "Auto-continue skill",
		description: "Continue multi-step todos while keeping safety gates."
	},
	{
		id: "skill-tdd-with-agents",
		kind: "install",
		title: "TDD with agents skill",
		description: "RED, GREEN, REFACTOR test-driven implementation."
	},
	{
		id: "skill-code-review-checklist",
		kind: "install",
		title: "Code review checklist skill",
		description: "Systematic code review and quality gates."
	},
	{
		id: "skill-prompt-refinery",
		kind: "install",
		title: "Prompt refinery skill",
		description: "Vague requests refined — silent adjust, >> full contract."
	},
	{
		id: "gate-idle-todo-enforcer",
		kind: "runtime",
		title: "Idle todo enforcer",
		description: "Continues pending todos when a session goes idle."
	},
	{
		id: "gate-context-pruner",
		kind: "runtime",
		title: "Context pruner",
		description: "Prunes repeated tool output before summarization."
	},
	{
		id: "gate-j1-risk-gate",
		kind: "runtime",
		title: "J1 risk gate",
		description: "High-risk tool calls demand explicit human approval."
	}
]);
new Set(SETTINGS_BEHAVIORS.map((b) => b.id));
function isBehaviorDisabled(effective, id) {
	return effective[id]?.action === "disable";
}
const TOGGLE_REASON = "toggled in /pantheon-settings";
/**
* Toggle (a targeted write keeps the toggle semantics: a `replace` entry is
* never destroyed — disabling keeps its `content`, re-enabling restores the
* replace; a settings-written disable is removed outright, no toggle noise).
*/
function toggledOverrides(effective, id, reason = TOGGLE_REASON) {
	const next = { ...effective };
	const entry = next[id];
	if (entry?.action === "disable") {
		if (entry.content !== void 0) next[id] = entry.reason === reason ? {
			action: "replace",
			content: entry.content
		} : {
			action: "replace",
			content: entry.content,
			...entry.reason !== void 0 ? { reason: entry.reason } : {}
		};
		else delete next[id];
	} else next[id] = entry?.content !== void 0 ? {
		action: "disable",
		reason,
		content: entry.content
	} : {
		action: "disable",
		reason
	};
	return next;
}
Object.freeze(["enabled", "disabled"]);
Object.freeze(["global", "project"]);
//#endregion
//#region src/preset-state.ts
/**
* preset-state.ts — the Model Preset section of the settings window.
*
* TUI-local replica (the bundle must stay self-contained). The preset NAMES
* mirror routing.yml's `presets:` and are drift-pinned by
* tests/tui-preset-state.test.mjs against `loadPresetDefs()`. The marker file
* shape mirrors scripts/install/model-picker.mjs's `buildActivePresetFile`
* (version 1), and the readers (`resolveActivePreset`, vision.ts candidates)
* only consult `.preset`, so the window writes `source: 'tui-settings'`.
*
* Scope note: the window writes the GLOBAL marker only
* (`<config-dir>/opencode/.pantheon/active-preset.json`). A project marker
* wins (it precedes the global path in every runtime candidate list), so it
* is displayed read-only. `none` DELETES the marker with a .bak backup — the
* same contract as the CLI's `set-tier none`.
*/
/** Mirrors routing.yml `presets:` — drift-pinned against loadPresetDefs(). */
const PRESET_NAMES = Object.freeze([
	"go-free",
	"go-fast",
	"go-premium",
	"go-hybrid",
	"anthropic",
	"openai"
]);
function globalActivePresetPath(env = process.env) {
	const xdg = env.XDG_CONFIG_HOME;
	const home = env.HOME ?? "";
	const root = xdg ?? (0, node_path.join)(home, ".config");
	return (0, node_path.join)(root, "opencode", ".pantheon", "active-preset.json");
}
/** Fail-open read: missing/corrupt marker = no active preset. */
function readActivePresetMarker(path) {
	try {
		const raw = JSON.parse((0, node_fs.readFileSync)(path, "utf8"));
		if (typeof raw?.preset !== "string" || raw.preset === "" || raw.preset === "none") return null;
		return {
			name: raw.preset,
			updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : ""
		};
	} catch {
		return null;
	}
}
function writeMarkerAtomically(path, content) {
	(0, node_fs.mkdirSync)((0, node_path.dirname)(path), { recursive: true });
	const temp = `${path}.tui.tmp`;
	(0, node_fs.writeFileSync)(temp, content);
	(0, node_fs.renameSync)(temp, path);
}
/** Select a preset globally: .bak backup, atomic write, version-1 marker. */
function writeActivePreset(path, name, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
	if (!PRESET_NAMES.includes(name)) throw new TypeError(`Refusing to persist unknown preset "${name}"`);
	backupMarker(path);
	writeMarkerAtomically(path, `${JSON.stringify({
		version: 1,
		preset: name,
		source: "tui-settings",
		updated_at: nowIso
	}, null, 2)}\n`);
}
/** Clear the global marker (the `none` contract): .bak backup, then remove. */
function clearActivePreset(path) {
	backupMarker(path);
	(0, node_fs.rmSync)(path, { force: true });
}
function backupMarker(path) {
	if (!(0, node_fs.existsSync)(path)) return;
	(0, node_fs.mkdirSync)((0, node_path.dirname)(path), { recursive: true });
	(0, node_fs.copyFileSync)(path, `${path}.bak`);
}
Object.freeze([
	"auto",
	"opencode-go/mimo-v2.6-flash",
	"google/gemini-2.5-flash",
	"openai/gpt-5-mini",
	"anthropic/claude-3-5-haiku",
	"opencode-go/mimo-v2.5"
]);
/** The staged value 'none' means: delete the global marker (the CLI contract). */
const PRESET_NONE = "none";
Object.freeze([PRESET_NONE, ...PRESET_NAMES]);
//#endregion
//#region src/gui.tsx
/** @jsxImportSource solid-js */
/**
* gui.tsx — Native OpenCode Desktop GUI plugin (`./gui-experimental`).
*
* Provides:
* - Side Panel (`Pantheon Cockpit`) with Olympus Topology (DAG + Timeline/Gantt
*   + replay scrubber), interactive Agora Board (`#seq` stream + post), Ephemeral
*   & Bots (`state.json` + `board-signals/*.signal.json`), and Settings/Cost.
* - `ComposerPill` (`pantheon.status`) showing live bots & quick actions.
* - Interactive `SettingsPage` (`Pantheon`) in Desktop Settings reading/writing
*   overrides via Electron `main(ctx)` IPC + host `tui-prefs` storage.
* - Slash commands `/pantheon-cockpit` and `/pantheon-settings`.
*/
var _tmpl$ = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-radius:4px;border:1px solid #ef4444;color:#fca5a5"><span></span><button type=button style=border:none;background:transparent;color:inherit;cursor:pointer>✕`);
var _tmpl$2 = /*#__PURE__*/ (0, solid_js_web.template)(`<svg viewBox="0 0 640 200"style=width:100%;height:200px><title>Olympus Topology DAG</title><rect x=245 y=10 width=150 height=36 rx=6 fill=none stroke=#fba970 stroke-width=2></rect><text x=320 y=32 text-anchor=middle fill=currentColor font-size=12 font-weight=600>zeus (root)`);
var _tmpl$3 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:10px><div style=display:flex;justify-content:space-between;align-items:center><div style=display:flex;align-items:center;gap:8px><input type=range min=0><span style=opacity:0.75></span></div><div style=display:flex;gap:6px><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);cursor:pointer">DAG Pillars</button><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);cursor:pointer">Timeline`);
var _tmpl$4 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:8px><div style=display:flex;gap:6px><input type=text placeholder=Channel style="width:90px;padding:4px 6px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit"><input type=text placeholder="Post message to Agora Board (@agent)..."style="flex:1;padding:4px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit"><button type=button style="padding:4px 10px;border-radius:4px;border:none;background:#fba970;color:#111;font-weight:600;cursor:pointer">Send`);
var _tmpl$5 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:8px>`);
var _tmpl$6 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:10px;padding:12px;font-size:12px;height:100%;overflow:auto><div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-weak-base, #2e2e32);padding-bottom:8px"><div style=display:flex;align-items:center;gap:8px><span style=font-weight:600>Pantheon Cockpit</span><span style=opacity:0.7></span></div><div style=display:flex;align-items:center;gap:10px><span style=opacity:0.8></span><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit;cursor:pointer">Refresh</button></div></div><div style="display:flex;gap:12px;border-bottom:1px solid var(--border-weak-base, #2e2e32)">`);
var _tmpl$7 = /*#__PURE__*/ (0, solid_js_web.template)(`<button type=button style="padding:4px 2px 8px;border:none;background:transparent;color:inherit;cursor:pointer">`);
var _tmpl$8 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:6px>`);
var _tmpl$9 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;align-items:center;gap:8px><span style=width:96px;font-family:monospace></span><div style=flex:1;height:10px;background:rgba(128,128,128,0.18);border-radius:4px;overflow:hidden><div style=height:100%>`);
var _tmpl$0 = /*#__PURE__*/ (0, solid_js_web.template)(`<svg><g><path fill=none stroke=#38bdf8 stroke-width=1.5></path><rect y=104 width=110 height=40 rx=6 fill=none stroke=#38bdf8 stroke-width=1.4></rect><text y=128 text-anchor=middle fill=currentColor font-size=11></svg>`, false, true, false);
var _tmpl$1 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.6>No board messages recorded yet.`);
var _tmpl$10 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><div style=display:flex;justify-content:space-between;opacity:0.75><span></span><span></span></div><div style=margin-top:4px>`);
var _tmpl$11 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.6>No active background jobs or subagent runs.`);
var _tmpl$12 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="display:flex;justify-content:space-between;padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><span></span><span>`);
var _tmpl$13 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.8>`);
var _tmpl$14 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="display:flex;justify-content:space-between;padding:6px 8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32);opacity:0.85"><span></span><span style=opacity:0.75>`);
var _tmpl$15 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:10px><div style="display:flex;justify-content:space-between;padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><span>OpenCode Spend (Today / 30d)</span><span style=font-family:monospace></span></div><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><span>Auto-Permissions Gate</span><div style=display:flex;gap:4px></div></div><div style="display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><div style=display:flex;justify-content:space-between;align-items:center><span>Model Preset (Global)</span><span style=opacity:0.7;font-family:monospace></span></div><div style=display:flex;flex-wrap:wrap;gap:4px></div></div><div style="display:flex;justify-content:space-between;align-items:center;padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><span></span><button type=button style="padding:2px 10px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);font-family:monospace;cursor:pointer"></button></div><div style="display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><div style=font-weight:600>Behavior Overrides</div></div><div style=opacity:0.75;font-size:11px>`);
var _tmpl$16 = /*#__PURE__*/ (0, solid_js_web.template)(`<button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);font-family:monospace;cursor:pointer">`);
var _tmpl$17 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;justify-content:space-between;align-items:center;gap:8px><span style=opacity:0.85></span><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;font-family:monospace;cursor:pointer">`);
var _tmpl$18 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="padding:6px 8px;border-radius:4px;border:1px solid #ef4444;color:#fca5a5;font-size:12px">`);
var _tmpl$19 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=padding:16px;display:flex;flex-direction:column;gap:12px><div style=display:flex;justify-content:space-between;align-items:center><h2 style=font-size:16px;font-weight:600></h2><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit;cursor:pointer">Refresh</button></div><p style=font-size:12px;opacity:0.7>Olympus Topology, interactive Agora Board, and Ephemeral Worker telemetry are active in the Pantheon side panel.`);
var _tmpl$20 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=padding:12px><div style=display:flex;justify-content:space-between;margin-bottom:8px><strong>Pantheon Cockpit</strong><button type=button>Close`);
function resolveRunningVersion() {
	return "2.3.4-beta.1";
}
const PantheonBridge = _opencode_plugin_gui.Ipc.define({
	id: "pantheon-opencode.bridge",
	methods: {
		snapshot: {
			input: effect.Schema.String,
			output: effect.Schema.String
		},
		postBoardMessage: {
			input: effect.Schema.String,
			output: effect.Schema.String
		},
		saveSettings: {
			input: effect.Schema.String,
			output: effect.Schema.String
		}
	}
});
function readNdjsonLines(filePath, limit = 80) {
	if (!(0, node_fs.existsSync)(filePath)) return [];
	try {
		const slice = (0, node_fs.readFileSync)(filePath, "utf8").trim().split("\n").filter(Boolean).slice(-limit);
		const parsed = [];
		for (const line of slice) try {
			parsed.push(JSON.parse(line));
		} catch {}
		return parsed;
	} catch {
		return [];
	}
}
function resolveOpenCodeDbPaths() {
	const candidates = [
		process.env.PANTHEON_COST_DB,
		process.env.OPENCODE_DB,
		process.env.XDG_DATA_HOME ? (0, node_path.join)(process.env.XDG_DATA_HOME, "opencode", "opencode.db") : "",
		process.env.LOCALAPPDATA ? (0, node_path.join)(process.env.LOCALAPPDATA, "opencode", "opencode.db") : "",
		process.env.APPDATA ? (0, node_path.join)(process.env.APPDATA, "opencode", "opencode.db") : "",
		(0, node_path.join)((0, node_os.homedir)(), ".local", "share", "opencode", "opencode.db")
	];
	const seen = /* @__PURE__ */ new Set();
	const existing = [];
	for (const raw of candidates) {
		const candidate = raw?.trim();
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if ((0, node_fs.existsSync)(candidate)) existing.push(candidate);
	}
	return existing;
}
async function openSqliteReadOnly(dbPath) {
	try {
		return new (await (import("node:sqlite"))).DatabaseSync(dbPath, { readOnly: true });
	} catch {
		return null;
	}
}
async function readOpenCodeCosts() {
	const dbPaths = resolveOpenCodeDbPaths();
	if (dbPaths.length === 0) return {
		todayCostUSD: 0,
		monthCostUSD: 0
	};
	const now = Date.now();
	const startOfDay = /* @__PURE__ */ new Date();
	startOfDay.setHours(0, 0, 0, 0);
	const dayMs = startOfDay.getTime();
	const monthMs = now - 2592e6;
	for (const dbPath of dbPaths) {
		const db = await openSqliteReadOnly(dbPath);
		if (!db) continue;
		try {
			const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message')").all().map((r) => String(r.name)));
			if (tables.size === 0) continue;
			let todayCostUSD = 0;
			let monthCostUSD = 0;
			for (const table of ["message", "session_message"]) {
				if (!tables.has(table)) continue;
				const row = db.prepare(`SELECT
              COALESCE(SUM(CASE WHEN time_created >= ? THEN CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.cost'), 0) ELSE 0 END ELSE 0 END), 0) AS today_cost,
              COALESCE(SUM(CASE WHEN time_created >= ? THEN CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.cost'), 0) ELSE 0 END ELSE 0 END), 0) AS month_cost
            FROM ${table}`).get(dayMs, monthMs);
				todayCostUSD += Number(row?.today_cost ?? 0) || 0;
				monthCostUSD += Number(row?.month_cost ?? 0) || 0;
			}
			return {
				todayCostUSD,
				monthCostUSD
			};
		} catch {} finally {
			try {
				db.close();
			} catch {}
		}
	}
	return {
		todayCostUSD: 0,
		monthCostUSD: 0
	};
}
function extractAgentFromSessionTitle(title) {
	if (typeof title !== "string" || !title.trim()) return "subagent";
	const mentionMatch = title.match(/@([a-zA-Z0-9_-]+)/);
	if (mentionMatch?.[1]) return mentionMatch[1].toLowerCase();
	const prefixMatch = title.match(/^([a-zA-Z0-9_-]+)\s*:/);
	if (prefixMatch?.[1]) return prefixMatch[1].toLowerCase();
	const known = [
		"apollo",
		"hermes",
		"themis",
		"athena",
		"zeus",
		"artemis",
		"hephaestus",
		"atlas"
	];
	const lower = title.toLowerCase();
	return known.find((name) => lower.includes(name)) ?? "subagent";
}
async function readOpenCodeChildSessions(rootDirectory) {
	const dbPaths = resolveOpenCodeDbPaths();
	if (dbPaths.length === 0) return [];
	const normalizedRoot = rootDirectory.trim().toLowerCase();
	for (const dbPath of dbPaths) {
		const db = await openSqliteReadOnly(dbPath);
		if (!db) continue;
		try {
			if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'").get()?.name) continue;
			const cols = new Set(db.prepare("PRAGMA table_info(session)").all().map((c) => String(c.name)));
			if (!cols.has("id") || !cols.has("parent_id")) continue;
			const selectCols = [
				"id",
				"parent_id",
				cols.has("title") ? "title" : "'' AS title",
				cols.has("directory") ? "directory" : "'' AS directory",
				cols.has("time_updated") ? "time_updated" : "0 AS time_updated",
				cols.has("time_archived") ? "time_archived" : "NULL AS time_archived"
			].join(", ");
			const rows = db.prepare(`SELECT ${selectCols} FROM session
           WHERE parent_id IS NOT NULL AND parent_id != ''
           ORDER BY time_updated DESC LIMIT 30`).all();
			const now = Date.now();
			return (normalizedRoot && cols.has("directory") ? rows.filter((r) => {
				const dir = typeof r.directory === "string" ? r.directory.trim().toLowerCase() : "";
				return !dir || dir === normalizedRoot;
			}) : rows).filter((r) => typeof r.id === "string" && r.id.length > 0).map((r) => {
				const updated = Number(r.time_updated ?? 0);
				const isRecentActive = !(r.time_archived !== null && r.time_archived !== void 0) && Number.isFinite(updated) && now - updated < 3e4;
				return {
					id: String(r.id),
					agent: extractAgentFromSessionTitle(r.title),
					status: isRecentActive ? "running" : "completed",
					cost: 0
				};
			});
		} catch {} finally {
			try {
				db.close();
			} catch {}
		}
	}
	return [];
}
async function readSnapshotFromDisk(directory) {
	const root = directory.trim() || process.cwd();
	const messages = readNdjsonLines((0, node_path.join)(root, ".pantheon", "board", "messages.ndjson"), 80);
	const events = readNdjsonLines((0, node_path.join)(root, ".pantheon", "telemetry", "cockpit-events.ndjson"), 100);
	const activeJobs = [];
	const seenJobIds = /* @__PURE__ */ new Set();
	const statePath = (0, node_path.join)(root, ".pantheon", "board", "state.json");
	if ((0, node_fs.existsSync)(statePath)) try {
		const state = JSON.parse((0, node_fs.readFileSync)(statePath, "utf8"));
		if (Array.isArray(state)) for (const job of state) {
			if (!job || typeof job !== "object") continue;
			const rec = job;
			const id = typeof rec.taskID === "string" ? rec.taskID : typeof rec.id === "string" ? rec.id : "";
			if (!id || seenJobIds.has(id)) continue;
			seenJobIds.add(id);
			activeJobs.push({
				id,
				agent: typeof rec.agent === "string" && rec.agent ? rec.agent : "specialist",
				status: typeof rec.state === "string" ? rec.state : typeof rec.status === "string" ? rec.status : "unknown",
				cost: typeof rec.cost === "number" ? rec.cost : 0
			});
		}
		else if (state && typeof state === "object") {
			const legacy = state.jobs;
			if (legacy && typeof legacy === "object") for (const [id, job] of Object.entries(legacy)) {
				if (seenJobIds.has(id)) continue;
				seenJobIds.add(id);
				activeJobs.push({
					id,
					agent: job.agent ?? "specialist",
					status: job.status ?? "unknown",
					cost: typeof job.cost === "number" ? job.cost : 0
				});
			}
		}
	} catch {}
	const signalsDir = (0, node_path.join)(root, ".pantheon", "deepwork", "board-signals");
	if ((0, node_fs.existsSync)(signalsDir)) try {
		for (const file of (0, node_fs.readdirSync)(signalsDir)) {
			if (!file.endsWith(".signal.json")) continue;
			try {
				const sig = JSON.parse((0, node_fs.readFileSync)((0, node_path.join)(signalsDir, file), "utf8"));
				const id = sig.jobId ?? file.replace(".signal.json", "");
				if (seenJobIds.has(id)) continue;
				seenJobIds.add(id);
				activeJobs.push({
					id,
					agent: sig.agent ?? "specialist",
					status: sig.status ?? "completed",
					cost: typeof sig.cost === "number" ? sig.cost : 0
				});
			} catch {}
		}
	} catch {}
	const childSessions = await readOpenCodeChildSessions(root);
	for (const child of childSessions) {
		if (seenJobIds.has(child.id)) continue;
		seenJobIds.add(child.id);
		activeJobs.push(child);
	}
	const eventJobIndex = /* @__PURE__ */ new Map();
	for (const ev of events) {
		const kind = ev.kind ?? ev.type ?? "";
		if (kind !== "subagent:start" && kind !== "subagent:stop" && kind !== "ephemeral:worker") continue;
		const agent = typeof ev.agent === "string" && ev.agent ? ev.agent : "subagent";
		const key = ev.stepKey || ev.threadId || `${agent}:${ev.timestamp}`;
		if (seenJobIds.has(key)) continue;
		const status = kind === "subagent:start" ? "running" : ev.severity === "error" ? "error" : "completed";
		const existingIdx = eventJobIndex.get(key);
		if (existingIdx !== void 0) {
			const existing = activeJobs[existingIdx];
			if (existing) existing.status = status;
		} else {
			eventJobIndex.set(key, activeJobs.length);
			activeJobs.push({
				id: key,
				agent,
				status,
				cost: 0
			});
		}
	}
	let overridesCount = 0;
	let effectiveOverrides = {};
	const overridesPath = (0, node_path.join)(root, ".pantheon", "overrides.json");
	if ((0, node_fs.existsSync)(overridesPath)) try {
		const ov = JSON.parse((0, node_fs.readFileSync)(overridesPath, "utf8"));
		if (ov && typeof ov === "object" && !Array.isArray(ov)) {
			effectiveOverrides = ov;
			overridesCount = Object.keys(ov).length;
		}
	} catch {}
	const behaviors = SETTINGS_BEHAVIORS.map((b) => ({
		id: b.id,
		title: b.title,
		description: b.description,
		kind: b.kind,
		enabled: !isBehaviorDisabled(effectiveOverrides, b.id)
	}));
	let gateMode = "shadow";
	const settingsPath = (0, node_path.join)(root, ".pantheon", "cockpit-settings.json");
	if ((0, node_fs.existsSync)(settingsPath)) try {
		const cfg = JSON.parse((0, node_fs.readFileSync)(settingsPath, "utf8"));
		if (typeof cfg.gateMode === "string" && cfg.gateMode) gateMode = cfg.gateMode;
	} catch {}
	const globalPreset = readActivePresetMarker(globalActivePresetPath());
	const projectPreset = readActivePresetMarker((0, node_path.join)(root, ".pantheon", "active-preset.json"));
	const activePreset = projectPreset?.name ?? globalPreset?.name ?? "none";
	const presetProjectOverride = projectPreset?.name ?? null;
	const decisionRead = readDecisionRouterConfig();
	const decisionEnabled = decisionRead.config.enabled;
	const decisionMode = decisionRead.config.selection.mode;
	let artifactsCount = 0;
	const plansDir = (0, node_path.join)(root, ".pantheon", "plans");
	if ((0, node_fs.existsSync)(plansDir)) try {
		artifactsCount = (0, node_fs.readdirSync)(plansDir).filter((f) => f.endsWith(".md")).length;
	} catch {}
	const { todayCostUSD, monthCostUSD } = await readOpenCodeCosts();
	return {
		messages,
		events,
		activeJobs,
		todayCostUSD,
		monthCostUSD,
		overridesCount,
		gateMode,
		artifactsCount,
		activePreset,
		presetProjectOverride,
		decisionEnabled,
		decisionMode,
		behaviors
	};
}
function appendBoardMessageToDisk(payloadRaw) {
	try {
		const payload = JSON.parse(payloadRaw);
		const root = payload.directory?.trim() || process.cwd();
		const body = String(payload.body ?? "").trim();
		if (!body) return JSON.stringify({
			ok: false,
			error: "Empty message"
		});
		const boardDir = (0, node_path.join)(root, ".pantheon", "board");
		(0, node_fs.mkdirSync)(boardDir, { recursive: true });
		const msgPath = (0, node_path.join)(boardDir, "messages.ndjson");
		const existing = readNdjsonLines(msgPath, 500);
		const nextSeq = existing.length > 0 ? (existing[existing.length - 1]?.seq ?? 0) + 1 : 1;
		const mentions = [...body.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((m) => `@${m[1]}`);
		const record = {
			seq: nextSeq,
			timestamp: Date.now(),
			channel: payload.channel?.trim() || "default",
			from: "user",
			mentions,
			tag: "note",
			body
		};
		(0, node_fs.appendFileSync)(msgPath, `${JSON.stringify(record)}\n`, "utf8");
		return JSON.stringify({
			ok: true,
			seq: nextSeq
		});
	} catch (err) {
		return JSON.stringify({
			ok: false,
			error: err instanceof Error ? err.message : "Failed to post board message"
		});
	}
}
function saveSettingsToDisk(payloadRaw) {
	try {
		const payload = JSON.parse(payloadRaw);
		const root = payload.directory?.trim() || process.cwd();
		const pantheonDir = (0, node_path.join)(root, ".pantheon");
		(0, node_fs.mkdirSync)(pantheonDir, { recursive: true });
		if (typeof payload.gateMode === "string") {
			const settingsPath = (0, node_path.join)(pantheonDir, "cockpit-settings.json");
			let current = {};
			if ((0, node_fs.existsSync)(settingsPath)) try {
				const parsed = JSON.parse((0, node_fs.readFileSync)(settingsPath, "utf8"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
			} catch {
				current = {};
			}
			current.gateMode = payload.gateMode;
			const tmpPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
			(0, node_fs.writeFileSync)(tmpPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
			(0, node_fs.renameSync)(tmpPath, settingsPath);
		}
		if (typeof payload.preset === "string") {
			const globalPath = globalActivePresetPath();
			if (payload.preset === "none") clearActivePreset(globalPath);
			else writeActivePreset(globalPath, payload.preset);
		}
		if (typeof payload.toggleBehaviorId === "string" && payload.toggleBehaviorId) {
			const overridesPath = (0, node_path.join)(pantheonDir, "overrides.json");
			let current = {};
			if ((0, node_fs.existsSync)(overridesPath)) {
				const parsed = JSON.parse((0, node_fs.readFileSync)(overridesPath, "utf8"));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return JSON.stringify({
					ok: false,
					error: "overrides.json is not a valid object; refusing to overwrite"
				});
				current = parsed;
			}
			const next = toggledOverrides(current, payload.toggleBehaviorId, "toggled in Pantheon GUI");
			const tmpPath = `${overridesPath}.${process.pid}.${Date.now()}.tmp`;
			(0, node_fs.writeFileSync)(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
			(0, node_fs.renameSync)(tmpPath, overridesPath);
		}
		if (typeof payload.decisionEnabled === "boolean") {
			const read = readDecisionRouterConfig();
			if (read.corrupt) return JSON.stringify({
				ok: false,
				error: "Decision router config is corrupt; refusing to overwrite"
			});
			const next = setDecisionEnabled(read.config, payload.decisionEnabled);
			if (!next.ok) return JSON.stringify({
				ok: false,
				error: next.reason
			});
			writeDecisionRouterConfig(next.config);
		}
		return JSON.stringify({ ok: true });
	} catch (err) {
		return JSON.stringify({
			ok: false,
			error: err instanceof Error ? err.message : "Failed to save cockpit settings"
		});
	}
}
const [sharedSnapshot, setSharedSnapshot] = (0, solid_js.createSignal)({
	messages: [],
	events: [],
	activeJobs: [],
	todayCostUSD: 0,
	monthCostUSD: 0,
	overridesCount: 0,
	gateMode: "shadow",
	artifactsCount: 0,
	activePreset: PRESET_NONE,
	presetProjectOverride: null,
	decisionEnabled: false,
	decisionMode: "local",
	behaviors: SETTINGS_BEHAVIORS.map((b) => ({
		id: b.id,
		title: b.title,
		description: b.description,
		kind: b.kind,
		enabled: true
	}))
});
const [activeDirectory, setActiveDirectory] = (0, solid_js.createSignal)("");
const [uiError, setUiError] = (0, solid_js.createSignal)(null);
function resolveActiveDirectory(ctx, explicit) {
	const direct = explicit?.().trim();
	if (direct) return direct;
	const session = ctx.sessions.current();
	const sessionDir = session?.directory?.trim() || session?.location?.directory?.trim() || "";
	if (sessionDir) return sessionDir;
	return activeDirectory().trim();
}
function PantheonCockpitView(props) {
	const [subTab, setSubTab] = (0, solid_js.createSignal)("topology");
	const [topoView, setTopoView] = (0, solid_js.createSignal)("dag");
	const [scrubberSeq, setScrubberSeq] = (0, solid_js.createSignal)(null);
	const [draftMsg, setDraftMsg] = (0, solid_js.createSignal)("");
	const [draftChannel, setDraftChannel] = (0, solid_js.createSignal)("default");
	const effectiveDirectory = () => resolveActiveDirectory(props.ctx, props.directory);
	const refresh = async () => {
		try {
			const dir = effectiveDirectory();
			if (dir) setActiveDirectory(dir);
			const raw = await props.ctx.main(PantheonBridge).snapshot(dir);
			setSharedSnapshot(JSON.parse(raw));
		} catch {}
	};
	const sendBoardMsg = async () => {
		const body = draftMsg().trim();
		if (!body) return;
		try {
			const raw = await props.ctx.main(PantheonBridge).postBoardMessage(JSON.stringify({
				directory: effectiveDirectory(),
				channel: draftChannel(),
				body
			}));
			const res = JSON.parse(raw);
			if (res.ok === false) {
				setUiError(res.error ?? "Failed to post board message");
				return;
			}
			setUiError(null);
			setDraftMsg("");
			await refresh();
		} catch (err) {
			setUiError(err instanceof Error ? err.message : "Board IPC unavailable");
		}
	};
	(0, solid_js.createEffect)(() => {
		const dir = effectiveDirectory();
		if (dir) setActiveDirectory(dir);
		refresh();
		const timer = setInterval(() => void refresh(), 3e3);
		(0, solid_js.onCleanup)(() => clearInterval(timer));
	});
	const maxSeq = (0, solid_js.createMemo)(() => {
		const msgs = sharedSnapshot().messages;
		return msgs.length > 0 ? msgs[msgs.length - 1]?.seq ?? 0 : 0;
	});
	const visibleMessages = (0, solid_js.createMemo)(() => {
		const cap = scrubberSeq();
		const msgs = sharedSnapshot().messages;
		return cap === null ? msgs : msgs.filter((m) => m.seq <= cap);
	});
	const ephemeralWorkers = (0, solid_js.createMemo)(() => visibleMessages().filter((m) => m.ephemeral !== void 0));
	const subagentEvents = (0, solid_js.createMemo)(() => sharedSnapshot().events.filter((ev) => {
		const kind = ev.kind ?? ev.type ?? "";
		return kind === "subagent:start" || kind === "subagent:stop" || kind === "ephemeral:worker" || kind === "review:verdict" || kind === "agent:execution:receipt";
	}));
	const uniqueAgents = (0, solid_js.createMemo)(() => {
		const set = /* @__PURE__ */ new Set(["zeus"]);
		for (const m of visibleMessages()) if (m.from && m.from !== "user") set.add(m.from);
		for (const j of sharedSnapshot().activeJobs) if (j.agent) set.add(j.agent);
		for (const ev of sharedSnapshot().events) {
			const agent = ev.agent?.trim();
			if (agent && agent !== "pantheon" && agent !== "ledger" && agent !== "user") set.add(agent);
		}
		return [...set].slice(0, 10);
	});
	const totalCost = (0, solid_js.createMemo)(() => sharedSnapshot().activeJobs.reduce((sum, j) => sum + (Number.isFinite(j.cost) ? j.cost : 0), 0));
	return (() => {
		var _el$ = _tmpl$6(), _el$2 = _el$.firstChild, _el$3 = _el$2.firstChild, _el$5 = _el$3.firstChild.nextSibling, _el$7 = _el$3.nextSibling.firstChild, _el$8 = _el$7.nextSibling, _el$10 = _el$2.nextSibling;
		(0, solid_js_web.insert)(_el$5, () => `v${resolveRunningVersion()}`);
		(0, solid_js_web.insert)(_el$7, () => `${sharedSnapshot().activeJobs.filter((j) => j.status === "running").length} active · $${totalCost().toFixed(2)}`);
		_el$8.$$click = () => void refresh();
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return uiError() !== null;
			},
			get children() {
				var _el$9 = _tmpl$(), _el$0 = _el$9.firstChild, _el$1 = _el$0.nextSibling;
				(0, solid_js_web.insert)(_el$0, uiError);
				_el$1.$$click = () => setUiError(null);
				return _el$9;
			}
		}), _el$10);
		(0, solid_js_web.insert)(_el$10, () => [
			["topology", "Topology & Timeline"],
			["board", `Agora Board (${sharedSnapshot().messages.length})`],
			["ephemeral", `Ephemeral & Bots (${sharedSnapshot().activeJobs.length})`],
			["settings", "Settings & Cost"]
		].map(([id, label]) => (() => {
			var _el$29 = _tmpl$7();
			_el$29.$$click = () => setSubTab(id);
			(0, solid_js_web.insert)(_el$29, label);
			(0, solid_js_web.effect)((_p$) => {
				var _v$6 = subTab() === id ? "2px solid #fba970" : "2px solid transparent", _v$7 = subTab() === id ? 1 : .65, _v$8 = subTab() === id ? 600 : 400;
				_v$6 !== _p$.e && (0, solid_js_web.setStyleProperty)(_el$29, "border-bottom", _p$.e = _v$6);
				_v$7 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$29, "opacity", _p$.t = _v$7);
				_v$8 !== _p$.a && (0, solid_js_web.setStyleProperty)(_el$29, "font-weight", _p$.a = _v$8);
				return _p$;
			}, {
				e: void 0,
				t: void 0,
				a: void 0
			});
			return _el$29;
		})()));
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "topology";
			},
			get children() {
				var _el$11 = _tmpl$3(), _el$13 = _el$11.firstChild.firstChild, _el$14 = _el$13.firstChild, _el$15 = _el$14.nextSibling, _el$17 = _el$13.nextSibling.firstChild, _el$18 = _el$17.nextSibling;
				_el$14.$$input = (e) => {
					const val = Number(e.currentTarget.value);
					setScrubberSeq(val >= maxSeq() ? null : val);
				};
				(0, solid_js_web.insert)(_el$15, (() => {
					var _c$ = (0, solid_js_web.memo)(() => scrubberSeq() === null);
					return () => _c$() ? `#${maxSeq()} · Live` : `#${scrubberSeq()} / ${maxSeq()} · Replay`;
				})());
				_el$17.$$click = () => setTopoView("dag");
				_el$18.$$click = () => setTopoView("gantt");
				(0, solid_js_web.insert)(_el$11, (0, solid_js_web.createComponent)(solid_js.Show, {
					get when() {
						return topoView() === "dag";
					},
					get fallback() {
						return (() => {
							var _el$30 = _tmpl$8();
							(0, solid_js_web.insert)(_el$30, (0, solid_js_web.createComponent)(solid_js.For, {
								get each() {
									return uniqueAgents();
								},
								children: (agent, idx) => (() => {
									var _el$31 = _tmpl$9(), _el$32 = _el$31.firstChild, _el$34 = _el$32.nextSibling.firstChild;
									(0, solid_js_web.insert)(_el$32, agent);
									(0, solid_js_web.setStyleProperty)(_el$34, "background", agent === "zeus" ? "#fba970" : "#38bdf8");
									(0, solid_js_web.effect)((_$p) => (0, solid_js_web.setStyleProperty)(_el$34, "width", `${Math.max(20, 95 - idx() * 15)}%`));
									return _el$31;
								})()
							}));
							return _el$30;
						})();
					},
					get children() {
						var _el$19 = _tmpl$2();
						_el$19.firstChild.nextSibling.nextSibling;
						(0, solid_js_web.insert)(_el$19, (0, solid_js_web.createComponent)(solid_js.For, {
							get each() {
								return uniqueAgents().filter((a) => a !== "zeus");
							},
							children: (agent, idx) => {
								const count = Math.max(1, uniqueAgents().length - 1);
								const x = 20 + idx() * 600 / count;
								const cx = x + 55;
								return (() => {
									var _el$35 = _tmpl$0(), _el$36 = _el$35.firstChild, _el$37 = _el$36.nextSibling, _el$38 = _el$37.nextSibling;
									(0, solid_js_web.setAttribute)(_el$36, "d", `M 320 46 C 320 78, ${cx} 72, ${cx} 104`);
									(0, solid_js_web.setAttribute)(_el$37, "x", x);
									(0, solid_js_web.setAttribute)(_el$38, "x", cx);
									(0, solid_js_web.insert)(_el$38, agent);
									return _el$35;
								})();
							}
						}), null);
						return _el$19;
					}
				}), null);
				(0, solid_js_web.effect)((_p$) => {
					var _v$ = Math.max(1, maxSeq()), _v$2 = topoView() === "dag" ? "#fba970" : "transparent", _v$3 = topoView() === "dag" ? "#111" : "inherit", _v$4 = topoView() === "gantt" ? "#fba970" : "transparent", _v$5 = topoView() === "gantt" ? "#111" : "inherit";
					_v$ !== _p$.e && (0, solid_js_web.setAttribute)(_el$14, "max", _p$.e = _v$);
					_v$2 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$17, "background", _p$.t = _v$2);
					_v$3 !== _p$.a && (0, solid_js_web.setStyleProperty)(_el$17, "color", _p$.a = _v$3);
					_v$4 !== _p$.o && (0, solid_js_web.setStyleProperty)(_el$18, "background", _p$.o = _v$4);
					_v$5 !== _p$.i && (0, solid_js_web.setStyleProperty)(_el$18, "color", _p$.i = _v$5);
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0,
					o: void 0,
					i: void 0
				});
				(0, solid_js_web.effect)(() => _el$14.value = scrubberSeq() ?? maxSeq());
				return _el$11;
			}
		}), null);
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "board";
			},
			get children() {
				var _el$23 = _tmpl$4(), _el$25 = _el$23.firstChild.firstChild, _el$26 = _el$25.nextSibling, _el$27 = _el$26.nextSibling;
				_el$25.$$input = (e) => setDraftChannel(e.currentTarget.value);
				_el$26.$$keydown = (e) => {
					if (e.key === "Enter") sendBoardMsg();
				};
				_el$26.$$input = (e) => setDraftMsg(e.currentTarget.value);
				_el$27.$$click = () => void sendBoardMsg();
				(0, solid_js_web.insert)(_el$23, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return [...visibleMessages()].reverse().slice(0, 20);
					},
					get fallback() {
						return _tmpl$1();
					},
					children: (msg) => (() => {
						var _el$40 = _tmpl$10(), _el$41 = _el$40.firstChild, _el$42 = _el$41.firstChild, _el$43 = _el$42.nextSibling, _el$44 = _el$41.nextSibling;
						(0, solid_js_web.insert)(_el$42, () => `#${msg.seq} ${msg.from}${msg.mentions.length ? ` → ${msg.mentions.join(", ")}` : ""}`);
						(0, solid_js_web.insert)(_el$43, () => msg.tag ?? "");
						(0, solid_js_web.insert)(_el$44, () => msg.body);
						return _el$40;
					})()
				}), null);
				(0, solid_js_web.effect)(() => _el$25.value = draftChannel());
				(0, solid_js_web.effect)(() => _el$26.value = draftMsg());
				return _el$23;
			}
		}), null);
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "ephemeral";
			},
			get children() {
				var _el$28 = _tmpl$5();
				(0, solid_js_web.insert)(_el$28, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return sharedSnapshot().activeJobs;
					},
					get fallback() {
						return (0, solid_js_web.createComponent)(solid_js.Show, {
							get when() {
								return subagentEvents().length === 0;
							},
							get children() {
								return _tmpl$11();
							}
						});
					},
					children: (job) => (() => {
						var _el$46 = _tmpl$12(), _el$47 = _el$46.firstChild, _el$48 = _el$47.nextSibling;
						(0, solid_js_web.insert)(_el$47, () => `${job.agent} (${job.id.slice(0, 8)})`);
						(0, solid_js_web.insert)(_el$48, () => `${job.status} · $${job.cost.toFixed(3)}`);
						return _el$46;
					})()
				}), null);
				(0, solid_js_web.insert)(_el$28, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return ephemeralWorkers().slice(-6);
					},
					children: (msg) => (() => {
						var _el$49 = _tmpl$13();
						(0, solid_js_web.insert)(_el$49, () => `◈ ${msg.ephemeral?.role ?? msg.from} [${msg.ephemeral?.status ?? "active"}]`);
						return _el$49;
					})()
				}), null);
				(0, solid_js_web.insert)(_el$28, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return [...subagentEvents()].reverse().slice(0, 10);
					},
					children: (ev) => (() => {
						var _el$50 = _tmpl$14(), _el$51 = _el$50.firstChild, _el$52 = _el$51.nextSibling;
						(0, solid_js_web.insert)(_el$51, () => `${ev.agent ?? "subagent"} · ${ev.kind ?? ev.type ?? "event"}`);
						(0, solid_js_web.insert)(_el$52, () => ev.detail ?? "");
						return _el$50;
					})()
				}), null);
				return _el$28;
			}
		}), null);
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "settings";
			},
			get children() {
				return (0, solid_js_web.createComponent)(PantheonSettingsControls, {
					get ctx() {
						return props.ctx;
					},
					directory: effectiveDirectory,
					onSaved: refresh
				});
			}
		}), null);
		return _el$;
	})();
}
function PantheonSettingsControls(props) {
	const savePatch = async (patch) => {
		try {
			const raw = await props.ctx.main(PantheonBridge).saveSettings(JSON.stringify({
				directory: props.directory(),
				...patch
			}));
			const res = JSON.parse(raw);
			if (res.ok === false) {
				setUiError(res.error ?? "Failed to save settings");
				return;
			}
			setUiError(null);
			await props.onSaved();
		} catch (err) {
			setUiError(err instanceof Error ? err.message : "Settings IPC unavailable");
		}
	};
	return (() => {
		var _el$53 = _tmpl$15(), _el$54 = _el$53.firstChild, _el$56 = _el$54.firstChild.nextSibling, _el$57 = _el$54.nextSibling, _el$59 = _el$57.firstChild.nextSibling, _el$60 = _el$57.nextSibling, _el$61 = _el$60.firstChild, _el$63 = _el$61.firstChild.nextSibling, _el$64 = _el$61.nextSibling, _el$65 = _el$60.nextSibling, _el$66 = _el$65.firstChild, _el$67 = _el$66.nextSibling, _el$68 = _el$65.nextSibling;
		_el$68.firstChild;
		var _el$70 = _el$68.nextSibling;
		(0, solid_js_web.insert)(_el$56, () => `$${sharedSnapshot().todayCostUSD.toFixed(2)} / $${sharedSnapshot().monthCostUSD.toFixed(2)}`);
		(0, solid_js_web.insert)(_el$59, () => [
			"shadow",
			"enforce",
			"off"
		].map((mode) => (() => {
			var _el$71 = _tmpl$16();
			_el$71.$$click = () => void savePatch({ gateMode: mode });
			(0, solid_js_web.insert)(_el$71, mode);
			(0, solid_js_web.effect)((_p$) => {
				var _v$1 = sharedSnapshot().gateMode === mode ? "#fba970" : "transparent", _v$10 = sharedSnapshot().gateMode === mode ? "#111" : "inherit", _v$11 = sharedSnapshot().gateMode === mode ? 600 : 400;
				_v$1 !== _p$.e && (0, solid_js_web.setStyleProperty)(_el$71, "background", _p$.e = _v$1);
				_v$10 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$71, "color", _p$.t = _v$10);
				_v$11 !== _p$.a && (0, solid_js_web.setStyleProperty)(_el$71, "font-weight", _p$.a = _v$11);
				return _p$;
			}, {
				e: void 0,
				t: void 0,
				a: void 0
			});
			return _el$71;
		})()));
		(0, solid_js_web.insert)(_el$63, (() => {
			var _c$2 = (0, solid_js_web.memo)(() => !!sharedSnapshot().presetProjectOverride);
			return () => _c$2() ? `project: ${sharedSnapshot().presetProjectOverride}` : sharedSnapshot().activePreset;
		})());
		(0, solid_js_web.insert)(_el$64, () => [PRESET_NONE, ...PRESET_NAMES].map((preset) => (() => {
			var _el$72 = _tmpl$16();
			_el$72.$$click = () => void savePatch({ preset });
			(0, solid_js_web.insert)(_el$72, preset);
			(0, solid_js_web.effect)((_p$) => {
				var _v$12 = sharedSnapshot().activePreset === preset ? "#fba970" : "transparent", _v$13 = sharedSnapshot().activePreset === preset ? "#111" : "inherit", _v$14 = sharedSnapshot().activePreset === preset ? 600 : 400;
				_v$12 !== _p$.e && (0, solid_js_web.setStyleProperty)(_el$72, "background", _p$.e = _v$12);
				_v$13 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$72, "color", _p$.t = _v$13);
				_v$14 !== _p$.a && (0, solid_js_web.setStyleProperty)(_el$72, "font-weight", _p$.a = _v$14);
				return _p$;
			}, {
				e: void 0,
				t: void 0,
				a: void 0
			});
			return _el$72;
		})()));
		(0, solid_js_web.insert)(_el$66, () => `Decision Router (${sharedSnapshot().decisionMode})`);
		_el$67.$$click = () => void savePatch({ decisionEnabled: !sharedSnapshot().decisionEnabled });
		(0, solid_js_web.insert)(_el$67, () => sharedSnapshot().decisionEnabled ? "enabled" : "disabled");
		(0, solid_js_web.insert)(_el$68, (0, solid_js_web.createComponent)(solid_js.For, {
			get each() {
				return sharedSnapshot().behaviors;
			},
			children: (beh) => (() => {
				var _el$73 = _tmpl$17(), _el$74 = _el$73.firstChild, _el$75 = _el$74.nextSibling;
				(0, solid_js_web.insert)(_el$74, () => `${beh.title} (${beh.kind})`);
				_el$75.$$click = () => void savePatch({ toggleBehaviorId: beh.id });
				(0, solid_js_web.insert)(_el$75, () => beh.enabled ? "on" : "off");
				(0, solid_js_web.effect)((_$p) => (0, solid_js_web.setStyleProperty)(_el$75, "color", beh.enabled ? "#4ade80" : "#f87171"));
				return _el$73;
			})()
		}), null);
		(0, solid_js_web.insert)(_el$70, () => `Overrides: ${sharedSnapshot().overridesCount} · Plans: ${sharedSnapshot().artifactsCount} · Active jobs: ${sharedSnapshot().activeJobs.length}`);
		(0, solid_js_web.effect)((_p$) => {
			var _v$9 = sharedSnapshot().decisionEnabled ? "#fba970" : "transparent", _v$0 = sharedSnapshot().decisionEnabled ? "#111" : "inherit";
			_v$9 !== _p$.e && (0, solid_js_web.setStyleProperty)(_el$67, "background", _p$.e = _v$9);
			_v$0 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$67, "color", _p$.t = _v$0);
			return _p$;
		}, {
			e: void 0,
			t: void 0
		});
		return _el$53;
	})();
}
function PantheonSettingsView(props) {
	const effectiveDirectory = () => resolveActiveDirectory(props.ctx);
	const refresh = async () => {
		try {
			const dir = effectiveDirectory();
			if (dir) setActiveDirectory(dir);
			const raw = await props.ctx.main(PantheonBridge).snapshot(dir);
			setSharedSnapshot(JSON.parse(raw));
		} catch (err) {
			setUiError(err instanceof Error ? err.message : "Settings IPC unavailable");
		}
	};
	(0, solid_js.createEffect)(() => {
		effectiveDirectory();
		refresh();
	});
	return (() => {
		var _el$76 = _tmpl$19(), _el$77 = _el$76.firstChild, _el$78 = _el$77.firstChild, _el$79 = _el$78.nextSibling, _el$81 = _el$77.nextSibling;
		(0, solid_js_web.insert)(_el$78, () => `Pantheon v${resolveRunningVersion()}`);
		_el$79.$$click = () => void refresh();
		(0, solid_js_web.insert)(_el$76, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return uiError() !== null;
			},
			get children() {
				var _el$80 = _tmpl$18();
				(0, solid_js_web.insert)(_el$80, uiError);
				return _el$80;
			}
		}), _el$81);
		(0, solid_js_web.insert)(_el$76, (0, solid_js_web.createComponent)(PantheonSettingsControls, {
			get ctx() {
				return props.ctx;
			},
			directory: effectiveDirectory,
			onSaved: refresh
		}), _el$81);
		return _el$76;
	})();
}
var gui_default = _opencode_plugin_gui.Plugin.define({
	main(ctx) {
		ctx.provide(PantheonBridge, {
			snapshot: async (directory) => JSON.stringify(await readSnapshotFromDisk(directory)),
			postBoardMessage: (payload) => appendBoardMessageToDisk(payload),
			saveSettings: (payload) => saveSettingsToDisk(payload)
		});
	},
	setup(ctx) {
		const cockpitTab = {
			id: "pantheon-cockpit",
			title: "Pantheon",
			pinned: true
		};
		const openCockpit = () => {
			const session = ctx.sessions.current();
			if (session) ctx.layout.open(`${ctx.id}:pantheon-cockpit`, session, { tab: "open" });
			else ctx.dialogs.open((dialog) => (() => {
				var _el$82 = _tmpl$20(), _el$85 = _el$82.firstChild.firstChild.nextSibling;
				_el$85.$$click = () => dialog.close();
				(0, solid_js_web.insert)(_el$82, (0, solid_js_web.createComponent)(PantheonCockpitView, {
					ctx,
					directory: () => resolveActiveDirectory(ctx)
				}), null);
				return _el$82;
			})());
		};
		ctx.add(_opencode_plugin_gui.Panel, () => ({
			id: "cockpit",
			region: "side",
			wide: true,
			list: () => [cockpitTab],
			render: (props) => (0, solid_js_web.createComponent)(PantheonCockpitView, {
				ctx,
				directory: () => props.session?.directory ?? props.session?.location?.directory ?? ""
			})
		}));
		ctx.add(_opencode_plugin_gui.ComposerPill, () => ({
			id: "pantheon.status",
			show: () => {
				const running = sharedSnapshot().activeJobs.filter((j) => j.status === "running").length;
				return {
					label: running > 0 ? `Pantheon · ${running} active` : "Pantheon · ready",
					tone: running > 0 ? "success" : void 0,
					rows: [{
						id: "open-cockpit",
						label: "Open Pantheon Cockpit",
						detail: `${sharedSnapshot().messages.length} msgs`,
						run: openCockpit
					}, {
						id: "open-settings",
						label: "Open Pantheon Settings",
						detail: sharedSnapshot().gateMode,
						run: () => ctx.layout.settings("pantheon")
					}]
				};
			}
		}));
		ctx.add(_opencode_plugin_gui.SettingsPage, () => ({
			id: "pantheon",
			title: "Pantheon",
			entries: [{
				id: "pantheon.overview",
				title: "Pantheon Orchestration",
				description: "Multi-agent Olympus Topology, Ephemeral Workers, and Cockpit Settings",
				keywords: "pantheon cockpit swarm ephemeral todo"
			}],
			render: () => (0, solid_js_web.createComponent)(PantheonSettingsView, { ctx })
		}));
		ctx.add(_opencode_plugin_gui.Command, () => ({
			id: "cockpit",
			title: "Open Pantheon Cockpit",
			description: "Open Olympus Topology, Agora Board, and Ephemeral Workers",
			slash: { name: "pantheon-cockpit" },
			run: openCockpit
		}));
		ctx.add(_opencode_plugin_gui.Command, () => ({
			id: "settings",
			title: "Open Pantheon Settings",
			description: "Open Pantheon Desktop Settings page",
			slash: { name: "pantheon-settings" },
			run: () => {
				ctx.layout.settings("pantheon");
			}
		}));
	}
});
(0, solid_js_web.delegateEvents)([
	"click",
	"input",
	"keydown"
]);
//#endregion
module.exports = gui_default;
